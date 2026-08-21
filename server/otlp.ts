import type {
  AtlasNode,
  AtlasTopology,
  NodeKind,
  RuntimeEventInput,
  RuntimeRequest,
} from "../shared/types.js";

type JsonRecord = Record<string, unknown>;
export type OtlpAttributeValue =
  | string
  | number
  | boolean
  | null
  | OtlpAttributeValue[]
  | { [key: string]: OtlpAttributeValue };

interface ParsedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  start: bigint;
  end: bigint;
  attributes: Map<string, OtlpAttributeValue>;
  resourceAttributes: Map<string, OtlpAttributeValue>;
  service: string;
  scopeName?: string;
  scopeVersion?: string;
  schemaUrl?: string;
  statusCode: number;
  statusMessage?: string;
}

interface ResolvedNode {
  nodeId: string;
  kind: NodeKind;
  label: string;
  description: string;
}

interface OrderedEvent {
  event: RuntimeEventInput;
  at: bigint;
  phase: 0 | 1 | 2 | 3;
  depth: number;
}

export interface OtlpConversionResult {
  events: RuntimeEventInput[];
  acceptedSpans: number;
  rejectedSpans: number;
  traceCount: number;
  errorMessage?: string;
}

export class OtlpRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
    readonly rpcCode: 3 | 8 = status === 413 ? 8 : 3,
  ) {
    super(message);
    this.name = "OtlpRequestError";
  }
}

const NODE_KINDS = new Set<NodeKind>([
  "route",
  "middleware",
  "service",
  "database",
  "cache",
  "external",
  "queue",
]);
const CACHE_SYSTEMS = new Set(["redis", "memcached"]);
const UINT64_MAX = (1n << 64n) - 1n;
const MAX_ATTRIBUTES = 128;
const MAX_NESTED_VALUES = 32;
const MAX_VALUE_DEPTH = 5;
const MAX_STRING_LENGTH = 2_048;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  limit = MAX_STRING_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, limit);
}

function readArray(
  record: JsonRecord,
  key: string,
  location: string,
): unknown[] {
  const value = record[key];
  if (value == null) return [];
  if (!Array.isArray(value))
    throw new OtlpRequestError(`${location}.${key} must be an array`);
  return value;
}

