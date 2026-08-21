export type NodeKind =
  | "route"
  | "middleware"
  | "service"
  | "database"
  | "cache"
  | "external"
  | "queue";

export type RuntimeStatus = "idle" | "active" | "complete" | "error";

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  runtimeOnly?: boolean;
}

export interface AtlasNode {
  id: string;
  symbol: string;
  label: string;
  kind: NodeKind;
  description?: string;
  meta?: Record<string, string>;
  source: SourceLocation;
}

export interface AtlasEdge {
  id: string;
  source: string;
  target: string;
}

export interface AtlasTopology {
  generatedAt: string;
  sourceRoot: string;
  project?: {
    name: string;
    environment: string;
    demo: boolean;
  };
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export type RuntimeEventType =
  | "trace:start"
  | "trace:finish"
  | "span:start"
  | "span:finish"
  | "span:error";

export interface RuntimeRequest {
  method: string;
  path: string;
  status?: number;
}

export interface RuntimeEventInput {
  eventId?: string;
  type: RuntimeEventType;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  nodeId?: string;
  timestamp: number;
  duration?: number;
  request?: RuntimeRequest;
  detail?: Record<string, string | number | boolean>;
  error?: string;
  service?: string;
}

export interface RuntimeEvent extends RuntimeEventInput {
  id: string;
  sequence: number;
}

export interface TraceSummary {
  id: string;
  method: string;
  path: string;
  startedAt: number;
  duration?: number;
  status?: number;
  outcome: "running" | "ok" | "error";
  events: RuntimeEvent[];
}

export interface NodeMetric {
  calls: number;
  errors: number;
  totalDuration: number;
  lastDuration?: number;
}
