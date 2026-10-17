import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore, PathAccessError } from "../../../src/mcp/store.js";
import { callTool } from "../../../src/mcp/tools.js";
import { API_AUDIT_SCHEMA_VERSION, type ApiAudit } from "../../../src/api/types.js";

/**
 * API contract audits, over the store and through the tools.
 *
 * The third root, and the confinement test is the point of the file rather than an
 * afterthought. The server now holds **three** roots, all open at once, and a
 * client path is untrusted input to each. The dangerous version of this feature is
 * one where a path sent to an API tool walks out of `artifacts/api` and lands in the
 * defect tree — or in the accessibility audits — because the server happened to have
 * all three open. Pinned below in both directions.
 */

/** A run's audit, valid against `api-audit.v1`, with overrides for each case. */
function apiAudit(overrides: Partial<ApiAudit> = {}): ApiAudit {
  return {
    schemaVersion: API_AUDIT_SCHEMA_VERSION,
    createdAt: "2026-10-17T09:30:00.000Z",
    baseUrl: "http://127.0.0.1:4311",
    counts: { expectations: 2, tests: 1, violations: 1, passed: 1 },
    expectations: [
      {
        name: "items-are-json",
        method: "GET",
        path: "/api/items",
        declared: {
          status: 200,
          contentType: "application/json",
          responseRequires: ["[0].id"],
        },
        observed: { exchanges: 3, dropped: 0, tests: 1 },
        violations: [
          {
            kind: "status",
            expected: "200",
            observed: "status 500",
            exchanges: 1,
            tests: 1,
          },
        ],
      },
      {
        name: "contact-is-accepted",
        method: "POST",
        path: "/api/contact",
        declared: {
          status: 200,
        },
        observed: { exchanges: 2, dropped: 0, tests: 1 },
        violations: [],
      },
    ],
    ...overrides,
  };
}

/** A store over a temp tree holding one defect run, one audit run and one API run. */
async function store(): Promise<ArtifactStore> {
  const root = await mkdtemp(path.join(tmpdir(), "qf-api-store-"));
  const defects = path.join(root, "defects");
  const audits = path.join(root, "a11y");
  const api = path.join(root, "api");
  const runId = "2026-10-17T09-30-00-000Z-deadbe";

  await mkdir(path.join(defects, "run-1"), { recursive: true });
  await writeFile(
    path.join(defects, "run-1", "quality-summary.v1.json"),
    JSON.stringify({ runId: "run-1", counts: {} }),
    "utf8",
  );
  await mkdir(path.join(audits, "2026-10-16T01-29-31-810Z-abcdef"), { recursive: true });
  await writeFile(
    path.join(audits, "2026-10-16T01-29-31-810Z-abcdef", "audit.v1.json"),
    "{}",
    "utf8",
  );
  await mkdir(path.join(api, runId), { recursive: true });
  await writeFile(path.join(api, runId, "api-audit.v1.json"), JSON.stringify(apiAudit()), "utf8");

  const instance = new ArtifactStore({ root: defects, auditRoot: audits, apiRoot: api });
  await instance.init();
  return instance;
}

const API_PATH = "2026-10-17T09-30-00-000Z-deadbe/api-audit.v1.json";

test.describe("the api store", () => {
  test("lists api audits newest first, with the counts a reader needs", async () => {
    const audits = await store().then((s) => s.listApiAudits());

    expect(audits).toHaveLength(1);
    expect(audits[0]?.violations).toBe(1);
    expect(audits[0]?.expectations).toBe(2);
    expect(audits[0]?.tests).toBe(1);
    expect(audits[0]?.path).toBe(API_PATH);
  });

  test("a project that declares no contracts gets an empty list, not an error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-api-none-"));
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    const instance = new ArtifactStore({ root: path.join(root, "defects") });
    await instance.init();

    expect(await instance.listApiAudits()).toEqual([]);
  });

  test("reads one api audit back", async () => {
    const loaded = await store().then((s) => s.readApiAudit(API_PATH));

    expect(loaded.expectations[0]?.violations[0]?.kind).toBe("status");
    expect(loaded.expectations[0]?.observed.exchanges).toBe(3);
  });

  test("refuses a path that walks out of the api root into the defect tree", async () => {
    // The case this feature could quietly get wrong, and the reason the third root
    // is confined rather than merely prefixed.
    await expect(
      store().then((s) => s.readApiAudit("../defects/run-1/quality-summary.v1.json")),
    ).rejects.toThrow();
  });

  test("refuses a path that walks out of the api root into the accessibility audits", async () => {
    // The direction that only appears once there are three roots. A path aimed at
    // `audit.v1.json` must be judged against `artifacts/api`, not found because the
    // server happens to have that file open under another name.
    await expect(
      store().then((s) => s.readApiAudit("../a11y/2026-10-16T01-29-31-810Z-abcdef/audit.v1.json")),
    ).rejects.toThrow();
  });

  test("an absolute path is refused", async () => {
    await expect(store().then((s) => s.readApiAudit("/etc/passwd"))).rejects.toThrow();
  });

  test("asking about api audits when the project declares none says so", async () => {
    // Not an empty answer: "nobody has declared a contract" and "every contract
    // held" are different facts, and a tool that returned the second for the first
    // would be making a claim the run never made.
    const root = await mkdtemp(path.join(tmpdir(), "qf-api-ask-"));
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    const instance = new ArtifactStore({ root: path.join(root, "defects") });
    await instance.init();

    const result = await callTool(instance, "quality_get_api_audit", {
      auditPath: "x/api-audit.v1.json",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No API audits found");
  });
});

