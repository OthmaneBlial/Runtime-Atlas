# Deployment

Runtime Atlas is safest as a local developer tool or an internal service behind an authenticated reverse proxy. It is not designed for direct exposure to the public internet.

## Compiled Node.js process

```bash
nvm use
npm ci
npm run build
NODE_ENV=production npm start
```

The default listener is `127.0.0.1:4319`. `GET /health` proves that the process is alive. `GET /ready` additionally analyzes the configured source and verifies the built UI in production.

## Container

The image runs as the unprivileged `node` user and contains only production dependencies, compiled server/UI output, and the demo source needed for default static analysis.

```bash
docker compose up --build
```

The included Compose service binds the exposed container listener back to `127.0.0.1:4319`, uses a read-only filesystem, and enables demo source inspection and trace clearing for a local showcase. Remove those capabilities for shared deployments.

To analyze host source from a container, mount it read-only and set an in-container glob:

```yaml
services:
  runtime-atlas:
    volumes:
      - ../orders-api:/workspace/orders-api:ro
    environment:
      ATLAS_SOURCE_GLOB: /workspace/orders-api/src/**/*.ts
      ATLAS_PROJECT_NAME: orders-api
      ATLAS_EXPOSE_SOURCE: "false"
```

## Shared network checklist

- Bind the public listener only inside a controlled network.
- Terminate TLS and require user authentication at a reverse proxy.
- Generate an `ATLAS_INGEST_TOKEN` of at least 16 characters and deliver it as a secret.
- Keep source inspection and trace clearing disabled unless explicitly required.
- Set `ATLAS_TRUST_PROXY=true` only behind a trusted single-hop proxy; rate limiting uses the resolved client IP.
- Tune body, span, concurrency, rate, per-trace, aggregate-event, and trace limits for available memory.
- Monitor structured stdout/stderr logs and both health endpoints.
- Use one process per instance. Trace state is in memory and is not coordinated across replicas.

## Shutdown and rollback

On `SIGINT` or `SIGTERM`, the server closes SSE clients, stops accepting connections, waits for active sockets, and forces shutdown after `ATLAS_SHUTDOWN_TIMEOUT_MS`. Roll back by restoring the previous image or release; there is no persistent schema or data migration.
