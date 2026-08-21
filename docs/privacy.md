# Privacy and data handling

Runtime Atlas is local-first and keeps telemetry in process memory. It does not include a database, user analytics, cookies, advertising, or a hosted Runtime Atlas service. Restarting the server clears retained telemetry; authorized users may also clear it through the UI when the capability is enabled.

## Data retained in memory

- trace IDs, span IDs, parent relationships, timestamps, durations, status, and outcome;
- bounded request method and path;
- configured node IDs and service names;
- a small allowlist of useful runtime metadata such as operation kind, code location, HTTP route, database system, and messaging destination;
- bounded error messages.

The first-party SDK strips query strings and URL fragments before emission. The OTLP converter does not retain `url.full`, database statements, request/response bodies, arbitrary span attributes, or credentials. Applications should still normalize user-specific path segments and avoid secrets in descriptor labels, service names, errors, or custom metadata.

## Source inspection

Static analysis retains source file paths and line/column locations. `/api/source` returns a small context window only when the exact file and line belong to an analyzed node. Source inspection defaults on for loopback and off for non-loopback bindings. Disable it explicitly with `ATLAS_EXPOSE_SOURCE=false` whenever viewers should not read code.

## Network and export

SSE and API responses are same-origin and receive restrictive browser security headers. Ingest can require a bearer token, but the dashboard itself does not implement user accounts. Put shared deployments behind TLS and your own authentication proxy.

Trace export is a deliberate download containing the currently retained trace history. Treat exports as internal observability data and review them before sharing. No export is created automatically on disk.

## Retention controls

| Variable                     | Default | Boundary                                 |
| ---------------------------- | ------: | ---------------------------------------- |
| `ATLAS_MAX_TRACES`           |      60 | Completed and running traces retained    |
| `ATLAS_MAX_BUFFERED_EVENTS`  |     800 | Recent events replayed to SSE clients    |
| `ATLAS_MAX_EVENTS_PER_TRACE` |   5,000 | Events retained for one trace            |
| `ATLAS_MAX_RETAINED_EVENTS`  |  50,000 | Events retained across all traces        |
| `ATLAS_MAX_STREAM_CLIENTS`   |     100 | Concurrent live SSE viewers              |
| `ATLAS_OTLP_MAX_SPANS`       |   1,000 | Span groups accepted in one OTLP request |
| `ATLAS_OTLP_BODY_LIMIT`      |   8 MiB | Decompressed OTLP request body           |

These controls limit memory use and exposure duration; they are not durable retention or compliance controls.
