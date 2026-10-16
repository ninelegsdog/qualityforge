import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

/**
 * The audit command's argument handling, with no browser anywhere.
 *
 * This file exists because the audit's CLI tests were first written in one piece
 * and CI refused them: the unit jobs install no browser, so every audit exited 2
 * and the assertions about exit 0 and 1 failed. The failure was correct — these
 * are two different layers of the same command — so the tests were split rather
 * than the job made to install something it does not need.
 *
 * The runs that genuinely launch a browser live in
 * `tests/smoke/a11y-audit-command.smoke.spec.ts`.
 */

const exec = promisify(execFile);
const CLI = path.join(process.cwd(), "src", "cli", "a11y-audit.ts");
const TSCX = path.join(process.cwd(), "node_modules", ".bin", "tsx");

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(TSCX, [CLI, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") {
      throw new Error(`the audit never ran: ${JSON.stringify(failure.stderr ?? failure)}`, {
        cause: error,
      });
    }
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test.describe("a11y:audit arguments", () => {
  test("--help states the exit codes, because a gate is read through them", async () => {
    const { stdout } = await exec(TSCX, [CLI, "--help"], { maxBuffer: 10 * 1024 * 1024 });

    expect(stdout).toContain("0  audited, no violations");
    expect(stdout).toContain("1  audited, violations found");
    expect(stdout).toContain("2  could not audit");
  });

  test("rejects an unknown flag instead of ignoring it", async () => {
    // A typo that is ignored changes nothing and says nothing, which is the same
    // failure as a typo that silently audits the wrong page.
    const result = await cli(["--colour", "blue"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown argument");
  });

  test("rejects a --max-nodes that is not a positive integer", async () => {
    const result = await cli(["--max-nodes", "zero"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--max-nodes");
  });

  test("a value flag with no value is an error, not the next flag", async () => {
    const result = await cli(["--url"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("requires a value");
  });
});
