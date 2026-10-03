# Architecture

Status: early alpha. This document describes what exists today and the direction
it is going. Where a decision is not yet final, it says so.

## Principles

1. **Evidence over assertion.** A failing test must leave behind enough material
   to diagnose it without re-running anything.
2. **Reproducible from a clean clone.** `npm ci && npm test` must work with no
   manual setup and no third-party network dependency.
3. **Vendor-neutral facts.** Evidence is normalized into a documented schema, so
   it is not tied to one test runner.
4. **Read-only by default.** The agent-facing surface grants the ability to read
   facts, not to act. Acting is a separate, explicit step.
5. **Bias toward observable behaviour.** Tests assert what a user sees. A
   restyle must not break them.

## Runtime baseline

| Item       | Choice                               | Why                                                                                                                                                                             |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node       | 22 and 24 in CI, `engines >=20.19.0` | Node 20 is past end-of-life (final release March 2026). Playwright 1.63 requires `>=20`. The permissive floor keeps consumers on an older runtime unblocked.                    |
| TypeScript | 5.9.x                                | TypeScript 7 exists, but `typescript-eslint` 8.71 declares `typescript >=4.8.4 <6.1.0`. Adopting 7.x would cost type-aware linting, including the `no-floating-promises` guard. |
| ESLint     | 10.x                                 | 9.x is flagged unsupported by npm. `typescript-eslint` 8.71 supports `^10.0.0`.                                                                                                 |
| Playwright | pinned exactly to 1.63.0             | A browser-automation pin should not float; the browser build is version-coupled.                                                                                                |

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Consumers                                                   │
│  OpenCode · Kilo · MiMo · any MCP client · humans            │
└───────────────┬─────────────────────────────────────────────┘
                │ MCP (stdio, read-only)
┌───────────────▼─────────────────────────────────────────────┐
│  @qualityforge/mcp        [planned]                           │
│  normalizes evidence, serves tools/resources/prompts         │
└───────────────┬─────────────────────────────────────────────┘
                │ reads files
┌───────────────▼─────────────────────────────────────────────┐
│  Artifact store            [planned]                         │
│  artifacts/defects/<ID>.v1.json · traces · screenshots · video│
└───────────────┬─────────────────────────────────────────────┘
                │ written by
┌───────────────▼─────────────────────────────────────────────┐
│  @qualityforge/core         [planned]                        │
│  schema definitions, validation, collectors                 │
└───────────────┬─────────────────────────────────────────────┘
                │ produced by
┌───────────────▼─────────────────────────────────────────────┐
│  @playwright/test 1.63.0                [exists]             │
│  runner · reporters · trace/screenshot/video                 │
└───────────────┬─────────────────────────────────────────────┘
                │ drives
┌───────────────▼─────────────────────────────────────────────┐
│  Application under test            [external]                │
└─────────────────────────────────────────────────────────────┘
```

## What exists today (Day 1)

```
playwright.config.ts   runner config, evidence policy, fixture webServer
scripts/serve.mjs      zero-dependency static server, loopback only
fixtures/index.html    the page the smoke suite runs against
tests/smoke/           three smoke tests: render, health, 404
src/index.ts           package entry point
.github/workflows/ci.yml  lint + typecheck + format + test, artifacts on failure
```

`src/index.ts` is intentionally thin. It exists so the package has a real entry
point; the schema and collector modules land here in later steps.

## Planned layout

```
packages/
├── core/
│   └── src/schemas/defect.v1.schema.ts
└── mcp/
    └── src/{server.ts,index.ts,tools/,resources/,repositories/}
artifacts/
├── quality-summary.v1.json
└── defects/<ID>.v1.json
```

A monorepo split is planned, not yet created. It stays a single package until
the MCP server genuinely needs its own version line.

## Evidence flow

1. A test fails.
2. Playwright writes trace, screenshot and video according to the evidence policy.
3. A collector reads those plus the JSON report and writes a normalized defect
   artifact.
4. The MCP server exposes read-only tools over those artifacts.

Step 3 does not exist yet. It is the substance of the project.

## MCP design constraints

These are not preferences; they follow from the protocol version in use.

- **Protocol 2026-07-28 is stateless.** No server-side sessions, and no
  `initialize` handshake. Protocol version and client capabilities travel in
  `_meta` on every request. The server must implement `server/discover`.
- **Logging goes to stderr, never stdout.** stdout carries the JSON-RPC frames.
  A stray `console.log` corrupts the stream.
- **`resultType` is required** on every result.
- **`ttlMs` and `cacheScope` are required** on `tools/list`, `resources/list`,
  `resources/read` and friends.
- **stdio transport is the right choice** for a local read-only server, and the
  security guidance explicitly prefers it: it limits access to the client.
- **The server confines its own file access.** Client-side path allowlists are a
  convenience, not a security boundary. `artifactsRoot` is enforced server-side.

## Deliberate non-goals

- Replacing Playwright, Lighthouse, axe-core or any observability vendor.
- An agent that autonomously edits and merges code.
- Any write access in the first release of the MCP server.

## Related

- [`docs/roadmap.md`](roadmap.md)
- [`../README.md`](../README.md)
