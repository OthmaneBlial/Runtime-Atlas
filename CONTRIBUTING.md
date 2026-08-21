# Contributing to Runtime Atlas

Thank you for helping make runtime behavior easier to understand. Keep changes focused, evidence-backed, privacy-conscious, and compatible with the supported Node.js version.

## Local setup

1. Install the Node.js version in [`.nvmrc`](.nvmrc).
2. Run `npm ci` from the repository root.
3. Run `npm run dev` and open the loopback URL printed by Vite (normally `http://127.0.0.1:5173`).
4. Before submitting a change, run `npm run check`.

The complete check formats, lints, type-checks, tests, builds, verifies documentation and SDK packaging, and boots the compiled production server for real HTTP scenarios.

## Change expectations

- Add focused tests for observable behavior and failure paths.
- Preserve causal trace ordering and the bounded in-memory retention model.
- Do not add unrestricted telemetry attributes, request bodies, database statements, query strings, or credentials.
- Keep source inspection opt-in outside loopback environments.
- Update the README, `.env.example`, and architecture/privacy documents when contracts change.
- For UI work, verify keyboard access, visible focus, reduced motion, narrow layouts, and empty/loading/error states.

## Commits and pull requests

Use a concise imperative commit subject such as `feat: add trace export` or `fix: retain causal parent spans`. Explain the outcome, validation evidence, risk, and rollback in the pull request. Small, reviewable changes are preferred.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports belong in the private process described in [SECURITY.md](SECURITY.md).
