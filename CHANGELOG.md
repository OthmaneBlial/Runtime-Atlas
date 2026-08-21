# Changelog

All notable changes will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Production server build, validated environment configuration, structured logs, request IDs, readiness checks, security headers, graceful shutdown, and bounded rate/concurrency controls.
- Trace export, trace clearing, deterministic dependency-failure demo, frontend recovery states, mobile workspace layout, bundled fonts, and live-follow controls.
- Container build, GitHub Actions CI and CodeQL, Dependabot, contributor/security guidance, and production smoke verification.

### Changed

- Static analysis now discovers instrumented declarations inside application factories and rejects duplicate node identifiers.
- SDK transport now validates limits, times out collector requests, bounds retry queues, and removes query strings and fragments from captured paths.

## [0.1.0] - 2026-08-21

### Added

- Source-backed TypeScript architecture analysis.
- Causal async runtime instrumentation and first-party Node.js SDK.
- OTLP/HTTP JSON trace ingestion with semantic-convention reconciliation.
- Interactive live map, source inspector, trace history, and replay timeline.
