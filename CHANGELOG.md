# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-21

### Added

- **Appearance as a fourth evidence dimension, compared against committed baseline
  images.** Each declared page is photographed and hashed, and the collector writes
  `visual-audit.v1` under `artifacts/visual/<runId>/`. Chromium only, zero tolerance,
  and the verdict is a SHA-256 of the screenshot bytes — which makes zero tolerance a
  property of the comparison rather than a number somebody chose, because there is no
  threshold to tune and so no size of change quietly decided not to look for.

  Measured on 2026-10-18: chromium produced byte-identical screenshots across five runs
  in fresh contexts, but **no two engines or viewports shared a hash**, and firefox
  rendered the home page in **two stable states exactly 253 pixels apart on three runs of
  ten** — not noise, and waiting does not settle it. That is why one engine is named and
  why a page seen two ways is `unstable`, its own kind: calling it a change would send a
  reader to diff two pictures when the real question is which of them is the page.

  **Baselines are born in the CI image**, on the owner's decision of 2026-10-19. The same
  commit differs by **269–1898 pixels** between a GitHub runner and a laptop, against a
  real CSS change worth 3 315, so the 13-fold separation measured on one machine is gone
  across two. `updateSnapshots` is `"none"` — Playwright's default of `missing` would let
  a plain suite run write any snapshot it lacks and pass, approving an appearance nobody
  looked at — and the CI step runs **after** the collector, so a page with no baseline
  stays red until a human commits the image the run produced.

  There is **no manifest of expected hashes**: the committed PNG is the baseline and its
  hash is computed from the file, because a manifest beside the images would be a second
  copy of one fact. A baseline's **viewport is `null`**, because the image does not
  record one; the live external run found the producer claiming `0×0×0`, which read as a
  real measurement of a page nobody rendered. Three gaps recorded as **G23**–**G25**,
  and **G24 is decided**: no rendered diff overlay and no stored observed image in v1,
  because a screenshot is page content that field-level redaction cannot sanitise.
  The contract is in `docs/visual-audit-schema.md`. (G24's escalation was resolved the
  same day it was raised, without moving the default: see the observed-image entry
  below, and the resolution recorded at the decision itself.)

  Two read-only MCP tools, `quality_list_visual_audits` and
  `quality_get_visual_audit`, read them over a fifth root, `--visual-root`. The wire
  check seeds a **changed** page rather than a clean one: what must survive the wire is
  both hashes and the committed file that approved the other one.

- **`visual.observedImages`, the opt-in store for the judged captures.** A project
  that wants to see what a finding _looks_ like declares the block in its own
  configuration and the collector keeps the images beside the audit — the reviewer's
  question "what did the header lose?" stopped needing a re-derivation of the page the
  run already photographed. The decision that made it possible is the one above: the
  default behaviour was not moved, and a project without the block writes artifacts
  whose pages carry no observed picture at all.

  Three honest controls instead of a redaction that cannot exist for pixels: the
  declaration itself, a **judged-only** filter (stubs and foreign engines store
  nothing), and a `keep` bound — after every opted-in run, older runs' `observed/`
  copies are freed while their audits stay. Storage is
  `artifacts/visual/<runId>/observed/<sha256>.png`, named by the hash of its own
  bytes and re-hashed on arrival, so the audit's hash, the file's name and the file's
  content are one fact; an appearance whose bytes never arrived stops the collection
  rather than being pointed at. Every judged page gains an optional
  `observed: [{sha256, bytes, file}]` pointer list in first-appearance order, which
  is a **minor** schema bump — `visual-audit.v1.json` is at `1.1.0`.

