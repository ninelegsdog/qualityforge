#!/usr/bin/env python3
"""Check that every live claim about how many MCP tools exist is true.

Why this exists, in one line: `README.md`, `docs/architecture.md` and
`docs/roadmap.md` all said the server has **five** tools, in three places, after
it had seven for several days - and nothing noticed, because a green suite says
nothing about whether the prose describes the code.

The count is read from `scripts/tool_list.py`, which is already the single
source of truth the MCP checks compare the wire against. This is that same
number's second consumer: adding a tool becomes one edit plus this check
telling you which three documents to fix, instead of three documents silently
disagreeing with each other.

## What counts as a claim, and why it is not simpler

`two MCP tools read it` is a true sentence and it must not be failed. So the
check cannot simply look for a number near the word "tools" - in this repository
that would be four false positives in five matches.

Instead a claim counts as a statement about the **whole server** when a
punctuation mark follows it, or when the next word is `and`, `with`, `including`
or `of`:

    Seven tools - five over defects, two over audits      <- a total
    Protocol 2026-07-28, seven tools, resources ...       <- a total
    two MCP tools read it                                 <- a subset, left alone
    two MCP tools that read it                            <- a subset, left alone

The rule is one line of English and it is stated here because it is a rule about
English. Measured over every tracked markdown file it classifies 4 claims as
totals and 4 as subsets, with no misclassification; a reworded sentence that
changes the classification is a sentence this check will have to be taught.

## Historical records are exempt, and say so when they are

`CHANGELOG.md` and any paragraph beginning `Now done, on <date>:` record what
was true when it was written. The 0.1.0 entry says "five tools" because there
were five on 2026-10-15, and correcting that would falsify the record of what
was observed when the tarball left. Every exemption is **printed** when the
check passes, because an exemption nobody sees is a hole nobody notices.

## What this does not check

- That a total is stated anywhere. Deleting every number would pass; the check
  prints how many live claims it verified so a drop to zero is visible in CI
  output rather than silent.
- Tool *names* in prose. `CHANGELOG.md` lists them explicitly and is historical;
  for live documents, `tools/list` order and membership are asserted against
  `tool_list.py` by `mcp:check:*` and by the live client, not here.
- Subsets. `two MCP tools read it` stays true whatever the server's size.

Cost: reads the file list and the prose. No build, no browser, no suite.
"""

import pathlib
import re
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from tool_list import EXPECTED_TOOLS  # noqa: E402  (needs the path above)

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

NUMBER = (
    r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
)
CLAIM = re.compile(rf"\b{NUMBER}\s+(?:MCP\s+)?tools\b", re.I)

# A total is followed by punctuation, or by one of these. Everything else - a
# verb, "that", "with a browser round-trip" - is a subset and is left alone.
TOTAL_FOLLOWERS = {"and", "with", "including", "of"}
PUNCTUATION = {",", ".", ";", ":", "!", "?", ")", "—", "–", "|", "*", "`"}

# A dated record: a paragraph that opens by naming the day it describes.
DATED_PARAGRAPH = re.compile(r"^Now done, on \d{4}-\d{2}-\d{2}:")

WORDS = {
    "0": 0,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 10,
    "11": 11,
    "12": 12,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
}


def markdown_files() -> list[pathlib.Path]:
    listed = subprocess.run(
        ["git", "ls-files", "*.md"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=True,
    )
    return [ROOT / line for line in listed.stdout.split() if line.strip()]


def in_dated_record(lines: list[str], index: int) -> bool:
    """Whether this line belongs to a paragraph opening `Now done, on <date>:`.

    Markdown separates paragraphs with a blank line, so the paragraph's opening
    line is the last non-empty line above the blank one. An earlier draft
    stopped at the first non-empty line above and checked *that*, which read
    every paragraph past its own first line and exempted nothing - the check
    caught it on its first run against `docs/roadmap.md`.
    """
    opener = ""
    for back in range(index - 1, -1, -1):
        stripped = lines[back].strip()
        if not stripped:
            break
        opener = stripped
    return DATED_PARAGRAPH.match(opener) is not None


def classify(line: str, end: int) -> tuple[bool, str]:
    """Is this claim about the whole server? Return the verdict and the reason."""
    rest = line[end:].strip()
    if not rest:
        return True, "nothing follows it"
    nxt = rest.split()[0]
    bare = nxt.strip("`'\"()[]")
    if bare in PUNCTUATION or nxt in PUNCTUATION:
        return True, f"followed by {bare or nxt!r}"
    if bare.lower() in TOTAL_FOLLOWERS:
        return True, f"followed by {bare.lower()!r}"
    return False, f"followed by {bare!r}, which makes it a subset"


def main() -> int:
    expected = len(EXPECTED_TOOLS)
    print(f"tools in tool_list.py: {expected}\n")

    problems: list[str] = []
    verified = 0
    exempt: list[str] = []
    subsets = 0

    for path in markdown_files():
        rel = path.relative_to(ROOT)
        if rel.name == "CHANGELOG.md":
            # Every entry describes a past release. Exempt whole, and say so.
            exempt.append(f"{rel} (a changelog records what was true when written)")
            continue
        lines = path.read_text(encoding="utf-8").split("\n")
        for index, line in enumerate(lines):
            for match in CLAIM.finditer(line):
                total, reason = classify(line, match.end())
                if not total:
                    subsets += 1
                    continue
                said = WORDS[match.group(1).lower()]
                where = f"{rel}:{index + 1}"
                if in_dated_record(lines, index):
                    exempt.append(f"{where} says {said} - a dated record ({reason})")
                    continue
                if said == expected:
                    verified += 1
                else:
                    problems.append(
                        f"{where} says the server has {said} tool(s); tool_list.py has "
                        f"{expected}. The claim is {reason}. Update the document or the "
                        f"server - do not delete the number to make this pass."
                    )

    print(f"live claims verified: {verified}")
    print(f"subset claims left alone: {subsets}")
    if exempt:
        print("historical records exempted:")
        for line in exempt:
            print(f"  - {line}")

    if problems:
        print()
        print(f"FAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print(
        f"\nOK: {verified} live claim(s) match tool_list.py, {subsets} subset claim(s) "
        f"correctly ignored, {len(exempt)} historical record(s) exempted"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())