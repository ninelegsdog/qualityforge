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
changes. Published at <https://github.com/ninelegsdog/qualityforge>, green on CI.

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

`.nvmrc` pins **22** for contributors. That is not cosmetic: `tsc` dies with a
segmentation fault under one Node 24.21.0 build, on this machine, reproducibly —
4 runs in 8 failed on 24 and 0 in 30 on 22. If you use a version manager, run
`nvm use` before anything else.

**Platforms.** Linux is what CI runs and therefore what is verified. The core is
written to be platform-neutral — `path.sep` and `path.relative` throughout, no
POSIX-only calls, and the fixture server uses `node:path` — so Windows and macOS
should work, and _have not been tested_. Treat them as unverified rather than
supported. The maintainer checks under `scripts/*.py` need Python 3 and are not
part of the shipped path; nothing a consumer runs requires them.

**Node 20 is untested, not supported.** The `engines` floor stays permissive on
purpose so an install is not blocked, but CI runs 22 and 24 only. Nothing has ever
been executed against 20 here, so the permissive floor is a statement about install
politeness, not about behaviour.

```bash
git clone https://github.com/ninelegsdog/qualityforge.git
cd qualityforge
npm ci
npx playwright install --with-deps chromium
npm test
```

`npm test` starts the bundled demo app automatically, so a fresh clone runs green
with no configuration and no third-party network dependency.

Open the HTML report:

```bash
npm run report
```

Expect **about ten seconds of silence** before it prints
`Serving HTML report at http://localhost:9323`. It is starting a local server, not
hanging. It then stays in the foreground until you press Ctrl+C.

There is deliberately no wrapper that prints the address sooner. Printing early
would be a lie if the server then failed to start — you would be handed a URL that
does not serve, which is a worse failure to debug than silence.

For a step-by-step path — seeing a real failure with evidence, collecting defect
artifacts, connecting an agent, pointing it at your own application — see
[`docs/quick-start.md`](docs/quick-start.md), or
[`docs/quick-start.ru.md`](docs/quick-start.ru.md).

## The bundled demo app

`fixtures/` is a small multi-page app that exists so the suite has something real
to test. It is not a mock: it renders, validates and fetches.

| Route        | What it does                                                                            |
| ------------ | --------------------------------------------------------------------------------------- |
| `/`          | Overview with a heading, a status readout, and an entity list fetched from `/api/items` |
| `/docs`      | Documentation page with the evidence policy                                             |
| `/contact`   | Form with client-side validation and accessible error reporting                         |
| `/api/items` | JSON payload backing the entity list                                                    |
| `/boom`      | Deliberately returns 500, for exercising the evidence pipeline                          |

Every control is labelled, every message has a role, and every element the tests
need has a stable handle — so the suite asserts on what a user perceives, not on
markup structure.

## Verifying the evidence pipeline

The project's core promise is that a failure leaves enough evidence to diagnose
it. That claim is testable, so it is tested:

```bash
QUALITYFORGE_EVIDENCE_CHECK=1 npx playwright test tests/smoke/evidence-pipeline.spec.ts
```

This runs two deliberately failing tests and exits non-zero. Afterwards
`test-results/` contains, per failure:

| Artifact            | Produced because                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `test-failed-1.png` | `screenshot: "only-on-failure"`                                                              |
| `video.webm`        | `video: "retain-on-failure"`                                                                 |
| `trace.zip`         | `trace: "on-first-retry"` — add `--trace on` locally, since there is no retry on a local run |
| `error-context.md`  | Structured failure summary: test name, location, error, expected, received                   |

`error-context.md` is the most interesting one for this project: it is already
written as an instruction to an assistant — "explain why, be concise, respect
best practices" — followed by the test name, file location, error and diff of
expectations. It is the raw material an agent needs, and it is free.

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

## Defect artifacts

A failing test is only useful if the failure can be read later without
re-running anything. QualityForge turns each failure into one normalized,
versioned artifact:

```bash
npm test                    # writes artifacts/json/playwright-results.json
npm run defects:collect     # writes artifacts/defects/<runId>/
```

