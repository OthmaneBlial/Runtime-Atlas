import { describe, expect, it } from "vitest";
import type { AtlasTopology } from "../shared/types.js";
import { convertOtlpTraceRequest, decodeOtlpAnyValue, OtlpRequestError } from "./otlp.js";

const topology: AtlasTopology = {
  generatedAt: "2026-08-20T00:00:00.000Z",
  sourceRoot: "src",
  nodes: [
    {
      id: "route.orders",
      symbol: "ordersRoute",
      label: "POST /orders/:id",
      kind: "route",
      meta: { method: "POST", path: "/orders/:id" },
      source: { file: "src/orders.ts", line: 10, column: 1 },
    },
    {
      id: "service.checkout",
      symbol: "checkout",
      label: "Checkout service",
      kind: "service",
      source: { file: "src/checkout.ts", line: 22, column: 1 },
    },
  ],
  edges: [{ id: "route.orders->service.checkout", source: "route.orders", target: "service.checkout" }],
};

function attribute(key: string, value: Record<string, unknown>) {
  return { key, value };
}

function envelope(spans: unknown[]) {
  return {
    resourceSpans: [{
      resource: {
        attributes: [attribute("service.name", { stringValue: "orders-api" })],
      },
      scopeSpans: [{
        scope: { name: "test.instrumentation", version: "1.2.3" },
        schemaUrl: "https://opentelemetry.io/schemas/1.37.0",
        spans,
      }],
    }],
  };
}

