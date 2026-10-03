# AGENTS.md

Rules for coding agents working in this repository. Read before changing code.

## What this project is

QualityForge: an open-source Playwright-based browser quality core. It produces
normalized, machine-readable evidence of test failures and (later) exposes that
evidence to AI agents over a read-only MCP surface.

It does **not** try to replace Playwright. It builds on it.

## Hard rules

These are enforced in CI. Do not work around them.

1. **Never commit `test.only()` or `describe.only()`.** In CI they silently skip
   the rest of the suite. Banned by lint rule.
2. **Never use `page.waitForTimeout()`.** Banned by lint rule. It is the primary
   cause of flaky tests. Wait for a real condition: `expect(locator).toBeVisible()`,
   `waitForURL`, `waitForResponse`, or a real state predicate.
3. **Never leave a floating promise.** `@typescript-eslint/no-floating-promises`
   is an error. A missing `await` on a Playwright call makes a test pass while
   asserting nothing.
4. **Never assert on implementation details.** No CSS classes, no XPath, no
   element indexes. Assert what a user sees: role, label, text, test id.
5. **Never commit secrets.** Use `.env`, and keep `.env.example` free of real
   values.
6. **Never commit evidence artifacts.** `artifacts/`, `test-results/`,
   `playwright-report/` and stray `*.png`/`*.webm`/`*.zip` are ignored on
   purpose. They are output, not source.
7. **Never write to stdout from an MCP server.** stdout carries JSON-RPC frames.
   Log to stderr only. A stray `console.log` corrupts the protocol stream.
8. **Never let the MCP server read outside its configured artifacts root.**
   Client-side path allowlists are not a security boundary. Confinement is
   enforced server-side, including against `..` and symlinks.

## Before you finish

Run and show the output of:

```bash
npm run verify   # lint + typecheck + format check
npm test         # the suite
```

Do not report a task as done on the basis of a green build alone. Confirm the
observable behaviour: the test ran, and it failed when the thing it guards was
broken.

**Check the exit code, not a line of output.** Grepping for the string you expect
is a claim that you looked, not a check: it passes while the build is green and
stays silent when the build is red — the worst way to fail. Not hypothetical here:
twelve lint errors reached `main` because a grep for the prettier line was taken
for the result of `verify`. CI caught it, because CI reads the exit code.

Being inside your zone does not make it true either, and neither does six green
jobs. Those describe the tree you committed, not whether your report is accurate.

## The rule: nothing is done until it has run in the real environment

**A check is not finished until it has been executed where it will actually
run, and observed to fail for the right reason. A green local build is not
evidence that anything works — it is evidence that nothing objected.**

This is not a warning about carelessness. It is an empirical finding from this
repository, where five separate things were each believed finished, each passed
every check available at the time, and each was found broken the first time it
was run for real:

| Thing                    | Looked finished because                                | Actually broken because                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI workflow              | `validate-ci.py` passed, YAML parsed, nine rules green | GitHub rejected the workflow at validation. `node-version` as an array inside a job that also declared `strategy.matrix`. Every push failed in **0 seconds** with no jobs and no logs.                          |
| `mcp:check:tools`        | Passed locally, repeatedly                             | Required a failing suite to have been run first. It was green because stale artifacts from earlier deliberate failures were lying around. On a green commit it failed for a reason unrelated to the MCP server. |
| `mcp:check`              | Not previously run in isolation                        | Same dependency, and it reported **eight** protocol symptoms instead of "the artifacts directory does not exist".                                                                                               |
| `scripts/check-links.py` | Passed on the real docs                                | Skipped only the line holding a fence marker, so links inside documented code blocks were judged as real links. Found by injecting a deliberately broken link.                                                  |
| The vault backup         | Mirror created, `git push` reported success            | The bare repository's `HEAD` pointed at `refs/heads/master` while the branch was `main`. A plain `git clone` produced an **empty directory**.                                                                   |

And two defects that no local check could ever have reached, because the tests
did not exercise the shape:

- The MCP server resolved a relative `--root` against the working directory. A
  real client spawns it from the user's project directory, so the root did not
  exist and the client reported only `Connection closed` — the message naming
  the cause went to stderr, which clients discard.
- `initialize` answered with the server's newest protocol version regardless of
  what the client requested. OpenCode, whose default is `legacy`, refused the
  connection outright. Our checks never sent an `initialize`.

Three rules follow, and they are checkable:

1. **Run it where it runs.** A validator that parses a file cannot know what a
   platform's runtime will accept. Push the workflow and read the run. Start the
   server the way a client starts it, from a different directory, with no
   `npx`.
2. **Break it on purpose.** Every new check gets a negative test: inject the
   defect it exists to catch and confirm it goes red. A check that has never
   failed is an untested assumption. If you cannot make it fail, you have not
   verified that it works — only that it is quiet.