- **API contracts, declared and audited, as their own dimension.** A project
  declares its contracts in `config/project.json` — method, path, and what the
  exchange must carry: a status, a media type, field paths in the request body,
  field paths in the response body. The fixture captures only the declared
  exchanges, and the collector writes `api-audit.v1` under
  `artifacts/api/<runId>/`.

  The artifact is not `defect.v1` and is not a field on it. A contract that broke
  without breaking a test is exactly what this catches, so the capture attachment is
  written on **every** test rather than on failures only.

  **An expectation nothing matched is a violation, not an absence** — the owner's
  decision of 2026-10-16. Listing only what was seen would let an application stop
  calling its own endpoint while every test stayed green. Two related rules fall
  out of the same reasoning: a body that could not be read makes every declared
  path missing, and exchanges the capture's cap refused are a violation of their
  own, because a capture that examined 40 of 50 has not proved the other ten.

  What survives a body is **presence, never values**: the audit records the
  declared paths a body did _not_ carry, and the found ones are not recorded at all
  — the declared list is in the configuration, and two copies of one list are two
  things to drift.

  Measured on 2026-10-17, on all three engines: every GET response body is
  readable, and a POST response body is readable on firefox and webkit but
  **chromium never answers** while the page stays open. The read is bounded rather
  than awaited forever, and an expired bound is recorded as `too-late` — "the
  engine did not answer" is a different fact from "the field is missing".

- **A broken API contract now fails the run, in `summary.api`.** The collector
  exits `1` when either the test thresholds or the declared contracts failed.

  **Two read-only MCP tools read the audits back**, over a third root,
  `--api-root` (default `artifacts/api`, when it exists):
  `quality_list_api_audits` and `quality_get_api_audit`. A fourth conventional
  name, and the last — three roots exist because three measurements answer three
  different questions, and none of them belongs inside another's directory.

  The root is confined like the other two, and the check that proves it now covers
  the escape that **only exists with three roots open at once**: a path out of
  `artifacts/api` and into the accessibility audits, refused with `-32602`.

  **`tests: 0` reads as `NOT RUN` in both tools**, never as zero violations —
  a run of pure logic tests never imports the fixture, and a client that read
  "0 violations" there would report an unmeasured contract as a sound one.

  **A refusal is now a readable answer rather than `Internal error`.** "This
  project declares no API contracts" is a legitimate answer to a legitimate
  question; it used to reach a client as a JSON-RPC internal error. Applied to the
  accessibility pair too, because the wart was the same one. A rejected _path_
  still throws, so the server keeps answering "Path is not readable" and keeps the
  log line that says a client tried.

  **The contract is documented in prose, and three gaps are recorded as G18–G20.**
  `docs/api-audit-schema.md` states what a consumer can rely on — values never
  survive a body, an unreadable body makes every declared path missing, dropped
  exchanges are a violation of their own — and what a consumer must not assume.
  The largest gap is measured: chromium never hands over a POST response body, so
  `responseRequires` cannot be relied on there while firefox and webkit answer.

  **"Not run" is a third state, and CI is what found it.** The `unit` job runs pure
  logic tests that never import the fixture, so no exchange could ever have been
  made — and fail-closed duly reported two violations for a run that had made no
  claim at all. A run with no capture is now neither clean nor failed:
  `summary.api.ran` is false and the collector prints `api contracts NOT RUN`.
  Fail-closed applies from the moment a single capture exists.

  `summary.gate` is **unchanged and keeps its meaning** — it still answers "did the
  tests hold the thresholds". Folding API violations into it would have changed
  the _meaning_ of an existing field, which the rule below calls a major change and
  a `v2` file; that is a price no one should pay for one added block. The two
  verdicts are reported apart in the summary and combined in exactly one place, the
  exit code — because a gate whose caller must distinguish two failure codes is a
  gate people end up scripting for only the one they have seen. `summary.api` is
  **absent** when nothing is declared, which is different from present and clean.

- **An accessibility audit, as its own command and its own artifact.**
  `npm run a11y:audit` — or `npx --no-install qualityforge-a11y` in a consuming
  project — runs `axe-core` against a page and writes `a11y-audit.v1` under
  `artifacts/a11y/<runId>/`. It exits `0` with no violations, `1` with
  violations, and `2` when it could not audit at all; the third is deliberately
  distinct from the first, because an audit that never ran must never read as an
  audit that found nothing.

  The artifact is not `defect.v1` and is not a field on it. An audit exists
  whether or not anything failed, so binding the two would make every audit look
  like a defect — and measured on this repository's own pages, the three fixtures
  routes produce **zero** violations, so a green audit of them proves nothing
  either.

  What the artifact keeps was chosen from a real engine's answer, not from its
  documentation: only `violations` and `incomplete` (on one real page they were
  33 bytes out of 53 147 — `passes` and `inapplicable` are the rest), nodes
  capped at ten per rule with `totalNodes` and `truncated` so the cap says what
  it dropped, `html` reduced to tag and attribute names because nine separate
  positions were measured carrying page content, and `target` kept whole —
  without it, 48 nodes of one rule are indistinguishable.

