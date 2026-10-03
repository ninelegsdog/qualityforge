import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { readGitInfo } from "../../src/defect/git-info.js";
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
interface TestAttachment {
  name: string;
  path?: string;
  /** Inline content, base64 encoded exactly as the JSON reporter writes it. */
  body?: string;
}

function reportWith(
  root: string,
  results: {
    status: string;
    retry?: number;
    attachments?: TestAttachment[];
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

test.describe("git context", () => {
  const SHA = "7f9da99b76aed67545e6449fe0ee65fbeb59abcd";

  /**
   * Build a throwaway checkout.
   *
   * `git` is a map of path -> contents, and may be a function of the sandbox
   * root because a worktree pointer holds an absolute path: git writes
   * `gitdir: /abs/path`, and a helper that quietly rooted that at the sandbox
   * would produce a green test of a broken resolution.
   */
  async function checkout(
    git: Record<string, string> | ((root: string) => Record<string, string>),
  ): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "qf-git-"));
    for (const [name, contents] of Object.entries(typeof git === "function" ? git(root) : git)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }
    return root;
  }

  test("reads the branch and commit from a plain repository", async () => {
    const root = await checkout({
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${SHA}\n`,
    });

    const info = await readGitInfo(root);

    expect(info.commit).toBe(SHA);
    expect(info.branch).toBe("main");
    expect(info.problem).toBeUndefined();
  });

  test("follows the gitdir pointer a worktree leaves behind", async () => {
    // The shape `git worktree add` actually produces: `.git` is a file holding
    // an absolute path, HEAD is in the worktree's own directory, and the ref
    // lives in the main repository's, which `commondir` points at.
    const root = await checkout((r) => ({
      ".git": `gitdir: ${path.join(r, "repo/.git/worktrees/defects")}\n`,
      "repo/.git/worktrees/defects/HEAD": "ref: refs/heads/qf/defects\n",
      "repo/.git/worktrees/defects/commondir": "../..\n",
      "repo/.git/refs/heads/qf/defects": `${SHA}\n`,
    }));

    const info = await readGitInfo(root);

    expect(info.commit).toBe(SHA);
    expect(info.branch).toBe("qf/defects");
    expect(info.problem).toBeUndefined();
  });

  test("reads a worktree branch that only exists in packed-refs", async () => {
    const root = await checkout((r) => ({
      ".git": `gitdir: ${path.join(r, "repo/.git/worktrees/defects")}\n`,
      "repo/.git/worktrees/defects/HEAD": "ref: refs/heads/qf/defects\n",
      "repo/.git/worktrees/defects/commondir": "../..\n",
      "repo/.git/packed-refs": `# pack-refs with: peeled\n${SHA} refs/heads/qf/defects\n`,
    }));

    const info = await readGitInfo(root);

    expect(info.commit).toBe(SHA);
    expect(info.branch).toBe("qf/defects");
  });

  test("follows a gitdir pointer that is relative to the pointer file", async () => {
    // Submodules and older git versions write a relative pointer, resolved
    // against the directory holding the pointer file.
    const root = await checkout({
      ".git": "gitdir: repo/.git/worktrees/defects\n",
      "repo/.git/worktrees/defects/HEAD": "ref: refs/heads/main\n",
      "repo/.git/worktrees/defects/commondir": "../..\n",
      "repo/.git/refs/heads/main": `${SHA}\n`,
    });

    const info = await readGitInfo(root);

    expect(info.commit).toBe(SHA);
    expect(info.branch).toBe("main");
  });

  test("a detached HEAD is a commit with no branch, and that is not a problem", async () => {
    const root = await checkout({ ".git/HEAD": `${SHA}\n` });

    const info = await readGitInfo(root);

    expect(info.commit).toBe(SHA);
    expect(info.branch).toBeNull();
    expect(info.problem).toBeUndefined();
  });

  test("no git at all is a legitimate absence, not a failure to report", async () => {
    // A tarball export, or a Docker layer copied without .git. `null` is the
    // right answer here and there is nothing to warn about.
    const root = await mkdtemp(path.join(tmpdir(), "qf-git-"));

    const info = await readGitInfo(root);

    expect(info.commit).toBeNull();
    expect(info.branch).toBeNull();
    expect(info.problem).toBeUndefined();
  });

  test("a gitdir pointer to nowhere says so instead of returning null in silence", async () => {
    const root = await checkout((r) => ({
      ".git": `gitdir: ${path.join(r, "repo/.git/worktrees/gone")}\n`,
    }));

    const info = await readGitInfo(root);

    expect(info.commit).toBeNull();
    // The difference that matters: this null is "I could not tell", and it is
    // reported as such rather than looking identical to "there is no git here".
    expect(info.problem).toContain("gitdir");
  });

  test("a .git file without a gitdir pointer says so", async () => {
    const root = await checkout({ ".git": "this is not a git pointer\n" });

    const info = await readGitInfo(root);

    expect(info.problem).toContain("gitdir");
  });

  test("a branch with no ref anywhere names the missing ref", async () => {
    const root = await checkout({ ".git/HEAD": "ref: refs/heads/gone\n" });

    const info = await readGitInfo(root);

    expect(info.branch).toBe("gone");
    expect(info.commit).toBeNull();
    expect(info.problem).toContain("refs/heads/gone");
  });

  test("an unrecognised HEAD shape says so rather than returning null in silence", async () => {
    const root = await checkout({ ".git/HEAD": "garbage\n" });

    const info = await readGitInfo(root);

    expect(info.commit).toBeNull();
    expect(info.problem).toContain("HEAD");
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

test.describe("colliding ids", () => {
  /**
   * A report with one spec per suite, each in its own file.
   *
   * Two specs under one suite is not how Playwright reports a file, and
   * building the real shape matters: a collision has to be produced by the same
   * report structure the runner writes, not by a convenient one.
   */
  function twoSpecReport(
    root: string,
    specs: { file: string; title: string; line: number; message: string }[],
  ): string {
    return JSON.stringify({
      config: { rootDir: root },
      stats: { startTime: "2026-10-03T00:00:00.000Z", duration: 1234.5 },
      suites: specs.map((spec, i) => ({
        title: `tests/${spec.file}`,
        file: spec.file,
        specs: [
          {
            id: `spec-${i}`,
            title: spec.title,
            file: spec.file,
            line: spec.line,
            tests: [
              {
                projectName: "chromium",
                expectedStatus: "passed",
                results: [
                  {
                    status: "failed",
                    retry: 0,
                    duration: 10,
                    startTime: "2026-10-03T00:00:00.000Z",
                    error: { message: spec.message },
                  },
                ],
              },
            ],
          },
        ],
      })),
    });
  }

  const COLLIDE_OPTIONS = {
    testDir: "tests",
    outputDir: "artifacts/defects",
    reportPath: "artifacts/json/playwright-results.json",
    thresholds: THRESHOLDS,
  } as const;

  test("two failures with the same id stop the collection instead of overwriting", async () => {
    // Two files with the same basename: defectIdFrom() keeps only
    // path.basename(), so both slugify to the same id.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": twoSpecReport(sandbox, [
        { file: "smoke/a.spec.ts", title: "renders the heading", line: 10, message: "FIRST" },
        { file: "unit/a.spec.ts", title: "renders the heading", line: 20, message: "SECOND" },
      ]),
    }));

    await expect(collectDefects({ ...COLLIDE_OPTIONS, projectRoot: root })).rejects.toThrow(
      /duplicate defect id/,
    );
  });

  test("the collision message names both tests, so the fix is actionable", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": twoSpecReport(sandbox, [
        { file: "smoke/a.spec.ts", title: "renders the heading", line: 10, message: "FIRST" },
        { file: "unit/a.spec.ts", title: "renders the heading", line: 20, message: "SECOND" },
      ]),
    }));

    // A message that only says "duplicate id" leaves the reader to go and work
    // out which two tests collided.
    const thrown = await collectDefects({ ...COLLIDE_OPTIONS, projectRoot: root }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("a-renders-the-heading");
    expect(message).toContain("smoke/a.spec.ts:10");
    expect(message).toContain("unit/a.spec.ts:20");
  });

  test("the failure written before the collision is left exactly as it was", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": twoSpecReport(sandbox, [
        { file: "smoke/a.spec.ts", title: "renders the heading", line: 10, message: "FIRST" },
        { file: "unit/a.spec.ts", title: "renders the heading", line: 20, message: "SECOND" },
      ]),
    }));

    await expect(collectDefects({ ...COLLIDE_OPTIONS, projectRoot: root })).rejects.toThrow();

    // The whole point of failing closed: nothing already on disk is destroyed.
    // Before the fix this file held SECOND and the first failure was gone.
    const runDirs = await readdir(path.join(root, "artifacts/defects"));
    const runDir = runDirs[0] as string;
    expect(await readdir(path.join(root, "artifacts/defects", runDir))).toContain(
      "a-renders-the-heading.v1.json",
    );

    const onDisk = JSON.parse(
      await readFile(
        path.join(root, "artifacts/defects", runDir, "a-renders-the-heading.v1.json"),
        "utf8",
      ),
    ) as { failure: { message: string }; test: { file: string } };
    expect(onDisk.failure.message).toBe("FIRST");
    expect(onDisk.test.file).toBe("tests/smoke/a.spec.ts");
  });

  test("a colliding run writes no summary, so nothing on disk claims it completed", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": twoSpecReport(sandbox, [
        { file: "smoke/a.spec.ts", title: "renders the heading", line: 10, message: "FIRST" },
        { file: "unit/a.spec.ts", title: "renders the heading", line: 20, message: "SECOND" },
      ]),
    }));

    await expect(collectDefects({ ...COLLIDE_OPTIONS, projectRoot: root })).rejects.toThrow();

    const runDirs = await readdir(path.join(root, "artifacts/defects"));
    // A summary is a claim that the run was collected in full. This one was not.
    expect(await readdir(path.join(root, "artifacts/defects", runDirs[0] as string))).not.toContain(
      "quality-summary.v1.json",
    );
  });

  test("a title with no ASCII letters collides with its neighbour and is refused", async () => {
    // The other proven trigger: the slug is built from [a-z0-9], so a title in
    // any other script contributes nothing and two tests in one file collapse
    // onto the file name.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": twoSpecReport(sandbox, [
        { file: "smoke/homepage.smoke.spec.ts", title: "!!!", line: 5, message: "FIRST" },
        { file: "smoke/homepage.smoke.spec.ts", title: "???", line: 9, message: "SECOND" },
      ]),
    }));

    await expect(collectDefects({ ...COLLIDE_OPTIONS, projectRoot: root })).rejects.toThrow(
      /duplicate defect id/,
    );
  });

  test("titles truncated at the 120 character cap collide and are refused", async () => {
    // Long enough that the distinct tail falls past the cap: the slug keeps the
    // first 120 characters of `basename + title`, so both titles differ only in
    // the part that gets cut.
    const shared = "renders the heading with every one of its letters present ".repeat(3);
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": twoSpecReport(sandbox, [
        {
          file: "smoke/homepage.smoke.spec.ts",
          title: `${shared}FIRST`,
          line: 11,
          message: "FIRST",
        },
        {
          file: "smoke/homepage.smoke.spec.ts",
          title: `${shared}SECOND`,
          line: 13,
          message: "SECOND",
        },
      ]),
    }));

    await expect(collectDefects({ ...COLLIDE_OPTIONS, projectRoot: root })).rejects.toThrow(
      /duplicate defect id/,
    );
  });

  test("a defect that would take the summary's own filename is refused", async () => {
    // A file called quality-summary.spec.ts whose title slugifies to nothing
    // produces id "quality-summary", and its artifact filename is exactly the
    // one the run summary is written to — at the end of the run, with no
    // warning. Same bug, third path in.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": twoSpecReport(sandbox, [
        { file: "smoke/quality-summary.spec.ts", title: "!!!", line: 5, message: "FIRST" },
      ]),
    }));

    await expect(collectDefects({ ...COLLIDE_OPTIONS, projectRoot: root })).rejects.toThrow(
      /quality-summary/,
    );
  });

  test("two defects with different ids are still written side by side", async () => {
    // The guard must not cost the ordinary case.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": twoSpecReport(sandbox, [
        { file: "smoke/a.spec.ts", title: "renders the heading", line: 10, message: "FIRST" },
        { file: "smoke/b.spec.ts", title: "renders the footer", line: 20, message: "SECOND" },
      ]),
    }));

    const { defects, runDir } = await collectDefects({ ...COLLIDE_OPTIONS, projectRoot: root });

    expect(defects).toHaveLength(2);
    expect((await readdir(runDir)).sort()).toEqual([
      "a-renders-the-heading.v1.json",
      "b-renders-the-footer.v1.json",
      "quality-summary.v1.json",
    ]);
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

