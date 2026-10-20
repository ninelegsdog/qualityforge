# Accessibility audit artifact v1

One accessibility audit of one page, written per run, shaped before it is
written so that an agent can read it without interpreting the engine's answer
first.

- Machine-readable schema:
  [`../schemas/a11y-audit.v1.schema.json`](../schemas/a11y-audit.v1.schema.json)
- Runtime types and validator: [`../src/a11y/types.ts`](../src/a11y/types.ts)
- Producer: [`../src/a11y/audit.ts`](../src/a11y/audit.ts)
- Command: [`../src/cli/a11y-audit.ts`](../src/cli/a11y-audit.ts)

## The design rule

**An audit is not a defect, and it is not a field on `defect.v1`.**

A defect artifact exists because a test failed. An audit exists whether or not
anything failed, so binding the two would make every audit look like a defect —
and would put a recurring measurement on a schema that promises "one normalized
failure". They have different questions, different lifetimes and different
consumers, so they have different artifacts.

What this artifact is instead: **the engine's answer, reduced to the part a
reader can act on, and reduced again where a reduction would be a lie.**

## Producing artifacts

```bash
npm run a11y:audit                                    # baseUrl from the config
npm run a11y:audit -- --url http://127.0.0.1:4311/docs
npx --no-install qualityforge-a11y --out /tmp/scratch --json
```

| Exit | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| `0`  | audited, no violations                                        |
| `1`  | audited, violations found                                     |
| `2`  | could not audit — bad config, no `axe-core`, page unreachable |

`2` is deliberately distinct from `0`. An audit that never loaded an engine and
reports zero violations is the worst outcome this command could produce, because
it looks exactly like a passing result. Both refusals name the fix: `npm i -D
axe-core`, or `npx playwright install chromium` when the browser build that is
missing follows from whichever Playwright version the project resolved.

The engine is a **peer dependency**, like `@playwright/test`. The core of this
package never loads it; the audit uses the engine the project already has, so no
second copy is shipped.

## Relationship to a test run

**An accessibility audit is a separate gate, not a block of the defect run.**
`qualityforge-a11y` opens its own browser, audits the pages it was given, writes its
own artifact and exits with its own code. The collector never calls it, and
`quality-summary.v1.json` deliberately has no `a11y` field.

The live external run on 2026-10-19 exposed why the absence needs saying: an agent
read the defect summary, saw no accessibility block, and could not tell whether the
dimension was silent, clean, or simply run by another command. The answer is the
last one. There is no `summary.a11y` because there is no fact for it to hold — the
collector does not know whether an audit happened, which pages it covered, or
whether it finished.

What the two artifacts do share is enough to correlate them honestly:

- **Origin.** `url` is the origin, with no path, exactly as in the defect summary.
  Audit the route separately; the artifact tells you which origin it belongs to, not
  which page.
- **Time.** `createdAt` is the audit's own timestamp. An audit taken before a deploy
  says nothing about the application after it.
- **`runId`.** It names the audit, not a suite run. Two audits with different ids may
  cover the same application, and an audit and a defect run may share a timestamp
  without sharing a cause.

To gate both, run both commands and require both exit codes. A green
`summary.gate` is evidence about the tests; it is not evidence that accessibility
was audited. A `--run-id` flag was considered and rejected for this version: it
would record a link the command cannot verify, and two independently correct
artifacts joined by a false id are worse than two artifacts joined by origin and
time.

The MCP tools say the same thing when they list audits, so an agent that finds them
does not have to infer it from this document.

## Shape

```jsonc
{
  "schemaVersion": "1.0.0",
  "url": "https://quotes.toscrape.com", // origin only
  "createdAt": "2026-10-16T01:29:31.810Z",
  "engine": { "name": "axe-core", "version": "4.14.0" },
  "counts": { "violations": 5, "incomplete": 0, "nodes": 11, "truncatedRules": 0 },
  "violations": [
    {
      "id": "image-alt",
      "impact": "critical",
      "nodes": [
        {
          "target": ["img"],
          "html": "<img src>",
          "failureSummary": "Fix any of the following:\n  Element does not have an alt attribute",
        },
      ],
      "totalNodes": 1,
      "truncated": false,
    },
  ],
  "incomplete": [],
}
```

