import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore, PathAccessError } from "../../../src/mcp/store.js";

/** A valid defect, so readDefect has something real to accept. */
function defect(runId: string): string {
  return JSON.stringify({
    schemaVersion: "1.1.0",
    id: "demo-shows-the-status",
    runId,
    createdAt: "2026-10-03T00:00:00.000Z",
    status: "failed",
    test: { title: "shows the status", file: "tests/demo.spec.ts", line: 3 },
    failure: { message: "boom" },
    evidence: {},
    context: {},
    flakiness: { verdict: "unknown", attempts: 1 },
  });
}

async function scaffold(): Promise<{ root: string; runId: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "qf-store-"));
  const runId = "2026-10-03T00-00-00-000Z-abcdef";
  const runDir = path.join(base, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "demo-shows-the-status.v1.json"), defect(runId), "utf8");
  await writeFile(
    path.join(runDir, "quality-summary.v1.json"),
    JSON.stringify({
      schemaVersion: "1.1.0",
      runId,
      createdAt: "2026-10-03T00:00:00.000Z",
      counts: { specs: 3, passed: 2, failed: 1, timedOut: 0, skipped: 0, flaky: 0 },
      defects: [`${runId}/demo-shows-the-status.v1.json`],
      thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 },
      gate: { passed: true, violations: [] },
    }),
    "utf8",
  );
  return { root: base, runId };
}

async function store(): Promise<ArtifactStore> {
  const { root } = await scaffold();
  const instance = new ArtifactStore({ root });
  await instance.init();
  return instance;
}

test.describe("ArtifactStore confinement", () => {
  test("reads a file that lives inside the root", async () => {
    const { root, runId } = await scaffold();
    const instance = new ArtifactStore({ root });
    await instance.init();

    const found = await instance.resolve(`${runId}/demo-shows-the-status.v1.json`);

    expect(found.endsWith("demo-shows-the-status.v1.json")).toBe(true);
  });

  test("rejects an absolute path", async () => {
    const instance = await store();

    await expect(instance.resolve("/etc/passwd")).rejects.toThrow(PathAccessError);
  });

  test("rejects dot-dot traversal", async () => {
    const instance = await store();

    await expect(instance.resolve("../secrets.txt")).rejects.toThrow(PathAccessError);
    await expect(instance.resolve("a/../../secrets.txt")).rejects.toThrow(PathAccessError);
  });

  test("rejects percent-encoded traversal", async () => {
    // Decoding first matters: judged as an opaque string, %2e%2e%2f matches
    // no file and looks harmless.
    const instance = await store();

    await expect(instance.resolve("%2e%2e%2fsecrets.txt")).rejects.toThrow(PathAccessError);
  });

  test("rejects a NUL byte", async () => {
    const instance = await store();

    await expect(instance.resolve("file.json\0.txt")).rejects.toThrow(PathAccessError);
  });

  test("names malformed percent-encoding instead of guessing", async () => {
    const instance = await store();

    // Asserting only that it throws would pass even if the fallback let a
    // malformed path through to a "does not exist" rejection, which would hide
    // that the decode guard stopped working.
    await expect(instance.resolve("%zz")).rejects.toThrow(/malformed percent-encoding/);
  });

  test("rejects a symlink that points outside the root", async () => {
    // The decisive case. String checks alone would pass this.
    const base = await mkdtemp(path.join(tmpdir(), "qf-link-"));
    const root = path.join(base, "root");
    const outside = path.join(base, "outside.txt");
    await mkdir(root, { recursive: true });
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, path.join(root, "link.txt"));

    const instance = new ArtifactStore({ root });
    await instance.init();

    await expect(instance.resolve("link.txt")).rejects.toThrow(PathAccessError);
  });

  test("rejects a path that does not exist", async () => {
    const instance = await store();

    await expect(instance.resolve("nope.json")).rejects.toThrow(PathAccessError);
  });

  test("never leaks the absolute root in an error message", async () => {
    const { root } = await scaffold();
    const instance = new ArtifactStore({ root });
    await instance.init();

    // An error message can end up in a transcript or an LLM prompt.
    await expect(instance.resolve("../../etc/passwd")).rejects.toThrow(
      new RegExp(`^(?!.*${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}).*$`),
    );
  });

  test("init fails clearly when the root is absent", async () => {
    const instance = new ArtifactStore({ root: path.join(tmpdir(), "definitely-not-here-qf") });

    await expect(instance.init()).rejects.toThrow(/does not exist or is not readable/);
  });
});

