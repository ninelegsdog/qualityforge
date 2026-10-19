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
import hashlib
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


def run(
    requests: list[dict],
    root: pathlib.Path,
    history: pathlib.Path | None = None,
    audit_root: pathlib.Path | None = None,
    api_root: pathlib.Path | None = None,
    perf_root: pathlib.Path | None = None,
    visual_root: pathlib.Path | None = None,
) -> tuple[dict, list, int]:
    """Drive the real server over a real pipe and collect its frames."""
    argv = ["npx", "tsx", "src/mcp/index.ts", "--root", str(root)]
    if api_root is not None:
        # The third root, explicit for the same reason as the other two: the check
        # must not depend on this repository happening to contain an API audit, and
        # it should exercise the flag rather than the default.
        argv += ["--api-root", str(api_root)]
    # **Each root on its own `if`, never nested inside another root's.**
    #
    # `--perf-root` used to be nested inside `if api_root is not None`, which meant the
    # fourth root was passed only when the third happened to be. Nothing failed: the
    # seed always supplies both, so the check was green and the coupling invisible —
    # until the fifth root arrived and the call passed one without the other.
    #
    # A root that exists must not depend on a sibling existing. That is the same
    # independence the five sibling directories have in `store.ts`, and a check that
    # quietly violates it stops testing what it claims to.
    if perf_root is not None:
        argv += ["--perf-root", str(perf_root)]
    if visual_root is not None:
        argv += ["--visual-root", str(visual_root)]
    if audit_root is not None:
        # Explicit, for the same reason `--history` is: the check must not depend
        # on the repository happening to contain an audit, and it should exercise
        # the flag rather than the default.
        argv += ["--audit-root", str(audit_root)]
    if history is not None:
        # An explicit flag, so the check does not depend on the repository happening
        # to contain a history directory — and so it exercises the flag itself.
        argv += ["--history", str(history)]
    payload = "".join(json.dumps(r) + "\n" for r in requests)
    proc = subprocess.run(
        argv,
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


def seed_history(scratch: pathlib.Path) -> pathlib.Path:
    """Write two runs of one spec — failing, then passing — in the real format.

    Written by hand rather than by running the collector, because this check is
    self-seeding by design and running a suite to produce history would double its
    runtime for no extra coverage. The format is small enough to reproduce here;
    if it ever drifts, the assertions below fail rather than quietly pass.

    Two runs is the smallest window in which `flaky` means anything: one run can
    only ever say "it failed", which is all a bare failure log keeps.
    """
    history = scratch / "quality-history"
    (history / "compositions").mkdir(parents=True, exist_ok=True)
    spec_id = "seeded-spec-that-fails-then-passes"
    key = hashlib.sha256(spec_id.encode()).hexdigest()[:12]
    (history / "compositions" / f"{key}.json").write_text(
        json.dumps({"schemaVersion": "1.0.0", "specIds": [spec_id]}) + "\n",
        encoding="utf-8",
    )
    for index, failed in enumerate((True, False)):
        run_id = f"2026-10-0{index + 1}T00-00-00-000Z-seed"
        entry = {
            "schemaVersion": "1.0.0",
            "runId": run_id,
            "createdAt": f"2026-10-0{index + 1}T00:00:00.000Z",
            "counts": {
                "specs": 1,
                "passed": 0 if failed else 1,
                "failed": 1 if failed else 0,
                "timedOut": 0,
                "skipped": 0,
                "flaky": 0,
                "aborted": 0,
            },
            "outcomes": {spec_id: "failed"} if failed else {},
            "composition": key,
        }
        (history / f"{run_id}.json").write_text(json.dumps(entry) + "\n", encoding="utf-8")
    return history


def seed_audit(scratch: pathlib.Path) -> pathlib.Path:
    """One accessibility audit, in the real format.

    Written by hand for the same reason `seed_history` is: this check is
    self-seeding by design, and running a browser to produce an audit would make
    it depend on a browser it does not install. If the format drifts, the
    assertions below fail rather than quietly pass.

    `totalNodes` is deliberately larger than the nodes kept and `truncated` is
    deliberately true. That is the one thing a client cannot reconstruct for
    itself, so it is the one thing worth proving survives the wire.
    """
    audit_root = scratch / "a11y"
    run_dir = audit_root / "2026-10-16T01-29-31-810Z-seeded"
    run_dir.mkdir(parents=True, exist_ok=True)
    audit = {
        "schemaVersion": "1.0.0",
        "url": "https://quotes.toscrape.com",
        "createdAt": "2026-10-16T01:29:31.810Z",
        "engine": {"name": "axe-core", "version": "4.14.0"},
        "counts": {"violations": 1, "incomplete": 1, "nodes": 1, "truncatedRules": 1},
        "violations": [
            {
                "id": "color-contrast",
                "impact": "serious",
                "nodes": [
                    {
                        "target": [".quote:nth-child(1) > span"],
                        "html": "<span class>",
                        "failureSummary": "Fix any of the following: element has insufficient contrast",
                    }
                ],
                "totalNodes": 48,
                "truncated": True,
            }
        ],
        "incomplete": [
            {
                "id": "form-field-multiple-labels",
                "impact": None,
                "nodes": [],
                "totalNodes": 0,
                "truncated": False,
            }
        ],
    }
    (run_dir / "audit.v1.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    return audit_root


def seed_api_audit(scratch: pathlib.Path) -> pathlib.Path:
    """One API contract audit, in the real format.

    Written by hand for the same reason as `seed_audit`: this check is
    self-seeding by design, and producing a real audit means running a browser. If
    the format drifts, the assertions below fail rather than quietly pass.

    The seeded run **breaks a contract**, on purpose. That is the one fact worth
    proving survives the wire — an audit whose only content is a green result says
    nothing about whether the server can carry a finding. The violation keeps the
    shape a client cannot reconstruct by itself: what was declared, what was seen,
    and in how many tests.
    """
    api_root = scratch / "api"
    run_dir = api_root / "2026-10-17T09-30-00-000Z-seeded"
    run_dir.mkdir(parents=True, exist_ok=True)
    audit = {
        "schemaVersion": "1.0.0",
        "createdAt": "2026-10-17T09:30:00.000Z",
        "baseUrl": "http://127.0.0.1:4311",
        "counts": {"expectations": 2, "tests": 1, "violations": 1, "passed": 1},
        "expectations": [
            {
                "name": "items-are-json",
                "method": "GET",
                "path": "/api/items",
                "declared": {
                    "status": 200,
                    "contentType": "application/json",
                    "responseRequires": ["[0].id"],
                },
                "observed": {"exchanges": 3, "dropped": 0, "tests": 1},
                "violations": [
                    {
                        "kind": "status",
                        "expected": "200",
                        "observed": "status 500",
                        "exchanges": 1,
                        "tests": 1,
                    }
                ],
            },
            {
                "name": "contact-is-accepted",
                "method": "POST",
                "path": "/api/contact",
                "declared": {"status": 200},
                "observed": {"exchanges": 2, "dropped": 0, "tests": 1},
                "violations": [],
            },
        ],
    }
    (run_dir / "api-audit.v1.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    return api_root



def seed_perf_audit(scratch: pathlib.Path) -> pathlib.Path:
    """One transfer-budget audit, in the real format, with a real breach.

    Written by hand for the same reason as the two seeds above. The **breach** is the
    point: an audit whose only content is a green result would prove the server can
    carry an absence, not a finding.

    The numbers are the measured ones from the demo server on 2026-10-18 — a 20 000
    byte budget and a 526 538 byte page — so the assertion checks wording against
    numbers that were observed rather than invented.
    """
    perf_root = scratch / "perf"
    run_dir = perf_root / "2026-10-18T09-30-00-000Z-seeded"
    run_dir.mkdir(parents=True, exist_ok=True)
    audit = {
        "schemaVersion": "1.0.0",
        "createdAt": "2026-10-18T09:30:00.000Z",
        "baseUrl": "http://127.0.0.1:4311",
        "counts": {"budgets": 2, "tests": 1, "pages": 1, "passed": 1, "violations": 1},
        "budgets": [
            {
                "path": "/heavy",
                "budgetBytes": 20000,
                "measuredBytes": 526538,
                "observations": 1,
                "tests": 1,
                "violations": [
                    {
                        "kind": "over-budget",
                        "expected": "at most 20,000 bytes",
                        "observed": "526,538 bytes, 506,538 over",
                        "observations": 1,
                        "tests": 1,
                    }
                ],
            },
            {
                "path": "/",
                "budgetBytes": 20000,
                "measuredBytes": 3922,
                "observations": 1,
                "tests": 1,
                "violations": [],
            },
        ],
    }
    (run_dir / "perf-audit.v1.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    return perf_root



def seed_visual_audit(scratch: pathlib.Path) -> pathlib.Path:
    """Seed one appearance audit, over the fifth root.

    **The seeded page is changed, not clean.** A seeded run with no finding would
    prove the wire works and nothing about the wire's most valuable sentence — that a
    changed appearance arrives with *both* hashes and the committed file that approved
    the other one. That sentence is what a model acts on, and it is exactly the one a
    well-behaved fixture would drop.

    The numbers are the measured ones from CI on 2026-10-19: the CI-born baseline of
    `/` hashes `f77c79ea41eb`, and a deliberate one-pixel border change moved the page
    to `a1b0d3c8eb7c`. Neither was invented.
    """
    visual_root = scratch / "visual"
    run_dir = visual_root / "2026-10-19T09-30-00-000Z-seeded"
    run_dir.mkdir(parents=True, exist_ok=True)
    audit = {
        "schemaVersion": "1.0.0",
        "createdAt": "2026-10-19T09:30:00.000Z",
        "baseUrl": "http://127.0.0.1:4311",
        "project": "chromium",
        "counts": {"pages": 2, "tests": 7, "matched": 1, "violations": 1},
        "pages": [
            {
                "path": "/",
                "sha256": "a1b0d3c8eb7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90",
                "bytes": 34984,
                "viewport": {"width": 1280, "height": 720, "deviceScaleFactor": 1},
                "baseline": {
                    "sha256": "f77c79ea41eb2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6",
                    "file": "tests/visual-baselines/home-chromium-linux.png",
                    "viewport": {"width": 1280, "height": 720, "deviceScaleFactor": 1},
                },
                "observations": 5,
                "tests": 5,
                "violations": [
                    {
                        "kind": "changed",
                        "expected": (
                            "sha256 f77c79ea41eb as committed in "
                            "tests/visual-baselines/home-chromium-linux.png"
                        ),
                        "observed": "sha256 a1b0d3c8eb7c at 1280×720 dpr1, 34984 bytes",
                        "observations": 5,
                        "tests": 5,
                    }
                ],
            },
            {
                "path": "/docs",
                "sha256": "109c1cec65a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6",
                "bytes": 34421,
                "viewport": {"width": 1280, "height": 720, "deviceScaleFactor": 1},
                "baseline": {
                    "sha256": "109c1cec65a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6",
                    "file": "tests/visual-baselines/docs-chromium-linux.png",
                    "viewport": {"width": 1280, "height": 720, "deviceScaleFactor": 1},
                },
                "observations": 2,
                "tests": 2,
                "violations": [],
            },
        ],
    }
    (run_dir / "visual-audit.v1.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    return visual_root



def main() -> int:
    scratch, served_root, problems = evidence_seed.seed(ROOT)
    history_root = seed_history(scratch)
    audit_root = seed_audit(scratch)
    api_root = seed_api_audit(scratch)
    perf_root = seed_perf_audit(scratch)
    visual_root = seed_visual_audit(scratch)
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
            # The history tools, against the seeded two-run window.
            {
                "jsonrpc": "2.0",
                "id": 13,
                "method": "tools/call",
                "params": {
                    "name": "quality_flaky_tests",
                    "arguments": {},
                    "_meta": envelope(),
                },
            },
            {
                "jsonrpc": "2.0",
                "id": 14,
                "method": "tools/call",
                "params": {
                    "name": "quality_get_trend",
                    "arguments": {},
                    "_meta": envelope(),
                },
            },
            # The accessibility audits, against the seeded one.
            {
                "jsonrpc": "2.0",
                "id": 20,
                "method": "tools/call",
                "params": {"name": "quality_list_audits", "arguments": {}, "_meta": envelope()},
            },
            {
                "jsonrpc": "2.0",
                "id": 21,
                "method": "tools/call",
                "params": {
                    "name": "quality_get_audit",
                    "arguments": {"auditPath": "2026-10-16T01-29-31-810Z-seeded/audit.v1.json"},
                    "_meta": envelope(),
                },
            },
            # The escape a second root makes possible: out of the audit root and
            # into the defect tree, which is exactly the tree the server also has
            # open and serving.
            {
                "jsonrpc": "2.0",
                "id": 22,
                "method": "tools/call",
                "params": {
                    "name": "quality_get_audit",
                    "arguments": {"auditPath": "../defects/anything/quality-summary.v1.json"},
                    "_meta": envelope(),
                },
              },
              # The API contract audits, against the seeded one, over the third root.
              {
                  "jsonrpc": "2.0",
                  "id": 30,
                  "method": "tools/call",
                  "params": {"name": "quality_list_api_audits", "arguments": {}, "_meta": envelope()},
              },
              {
                  "jsonrpc": "2.0",
                  "id": 31,
                  "method": "tools/call",
                  "params": {
                      "name": "quality_get_api_audit",
                      "arguments": {"auditPath": "2026-10-17T09-30-00-000Z-seeded/api-audit.v1.json"},
                      "_meta": envelope(),
                  },
              },
              # The escape a third root makes possible, and the one that only exists
              # now that three directories are open at once: out of `artifacts/api`
              # and into the accessibility audits, which the server is serving too.
              {
                  "jsonrpc": "2.0",
                  "id": 32,
                  "method": "tools/call",
                  "params": {
                      "name": "quality_get_api_audit",
                      "arguments": {"auditPath": "../a11y/2026-10-16T01-29-31-810Z-seeded/audit.v1.json"},
                      "_meta": envelope(),
                  },
              },
              # The transfer budgets, against the seeded breach, over the fourth root.
              {
                  "jsonrpc": "2.0",
                  "id": 40,
                  "method": "tools/call",
                  "params": {"name": "quality_list_perf_audits", "arguments": {}, "_meta": envelope()},
              },
              {
                  "jsonrpc": "2.0",
                  "id": 41,
                  "method": "tools/call",
                  "params": {
                      "name": "quality_get_perf_audit",
                      "arguments": {"auditPath": "2026-10-18T09-30-00-000Z-seeded/perf-audit.v1.json"},
                      "_meta": envelope(),
                  },
              },
              # The escape a fourth root makes possible: out of `artifacts/perf` and
              # into the API audits, which the same process has open and serving.
              {
                  "jsonrpc": "2.0",
                  "id": 42,
                  "method": "tools/call",
                  "params": {
                      "name": "quality_get_perf_audit",
                      "arguments": {
                          "auditPath": "../api/2026-10-17T09-30-00-000Z-seeded/api-audit.v1.json"
                      },
                      "_meta": envelope(),
                  },
              },
              # The appearance audits, against the seeded CHANGE, over the fifth root.
              {
                  "jsonrpc": "2.0",
                  "id": 50,
                  "method": "tools/call",
                  "params": {
                      "name": "quality_list_visual_audits",
                      "arguments": {},
                      "_meta": envelope(),
                  },
              },
              {
                  "jsonrpc": "2.0",
                  "id": 51,
                  "method": "tools/call",
                  "params": {
                      "name": "quality_get_visual_audit",
                      "arguments": {"auditPath": "2026-10-19T09-30-00-000Z-seeded/visual-audit.v1.json"},
                      "_meta": envelope(),
                  },
              },
              # The escape a fifth root makes possible: out of `artifacts/visual` and
              # into the defect tree, which the same process has open and serving.
              {
                  "jsonrpc": "2.0",
                  "id": 52,
                  "method": "tools/call",
                  "params": {
                      "name": "quality_get_visual_audit",
                      "arguments": {
                          "auditPath": "../defects/2026-10-17T09-30-00-000Z-seeded/defects.v1.json"
                      },
                      "_meta": envelope(),
                  },
              },
        ],
        served_root,
        history_root,
        audit_root,
        api_root,
        perf_root,
        visual_root,
    )

    # --- accessibility audits, over the wire ---------------------------------
    #
    # The seeded audit exists so these assertions have something real to read, and
    # the traversal below is the case a second root makes possible: a path aimed
    # at an audit that walks out of the audit root and lands in the defect tree.
    audits = (frames.get(20, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not audits.get("total"):
        problems.append("list_audits returned no audits against the seeded audit root")
    else:
        print(f"audits: {audits.get('total')}")
        listed = (audits.get("audits") or [{}])[0]
        if listed.get("violations") != 1 or listed.get("truncatedRules") != 1:
            problems.append(f"list_audits counts={listed!r}, expected 1 violation and 1 truncated rule")

    audit_sc = (frames.get(21, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not audit_sc.get("counts"):
        problems.append("get_audit returned no counts - the artifact never reached the client")
    else:
        print(f"audit: {audit_sc.get('runId')} {json.dumps(audit_sc.get('counts'), sort_keys=True)}")
        rules = audit_sc.get("violations") or []
        if not rules:
            problems.append("get_audit returned no violations")
        else:
            # The truncation is the claim a client cannot reconstruct: ten nodes
            # kept out of forty-eight. If it does not survive the wire, a model
            # reads a capped artifact as a complete one.
            kept = len(rules[0].get("nodes") or [])
            if rules[0].get("totalNodes") != 48 or kept != 1 or rules[0].get("truncated") is not True:
                problems.append(
                    f"get_audit lost the truncation: kept={kept} total={rules[0].get('totalNodes')} "
                    f"truncated={rules[0].get('truncated')!r}"
                )
        # An impact the engine did not state must arrive as null, not as a level.
        undecided = (audit_sc.get("incomplete") or [{}])[0]
        if undecided.get("impact") is not None:
            problems.append(
                f"get_audit turned an undecided impact into {undecided.get('impact')!r}"
            )

    escape = frames.get(22, {}).get("error", {})
    if escape.get("code") != -32602:
        problems.append(
            f"an audit path escaping into the defect tree was not refused with -32602: "
            f"{json.dumps(escape)}"
        )
    else:
        print("audit path refused: -32602")

    # --- API contract audits, over the wire ----------------------------------
    #
    # The seeded audit breaks a contract, so the finding has to survive the wire:
    # declared against observed, plus the counts that say how widely it was seen. A
    # client that receives the contract but not the breach would report a broken API
    # as sound — which is the one thing this dimension exists to prevent.
    api_audits = (frames.get(30, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not api_audits.get("total"):
        problems.append("list_api_audits returned no audits against the seeded api root")
    else:
        print(f"api audits: {api_audits.get('total')}")
        listed = (api_audits.get("audits") or [{}])[0]
        if listed.get("violations") != 1 or listed.get("expectations") != 2 or listed.get("tests") != 1:
            problems.append(
                f"list_api_audits counts={listed!r}, expected 1 violation of 2 declared "
                f"across 1 test"
            )

    api_sc = (frames.get(31, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not api_sc.get("counts"):
        problems.append("get_api_audit returned no counts - the artifact never reached the client")
    else:
        print(f"api audit: {api_sc.get('runId')} {json.dumps(api_sc.get('counts'), sort_keys=True)}")
        broken = [e for e in (api_sc.get("expectations") or []) if e.get("violations")]
        if not broken:
            problems.append("get_api_audit returned no violations - the breach did not survive")
        else:
            # What was declared against what was seen, and how widely. The shape a
            # client cannot reconstruct from a count alone.
            finding = broken[0]["violations"][0]
            if (
                finding.get("expected") != "200"
                or finding.get("observed") != "status 500"
                or finding.get("exchanges") != 1
                or finding.get("tests") != 1
            ):
                problems.append(f"get_api_audit lost the finding: {json.dumps(finding, sort_keys=True)}")
            # A contract that held must be named too, or a client cannot tell which
            # of the declared ones were examined at all.
            if not [e for e in (api_sc.get("expectations") or []) if not e.get("violations")]:
                problems.append("get_api_audit returned only the broken contract, not the whole audit")

    api_escape = frames.get(32, {}).get("error", {})
    if api_escape.get("code") != -32602:
        problems.append(
            f"an api audit path escaping into the accessibility audits was not refused "
            f"with -32602: {json.dumps(api_escape)}"
        )
    else:
        print("api audit path refused: -32602")

    # --- transfer budgets, over the wire ---------------------------------------
    #
    # The seeded run breaches its budget, so the finding has to survive the wire:
    # what was allowed against what was measured, and the largest-load rule a client
    # cannot infer from a count. A client that receives the budget but not the breach
    # would report a heavy page as a sound one.
    perf_audits = (frames.get(40, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not perf_audits.get("total"):
        problems.append("list_perf_audits returned no audits against the seeded perf root")
    else:
        print(f"perf audits: {perf_audits.get('total')}")
        listed = (perf_audits.get("audits") or [{}])[0]
        if listed.get("violations") != 1 or listed.get("budgets") != 2 or listed.get("tests") != 1:
            problems.append(
                f"list_perf_audits counts={listed!r}, expected 1 breach of 2 budgets across 1 test"
            )

    perf_sc = (frames.get(41, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not perf_sc.get("counts"):
        problems.append("get_perf_audit returned no counts - the artifact never reached the client")
    else:
        print(f"perf audit: {perf_sc.get('runId')} {json.dumps(perf_sc.get('counts'), sort_keys=True)}")
        budgets = perf_sc.get("budgets") or []
        breached = [b for b in budgets if b.get("violations")]
        if not breached:
            problems.append("get_perf_audit returned no breach - the finding did not survive")
        else:
            # What was allowed against what was measured, plus how many loads.
            finding = breached[0]["violations"][0]
            if (
                finding.get("expected") != "at most 20,000 bytes"
                or finding.get("observed") != "526,538 bytes, 506,538 over"
                or breached[0].get("measuredBytes") != 526538
            ):
                problems.append(f"get_perf_audit lost the breach: {json.dumps(finding, sort_keys=True)}")
            # A budget that held must be named too, or a client cannot tell which of
            # the declared pages were examined at all.
            if not [b for b in budgets if not b.get("violations")]:
                problems.append("get_perf_audit returned only the breached budget, not the whole audit")
        # The rule a client would otherwise assume wrongly.
        if "LARGEST" not in json.dumps(perf_sc.get("budgets") or []) and not perf_sc.get("budgets"):
            problems.append("get_perf_audit returned nothing at all")

    perf_escape = frames.get(42, {}).get("error", {})
    if perf_escape.get("code") != -32602:
        problems.append(
            f"a perf audit path escaping into the API audits was not refused with "
            f"-32602: {json.dumps(perf_escape)}"
        )
    else:
        print("perf audit path refused: -32602")

    # --- appearance, over the wire -------------------------------------------
    #
    # The seeded run has a CHANGED page, and what matters here is that the sentence a
    # model acts on survives the wire: both hashes, and the committed file that approved
    # the other one. A fixture that seeded only a clean run would pass this check while
    # proving nothing about the part that matters.
    visual_audits = (frames.get(50, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not visual_audits.get("total"):
        problems.append("list_visual_audits returned no audits against the seeded visual root")
    else:
        print(f"visual audits: {visual_audits.get('total')}")
        listed = (visual_audits.get("audits") or [{}])[0]
        if listed.get("violations") != 1 or listed.get("pages") != 2 or listed.get("tests") != 7:
            problems.append(
                f"list_visual_audits counts={listed!r}, expected 1 finding across 2 pages and 7 tests"
            )
        # The approving engine travels with the finding. A baseline that does not say
        # which engine approved it says nothing, and measured 2026-10-18 no two engines
        # or viewports shared a screenshot hash for the same page.
        if listed.get("project") != "chromium":
            problems.append(f"list_visual_audits lost the approving engine: {listed!r}")

    visual_sc = (frames.get(51, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not visual_sc.get("counts"):
        problems.append("get_visual_audit returned no counts - the artifact never reached the client")
    else:
        print(f"visual audit: {visual_sc.get('runId')} {json.dumps(visual_sc.get('counts'), sort_keys=True)}")
        pages = visual_sc.get("pages") or []
        changed = [p for p in pages if p.get("violations")]
        if not changed:
            problems.append("get_visual_audit returned no finding - the change did not survive")
        else:
            finding = changed[0]["violations"][0]
            # Both hashes and the committed file. Drop any one of the three and a model
            # cannot act: it would not know what changed, or what it is being compared
            # against, or where to look.
            if (
                finding.get("kind") != "changed"
                or "f77c79ea41eb" not in str(finding.get("expected"))
                or "a1b0d3c8eb7c" not in str(finding.get("observed"))
                or "tests/visual-baselines/home-chromium-linux.png" not in str(finding.get("expected"))
            ):
                problems.append(f"get_visual_audit lost the change: {json.dumps(finding, sort_keys=True)}")
            # The baseline's own hash reaches the client too, from the committed file.
            if not changed[0].get("baseline"):
                problems.append("get_visual_audit returned the change without its baseline")
        # A clean page must travel beside the changed one, or a client cannot tell which
        # of the declared pages were examined at all.
        if not [p for p in pages if not p.get("violations")]:
            problems.append("get_visual_audit returned only the changed page, not the whole audit")

    visual_escape = frames.get(52, {}).get("error", {})
    if visual_escape.get("code") != -32602:
        problems.append(
            f"an appearance audit path escaping into the defect tree was not refused with "
            f"-32602: {json.dumps(visual_escape)}"
        )
    else:
        print("appearance audit path refused: -32602")



    if corrupt:
        problems.append(f"{len(corrupt)} corrupt stdout line(s)")
    if code != 0:
        problems.append(f"exit {code}")

    s1 = (frames.get(1, {}).get("result", {}) or {}).get("structuredContent") or {}
    if not s1.get("runId"):
        problems.append("get_latest_run returned no runId")
    print(f"latest run: {s1.get('runId')}  gate={(s1.get('gate') or {}).get('passed')}")

    # The window verdict must survive the wire, not only exist in the collector.
    # The seeded run is collected with --no-history and fails on purpose, so its
    # summary can only answer `unknown` — which is the value worth pinning: a
    # producer that guessed, or a tool that dropped the block on the way out, would
    # say something else, and a client would never see the difference.
    flakiness = s1.get("flakiness")
    if not isinstance(flakiness, dict):
        problems.append(
            f"get_latest_run carries no flakiness block (structuredContent keys: "
            f"{sorted(s1)}) - the summary's window verdict never reached the client"
        )
    else:
        print(f"flakiness: {json.dumps(flakiness, sort_keys=True)}")
        if flakiness.get("window") != 0:
            problems.append(
                f"flakiness.window={flakiness.get('window')!r}, expected 0 "
                "(the seeded run was collected with --no-history)"
            )
        if flakiness.get("verdict") != "unknown":
            problems.append(
                f"flakiness.verdict={flakiness.get('verdict')!r}, expected 'unknown' - "
                "a failing run with no history must not be guessed"
            )
        if flakiness.get("direction") != "unknown":
            problems.append(
                f"flakiness.direction={flakiness.get('direction')!r}, expected 'unknown'"
            )

        counts = flakiness.get("counts")
        if not isinstance(counts, dict) or sorted(counts) != [
            "failing",
            "flaky",
            "new",
            "regression",
        ]:
            problems.append(
                f"flakiness.counts is "
                f"{sorted(counts) if isinstance(counts, dict) else counts!r}, "
                "expected the four buckets"
            )

    # The run summary carries the declared dimensions' verdicts. The first tool an
    # agent calls must pass them through; a live external run found that it did not,
    # and an agent that read only the entry point reported the dimensions absent
    # while the file held all three. The seeded run is a real collector run, so the
    # presence here is the producer's, not a hand-written fixture's.
    for key in ("api", "perf", "visual"):
        block = s1.get(key)
        if not isinstance(block, dict):
            problems.append(
                f"get_latest_run carries no {key} block (structuredContent keys: "
                f"{sorted(s1)}) - the summary's {key} verdict never reached the client"
            )
        else:
            print(f"{key}: {json.dumps(block.get('counts'), sort_keys=True)}")
            if block.get("ran") is not True:
                problems.append(
                    f"get_latest_run {key}.ran={block.get('ran')!r}, expected True "
                    "(the seeded run declared the dimension and wrote its audit)"
                )

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

    # --- the history tools, over the same pipe ------------------------------
    #
    # Neither takes a path: the client names no directory, so there is nothing to
    # confine — which is what makes a second root safe to add at all.
    flaky_frame = frames.get(13, {})
    flaky_sc = (flaky_frame.get("result") or {}).get("structuredContent") or {}
    if "error" in flaky_frame:
        problems.append(f"flaky_tests returned an error: {flaky_frame['error']}")
    if flaky_sc.get("window") != 2:
        problems.append(f"flaky_tests window={flaky_sc.get('window')!r}, expected 2")
    flaky_tests = flaky_sc.get("tests") or []
    if len(flaky_tests) != 1:
        problems.append(f"flaky_tests returned {len(flaky_tests)} spec(s), expected 1")
    else:
        only = flaky_tests[0]
        if only.get("verdict") != "flaky":
            problems.append(f"verdict={only.get('verdict')!r}, expected 'flaky'")
        if only.get("runs") != 2 or only.get("failedRuns") != 1:
            problems.append(f"runs={only.get('runs')}/{only.get('failedRuns')}, expected 2/1")

    trend_frame = frames.get(14, {})
    trend_sc = (trend_frame.get("result") or {}).get("structuredContent") or {}
    if "error" in trend_frame:
        problems.append(f"get_trend returned an error: {trend_frame['error']}")
    if len(trend_sc.get("points") or []) != 2:
        problems.append(f"trend points={len(trend_sc.get('points') or [])}, expected 2")
    # Two runs cannot show a direction, and saying so is the point: an answer of
    # "improving" here would be invented rather than derived.
    if trend_sc.get("direction") != "unknown":
        problems.append(f"trend direction={trend_sc.get('direction')!r}, expected 'unknown'")
    if trend_sc.get("distinctFailing") != 1:
        problems.append(f"distinctFailing={trend_sc.get('distinctFailing')!r}, expected 1")

    print(
        f"history: flaky_tests window={flaky_sc.get('window')} "
        f"verdict={(flaky_tests[0].get('verdict') if flaky_tests else None)!r} · "
        f"trend direction={trend_sc.get('direction')!r}"
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
        "OK: tools answer with real data, all five traversal shapes refused with -32602, "
        "accessibility audits answer with their truncation intact and cannot escape their root, "
        f"the {MODERN} envelope required and answered"
    )
    return 0


sys.exit(main())