```jsonc
{
  "id": "form-validation-smoke-shows-an-error-when-email-is-empty",
  "status": "failed",
  "test": { "file": "tests/smoke/form-validation.smoke.spec.ts", "line": 15 },
  "failure": {
    "message": "Error: expect(locator).toHaveText(expected) failed\n\nExpected: \"Email is required\"",
    "errorContextRef": "test-results/.../error-context.md",
  },
  "evidence": { "screenshot": "test-results/.../test-failed-1.png" },
  "context": { "commit": "43c761f", "baseUrl": "http://127.0.0.1:4311" },
  "flakiness": { "verdict": "unknown", "attempts": 1 },
}
```

The artifact deliberately **extends** Playwright's `error-context.md` rather
than duplicating it: it records a path to that file and adds stable identity,
run correlation, VCS context, evidence pointers and a flakiness verdict. See
[`docs/defect-schema.md`](docs/defect-schema.md).

It also carries a `signals` block — console errors, uncaught page errors, failed
requests and HTTP errors above 400 — because "element not found" is a symptom
while "the page threw a TypeError" is the cause. The Playwright JSON reporter
carries none of this, so it is collected live by the bundled fixture:

```ts
import { test, expect } from "../fixtures.js"; // not "@playwright/test"
```

In this repository the path is relative to your test file. A project that
installs the package instead of cloning it imports the same fixture from the
build, because Playwright refuses to transpile TypeScript under `node_modules`:

```ts
import { expect, test } from "qualityforge/dist/fixtures/quality-context.js";
```

The package is not on npm yet; install it from GitHub with
`npm i github:ninelegsdog/qualityforge`. That deep path is what exists today,
not what the package will keep: an `exports` map with a stable subpath is
packaging work that is still open, see [`docs/roadmap.md`](docs/roadmap.md).

That one import change is the whole integration. Everything captured is redacted
at the source: URLs keep scheme, host and path with query strings and
credentials removed, console text has tokens and JWTs replaced, and sensitive
header values are masked while their names are kept.

Capture is bounded at 40 entries per category, and `signals.dropped` records how
many were cut, so a truncated capture never looks complete.

`npm run defects:collect` doubles as a CI quality gate. It exits `0` when the
gate passes, `1` when thresholds are violated, and `2` when collection could
not run at all.

## The MCP server

`npm run mcp` starts a read-only MCP server over stdio, speaking protocol
2026-07-28. It hands an agent the evidence layer: what failed, where, and what
the page was doing while it failed.

Verified against **OpenCode v2.0.16** on Linux, by copying the block below into
an `opencode.json` and connecting. Kilo and MiMo were **not** tested — see the
end of this section.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "qualityforge": {
      "enabled": true,
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/qualityforge/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/qualityforge/src/mcp/index.ts",
      ],
    },
  },
}
```

`opencode mcp list` then reports the connection status:

```
✓ qualityforge  connected
```

Re-run it before you believe it. In a directory OpenCode had not seen before,
v2.0.16 printed `No MCP servers configured` on the first invocation and often the
second, then `○ qualityforge  pending`, and only then the status above — with a
config file that was present, valid and unchanged throughout. That first line is
not evidence that your block is wrong, and one `connected` is not evidence that
it is right: four consecutive invocations of the same command against the same
unchanged file printed `connected`, `pending`, `pending`, `pending`. Read the
line as a sample of a connection still being formed, not as a verdict.

Add `--root <dir>` to serve artifacts from somewhere other than
`artifacts/defects`, and `--history <dir>` to serve run history from somewhere
other than `quality-history`.

Four things about that block, each checked against a real client rather than
assumed:

- **Produce the artifacts before you connect.** This is the one that bites. The
  server exits `1` when it cannot find an artifacts root, and the message saying
  so goes to stderr, which the client discards — so all you see is
  `failed: Connection closed`. Run the suite and `npm run defects:collect` first,
  or pass `--root <dir>`.
- **Use absolute paths.** A client spawns the server from _your_ project
  directory, not from this checkout, so a relative root resolves somewhere that
  does not exist. When that happens the server falls back to this checkout and
  says so on stderr — but only if this checkout has artifacts to serve, which is
  the previous point.
- **Spell the runner out.** `["npx", "tsx", ...]` works, and it is the shorter
  thing to type, but it took ~3.6 s to answer `initialize` here against ~0.9 s
  for the `node` form above, and OpenCode's documented default MCP timeout is
  5000 ms. That is a thin margin on a slower machine, so if `npx` ever fails to
  connect, swap in the spelled-out command before debugging anything else.
- **Both `mcp.<name>` and `mcp.servers.<name>` connect.** The flat form shown
  above is what the JSON schema at `https://opencode.ai/config.json` describes —
  and that schema describes V1, so it is the wrong thing to check a V2 file
  against. The V2 documentation documents `mcp.servers.<name>`, and
  `opencode mcp add` writes that one, so a file you did not write will not match
  the block above. v2.0.16 accepts both: the flat block connected here, and the
  same block wrapped in `"servers"` connected too. The difference is which file
  wrote it, not whether it works — assume nothing about a form you did not test,
  including this one.

