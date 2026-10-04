import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectDefects, defectIdFrom } from "../../src/defect/collect.js";
import {
  compositionKey,
  readHistory,
  readHistoryRecords,
  recordHistory,
  rotateHistory,
} from "../../src/defect/history.js";
import { flakinessReport, trendReport } from "../../src/defect/flakiness.js";

/**
 * The acceptance test for run history: two real collections, and the verdict that
 * has to come out of them different.
 *
 * History exists to separate a flaky spec from a regression. If these two runs read
 * the same, the feature is decoration — and the way they would read the same is by
 * treating "no record of a pass" as "not present", which is what a bare failure log
 * does. Presence therefore comes from the composition, and this test is where that
 * claim is checked rather than asserted in a comment.
 */

const THRESHOLDS = { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 };

interface SpecOutcome {
  title: string;
  status: string;
}

/**
 * A report whose specs are exactly the ones given, in that order.
 *
 * Not a fixture borrowed from the collector's tests: those describe one spec, and
 * the question here is what happens when a spec is present in one run and absent
 * from the next, which needs at least two.
 */
function reportWithSpecs(root: string, specs: SpecOutcome[]): string {
  return JSON.stringify({
    config: { rootDir: path.join(root, "tests") },
    stats: { startTime: "2026-10-04T00:00:00.000Z", duration: 1000 },
    suites: [
      {
        title: "tests/smoke/demo.spec.ts",
        file: "smoke/demo.spec.ts",
        specs: specs.map((spec, index) => ({
          id: `id${index}`,
          title: spec.title,
          file: "smoke/demo.spec.ts",
          line: 10 + index,
          column: 3,
          tags: [],
          tests: [
            {
              projectName: "chromium",
              expectedStatus: "passed",
              results: [
                {
                  status: spec.status,
                  retry: 0,
                  duration: 50,
                  startTime: "2026-10-04T00:00:00.000Z",
                  attachments: [],
                  ...(spec.status === "passed"
                    ? {}
                    : {
                        error: {
                          message: `Error: expect(received).toBe(expected) failed\nExpected: "ok"`,
                          location: {
                            file: path.join(root, "tests/smoke/demo.spec.ts"),
                            line: 10 + index,
                            column: 3,
                          },
                        },
                      }),
                },
              ],
            },
          ],
        })),
      },
    ],
  });
}

async function scaffold(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "qf-history-"));
  await mkdir(path.join(root, "tests/smoke"), { recursive: true });
  await writeFile(
    path.join(root, "tests/smoke/demo.spec.ts"),
    "import { test } from '@playwright/test';\n",
  );
  return root;
}

async function runOnce(options: {
  root: string;
  specs: SpecOutcome[];
  now: Date;
  keep?: number;
}): Promise<string> {
  const reportPath = "artifacts/json/results.json";
  await mkdir(path.join(options.root, "artifacts/json"), { recursive: true });
  await writeFile(
    path.join(options.root, reportPath),
    reportWithSpecs(options.root, options.specs),
    "utf8",
  );

  const { history } = await collectDefects({
    projectRoot: options.root,
    testDir: "tests",
    outputDir: "artifacts/defects",
    reportPath,
    thresholds: THRESHOLDS,
    now: options.now,
    history: { directory: "quality-history", keep: options.keep ?? 10 },
  });

  expect(history?.failed, `history write failed: ${history?.failed ?? ""}`).toBeUndefined();
  return history?.path ?? "";
}

