import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "../../../src/mcp/store.js";
import { callTool } from "../../../src/mcp/tools.js";
import type { A11yAudit } from "../../../src/a11y/types.js";

/**
 * Accessibility audits, over the store and through the tools.
 *
 * The property worth the most attention here is confinement. The server now
 * holds two roots — defects and audits — and a client path is untrusted input to
 * both. The dangerous version of this feature is one where a path sent to an
 * audit tool walks out of the audit root and lands in the defect tree, because
 * the server happened to have both open. That case is pinned below rather than
 * assumed away.
 */

function audit(overrides: Partial<A11yAudit> = {}): A11yAudit {
  return {
    schemaVersion: "1.0.0",
    url: "https://example.com",
    createdAt: "2026-10-16T01:29:31.810Z",
    engine: { name: "axe-core", version: "4.14.0" },
    counts: { violations: 1, incomplete: 0, nodes: 1, truncatedRules: 0 },
    violations: [
      {
        id: "image-alt",
        impact: "critical",
        nodes: [
          {
            target: ["img"],
            html: "<img src>",
            failureSummary: "Fix any of the following: no alt attribute",
          },
        ],
        totalNodes: 48,
        truncated: true,
      },
    ],
    incomplete: [],
    ...overrides,
  };
}

/** A store over a temp tree holding one defect run and one audit run. */
async function store(): Promise<ArtifactStore> {
  const root = await mkdtemp(path.join(tmpdir(), "qf-audit-store-"));
  const defects = path.join(root, "defects");
  const audits = path.join(root, "a11y");

  await mkdir(path.join(defects, "run-1"), { recursive: true });
  await writeFile(
    path.join(defects, "run-1", "quality-summary.v1.json"),
    JSON.stringify({ runId: "run-1", counts: {} }),
    "utf8",
  );
  await mkdir(path.join(audits, "2026-10-16T01-29-31-810Z-abcdef"), { recursive: true });
  await writeFile(
    path.join(audits, "2026-10-16T01-29-31-810Z-abcdef", "audit.v1.json"),
    JSON.stringify(audit(), null, 2),
    "utf8",
  );

  const instance = new ArtifactStore({ root: defects, auditRoot: audits });
  await instance.init();
  return instance;
}

test.describe("the audit store", () => {
  test("lists audits newest first, with the counts a reader needs", async () => {
    const audits = await store().then((s) => s.listAudits());

    expect(audits).toHaveLength(1);
    expect(audits[0]?.violations).toBe(1);
    expect(audits[0]?.truncatedRules).toBe(0);
    expect(audits[0]?.path).toBe("2026-10-16T01-29-31-810Z-abcdef/audit.v1.json");
  });

  test("a project with no audits gets an empty list, not an error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-audit-none-"));
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    const instance = new ArtifactStore({ root: path.join(root, "defects") });
    await instance.init();

    expect(await instance.listAudits()).toEqual([]);
  });

  test("reads one audit back", async () => {
    const loaded = await store().then((s) =>
      s.readAudit("2026-10-16T01-29-31-810Z-abcdef/audit.v1.json"),
    );

    expect(loaded.violations[0]?.totalNodes).toBe(48);
    expect(loaded.violations[0]?.truncated).toBe(true);
  });

  test("refuses a path that walks out of the audit root into the defect tree", async () => {
    // The case this feature could quietly get wrong: the server holds both
    // roots, so a client path aimed at the defect run must still be judged
    // against the audit root.
    await expect(
      store().then((s) => s.readAudit("../defects/run-1/quality-summary.v1.json")),
    ).rejects.toThrow(/outside the configured artifacts root/);
  });

  test("refuses an absolute path and a traversal spelled with encoding", async () => {
    await expect(store().then((s) => s.readAudit("/etc/passwd"))).rejects.toThrow(
      /outside the configured artifacts root/,
    );
    await expect(store().then((s) => s.readAudit("%2e%2e%2fdefects%2frun-1"))).rejects.toThrow(
      /outside the configured artifacts root/,
    );
  });

  test("refuses an artifact that violates its own contract", async () => {
    const instance = await store();
    const broken = audit({ violations: [] });
    (broken.violations as unknown[]).push({ id: "x", nodes: [], totalNodes: 0 });
    await mkdir(path.join(instance.root, "..", "a11y", "run-bad"), { recursive: true });

    // Written through the store's own confinement: the point is the validator,
    // not the path.
    const auditsRoot = path.join(path.dirname(instance.root), "a11y");
    await writeFile(
      path.join(auditsRoot, "2026-10-16T01-29-31-810Z-abcdef", "audit.v1.json"),
      JSON.stringify({ ...audit(), url: "https://example.com/?token=x" }),
      "utf8",
    );

    await expect(
      instance.readAudit("2026-10-16T01-29-31-810Z-abcdef/audit.v1.json"),
    ).rejects.toThrow(/violates the a11y-audit\.v1 contract/);
  });
});

test.describe("the audit tools", () => {
  test("say plainly that nobody has audited, naming the command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-audit-tools-"));
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    const instance = new ArtifactStore({ root: path.join(root, "defects") });
    await instance.init();

    const result = await callTool(instance, "quality_list_audits", {});

    expect(result.content[0]?.text).toContain("npm run a11y:audit");
    // "Nobody looked" must not read as "nothing found".
    expect(result.content[0]?.text).toContain(
      "says nothing about whether the project is accessible",
    );
  });

  test("list and read report the truncation the artifact records", async () => {
    const instance = await store();

    const list = await callTool(instance, "quality_list_audits", {});
    expect(list.content[0]?.text).toContain("1 accessibility audit(s)");

    const one = await callTool(instance, "quality_get_audit", {
      auditPath: "2026-10-16T01-29-31-810Z-abcdef/audit.v1.json",
    });
    // Kept against real is the whole point of totalNodes; without it a model
    // cannot tell a capped artifact from a complete one.
    expect(one.content[0]?.text).toContain("1 of 48 node(s)");
    expect(one.content[0]?.text).toContain("truncated");
  });

  test("a missing auditPath is refused with a way forward", async () => {
    const result = await callTool(await store(), "quality_get_audit", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("quality_list_audits");
  });
});
