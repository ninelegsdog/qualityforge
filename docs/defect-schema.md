# Defect artifact v1

A defect artifact is one normalized failure, written per run, designed to be
read by a human or handed to an agent without further interpretation.

- Machine-readable schema: [`../schemas/defect.v1.schema.json`](../schemas/defect.v1.schema.json)
- Runtime types and validator: [`../src/defect/types.ts`](../src/defect/types.ts)
- Producer: [`../src/defect/collect.ts`](../src/defect/collect.ts)

## The design rule

**This artifact extends Playwright's `error-context.md`; it does not duplicate
it.**

On every failure, Playwright already writes a markdown file whose content is
phrased as an instruction to an assistant — "explain why, be concise, respect
best practices" — followed by the test name, the file and line, the error, the
expected versus received values, and a page snapshot.

Parsing prose written for a human reader would be the most fragile link in this
entire pipeline. So the artifact records a path to that file and adds only what
it cannot carry:

| Added here                         | Why it cannot live in `error-context.md`                       |
| ---------------------------------- | -------------------------------------------------------------- |
| `id`                               | Needs to be stable across runs so history can be joined        |
| `runId`                            | Groups every defect from one execution                         |
| `context.commit`, `context.branch` | Version context is not the runner's business                   |
| `context.baseUrl`                  | Reduced to an origin; the runner records the full value        |
| `evidence.*`                       | Machine-readable pointers rather than a human-readable list    |
| `flakiness`                        | Requires reasoning across attempts, which the file does not do |
| `retryHistory`                     | Same                                                           |

## Producing artifacts

```bash
npm test                    # writes artifacts/json/playwright-results.json
npm run defects:collect     # writes artifacts/defects/<runId>/
```

```
artifacts/defects/2026-10-03T00-43-13-217Z-443909/
├── form-validation-smoke-shows-an-error-when-email-is-empty.v1.json
├── form-validation-smoke-shows-an-error-when-email-is-malformed.v1.json
├── quality-summary.v1.json
└── ...
```

`npm run defects:collect` exits `0` when the quality gate passes, `1` when it
fails, and `2` when collection itself could not run. That makes it usable
directly as a CI step.

```bash
npm run defects:collect -- --json    # machine-readable summary on stdout
```

## Signals

`signals` is the second most useful block for triage after the error message
itself. A failure reading "element not found" is a symptom; "the page threw a
TypeError" or "GET /api/items returned 500" is the cause.

The Playwright JSON reporter carries none of this — its `stdout` and `stderr`
fields were empty on a real failing run — so it is captured live by the
QualityForge fixture:

```ts
import { test, expect } from "../fixtures.js"; // not "@playwright/test"
```

That single import change is the whole integration. The `signals` fixture is
declared `auto`, so console errors and warnings, uncaught page errors, failed
requests and HTTP responses at or above 400 are captured for every test that
drives a page, and attached as `quality-context` when — and only when — the test
fails.

```jsonc
"signals": {
  "consoleErrors": [
    {
      "type": "error",
      "text": "diagnostic: fetching with token=[redacted]",
      "location": { "url": "http://127.0.0.1:4311/app.js", "line": 6, "column": 12 }
    }
  ],
  "consoleWarnings": [
    { "type": "warning", "text": "Authorization: Bearer [redacted]" }
  ],
  "pageErrors": [],
  "requestFailures": [],
  "httpErrors": [],
  "dropped": 0
}
```

Rules a consumer can rely on:

- **Absent versus empty.** `signals` absent means "not observed", because the
  test drove no page or captured nothing. An empty array means "observed, found
  nothing". Those are different claims and are not conflated.
- **Redacted at the source.** URLs keep scheme, host, port and path; query
  strings, fragments and credentials are removed. Console text has sensitive
  assignments, `Authorization` values and bare JWTs replaced with `[redacted]`.
  The auth _scheme_ is deliberately preserved, because "Bearer" versus "Basic"
  is diagnostically useful and the token is not.
- **Bounded.** At most 40 entries per category. `dropped` records how many hit
  the cap, so a truncated capture never looks complete.
- **An auth-scheme word is not a secret.** Redaction that turns
  `Authorization: Bearer [redacted]` into `Authorization: [redacted] [redacted]`
  destroys the diagnostic value while protecting nothing extra.

## Shape