- **`axe-core` is a peer dependency**, declared the way `@playwright/test` is.
  The core of this package does not use it: the audit uses the engine the
  project already has, and nothing ships a second copy.

### Fixed

- **`quality_get_latest_run` dropped the run summary's declared-dimension verdicts
  and the policy chain.** The collector writes `api`, `perf`, `visual` and `policy`
  into `quality-summary.v1.json`, but the documented first tool passed through only
  counts, gate, defects and flakiness. A live external run found it: an agent that
  started where the server instructions say to start reported that the API,
  transfer-budget and appearance verdicts did not exist and that no tool exposed the
  policy chain — while the file held all four. The blocks now travel in
  `structuredContent` and in the tool's text, and a dimension with `ran: false`
  reads `NOT RUN` rather than as a clean one. Asserted on the wire against a real
  seeded run (`mcp:check:tools`), not only against a hand-written summary.

- **Accessibility looked like a missing block in the run summary.** The live
  external agent read `quality-summary.v1.json`, found no accessibility field and
  could not tell whether the dimension was absent, clean or run by another command.
  It is the last one: `qualityforge-a11y` is a separate gate with its own artifact,
  `runId` and exit code, and the collector never calls it. The schema now states
  that independence and the way to correlate the two by origin and `createdAt`;
  both MCP tools say it too, rather than leaving an agent to infer a relationship
  from two similar-looking ids. The rules now state that `counts.nodes` and
  `counts.truncatedRules` cover `violations` **and** `incomplete`; the live run's
  24 nodes were 21 + 3, and the document did not say so.

- **A token with no key beside it was not redacted.** `redactAssignments` matched
  secrets by the name of the key next to them, which cannot work for a token
  Playwright quotes out of the page into `Received:` — measured, the token
  survived in 4 of 4 real failure messages and 4 of 4 stacks. Formats with a real
  structure are matched as well, chosen by a probe over the repository and the
  working notes with eleven decoys built to look like secrets: the GitHub token
  family, OpenAI keys, AWS access key ids. A broader `sk-` pattern was rejected
  because it took an `sk-` slug and a CSS class out of working text. Formats earn
  their place by measurement rather than by the fame of the vendor, and the
  trigger for adding one is written into the source rather than left to be
  rediscovered.

- **`failure.message`, `failure.stack` and an audit's `target` are redacted.**
  `snippet` deliberately is **not**: it is the test's own source, it carried the
  token in 0 of 4, and redacting it rewrote a template literal into corrupted
  code — damaging the line a reader came to see.

## [0.1.0] — 2026-10-15

The first stable release.

The `defect.v1` contract at `1.4.0`, the `exports` map, `bin`, `files`,
`engines` and the `^1.63.0` Playwright peer are identical to
`0.1.0-alpha.2` — checked field by field against `git diff
v0.1.0-alpha.2`, not assumed. Only two things a consumer sees differ: the
`version`, from `0.1.0-alpha.2` to `0.1.0`, and signal redaction, which
now honours the declared key list — that changes what an artifact
contains, but no import, signature or schema. Everything below is
therefore of one of two kinds, and the two are kept apart: what a consumer
reads, and what this repository now enforces on itself.

### Added

