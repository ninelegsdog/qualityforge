#!/usr/bin/env python3
"""Prove the suite-abort rule against a real Playwright report.

Why this exists, in one line: a shipped bug passed a fully green test suite
because the tests were fed a hand-written report rather than the runner's own.

The collector treats an unreachable target as one outage rather than a defect per
test. The rule that does it was written against a report where every spec in the
file failed on the same error. Real Playwright does not write that for a
`beforeAll` throw - it marks the first spec `failed` and every later one
`skipped` - so the rule could not fire on the case it existed for, and an
outage produced exactly one artifact, which is the harm it was meant to remove.

No unit test can catch that. A unit test asserts against a report somebody typed,
so it agrees with whatever shape the author believed in. Only a real run settles
what the reporter emits. So this runs a real one, twice over: a suite that aborts,
and a suite where one test fails for its own reason. The first must write nothing;
the second must write exactly one artifact. Anything else means the shape moved.

Cost: one Playwright start against a scratch directory, no browsers, no network.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
CLI = ROOT / "node_modules" / "@playwright" / "test" / "cli.js"
COLLECT = ROOT / "src" / "cli" / "collect-defects.ts"
LOADER = ROOT / "node_modules" / "tsx" / "dist" / "loader.mjs"

# One throw in beforeAll: the hook fails, so the first spec is reported failed and
# the rest are skipped without ever running.
HOOK_SPEC = """import { test } from "@playwright/test";

test.describe("suite that never ran", () => {
  test.beforeAll(() => {
    throw new Error("the target is unreachable, so this suite did not run");
  });

  test("first probe", async () => {
    // Never reached.
  });

  test("second probe", async () => {
    // Never reached.
  });
});
"""

# The other half, and the reason the check is not just "nothing is written": a
# test that fails on its own assertion must still be reported, or the rule is
# eating real defects and everything below is worthless.
GENUINE_SPEC = """import { expect, test } from "@playwright/test";

