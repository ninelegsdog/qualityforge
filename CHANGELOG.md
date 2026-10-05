# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The run summary carries what history says: `summary.flakiness`.** The
  per-defect `flakiness` verdict is computed from a single run's retries and dies
  with its artifact, so a reader holding only `quality-summary.v1.json` could see
  that five specs failed and not whether they failed the way flakes fail — the one
  distinction this repository exists for. The summary now records `window` (how
  many earlier runs were consulted, never the run itself), per-bucket `counts`
  (`flaky` / `failing` / `regression` / `new`), one `verdict` over them, and
  `direction` from `trendReport`, the same number `quality_get_trend` answers with,
  so the summary and the tool cannot disagree. With history off it reads `unknown`
  rather than an empty guess. `defect.v1` is now **1.4.0** (minor, additive).

- **The package builds, so a consumer can import the fixture.** Playwright
  refuses to transpile TypeScript under `node_modules`, which left
  `quality-context.ts` — the one import that turns on console, page-error and
  network capture — unloadable for anyone who installed the package instead of
  cloning it. `npm run build` emits `dist/`, `prepare` runs it so an install
  from git builds before the package is packed, and `verify` includes it.

  ```ts
  import { expect, test } from "qualityforge/fixtures/quality-context.js";
  ```

  `tests/unit/build-output.test.ts` deletes `dist`, rebuilds and loads the
  emitted fixture in a spawned Node, so a green suite cannot sit next to a
  fixture a consumer cannot import.

  A build alone was not enough, and the first consumer install is how that
  showed. `dist` is gitignored, which is exactly what npm drops from a package
  with no `files` field: the install arrived with no fixture at all and with 88
  files of this repository instead, `.github/workflows/ci.yml` among them.
  `files` now whitelists `dist`, `src`, `schemas`, `docs`, `AGENTS.md` and
  `CHANGELOG.md` — a whitelist rather than an `.npmignore`, because a whitelist
  fails closed while an ignore file ships whatever nobody remembered to list.
  The packlist is asserted too, in both directions.

  Verified by going red in all three places on purpose: a build with no inputs,
  a changed `ATTACHMENT_NAME`, and `dist` removed from `files`.

  The build is the substrate. What the package exposes on top of it — `exports`
  and `bin` — is the next entry.

