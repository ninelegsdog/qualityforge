# API audit artifact v1

One run's verdict on the API contracts a project declared, shaped before it is
written so that an agent can read it without interpreting a capture first.

- Machine-readable schema:
  [`../schemas/api-audit.v1.schema.json`](../schemas/api-audit.v1.schema.json)
- Runtime types and validator: [`../src/api/types.ts`](../src/api/types.ts)
- Producer: [`../src/api/audit.ts`](../src/api/audit.ts)
- Capture: [`../src/api/observe.ts`](../src/api/observe.ts)
- Configuration: the `api.expectations` block of
  [`quick-start.md`](quick-start.md)'s `config/project.json`

## The design rule

**A contract is not a defect, and it is not a field on `defect.v1`.**

A defect artifact exists because a test failed. A contract can break without any
test failing — an endpoint that stops answering is exactly the case this dimension
exists to catch — so binding the two would make every audit look like a failure
and would put a recurring measurement on a schema that promises "one normalized
failure". The owner's decision of 2026-10-16.

## Producing artifacts

```bash
# Declared in config/project.json; captured automatically by the fixture, because
# the `api` fixture is declared `auto` and no test has to ask for it.
QUALITYFORGE_THIRD_PARTY=1 npx playwright test tests/smoke/third-party
npm run defects:collect
```

The artifact lands at `artifacts/api/<runId>/api-audit.v1.json` — a **sibling** of
the defects directory, not a subdirectory of it. Rule 14 of
[`defect-schema.md`](defect-schema.md) reserves a run directory for one artifact
per failure, and an audit is not a failure.

The collector exits `1` when the contract failed, and prints one line per
violation. Two verdicts live in the run summary and are reported apart:

| Field          | Question it answers                   |
| -------------- | ------------------------------------- |
| `summary.gate` | did the **tests** hold the thresholds |
| `summary.api`  | did the **contracts** hold            |

`summary.gate` keeps its published meaning, and the two are combined in exactly
one place — the exit code. A run passes when `gate.passed` holds and `api` is
absent or carries no violations.

## What a declaration can assert

```json
{
  "name": "items-are-json",
  "method": "GET",
  "path": "/api/items",
  "status": 200,
  "contentType": "application/json",
  "requestRequires": ["email"],
  "responseRequires": ["[0].id", "[0].name"]
}
```

An expectation names one **exchange** and may assert four things about it. There is
no `optional`: an expectation nothing matched is a violation, not an absence —
the owner's decision, and the reason a config entry here cannot quietly stop
applying.

**Field paths carry indices**, because the demo app's only JSON response is an
array and a grammar that could only name object keys would say nothing about it.
`[0].id` is how you state "the first item has an id". Wildcards and path templates
are deliberately absent: `[]` is a different claim from `[0]` and belongs to a
test, and `/users/{id}` would let a matcher pass on a request the application
never meant to make.

## Rules a consumer can rely on

1. **Values never survive a body.** The audit records the declared paths a body did
   **not** carry. The paths it did carry are not recorded at all: the declared
   list is in the configuration, and two copies of one list are two things to
   drift. Nothing in this artifact holds a field value from either direction.
2. **A body that could not be walked makes every declared path missing.** Not
   "unknown" — unknown would let an expectation pass on a response nobody could
   check. `responseKind` records _why_, so a failure can say "the body was not
   JSON" instead of implying a missing field.
3. **Exchanges the cap refused are a violation of their own**
   (`exchanges-dropped`). A capture that examined 40 of 50 exchanges has not proved
   the other ten, and a verdict that acted as though it had would be a claim about
   traffic nobody looked at.
4. **Violations are deduplicated.** Fifty exchanges with the wrong status are one
   finding about fifty exchanges, and `expected`/`observed` still name the range.
5. **Two kinds of exchange are observed but not judged.** One a test broke on
   purpose (`markStubbed()`), and one whose response had not arrived when the test
   finished (`pending`). Both are counted and recorded; neither is evidence about
   the application's contract.
6. **No gate lives here.** The artifact is evidence; the gate is a run-level
   verdict and belongs to the run summary, which already has one.
7. **There is no gate field, and `gate` in the summary did not move.** Folding
   violations into `summary.gate` would have changed the _meaning_ of an existing
   field, which the versioning rule calls a major change and a `v2` file.
8. **`counts.violations` equals the number listed, and names are unique.** Both are
   enforced by the runtime validator rather than the JSON Schema, which cannot tie
   a property to the length of a sibling array nor compare objects by one key.
9. **`baseUrl` is an origin or it is absent.** Never a path or a query string: those
   carry tokens.

## What is deliberately not in this artifact

**The exchanges themselves.** An artifact is read by a language model, and a list
of successful exchanges is evidence about nothing. What is kept is the violations,
each saying what was expected, what was seen, in how many exchanges and how many
tests.

## Known gaps

Three, stated as what a consumer must not assume rather than as promises of a fix.
They are recorded in [`defect-schema.md`](defect-schema.md) as **G18**, **G19** and
**G20**, alongside the gaps of the defect contract, because that is where a
consumer looks for them.

- **G18** — `chromium` does not answer `response.body()` for a POST, so
  `responseRequires` cannot be relied on there. Measured on all three engines:
  every GET body is readable, and the POST body is readable on firefox and webkit
  but never on chromium while the page stays open. The read is bounded, and an
  expired bound is recorded as `too-late`.
- **G19** — an expectation matches on **path, not origin**. A third party serving
  the same path satisfies it. This is the same gap as **G5** in
  [`defect-schema.md`](defect-schema.md), met from the other side: the origin is
  recorded as observed so a consumer can weigh it, and nothing decides it for them.
- **G20** — an expectation nothing matched cannot say _why_. No page was reached,
  the page stopped calling, or the test skipped: all three look identical, and the
  audit names the contract without naming the cause.
