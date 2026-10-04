#!/usr/bin/env python3
"""Check the collector's two claims about what Playwright actually writes.

Why this exists, in one line: a shipped bug passed a fully green test suite
because the tests were fed a hand-written report rather than the runner's own.

Both claims here are claims about Playwright's behaviour, and both were wrong
when first written down.

1. The suite-abort rule treats an unreachable target as one outage rather than a
   defect per test. It was written against a report where every spec in a file
   failed on the same error. Real Playwright does not write that for a
   `beforeAll` throw - it marks the first spec `failed` and every later one
   `skipped` - so the rule, which needed two or more matching failures, could not
   fire on the case it existed for. An outage produced exactly the one artifact
   the rule was meant to remove.

2. The evidence fixture attaches its payload on a failure rather than on a
   difference from what was expected, so `test.fail()` keeps its evidence. The
   decision function is unit-tested as a pure function and always was. What no
   test covered is the other side of it: whether the runner records the
   attachment at all for an expected failure.

No unit test can settle either. A test that asserts against a written fixture
agrees with whatever shape its author believed in - it is the belief, with a
green tick on it. So this runs a real Playwright and reads the report it
produces.

Cost: one Playwright start, one browser, no network. Needs a browser because
claim 2 goes through our own fixture, which depends on a page.

Runs on the chromium leg alone. Claim 2 is about how Playwright records an
attachment, which is not engine-specific; proving it on one engine is enough and
tripling it would buy three times the cost for the same fact.
"""

import base64
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
BROWSER = os.environ.get("REPORT_CHECK_BROWSER", "chromium")

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

# The other half of claim 1, and the reason it is not just "nothing is written":
# a test that fails on its own assertion must still be reported, or the rule is
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

# Claim 2. Imports the project's own fixture rather than a copy of it, because a
# copy would test the copy. `test.fail()` means this test is green overall, which
# is the only reason it can exist in a suite that has to stay green.
EXPECTED_FAILURE_SPEC = """import { expect, test } from "../../../tests/fixtures.js";

test.fail("a known-broken expectation still writes its context payload", async ({
  page,
}) => {
  await page.setContent("<h1>a heading</h1>");
  await expect(page.getByRole("heading")).toHaveText("a different heading");
});
"""

CONFIG = """import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  outputDir: "./out",
  reporter: [["json", { outputFile: "./report.json" }]],
  projects: [{ name: "browser", use: { browserName: "%(browser)s" } }],
});
"""


def playwright_rows(report: pathlib.Path) -> list[dict]:
    """What the runner actually wrote, flattened to one row per spec."""
    rows: list[dict] = []

    def walk(suites: list | None) -> None:
        for suite in suites or []:
            for spec in suite.get("specs", []) or []:
                tests = spec.get("tests", []) or []
                expected = tests[0].get("expectedStatus") if tests else None
                results = tests[0].get("results", []) if tests else []
                attachments = []
                for result in results:
                    for item in result.get("attachments", []) or []:
                        attachments.append(item)
                rows.append(
                    {
                        "file": spec.get("file"),
                        "title": spec.get("title"),
                        "expectedStatus": expected,
                        "statuses": [r.get("status") for r in results],
                        "errorLines": [
                            (r.get("error") or {}).get("location", {}).get("line")
                            for r in results
                        ],
                        "attachments": attachments,
                    }
                )
            walk(suite.get("suites"))

    data = json.loads(report.read_text(encoding="utf-8"))
    walk(data.get("suites"))
    return rows


def history_directory() -> pathlib.Path:
    """Where the project's own config says run history lives."""
    config = ROOT / "config" / "project.json"
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ROOT / "quality-history"
    history = data.get("history", {}) if isinstance(data, dict) else {}
    return ROOT / str(history.get("directory", "quality-history"))


def history_snapshot(directory: pathlib.Path) -> set[str]:
    """Every history file present, relative to its directory."""
    if not directory.exists():
        return set()
    return {str(path.relative_to(directory)) for path in directory.rglob("*.json")}


