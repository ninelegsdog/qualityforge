# Shared quality policy

One quality policy, many repositories. A project declares `extends` with a path to a
file, takes the values it does not state from there, and wins wherever the two
overlap.

```json
{
  "extends": "../../quality-policy.json"
}
```

- Runtime types, loader and validation:
  [`../src/config/load-config.ts`](../src/config/load-config.ts)
- The policy's own rules: [`../src/config/policy.ts`](../src/config/policy.ts)
- A working example: [`../examples/shared-policy/`](../examples/shared-policy/)

## Why the shape is a file, not a package

A path. A published package would be a dependency with its own version, and a shared
quality policy that can drift away from the tooling that reads it is not a policy but
a suggestion. A file sits next to the repositories that read it, moves in the same
commit, and is reviewed like everything else.

## Precedence, stated once

**The project's own value wins, field by field.** An organisation that sets a failure
threshold and a developer who raises it for one repository must be able to say so
without copying the whole section — copying the whole section is how a shared policy
starts drifting again.

With a chain, from weakest to strongest:

```
project  >  policy named first  >  policy it extends  >  …
```

```jsonc
// policy.json — the organisation's rule
{ "thresholds": { "maxFailureRate": 0.02, "maxAttemptsPerTest": 3, "maxDurationMs": 900000 } }

// support/config/project.json — this project's one objection
{ "extends": "../../policy.json",
  "thresholds": { "maxDurationMs": 1800000 } }

// result: 0.02 and 3 from the policy, 1800000 from the project
```

## What a policy may not say

Each of these is **refused with its reason**, not ignored:

| Key                 | Why                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`              | it names the project under test, which is the one thing a policy cannot know                                                                                 |
| `baseUrl`           | a shared origin would point every project's artifacts at somebody else's server                                                                              |
| `projects`          | these are this repository's Playwright project names; another's do not exist here                                                                            |
| `tags`              | artifact labels mix this project's release marks with organisation-wide ones, and one filter pulls the wrong one                                             |
| `defects.directory` | where a repository keeps its artifacts is its own arrangement                                                                                                |
| `history.directory` | likewise for history                                                                                                                                         |
| `history`           | a history section needs `directory`, and the directory is the project's — so `keep` could only be shared by shipping a section that is invalid on its own    |
| `api.directory`     | where a repository keeps its API audits is its own arrangement                                                                                               |
| `api.expectations`  | contracts describe **this** application's endpoints; shared ones would be checked against an address that does not exist here                                |
| `perf.pages`        | the pages a budget holds are this application's routes; a shared list would name pages another project does not serve, and an unobserved page is a violation |

**A policy contains no arrays at all.** Everything shareable — `evidence`,
`thresholds`, `defects.writeSummary`, `defects.referenceErrorContext`,
`schemaVersion` — is a scalar or an object of scalars. That removes the one question
per-field merging usually gets wrong: what a list from two sources should mean. It is
a consequence of the table above, not a convenience, and adding a shareable list later
should be treated as adding an ambiguity.

## Rules a consumer can rely on

1. **A policy is validated before anything is merged from it.** An impossible
   threshold is refused naming the _policy_, not the project — because an error that
   sends the reader to the wrong file is the half-application this feature exists to
   prevent.
2. **A policy's values are checked by the project's own rules**, not a second copy of
   them. A second copy would be one more place for those rules to live, and it would
   drift.
3. **A chain is refused when it cycles**, with the whole chain named. A loop is not a
   slow run; it is a policy that would apply forever, and the visible failure has to
   arrive before the invisible one. Cycles are recognised through `realpath`, so
   `a/../policy.json` and `policy.json` are the same file for this purpose.
4. **A path is resolved against the file that named it**, not the working directory,
   so the same command works from anywhere.
5. **The merged result must itself be a valid project configuration.** `extends` is
   gone by the time the project's own rules run, so a project that shares a policy is
   held to exactly the strictness one that does not is.
6. **A policy may declare `schemaVersion` and it must match the project's.** Two
   versions in one load, with no way to say which applied, is refused rather than
   resolved.
7. **A shared policy is a coupling point.** An organisation's policy file must move
   in step with the QualityForge version its repositories run, because a key the
   loader does not know is an error. That is the cost of rule 1, and it is deliberate.
8. **A run records the chain it inherited** in `summary.policy`, and the collector
   prints it. What that answers is _did a shared policy decide anything here_ — the
   first question anyone asks of a governance claim.

## Known gaps

- **Per-value provenance is not recorded.** `summary.policy.chain` names the files;
  it does not say which value came from which. Comparing a stored threshold against
  the policy still means opening the policy. A per-value record is a second map that
  can drift out of step with the merge that produced it, and a wrong attribution is
  worse than an absent one.

## The example

[`examples/shared-policy/`](../examples/shared-policy/) holds two projects and one
policy:

- `checkout` overrides **nothing**, so every shared value reaches it;
- `support` overrides **one threshold**, showing a single field winning while the
  other two arrive from the policy;
- changing `policy.json` moves **both** projects at once, and does not flatten the
  override.

`tests/unit/config-policy-example.test.ts` reads those files rather than building a
tree, so the numbers in it cannot drift from the example a reader would open.
