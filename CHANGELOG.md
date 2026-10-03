# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Read-only MCP server on stdio speaking protocol **2026-07-28**:
  `src/mcp/protocol.ts`, `store.ts`, `tools.ts`, `server.ts`, `stdio.ts`,
  `index.ts`. Start it with `npm run mcp`.
- Tools `quality_get_latest_run`, `quality_list_failures`,
  `quality_get_defect`; resources for the latest run summary and any defect;
  a `triage_failure` prompt that asks for facts before hypotheses.
- `ArtifactStore` with server-side path confinement: absolute paths, `..`
  traversal before and after percent-decoding, NUL bytes and symlinks
  resolving outside the root are all rejected, and rejection messages never
  describe the filesystem.
- `scripts/mcp-session-check.py` and `scripts/mcp-tools-check.py`, wired into CI,
  which drive the server over real stdio. Unit tests cannot check that stdout
  carries JSON-RPC and nothing else.
- 43 unit tests for the store boundary and the protocol surface.

### Changed

- `quality-summary.v1.json` now lists defects as run-prefixed paths
  (`<runId>/<id>.v1.json`) instead of bare filenames, so a value from the
  summary can be handed straight to `quality_get_defect` as `defectPath`.
  One canonical form, rather than a caller having to guess which it holds.

### Fixed

- The MCP server resolved a relative `--root` against the working directory only.
  An MCP client does not `cd` into this repository: OpenCode, Kilo and MiMo spawn
  the server from the user's project directory, so the root resolved somewhere
  that does not exist, the store failed to initialise, and the client reported
  only `Connection closed` — the message naming the cause went to stderr, which
  clients discard. It now falls back to this checkout when the working-directory
  root is absent, and says on stderr that it did.

- `initialize` answered with the server's newest protocol version regardless of
  the version the client asked for. Negotiation requires echoing the client's
  version when it is one we can serve. OpenCode, whose default negotiation mode
  is "legacy" and therefore speaks only up to 2025-11-25, refused the connection
  with `Server's protocol version is not supported: 2026-07-28`.

- `npm run typecheck` failed about half the time on this machine with
  `Segmentation fault`, exit 139. Not a project fault: `tsc` crashes the same way
  on an unrelated one-file project, and under Node 22 it failed 0 of 30 runs
  against 4 of 8 on Node 24.21.0. The owner chose to run the project on Node 22,
  so `.nvmrc` now pins 22 and the retry wrapper that was masking the crash is
  gone. `engines` stays permissive at `>=20.19.0`: that is about consumers, not
  about the development toolchain.

- CI never ran. The test job passed an array to setup-node's `node-version` while
  also declaring `strategy.matrix`, and GitHub rejects that combination when it
  validates the workflow: the run failed in zero seconds, with no jobs and no
  logs, reported only as "this run likely failed because of a workflow file
  issue". The YAML is valid and PyYAML parses it, so every local check passed.
  Node versions now live in the matrix, and `scripts/validate-ci.py` rejects both
  that form and artifact names that omit a matrix dimension.

- `scripts/mcp-tools-check.py` required a failing suite to have been run first,
  and failed with "expected at least one defect to list" on an empty artifacts
  store. On a green commit the store is empty by design, so the check went red
  for a reason unrelated to the MCP server — which is how the first CI run that
  actually executed failed. It now seeds its own evidence with the project's own
  deliberately failing `evidence-pipeline` spec, in a temporary directory, and
  asserts that the failure-rate gate trips on it. It no longer depends on prior
  state and no longer clears `test-results/` from the run before it.

- `scripts/mcp-session-check.py` had the same dependency and the same silence
  about it: with no artifacts root the server exited 1 at startup and the check
  reported eight protocol symptoms — missing envelopes, absent `resultType`, an
  empty tool list, no `-32601` — none of which named the actual cause, a
  directory that had not been created. It had never shown up because CI happens
  to run `defects:collect` first. Both checks now share `scripts/evidence_seed.py`
  and seed themselves, so either can be run alone on a clean tree.

