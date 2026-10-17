import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectDefects } from "../../src/defect/collect.js";
import { validateApiAudit, type ApiAudit } from "../../src/api/types.js";
import type { ApiExpectation } from "../../src/config/types.js";

/**
 * The collector writing an API audit, over a report shaped like the real one.
 *
 * The report here is built by hand, which is the risk this file is written
 * against: a hand-written report agrees with whatever its author believed about
 * Playwright's shape. So the two facts the collector depends on are stated as
 * facts and pinned by the defect collector's own tests — `quality-api` is an
 * **inline** attachment on the **last result** of a test, base64 encoded, and the
 * fixture writes it on every test rather than only on failures.
 *
 * Two controls carry the file:
 *
 * - a **passing** contract writes an audit with zero violations;
 * - a **broken** one writes an audit that names the endpoint and the reason.
 *
 * And the negative half the project rule asks for: an artifact the validator
 * refuses must stop the run rather than reach disk.
 */
const THRESHOLDS = { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 };

const ITEMS: ApiExpectation = {
  name: "items-are-json",
  method: "GET",
  path: "/api/items",
  status: 200,
  contentType: "application/json",
  responseRequires: ["[0].id", "[0].name"],
};

/** A capture exactly as the fixture attaches it. */
function capture(options: {
  exchanges?: number;
  status?: number;
  responseMissing?: string[];
  dropped?: number;
  expectations?: ApiExpectation[];
}): string {
  const expectation = options.expectations?.[0] ?? ITEMS;
  return JSON.stringify({
    schemaVersion: "1.0.0",
    baseUrl: "http://127.0.0.1:4311",
    expectations: [
      {
        name: expectation.name,
        method: expectation.method,
        path: expectation.path,
        observed: options.exchanges ?? 1,
        dropped: options.dropped ?? 0,
        exchanges:
          options.exchanges === 0
            ? []
            : [
                {
                  origin: "http://127.0.0.1:4311",
                  status: options.status ?? 200,
                  contentType: "application/json",
                  requestKind: "absent",
                  requestMissing: [],
                  responseKind: "json",
                  responseMissing: options.responseMissing ?? [],
                },
              ],
      },
    ],
  });
}

/** A report whose specs each carry one inline `quality-api` attachment. */
function report(root: string, captures: string[]): string {
  return JSON.stringify({
    config: { rootDir: path.join(root, "tests") },
    stats: { startTime: "2026-10-17T09:00:00.000Z", duration: 100 },
    suites: [
      {
        title: "tests/smoke/api.spec.ts",
        file: "smoke/api.spec.ts",
        specs: captures.map((body, index) => ({
          id: `spec${index}`,
          title: `checks the contract ${index}`,
          file: "smoke/api.spec.ts",
          line: 10 + index,
          tests: [
            {
              projectName: "chromium",
              expectedStatus: "passed",
              results: [
                {
                  status: "passed",
                  retry: 0,
                  duration: 50,
                  startTime: "2026-10-17T09:00:00.000Z",
                  attachments: [
                    {
                      name: "quality-api",
                      // The JSON reporter base64-encodes an inline attachment body
                      // and writes no file for it. A collector reading `path` here
                      // would find nothing and report a working fixture broken.
                      body: Buffer.from(body, "utf8").toString("base64"),
                      contentType: "application/json",
                    },
                  ],
                },
              ],
            },
          ],
        })),
      },
    ],
  });
}

function writeReport(root: string, captures: string[]): void {
  mkdirSync(path.join(root, "artifacts", "json"), { recursive: true });
  writeFileSync(path.join(root, "artifacts/json/playwright-results.json"), report(root, captures));
}

async function collect(
  root: string,
  expectations: ApiExpectation[] | undefined,
): Promise<{ auditPath: string | undefined; audit: ApiAudit | undefined; runId: string }> {
  const result = await collectDefects({
    projectRoot: root,
    testDir: "tests",
    outputDir: "artifacts/defects",
    reportPath: "artifacts/json/playwright-results.json",
    thresholds: THRESHOLDS,
    now: new Date("2026-10-17T09:30:00.000Z"),
    commit: "deadbeef",
    branch: "main",
    ...(expectations === undefined ? {} : { api: { directory: "artifacts/api", expectations } }),
  });

  if (result.apiAudit === undefined) {
    return { auditPath: undefined, audit: undefined, runId: result.summary.runId };
  }
  const text = readFileSync(result.apiAudit.path, "utf8");
  return {
    auditPath: result.apiAudit.path,
    audit: JSON.parse(text) as ApiAudit,
    runId: result.summary.runId,
  };
}