describe("OTLP/HTTP JSON conversion", () => {
  it("reconciles static nodes and infers live dependencies without retaining URL queries", () => {
    const traceId = "11111111111111111111111111111111";
    const converted = convertOtlpTraceRequest(envelope([
      {
        traceId,
        spanId: "1111111111111111",
        name: "POST /orders/:id",
        kind: 2,
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000005000000000",
        attributes: [
          attribute("http.request.method", { stringValue: "POST" }),
          attribute("http.route", { stringValue: "/orders/:id" }),
          attribute("http.response.status_code", { intValue: "201" }),
        ],
        status: { code: 0 },
      },
      {
        traceId,
        spanId: "2222222222222222",
        parentSpanId: "1111111111111111",
        name: "checkout",
        kind: 1,
        startTimeUnixNano: "1700000001000000000",
        endTimeUnixNano: "1700000004000000000",
        attributes: [
          attribute("code.function.name", { stringValue: "shop.handlers.checkout" }),
          attribute("code.file.path", { stringValue: "/workspace/src/checkout.ts" }),
          attribute("code.line.number", { intValue: "22" }),
        ],
      },
      {
        traceId,
        spanId: "3333333333333333",
        parentSpanId: "2222222222222222",
        name: "GET",
        kind: 3,
        startTimeUnixNano: "1700000002000000000",
        endTimeUnixNano: "1700000003000000000",
        attributes: [
          attribute("db.system.name", { stringValue: "redis" }),
          attribute("db.operation.name", { stringValue: "GET" }),
          attribute("db.namespace", { stringValue: "0" }),
        ],
      },
      {
        traceId,
        spanId: "4444444444444444",
        parentSpanId: "2222222222222222",
        name: "GET",
        kind: 3,
        startTimeUnixNano: "1700000002000000000",
        endTimeUnixNano: "1700000003500000000",
        attributes: [
          attribute("http.request.method", { stringValue: "GET" }),
          attribute("server.address", { stringValue: "payments.example" }),
          attribute("url.full", { stringValue: "https://payments.example/charge?secret=do-not-render" }),
        ],
      },
    ]), topology);

    expect(converted).toMatchObject({ acceptedSpans: 4, rejectedSpans: 0, traceCount: 1 });
    expect(converted.events.at(0)).toMatchObject({
      type: "trace:start",
      request: { method: "POST", path: "/orders/:id" },
      service: "orders-api",
    });
    expect(converted.events.at(-1)).toMatchObject({
      type: "trace:finish",
      duration: 5_000,
      request: { status: 201 },
    });

    const starts = converted.events.filter((event) => event.type === "span:start");
    expect(starts.find((event) => event.spanId === "1111111111111111")?.nodeId).toBe("route.orders");
    expect(starts.find((event) => event.spanId === "2222222222222222")?.nodeId).toBe("service.checkout");
    expect(starts.find((event) => event.spanId === "3333333333333333")).toMatchObject({
      nodeId: "otlp.cache.orders-api.redis-0",
      detail: { kind: "cache", label: "redis / 0", provenance: "OpenTelemetry" },
    });
    const external = starts.find((event) => event.spanId === "4444444444444444");
    expect(external).toMatchObject({
      nodeId: "otlp.external.orders-api.payments-example",
      detail: { kind: "external", label: "GET payments.example" },
    });
    expect(JSON.stringify(external)).not.toContain("do-not-render");
  });

  it("partially accepts a batch containing an invalid span and ignores unknown fields", () => {
    const converted = convertOtlpTraceRequest({
      unknownFutureField: { enabled: true },
      ...envelope([
        {
          traceId: "22222222222222222222222222222222",
          spanId: "5555555555555555",
          name: "worker",
          kind: 1,
          startTimeUnixNano: 1_700_000_001_000_000_000,
          endTimeUnixNano: "1700000002000000000",
          unknownSpanField: "forward-compatible",
        },
        {
          traceId: "00000000000000000000000000000000",
          spanId: "6666666666666666",
          name: "invalid",
          startTimeUnixNano: "1700000001000000000",
          endTimeUnixNano: "1700000002000000000",
        },
      ]),
    }, topology);

    expect(converted.acceptedSpans).toBe(1);
    expect(converted.rejectedSpans).toBe(1);
    expect(converted.errorMessage).toContain("invalid traceId");
  });

  it("applies HTTP error semantics while respecting explicit OK status", () => {
    const converted = convertOtlpTraceRequest(envelope([
      {
        traceId: "33333333333333333333333333333333",
        spanId: "7777777777777777",
        name: "GET upstream",
        kind: 3,
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000001000000000",
        attributes: [
          attribute("http.request.method", { stringValue: "GET" }),
          attribute("server.address", { stringValue: "api.example" }),
          attribute("http.response.status_code", { intValue: "404" }),
        ],
      },
      {
        traceId: "44444444444444444444444444444444",
        spanId: "8888888888888888",
        name: "GET /missing",
        kind: 2,
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000001000000000",
        attributes: [
          attribute("http.request.method", { stringValue: "GET" }),
          attribute("http.route", { stringValue: "/missing" }),
          attribute("http.response.status_code", { intValue: "404" }),
          attribute("error.type", { stringValue: "NotFound" }),
        ],
        status: { code: 1 },
      },
    ]), topology);

    const clientFinish = converted.events.find((event) => event.spanId === "7777777777777777" && event.type !== "span:start");
    const serverFinish = converted.events.find((event) => event.spanId === "8888888888888888" && event.type !== "span:start");
    expect(clientFinish).toMatchObject({ type: "span:error", error: "HTTP 404" });
    expect(serverFinish).toMatchObject({ type: "span:finish" });
  });

  it("rejects duplicate span identifiers within a trace", () => {
    const duplicate = {
      traceId: "55555555555555555555555555555555",
      spanId: "9999999999999999",
      name: "duplicate",
      kind: 1,
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000001000000000",
    };
    const converted = convertOtlpTraceRequest(envelope([duplicate, { ...duplicate, name: "again" }]), topology);
    expect(converted).toMatchObject({ acceptedSpans: 1, rejectedSpans: 1 });
    expect(converted.errorMessage).toContain("duplicated");
  });

  it("decodes every supported AnyValue shape and enforces the span capacity bound", () => {
    expect(decodeOtlpAnyValue({ stringValue: "text" })).toBe("text");
    expect(decodeOtlpAnyValue({ boolValue: true })).toBe(true);
    expect(decodeOtlpAnyValue({ intValue: "9007199254740993" })).toBe("9007199254740993");
    expect(decodeOtlpAnyValue({ doubleValue: 3.14 })).toBe(3.14);
    expect(decodeOtlpAnyValue({ bytesValue: "AQI=" })).toEqual({ bytesValue: "AQI=" });
    expect(decodeOtlpAnyValue({ arrayValue: { values: [{ stringValue: "a" }, { intValue: "2" }] } })).toEqual(["a", 2]);
    expect(decodeOtlpAnyValue({
      kvlistValue: { values: [{ key: "nested", value: { boolValue: false } }] },
    })).toEqual({ nested: false });
    expect(decodeOtlpAnyValue({ stringValue: "ambiguous", boolValue: true })).toBeUndefined();
    expect(() => convertOtlpTraceRequest(envelope([{}, {}]), topology, 1)).toThrowError(OtlpRequestError);
    try {
      convertOtlpTraceRequest(envelope([{}, {}]), topology, 1);
    } catch (error) {
      expect(error).toMatchObject({ status: 413, rpcCode: 8 });
    }
  });
});
