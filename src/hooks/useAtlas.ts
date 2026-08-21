import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AtlasTopology,
  NodeKind,
  RuntimeEvent,
  TraceSummary,
} from "../types";

const NODE_KINDS = new Set<NodeKind>([
  "route",
  "middleware",
  "service",
  "database",
  "cache",
  "external",
  "queue",
]);
export type DemoScenario = "checkout" | "search" | "failure";

async function readApiError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as
    { error?: string | { message?: string } } | undefined;
  if (typeof body?.error === "string") return body.error;
  return body?.error?.message ?? `Request returned HTTP ${response.status}`;
}

export function reconcileRuntimeTopology(
  topology: AtlasTopology,
  event: RuntimeEvent,
  parentNodeId?: string,
): AtlasTopology {
  if (event.type !== "span:start" || !event.nodeId) return topology;
  const detailKind = event.detail?.kind;
  const kind =
    typeof detailKind === "string" && NODE_KINDS.has(detailKind as NodeKind)
      ? (detailKind as NodeKind)
      : "service";
  const hasNode = topology.nodes.some((node) => node.id === event.nodeId);
  const edgeId = parentNodeId ? `${parentNodeId}->${event.nodeId}` : undefined;
  const hasEdge = !edgeId || topology.edges.some((edge) => edge.id === edgeId);
  if (hasNode && hasEdge) return topology;

  const runtimeMeta = Object.fromEntries(
    Object.entries(event.detail ?? {})
      .filter(([key]) => !["kind", "label", "description"].includes(key))
      .map(([key, value]) => [key, String(value)]),
  );
  const runtimeFile =
    typeof event.detail?.["code.file.path"] === "string"
      ? event.detail["code.file.path"]
      : `${event.service ?? "unknown service"} / runtime discovered`;
  const runtimeLine =
    typeof event.detail?.["code.line.number"] === "number"
      ? Math.max(0, Math.trunc(event.detail["code.line.number"]))
      : 0;
  return {
    ...topology,
    nodes: hasNode
      ? topology.nodes
      : [
          ...topology.nodes,
          {
            id: event.nodeId,
            symbol: event.nodeId,
            label:
              typeof event.detail?.label === "string"
                ? event.detail.label
                : event.nodeId,
            description:
              typeof event.detail?.description === "string"
                ? event.detail.description
                : `Discovered from live events emitted by ${event.service ?? "an instrumented service"}.`,
            kind,
            meta: runtimeMeta,
            source: {
              file: runtimeFile,
              line: runtimeLine,
              column: 0,
              runtimeOnly: true,
            },
          },
        ],
    edges:
      hasEdge || !edgeId || !parentNodeId
        ? topology.edges
        : [
            ...topology.edges,
            { id: edgeId, source: parentNodeId, target: event.nodeId },
          ],
  };
}

function mergeEventIntoTraces(
  traces: TraceSummary[],
  event: RuntimeEvent,
): TraceSummary[] {
  let trace = traces.find((candidate) => candidate.id === event.traceId);
  if (!trace && event.type !== "trace:start") return traces;

  if (!trace) {
    trace = {
      id: event.traceId,
      method: event.request?.method ?? "—",
      path: event.request?.path ?? "unknown",
      startedAt: event.timestamp,
      outcome: "running",
      events: [],
    };
  }

  const alreadyPresent = trace.events.some(
    (candidate) => candidate.id === event.id,
  );
  const nextTrace: TraceSummary = {
    ...trace,
    events: alreadyPresent
      ? trace.events
      : [...trace.events, event].sort((a, b) => a.sequence - b.sequence),
  };

  if (event.type === "trace:finish") {
    nextTrace.duration = event.duration;
    nextTrace.status = event.request?.status;
    nextTrace.outcome = event.error ? "error" : "ok";
  }

  return [nextTrace, ...traces.filter((candidate) => candidate.id !== trace.id)]
    .sort((a, b) => {
      const aSequence = a.events.at(-1)?.sequence ?? 0;
      const bSequence = b.events.at(-1)?.sequence ?? 0;
      return bSequence - aSequence || b.startedAt - a.startedAt;
    })
    .slice(0, 60);
}

