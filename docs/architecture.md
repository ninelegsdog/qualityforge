# Architecture

Status: early alpha, published. `qualityforge@0.1.0-alpha.2` has been on npm
since 2026-10-10, and the defect contract is `defect.v1` at 1.4.0. This
document describes what exists today and the direction it is going. Where a
decision is not yet final, it says so.

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

| Item       | Choice                              | Why                                                                                                                                                                             |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node       | 22 and 24 in CI, `engines >=22.0.0` | Node 20 is past end-of-life (final release March 2026). The floor is the lower of the two CI lines, and `scripts/validate-ci.py` fails if floor and matrix ever disagree.       |
| TypeScript | 5.9.x                               | TypeScript 7 exists, but `typescript-eslint` 8.71 declares `typescript >=4.8.4 <6.1.0`. Adopting 7.x would cost type-aware linting, including the `no-floating-promises` guard. |
| ESLint     | 10.x                                | 9.x is flagged unsupported by npm. `typescript-eslint` 8.71 supports `^10.0.0`.                                                                                                 |
| Playwright | pinned exactly to 1.63.0            | A browser-automation pin should not float; the browser build is version-coupled.                                                                                                |

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│  Consumers                                                    │
│  OpenCode · any MCP client · humans                           │
└───────────────┬───────────────────────────────────────────────┘
                │ MCP (stdio, read-only)
┌───────────────▼───────────────────────────────────────────────┐
│  src/mcp/                                                     │
│  normalizes evidence, serves tools/resources/prompts          │
└───────────────┬───────────────────────────────────────────────┘
                │ reads files
┌───────────────▼───────────────────────────────────────────────┐
│  Artifact store                                              │
│  artifacts/defects/<run>/ · quality-summary.v1.json · *.v1.json│
└───────────────┬───────────────────────────────────────────────┘
                │ written by
┌───────────────▼───────────────────────────────────────────────┐
│  src/defect/ and src/quality/                                 │
│  collector, quality gate, signal capture, redaction           │
└───────────────┬───────────────────────────────────────────────┘
                │ produced by
┌───────────────▼───────────────────────────────────────────────┐
│  @playwright/test 1.63.0                                      │
│  runner · reporters · trace/screenshot/video                  │
└───────────────┬───────────────────────────────────────────────┘
                │ drives
