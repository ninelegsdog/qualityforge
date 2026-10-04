import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

/**
 * The help text is the first thing a consumer reads, and it is a claim about
 * which commands exist.
 *
 * Both CLIs used to advertise invocations nobody could run: the collector
 * printed `npm run defects:collect`, a script a consuming project does not
 * have, and the server printed `Usage: qualityforge-mcp`, a `bin` this package
 * does not declare. Nothing failed, because nothing read the help.
 *
 * So the help is checked against the two sources of truth: `package.json` for
 * scripts, and the filesystem for the paths it hands out. Spawning rather than
 * importing keeps the exit code in the assertion too — a help that prints and
 * exits non-zero is not a working help.
 */

const exec = promisify(execFile);
const ROOT = process.cwd();

const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Every `npm run <name>` the text hands out. */
function scriptsMentioned(text: string): string[] {
  return [...text.matchAll(/npm run ([a-z0-9:-]+)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Every `node_modules/qualityforge/<path>` the text hands out. */
function packagePathsMentioned(text: string): string[] {
  return [...text.matchAll(/node_modules\/qualityforge\/(\S+)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Launchers a help line may legitimately start with. */
const LAUNCHERS = new Set(["npm", "npx", "node", "python", "python3"]);

/**
 * The command on the `Usage:` line itself, when there is one.
 *
 * `Usage: qualityforge-mcp` names a `bin` this package does not declare, and it
 * survived every check because no check read the line. A bare token here is a
 * promise about what a consumer can type, so it is either a known launcher or a
 * path that resolves inside this package — nothing else.
 */
function expectUsageLineIsRunnable(text: string): void {
  const match = /^Usage:[ \t]*(\S+)/m.exec(text);
  const command = match?.[1];
  if (command === undefined) return;

  const known =
    LAUNCHERS.has(command) || (command.includes("/") && existsSync(path.join(ROOT, command)));
  expect(known, `Usage line hands out \`${command}\`, which this package does not provide`).toBe(
    true,
  );
}

async function help(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await exec("npx", ["tsx", ...args, "--help"], {
    cwd: ROOT,
    timeout: 60_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

test.describe("help text", () => {
  test("collector help names only scripts and files that exist", async () => {
    const { stdout } = await help(["src/cli/collect-defects.ts"]);

    for (const script of scriptsMentioned(stdout)) {
      expect(
        script in PKG.scripts,
        `help advertises \`npm run ${script}\`, which is not a script in package.json`,
      ).toBe(true);
    }

    for (const file of packagePathsMentioned(stdout)) {
      expect(
        existsSync(path.join(ROOT, file)),
        `help advertises ${file}, which does not exist in the package`,
      ).toBe(true);
    }

    expectUsageLineIsRunnable(stdout);

    // Both ways of running it, or the section is not doing its job.
    expect(stdout).toContain("npm run defects:collect");
    expect(stdout).toContain("node_modules/qualityforge/src/cli/collect-defects.ts");
  });

  test("server help goes to stderr and names only scripts and files that exist", async () => {
    const { stdout, stderr } = await help(["src/mcp/index.ts"]);

    // stdout carries JSON-RPC frames. A banner printed there corrupts the
    // protocol stream, and `--help` is the easiest banner to add by accident.
    expect(stdout, "server help must not touch stdout").toBe("");

    for (const script of scriptsMentioned(stderr)) {
      expect(
        script in PKG.scripts,
        `help advertises \`npm run ${script}\`, which is not a script in package.json`,
      ).toBe(true);
    }

    for (const file of packagePathsMentioned(stderr)) {
      expect(
        existsSync(path.join(ROOT, file)),
        `help advertises ${file}, which does not exist in the package`,
      ).toBe(true);
    }

    expectUsageLineIsRunnable(stderr);

    expect(stderr).toContain("npm run mcp --");
    expect(stderr).toContain("node_modules/qualityforge/src/mcp/index.ts");
  });
});