- **The package can be consumed: `exports`, `bin`, and a check that installs it.**
  A consuming project could only reach inside the tree: import the fixture by
  its internal path and run the collector by hand as
  `tsx node_modules/qualityforge/src/…`. An ESM package with no `exports` map
  resolves no entry at all, and a package with no `bin` gives a client nothing
  to spawn, so both failures were invisible here — the suite runs `src/` through
  tsx and the packlist test only lists file names. The surface is now:

  ```bash
  npx --no-install qualityforge [flags]                          # the collector
  npx --no-install qualityforge-mcp [--root <dir>] [--history <dir>]
  ```

  ```ts
  import { expect, test } from "qualityforge/fixtures/quality-context.js";
  ```

  `--no-install` is part of the contract rather than a style: without it, `npx`
  on a name nobody has published goes to the registry, and the registry is not
  ours to keep empty. `qualityforge/dist/…` is refused with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` — internal layout was never an interface — and
  the refusal is asserted, so reopening the deep path has to be a decision
  rather than an accident.

  **`npm run package:check` is what makes its green mean something.** It packs a
  real tarball (`prepare` therefore runs — the build a git install performs),
  installs it into a throwaway directory outside this checkout, and there
  imports the entry, resolves both subpaths, executes each binary by hand and
  through `npx`, and starts the MCP server the way a client starts it: from the
  consumer's working directory, frames only on stdout, and — with no artifacts
  directory to serve — exiting rather than serving a root that is not there. Two
  controls are required to fail. The same tarball with `exports` stripped must
  resolve the internal path it refused a moment ago, which is what separates "the
  map refuses it" from "the file is missing"; with `bin` stripped, no link may
  appear and `npx` must fail, which is what separates a working binary from
  anything at all. Building the check failed its own control once: with `bin`
  absent, spawning the missing link raised `FileNotFoundError`, and the script
  died with a traceback whose exit code is indistinguishable from a real
  failure. `run()` now turns that into a result to assert on.

  It runs as a step of its own in CI, because it is the only check that leaves
  the checkout.

- **Run history, and two MCP tools that read it.** An optional `history` block in
  `config/project.json` keeps one compact file per run, which is how the question
  "is this a regression, or has it always been this way" gets an answer instead of
  a guess.

  ```json
  "history": { "directory": "quality-history", "keep": 200 }
  ```

  Committed on purpose, in its own directory and never under `artifacts/`. The rule
  that evidence is output and never checked in is about evidence — screenshots,
  traces, full reports. A history entry is a few hundred bytes of counts and
  outcomes, and it is the only thing that makes a run worth having had.

  **The composition is what makes it correct.** A pass leaves no outcome of its
  own, so a bare failure log cannot tell a spec that failed in one run of two from
  one that failed every time it ran — which is the difference between a flake and a
  regression, and the entire reason to keep history at all. Each entry therefore
  carries a hash pointing at the list of every spec that ran, and that list is
  stored once per distinct suite rather than once per run:

  Measured on two consecutive full runs of this repository's own suite — 349
  specs, 313 passing, 36 deliberately skipped:

  ```
  quality-history/
  ├── 2026-10-04T08-04-56-467Z-da0b19.json    3,962 bytes
  ├── 2026-10-04T08-07-23-977Z-c2fda5.json    3,962 bytes
  └── compositions/eb6a4bb9011a.json          27,635 bytes, written once
  ```

  A third run with an unchanged suite adds only its entry: 4 KB, not 28. The
  composition is the large half and it is shared, which is the entire reason the
  entry can stay small.

  An entry whose composition cannot be read is reported as `partial` rather than
  guessed at, and errs towards `failing` rather than `flaky`: a reader who acts on
  a false regression investigates, and a reader who acts on a false flake waits.

- **`quality_flaky_tests`** reports which specs failed across the window and how
  to read each: `flaky` (failed and passed), `failing` (failed every time it
  ran), `new` (first appearance in the window is a failure), `quiet` (failed, but
  is no longer in the suite). Sorted worst first, stable across calls.

- **`quality_get_trend`** reports pass rate per run, a direction from the first
  half of the window against the second, mean duration of each half, and how many
  distinct specs failed anywhere in it. Under four runs it answers `unknown`
  rather than fitting a line to two points.

  Both are read-only, and neither takes a path: the client names no directory, so
  there is nothing to confine — which is what makes a second root safe to serve at
  all. `--history <dir>` points the server at it; without the flag the
  conventional `quality-history` is used only when it exists.

### Changed

- **`defect.v1` is now 1.3.0** (minor, additive). Two new enum members, both
  answering a defect this project found in itself by running the suite against an
  application it did not build.

  - **`context.targetSource: "observed"`.** `BASE_URL`, `webServer.url` and
    `config/project.json` all record what someone _meant_ the target to be. In a
    third-party run they were wrong in the same way — the report named the bundled
    fixture's origin while the browser was on the real target — so grouping defects
    by origin merged two applications' failures under one wrong value. When a
    failing test drove a page and that page disagrees with the configured answer,
    the artifact records the observation and marks it `observed`.

    Measured on the real third-party run, before and after:

    ```
    before   context.baseUrl = http://127.0.0.1:4311     targetSource = report
    after    context.baseUrl = https://quotes.toscrape.com   targetSource = observed
    ```

    A run whose inputs agree is unchanged and keeps its configured source, so
    ordinary artifacts are byte-identical to what 1.2.0 produced. The run summary
    keeps the configured answer, because a summary has no page; the observation
    lands in per-defect context.

  - **`failure.attribution: "hook"`.** The vocabulary was `suite | unknown` and
    `suite` was doing two jobs. A `beforeAll` that throws and a failure inside a
    shared helper module are both "not this test's body", but they send a reader
    somewhere completely different. The above-the-declaration case in the spec's own
    file is now `hook`; `suite` means "a different file"; `unknown` is unchanged.

    The split is a boundary about files, not about line numbers. A helper at line 3
    of another module stays `suite`, because a line in another file is not "above
    this spec" in any meaningful sense.

### Fixed

- **The README asserted an MCP config form difference that is not one.** "The key
  is `mcp`, not `mcp.servers`" was wrong twice over: the schema at
  `opencode.ai/config.json` describes V1, and the V2 documentation — along with
  `opencode mcp add` — use `mcp.servers.<name>`. Both forms connect on v2.0.16;
  the flat block was connected here, and so was the same block wrapped in
  `"servers"`. What separates them is which file wrote the config, not whether it
  works.

  The connection line grew no more trustworthy from being tested: four
  consecutive `opencode mcp list` runs against one unchanged file printed
  `connected`, `pending`, `pending`, `pending`. The README now calls it a sample
  rather than a verdict.

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

- `server/discover` answered with `protocolVersions`. The client's `DiscoverResult`
  schema validates against `supportedVersions`, and it does not know the other
  spelling — in the OpenCode 2.0.16 binary one string appears eight times and the
  other zero. The probe failed validation, was discarded as "no modern evidence",
  and 2026-07-28 became unreachable: every negotiation mode fell back to legacy
  silently, and pinned mode failed with a message about negotiation rather than
  about a field name. One field name was the entire modern path.

- The `_meta` envelope is now required on 2026-07-28 and answered on every
  result. Previously it was read from requests but never written to responses,
  `META_CLIENT_CAPABILITIES` was declared and never used, and the envelope was
  optional — so a conforming 2026-07-28 client and this server could not actually
  talk. The 2025-11-25 path is untouched and still needs no envelope.

- `initialize` with an explicit `--root` did not do what its comment claimed. The
  checkout fallback applied to an explicitly passed relative path too, not only
  to the default.

- The server no longer advertises `resources.subscribe`. It was offered
  conditionally to a client declaring a `subscriptions` capability, and no
  `resources/subscribe` case existed in dispatch — so the capability promised a
  method that answers `-32601`. The 2026-07-28 client-capability schema has no
  `subscriptions` member at all, so a conforming client could never switch it on;
  the condition could only have selected who to mislead. Absence is also the more
  useful answer, because the client then refuses the call itself. The rest of the
  capabilities shape is unchanged and verified against the 2026 schema, which still
  contains `tools`, `resources` and `prompts` with their `listChanged` flags —
  dropping them would make `tools/list` uncallable, not modern.

- A request declaring an unservable protocol revision is refused on **every**
  method, not only unknown ones, with `UNSUPPORTED_PROTOCOL_VERSION` carrying both
  `supported` and `requested`. Previously `tools/list` with revision `1999-01-01`
  was served a result containing `resultType`, `ttlMs` and `cacheScope` — all
  introduced by 2026-07-28 — and the client caches on `ttlMs`. `initialize` is
  exempt because it is the negotiation itself, and notifications stay silent.

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

- `scripts/agent-scope.sh`, installed as a pre-commit hook per worktree, rejects
  a commit touching a file outside the agent's zone. A zone written in a document
  is a memory test with four agents running; a hook is a gate. A worktree created
  without a zone gets a hook that refuses every commit.

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
