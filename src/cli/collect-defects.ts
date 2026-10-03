#!/usr/bin/env node
/**
 * defects:collect — turn the last Playwright JSON report into defect artifacts.
 *
 * Usage:
 *   npm run defects:collect
 *   npm run defects:collect -- --config config/project.json --json
 *
 * Exit codes:
 *   0  collected, quality gate passed
 *   1  collected, quality gate failed (violations found)
 *   2  could not collect (bad config, missing report)
 *
 * Exit code 1 is what makes this usable as a CI quality gate.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "../config/load-config.js";
import { collectDefects } from "../defect/collect.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const DEFAULT_REPORT = "artifacts/json/playwright-results.json";
const DEFAULT_TEST_DIR = "tests";

function parseArgs(argv: string[]): { configPath: string | undefined; asJson: boolean } {
  let configPath: string | undefined;
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config" && argv[i + 1] !== undefined) {
      configPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--json") {
      asJson = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: npm run defects:collect -- [--config <path>] [--json]\n" +
          "\n" +
          "  --config <path>  configuration file (default config/project.json)\n" +
          "  --json           print the run summary as JSON and nothing else\n",
      );
      process.exit(0);
    }
  }
  return { configPath, asJson };
}

/**
 * Read git metadata without shelling out from the collector itself.
 *
 * Resolves the full ref path rather than just the branch name: HEAD contains
 * "refs/heads/main", and joining only "main" onto .git produces a path that
 * does not exist. Falls back to packed-refs, which is where a branch goes
 * after enough commits.
 */
async function gitInfo(root: string): Promise<{ commit: string | null; branch: string | null }> {
  const gitDir = path.join(root, ".git");
  const nothing = { commit: null, branch: null } as const;

  let head: string;
  try {
    head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
  } catch {
    // Not a git checkout. Not fatal; the artifact just omits VCS context.
    return nothing;
  }

  const branchRef = /^ref:\s*(refs\/heads\/.+)$/.exec(head);
  if (branchRef?.[1]) {
    const branch = branchRef[1].slice("refs/heads/".length);

    const loose = await readFile(path.join(gitDir, branchRef[1]), "utf8").catch(() => null);
    if (loose !== null) {
      return { commit: loose.trim(), branch };
    }

    const packed = await readFile(path.join(gitDir, "packed-refs"), "utf8").catch(() => null);
    const match =
      packed === null ? null : new RegExp(`^([0-9a-f]{40}) ${branchRef[1]}$`, "m").exec(packed);
    return { commit: match?.[1] ?? null, branch };
  }

  // Detached HEAD: the file holds the commit itself.
  if (/^[0-9a-f]{40}$/.test(head)) {
    return { commit: head, branch: null };
  }
  return nothing;
}

async function main(): Promise<number> {
  const { configPath, asJson } = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = await loadConfig(ROOT, configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error:\n${error.message}`);
      return 2;
    }
    throw error;
  }

  const { commit, branch } = await gitInfo(ROOT);

  try {
    const { defects, summary, runDir } = await collectDefects({
      projectRoot: ROOT,
      testDir: DEFAULT_TEST_DIR,
      outputDir: config.defects.directory,
      reportPath: DEFAULT_REPORT,
      baseUrl: config.baseUrl,
      referenceErrorContext: config.defects.referenceErrorContext,
      tags: config.tags,
      thresholds: config.thresholds,
      commit,
      branch,
      ci: process.env.CI !== undefined,
      retries: process.env.CI ? 1 : 0,
    });

    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const written = await readdir(runDir).catch(() => []);
      console.log(`run ${summary.runId}`);
      console.log(
        `  specs ${summary.counts.specs} · passed ${summary.counts.passed} · ` +
          `failed ${summary.counts.failed} · skipped ${summary.counts.skipped} · ` +
          `flaky ${summary.counts.flaky}`,
      );
      console.log(`  artifacts in ${path.relative(ROOT, runDir)}/ (${written.length} files)`);
      for (const defect of defects) {
        console.log(`  - ${defect.status} ${defect.id}`);
        console.log(
          `      ${defect.test.file}:${defect.test.line ?? "?"} · ${defect.flakiness.verdict}`,
        );
      }
      console.log(
        summary.gate.passed
          ? "  gate PASSED"
          : `  gate FAILED\n${summary.gate.violations.map((v) => `    - ${v}`).join("\n")}`,
      );
    }

    return summary.gate.passed ? 0 : 1;
  } catch (error) {
    console.error(`Collection failed: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = await main();
