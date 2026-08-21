import { randomUUID, timingSafeEqual } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type {
  AtlasTopology,
  RuntimeEventInput,
  RuntimeEventType,
} from "../shared/types.js";
import { analyzeProject } from "./analyzer.js";
import type { AtlasConfig } from "./config.js";
import { createDemoApplication } from "./demo-application.js";
import type { AtlasLogger } from "./logger.js";
import { convertOtlpTraceRequest, OtlpRequestError } from "./otlp.js";
import type { AtlasRuntime } from "./runtime.js";

interface AppDependencies {
  config: AtlasConfig;
  logger: AtlasLogger;
  runtime: AtlasRuntime;
}

interface RateLimitEntry {
  count: number;
  resetsAt: number;
}

const EVENT_TYPES = new Set<RuntimeEventType>([
  "trace:start",
  "trace:finish",
  "span:start",
  "span:finish",
  "span:error",
]);

function apiError(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({
    error: {
      code,
      message,
      requestId: response.locals.requestId as string | undefined,
    },
  });
}

function sendOtlpError(
  response: Response,
  status: number,
  code: number,
  message: string,
): void {
  response.status(status).type("application/json").send({ code, message });
}

function safeEqual(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected) return true;
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isBoundedString(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    return false;
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isRuntimeEvent(value: unknown): value is RuntimeEventInput {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!EVENT_TYPES.has(event.type as RuntimeEventType)) return false;
  if (
    !isBoundedString(event.traceId, 256) ||
    typeof event.timestamp !== "number" ||
    !Number.isFinite(event.timestamp) ||
    event.timestamp < 0
  ) {
    return false;
  }
  if (event.eventId != null && !isBoundedString(event.eventId, 256))
    return false;
  if (event.service != null && !isBoundedString(event.service, 256))
    return false;
  if (
    event.duration != null &&
    (typeof event.duration !== "number" ||
      !Number.isFinite(event.duration) ||
      event.duration < 0)
  ) {
    return false;
  }
  if (
    String(event.type).startsWith("span:") &&
    (!isBoundedString(event.spanId, 256) || !isBoundedString(event.nodeId, 256))
  )
    return false;
  if (event.parentSpanId != null && !isBoundedString(event.parentSpanId, 256))
    return false;
  if (event.error != null && !isBoundedString(event.error, 2_048)) return false;

  if (event.type === "trace:start") {
    if (!event.request || typeof event.request !== "object") return false;
    const request = event.request as Record<string, unknown>;
    if (
      !isBoundedString(request.method, 32) ||
      !isBoundedString(request.path, 2_048)
    )
      return false;
  }
  if (event.request != null) {
    if (
      !event.request ||
      typeof event.request !== "object" ||
      Array.isArray(event.request)
    )
      return false;
    const request = event.request as Record<string, unknown>;
    if (request.method != null && !isBoundedString(request.method, 32))
      return false;
    if (request.path != null && !isBoundedString(request.path, 2_048))
      return false;
    if (
      request.status != null &&
      (!Number.isInteger(request.status) ||
        (request.status as number) < 100 ||
        (request.status as number) > 599)
    )
      return false;
  }
  if (event.detail != null) {
    if (
      !event.detail ||
      typeof event.detail !== "object" ||
      Array.isArray(event.detail)
    )
      return false;
    const entries = Object.entries(event.detail);
    if (entries.length > 64) return false;
    if (
      entries.some(
        ([key, detail]) =>
          !isBoundedString(key, 128) ||
          !["string", "number", "boolean"].includes(typeof detail) ||
          (typeof detail === "string" && detail.length > 2_048) ||
          (typeof detail === "number" && !Number.isFinite(detail)),
      )
    )
      return false;
  }
  return true;
}

