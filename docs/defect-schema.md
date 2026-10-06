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
| `context.targetSource`             | The origin alone is ambiguous — it does not say what it claims |
| `page.url`, `page.title`           | The file carries an aria snapshot and **no URL**               |
| `failure.attribution`              | The file shows the message, not where it was raised            |
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
**failed**, whatever anybody expected.

That last part is the rule that was wrong for a long time. The fixture used to
attach on `testInfo.status !== testInfo.expectedStatus`, and `test.fail()` — the
natural way to write a test asserting a bug exists — makes those two equal. The
evidence was deleted at exactly the moment someone wanted it, and the artifact
that resulted read exactly like a failure which produced no signals. It now
compares against the outcome. `timedOut` and `interrupted` count as failures too,
which is not a widening: their expected status is `passed`, so the old rule
already attached for them.

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
  nothing". Those are different claims and are not conflated. The same rule
  applies to `page`: a page block with no URL is dropped rather than recorded
  half-populated, because "the page was somewhere" states nothing actionable.
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

### Every signal carries the host it came from

`origin` on `consoleErrors`, `consoleWarnings`, `requestFailures` and `httpErrors` is
the URL `host` of the entry — which includes the port, so a failure on the
application's own port and one on a different port on the same machine are
separable.

It exists because a third party's failure and the application's own are otherwise
identical. Measured against a real site: one blocked Google font produced

```
page.url   https://quotes.toscrape.com/
consoleErrors    origin=fonts.gstatic.com      url=https://fonts.gstatic.com/s/raleway/...
requestFailures  origin=fonts.gstatic.com      url=https://fonts.gstatic.com/s/raleway/...
```

and in the same run a 404 produced `origin=quotes.toscrape.com`. Without `origin`
those two read as one undifferentiated pile of network noise.

**It is a fact, not a verdict.** Nothing here decides whether an origin is "ours";
that judgement is left to the reader, against `page.url` — which is ground truth in
a way `context.baseUrl` is not, for the reason described above. Encoding the
comparison in the collector would bake in a decision it is not positioned to make
correctly.

**`pageErrors` is never attributed.** Those entries are the error message as a
plain string, with no location, so there is no host to report. The field is absent
rather than guessed, and this paragraph is here so that absence does not read as
an oversight.

### Signals are not comparable across browsers

Measured on one broken third-party font, against `quotes.toscrape.com`:

| Signal                              | Chromium     | Firefox                   | WebKit        |
| ----------------------------------- | ------------ | ------------------------- | ------------- |
| console entries for the failure     | 1            | **4**                     | **0**         |
| `httpErrors[].statusText` for a 404 | `""`         | —                         | `"Not Found"` |
| `console.warn("x", {a: 1})`         | `"x {a: 1}"` | **`"x JSHandle@object"`** | `"x {a: 1}"`  |

Three separate consequences for anyone reading an artifact:

1. **Absence of a console entry is not evidence of absence of a failure.** Firefox
   logs nothing to the console for a failed subresource and reports it only in
   `requestFailures`; WebKit reported zero console entries for the same failure
   that Chromium reported once. The `requestFailures` and `httpErrors` categories
   are the cross-browser-safe ones, and a consumer should not conclude "no console
   error occurred" from a Firefox or WebKit artifact.
2. **Object arguments lose their content in Firefox.** `console.warn("x", {a: 1})`
   serialises to `"x JSHandle@object"`. The string survives; the data does not. A
   diagnostic that depends on an object argument is weaker on that leg, not
   absent.
3. **`statusText` is not portable.** Chromium exposes no reason phrase, so it is
   `""` there. Absence of `statusText` is a browser fact, not a missing capture.

The artifact records no browser version for the page's engine, so this cannot be
inferred from the file alone — `test.project` names the project, which is how you
tell which of these applies. The `context.environment` gap is tracked as G9.

## Which application, and which page

Two questions a triage agent asks first, which the artifact could not answer
before `1.2.0`.

