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
    const parent = trace.events.find((event) => event.type === "span:start" && event.nodeId === "service.root");
    const children = trace.events.filter(
      (event) => event.type === "span:start" && ["db.left", "external.right"].includes(event.nodeId ?? ""),
    );

    expect(trace.outcome).toBe("ok");
    expect(trace.status).toBe(200);
    expect(children).toHaveLength(2);
    expect(children.every((event) => event.parentSpanId === parent?.spanId)).toBe(true);
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

    await expect(runtime.trace({ method: "GET", path: "/broken" }, broken)).rejects.toThrow("upstream timeout");
    const trace = runtime.getTraces()[0];
    expect(trace.outcome).toBe("error");
    expect(trace.status).toBe(500);
    expect(trace.events.some((event) => event.type === "span:error" && event.error === "upstream timeout")).toBe(true);
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
});