┌───────────────▼───────────────────────────────────────────────┐
│  Application under test            [external]                 │
└───────────────────────────────────────────────────────────────┘
```

Everything above the runner is **one package**, `qualityforge`, and the boxes
between the runner and the consumers are modules, not packages. A monorepo split
is planned, not yet created (issue #4); it stays a single package until the MCP
server genuinely needs its own version line. The `[planned]` markers earlier
versions of this diagram carried were wrong in the other direction — the boxes
they marked have existed for a while; what has not happened is the split.

Kilo and MiMo are absent from the consumers box because they are out of scope
**by decision**, not by omission — read [`client-support.md`](client-support.md)
and the roadmap for the recorded reasons.

## What exists today

Everything the project set out to build is in place and shipped as the one
package above:

- **The package surface.** `exports` maps `.` to the typed entry and
  `./fixtures/quality-context.js` to the fixture a consuming project imports;
  `bin` publishes the collector (`qualityforge`) and the MCP server
  (`qualityforge-mcp`). The deep `dist/…` path is refused, because internal
  layout was never the contract.
- **The collector and the quality gate.** Reads the JSON report of the last run
  and writes one normalized, validated artifact per failure under
  `artifacts/defects/<run>/`, plus a per-run summary. It splits by spec ×
  project — a test failing on three engines is three artifacts, not three
  retries of one — refuses duplicate ids, and treats an aborted suite as one
  outage rather than a defect per test. Its exit code is the gate: `0` the
  thresholds hold, `1` they are violated, `2` collection could not run.
- **The MCP server.** Protocol 2026-07-28, read-only by construction, with
  server-side path confinement: five tools, resources, and a `triage_failure`
  prompt. Verified against OpenCode v2.0.16 over real stdio.
- **Run history.** An optional `history` block keeps one compact entry per run
  in a committed directory, and two MCP tools read it — the details and the
  contract are in [`roadmap.md`](roadmap.md).
- **CI.** Seven jobs: lint and typecheck, unit tests on Node 22 and 24, the
  suite on three browsers, and a live-client job that installs a pinned OpenCode
  and asserts the frames that cross the wire. Several checks cannot be unit
  tests, because they depend on the shape of a real producer's output — those
  live under `scripts/` and are described in [`../AGENTS.md`](../AGENTS.md).
- **Published.** On npm since 2026-10-10, installable from the tag, with a
  template repository wired to it — the details are under "Distribution" below.

## The demo app

`fixtures/` is a genuine small application, not a stub. It exists so the suite
tests behaviour rather than markup:

| Route        | Purpose                                                        |
| ------------ | -------------------------------------------------------------- |
| `/`          | Heading, status readout, entity list fetched from `/api/items` |
| `/docs`      | Documentation with the evidence policy                         |
| `/contact`   | Form with client-side validation, `role="alert"` errors        |
| `/api/items` | JSON payload, three entities                                   |
| `/boom`      | Always 500 — a target for evidence-pipeline work               |

Two properties are enforced structurally:

- The server resolves every request inside `fixtures/` and rejects traversal
  before touching disk.
- The server logs handler failures instead of swallowing them, because a fixture
  that hides errors turns a broken run into a confusing one.

## Layout

```
config/project.json          thresholds, baseUrl, artifact root
fixtures/                    the demo app: html, js, and a dependency-free server
schemas/defect.v1.schema.json  the published contract
src/
├── cli/                      defects:collect
├── config/                   load and validate config/project.json
├── defect/                   artifact shape, collector, gate, git and page context
├── fixtures/                 the Playwright fixtures a test imports
├── mcp/                      the read-only server
└── quality/                  signal capture and redaction
scripts/                      checks that need a real producer, not a mock
tests/{unit,smoke}/           unit specs, and browser specs against the demo app
artifacts/defects/<run>/      quality-summary.v1.json and <ID>.v1.json
quality-history/              committed run history, one compact entry per run
```

## What the fixture adds

Browser tests import `test` and `expect` from `tests/fixtures.ts` (a consuming
project imports `qualityforge/fixtures/quality-context.js`) rather than from
`@playwright/test`. That single change is the whole integration:

```
src/quality/signals.ts       listeners for console, pageerror, requestfailed, response
src/quality/redact.ts        redaction applied at capture time
src/fixtures/quality-context.ts   the auto fixture that attaches it on failure
```

On failure it attaches one `quality-context` payload, which the collector folds
into `defect.signals`. Nothing is attached on success: an artifact about a
passing test is noise.

Two properties are enforced structurally:

- **Redaction happens at capture, never at write.** By the time the collector
  runs, the secret has already touched a file. Query strings are dropped
  wholesale rather than filtered by parameter name, because a filter only knows
  the names it was told about.
- **Capture is bounded.** Forty entries per category, with `signals.dropped`
  recording how many were cut. An artifact is read by a language model, and one
  unbounded stack dump crowds out everything else in the context window.

## Evidence flow

1. A test fails.
2. Playwright writes trace, screenshot and video according to the evidence policy.
3. Playwright also writes `error-context.md` next to them: a markdown summary
   containing the test name, the file and line, the error, and the expected
   versus received values.
4. The collector reads those plus the JSON report and writes one normalized,
   validated defect artifact per failure.
5. The MCP server exposes read-only tools over those artifacts.

All five steps exist. Step 4 doubles as the quality gate — its exit code is the
thing CI and a consuming project read, and a violation of the thresholds must
actually change CI's conclusion. Step 5 is `src/mcp/`: read-only, path
confinement enforced server-side, its only job to hand an agent the facts and
refuse everything else.

Step 3 is worth noting: `error-context.md` is already phrased as an instruction
to an assistant. It has been observed to contain lines like "Explain why, be
concise, respect Playwright best practices", followed by the structured facts.
The raw material for agent triage exists today, for free, and the defect schema
is built around extending it rather than duplicating it.

The whole path is asserted, not assumed. `QUALITYFORGE_EVIDENCE_CHECK=1` runs
the evidence-pipeline spec, which fails on purpose and must leave real artifacts
in `test-results/`. Claims that depend on the shape of a real producer's output
— the report the collector reads, the frames a client sends — are checked by
scripts that run the real producer, never by a hand-written fixture:
`npm run defects:check`, `npm run mcp:check:all` and `npm run mcp:live` are the
pattern. The rules behind that pattern are in
[`../AGENTS.md`](../AGENTS.md#the-rule-nothing-is-done-until-it-has-run-in-the-real-environment).

The workflow has a static validator, `scripts/validate-ci.py`, because Actions
cannot run without a remote. See `npm run ci:validate`.

## MCP design constraints

These are not preferences; they follow from the protocol version in use.

- **Protocol 2026-07-28 is stateless for its era.** No server-side sessions;
  protocol version and client capabilities travel in `_meta` on every request;
  the server implements `server/discover`.
- **The legacy handshake is still accepted.** A client that never sends
  `initialize` must still get `tools/list`, so the server answers the 2025-11-25
  handshake too. That is the path the real client takes: OpenCode probes legacy
  regardless of its `protocol` config key, so the pinned era and
  `server/discover` remain unexercised by any automated check — that boundary is
  stated explicitly in [`../AGENTS.md`](../AGENTS.md#the-mcp-server). The
  official SDK is not used because its 1.32.0 does not implement the 2026
  revision.
- **Logging goes to stderr, never stdout.** stdout carries the JSON-RPC frames.
  A stray `console.log` corrupts the stream.
- **`resultType` is required** on every result.
- **`ttlMs` and `cacheScope` are required** on `tools/list`, `resources/list`,
  `resources/read` and friends.
- **stdio transport is the right choice** for a local read-only server, and the
  security guidance explicitly prefers it: it limits access to the client.
- **The server confines its own file access.** Client-side path allowlists are a
  convenience, not a security boundary. `artifactsRoot` is enforced server-side,
  including against `..` and symlinks.

## Distribution

- **npm.** `qualityforge@0.1.0-alpha.2`, published 2026-10-10. `@playwright/test`
  is a peer dependency (a consuming project brings its own), pinned exactly to
  1.63.0 in `devDependencies`, and the declared range is `^1.63.0`.
  `npm run package:check` packs the tarball, installs it into a directory
  outside this checkout, and runs what `package.json` promises there — with
  controls that are required to fail, so the check's own green means something.
- **From the tag.** `npm i git+…#v0.1.0-alpha.2`; the `prepare` script builds
  `dist/` before the tarball is packed, and a `files` whitelist decides what
  travels.
- **The runner form is always `npx --no-install`.** It provably cannot reach
  the registry for somebody else's code.
- **The template.** [`ninelegsdog/qualityforge-template`](https://github.com/ninelegsdog/qualityforge-template)
  installs this package, runs green from a fresh clone, and carries the MCP
  block already written.

## Deliberate non-goals

- Replacing Playwright, Lighthouse, axe-core or any observability vendor.
- An agent that autonomously edits and merges code.
- Any write access in the first release of the MCP server.

## Related

- [`docs/roadmap.md`](roadmap.md)
- [`../README.md`](../README.md)