**Kilo and MiMo are not supported, by decision.** An earlier version of this
README claimed one block covered all three clients; only OpenCode was ever
connected, so that claim was not evidence of anything. They are now explicitly
out of scope rather than quietly untested: the owner decided on 2026-10-03 not
to pursue them, because the server-side work a third client would require is
better spent on the one client that is real. If you use Kilo or MiMo, this block
says nothing about whether they accept it — and it should not be assumed to.

| Tool                     | What it answers                                                       |
| ------------------------ | --------------------------------------------------------------------- |
| `quality_get_latest_run` | Pass and fail counts, duration, whether the quality gate passed       |
| `quality_list_failures`  | Compact records: id, status, test location, flakiness                 |
| `quality_get_defect`     | One defect in full, including console, network and page-error signals |
| `quality_flaky_tests`    | Which specs failed across runs: flaky, failing, new, or gone          |
| `quality_get_trend`      | Pass rate per run, direction, duration, distinct failing specs        |

Plus resources for the latest run summary and any defect, and a
`triage_failure` prompt that asks for facts before hypotheses.

Read-only is structural, not a promise: there is no write path in the server,
and the store exposes no mutating method.

### Why the protocol is hand-written

The official `@modelcontextprotocol/sdk` was checked rather than assumed.
Version 1.32.0, published 2026-10-02, declares
`LATEST_PROTOCOL_VERSION = "2025-11-25"` and contains no `server/discover`, no
`resultType`, no `ttlMs`/`cacheScope` and no `subscriptions/listen`. It does not
implement 2026-07-28, so the surface is implemented here. That also keeps the
project dependency-free.

The 2025-11-25 handshake is still accepted, because a client that never sends
`initialize` must still get `tools/list`.

### Path confinement

Every client-supplied path is treated as hostile, because client-side path
allowlists are a convenience rather than a boundary. Absolute paths, `..`
traversal before and after percent-decoding, NUL bytes and symlinks resolving
outside the root are all rejected — and the rejection message never echoes the
filesystem layout, since it can end up in a transcript.

## Configuration

[`config/project.json`](config/project.json) declares the project name, the
origin under test, the evidence policy, gate thresholds, and where artifacts
are written. It is validated on load, and every problem is reported at once
with the exact path:

```
Configuration error: Invalid configuration in /…/config/project.json
  - thresholds.maxFailureRate must be a number between 0 and 1, got "high"
  - baseUrl must not contain credentials, a query string or a fragment
```

### Run history

An optional `history` block keeps one compact file per run, so the question
"is this a regression, or has it always been this way" has an answer:

```json
"history": { "directory": "quality-history", "keep": 200 }
```

It is committed on purpose, unlike `artifacts/`. The rule that evidence
artifacts are output and never checked in is about evidence: screenshots,
traces, full reports. A history entry is a few hundred bytes of counts and
outcomes, and it is the only thing that makes a run worth having had.

