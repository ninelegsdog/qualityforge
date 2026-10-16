#!/usr/bin/env node
/**
 * a11y:audit — run an accessibility audit and write one artifact.
 *
 * Usage:
 *   npm run a11y:audit
 *   npm run a11y:audit -- --url http://127.0.0.1:4311/docs
 *   npx --no-install qualityforge-a11y --out /tmp/scratch --json
 *
 * Exit codes:
 *   0  audited, no violations
 *   1  audited, violations found
 *   2  could not audit (bad config, no axe-core, browser refused the page)
 *
 * Exit code 1 is what makes this usable as a CI gate. Exit code 2 is
 * deliberately different from 0: an audit that never ran must never look like an
 * audit that found nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadConfig, ConfigError } from "../config/load-config.js";
import { AuditError, runAudit } from "../a11y/audit.js";
import { MAX_NODES_PER_RULE } from "../a11y/shape.js";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DEFAULT_OUT = "artifacts/a11y";

/**
 * Same rule as the collector: a CLI runs where it is run. Resolving everything
 * against this package's own directory is what made a consuming project's run
 * read the wrong report and still exit 0.
 */
function projectRootFor(configPath: string | undefined): string {
  const cwd = process.cwd();
  if (configPath !== undefined) return cwd;
  if (existsSync(path.join(cwd, "config", "project.json"))) return cwd;
  if (existsSync(path.join(PACKAGE_ROOT, "config", "project.json"))) return PACKAGE_ROOT;
  return cwd;
}

interface Args {
  url: string | undefined;
  configPath: string | undefined;
  outDir: string | undefined;
  maxNodes: number | undefined;
  asJson: boolean;
}

const VALUE_FLAGS = new Set(["--url", "--config", "--out", "--max-nodes"]);

function parseArgs(argv: string[]): Args {
  let url: string | undefined;
  let configPath: string | undefined;
  let outDir: string | undefined;
  let maxNodes: number | undefined;
  let asJson = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error(`Configuration error:\n  ${arg} requires a value`);
        process.exit(2);
      }
      if (arg === "--url") url = value;
      if (arg === "--config") configPath = value;
      if (arg === "--out") outDir = value;
      if (arg === "--max-nodes") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          console.error(`Configuration error:\n  --max-nodes must be a positive integer`);
          process.exit(2);
        }
        maxNodes = parsed;
      }
      i += 1;
    } else if (arg === "--json") {
      asJson = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage:\n" +
          "  this repository     npm run a11y:audit -- [flags]\n" +
          "  a consuming project npx --no-install qualityforge-a11y [flags]\n" +
          "\n" +
          "  --url <url>        page to audit (default baseUrl from the config)\n" +
          "  --config <path>    configuration file (default config/project.json)\n" +
          "  --out <dir>        where to write the audit (default " +
          DEFAULT_OUT +
          ")\n" +
          `  --max-nodes <n>    nodes kept per rule (default ${MAX_NODES_PER_RULE})\n` +
          "  --json             print the summary as JSON and nothing else\n" +
          "\n" +
          "Exit codes:\n" +
          "  0  audited, no violations\n" +
          "  1  audited, violations found\n" +
          "  2  could not audit (bad config, no axe-core, page unreachable)\n",
      );
      process.exit(0);
    } else {
      console.error(`Configuration error:\n  unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  return { url, configPath, outDir, maxNodes, asJson };
}

/**
 * A path a reader can act on.
 *
 * Relative to the project reads better, but `--out /tmp/scratch` is a
 * legitimate thing to type and it produced `../../../tmp/…` — technically
 * correct and practically useless.
 */
function displayPath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target);
  return relative.startsWith("..") ? target : relative;
}

async function main(): Promise<number> {
  const { url, configPath, outDir, maxNodes, asJson } = parseArgs(process.argv.slice(2));
  const projectRoot = projectRootFor(configPath);

  /**
   * The config is consulted only when it is needed.
   *
   * It used to be loaded unconditionally, which meant auditing any URL required
   * a `config/project.json` sitting next to it. `package:check` caught that: the
   * consumer directory has no project config, so an explicit `--url` died on
   * "cannot read configuration" before it ever reached the page. A flag that
   * names the target should not also require a project to belong to.
   */
  let target = url;
  if (target === undefined) {
    try {
      const config = await loadConfig(projectRoot, configPath);
      target = config.baseUrl;
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`Configuration error:\n${error.message}`);
        return 2;
      }
      throw error;
    }
  }

  try {
    const result = await runAudit({
      url: target,
      outputDir: path.resolve(projectRoot, outDir ?? DEFAULT_OUT),
      ...(maxNodes === undefined ? {} : { maxNodesPerRule: maxNodes }),
    });

    const { audit, runId, artifactPath } = result;
    const rules = [...audit.violations, ...audit.incomplete];

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            runId,
            url: audit.url,
            counts: audit.counts,
            rules: rules.map((rule) => ({
              id: rule.id,
              impact: rule.impact,
              nodes: rule.nodes.length,
              totalNodes: rule.totalNodes,
              truncated: rule.truncated,
            })),
            artifact: displayPath(projectRoot, artifactPath),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`run ${runId}`);
      console.log(`  ${audit.url} · axe-core ${audit.engine.version}`);
      console.log(
        `  violations ${audit.counts.violations} · incomplete ${audit.counts.incomplete} · ` +
          `nodes kept ${audit.counts.nodes}`,
      );
      for (const rule of rules) {
        console.log(
          `  - ${rule.id}${rule.impact === null ? " (impact unknown)" : ` [${rule.impact}]`}: ` +
            `${rule.nodes.length} of ${rule.totalNodes} nodes` +
            // A cap that does not say what it dropped is a silent loss, so this
            // line is never omitted when it applies.
            (rule.truncated ? " — truncated" : ""),
        );
      }
      console.log(`  artifact ${displayPath(projectRoot, artifactPath)}`);
      console.log(audit.counts.violations === 0 ? "  audit PASSED" : "  audit FOUND VIOLATIONS");
    }

    return audit.counts.violations === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof AuditError) {
      console.error(`Audit failed: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main();
