import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

/**
 * Where the collector looks when a project other than this one runs it.
 *
 * Every path it resolved used to come from its own file location, so a
 * consuming project got `node_modules/qualityforge/config/project.json` for its
 * config, `node_modules/qualityforge/artifacts/json/...` for its report, its
 * artifacts written back into `node_modules`, and our git commit stamped on the
 * run instead of theirs. It exited 0 throughout: the wrong project was
 * collected, quietly, and only the missing report gave the game away.
 *
 * The assertions are on which paths the CLI resolves, not on what Playwright
 * writes — that shape is `report-check.py`'s job, and asserting it here from a
 * hand-written report would only agree with whatever this file believed.
 */

const exec = promisify(execFile);
const CLI = path.join(process.cwd(), "src", "cli", "collect-defects.ts");

const VALID_CONFIG = JSON.stringify(
  {
    schemaVersion: "1.0.0",
    name: "a-consumer-project",
    baseUrl: "http://127.0.0.1:4321",
    projects: ["chromium"],
    evidence: {
      trace: "on-first-retry",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    },
    thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 90000 },
    defects: { directory: "artifacts/defects", writeSummary: true, referenceErrorContext: true },
    tags: ["consumer"],
  },
  null,
  2,
);

async function runInConsumer(configText: string): Promise<{ code: number; error: string }> {
  const project = mkdtempSync(path.join(os.tmpdir(), "qualityforge-consumer-"));
  mkdirSync(path.join(project, "config"), { recursive: true });
  writeFileSync(path.join(project, "config", "project.json"), configText, "utf8");

  try {
    // `--no-history`: this test spawns the real collector, and a run of it
    // appends to the committed history. Two records of a run that never
    // happened is exactly what the collector's own history is supposed to make
    // impossible, and a failing test should not leave the working tree dirty
    // on top of failing. History is not what this test asserts.
    const result = await exec("npx", ["tsx", CLI, "--no-history"], {
      cwd: project,
      timeout: 60_000,
    });
    // `exec` rejects on a non-zero exit, so reaching here means the collector
    // said 0 — which is the case worth catching: it collected and liked it.
    return { code: 0, error: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, error: failure.stderr ?? "" };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test.describe("collector path resolution", () => {
  test("reads the config of the project that invoked it, not its own", async () => {
    const broken = JSON.parse(VALID_CONFIG) as Record<string, unknown>;
    broken.name = 42; // invalid, and only reachable if this file is the one read

    const { code, error } = await runInConsumer(JSON.stringify(broken));

    expect(code, "an invalid config must be rejected, not collected past").toBe(2);
    expect(
      error,
      "the error must name the invoking project's config; naming one in " +
        "node_modules means the collector read its own",
    ).toContain(path.join("config", "project.json"));
    expect(error).not.toContain("node_modules");
  });

  test("looks for the Playwright report in the invoking project", async () => {
    const { code, error } = await runInConsumer(VALID_CONFIG);

    expect(code, "with no report the collector must refuse").toBe(2);
    expect(
      error,
      "the missing-report message must name a path in the invoking project; " +
        "one in node_modules means it collected its own",
    ).toContain("artifacts/json/playwright-results.json");
    expect(error).not.toContain("node_modules");
    expect(error).toContain("Run the suite first");
  });
});
