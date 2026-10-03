#!/usr/bin/env python3
"""
Drive the MCP server over real stdio and check the data path and confinement.

The session check proves the envelope. This one proves the tools answer with
real data, and that the path boundary holds as a client experiences it — over a
pipe, through the tool interface, not just by calling a function.

The 2026-07-28 requests below carry the `_meta` envelope that revision makes
mandatory, and one deliberately omits it: a tool call is not exempt from a rule
that applies to every request, and the tools check is where the data path gets
exercised rather than the tool list.

Self-seeding, deliberately.

This check used to require the operator to run a failing suite first: it listed
defects and failed with "expected at least one defect to list" when the store was
empty. On a clean checkout, or on any green commit, the store is empty by design
and the check went red for a reason that had nothing to do with the MCP server.
CI failed on the first push that actually ran.

It now produces its own evidence, in a temporary directory, using the project's
own evidence-pipeline spec, which fails on purpose. See `evidence_seed.py`, which
`mcp-session-check.py` shares, so both checks behave the same and neither depends
on prior state.

Usage: python3 scripts/mcp-tools-check.py [project-root]
"""
import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import evidence_seed  # noqa: E402  (needs the path above)

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

# --- The 2026-07-28 `_meta` envelope ---------------------------------------
#
# Taken from the protocol implementation inside the OpenCode 2.0.16 binary: that
# revision requires io.modelcontextprotocol/protocolVersion and
# io.modelcontextprotocol/clientCapabilities on every request, so the data path
# below is driven with the envelope a real client sends, and with the envelope
# left off, because a tool call is no exception to the rule.
MODERN = "2026-07-28"
META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

UNSUPPORTED_PROTOCOL_VERSION = -32022


def envelope() -> dict:
    """The `_meta` a 2026-07-28 client attaches to every request."""
    return {META_PROTOCOL_VERSION: MODERN, META_CLIENT_CAPABILITIES: {}}


def run(requests: list[dict], root: pathlib.Path) -> tuple[dict, list, int]:
    """Drive the real server over a real pipe and collect its frames."""
    payload = "".join(json.dumps(r) + "\n" for r in requests)
    proc = subprocess.run(
        ["npx", "tsx", "src/mcp/index.ts", "--root", str(root)],
        input=payload,
        capture_output=True,
        text=True,
        cwd=ROOT,
        timeout=180,
    )
    frames: dict = {}
    corrupt: list = []
    for line in proc.stdout.split("\n"):
        if not line.strip():
            continue
        try:
            frame = json.loads(line)
            frames[frame.get("id")] = frame
        except json.JSONDecodeError:
            corrupt.append(line)
    return frames, corrupt, proc.returncode