- **A worked reference to copy** (PR #33). `docs/selectors-and-testid.md` has
  named the page-object pattern as the reference consumers should follow, and
  nothing demonstrated it — the suite called selectors inline, so a consumer
  copied from a vacuum. `tests/smoke/pages/base-page.ts` now reads only the
  policy's selectors (role, label, text, and the two `data-testid` the app
  actually uses) and takes its page from the fixture, so the file a consumer
  copies shows the real composition. It runs on all three browser legs like
  every claim that is not a unit fact, and the reverse probe ran here: renaming
  `Send` to `Sende` fails exactly the tests that click it on every leg with the
  click timing out, and the tree was restored. Its twelve tests moved
  quick-start's counts from 385 to 397.
- **The selector policy is enforced, not stated** (PR #32). Five
  `no-restricted-syntax` rules ban XPath prefixes, class and id selectors,
  attribute selectors, combinators, whitespace-separated descendants and
  `text=` on a literal first argument of `locator()`. Reverse probe: a scratch
  spec carrying all six banned forms fails `lint` with eight errors naming each,
  and the same file written with `getByRole`/`getByLabel`/`getByText`/
  `getByTestId` passes. Variable and template arguments are not statically
  reachable and stay a documented gap; positional `.nth()` stays policy-only.
- **A repository-contract gate, and proof it can fail** (PRs #51, #52, #53).
  `scripts/check-repo-contract.py` checks this repository against the shared
  contract, `scripts/check-repo-contract_test.py` proves that checker goes red,
  and the gate runs in CI rather than by hand. A gate that has never failed is
  an assumption, not a gate.
- **`docs:security`, and a `SECURITY.md` that describes what exists** (PR #34).
  The policy answered the questions it exists for in wording that outlived the
  code — "once it exists" for a server that exists and is published, "for the
  MVP" for a first release that shipped. The scope and commitment now name the
  published reality, and the check asserts each of the five claims — read-only,
  server-side path boundary, stdio scope, redaction, no supported versions — by
  the exact bold marker it is written as, in CI and in `prepublishOnly`.
  Reverse probe: removing the read-only marker reddens it with the claim named.
- **Governance brought to the family standard**: `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md`, `.editorconfig`,
  `.gitattributes` and `CODEOWNERS`, plus issue forms and a pull-request
  template asking for the evidence this project acts on — what was run, what was
  expected, and how "done" would be able to fail.
- Long-form documentation that existed but was unreachable is now linked from
  the front page: `docs/architecture.md`, `docs/client-support.md`,
  `docs/defect-schema.md`, `docs/parallel-work.md`, `docs/quick-start.md`,
  `docs/quick-start.ru.md`, `docs/roadmap.md`, `docs/selectors-and-testid.md`.

  **Two read-only MCP tools read the budgets back**, over a **fourth** root,
  `--perf-root` (default `artifacts/perf`, when it exists):
  `quality_list_perf_audits` and `quality_get_perf_audit`. Four directories are now
  open at once, and the check proves the escape that only becomes reachable at four:
  out of `artifacts/perf` and into the API audits, refused with `-32602`.

  **The contract is documented in prose**, in
  [`docs/perf-audit-schema.md`](docs/perf-audit-schema.md), with nine rules a consumer
  can rely on — the largest load rather than an average, a budget nothing loaded as a
  violation of its own kind, a reading that covers the page that stands rather than the
  pages that passed.

  **Two gaps recorded as G21 and G22** in
  [`docs/defect-schema.md`](docs/defect-schema.md): a timing budget cannot be made to
  fail only for a real regression on a shared runner, and a reading cannot reach back
  to a page the browser has left.

- **One quality policy, shared by many repositories.** A project declares `extends`
  with a path to a file and takes what it does not state from there; its own values
  win, field by field. The contract is in
  [`docs/shared-policy.md`](docs/shared-policy.md), with a worked example in
  [`examples/shared-policy/`](examples/shared-policy/) holding two projects on one
  policy.

  **`summary.policy` records the chain a run inherited**, `1.5.0` → `1.6.0`,
  additive and in the run summary only — nothing about a `1.6.0` **defect** moved.
  Before this field two projects, one writing every value itself and one sharing a
  policy, produced identical configuration, and a reader of the stored artifact could
  not ask whether a policy had been involved. Absent when nothing was inherited,
  because an empty chain claims a check nobody made.

- **Transfer budgets as an evidence dimension.** `thresholds.maxTransferredBytes`
  declares the largest a page may cost, the fixture captures what each page actually
  cost, and the collector writes `perf-audit.v1` under `artifacts/perf/<runId>/`. A
  breach stops the run.

  **One metric, chosen by measuring two.** Over five runs on the demo pages:

  | measured                            | home          | heavy   | spread |
  | ----------------------------------- | ------------- | ------- | ------ |
  | `transferSize` from Resource Timing | 3 922         | 526 538 | **0**  |
  | sum of response bodies              | 1 704 / 2 101 | 525 638 | 397    |

  So the metric is the network layer's own count: summing bodies needs the engine to
  hand each one over, and it does not always — the same page measured 1 704 and 2 101.
  **Timing was measured and rejected**: it separates a real regression 5.7-fold, but
  its noise grows from 4 ms idle to 39 ms with four CPUs busy. A budget that can fail
  for two reasons is worth less than a second budget that can fail for one.

  **The budget is 20 000 bytes** — five times the home page and twenty-six times below
  the heavy one. The margin is not fighting noise, which is zero; it is bought for
  the future.

  **The verdict is the largest load, never the average.** A page that is usually fine
  is what a regression looks like, and a mean would pass four small loads and one
  enormous one.

  **Three states, not two.** Held, breached, and _not run_ — a run of pure logic tests
  never loads a page, and reporting that as a passed budget would claim a measurement
  nobody made. `summary.perf` is a field of its own: folding budget breaches into the
  test thresholds would change the meaning of an existing field, which is a `v2` file.

  **A project may declare `perf.pages`, or leave it out.** Named pages are held
  exactly: one nobody measured is `no-observation`. Omitted means every page the run
  actually loaded, so enabling the dimension cannot fail because a consumer did not
  repeat a route list it was never asked for. The external live run on 2026-10-19
  found the hard-coded alternative: a project outside this repository set only
  `maxTransferredBytes` and got `no-observation` for pages it had never declared.
  The counts now say what they measure: `counts.pages` is observed paths while
  `counts.budgets` is pages held, and the two differ for a declared page nobody
  loaded.

  The demo server gains `/heavy`, a page that exists to breach a budget and is linked
  from nowhere, so the red half of "a heavy page goes red" is checkable rather than
  assumed. `/heavy` is excluded from this repository's `perf.pages` for that reason.

### Changed

- **One quality policy, shared by many repositories.** A project declares `extends`
  with a path to a file, and the values it does not state come from there. The
  project's own values win, field by field.

  ```json
  { "extends": "../../quality-policy.json" }
  ```

  **What may not be shared is refused rather than ignored**, and the error says why:
  `name`, `baseUrl`, `projects`, `tags`, `defects.directory`, `history.directory`,
  `api.directory`, `api.expectations` and `perf.pages` all belong to the project that
  runs the application. A policy carrying any of them would look authoritative and
  mean nothing — or worse, mean the wrong thing, since a shared `baseUrl` would point
  every project's artifacts at somebody else's server.

  **After those refusals a policy contains no arrays at all**, which removes the one
  question per-field merging usually gets wrong: what a list from two sources should
  mean. Here it never arises, and that is a consequence of what was forbidden rather
  than a convenience.

  **A policy's own values are checked before anything is merged from it.** An
  impossible threshold is refused naming the _policy_, not the project — because an
  error that sends the reader to the wrong file is the "half-applying" this feature
  exists to prevent, in the only disguise it can reach this code in.

  **A policy may inherit from another policy**, organisation to team, with the one
  named first winning. A cycle is refused with the whole chain named: a loop is not
  a slow run, it is a policy that would apply forever, and the visible failure has to
  arrive before the invisible one.

### Changed

- **The configuration validator is fail-closed on keys, not only on values.**
  Measured on 2026-10-18: `nonsenseKey` at the top level, `evidence.nonsense` and
  `thresholds.extraKey` were **all accepted** — nothing in the loader ever asked
  which keys were present. Values the schema does know were checked strictly, so
  the validator was strict about what it understood and silent about everything
  else.

  This is a change of behaviour, not an added field: **a configuration carrying a
  key QualityForge does not define will now be rejected**, at every level, naming
  the offending key and suggesting the nearest one that does exist. Nothing in this
  repository relied on the loose behaviour — the whole suite passed unchanged on the
  first run — but a consuming project holding a stray key will find out.

  It lands first, and separately, because #44 introduces a key (`extends`) whose
  entire function is that it is read. Under the old rules a typo in it would have
  disabled inheritance in **every** project that misspelled it, each of them going
  on believing it shared a policy.

### Changed

- **The README is a front page** (PR #37): pitch, badges, a table of contents
  and user-facing sections, and the stale "not on npm yet" claim is gone now
  that the package is published.
- **Documentation drift is checked where it happens** (PRs #35, #36).
  `docs:numbers` parses the `The remaining N run.` sentence and compares it with
  collected minus skipped — it had said 324 while 385 − 60 is 325, and nothing
  read it, one paragraph below the check's own origin story. Four files that
  must stay count-free (README, CONTRIBUTING, architecture, AGENTS) now refuse
  the shapes a spec count takes there, so removal survives: appending a count
  to the README fails naming the line.
- **Process is enforced, not assumed** (PR #37 and repository settings): `main`
  requires all seven CI checks, merging is squash-only with the branch deleted,
  and `.gitattributes` pins LF so a CRLF contributor no longer turns every
  touched line into a diff.
- **Dependency hygiene and package metadata** (PRs #39, #57). Dependabot watches
  npm as well as GitHub Actions (weekly; the Playwright runner stays out of its
  reach by the pin policy), `package.json` carries `homepage` and `bugs`, and
  `typescript@>=7` and `@types/node@>=23` are ignored with the reason beside
  each: the first cannot pass `npm ci` because `typescript-eslint` declares a
  peer of `>=4.8.4 <6.1.0`, the second describes modules the `node >=22` floor
  does not have. Left to automation, the weekly run would reopen both and spend
  two of five PR slots on bumps that cannot land.
- **Dist-tag honesty** (PR #39): the prerelease carries `next`, `latest` cannot
  be removed by npm and still points at the alpha until v0.1.0, and the README
  says to pin the version rather than trust a tag name.
- **The documentation describes the repository as it exists** (PRs #38, #46).
  `docs/architecture.md` records one published package, all five evidence-flow
  steps present and the legacy MCP handshake documented, rather than a Day-2
  snapshot with boxes marked "[planned]"; the roadmap's Later items point at
  issues #40–#44 instead of living only in the file, and "a release" names the
  `v0.1.0` milestone whose description carries the criteria.
- **The template's divergence is recorded as a decision** (PR #58).
  `qualityforge-template` carries no part of the contract layer, because the
  gate checks how a repository presents itself and a template produces
  repositories at clone time, before any of that exists. Written down because an
  unexplained divergence reads as an oversight and gets "fixed" by whoever
  notices it first.
- **`mcp:check:spawn` runs in CI** (PR #31). It starts the server from a
  foreign directory with no `npx` — the arrangement that broke the artifacts
  root once — and was the only MCP check with no job at all, while the other two
  started the server from the project root, which is what nothing else does.
  Its absence was an omission, and the comment on the step now says so.

### Fixed

- **Signal redaction now honours the declared key list.** `redactText` carried
  its own nine-word pattern under a comment promising `SENSITIVE_KEYS`, and the
  two lists drifted until eight declared keys — `auth, code, csrf, key, pwd,
session, sig, signature` — passed through captured text untouched. The
  pattern is now built from `SENSITIVE_KEYS` itself, so a second list cannot
  drift again, and it covers three literal shapes the old one missed: a JSON
  key with its closing quote (`{"token":"ghp_…"}` reached the artifact whole,
  and that is the most ordinary object-printing shape there is), a
  single-quoted value (`token: 'ghp_…'`), and an underscore continuation
  (`session_id=`). The right-hand side got stricter to pay for the permissive
  prefix that catches `accessToken=` and `clientSecret=`: `keyboard=`,
  `sessionStorage=` and `tokenizer=` are left alone, where `tokenizer=` used
  to be redacted too. The cost is measured, not asserted — across the 583
  captured strings in `artifacts/defects/` the new pattern makes **zero**
  extra redactions, and a positive control confirms that comparison can
  report a nonzero count at all. It does fail closed on a word ending in a
  key: `exit_code=1` and `status_code=404` are redacted, and that trade is
  pinned by a test so that changing it is a decision rather than an omission.
  Seven unit tests guard the change, and with the fix reverted six of them go
  red. Counts in quick-start moved with it, to 406 specs and 346 running.
- The collector-path tests classified every `execFile` rejection as exit 1 —
  the collector's own number for a failed gate — so a collector that never ran
  reported a failed gate instead of the reason it did not run. The interpreter
  is now the pinned local `tsx` instead of whatever `npx` fetches from the
  registry into a temporary directory, and an unrecognised rejection fails with
  the code, the signal and the stderr. Found in the red CI job of 2026-10-13:
  the test failed its first attempt inside `npx`, passed on the retry against a
  warm cache, and the quality gate reddened the build over a flaky test — as
  designed, and over a message that named the wrong cause. Quick-start's counts
  moved with the fix, to 399/60/339.
- `README-testing.md` was unreachable from the README in every bot of the family
  except one. A document nobody can reach is a document nobody reads; it is linked
  from the front page now.

## [0.1.0-alpha.2] — 2026-10-07

### Added

- **A second third-party application: GitHub.**
  `tests/smoke/third-party/github.smoke.spec.ts` (the owner's E2 decision of
  2026-10-06) runs the same method as the quotes suite against an application
  built the modern way: four tests establish what it does — client-side
  navigation keeps page state, the repository page, the login form, the
  signed-out front page — and four probes fail on purpose, one question each:
  a failure after a Turbo navigation with no load event, a lazy image the
  browser never requested, twenty-five rows sharing the accessible name
  "Open", and a stubbed first-party CDN on a foreign eTLD+1. The reachability
  probe also refuses a body that answers 200 without the signed-out header,
  both refusals were run red on purpose, and the whole file stays out of
  `npm test` behind `QUALITYFORGE_THIRD_PARTY=1` with `--workers=1`.
  Findings are written down as G15–G17 in `docs/defect-schema.md` — `page.title`
  stale against `page.url` after client-side navigation, `dropped: 43` with no
  provenance when one host consumes both caps, and a never-requested resource
  that produces no signal to tell apart from silence — plus G5's cap
  prediction observed for real and a negative result for the iframes
  hypothesis on six public pages. G15–G17 came back from the owner as
  **documented limitations** (2026-10-06) — the contract stays at 1.4.0,
  and each gap states what a consumer must not assume instead;
  quick-start's counts moved to 384/60
  and are still checked by `docs:numbers`.

- **`@playwright/test` is now a peer dependency** (owner's decision
  2026-10-06): a consuming project brings its own Playwright instead of
  receiving a second copy beside it, and `peerDependenciesMeta.optional` stays
  unset — npm 7+ installs the peer automatically, because the fixture cannot
  run without it. The range is `^1.63.0`; `1.63.0` is what CI pins and verifies.
  `npm run package:check` grew two claims proven red before this was written:
  the installed package must declare the peer at `^1.63.0`, and npm must have
  actually installed it for the consumer — declare the peer and stop having it
  installed, and the check names which of the two broke.

- **A live client in CI.** `npm run mcp:live` connects the real `opencode`
  binary to this server from a fresh directory outside the checkout — no `npx`,
  no project environment, the way a client actually starts it — and asserts on
  the captured frames rather than on the word "connected": the `initialize`
  echo, `serverInfo` in the result and in `_meta`, and a `tools/list` answer
  carrying `resultType`, `ttlMs`, `cacheScope` and exactly the tools
  `tool_list.py` names. The wire is read through `scripts/mcp-wire-log.mjs`, a
  dependency-free pass-through, because a legacy-path client stays silent about
  all of that: with the `_meta` envelope removed from the answer the client
  still connected, and only this check went red. The `live-client` CI job pins
  the client to 2.0.16 and asserts the pin twice — `EXPECT_OPENCODE_VERSION`
  against `opencode --version`, and `clientInfo` in the initialize frame
  against the same number — and `mcp:schema` joined it, as promised when that
  check was deferred for want of a client binary. Proven red four ways: no
  `_meta`, no `resultType`, a server dying at startup, a wrong pinned version.
  Observed on the way and recorded rather than assumed: `opencode mcp list`
  probes legacy (`initialize` 2025-11-25) whatever the `protocol` config key
  says, so the pinned era and `server/discover` remain outside every automated
  check.

- **The capabilities quotation is checked against the client itself.** The
  2026-07-28 shape was settled in `0.1.0-alpha.1` (issue #12: the schema in the
  OpenCode binary still carries `listChanged`, and the one lie —
  `resources.subscribe` — was removed), and the unit tests pin our emission
  against that schema quoted into the test file. A quotation proves the copy:
  `npm run mcp:schema` extracts `ServerCapabilitiesSchema` from the `opencode`
  binary on the machine and fails if this server advertises a member or nested
  key the client's schema does not contain, naming the offending member and the
  schema it came from. It runs locally until E3 installs a client in CI;
  `OPENCODE_BIN` makes even the extraction's own failure path testable.
  Proven red three ways: a binary without the schema, an out-of-schema member,
  and — the case the schema cannot catch, because `subscribe` is valid in it —
  the old advertisement, caught by `mcp:check` naming it.

- **A table of who implements the revision, with the commands behind it.**
  [`docs/client-support.md`](docs/client-support.md) records each client's
  connection, `server/discover` behaviour and capabilities form, and every row
  cites the evidence (command + date) it rests on. Observed 2026-10-06: OpenCode
  2.0.16 connects, requests `2025-11-25` without the `_meta` envelope and never
  sends `server/discover` — though its bundled SDK carries the method, era-gated
  to 2026 — while Kilo and MiMo read `not tested` by decision rather than by
  omission. `npm run docs:support` fails a claim without a citation and an
  "untested" row without a decision, so the table cannot drift into impression.

### Changed

- **`engines` narrowed from `>=20.19.0` to `>=22.0.0`** (B4, owner's decision
  2026-10-06: support what is verified). The floor had claimed Node 20 while CI
  ran 22 and 24, and Node 20 reached end-of-life in March 2026 — the permissive
  floor was a statement about install politeness that nothing here ever
  executed. It now equals the lower of the two CI lines, `@types/node` moves 20
  → 22 with it, and rule 12 of `scripts/validate-ci.py` fails if the floor and
  the matrix ever part ways — proven both ways: `>=20` fails as a promise nobody
  runs, `>=24` as a promise CI has disproved, `>=22` passes with
  `engines >=22.0.0 = lowest CI line (22)`.

### Fixed

- **The live client check now waits for the connection instead of racing it.**
  `opencode mcp list` prints its verdict and exits in about 150ms on a fast
  runner, while the server it spawned keeps booting after the client is gone —
  so four back-to-back attempts gave the connection roughly one second of wall
  clock, and two consecutive runs on `main` failed with every attempt
  `pending` and the whole check lasting 1.04s (2026-10-06). Attempts are
  spaced by `ATTEMPT_GAP_S = 2.0` now, with the measurements next to the
  constant: a server that never answers still goes red on `pending`, a server
  that dies at startup still goes red on `failed`, and the live run still
  asserts the frames. The check's stdout is line-buffered so the log says when
  each attempt happened.

## [0.1.0-alpha.1] — 2026-10-06

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

[Unreleased]: https://github.com/ninelegsdog/qualityforge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ninelegsdog/qualityforge/releases/tag/v0.1.0
[0.1.0-alpha.2]: https://github.com/ninelegsdog/qualityforge/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/ninelegsdog/qualityforge/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/ninelegsdog/qualityforge/commit/cb7dbce7ac3226d7073ca9bf5b58571f80a76295
