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
  resolveTarget,
  stripAnsi,
} from "../../src/defect/collect.js";
import { readGitInfo } from "../../src/defect/git-info.js";
import {
  capturePageContext,
  shouldAttachContext,
  type PageLike,
} from "../../src/defect/page-context.js";
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
    config: { rootDir: path.join(root, "tests") },
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

  test("run ids sort as strings into the same order as the instants they name", () => {
    // `ArtifactStore.latestRun` picks a run by `b.runId.localeCompare(a.runId)`,
    // so "the latest run" is decided by a string comparison and nothing else.
    // That is only the same answer as "the most recent run" because every field
    // of the timestamp is fixed width: drop the zero-padding on a month, or stop
    // emitting milliseconds, and `2026-9-9` sorts after `2026-10-01` with nothing
    // anywhere reporting a problem.
    //
    // The dates below are chosen for the fields that would break: single-digit
    // month, day, hour and minute, a day boundary, a month boundary, a year
    // boundary, and a leap day. A format change that broke ordering would break
    // one of these.
    const instants = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-09T00:00:00.000Z",
      "2026-02-28T23:59:59.999Z",
      "2026-03-01T00:00:00.000Z",
      "2026-09-09T09:09:09.009Z",
      "2026-10-01T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
      "2026-10-03T00:00:00.001Z",
      "2026-10-09T19:59:00.000Z",
      "2026-10-31T23:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "2028-02-29T12:00:00.000Z",
    ].map((iso) => new Date(iso));

    const ids = instants.map((at) => makeRunId(at));

    // Every field keeps its width, which is the property doing the work.
    for (const id of ids) {
      expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/);
    }

    // The store's own comparison, against the order it is supposed to mean.
    const byString = [...ids].sort((a, b) => b.localeCompare(a));
    const byInstant = [...instants]
      .sort((a, b) => b.getTime() - a.getTime())
      .map((at) => makeRunId(at));

    expect(byString).toEqual(byInstant);
  });

  test("two runs in the same millisecond share a run id, which is a known limit", () => {
    // Pinned because it is counter-intuitive, not because it is desirable. The
    // digest is derived from the same instant the stamp already encodes, so it
    // adds no uniqueness: same instant, same id, and both runs would write into
    // one directory.
    //
    // Reachable only by collecting twice inside a millisecond, which no CI leg
    // does. If this ever starts failing, the fix is not in this test - it is that
    // the id needs a real uniqueness source, and that is an artifact-contract
    // change rather than a bug fix.
    const at = new Date("2026-10-03T00:00:00.000Z");

    expect(makeRunId(at)).toBe(makeRunId(at));
    // Still correctly ordered against its neighbours, which is what the store
    // relies on.
    expect(makeRunId(at) < makeRunId(new Date("2026-10-03T00:00:00.001Z"))).toBe(true);
    expect(makeRunId(new Date("2026-10-02T23:59:59.999Z")) < makeRunId(at)).toBe(true);
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

  test("accepts an artifact carrying a page", () => {
    const result = validateDefect({
      schemaVersion: "1.1.0",
      id: "a-b",
      runId: "run-1",
      createdAt: "2026-10-03T00:00:00.000Z",
      status: "failed",
      test: { title: "t", file: "a.spec.ts" },
      failure: { message: "boom" },
      evidence: {},
      context: {},
      page: { url: "https://example.com/form" },
      flakiness: { verdict: "unknown" },
    });

    expect(result.problems).toEqual([]);
  });

  test("rejects a page with no url, which states nothing actionable", () => {
    const result = validateDefect({
      schemaVersion: "1.1.0",
      id: "a-b",
      runId: "run-1",
      createdAt: "2026-10-03T00:00:00.000Z",
      status: "failed",
      test: { title: "t", file: "a.spec.ts" },
      failure: { message: "boom" },
      evidence: {},
      context: {},
      page: { title: "Contact form" },
      flakiness: { verdict: "unknown" },
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join()).toContain("page.url");
  });

  test("rejects a targetSource outside the vocabulary", () => {
    const result = validateDefect({
      schemaVersion: "1.1.0",
      id: "a-b",
      runId: "run-1",
      createdAt: "2026-10-03T00:00:00.000Z",
      status: "failed",
      test: { title: "t", file: "a.spec.ts" },
      failure: { message: "boom" },
      evidence: {},
      context: { targetSource: "guesswork" },
      flakiness: { verdict: "unknown" },
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join()).toContain("context.targetSource");
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

  test("records the size of the referenced error-context.md", async () => {
    // The artifact references this file rather than embedding it, so without a
    // size a reader cannot tell whether they are about to open 3 KB or 34 KB.
    const body = "# Instructions\n" + "x".repeat(500);
    const root = await scaffold(() => ({
      "test-results/x/error-context.md": body,
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

    expect(defects[0]?.failure.errorContextBytes).toBe(Buffer.byteLength(body));
  });

  test("a reference without a readable file records a path but no size", async () => {
    // Absent size is the honest answer for a file that is not there. Guessing a
    // size would be worse than not having the field.
    const root = await scaffold(() => ({}));
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      reportWith(root, [
        {
          status: "failed",
          attachments: [{ name: "error-context", path: path.join(root, "test-results/gone.md") }],
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

    // The defect is still real and still written; only the evidence pointer is
    // absent, because a path to a file that is not there would be a lie. An
    // absent size must not become a zero, which would read as "empty file".
    expect(defects).toHaveLength(1);
    expect(defects[0]?.failure.errorContextRef).toBeUndefined();
    expect(defects[0]?.failure.errorContextBytes).toBeUndefined();
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

test.describe("what the fixture decides to record", () => {
  /**
   * The rule the fixture used before this fix, kept so the expectations below
   * read as a difference rather than as a preference.
   *
   * It is what `testInfo.status !== testInfo.expectedStatus` evaluates to.
   */
  const previousRule = (status: string, expectedStatus: string): boolean =>
    status !== expectedStatus;

  test("an expected failure still attaches, because it is the moment evidence matters", () => {
    // test.fail() is the natural way to write a test asserting a bug exists.
    // For an expected failure status and expectedStatus are equal, so comparing
    // them produced no attachment at all: evidence deleted at exactly the moment
    // someone wanted it. This is the whole defect, in one line.
    expect(previousRule("failed", "failed")).toBe(false);
    expect(shouldAttachContext("failed", "failed", true)).toBe(true);
  });

  test("an expected failure that passes unexpectedly attaches nothing", () => {
    // test.fail() and the test passed: the runner reports status "passed" against
    // an expected "failed". Both rules agree this is not a failure to record, and
    // it is worth saying out loud that the fix did not widen this case.
    expect(shouldAttachContext("passed", "failed", true)).toBe(false);
  });

  test("a genuinely unexpected failure attaches", () => {
    expect(shouldAttachContext("failed", "passed", true)).toBe(true);
  });

  test("a passing test attaches nothing, expected or not", () => {
    expect(shouldAttachContext("passed", "passed", true)).toBe(false);
  });

  test("a timeout attaches, because the page state at a timeout is the evidence", () => {
    // Narrowing the rule to status === "failed" would fix the reported case and
    // introduce a quieter version of the same bug: a timeout is a defect, and a
    // timed-out test has more page state worth recording than a passing one.
    // The previous rule already attached here, so this is not a widening.
    expect(previousRule("timedOut", "passed")).toBe(true);
    expect(shouldAttachContext("timedOut", "passed", true)).toBe(true);
  });

  test("an interrupted test attaches too", () => {
    expect(previousRule("interrupted", "passed")).toBe(true);
    expect(shouldAttachContext("interrupted", "passed", true)).toBe(true);
  });

  test("a skipped test is not a failure and attaches nothing", () => {
    expect(shouldAttachContext("skipped", "passed", true)).toBe(false);
  });

  test("an absent status is not a failure", () => {
    // Open on the outcome: an unknown status is not claimed to be a failure just
    // in case, even though the collector fails closed on what it does not know.
    expect(shouldAttachContext(undefined, undefined, true)).toBe(false);
  });

  test("a failure with nothing at all to record attaches nothing", () => {
    // The page counts as something to record, which is why this is the fixture's
    // argument and not the rule's: a failing test that drove no page and captured
    // no signal has an empty payload, and an empty payload reads as "we looked
    // and found nothing", which is not what happened.
    expect(shouldAttachContext("failed", "passed", false)).toBe(false);
  });
});

test.describe("the page a failure happened on", () => {
  /** A Page stand-in, so the rule is checked without a browser. */
  function fakePage(over: Partial<PageLike> = {}): PageLike {
    return {
      url: () => "http://127.0.0.1:4411/form",
      title: () => Promise.resolve("Contact form"),
      ...over,
    };
  }

  test("records the url and the title", async () => {
    const context = await capturePageContext(fakePage());

    expect(context).toEqual({ url: "http://127.0.0.1:4411/form", title: "Contact form" });
  });

  test("a page with no title records the url alone rather than an empty string", async () => {
    // An empty title would read as "the page's title is empty", which is a claim
    // about the application. What happened is that we did not get one.
    const context = await capturePageContext(fakePage({ title: () => Promise.resolve("") }));

    expect(context).toEqual({ url: "http://127.0.0.1:4411/form" });
    expect(context).not.toHaveProperty("title");
  });

  test("the url is redacted, so a token in the query never reaches an artifact", async () => {
    const context = await capturePageContext(
      fakePage({ url: () => "https://app.example.com/reset?token=secret123#step-2" }),
    );

    expect(context?.url).toBe("https://app.example.com/reset");
    expect(context?.url).not.toContain("secret123");
  });

  test("credentials in the url are removed", async () => {
    const context = await capturePageContext(
      fakePage({ url: () => "https://user:pass@app.example.com/private" }),
    );

    expect(context?.url).toBe("https://app.example.com/private");
  });

  test("no page at all is absent rather than a placeholder", async () => {
    // The contract distinguishes "not observed" from "observed and empty", and
    // that applies to the page too.
    expect(await capturePageContext(fakePage({ url: () => "" }))).toBeUndefined();
  });

  test("a title that rejects does not fail the test", async () => {
    // page.title() can reject on a page that navigated away mid-teardown.
    // Losing a title is never worth failing a test over.
    const context = await capturePageContext(
      fakePage({
        title: () => Promise.reject(new Error("Execution context was destroyed")),
      }),
    );

    expect(context).toEqual({ url: "http://127.0.0.1:4411/form" });
  });

  test("a url that throws is treated as no page rather than crashing the fixture", async () => {
    const context = await capturePageContext(
      fakePage({
        url: () => {
          throw new Error("page is closed");
        },
      }),
    );

    expect(context).toBeUndefined();
  });
});

test.describe("reconciling the configured target against the page", () => {
  test("an observation that disagrees replaces the configured origin", () => {
    // The case from issue #8: the report named the bundled fixture's origin while
    // the browser was on a real third-party target. Grouping defects by origin
    // merged two applications' failures under one wrong value, and nothing in the
    // artifact said so.
    expect(
      resolveTarget({
        reportWebServerUrl: "http://127.0.0.1:4311",
        configuredBaseUrl: "http://127.0.0.1:4311",
        observedPageUrl: "https://quotes.toscrape.com/login",
      }),
    ).toEqual({ origin: "https://quotes.toscrape.com", source: "observed" });
  });

  test("an observation that agrees leaves the configured source alone", () => {
    // Ordinary runs must not churn. If BASE_URL set the target and the browser went
    // there, the artifact says `environment` and stays byte-identical to 1.2.0 —
    // otherwise every existing artifact would need rewriting for no correction.
    expect(
      resolveTarget({
        environmentBaseUrl: "http://127.0.0.1:4311",
        reportWebServerUrl: "http://127.0.0.1:9999",
        observedPageUrl: "http://127.0.0.1:4311/form?x=1#y",
      }),
    ).toEqual({ origin: "http://127.0.0.1:4311", source: "environment" });
  });

  test("no observation at all leaves the configured answer untouched", () => {
    expect(resolveTarget({ configuredBaseUrl: "http://127.0.0.1:4311" })).toEqual({
      origin: "http://127.0.0.1:4311",
      source: "config",
    });
    expect(resolveTarget({})).toEqual({});
  });

  test("an observation with nothing configured is still recorded", () => {
    // "Nothing was configured" and "the browser was here" are different facts, and
    // only the second one tells a reader where to look.
    expect(resolveTarget({ observedPageUrl: "https://example.test/a" })).toEqual({
      origin: "https://example.test",
      source: "observed",
    });
  });

  test("an unparseable observation does not invent an origin", () => {
    expect(
      resolveTarget({ observedPageUrl: "not a url", configuredBaseUrl: "http://a.test" }),
    ).toEqual({ origin: "http://a.test", source: "config" });
    expect(resolveTarget({ observedPageUrl: "" })).toEqual({});
  });
});

test.describe("which application was under test", () => {
  const OPTIONS = {
    testDir: "tests",
    outputDir: "artifacts/defects",
    reportPath: "artifacts/json/playwright-results.json",
    thresholds: { ...THRESHOLDS, maxFailureRate: 1 },
  } as const;

  /** A one-failure report, optionally carrying a webServer block. */
  async function failing(root: string, webServerUrl?: string): Promise<string> {
    const report = JSON.parse(reportWith(root, [{ status: "failed" }])) as Record<string, unknown>;
    if (webServerUrl !== undefined) {
      (report["config"] as Record<string, unknown>)["webServer"] = { url: webServerUrl };
    }
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      JSON.stringify(report),
      "utf8",
    );
    return root;
  }

  test("BASE_URL wins, because it is the value the runner's config reads", async () => {
    const root = await failing(await scaffold(() => ({})), "http://127.0.0.1:4311");

    const { defects } = await collectDefects({
      ...OPTIONS,
      projectRoot: root,
      baseUrl: "http://127.0.0.1:4311",
      environmentBaseUrl: "https://quotes.toscrape.com",
    });

    expect(defects[0]?.context.baseUrl).toBe("https://quotes.toscrape.com");
    expect(defects[0]?.context.targetSource).toBe("environment");
  });

  test("without BASE_URL the report's webServer url is used", async () => {
    const root = await failing(await scaffold(() => ({})), "https://app.example.com");

    const { defects } = await collectDefects({
      ...OPTIONS,
      projectRoot: root,
      baseUrl: "http://127.0.0.1:4311",
    });

    expect(defects[0]?.context.baseUrl).toBe("https://app.example.com");
    expect(defects[0]?.context.targetSource).toBe("report");
  });

  test("with neither, the configured value is the fallback and says so", async () => {
    const root = await failing(await scaffold(() => ({})));

    const { defects } = await collectDefects({
      ...OPTIONS,
      projectRoot: root,
      baseUrl: "http://127.0.0.1:4311",
    });

    expect(defects[0]?.context.baseUrl).toBe("http://127.0.0.1:4311");
    expect(defects[0]?.context.targetSource).toBe("config");
  });

  test("a BASE_URL that is not absolute is ignored rather than recorded", async () => {
    // Playwright reports a relative BASE_URL far more clearly than this can.
    // Recording "/api" as an origin would put a meaningless claim in an artifact.
    const root = await failing(await scaffold(() => ({})), "https://app.example.com");

    const { defects } = await collectDefects({
      ...OPTIONS,
      projectRoot: root,
      baseUrl: "http://127.0.0.1:4311",
      environmentBaseUrl: "/relative/path",
    });

    expect(defects[0]?.context.baseUrl).toBe("https://app.example.com");
    expect(defects[0]?.context.targetSource).toBe("report");
  });

  test("the recorded origin drops credentials, path and query", async () => {
    const root = await failing(await scaffold(() => ({})));

    const { defects } = await collectDefects({
      ...OPTIONS,
      projectRoot: root,
      environmentBaseUrl: "https://user:token@app.example.com/tenant?x=1",
    });

    expect(defects[0]?.context.baseUrl).toBe("https://app.example.com");
  });

  test("no source at all leaves baseUrl absent rather than guessing", async () => {
    const root = await failing(await scaffold(() => ({})));

    const { defects } = await collectDefects({ ...OPTIONS, projectRoot: root });

    expect(defects[0]?.context.baseUrl).toBeUndefined();
    expect(defects[0]?.context.targetSource).toBeUndefined();
  });

  test("the run summary carries the same target and source as the artifacts", async () => {
    const root = await failing(await scaffold(() => ({})));

    const { summary } = await collectDefects({
      ...OPTIONS,
      projectRoot: root,
      baseUrl: "http://127.0.0.1:4311",
      environmentBaseUrl: "https://quotes.toscrape.com",
    });

    expect(summary.baseUrl).toBe("https://quotes.toscrape.com");
    expect(summary.targetSource).toBe("environment");
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
      config: { rootDir: path.join(root, "tests") },
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

  test("folds the page the failure happened on into the artifact", async () => {
    const root = await scaffold(() => ({}));
    const signalsPath = await seedSignals(root, {
      signals: { pageErrors: ["TypeError"] },
      dropped: 0,
      page: { url: "https://quotes.toscrape.com/login", title: "Quotes to Scrape: Login" },
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

    expect(defects[0]?.page).toEqual({
      url: "https://quotes.toscrape.com/login",
      title: "Quotes to Scrape: Login",
    });
  });

  test("records the page even when the test captured no signals at all", async () => {
    // The two blocks have different rules. Signals are absent unless something
    // was observed; the page is present whenever the test drove a page, because
    // a page that threw no console error is still the page the failure was on.
    const root = await scaffold(() => ({}));
    const signalsPath = await seedSignals(root, {
      signals: { consoleErrors: [], consoleWarnings: [], pageErrors: [], requestFailures: [] },
      dropped: 0,
      page: { url: "https://quotes.toscrape.com/" },
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

    expect(defects[0]?.page).toEqual({ url: "https://quotes.toscrape.com/" });
    expect(defects[0]).not.toHaveProperty("signals");
  });

  test("a page with a title only and no url is dropped rather than half-recorded", async () => {
    const root = await scaffold(() => ({}));
    const signalsPath = await seedSignals(root, {
      signals: { pageErrors: ["TypeError"] },
      dropped: 0,
      page: { title: "no url here" },
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

    // A page block with no url states nothing a consumer can act on.
    expect(defects[0]).not.toHaveProperty("page");
    expect(defects[0]).toHaveProperty("signals");
  });

  test("omits the page when the fixture recorded none", async () => {
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

    expect(defects[0]).not.toHaveProperty("page");
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

test.describe("an outage is not four defects", () => {
  const OPTIONS = {
    testDir: "tests",
    outputDir: "artifacts/defects",
    reportPath: "artifacts/json/playwright-results.json",
    thresholds: THRESHOLDS,
  } as const;

  /**
   * Several specs carrying one identical error — the shape a serial-mode runner
   * produces when a shared fixture dies and every test runs it.
   *
   * This is **not** the shape Playwright produces for a `beforeAll` throw, which
   * is one failure followed by skips. See `hookReport` below for the real one,
   * and for why mistaking the two is what let a shipped bug through a green suite.
   */
  function outageReport(
    root: string,
    count: number,
    override: {
      specLine?: number;
      raiseLine?: number;
      sameMessage?: boolean;
      withLocation?: boolean;
    } = {},
  ): string {
    const { specLine = 20, raiseLine = 13, sameMessage = true, withLocation = true } = override;
    const specFile = path.join(root, "tests/smoke/demo.spec.ts");
    return JSON.stringify({
      config: { rootDir: path.join(root, "tests") },
      stats: { startTime: "2026-10-03T00:00:00.000Z", duration: 30 },
      suites: [
        {
          title: "tests/smoke/demo.spec.ts",
          file: "smoke/demo.spec.ts",
          specs: Array.from({ length: count }, (_unused, i) => ({
            id: `spec-${i}`,
            title: `probe ${i + 1}`,
            file: "smoke/demo.spec.ts",
            line: specLine,
            column: 1,
            tests: [
              {
                projectName: "chromium",
                expectedStatus: "passed",
                results: [
                  {
                    status: "failed",
                    retry: 0,
                    duration: 3,
                    startTime: "2026-10-03T00:00:00.000Z",
                    attachments: [],
                    error: {
                      message: sameMessage
                        ? "Error: Third-party target http://127.0.0.1:9 is unreachable, so this suite did not run."
                        : `Error: probe ${i + 1} failed for its own reason.`,
                      ...(withLocation
                        ? { location: { file: specFile, line: raiseLine, column: 11 } }
                        : {}),
                    },
                  },
                ],
              },
            ],
          })),
        },
      ],
    });
  }

  async function collect(root: string): Promise<{
    defects: Awaited<ReturnType<typeof collectDefects>>["defects"];
    summary: Awaited<ReturnType<typeof collectDefects>>["summary"];
    runDir: string;
  }> {
    return collectDefects({ ...OPTIONS, projectRoot: root });
  }

  test("four specs that failed on one raise site produce no artifact at all", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": outageReport(sandbox, 4),
    }));

    const { defects, summary, runDir } = await collect(root);

    // The reported harm: four artifacts with distinct ids, identical messages,
    // and one ticket each opened against somebody else's codebase.
    expect(defects).toHaveLength(0);
    expect(summary.counts.aborted).toBe(4);
    // Not counted as failures: they are not defects.
    expect(summary.counts.failed).toBe(0);
    expect(summary.counts.specs).toBe(4);
    expect(summary.defects).toEqual([]);

    // Nothing on disk claims a defect either.
    expect(await readdir(runDir)).toEqual(["quality-summary.v1.json"]);
  });

  test("the gate still fails, and says why, so an outage cannot pass silently", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": outageReport(sandbox, 4),
    }));

    const { summary } = await collect(root);

    // Suppressing the artifacts must not turn a broken build green. The violation
    // names the file and the raise site, which is the whole diagnosis.
    expect(summary.gate.passed).toBe(false);
    const violation = summary.gate.violations.join("\n");
    expect(violation).toContain("smoke/demo.spec.ts");
    expect(violation).toContain("never ran");
    expect(violation).toContain("is unreachable");
  });

  test("two specs on one raise site are enough, because one throw cannot be two tests", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": outageReport(sandbox, 2),
    }));

    const { defects, summary } = await collect(root);

    expect(defects).toHaveLength(0);
    expect(summary.counts.aborted).toBe(2);
  });

  test("one spec alone, with its siblings still running, is a defect", async () => {
    // A single failure is a defect when nothing proves the file was aborted.
    // This is the guard that stops the hook rule eating real bugs: a helper
    // defined above the test and called from its body raises at a line above the
    // declaration too, and the only thing separating it from a dead `beforeAll`
    // is that its siblings ran.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": outageReport(sandbox, 1),
    }));

    const { defects, summary } = await collect(root);

    expect(defects).toHaveLength(1);
    expect(summary.counts.aborted).toBe(0);
  });

  /**
   * The report a real `beforeAll` failure produces, recorded from a live run.
   *
   * Every detail here was measured, and each one contradicts the obvious guess:
   *
   * - Playwright marks the **first** spec `failed` and every later spec in the
   *   file `skipped`. It does not repeat the hook's error across them, so a rule
   *   looking for repeated identical failures has nothing to match, and one
   *   unreachable target produced exactly one defect artifact instead of none.
   * - The error's location is the `throw` inside the hook, which sits *above* the
   *   declaration of the spec reported as failed.
   * - There is no `stage` field, so nothing in the report names the phase.
   *
   * The siblings being skipped is what tells this apart from a real failure. That
   * was measured too, and it is the load-bearing half: with one test failing on its
   * own assertion, the next test in the same file reports `passed`.
   */
  function hookReport(root: string, siblings: number): string {
    const specFile = path.join(root, "tests/smoke/demo.spec.ts");
    const failed = {
      id: "spec-0",
      title: "probe 1",
      file: "smoke/demo.spec.ts",
      line: 20,
      column: 1,
      tests: [
        {
          projectName: "chromium",
          expectedStatus: "passed",
          results: [
            {
              status: "failed",
              retry: 0,
              duration: 3,
              startTime: "2026-10-03T00:00:00.000Z",
              attachments: [],
              error: {
                message: "Error: the target is unreachable, so this suite did not run",
                location: { file: specFile, line: 13, column: 11 },
              },
            },
          ],
        },
      ],
    };
    const skipped = Array.from({ length: siblings }, (_unused, i) => ({
      id: `spec-${i + 1}`,
      title: `probe ${i + 2}`,
      file: "smoke/demo.spec.ts",
      line: 20 + i,
      column: 1,
      tests: [
        {
          projectName: "chromium",
          expectedStatus: "passed",
          results: [
            {
              status: "skipped",
              retry: 0,
              duration: 0,
              startTime: "2026-10-03T00:00:00.000Z",
              attachments: [],
            },
          ],
        },
      ],
    }));
    return JSON.stringify({
      config: { rootDir: path.join(root, "tests") },
      stats: { startTime: "2026-10-03T00:00:00.000Z", duration: 30 },
      suites: [
        {
          title: "tests/smoke/demo.spec.ts",
          file: "smoke/demo.spec.ts",
          specs: [failed, ...skipped],
        },
      ],
    });
  }

  test("a beforeAll that throws produces no artifact, which is the shape that shipped broken", async () => {
    // The regression. The rule this exercises needed two or more identical
    // failures, and a real `beforeAll` throw never produces two, so the rule
    // could not fire on the case it was written for. Its own unit tests stayed
    // green because they were fed a synthetic report of four failures - a
    // plausible guess that the real runner never produces.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": hookReport(sandbox, 1),
    }));

    const { defects, summary, runDir } = await collect(root);

    expect(defects).toHaveLength(0);
    // One failure written off, and counted as an abort rather than a defect.
    expect(summary.counts.aborted).toBe(1);
    expect(summary.counts.failed).toBe(0);
    // The sibling was skipped, so it is not a failure either.
    expect(summary.counts.skipped).toBe(1);
    expect(await readdir(runDir)).toEqual(["quality-summary.v1.json"]);
  });

  test("the hook's own wording names the hook, not a repeated failure", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": hookReport(sandbox, 1),
    }));

    const { summary } = await collect(root);

    expect(summary.gate.passed).toBe(false);
    const violation = summary.gate.violations.join("\n");
    expect(violation).toContain("failed on a hook");
    expect(violation).toContain("smoke/demo.spec.ts");
    // The diagnosis a reader needs: which file, and where the throw was.
    expect(violation).toContain("13");
  });

  test("a lone failure above the declaration is suppressed only when siblings were skipped", async () => {
    // Both halves are required. Drop the location and a genuine outage writes
    // artifacts again; drop the skipped siblings and a real defect disappears.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": hookReport(sandbox, 0),
    }));

    const { defects, summary } = await collect(root);

    expect(defects).toHaveLength(1);
    expect(summary.counts.aborted).toBe(0);
  });

  test("identical messages at different lines are two assertions, not one hook", async () => {
    // Two tests waiting for the same absent element produce byte-identical
    // messages. Only the location tells them apart, so the location is required.
    const root = await scaffold((sandbox) => {
      const report = JSON.parse(outageReport(sandbox, 2)) as {
        suites: [{ specs: { tests: { results: { error: unknown }[] }[] }[] }];
      };
      const specs = report.suites[0]?.specs ?? [];
      (specs[0]?.tests[0]?.results[0]?.error as { location: { line: number } }).location.line = 41;
      (specs[1]?.tests[0]?.results[0]?.error as { location: { line: number } }).location.line = 42;
      return { "artifacts/json/playwright-results.json": JSON.stringify(report) };
    });

    const { defects, summary } = await collect(root);

    expect(defects).toHaveLength(2);
    expect(summary.counts.aborted).toBe(0);
  });

  test("one outlier means the bodies ran, so nothing is suppressed", async () => {
    // Two specs on one raise site plus a third that failed at its own line: the
    // file did not abort, it partially ran, and all three failures are worth
    // keeping. Suppressing all three to save two would be the wrong trade.
    const root = await scaffold((sandbox) => {
      const report = JSON.parse(outageReport(sandbox, 3)) as {
        suites: [
          {
            specs: {
              file: string;
              tests: {
                results: { error: { message: string; location: { file: string; line: number } } }[];
              }[];
            }[];
          },
        ];
      };
      const odd = report.suites[0]?.specs[2]?.tests[0]?.results[0]?.error;
      if (odd !== undefined) {
        odd.message = "Error: this one is a real assertion failure.";
        odd.location.line = 37;
      }
      return { "artifacts/json/playwright-results.json": JSON.stringify(report) };
    });

    const { defects, summary } = await collect(root);

    expect(defects).toHaveLength(3);
    expect(summary.counts.aborted).toBe(0);
  });

  test("no error location means no comparison, so nothing is suppressed", async () => {
    // Guessing here is how data goes missing. Without a location there is nothing
    // to compare, so the rule declines to act.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": outageReport(sandbox, 4, { withLocation: false }),
    }));

    const { defects, summary } = await collect(root);

    expect(defects).toHaveLength(4);
    expect(summary.counts.aborted).toBe(0);
  });

  test("an aborted file does not suppress a real failure in another file", async () => {
    const root = await scaffold((sandbox) => {
      const aborted = JSON.parse(outageReport(sandbox, 3)) as {
        suites: { file?: string; specs: unknown[] }[];
      };
      const genuine = JSON.parse(outageReport(sandbox, 1)) as {
        suites: { file?: string; specs: unknown[] }[];
      };
      (genuine.suites[0] as { file: string }).file = "smoke/other.spec.ts";
      for (const spec of (genuine.suites[0] as { specs: { file: string }[] }).specs) {
        spec.file = "smoke/other.spec.ts";
      }
      const merged = JSON.parse(outageReport(sandbox, 0)) as { suites: unknown[] };
      merged.suites = [aborted.suites[0], genuine.suites[0]];
      return { "artifacts/json/playwright-results.json": JSON.stringify(merged) };
    });

    const { defects, summary } = await collect(root);

    expect(summary.counts.aborted).toBe(3);
    expect(defects).toHaveLength(1);
    expect(defects[0]?.test.file).toBe("tests/smoke/other.spec.ts");
  });

  test("the same raise site with different messages is not one outage", async () => {
    // The message is part of the failure's identity, not decoration. Two failures
    // that read differently are two facts even when they share a line, and keeping
    // them costs nothing - suppressing them would lose data for no gain.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": outageReport(sandbox, 2, { sameMessage: false }),
    }));

    const { defects, summary } = await collect(root);

    expect(defects).toHaveLength(2);
    expect(summary.counts.aborted).toBe(0);
  });

  test("a passing spec in the file neither counts nor vetoes the rule", async () => {
    // A beforeAll inside one describe takes that describe's specs down and leaves a
    // sibling describe green. Those green results say nothing about whether the
    // failing bodies ran, so the abort still stands.
    const root = await scaffold((sandbox) => {
      const report = JSON.parse(outageReport(sandbox, 2)) as {
        suites: {
          specs: {
            title: string;
            tests: { results: { status: string; error?: unknown }[] }[];
          }[];
        }[];
      };
      report.suites[0]?.specs.push({
        title: "probe 3",
        tests: [{ results: [{ status: "passed" }] }],
      });
      return { "artifacts/json/playwright-results.json": JSON.stringify(report) };
    });

    const { defects, summary } = await collect(root);

    expect(summary.counts.aborted).toBe(2);
    expect(summary.counts.passed).toBe(1);
    expect(defects).toHaveLength(0);
  });

  test("the flakiness verdict of an aborted spec is not silently counted as flaky", async () => {
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": outageReport(sandbox, 2),
    }));

    const { summary } = await collect(root);

    expect(summary.counts.flaky).toBe(0);
  });
});