3. **Test the shape the client uses.** Coverage of the easy path is not coverage.
   If a client may send a handshake, your test sends that handshake. If a
   platform validates a field, your tests exercise a run that contains it. Ask
   what your tests _cannot_ reach, and go reach it.

The pattern behind all five: the checks agreed with the code, because both were
written from the same assumption. Agreement between a check and the thing it
checks is only evidence when the assumption was tested independently.

If you changed the evidence policy or the capture path, prove it:

```bash
QUALITYFORGE_EVIDENCE_CHECK=1 npx playwright test tests/smoke/evidence-pipeline.spec.ts
```

That run is supposed to fail. Confirm the artifacts landed in `test-results/`.

## Parallel work

Several agents may work on this repository at once, but not in one working tree:
`CHANGELOG.md`, `AGENTS.md` and `package.json` were each touched by 5 of the last
5 commits, so two agents in one tree collide on the first commit that touches
documentation.

Use `scripts/agent-worktree.sh`, which gives an agent its own worktree, branch
and fixture port, and **read [`docs/parallel-work.md`](docs/parallel-work.md)
before splitting work**. It documents the file-exclusivity zones, which files are
integrator-only, the `FIXTURE_PORT`/`BASE_URL` trap, the wave plan, and the
failure modes.

Three things that document does not need to repeat, learned by hitting them:

- **Zones catch file overlap, not meaning.** A collector that refuses colliding
  ids and a browser matrix were each correct, each in its own zone, each passing
  its own checks — and together they meant a multi-browser run could not collect
  a single artifact. Only running the checks *after* the merge finds that.
- **Never leave a path unowned.** `docs/` belonged to nobody in one wave, so two
  parties edited the same file. Zones must say who *cannot* touch a path, not
  only who can.
- **The gate is per-worktree or it is not a gate.** `core.hooksPath` needs
  `extensions.worktreeConfig`; without it every agent overwrites the previous
  hook and they all end up gated by whoever wrote last.

Two things to keep in mind:

- The fixture port comes from `FIXTURE_PORT`, not `BASE_URL`. Setting only
  `BASE_URL` leaves the server on 4311 and the run times out.
- The integrator's verification is serial and cannot be delegated. That is the
  real ceiling on how far this repository parallelises.

## The demo app

`fixtures/` is a real, working app, not a mock stub. It exists so the suite has
genuine behaviour to observe.

- `fixtures/*.html`, `fixtures/*.js` are **browser** code. They are linted as
  plain JS and excluded from the TypeScript project.
- `scripts/serve.mjs` is **Node** code. It must stay dependency-free and must
  keep rejecting path traversal.
- Every control gets a `<label>`. Every message gets a `role`.
- Keep the app boring. It is a test target, not a showcase.

If you add a page, register it in `ROUTES` in `scripts/serve.mjs` and give it a
smoke test that asserts something a user would notice.

## Style

- TypeScript, ESM, Node 22+ (Node 20 reached end-of-life in March 2026).
- Imports ordered: stdlib, then third-party, then local.
- Explicit type annotations on exported functions.
- Conventional Commits: `feat`, `fix`, `docs`, `test`, `chore`, `security`, `refactor`.
- One concern per commit. A commit that fixes a bug and reformats a file is two
  commits.

## Adding tests

- Put smoke tests in `tests/smoke/`, grouped by area beyond that.
- Name tests after the behaviour, not the method: `returns 404 for a missing
path`, not `testGet404`.
- Prefer a web-first assertion (`await expect(x).toBeVisible()`) over asserting
  on a value you just awaited yourself — the latter does not retry.
- Follow the locator priority in `docs/selectors-and-testid.md`: role, then
  label, then text, and `data-testid` only as a last resort.
- If a test needs a real third-party service, stub it with `page.route` rather
  than depending on someone else's uptime.
- Every new test must be able to fail. Add it, then break the thing it guards
  and confirm it goes red. A test that has never failed is unverified.

## The MCP server

`src/mcp/` implements protocol 2026-07-28 directly. Read
`src/mcp/protocol.ts` before changing it; the header explains why the official
SDK is not used.

1. **Never write to stdout.** stdout carries JSON-RPC frames. A banner, a
   warning, or a stray `console.log` is a corrupt frame. Diagnostics go to
   stderr, including `--help`.
2. **Never add a write capability.** The server is read-only, and that is
   structural. If a tool needs to write, it does not belong in this server.
3. **Treat every client path as hostile.** Confinement lives in
   `src/mcp/store.ts` and must stay server-side. Do not rely on a client's path
   allowlist; the Kilo config on this machine allows `/home/*`.
4. **Never let a rejection message describe the filesystem.** Errors reach
   transcripts and model prompts.