```jsonc
{
  "$schema": "https://qualityforge.dev/schemas/defect.v1.schema.json",
  "schemaVersion": "1.0.0",
  "id": "form-validation-smoke-shows-an-error-when-email-is-empty",
  "runId": "2026-10-03T00-43-13-217Z-443909",
  "createdAt": "2026-10-03T00:43:13.217Z",
  "status": "failed",

  "test": {
    "playwrightId": "aa9410a9...",
    "title": "shows an error when email is empty",
    "file": "tests/smoke/form-validation.smoke.spec.ts",
    "line": 15,
    "column": 3,
    "project": "chromium",
  },

  "failure": {
    "message": "Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByRole('alert')\nExpected: \"Email is required\"",
    "location": { "file": "tests/smoke/form-validation.smoke.spec.ts", "line": 18, "column": 43 },
    "snippet": "16 | ...\n> 18 |   await expect(page.getByRole(\"alert\")).toHaveText(\"Email is required\");",
    "stack": "Error: ...",
    "errorContextRef": "test-results/smoke-form-validation.../error-context.md",
  },

  "evidence": {
    "screenshot": "test-results/.../test-failed-1.png",
    "video": "test-results/.../video.webm",
  },

  "context": {
    "baseUrl": "http://127.0.0.1:4311",
    "commit": "43c761f54c3571fab9fd9211539493d6210decea",
    "branch": "main",
    "ci": false,
    "retries": 0,
    "runStartedAt": "2026-10-03T00:42:42.392Z",
    "durationMs": 22573,
  },

  "flakiness": {
    "verdict": "unknown",
    "attempts": 1,
    "passedAttempts": 0,
    "failedAttempts": 1,
  },

  "signals": {
    "consoleErrors": [{ "type": "error", "text": "TypeError: entities is not a function" }],
    "httpErrors": [{ "method": "GET", "url": "https://api.example.com/items", "status": 500 }],
    "dropped": 0,
  },

  "tags": ["demo", "smoke"],
}
```

## Rules a consumer can rely on

1. **Paths are relative to the project root** and use forward slashes. An
   artifact is portable between machines; an absolute path would not be.
2. **Every `evidence.*` field is optional.** A local run with `retries: 0` has
   no trace, and that is normal, not a defect in the artifact.
3. **Messages contain no terminal colour codes.** Playwright embeds ANSI
   escapes in `error.message`; they are stripped, because they make the
   artifact unreadable to both a person and a model.
4. **`context.baseUrl` is an origin only.** No path, no query string, no
   credentials. A base URL carrying a token must never be committed.
5. **Nothing secret is ever recorded.** No environment values, no credentials.
   The configuration loader rejects a `baseUrl` that contains any of those, so
   the mistake is caught at the source rather than at the sink.
6. **An unknown status fails closed.** A status the collector does not
   recognise becomes `failed`, never `passed`.
7. **`flakiness.verdict` may be `unknown`.** One attempt is not evidence of a
   pattern. Claiming `failing` from a single observation would be a guess
   dressed up as a verdict.
8. **`errorContextRef` may be absent** when `defects.referenceErrorContext` is
   false in configuration.
9. **`signals` is never invented.** It is written only when the fixture actually
   captured something. There is no empty-object placeholder, because "nothing was
   observed" and "nothing was found" are different facts.
10. **`context.baseUrl` is the configured base URL, which is not always the
    application the test ran against.** Pointing the suite at another host with
    `BASE_URL` does not change it: the collector reads `config/project.json`, and
    Playwright's JSON report does not serialise `use.baseURL`. See gap G1 below —
    this is the sharpest edge in the contract today.
11. **`httpErrors[].statusText` is frequently an empty string** and must not be
    branched on. Chromium does not expose a reason phrase for HTTP/2 or for a
    response that crossed a TLS-terminating proxy. `status` is the reliable field.
12. **A defect produced by an expected failure (`test.fail()`) carries no
    evidence.** The fixture attaches `quality-context` only when
    `testInfo.status !== testInfo.expectedStatus`, which is false for an expected
    failure, and the runner attaches no screenshot or video for one either. The
    artifact is written with `evidence: {}` and no `signals`, which reads exactly
    like a failure that produced no signals. See gap G12.

## Meeting an application we did not build

Everything above was, until now, checked against `fixtures/` — an application
this repository wrote, and whose suite it also controls. A contract verified only
by its own producer is not verified.