- `collectDefects()` resolved `reportPath`, `outputDir` and `testDir` with
  `path.join`, which concatenates even when the given path is absolute. An
  absolute path was silently re-rooted inside the project, and the resulting
  "missing file" error named the wrong path. All three now use `path.resolve`.

### Added

- `npm run docs:check` — verifies that every relative link in the markdown
  resolves, wired into the CI `verify` job. A broken relative link has already
  shipped once (`docs/selectors-and-testid.md` pointing at a non-existent
  `../architecture.md`, found by hand); GitHub renders a missing target as plain
  text, so it is invisible in review. Fenced code blocks are skipped, and anchors
  are verified as files only.

- `scripts/agent-worktree.sh` and [`docs/parallel-work.md`](docs/parallel-work.md)
  — how several agents work on this repository at once. Each agent gets its own
  worktree, branch, artifacts directory and fixture port; `CHANGELOG.md`,
  `AGENTS.md` and `package.json` are integrator-only during a wave, because each
  was touched by 5 of the last 5 commits. Verified before adoption: two agents ran
  the suite simultaneously on separate ports, both green, main tree untouched.

- `defects:collect --report <path>` and `--out <dir>`, so a run can be collected
  from a report other than the default and written outside the configured
  directory. The library already accepted both; only the CLI hardcoded them.
  Unknown flags are now rejected instead of ignored.

- `QUALITYFORGE_OUTPUT_DIR`, `PLAYWRIGHT_JSON_OUTPUT_NAME` and
  `PLAYWRIGHT_HTML_OUTPUT_DIR` are honoured in `playwright.config.ts`, so a
  run can be redirected away from the project's evidence directories.

### Notes

- The MCP protocol surface is hand-written. `@modelcontextprotocol/sdk@1.32.0`,
  published 2026-10-02, declares `LATEST_PROTOCOL_VERSION = "2025-11-25"` and
  contains no `server/discover`, no `resultType`, no `ttlMs`/`cacheScope` and no
  `subscriptions/listen`. It does not implement 2026-07-28. The 2025-11-25
  handshake is still accepted so existing clients keep working.

- Signal capture: `src/quality/signals.ts` records console errors and warnings,
  uncaught page errors, failed requests and HTTP responses at or above 400.
- Redaction: `src/quality/redact.ts` strips sensitive assignments, `Authorization`
  values and bare JWTs from captured text, drops query strings, fragments and
  credentials from URLs, and masks sensitive header values while keeping the
  header names. The auth scheme is preserved, because it is diagnostically
  useful and the token is not.
- QualityForge test fixture: `src/fixtures/quality-context.ts`, re-exported as
  `tests/fixtures.ts`. Importing `test` and `expect` from it makes signal capture
  automatic for every test that drives a page, and attaches a `quality-context`
  artifact on failure. Declared `auto` so evidence never depends on a test
  remembering to opt in.
- `signals` block in the defect artifact. Schema moves to **1.1.0**: an additive
  optional field, so the file suffix stays `v1` and a 1.0.0 reader still works.
- 28 unit tests covering redaction, the signal collector and signal enrichment.

### Changed

- Browser tests import from `../fixtures.js` instead of `@playwright/test`.
- The defect collector reads attachments that carry inline base64 `body` as well
  as those that carry a `path`. Only the latter is written to disk by
  `testInfo.attach({ body })`, so a reader requiring `path` silently ignored
  every inline attachment.

- `defect.v1` artifact contract: `schemas/defect.v1.schema.json` (JSON Schema
  2020-12), runtime types and a hand-written validator in `src/defect/types.ts`.
- Defect collector in `src/defect/collect.ts`, reading Playwright's JSON report
  and writing one artifact per non-passing spec plus a `quality-summary.v1.json`.
- CLI `npm run defects:collect` that doubles as a CI quality gate. Exit `0`
  when the gate passes, `1` on a threshold violation, `2` when collection could
  not run. Supports `--json` and `--config`.
