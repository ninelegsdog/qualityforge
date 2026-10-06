#!/usr/bin/env python3
"""
Cross-check what this server advertises against the schema in the client binary.

Issue #12 asked whether the advertised capabilities are the 2026-07-28 shape.
The answer shipped in edb1eb0 (0.1.0-alpha.1): the shape was never pre-2026 —
the `ServerCapabilitiesSchema` in the OpenCode 2.0.16 binary is all-optional
and still contains `listChanged` under tools/resources/prompts — and the one
lie that did exist, `resources.subscribe`, was removed. The unit tests pin our
emission against that schema... quoted into the test file.

A quotation is the weak point. `dispatch.test.ts` asserts our output against a
schema written down by the same reader who believed issue #12; agreement
between a check and a hand-copied expectation is evidence about the copy, not
about the client. This script closes that gap by reading the real binary: it
extracts the server capabilities schema from the `opencode` executable on this
machine and fails if this server advertises a member (or nested key) the
client's schema does not contain.

What it does not check: whether the client *rejects* unknown members (zod may
strip rather than error — the claim here is only "we are inside the schema"),
and anything about members the schema offers that we leave unadvertised; every
member is optional, so absence is always truthful. The three members the
client gates its methods on are asserted by `mcp:check` and by the unit tests.

Environment: needs the client binary on PATH (or `OPENCODE_BIN`), which is why
this is not in CI yet — CI has no OpenCode. E3 ("a live client in CI") installs
a pinned version; this check joins that job when it lands. Until then it is
required locally, the way `board:check` is, and `OPENCODE_BIN` exists so the
extraction itself can be given something that fails.

Usage: python3 scripts/capabilities-schema-check.py [project-root]
Exit:  0 the advertisement is inside the extracted schema, 1 otherwise.
"""
import datetime
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

MODERN = "2026-07-28"
META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"

# Members the server schema must contain for the extraction to be the server's
# and not the client's `ClientCapabilitiesSchema` (which has sampling and
# elicitation where this one has logging and completions).
SERVER_MARKERS = {"logging", "completions", "prompts", "resources", "tools"}

problems = []


def fail(msg: str) -> None:
    problems.append(msg)


# --- locate the client binary ------------------------------------------------
binary = os.environ.get("OPENCODE_BIN") or shutil.which("opencode")
if not binary:
    sys.exit(
        "FATAL: no opencode binary (PATH or OPENCODE_BIN). This check compares "
        "against the real client; guessing the schema is what it exists to avoid."
    )

try:
    version_run = subprocess.run(
        [binary, "--version"], capture_output=True, text=True, timeout=30
    )
    version = (version_run.stdout or version_run.stderr).strip() or "<no version>"
except (OSError, subprocess.SubprocessError) as exc:
    sys.exit(f"FATAL: {binary} --version failed: {exc}")

try:
    data = pathlib.Path(binary).read_bytes()
except OSError as exc:
    sys.exit(f"FATAL: cannot read {binary}: {exc}")


# --- extract the ServerCapabilitiesSchema literal ----------------------------
def balanced_object(blob: bytes, brace_pos: int) -> str | None:
    """The object literal starting at brace_pos, brace-balanced."""
    depth = 0
    k = brace_pos
    while k < len(blob):
        c = blob[k : k + 1]
        if c == b"{":
            depth += 1
        elif c == b"}":
            depth -= 1
            if depth == 0:
                return blob[brace_pos : k + 1].decode("utf-8", "replace")
        k += 1
    return None