[`../tests/smoke/third-party/quotes-toscrape.smoke.spec.ts`](../tests/smoke/third-party/quotes-toscrape.smoke.spec.ts)
runs the contract against **quotes.toscrape.com**, Zyte's public scraping
sandbox: a real application with a real login form, a real 302 after a POST, real
repeated accessible names, a real HTML 404 page, and real assets loaded from
Google's font CDN. It needs no account, no API key and no code of ours.

```bash
QUALITYFORGE_THIRD_PARTY=1 npx playwright test tests/smoke/third-party
npm run defects:collect
```

It never runs by default: someone else's uptime is not a dependency of
`npm test`. Five tests assert the application's real behaviour and pass. Five
probes assert things the target does not do and **fail on purpose** — that is the
run's deliverable, and the run is expected to end red. Before each run the suite
probes the target over HTTP with a hard timeout and aborts with "the third-party
target is unreachable" rather than letting an outage arrive as a pile of locator
timeouts.

### What held up

Worth stating, because the list below is long enough to look like a verdict on
the whole contract. ANSI stripping worked on real Playwright messages — the raw
report carried `\x1b[2m` sequences and the artifacts did not. Redaction held:
no query strings, no cookies, no credentials, from a site that sets a session
cookie on login. All five `id` values satisfied the kebab-case pattern and the
120-character cap. `validateDefect()` accepted all five artifacts unchanged. And
the documented absent-versus-empty rule for `signals` behaved as written in two of
the five probes.

### Gaps

Each one states what could not be expressed, what it risks a consumer, and what
is proposed. "Schema" means a change to
[`../schemas/defect.v1.schema.json`](../schemas/defect.v1.schema.json), which is
the integrator's file; "producer" means `src/`.

#### G1 · `context.baseUrl` is not the application under test

_What could not be expressed:_ which application a defect belongs to. All five
artifacts from the third-party run record `"baseUrl": "http://127.0.0.1:4311"`
while the browser was on `https://quotes.toscrape.com`. The collector is handed
`config.baseUrl`; Playwright's JSON report does not serialise `use.baseURL`, so
the only place the effective value survives inside the report is
`config.webServer.url`, which exists because of the bundled fixture.

_Risk:_ a consumer that groups or suppresses defects by origin silently merges a
third party's failures with the fixture's, and two runs against different targets
produce artifacts claiming the same origin. Here the artifact also contradicts
its own `id`, which says `quotes-toscrape-smoke`.

_Proposed:_ producer — prefer the effective base URL over the configured one and
say which was used; schema — additive `context.targetSource`
(`config | environment | report`), minor bump.

#### G2 · Nothing records the page the failure happened on

_What could not be expressed:_ where the browser was. The "missing element"
probe's entire message is `waiting for getByRole('heading', { name:
'Documentation', level: 1 })`. `error-context.md` does not fill the gap either:
it carries the test name, the error and an aria snapshot, and **no URL**. So the
file this contract extends by reference cannot supply it either.

_Risk:_ on the fixture, origin plus test name reconstructs the page, because there
are three routes. On a real application with hundreds, a consumer cannot tell
which page failed and cannot reproduce it.

_Proposed:_ schema — additive `page: { url, title? }` recorded by the fixture,
which holds `page.url()` at failure time; minor bump. Redact the URL the way
signals are redacted. Note that the end state alone cannot recover a redirect
chain: the login probe was answered with a 302 and landed on a different page,
and nothing anywhere records that it moved.

#### G3 · An outage is indistinguishable from a defect

_What could not be expressed:_ "this failure is the target being unavailable".
With the target pointed at a dead port, the run produced **four** artifacts. All
four say `status: "failed"`, all four carry distinct ids ending in
`quotes-toscrape-smoke`, and all four carry the same message: `Third-party target
… is unreachable, so this suite did not run.`

_Risk:_ an agent working the defect list opens four tickets against the target's
codebase for one outage, and the quality gate reports it as a 40% failure rate.
The contract has a flakiness verdict and no notion of attribution at all.

_Proposed:_ two steps, and the first is cheaper and more correct. Producer — a
failure raised in `beforeAll` is not a defect and should not produce an artifact;
the collector needs to recognise a hook failure rather than a spec failure.
Schema — additive `failure.attribution` enum
(`application | environment | test | unknown`); minor bump.

#### G4 · `id` is not unique within a run, and collisions destroy artifacts

_What could not be expressed:_ two distinct failures as two distinct artifacts.
Two proven triggers:

- A title with no ASCII letters slugifies to nothing, so `id` collapses to the
  file name. Two tests in one file titled in Russian, Chinese or Greek produce the
  same `id`, and the second write **overwrites** the first.
- `id` is truncated at 120 characters. Two titles sharing a prefix past that point
  collide the same way.

Reproduced end to end: two specs, two reported failures, `defects` in the summary
listing the _same path twice_, and **one** artifact on disk — the second failure.
The first is gone, with no warning and no trace. `validateDefect()` passes it,
because each artifact is individually valid.

_Risk:_ silent loss of a defect, a summary that contradicts the directory it
describes, and history joined on `id` attributing one test's failure to another.

_Proposed:_ producer only, no schema change. Derive `id` from
`test.playwrightId` — already in the artifact, already unique per spec — or append
a short hash of it. And make the collector **fail closed** on a duplicate `id`,
throwing as it already does for an invalid artifact, instead of overwriting.

#### G5 · `signals` cannot tell the target's origin from a third party's

_What could not be expressed:_ whose problem a network signal is. The
blocked-CDN probe's artifact carries
`requestFailures[0].url = https://fonts.gstatic.com/s/raleway/v37/1Ptug….woff2`
and a console error naming the same request. Neither is marked as unrelated to
the application under test.

