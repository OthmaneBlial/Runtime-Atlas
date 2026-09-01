# Changelog

All notable changes will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Three-step showcase walkthrough using browser-validated checkout, source-inspection, and dependency-failure captures.
- Dedicated 1280 × 640 social preview, canonical metadata, structured data, sitemap, crawler guidance, and static showcase verification.

### Changed

- Repositioned Runtime Atlas as a local request flight recorder for developer-time causal debugging and rewrote the README around a fresh-clone golden path.
- Screenshot generation now captures the deterministic failure journey and synchronizes every product image into the static showcase.
- GitHub CI and CodeQL triggers are temporarily manual-only while the project is being reworked; the complete local validation command remains unchanged.

## [0.1.0] - 2026-08-21

### Added

- Source-backed TypeScript architecture analysis.
- Causal async runtime instrumentation and first-party Node.js SDK.
- OTLP/HTTP JSON trace ingestion with semantic-convention reconciliation.
- Interactive live map, source inspector, trace history, and replay timeline.
- Production server build, validated environment configuration, structured logs, request IDs, readiness checks, security headers, graceful shutdown, and bounded rate/concurrency controls.
- Trace export, trace clearing, deterministic dependency-failure demo, frontend recovery states, mobile workspace layout, bundled fonts, and live-follow controls.
- Container build, GitHub Actions CI and CodeQL, Dependabot, contributor/security guidance, and production smoke verification.
- Playwright desktop/mobile product journeys, real-browser axe checks, console/network failure detection, and reproducible documentation screenshots.

### Changed

- Static analysis now discovers instrumented declarations inside application factories and rejects duplicate node identifiers.
- SDK transport now validates limits, times out collector requests, bounds retry queues, and removes query strings and fragments from captured paths.
- The compact node-search control keeps an explicit accessible name when its visible label is hidden on narrow screens.
