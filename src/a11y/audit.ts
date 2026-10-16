/**
 * Run one accessibility audit and write one artifact.
 *
 * An audit is not a defect. It exists whether or not anything failed, so it gets
 * its own runner, its own directory and its own exit code, and nothing here
 * touches `defect.v1`.
 *
 * The browser work is real on purpose. The decision to keep only `violations`
 * and `incomplete`, the 10-node cap and the structure-only `html` were all
 * chosen from a real engine's output, and a runner that fed itself a fixture
 * would be asserting agreement with itself.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { shapeAudit, MAX_NODES_PER_RULE, type RawAxeResult } from "./shape.js";
import { validateAudit, type A11yAudit } from "./types.js";

const require = createRequire(import.meta.url);

/** Thrown when the audit could not be produced at all. Exit code 2. */
export class AuditError extends Error {}

/**
 * Locate `axe-core`, or explain how to get it.
 *
 * Fail-closed on purpose: an audit that reports zero violations because the
 * engine never loaded is the worst possible failure — it looks like a passing
 * result. The message names the package and the command, because "cannot find
 * module" is not something a reader can act on.
 */
export function resolveAxePath(): string {
  try {
    return require.resolve("axe-core/axe.min.js");
  } catch {
    throw new AuditError(
      "axe-core is not installed, so there is nothing to audit with.\n" +
        "  npm i -D axe-core   in this project, or npm i axe-core in a consuming one.\n" +
        "  It is declared as a peer dependency: the audit uses the engine you already have.",
    );
  }
}

/** Same reasoning as the DOM cast in the smoke test: no DOM lib, by design. */
interface Browser {
  document: unknown;
  axe: { run: (context: unknown) => Promise<unknown> };
}

export interface AuditOptions {
  url: string;
  outputDir: string;
  /** Overridable so a test can prove the cap is the cap. */
  maxNodesPerRule?: number;
  timeoutMs?: number;
}

export interface AuditResult {
  runId: string;
  audit: A11yAudit;
  /** Absolute path of the artifact written. */
  artifactPath: string;
}

function runId(url: string): string {
  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, "-");
  const suffix = createHash("sha256").update(`${now}${url}`).digest("hex").slice(0, 6);
  return `${stamp}-${suffix}`;
}

export async function runAudit(options: AuditOptions): Promise<AuditResult> {
  const { url, outputDir, maxNodesPerRule = MAX_NODES_PER_RULE, timeoutMs = 30_000 } = options;
  const axePath = resolveAxePath();

  // Imported lazily so that `--help` and a missing-axe error do not pay for a
  // Playwright import, and so the failure above is the first thing a reader sees.
  const { chromium } = await import("@playwright/test");

  let raw: RawAxeResult;
  const browser = await chromium.launch().catch((error: unknown) => {
    const message = (error as Error).message;
    throw new AuditError(
      `could not start a browser: ${message}` +
        // The peer means the browser to install follows whichever Playwright the
        // project already has — observed here: this machine carries build 1243
        // for 1.63.0, and a fresh consumer install resolved a different version
        // wanting 1248. Naming the command saves a long guessing loop.
        (message.includes("Executable doesn't exist")
          ? "\n  npx playwright install chromium   installs the browser this version expects"
          : ""),
      { cause: error },
    );
  });

  try {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.addScriptTag({ path: axePath });
      raw = await page.evaluate(async () => {
        const { axe, document } = globalThis as unknown as Browser;
        return (await axe.run(document)) as RawAxeResult;
      });
    } catch (error) {
      throw new AuditError(`could not audit ${url}: ${(error as Error).message}`, { cause: error });
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }

  const audit = shapeAudit(raw, { maxNodesPerRule });

  /**
   * Validate before writing, as `collectDefects` does for a defect. If this
   * fails, the producer is wrong — the contract is not relaxed to fit it.
   */
  const validation = validateAudit(audit);
  if (!validation.valid) {
    throw new AuditError(
      `the audit artifact failed validation and was not written:\n${validation.problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
  }

  const id = runId(url);
  const runDir = path.join(outputDir, id);
  await mkdir(runDir, { recursive: true });
  const artifactPath = path.join(runDir, "audit.v1.json");
  await writeFile(artifactPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");

  return { runId: id, audit, artifactPath };
}
