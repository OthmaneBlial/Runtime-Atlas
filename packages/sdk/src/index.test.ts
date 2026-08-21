// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createAtlas, HttpAtlasTransport, type AtlasTransport, type RuntimeEventInput } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

class MemoryTransport implements AtlasTransport {
  events: RuntimeEventInput[] = [];
  flushes = 0;

  emit(event: RuntimeEventInput): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    this.flushes += 1;
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

describe("@runtime-atlas/sdk", () => {
  it("emits causal spans for an independently instrumented service", async () => {
    const transport = new MemoryTransport();
    const atlas = createAtlas({ serviceName: "orders-api", transport });
    const database = atlas.database({ id: "db.orders", label: "Orders DB" }, async () => ({ id: 42 }));
    const route = atlas.route({ id: "route.orders", label: "POST /orders" }, async () => database());

    await atlas.trace({ method: "POST", path: "/orders" }, route);

    const routeStart = transport.events.find((event) => event.type === "span:start" && event.nodeId === "route.orders");
    const databaseStart = transport.events.find((event) => event.type === "span:start" && event.nodeId === "db.orders");
    expect(transport.events.map((event) => event.type)).toEqual([
      "trace:start",
      "span:start",
      "span:start",
      "span:finish",
      "span:finish",
      "trace:finish",
    ]);
    expect(databaseStart?.parentSpanId).toBe(routeStart?.spanId);
    expect(databaseStart?.detail).toMatchObject({ kind: "database", label: "Orders DB" });
    expect(transport.events.every((event) => event.service === "orders-api")).toBe(true);
    expect(new Set(transport.events.map((event) => event.eventId)).size).toBe(transport.events.length);
    expect(transport.flushes).toBe(1);
  });

  it("never breaks the observed request when the collector is down", async () => {
    const onError = vi.fn();
    const transport: AtlasTransport = {
      emit: () => undefined,
      flush: async () => { throw new Error("collector unavailable"); },
      close: async () => undefined,
    };
    const atlas = createAtlas({ serviceName: "resilient-api", transport, onError });

    await expect(atlas.trace({ method: "GET", path: "/health" }, async () => "healthy")).resolves.toBe("healthy");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "collector unavailable" }));
  });

  it("begins a real HTTP trace at Connect middleware entry and finishes on the response", async () => {
    const transport = new MemoryTransport();
    const atlas = createAtlas({ serviceName: "web-api", transport });
    const route = atlas.route({ id: "route.users", label: "GET /users/:id" }, async () => "user");
    const middleware = atlas.httpMiddleware({
      path: (request) => request.originalUrl?.replace(/\/\d+$/, "/:id") ?? "/users/:id",
    });
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 204;
    let downstream: Promise<string> | undefined;

    middleware(
      { method: "get", originalUrl: "/users/42" },
      response,
      () => { downstream = route(); },
    );
    await downstream;
    response.emit("finish");
    await Promise.resolve();

    expect(transport.events.map((event) => event.type)).toEqual([
      "trace:start",
      "span:start",
      "span:finish",
      "trace:finish",
    ]);
    expect(transport.events[0].request).toEqual({ method: "GET", path: "/users/:id" });
    expect(transport.events.at(-1)?.request?.status).toBe(204);
    expect(transport.events[1].traceId).toBe(transport.events[0].traceId);
  });

  it("can ignore health checks without emitting telemetry", () => {
    const transport = new MemoryTransport();
    const atlas = createAtlas({ serviceName: "web-api", transport });
    const middleware = atlas.httpMiddleware({ ignore: (request) => request.url === "/health" });
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 200;
    const next = vi.fn();

    middleware({ method: "GET", url: "/health" }, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(transport.events).toEqual([]);
  });

  it("bounds queued telemetry while the collector is unreachable", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(init);
      return new Response(null, { status: 202 });
    }));
    const transport = new HttpAtlasTransport("http://collector.test/api/ingest", 60_000, {}, 2);
    const base = { type: "trace:start" as const, traceId: "bounded", timestamp: 1, request: { method: "GET", path: "/" } };

    transport.emit({ ...base, eventId: "oldest" });
    transport.emit({ ...base, eventId: "middle" });
    transport.emit({ ...base, eventId: "newest" });
    await transport.flush();

    const body = JSON.parse(String(requests[0].body)) as { events: RuntimeEventInput[] };
    expect(body.events.map((event) => event.eventId)).toEqual(["middle", "newest"]);
  });
});