test.describe("signal enrichment", () => {
  /** Write a quality-context attachment into the sandbox and return its path. */
  async function seedSignals(root: string, payload: Record<string, unknown>): Promise<string> {
    const target = path.join(root, "test-results/x/quality-context.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return target;
  }

  test("folds a quality-context attachment into the artifact", async () => {
    const root = await scaffold(() => ({}));
    const signalsPath = await seedSignals(root, {
      signals: {
        consoleErrors: [{ type: "error", text: "Uncaught TypeError" }],
        pageErrors: ["TypeError: x is not a function"],
        httpErrors: [{ method: "GET", url: "https://api.example.com/items", status: 500 }],
        requestFailures: [],
      },
      dropped: 0,
    });
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        { status: "failed", attachments: [{ name: "quality-context", path: signalsPath }] },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    const signals = defects[0]?.signals;
    expect(signals?.consoleErrors).toHaveLength(1);
    expect(signals?.pageErrors?.[0]).toContain("TypeError");
    expect(signals?.httpErrors?.[0]?.status).toBe(500);
  });

  test("omits signals entirely when the attachment is absent", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": reportWith(sandbox, [{ status: "failed" }]),
    }));

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    // Absent means "not observed". An empty object would mean "observed, found
    // nothing", and those are different claims.
    expect(defects[0]).not.toHaveProperty("signals");
  });

  test("omits signals when the attachment contains nothing worth reporting", async () => {
    const root = await scaffold(() => ({}));
    const signalsPath = await seedSignals(root, {
      signals: {
        consoleErrors: [],
        consoleWarnings: [],
        pageErrors: [],
        requestFailures: [],
        httpErrors: [],
      },
      dropped: 0,
    });
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        { status: "failed", attachments: [{ name: "quality-context", path: signalsPath }] },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    expect(defects[0]).not.toHaveProperty("signals");
  });

  test("keeps the dropped count so a truncated capture is visible", async () => {
    const root = await scaffold(() => ({}));
    const signalsPath = await seedSignals(root, {
      signals: { pageErrors: ["first"] },
      dropped: 17,
    });
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        { status: "failed", attachments: [{ name: "quality-context", path: signalsPath }] },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    expect(defects[0]?.signals?.dropped).toBe(17);
  });

  test("reads an inline attachment carried as base64, not as a path", async () => {
    // This is the shape testInfo.attach({ body }) produces: nothing is written
    // to disk, so a reader that requires `path` sees no attachment at all.
    const root = await scaffold(() => ({}));
    const payload = Buffer.from(
      JSON.stringify({
        signals: { pageErrors: ["TypeError: entities is not a function"] },
        dropped: 0,
      }),
      "utf8",
    ).toString("base64");

    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        {
          status: "failed",
          attachments: [{ name: "quality-context", body: payload }],
        },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    expect(defects[0]?.signals?.pageErrors?.[0]).toContain("TypeError");
  });

  test("prefers inline body over path when both are somehow present", async () => {
    const root = await scaffold(() => ({}));
    const decoy = path.join(root, "test-results/x/decoy.json");
    await mkdir(path.dirname(decoy), { recursive: true });
    await writeFile(decoy, JSON.stringify({ signals: { pageErrors: ["from path"] } }), "utf8");

    const payload = Buffer.from(
      JSON.stringify({ signals: { pageErrors: ["from body"] }, dropped: 0 }),
      "utf8",
    ).toString("base64");

    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        {
          status: "failed",
          attachments: [{ name: "quality-context", path: decoy, body: payload }],
        },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    expect(defects[0]?.signals?.pageErrors?.[0]).toBe("from body");
  });

  test("undecodable inline body leaves signals absent instead of throwing", async () => {
    const root = await scaffold(() => ({}));
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        { status: "failed", attachments: [{ name: "quality-context", body: "" }] },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    expect(defects).toHaveLength(1);
    expect(defects[0]).not.toHaveProperty("signals");
  });

  test("a malformed attachment does not fail collection", async () => {
    const root = await scaffold(() => ({}));
    const target = path.join(root, "test-results/x/quality-context.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{ this is not json", "utf8");
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        { status: "failed", attachments: [{ name: "quality-context", path: target }] },
      ]),
    );

    const { defects } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
    });

    // The defect is still worth recording even if its context file is corrupt.
    expect(defects).toHaveLength(1);
    expect(defects[0]).not.toHaveProperty("signals");
  });
});
