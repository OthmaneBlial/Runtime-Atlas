import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { analyzeProject } from "./analyzer.js";
import { checkoutRoute, runtime, searchRoute } from "./demo-application.js";
import { convertOtlpTraceRequest, OtlpRequestError } from "./otlp.js";

const port = Number(process.env.PORT ?? 4319);
const app = express();
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const entryFile = path.join(currentDirectory, "demo-application.ts");
const sourcePatterns = (process.env.ATLAS_SOURCE_GLOB?.split(",") ?? [entryFile])
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.isAbsolute(value) ? value : path.resolve(value));
const distDirectory = path.resolve(currentDirectory, "../dist");
const ingestToken = process.env.ATLAS_INGEST_TOKEN;
const demoEnabled = !process.env.ATLAS_SOURCE_GLOB;
const otlpBodyLimit = process.env.ATLAS_OTLP_BODY_LIMIT ?? "8mb";
const requestedOtlpSpanLimit = Number(process.env.ATLAS_OTLP_MAX_SPANS ?? 1_000);
const otlpSpanLimit = Number.isInteger(requestedOtlpSpanLimit) && requestedOtlpSpanLimit > 0
  ? Math.min(requestedOtlpSpanLimit, 100_000)
  : 1_000;
const requestedOtlpConcurrency = Number(process.env.ATLAS_OTLP_MAX_CONCURRENT_REQUESTS ?? 16);
const otlpConcurrencyLimit = Number.isInteger(requestedOtlpConcurrency) && requestedOtlpConcurrency > 0
  ? Math.min(requestedOtlpConcurrency, 1_000)
  : 16;
let otlpRequestsInFlight = 0;

app.disable("x-powered-by");

function collectorAuthorized(request: Request): boolean {
  return !ingestToken || request.get("authorization") === `Bearer ${ingestToken}`;
}

function sendOtlpError(response: Response, status: number, code: number, message: string): void {
  response.status(status).type("application/json").send({ code, message });
}

app.post(
  "/v1/traces",
  (request, response, next) => {
    if (!collectorAuthorized(request)) {
      sendOtlpError(response, 401, 16, "collector authorization failed");
      return;
    }
    if (!request.is("application/json")) {
      sendOtlpError(response, 415, 3, "Runtime Atlas currently accepts OTLP/HTTP JSON only");
      return;
    }
    next();
  },
  (_request, response, next) => {
    if (otlpRequestsInFlight >= otlpConcurrencyLimit) {
      response.set("Retry-After", "1");
      sendOtlpError(response, 429, 8, "OTLP collector is at its concurrent request limit");
      return;
    }
    otlpRequestsInFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      otlpRequestsInFlight -= 1;
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  },
  express.json({ limit: otlpBodyLimit }),
  (request, response) => {
    try {
      const converted = convertOtlpTraceRequest(
        request.body,
        analyzeProject(sourcePatterns),
        otlpSpanLimit,
      );
      runtime.ingest(converted.events);
      response.status(200).type("application/json").send(converted.rejectedSpans ? {
        partialSuccess: {
          rejectedSpans: String(converted.rejectedSpans),
          errorMessage: converted.errorMessage,
        },
      } : {});
    } catch (error) {
      if (error instanceof OtlpRequestError) {
        sendOtlpError(response, error.status, error.rpcCode, error.message);
        return;
      }
      sendOtlpError(
        response,
        500,
        13,
        error instanceof Error ? error.message : "OTLP trace conversion failed",
      );
    }
  },
);

