# Quick start

A hands-on path from a fresh clone to an agent reading a real failure. Every
command here is meant to be run and watched, not just read. If one of them
behaves differently from what is written below, that is a bug worth reporting.

The [README](../README.md) describes what the project is and why. This document
describes how to use it in the next ten minutes.

## Requirements

| Need              | Version                                                      |
| ----------------- | ------------------------------------------------------------ |
| Node.js           | 22 or newer. Node 20 reached end-of-life in March 2026       |
| Playwright driver | installed via `npx playwright install`, not a global install |
| Python 3          | only for `npm run mcp:check*` and `npm run ci:validate`      |
| Platform          | Linux is verified; Windows and macOS are untested            |

`npm run verify` deliberately needs no Python, so the bulk of the project stays
usable on a Node-only machine.

## 1. Install

```bash
git clone https://github.com/ninelegsdog/qualityforge.git
cd qualityforge
npm ci
npx playwright install --with-deps chromium
```

`npm ci` runs with lifecycle scripts disabled by default in CI; locally it does
not need to, because nothing in this dependency tree runs install-time code that
the project relies on. `--with-deps` installs the browser's system libraries and
needs `sudo` on Linux.

## 2. Run the suite

```bash
npm test
```

This starts the bundled demo app in `fixtures/` on `http://127.0.0.1:4311`,
runs every spec in all four projects and shuts the server down again. A clean
clone is green with no configuration and no third-party network access.

| Count                                       | Number |
| ------------------------------------------- | ------ |
| Specs, all four projects                    | 333    |
| Skipped without any configuration           | 36     |
| — of those, `evidence-pipeline.spec.ts`     | 6      |
| — of those, `quotes-toscrape.smoke.spec.ts` | 30     |

Those skips are deliberate and all of them are described below: the evidence
pipeline fails on purpose, and the third-party suite needs an application this
repository did not build. The remaining 297 run.

Every number in that table is checked against the suite by
`npm run docs:numbers`, which counts what Playwright actually collects rather
than trusting this file. An earlier version of this paragraph said "139 specs"
and "expect two skips" — both were true when the matrix was one browser and the
third-party suite did not exist, and neither was noticed, because a green suite
says nothing about whether the documentation describes it.

Look at the report:

```bash
npm run report
```

It takes about **ten seconds** to say anything, then serves the HTML report on
`http://localhost:9323` and stays in the foreground until you press Ctrl+C. The
pause is the server starting; it is not a hang. No wrapper prints the address
sooner on purpose — if the server then failed, an address printed early would
send you somewhere that does not serve.

## 3. See a real failure with evidence

The project's core promise is that a failure leaves enough evidence to diagnose
it. That is a testable claim, so there is a test for it — one that fails on
purpose and is skipped unless you ask for it:

```bash
QUALITYFORGE_EVIDENCE_CHECK=1 npx playwright test tests/smoke/evidence-pipeline.spec.ts
```

The exit code is non-zero by design. Afterwards:

```bash
ls test-results/
```

Each failure directory holds a screenshot, a video, and an `error-context.md`.
Open the report to watch the trace:

```bash
npm run report
```

The trace viewer is the better tool when diagnosing a real failure: it gives the
DOM snapshot at every action plus the full network log, which a screenshot and a
video cannot.

`error-context.md` is worth reading directly. Playwright already writes it as an
instruction to an assistant — "explain why, be concise, respect best practices"
— followed by the test name, its location, the error and a diff of what was
expected. It is free, and QualityForge points at it rather than re-implementing
it.

## 4. Turn failures into artifacts

A failing test is only useful if the failure can be read later without re-running
anything:

```bash
npm run defects:collect
```

This reads the JSON report from the last run and writes one normalized artifact
per failure into `artifacts/defects/<runId>/`. Read one:

```bash
cat artifacts/defects/*/*.v1.json | head -40
```

The exit code is the gate: `0` when thresholds hold, `1` when they are violated,
`2` when collection could not run. In the step above it exits `1`, because every
spec failed and `thresholds.maxFailureRate` is `0.05`. That is the gate working.

The contract is [`defect-schema.md`](defect-schema.md). It is versioned, and a
breaking change is a major bump, so an artifact written today stays readable.

## 5. Let an agent read the evidence

The server is read-only and speaks MCP over stdio. Start it by hand first:

```bash
npm run mcp
```

It prints a banner to **stderr** and then waits for JSON-RPC frames on stdin,
staying in the foreground until you close it. Nothing else may ever go to stdout
— a stray log line is a corrupt frame. Check it properly with:

