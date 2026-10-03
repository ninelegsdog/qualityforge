#!/usr/bin/env python3
"""
Check that every relative link in the documentation resolves.

A broken relative link in the documentation has already shipped once:
`docs/selectors-and-testid.md` pointed at `../architecture.md`, which does not
exist, and nothing noticed until a human read it. The two quick-start guides
between them add about fourteen more internal links.

GitHub renders a missing target as plain text rather than an error, so a broken
link is invisible in review and only shows up when a reader clicks it. This is
about twenty lines and needs no dependencies, which is the whole point: a check
that only runs when someone remembers it is the same failure mode as the MCP
checks had.

What it does not check: anchors. `#some-heading` targets are verified as files
only, because the anchors in these documents are mostly GitHub-generated and a
false positive there is worse than a miss. Deciding that properly is issue #5.

Usage: python3 scripts/check-links.py [project-root]
Exit:  0 all relative links resolve, 1 otherwise.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

# Skip generated and vendored trees. None of these are authored.
SKIP_DIRS = {".git", "node_modules", "artifacts", "test-results", "playwright-report", "coverage"}

# Inline markdown links and reference definitions. Images are included on
# purpose: a broken screenshot path is just as invisible.
LINK = re.compile(r"!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+[\"'][^\"']*[\"'])?\s*\)")

# Only these can point at a file in this repository. Anything else is a URL, a
# mailto, or a protocol-relative link.
INTERNAL = re.compile(r"^(?!https?://|mailto:|//|#)")


def markdown_files() -> list[pathlib.Path]:
    found = []
    for path in ROOT.rglob("*.md"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        found.append(path)
    return sorted(found)


def internal_links(path: pathlib.Path):
    """
    Yield (line_number, target) for every internal markdown link outside code.

    Fence state has to be tracked, not just tested per line: a documentation page
    that *shows* an example link must not be judged by it, and the line holding
    the closing fence is not the only one inside the block.
    """
    in_fence = False
    fence = ""
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence, fence = True, marker
            elif marker == fence:
                in_fence, fence = False, ""
            continue
        if in_fence:
            continue
        for match in LINK.finditer(line):
            target = match.group(1)
            if INTERNAL.match(target):
                yield number, target


def check(path: pathlib.Path) -> list[tuple[int, str, str]]:
    """Return (line, target, reason) for every unresolvable link in one file."""
    problems = []
    for number, target in internal_links(path):
        # Strip the anchor and any query string before resolving.
        bare = target.split("#", 1)[0].split("?", 1)[0]
        if bare == "":
            continue  # a same-page anchor
        resolved = (path.parent / bare).resolve()
        if resolved.exists():
            continue
        problems.append((number, target, "нет такого файла"))
    return problems


def main() -> int:
    files = markdown_files()
    if not files:
        print("FAIL: не найдено ни одного markdown-файла — проверка ничего не сделала")
        return 1

    total_links = 0
    all_problems = []
    for path in files:
        relative = path.relative_to(ROOT)
        for number, target, reason in check(path):
            all_problems.append((relative, number, target, reason))
        for _, target in internal_links(path):
            if target.split("#", 1)[0] != "":
                total_links += 1

    print(f"проверено {len(files)} markdown-файл(ов), {total_links} внутренних ссылок")

    if all_problems:
        print()
        print(f"FAIL: {len(all_problems)} битая(ых) ссылка(и)")
        for relative, number, target, reason in all_problems:
            print(f"  {relative}:{number}  ->  {target}  ({reason})")
        print()
        print("  Ссылка должна быть относительной и вести на существующий файл.")
        print("  Если ведёт на раздел, проверяется только файл, не якорь.")
        return 1

    print("OK: все внутренние ссылки разрешаются")
    return 0


sys.exit(main())