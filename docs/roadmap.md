# Roadmap

Status: **stable, published.** `qualityforge@0.1.0` went to npm on 2026-10-15
as the first stable release; `latest` points at it and `next` still holds
`0.1.0-alpha.2` (2026-10-10). Contract `defect.v1` is at **1.4.0**; tags
`v0.1.0-alpha.1` (2026-10-06), `v0.1.0-alpha.2` (2026-10-07) and `v0.1.0`
(2026-10-15).

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
- **Accessibility audit.** `qualityforge-a11y` runs `axe-core` against a URL and
  writes a contract of its own, `a11y-audit.v1` — deliberately not fields on
  `defect.v1`, decided on 2026-10-15: a page's accessibility verdict and one
  test's failure are different claims with different owners. Ten nodes per rule
  with a `totalNodes` counter beside it, so a capped artifact cannot be read as
  a complete one. Two of the nine MCP tools read the audits back. Ten tests
  exercise the command in the default suite, chromium only and only where
  chromium is installed — the command launches its own browser, so the project
  it runs inside is irrelevant to it. **They stay in the default run by the
  owner's decision of 2026-10-16**: issue #40 conditioned exclusion on a browser
  round-trip per page, and there is none, since each test builds the page it
  audits. Measured at 20 seconds of a 46-second chromium leg.
- **API contracts, declared and audited.** A project declares its contracts in
  `config/project.json` — method, path, and what the exchange must carry. The
  fixture captures only the declared exchanges, the collector writes
  `api-audit.v1` under `artifacts/api/<runId>/`, and a breach fails the run in
  `summary.api` without touching what `summary.gate` means. The contract is in
  [`api-audit-schema.md`](api-audit-schema.md), with three gaps recorded there as
  **G18** to **G20**; the largest is measured — chromium never hands over a POST
  response body.
- **One quality policy, shared by many repositories.** A project declares `extends`
  with a path to a file and wins, field by field, wherever the two overlap. What a
  policy may **not** say — a base URL, a project's own tags, where its artifacts
  live, its API contracts — is refused with its reason rather than ignored, and after
  those refusals a policy contains no arrays at all, which removes the one question
  per-field merging usually gets wrong. A run records the chain it inherited in
  `summary.policy`. The contract is in
  [`shared-policy.md`](shared-policy.md).
- **Transfer budgets, as an evidence dimension.** A project declares
  `thresholds.maxTransferredBytes`, the fixture records what each page actually cost
  from Resource Timing, and the collector writes `perf-audit.v1` under
  `artifacts/perf/<runId>/`. A breach fails the run in `summary.perf`, without
  touching what `summary.gate` means.

  **One metric, chosen by measuring two:** `transferSize` gave 3 922 bytes with a
  spread of 0 across five runs, while summing response bodies gave 1 704 and 2 101 on
  the same page — the engine does not always hand a body over. Timing was measured and
  **not** budgeted: it separates a real regression 5.7-fold, but its noise grows from
  4 ms to 39 ms under load. The verdict is the **largest** load, never an average.

  Two gaps recorded as **G21** and **G22**; the contract is in
  [`perf-audit-schema.md`](perf-audit-schema.md).

- **Read-only MCP server** on stdio, protocol 2026-07-28, with server-side path
  confinement. Eleven tools — five over defects and run history, two over
  accessibility audits, two over API contract audits, two over transfer budgets —
  plus resources and a `triage_failure` prompt.
  Verified
  against a real third-party application's artifacts as well: the installed
  binary, driven by the real client from a directory outside both projects,
  answering with that application's five defects — see
  [`defect-schema.md`](defect-schema.md).
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

Now done, on 2026-10-10: published to npm as `qualityforge@0.1.0-alpha.2`.
The `prepublishOnly` gate ran verify, the suite, the three docs checks and
`package:check` in the same invocation before the tarball left, and the wire
version is bound to the package version by a test that was red on its first
run — the frames of the published server carry the same number as the
tarball. The probe from the registry installed `qualityforge@0.1.0-alpha.2`
into a fresh directory, resolved `import('qualityforge')` on the `exports`
map, and ran the collector's `--help`. The `engines` floor that publishing
was meant to force was settled earlier by B4 at `>=22`; and
`npx --no-install` remains the form that provably cannot reach the registry
for somebody else's code.

