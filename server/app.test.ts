// @vitest-environment node
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeAtlasApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { AtlasRuntime } from "./runtime.js";

describe("Runtime Atlas HTTP application", () => {
  const config = loadConfig({ ATLAS_LOG_LEVEL: "silent" });
  const runtime = new AtlasRuntime({ maxTraces: 10 });
  const app = createRuntimeAtlasApp({
    config,
    logger: createLogger("silent"),
    runtime,
  });
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    runtime.closeSubscribers();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("reports health and readiness with hardened response headers", async () => {
    const health = await fetch(`${origin}/health`, {
      headers: { "x-request-id": "integration-check" },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get("x-request-id")).toBe("integration-check");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await health.json()).toMatchObject({
      ok: true,
      service: "runtime-atlas",
    });

    const ready = await fetch(`${origin}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      checks: { topology: "14 nodes", ui: "development" },
    });
  });

  it("validates ingest batches and accepts a well-formed remote trace", async () => {
    const malformed = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ type: "trace:start" }] }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "INVALID_EVENT" },
    });

    const invalidStatus = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "trace:finish",
            traceId: "invalid-status",
            timestamp: Date.now(),
            request: { status: 900 },
          },
        ],
      }),
    });
    expect(invalidStatus.status).toBe(400);

    const accepted = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            eventId: "integration-start",
            type: "trace:start",
            traceId: "integration-trace",
            timestamp: Date.now(),
            request: { method: "POST", path: "/orders" },
          },
        ],
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: 1 });
  });

  it("serves source only for exact analyzer-approved locations", async () => {
    const topology = (await fetch(`${origin}/api/topology`).then((response) =>
      response.json(),
    )) as { nodes: Array<{ source: { file: string; line: number } }> };
    const location = topology.nodes[0].source;
    const query = new URLSearchParams({
      file: location.file,
      line: String(location.line),
    });
    const source = await fetch(`${origin}/api/source?${query}`);
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({
      file: location.file,
      focusLine: location.line,
      lines: expect.any(Array),
    });

    const traversal = await fetch(
      `${origin}/api/source?file=../../etc/passwd&line=1`,
    );
    expect(traversal.status).toBe(404);
    expect(await traversal.json()).toMatchObject({
      error: { code: "SOURCE_NOT_ANALYZED" },
    });
  });

  it("records the deterministic dependency-failure scenario", async () => {
    const failure = await fetch(`${origin}/api/demo/failure`, {
      method: "POST",
    });
    expect(failure.status).toBe(503);
    expect(await failure.json()).toMatchObject({
      error: { code: "DEMO_DEPENDENCY_FAILURE" },
    });

    const traces = (await fetch(`${origin}/api/traces`).then((response) =>
      response.json(),
    )) as Array<{
      path: string;
      status: number;
      outcome: string;
    }>;
    expect(traces).toContainEqual(
      expect.objectContaining({
        path: "/api/demo/failure",
        status: 503,
        outcome: "error",
      }),
    );
  });

  it("exports and clears retained traces without leaking implementation errors", async () => {
    const exported = await fetch(`${origin}/api/traces/export`);
    expect(exported.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(await exported.json()).toMatchObject({
      project: config.projectName,
      environment: "local",
    });

    const cleared = await fetch(`${origin}/api/traces`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ cleared: expect.any(Number) });
    expect(
      await fetch(`${origin}/api/traces`).then((response) => response.json()),
    ).toEqual([]);

    const invalidJson = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({
      error: { code: "INVALID_JSON" },
    });
  });
});

describe("shared-network security capabilities", () => {
  it("enforces collector auth and disables source and destructive controls", async () => {
    const config = loadConfig({
      ATLAS_LOG_LEVEL: "silent",
      ATLAS_INGEST_TOKEN: "integration-secret-token",
      ATLAS_EXPOSE_SOURCE: "false",
      ATLAS_ALLOW_CLEAR: "false",
      ATLAS_DEMO_RATE_LIMIT: "1",
      ATLAS_MAX_STREAM_CLIENTS: "1",
    });
    const runtime = new AtlasRuntime();
    const app = createRuntimeAtlasApp({
      config,
      logger: createLogger("silent"),
      runtime,
    });
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const streamController = new AbortController();

    try {
      const ingest = await fetch(`${origin}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      });
      expect(ingest.status).toBe(401);
      expect(await ingest.json()).toMatchObject({
        error: { code: "UNAUTHORIZED" },
      });

      const otlp = await fetch(`${origin}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceSpans: [] }),
      });
      expect(otlp.status).toBe(401);

      const source = await fetch(
        `${origin}/api/source?file=server/demo-application.ts&line=1`,
      );
      expect(source.status).toBe(403);
      expect(await source.json()).toMatchObject({
        error: { code: "SOURCE_DISABLED" },
      });

      const clear = await fetch(`${origin}/api/traces`, { method: "DELETE" });
      expect(clear.status).toBe(403);
      expect(await clear.json()).toMatchObject({
        error: { code: "CLEAR_DISABLED" },
      });

      const firstDemo = await fetch(`${origin}/api/demo/search`);
      expect(firstDemo.status).toBe(200);
      const limitedDemo = await fetch(`${origin}/api/demo/search`);
      expect(limitedDemo.status).toBe(429);
      expect(limitedDemo.headers.get("retry-after")).toBeTruthy();

      const firstStream = await fetch(`${origin}/api/stream`, {
        signal: streamController.signal,
      });
      expect(firstStream.status).toBe(200);
      const limitedStream = await fetch(`${origin}/api/stream`);
      expect(limitedStream.status).toBe(503);
      expect(await limitedStream.json()).toMatchObject({
        error: { code: "STREAM_CAPACITY" },
      });
      streamController.abort();
    } finally {
      streamController.abort();
      runtime.closeSubscribers();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