app.use(express.json({ limit: "64kb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "runtime-atlas", time: new Date().toISOString() });
});

app.get("/api/topology", (_request, response) => {
  try {
    response.json({
      ...analyzeProject(sourcePatterns),
      project: {
        name: process.env.ATLAS_PROJECT_NAME ?? "meridian-commerce",
        environment: process.env.ATLAS_ENVIRONMENT ?? "local",
        demo: demoEnabled,
      },
    });
  } catch (error) {
    response.status(500).json({
      error: "Static analysis failed",
      detail: error instanceof Error ? error.message : "Unknown analyzer error",
    });
  }
});

app.get("/api/source", async (request, response) => {
  try {
    const requestedFile = typeof request.query.file === "string" ? request.query.file : "";
    const requestedLine = Number(request.query.line);
    const topology = analyzeProject(sourcePatterns);
    const node = topology.nodes.find((candidate) =>
      candidate.source.file === requestedFile && candidate.source.line === requestedLine,
    );
    if (!node) {
      response.status(404).json({ error: "source location is not part of the analyzed topology" });
      return;
    }

    const source = await readFile(path.resolve(process.cwd(), node.source.file), "utf8");
    const allLines = source.split(/\r?\n/);
    const startLine = Math.max(1, node.source.line - 3);
    const endLine = Math.min(allLines.length, node.source.line + 12);
    response.json({
      file: node.source.file,
      focusLine: node.source.line,
      lines: allLines.slice(startLine - 1, endLine).map((text, index) => ({
        number: startLine + index,
        text,
      })),
    });
  } catch (error) {
    response.status(500).json({
      error: "source context could not be read",
      detail: error instanceof Error ? error.message : "Unknown source error",
    });
  }
});

const eventTypes = new Set(["trace:start", "trace:finish", "span:start", "span:finish", "span:error"]);

app.post("/api/ingest", (request, response) => {
  if (!collectorAuthorized(request)) {
    response.status(401).json({ error: "collector authorization failed" });
    return;
  }
  const events = request.body?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > 250) {
    response.status(400).json({ error: "events must be a non-empty array with at most 250 entries" });
    return;
  }
  const valid = events.every((event) => {
    if (!event || typeof event !== "object") return false;
    if (!eventTypes.has(event.type) || typeof event.traceId !== "string" || !Number.isFinite(event.timestamp)) return false;
    if (event.type.startsWith("span:") && (typeof event.spanId !== "string" || typeof event.nodeId !== "string")) return false;
    if (event.type === "trace:start" && (
      typeof event.request?.method !== "string" || typeof event.request?.path !== "string"
    )) return false;
    return true;
  });
  if (!valid) {
    response.status(400).json({ error: "one or more runtime events are malformed" });
    return;
  }
  response.status(202).json({ accepted: runtime.ingest(events) });
});

app.get("/api/traces", (_request, response) => {
  response.json(runtime.getTraces());
});

app.get("/api/stream", (request, response) => {
  response.set({
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  const unsubscribe = runtime.subscribe(response);
  request.on("close", unsubscribe);
});

app.post("/api/demo/checkout", async (_request, response) => {
  if (!demoEnabled) {
    response.status(404).json({ error: "demo endpoints are disabled for external projects" });
    return;
  }
  try {
    const result = await runtime.trace(
      { method: "POST", path: "/api/demo/checkout" },
      checkoutRoute,
    );
    response.json(result);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Request failed" });
  }
});

app.get("/api/demo/search", async (_request, response) => {
  if (!demoEnabled) {
    response.status(404).json({ error: "demo endpoints are disabled for external projects" });
    return;
  }
  try {
    const result = await runtime.trace(
      { method: "GET", path: "/api/demo/search" },
      searchRoute,
    );
    response.json(result);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Request failed" });
  }
});

app.use(express.static(distDirectory));
app.get(/^(?!\/api|\/health).*$/, (_request, response) => {
  response.sendFile(path.join(distDirectory, "index.html"));
});

app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
  if (request.path !== "/v1/traces") {
    next(error);
    return;
  }
  const parserError = error as { status?: number; type?: string; message?: string };
  if (parserError.status === 413 || parserError.type === "entity.too.large") {
    sendOtlpError(response, 413, 8, `OTLP request exceeds the ${otlpBodyLimit} body limit`);
    return;
  }
  if (parserError.status === 415 || parserError.type === "encoding.unsupported") {
    sendOtlpError(response, 415, 3, parserError.message ?? "unsupported OTLP content encoding");
    return;
  }
  sendOtlpError(response, 400, 3, "OTLP request body is not valid protobuf JSON");
});

const server = app.listen(port, () => {
  process.stdout.write(`Runtime Atlas listening on http://localhost:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
