#!/usr/bin/env python3
"""Check that the quick-start's numbers are the suite's numbers.

Why this exists: quick-start promised 139 specs and "expect two skips". It was
running 327 and skipping 36. Both figures had been right once - when the matrix
was a single browser and there was no third-party suite - and nobody noticed,
because a green suite says nothing about whether the documentation describes it.

Every other check in this repository is a claim about code. This one is a claim
about prose, and prose drifts on its own: nothing compiles it, nothing executes
it, and a test that would catch the drift does not exist because there is nothing
to fail. So the counts are read out of the document and compared against what
Playwright actually collects.

Cheap on purpose. `playwright test --list` compiles every spec and collects them
without launching a browser or running anything, so this costs about six seconds
and is safe to run on every commit. Running the suite to learn a count would cost
three minutes and would need the demo server.

Counting is done by **file path**, never by test title. An earlier draft matched
on the word "third-party" and counted a test in `signal-capture.smoke.spec.ts`
whose title happens to contain that word - which put the total at 33 per engine
instead of 10, and would have shipped a check that disagreed with the suite for a
reason that had nothing to do with either.
"""

import collections
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
DOC = ROOT / "docs" / "quick-start.md"



def counts_by_file() -> tuple[dict[str, int], int]:
    """Tests per spec file, and the total, as Playwright collects them."""
    run = subprocess.run(
        ["npx", "playwright", "test", "--list"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if run.returncode != 0:
        print("FAIL: `playwright test --list` did not succeed")
        print(run.stdout[-2000:])
        print(run.stderr[-2000:])
        raise SystemExit(1)

    per_file: collections.Counter[str] = collections.Counter()
    # `[project] › path/file.spec.ts:12:3 › describe › title`
    pattern = re.compile(r"^\s*\[[a-z0-9_-]+\]\s+›\s+(\S+?):\d+:\d+\s+›")
    for line in run.stdout.splitlines():
        found = pattern.match(line)
        if found is not None:
            per_file[found.group(1)] += 1

    if not per_file:
        print("FAIL: no tests were collected, so there is nothing to compare against")
        print(run.stdout[-2000:])
        raise SystemExit(1)

    # Cross-check against Playwright's own total rather than trusting the parse,
    # so a change in the reporter's line format is reported here as a parse
    # failure instead of quietly producing a smaller number.
    reported = re.search(r"Total:\s+(\d+)\s+tests", run.stdout)
    if reported is None:
        print("FAIL: could not find Playwright's own total in `test --list`")
        print(run.stdout[-500:])
        raise SystemExit(1)
    total = int(reported.group(1))
    if total != sum(per_file.values()):
        print(
            f"FAIL: parsed {sum(per_file.values())} tests but Playwright reports {total} — "
            "this script's line format no longer matches the reporter's"
        )
        raise SystemExit(1)
    return dict(per_file), total


def main() -> int:
    print(f"project root: {ROOT}")
    per_file, total = counts_by_file()
    print(f"collected:    {total} tests in {len(per_file)} files\n")

    for path in sorted(per_file, key=lambda p: -per_file[p]):
        print(f"  {per_file[path]:4}  {path}")

    text = DOC.read_text(encoding="utf-8")
    problems: list[str] = []

    # Total.
    total_match = re.search(r"\|\s*Specs[^|]*\|\s*(\d+)\s*\|", text)
    if total_match is None:
        problems.append(
            "quick-start has no row matching `Specs, ... | <number>` — add one, or this "
            "check has nothing to verify"
        )
    elif int(total_match.group(1)) != total:
        problems.append(
            f"quick-start says {total_match.group(1)} specs, the suite collects {total}"
        )

    # Per-file rows: `| — of those, `some.spec.ts` | 30 |`
    file_rows = re.findall(r"\|\s*—\s*of those,\s*`([^`]+)`\s*\|\s*(\d+)\s*\|", text)
    if not file_rows:
        problems.append(
            "quick-start has no `— of those, `file.spec.ts` | <number>` rows, so the "
            "skip composition is not checked"
        )
    matched_total = 0
    for name, claimed in file_rows:
        claimed_n = int(claimed)
        # Match on basename so the document need not repeat the directory.
        candidates = {p: n for p, n in per_file.items() if p.rsplit("/", 1)[-1] == name}
        if len(candidates) != 1:
            problems.append(
                f"quick-start names `{name}`, which matches {len(candidates)} collected "
                f"files {sorted(candidates)} — the name is wrong or ambiguous"
            )
            continue
        actual = next(iter(candidates.values()))
        if actual != claimed_n:
            problems.append(
                f"quick-start says {claimed_n} for `{name}`, the suite collects {actual}"
            )
        matched_total += claimed_n

    # Skipped total must equal the sum of its parts.
    skip_match = re.search(r"\|\s*Skipped without[^|]*\|\s*(\d+)\s*\|", text)
    if skip_match is None:
        problems.append("quick-start has no row matching `Skipped without ... | <number>`")
    elif file_rows and int(skip_match.group(1)) != matched_total:
        problems.append(
            f"quick-start claims {skip_match.group(1)} skipped but its own file rows sum "
            f"to {matched_total}"
        )

    if problems:
        print(f"\nFAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        print("\nThe suite is the authority. Fix the document, not the check.")
        return 1

    print(f"\nOK: quick-start's {total} specs and its skip composition match the suite")
    return 0


if __name__ == "__main__":
    sys.exit(main())
