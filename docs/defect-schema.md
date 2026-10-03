# Defect artifact v1

A defect artifact is one normalized failure, written per run, designed to be
read by a human or handed to an agent without further interpretation.

- Machine-readable schema: [`../schemas/defect.v1.schema.json`](../schemas/defect.v1.schema.json)
- Runtime types and validator: [`../src/defect/types.ts`](../src/defect/types.ts)
- Producer: [`../src/defect/collect.ts`](../src/defect/collect.ts)

## The design rule

**This artifact extends Playwright's `error-context.md`; it does not duplicate
it.**

On every failure, Playwright already writes a markdown file whose content is
phrased as an instruction to an assistant — "explain why, be concise, respect
best practices" — followed by the test name, the file and line, the error, the
expected versus received values, and a page snapshot.

Parsing prose written for a human reader would be the most fragile link in this
entire pipeline. So the artifact records a path to that file and adds only what
it cannot carry:

| Added here                         | Why it cannot live in `error-context.md`                       |
| ---------------------------------- | -------------------------------------------------------------- |
| `id`                               | Needs to be stable across runs so history can be joined        |
| `runId`                            | Groups every defect from one execution                         |
| `context.commit`, `context.branch` | Version context is not the runner's business                   |
| `context.baseUrl`                  | Reduced to an origin; the runner records the full value        |
| `evidence.*`                       | Machine-readable pointers rather than a human-readable list    |
| `flakiness`                        | Requires reasoning across attempts, which the file does not do |
| `retryHistory`                     | Same                                                           |

## Producing artifacts

```bash
npm test                    # writes artifacts/json/playwright-results.json
npm run defects:collect     # writes artifacts/defects/<runId>/
```

```
artifacts/defects/2026-10-03T00-43-13-217Z-443909/
├── form-validation-smoke-shows-an-error-when-email-is-empty.v1.json
├── form-validation-smoke-shows-an-error-when-email-is-malformed.v1.json
├── quality-summary.v1.json
└── ...
```

`npm run defects:collect` exits `0` when the quality gate passes, `1` when it
fails, and `2` when collection itself could not run. That makes it usable
directly as a CI step.

```bash
npm run defects:collect -- --json    # machine-readable summary on stdout
```

## Shape

```jsonc
{
  "$schema": "https://qualityforge.dev/schemas/defect.v1.schema.json",
  "schemaVersion": "1.0.0",
  "id": "form-validation-smoke-shows-an-error-when-email-is-empty",
  "runId": "2026-10-03T00-43-13-217Z-443909",
  "createdAt": "2026-10-03T00:43:13.217Z",
  "status": "failed",

  "test": {
    "playwrightId": "aa9410a9...",
    "title": "shows an error when email is empty",
    "file": "tests/smoke/form-validation.smoke.spec.ts",
    "line": 15,
    "column": 3,
    "project": "chromium",
  },

  "failure": {
    "message": "Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByRole('alert')\nExpected: \"Email is required\"",
    "location": { "file": "tests/smoke/form-validation.smoke.spec.ts", "line": 18, "column": 43 },
    "snippet": "16 | ...\n> 18 |   await expect(page.getByRole(\"alert\")).toHaveText(\"Email is required\");",
    "stack": "Error: ...",
    "errorContextRef": "test-results/smoke-form-validation.../error-context.md",
  },

  "evidence": {
    "screenshot": "test-results/.../test-failed-1.png",
    "video": "test-results/.../video.webm",
  },

  "context": {
    "baseUrl": "http://127.0.0.1:4311",
    "commit": "43c761f54c3571fab9fd9211539493d6210decea",
    "branch": "main",
    "ci": false,
    "retries": 0,
    "runStartedAt": "2026-10-03T00:42:42.392Z",
    "durationMs": 22573,
  },

  "flakiness": {
    "verdict": "unknown",
    "attempts": 1,
    "passedAttempts": 0,
    "failedAttempts": 1,
  },

  "tags": ["demo", "smoke"],
}
```

## Rules a consumer can rely on

1. **Paths are relative to the project root** and use forward slashes. An
   artifact is portable between machines; an absolute path would not be.
2. **Every `evidence.*` field is optional.** A local run with `retries: 0` has
   no trace, and that is normal, not a defect in the artifact.
3. **Messages contain no terminal colour codes.** Playwright embeds ANSI
   escapes in `error.message`; they are stripped, because they make the
   artifact unreadable to both a person and a model.
4. **`context.baseUrl` is an origin only.** No path, no query string, no
   credentials. A base URL carrying a token must never be committed.
5. **Nothing secret is ever recorded.** No environment values, no credentials.
   The configuration loader rejects a `baseUrl` that contains any of those, so
   the mistake is caught at the source rather than at the sink.
6. **An unknown status fails closed.** A status the collector does not
   recognise becomes `failed`, never `passed`.
7. **`flakiness.verdict` may be `unknown`.** One attempt is not evidence of a
   pattern. Claiming `failing` from a single observation would be a guess
   dressed up as a verdict.
8. **`errorContextRef` may be absent** when `defects.referenceErrorContext` is
   false in configuration.

## Versioning

`schemaVersion` is semantic. The file name carries `v1` to match.

- Adding an optional field: minor bump.
- Removing a field, renaming one, or changing a type or meaning: major bump,
  and the file suffix changes to `v2`.

Consumers should ignore unknown fields. A minor bump must never break a reader.

## Validation

Two layers, deliberately:

- `schemas/defect.v1.schema.json` is the published contract, for consumers and
  for editors. It uses JSON Schema 2020-12, matching what MCP 2026-07-28
  requires of `inputSchema` and `outputSchema`.
- `validateDefect()` in `src/defect/types.ts` is what the producer runs. It is
  hand-written to keep the project dependency-free and to produce messages a
  person can act on. The collector validates every artifact it is about to
  write, so an invalid artifact fails the run rather than landing on disk.

## Related

- [`architecture.md`](architecture.md) — where this fits in the flow
- [`selectors-and-testid.md`](selectors-and-testid.md)
- [`../AGENTS.md`](../AGENTS.md) — rules for agents working in this repo