**Which application was under test.** `context.baseUrl` is an origin, but the
configured origin is not necessarily the effective one: pointing the suite at
another host with `BASE_URL` does not change `config/project.json`. The producer
prefers the most trustworthy input available and records which one it used in
`context.targetSource`:

| `targetSource` | Input                              | When it wins                                                                          |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `environment`  | `BASE_URL`                         | whenever it is set and parses as absolute — it is the value the runner's config reads |
| `report`       | `webServer.url` in the JSON report | only when a project declares a `webServer`                                            |
| `config`       | `config/project.json`              | otherwise; correct exactly when nothing overrode it                                   |

`environment` is evidence, not proof, and this repository's own third-party suite
is the worked example of where it goes wrong. That spec navigates to absolute URLs
built from `QUALITYFORGE_THIRD_PARTY_URL`, not from `BASE_URL`, precisely so a
`BASE_URL` left pointing at the bundled fixture cannot redirect it. Run it with
`BASE_URL` still set to the fixture — which you must, or the fixture server is not
what `webServer` waits for — and the collector faithfully reports
`baseUrl: http://127.0.0.1:4311, targetSource: environment` for failures that
happened on `https://quotes.toscrape.com`. Every input it has is a lie in that
configuration, and the strongest one lies loudest.

Two things make that recoverable rather than silent:

- **`targetSource` says how much the answer is worth.** Read it, never `baseUrl`
  alone.
- **`page.url` is ground truth.** It is read from the browser, so it cannot be
  wrong about where the failure happened. Comparing its origin with
  `context.baseUrl` detects the disagreement, and that comparison is the check a
  consumer grouping by application should make.

`context.baseUrl` deliberately still means "the origin this run was pointed at",
which is a run-level claim, not a per-failure one. Reconciling it against
`page.url` per defect would be a different meaning for an existing field, and that
is a version decision rather than a bug fix. Until then the two fields disagreeing
is the signal, and it is a signal a consumer can act on.

**Which page failed.** `page.url` is the page the browser was on when the failure
happened, read at failure time and redacted the way signal URLs are.

```jsonc
"page": {
  "url": "https://quotes.toscrape.com/login",
  "title": "Quotes to Scrape: Login",
},
```

`page` and `signals` follow different rules and that is deliberate. `signals` is
absent unless something was observed; `page` is present whenever the test drove
a page, because a page with no console error and no failed request is still the
page the failure happened on. One rule for both would force one of them to be
wrong.

The end state alone cannot recover a redirect chain: a login that answers 302 and
lands somewhere else records only where it ended up, and nothing anywhere says it
moved.

## Shape