Every field below was chosen from a measured run of the real engine against real
pages, not from its documentation. The measurements are the reason; the numbers
are in [`../notes/roadmap-40-a11y-findings.md`](https://github.com/ninelegsdog/qualityforge-notes)
and summarised here.

### `violations` and `incomplete`, never `passes` or `inapplicable`

On the project's own `/`, `violations + incomplete` came to **33 bytes out of
53 147** — the other 99.9% was rules that passed or did not apply. An artifact
is read by a language model, so carrying them spends the context window on
nothing.

`incomplete` is kept apart from `violations` because it is not the same claim: a
rule the engine could not decide has not been found clean. A consumer that merges
the two reports uncertainty as certainty.

### `url` is an origin

Never a path, a query or a fragment: a query string is exactly where a token
would ride. A scheme with no origin, such as `file:`, is recorded as its scheme —
the platform reports "no origin" as the literal string `null`, and recording that
puts a reader one character away from reading it as a missing value.

### `nodes` is capped, and the cap is visible

One rule produced **48 nodes** on a real page (`color-contrast`, 18 460 bytes
after compression), so ten are kept. Ten is enough to see the pattern, because
nodes of one rule repeat the same defect.

Every rule therefore carries `totalNodes` — how many the rule really produced —
and `truncated`. A cap that does not say what it dropped is the silent loss this
package forbids everywhere else, and a consumer that reads only `nodes` will
under-report by exactly the difference it is not told about.

### `html` is structure, never content

Nine positions on a real page carried an injected token across ten violation
nodes: `onclick`, `value`, `id`, `title`, `aria-label`, `data-*`, a query in
`href`, a query in `src`, and the element's own text. Nine different places is
the argument against filtering by attribute name: **the name is never the secret,
the value is.**

So `<img src="/x.png" alt="pic" data-token="…">` is written as `<img src alt
data-token>`. The cost is stated rather than discovered later: `type="password"`,
`alt=""` and every concrete value are gone. The benefit is measured — not one of
the nine observed positions survives.

### `target` is kept, and redacted

Without it, 48 nodes of one rule are indistinguishable, and `where` is half the
message — `#password` is the most useful selector in the artifact. It is
redacted rather than stripped, and the redaction is measured: before, the
editor covered 2 of the 6 selector forms the engine builds, and the misses were
exactly the ones carrying a token.

### `failureSummary` survives whole

It is the engine's own prose, not page content. Measured across nine injected
positions it carried the token in **none** of them, which is why it is kept
intact while `html` beside it is reduced.

## Rules a consumer can rely on

1. **`impact: null` means the engine did not say.** It is never rounded up or
   down to a level, and it never means "minor". An unrecognised level becomes
   `null`: fail closed, so that "we could not tell" cannot read as "it passed".
2. **`nodes.length ≤ totalNodes` always.** If you need the whole sample, the
   artifact does not carry it and the audit must be re-run with a higher
   `--max-nodes`.
3. **`truncated` is the only way a rule loses information**, and it is always
   present on every rule, whether it fired or not.
4. **No attribute value and no element text is ever recorded.** Not in `html`,
   not anywhere. Consumers must not expect to recover them from a later version
   either; this is the rule the project applies to URLs as well, for the same
   reason — a filter only knows the names it was told about.
5. **`url` carries no path.** Join it with the route you audited yourself.
6. **`engine` is recorded because a rule's meaning belongs to its engine.**
   `color-contrast` in `axe-core` 4.14 is not the same rule as in 4.9, and this
   artifact does not pretend otherwise.
7. **An audit is not a gate result.** Exit `1` means violations were found on the
   pages you chose. It says nothing about whether your tests pass.

## What the JSON Schema cannot express, and where that check lives instead

`totalNodes ≥ nodes.length` is a relation between two fields. JSON Schema
describes one value at a time and cannot compare them, which is why
`validateAudit()` in `src/a11y/types.ts` exists alongside the schema: it checks
cross-field invariants, and the audit is validated **before** it is written
rather than trusted afterwards.

If you validate an artifact with the schema alone, you get structure without the
invariants. That boundary is deliberate and pinned by
`tests/unit/a11y-schema.test.ts`, which asserts both halves: the schema accepts
what it cannot express, and the runtime validator refuses it.

## Versioning

Semantic versioning, as for `defect.v1`. Removing or renaming a field, or
changing a type or meaning, is a major bump. Adding an optional field is a minor.
Consumers must be able to ignore unknown fields — the schema sets
`additionalProperties: false` on purpose, so a producer that invents a field is
caught rather than silently accepted.

## Validation

```bash
npm run a11y:audit -- --out /tmp/scratch
```

Every artifact is validated with `validateAudit()` before it touches disk. If
validation fails, the producer is wrong; the contract is not relaxed to fit it.
The published schema is separately checked against real output by
`tests/unit/a11y-schema.test.ts`, so the two cannot drift apart quietly.

## Related

- [`defect-schema.md`](defect-schema.md) — the defect artifact
- [`roadmap.md`](roadmap.md) — where accessibility sits and what was measured
