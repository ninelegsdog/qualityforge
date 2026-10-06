# Roadmap

Status: **early alpha, pre-release.** Contract `defect.v1` is at **1.4.0** and is
published; the first tag, `v0.1.0-alpha.1`, was cut on 2026-10-06.

This file was rewritten on 2026-10-04 because it had drifted: it still listed the
repository, the licence and the community files as unbuilt, and Phases 2 and 3 as
untouched, all of which had been done for days. A roadmap that understates what
exists is not neutral — it costs a reader the time to find out, and it makes the
work that _is_ outstanding invisible.

## What exists today

- **Evidence pipeline.** Trace on first retry, screenshot and video on failure, in
  Chromium, Firefox and WebKit. A run that fails still publishes its artifacts.
- **`defect.v1` at 1.4.0** — schema, producer and documentation, including the
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
- **CI on six legs, plus the live client.** Lint and typecheck, unit tests on
  Node 22 and 24, the suite on three browsers. Checks that cannot be written as
  unit tests run there too — three MCP checks and one that drives a real
  Playwright to verify two rules about the shape of its report.
- **A live client in CI.** The `live-client` job installs OpenCode pinned to
  2.0.16 (the v2 installer fetches a versioned npm package;
  `EXPECT_OPENCODE_VERSION` and `clientInfo` on the wire both re-assert the
  number), connects it from a
  fresh directory outside the checkout with no `npx`, and reads the frames
  through a pass-through proxy: the `initialize` echo, `serverInfo` in the result
  and in `_meta`, a `tools/list` carrying `resultType`/`ttlMs`/`cacheScope` and
  exactly the tools we name. Proven red four ways: the `_meta` envelope removed
  (the client still connected — only this check caught it), `resultType`
  removed, a server that dies at startup, and a wrong pinned version. What it
  does not reach: `opencode mcp list` probes legacy regardless of the `protocol`
  config key (observed with `"auto"` and `"2026-07-28"`), so the pinned era,
  `server/discover` and a real tool call through a client stay unexercised —
  the latter needs a model.
- **Client support table.** [`client-support.md`](client-support.md) records who
  was observed and how: every row cites the command and date behind it, and
  `npm run docs:support` fails a claim without an observation or silence without
  a recorded decision. OpenCode 2.0.16, observed 2026-10-06: connects, requests
  `2025-11-25` without the `_meta` envelope, never sends `server/discover`
  (though its bundled SDK carries it, era-gated to 2026); Kilo and MiMo read
  `not tested` by decision.

## Not done, and why it is not done

**Distribution.** The owner's decision of 2026-10-04 was a template first and npm
after, and the template exists: [`ninelegsdog/qualityforge-template`](https://github.com/ninelegsdog/qualityforge-template),
cloned rather than installed, installing this package from git, running green
from a fresh clone, and carrying the MCP block already written. Under it there is
a build — `npm run build` emits `dist/`, `prepare` runs it before an install from
git packs the tree, and a `files` whitelist decides what travels — and, since the
packaging of 2026-10-06, a published surface: an `exports` map for `.`,
`./fixtures/quality-context.js` and `./package.json`, plus `bin` entries for
`qualityforge` and `qualityforge-mcp`. A consuming project therefore imports
`qualityforge/fixtures/quality-context.js` and runs `npx --no-install qualityforge …`;
the old `qualityforge/dist/…` deep path is refused, because internal layout was
never the contract. `npm run package:check` packs the tarball, installs it into a
directory outside this checkout and runs what it promises there — with two
controls that are required to fail, so the check's own green means something.

Still not done, and why this stays open: nothing published to npm. Until it is,
the package installs only from git, `npx --no-install` is the only form that
provably cannot reach the registry for somebody else's code, and the floor in
`engines` stays deliberately permissive — publishing is what will force that
question. Issue #4 is closed, because the decision was made and executed; the
publication it decided on is still the owner's call.

**A release.** `v0.1.0-alpha.1` is tagged and installs from the tag with
`npm i git+…#v0.1.0-alpha.1`; a GitHub Release carries the changelog section.
The three issues still open on the `v0.1.0-alpha` milestone (#1, #6, #12) stay
open by the owner's decision of 2026-10-06: the tag marks the code, not a closed
milestone. The pre-release stays unpublished to npm.

## Open, and waiting on the owner

These change meaning, not just behaviour, so they are not mine to decide:

Both questions below were answered on 2026-10-04 and are no longer the owner's
to call: `context.baseUrl` is now reconciled against the observed page (1.3.0,
issue #8) and `failure.attribution` is `suite | hook | unknown`, where the split
is about files rather than line numbers.

## Open, and mine to do

- A base fixture and a worked `BasePage` example. The selector policy is written
  down and lint-guarded against `waitForTimeout()`, but there is no reference page
  object to copy.
- Lint guards against CSS and XPath selectors, to finish the policy the docs state.
- More than one entry point proven against a real third-party application.
- Take the E2 gaps to the owner and land whichever they pick: G15–G17 in
  `defect-schema.md` are waiting as schema change (with the bump rule 7
  requires) or documented limitation — the options are written down, the call
  is not mine.

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

| Issue | Why it is still open                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| #6    | the record now exists (`client-support.md`, cited per row); closing it is F1's call                                           |
| #12   | the premise was refuted against the client's own binary and the decision is recorded in `0.1.0-alpha.1`; closing is F1's call |

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