test.describe("failure attribution", () => {
  const OPTIONS = {
    testDir: "tests",
    outputDir: "artifacts/defects",
    reportPath: "artifacts/json/playwright-results.json",
    thresholds: THRESHOLDS,
  } as const;

  /** One failing spec whose error is raised at `raiseLine` of the demo file. */
  async function oneFailure(root: string, raiseLine: number, withLocation = true): Promise<string> {
    const specFile = path.join(root, "tests/smoke/demo.spec.ts");
    const report = JSON.stringify({
      config: { rootDir: path.join(root, "tests") },
      stats: { startTime: "2026-10-03T00:00:00.000Z", duration: 10 },
      suites: [
        {
          title: "tests/smoke/demo.spec.ts",
          file: "smoke/demo.spec.ts",
          specs: [
            {
              id: "one",
              title: "shows the status",
              file: "smoke/demo.spec.ts",
              line: 20,
              column: 1,
              tests: [
                {
                  projectName: "chromium",
                  expectedStatus: "passed",
                  results: [
                    {
                      status: "failed",
                      retry: 0,
                      duration: 5,
                      startTime: "2026-10-03T00:00:00.000Z",
                      attachments: [],
                      error: {
                        message: "Error: something went wrong",
                        ...(withLocation ? { location: { file: specFile, line: raiseLine } } : {}),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    await writeFile(path.join(root, "artifacts/json/playwright-results.json"), report, "utf8");
    return root;
  }

  test("an error raised above the test is attributed to a hook, not to the test", async () => {
    // A beforeAll, a file-level fixture or a helper declared above the test all
    // raise from above it. A test body never does, so this is provable - and the
    // line is in the reader's own file, which is why this says `hook` rather than
    // `suite`. A hook attribution names a line above the test, so the first place
    // to look is that hook, not the assertion that never ran.
    const root = await oneFailure(await scaffold(() => ({})), 4);

    const { defects } = await collectDefects({ ...OPTIONS, projectRoot: root });

    expect(defects[0]?.failure.attribution).toBe("hook");
  });

  test("an error raised inside the test carries no attribution", async () => {
    // Absence is the ordinary case and means nothing was noteworthy. It is not a
    // claim that the body raised it: a helper defined below the test is equally
    // consistent with it, and a line number cannot tell those apart.
    const root = await oneFailure(await scaffold(() => ({})), 24);

    const { defects } = await collectDefects({ ...OPTIONS, projectRoot: root });

    expect(defects[0]).not.toHaveProperty("failure.attribution");
  });

  test("the test's own declaration line counts as inside, not above", async () => {
    const root = await oneFailure(await scaffold(() => ({})), 20);

    const { defects } = await collectDefects({ ...OPTIONS, projectRoot: root });

    expect(defects[0]).not.toHaveProperty("failure.attribution");
  });

  test("a foreign file stays suite even when its line number is lower", async () => {
    // The boundary between `hook` and `suite`, and it is a boundary about *files*,
    // not about line numbers. A shared helper at line 3 of another module is not a
    // hook in this reader's file, and labelling it `hook` would send them looking
    // above a test that did not raise it.
    const root = await scaffold((sandbox) => ({
      "artifacts/json/playwright-results.json": JSON.stringify({
        config: { rootDir: path.join(sandbox, "tests") },
        stats: { startTime: "2026-10-03T00:00:00.000Z", duration: 10 },
        suites: [
          {
            title: "tests/smoke/demo.spec.ts",
            file: "smoke/demo.spec.ts",
            specs: [
              {
                id: "one",
                title: "shows the status",
                file: "smoke/demo.spec.ts",
                line: 20,
                column: 1,
                tests: [
                  {
                    projectName: "chromium",
                    expectedStatus: "passed",
                    results: [
                      {
                        status: "failed",
                        retry: 0,
                        duration: 5,
                        startTime: "2026-10-03T00:00:00.000Z",
                        attachments: [],
                        error: {
                          message: "Error: the shared helper gave up",
                          location: {
                            // Beside the test file, not inside it: a shared module.
                            file: path.join(sandbox, "helpers.ts"),
                            line: 3,
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));

    const { defects } = await collectDefects({ ...OPTIONS, projectRoot: root });

    expect(defects[0]?.failure.attribution).toBe("suite");
  });

  test("an error raised in another file is attributed to the suite", async () => {
    // The spec's own file does not even contain the throw.
    const root = await oneFailure(await scaffold(() => ({})), 24);
    const report = JSON.parse(
      await readFile(path.join(root, "artifacts/json/playwright-results.json"), "utf8"),
    ) as {
      suites: [
        {
          specs: {
            tests: { results: { error: { location: { file: string; line: number } } }[] }[];
          }[];
        },
      ];
    };
    const spec = report.suites[0]?.specs[0];
    if (spec !== undefined) {
      spec.tests[0]!.results[0]!.error.location = {
        file: path.join(root, "tests/smoke/helpers.ts"),
        line: 9,
      };
    }
    await writeFile(
      path.join(root, "artifacts/json/playwright-results.json"),
      JSON.stringify(report),
      "utf8",
    );

    const { defects } = await collectDefects({ ...OPTIONS, projectRoot: root });

    expect(defects[0]?.failure.attribution).toBe("suite");
  });

  test("no location at all is recorded as unknown rather than guessed", async () => {
    const root = await oneFailure(await scaffold(() => ({})), 24, false);

    const { defects } = await collectDefects({ ...OPTIONS, projectRoot: root });

    expect(defects[0]?.failure.attribution).toBe("unknown");
  });

  test("a suite attribution does not stop the artifact being written", async () => {
    // The residual case is precisely a single spec that failed on an error raised
    // outside its body: indistinguishable from a real defect by message alone, and
    // the artifact is what a triage agent reads. It is flagged, not hidden.
    const root = await oneFailure(await scaffold(() => ({})), 4);

    const { defects, summary } = await collectDefects({ ...OPTIONS, projectRoot: root });

    expect(defects).toHaveLength(1);
    expect(summary.counts.aborted).toBe(0);
  });

  test("validateDefect rejects an attribution outside the vocabulary", () => {
    const result = validateDefect({
      schemaVersion: "1.2.0",
      id: "a-b",
      runId: "run-1",
      createdAt: "2026-10-03T00:00:00.000Z",
      status: "failed",
      test: { title: "t", file: "a.spec.ts" },
      failure: { message: "boom", attribution: "the-applications-fault" },
      evidence: {},
      context: {},
      flakiness: { verdict: "unknown" },
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join()).toContain("failure.attribution");
  });
});
