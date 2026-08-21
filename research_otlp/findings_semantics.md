# OpenTelemetry semantic conventions for Runtime Atlas inference

Checked against the current official OpenTelemetry Semantic Conventions **1.44.0**. Only official OpenTelemetry specifications are cited.

## Recommended inference signals

| Runtime Atlas inference | Current canonical signals | Stability / interpretation |
| --- | --- | --- |
| Owning service | Resource `service.name`; optionally pair with resource `service.namespace` | Both are **Stable**. `service.name` is the logical service name and is identical across horizontally scaled instances. It is a **resource attribute**, not a span attribute. SDK fallback is `unknown_service:<process.executable.name>` or `unknown_service`, so Runtime Atlas should preserve that honest fallback rather than inventing an identity. |
| HTTP server / route | `span.kind == SERVER`, `http.request.method`, `http.route`; `url.path` is required context when present | HTTP server spans and these attributes are **Stable**. `http.route` is conditionally required when available and is the low-cardinality matched route template. Prefer a label such as `METHOD route`; do not turn a raw, potentially high-cardinality path into a route template. |
| External HTTP client | `span.kind == CLIENT`, `http.request.method`, `server.address`, `url.full`; optionally `server.port` | HTTP client span and listed attributes are **Stable** and required. `url.full` is the absolute URL, while `server.address` is the destination host/address. Credentials and known sensitive query values must be redacted by instrumentation; a consumer should still avoid exposing query strings unnecessarily. |
| Database | `db.system.name`; refine with `db.operation.name`, `db.namespace`, `db.collection.name`, `server.address` | Database client span and these core attributes are **Stable**. `db.system.name` is required; `db.operation.name` and `db.namespace` are conditionally required. Database span kind should be `CLIENT`, except in-memory database calls may be `INTERNAL`. Let `db.*` outrank a generic `CLIENT` inference because a database implementation may itself use nested HTTP client spans. |
| Redis / cache-like dependency | `db.system.name == "redis"` or `"memcached"`; for Redis, `db.operation.name` and optionally `db.namespace` | The database span schema and the attribute keys are Stable. The Redis-specific span convention is still **Development**, although its listed `db.operation.name`, `db.namespace`, and error attributes are individually Stable; it requires `db.system.name = "redis"`, uses Redis command name as `db.operation.name`, and represents the database index as string `db.namespace`. The well-known identifier values `redis` and `memcached` are currently Development. There is no separate generic Cache semantic-convention area or canonical `cache.*` span schema in 1.44.0, so infer a cache node only from an explicit known product such as Redis/Memcached (or a Runtime Atlas override), not from invented `cache.*` keys. |
| Messaging / broker | `messaging.system`, `messaging.destination.name`, `messaging.operation.name`, `messaging.operation.type`; optionally `server.address` | These are the **current** names, but messaging spans and these attributes remain **Development**, not Stable. `messaging.operation.type` values are `create`, `send`, `receive`, `process`, and `settle`. Create/send producer work generally uses `PRODUCER`; consumer processing uses the messaging-defined kind. Treat the attributes as current, version-sensitive signals rather than a frozen stable contract. |
| Code location | `code.function.name`, `code.file.path`, `code.line.number` | All are **Stable**. Function name is fully qualified without arguments; file path should identify the source file as uniquely as possible; line number is an integer pointing into that file/function. Legacy `code.function`, `code.filepath`, and `code.lineno` are deprecated and should be compatibility fallbacks only. |
| Error marker | Span `status.code == Error`; stable `error.type`; domain attributes such as `http.response.status_code` or `db.response.status_code` | Span status has `Unset`, `Ok`, and `Error`. `Unset` is the default; instrumentation normally leaves successful operations Unset and should not set Ok routinely. General guidance says an errored operation should set Error and `error.type`, while successful operations should not carry `error.type`. An explicit Ok should suppress otherwise-derived errors. For HTTP specifically: 1xx-3xx are Unset absent another error; 4xx are Unset for SERVER but should be Error for CLIENT; 5xx should be Error. |

## `SpanKind` meaning

Use kind as a direction/communication signal, not as the sole node type:

- `SERVER`: incoming request/response handling.
- `CLIENT`: outgoing request/response call.
- `PRODUCER`: outgoing deferred work initiation/scheduling.
- `CONSUMER`: incoming deferred work processing.
- `INTERNAL`: in-process work; it is the default.

Technology attributes should refine the kind. For example, `CLIENT + db.system.name` is a database call, while `CLIENT + http.request.method + url.full` is an HTTP dependency.

## Practical precedence for Runtime Atlas

1. Preserve any explicit `runtime.atlas.*` override.
2. Read `service.name` from the enclosing OTLP Resource to identify the source service.
3. Infer database/cache or messaging from their technology namespaces before applying generic span-kind rules.
4. Infer HTTP server routes only from a SERVER span plus HTTP server attributes; infer external HTTP dependencies from a CLIENT span plus HTTP client attributes.
5. Use stable code attributes only as display/source-location metadata, not as proof of a service or dependency kind.
6. Mark an error from explicit Error status or `error.type`; use domain-specific response status rules only when explicit status is not Ok.

## Official sources

- Semantic Conventions 1.44.0 index: https://opentelemetry.io/docs/specs/semconv/
- HTTP spans: https://opentelemetry.io/docs/specs/semconv/http/http-spans/
- Database client spans: https://opentelemetry.io/docs/specs/semconv/db/database-spans/
- Redis client operations: https://opentelemetry.io/docs/specs/semconv/db/redis/
- Messaging spans: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
- Service attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/service/
- Code attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/
- Trace API (`SpanKind` and status): https://opentelemetry.io/docs/specs/otel/trace/api/
- Recording errors: https://opentelemetry.io/docs/specs/semconv/general/recording-errors/
