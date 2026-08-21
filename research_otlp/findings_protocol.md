# OTLP/HTTP JSON trace protocol findings

Checked 2026-08-20 against OTLP Specification 1.11.0. Traces and their JSON schema are marked Stable.

## Transport contract

- Send traces with `POST /v1/traces`; the default OTLP/HTTP port is `4318`, so the conventional local URL is `http://localhost:4318/v1/traces`. A non-default path may be configured.
- A JSON request body is the protobuf-JSON representation of `ExportTraceServiceRequest` and must use `Content-Type: application/json`. The response must use the same content type as the request. Binary protobuf is the same schema under `application/x-protobuf`; a general OTLP/HTTP server should dispatch by content type.
- Requests may use `Content-Encoding: gzip`. OTLP servers must support uncompressed and gzip transports.

## JSON envelope and span shape

The traversal hierarchy is:

```text
ExportTraceServiceRequest
  resourceSpans[]                         ResourceSpans
    resource                              Resource
      attributes[]                        KeyValue
    scopeSpans[]                          ScopeSpans
      scope                               InstrumentationScope
      spans[]                             Span
```

`ResourceSpans` and `ScopeSpans` may also carry their own `schemaUrl`. A span may carry `traceId`, `spanId`, `traceState`, `parentSpanId`, `flags`, `name`, `kind`, `startTimeUnixNano`, `endTimeUnixNano`, `attributes[]`, `events[]`, `links[]`, dropped-item counts, and `status`. Event timestamps and attributes use the same timestamp and `KeyValue` encodings; links contain their own trace/span IDs and attributes; status is `{ "message": string, "code": integer-enum }`.

Representative request:

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          {
            "key": "service.name",
            "value": { "stringValue": "checkout" }
          }
        ]
      },
      "scopeSpans": [
        {
          "scope": { "name": "example.instrumentation", "version": "1.0.0" },
          "spans": [
            {
              "traceId": "5B8EFFF798038103D269B633813FC60C",
              "spanId": "EEE19B7EC3C1B174",
              "parentSpanId": "EEE19B7EC3C1B173",
              "name": "GET /orders/{id}",
              "kind": 2,
              "startTimeUnixNano": "1544712660000000000",
              "endTimeUnixNano": "1544712661000000000",
              "attributes": [
                {
                  "key": "http.request.method",
                  "value": { "stringValue": "GET" }
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## Protobuf-JSON rules that matter to a receiver

- JSON keys are protobuf field names converted to `lowerCamelCase`; snake_case keys are invalid.
- Enum values must be JSON integers, not enum-name strings. For example, server `SpanKind` is `"kind": 2` and error `StatusCode` is `"code": 2`.
- A receiver must ignore unknown message-field names for forward compatibility.
- `traceId` is a case-insensitive, hex-encoded 16-byte ID (32 hex digits). `spanId` and `parentSpanId` are hex-encoded 8-byte IDs (16 hex digits), not base64. Required trace/span IDs with the wrong length or all zeroes are invalid; a root span has an empty/omitted parent ID.
- `startTimeUnixNano`, `endTimeUnixNano`, and event `timeUnixNano` are unsigned 64-bit nanoseconds since the Unix epoch. As 64-bit protobuf integers they are emitted as decimal strings; a receiver must accept either a JSON string or number. Preserve them as a decimal string or arbitrary-precision integer rather than a JavaScript `number`. Start and end are semantically required and `end >= start` is expected.
- Other 64-bit integer fields follow the same decimal-string rule. Ordinary 32-bit counters and flags are JSON numbers.

## `AnyValue` / attribute encoding

Each `KeyValue` is `{ "key": string, "value": AnyValue }`. `AnyValue` is a protobuf `oneof` and therefore has one wrapper key:

| Type                  | JSON form                                                                              |
| --------------------- | -------------------------------------------------------------------------------------- |
| string                | `{ "stringValue": "text" }`                                                            |
| boolean               | `{ "boolValue": true }`                                                                |
| signed 64-bit integer | `{ "intValue": "42" }` (decoder also accepts `42`)                                     |
| double                | `{ "doubleValue": 3.14 }`                                                              |
| bytes                 | `{ "bytesValue": "AQI=" }` (standard protobuf base64; ID fields are the hex exception) |
| array                 | `{ "arrayValue": { "values": [AnyValue, ...] } }`                                      |
| key-value list        | `{ "kvlistValue": { "values": [{ "key": "k", "value": AnyValue }, ...] } }`            |
| empty                 | `{}`                                                                                   |

Arrays and key-value lists can recursively contain any `AnyValue`; array values need not be homogeneous. Keys in a key-value list, and attribute keys at resource/scope/span/event/link level, must be unique. `stringValueStrindex` exists as an Alpha, profiles-only choice in the current common proto; a non-profiling receiver should treat it as a non-fatal issue and process that value as empty.

## Success, partial success, and failure

- **Full success:** `HTTP 200 OK`, `Content-Type: application/json`, body `{}`. This is the JSON encoding of `ExportTraceServiceResponse` with `partialSuccess` unset. An empty telemetry request should also receive success.
- **Partial acceptance:** still `HTTP 200 OK`, with a body such as:

  ```json
  {
    "partialSuccess": {
      "rejectedSpans": "2",
      "errorMessage": "two spans had invalid identifiers"
    }
  }
  ```

  `rejectedSpans` is `int64`, hence the encoded decimal string. The server must set it to the number rejected and should provide a developer-facing English message. A populated partial-success response must not be retried.

- A server may send a warning after accepting everything by setting `rejectedSpans` to `"0"` and a non-empty `errorMessage`. An empty `partialSuccess` object is semantically equivalent to absent, although full-success senders are required to leave it unset.
- A total failure uses an appropriate `4xx`/`5xx` and a protobuf-JSON `google.rpc.Status` body, not `ExportTraceServiceResponse`. Permanently malformed data is `400`; oversize data is `413`. Retryable OTLP/HTTP statuses are `429`, `502`, `503`, and `504`.

## Collector security and size implications

- Enforce a configurable request-body limit while parsing **including after decompression**. The OTLP recommendation is 64 MiB; exceeding it must return `413 Content Too Large`. This post-decompression check is essential for gzip expansion attacks.
- Limit response bodies before compression; OTLP recommends 4 MiB. Shorten or omit optional partial-success diagnostics if needed; if a semantically equivalent response still cannot fit, return `500`.
- OTLP/HTTP endpoints may use `http` or `https`; the exporter specification provides CA verification and optional client certificate/key settings for mTLS, plus configurable HTTP headers. The trace envelope itself has no authentication field, so any caller authentication is an HTTP/TLS deployment concern rather than a JSON-envelope concern.
- Under request-rate or capacity overload, the server should return `429` or `503` and may include `Retry-After`. Bound concurrency and parsing work as well as bytes; do not rely only on the body-size check.

## Primary sources

- [OTLP Specification 1.11.0](https://opentelemetry.io/docs/specs/otlp/)
- [Trace collector service protobuf](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/trace/v1/trace_service.proto)
- [Trace data protobuf](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto)
- [Common `AnyValue` / `KeyValue` protobuf](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/common/v1/common.proto)
- [Official OTLP JSON trace example](https://github.com/open-telemetry/opentelemetry-proto/blob/main/examples/trace.json)
- [OpenTelemetry OTLP exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)
