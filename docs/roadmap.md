# Roadmap

Status: **early alpha, pre-release.** Contract `defect.v1` is at **1.3.0** and is
published; nothing here has a release tag yet, so there is nothing to pin.

This file was rewritten on 2026-10-04 because it had drifted: it still listed the
repository, the licence and the community files as unbuilt, and Phases 2 and 3 as
untouched, all of which had been done for days. A roadmap that understates what
exists is not neutral — it costs a reader the time to find out, and it makes the
work that _is_ outstanding invisible.

## What exists today

- **Evidence pipeline.** Trace on first retry, screenshot and video on failure, in
  Chromium, Firefox and WebKit. A run that fails still publishes its artifacts.
- **`defect.v1` at 1.2.0** — schema, producer and documentation, including the
  measured table of how the three engines disagree on identical faults.
- **Collector and quality gate.** Splits by spec × project so one test across
  three engines is three artifacts rather than three retries of one; refuses
  duplicate ids; records the page and the application under test; treats an
  aborted suite as one outage instead of a defect per test.
- **Read-only MCP server** on stdio, protocol 2026-07-28, with server-side path
  confinement. Five tools, resources, a `triage_failure` prompt. Verified against
  OpenCode v2.0.16; Kilo and MiMo are out of scope by decision.
- **Run history.** An optional `history` block keeps one compact file per run in a
  committed directory, plus a per-suite composition shared between runs, so "is this
  a regression or has it always been this way?" has an answer. Two MCP tools read
  it: `quality_flaky_tests` separates a spec that recovered from one that never did,
  and `quality_get_trend` reports a direction over a window and answers `unknown`
  below four runs. Both verified over real stdio against a seeded two-run window.
- **CI on six legs**: lint and typecheck, unit tests on Node 22 and 24, the suite
  on three browsers. Checks that cannot be written as unit tests run there too —
  three MCP checks and one that drives a real Playwright to verify two rules about
  the shape of its report.

## Not done, and why it is not done

**Distribution.** The owner's decision of 2026-10-04 was a template first and npm
after, and the template exists: [`ninelegsdog/qualityforge-template`](https://github.com/ninelegsdog/qualityforge-template),
cloned rather than installed, installing this package from git, running green
from a fresh clone, and carrying the MCP block already written. Under it there is
a build — `npm run build` emits `dist/`, `prepare` runs it before an install from
git packs the tree, and a `files` whitelist decides what travels — so an
installing project can import the fixture at
`qualityforge/dist/fixtures/quality-context.js`.

Still not done, and why this stays open: no `bin`, no `exports` map (so the deep
path above is temporary), nothing published to npm, and every command still
hand-run as `tsx node_modules/qualityforge/src/…`. The floor in `engines` is
deliberately permissive for the same reason. Issue #4 is closed, because the
decision was made and executed; the packaging it decided on is not finished.

**A live client in CI.** OpenCode was connected by hand, once. That is a single
unautomated point of trust, and it is documented rather than verified.

**A release.** No tag, no milestone issues closed against one. `0.1.0-alpha.0` in
`package.json` is a placeholder, not a distribution.

## Open, and waiting on the owner

These change meaning, not just behaviour, so they are not mine to decide:

Both questions below were answered on 2026-10-04 and are no longer the owner's
to call: `context.baseUrl` is now reconciled against the observed page (1.3.0,
issue #8) and `failure.attribution` is `suite | hook | unknown`, where the split
is about files rather than line numbers.

## Open, and mine to do

- Record which clients implement protocol 2026-07-28, as a table rather than as a
  connection check. Issue #6. OpenCode connects, but issue #12 found it advertises
  the _pre_-2026 capability shape, so "it works" and "it implements the revision" are
  different claims and only the first is established.
- A base fixture and a worked `BasePage` example. The selector policy is written
  down and lint-guarded against `waitForTimeout()`, but there is no reference page
  object to copy.
- Lint guards against CSS and XPath selectors, to finish the policy the docs state.
- More than one entry point proven against a real third-party application.

## Board

The closed issues on `v0.1.0-alpha` are the defects this repository found in
itself by pointing the suite at an application it did not build. Two of them (#9
and #11) were closed only after a second pass, because each had shipped broken
through a green suite — see the closing comments, which say so rather than
claiming a first-time fix.

Run `npm run board:check` for the current state. The counts are deliberately absent
here: they were correct for an hour, which is the whole problem this section exists
to describe. It needs a full clone, so it is not in CI, where
`actions/checkout` fetches depth 1 and every closed issue would read as uncited.

Still open, and the reason each is still open:

| Issue | Why it is open                                                          |
| ----- | ----------------------------------------------------------------------- |
| #1    | one third-party application is proven; the issue asks for more than one |
| #4    | the distribution decision, which is the owner's                         |
| #6    | which clients implement 2026-07-28 is unanswered; see above             |
| #12   | we advertise the pre-2026 capability shape on the wire                  |

## Later

Only after the above:

- Accessibility checks, visual regression, performance budgets, API assertions.
- Cross-project configuration, so one policy applies to many repositories.
- Write access, and only behind the read-only surface being stable: run a test,
  validate a fix, draft an issue — sandboxed and audit-logged, never auto-published.

## Out of scope

- Replacing Playwright, axe-core, Lighthouse, Sentry or Grafana.
- An autonomous agent that writes, merges and deploys code.
- Clients other than OpenCode, by decision rather than by omission.
