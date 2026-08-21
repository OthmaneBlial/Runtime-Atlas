# Release checklist

## Contracts

- [ ] Version and changelog describe the release.
- [ ] API, SDK, environment, privacy, and deployment documentation match behavior.
- [ ] No build output, local environment file, trace export, credential, or proprietary fixture is staged.
- [ ] Breaking changes have an explicit migration and rollback note.

## Evidence

- [ ] `npm ci` succeeds on the pinned Node.js version.
- [ ] `npm run check` succeeds from a clean checkout.
- [ ] Playwright desktop/mobile journeys and the real-browser axe audit are green in current Chrome.
- [ ] `npm audit --omit=dev --audit-level=high` succeeds.
- [ ] `docker build -t runtime-atlas:release .` succeeds.
- [ ] The container health check becomes healthy.
- [ ] Checkout, search, failure, history selection, replay, source inspection, export, clear, reconnect, and empty/error states were exercised.
- [ ] The committed screenshots were regenerated when visible UI behavior changed.
- [ ] Keyboard navigation and focus visibility were manually spot-checked in Chrome; Firefox and Safari cross-browser behavior was manually checked.

## GitHub release

- [ ] CI and CodeQL are green on the release commit.
- [ ] The SDK dry-run tarball contains only intended compiled output and metadata.
- [ ] The Git tag matches `package.json` and `packages/sdk/package.json`.
- [ ] Release notes include validation evidence, known limitations, and security/privacy-relevant changes.