function createRateLimiter(maximum: number, scope: string): RequestHandler {
  const windowMs = 60_000;
  const clients = new Map<string, RateLimitEntry>();
  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const current = clients.get(key);
    const entry =
      !current || current.resetsAt <= now
        ? { count: 1, resetsAt: now + windowMs }
        : { ...current, count: current.count + 1 };
    clients.set(key, entry);
    if (clients.size > 5_000) {
      for (const [client, candidate] of clients) {
        if (candidate.resetsAt <= now) clients.delete(client);
      }
      while (clients.size > 5_000) {
        const oldest = clients.keys().next().value as string | undefined;
        if (!oldest) break;
        clients.delete(oldest);
      }
    }
    response.set("X-RateLimit-Limit", String(maximum));
    response.set(
      "X-RateLimit-Remaining",
      String(Math.max(0, maximum - entry.count)),
    );
    if (entry.count > maximum) {
      response.set(
        "Retry-After",
        String(Math.max(1, Math.ceil((entry.resetsAt - now) / 1_000))),
      );
      apiError(
        response,
        429,
        "RATE_LIMITED",
        `Too many ${scope} requests; retry after the current window`,
      );
      return;
    }
    next();
  };
}

function securityHeaders(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.set({
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
}

export function createRuntimeAtlasApp({
  config,
  logger,
  runtime,
}: AppDependencies) {
  const app = express();
  const demo = createDemoApplication(runtime);
  const ingestRateLimit = createRateLimiter(
    config.ingestRateLimit,
    "telemetry ingest",
  );
  const demoRateLimit = createRateLimiter(config.demoRateLimit, "demo");
  let otlpRequestsInFlight = 0;
  let topologyCache: { expiresAt: number; topology: AtlasTopology } | undefined;

  const topology = (force = false): AtlasTopology => {
    const now = Date.now();
    if (!force && topologyCache && topologyCache.expiresAt >= now)
      return topologyCache.topology;
    const analyzed = analyzeProject(config.sourcePatterns);
    topologyCache = {
      topology: analyzed,
      expiresAt: now + config.topologyCacheMs,
    };
    return analyzed;
  };

  const collectorAuthorized = (request: Request): boolean =>
    safeEqual(
      request.get("authorization"),
      config.ingestToken ? `Bearer ${config.ingestToken}` : undefined,
    );

  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use((request, response, next) => {
    const supplied = request.get("x-request-id");
    const requestId =
      supplied && /^[a-zA-Z0-9._:-]{1,80}$/.test(supplied)
        ? supplied
        : randomUUID();
    const startedAt = performance.now();
    response.locals.requestId = requestId;
    response.set("X-Request-Id", requestId);
    response.once("finish", () =>
      logger.debug("http.request.completed", {
        requestId,
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }),
    );
    next();
  });

  app.post(
    "/v1/traces",
    ingestRateLimit,
    (request, response, next) => {
      if (!collectorAuthorized(request)) {
        sendOtlpError(response, 401, 16, "collector authorization failed");
        return;
      }
      if (!request.is("application/json")) {
        sendOtlpError(
          response,
          415,
          3,
          "Runtime Atlas currently accepts OTLP/HTTP JSON only",
        );
        return;
      }
      next();
    },
    (_request, response, next) => {
      if (otlpRequestsInFlight >= config.otlpConcurrencyLimit) {
        response.set("Retry-After", "1");
        sendOtlpError(
          response,
          429,
          8,
          "OTLP collector is at its concurrent request limit",
        );
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
    express.json({ limit: config.otlpBodyLimitBytes }),
    (request, response) => {
      try {
        const converted = convertOtlpTraceRequest(
          request.body,
          topology(),
          config.otlpSpanLimit,
        );
        runtime.ingest(converted.events);
        response
          .status(200)
          .type("application/json")
          .send(
            converted.rejectedSpans
              ? {
                  partialSuccess: {
                    rejectedSpans: String(converted.rejectedSpans),
                    errorMessage: converted.errorMessage,
                  },
                }
              : {},
          );
      } catch (error) {
        if (error instanceof OtlpRequestError) {
          sendOtlpError(response, error.status, error.rpcCode, error.message);
          return;
        }
        logger.error("otlp.conversion.failed", {
          requestId: response.locals.requestId,
          error: error instanceof Error ? error.message : "unknown error",
        });
        sendOtlpError(response, 500, 13, "OTLP trace conversion failed");
      }
    },
  );

  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "runtime-atlas",
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get("/ready", async (_request, response) => {
    try {
      const analyzed = topology();
      if (config.production)
        await access(path.join(config.distDirectory, "index.html"));
      response.json({
        ok: true,
        service: "runtime-atlas",
        checks: {
          topology: `${analyzed.nodes.length} nodes`,
          ui: config.production ? "built" : "development",
        },
        runtime: runtime.stats(),
      });
    } catch (error) {
      logger.error("readiness.failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      apiError(response, 503, "NOT_READY", "Runtime Atlas is not ready");
    }
  });

  app.get("/api/topology", (_request, response) => {
    try {
      response.json({
        ...topology(),
        project: {
          name: config.projectName,
          environment: config.environment,
          demo: config.demoEnabled,
          canClearTraces: config.allowClearTraces,
          maxTraces: config.maxTraces,
        },
      });
    } catch (error) {
      logger.error("topology.analysis.failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      apiError(
        response,
        500,
        "ANALYSIS_FAILED",
        "Static analysis failed; check ATLAS_SOURCE_GLOB and server logs",
      );
    }
  });

  app.get("/api/source", async (request, response) => {
    if (!config.exposeSource) {
      apiError(
        response,
        403,
        "SOURCE_DISABLED",
        "Source inspection is disabled by server configuration",
      );
      return;
    }
    try {
      const requestedFile =
        typeof request.query.file === "string" ? request.query.file : "";
      const requestedLine = Number(request.query.line);
      const node = topology().nodes.find(
        (candidate) =>
          candidate.source.file === requestedFile &&
          candidate.source.line === requestedLine,
      );
      if (!node) {
        apiError(
          response,
          404,
          "SOURCE_NOT_ANALYZED",
          "Source location is not part of the analyzed topology",
        );
        return;
      }

      const source = await readFile(
        path.resolve(process.cwd(), node.source.file),
        "utf8",
      );
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
      logger.error("source.read.failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      apiError(
        response,
        500,
        "SOURCE_READ_FAILED",
        "Source context could not be read",
      );
    }
  });

  app.post("/api/ingest", ingestRateLimit, (request, response) => {
    if (!collectorAuthorized(request)) {
      apiError(response, 401, "UNAUTHORIZED", "Collector authorization failed");
      return;
    }
    const events: unknown = request.body?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 250) {
      apiError(
        response,
        400,
        "INVALID_BATCH",
        "events must be a non-empty array with at most 250 entries",
      );
      return;
    }
    if (!events.every(isRuntimeEvent)) {
      apiError(
        response,
        400,
        "INVALID_EVENT",
        "One or more runtime events are malformed or exceed safe limits",
      );
      return;
    }
    response.status(202).json({ accepted: runtime.ingest(events) });
  });

  app.get("/api/traces", (_request, response) =>
    response.json(runtime.getTraces()),
  );

  app.get("/api/traces/export", (_request, response) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    response.set(
      "Content-Disposition",
      `attachment; filename="runtime-atlas-traces-${stamp}.json"`,
    );
    response.json({
      exportedAt: new Date().toISOString(),
      project: config.projectName,
      environment: config.environment,
      traces: runtime.getTraces(),
    });
  });

  app.delete("/api/traces", (_request, response) => {
    if (!config.allowClearTraces) {
      apiError(
        response,
        403,
        "CLEAR_DISABLED",
        "Trace clearing is disabled by server configuration",
      );
      return;
    }
    response.json({ cleared: runtime.clear() });
  });

  app.get("/api/stream", (request, response) => {
    if (runtime.stats().subscribers >= config.maxStreamClients) {
      apiError(
        response,
        503,
        "STREAM_CAPACITY",
        "Live stream client capacity has been reached",
      );
      return;
    }
    response.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const unsubscribe = runtime.subscribe(response);
    request.once("close", unsubscribe);
  });

  const requireDemo: RequestHandler = (_request, response, next) => {
    if (!config.demoEnabled) {
      apiError(
        response,
        404,
        "DEMO_DISABLED",
        "Demo endpoints are disabled while analyzing an external project",
      );
      return;
    }
    next();
  };

  app.post(
    "/api/demo/checkout",
    requireDemo,
    demoRateLimit,
    async (_request, response) => {
      try {
        const result = await runtime.trace(
          { method: "POST", path: "/api/demo/checkout" },
          demo.checkoutRoute,
        );
        response.json(result);
      } catch {
        apiError(
          response,
          500,
          "DEMO_FAILED",
          "Checkout scenario failed unexpectedly",
        );
      }
    },
  );

  app.get(
    "/api/demo/search",
    requireDemo,
    demoRateLimit,
    async (_request, response) => {
      try {
        const result = await runtime.trace(
          { method: "GET", path: "/api/demo/search" },
          demo.searchRoute,
        );
        response.json(result);
      } catch {
        apiError(
          response,
          500,
          "DEMO_FAILED",
          "Search scenario failed unexpectedly",
        );
      }
    },
  );

  app.post(
    "/api/demo/failure",
    requireDemo,
    demoRateLimit,
    async (_request, response) => {
      try {
        await runtime.trace(
          { method: "POST", path: "/api/demo/failure", status: 503 },
          demo.paymentFailureRoute,
        );
        apiError(
          response,
          500,
          "DEMO_INVARIANT",
          "Failure scenario completed without its expected error",
        );
      } catch {
        apiError(
          response,
          503,
          "DEMO_DEPENDENCY_FAILURE",
          "Simulated payment provider outage",
        );
      }
    },
  );

  app.use((request, response, next) => {
    if (
      request.path.startsWith("/api/") ||
      request.path.startsWith("/v1/") ||
      request.path === "/api"
    ) {
      apiError(response, 404, "NOT_FOUND", "API endpoint not found");
      return;
    }
    next();
  });

  app.use(
    express.static(config.distDirectory, {
      index: false,
      setHeaders: (response, file) => {
        response.setHeader(
          "Cache-Control",
          file.includes(`${path.sep}assets${path.sep}`)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    }),
  );
  app.get("*splat", (_request, response) => {
    response.set("Cache-Control", "no-cache");
    response.sendFile(path.join(config.distDirectory, "index.html"));
  });

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const parserError = error as { status?: number; type?: string };
      if (request.path === "/v1/traces") {
        if (
          parserError.status === 413 ||
          parserError.type === "entity.too.large"
        ) {
          sendOtlpError(
            response,
            413,
            8,
            `OTLP request exceeds the ${config.otlpBodyLimitBytes} byte body limit`,
          );
          return;
        }
        if (
          parserError.status === 415 ||
          parserError.type === "encoding.unsupported"
        ) {
          sendOtlpError(response, 415, 3, "Unsupported OTLP content encoding");
          return;
        }
        sendOtlpError(
          response,
          400,
          3,
          "OTLP request body is not valid protobuf JSON",
        );
        return;
      }
      logger.error("http.request.failed", {
        requestId: response.locals.requestId,
        path: request.path,
        error: error instanceof Error ? error.message : "unknown error",
      });
      const status = parserError.status === 413 ? 413 : 400;
      apiError(
        response,
        status,
        status === 413 ? "BODY_TOO_LARGE" : "INVALID_JSON",
        status === 413
          ? "Request body exceeds the configured limit"
          : "Request body is not valid JSON",
      );
    },
  );

  return app;
}
