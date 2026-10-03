#!/usr/bin/env python3
"""
Drive the MCP server over real stdio and check the data path and confinement.

The session check proves the envelope. This one proves the tools answer with
real data, and that the path boundary holds as a client experiences it — over a
pipe, through the tool interface, not just by calling a function.

Self-seeding, deliberately.

This check used to require the operator to run a failing suite first: it listed
defects and failed with "expected at least one defect to list" when the store was
empty. On a clean checkout, or on any green commit, the store is empty by design
and the check went red for a reason that had nothing to do with the MCP server.
CI failed on the first push that actually ran.

So the check now produces its own evidence, using the project's own
evidence-pipeline spec, which fails on purpose. Nothing is fabricated: the same
suite, the same collector, the same validation produce these artifacts, and a
deliberately broken collector would still make this check fail.

Nothing is written inside the project. The seed report, the artifacts and the
served root all live in a temporary directory, and Playwright's output directory
is redirected too, because Playwright clears it on every run and would otherwise
delete test-results/ from whatever suite ran before this.

Usage: python3 scripts/mcp-tools-check.py [project-root]
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
SCRATCH = pathlib.Path(tempfile.mkdtemp(prefix="qualityforge-mcp-check-"))
SEED_REPORT = SCRATCH / "playwright-results.json"
SEED_ROOT = SCRATCH / "defects"

problems = []


def note(message: str) -> None:
    print(message)


def seed() -> pathlib.Path:
    """Produce one genuine failing run, isolated from the project's artifacts."""
    env = {
        **os.environ,
        "QUALITYFORGE_EVIDENCE_CHECK": "1",
        "QUALITYFORGE_OUTPUT_DIR": str(SCRATCH / "test-results"),
        "PLAYWRIGHT_JSON_OUTPUT_NAME": str(SEED_REPORT),
        "PLAYWRIGHT_HTML_OUTPUT_DIR": str(SCRATCH / "playwright-report"),
    }
    proc = subprocess.run(
        # No --reporter here: a CLI reporter overrides the configured list and
        # would suppress the JSON reporter this script depends on.
        ["npx", "playwright", "test", "tests/smoke/evidence-pipeline.spec.ts"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
    )

    # The spec is supposed to fail. A zero exit means the evidence pipeline
    # stopped producing failures, and then nothing downstream is worth checking.
    if proc.returncode == 0:
        problems.append(
            "the evidence-pipeline spec passed; it is meant to fail, so no evidence "
            "was produced to check the tools against"
        )
    if not SEED_REPORT.exists():
        problems.append(f"the seeded run wrote no JSON report at {SEED_REPORT.name}")
        return SEED_ROOT

    collected = subprocess.run(
        [
            "npm",
            "run",
            "--silent",
            "defects:collect",
            "--",
            "--report",
            str(SEED_REPORT),
            "--out",
            str(SEED_ROOT),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    # Exit 1 means "collected, gate failed". That is the required outcome here:
    # a run that fails 100% of the time must trip the failure-rate gate, and this
    # is the only place the gate is exercised against real data.
    if collected.returncode != 1:
        problems.append(
            f"defects:collect exited {collected.returncode} on a 100%-failing run; "
            "expected 1 (collected, gate failed). The quality gate did not react."
        )

    runs = sorted(SEED_ROOT.glob("*/"))
    if not runs:
        problems.append("the collector wrote no run directory")
    else:
        defects = sorted(p for p in runs[0].glob("*.v1.json") if p.name != "quality-summary.v1.json")
        note(f"seeded {len(defects)} real defect artifact(s) in {runs[0].name}")
        if not defects:
            problems.append("the seeded run produced no defect artifacts")
    return SEED_ROOT


def build_requests(seeded: pathlib.Path) -> list[dict]:
    return [
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


def run(requests: list[dict], root: pathlib.Path) -> tuple[dict, list, int]:
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
    note(f"scratch: {SCRATCH}")
    served_root = seed()

    frames, corrupt, code = run(build_requests(served_root), served_root)

    if corrupt:
        problems.append(f"{len(corrupt)} corrupt stdout line(s)")
    if code != 0:
        problems.append(f"exit {code}")

    s1 = (frames.get(1, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not s1.get("runId"):
        problems.append("get_latest_run returned no runId")
    note(f"latest run: {s1.get('runId')}  gate={(s1.get('gate') or {}).get('passed')}")

    s2 = (frames.get(2, {}).get("result", {}) or {}).get("structuredContent") or {}
    defects = s2.get("defects") or []
    note(f"listed failures: {s2.get('total')}")

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

    note(
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
            note(f"defect read back: id={sc.get('id')} (signals absent: expected)")
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
        print(f"  seeded artifacts kept at {SCRATCH}")
        return 1

    shutil.rmtree(SCRATCH, ignore_errors=True)
    print("OK: tools answer with real data, all three traversal shapes refused with -32602")
    return 0


sys.exit(main())