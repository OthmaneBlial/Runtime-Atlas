import { describe, expect, it } from "vitest";
import type { AtlasTopology, RuntimeEvent } from "../types";
import { reconcileRuntimeTopology } from "./useAtlas";

describe("runtime topology reconciliation", () => {
  it("adds a runtime-only node and causal edge missing from static analysis", () => {
    const topology: AtlasTopology = {
      generatedAt: "2026-08-20T00:00:00.000Z",
      sourceRoot: "src",
      nodes: [
        {
          id: "route.root",
          symbol: "root",
          label: "Root",
          kind: "route",
          source: { file: "src/root.ts", line: 1, column: 1 },
        },
      ],
      edges: [],
    };
    const event: RuntimeEvent = {
      id: "trace:2",
      sequence: 2,
      traceId: "trace",
      type: "span:start",
      spanId: "worker",
      nodeId: "service.worker",
      timestamp: 2,
      service: "worker-api",
      detail: { kind: "service", label: "Live worker" },
    };

    const reconciled = reconcileRuntimeTopology(topology, event, "route.root");
    expect(reconciled.nodes.at(-1)).toMatchObject({
      id: "service.worker",
      label: "Live worker",
      kind: "service",
      source: { runtimeOnly: true },
    });
    expect(reconciled.edges).toContainEqual({
      id: "route.root->service.worker",
      source: "route.root",
      target: "service.worker",
    });
  });

  it("keeps OpenTelemetry code provenance on runtime-only nodes", () => {
    const topology: AtlasTopology = {
      generatedAt: "2026-08-20T00:00:00.000Z",
      sourceRoot: "src",
      nodes: [],
      edges: [],
    };
    const event: RuntimeEvent = {
      id: "trace:1",
      sequence: 1,
      traceId: "trace",
      type: "span:start",
      spanId: "live",
      nodeId: "otlp.service.worker.run-job",
      timestamp: 1,
      service: "worker",
      detail: {
        kind: "service",
        label: "runJob",
        provenance: "OpenTelemetry",
        "code.file.path": "/workspace/src/worker.ts",
        "code.line.number": 42,
      },
    };

    const reconciled = reconcileRuntimeTopology(topology, event);
    expect(reconciled.nodes[0]).toMatchObject({
      source: { file: "/workspace/src/worker.ts", line: 42, runtimeOnly: true },
      meta: {
        provenance: "OpenTelemetry",
        "code.file.path": "/workspace/src/worker.ts",
      },
    });
  });
});