_Risk:_ an agent files "the application's font request failed" against the
application. In the other direction, a third party's noise consumes the 40-entry
per-category cap, `dropped` goes above zero, and the application's own error is
the one that gets dropped.

_Proposed:_ schema — a per-entry `sameOriginAsTarget` boolean, or a separate
`signals.thirdParty` group; minor bump. This one depends on G1: the flag needs a
trustworthy target origin to compare against.

#### G6 · One HTTP response is recorded twice, and the duplicate is the worse copy

_What could not be expressed:_ that these two entries are the same fact. A real
404 produces both `httpErrors[0] = { status: 404, statusText: "" }` and
`consoleErrors[0].text = "Failed to load resource: the server responded with a
status of 404 ()"` — Chromium's own message, with the empty reason phrase
interpolated into the sentence.

Its `location` is `{ url: <the document>, line: 0, column: 0 }`, which reads like
a source position in the application and is neither. For page-thrown console
errors the same field is the failing resource, so the field means two different
things depending on who wrote the message.

_Risk:_ a model counts two independent problems where there was one, and a human
reads `line: 0, column: 0` as a location.

_Proposed:_ documented now (rule 11 covers `statusText`; add the `location`
ambiguity here); producer follow-up — drop console entries whose text is
Chromium's "Failed to load resource", since `httpErrors` and `requestFailures`
already carry the fact with better structure.

#### G7 · `httpErrors[].statusText` is always empty in practice

Two of two populated entries on the third-party run were `""`. The field is
optional in the schema and reads as if it carries information.

_Proposed:_ documented as unreliable (rule 11). Deprecating it properly is a major
bump and should wait for a producer that can actually fill it.

#### G8 · The schema advertises three evidence pointers nothing writes

`evidence.snapshot`, `evidence.report` and `evidence.resultsDir` are declared in
[`../schemas/defect.v1.schema.json`](../schemas/defect.v1.schema.json) and in
`DefectEvidence`. The collector maps only `trace`, `screenshot` and `video`, and
the third-party run produced only the last two.

_Risk:_ a consumer wires up three pointers that are always absent and reads their
absence as a lost artifact.

_Proposed:_ integrator's decision — populate them or remove them. Removal is a
major bump. Until then they are documented as reserved rather than promised.

#### G9 · The environment a failure happened in is not recorded

_What could not be expressed:_ browser build, viewport, locale, timezone, colour
scheme, user agent. `test.project` is `"chromium"`; the report's project entry
carries a name and a retry count, and no version.

_Risk:_ against a third party, "only at 375 px", "only in Firefox" and "only
under `TZ=Asia/Tokyo`" are first-order triage questions, and the answers live in a
CI log rather than in the artifact.

_Proposed:_ schema — additive `context.environment`; minor bump. Locale and
timezone are worth more than the user agent and carry no secret.

#### G10 · The quality gate cannot separate the target's failures from the suite's

The third-party run reported `failure rate 50.0% exceeds maxFailureRate 5.0%
(5/10)`. Those five failures were deliberate probes, and the thresholds come from
a configuration authored for the bundled demo app.

