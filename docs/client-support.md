# Client support for MCP revision 2026-07-28

Status: research record for [issue #6](https://github.com/ninelegsdog/qualityforge/issues/6).
The protocol layer here is hand-written against the spec, so which clients
actually exercise the 2026 revision — and `server/discover` in particular —
decides whether the 2025-11-25 fallback is a bridge or a permanent path.

Two rules govern this document, and `npm run docs:support` enforces both:

1. **No silent cells.** Every cell is one of the tokens defined below. "not
   tested" is a written statement, never an empty cell: silence reads as "does
   not work", and that claim has not been made.
2. **Every row cites an observation.** The `Observation` column names evidence
   items from the [Evidence](#evidence) section, each of which carries the
   command that produced it and the date it was run. A row making any claim
   without such a citation fails the check; a row of all "not tested" must
   cite the recorded decision that says why.

## Support table

| Client          | Connection | `server/discover` | Capabilities form | Checked    | Observation |
| --------------- | ---------- | ----------------- | ----------------- | ---------- | ----------- |
| OpenCode 2.0.16 | connected  | not called        | 2025-11-25        | 2026-10-06 | E1, E2, E3  |
| Kilo Code       | not tested | not tested        | not tested        | 2026-10-03 | E4          |
| MiMo Code       | not tested | not tested        | not tested        | 2026-10-03 | E4          |

Column meanings:

- **Connection** — `connected` means this client completed a stdio session with
  this server (an `initialize` exchange and a status of connected), or
  `not tested`.
- **`server/discover`** — `called` / `not called` during the observed session,
  or `not tested`. `not called` is not `unsupported`: see the notes below for
  what the binary does and does not settle.
- **Capabilities form** — the `initialize` the client produced: the protocol
  revision it requested and whether it attached the 2026 `_meta` envelope.
  `2025-11-25` is the pre-2026 form (no envelope); `2026-07-28` would be the
  revision this repository implements natively; `not tested` otherwise.
- **Checked** — ISO date of the evidence the row rests on.
- **Observation** — `E…` items from the Evidence section. Never empty.

### Notes on the OpenCode row

The observed `initialize` requested `2025-11-25` without a `_meta` envelope, so
the server answered in the 2025 era — the capabilities it saw were the
pre-2026 client shape (`elicitation` form/url, `roots`). The shipped binary
does contain the 2026 machinery: its bundled MCP SDK lists `server/discover` as
a request method gated to era `2026-07-28` (Evidence E3). During the observed
connect the client never sent it (E2), so the table records `not called` and
not a verdict. What would settle it: a session where the client requests the
2026 revision — that is [issue #12](https://github.com/ninelegsdog/qualityforge/issues/12),
about the capabilities form this _server_ advertises.

### Notes on the Kilo and MiMo rows

Out of scope by the decision of 2026-10-03 (Kilo and MiMo are not supported;
the research note behind it is internal to this project's vault). The rows say
`not tested` deliberately: a reader must not take silence for "does not work",
and must not take this table for a claim of support.

## Evidence

- **E1** — connect, **2026-10-06**: in a fresh directory (`git init`, an
  `opencode.json` naming this server) run `opencode mcp list` →
  `✓ qualityforge  connected`, `opencode --version` → `opencode v2.0.16`.
- **E2** — stdio wire capture, **2026-10-06**: the same connect with the
  server's stdin/stdout passing through a line-tagging proxy. Frames observed,
  in order: client `initialize` (`protocolVersion 2025-11-25`, no `_meta`
  envelope, `clientInfo cli 2.0.16`), server response (negotiated
  `2025-11-25`, `serverInfo qualityforge-mcp 0.1.0-alpha.1`),
  `notifications/initialized`, `tools/list`, `prompts/list`, `resources/list`,
  `resources/templates/list`. No `server/discover` frame in either direction.
- **E3** — binary, **2026-10-06**:
  `strings -n 12 "$(readlink -f "$(which opencode))" | grep -c server/discover`
  → `6`, and the SDK's request registry maps `server/discover` to
  `era:"2026-07-28"`.
- **E4** — decision, **2026-10-03**: Kilo and MiMo are out of scope (decision,
  recorded in the project roadmap), so their cells are `not tested` by
  decision rather than by omission.

## Re-checking

Repeat E1–E3 after upgrading the client, update the row and its Checked date,
and keep the old observation only if it still describes a row. The check
(`npm run docs:support`) fails when a cell is empty or off-vocabulary, when a
claiming row loses its citations, or when an "all not tested" row cites no
decision.