def top_keys(obj: str) -> list[str]:
    """Keys at depth 1 of an object literal, skipping strings."""
    keys: list[str] = []
    depth = 0
    i = 0
    n = len(obj)
    while i < n:
        c = obj[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c in "\"'`":
            quote = c
            i += 1
            while i < n and obj[i] != quote:
                if obj[i] == "\\":
                    i += 1
                i += 1
        elif depth == 1:
            j = i
            name = ""
            while j < n and (obj[j].isalnum() or obj[j] in "_$"):
                name += obj[j]
                j += 1
            if name and j < n and obj[j] == ":":
                keys.append(name)
                i = j
        i += 1
    return keys


def value_object(obj: str, key: str) -> str | None:
    """The `{...}` value of a depth-1 key, if it has one."""
    depth = 0
    i = 0
    n = len(obj)
    while i < n:
        c = obj[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif depth == 1 and obj.startswith(key + ":", i):
            brace = obj.find("{", i + len(key) + 1)
            if brace == -1:
                return None
            depth2 = 0
            k = brace
            while k < n:
                if obj[k] == "{":
                    depth2 += 1
                elif obj[k] == "}":
                    depth2 -= 1
                    if depth2 == 0:
                        return obj[brace : k + 1]
                k += 1
            return None
        i += 1
    return None


schema_obj: str | None = None
start = 0
while True:
    i = data.find(b"experimental:", start)
    if i == -1:
        break
    start = i + 1
    if i > 0 and data[i - 1 : i] == b"{":
        candidate = balanced_object(data, i - 1)
        if candidate and SERVER_MARKERS <= set(top_keys(candidate)):
            schema_obj = candidate
            break

if schema_obj is None:
    sys.exit(
        f"FATAL: the ServerCapabilitiesSchema literal was not found in {binary} "
        f"({version}). Either the extraction anchor moved with a new client "
        "release — re-examine the binary before trusting anything here — or "
        "OPENCODE_BIN points at something that is not this client."
    )

schema_members = top_keys(schema_obj)
schema_nested = {
    m: top_keys(value_object(schema_obj, m) or "")
    for m in ("prompts", "resources", "tools")
    if value_object(schema_obj, m)
}

# --- what this server actually advertises ------------------------------------
REQUESTS = [
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": MODERN,
            "capabilities": {},
            "clientInfo": {"name": "schema-check", "version": "1"},
            "_meta": {
                META_PROTOCOL_VERSION: MODERN,
                META_CLIENT_CAPABILITIES: {},
            },
        },
    },
    {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "server/discover",
        "params": {"_meta": {META_PROTOCOL_VERSION: MODERN, META_CLIENT_CAPABILITIES: {}}},
    },
]
payload = "".join(json.dumps(r) + "\n" for r in REQUESTS)

with tempfile.TemporaryDirectory(prefix="capability-schema-") as scratch:
    root = pathlib.Path(scratch)
    (root / "artifacts" / "defects").mkdir(parents=True)
    try:
        proc = subprocess.run(
            ["npx", "tsx", "src/mcp/index.ts", "--root", str(root)],
            input=payload,
            capture_output=True,
            text=True,
            cwd=ROOT,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        sys.exit(f"FATAL: spawning the server failed: {exc}")

answers: dict[int, dict] = {}
for line in proc.stdout.split("\n"):
    if not line.strip():
        continue
    try:
        frame = json.loads(line)
    except json.JSONDecodeError:
        fail(f"stdout carried a frame that is not JSON: {line[:120]!r}")
        continue
    if isinstance(frame.get("id"), int):
        answers[frame["id"]] = frame

for req_id, label in ((1, "initialize"), (2, "server/discover")):
    frame = answers.get(req_id, {})
    if "error" in frame or "result" not in frame:
        fail(f"{label} did not answer with a result: {frame.get('error', 'no frame')}")
        continue
    advertised = frame["result"].get("capabilities")
    if not isinstance(advertised, dict):
        fail(f"{label} answered no capabilities object")
        continue

    for member, value in advertised.items():
        if member not in schema_members:
            fail(
                f"{label} advertises `{member}`, which the client's "
                f"ServerCapabilitiesSchema in {version} does not contain "
                f"(schema members: {schema_members})"
            )
            continue
        if isinstance(value, dict):
            known = schema_nested.get(member, [])
            for key in value:
                if known and key not in known:
                    fail(
                        f"{label} advertises `{member}.{key}`; the schema allows "
                        f"{member} to carry only {known}"
                    )
    print(f"  {label}: {json.dumps(advertised, sort_keys=True)}")

# --- report ------------------------------------------------------------------
absent = [m for m in schema_members if m not in (answers.get(1, {}).get("result", {}).get("capabilities") or {})]
print(f"  client:    {version}")
print(f"  schema:    {schema_members} (nested: {schema_nested})")
print(f"  date:      {datetime.date.today().isoformat()}")
if absent:
    print(f"  optional members we do not advertise (truthful absence): {absent}")

if problems:
    print(f"FAIL: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

print(
    "OK: everything advertised is inside the schema extracted from the client "
    "binary"
)