- `config/project.json`: project name, origin under test, evidence policy, gate
  thresholds, artifact location. Validated on load, with every problem reported
  at once and the exact path named.
- `docs/defect-schema.md` documenting the contract and the rules a consumer can
  rely on.
- `scripts/clean.mjs` behind `npm run report:clean`, refusing to delete anything
  outside the project.
- `npm run test:unit` for the unit suite.
- 37 unit tests covering the config validator, the contract validator, and the
  collector, including failure paths.

### Changed

- JSON and JUnit reporters now write to `artifacts/json/`, so the collector and
  any CI dashboard read machine-readable output instead of scraping HTML.
- `artifacts/` is ignored in its entirety with no `.gitkeep`: a `.gitkeep` in an
  output directory is the first thing a cleanup removes, and the tree is created
  on demand instead.

- Demo application under `fixtures/`: overview with an entity list fetched from
  `/api/items`, a documentation page, and a contact form with client-side
  validation and accessible error reporting.
- Fixture server rewritten with clean URLs (`/docs`, `/contact`), a JSON API
  route, and a deliberately failing `/boom` route for evidence work.
- Navigation smoke tests: link-based journeys in both directions, plus a
  direct-URL entry point.
- Contact form validation tests covering every error branch, the happy path, and
  recovery after a failed submission is corrected.
- `tests/setup/global-setup.ts`: validates `BASE_URL` and fails once, with an
  actionable message, instead of producing a wall of timeouts.
- `tests/smoke/evidence-pipeline.spec.ts`: opt-in suite of deliberately failing
  tests that proves screenshot, video and trace capture. Skipped unless
  `QUALITYFORGE_EVIDENCE_CHECK=1`.
- `docs/selectors-and-testid.md`: locator priority order, forbidden patterns,
  and the rules for introducing a `data-testid`.

### Changed

- Overview smoke test now asserts on the entity list rendered from the API,
  using an auto-retrying assertion instead of any fixed wait.
- Fixture server rejects path traversal before touching disk, and logs handler
  failures instead of swallowing them.

### Verified

- 13 tests pass on Chromium; suite is green from a clean clone.
- Mutation checks: breaking validation fails 4 form tests, removing one nav
  link fails exactly 1 navigation test, and breaking `/api/items` fails exactly
  1 entity-list test. The suite discriminates rather than failing broadly.
- All three evidence types observed on a real failure: `test-failed-1.png`,
  `video.webm`, and `trace.zip` (the latter with `--trace on`, since a local run
  has no retry).

## [0.1.0-alpha.0] — 2026-10-03

Initial foundation. Early alpha, not yet published to a registry.

### Added

- Playwright 1.63.0 test runner with Chromium as the first project.
- Evidence policy: trace `on-first-retry`, screenshot `only-on-failure`,
  video `retain-on-failure`.
- Reporters: `github` + `html` + `junit` on CI, `list` + `html` locally.
- Zero-dependency fixture web server (`scripts/serve.mjs`) bound to loopback, so
  `npm ci && npm test` works on a fresh clone with no network dependency.
- Smoke suite covering homepage rendering, HTTP health, and 404 behaviour.
- ESLint 9 flat config with type-aware rules, including a ban on
  `page.waitForTimeout()` and on committed `test.only()`.
- GitHub Actions workflow: lint, typecheck, format check, then browser tests,
  uploading report and JUnit artifacts even when the run fails.

### Known gaps

- No GitHub repository yet; the `github.com/ninelegsdog/qualityforge` remote is
  a placeholder.
- No `artifacts/defects/` schema or MCP server yet.
- CI runs Chromium only. Firefox and WebKit are planned.

[Unreleased]: https://github.com/ninelegsdog/qualityforge/compare/v0.1.0-alpha.0...HEAD
[0.1.0-alpha.0]: https://github.com/ninelegsdog/qualityforge/releases/tag/v0.1.0-alpha.0
