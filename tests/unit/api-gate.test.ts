import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectDefects, runExitCode, type RunSummary } from "../../src/defect/collect.js";
import { DEFECT_SCHEMA_VERSION } from "../../src/defect/types.js";
import type { ApiExpectation } from "../../src/config/types.js";

/**
 * Two verdicts, reported apart and combined in one place.
 *
 * The owner's decision of 2026-10-16: an API contract breach must stop the run.
 * The shape that makes it possible is the whole point of this file —
 *
 * - `summary.gate` still means **"the tests held the thresholds"**, unchanged, so
 *   no existing field changed meaning and the version bump stayed minor;
 * - `summary.api` carries its own verdict, and is **absent** when nothing was
 *   declared, because "nothing was declared" and "everything held" are different
 *   facts;
 * - the exit code is the single place the two are combined, because a gate whose
 *   caller must distinguish two failure codes gets scripted for one of them.
 *
 * Two of these tests would be meaningless without the version pin: a change of
 * meaning is a major bump and a `v2` file, so `DEFECT_SCHEMA_VERSION` staying at a
 * `1.x` is the check that the cheap shape was the one taken.
 */
const THRESHOLDS = { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 };

const ITEMS: ApiExpectation = {
  name: "items-are-json",
  method: "GET",
  path: "/api/items",
  status: 200,
};

function capture(status: number, observed: number): string {
  return JSON.stringify({
    schemaVersion: "1.0.0",
    baseUrl: "http://127.0.0.1:4311",
    expectations: [
      {
        name: ITEMS.name,
        method: "GET",
        path: "/api/items",
        observed,
        dropped: 0,
        exchanges:
          observed === 0
            ? []
            : [
                {
                  origin: "http://127.0.0.1:4311",
                  status,
                  contentType: "application/json",
                  requestKind: "absent",
                  requestMissing: [],
                  responseKind: "json",
                  responseMissing: [],
                },
              ],
      },
    ],
  });
}

/** A run whose tests all pass, so only the API verdict can turn it red. */
async function collect(
  root: string,
  captures: string[],
  expectations: ApiExpectation[] | undefined,
): Promise<RunSummary> {
  mkdirSync(path.join(root, "artifacts", "json"), { recursive: true });
  writeFileSync(
    path.join(root, "artifacts/json/playwright-results.json"),
    JSON.stringify({
      config: { rootDir: path.join(root, "tests") },
      stats: { startTime: "2026-10-17T09:00:00.000Z", duration: 100 },
      suites: [
        {
          title: "tests/smoke/api.spec.ts",
          file: "smoke/api.spec.ts",
          specs: captures.map((body, index) => ({
            id: `spec${index}`,
            title: `passes ${index}`,
            file: "smoke/api.spec.ts",
            line: 10 + index,
            tests: [
              {
                projectName: "chromium",
                expectedStatus: "passed",
                results: [
                  {
                    status: "passed",
                    retry: 0,
                    duration: 50,
                    startTime: "2026-10-17T09:00:00.000Z",
                    attachments: [
                      {
                        name: "quality-api",
                        body: Buffer.from(body, "utf8").toString("base64"),
                        contentType: "application/json",
                      },
                    ],
                  },
                ],
              },
            ],
          })),
        },
      ],
    }),
  );

  const { summary } = await collectDefects({
    projectRoot: root,
    testDir: "tests",
    outputDir: "artifacts/defects",
    reportPath: "artifacts/json/playwright-results.json",
    thresholds: THRESHOLDS,
    now: new Date("2026-10-17T09:30:00.000Z"),
    commit: "deadbeef",
    branch: "main",
    ...(expectations === undefined ? {} : { api: { directory: "artifacts/api", expectations } }),
  });
  return summary;
}

test.describe("the two verdicts", () => {
  test("the api verdict is absent when nothing was declared", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-gate-"));
    const summary = await collect(root, [capture(200, 1)], undefined);

    // Not present-and-clean: a run that declared no contracts was not audited.
    expect(summary.api).toBeUndefined();
  });

  test("a held contract reports clean, beside a passing gate", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-gate-"));
    const summary = await collect(root, [capture(200, 1)], [ITEMS]);

    expect(summary.gate.passed).toBe(true);
    expect(summary.api?.violations).toEqual([]);
    expect(summary.api?.counts.passed).toBe(1);
    expect(summary.api?.audit).toMatch(/api-audit\.v1\.json$/);
  });

  test("a broken contract is named in the summary, in the api block only", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-gate-"));
    const summary = await collect(root, [capture(500, 1)], [ITEMS]);

    // `gate` keeps its meaning and its own reasons. This is the test that would
    // fail if anyone folded the API verdict into it.
    expect(summary.gate.passed).toBe(true);
    expect(summary.gate.violations).toEqual([]);

    // The api block carries the finding, naming the endpoint and what was seen.
    expect(summary.api?.violations).toEqual(["GET /api/items: 200 — observed status 500"]);
  });

  test("an expectation nothing reached is named too, by its own rule", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-gate-"));
    const summary = await collect(root, [capture(200, 0)], [ITEMS]);

    expect(summary.api?.violations[0]).toContain("no exchange");
    expect(summary.api?.violations[0]).toContain("GET /api/items");
  });

  test("the exit code is the one place the two verdicts meet", async () => {
    // The real rule, called rather than copied. A first version of this test
    // re-implemented the expression inline, and breaking the CLI's own code left
    // it green: the copy is what made the check unable to fail.
    const held = await collect(
      mkdtempSync(path.join(tmpdir(), "qf-gate-")),
      [capture(200, 1)],
      [ITEMS],
    );
    const broken = await collect(
      mkdtempSync(path.join(tmpdir(), "qf-gate-")),
      [capture(500, 1)],
      [ITEMS],
    );
    const undeclared = await collect(
      mkdtempSync(path.join(tmpdir(), "qf-gate-")),
      [capture(500, 1)],
      undefined,
    );

    expect(runExitCode(held)).toBe(0);
    // The owner's decision: a broken contract stops the run, even with every test
    // green — which is exactly the case no defect would have reported.
    expect(runExitCode(broken)).toBe(1);
    // And a run with nothing declared is judged only on its tests.
    expect(runExitCode(undeclared)).toBe(0);
  });

  test("the bump is minor, because no existing field changed meaning", () => {
    // Pinned rather than ranged, so every addition to the summary forces a conscious
    // decision about the number instead of drifting past it. It is 1.6.0 now because
    // `summary.policy` arrived after `summary.api`, and it is still a 1.x: three
    // summary-only changes in a row, and a `v2` would be the price of two added blocks.
    expect(DEFECT_SCHEMA_VERSION).toBe("1.6.0");
  });
});
