# Transfer-budget artifact v1

One run's verdict on the transfer budgets a project declared, shaped before it is
written so that an agent can read it without measuring a page first.

- Machine-readable schema and runtime validator:
  [`../src/perf/types.ts`](../src/perf/types.ts)
- Producer: [`../src/perf/audit.ts`](../src/perf/audit.ts)
- Capture: [`../src/perf/observe.ts`](../src/perf/observe.ts)
- Configuration: `thresholds.maxTransferredBytes`, and optionally `perf.pages`

## The design rule

**A budget is not a defect, and it is not a field on `defect.v1`.** A defect exists
because a test failed; a page can double in weight while every test stays green, and
that case is the entire reason this dimension exists. Binding the two would make
every measurement look like a failure.

## Producing artifacts

```json
"thresholds": { "maxTransferredBytes": 20000 },
"perf": { "pages": ["/", "/docs", "/contact"] }
```

`thresholds.maxTransferredBytes` turns the dimension on. `perf.pages` is optional:
naming pages holds the budget against exactly those, and omitting it holds the budget
against every page the run actually loaded. Empty is refused, because omitting the
list already means "every page" and one spelling must not mean two things.

The fixture is declared `auto`, so no test has to ask for the measurement: every test
that loads a page records what the page cost, and the collector writes
`perf-audit.v1` under `artifacts/perf/<runId>/`.

The collector exits `1` when a budget was breached, and prints one line per breach.
Two verdicts live in the run summary and are reported apart:

| Field          | Question it answers                   |
| -------------- | ------------------------------------- |
| `summary.gate` | did the **tests** hold the thresholds |
| `summary.perf` | did the **pages** hold the budget     |

`summary.gate` keeps its published meaning. Folding budget breaches into it would
change the _meaning_ of an existing field, which the versioning rule calls a major
change and a `v2` file.

## Rules a consumer can rely on

1. **The figure is the network layer's own count**, `transferSize` from Resource
   Timing, never a sum of response bodies. Measured 2026-10-18 on the demo pages:
   `transferSize` gave **3 922 bytes with a spread of 0** across five runs, while
   summing bodies gave 1 704 and 2 101 on the _same_ page — because the engine does
   not always hand a body over. A metric whose value depends on the browser's
   cooperation is not a metric to gate on.
2. **The verdict is the largest load, never an average.** A page that is usually fine
   is what a regression looks like, and a mean would pass four small loads and one
   enormous one.
3. **A declared page nothing loaded is a violation** of its own kind,
   `no-observation`. Fail-closed, on the same principle as the API dimension: a page
   the project said the budget held, and nobody measured, has not been passed. Kept
   separate from `over-budget` because the reader's next question differs — _did it
   get heavier, or did nobody look_. A page list the project omitted has no declared
   pages, so it cannot produce this violation; its budgets are the pages the run
   actually loaded.
4. **A run with no capture at all is neither clean nor failed.** `summary.perf.ran`
   is false and the collector prints `NOT RUN`; fail-closed applies from the first
   capture onward. With no page list the audit then holds no budgets at all; with a
   declared list it records `no-observation` for each, but `NOT RUN` is the verdict
   because no claim about a page was ever made.
5. **A reading is of the page as it stands, not of the history.** Once the browser
   has navigated away, it can no longer say what the previous page cost, so a test
   that visits two pages measures at each.
6. **Values are integers and nothing is averaged, trimmed or rounded** into the
   artifact.
7. **`counts.violations` equals the number listed, and paths are unique.** Both are
   enforced by the runtime validator rather than the JSON Schema, which cannot tie a
   property to the length of a sibling array nor compare objects by one key.
8. **`baseUrl` is an origin or it is absent.** Never a path or a query string: those
   carry tokens.
9. **No gate lives here.** The artifact is evidence; the verdict is a run-level
   statement and belongs to the run summary, which already has one.

## Which pages a budget holds

There are two modes, and the difference is what a missing measurement means.

| `perf.pages` | Pages held                | A page nobody measured                      |
| ------------ | ------------------------- | ------------------------------------------- |
| named        | exactly the named pages   | `no-observation`, a violation               |
| omitted      | every page the run loaded | cannot arise: the budget is what was loaded |

**Named is the fail-closed mode.** The project has said the budget applies to `/`,
`/docs` and `/contact`; if a test stops visiting one, that is a finding, not a
smaller audit.

**Omitted is the dimension's declaration.** Setting
`thresholds.maxTransferredBytes` is already a statement that page weight matters.
Requiring a second list of routes would make an application's first budget fail
because the consumer did not repeat a list the tool never asked for — measured on
2026-10-19 in the external live run, where a project outside this repository got
`no-observation` for three hard-coded pages it had never declared.

**An empty list is refused**, not treated as either mode. `"pages": []` would
otherwise mean "nothing is held" and "everything is held" depending on which code
path read it, and a configuration error should be visible at load.

**This repository names three pages and omits `/heavy`.** The demo server keeps that
page to breach a budget, and a fixture cannot both contain an over-budget page and
pass its own budget. The heavy page is proved by the test that measures it; the
three real pages are gated.

## What is deliberately not in this artifact

**The loads themselves.** A list of successful page loads is evidence about nothing.
What is kept is the largest measurement per path, the budget it was held to, and the
violations.

## Reading artifacts from an agent

The MCP server serves them over the fourth root, `--perf-root` (default
`artifacts/perf`, when that directory exists):

| Tool                       | Answers                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `quality_list_perf_audits` | what this project has written, with `budgets`, `tests`, `pages`, `violations` and `passed` per run |
| `quality_get_perf_audit`   | one run in full: every declared budget, what each page cost, and its violations                    |

`tests: 0` means **the dimension never ran**, and both tools say so in words rather
than printing a zero.

## Known gaps

- **This repository's own CI does not exercise a real breach end to end.** The demo
  server keeps `/heavy` precisely to breach a budget, so a budget that held it could
  only ever fail — proved by CI going red on all three browser legs when the budget
  was switched on. `/heavy` is therefore excluded by `perf.pages` in
  `config/project.json` and proved by the test that measures it, which means the
  collector runs against a genuine breach only in `tests/unit/api-gate.test.ts`, with
  a synthetic report. A fixture that quietly sat under its own budget would have made
  the red half of the criterion untestable.
- **Timing was measured and not budgeted.** It separates a real regression 5.7-fold
  (70 ms → 401 ms), but its noise grows with the machine — spread 4 ms idle, 39 ms
  with four CPUs busy. A budget there would need a wide margin, and the margin would
  be the number nobody could argue about. A budget that can fail for two reasons is
  worth less than a second budget that can fail for one.
