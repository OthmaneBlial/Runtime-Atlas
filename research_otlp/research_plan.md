# OTLP ingestion research plan

## Main question

What exact OTLP/HTTP JSON trace envelope, field encodings, response contract, and stable semantic attributes should Runtime Atlas support for secure trace ingestion in August 2026?

## Subtopics

1. **OTLP/HTTP JSON protocol** — confirm the canonical `/v1/traces` request shape, protobuf-JSON encoding rules for 64-bit timestamps and IDs, success/partial-success responses, and content types from official OpenTelemetry specifications.
2. **Span semantic inference** — confirm official stable attributes and span-kind signals for HTTP server routes, database/cache calls, messaging systems, external HTTP clients, and service identity.

## Synthesis

Use the protocol findings to implement a bounded JSON parser and compliant response. Use the semantic findings to infer Runtime Atlas node kinds without inventing application data. Preserve explicit `runtime.atlas.*` attributes as higher-priority overrides and cover every supported inference with fixtures and tests.
