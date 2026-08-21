import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { Focus, Minus, Plus } from "lucide-react";
import type {
  AtlasEdge,
  AtlasNode,
  AtlasTopology,
  RuntimeEvent,
  RuntimeStatus,
} from "../types";
import { KindIcon } from "./KindIcon";

interface Point {
  x: number;
  y: number;
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CANVAS_WIDTH = 1240;
const MIN_CANVAS_HEIGHT = 700;
const CARD = { width: 188, height: 78 };
const KIND_COLUMN: Record<AtlasNode["kind"], number> = {
  route: 0,
  middleware: 1,
  service: 2,
  cache: 3,
  database: 3,
  external: 3,
  queue: 3,
};

const KIND_ORDER: Record<AtlasNode["kind"], number> = {
  route: 0,
  middleware: 1,
  service: 2,
  cache: 3,
  database: 4,
  external: 5,
  queue: 6,
};

function computeLayout(nodes: AtlasNode[]): {
  height: number;
  positions: Map<string, Point>;
} {
  const columns = new Map<number, AtlasNode[]>();
  for (const node of nodes) {
    const column = KIND_COLUMN[node.kind];
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }

  const largestColumn = Math.max(
    1,
    ...[...columns.values()].map((column) => column.length),
  );
  const height = Math.max(
    MIN_CANVAS_HEIGHT,
    largestColumn * (CARD.height + 24) + 86,
  );
  const positions = new Map<string, Point>();
  const xPositions = [42, 338, 650, 997];
  for (const [column, columnNodes] of columns) {
    const sorted = [...columnNodes].sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.label.localeCompare(b.label),
    );
    const available = height - 80 - CARD.height;
    const gap = available / Math.max(sorted.length - 1, 1);
    const contentHeight = sorted.length === 1 ? 0 : gap * (sorted.length - 1);
    const start = (height - CARD.height - contentHeight) / 2;
    sorted.forEach((node, index) => {
      positions.set(node.id, { x: xPositions[column], y: start + index * gap });
    });
  }
  return { height, positions };
}

function nodeState(
  nodeId: string,
  events: RuntimeEvent[],
): { status: RuntimeStatus; duration?: number } {
  const nodeEvents = events.filter((event) => event.nodeId === nodeId);
  if (!nodeEvents.length) return { status: "idle" };
  const starts = nodeEvents.filter((event) => event.type === "span:start");
  const finishes = nodeEvents.filter(
    (event) => event.type === "span:finish" || event.type === "span:error",
  );
  if (starts.length > finishes.length) return { status: "active" };
  const last = finishes.at(-1);
  return {
    status: last?.type === "span:error" ? "error" : "complete",
    duration: last?.duration,
  };
}

function edgeState(
  edge: AtlasEdge,
  events: RuntimeEvent[],
  now: number,
): "idle" | "forward" | "return" | "complete" {
  const spanStarts = new Map(
    events
      .filter((event) => event.type === "span:start" && event.spanId)
      .map((event) => [event.spanId as string, event]),
  );
  const candidates = events.filter((event) => {
    if (event.type !== "span:start" || event.nodeId !== edge.target)
      return false;
    const parent = event.parentSpanId
      ? spanStarts.get(event.parentSpanId)
      : undefined;
    return parent?.nodeId === edge.source;
  });
  const start = candidates.at(-1);
  if (!start?.spanId) return "idle";
  const finish = events.find(
    (event) =>
      event.spanId === start.spanId &&
      (event.type === "span:finish" || event.type === "span:error"),
  );
  if (!finish) return "forward";
  if (now - finish.timestamp < 900) return "return";
  return "complete";
}

function curve(source: Point, target: Point): string {
  const sx = source.x + CARD.width;
  const sy = source.y + CARD.height / 2;
  const tx = target.x;
  const ty = target.y + CARD.height / 2;
  const bend = Math.max(70, (tx - sx) * 0.48);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}

interface RuntimeCanvasProps {
  topology: AtlasTopology;
  events: RuntimeEvent[];
  selectedNodeId?: string;
  onSelectNode: (node: AtlasNode) => void;
  now: number;
  topologyMode?: boolean;
}

