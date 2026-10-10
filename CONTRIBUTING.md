# Contributing to QualityForge

Thanks for considering it. This project is early alpha, so the design is still
moving — a conversation before a large patch will save everyone time.

## Getting set up

Requires **Node.js 22 or newer** (Node 20 reached end-of-life in March 2026).
CI runs Node 22 and 24.

```bash
git clone https://github.com/ninelegsdog/qualityforge.git
cd qualityforge
npm ci
npx playwright install --with-deps chromium
npm test
```

The suite starts its own fixture server. You do not need a running application
to run it.

## Before opening a pull request

```bash
npm run verify   # lint + typecheck + format check
npm test
```

Both must pass. If you touched test infrastructure, say in the description which
failure modes you verified — for example, that you confirmed a test can still
fail.

## Checking the CI workflow

A workflow cannot be exercised without a remote, so it gets a static check:

```bash
npm run ci:validate
```

This verifies, beyond mere validity, the properties whose absence is silent:

- `permissions` is declared and least-privilege, so the token inherits nothing;
- every third-party action is pinned to a commit SHA, not a mutable tag;
- `persist-credentials` is disabled, so no token is left in `.git/config`;
- every job sets `timeout-minutes`;
- installs run with `--ignore-scripts`;
- `pull_request_target` is not used, since it exposes secrets to untrusted code;
- every `npm run` target exists in `package.json`;
- every uploaded artifact path is actually produced by something in the repo;
- no end-of-life Node version is pinned.

It needs Python 3 with PyYAML, which is why it is a separate script rather than
part of `npm run verify`: `verify` must stay runnable with only Node installed.
If you change the workflow or the artifact paths, run it.

## Pull request rules

- One concern per pull request.
- Explain **why**, not just what. The diff already shows what.
- Use the pull-request template; it asks for the verification that makes a
  change reviewable, including what you broke on purpose to confirm a new check
  can fail.
- If behaviour changes, update `CHANGELOG.md` under `[Unreleased]`.
- If evidence fields change, that is a schema version bump — see `AGENTS.md`.
- Conventional Commits for the commit subject: `feat:`, `fix:`, `docs:`,
  `test:`, `chore:`, `security:`, `refactor:`.

## Writing tests

Read `AGENTS.md` first. The short version:

- Assert user-visible behaviour, never CSS classes or XPath.
- No `page.waitForTimeout()`.
- No `test.only()`.
- Use web-first assertions so they retry.
- Stub third-party services instead of depending on their uptime.

## AI-assisted contributions

Fine, and encouraged — this is an AI-native project. Two expectations:

1. Say which parts were agent-generated. Reviewers weigh unreviewed generated
   code accordingly.
2. The agent must have actually run `npm run verify` and `npm test`, and the
   output belongs in the description. "The agent says it passes" is not
   evidence.

## Reporting bugs

Use the bug-report issue form: it asks for the four things this project acts
on — what you ran, what you expected, what happened, and the trace or report if
you have one. A failing test is the ideal bug report. For a suggested change,
use the feature-request form; it asks how "done" would be verified, because a
change that cannot be observed failing is not finished.

## Security

Do not open a public issue for a security problem. See `SECURITY.md`.

## Code of conduct

Be straightforward and assume good faith. See `CODE_OF_CONDUCT.md`.
