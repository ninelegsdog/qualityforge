#!/usr/bin/env python3
"""
Drive the MCP server over real stdio and check the protocol envelope.

This is what unit tests cannot check. Spawning the process proves the transport
works, that stdout carries JSON-RPC frames and nothing else, that a stray log
line would surface as a corrupt frame, and that responses really arrive over a
pipe.

Usage: python3 scripts/mcp-session-check.py [project-root]

It also drives the 2026-07-28 path the way a client does, with the `_meta`
envelope attached to every request: that revision makes the envelope mandatory
and expects one in the answer, and neither was previously sent here.

Self-seeding, like the tools check: it produces its own failing run with the
project's own evidence-pipeline spec, in a temporary directory, and serves that.
It therefore behaves the same on a clean checkout and on a green commit, instead
of reporting eight protocol symptoms for what is really a missing directory.
"""
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import evidence_seed  # noqa: E402  (needs the path above)

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

SCRATCH, SEEDED_ROOT, seed_problems = evidence_seed.seed(ROOT)
if seed_problems:
    print(evidence_seed.describe(SCRATCH, SEEDED_ROOT))
    print(f"FAIL: {len(seed_problems)} problem(s)")
    for problem in seed_problems:
        print(f"  - {problem}")
    print(f"  seeded artifacts kept at {SCRATCH}")
    sys.exit(1)

print(evidence_seed.describe(SCRATCH, SEEDED_ROOT))
print()

# --- The 2026-07-28 `_meta` envelope ---------------------------------------
#
# These shapes are not invented for the test. They are what the protocol
# implementation inside the OpenCode 2.0.16 binary uses: its
# RequestMetaEnvelopeSchema makes io.modelcontextprotocol/protocolVersion and
# io.modelcontextprotocol/clientCapabilities mandatory on every request of that
# revision, and its ResultMetaSchema carries
# io.modelcontextprotocol/serverInfo on results. A client speaking 2026-07-28
# therefore never sends a bare tools/list, and it rejects an answer whose result
# has no `_meta` at all.
#
# Nothing here sent either shape until now, which is how the modern path stayed
# unimplemented while every check passed.
MODERN = "2026-07-28"
LEGACY = "2025-11-25"
META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

# -32022 is the MCP-reserved code for a protocol revision that cannot be served;
# -32602 is Invalid Params, which is what the client itself answers for a
# malformed envelope.
UNSUPPORTED_PROTOCOL_VERSION = -32022
INVALID_PARAMS = -32602


def envelope(client_capabilities: dict | None = None) -> dict:
    """The `_meta` a 2026-07-28 client attaches to every request."""
    return {
        META_PROTOCOL_VERSION: MODERN,
        META_CLIENT_CAPABILITIES: {} if client_capabilities is None else client_capabilities,
    }