test.describe("suite where one test fails for its own reason", () => {
  test("first probe fails on its own assertion", async () => {
    expect("actual").toBe("expected");
  });

  test("second probe should still run", async () => {
    expect(1).toBe(1);
  });
});
"""

CONFIG = """import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  outputDir: "./out",
  reporter: [["json", { outputFile: "./report.json" }]],
  // No browser is launched, and that is checked rather than assumed: neither spec
  // touches `page`, because a dead hook and a failing assertion are runner
  // bookkeeping and nothing more. Verified by running this script with
  // PLAYWRIGHT_BROWSERS_PATH pointing at an empty directory - it still passes.
  //
  // It matters because the job that should run this installs no browser, and a
  // check that needs one gets skipped or moved somewhere expensive.
  projects: [{ name: "none" }],
});
"""


def playwright_specs(report: pathlib.Path) -> list[dict]:
    """What the runner actually wrote, flattened to one row per result."""
    rows: list[dict] = []

    def walk(suites: list | None) -> None:
        for suite in suites or []:
            for spec in suite.get("specs", []) or []:
                for test in spec.get("tests", []) or []:
                    for result in test.get("results", []) or []:
                        error = result.get("error") or {}
                        location = error.get("location") or {}
                        rows.append(
                            {
                                "file": spec.get("file"),
                                "status": result.get("status"),
                                "errorLine": location.get("line"),
                            }
                        )
            walk(suite.get("suites"))

    data = json.loads(report.read_text(encoding="utf-8"))
    walk(data.get("suites"))
    return rows


def main() -> int:
    problems: list[str] = []
    if not CLI.exists():
        print(f"FAIL: {CLI} does not exist")
        return 1
    if not LOADER.exists():
        print(f"FAIL: no tsx loader at {LOADER}")
        return 1

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="qf-abort-"))
    tests = scratch / "tests"
    tests.mkdir()
    (tests / "hook.spec.ts").write_text(HOOK_SPEC, encoding="utf-8")
    (tests / "genuine.spec.ts").write_text(GENUINE_SPEC, encoding="utf-8")
    (scratch / "playwright.config.ts").write_text(CONFIG, encoding="utf-8")
    os.symlink(ROOT / "node_modules", scratch / "node_modules")

    print(f"project root: {ROOT}")
    print(f"scratch:      {scratch}")
    print("running a real beforeAll throw and a real assertion failure in one run\n")

    run = subprocess.run(
        ["node", str(CLI), "test"],
        cwd=scratch,
        capture_output=True,
        text=True,
        timeout=600,
    )
    report = scratch / "report.json"
    if not report.exists():
        print("FAIL: Playwright wrote no report")
        print(run.stdout[-2000:])
        print(run.stderr[-2000:])
        print(f"  scratch kept at {scratch}")
        return 1

    rows = playwright_specs(report)
    print("what the runner actually wrote:")
    for row in rows:
        print(
            f"  {str(row['file']):18} status={str(row['status']):9}"
            f" errorLine={row['errorLine']}"
        )

    # The report shape is an assumption the collector's rule depends on. Name the
    # two facts it relies on and fail here, loudly, if either stops being true -
    # a shape change should read as a shape change, not as a silent behaviour
    # change two layers down.
    hook_rows = [r for r in rows if r["file"] == "hook.spec.ts"]
    hook_failed = [r for r in hook_rows if r["status"] == "failed"]
    hook_skipped = [r for r in hook_rows if r["status"] == "skipped"]
    genuine_rows = [r for r in rows if r["file"] == "genuine.spec.ts"]
    genuine_failed = [r for r in genuine_rows if r["status"] == "failed"]
    genuine_ran = [r for r in genuine_rows if r["status"] == "passed"]

    if len(hook_failed) != 1:
        problems.append(
            f"expected exactly one failed spec in hook.spec.ts, saw {len(hook_failed)}"
        )
    if len(hook_skipped) < 1:
        problems.append("expected the rest of hook.spec.ts to be skipped, saw none")
    if len(genuine_ran) < 1:
        problems.append(
            "expected a sibling to still run after a genuine failure, saw none - "
            "if Playwright now skips them, the abort rule loses its only way to "
            "tell a dead hook from a real defect"
        )
    if len(genuine_failed) != 1:
        problems.append(
            f"expected exactly one failed spec in genuine.spec.ts, saw {len(genuine_failed)}"
        )

    out = scratch / "out"
    collect = subprocess.run(
        [
            "node",
            "--import",
            str(LOADER),
            str(COLLECT),
            "--report",
            str(report),
            "--out",
            str(out),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )

    summaries = sorted(out.glob("*/quality-summary.v1.json"))
    if not summaries:
        problems.append("the collector wrote no summary")
        print(collect.stdout[-2000:])
        print(collect.stderr[-2000:])
    else:
        summary = json.loads(summaries[0].read_text(encoding="utf-8"))
        counts = summary.get("counts", {})
        artifacts = sorted(
            p for p in out.rglob("*.v1.json") if "summary" not in p.name
        )
        names = [p.name for p in artifacts]

        print("\nwhat the collector made of it:")
        print(f"  defects written: {len(names)} {names}")
        print(f"  aborted:         {counts.get('aborted')}")
        print(f"  failed:          {counts.get('failed')}")
        print(f"  skipped:         {counts.get('skipped')}")

        # The abort must write nothing at all.
        if any("hook" in name for name in names):
            problems.append(
                f"the aborted suite wrote {names} - an outage is being reported as "
                "defects, which is the whole thing this rule exists to prevent"
            )
        # The genuine failure must survive.
        genuine_artifacts = [n for n in names if "genuine" in n]
        if len(genuine_artifacts) != 1:
            problems.append(
                f"expected exactly one artifact for the genuine failure, saw "
                f"{len(genuine_artifacts)} {names} - the rule is suppressing real defects"
            )
        if counts.get("aborted") != 1:
            problems.append(
                f"expected aborted=1, saw {counts.get('aborted')} - the rule did not "
                "recognise a real beforeAll abort"
            )

        gate = summary.get("gate", {})
        if gate.get("passed") is not False:
            problems.append(
                "the gate passed despite a dead suite - an outage must not go green"
            )
        else:
            violations = "\n".join(gate.get("violations") or [])
            if "hook.spec.ts" not in violations:
                problems.append(
                    "the gate violation does not name the file that aborted: "
                    f"{violations!r}"
                )
            print(f"  gate says:      {violations.splitlines()[0][:100]}")

    if problems:
        print(f"\nFAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        print(f"  scratch kept at {scratch}")
        return 1

    shutil.rmtree(scratch, ignore_errors=True)
    print(
        "\nOK: a dead beforeAll produced no artifact and was named in the gate, while a "
        "genuine assertion failure still produced exactly one — checked against the "
        "runner's own report rather than a written one"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
