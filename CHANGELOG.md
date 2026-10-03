# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
