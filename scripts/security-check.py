#!/usr/bin/env python3
"""
Check that SECURITY.md still answers the questions it is published to answer.

Why this exists: a policy document drifts the way prose does. Each commitment
in SECURITY.md is a sentence that can be edited out of existence with a clean
diff, and the failure mode is quiet — a reporter arrives at a policy that no
longer says whether versions are supported, whether the scope is stdio, or
whether the server is read-only, and nothing in CI objects. `docs:check`
proves links, not claims.

F2 in the plan named the questions the policy must answer: there are no
supported versions, the scope is stdio, the path boundary is server-side,
capture is redacted, and the server is read-only. Each is enforced by the
exact bold marker it is written as, so removing or rewording a claim is a
red run that names it.

Usage: python3 scripts/security-check.py [project-root]
Exit:  0 every required claim is present, 1 otherwise.
"""
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
DOC = ROOT / "SECURITY.md"

# (anchor, what the claim is) — the anchor is the readable sentence itself,
# so the claim cannot be reworded past the guard.
REQUIRED_CLAIMS = [
    ("**The MCP server is read-only.**", "the server is read-only"),
    ("**File access is confined server-side.**", "the path boundary is server-side"),
    ("**Released builds run over stdio.**", "the scope is stdio"),
    ("**Secrets never enter evidence.**", "capture is redacted"),
    ("**There are no supported versions.**", "there are no supported versions"),
]


def main() -> int:
    if not DOC.exists():
        print(f"FATAL: {DOC} not found")
        return 1

    text = DOC.read_text(encoding="utf-8")
    missing = [claim for anchor, claim in REQUIRED_CLAIMS if anchor not in text]

    if not missing:
        print("OK: SECURITY.md states every commitment the policy advertises")
        return 0

    for claim in missing:
        print(f"FAIL: SECURITY.md no longer states that {claim}")
    print("Restore the claim with the same bold anchor, or the policy has drifted.")
    return 1


if __name__ == "__main__":
    sys.exit(main())