```jsonc
{
  "$schema": "https://qualityforge.dev/schemas/defect.v1.schema.json",
  "schemaVersion": "1.4.0",
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
    "targetSource": "config",
    "commit": "43c761f54c3571fab9fd9211539493d6210decea",
    "branch": "main",
    "ci": false,
    "retries": 0,
    "runStartedAt": "2026-10-03T00:42:42.392Z",
    "durationMs": 22573,
  },

  "page": {
    "url": "http://127.0.0.1:4311/contact",
    "title": "Contact form",
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
   false in configuration. When it is present, **`errorContextBytes` is too**,
   and it is the size of that file. Read it before opening it: about 3 KB against
   this project's fixture, and 34 KB — 933 lines — for an ariaSnapshot of a
   mainstream front page. The artifact points at the file rather than embedding
   it, which is correct, but it means the size has to travel with the reference or
   a reader pulls an unknown quantity of text into a context window.
9. **`signals` is never invented.** It is written only when the fixture actually
   captured something. There is no empty-object placeholder, because "nothing was
   observed" and "nothing was found" are different facts.
10. **`context.baseUrl` is the origin the run was pointed at, and
    `context.targetSource` says how much that is worth.** Read the pair, never
    `baseUrl` alone. `environment` is the value the runner's config reads and is
    the strongest evidence available, but a suite that navigates to absolute URLs
    of its own can contradict it — and then `page.url` disagrees with
    `context.baseUrl`, which is the signal to notice. `config` is only a fallback.
    A consumer grouping defects by origin must decide which of these it holds
    before it trusts the grouping. See "Which application, and which page" above.
11. **`httpErrors[].statusText` is frequently an empty string** and must not be
    branched on. Chromium does not expose a reason phrase for HTTP/2 or for a
    response that crossed a TLS-terminating proxy. `status` is the reliable field.
12. **`context.commit` is `null` in two different situations, and only one of them
    is quiet.** A checkout with no git at all records `commit: null, branch: null`
    and prints nothing. A checkout whose git directory exists but could not be
    read — an unfollowed `gitdir:` pointer, a missing ref — records the same
    values _and_ makes the collector warn on stderr. Treat a null commit from a
    git-backed run as a problem to investigate, not as an absence.
13. **An expected failure (`test.fail()`) is recorded like any other failure.**
    `status` stays `failed` and the context is attached, because the fixture
    decides on the outcome and not on a comparison with `expectedStatus`. The
    artifact does **not** say the failure was expected — nothing in the schema
    distinguishes it — so an expected failure and a real regression with the same
    title produce indistinguishable artifacts. That is a known limit, not a
    promise; see gap G12.
14. **One run directory holds one artifact per failure, or the collector failed.**
    Two failures whose ids collide stop the collection rather than sharing a
    filename, so a run directory never contains a summary listing a path twice
    while only one copy of it exists. A summary whose `defects` array repeats a
    path was written by a version that predates this guarantee.
15. **A spec whose failure was raised outside its own test body may produce no
    artifact at all.** One failure cannot be the body of four tests, so when every
    failed spec in a file reports the same message at the same source location, the
    suite aborted rather than failed. Those specs produce no artifact, and the run
    summary counts them under `counts.aborted` instead of listing them as defects —
    `counts.failed` excludes them. **The quality gate still fails**, with a violation
    naming the file and the raise site, because suppressing four tickets must not turn
    a broken build green. An artifact listing `counts.aborted: 0` predates this rule,
    as does one whose gate passed while the target was unreachable.
16. **`failure.attribution` says where the error was raised, not whose fault it is.**
    `suite` means the raise site is provably outside that spec's body — a different
    file, or a line above the spec's own declaration. `unknown` means the runner
    reported no location. Absent, which is the ordinary case, means the raise site
    was at or after the declaration in its own file and carries no information; it is
    _not_ a claim that the body raised it. The vocabulary deliberately stops there:
    `application` and `environment` would require judgement no producer can make, and
    a value nobody can justify is worse than no value. See gap G3.

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

#### G1 · ~~`context.baseUrl` is not the application under test~~ — fixed

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

_Fixed in `src/defect/collect.ts`, `src/defect/types.ts` and the schema._ The
producer resolves the target from three inputs, most trustworthy first — `BASE_URL` from
the environment, `webServer.url` from the report, the configured value — and
records which one it used in the additive `context.targetSource`. A `BASE_URL`
that does not parse as an absolute URL is skipped rather than recorded, so a
configuration mistake never becomes an origin claim.

The source is recorded because the strongest input is evidence rather than proof:
a project whose Playwright config derives its base URL some other way would report
`environment` incorrectly. A consumer grouping by origin can therefore weigh the
claim, which is strictly more than the previous behaviour allowed.

#### G2 · ~~Nothing records the page the failure happened on~~ — fixed

_What could not be expressed:_ where the browser was. The "missing element"
probe's entire message is `waiting for getByRole('heading', { name:
'Documentation', level: 1 })`. `error-context.md` does not fill the gap either:
it carries the test name, the error and an aria snapshot, and **no URL**. So the
file this contract extends by reference cannot supply it either.

_Risk:_ on the fixture, origin plus test name reconstructs the page, because there
are three routes. On a real application with hundreds, a consumer cannot tell
which page failed and cannot reproduce it.

_Fixed in `src/fixtures/quality-context.ts` and `src/defect/page-context.ts`._ The
fixture reads `page.url()` and `page.title()` at failure time, before teardown can
navigate away, and attaches them in the same `quality-context` payload. The URL is
redacted at capture, not at write time — by the time the collector sees it the
secret has already touched a file, and a page reached through a reset link is
exactly that case. `page` is additive and optional; a page block with no URL is
dropped rather than recorded half-populated.

The end state alone still cannot recover a redirect chain: the login probe was
answered with a 302 and landed on a different page, and nothing anywhere records
that it moved.

#### G3 · ~~An outage is indistinguishable from a defect~~ — fixed

_What could not be expressed:_ "this failure is the target being unavailable".
With the target pointed at a dead port, the run produced **four** artifacts. All
four say `status: "failed"`, all four carry distinct ids ending in
`quotes-toscrape-smoke`, and all four carry the same message: `Third-party target
… is unreachable, so this suite did not run.`

_Risk:_ an agent working the defect list opens four tickets against the target's
codebase for one outage, and the quality gate reports it as a 40% failure rate.
The contract has a flakiness verdict and no notion of attribution at all.

_The obstacle, found while fixing it:_ Playwright 1.63.0's JSON reporter
serialises `result.error` straight through, and `TestError` carries **no** `stage`
field — there is no `before-all-hook` marker anywhere in the report to key off.
Verified by reading the reporter source and by running a real `beforeAll` failure
end to end. In the report, a hook failure and a spec failure are structurally
identical, so the collector cannot simply look for one.

_Fixed on the evidence that does exist._ When every failed spec in a file reports
the same error at the same source location, the failure was raised once, outside
the test bodies: one `throw` cannot be the body of four tests. Those specs produce
no artifact, are counted under `aborted` in the run summary, and raise a gate
violation naming the file and the error — so the build still goes red, and red
for the right reason, without four tickets. Rule 15 states it for consumers.

_The residual case_ — a single spec failing on an error raised outside its own
body — cannot be identified as such, because the evidence that settles four specs
settles none when there is only one. That is the case additive
`failure.attribution` exists for: the artifact is kept, flagged `suite` when the
raise site is provably above the spec's own declaration or in another file, and
recorded `unknown` when the runner gave no location at all. See rule 16.

_Departure from this gap's own proposal, deliberately._ G3 originally suggested an
`application | environment | test | unknown` enum. The first two cannot be written
without judgement the collector does not have — nothing in a Playwright report says
whether a failure is the application's fault or the network's — and a field whose
values are guesses is worse than a field that only says what it can prove. The
vocabulary was cut to `suite | unknown`, and the distinction between "raised in the
suite" and "raised in the test" was kept by making absence meaningful rather than by
inventing a value for it.

#### G4 · ~~`id` is not unique within a run, and collisions destroy artifacts~~ — fixed

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

_Fixed in `src/defect/collect.ts`._ The collector keeps an in-memory map of the
ids it has already written for the run and **refuses the second write**, throwing
with both colliding tests named — file, line, title and `playwrightId` — so the
reader does not have to work out which two collided. Nothing already on disk is
touched, and no run summary is written, because a summary is a claim that the run
was collected in full and this one was not.

A third path turned up while fixing this and is covered by the same guard: an id
that slugifies to `quality-summary` produces the filename the run summary is
written to, thirty lines later, with no warning. That filename is now reserved.

_The derivation was deliberately left alone._ `id` is a published value and
changing how it is computed changes every artifact ever written, which is a
contract change rather than a bug fix. The collision is now a hard, explained
failure instead of a silent loss; deciding what an id should be is a separate
question and belongs with a version bump.

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

_Observed on the second object (GitHub, 2026-10-06), both halves._ The avatars
probe stubs `avatars.githubusercontent.com`; the artifact carries
`requestFailures: 40` and `consoleErrors: 40` — the per-category cap, twice —
and `dropped: 43` as one number with no bucket and no host attached, which is
G5's risk sentence having come true: a consumer cannot tell whether the
application's own errors were among the casualties. And `sameOriginAsTarget`
would have answered **"third party"** about the flood: GitHub's image CDN lives
on `githubusercontent.com` and its scripts on `githubassets.com` — first-party
assets, foreign eTLD+1s — while the same artifacts correctly attribute the
target's own `404` to `origin: github.com`. The vocabulary works; what is
missing is the comparison, and the provenance of what was dropped.

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

#### G12 · ~~`test.fail()` yields a defect with no evidence and no signals~~ — fixed

Found by writing this suite the obvious way first. With `test.fail()`, the JSON
report records `status: "failed"` and exactly one attachment, `error-context`. The
fixture's guard, `testInfo.status !== testInfo.expectedStatus`, is false for an
expected failure, so `quality-context` was never attached — and the runner attaches
no screenshot or video for an expected failure either. The artifacts came out with
`evidence: {}` and no `signals`.

_Risk:_ rule 9 stopped being true. "Nothing was observed" and "the runner
considered this failure expected" became indistinguishable, and a consumer would
read the second as the first. This suite's probes were rewritten to fail honestly
for exactly this reason.

_Fixed in `src/defect/page-context.ts`._ The guard moved out of the fixture and now
compares against the outcome. Proven against a real `test.fail()` spec rather than
only in a unit test: the report's attachments went from `["error-context"]` to
`["error-context", "quality-context"]`, and the collected artifact went from
`evidence: {}` with no `signals` to carrying the 404 the test actually saw.

`timedOut` and `interrupted` are in the failure set deliberately. The old rule
already attached for them — their expected status is `passed` — so narrowing to
`status === "failed"` would have fixed the reported case while quietly
reintroducing the same bug for a timeout, whose page state is worth more than a
passing test's.

_Still open, and deliberately not here:_ the artifact records `status: "failed"`
for an expected failure and nothing says the failure was expected. Recording that
needs either a new value in `status` or a new flag, and both change what an
existing field means to a consumer. That is a decision for a version bump, not a
bug fix, so the third-party probes stay honestly red rather than reaching for
`test.fail()`.

#### G13 · ~~`commit` and `branch` are silently null in a git worktree~~ — fixed

Every artifact from every run in a worktree recorded `commit: null, branch: null`,
while `git rev-parse HEAD` succeeded. `gitInfo()` read `<root>/.git` expecting
either `ref: refs/heads/…` or a bare SHA; in a worktree that path is a _file_
containing `gitdir: /…/.git/worktrees/<name>`, which matches neither, so it
returns nothing rather than failing.

_Fixed in `src/defect/git-info.ts`._ The `gitdir:` pointer is followed, a
relative one is resolved against the directory holding the pointer file, and
`commondir` is honoured — a linked worktree keeps its own `HEAD` but shares the
ref store with the main repository, so the branch ref is in the common
directory. The loader now also separates the two reasons for a null commit:
**absent** `problem` means there is no git here (a tarball export, which is
legitimate and silent), while a set `problem` means git is here and could not be
read. The collector prints the second to stderr, so `--json` output stays pure
JSON and a lost VCS context cannot pass unnoticed again.

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

### The second object · GitHub

One application proves only that one application. The owner's decision of
2026-10-06 named the second object — **GitHub** — and
[`../tests/smoke/third-party/github.smoke.spec.ts`](../tests/smoke/third-party/github.smoke.spec.ts)
runs the same method against an application built the modern way: Turbo
navigation without document loads, first-party assets on three registrable
domains, content below the fold that is never fetched, and twenty-five rows
sharing one accessible name where quotes.toscrape had ten.

The three rules carry over unchanged: it never runs by default, an unreachable
target — or one that answers 200 without the signed-out header — aborts the
suite for that reason, and the probes fail on purpose with `test.fail()` still
banned. The run additionally takes `--workers=1`: one reachability probe
against somebody else's server instead of one per worker, and no contention
between our own workers for the target's attention.

```bash
QUALITYFORGE_THIRD_PARTY=1 npx playwright test \
  tests/smoke/third-party/github.smoke.spec.ts --project=chromium --workers=1
