# Troubleshooting

## The UI opens but shows a connection error

In development, both processes must be running: Vite on port 5173 (or the next available loopback port printed at startup) and the server on port 4319. Start them together with `npm run dev`. Check `http://127.0.0.1:4319/health`, then use the retry action in the UI.

## Readiness returns 503

Read the structured `readiness.failed` server log. Common causes are a source glob matching no files, duplicate atlas node IDs, too broad a glob, or a missing `dist/index.html` in production. Run `npm run build` before `npm start`.

## Static nodes are missing

The analyzer expects a literal call shaped like `atlas.service({ id: "...", label: "..." }, handler)`. It can find calls inside factories, but it does not execute dynamic descriptors or infer calls hidden behind another wrapper. Runtime evidence can still create a clearly marked runtime-only node.

## The collector returns 401

`ATLAS_INGEST_TOKEN` is configured on the server. Send the exact value as `Authorization: Bearer …` from the first-party SDK or OTLP exporter. Do not put the token in source, URLs, or logs.

## The OTLP collector returns 415

Runtime Atlas accepts OTLP/HTTP JSON, not binary protobuf or gRPC. Configure the exporter for JSON and send it to the exact `/v1/traces` endpoint with `Content-Type: application/json`. Gzip content encoding is supported.

## The OTLP response contains `partialSuccess`

The envelope was valid, but one or more resource/span groups were rejected because they were malformed, incomplete, or exceeded a configured bound. The response reports the rejected count; inspect exporter configuration without logging sensitive payloads.

## A trace does not appear

- Confirm `/api/ingest` returned 202 or `/v1/traces` returned 200.
- Normalize service clocks if timestamp ordering inside a trace looks wrong; newest-trace selection uses collector sequence.
- Check `ATLAS_MAX_TRACES` and `ATLAS_MAX_EVENTS_PER_TRACE` retention limits.
- If the browser temporarily disconnected, use the reconnect action. The server replays a bounded recent event buffer.

## Port 4319 is already in use

Choose a different server port, for example `PORT=4320 npm run dev:server`. During Vite development, also update the proxy target in `vite.config.ts` or stop the conflicting process.

## Node.js prints engine warnings

Use the version pinned in `.nvmrc` (`nvm install && nvm use`) and reinstall with `npm ci`. The dependency graph is tested against that runtime in CI.
