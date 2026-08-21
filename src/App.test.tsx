import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { AtlasTopology, TraceSummary } from "./types";

const topology: AtlasTopology = {
  generatedAt: "2026-08-20T20:00:00.000Z",
  sourceRoot: "service/src",
  project: { name: "orders-api", environment: "test", demo: true },
  nodes: [
    {
      id: "route.orders",
      symbol: "ordersRoute",
      label: "POST /orders",
      kind: "route",
      source: { file: "service/src/routes.ts", line: 10, column: 1 },
    },
    {
      id: "db.orders",
      symbol: "ordersDb",
      label: "Orders DB",
      kind: "database",
      description: "Persists an order.",
      source: { file: "service/src/db.ts", line: 4, column: 1 },
    },
  ],
  edges: [{ id: "route.orders->db.orders", source: "route.orders", target: "db.orders" }],
};

const traces: TraceSummary[] = [{
  id: "trace-one",
  method: "POST",
  path: "/orders",
  startedAt: Date.now(),
  duration: 24,
  status: 201,
  outcome: "ok",
  events: [
    { id: "trace-one:1", type: "span:start", traceId: "trace-one", spanId: "route", nodeId: "route.orders", timestamp: 10, sequence: 1 },
    { id: "trace-one:2", type: "span:finish", traceId: "trace-one", spanId: "route", nodeId: "route.orders", timestamp: 34, duration: 24, sequence: 2 },
  ],
}];

class FakeEventSource {
  static current?: FakeEventSource;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (event?: MessageEvent<string>) => void>();

  constructor(_url: string) {
    FakeEventSource.current = this;
    queueMicrotask(() => this.listeners.get("ready")?.());
  }

  addEventListener(name: string, listener: (event?: MessageEvent<string>) => void) {
    this.listeners.set(name, listener);
  }

  emit(name: string, data: object) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  close() {}
}

describe("Runtime Atlas workspace", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/topology") return new Response(JSON.stringify(topology), { status: 200 });
      if (url === "/api/traces") return new Response(JSON.stringify(traces), { status: 200 });
      if (url.startsWith("/api/source?")) return new Response(JSON.stringify({
        file: "service/src/db.ts",
        focusLine: 4,
        lines: [
          { number: 3, text: "" },
          { number: 4, text: "export const ordersDb = atlas.database(" },
          { number: 5, text: "  { id: 'db.orders', label: 'Orders DB' }," },
        ],
      }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("switches between live evidence and the static topology", async () => {
    render(<App />);
    const topologyButton = await screen.findByRole("button", { name: /topology/i });
    fireEvent.click(topologyButton);
    expect(screen.getByText("MAP READY")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /live map/i }));
    expect(screen.queryByText("MAP READY")).not.toBeInTheDocument();
  });

  it("finds an analyzed node and opens its source-backed inspector", async () => {
    render(<App />);
    const findNode = await screen.findByRole("button", { name: /find a node/i });
    fireEvent.click(findNode);
    fireEvent.change(screen.getByRole("textbox", { name: "Search runtime nodes" }), { target: { value: "orders db" } });
    const result = within(screen.getByRole("dialog")).getByText("Orders DB").closest("button");
    expect(result).not.toBeNull();
    fireEvent.click(result!);
    expect(screen.getByRole("heading", { name: "Orders DB" })).toBeInTheDocument();
    expect(screen.getByText("service/src/db.ts:4")).toBeInTheDocument();
    expect(await screen.findByText("export const ordersDb = atlas.database(")).toBeInTheDocument();
  });

  it("injects the real demo endpoint from the request launcher", async () => {
    render(<App />);
    const checkout = await screen.findByRole("button", { name: "POST /checkout" });
    fireEvent.click(checkout);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/demo/checkout", { method: "POST" }));
  });

  it("adds runtime-only nodes when live instrumentation exceeds the static map", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "POST /checkout" });
    expect(FakeEventSource.current).toBeDefined();
    // Deliberately older than the existing trace: collector sequence, not a
    // potentially skewed service clock, must make this the active request.
    const liveStartedAt = 100;
    act(() => {
      FakeEventSource.current?.emit("runtime", {
        id: "live:100",
        type: "trace:start",
        traceId: "live",
        timestamp: liveStartedAt,
        sequence: 100,
        request: { method: "POST", path: "/live" },
      });
    });
    await screen.findByText("/live");
    act(() => {
      FakeEventSource.current?.emit("runtime", {
        id: "live:101",
        type: "span:start",
        traceId: "live",
        spanId: "worker",
        nodeId: "service.live-worker",
        timestamp: liveStartedAt + 1,
        sequence: 101,
        service: "worker-api",
        detail: { kind: "service", label: "Live worker", description: "Observed only at runtime." },
      });
    });
    expect(await screen.findByRole("button", { name: "Live worker, service, active" })).toBeInTheDocument();
  });
});