/** Decode the protobuf-JSON AnyValue union without coercing unknown fields. */
export function decodeOtlpAnyValue(
  value: unknown,
  depth = 0,
): OtlpAttributeValue | undefined {
  if (!isRecord(value) || depth > MAX_VALUE_DEPTH) return undefined;
  const wrappers = [
    "stringValue",
    "boolValue",
    "intValue",
    "doubleValue",
    "bytesValue",
    "arrayValue",
    "kvlistValue",
  ].filter((key) => Object.hasOwn(value, key));
  if (wrappers.length !== 1) return undefined;
  if (typeof value.stringValue === "string")
    return value.stringValue.slice(0, MAX_STRING_LENGTH);
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.intValue === "number" && Number.isInteger(value.intValue))
    return value.intValue;
  if (typeof value.intValue === "string" && /^-?\d+$/.test(value.intValue)) {
    const parsed = BigInt(value.intValue);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) &&
      parsed >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(parsed)
      : value.intValue;
  }
  if (
    typeof value.doubleValue === "number" &&
    Number.isFinite(value.doubleValue)
  )
    return value.doubleValue;
  if (
    typeof value.bytesValue === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.bytesValue,
    )
  ) {
    return { bytesValue: value.bytesValue.slice(0, MAX_STRING_LENGTH) };
  }

  if (isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values
      .slice(0, MAX_NESTED_VALUES)
      .map((entry) => decodeOtlpAnyValue(entry, depth + 1) ?? null);
  }
  if (isRecord(value.kvlistValue) && Array.isArray(value.kvlistValue.values)) {
    const entries: Array<[string, OtlpAttributeValue]> = [];
    for (const item of value.kvlistValue.values.slice(0, MAX_NESTED_VALUES)) {
      if (!isRecord(item) || typeof item.key !== "string") continue;
      const decoded = decodeOtlpAnyValue(item.value, depth + 1);
      const key = item.key.slice(0, 256);
      if (
        decoded !== undefined &&
        !entries.some(([existing]) => existing === key)
      ) {
        entries.push([key, decoded]);
      }
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

function readAttributes(
  container: JsonRecord,
): Map<string, OtlpAttributeValue> {
  const attributes = new Map<string, OtlpAttributeValue>();
  const raw = Array.isArray(container.attributes) ? container.attributes : [];
  for (const entry of raw.slice(0, MAX_ATTRIBUTES)) {
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    const key = entry.key.slice(0, 256);
    if (attributes.has(key)) continue;
    const decoded = decodeOtlpAnyValue(entry.value);
    if (decoded !== undefined) attributes.set(key, decoded);
  }
  return attributes;
}

function stringAttribute(
  attributes: Map<string, OtlpAttributeValue>,
  key: string,
): string | undefined {
  const value = attributes.get(key);
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(
  attributes: Map<string, OtlpAttributeValue>,
  key: string,
): number | undefined {
  const value = attributes.get(key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseUint64(value: unknown): bigint | undefined {
  let parsed: bigint;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    parsed = BigInt(value);
  } else if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
  ) {
    parsed = BigInt(value);
  } else {
    return undefined;
  }
  return parsed <= UINT64_MAX ? parsed : undefined;
}

function parseId(
  value: unknown,
  length: 16 | 32,
  optional = false,
): string | undefined {
  if ((value == null || value === "") && optional) return undefined;
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)
  )
    return undefined;
  if (/^0+$/.test(value)) return undefined;
  return value.toLowerCase();
}

function parseEnum(value: unknown, fallback = 0): number | undefined {
  if (value == null) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseSpan(
  value: unknown,
  resourceAttributes: Map<string, OtlpAttributeValue>,
  scope: JsonRecord,
  schemaUrl?: string,
): ParsedSpan | string {
  if (!isRecord(value)) return "span must be an object";
  const traceId = parseId(value.traceId, 32);
  if (!traceId) return "span has an invalid traceId";
  const spanId = parseId(value.spanId, 16);
  if (!spanId) return "span has an invalid spanId";
  const parentSpanId = parseId(value.parentSpanId, 16, true);
  if (
    value.parentSpanId != null &&
    value.parentSpanId !== "" &&
    !parentSpanId
  ) {
    return "span has an invalid parentSpanId";
  }
  if (parentSpanId === spanId) return "span cannot be its own parent";
  const name = boundedString(value.name, 512);
  if (!name) return "span has an empty name";
  const start = parseUint64(value.startTimeUnixNano);
  const end = parseUint64(value.endTimeUnixNano);
  if (start == null || end == null)
    return "span has an invalid nanosecond timestamp";
  if (end < start) return "span ends before it starts";
  const kind = parseEnum(value.kind);
  if (kind == null) return "span.kind must be an integer enum value";

  const status = value.status == null ? {} : value.status;
  if (!isRecord(status)) return "span.status must be an object";
  const statusCode = parseEnum(status.code);
  if (statusCode == null)
    return "span.status.code must be an integer enum value";
  const serviceName =
    stringAttribute(resourceAttributes, "service.name") || "unknown_service";
  const serviceNamespace = stringAttribute(
    resourceAttributes,
    "service.namespace",
  );
  const service = serviceNamespace
    ? `${serviceNamespace}/${serviceName}`
    : serviceName;

  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    start,
    end,
    attributes: readAttributes(value),
    resourceAttributes,
    service,
    scopeName: boundedString(scope.name, 256),
    scopeVersion: boundedString(scope.version, 128),
    schemaUrl,
    statusCode,
    statusMessage: boundedString(status.message, 512),
  };
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "unknown"
  );
}