def main() -> int:
    problems: list[str] = []
    for path, what in ((CLI, "cli.js"), (LOADER, "tsx loader"), (COLLECT, "collector")):
        if not path.exists():
            print(f"FAIL: no {what} at {path}")
            return 1

    # Inside the checkout, not in /tmp: one spec imports `../../../tests/fixtures.js`,
    # and a relative path that climbs out of a temp directory to reach the project
    # is the kind of thing that breaks the first time a path segment changes.
    # `test-results/` is gitignored and is already Playwright's working directory.
    scratch = ROOT / "test-results" / f"report-check-{os.getpid()}"
    tests = scratch / "tests"
    tests.mkdir(parents=True)
    (tests / "hook.spec.ts").write_text(HOOK_SPEC, encoding="utf-8")
    (tests / "genuine.spec.ts").write_text(GENUINE_SPEC, encoding="utf-8")
    (tests / "expected-failure.spec.ts").write_text(EXPECTED_FAILURE_SPEC, encoding="utf-8")
    (scratch / "playwright.config.ts").write_text(
        CONFIG % {"browser": BROWSER}, encoding="utf-8"
    )

    print(f"project root: {ROOT}")
    print(f"browser:      {BROWSER}")
    print(f"scratch:      {scratch}")
    print("running a dead beforeAll, a genuine assertion failure and a test.fail()\n")

    run = subprocess.run(
        ["node", str(CLI), "test", "--config", str(scratch / "playwright.config.ts")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=900,
    )
    report = scratch / "report.json"
    if not report.exists():
        print("FAIL: Playwright wrote no report")
        print(run.stdout[-3000:])
        print(run.stderr[-3000:])
        print(f"  scratch kept at {scratch}")
        return 1

    rows = playwright_rows(report)
    print("what the runner actually wrote:")
    for row in rows:
        print(
            f"  {str(row['file']):28} expected={str(row['expectedStatus']):8}"
            f" statuses={row['statuses']} attachments={[a.get('name') for a in row['attachments']]}"
        )

    def rows_for(name: str) -> list[dict]:
        return [r for r in rows if r["file"] == name]

    hook = rows_for("hook.spec.ts")
    genuine = rows_for("genuine.spec.ts")
    expected_failure = [
        r for r in rows_for("expected-failure.spec.ts")
        if r["expectedStatus"] == "failed"
    ]

    # ---- claim 1: the shape of an aborted suite -------------------------------
    hook_failed = [r for r in hook if "failed" in (r["statuses"] or [])]
    hook_skipped = [r for r in hook if "skipped" in (r["statuses"] or [])]
    genuine_failed = [r for r in genuine if "failed" in (r["statuses"] or [])]
    genuine_passed = [r for r in genuine if "passed" in (r["statuses"] or [])]

    if len(hook_failed) != 1:
        problems.append(
            f"expected exactly one failed spec in hook.spec.ts, saw {len(hook_failed)}"
        )
    if len(hook_skipped) < 1:
        problems.append("expected the rest of hook.spec.ts to be skipped, saw none")
    if len(genuine_passed) < 1:
        problems.append(
            "expected a sibling to still run after a genuine failure, saw none - if "
            "Playwright now skips them, the abort rule loses its only way to tell a "
            "dead hook from a real defect"
        )
    if len(genuine_failed) != 1:
        problems.append(
            f"expected exactly one failed spec in genuine.spec.ts, saw {len(genuine_failed)}"
        )

    # The collector records every run in the committed history. This is not a run
    # of the project: it is a scratch suite of five specs with two deliberate
    # failures, and a record of it would make the repository claim a run that
    # never happened. `--no-history` keeps it out; the snapshot is what notices
    # if that flag ever stops being passed.
    history_dir = history_directory()
    history_before = history_snapshot(history_dir)

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
            "--no-history",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )

    written = sorted(history_snapshot(history_dir) - history_before)
    if written:
        problems.append(
            "the collector wrote to the committed run history "
            f"({', '.join(written)}) - this check must pass --no-history, its "
            "scratch suite is not a run of this project"
        )

    summaries = sorted(out.glob("*/quality-summary.v1.json"))
    if not summaries:
        problems.append("the collector wrote no summary")
        print(collect.stdout[-2000:])
        print(collect.stderr[-2000:])
    else:
        summary = json.loads(summaries[0].read_text(encoding="utf-8"))
        counts = summary.get("counts", {})
        names = [p.name for p in sorted(out.rglob("*.v1.json")) if "summary" not in p.name]

        print("\nwhat the collector made of it:")
        print(f"  defects written: {len(names)} {names}")
        print(f"  aborted:         {counts.get('aborted')}")

        if any("hook" in name for name in names):
            problems.append(
                f"the aborted suite wrote {names} - an outage is being reported as "
                "defects, which is the whole thing this rule exists to prevent"
            )
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
            problems.append("the gate passed despite a dead suite - an outage must not go green")
        elif "hook.spec.ts" not in "\n".join(gate.get("violations") or []):
            problems.append("the gate violation does not name the file that aborted")

    # ---- claim 2: evidence survives an expected failure ----------------------
    #
    # Read from the report, not from disk, and base64-decode it. Both facts are
    # measured: Playwright keeps a `body` attachment inline and writes no file for
    # it, and the JSON reporter base64-encodes that body. An earlier attempt at
    # this assertion looked in `test-results/` for a written file, found nothing,
    # and would have declared a working fixture broken.
    if len(expected_failure) != 1:
        problems.append(
            f"expected one test.fail() spec, saw {len(expected_failure)} - the runner "
            "did not report it the way this check assumes"
        )
    else:
        spec = expected_failure[0]
        if spec["statuses"] != ["failed"]:
            problems.append(
                f"test.fail() reported {spec['statuses']}, expected ['failed']"
            )
        context = [a for a in spec["attachments"] if a.get("name") == "quality-context"]
        if len(context) != 1:
            problems.append(
                f"expected one quality-context attachment on the expected failure, saw "
                f"{len(context)}: {[a.get('name') for a in spec['attachments']]} - "
                "evidence was deleted at the moment it was wanted"
            )
        else:
            body = context[0].get("body")
            if body is None:
                problems.append("the attachment carries no body")
            else:
                try:
                    payload = json.loads(base64.b64decode(body).decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as exc:
                    problems.append(f"the attachment body is not base64 JSON: {exc}")
                else:
                    if not (payload.get("page") or {}).get("url"):
                        problems.append(
                            f"the attachment has no page url, so it records no evidence: "
                            f"{json.dumps(payload)[:200]}"
                        )

    if problems:
        print(f"\nFAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        print(f"  scratch kept at {scratch}")
        return 1

    shutil.rmtree(scratch, ignore_errors=True)
    print(
        "\nOK: a dead beforeAll wrote no artifact and was named in the gate, a genuine "
        "assertion failure still wrote exactly one, and a test.fail() kept its evidence "
        "- all read off the runner's own report rather than a written one"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
