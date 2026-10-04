#!/usr/bin/env python3
"""Check that every closed issue is cited by a commit, and say so out loud.

Why this exists. Five issues sat open on `main` after they had been fixed: #2, #7,
#9, #10, #11. The repository and the board disagreed, and the board was the one
read. Nothing caught it, because closing an issue by hand leaves no trace in the
tree and no check looked.

One direction of that is automatable. A commit that fixes something says so, and
these commits do cite their issues — `#2`, `#3`, `#5`, `#7`, `#9`, `#10`, `#11`,
`#12` appear in the log. So "closed with no commit behind it" is detectable, and
that is the direction worth catching: it is the one where a reader trusts a
resolution that does not exist.

The other direction is deliberately not checked. An open issue whose number appears
in a commit message is normal — #6 and #12 are both cited by commits that
documented a problem rather than fixed it — so inferring "this should be closed"
from a citation would produce false positives, and a check that cries wolf gets
ignored.

**Not wired into CI, deliberately.** `actions/checkout` fetches depth 1 by
default, so on a runner this repository's history is a single commit and every
closed issue would read as uncited. Found by running it on a `--depth 1` clone
while reverse-testing: seven confident false accusations. It now refuses to judge
when the history is shallow, and says that instead.

Its real use is immediately before closing an issue, on a full clone — which is
what stops a closure from being a claim with nothing behind it.

Needs the network. It reads the public GitHub API with no token, which is inside
the unauthenticated rate limit. It fails loudly rather than reporting a pass it did
not earn.

The roadmap deliberately does not restate the open and closed counts. This script
is how to see them.
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
REPO = os.environ.get("QUALITYFORGE_REPO", "ninelegsdog/qualityforge")
MILESTONE = os.environ.get("QUALITYFORGE_MILESTONE", "v0.1.0-alpha")
API = "https://api.github.com"


def is_shallow() -> bool:
    probe = subprocess.run(
        ["git", "rev-parse", "--is-shallow-repository"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return probe.returncode == 0 and probe.stdout.strip() == "true"


def cited_issues() -> set[int]:
    """Issue numbers that appear anywhere in this repository's commit messages."""
    log = subprocess.run(
        ["git", "log", "--format=%s%n%b"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if log.returncode != 0:
        print("FAIL: could not read this repository's history")
        print(log.stderr[-1000:])
        raise SystemExit(1)
    return {int(n) for n in re.findall(r"#(\d+)", log.stdout)}


def get_json(path: str) -> object:
    request = urllib.request.Request(
        f"{API}{path}",
        headers={
            "User-Agent": "qualityforge-board-check",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def milestone_number() -> int | None:
    """The milestone's number, found by title.

    The `milestone` query parameter takes a number, not a name. Passing the name
    is answered with 422 Unprocessable Entity, which reads like a permissions
    problem and is not one.
    """
    for item in get_json(f"/repos/{REPO}/milestones?state=all&per_page=100"):  # type: ignore[union-attr]
        if item["title"] == MILESTONE:
            return int(item["number"])
    return None


def fetch_state(number: int) -> dict[int, str]:
    """Issue number -> state, for open and closed issues alike."""
    data = get_json(
        f"/repos/{REPO}/issues?state=all&per_page=100&milestone={number}"
    )
    # Pull requests come back from the issues endpoint; they are not board items.
    return {
        item["number"]: item["state"]
        for item in data  # type: ignore[union-attr]
        if "pull_request" not in item
    }


def main() -> int:
    if is_shallow():
        print(f"FAIL: {ROOT} is a shallow clone, so its history cannot be searched.")
        print("  Every closed issue would be reported as uncited, which is an accusation")
        print("  about the repository rather than a finding. Fetch the history first:")
        print("    git fetch --unshallow")
        return 1

    cited = cited_issues()
    print(f"repository:  {REPO}")
    print(f"milestone:   {MILESTONE}")
    print(f"cited:       {', '.join(f'#{n}' for n in sorted(cited)) or '(none)'}\n")

    try:
        number = milestone_number()
        if number is None:
            print(f"FAIL: no milestone titled {MILESTONE} in {REPO}")
            return 1
        print(f"milestone id: {number}")
        state = fetch_state(number)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"FAIL: could not read {REPO}: {exc}")
        print("  This check needs the network and has no offline mode on purpose.")
        return 1

    if not state:
        print(f"FAIL: milestone {MILESTONE} carries no issues")
        return 1

    closed = sorted(n for n, s in state.items() if s == "closed")
    open_ = sorted(n for n, s in state.items() if s == "open")

    print("  open:")
    for n in open_:
        print(f"    #{n}")
    print("  closed:")
    for n in closed:
        mark = "cited" if n in cited else "NOT CITED"
        print(f"    #{n}  {mark}")

    problems = [
        f"#{n} is closed but no commit message mentions it — closing an issue by hand "
        "leaves no trace in the tree, so a reader can trust a resolution that does not exist"
        for n in closed
        if n not in cited
    ]

    if problems:
        print(f"\nFAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print(
        f"\nOK: all {len(closed)} closed issues are cited by a commit; "
        f"{len(open_)} still open"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
