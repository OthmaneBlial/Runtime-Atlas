# Runtime Atlas

Runtime Atlas is an interactive application map that combines static TypeScript analysis with live request instrumentation. It illuminates routes, middleware, services, databases, caches, queues, and external APIs while a real request crosses the demo system, then shows the response returning through the same causal path.

## What is real today

- `server/analyzer.ts` parses `server/demo-application.ts` with the TypeScript AST through `ts-morph`. Nodes come from `atlas.*` declarations and edges come from actual handler call sites.
- `server/runtime.ts` instruments async handlers with `AsyncLocalStorage`, keeping parent/child span relationships intact across concurrent branches.
- `server/index.ts` accepts first-party SDK batches and OTLP/HTTP JSON traces, streams lifecycle events over SSE, and exposes recent traces, analyzed topology, health, and two instrumented demo endpoints.
- The React map renders the static topology immediately, animates live outbound and returning flow, keeps a selectable request history, supports trace replay/scrubbing, and inspects source locations plus measured node latency.

The first-party Node SDK can instrument a separate TypeScript service, including Connect/Express request lifecycles. Existing OpenTelemetry services can send standard OTLP/HTTP JSON without adopting the SDK.

## Run locally

Requires a modern Node.js release.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`, then use **POST /checkout** or **GET /search** to send a real request through the instrumented service.

Production mode:

```bash
npm run build
npm start
```

Open `http://localhost:4319`.

## Connect another Node service

Build the local workspace package, then import `@runtime-atlas/sdk` in the service. The complete example is in `examples/instrumented-orders.ts`.

```ts
import { createAtlas } from "@runtime-atlas/sdk";

const atlas = createAtlas({
  serviceName: "orders-api",
  collectorUrl: "http://localhost:4319",
  // Telemetry remains bounded if the collector is temporarily unreachable.
  maxQueueSize: 2_000,
});

// Connect/Express compatible: starts at request entry and finishes when the
// actual response emits `finish`. Health checks can be filtered with `ignore`.
app.use(atlas.httpMiddleware({
  path: (request) => request.originalUrl?.replace(/\/\d+(?=\/|$)/g, "/:id") ?? "/",
  ignore: (request) => request.url === "/health",
}));

const ordersDb = atlas.database(
  { id: "db.orders", label: "Orders DB" },
  async () => saveOrder(),
);

const createOrder = atlas.route(
  { id: "route.orders", label: "POST /orders" },
  async () => ordersDb(),
);

app.post("/orders", async (_request, response) => {
  response.status(201).json(await createOrder());
});
```

For frameworks without Connect-style middleware, use `atlas.trace()` around the request handler as shown in the complete example.

Point static analysis at that service when starting the dashboard. Comma-separated globs are supported.

```bash
ATLAS_SOURCE_GLOB='../orders/src/**/*.ts' \
ATLAS_PROJECT_NAME='orders-api' \
ATLAS_ENVIRONMENT='development' \
npm start
```

For a collector reachable outside localhost, set an ingest token and pass the same bearer value from the SDK without printing or committing it:

```ts
const atlas = createAtlas({
  serviceName: "orders-api",
  collectorUrl: process.env.ATLAS_COLLECTOR_URL,
  headers: { authorization: `Bearer ${process.env.ATLAS_INGEST_TOKEN}` },
});
```

The dashboard reads `ATLAS_INGEST_TOKEN` server-side. When it is set, unauthenticated ingest batches receive HTTP 401.

## Connect OpenTelemetry

Point an OTLP/HTTP JSON trace exporter at the collector's exact traces endpoint:

```text
http://localhost:4319/v1/traces
```

Exporter support for OTLP JSON varies, so explicitly select JSON rather than the more common binary protobuf transport. Runtime Atlas currently rejects `application/x-protobuf` with HTTP 415. Uncompressed and gzip-compressed JSON requests are accepted.

The included standards-shaped payload is useful for a direct smoke test:

```bash
curl --request POST http://localhost:4319/v1/traces \
  --header 'content-type: application/json' \
  --data-binary @examples/otlp-trace.json
```

Runtime Atlas groups complete spans by trace ID, emits causal start/finish events, and reconciles each live span with the AST topology in this order:

1. Explicit `runtime.atlas.node_id` override.
2. Stable `code.function.name` or exact `code.file.path` plus `code.line.number`.
3. Matching HTTP method and `http.route` for a static route.
4. A runtime-only node inferred from database, Redis/Memcached, messaging, HTTP client/server, and service signals.

Only an allowlist of useful semantic attributes reaches the UI. `url.full`, query strings, arbitrary attributes, and database statements are not retained. Set `ATLAS_INGEST_TOKEN` to apply the same bearer authentication used by `/api/ingest`. Collector capacity is bounded and configurable:

```bash
ATLAS_OTLP_BODY_LIMIT=8mb \
ATLAS_OTLP_MAX_SPANS=1000 \
ATLAS_OTLP_MAX_CONCURRENT_REQUESTS=16 \
npm start
```

The defaults are an 8 MiB decompressed body limit, 1,000 spans/groups per request, and 16 concurrent requests. Invalid individual spans produce a standard OTLP `partialSuccess` response; malformed envelopes and capacity violations produce protobuf-JSON `google.rpc.Status` errors. The implementation follows the [OTLP specification](https://opentelemetry.io/docs/specs/otlp/) and [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/).

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Collector health |
| `GET /api/topology` | Fresh AST-derived topology |
| `GET /api/source` | Analyzer-approved source context for an exact node location |
| `GET /api/traces` | Recent in-memory trace history |
| `GET /api/stream` | Server-sent runtime events |
| `POST /api/ingest` | Batched events from `@runtime-atlas/sdk` |
| `POST /v1/traces` | OTLP/HTTP JSON traces, including gzip transport |
| `POST /api/demo/checkout` | Parallel and sequential checkout trace |
| `GET /api/demo/search` | Smaller shared-infrastructure trace |

## Validation

```bash
npm run check
```

This runs analyzer, OTLP conversion, causal runtime, SDK, and interaction tests before producing the optimized UI build.
