# Parallel work on this repository

How several agents work on QualityForge at once without colliding, and why the
arrangement is shaped the way it is. Read this before splitting work across
agents.

The short version: **each agent gets its own worktree, its own branch, its own
port, and an explicit list of files it may touch. Only the integrator writes to
`main` and to the shared files.** Everything below is the reasoning and the
failure modes.

## Why not just several agents in one tree

Measured on this repository, last five commits:

| File                   | Times touched in 5 commits |
| ---------------------- | -------------------------- |
| `CHANGELOG.md`         | 5 of 5                     |
| `AGENTS.md`            | 5 of 5                     |
| `package.json`         | 5 of 5                     |
| `playwright.config.ts` | 4 of 5                     |
| `src/mcp/server.ts`    | 2 of 5                     |

Every change updates the changelog. So every agent reaches for the same three
files by reflex, and two agents in one tree collide by construction — not
sometimes, but on the first commit that touches documentation.

Working trees also share state that Playwright deletes. `outputDir` is cleared on
every run, and the JSON reporter overwrites `artifacts/json/playwright-results.json`.
Two concurrent runs in one tree destroy each other's evidence.

## The arrangement

```
main                     integrator only
 └─ qf/mcp-protocol      agent 1   src/mcp/**, tests/unit/mcp/**, scripts/mcp-*
 └─ qf/docs-config       agent 2   README.md, docs/quick-start*.md
 └─ qf/contract          agent 3   tests/**, config/project.json
 └─ qf/investigate       agent 4   nothing — read-only, writes to /tmp
```

Each worktree is a full checkout at `~/.agents/wt/<name>` with its own
`artifacts/` and `test-results/`. `node_modules` is a symlink to the main one: it
is 88 MB and identical, so N agents should not cost N copies. Treat it as
read-only — a dependency change is an integrator decision, because a symlinked
`node_modules` cannot be updated independently.

```bash
scripts/agent-worktree.sh create mcp-protocol   # worktree, branch, port
scripts/agent-worktree.sh env    mcp-protocol   # exports for the agent's shell
scripts/agent-worktree.sh verify mcp-protocol   # prove isolation before working
scripts/agent-worktree.sh remove mcp-protocol   # refuses to discard uncommitted work
```

## The port trap

The fixture port is set by **`FIXTURE_PORT`**, not `BASE_URL`.

```bash
FIXTURE_PORT=4411 BASE_URL=http://127.0.0.1:4411 npm run test:unit
```

`scripts/serve.mjs` reads `FIXTURE_PORT`; `playwright.config.ts` waits on
`BASE_URL`. Setting only `BASE_URL` leaves the server listening on 4311 while
Playwright waits on the other port, and the run dies after 30 seconds with
`Timed out waiting from config.webServer`. Both variables must be set, and
`agent-worktree.sh` sets both from one slot number.

Without distinct ports, two agents do not fail cleanly — the second one either
times out or, worse, silently reuses the first agent's fixture server, because
`reuseExistingServer` is true outside CI.

Slot allocation is "lowest free slot", read from a `port` file in each worktree.
A hash was tried first and rejected: modulo 12, two of five names collided on the
same port. Probably-unique is not good enough for the thing that exists to
guarantee uniqueness.

## Shared files nobody edits during a wave

These are integrator-only while agents work:

| File           | Why it is hot  |
| -------------- | -------------- |
| `CHANGELOG.md` | 5 of 5 commits |
| `AGENTS.md`    | 5 of 5 commits |
| `package.json` | 5 of 5 commits |

Agents describe their changes in the task report instead. The integrator writes
the changelog entry, from the reports, at merge time. This costs a little
translation work and removes the one collision that would happen on every single
task.

## Isolation, verified rather than assumed

Checked on this machine before the scheme was adopted:

- a worktree has its own `artifacts/` and `test-results/`;
- the main tree had 0 entries in `test-results/` before two agents ran, and 0
  after;