npm run defects:collect
```

The run of 2026-10-06 (chromium, one worker): four tests establishing what the
application does passed; the four probes each failed on the assertion their
question is written around; `defects:collect` wrote four artifacts and failed
the gate at 50% against the 5% cap; `defects:check` passed over the result
afterwards. Both reverse paths were run too: an unreachable override
(`http://127.0.0.1:9`) aborted with "unreachable … so this suite did not run",
and a reachable-but-wrong override (the bundled fixture) was refused with
"answered 200 but is not serving the application".

#### What held up on the second object

- **`page.url` after a navigation with no load event.** The failure happened on
  `https://github.com/ninelegsdog/qualityforge/issues` while the test started
  at `.../qualityforge`, and no document load ever fired; the artifact names
  the destination, and the `error-context.md` snapshot beside it shows the
  issue list.
- **`context.targetSource: "observed"`.** The configured candidate was the
  bundled fixture, the browser was on `github.com`, and the artifact says so
  rather than claiming an origin it knew to be wrong — the 1.3.0
  reconciliation, unattended.
- **Origins on every signal.** Console, HTTP and request entries name
  `github.com`, `github.githubassets.com` and `avatars.githubusercontent.com`
  separately, which is what makes the questions below answerable at all.
- **Evidence on every genuine failure.** Screenshot and video on all four
  probes — the `test.fail()` lesson, observed a second time on a second
  application.
