#!/usr/bin/env python3
"""
Produce one genuine failing run, in a temporary directory, for the MCP checks.

Both MCP checks drive the server against a real artifacts root. Neither should
depend on whether somebody happened to run a failing suite first: on a clean
checkout, and on any commit whose suite is green, the root is empty by design.
A check that needs its input prepared by a human tests the human, not the code.

So this runs the project's own `tests/smoke/evidence-pipeline.spec.ts`, which
fails on purpose, and collects the artifacts through the project's own collector.
Nothing is fabricated: the same suite, the same `validateDefect()` and the same
quality gate produce these artifacts. A deliberately broken collector would still
make a caller fail.

Isolation matters as much as the seeding. Playwright clears its output directory
on every run and the reporters overwrite their files, so without redirection this
would delete `test-results/` and `artifacts/json/` from whatever ran before it.
The seed report, the artifacts and the served root therefore all live outside the
project.

Imported by `mcp-session-check.py` and `mcp-tools-check.py`, which add this
directory to `sys.path` themselves.
"""
import os
import pathlib
import shutil
import subprocess
import tempfile

# The spec is meant to fail; that is what makes it produce evidence.
SEED_SPEC = "tests/smoke/evidence-pipeline.spec.ts"


#: Set by `scripts/mcp-check-all.py` so both checks share one seeded run.
SHARED_SCRATCH_ENV = "QUALITYFORGE_SEED_SCRATCH"


def seed(project_root: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path, list[str]]:
    """
    Produce a seeded artifacts root, or reuse one another check already made.

    `scripts/mcp-check-all.py` seeds once and points both checks at it. Each check
    also runs standalone, and seeds for itself in that case.

    Reuse is not an optimisation at the cost of independence: both paths produce
    real artifacts through the same pipeline, and a check run on its own still
    seeds its own. Measured on this machine, seeding cost 50s and 51s — together
    more than every browser suite except Firefox's — because each check ran the
    whole evidence pipeline separately.
    """
    shared = os.environ.get(SHARED_SCRATCH_ENV)
    if shared:
        scratch = pathlib.Path(shared)
        root = scratch / "defects"
        runs = sorted(root.glob("*/"))
        artifacts = (
            [p for p in runs[0].glob("*.v1.json") if p.name != "quality-summary.v1.json"]
            if runs
            else []
        )
        if artifacts:
            return scratch, root, []
        # A shared root that has nothing in it is a bug in the orchestrator, not
        # something to paper over by silently seeding a second time.
        return (
            scratch,
            root,
            [f"{SHARED_SCRATCH_ENV} points at {root}, which holds no defect artifacts"],
        )

    return _seed_fresh(project_root)


def _seed_fresh(project_root: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path, list[str]]:
    """
    Produce a seeded artifacts root.

    Returns `(scratch_dir, defects_root, problems)`. A non-empty `problems` means
    the caller has nothing meaningful to check and should report and stop.

    The scratch directory is owned by the caller: remove it on success, keep it
    on failure, where the seeded artifacts are the thing being debugged.
    """
    problems: list[str] = []
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="qualityforge-mcp-check-"))
    report = scratch / "playwright-results.json"
    defects_root = scratch / "defects"

    env = {
        **os.environ,
        "QUALITYFORGE_EVIDENCE_CHECK": "1",
        "QUALITYFORGE_OUTPUT_DIR": str(scratch / "test-results"),
        "PLAYWRIGHT_JSON_OUTPUT_NAME": str(report),
        "PLAYWRIGHT_HTML_OUTPUT_DIR": str(scratch / "playwright-report"),
    }
    proc = subprocess.run(
        # No --reporter here: a reporter given on the command line replaces the
        # configured list and would suppress the JSON reporter this depends on.
        ["npx", "playwright", "test", SEED_SPEC],
        cwd=project_root,
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if proc.returncode == 0:
        problems.append(
            f"{SEED_SPEC} passed; it is meant to fail, so no evidence was produced"
        )
    if not report.exists():
        problems.append("the seeded run wrote no JSON report")
        return scratch, defects_root, problems

    collected = subprocess.run(
        [
            "npm",
            "run",
            "--silent",
            "defects:collect",
            "--",
            "--report",
            str(report),
            "--out",
            str(defects_root),
            # A seeded run is not a run of this project: it happens in a scratch
            # directory, fails on purpose, and must not append itself to the committed
            # history, whose only value is that it records what really happened here.
            "--no-history",
        ],
        cwd=project_root,
        capture_output=True,
        text=True,
        timeout=300,
    )
    # Exit 1 means "collected, gate failed". That is required, not incidental:
    # the seeded run fails 100% of the time and must trip the failure-rate
    # gate, which is the only place that gate meets real data instead of a
    # fixture.
    if collected.returncode != 1:
        problems.append(
            f"defects:collect exited {collected.returncode} on a 100%-failing run, "
            "expected 1 (collected, gate failed); the quality gate did not react"
        )

    runs = sorted(defects_root.glob("*/"))
    if not runs:
        problems.append("the collector wrote no run directory")
        return scratch, defects_root, problems

    artifacts = [p for p in runs[0].glob("*.v1.json") if p.name != "quality-summary.v1.json"]
    if not artifacts:
        problems.append("the seeded run produced no defect artifacts")
    return scratch, defects_root, problems


def describe(scratch: pathlib.Path, defects_root: pathlib.Path) -> str:
    """One line describing what was seeded, for the caller's output."""
    runs = sorted(defects_root.glob("*/"))
    if not runs:
        return f"scratch: {scratch}"
    artifacts = [p for p in runs[0].glob("*.v1.json") if p.name != "quality-summary.v1.json"]
    return f"scratch: {scratch}\nseeded {len(artifacts)} real defect artifact(s) in {runs[0].name}"


def discard(scratch: pathlib.Path) -> None:
    """
    Remove a scratch directory — unless this process did not create it.

    Under `scripts/mcp-check-all.py` the scratch belongs to the orchestrator and
    is shared by every check, so a check that succeeded must not delete it out
    from under the checks that follow. That is not hypothetical: the first run of
    the shared path failed because the session check cleaned up on its way out and
    the tools check then found nothing.
    """
    if os.environ.get(SHARED_SCRATCH_ENV):
        return
    shutil.rmtree(scratch, ignore_errors=True)