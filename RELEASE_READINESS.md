# Release Readiness

Audit date: June 11, 2026

## Decision

Do not publish `mcp-notarium@1.0.0`.

This repository is an unreleased prototype that has been superseded by
Automattic's maintained Simplenote MCP implementation:

- <https://github.com/Automattic/simplenote-mcp>
- <https://www.npmjs.com/package/@automattic/simplenote-mcp>

## Evidence

- `1.0.0` has been present since the initial package scaffold on May 18, 2025;
  it was not introduced by a release commit.
- The repository has no tags, GitHub Releases, or historical changelog.
- The public npm registry returns `404` for `mcp-notarium`.
- The latest human-authored product commit is from May 20, 2025. The June 2026
  commits only refresh dependencies.
- `npm test` fails 48 of 116 tests on current `main`.
- `npm run lint:check-format` reports 21 unformatted files.
- `npm run lint` reports 50 warnings.
- The packed executable has no shebang, while `package.json` exposes it as an
  npm binary.
- The README advertised `npx mcp-notarium` despite no published package.
- The documented password-based Simplenote flow is obsolete. The maintained
  implementation uses Simplenote's current login-code flow or the local macOS
  Simplenote store.
- The prototype contains production placeholders and incomplete cache/schema
  checks.
- GitHub has no open issues or pull requests, and current `main` has no
  repository CI workflow covering tests, lint, build, or package execution.

## Reproduction

```bash
git checkout main
npm ci
npm run lint
npm run lint:check-format
npm test
npm run build
npm pack --dry-run
```

## Publication Guard

`package.json` is marked private and includes a `prepublishOnly` failure. Remove
both only after an explicit decision to build and maintain a distinct product,
followed by a new implementation, live Simplenote proof, current MCP client
proof, green CI, and a fresh release review.