function stripQuery(value: string): string {
  return value.split(/[?#]/, 1)[0].slice(0, 512) || "/";
}

function explicitNodeId(span: ParsedSpan): string | undefined {
  const value = stringAttribute(span.attributes, "runtime.atlas.node_id");
  return value && /^[a-zA-Z0-9._:/-]{1,256}$/.test(value) ? value : undefined;
}

function destinationHost(span: ParsedSpan): string | undefined {
  const address = stringAttribute(span.attributes, "server.address");
  if (address) return address.slice(0, 256);
  const fullUrl = stringAttribute(span.attributes, "url.full");
  if (!fullUrl) return undefined;
  try {
    return new URL(fullUrl).host.slice(0, 256);
  } catch {
    return undefined;
  }
}

function inferredKind(span: ParsedSpan): NodeKind {
  const override = stringAttribute(span.attributes, "runtime.atlas.kind") as
    NodeKind | undefined;
  if (override && NODE_KINDS.has(override)) return override;
  const databaseSystem = stringAttribute(
    span.attributes,
    "db.system.name",
  )?.toLowerCase();
  if (databaseSystem)
    return CACHE_SYSTEMS.has(databaseSystem) ? "cache" : "database";
  if (stringAttribute(span.attributes, "messaging.system")) return "queue";
  if (
    span.kind === 2 &&
    stringAttribute(span.attributes, "http.request.method")
  )
    return "route";
  if (
    span.kind === 3 &&
    (stringAttribute(span.attributes, "http.request.method") ||
      stringAttribute(span.attributes, "url.full") ||
      stringAttribute(span.attributes, "server.address"))
  )
    return "external";
  return "service";
}

function nodePresentation(
  span: ParsedSpan,
  kind: NodeKind,
): Omit<ResolvedNode, "nodeId" | "kind"> & { key: string } {
  const method = stringAttribute(
    span.attributes,
    "http.request.method",
  )?.toUpperCase();
  const route = stringAttribute(span.attributes, "http.route");
  const databaseSystem = stringAttribute(span.attributes, "db.system.name");
  const databaseNamespace = stringAttribute(span.attributes, "db.namespace");
  const operation = stringAttribute(span.attributes, "db.operation.name");
  const messagingSystem = stringAttribute(span.attributes, "messaging.system");
  const destination = stringAttribute(
    span.attributes,
    "messaging.destination.name",
  );
  const codeFunction = stringAttribute(span.attributes, "code.function.name");

  switch (kind) {
    case "route": {
      const routeLabel = route ? stripQuery(route) : "HTTP server";
      return {
        key: `${method ?? "HTTP"}-${routeLabel}`,
        label: `${method ?? "HTTP"} ${routeLabel}`,
        description: `Incoming HTTP request observed in ${span.service}.`,
      };
    }
    case "database":
    case "cache": {
      const system =
        databaseSystem ?? (kind === "cache" ? "Cache" : "Database");
      const label = [system, databaseNamespace].filter(Boolean).join(" / ");
      return {
        key: `${system}-${databaseNamespace ?? destinationHost(span) ?? "default"}`,
        label,
        description: `${operation ? `${operation} operation on` : "Call to"} ${label}.`,
      };
    }
    case "external": {
      const host = destinationHost(span) ?? "external service";
      return {
        key: host,
        label: `${method ?? "CALL"} ${host}`,
        description: `Outbound dependency call from ${span.service}; URL query data is not retained.`,
      };
    }
    case "queue": {
      const label = [messagingSystem ?? "Message broker", destination]
        .filter(Boolean)
        .join(" / ");
      return {
        key: `${messagingSystem ?? "messaging"}-${destination ?? "default"}`,
        label,
        description: `Messaging operation observed from ${span.service}.`,
      };
    }
    default:
      return {
        key: codeFunction ?? stripQuery(span.name),
        label: codeFunction?.split(/[.:/#]/).at(-1) || stripQuery(span.name),
        description: `In-process span emitted by ${span.service}.`,
      };
  }
}

function normalizedFile(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolveStaticNode(
  span: ParsedSpan,
  topology: AtlasTopology,
): AtlasNode | undefined {
  const explicitId = explicitNodeId(span);
  if (explicitId) {
    const exact = topology.nodes.find((node) => node.id === explicitId);
    if (exact) return exact;
  }

  const functionName = stringAttribute(span.attributes, "code.function.name");
  if (functionName) {
    const exact = topology.nodes.filter((node) => node.symbol === functionName);
    if (exact.length === 1) return exact[0];
    const tail = functionName.split(/[.:/#]/).at(-1);
    const suffix = topology.nodes.filter((node) => node.symbol === tail);
    if (suffix.length === 1) return suffix[0];
  }

  const codeFile =
    stringAttribute(span.attributes, "code.file.path") ??
    stringAttribute(span.attributes, "code.filepath");
  const codeLine =
    numberAttribute(span.attributes, "code.line.number") ??
    numberAttribute(span.attributes, "code.lineno");
  if (codeFile && codeLine != null) {
    const sought = normalizedFile(codeFile);
    const sourceMatches = topology.nodes.filter((node) => {
      const candidate = normalizedFile(node.source.file);
      return (
        node.source.line === codeLine &&
        (sought === candidate || sought.endsWith(`/${candidate}`))
      );
    });
    if (sourceMatches.length === 1) return sourceMatches[0];
  }

  if (inferredKind(span) === "route") {
    const method = stringAttribute(
      span.attributes,
      "http.request.method",
    )?.toUpperCase();
    const route = stringAttribute(span.attributes, "http.route");
    if (method && route) {
      const routeMatches = topology.nodes.filter(
        (node) =>
          node.kind === "route" &&
          node.meta?.method?.toUpperCase() === method &&
          node.meta?.path === route,
      );
      if (routeMatches.length === 1) return routeMatches[0];
    }
  }
  return undefined;
}

function resolveNode(span: ParsedSpan, topology: AtlasTopology): ResolvedNode {
  const staticNode = resolveStaticNode(span, topology);
  if (staticNode) {
    return {
      nodeId: staticNode.id,
      kind: staticNode.kind,
      label: staticNode.label,
      description:
        staticNode.description ?? `Static node reconciled with ${span.name}.`,
    };
  }

  const kind = inferredKind(span);
  const presentation = nodePresentation(span, kind);
  const explicitId = explicitNodeId(span);
  return {
    nodeId:
      explicitId?.slice(0, 256) ||
      `otlp.${kind}.${slug(span.service)}.${slug(presentation.key)}`,
    kind,
    label: presentation.label.slice(0, 256),
    description: presentation.description.slice(0, 512),
  };
}

function errorForSpan(span: ParsedSpan): string | undefined {
  if (span.statusCode === 1) return undefined;
  const errorType = stringAttribute(span.attributes, "error.type");
  if (span.statusCode === 2)
    return (
      span.statusMessage || errorType || "OpenTelemetry span reported an error"
    );
  if (errorType) return errorType;
  const httpStatus = numberAttribute(
    span.attributes,
    "http.response.status_code",
  );
  if (
    httpStatus != null &&
    (httpStatus >= 500 || (httpStatus >= 400 && span.kind === 3))
  ) {
    return `HTTP ${httpStatus}`;
  }
  return undefined;
}

function milliseconds(timestamp: bigint): number {
  return Number(timestamp / 1_000_000n);
}

function durationMilliseconds(start: bigint, end: bigint): number {
  return Math.round((Number(end - start) / 1_000_000) * 1_000) / 1_000;
}

function detailForSpan(
  span: ParsedSpan,
  node: ResolvedNode,
): Record<string, string | number | boolean> {
  const detail: Record<string, string | number | boolean> = {
    kind: node.kind,
    label: node.label,
    description: node.description,
    provenance: "OpenTelemetry",
    "otel.span": stripQuery(span.name),
  };
  if (span.scopeName)
    detail["otel.scope"] = span.scopeVersion
      ? `${span.scopeName}@${span.scopeVersion}`
      : span.scopeName;
  if (span.schemaUrl) detail["otel.schema"] = span.schemaUrl;
  const serviceNamespace = stringAttribute(
    span.resourceAttributes,
    "service.namespace",
  );
  if (serviceNamespace) detail["service.namespace"] = serviceNamespace;

  const safeAttributes = [
    "http.request.method",
    "http.route",
    "http.response.status_code",
    "server.address",
    "server.port",
    "db.system.name",
    "db.operation.name",
    "db.namespace",
    "db.collection.name",
    "messaging.system",
    "messaging.destination.name",
    "messaging.operation.name",
    "messaging.operation.type",
    "code.function.name",
    "code.file.path",
    "code.line.number",
    "error.type",
  ];
  for (const key of safeAttributes) {
    const value = span.attributes.get(key);
    if (["string", "number", "boolean"].includes(typeof value)) {
      detail[key] = value as string | number | boolean;
    }
  }
  return detail;
}

function depthOf(
  span: ParsedSpan,
  spans: Map<string, ParsedSpan>,
  visiting = new Set<string>(),
): number {
  if (!span.parentSpanId || visiting.has(span.spanId)) return 0;
  const parent = spans.get(span.parentSpanId);
  if (!parent) return 0;
  visiting.add(span.spanId);
  return Math.min(64, depthOf(parent, spans, visiting) + 1);
}

function requestForTrace(spans: ParsedSpan[]): {
  request: RuntimeRequest;
  root: ParsedSpan;
} {
  const root =
    spans.find(
      (span) =>
        span.kind === 2 &&
        !span.parentSpanId &&
        stringAttribute(span.attributes, "http.request.method"),
    ) ??
    spans.find(
      (span) =>
        span.kind === 2 &&
        stringAttribute(span.attributes, "http.request.method"),
    ) ??
    [...spans].sort((a, b) =>
      a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
    )[0];
  const method =
    stringAttribute(root.attributes, "http.request.method")?.toUpperCase() ??
    "TRACE";
  const route = stringAttribute(root.attributes, "http.route");
  const urlPath = stringAttribute(root.attributes, "url.path");
  const status = numberAttribute(root.attributes, "http.response.status_code");
  return {
    root,
    request: {
      method,
      path: stripQuery(route ?? urlPath ?? root.name ?? root.service),
      ...(status != null ? { status } : {}),
    },
  };
}

function convertTrace(
  spans: ParsedSpan[],
  topology: AtlasTopology,
): RuntimeEventInput[] {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const start = spans.reduce(
    (minimum, span) => (span.start < minimum ? span.start : minimum),
    spans[0].start,
  );
  const end = spans.reduce(
    (maximum, span) => (span.end > maximum ? span.end : maximum),
    spans[0].end,
  );
  const { request, root } = requestForTrace(spans);
  const traceError =
    errorForSpan(root) ?? spans.map(errorForSpan).find(Boolean);
  const finalRequest: RuntimeRequest = {
    ...request,
    status: request.status ?? (traceError ? 500 : 200),
  };
  const ordered: OrderedEvent[] = [
    {
      at: start,
      phase: 0,
      depth: -1,
      event: {
        eventId: `otlp:${root.traceId}:trace:start:${start}`,
        type: "trace:start",
        traceId: root.traceId,
        timestamp: milliseconds(start),
        request,
        service: root.service,
      },
    },
  ];

  for (const span of spans) {
    const node = resolveNode(span, topology);
    const depth = depthOf(span, byId);
    const common = {
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      nodeId: node.nodeId,
      service: span.service,
    };
    ordered.push({
      at: span.start,
      phase: 1,
      depth,
      event: {
        ...common,
        eventId: `otlp:${span.traceId}:${span.spanId}:start`,
        type: "span:start",
        timestamp: milliseconds(span.start),
        detail: detailForSpan(span, node),
      },
    });
    const error = errorForSpan(span);
    ordered.push({
      at: span.end,
      phase: 2,
      depth,
      event: {
        ...common,
        eventId: `otlp:${span.traceId}:${span.spanId}:finish`,
        type: error ? "span:error" : "span:finish",
        timestamp: milliseconds(span.end),
        duration: durationMilliseconds(span.start, span.end),
        ...(error ? { error } : {}),
      },
    });
  }

  ordered.push({
    at: end,
    phase: 3,
    depth: -1,
    event: {
      eventId: `otlp:${root.traceId}:trace:finish:${end}`,
      type: "trace:finish",
      traceId: root.traceId,
      timestamp: milliseconds(end),
      duration: durationMilliseconds(start, end),
      request: finalRequest,
      service: root.service,
      ...(traceError ? { error: traceError } : {}),
    },
  });

  return ordered
    .sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1;
      if (a.phase !== b.phase) return a.phase - b.phase;
      if (a.phase === 1 && a.depth !== b.depth) return a.depth - b.depth;
      if (a.phase === 2 && a.depth !== b.depth) return b.depth - a.depth;
      return (a.event.spanId ?? "").localeCompare(b.event.spanId ?? "");
    })
    .map(({ event }) => event);
}

export function convertOtlpTraceRequest(
  payload: unknown,
  topology: AtlasTopology,
  maxSpans = 1_000,
): OtlpConversionResult {
  if (!isRecord(payload))
    throw new OtlpRequestError("OTLP request body must be a JSON object");
  const resourceSpans = readArray(payload, "resourceSpans", "request");
  if (resourceSpans.length > maxSpans) {
    throw new OtlpRequestError(
      `OTLP request exceeds the ${maxSpans} resource group limit`,
      413,
    );
  }
  const parsed: ParsedSpan[] = [];
  const parsedSpanIds = new Set<string>();
  const rejectionReasons: string[] = [];
  let seenSpans = 0;
  let seenScopes = 0;

  for (const [resourceIndex, resourceValue] of resourceSpans.entries()) {
    if (!isRecord(resourceValue))
      throw new OtlpRequestError(
        `resourceSpans[${resourceIndex}] must be an object`,
      );
    const resource =
      resourceValue.resource == null ? {} : resourceValue.resource;
    if (!isRecord(resource))
      throw new OtlpRequestError(
        `resourceSpans[${resourceIndex}].resource must be an object`,
      );
    const resourceAttributes = readAttributes(resource);
    const resourceSchema = boundedString(resourceValue.schemaUrl, 512);
    const scopeSpans = readArray(
      resourceValue,
      "scopeSpans",
      `resourceSpans[${resourceIndex}]`,
    );
    seenScopes += scopeSpans.length;
    if (seenScopes > maxSpans) {
      throw new OtlpRequestError(
        `OTLP request exceeds the ${maxSpans} scope group limit`,
        413,
      );
    }

    for (const [scopeIndex, scopeValue] of scopeSpans.entries()) {
      if (!isRecord(scopeValue)) {
        throw new OtlpRequestError(
          `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}] must be an object`,
        );
      }
      const scope = scopeValue.scope == null ? {} : scopeValue.scope;
      if (!isRecord(scope)) {
        throw new OtlpRequestError(
          `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].scope must be an object`,
        );
      }
      const spans = readArray(
        scopeValue,
        "spans",
        `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}]`,
      );
      seenSpans += spans.length;
      if (seenSpans > maxSpans) {
        throw new OtlpRequestError(
          `OTLP request exceeds the ${maxSpans} span limit`,
          413,
        );
      }
      const schemaUrl =
        boundedString(scopeValue.schemaUrl, 512) ?? resourceSchema;
      for (const spanValue of spans) {
        const span = parseSpan(spanValue, resourceAttributes, scope, schemaUrl);
        if (typeof span === "string") {
          rejectionReasons.push(span);
        } else {
          const spanKey = `${span.traceId}:${span.spanId}`;
          if (parsedSpanIds.has(spanKey)) {
            rejectionReasons.push("spanId is duplicated within its trace");
          } else {
            parsedSpanIds.add(spanKey);
            parsed.push(span);
          }
        }
      }
    }
  }

  const traces = new Map<string, ParsedSpan[]>();
  for (const span of parsed)
    traces.set(span.traceId, [...(traces.get(span.traceId) ?? []), span]);
  const events = [...traces.values()].flatMap((spans) =>
    convertTrace(spans, topology),
  );
  const rejectedSpans = rejectionReasons.length;
  return {
    events,
    acceptedSpans: parsed.length,
    rejectedSpans,
    traceCount: traces.size,
    ...(rejectedSpans
      ? {
          errorMessage:
            `${rejectedSpans} span${rejectedSpans === 1 ? " was" : "s were"} rejected: ${[
              ...new Set(rejectionReasons),
            ]
              .slice(0, 3)
              .join("; ")}`.slice(0, 1_024),
        }
      : {}),
  };
}
