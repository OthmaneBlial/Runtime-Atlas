import { describe, expect, it } from "vitest";
import { AtlasRuntime } from "./runtime.js";

describe("runtime instrumentation", () => {
  it("keeps causal parent spans across concurrent work", async () => {
    const runtime = new AtlasRuntime();
    const left = runtime.instrument(
      { id: "db.left", label: "Left", kind: "database" },
      async () => "left",
    );
    const right = runtime.instrument(
      { id: "external.right", label: "Right", kind: "external" },
      async () => "right",
    );
    const service = runtime.instrument(
      { id: "service.root", label: "Root", kind: "service" },
      async () => Promise.all([left(), right()]),
    );

    await runtime.trace({ method: "POST", path: "/parallel" }, service);

    const trace = runtime.getTraces()[0];
    const parent = trace.events.find(
      (event) => event.type === "span:start" && event.nodeId === "service.root",
    );
    const children = trace.events.filter(
      (event) =>
        event.type === "span:start" &&
        ["db.left", "external.right"].includes(event.nodeId ?? ""),
    );

    expect(trace.outcome).toBe("ok");
    expect(trace.status).toBe(200);
    expect(children).toHaveLength(2);
    expect(
      children.every((event) => event.parentSpanId === parent?.spanId),
    ).toBe(true);
    expect(trace.events.at(0)?.type).toBe("trace:start");
    expect(trace.events.at(-1)?.type).toBe("trace:finish");
  });

  it("records failed spans and a failed trace without swallowing the error", async () => {
    const runtime = new AtlasRuntime();
    const broken = runtime.instrument(
      { id: "external.broken", label: "Broken", kind: "external" },
      async () => {
        throw new Error("upstream timeout");
      },
    );

    await expect(
      runtime.trace({ method: "GET", path: "/broken" }, broken),
    ).rejects.toThrow("upstream timeout");
    const trace = runtime.getTraces()[0];
    expect(trace.outcome).toBe("error");
    expect(trace.status).toBe(500);
    expect(
      trace.events.some(
        (event) =>
          event.type === "span:error" && event.error === "upstream timeout",
      ),
    ).toBe(true);
  });

  it("bounds control characters and oversized internal error evidence", async () => {
    const runtime = new AtlasRuntime();
    const broken = runtime.instrument(
      { id: "service.broken", label: "Broken", kind: "service" },
      async () => {
        throw new Error(`line one\n${"x".repeat(3_000)}`);
      },
    );

    await expect(
      runtime.trace({ method: "GET", path: "/broken" }, broken),
    ).rejects.toThrow("line one");
    const errors = runtime.getTraces()[0].events.filter((event) => event.error);
    expect(errors).toHaveLength(2);
    expect(errors.every((event) => event.error!.length <= 2_048)).toBe(true);
    expect(errors.every((event) => !event.error!.includes("\n"))).toBe(true);
  });

  it("accepts remote SDK batches and deduplicates retried events", () => {
    const runtime = new AtlasRuntime();
    const events = [
      {
        eventId: "remote-1",
        type: "trace:start" as const,
        traceId: "remote-trace",
        timestamp: 100,
        request: { method: "POST", path: "/orders" },
        service: "orders-api",
      },
      {
        eventId: "remote-2",
        type: "trace:finish" as const,
        traceId: "remote-trace",
        timestamp: 145,
        duration: 45,
        request: { method: "POST", path: "/orders", status: 201 },
        service: "orders-api",
      },
    ];

    expect(runtime.ingest(events)).toBe(2);
    expect(runtime.ingest(events)).toBe(0);
    expect(runtime.getTraces()[0]).toMatchObject({
      id: "remote-trace",
      path: "/orders",
      status: 201,
      duration: 45,
      outcome: "ok",
    });
    expect(runtime.getTraces()[0].events).toHaveLength(2);
  });

  it("enforces trace retention and can clear all in-memory telemetry", () => {
    const runtime = new AtlasRuntime({
      maxTraces: 2,
      maxBufferedEvents: 100,
      maxEventsPerTrace: 100,
    });
    const event = (traceId: string, timestamp: number) => ({
      eventId: `${traceId}-start`,
      type: "trace:start" as const,
      traceId,
      timestamp,
      request: { method: "GET", path: `/${traceId}` },
    });

    runtime.ingest([event("one", 1), event("two", 2), event("three", 3)]);

    expect(runtime.getTraces().map((trace) => trace.id)).toEqual([
      "three",
      "two",
    ]);
    expect(runtime.stats()).toMatchObject({
      traces: 2,
      retainedEvents: 2,
      bufferedEvents: 2,
    });
    expect(runtime.clear()).toBe(2);
    expect(runtime.getTraces()).toEqual([]);
    expect(runtime.stats()).toMatchObject({
      traces: 0,
      retainedEvents: 0,
      bufferedEvents: 0,
    });
  });

  it("caps aggregate retained events and removes evicted evidence from SSE replay", () => {
    const runtime = new AtlasRuntime({
      maxTraces: 10,
      maxBufferedEvents: 100,
      maxEventsPerTrace: 100,
      maxRetainedEvents: 3,
    });
    runtime.ingest(
      ["one", "two", "three", "four"].map((traceId, index) => ({
        type: "trace:start" as const,
        traceId,
        timestamp: index,
        request: { method: "GET", path: `/${traceId}` },
      })),
    );

    expect(runtime.getTraces().map((trace) => trace.id)).toEqual([
      "four",
      "three",
      "two",
    ]);
    expect(runtime.stats()).toMatchObject({
      traces: 3,
      retainedEvents: 3,
      bufferedEvents: 3,
    });
  });
});
