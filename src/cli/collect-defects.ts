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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "../config/load-config.js";
import { collectDefects } from "../defect/collect.js";
import { readGitInfo } from "../defect/git-info.js";

/** Where this script lives, used only as a fallback. */
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const DEFAULT_REPORT = "artifacts/json/playwright-results.json";
const DEFAULT_TEST_DIR = "tests";

/**
 * The project this run belongs to.
 *
 * Everything used to resolve against `PACKAGE_ROOT`, which is correct inside
 * this repository and wrong the moment a consuming project runs the collector:
 * the config came from `node_modules/qualityforge/config/project.json`, the
 * report was looked for inside `node_modules`, the artifacts were written back
 * into `node_modules`, and the recorded git commit was ours rather than the
 * caller's. Every one of those collected the wrong project while exiting 0.
 *
 * A CLI runs where it is run, so the working directory wins whenever it holds a
 * project of its own. Falling back to this checkout keeps the old behaviour for
 * anyone invoking the script from a subdirectory of this repository.
 */
function projectRootFor(configPath: string | undefined): string {
  const cwd = process.cwd();
  if (configPath !== undefined) return cwd;
  if (existsSync(path.join(cwd, "config", "project.json"))) return cwd;
  if (existsSync(path.join(PACKAGE_ROOT, "config", "project.json"))) return PACKAGE_ROOT;
  return cwd;
}

interface Args {
  configPath: string | undefined;
  reportPath: string | undefined;
  outDir: string | undefined;
  asJson: boolean;
  /** Suppress run history, whatever `config.history` says. */
  noHistory: boolean;
}

/** Flags that take a value, so a missing one gets a message and not a guess. */
const VALUE_FLAGS = new Set(["--config", "--report", "--out"]);

function parseArgs(argv: string[]): Args {
  let configPath: string | undefined;
  let reportPath: string | undefined;
  let outDir: string | undefined;
  let asJson = false;
  let noHistory = false;
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
    } else if (arg === "--no-history") {
      noHistory = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage:\n" +
          "  this repository     npm run defects:collect -- [flags]\n" +
          "  a consuming project npx tsx node_modules/qualityforge/src/cli/collect-defects.ts [flags]\n" +
          "\n" +
          "  --config <path>  configuration file (default config/project.json)\n" +
          "  --report <path>  Playwright JSON report to read (default " +
          DEFAULT_REPORT +
          ")\n" +
          "  --out <dir>      where to write run artifacts (default " +
          "defects.directory from the config)\n" +
          "  --json           print the run summary as JSON and nothing else\n" +
          "  --no-history     do not append to the run history, whatever the config says\n",
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
  return { configPath, reportPath, outDir, asJson, noHistory };
}

async function main(): Promise<number> {
  const { configPath, reportPath, outDir, asJson, noHistory } = parseArgs(process.argv.slice(2));
  const projectRoot = projectRootFor(configPath);

  let config;
  try {
    config = await loadConfig(projectRoot, configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error:\n${error.message}`);
      return 2;
    }
    throw error;
  }

  // BASE_URL is what playwright.config.ts reads, so when it is set it is the
  // best available evidence of the application the browser was actually on. The
  // collector records which input it used, so an artifact never claims an
  // origin without saying where that claim came from.
  const environmentBaseUrl = process.env.BASE_URL;

  const { commit, branch, problem } = await readGitInfo(projectRoot);
  if (problem !== undefined) {
    // stderr, never stdout: --json promises that stdout carries the summary and
    // nothing else, and a warning printed there would corrupt it for whoever
    // parses it. Silently recording commit: null would be worse — this is the
    // difference between "there is no git here" and "there is and I could not
    // read it", and only the second is a bug worth saying out loud.
    console.warn(`Warning: no git context recorded: ${problem}`);
  }

  try {
    const { defects, summary, runDir, history } = await collectDefects({
      projectRoot,
      testDir: DEFAULT_TEST_DIR,
      outputDir: outDir ?? config.defects.directory,
      reportPath: reportPath ?? DEFAULT_REPORT,
      baseUrl: config.baseUrl,
      ...(environmentBaseUrl === undefined ? {} : { environmentBaseUrl }),
      referenceErrorContext: config.defects.referenceErrorContext,
      // `--no-history` exists for runs that are not runs of this project: a seeded
      // check produces a 100%-failing run inside a scratch directory, and letting it
      // append would mean every CI pass wrote synthetic entries into a history whose
      // whole value is that it records what actually happened here.
      ...(config.history === undefined || noHistory ? {} : { history: config.history }),
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
          `flaky ${summary.counts.flaky}` +
          // Only when non-zero: an aborted suite is not a normal run and should
          // not have to be hunted for in the gate violations.
          (summary.counts.aborted === 0 ? "" : ` · aborted ${summary.counts.aborted}`),
      );
      console.log(
        `  artifacts in ${path.relative(projectRoot, runDir)}/ (${written.length} files)`,
      );
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
      // History problems are printed, never thrown on: the artifacts are already
      // written and uploaded, and a red build over a missing index would train people
      // to ignore the one line that says it did not work.
      if (history?.failed !== undefined) {
        console.error(`  history NOT written: ${history.failed}`);
      } else if (history !== undefined) {
        console.log(
          `  history ${path.relative(projectRoot, history.path)}` +
            (history.removed.length === 0
              ? ""
              : ` (pruned ${history.removed.length} older run(s))`),
        );
        if (history.rotationFailed !== undefined) {
          console.error(`  history not pruned: ${history.rotationFailed}`);
        }
      }
    }

    return summary.gate.passed ? 0 : 1;
  } catch (error) {
    console.error(`Collection failed: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = await main();