- two agents ran `npm run test:unit` simultaneously on ports 4411 and 4413, both
  reporting **126 passed**, with the main tree untouched;
- five worktrees received slots 0–4 with no duplicates.

If you add a resource that agents share, add it to `agent-worktree.sh verify`
before relying on it. The check is cheap and it is the only thing standing
between "isolated" and "assumed isolated".

## Waves

**Wave 1 — disjoint file sets, four agents:**

| Agent | Task                                | May touch                                          |
| ----- | ----------------------------------- | -------------------------------------------------- |
| 1     | Modern protocol path                | `src/mcp/**`, `tests/unit/mcp/**`, `scripts/mcp-*` |
| 2     | Client config in the docs           | `README.md`, `docs/quick-start*.md`                |
| 3     | Contract against a real application | `tests/**`, `config/project.json`                  |
| 4     | Investigate the client refusal      | nothing in the repo; experiments in `/tmp`         |

Agent 4 is read-only on purpose. Its task is to find out _why_ a client refuses
the server, which needs no edits and must not be able to interfere.

**Wave 2 — after wave 1 lands:** the fix for whatever agent 4 found (needs
`src/mcp/server.ts`, which wave-1 agent 1 owns), browser coverage, and the Node
version decision.

Do not run more than four. The repository is 1.4 MB of source and 15 commits
old; past four agents the merge queue costs more than the parallelism saves, and
the integration verification is serial by nature.

## Failure modes, and what happens instead

| Scenario                                                                 | What happens                   | Response                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Two agents want the same file                                            | Never, by construction         | Exclusive zones above; shared files are integrator-only                                                                                  |
| An agent's tests collide with another's                                  | Never, by construction         | Distinct ports, distinct worktrees, verified                                                                                             |
| An agent hangs or dies                                                   | Its worktree and branch remain | `agent-worktree.sh remove` refuses while uncommitted work exists, and names the branch. Nothing is lost because `main` was never touched |
| An agent commits something that breaks `main`                            | CI catches it                  | Agents push only to `qf/*`. The integrator merges and watches the run                                                                    |
| An agent "finishes" with a green local build                             | Possible                       | The rule in `AGENTS.md`. Verification in the real environment is the integrator's, at merge                                              |
| Two agents find the same bug                                             | Likely                         | Record it once in the task board. Fixing it twice produces two divergent patches and a merge conflict nobody can explain                 |
| An agent needs a dependency                                              | Not allowed to install         | New dependency is a product decision. It goes to the integrator with the rest of the shared-file changes                                 |
| `node_modules` needs updating                                            | Symlinked, shared              | One agent updates it in the main tree; every worktree sees it. Coordinate, do not parallelise                                            |
| The integrator merges two branches that both touched `src/mcp/server.ts` | Merge conflict                 | Expected only when wave boundaries were wrong. Resolve in the main tree, then re-run the full verification                               |
| An agent's branch is behind `main`                                       | Normal                         | Agents do not rebase mid-wave. The integrator merges and resolves; rebasing a branch nobody else has merged only creates work            |

## The integrator's job, every wave

1. Read the reports, write `CHANGELOG.md` from them.
2. Merge wave branches into `main`, resolving shared files in the main tree.
3. Run the full local verification in the main tree — `npm run verify`, both MCP
   checks, `npm run ci:validate`, `npm run docs:check`.
4. Push and **watch the run**. A merge that has not been watched has not been
   verified.
5. For protocol changes, additionally start the server the way a client starts
   it: from another directory, sending an `initialize` with each supported
   version, and a request carrying `_meta`. The scripted checks cannot do this —
   see `AGENTS.md`.
6. Clean up worktrees and branches.

Steps 3 to 5 are serial and cannot be delegated. That is the real limit on how
much this repository can parallelise, and it is a limit of the verification, not
of the coding.

## Related

- [`../AGENTS.md`](../AGENTS.md) — the rule this arrangement exists to satisfy
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — branch and commit conventions
- [`roadmap.md`](roadmap.md) — what the work is for
