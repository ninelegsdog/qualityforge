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
 *
 * What a rejection of `execFile` means is classified, not guessed
 * (`collectorExit` below). This file once reported "an invalid config must be
 * rejected" with `Received: 1` for a collector that had never run, because the
 * harness mapped every unrecognised rejection to exit 1 — the same number the
 * collector uses for a failed gate. The quality gate then did its job on the
 * flaky result and the build went red over a test whose own message named the
 * wrong cause.
 */

const exec = promisify(execFile);
const CLI = path.join(process.cwd(), "src", "cli", "collect-defects.ts");
/**
 * The interpreter this repository pins, not the one `npx` would fetch.
 *
 * `npx tsx` from a temporary directory has no local `node_modules` to read, so
 * it resolves `tsx` against the registry — the latest version, not the pinned
 * one, over the network, on every first call with a cold cache. That makes the
 * interpreter part of the test's subject by accident, and it made the test
 * flake: on 2026-10-13 the first attempt inside `npx` never reached the
 * collector, the retry passed against a warm cache, and the quality gate
 * rightly reddened the build over a test that had passed only after a retry.
 * The pinned binary is both the real collector's usual interpreter and free of
 * a network round trip.
 */
const TSX = path.join(process.cwd(), "node_modules", ".bin", "tsx");

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

/**
 * What one rejection of `execFile` means, told apart rather than guessed.
 *
 * `error.code` is the child's exit code only when the child actually exited.
 * When it was killed — a timeout, a signal, an OOM — the code is absent and
 * `signal` carries the reason; when the interpreter itself fails to start, the
 * code is a string such as `ENOENT`. The old shape, `failure.code ?? 1`,
 * folded all of those into exit 1, which is also the collector's own number
 * for "collected, gate failed" — so a collector that never ran reported a
 * failed gate, and the message named a cause that had not happened.
 *
 * Exit 1 is therefore only ever believed when the child really exited 1.
 */
function collectorExit(failure: {
  code?: number | string;
  signal?: string | null;
  killed?: boolean;
  stderr?: string;
}): number {
  if (typeof failure.code !== "number") {
    throw new Error(
      "the collector did not run to completion" +
        ` (code=${String(failure.code)}, signal=${String(failure.signal)},` +
        ` killed=${String(failure.killed)}); stderr:\n` +
        (failure.stderr ?? "(none)"),
    );
  }
  return failure.code;
}

async function runInConsumer(
  configText: string,
  interpreter: string = TSX,
): Promise<{ code: number; error: string }> {
  const project = mkdtempSync(path.join(os.tmpdir(), "qualityforge-consumer-"));
  mkdirSync(path.join(project, "config"), { recursive: true });
  writeFileSync(path.join(project, "config", "project.json"), configText, "utf8");

  try {
    // `--no-history`: this test spawns the real collector, and a run of it
    // appends to the committed history. Two records of a run that never
    // happened is exactly what the collector's own history is supposed to make
    // impossible, and a failing test should not leave the working tree dirty
    // on top of failing. History is not what this test asserts.
    const result = await exec(interpreter, [CLI, "--no-history"], {
      cwd: project,
      timeout: 60_000,
    });
    // `exec` rejects on a non-zero exit, so reaching here means the collector
    // said 0 — which is the case worth catching: it collected and liked it.
    return { code: 0, error: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      signal?: string | null;
      killed?: boolean;
      stderr?: string;
    };
    return { code: collectorExit(failure), error: failure.stderr ?? "" };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test.describe("an interpreter that never started", () => {
  // The negative half of `collectorExit`, driven through a real `execFile`
  // rejection rather than a hand-written error object: a missing interpreter
  // is the shape that produced exit code "1" in the one red CI job of
  // 2026-10-13, and it must not be reported as the collector's verdict.
  test("is reported as not run, never as the collector's exit code", async () => {
    await expect(
      runInConsumer(VALID_CONFIG, "/nonexistent/interpreter-for-this-test"),
    ).rejects.toThrow(/the collector did not run to completion \(code=ENOENT/);
  });

  test("a real exit code is still read as one", () => {
    expect(collectorExit({ code: 2 })).toBe(2);
    expect(collectorExit({ code: 1 })).toBe(1);
    expect(collectorExit({ code: 0 })).toBe(0);
  });
});

test.describe("collector path resolution", () => {
  test("reads the config of the project that invoked it, not its own", async () => {
    const broken = JSON.parse(VALID_CONFIG) as Record<string, unknown>;
    broken.name = 42; // invalid, and only reachable if this file is the one read

    const { code, error } = await runInConsumer(JSON.stringify(broken));

    expect(code, `an invalid config must be rejected, not collected past; stderr:\n${error}`).toBe(
      2,
    );
    expect(
      error,
      "the error must name the invoking project's config; naming one in " +
        "node_modules means the collector read its own",
    ).toContain(path.join("config", "project.json"));
    expect(error).not.toContain("node_modules");
  });

  test("looks for the Playwright report in the invoking project", async () => {
    const { code, error } = await runInConsumer(VALID_CONFIG);

    expect(code, `with no report the collector must refuse; stderr:\n${error}`).toBe(2);
    expect(
      error,
      "the missing-report message must name a path in the invoking project; " +
        "one in node_modules means it collected its own",
    ).toContain("artifacts/json/playwright-results.json");
    expect(error).not.toContain("node_modules");
    expect(error).toContain("Run the suite first");
  });
});
