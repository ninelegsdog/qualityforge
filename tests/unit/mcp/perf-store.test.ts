import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore, PathAccessError } from "../../../src/mcp/store.js";
import { callTool } from "../../../src/mcp/tools.js";
import { PERF_AUDIT_SCHEMA_VERSION, type PerfAudit } from "../../../src/perf/types.js";

/**
 * Transfer budgets, over the store and through the tools.
 *
 * The **fourth** root, and the confinement test is the point of the file rather than
 * an afterthought. Four directories are now open at once, and every client path is
 * untrusted input to each. The dangerous version of this feature is one where a path
 * sent to a budget tool walks out of `artifacts/perf` and lands in the API audits —
 * the same class of mistake as the API→accessibility escape, and only reachable now.
 *
 * The bytes are the measured ones from the demo server on 2026-10-18: a 20 000 byte
 * budget, a 3 922 byte home page and a 526 538 byte heavy one.
 */

const RUN_ID = "2026-10-18T09-30-00-000Z-deadbe";
const API_PATH = "2026-10-17T09-30-00-000Z-seeded/api-audit.v1.json";
const PERF_PATH = `${RUN_ID}/perf-audit.v1.json`;

function audit(overrides: Partial<PerfAudit> = {}): PerfAudit {
  return {
    schemaVersion: PERF_AUDIT_SCHEMA_VERSION,
    createdAt: "2026-10-18T09:30:00.000Z",
    baseUrl: "http://127.0.0.1:4311",
    counts: { budgets: 2, tests: 1, pages: 1, passed: 1, violations: 1 },
    budgets: [
      {
        path: "/heavy",
        budgetBytes: 20000,
        measuredBytes: 526538,
        observations: 1,
        tests: 1,
        violations: [
          {
            kind: "over-budget",
            expected: "at most 20,000 bytes",
            observed: "526,538 bytes, 506,538 over",
            observations: 1,
            tests: 1,
          },
        ],
      },
      {
        path: "/",
        budgetBytes: 20000,
        measuredBytes: 3922,
        observations: 1,
        tests: 1,
        violations: [],
      },
    ],
    ...overrides,
  };
}

/** A store over a temp tree holding one run of each of the three audited kinds. */
async function store(): Promise<ArtifactStore> {
  const root = await mkdtemp(path.join(tmpdir(), "qf-perf-store-"));
  const defects = path.join(root, "defects");
  const audits = path.join(root, "a11y");
  const api = path.join(root, "api");
  const perf = path.join(root, "perf");

  await mkdir(path.join(defects, "run-1"), { recursive: true });
  await writeFile(
    path.join(defects, "run-1", "quality-summary.v1.json"),
    JSON.stringify({ runId: "run-1", counts: {} }),
    "utf8",
  );
  await mkdir(path.join(audits, "a11y-run"), { recursive: true });
  await writeFile(path.join(audits, "a11y-run", "audit.v1.json"), "{}", "utf8");
  await mkdir(path.join(api, "api-run"), { recursive: true });
  await writeFile(path.join(api, "api-run", "api-audit.v1.json"), "{}", "utf8");
  await mkdir(path.join(perf, RUN_ID), { recursive: true });
  await writeFile(path.join(perf, RUN_ID, "perf-audit.v1.json"), JSON.stringify(audit()), "utf8");

  const instance = new ArtifactStore({
    root: defects,
    auditRoot: audits,
    apiRoot: api,
    perfRoot: perf,
  });
  await instance.init();
  return instance;
}

test.describe("the perf store", () => {
  test("lists budget audits newest first, with the counts a reader needs", async () => {
    const audits = await store().then((s) => s.listPerfAudits());

    expect(audits).toHaveLength(1);
    expect(audits[0]?.violations).toBe(1);
    expect(audits[0]?.budgets).toBe(2);
    expect(audits[0]?.tests).toBe(1);
    expect(audits[0]?.path).toBe(PERF_PATH);
  });

  test("a project that declares no budget gets an empty list, not an error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-perf-none-"));
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    const instance = new ArtifactStore({ root: path.join(root, "defects") });
    await instance.init();

    expect(await instance.listPerfAudits()).toEqual([]);
  });

  test("reads one budget audit back", async () => {
    const loaded = await store().then((s) => s.readPerfAudit(PERF_PATH));

    expect(loaded.budgets[0]?.violations[0]?.kind).toBe("over-budget");
    expect(loaded.budgets[0]?.measuredBytes).toBe(526538);
  });

  test("refuses a path that walks out of the perf root into the API audits", async () => {
    // The escape that only exists now that four roots are open at once.
    await expect(store().then((s) => s.readPerfAudit(`../api/${API_PATH}`))).rejects.toThrow();
  });

  test("refuses a path that walks out of the perf root into the defect tree", async () => {
    await expect(
      store().then((s) => s.readPerfAudit("../defects/run-1/quality-summary.v1.json")),
    ).rejects.toThrow();
  });

  test("an absolute path is refused", async () => {
    await expect(store().then((s) => s.readPerfAudit("/etc/passwd"))).rejects.toThrow();
  });

  test("an artifact that violates the contract is refused rather than served", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-perf-bad-"));
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    await mkdir(path.join(root, "perf", RUN_ID), { recursive: true });
    // Counts claim one violation, the list carries none.
    await writeFile(
      path.join(root, "perf", RUN_ID, "perf-audit.v1.json"),
      JSON.stringify(
        audit({ counts: { budgets: 2, tests: 1, pages: 1, passed: 1, violations: 9 } }),
      ),
      "utf8",
    );
    const instance = new ArtifactStore({
      root: path.join(root, "defects"),
      perfRoot: path.join(root, "perf"),
    });
    await instance.init();

    expect(await instance.listPerfAudits()).toEqual([]);
    await expect(instance.readPerfAudit(PERF_PATH)).rejects.toThrow(/perf-audit\.v1 contract/);
  });
});