Each entry records which specs did _not_ pass, plus a hash pointing at the list
of every spec that ran. That list is stored once per distinct suite and shared by
every run in that state, so an entry stays small and a diff of a run shows counts
rather than three hundred ids. Both halves matter: without knowing who was
present, a spec that failed once in two runs and a spec that failed every time it
ran are the same string — which is the distinction the history exists for.

Left unset, history is off and nothing extra is written.

## Commands

The server targets **OpenCode**. Kilo and MiMo are out of scope by decision, not
merely untested — see the MCP section above.

```bash
npm test                    # full suite
npm run test:smoke          # Chromium only
npm run test:unit           # unit tests, no browser launched
npm run test:debug          # Playwright Inspector, step through a test
npm run report              # open the HTML report
npm run report:clean        # remove generated output
npm run build               # compile src/ to dist/ (an install runs this for you)
npm run defects:collect     # build defect artifacts from the last run
npm run defects:check       # prove two report-shape rules on a real Playwright run
npm run mcp                 # start the read-only MCP server on stdio
npm run mcp:check:all       # drive the server over real stdio and check it
npm run verify              # lint + typecheck + build + format check (CI runs this first)
```

`mcp:check*`, `defects:check`, `docs:numbers` and `ci:validate` need Python 3. They
are separate scripts because `verify` must stay runnable with only Node installed.

`defects:check` is the one check here that could not be written as a unit test,
because two of its rules are claims about what Playwright writes and both were
wrong when first written down.

The collector treats an unreachable target as one outage rather than a defect per
test. That rule needed two or more identical failures, and a `beforeAll` throw
never produces two: real Playwright marks the first spec `failed` and every later
one `skipped`. So the rule could not fire on the case it was written for, and an
outage produced exactly the one artifact it existed to remove — through a fully
green suite, because its tests were fed a hand-written report.

The evidence fixture keeps its payload on a failure rather than on a difference
from what was expected, so `test.fail()` does not delete the evidence. The
decision function has been unit-tested for a while; nothing checked that the
runner records the attachment at all.

So this runs a real Playwright and reads the report it produces: a dead
`beforeAll` writes no artifact and is named in the gate, a genuine assertion
failure still writes exactly one, and a `test.fail()` still carries a page URL
in its attachment. Needs a browser, for the fixture claim, and no network.

Both MCP checks produce their own evidence to check against: each runs the
deliberately failing `tests/smoke/evidence-pipeline.spec.ts` and collects the real
artifacts. So they work on a clean checkout and on a green commit, instead of
needing a failing suite to have been run first, and they report one clear cause
rather than a cascade of symptoms when something upstream is missing. Nothing is
written inside the project — the seed report, the artifacts and the served root
all live in a temporary directory, kept only if a check fails.

## Quality rules enforced in CI

- `page.waitForTimeout()` is banned by a lint rule. It is the main cause of
  flaky tests; wait for a real condition instead.
- `test.only()` and `describe.only()` are banned. In CI they would silently skip
  the rest of the suite.
- `@typescript-eslint/no-floating-promises` is an error. A forgotten `await` on a
  Playwright call makes a test quietly assert nothing.
- Formatting and type checks must pass.

Selector policy — which locator to reach for, and why — is in
[`docs/selectors-and-testid.md`](docs/selectors-and-testid.md).

## Sprint 1 scope

- Chromium smoke tests over a bundled demo app
- HTML, GitHub and JUnit reports
- Trace on retry, screenshot and video on failure
- Global setup that fails fast when the target is unreachable
- GitHub Actions CI publishing artifacts even on failure

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit together
- [`docs/defect-schema.md`](docs/defect-schema.md) — the `defect.v1` contract
- [`docs/selectors-and-testid.md`](docs/selectors-and-testid.md) — locator policy
- [`docs/roadmap.md`](docs/roadmap.md) — where this is going
- [`AGENTS.md`](AGENTS.md) — rules for coding agents working in this repo
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md).

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
