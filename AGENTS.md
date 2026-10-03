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
- If a test needs a real third-party service, stub it with `page.route` rather
  than depending on someone else's uptime.

## Adding evidence fields

Evidence artifacts are a public contract. Any change to the defect schema needs
a version bump (`v1` → `v2`), a migration note, and a changelog entry.

## Current state

Early alpha. The MCP server and the defect schema do not exist yet. See
[`docs/roadmap.md`](docs/roadmap.md).
