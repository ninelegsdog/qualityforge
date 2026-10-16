import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "../fixtures.js";

/**
 * The audit command, run as a command, with a real browser.
 *
 * These live in the smoke suite because they launch one. The unit jobs install
 * no browser, so an audit there exits 2 for want of a browser and every
 * assertion about 0 and 1 fails — CI refused the first version of this file for
 * exactly that reason, and the fix was to split the layers rather than to make
 * the unit job install something it does not need.
 *
 * `file://` pages, no server and no network: the runner starts its own browser,
 * and a test that depends on somebody else's uptime eventually lies to us. Both
 * a clean page and a page with known defects are audited, because measured —
 * this repository's own three fixture routes produce **zero** violations, so a
 * green audit of them is not evidence that the audit works.
 */

const exec = promisify(execFile);
const CLI = path.join(process.cwd(), "src", "cli", "a11y-audit.ts");
const TSCX = path.join(process.cwd(), "node_modules", ".bin", "tsx");

const BROKEN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>control</title></head>
  <body><h1>control</h1><button></button><img src="/x.png"><input type="text" id="a"></body></html>`;

const CLEAN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>clean</title></head>
  <body><main><h1>clean</h1><button>press me</button></main></body></html>`;

function page(dir: string, name: string, html: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, html, "utf8");
  return `file://${file}`;
}

async function audit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

test.describe("a11y:audit, with a real browser", () => {
  let work: string;

  test.beforeEach(() => {
    work = mkdtempSync(path.join(os.tmpdir(), "qf-a11y-run-"));
  });

  test.afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test("finds violations and exits 1, so it can be a CI gate", async () => {
    const out = path.join(work, "out");
    const result = await audit([
      "--url",
      page(work, "broken.html", BROKEN_PAGE),
      "--out",
      out,
      "--json",
    ]);

    expect(result.code, result.stderr).toBe(1);
    const summary = JSON.parse(result.stdout) as {
      counts: { violations: number };
      artifact: string;
      rules: { id: string; nodes: number; totalNodes: number }[];
    };
    expect(summary.counts.violations).toBeGreaterThan(0);
    // Kept against real: the cap is only honest if both numbers travel.
    expect(summary.rules.every((rule) => rule.totalNodes >= rule.nodes)).toBe(true);

    const artifact = JSON.parse(readFileSync(summary.artifact, "utf8")) as {
      schemaVersion: string;
      violations: { id: string; nodes: { html: string }[] }[];
    };
    expect(artifact.schemaVersion).toBe("1.0.0");
    // Structure kept, values dropped — the same rule the unit tests pin, proven
    // here against what the engine actually returned.
    expect(artifact.violations.find((rule) => rule.id === "image-alt")?.nodes[0]?.html).toBe(
      "<img src>",
    );
  });

  test("reports a clean page as clean, with exit 0", async () => {
    const result = await audit([
      "--url",
      page(work, "clean.html", CLEAN_PAGE),
      "--out",
      path.join(work, "out"),
      "--json",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(
      (JSON.parse(result.stdout) as { counts: { violations: number } }).counts.violations,
    ).toBe(0);
  });

  test("a page it cannot reach is a failure, never a clean result", async () => {
    // Port 1 refuses instantly. Exit 2 must stay distinct from 0.
    const result = await audit(["--url", "http://127.0.0.1:1/", "--out", path.join(work, "out")]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Audit failed");
  });

  test("creates the output directory it was told to use", async () => {
    const out = path.join(work, "deep", "nested", "out");

    const result = await audit(["--url", page(work, "clean.html", CLEAN_PAGE), "--out", out]);

    expect(result.code, result.stderr).toBe(0);
    const runs = readdirSync(out);
    expect(runs).toHaveLength(1);
    expect(existsSync(path.join(out, runs[0] as string, "audit.v1.json"))).toBe(true);
  });
});