test.describe("the perf tools", () => {
  test("the list names each run's declared, measured and failing counts", async () => {
    const result = await callTool(await store(), "quality_list_perf_audits", {});
    const text = JSON.stringify(result.content);

    expect(text).toContain("transfer-budget audit(s)");
    expect(text).toContain("2 budget(s)");
    expect(text).toContain("1 breach(es)");
    expect(text).toContain("quality_get_perf_audit");
  });

  test("reading one audit names the budget, what was allowed and what was measured", async () => {
    const result = await callTool(await store(), "quality_get_perf_audit", {
      auditPath: PERF_PATH,
    });
    const text = JSON.stringify(result.content);

    expect(text).toContain("/heavy: 526538 bytes of 20000 allowed");
    expect(text).toContain("at most 20,000 bytes — observed 526,538 bytes, 506,538 over");
    // A budget that held is named too, or a client cannot tell which pages were
    // examined at all.
    expect(text).toContain("/: 3922 bytes of 20000 allowed, held");
    // The rule a client would otherwise assume wrongly.
    expect(text).toContain("LARGEST");

    // **And the structured content**, not only the prose. A first version of this
    // test asserted the text alone, so a run where `structuredContent` was emptied of
    // its violations still passed here — while `mcp-tools-check.py`, which reads what
    // crosses the wire, failed on it. Text and payload are two deliveries, and a
    // client reads whichever its transport gives it.
    const payload = result.structuredContent as unknown as {
      budgets: { path: string; violations: unknown[] }[];
    };
    expect(payload.budgets.find((b) => b.path === "/heavy")?.violations).toHaveLength(1);
    expect(payload.budgets.find((b) => b.path === "/")?.violations).toEqual([]);
  });

  test("a run with no capture says NOT RUN, not zero breaches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-perf-notrun-"));
    const runId = "not-a-run";
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    await mkdir(path.join(root, "perf", runId), { recursive: true });
    await writeFile(
      path.join(root, "perf", runId, "perf-audit.v1.json"),
      JSON.stringify(
        audit({
          counts: { budgets: 2, tests: 0, pages: 0, passed: 0, violations: 0 },
          budgets: audit().budgets.map((budget) => ({
            ...budget,
            measuredBytes: null,
            observations: 0,
            violations: [],
          })),
        }),
      ),
      "utf8",
    );
    const instance = new ArtifactStore({
      root: path.join(root, "defects"),
      perfRoot: path.join(root, "perf"),
    });
    await instance.init();

    const result = await callTool(instance, "quality_list_perf_audits", {});

    expect(JSON.stringify(result.content)).toContain("NOT RUN");
    expect(JSON.stringify(result.content)).not.toContain("0 breach(es)");
  });

  test("a missing auditPath is an error naming the list tool", async () => {
    const result = await callTool(await store(), "quality_get_perf_audit", {});

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("quality_list_perf_audits");
  });

  test("a project that declares no budget gets a sentence, not an empty result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-perf-ask-"));
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    const instance = new ArtifactStore({ root: path.join(root, "defects") });
    await instance.init();

    const result = await callTool(instance, "quality_get_perf_audit", {
      auditPath: "x/perf-audit.v1.json",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No transfer-budget audits found");
  });

  test("a rejected path still throws, so the server can log and answer for it", async () => {
    // A refusal about *the project* is a readable answer; a path from outside is a
    // security event, and the guard separating them must not be caught by the first.
    await expect(
      callTool(await store(), "quality_get_perf_audit", { auditPath: `../api/${API_PATH}` }),
    ).rejects.toThrow(PathAccessError);
  });
});