REQUESTS = [
    {"jsonrpc": "2.0", "id": 1, "method": "server/discover"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    {"jsonrpc": "2.0", "id": 3, "method": "resources/list"},
    {"jsonrpc": "2.0", "id": 4, "method": "prompts/list"},
    {"jsonrpc": "2.0", "id": 5, "method": "quality_get_latest_run_probe"},
    {
        "jsonrpc": "2.0",
        "id": 6,
        "method": "tools/call",
        "params": {"name": "quality_list_failures", "arguments": {}},
    },
    {"jsonrpc": "2.0", "id": 7, "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 8, "method": "does/not/exist"},
    # --- the modern path: envelope in, envelope out ------------------------
    {
        "jsonrpc": "2.0",
        "id": 9,
        "method": "initialize",
        "params": {
            "protocolVersion": MODERN,
            "capabilities": {},
            "clientInfo": {"name": "opencode", "version": "2.0.16"},
            "_meta": envelope(),
        },
    },
    {
        "jsonrpc": "2.0",
        "id": 10,
        "method": "tools/list",
        "params": {"_meta": envelope()},
    },
    # The same call, declared 2026-07-28, with the envelope left off. A server
    # that answers this cannot tell which revision the client is speaking, which
    # is the whole reason the revision exists.
    {
        "jsonrpc": "2.0",
        "id": 11,
        "method": "tools/list",
        "params": {"protocolVersion": MODERN},
    },
    # 2025-11-25 had no envelope. Refusing it would break the legacy path that
    # OpenCode's default "legacy" mode uses.
    {
        "jsonrpc": "2.0",
        "id": 12,
        "method": "tools/list",
        "params": {"protocolVersion": LEGACY},
    },
    # A client that declared subscriptions must be told they are available.
    {
        "jsonrpc": "2.0",
        "id": 13,
        "method": "initialize",
        "params": {
            "protocolVersion": MODERN,
            "capabilities": {},
            "clientInfo": {"name": "opencode", "version": "2.0.16"},
            "_meta": envelope({"subscriptions": {"resources": True}}),
        },
    },
    # A client that declared none must not be offered a subscription it cannot
    # receive: this server implements no subscription method.
    {
        "jsonrpc": "2.0",
        "id": 14,
        "method": "initialize",
        "params": {
            "protocolVersion": MODERN,
            "capabilities": {},
            "clientInfo": {"name": "opencode", "version": "2.0.16"},
            "_meta": envelope(),
        },
    },
    # Envelope present but incomplete: the version is stated and the client
    # capabilities are not, so the revision still cannot be served.
    {
        "jsonrpc": "2.0",
        "id": 15,
        "method": "tools/list",
        "params": {"_meta": {META_PROTOCOL_VERSION: MODERN}},
    },
]

payload = "".join(json.dumps(r) + "\n" for r in REQUESTS)

proc = subprocess.run(
    ["npx", "tsx", "src/mcp/index.ts", "--root", str(SEEDED_ROOT)],
    input=payload,
    capture_output=True,
    text=True,
    cwd=ROOT,
    timeout=180,
)

print("=== exit code ===")
print(proc.returncode)

print("=== stderr (diagnostics only) ===")
for line in [l for l in proc.stderr.strip().split("\n") if l.strip()][:8]:
    print("  " + line)

print()
print("=== stdout frames ===")
frames = []
corrupt = []
for line in proc.stdout.split("\n"):
    if not line.strip():
        continue
    try:
        frames.append(json.loads(line))
    except json.JSONDecodeError:
        corrupt.append(line)

print(f"  {len(frames)} valid frame(s), {len(corrupt)} corrupt")
for bad in corrupt:
    print(f"  CORRUPT: {bad[:100]}")

problems = list(seed_problems)
if proc.returncode != 0:
    problems.append(f"exit code {proc.returncode}, expected 0")
if corrupt:
    problems.append(
        f"{len(corrupt)} stdout line(s) were not valid JSON — stdout carries frames only"
    )

ids = [f.get("id") for f in frames]
# A notification must never be answered.
if 7 in ids:
    problems.append("a notification was answered; notifications must be silent")

missing = {1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15} - set(ids)
if missing:
    problems.append(f"no response for id(s) {sorted(missing)}")

by_id = {f.get("id"): f for f in frames}


def result_of(frame: dict) -> dict:
    """The result object of a successful frame, or {} when there is none."""
    result = frame.get("result")
    return result if isinstance(result, dict) else {}


def check_result_meta(frame: dict, label: str) -> None:
    """Every answer on the modern path must carry `_meta` back to the client."""
    meta = result_of(frame).get("_meta")
    if not isinstance(meta, dict):
        problems.append(f"{label}: the result body has no `_meta` object")
        return
    info = meta.get(META_SERVER_INFO)
    if not isinstance(info, dict):
        problems.append(f"{label}: `_meta` does not carry {META_SERVER_INFO}")
        return
    if not info.get("name") or not info.get("version"):
        problems.append(f"{label}: {META_SERVER_INFO} is incomplete: {info}")


def resources_capability(frame: dict) -> dict:
    """The `resources` capability of an answer that advertises capabilities."""
    capabilities = result_of(frame).get("capabilities")
    if not isinstance(capabilities, dict):
        return {}
    resources = capabilities.get("resources")
    return resources if isinstance(resources, dict) else {}

disc = by_id.get(1, {}).get("result", {})
if "2026-07-28" not in (disc.get("supportedVersions") or []):
    problems.append("server/discover did not advertise 2026-07-28")

tl = by_id.get(2, {}).get("result", {})
if tl.get("resultType") != "complete":
    problems.append("tools/list result lacks resultType=complete")
if not isinstance(tl.get("ttlMs"), int):
    problems.append("tools/list result lacks an integer ttlMs")
if tl.get("cacheScope") != "private":
    problems.append("tools/list result lacks cacheScope=private")

names = [t.get("name") for t in (tl.get("tools") or [])]
expected = ["quality_get_latest_run", "quality_list_failures", "quality_get_defect"]
if names != expected:
    problems.append(f"unexpected tool list: {names}")
print(f"  tools: {names}")

if by_id.get(8, {}).get("error", {}).get("code") != -32601:
    problems.append("unknown method did not return -32601")

# --- the modern path: 2026-07-28 requires the envelope, and answers with it --
modern_init = by_id.get(9, {})
if "error" in modern_init:
    problems.append(f"initialize with a {MODERN} envelope failed: {modern_init['error']}")
elif result_of(modern_init).get("protocolVersion") != MODERN:
    problems.append(
        f"initialize with a {MODERN} envelope answered "
        f"{result_of(modern_init).get('protocolVersion')!r}, expected {MODERN!r}"
    )
check_result_meta(modern_init, "initialize")

modern_tools = by_id.get(10, {})
if "error" in modern_tools:
    problems.append(f"tools/list with a {MODERN} envelope failed: {modern_tools['error']}")
elif not result_of(modern_tools).get("tools"):
    problems.append(f"tools/list with a {MODERN} envelope returned no tools")
check_result_meta(modern_tools, f"tools/list with _meta")

missing_envelope = by_id.get(11, {}).get("error", {}).get("code")
if missing_envelope != UNSUPPORTED_PROTOCOL_VERSION:
    problems.append(
        f"tools/list declaring {MODERN} with no `_meta` answered {missing_envelope}, "
        f"expected {UNSUPPORTED_PROTOCOL_VERSION}: the envelope is mandatory on "
        f"this revision and must not be served silently"
    )

legacy_tools = by_id.get(12, {})
if "error" in legacy_tools or not result_of(legacy_tools).get("tools"):
    problems.append(
        f"tools/list declaring {LEGACY} with no `_meta` was refused; "
        "the pre-envelope revision must keep working"
    )
check_result_meta(legacy_tools, f"tools/list declaring {LEGACY}")

declared = resources_capability(by_id.get(13, {}))
if declared.get("subscribe") is not True:
    problems.append(
        f"a client that declared subscriptions was not offered them: resources={declared}"
    )

undeclared = resources_capability(by_id.get(14, {}))
if undeclared.get("subscribe"):
    problems.append(
        f"subscribe was advertised to a client that declared no subscriptions: "
        f"resources={undeclared}"
    )

incomplete = by_id.get(15, {}).get("error", {}).get("code")
if incomplete != INVALID_PARAMS:
    problems.append(
        f"an envelope carrying the version but no clientCapabilities answered "
        f"{incomplete}, expected {INVALID_PARAMS}"
    )

print(
    f"  envelope: with `_meta` served, without it {missing_envelope}, "
    f"incomplete {incomplete}, {LEGACY} served"
)
print(
    f"  subscriptions: declared -> {declared.get('subscribe')!r}, "
    f"undeclared -> {undeclared.get('subscribe')!r}"
)

print()
if problems:
    print(f"FAIL: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    # Keep the scratch directory on failure: it holds the seeded artifacts,
    # which is what the failure is about. A green run cleans up after itself.
    print(f"  seeded artifacts kept at {SCRATCH}")
    sys.exit(1)

evidence_seed.discard(SCRATCH)
print(
    "OK: clean stdio session — frames only on stdout, all responses delivered, "
    "envelope required and answered on 2026-07-28, legacy path intact"
)