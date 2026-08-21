# `@runtime-atlas/sdk`

Bounded Node.js runtime instrumentation for [Runtime Atlas](https://github.com/OthmaneBlial/Runtime-Atlas). It emits causal trace/span lifecycle events without breaking observed application requests when the collector is unavailable.

This package is currently built and consumed from the Runtime Atlas workspace. Build it with `npm run build:sdk` at the repository root.

```ts
import { createAtlas } from "@runtime-atlas/sdk";

const atlas = createAtlas({
  serviceName: "orders-api",
  collectorUrl: "http://127.0.0.1:4319",
});

const database = atlas.database(
  { id: "db.orders", label: "Orders DB" },
  async () => saveOrder(),
);

await atlas.trace({ method: "POST", path: "/orders" }, database);
await atlas.close();
```

Connect/Express applications can use `atlas.httpMiddleware()` at request entry. Always normalize identifiers in URL paths. Query strings and fragments are removed by the SDK before emission.

See the [root README](https://github.com/OthmaneBlial/Runtime-Atlas#instrument-another-nodejs-service) for the complete API and collector configuration. Requires Node.js 22.22.2 or later.

MIT © Othmane BLIAL