export function RuntimeCanvas({
  topology,
  events,
  selectedNodeId,
  onSelectNode,
  now,
  topologyMode = false,
}: RuntimeCanvasProps) {
  const layout = useMemo(() => computeLayout(topology.nodes), [topology.nodes]);
  const positions = layout.positions;
  const [viewBox, setViewBox] = useState<ViewBox>({
    x: 0,
    y: 0,
    width: CANVAS_WIDTH,
    height: layout.height,
  });
  const drag = useRef<{ x: number; y: number; viewBox: ViewBox } | undefined>(
    undefined,
  );
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    setViewBox({ x: 0, y: 0, width: CANVAS_WIDTH, height: layout.height });
  }, [layout.height]);

  const zoom = (factor: number) => {
    setViewBox((current) => {
      const nextWidth = Math.min(1700, Math.max(620, current.width * factor));
      const nextHeight = (nextWidth / CANVAS_WIDTH) * layout.height;
      return {
        x: current.x + (current.width - nextWidth) / 2,
        y: current.y + (current.height - nextHeight) / 2,
        width: nextWidth,
        height: nextHeight,
      };
    });
  };

  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    zoom(event.deltaY > 0 ? 1.08 : 0.92);
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest(".atlas-node")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, viewBox };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx =
      ((event.clientX - drag.current.x) / rect.width) *
      drag.current.viewBox.width;
    const dy =
      ((event.clientY - drag.current.y) / rect.height) *
      drag.current.viewBox.height;
    setViewBox({
      ...drag.current.viewBox,
      x: drag.current.viewBox.x - dx,
      y: drag.current.viewBox.y - dy,
    });
  };

  const stopDrag = () => {
    drag.current = undefined;
  };

  return (
    <section className="map-shell" aria-label="Application runtime map">
      <div className="map-hud map-hud-left" aria-hidden="true">
        <span>REQUEST FLOW</span>
        <i />
        <span>RESPONSE FLOW</span>
      </div>
      <div className="map-hud map-hud-right" aria-hidden="true">
        AST + RUNTIME
      </div>
      <div className="zoom-controls" aria-label="Map zoom controls">
        <button type="button" onClick={() => zoom(0.86)} aria-label="Zoom in">
          <Plus size={15} />
        </button>
        <button type="button" onClick={() => zoom(1.16)} aria-label="Zoom out">
          <Minus size={15} />
        </button>
        <button
          type="button"
          onClick={() =>
            setViewBox({
              x: 0,
              y: 0,
              width: CANVAS_WIDTH,
              height: layout.height,
            })
          }
          aria-label="Fit map"
        >
          <Focus size={15} />
        </button>
      </div>
      <svg
        ref={svgRef}
        className="runtime-canvas"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        role="group"
        aria-label={`${topology.nodes.length} runtime nodes and ${topology.edges.length} code-derived connections`}
      >
        <defs>
          <filter
            id="active-glow"
            x="-100%"
            y="-100%"
            width="300%"
            height="300%"
          >
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className="column-labels" aria-hidden="true">
          <text x="42" y="28">
            01 / ENTRY
          </text>
          <text x="338" y="28">
            02 / POLICY
          </text>
          <text x="650" y="28">
            03 / DOMAIN
          </text>
          <text x="997" y="28">
            04 / DEPENDENCIES
          </text>
        </g>
        <g className="edge-layer">
          {topology.edges.map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const path = curve(source, target);
            const state = edgeState(edge, events, now);
            const pathId = `edge-${edge.id.replace(/[^a-z0-9]/gi, "-")}`;
            return (
              <g key={edge.id} className={`atlas-edge edge-${state}`}>
                <path className="edge-base" d={path} />
                <path id={pathId} className="edge-signal" d={path} />
                {(state === "forward" || state === "return") && (
                  <circle
                    className={`traveler traveler-${state}`}
                    r="4.5"
                    filter="url(#active-glow)"
                  >
                    <animateMotion
                      dur="0.85s"
                      repeatCount="indefinite"
                      keyPoints={state === "return" ? "1;0" : "0;1"}
                      keyTimes="0;1"
                    >
                      <mpath href={`#${pathId}`} />
                    </animateMotion>
                  </circle>
                )}
              </g>
            );
          })}
        </g>
        <g className="node-layer">
          {topology.nodes.map((node) => {
            const position = positions.get(node.id);
            if (!position) return null;
            const state = nodeState(node.id, events);
            return (
              <foreignObject
                key={node.id}
                x={position.x}
                y={position.y}
                width={CARD.width}
                height={CARD.height}
                className="atlas-node"
              >
                <button
                  type="button"
                  className={`node-card kind-${node.kind} status-${state.status} ${selectedNodeId === node.id ? "is-selected" : ""}`}
                  onClick={() => onSelectNode(node)}
                  aria-label={`${node.label}, ${node.kind}, ${state.status}`}
                >
                  <span className="node-icon">
                    <KindIcon kind={node.kind} />
                  </span>
                  <span className="node-copy">
                    <small>{node.kind}</small>
                    <strong>{node.label}</strong>
                  </span>
                  <span className="node-readout">
                    {state.status === "active" ? (
                      <i className="active-bars" />
                    ) : state.duration != null ? (
                      `${state.duration}ms`
                    ) : (
                      "—"
                    )}
                  </span>
                </button>
              </foreignObject>
            );
          })}
        </g>
      </svg>
      {!events.length && (
        <div className="empty-map-callout">
          <span>{topologyMode ? "STATIC TOPOLOGY" : "MAP READY"}</span>
          <strong>
            {topologyMode
              ? "Structure derived from source."
              : "Run a scenario to wake the system."}
          </strong>
          <p>
            {topologyMode
              ? "Switch to Live Map to watch causal runtime evidence move across these code-derived links."
              : "1 · Run a scenario  2 · Select a node  3 · Replay the response path"}
          </p>
        </div>
      )}
    </section>
  );
}