test.describe("two real collections", () => {
  test("a flaky spec and a regression are not the same verdict", async () => {
    const root = await scaffold();

    // Run 1: a and b both fail, c passes, and d does not exist yet.
    await runOnce({
      root,
      now: new Date("2026-10-04T01:00:00.000Z"),
      specs: [
        { title: "a", status: "failed" },
        { title: "b", status: "failed" },
        { title: "c", status: "passed" },
      ],
    });

    // Run 2: a fails again, b recovers, c and d are healthy-looking but d is new
    // and broken. Four different histories in one window.
    await runOnce({
      root,
      now: new Date("2026-10-04T01:00:05.000Z"),
      specs: [
        { title: "a", status: "failed" },
        { title: "b", status: "passed" },
        { title: "c", status: "passed" },
        { title: "d", status: "failed" },
      ],
    });

    const records = await readHistoryRecords(root, "quality-history");
    expect(records).toHaveLength(2);
    // Presence must be real, not guessed: a missing composition would collapse the
    // distinction this test is about.
    expect(records.every((record) => record.complete)).toBe(true);

    const report = flakinessReport(records);
    expect(report.window).toBe(2);
    expect(report.partial).toBeUndefined();

    const byId = new Map(report.tests.map((entry) => [entry.id, entry]));
    const verdict = (title: string): string | undefined =>
      byId.get(defectIdFrom("smoke/demo.spec.ts", title))?.verdict;

    // Failed in every run it was in: a regression, not a flake.
    expect(verdict("a")).toBe("failing");
    // Failed once and passed once: a flake. This is the assertion that a bare
    // failure log cannot satisfy, because b's pass leaves no outcome of its own.
    expect(verdict("b")).toBe("flaky");
    // Never failed, so it is not a question worth asking.
    expect(verdict("c")).toBeUndefined();
    // First appearance in the window, and it failed.
    expect(verdict("d")).toBe("new");

    // b's pass must be credited from presence, not from an outcome entry.
    const b = byId.get(defectIdFrom("smoke/demo.spec.ts", "b"));
    expect(b?.runs).toBe(2);
    expect(b?.failedRuns).toBe(1);
    expect(b?.otherRuns).toBe(1);
  });

  test("the two runs share one composition only while the suite is unchanged", async () => {
    const root = await scaffold();
    const specs: SpecOutcome[] = [
      { title: "a", status: "failed" },
      { title: "b", status: "passed" },
    ];

    await runOnce({ root, now: new Date("2026-10-04T02:00:00.000Z"), specs });
    await runOnce({ root, now: new Date("2026-10-04T02:00:01.000Z"), specs });
    await runOnce({
      root,
      now: new Date("2026-10-04T02:00:02.000Z"),
      specs: [...specs, { title: "c", status: "passed" }],
    });

    const entries = await readHistory(root, "quality-history");
    expect(entries).toHaveLength(3);

    // Three runs, two compositions: the id list is stored once per state rather than
    // three hundred ids per run, which is what keeps this committable.
    expect(new Set(entries.map((entry) => entry.composition)).size).toBe(2);
    const compositions = await readdir(path.join(root, "quality-history/compositions"));
    expect(compositions).toHaveLength(2);

    // The membership change is visible from the composition alone, without opening
    // every run: that is how a reader tells "added" from "was always broken".
    const first = entries[0];
    const keys = entries.map((entry) => entry.composition);
    const idsOf = async (key: string): Promise<string[]> => {
      const parsed = JSON.parse(
        await readFile(path.join(root, "quality-history/compositions", `${key}.json`), "utf8"),
      ) as { specIds: string[] };
      return parsed.specIds;
    };
    expect(keys[0]).toBeDefined();
    expect(keys[2]).toBeDefined();
    expect(await idsOf(keys[0] as string)).toHaveLength(2);
    expect(await idsOf(keys[2] as string)).toHaveLength(3);
    expect(first?.composition).toBe(keys[0]);
  });

  test("an entry stays small enough to commit", async () => {
    const root = await scaffold();
    // Forty specs, all passing but one: the size of a real suite's shape without
    // needing a real suite's runtime.
    const specs: SpecOutcome[] = Array.from({ length: 40 }, (_, i) => ({
      title: `spec ${i}`,
      status: i === 7 ? "failed" : "passed",
    }));

    await runOnce({ root, now: new Date("2026-10-04T03:00:00.000Z"), specs });

    const [name] = (await readdir(path.join(root, "quality-history"))).filter((file) =>
      file.endsWith(".json"),
    );
    expect(name).toBeDefined();
    const raw = await readFile(path.join(root, "quality-history", name ?? ""), "utf8");

    // Forty ids repeated per run would be several kilobytes; the entry holds one
    // hash and the single spec that did not pass.
    expect(raw.length).toBeLessThan(1000);
    const parsed = JSON.parse(raw) as { outcomes: Record<string, string> };
    expect(Object.keys(parsed.outcomes)).toHaveLength(1);
  });
});

test.describe("rotation", () => {
  /**
   * Write `count` runs, rotating after each, with the composition changing after
   * the first two — the shape of a suite that gained a spec and stayed that way.
   */
  async function writeRuns(root: string, count: number, keep: number): Promise<string[]> {
    const removed: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const runId = `2026-10-04T0${i}0000-000Z-dead${i}`;
      const specIds = i < 2 ? ["spec-a", "spec-b"] : ["spec-a", "spec-b", "spec-c"];
      const rotated = await rotateHistory({
        projectRoot: root,
        directory: "quality-history",
        keep,
      });
      removed.push(...rotated.removed);
      await recordHistory({
        projectRoot: root,
        directory: "quality-history",
        keep,
        specIds,
        entry: {
          schemaVersion: "1.0.0" as const,
          runId,
          createdAt: `2026-10-04T0${i}00:00.000Z`,
          counts: {
            specs: specIds.length,
            passed: 1,
            failed: 0,
            timedOut: 0,
            skipped: 0,
            flaky: 0,
            aborted: 0,
          },
          outcomes: {},
        },
      });
    }
    removed.push(
      ...(await rotateHistory({ projectRoot: root, directory: "quality-history", keep })).removed,
    );
    return removed;
  }

  test("keeps the newest runs and drops compositions nobody references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-rotate-"));
    const removed = await writeRuns(root, 5, 2);
    expect(removed).toHaveLength(3);

    const dir = path.join(root, "quality-history");
    const runs = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    expect(runs.sort()).toEqual([
      "2026-10-04T030000-000Z-dead3.json",
      "2026-10-04T040000-000Z-dead4.json",
    ]);

    const kept = (await readHistory(root, "quality-history")).map((entry) => entry.composition);
    const compositions = (await readdir(path.join(dir, "compositions"))).map((file) =>
      file.replace(/\.json$/, ""),
    );
    // Nothing left that no kept run points at — the large half cannot accumulate.
    for (const key of compositions) expect(kept).toContain(key);
    // Both surviving runs share the composition they grew into; the one from before
    // the suite changed is now referenced by nothing and is gone.
    expect(compositions).toHaveLength(1);
    expect(kept).toEqual([compositions[0], compositions[0]]);
  });

  test("files it did not write are left alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-rotate-"));
    const dir = path.join(root, "quality-history");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "notes.txt"), "mine\n", "utf8");
    await writeFile(path.join(dir, "other.json"), "{}\n", "utf8");

    await writeRuns(root, 3, 1);

    expect((await readdir(dir)).sort()).toEqual([
      "2026-10-04T020000-000Z-dead2.json",
      "compositions",
      "notes.txt",
      "other.json",
    ]);
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("mine\n");
  });

  test("a missing history directory reads as no history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-none-"));
    expect(await readHistory(root, "quality-history")).toEqual([]);
    expect(await readHistoryRecords(root, "quality-history")).toEqual([]);
  });
});