test.describe("the collector writing an API audit", () => {
  test("writes a valid artifact for a contract that held", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    writeReport(root, [capture({})]);

    const { auditPath, audit } = await collect(root, [ITEMS]);

    expect(auditPath).toBeDefined();
    expect(audit?.counts.violations).toBe(0);
    expect(audit?.counts.passed).toBe(1);
    expect(validateApiAudit(audit).problems).toEqual([]);
    // `defect.v1` is untouched: no api field, and the audit is not among defects.
    expect(audit?.baseUrl).toBe("http://127.0.0.1:4311");
  });

  test("writes the audit where the configuration asked, beside the defects", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    writeReport(root, [capture({})]);

    const { auditPath, runId } = await collect(root, [ITEMS]);

    // The run directory is the run's own id, not a guess: `makeRunId` appends a
    // random suffix so two collections in the same second do not collide.
    expect(auditPath).toBe(path.join(root, "artifacts", "api", runId, "api-audit.v1.json"));
    expect(existsSync(path.join(root, "artifacts", "api"))).toBe(true);
    // A sibling of the defects directory, not inside it: the contract reserves a
    // run directory for one artifact per failure.
    expect(
      existsSync(path.join(root, "artifacts", "defects", runId, "quality-summary.v1.json")),
    ).toBe(true);
  });

  test("names the endpoint and the reason when the contract broke", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    writeReport(root, [capture({ status: 500 })]);

    const { audit } = await collect(root, [ITEMS]);
    const violation = audit?.expectations[0]?.violations[0];

    expect(audit?.counts.violations).toBe(1);
    expect(violation?.kind).toBe("status");
    expect(violation?.expected).toBe("200");
    expect(violation?.observed).toBe("status 500");
  });

  test("an expectation no test reached is still a violation, across the whole run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    // Two tests, neither of which visited /contact: the fail-closed case, and it
    // only exists because the collector reads every spec rather than only failures.
    writeReport(root, [capture({}), capture({ expectations: [ITEMS] })]);

    const contact: ApiExpectation = {
      name: "contact-is-posted-and-accepted",
      method: "POST",
      path: "/api/contact",
      status: 200,
    };
    const { audit } = await collect(root, [ITEMS, contact]);
    const contactResult = audit?.expectations.find((e) => e.name === contact.name);

    expect(contactResult?.violations[0]?.kind).toBe("no-exchange");
    expect(contactResult?.violations[0]?.observed).toContain("POST /api/contact");
  });

  test("aggregates across every spec that ran", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    writeReport(root, [capture({}), capture({}), capture({})]);

    const { audit } = await collect(root, [ITEMS]);

    expect(audit?.expectations[0]?.observed).toEqual({ exchanges: 3, dropped: 0, tests: 3 });
    expect(audit?.counts.tests).toBe(3);
  });

  test("writes nothing at all when no expectations are declared", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    writeReport(root, [capture({})]);

    const { auditPath, audit } = await collect(root, undefined);

    expect(audit).toBeUndefined();
    expect(auditPath).toBeUndefined();
    expect(existsSync(path.join(root, "artifacts", "api"))).toBe(false);
  });

  test("an attachment that is not JSON stops the run rather than being skipped", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    writeReport(root, ["{ not json"]);

    await expect(collect(root, [ITEMS])).rejects.toThrow(/is not JSON/);
  });

  test("an artifact the validator refuses never reaches disk", async () => {
    // The guard before writing is the one thing this file could not prove by
    // observation: every honest producer emits a valid artifact, so removing the
    // guard changes nothing the tests could see. That was found by a reverse run
    // which came back green.
    //
    // A duplicated name is the reachable input: the loader refuses one, but
    // `collectDefects` is exported and a caller can still pass it, and the
    // artifact would then carry two results a consumer cannot tell apart.
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    writeReport(root, [capture({})]);

    await expect(collect(root, [ITEMS, ITEMS])).rejects.toThrow(/is invalid/);
    // And nothing was written: the audit directory the run would have used is not
    // there, so a caller cannot mistake a failed run for a clean one.
    expect(existsSync(path.join(root, "artifacts", "api"))).toBe(false);
  });

  test("a body whose fields are missing is reported against the expectation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-api-"));
    writeReport(root, [capture({ responseMissing: ["[0].id"] })]);

    const { audit } = await collect(root, [ITEMS]);

    expect(audit?.expectations[0]?.violations[0]?.kind).toBe("missing-response-field");
    expect(audit?.expectations[0]?.violations[0]?.expected).toBe("[0].id");
  });
});
