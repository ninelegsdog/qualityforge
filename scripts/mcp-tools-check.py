#!/usr/bin/env python3
"""
Drive the MCP server over real stdio and check the data path and confinement.

The session check proves the envelope. This one proves the tools answer with
real data, and that the path boundary holds as a client experiences it — over a
pipe, through the tool interface, not just by calling a function.

Usage: python3 scripts/mcp-tools-check.py [project-root]
Requires artifacts: run `npm test && npm run defects:collect` first.
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

BASE = [
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
]


def run(requests):
    payload = "".join(json.dumps(r) + "\n" for r in requests)
    proc = subprocess.run(
        ["npx", "tsx", "src/mcp/index.ts"],
        input=payload,
        capture_output=True,
        text=True,
        cwd=ROOT,
        timeout=180,
    )
    frames, corrupt = {}, []
    for line in proc.stdout.split("\n"):
        if not line.strip():
            continue
        try:
            frame = json.loads(line)
            frames[frame.get("id")] = frame
        except json.JSONDecodeError:
            corrupt.append(line)
    return frames, corrupt, proc.returncode


frames, corrupt, code = run(BASE)

problems = []
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
    # An error message can end up in a transcript or a model prompt, so it must
    # not describe the filesystem.
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

if defect_path:
    followup = [
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "quality_get_defect", "arguments": {"defectPath": defect_path}},
        }
    ]
    frames2, corrupt2, _ = run(followup)
    if corrupt2:
        problems.append(f"{len(corrupt2)} corrupt line(s) on the follow-up call")
    got = frames2.get(7)
    if not got or "result" not in got:
        problems.append("reading the listed defectPath failed")
    else:
        sc = got["result"].get("structuredContent") or {}
        print(f"defect read back: id={sc.get('id')} has_signals={'signals' in sc}")
        if not sc.get("id"):
            problems.append("defect returned without an id")
        if "failure" not in sc:
            problems.append("defect returned without failure detail")

print()
if problems:
    print(f"FAIL: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

print("OK: tools answer with real data, all three traversal shapes refused with -32602")