test.describe("the api tools", () => {
  test("the list names each run's declared, tested and failing counts", async () => {
    const result = await callTool(await store(), "quality_list_api_audits", {});
    const text = JSON.stringify(result.content);

    expect(text).toContain("API contract audit(s)");
    expect(text).toContain("2 declared, 1 test(s), 1 violation(s)");
    expect(text).toContain("quality_get_api_audit");
  });

  test("a run with no capture says NOT RUN, not zero violations", async () => {
    // Found by CI on the collector side: a run of pure logic tests never imports the
    // fixture, so `tests: 0` means nobody looked. Printing "0 violation(s)" here
    // would make an unrun dimension read as a clean one.
    const root = await mkdtemp(path.join(tmpdir(), "qf-api-notrun-"));
    const runId = "not-a-run-yet";
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    await mkdir(path.join(root, "api", runId), { recursive: true });
    await writeFile(
      path.join(root, "api", runId, "api-audit.v1.json"),
      JSON.stringify(
        apiAudit({
          counts: { expectations: 2, tests: 0, violations: 0, passed: 0 },
          // A run that never produced a capture holds every contract, because it
          // observed none. The runtime validator enforces exactly that — counts that
          // claim nothing must be backed by an empty violation list — and this
          // fixture was refused until it said so.
          expectations: apiAudit().expectations.map((expectation) => ({
            ...expectation,
            observed: { exchanges: 0, dropped: 0, tests: 0 },
            violations: [],
          })),
        }),
      ),
      "utf8",
    );
    const instance = new ArtifactStore({
      root: path.join(root, "defects"),
      apiRoot: path.join(root, "api"),
    });
    await instance.init();

    const result = await callTool(instance, "quality_list_api_audits", {});

    expect(JSON.stringify(result.content)).toContain("NOT RUN");
    expect(JSON.stringify(result.content)).not.toContain("0 violation(s)");
  });

  test("reading one audit names the contract, what was expected and what was seen", async () => {
    const result = await callTool(await store(), "quality_get_api_audit", { auditPath: API_PATH });
    const text = JSON.stringify(result.content);

    expect(text).toContain("GET /api/items");
    expect(text).toContain("200 — observed status 500");
    // A contract that held is named too, with what it was examined against.
    expect(text).toContain("POST /api/contact");
    expect(text).toContain("held across");
    // The rule a reader would otherwise guess wrong.
    expect(text).toContain("Values never survive a body");
  });

  test("a missing auditPath is an error naming the list tool", async () => {
    const result = await callTool(await store(), "quality_get_api_audit", {});

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("quality_list_api_audits");
  });

  test("a directory without a readable audit is not a run", async () => {
    // Same rule `listRuns` follows for a directory with no summary: a run is what it
    // wrote, not what its name claims.
    const root = await mkdtemp(path.join(tmpdir(), "qf-api-empty-"));
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    await mkdir(path.join(root, "api", "empty-run"), { recursive: true });
    const instance = new ArtifactStore({
      root: path.join(root, "defects"),
      apiRoot: path.join(root, "api"),
    });
    await instance.init();

    expect(await instance.listApiAudits()).toEqual([]);
  });

  test("a rejected path still throws, so the server can log and answer for it", async () => {
    // The guard that says "a refusal is a readable answer" must not swallow a
    // *rejected path*. Those are different events: a project with no contracts gets
    // a sentence, while a path sent from outside the root is a security event, and
    // the server's own handler answers it with "Path is not readable" and writes
    // the log line that says a client tried.
    //
    // Written after a reverse run came back green: dropping that one line changed
    // nothing any test noticed.
    await expect(
      callTool(await store(), "quality_get_api_audit", {
        auditPath: "../defects/run-1/quality-summary.v1.json",
      }),
    ).rejects.toThrow(PathAccessError);
  });

  test("an artifact that violates the contract is refused rather than served", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qf-api-bad-"));
    const runId = "bad-run";
    await mkdir(path.join(root, "defects", "run-1"), { recursive: true });
    await writeFile(
      path.join(root, "defects", "run-1", "quality-summary.v1.json"),
      JSON.stringify({ runId: "run-1", counts: {} }),
      "utf8",
    );
    await mkdir(path.join(root, "api", runId), { recursive: true });
    // Counts claim one violation, the list carries none: the two invariants the JSON
    // Schema cannot express, and the reason there is a runtime validator at all.
    await writeFile(
      path.join(root, "api", runId, "api-audit.v1.json"),
      JSON.stringify(apiAudit({ counts: { expectations: 2, tests: 1, violations: 9, passed: 1 } })),
      "utf8",
    );
    const instance = new ArtifactStore({
      root: path.join(root, "defects"),
      apiRoot: path.join(root, "api"),
    });
    await instance.init();

    expect(await instance.listApiAudits()).toEqual([]);
    await expect(instance.readApiAudit(`${runId}/api-audit.v1.json`)).rejects.toThrow(
      /api-audit\.v1 contract/,
    );
  });
});