test.describe("ArtifactStore reads", () => {
  test("lists runs newest first", async () => {
    const { root } = await scaffold();
    const older = "2026-10-02T00-00-00-000Z-aaaaaa";
    await mkdir(path.join(root, older), { recursive: true });
    await writeFile(
      path.join(root, older, "quality-summary.v1.json"),
      JSON.stringify({ runId: older, counts: { passed: 0, failed: 0 }, gate: {} }),
      "utf8",
    );

    const instance = new ArtifactStore({ root });
    await instance.init();
    const runs = await instance.listRuns();

    expect(runs).toHaveLength(2);
    expect(runs[0]?.runId.startsWith("2026-10-03")).toBe(true);
  });

  test("ignores a directory with no summary", async () => {
    const { root } = await scaffold();
    await mkdir(path.join(root, "not-a-run"), { recursive: true });

    const instance = new ArtifactStore({ root });
    await instance.init();

    expect((await instance.listRuns()).map((r) => r.runId)).not.toContain("not-a-run");
  });

  test("listDefects excludes the summary file", async () => {
    const instance = await store();
    const runs = await instance.listRuns();

    const defects = await instance.listDefects(runs[0]!.runId);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.endsWith("quality-summary.v1.json")).toBe(false);
  });

  test("readDefect returns a contract-valid artifact", async () => {
    const { root, runId } = await scaffold();
    const instance = new ArtifactStore({ root });
    await instance.init();

    const found = await instance.readDefect(`${runId}/demo-shows-the-status.v1.json`);

    expect(found.id).toBe("demo-shows-the-status");
    expect(found.runId).toBe(runId);
  });

  test("readDefect refuses an artifact that violates the contract", async () => {
    const { root, runId } = await scaffold();
    await writeFile(
      path.join(root, runId, "broken.v1.json"),
      JSON.stringify({ schemaVersion: "1.1.0", id: "NOT-KEBAB" }),
      "utf8",
    );
    const instance = new ArtifactStore({ root });
    await instance.init();

    // An artifact may be produced by an older version or edited by hand. It is
    // reported as unsound rather than passed to a model as if it were fine.
    await expect(instance.readDefect(`${runId}/broken.v1.json`)).rejects.toThrow(
      /violates the v1 contract/,
    );
  });

  test("readDefect rejects invalid JSON with the path, not its content", async () => {
    const { root, runId } = await scaffold();
    await writeFile(path.join(root, runId, "garbage.v1.json"), "{ not json", "utf8");
    const instance = new ArtifactStore({ root });
    await instance.init();

    await expect(instance.readDefect(`${runId}/garbage.v1.json`)).rejects.toThrow(/not valid JSON/);
  });

  test("readLatestSummary explains itself when the root is empty", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "qf-empty-"));
    const instance = new ArtifactStore({ root: base });
    await instance.init();

    await expect(instance.readLatestSummary()).rejects.toThrow(/No runs found/);
  });

  test("a defect on disk is what the summary claims", async () => {
    const { root, runId } = await scaffold();
    const instance = new ArtifactStore({ root });
    await instance.init();

    const summary = await instance.readSummary(runId);
    const listed = await instance.listDefects(runId);

    expect(summary.defects).toEqual(listed);
  });

  test("store exposes no write capability", async () => {
    const instance = await store();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(instance) as object).filter(
      (name) => name !== "constructor",
    );

    // Read-only is structural. A method named write/mutate would be a finding.
    expect(surface.filter((n) => /^(write|create|delete|remove|update|patch)/i.test(n))).toEqual(
      [],
    );
    expect(surface.length).toBeGreaterThan(0);
  });

  test("a root symlink is resolved, so a symlinked root still works", async () => {
    const { root, runId } = await scaffold();
    const link = path.join(await mkdtemp(path.join(tmpdir(), "qf-rootlink-")), "link");
    await symlink(root, link);

    const instance = new ArtifactStore({ root: link });
    await instance.init();

    expect((await instance.readDefect(`${runId}/demo-shows-the-status.v1.json`)).id).toBe(
      "demo-shows-the-status",
    );
  });

  test("the served summary is the file on disk, byte for byte parseable", async () => {
    const { root, runId } = await scaffold();
    const instance = new ArtifactStore({ root });
    await instance.init();

    const summary = await instance.readSummary(runId);
    const raw = JSON.parse(
      await readFile(path.join(root, runId, "quality-summary.v1.json"), "utf8"),
    ) as unknown;

    expect(summary).toEqual(raw);
  });
});
