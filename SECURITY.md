# Security policy

## Supported versions

Security fixes are applied to the latest release and the `main` branch. Pre-release snapshots and older tags may not receive patches.

## Reporting a vulnerability

After the repository is published with private vulnerability reporting enabled, use **Security → Advisories → Report a vulnerability** in this repository. If that control is unavailable, contact the repository owner through an established private channel. Do not open a public issue and do not attach real credentials, customer traces, proprietary source, or exploit data to a public thread.

Include the affected commit or version, impact, a minimal safe reproduction, and any suggested mitigation. You should receive an acknowledgement within seven days. Public disclosure should wait until a fix or coordinated mitigation is available.

## Deployment boundaries

Runtime Atlas is a developer observability tool, not an authentication gateway or durable telemetry store. It binds to loopback by default. Before exposing it to a shared network:

- configure a long `ATLAS_INGEST_TOKEN` and TLS at the reverse proxy;
- keep `ATLAS_EXPOSE_SOURCE=false` unless every viewer may read analyzed code;
- keep `ATLAS_ALLOW_CLEAR=false` unless deletion is intentionally delegated;
- place the dashboard behind your own access control;
- set conservative body, concurrency, rate, event, and trace limits;
- avoid forwarding request bodies, database statements, query strings, credentials, or unrestricted span attributes.

See [the privacy model](docs/privacy.md) and [deployment guidance](docs/deployment.md) for the full threat boundary.