- **The contract's own rules held:** `validateDefect()` accepted all four
  artifacts unchanged, the gate failed on the rate alone, and
  `failure.attribution` stayed absent on body failures exactly as the
  absent-means-body rule says.
- **G6 and G7 reproduced on the target's own bug:** GitHub's signed-out pages
  fetch `_global-navigation/payloads.json` and get a real `404` — recorded
  once as `httpErrors` and again as Chromium's console sentence, with
  `statusText: ""` and `location: { line: 0, column: 0 }`, from
  `github.com`.

#### G15 · `page.title` and `page.url` name different pages after a client-side navigation

_What could not be expressed:_ that the two fields disagree, and which one a
consumer should stand behind. The navigation probe's artifact carries
`page.url: "https://github.com/ninelegsdog/qualityforge/issues"` and
`page.title: "GitHub - ninelegsdog/qualityforge: Evidence-first browser quality
automation …"`. A full load of that URL serves `Issues · ninelegsdog/qualityforge
· GitHub` — checked separately — because the frame navigation rewrote the URL
and left `document.title` on the page the run came from. Both fields were read
at failure time, each is faithful to its source, and nothing in the artifact
says they describe different pages.

_Risk:_ a consumer that identifies the page by title — a listing, a dedupe key,
a summary line — files client-side navigation failures under the previous page.
A consumer that notices the disagreement cannot tell which field the run stands
behind, because the contract does not say.