```bash
npm run mcp:check:all
```

This drives the real binary over a real pipe, asserts that stdout carries frames
and nothing else, and tries three ways of escaping the artifacts root — `..`
traversal, percent-encoded traversal and an absolute path — expecting all three to
be refused.

It runs three checks, and the third exists because of a bug that only appeared in
front of a real client: `mcp:check:spawn` starts the server the way a client
starts it — from a temporary directory outside the project, without `npx` — and
asserts the artifacts root still resolves into the checkout while a foreign
directory that really does hold evidence is still honoured. The first two checks
spawn from the project root, which is not what anything else does. It produces its own evidence to check against, by running step 3, so
it works on a clean checkout and on a green commit.

To connect a client, add this to its MCP configuration. This is the OpenCode
v2.0.16 form, verified by copying it into an `opencode.json` and connecting;
Kilo and MiMo were not tested and may expect something else:

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

`opencode mcp list` should then print `✓ qualityforge  connected`. Re-run it
before you believe it: in a directory OpenCode had not seen before, the first
invocation or two printed `No MCP servers configured` and the status arrived
several runs later, with a config file that was present and correct throughout.

Three notes, and the [README](../README.md#the-mcp-server) has the detail:

- **Both paths are absolute on purpose.** A client starts the server from _your_
  project directory, so a relative root resolves somewhere that does not exist.
  The server then falls back to this checkout — which only helps if step 4 has
  already produced `artifacts/defects/`. If it has not, the server exits and all
  the client reports is `failed: Connection closed`.
- **`["npx", "tsx", ...]` also works**, and is shorter, but it is several times
  slower to answer than the `node` form above. If a client refuses to connect,
  try that swap before anything else.
- **`opencode mcp add` writes `mcp.servers.<name>`** rather than the `mcp.<name>`
  above. OpenCode v2.0.16 accepts both; the two forms just will not match each
  other in review.

Add `--root <dir>` to serve artifacts from somewhere other than the default
`artifacts/defects`.

| Tool                     | What it answers                                                       |
| ------------------------ | --------------------------------------------------------------------- |
| `quality_get_latest_run` | Pass and fail counts, duration, whether the quality gate passed       |
| `quality_list_failures`  | Compact records: id, status, test location, flakiness                 |
| `quality_get_defect`     | One defect in full, including console, network and page-error signals |

There is a prompt too, `triage_failure`, which asks for facts before
hypotheses.

## 6. Point it at your own application

```bash
cp .env.example .env
```

Set `BASE_URL` in `.env`, then:

```bash
npm test
```

Everything else — selectors, fixtures, thresholds — is per project and belongs
under `tests/`. `config/project.json` holds the origin under test, the evidence
policy, the gate thresholds and where artifacts are written; it is validated on
load and reports every problem at once with the exact path.

Your own tests should import from the bundled fixture rather than from
`@playwright/test`:

```ts
import { expect, test } from "../fixtures.js";
```

That single change is what makes console, page-error and network capture
automatic. See [`AGENTS.md`](../AGENTS.md) for the rules that apply to writing
tests here, and [`selectors-and-testid.md`](selectors-and-testid.md) for locator
priority.

## 7. When something goes wrong

**`npm test` fails to start the demo app.** Port 4311 is in use. `BASE_URL`
overrides it, but then the bundled suite has nothing to test against. Free the
port.

**No screenshot or video appears.** Both are `only-on-failure` and
`retain-on-failure`. A passing test produces neither, by design. Also check
`test-results/` rather than `playwright-report/` for the raw files.

**No trace.** The policy is `on-first-retry`. A local run has no retry, so pass
`--trace on` when you actually need it.

**`quality_list_failures` returns nothing.** Correct behaviour on a green run:
there are no defects. Step 3 produces some on purpose.

**A check passes locally and fails in CI.** Run `npm run verify`,
`npm run ci:validate`, `npm run mcp:check:all` and `npm run defects:check` in
that order — they are the four things CI runs, in the same order. The last one
needs a browser and no network: it starts a real Playwright to check two rules
that depend on the shape of the report, which is the kind of assumption a unit
test cannot test.

## Where to go next

- [`architecture.md`](architecture.md) — how the pieces fit together
- [`defect-schema.md`](defect-schema.md) — the artifact contract
- [`selectors-and-testid.md`](selectors-and-testid.md) — how to write selectors
- [`roadmap.md`](roadmap.md) — what is planned
- [`../AGENTS.md`](../AGENTS.md) — rules for agents and contributors