def main() -> int:
    scratch, served_root, problems = evidence_seed.seed(ROOT)
    if not os.environ.get(evidence_seed.SHARED_SCRATCH_ENV):
        print(evidence_seed.describe(scratch, served_root))

    if problems:
        print()
        print(f"FAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        print(f"  seeded artifacts kept at {scratch}")
        return 1

    frames, corrupt, code = run(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "quality_get_latest_run", "arguments": {}},
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "quality_list_failures", "arguments": {}},
            },
            # Three shapes of the same escape attempt.
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "quality_get_defect",
                    "arguments": {"defectPath": "../../../../etc/passwd"},
                },
            },
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "quality_get_defect",
                    "arguments": {"defectPath": "%2e%2e%2f%2e%2e%2fetc%2fpasswd"},
                },
            },
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {"name": "quality_get_defect", "arguments": {"defectPath": "/etc/passwd"}},
            },
            {
                "jsonrpc": "2.0",
                "id": 6,
                "method": "prompts/get",
                "params": {"name": "triage_failure", "arguments": {"defectPath": "x/y.v1.json"}},
            },
            # The data path on the modern path: same tool, envelope attached.
            {
                "jsonrpc": "2.0",
                "id": 11,
                "method": "tools/call",
                "params": {
                    "name": "quality_list_failures",
                    "arguments": {},
                    "_meta": envelope(),
                },
            },
            # The same tool, declared 2026-07-28, envelope left off.
            {
                "jsonrpc": "2.0",
                "id": 12,
                "method": "tools/call",
                "params": {
                    "name": "quality_get_latest_run",
                    "arguments": {},
                    "protocolVersion": MODERN,
                },
            },
        ],
        served_root,
    )

    if corrupt:
        problems.append(f"{len(corrupt)} corrupt stdout line(s)")
    if code != 0:
        problems.append(f"exit {code}")

    s1 = (frames.get(1, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not s1.get("runId"):
        problems.append("get_latest_run returned no runId")
    print(f"latest run: {s1.get('runId')}  gate={(s1.get('gate') or {}).get('passed')}")

    s2 = (frames.get(2, {}).get("result", {}) or {}).get("structuredContent") or {}
    defects = s2.get("defects") or []
    print(f"listed failures: {s2.get('total')}")

    defect_path = defects[0].get("defectPath") if defects else None
    if not defects:
        problems.append("expected at least one defect to list")
    elif not defect_path or not defect_path.endswith(".v1.json"):
        # The path handed to a client must be the shape it can hand back.
        problems.append(f"defectPath is not a usable artifact path: {defect_path}")

    for req_id, label in ((3, "dot-dot traversal"), (4, "encoded traversal"), (5, "absolute path")):
        err = frames.get(req_id, {}).get("error")
        if err is None:
            problems.append(f"{label} was NOT refused")
            continue
        if err.get("code") != -32602:
            problems.append(f"{label} refused with {err.get('code')}, expected -32602")
        message = str(err.get("message", ""))
        # An error message can end up in a transcript or a model prompt, so it
        # must not describe the filesystem.
        if "/" in message:
            problems.append(f"{label} error leaks a filesystem path: {message}")

    print(
        f"confinement: traversal={frames.get(3, {}).get('error', {}).get('code')} "
        f"encoded={frames.get(4, {}).get('error', {}).get('code')} "
        f"absolute={frames.get(5, {}).get('error', {}).get('code')}"
    )

    messages = frames.get(6, {}).get("result", {}).get("messages") or []
    if not messages or "quality_get_defect" not in json.dumps(messages):
        problems.append("triage prompt missing or empty")

    # --- the envelope, on the data path -----------------------------------
    enveloped = frames.get(11, {})
    if "error" in enveloped:
        problems.append(f"tools/call with a {MODERN} envelope failed: {enveloped['error']}")
    else:
        structured = (enveloped.get("result") or {}).get("structuredContent") or {}
        if not structured.get("defects"):
            problems.append("tools/call with an envelope returned no defects")
        meta = (enveloped.get("result") or {}).get("_meta")
        if not isinstance(meta, dict) or not isinstance(
            (meta.get(META_SERVER_INFO) or {}).get("name"), str
        ):
            problems.append(f"tools/call result does not carry _meta.{META_SERVER_INFO}")

    without = frames.get(12, {}).get("error", {}).get("code")
    if without != UNSUPPORTED_PROTOCOL_VERSION:
        problems.append(
            f"tools/call declaring {MODERN} with no `_meta` answered {without}, "
            f"expected {UNSUPPORTED_PROTOCOL_VERSION}"
        )

    print(
        f"envelope: tools/call with `_meta` served, without it {without}"
    )

    if defect_path:
        followup = [
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {
                    "name": "quality_get_defect",
                    "arguments": {"defectPath": defect_path},
                    "_meta": envelope(),
                },
            }
        ]
        frames2, corrupt2, _ = run(followup, served_root)
        if corrupt2:
            problems.append(f"{len(corrupt2)} corrupt line(s) on the follow-up call")
        got = frames2.get(7)
        if not got or "result" not in got:
            problems.append("reading the listed defectPath failed")
        else:
            sc = got["result"].get("structuredContent") or {}
            # Absence is the correct result for this seeded run: it asserts a
            # wrong text and a wrong URL, which produce no console output, no
            # page error and no failing response. Per the collector, absent
            # means "not observed", which is not the same as "observed and
            # empty", so there is nothing to assert here.
            print(f"defect read back: id={sc.get('id')} (signals absent: expected)")
            if not sc.get("id"):
                problems.append("defect returned without an id")
            if "failure" not in sc:
                problems.append("defect returned without failure detail")

    print()
    if problems:
        print(f"FAIL: {len(problems)} problem(s)")
        for p in problems:
            print(f"  - {p}")
        # Keep the scratch directory on failure: it holds the seeded artifacts,
        # which is what the failure is about. A green run cleans up after itself.
        print(f"  seeded artifacts kept at {scratch}")
        return 1

    evidence_seed.discard(scratch)
    print(
        "OK: tools answer with real data, all three traversal shapes refused with -32602, "
        f"the {MODERN} envelope required and answered"
    )
    return 0


sys.exit(main())