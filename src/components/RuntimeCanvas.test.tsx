import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AtlasTopology, RuntimeEvent } from "../types";
import { RuntimeCanvas } from "./RuntimeCanvas";

const topology: AtlasTopology = {
  generatedAt: "2026-08-20T00:00:00.000Z",
  sourceRoot: "server",
  nodes: [
    {
      id: "route.test",
      symbol: "testRoute",
      label: "GET /test",
      kind: "route",
      source: { file: "server/app.ts", line: 2, column: 1 },
    },
    {
      id: "service.test",
      symbol: "testService",
      label: "Test service",
      kind: "service",
      source: { file: "server/app.ts", line: 8, column: 1 },
    },
  ],
  edges: [
    {
      id: "route.test->service.test",
      source: "route.test",
      target: "service.test",
    },
  ],
};

const events: RuntimeEvent[] = [
  {
    id: "a:1",
    type: "span:start",
    traceId: "a",
    spanId: "route-span",
    nodeId: "route.test",
    timestamp: 100,
    sequence: 1,
  },
  {
    id: "a:2",
    type: "span:start",
    traceId: "a",
    spanId: "service-span",
    parentSpanId: "route-span",
    nodeId: "service.test",
    timestamp: 110,
    sequence: 2,
  },
];

describe("RuntimeCanvas", () => {
  it("renders analyzed nodes and exposes node selection", () => {
    const onSelectNode = vi.fn();
    render(
      <RuntimeCanvas
        topology={topology}
        events={events}
        onSelectNode={onSelectNode}
        now={120}
      />,
    );

    expect(
      screen.getByRole("group", {
        name: "2 runtime nodes and 1 code-derived connections",
      }),
    ).toBeInTheDocument();
    const service = screen.getByRole("button", {
      name: "Test service, service, active",
    });
    fireEvent.click(service);
    expect(onSelectNode).toHaveBeenCalledWith(topology.nodes[1]);
  });

  it("provides keyboard-addressable zoom and fit controls", () => {
    render(
      <RuntimeCanvas
        topology={topology}
        events={[]}
        onSelectNode={() => undefined}
        now={120}
      />,
    );
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Fit map" })).toBeEnabled();
  });

  it("reverses the edge signal while a completed child returns to its parent", () => {
    const returningEvents: RuntimeEvent[] = [
      ...events,
      {
        id: "a:3",
        type: "span:finish",
        traceId: "a",
        spanId: "service-span",
        parentSpanId: "route-span",
        nodeId: "service.test",
        timestamp: 200,
        duration: 90,
        sequence: 3,
      },
    ];
    const { container, rerender } = render(
      <RuntimeCanvas
        topology={topology}
        events={returningEvents}
        onSelectNode={() => undefined}
        now={300}
      />,
    );
    expect(container.querySelector(".edge-return")).toBeInTheDocument();
    expect(container.querySelector(".traveler-return")).toBeInTheDocument();

    rerender(
      <RuntimeCanvas
        topology={topology}
        events={returningEvents}
        onSelectNode={() => undefined}
        now={2_000}
      />,
    );
    expect(container.querySelector(".edge-complete")).toBeInTheDocument();
    expect(container.querySelector(".traveler-return")).not.toBeInTheDocument();
  });
});