5. **Every result carries `resultType`.** List and read results also carry
   `ttlMs` and `cacheScope`. 2026-07-28 requires both.
6. **Keep `tools/list` order stable.** Clients cache on it, and it affects LLM
   prompt-cache hit rates.
7. **Resource-not-found is `-32602`.** It moved from `-32002` in this revision.
8. **A notification gets no response**, not even an error one.

Check changes over the wire, not only by calling functions:

```bash
npm run mcp:check:all
```

Three checks run there, and it is worth knowing which is which:

| Check             | What it drives                                                            |
| ----------------- | ------------------------------------------------------------------------- |
| `mcp:check`       | frames only on stdout, envelope required and answered on 2026-07-28       |
| `mcp:check:tools` | tools answer with real data; three traversal shapes refused with `-32602` |
| `mcp:check:spawn` | the server started from a directory outside the project, with no `npx`    |

The first two spawn from the project root, which is not what any client does.
`mcp:check:spawn` exists because that difference is exactly what broke the
artifacts root once, and it asserts both halves: the root still resolves into this
checkout when the working directory has nothing, and a foreign directory that
really does hold evidence is still honoured. A server that ignored its working
directory entirely would pass the first half alone, so the control case is there
on purpose.

What these checks still do **not** cover, so you do not believe more than they
prove:

- **No real client.** `opencode mcp list` connects, in both `auto` and pinned
  2026-07-28 mode, but that was checked by hand. If you change anything a client
  reads during connection — `server/discover`, capabilities, the `initialize`
  echo — verify against the actual client, and **use a fresh directory**: the CLI
  caches connection state per directory, so a directory that has already seen a
  failure keeps reporting it after you fixed the server.
- **Nothing is checked for speed or concurrency.** If you add a fourth check that
  binds a port or writes to a shared path, it will collide with the other two.

After changing this directory, still connect a real client. It reads things no
local check asserts.

## The defect contract

Artifacts under `artifacts/defects/` are a published contract. Read
`docs/defect-schema.md` before touching them.

1. **Extend `error-context.md`, never re-implement it.** The artifact records a
   path to Playwright's `error-context.md` and adds only what that file cannot
   carry. Parsing its prose would be the most fragile link in the pipeline.
2. **Strip terminal escapes.** Playwright embeds ANSI codes in `error.message`.
   `stripAnsi()` handles this; never write a raw message into an artifact.
3. **Never record a secret.** `baseUrl` is reduced to an origin before it is
   stored. The config loader rejects a `baseUrl` carrying credentials or a query
   string, so the mistake is caught at the source.
4. **Fail closed on unknown input.** An unrecognised status becomes `failed`,
   never `passed`.
5. **Do not guess.** Evidence pointers are recorded only when the runner
   actually attached the file. An absent trace on a run with no retry is normal.
6. **Validate before writing.** The collector validates every artifact against
   `validateDefect()` before it touches disk. If validation fails, fix the
   producer rather than relaxing the contract.
7. **Version any breaking change.** Removing or renaming a field, or changing a
   type or meaning, is a major bump: `v1` to `v2`, with a migration note and a
   changelog entry. Adding an optional field is a minor bump. Consumers must be
   able to ignore unknown fields.

## Writing a browser test

Import `test` and `expect` from `../fixtures.js`, never from `@playwright/test`:

```ts
import { expect, test } from "../fixtures.js";
```

That single change is what makes console, page-error and network capture
automatic. It works because the `signals` fixture is declared `auto`; evidence
should never depend on a test remembering to ask for it.

Pure logic tests are the exception: they keep importing `@playwright/test`
directly, launch no browser, and stay fast.

### Redaction is not optional

Captured console text and request URLs are attacker-adjacent. An application
under test will print a token into a warning, and a failing request will carry
one in its query string. So:

1. Redact at capture time, in `src/quality/redact.ts`. Never at write time in
   the collector — by then the secret has already touched a file.
2. Drop query strings wholesale rather than filtering by parameter name. A
   filter only knows the names it was told about.
3. Preserve what is not secret. `Authorization: Bearer [redacted]` is useful;
   `Authorization: [redacted] [redacted]` protects nothing extra and destroys
   the diagnostic value.
4. Mask sensitive header values but keep the header names. The name is the
   signal; the value is never needed for triage.
5. Keep capture bounded. An artifact is read by a language model, and one
   unbounded stack dump crowds out everything else in the context window.

## Current state

Early alpha, and the core is in place: the `defect.v1` contract, the collector
with its quality gate, signal capture with redaction, and a read-only MCP server
speaking protocol 2026-07-28. Published at <https://github.com/ninelegsdog/qualityforge>
and green on CI. Not yet done: packaging, and a check against a live agent
client. See [`docs/roadmap.md`](docs/roadmap.md).