_Owner's decision pending_ (raised with the E2 report, 2026-10-06): a
documented limitation — both fields are read at failure time and can disagree
after a client-side navigation; `page.url` is the browser's location — or a
schema change, with the major bump that rule 7 requires for a meaning change.

#### G16 · `dropped` counts a flood without saying who flooded it

_What could not be expressed:_ where the dropped entries came from — and, on
this target, whose they were. The avatars probe (stubbing the application's
own `avatars.githubusercontent.com`) produced `requestFailures: 40` and
`consoleErrors: 40`, both at the per-category cap, with `dropped: 43` recorded
as a single number across categories. One host consumed both caps, and the
artifact cannot say whether the application's own errors were among the
casualties — G5's risk, observed rather than argued.

_Risk:_ a consumer reads `dropped: 43` as housekeeping — bounded capture doing
its job — when it may be the line saying the real error was evicted. The
naive fix proposed under G5 would make it worse: the flood came from the
application's own CDN, on another registrable domain.

_Owner's decision pending:_ per-category drop counts (additive, minor bump) or
a documented limitation — capture stays bounded and `dropped` stays a total.

#### G17 · A resource the page never requested produces nothing at all

_What could not be expressed:_ that the element in the failed assertion was
never fetched. The lazy-content probe waits on a screenshot caption below the
fold: `loading="lazy"` means the browser sends no request, `complete` stays
`false`, the assertion fails — and **nothing in the signals is about that
image**, because nothing failed. The one `requestFailure` in that artifact is
an unrelated abort of the page's hero video
(`github.githubassets.com/assets/code-1_desktop-….mp4`, `net::ERR_ABORTED`) —
a true fact about the page, sitting next to the failure and looking like an
explanation.