export function useAtlas() {
  const [topology, setTopology] = useState<AtlasTopology>();
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [requesting, setRequesting] = useState<string>();
  const [reloadVersion, setReloadVersion] = useState(0);
  const latestTraceRef = useRef<string | undefined>(undefined);
  const spanNodesRef = useRef(
    new Map<string, { nodeId: string; traceId: string }>(),
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    Promise.all([
      fetch("/api/topology", { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error("Topology endpoint is unavailable");
        return response.json() as Promise<AtlasTopology>;
      }),
      fetch("/api/traces", { signal: controller.signal }).then((response) => {
        if (!response.ok)
          throw new Error("Trace history endpoint is unavailable");
        return response.json() as Promise<TraceSummary[]>;
      }),
    ])
      .then(([nextTopology, nextTraces]) => {
        if (cancelled) return;
        setTopology(nextTopology);
        setTraces(nextTraces);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Atlas failed to initialize",
          );
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadVersion]);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("ready", () => {
      setConnected(true);
      setError(undefined);
    });
    source.addEventListener("runtime", (message) => {
      let event: RuntimeEvent;
      try {
        event = JSON.parse(
          (message as MessageEvent<string>).data,
        ) as RuntimeEvent;
      } catch {
        setError(
          "Collector sent an unreadable live event; reconnecting may recover the stream",
        );
        return;
      }
      if (event.type === "trace:start") latestTraceRef.current = event.traceId;
      if (event.type === "span:start" && event.spanId && event.nodeId) {
        const parentNodeId = event.parentSpanId
          ? spanNodesRef.current.get(event.parentSpanId)?.nodeId
          : undefined;
        spanNodesRef.current.set(event.spanId, {
          nodeId: event.nodeId,
          traceId: event.traceId,
        });
        if (spanNodesRef.current.size > 5_000) {
          const oldest = spanNodesRef.current.keys().next().value as
            string | undefined;
          if (oldest) spanNodesRef.current.delete(oldest);
        }
        setTopology((current) =>
          current
            ? reconcileRuntimeTopology(current, event, parentNodeId)
            : current,
        );
      }
      if (event.type === "trace:finish") {
        for (const [spanId, span] of spanNodesRef.current) {
          if (span.traceId === event.traceId)
            spanNodesRef.current.delete(spanId);
        }
      }
      setTraces((current) => mergeEventIntoTraces(current, event));
    });
    source.onerror = () => {
      setConnected(false);
      setError("Live stream reconnecting");
    };
    return () => source.close();
  }, []);

  const launchRequest = useCallback(async (kind: DemoScenario) => {
    setRequesting(kind);
    setError(undefined);
    try {
      const response = await fetch(`/api/demo/${kind}`, {
        method: kind === "search" ? "GET" : "POST",
      });
      const expectedFailure = kind === "failure" && response.status === 503;
      if (!response.ok && !expectedFailure)
        throw new Error(await readApiError(response));
      await response.json().catch(() => undefined);
      return latestTraceRef.current;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
      return undefined;
    } finally {
      setRequesting(undefined);
    }
  }, []);

  const clearTraces = useCallback(async () => {
    setError(undefined);
    const response = await fetch("/api/traces", { method: "DELETE" });
    if (!response.ok) {
      setError(await readApiError(response));
      return false;
    }
    setTraces([]);
    latestTraceRef.current = undefined;
    spanNodesRef.current.clear();
    return true;
  }, []);

  const reload = useCallback(() => {
    setTopology(undefined);
    setError(undefined);
    setReloadVersion((current) => current + 1);
  }, []);
  const dismissError = useCallback(() => setError(undefined), []);

  const inFlight = useMemo(
    () => traces.filter((trace) => trace.outcome === "running").length,
    [traces],
  );

  return {
    topology,
    traces,
    connected,
    error,
    requesting,
    inFlight,
    launchRequest,
    clearTraces,
    reload,
    dismissError,
  };
}