test.describe("a composition that cannot be read", () => {
  test("is reported as partial rather than guessed quietly", async () => {
    const root = await scaffold();
    await runOnce({
      root,
      now: new Date("2026-10-04T04:00:00.000Z"),
      specs: [
        { title: "a", status: "failed" },
        { title: "b", status: "passed" },
      ],
    });
    await runOnce({
      root,
      now: new Date("2026-10-04T04:00:05.000Z"),
      specs: [
        { title: "a", status: "failed" },
        { title: "b", status: "passed" },
      ],
    });

    // Simulate a partial checkout: the composition files are gone, the entries are
    // not. This is the state a shallow clone or a hand-edited directory produces.
    const compositions = path.join(root, "quality-history/compositions");
    for (const file of await readdir(compositions)) {
      await writeFile(path.join(compositions, file), "{ not json", "utf8");
    }

    const records = await readHistoryRecords(root, "quality-history");
    expect(records).toHaveLength(2);
    expect(records.every((record) => !record.complete)).toBe(true);

    const report = flakinessReport(records);
    expect(report.partial).toBe(true);
    // Conservatively wrong: without a composition, a is present only where it was
    // recorded failing, so it reads as always-failing rather than as healthy. A
    // reader told "regression" investigates; a reader told "flake" waits.
    const a = report.tests.find((entry) => entry.id === defectIdFrom("smoke/demo.spec.ts", "a"));
    expect(a?.verdict).toBe("failing");
  });
});

test.describe("trend", () => {
  const run = (specs: number, passed: number, runId: string, durationMs?: number) => ({
    runId,
    createdAt: runId,
    counts: { specs, passed, failed: specs - passed },
    ...(durationMs === undefined ? {} : { durationMs }),
    outcomes: {},
  });

  test("says unknown under four runs rather than inventing a direction", () => {
    const points = [
      run(10, 8, "2026-10-01T00:00:00.000Z"),
      run(10, 9, "2026-10-02T00:00:00.000Z"),
      run(10, 7, "2026-10-03T00:00:00.000Z"),
    ];
    expect(trendReport(points).direction).toBe("unknown");
  });

  test("compares the first half of the window against the second", () => {
    const improving = [
      run(10, 5, "2026-10-01T00:00:00.000Z"),
      run(10, 6, "2026-10-02T00:00:00.000Z"),
      run(10, 9, "2026-10-03T00:00:00.000Z"),
      run(10, 10, "2026-10-04T00:00:00.000Z"),
    ];
    expect(trendReport(improving).direction).toBe("improving");

    const worsening = [...improving].reverse();
    expect(trendReport(worsening).direction).toBe("worsening");
  });

  test("counts distinct failing specs, not skips and not aborts", () => {
    const points = [
      {
        runId: "2026-10-01T00:00:00.000Z",
        counts: { specs: 3, passed: 1, failed: 1 },
        outcomes: { alpha: "failed", beta: "skipped", gamma: "aborted" },
      },
      {
        runId: "2026-10-02T00:00:00.000Z",
        counts: { specs: 3, passed: 2, failed: 1 },
        outcomes: { alpha: "failed", beta: "failed", delta: "failed" },
      },
    ];
    // alpha twice, beta once, delta once: three specs failed. gamma never ran.
    expect(trendReport(points).distinctFailing).toBe(3);
  });
});

test.describe("composition keys", () => {
  test("depend on the ids and their order, not on the run", () => {
    expect(compositionKey(["a", "b"])).toBe(compositionKey(["a", "b"]));
    expect(compositionKey(["a", "b"])).not.toBe(compositionKey(["b", "a"]));
    expect(compositionKey(["a", "b"])).not.toBe(compositionKey(["a", "c"]));
    expect(compositionKey(["a", "b"])).toMatch(/^[0-9a-f]{12}$/);
  });

  test("two ids that join with a newline hash differently from one id", () => {
    // The separator is what stops ["ab","c"] and ["a","bc"] from colliding.
    expect(compositionKey(["ab", "c"])).not.toBe(compositionKey(["a", "bc"]));
  });
});