_Risk:_ a gate tuned for the fixture misfires on a real application and vice
versa, so a red gate stops being actionable — which is the one thing a gate is
for.

_Proposed:_ per-target thresholds in configuration, plus `thresholdsSource` on the
run summary. The summary is a separate document from the per-defect artifact, so
this is additive and needs no `v1` bump — stated here rather than left implied.

#### G11 · The published schema forbids the extensibility the versioning rule promises

`additionalProperties: false` sits on the root object and on every nested object,
while the rule below states that consumers should ignore unknown fields and that a
minor bump must never break a reader. Both cannot hold: a consumer that validates
against the published schema rejects every minor bump, including the `signals`
block this repository shipped in `1.1.0`.

_Proposed:_ integrator's decision — relax forward compatibility, or change the
rule to say that a schema-validating consumer must allow unknown fields. **Not
executed here:** no conforming JSON Schema validator is available in this
environment and adding a dependency is out of scope, so this is a reading of the
schema and of JSON Schema 2020-12 rather than an observed failure.

#### G12 · `test.fail()` yields a defect with no evidence and no signals

Found by writing this suite the obvious way first. With `test.fail()`, the JSON
report records `status: "failed"` and exactly one attachment, `error-context`. The
fixture's guard, `testInfo.status !== testInfo.expectedStatus`, is false for an
expected failure, so `quality-context` is never attached — and the runner attaches
no screenshot or video for an expected failure either. The artifacts came out with
`evidence: {}` and no `signals`.

_Risk:_ rule 9 stops being true. "Nothing was observed" and "the runner considered
this failure expected" become indistinguishable, and a consumer will read the
second as the first. This suite's probes were rewritten to fail honestly for
exactly this reason.

_Proposed:_ producer — attach on `testInfo.status === "failed"` rather than on a
comparison with `expectedStatus`, so evidence follows the outcome. Documented as
rule 12 until then.

#### G13 · `commit` and `branch` are silently null in a git worktree

Every artifact from every run in a worktree records `commit: null, branch: null`,
while `git rev-parse HEAD` succeeds. `gitInfo()` reads `<root>/.git` expecting
either `ref: refs/heads/…` or a bare SHA; in a worktree that path is a _file_
containing `gitdir: /…/.git/worktrees/<name>`, which matches neither, so it
returns nothing rather than failing.

_Risk:_ history joined on commit degrades to no history without saying so, and two
artifacts from different commits look identical.

_Proposed:_ producer — follow `gitdir:` and read `HEAD` and its ref from there.

#### G14 · `error-context.md` is unbounded, and it is the file this contract points at

The fixture's pages snapshot to roughly ten lines. A real application's index
snapshots to 141 lines and a login page to 300. For scale, a single `ariaSnapshot`
of a mainstream encyclopedia's front page is 933 lines and 34 kB — and
`error-context.md` embeds exactly that. `signals` is capped at 40 entries per
category for the sake of a reader's context window, and the file the contract
delegates the page state to has no cap at all.

_Proposed:_ schema — additive `failure.errorContextBytes` so a consumer can decide
before reading; producer follow-up — cap the snapshot and record that it was
capped, the way `signals.dropped` already does.

## Versioning

`schemaVersion` is semantic. The file name carries `v1` to match.

- Adding an optional field: minor bump. That is how `signals` arrived in
  `1.1.0`, the file suffix staying `v1` and every `1.0.0` reader still working.
- Removing a field, renaming one, or changing a type or meaning: major bump,
  and the file suffix changes to `v2`.

Consumers should ignore unknown fields. A minor bump must never break a reader.

## Validation

Two layers, deliberately:

- `schemas/defect.v1.schema.json` is the published contract, for consumers and
  for editors. It uses JSON Schema 2020-12, matching what MCP 2026-07-28
  requires of `inputSchema` and `outputSchema`.
- `validateDefect()` in `src/defect/types.ts` is what the producer runs. It is
  hand-written to keep the project dependency-free and to produce messages a
  person can act on. The collector validates every artifact it is about to
  write, so an invalid artifact fails the run rather than landing on disk.

## Related

- [`architecture.md`](architecture.md) — where this fits in the flow
- [`../src/quality/redact.ts`](../src/quality/redact.ts) — what redaction guarantees
- [`selectors-and-testid.md`](selectors-and-testid.md)
- [`../AGENTS.md`](../AGENTS.md) — rules for agents working in this repo
