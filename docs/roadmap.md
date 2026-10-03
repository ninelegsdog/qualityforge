# Roadmap

Status: early alpha, pre-release. Dates below are targets, not commitments.

## Where this is going

The short version: a reusable browser-quality core that produces **normalized,
vendor-neutral evidence**, plus a **read-only** surface that lets any AI agent
read that evidence without being able to act on the system.

## Phase 0 — Foundation (this sprint)

- [x] Repository, license, README, contributor and security policy
- [x] Playwright 1.63.0 with Chromium
- [x] Evidence policy: trace on-first-retry, screenshot and video on failure
- [x] Reporters: HTML locally; GitHub + HTML + JUnit on CI
- [x] Zero-dependency fixture server so a clean clone runs green
- [x] CI publishing artifacts even when the run fails
- [ ] Public repository, labels, `v0.1.0-alpha` milestone
- [ ] CONTRIBUTING, SECURITY, CODE_OF_CONDUCT

## Phase 1 — Stable tests and evidence

- Base fixture (`base.fixture.ts`) and a reference `BasePage`
- Login page object as the worked example
- Selector policy: prefer role, label and test id; document the `data-testid` contract
- Lint guard against `page.waitForTimeout()` (already in place) and against CSS/XPath selectors
- Secret redaction in textual reports
- A deliberately failing test, to prove the trace/screenshot/video pipeline works
- `npm run test:smoke` / `test:debug` / `report` wired into docs

Exit criterion: every failure leaves a trace that can be opened and understood
without re-running the test.

## Phase 2 — Defect intelligence

- `defect.v1` JSON Schema, versioned and documented
- Collector that turns runner output plus artifacts into one defect file
- `quality-summary.v1.json` per run
- Quality metrics: pass rate, duration trend, flake rate per test
- History storage so regressions are visible across runs

Exit criterion: a defect file can be read by a human or an agent and be enough
to start triage.

## Phase 3 — Read-only MCP server

- `@qualityforge/mcp`, stdio, read-only
- Tools: `quality_get_latest_run`, `quality_list_failures`, `quality_get_defect`
- Resources for the latest run and for individual defects
- Prompt: evidence-first triage (list facts, then at most three hypotheses with
  confidence and safe verification steps)
- Path confinement to a configured artifacts root
- Protocol 2026-07-28 compliance: `server/discover`, `resultType`,
  `ttlMs`/`cacheScope`, stderr-only logging

Exit criterion: an agent reads real failure data through MCP and produces a
triage **without** any manual copy-paste of logs.

## Phase 4 — Widening quality coverage

- Accessibility checks (axe-core based)
- Visual regression
- Performance budgets
- API and network assertions; failed request and console error capture
- Cross-project configuration so one policy applies to many repositories

## Phase 5 — Controlled write access

Only after the read-only surface is stable:

- `quality_run_test`, `quality_run_smoke`, `quality_validate_fix`
- Audit log of every invocation
- Sandboxed execution
- Issue drafting without auto-publish

## Out of scope

- Replacing Playwright, Lighthouse, axe-core, Sentry or Grafana.
- An autonomous agent that writes, merges and deploys code.

## Related

- [`architecture.md`](architecture.md)
- [`../CHANGELOG.md`](../CHANGELOG.md)