Now done, on 2026-10-15: published to npm as `qualityforge@0.1.0`, the first
stable release. The same `prepublishOnly` gate ran in full before the tarball
left; `npm run mcp:live` connected the real OpenCode client from a fresh
directory on the releaser's machine (`initialize` 2025-11-25,
`_meta[serverInfo]`, five tools with `resultType`/`ttlMs`/`cacheScope`); and
`latest` was verified in the registry rather than trusted — it lagged behind
the `versions` entry for a moment, and `npm dist-tag add` then reported the
tag was already set. The probe installed `qualityforge@0.1.0` into a fresh
directory outside the checkout, resolved `import('qualityforge')` and the
`fixtures/quality-context.js` subpath on the `exports` map, and ran both
binaries: `qualityforge --help` exited 0, and `qualityforge-mcp --help`
wrote 0 bytes to stdout, so the protocol channel stayed clean.

Decided, and then measured, on 2026-10-15: **the repository-contract gate does
not travel to the template.** The gate checks how a repository presents itself
— released surface, badges, policy — and a template produces repositories at the
moment they are cloned, under a name the shared contract has never heard of.

The first statement of this decision was wrong for two days and is corrected
here rather than left standing. It claimed the gate was absent from the
template. It was not: it had arrived there on 2026-10-13 in the same three pull
requests that brought it here (#5–#7 in the template, #51–#53 here), and the
files were byte-identical. The decision was taken against a note saying the
template still stood at 2026-10-06, which stopped being true on the 13th.

Measured on a real fresh clone before anything was changed:

| Clone of the template                       | The gate                                                   |
| ------------------------------------------- | ---------------------------------------------------------- |
| directory named after the repository        | exit 0 — `contract satisfied (37 assertions)`              |
| directory named anything else               | exit 1 — `repository '<name>' has no type in the contract` |
| a new project, its own name, its own remote | exit 1 — the same failure                                  |

The gate takes the repository's identity from the directory name
(`repo = root.name` in `scripts/check-repo-contract.py`), never from the git
remote or `package.json`. The second and third rows are one failure, and the
second is not a corner case: renaming the clone is what a template is for.
CI never saw it, because `actions/checkout` clones into a directory named after
the repository — a gate that cannot go red in the only place it would matter is
not a gate. Resolving the name from the remote was tried and does not help: it
turns the second row green and leaves a new project red, because no lookup can
put an unregistered name into the contract.

So the gate was removed from the template (PR #9 there, 2026-10-16), and a
fresh clone named `my-new-bot` now runs `npm ci`, `npm test` and
`npm run collect` — exit 0, gate passed. The governance layer stays, because it
is what a generated project needs whatever it is called: `README.md`, `LICENSE`,
`CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`,
`AGENTS.md`, `.editorconfig`, `.gitattributes`, `CODEOWNERS`, and the issue and
pull-request templates. A project takes the gate on when it joins the shared
contract as an entry of its own, at which point the gate reads its real name.

**A release.** `v0.1.0` is tagged and installs from the tag with
`npm i git+…#v0.1.0`, or from npm with `npm i qualityforge@0.1.0`; a GitHub
Release carries the changelog section and `latest` points at it. It is the
first stable one, and it followed two prereleases — `v0.1.0-alpha.1`
(2026-10-06) and `v0.1.0-alpha.2` (2026-10-07), whose `v0.1.0-alpha`
milestone closed all twelve issues, #1 with E2 and #6/#12 with F1, the tag
marking the code either way. The `v0.1.0` milestone (created 2026-10-10)
carried the criteria this release had to meet — so "when is it no longer
alpha?" was answerable rather than felt. The prerelease keeps the `next`
dist-tag; npm forbids removing `latest`, which now names the stable version
(see `docs/architecture.md`).

## Open, and waiting on the owner

These change meaning, not just behaviour, so they are not mine to decide.

None are open today. Answered and no longer the owner's to call: on 2026-10-04
`context.baseUrl` became reconciled against the observed page (1.3.0, issue
#8) and `failure.attribution` became `suite | hook | unknown`, where the
split is about files rather than line numbers; on 2026-10-06 the owner chose
**documented limitations** for G15–G17 — the contract stays at 1.4.0, and each
gap in `defect-schema.md` now states what a consumer must not assume instead.

## Open, and mine to do

- More than one entry point proven against a real third-party application.

**Re-decided by the owner, on 2026-10-15: it stays open, and it does not
block the release.** Measured rather than guessed while closing the `v0.1.0`
milestone: both third-party suites import `../../fixtures.js` and nothing
else, so exactly **one** entry point — the fixture — is proven against a
real third-party application. The CLI is proven by
`tests/unit/help-text.test.ts` and the registry probe; MCP by the dispatch
tests and `mcp:live` against the real OpenCode client; the library import
by `package:check`. None of those three runs against a third-party
application, so the item is not closed and no test was stretched to make it
read as closed. The milestone's own text already called it "deliberately
not a blocker by default"; the owner chose not to promote it, so it follows
the release like the **Later** items do, and closing the milestone records
that decision instead of claiming the work.

Now done, on 2026-10-10: the selector policy gained its lint guard (PR #32 —
CSS, XPath and the `text=` shorthand in a literal `locator()` argument fail
`npm run lint`), and a worked `BasePage` exists to copy —
`tests/smoke/pages/base-page.ts`, with `OverviewPage` and `ContactPage`
extending a shared base and using none but the policy's selectors, driven on
all three browser legs by `tests/smoke/base-page.smoke.spec.ts`. The base
fixture behind it was already product code (`quality-context`, imported as
`../fixtures.js`); what was missing was the reference. It runs for the same
reason every other claim here runs: break a locator in it, and exactly the
test that reads it goes red. Its twelve per-project tests moved the
quick-start's counts to 397.

**Done, on 2026-10-16 — the item closes, and the measurement above was right
about the wrong thing.** The 2026-10-15 note counted one entry point because both
third-party suites import `../../fixtures.js` and nothing else. That is true, and
it is not the whole picture: the same run carries a second entry point out of the
repository, because the report it produces is consumed by the collector. One live
run against `quotes.toscrape.com` therefore proved two.

**The fixture**, as before: ten specs, five asserting the application's real
behaviour and passing, five probes failing on purpose — the run's deliverable.

**The CLI**, proved the way a consumer meets it rather than the way this
repository runs it. `npm pack` (so `prepare` builds what a git install builds),
installed into a directory outside this checkout with a `config/project.json` that
was not ours, and then:

```bash
QUALITYFORGE_THIRD_PARTY=1 npx playwright test tests/smoke/third-party
# from the consumer's directory, against the report that run produced:
npx --no-install qualityforge --report <report> --out ./artifacts --no-history --json
```

Exit 1, the gate red as designed, five artifacts. What that run showed that the
in-repository invocation cannot: the artifacts carry the **consumer's** tags
(`consumer`, `third-party`) and not this repository's (`demo`, `smoke`), they land
in the consumer's `artifacts/` with **zero** files written into `node_modules`,
and no git commit is recorded because the consumer's directory is not a git
repository — which is the honest answer, not a missing field. Every defect carries
`context.baseUrl: https://quotes.toscrape.com` with `targetSource: observed`, and
per-defect `page.url` values including the 404 path.

The summary beside them says `baseUrl: http://127.0.0.1:4321`, `targetSource:
report` — because that run's Playwright config declared a `webServer`, and
`defect-schema.md` already says a summary keeps the configured answer while the
observation lands per defect. Noted here because it is the first time that
documented split has been observed rather than asserted.

Two costs worth recording: the collector needs `evidence` in its configuration
without being told, and a consumer project that has no `config/project.json` of
its own exits 2 with `Configuration error` rather than guessing — both correct,
both found by running it the way a consumer does.

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

Nothing on the defect board is open. `#6` and `#12` were closed by F1 on
2026-10-07, on the owner's decision of 2026-10-06, with their references
(`#13` and `#14`); `#1` went with E2 (`PR #23`), and the milestone
`v0.1.0-alpha` — twelve issues, all twelve closed — is closed with them. The
two closing comments cite the pull request and the observations behind it
rather than asserting the work happened. The issues opened since are a
different kind: `#40`–`#44` are the **Later** items below, filed so they can be
picked up, not defects this repository found in itself.

## Later

Only after the above. Each item is filed as an issue so it can be picked up and
reviewed rather than living only in this file:

- Visual regression
  ([#41](https://github.com/ninelegsdog/qualityforge/issues/41)), performance
  budgets
  ([#42](https://github.com/ninelegsdog/qualityforge/issues/42)), API
  assertions ([#43](https://github.com/ninelegsdog/qualityforge/issues/43)).
- Cross-project configuration, so one policy applies to many repositories
  ([#44](https://github.com/ninelegsdog/qualityforge/issues/44)).
- **MCP Registry, and MCPB packaging with it** — deferred by the owner's
  decision of 2026-10-06: a milestone reached after the first consumers exist,
  not a step before publication. Nothing in the registry direction is built or
  promised until then.
- Write access, and only behind the read-only surface being stable: run a test,
  validate a fix, draft an issue — sandboxed and audit-logged, never auto-published.

## Out of scope

- Replacing Playwright, axe-core, Lighthouse, Sentry or Grafana.
- An autonomous agent that writes, merges and deploys code.
- Clients other than OpenCode, by decision rather than by omission.
