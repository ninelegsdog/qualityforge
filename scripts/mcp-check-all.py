#!/usr/bin/env python3
"""
Run every MCP check against one seeded run.

## Why this exists

Each check is self-seeding, which is right: neither depends on a failing suite
having been run beforehand. But `npm run mcp:check && npm run mcp:check:tools`
then ran the whole evidence pipeline twice, once per check, and on CI that is five
legs paying for it.

Measured on this machine: the two seeds cost 50s and 51s. Together that is more
than every browser suite except Firefox's, and it had become the single largest
item in the run.

So this seeds once and points both checks at the result. Each check still runs
standalone and still seeds for itself, so nothing depends on the orchestrator
existing — which is the point of the refactor behind it.

Usage: python3 scripts/mcp-check-all.py [project-root]
Exit:  0 all checks passed, otherwise the first non-zero code.
"""
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import evidence_seed  # noqa: E402  (needs the path above)

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

CHECKS = [
    ("session envelope", "scripts/mcp-session-check.py"),
    ("tools and confinement", "scripts/mcp-tools-check.py"),
    ("spawned like a client", "scripts/mcp-spawn-check.py"),
]


def main() -> int:
    scratch, seeded_root, problems = evidence_seed.seed(ROOT)
    if problems:
        print(evidence_seed.describe(scratch, seeded_root))
        print(f"\nFAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        print(f"\n  seeded artifacts kept at {scratch}")
        return 1

    print(evidence_seed.describe(scratch, seeded_root))
    print("  one seeded run, shared by every check below\n")

    environment = {**os.environ, evidence_seed.SHARED_SCRATCH_ENV: str(scratch)}
    failed: list[str] = []
    for label, script in CHECKS:
        print(f"--- {label} ---")
        result = subprocess.run(
            [sys.executable, script, str(ROOT)],
            cwd=ROOT,
            env=environment,
            timeout=1800,
        )
        if result.returncode != 0:
            failed.append(label)
        print()

    if failed:
        print(f"FAIL: {len(failed)} of {len(CHECKS)} checks failed: {', '.join(failed)}")
        print(f"  seeded artifacts kept at {scratch}")
        return 1

    evidence_seed.discard(scratch)
    print(f"OK: all {len(CHECKS)} checks passed")
    return 0


sys.exit(main())