_Risk:_ the consumer's real question — "did it break, or did it never
happen?" — gets one available answer (break), and the false lead beside it
makes that answer the attractive one.

_Owner's decision pending:_ the only honest option is a documented limitation —
absence is not a signal, and the contract records what happened, not what did
not — recorded here for confirmation alongside G15 and G16.

#### What the second object did not bring

The hypothesis list drawn up before the run also named iframes (in discussions
and embeds) and shadow DOM. Six signed-out public pages were checked for
iframes — front page, repository, issue list, login, `/about`,
`/features/copilot` — and their raw HTML contains **zero**; GitHub's content
sanitizer keeps them out of markdown, and the public surface carries none. That
is a negative result, not a resolution: the shape remains untested against the
contract, and a target that actually has one — a challenge widget, an embed
player — is what would settle it. Shadow DOM did not appear either. From the
same list, what did materialize: client-side navigation (G15), never-requested
lazy content (G17), duplicate accessible names at scale (twenty-five `Open`
icons where quotes.toscrape had ten `(about)` links — generalized), and
multi-host first-party assets (G16).

## Versioning

`schemaVersion` is semantic. The file name carries `v1` to match.

- Adding an optional field, or a new member of an existing enum: minor bump.
  That is how `signals` arrived in `1.1.0`, the file suffix staying `v1` and every
  `1.0.0` reader still working; how `page` and `context.targetSource` arrived in
  `1.2.0`; how `targetSource: "observed"` and `attribution: "hook"` arrived in
  `1.3.0`; and how the run summary gained `flakiness` in `1.4.0`.
- Removing a field, renaming one, or changing a type or meaning: major bump,
  and the file suffix changes to `v2`.

### 1.4.0 — the run summary carries what history says

One change, additive, and it lands in the run summary rather than in the per-defect
artifact: **`summary.flakiness`**.

The per-defect `flakiness` verdict is computed from a single run's retries and dies
with its artifact, so a reader holding only `quality-summary.v1.json` — the file
`--json` prints and the file the MCP surface serves — could see that five specs
failed and not whether they failed the way flakes fail. That distinction is the
question this repository exists to answer, so it now travels with the run:

```jsonc
"flakiness": {
  "window": 6,            // earlier runs consulted; this run is never among them
  "verdict": "flaky",     // the strongest claim the run's failures support
  "counts": { "flaky": 3, "failing": 1, "regression": 0, "new": 1 },
  "direction": "worsening",
  "partial": true          // only when some run's composition was unreadable
}
```

- `window` is written rather than implied. Zero means no history was configured or
  readable, and then `verdict` is `unknown` — not an empty object and not a guess,
  because a summary is a claim.
- `counts` buckets every spec this run failed by what the window recorded for it:
  `flaky` (failed in some runs, passed in others), `failing` (never passed),
  `regression` (present in the window and never failed, so this break is new) and
  `new` (no record at all). `regression` needs positive evidence of presence; it is
  never inferred from silence.
