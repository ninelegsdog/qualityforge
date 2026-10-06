#!/usr/bin/env python3
"""
Validate the client-support table: vocabulary first, evidence second.

Issue #6 asks which clients implement protocol 2026-07-28. A table answers it
only if its cells cannot drift into impression: an empty cell reads as "does
not work", and a claim with no command behind it is a memory, not an
observation. Two rules, both from the plan for C3:

  1. Structure and vocabulary: the six columns exist, every cell is non-empty
     and starts with an allowed token, the three expected clients have rows,
     and Checked is an ISO date.
  2. Evidence: every row cites E-items that exist in the Evidence section and
     carry dates; a row that claims anything must cite a dated observation
     (not only a decision); a row that is entirely "not tested" must cite a
     decision, so silence is always a recorded choice.

Note on the boundary: "not called" is a claim (something was watched and did
not happen); only "not tested" is the absence of one. The rules key off that.

Usage: python3 scripts/client-support-check.py [project-root]
Exit:  0 the table is complete and cited, 1 otherwise.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
DOC = ROOT / "docs/client-support.md"

EXPECTED_HEADER = [
    "Client",
    "Connection",
    "`server/discover`",
    "Capabilities form",
    "Checked",
    "Observation",
]
CLAIM_COLUMNS = ("Connection", "`server/discover`", "Capabilities form")
TOKENS = {
    "Connection": ("connected", "not tested"),
    "`server/discover`": ("called", "not called", "not tested"),
    "Capabilities form": ("2025-11-25", "2026-07-28", "not tested"),
}
EXPECTED_CLIENTS = ("OpenCode", "Kilo", "MiMo")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EVIDENCE_ITEM = re.compile(r"^- \*\*(E\d+)\*\*")
NOT_TESTED = "not tested"

problems = []


def fail(msg: str) -> None:
    problems.append(msg)


if not DOC.exists():
    sys.exit(f"FATAL: {DOC} not found")

text = DOC.read_text(encoding="utf-8")

# --- locate the table --------------------------------------------------------
lines = text.splitlines()
start = next(
    (i for i, ln in enumerate(lines) if re.match(r"^\|\s*Client\s*\|\s*Connection\s*\|", ln)),
    None,
)
if start is None:
    sys.exit("FATAL: the support table header was not found")

header = [c.strip() for c in lines[start].strip("|").split("|")]
if header != EXPECTED_HEADER:
    fail(f"header is {header}, expected {EXPECTED_HEADER}")

rows = []
for ln in lines[start + 2 :]:
    if not ln.startswith("|"):
        break
    rows.append([c.strip() for c in ln.strip("|").split("|")])

# --- rule 1: structure and vocabulary ---------------------------------------
if not rows:
    fail("the table has no data rows")

for i, row in enumerate(rows):
    where = f"row {i + 1} ({row[0] if row else '?'})"
    if len(row) != len(EXPECTED_HEADER):
        fail(f"{where}: {len(row)} cells, expected {len(EXPECTED_HEADER)}")
        continue
    cells = dict(zip(EXPECTED_HEADER, row))
    for col, cell in cells.items():
        if cell == "":
            fail(f"{where}: cell '{col}' is empty — write 'not tested' rather than leave silence")
    for col in CLAIM_COLUMNS:
        cell = cells[col]
        if not cell:
            continue
        # Cells are pure tokens by design: a qualifier lives in the notes, not
        # in the cell, or the vocabulary would decay into free text.
        if cell not in TOKENS[col]:
            fail(f"{where}: '{col}' cell '{cell}' must be exactly one of {TOKENS[col]}")
    if not ISO_DATE.match(cells["Checked"]):
        fail(f"{where}: 'Checked' is '{cells['Checked']}', expected an ISO date")

for name in EXPECTED_CLIENTS:
    if not any(r and r[0].startswith(name) for r in rows):
        fail(f"no row for {name} — an absent client is the same silence the rules forbid")

# --- evidence index ----------------------------------------------------------
evidence = {}
in_evidence = False
for ln in lines:
    if ln.startswith("## Evidence"):
        in_evidence = True
        continue
    if in_evidence and ln.startswith("## "):
        break
    if in_evidence:
        m = EVIDENCE_ITEM.match(ln)
        if m:
            evidence[m.group(1)] = ln

if not evidence:
    fail("no E-items found under '## Evidence'")

for key, body in evidence.items():
    if not re.search(r"\d{4}-\d{2}-\d{2}", body):
        fail(f"{key} carries no date — an observation without a date is an impression")

# --- rule 2: each row cites --------------------------------------------------
for i, row in enumerate(rows):
    if len(row) != len(EXPECTED_HEADER):
        continue
    where = f"row {i + 1} ({row[0]})"
    cells = dict(zip(EXPECTED_HEADER, row))
    cited = [t.strip() for t in cells["Observation"].split(",") if t.strip()]
    if not cited:
        fail(f"{where}: no observation cited — a claim with no command behind it is a memory")
        continue
    unknown = [c for c in cited if c not in evidence]
    if unknown:
        fail(f"{where}: cites {unknown}, which the Evidence section does not define")
        continue
    observed = [c for c in cited if "decision" not in evidence[c].lower()]
    deciding = [c for c in cited if "decision" in evidence[c].lower()]
    claiming = any(cells[col] and cells[col] != NOT_TESTED for col in CLAIM_COLUMNS)
    if claiming and not observed:
        fail(f"{where}: claims ({', '.join(cells[c] for c in CLAIM_COLUMNS)}) but cites no observation — only a decision")
    if not claiming and not deciding:
        fail(f"{where}: all cells '{NOT_TESTED}' but no decision cited — silence must be a choice")

if problems:
    print(f"{DOC}: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

print(f"OK: {len(rows)} rows, {len(evidence)} evidence items; every claim cited, every silence decided")
