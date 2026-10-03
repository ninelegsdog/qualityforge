#!/usr/bin/env node
/**
 * defects:collect — turn the last Playwright JSON report into defect artifacts.
 *
 * Usage:
 *   npm run defects:collect
 *   npm run defects:collect -- --config config/project.json --json
 *   npm run defects:collect -- --report other-results.json --out /tmp/scratch
 *
 * Exit codes:
 *   0  collected, quality gate passed
 *   1  collected, quality gate failed (violations found)
 *   2  could not collect (bad config, missing report)
 *
 * Exit code 1 is what makes this usable as a CI quality gate.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "../config/load-config.js";
import { collectDefects } from "../defect/collect.js";
import { readGitInfo } from "../defect/git-info.js";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const DEFAULT_REPORT = "artifacts/json/playwright-results.json";
const DEFAULT_TEST_DIR = "tests";

interface Args {
  configPath: string | undefined;
  reportPath: string | undefined;
  outDir: string | undefined;
  asJson: boolean;
}

/** Flags that take a value, so a missing one gets a message and not a guess. */
const VALUE_FLAGS = new Set(["--config", "--report", "--out"]);

function parseArgs(argv: string[]): Args {
  let configPath: string | undefined;
  let reportPath: string | undefined;
  let outDir: string | undefined;
  let asJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      // A bare value flag followed by another flag means the value was
      // forgotten. Silently accepting the next flag would write artifacts
      // somewhere derived from a flag name.
      if (value === undefined || value.startsWith("--")) {
        console.error(`Configuration error:\n  ${arg} requires a value`);
        process.exit(2);
      }
      if (arg === "--config") configPath = value;
      if (arg === "--report") reportPath = value;
      if (arg === "--out") outDir = value;
      i += 1;
    } else if (arg === "--json") {
      asJson = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npm run defects:collect -- [--config <path>] [--report <path>] " +
          "[--out <dir>] [--json]\n" +
          "\n" +
          "  --config <path>  configuration file (default config/project.json)\n" +
          "  --report <path>  Playwright JSON report to read (default " +
          DEFAULT_REPORT +
          ")\n" +
          "  --out <dir>      where to write run artifacts (default " +
          "defects.directory from the config)\n" +
          "  --json           print the run summary as JSON and nothing else\n",
      );
      process.exit(0);
    } else {
      // Unknown flags used to be ignored, which meant a typo silently changed
      // nothing at all. A collector that quietly collects from the wrong report
      // is worse than one that refuses.
      console.error(`Configuration error:\n  unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { configPath, reportPath, outDir, asJson };
}

async function main(): Promise<number> {
  const { configPath, reportPath, outDir, asJson } = parseArgs(process.argv.slice(2));

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

  const { commit, branch, problem } = await readGitInfo(ROOT);
  if (problem !== undefined) {
    // stderr, never stdout: --json promises that stdout carries the summary and
    // nothing else, and a warning printed there would corrupt it for whoever
    // parses it. Silently recording commit: null would be worse — this is the
    // difference between "there is no git here" and "there is and I could not
    // read it", and only the second is a bug worth saying out loud.
    console.warn(`Warning: no git context recorded: ${problem}`);
  }

  try {
    const { defects, summary, runDir } = await collectDefects({
      projectRoot: ROOT,
      testDir: DEFAULT_TEST_DIR,
      outputDir: outDir ?? config.defects.directory,
      reportPath: reportPath ?? DEFAULT_REPORT,
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
