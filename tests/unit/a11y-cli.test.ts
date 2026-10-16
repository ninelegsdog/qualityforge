import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

/**
 * The audit command, run as a command.
 *
 * Spawned rather than imported, because the things worth checking here are the
 * exit codes and the file on disk — the same things a CI gate would see. A
 * cleaned page and a deliberately broken one are both audited, because measured
 * earlier: the project's own fixtures produce **zero** violations, so a green
 * audit of them is not evidence that the audit works.
 *
 * `file://` pages rather than the fixtures server: the runner starts its own
 * browser, so these need no server, no network and no third-party host. A test
 * that depends on somebody else's uptime eventually lies to us.
 */

const exec = promisify(execFile);
const CLI = path.join(process.cwd(), "src", "cli", "a11y-audit.ts");
const TSCX = path.join(process.cwd(), "node_modules", ".bin", "tsx");

const BROKEN_PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>control</title></head>
  <body><h1>control</h1><button></button><img src="/x.png"><input type="text" id="a"></body></html>`;

const CLEAN_PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>clean</title></head>
  <body><main><h1>clean</h1><button>press me</button></main></body></html>`;

function page(dir: string, name: string, html: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, html, "utf8");
  return `file://${file}`;
}

/** Exit code of a finished run. A spawn failure is not exit 1. */
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

test.describe("a11y:audit", () => {
  let work: string;

  test.beforeEach(() => {
    work = mkdtempSync(path.join(os.tmpdir(), "qf-a11y-cli-"));
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

    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stdout) as {
      counts: { violations: number };
      artifact: string;
      rules: { id: string; nodes: number; totalNodes: number }[];
    };
    expect(summary.counts.violations).toBeGreaterThan(0);
    // The counts are what make the cap visible: kept against real.
    expect(summary.rules.some((rule) => rule.totalNodes >= rule.nodes)).toBe(true);

    const artifact = JSON.parse(readFileSync(summary.artifact, "utf8")) as {
      schemaVersion: string;
      violations: { id: string; nodes: { html: string; target: string[] }[] }[];
    };
    expect(artifact.schemaVersion).toBe("1.0.0");
    const image = artifact.violations.find((rule) => rule.id === "image-alt");
    expect(image?.nodes[0]?.html).toBe("<img src>");
  });

  test("reports a clean page as clean, with exit 0", async () => {
    const result = await audit([
      "--url",
      page(work, "clean.html", CLEAN_PAGE),
      "--out",
      path.join(work, "out"),
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(
      (JSON.parse(result.stdout) as { counts: { violations: number } }).counts.violations,
    ).toBe(0);
  });

  test("a page it cannot reach is a failure, never a clean result", async () => {
    // Port 1 refuses instantly. Exit 2 must be distinct from 0: an audit that
    // never ran must never read as an audit that found nothing.
    const result = await audit(["--url", "http://127.0.0.1:1/", "--out", path.join(work, "out")]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Audit failed");
  });

  test("rejects an unknown flag instead of ignoring it", async () => {
    const result = await audit(["--colour", "blue"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown argument");
  });

  test("rejects a --max-nodes that is not a positive integer", async () => {
    const result = await audit(["--max-nodes", "zero"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--max-nodes");
  });

  test("--help explains the exit codes", async () => {
    const { stdout } = await exec(TSCX, [CLI, "--help"], { maxBuffer: 10 * 1024 * 1024 });

    expect(stdout).toContain("0  audited, no violations");
    expect(stdout).toContain("2  could not audit");
  });

  test("a directory that does not exist is created rather than refused", async () => {
    const out = path.join(work, "deep", "nested", "out");
    expect(() => mkdirSync(out, { recursive: true })).not.toThrow();
    rmSync(out, { recursive: true, force: true });

    const result = await audit(["--url", page(work, "clean.html", CLEAN_PAGE), "--out", out]);

    expect(result.code).toBe(0);
  });
});
