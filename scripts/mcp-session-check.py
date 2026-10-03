#!/usr/bin/env python3
"""
Drive the MCP server over real stdio and check the protocol envelope.

This is what unit tests cannot check. Spawning the process proves the transport
works, that stdout carries JSON-RPC frames and nothing else, that a stray log
line would surface as a corrupt frame, and that responses really arrive over a
pipe.

Usage: python3 scripts/mcp-session-check.py [project-root]
Requires artifacts: run `npm test && npm run defects:collect` first.
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

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
]

payload = "".join(json.dumps(r) + "\n" for r in REQUESTS)

proc = subprocess.run(
    ["npx", "tsx", "src/mcp/index.ts"],
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

problems = []
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

missing = {1, 2, 3, 4, 5, 6, 8} - set(ids)
if missing:
    problems.append(f"no response for id(s) {sorted(missing)}")

by_id = {f.get("id"): f for f in frames}

disc = by_id.get(1, {}).get("result", {})
if "2026-07-28" not in (disc.get("protocolVersions") or []):
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

print()
if problems:
    print(f"FAIL: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

print("OK: clean stdio session — frames only on stdout, all responses delivered, envelope intact")