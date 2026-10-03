import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyAttempts,
  collectDefects,
  defectIdFrom,
  makeRunId,
  originOf,
  stripAnsi,
} from "../../src/defect/collect.js";
import { validateDefect } from "../../src/defect/types.js";
import type { TestStatus } from "../../src/defect/types.js";

// Real escape sequences, with the literal ESC byte. Stripping them out for
// readability would mean stripAnsi was never actually exercised, and the test
// would pass for the wrong reason.
const ESC = "";
const RED = `${ESC}[31m`;
const RESET = `${ESC}[39m`;

/**
 * A Playwright JSON report shaped exactly like the real 1.63.0 output,
 * verified against a live run rather than assumed. Field names, the absolute
 * attachment paths and the ANSI codes in error.message are all load-bearing.
 */
function reportWith(
  root: string,
  results: {
    status: string;
    retry?: number;
    attachments?: { name: string; path: string }[];
  }[],
): string {
  return JSON.stringify({
    config: { rootDir: root },
    stats: { startTime: "2026-10-03T00:00:00.000Z", duration: 1234.5 },
    suites: [
      {
        title: "tests/smoke/demo.spec.ts",
        file: "smoke/demo.spec.ts",
        specs: [
          {
            id: "abc123",
            title: "shows the status",
            file: "smoke/demo.spec.ts",
            line: 11,
            column: 3,
            tags: ["smoke"],
            tests: [
              {
                projectName: "chromium",
                expectedStatus: "passed",
                results: results.map((r) => ({
                  status: r.status,
                  retry: r.retry ?? 0,
                  duration: 100,
                  startTime: "2026-10-03T00:00:00.000Z",
                  attachments: r.attachments ?? [],
                  error: {
                    message: `Error: expect(locator).${RED}toHaveText${RESET} failed\n\nExpected: "a"\nReceived: "b"`,
                    snippet: "> 11 |   await expect(x).toHaveText('a');",
                    // Absolute, exactly as the real reporter writes it, and
                    // rooted at the sandbox so relativisation has to do work.
                    location: {
                      file: path.join(root, "tests/smoke/demo.spec.ts"),
                      line: 11,
                      column: 3,
                    },
                    stack: `${RED}Error: boom${RESET}`,
                  },
                })),
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Build a throwaway project tree.
 *
 * `files` may be a function of the freshly created root, because several tests
 * need to reference paths inside the sandbox that cannot exist until it does.
 */
async function scaffold(
  files: Record<string, string> | ((root: string) => Record<string, string>),
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "qf-collect-"));
  await mkdir(path.join(root, "artifacts/json"), { recursive: true });
  await mkdir(path.join(root, "tests/smoke"), { recursive: true });
  await writeFile(
    path.join(root, "tests/smoke/demo.spec.ts"),
    "import { test } from '@playwright/test';\n",
  );
  const resolved = typeof files === "function" ? files(root) : files;
  for (const [name, content] of Object.entries(resolved)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const THRESHOLDS = { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 };

test.describe("pure helpers", () => {
  test("stripAnsi removes colour codes and keeps the message readable", () => {
    const dirty = `Error: expect(${RED}locator${RESET}) failed`;
    const clean = stripAnsi(dirty);

    expect(clean).toBe("Error: expect(locator) failed");
    expect(clean).not.toContain("");
  });

  test("originOf reduces a URL to its origin and drops secrets", () => {
    expect(originOf("https://user:token@example.com/app?x=1#frag")).toBe("https://example.com");
    expect(originOf("http://127.0.0.1:4311")).toBe("http://127.0.0.1:4311");
    expect(originOf("not a url")).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
  });

  test("defectIdFrom is stable and kebab-case", () => {
    const first = defectIdFrom("tests/smoke/homepage.smoke.spec.ts", "renders the heading!");

    expect(first).toBe("homepage-smoke-renders-the-heading");
    expect(defectIdFrom("tests/smoke/homepage.smoke.spec.ts", "renders the heading!")).toBe(first);
    expect(first).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("defectIdFrom survives a title with no usable characters", () => {
    expect(defectIdFrom("tests/a.spec.ts", "!!!")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("makeRunId is sortable and unique per instant", () => {
    const first = makeRunId(new Date("2026-10-03T00:00:00.000Z"));
    const second = makeRunId(new Date("2026-10-03T00:00:00.001Z"));

    expect(first).not.toBe(second);
    expect(first.startsWith("2026-10-03T00-00-00-000Z-")).toBe(true);
    expect(first).not.toContain(":");
  });

  test("classifyAttempts calls a single attempt unknown rather than guessing", () => {
    // One observation is not evidence of a pattern.
    expect(classifyAttempts(["failed"])).toMatchObject({ verdict: "unknown", failed: 1 });
  });

  test("classifyAttempts detects flakiness across a retry", () => {
    expect(classifyAttempts(["failed", "passed"])).toMatchObject({
      verdict: "flaky",
      passed: 1,
      failed: 1,
    });
  });

  test("classifyAttempts reports a consistently failing test", () => {
    expect(classifyAttempts(["failed", "failed"])).toMatchObject({ verdict: "failing", failed: 2 });
  });
});

test.describe("validateDefect", () => {
  test("rejects an artifact that is not an object", () => {
    expect(validateDefect(null).valid).toBe(false);
  });

  test("accepts a minimal valid artifact", () => {
    const result = validateDefect({
      schemaVersion: "1.0.0",
      id: "demo-shows-the-status",
      runId: "run-1",
      createdAt: "2026-10-03T00:00:00.000Z",
      status: "failed",
      test: { title: "t", file: "tests/a.spec.ts" },
      failure: { message: "boom" },
      evidence: {},
      context: {},
      flakiness: { verdict: "unknown" },
    });

    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("rejects an uppercase id, which the contract forbids", () => {
    const result = validateDefect({
      schemaVersion: "1.0.0",
      id: "Demo_Shows",
      runId: "run-1",
      createdAt: "2026-10-03T00:00:00.000Z",
      status: "failed",
      test: { title: "t", file: "a.spec.ts" },
      failure: { message: "boom" },
      evidence: {},
      context: {},
      flakiness: { verdict: "unknown" },
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join()).toContain("kebab-case");
  });

  test("rejects a createdAt that is not ISO 8601", () => {
    const result = validateDefect({
      schemaVersion: "1.0.0",
      id: "a-b",
      runId: "run-1",
      createdAt: "yesterday",
      status: "failed",
      test: { title: "t", file: "a.spec.ts" },
      failure: { message: "boom" },
      evidence: {},
      context: {},
      flakiness: { verdict: "unknown" },
    });

    expect(result.problems.join()).toContain("ISO 8601");
  });
});

test.describe("collectDefects", () => {
  test("writes one artifact per failure plus a run summary", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [{ status: "failed" }]),
    }));

    const { defects, summary, runDir } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      referenceErrorContext: true,
      thresholds: THRESHOLDS,
      now: new Date("2026-10-03T01:02:03.000Z"),
      commit: "deadbeef",
      branch: "main",
    });

    expect(defects).toHaveLength(1);
    expect(summary.counts.specs).toBe(1);
    expect(summary.counts.failed).toBe(1);

    const written = JSON.parse(
      await readFile(path.join(runDir, "quality-summary.v1.json"), "utf8"),
    ) as { defects: string[]; gate: { passed: boolean } };

    expect(written.defects).toHaveLength(1);
    // One failure out of one spec is a 100% failure rate, above the threshold.
    expect(written.gate.passed).toBe(false);
  });

  test("resolves the test file relative to testDir and strips ANSI from the message", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [{ status: "failed" }]),
    }));

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      referenceErrorContext: true,
      thresholds: THRESHOLDS,
    });

    const defect = defects[0];
    expect(defect?.test.file).toBe("tests/smoke/demo.spec.ts");
    expect(defect?.test.line).toBe(11);
    expect(defect?.test.project).toBe("chromium");
    expect(defect?.failure.message).not.toContain("");
    expect(defect?.failure.message).toContain('Expected: "a"');
    expect(defect?.failure.location?.file).toBe("tests/smoke/demo.spec.ts");
  });

  test("records evidence only when the runner actually attached it", async () => {
    const shot = "/tmp/qf-fake/test-results/x/test-failed-1.png";
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [
        { status: "failed", attachments: [{ name: "screenshot", path: shot }] },
      ]),
    }));
    // The referenced file does not exist, so the pointer must be omitted
    // rather than recorded as a dangling path.
    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      referenceErrorContext: true,
      thresholds: THRESHOLDS,
    });

    expect(defects[0]?.evidence).toEqual({});
  });

  test("records errorContextRef when referenceErrorContext is on", async () => {
    // The attachment has to point at a file that exists, so the report is
    // written after the sandbox exists and the context file is seeded first.
    const root = await scaffold(() => ({
      "test-results/x/error-context.md": "# Instructions\n",
    }));
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        {
          status: "failed",
          attachments: [
            { name: "error-context", path: path.join(root, "test-results/x/error-context.md") },
          ],
        },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      referenceErrorContext: true,
      thresholds: THRESHOLDS,
    });

    expect(defects[0]?.failure.errorContextRef).toBe("test-results/x/error-context.md");
  });

  test("keeps no errorContextRef when the flag is off", async () => {
    const root = await scaffold(() => ({
      "test-results/x/error-context.md": "# Instructions\n",
    }));
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        {
          status: "failed",
          attachments: [
            { name: "error-context", path: path.join(root, "test-results/x/error-context.md") },
          ],
        },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      referenceErrorContext: false,
      thresholds: THRESHOLDS,
    });

    expect(defects[0]?.failure.errorContextRef).toBeUndefined();
  });

  test("writes no artifacts for a passing run", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [{ status: "passed" }]),
    }));

    const { defects, summary } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: THRESHOLDS,
    });

    expect(defects).toHaveLength(0);
    expect(summary.counts.passed).toBe(1);
    expect(summary.gate.passed).toBe(true);
  });

  test("classifies a spec that passed only on retry as flaky", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [
        { status: "failed", retry: 0 },
        { status: "passed", retry: 1 },
      ]),
    }));

    const { defects, summary } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: THRESHOLDS,
    });

    // Passed overall, so no defect artifact, but the run is still flagged.
    expect(defects).toHaveLength(0);
    expect(summary.counts.flaky).toBe(1);
    expect(summary.gate.violations.join()).toContain("passed only after a retry");
  });

  test("records full retry history for a consistently failing spec", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [
        { status: "failed", retry: 0 },
        { status: "failed", retry: 1 },
      ]),
    }));

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxAttemptsPerTest: 2 },
    });

    const defect = defects[0];
    expect(defect?.flakiness.verdict).toBe("failing");
    expect(defect?.retryHistory).toHaveLength(2);
    expect(defect?.retryHistory?.map((r) => r.attempt)).toEqual([0, 1]);
  });

  test("fails with an actionable message when the report is missing", async () => {
    const root = await scaffold(() => ({}));

    await expect(
      collectDefects({
        projectRoot: root,
        testDir: "tests",
        outputDir: "artifacts/defects",
        reportPath: "artifacts/json/playwright-results.json",
        thresholds: THRESHOLDS,
      }),
    ).rejects.toThrow(/Run the suite first/);
  });

  test("emits only contract-valid artifacts", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [{ status: "failed" }]),
    }));

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: THRESHOLDS,
    });

    for (const defect of defects) {
      const result = validateDefect(JSON.parse(JSON.stringify(defect)));
      expect(result.problems).toEqual([]);
    }
  });
});

