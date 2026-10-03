# QualityForge

Evidence-first browser quality automation for modern web applications.

QualityForge is an open-source Playwright-based foundation for:

- smoke and E2E browser tests;
- CI quality checks;
- trace, screenshot and video evidence captured on failure;
- machine-readable test results;
- later: accessibility, visual and performance checks, and AI-assisted defect
  triage over a read-only MCP surface.

## Status

**Early alpha.** The project is under active development. Expect breaking
changes. The GitHub repository is not public yet.

## Why this exists

Most teams end up with a pile of one-off UI tests per project: duplicated
selectors, no shared failure evidence, no cross-project view of quality.

QualityForge is a reusable core instead. One configuration, one evidence
format, one set of quality gates — pointed at any web application.

The differentiator is not "AI writes tests". Playwright already ships agents
for that. It is the **evidence layer between a failing run and any agent**:
normalized, vendor-neutral defect artifacts, read without granting the ability
to act.

## Quick start

Development requires **Node.js 22 or newer**. Node 20 is past end-of-life — its
final release was in March 2026 — so CI runs Node 22 and 24. The package's
`engines` field stays permissive at `>=20.19.0` so consumers on an older runtime
are not blocked.

```bash
git clone https://github.com/ninelegsdog/qualityforge.git
cd qualityforge
npm ci
npx playwright install --with-deps chromium
npm test
```

`npm test` starts a bundled fixture web server automatically, so a fresh clone
runs green with no configuration and no third-party network dependency.

Open the HTML report:

```bash
npm run report
```

## Running against your own application

```bash
cp .env.example .env      # then set BASE_URL
BASE_URL=https://staging.example.com npm test
```

Everything else — selectors, fixtures, thresholds — is meant to be added under
`tests/` per project.

## Evidence policy

| Signal     | Setting             | Why                                                                           |
| ---------- | ------------------- | ----------------------------------------------------------------------------- |
| trace      | `on-first-retry`    | Only when something already failed. `on` for every test is far too expensive. |
| screenshot | `only-on-failure`   | Evidence, not noise.                                                          |
| video      | `retain-on-failure` | Keeps the clip only for failures.                                             |

On CI, prefer the **trace viewer** over screenshots and videos when debugging: it
gives the DOM snapshot at each action plus the full network log.

## Commands

```bash
npm test              # full suite
npm run test:smoke    # Chromium only
npm run test:debug    # Playwright Inspector, step through a test
npm run report        # open the HTML report
npm run verify        # lint + typecheck + format check (what CI runs first)
```

## Quality rules enforced in CI

- `page.waitForTimeout()` is banned by a lint rule. It is the main cause of
  flaky tests; wait for a real condition instead.
- `test.only()` and `describe.only()` are banned. In CI they would silently skip
  the rest of the suite.
- `@typescript-eslint/no-floating-promises` is an error. A forgotten `await` on a
  Playwright call makes a test quietly assert nothing.
- Formatting and type checks must pass.

## Sprint 1 scope

- Chromium smoke tests
- HTML, GitHub and JUnit reports
- Trace on retry, screenshot and video on failure
- GitHub Actions CI publishing artifacts even on failure

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together
- [`docs/roadmap.md`](docs/roadmap.md) — where this is going
- [`AGENTS.md`](AGENTS.md) — rules for coding agents working in this repo
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md).

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