- `verdict` is the strongest of those buckets, ordered as a reader would triage
  them, with `none` for a run that failed nothing.
- `direction` is `trendReport`'s own number — the same function `quality_get_trend`
  answers with — so a summary and the tool cannot disagree about which way the suite
  is moving.

The block is not confined to the file: `quality_get_latest_run` passes it through in
`structuredContent`, so a client that starts there reads the window verdict without
a second call. That pass-through is asserted in `mcp:check:tools`, where the seeded
run is collected with `--no-history` and fails on purpose — which is why the wire
carries `window: 0` and `verdict: "unknown"` there, and why a producer that guessed
instead of admitting it had no history would go red.

Nothing in `1.4.0` was removed, renamed, retyped or given a new sense. `schemaVersion`
moved from `1.3.0` to `1.4.0` and the summary gained one key, which is why this is a
minor bump; the per-defect artifact is unchanged apart from the number it reports.

### 1.3.0 — the configured target is reconciled against the page

Two changes, both additive, both answering a defect this repository found in itself
by running against an application it did not build.

**`context.targetSource: "observed"`.** The three existing sources all record what
someone _meant_ the target to be. In a third-party run they were wrong in the same
way: the report named the bundled fixture's origin while the browser was on the real
target, so grouping defects by origin merged two applications' failures under one
wrong value.

`page.url` is the only input that is not a declaration of intent, so when a failing
test drove a page and that page disagrees with the configured answer, the artifact
records the observation and marks it `observed`. Compared against the candidate that
would have won the precedence anyway — a lower-priority candidate that disagrees is
irrelevant when a higher-priority one agrees, because nothing is being corrected in
that case.

**A run whose inputs agree is byte-identical to what `1.2.0` produced.** Ordinary
artifacts do not change and `targetSource` keeps its configured name. Only the
disagreement case is new, and that is the case that was wrong.

The run summary keeps the configured answer, because a summary has no page: it
describes what was configured, not where the browser went. Per-defect context is
where the observation lands. A consumer that wants to know whether the two ever
disagreed should compare `summary.baseUrl` with a defect's `context.baseUrl`.

**`failure.attribution: "hook"`.** The vocabulary was `suite | unknown`, and `suite`
was doing two jobs. A `beforeAll` that throws and a failure inside a shared helper
module are both "not this test's body", but they send a reader somewhere completely
different: one to a line in their own file above the test, the other to a file they
may not own. So the above-the-declaration case in the spec's own file is now `hook`,
and `suite` means "a different file". `unknown` is unchanged.

The split is a boundary about **files**, not about line numbers, and it is measured:
a `beforeAll` throw reports the hook's line, above the declaration of the spec marked
failed. A helper at line 3 of another module stays `suite` even though 3 is lower
than most test declarations, because a line in another file is not "above this spec"
in any meaningful sense.

Nothing in `1.3.0` was removed, renamed, retyped or given a new sense. Both are new
members of existing enums, which is why this is a minor bump: the only thing that
would notice is a consumer validating against the old enum, and it should ignore
unknown members the same way it ignores unknown fields.

### What 1.2.0 did

Nothing in `1.2.0` was removed, renamed, retyped or given a new sense:
`context.baseUrl` still means "an origin", `context.targetSource` says how much
that origin is worth, and `page` is a new key beside them. The only field whose
_content_ changed is `context.baseUrl`'s value in a third-party run — from the
configured origin to the effective one. The meaning of the field is unchanged and
the new `targetSource` says which of the two inputs was used, so a consumer that
wants the old answer can still get it: read `config/project.json`. That is a
change in behaviour, not in contract, and it is called out in the changelog
because it is the one thing here that would surprise a returning reader.

The run summary is a separate document from the per-defect artifact, so adding a
field to it needs no `v1` bump at all.

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