test.describe("status mapping", () => {
  const cases: { status: string; expected: DefectStatusProbe }[] = [
    { status: "failed", expected: "failed" },
    { status: "timedOut", expected: "timedOut" },
    { status: "interrupted", expected: "interrupted" },
  ];

  for (const { status, expected } of cases) {
    test(`maps a ${status} attempt to a defect with status ${expected}`, async () => {
      const root = await scaffold((sandbox) => ({
        "artifacts/json/playwright-results.json": reportWith(sandbox, [{ status }]),
      }));

      const { defects } = await collectDefects({
        projectRoot: root,
        testDir: "tests",
        outputDir: "artifacts/defects",
        reportPath: "artifacts/json/playwright-results.json",
        thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
      });

      expect(defects[0]?.status).toBe(expected);
    });
  }

  test("an unknown status is not silently treated as passed", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [
        { status: "weird-new-status" },
      ]),
    }));

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    // Fail closed: an unknown status becomes a defect, never a pass.
    expect(defects).toHaveLength(1);
    expect(defects[0]?.status).toBe("failed");
  });
});

/** Terminal statuses a defect may carry, mirroring the contract. */
type DefectStatusProbe = "failed" | "timedOut" | "skipped" | "interrupted";

// Compile-time guard: the probe union must stay a subset of TestStatus, or the
// table above stops type-checking.
const _probe: readonly TestStatus[] = ["failed", "timedOut", "interrupted"];
void _probe;
