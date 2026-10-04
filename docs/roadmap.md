# Roadmap

Status: **early alpha, pre-release.** Contract `defect.v1` is at **1.2.0** and is
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
  confinement. Three tools, resources, a `triage_failure` prompt. Verified against
  OpenCode v2.0.16; Kilo and MiMo are out of scope by decision.
- **CI on six legs**: lint and typecheck, unit tests on Node 22 and 24, the suite
  on three browsers. Checks that cannot be written as unit tests run there too —
  three MCP checks and one that drives a real Playwright to verify two rules about
  the shape of its report.

## Not done, and why it is not done

**Distribution.** No build step (`tsconfig.json` sets `noEmit`), and no `bin`,
`exports` or `files` in `package.json`. Consuming this means cloning it and
pointing a client at a `.ts` file through `tsx`. The floor in `engines` is
deliberately permissive for the same reason. Issue #4 tracks the decision.

**Run history.** The server answers for one run — `quality_get_latest_run` — and
there is no store of previous runs, so "is this a regression or has it always been
this way?" has no answer. This is the largest functional gap and the reason the
project does not yet deliver the thing it is for.

**A live client in CI.** OpenCode was connected by hand, once. That is a single
unautomated point of trust, and it is documented rather than verified.

**A release.** No tag, no milestone issues closed against one. `0.1.0-alpha.0` in
`package.json` is a placeholder, not a distribution.

## Open, and waiting on the owner

These change meaning, not just behaviour, so they are not mine to decide:

- Reconciling `context.baseUrl` against `page.url`. `baseUrl` is wrong in a
  third-party run; `page.url` is ground truth and is now recorded, but the
  reconciliation is a contract question. Issue #8.
- The vocabulary for `failure.attribution`. It is `suite | unknown` today, and the
  richer version needs information no collector has.

## Open, and mine to do

- Close the issues that are fixed but still open: #2, #7, #9, #10, #11.
- A base fixture and a worked `BasePage` example. The selector policy is written
  down and lint-guarded against `waitForTimeout()`, but there is no reference page
  object to copy.
- Lint guards against CSS and XPath selectors, to finish the policy the docs state.
- More than one entry point proven against a real third-party application.

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
