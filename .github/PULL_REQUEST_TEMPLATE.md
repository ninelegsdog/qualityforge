## What and why

What does this change, and why does it need to exist? One paragraph. The diff
shows the what; this is the why — the decision, the constraint, the observed
behaviour that made the change necessary.

## Verification

- [ ] `npm run verify` passes locally
- [ ] `npm test` passes locally

If the change adds or modifies a check, a rule, or a claim about behaviour:
what did you **break on purpose** to confirm it can fail, and what did that
run output? A check that has never failed is an unverified assumption — the
CI conclusion is read from the exit code, not from grepping output.

## Notes for the reviewer

- One concern per pull request.
- Conventional Commits on the squash commit: `feat:`, `fix:`, `docs:`,
  `test:`, `chore:`, `security:`, `refactor:`.
- If behaviour changed, `CHANGELOG.md` is updated under `[Unreleased]`.
- If evidence fields changed, that is a schema version bump — see `AGENTS.md`.
- If this was AI-assisted, say which parts were agent-generated and paste the
  verbatim output of `npm run verify` and `npm test`. "The agent says it
  passes" is not evidence.
