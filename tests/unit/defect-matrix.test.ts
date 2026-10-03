/**
 * Regression: attempts from different browser projects are not retries of one
 * test.
 *
 * Found by integrating two independently correct changes — a collector that
 * refuses colliding defect ids, and a CI matrix that runs the suite in three
 * engines. Neither was wrong alone. Together, one spec in three engines produced
 * three identical ids, so the collector refused the whole run and CI could not
 * collect anything at all.
 *
 * The same flattening also mislabelled results: a test that passed in chromium
 * and failed in firefox came out as one defect attributed to chromium with a
 * `passedAfterRetry` verdict, which claims a retry happened when none did.
 */
import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectDefects } from "../../src/defect/collect.js";

/**
 * The fields this suite reads. Parsing a file from disk is not trusted input,
 * so it is parsed as unknown and narrowed, rather than left as `any` — which
 * eslint refuses, correctly.
 */
interface ReadArtifact {
  id: string;
  status: string;
  test: { project?: string };
  flakiness: { verdict: string; attempts: number };
}

function parseArtifact(text: string): ReadArtifact {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("artifact is not an object");
  }
  return parsed as ReadArtifact;
}

interface EngineResult {
  project: string;
  status: "passed" | "failed";
  /** Defaults to a single attempt of `status`; supply to model a retry. */
  attempts?: Array<{ status: string; duration: number; error?: { message: string } }>;
}

/** A report with one spec run in every engine named, each with that status. */
function twoEngineReport(results: EngineResult[], file = "smoke/demo.smoke.spec.ts") {
  return {
    config: { metadata: {}, webServer: null },
    stats: {},
    suites: [
      {
        title: "smoke",
        file,
        specs: [
          {
            title: "one spec, several engines",
            file,
            line: 10,
            tests: results.map((r) => ({
              projectName: r.project,
              // An engine supplies its own attempts when the case is about a
              // retry; otherwise one attempt carrying that status.
              results: r.attempts ?? [
                {
                  status: r.status,
                  duration: 100,
                  ...(r.status === "failed"
                    ? { error: { message: `Error: boom in ${r.project}` } }
                    : {}),
                },
              ],
            })),
          },
        ],
        suites: [],
      },
    ],
    errors: [],
  };
}

/** Build a one-spec report for the given engines, then collect it. */
async function collect(results: EngineResult[], file = "smoke/demo.smoke.spec.ts") {
  const report = twoEngineReport(results, file);
  const root = await mkdtemp(path.join(tmpdir(), "qf-engines-"));
  const reportPath = path.join(root, "report.json");
  await (await import("node:fs/promises")).writeFile(reportPath, JSON.stringify(report));
  const out = path.join(root, "out");
  const result = await collectDefects({
    projectRoot: process.cwd(),
    testDir: "tests",
    outputDir: out,
    reportPath,
    baseUrl: "http://127.0.0.1:4311",
    referenceErrorContext: false,
    tags: ["demo"],
    thresholds: { maxFailureRate: 1, maxAttemptsPerTest: 2, maxDurationMs: 900_000 },
    commit: null,
    branch: null,
    ci: false,
    retries: 0,
  });
  const files = (await readdir(result.runDir)).filter(
    (f) => f.endsWith(".v1.json") && f !== "quality-summary.v1.json",
  );
  const artifacts = await Promise.all(
    files.map((f) => readFile(path.join(result.runDir, f), "utf8")),
  );
  return { summary: result.summary, artifacts: artifacts.map(parseArtifact) };
}

test.describe("a matrix run is not a retry", () => {
  test("one artifact per engine, each attributed to the engine that failed", async () => {
    const { summary, artifacts } = await collect([
      { project: "chromium", status: "failed" },
      { project: "firefox", status: "failed" },
    ]);

    // Two engines, two artifacts — not one artifact holding two attempts.
    expect(summary.counts.failed).toBe(2);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((a) => a.test.project).sort()).toEqual(["chromium", "firefox"]);

    // Ids must be distinct, or the run refuses to collect at all.
    const ids = new Set(artifacts.map((a) => a.id));
    expect(ids.size).toBe(2);
  });

  test("an engine that passed is not reported as a defect", async () => {
    const { summary, artifacts } = await collect([
      { project: "chromium", status: "passed" },
      { project: "firefox", status: "failed" },
    ]);

    expect(summary.counts.passed).toBe(1);
    expect(summary.counts.failed).toBe(1);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.test.project).toBe("firefox");
  });

  test("a passing engine is never given a retry verdict", async () => {
    // The bug this pins: chromium passed, firefox failed, and the artifact said
    // `passedAfterRetry` — a retry verdict for something that was never retried.
    const { artifacts } = await collect([
      { project: "chromium", status: "passed" },
      { project: "firefox", status: "failed" },
    ]);

    for (const artifact of artifacts) {
      expect(artifact.flakiness.verdict).not.toBe("passedAfterRetry");
      expect(artifact.flakiness.attempts).toBe(1);
    }
  });

  test("retries within one engine are still retries", async () => {
    // The counter-case. Partitioning by project must not flatten genuine retries
    // inside a single engine, or this whole fix is a different bug.
    const report = twoEngineReport([
      {
        project: "firefox",
        status: "failed",
        // One engine, two attempts: failed, then passed. A genuine retry.
        attempts: [
          { status: "failed", duration: 100, error: { message: "Error: first" } },
          { status: "passed", duration: 100 },
        ],
      },
    ]);

    const root = await mkdtemp(path.join(tmpdir(), "qf-retry-"));
    const reportPath = path.join(root, "report.json");
    await (await import("node:fs/promises")).writeFile(reportPath, JSON.stringify(report));
    const out = path.join(root, "out");
    const result = await collectDefects({
      projectRoot: process.cwd(),
      testDir: "tests",
      outputDir: out,
      reportPath,
      baseUrl: "http://127.0.0.1:4311",
      referenceErrorContext: false,
      tags: ["demo"],
      thresholds: { maxFailureRate: 1, maxAttemptsPerTest: 2, maxDurationMs: 900_000 },
      commit: null,
      branch: null,
      ci: false,
      retries: 1,
    });
    // Failed then passed on retry: that is flakiness, not a defect, so no
    // artifact is written. The retry is still visible in the counts — which is
    // the point: partitioning by project must not flatten genuine retries.
    const files = (await readdir(result.runDir)).filter(
      (f) => f.endsWith(".v1.json") && f !== "quality-summary.v1.json",
    );
    expect(files).toHaveLength(0);
    expect(result.summary.counts.flaky).toBe(1);
    expect(result.summary.counts.passed).toBe(1);
  });

  test("a single-project report keeps the ids it always had", async () => {
    const { artifacts } = await collect([{ project: "chromium", status: "failed" }]);
    expect(artifacts[0]?.id).toBe("demo-smoke-one-spec-several-engines");
    // The engine only joins the id when more than one ran.
    expect(artifacts[0]?.id).not.toContain("chromium");
  });
});
