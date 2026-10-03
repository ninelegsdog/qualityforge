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

If you changed the evidence policy or the capture path, prove it:

```bash
QUALITYFORGE_EVIDENCE_CHECK=1 npx playwright test tests/smoke/evidence-pipeline.spec.ts
```

That run is supposed to fail. Confirm the artifacts landed in `test-results/`.

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
