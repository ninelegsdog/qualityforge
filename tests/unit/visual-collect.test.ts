import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { baselinePathFor, collectDefects } from "../../src/defect/collect.js";

/**
 * The baseline metadata the collector actually writes.
 *
 * The audit builder can represent an unknown viewport, but that says nothing about
 * the file a run leaves behind: `readBaselines` used to fill `0×0×0` beside every
 * committed image, and the validator happily passed it. This test reads the
 * artifact from a real collection, so putting the zeros back is a failure rather
 * than a type-compatible detail.
 */

const THRESHOLDS = { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 };
const PNG = Buffer.from("a committed baseline image, not a real PNG", "utf8");
const SHA = createHash("sha256").update(PNG).digest("hex");

function reportFor(root: string): unknown {
  return {
    config: { rootDir: path.join(root, "tests") },
    stats: { startTime: "2026-10-19T09:00:00.000Z", duration: 100 },
    suites: [
      {
        title: "tests/smoke/visual.spec.ts",
        file: "smoke/visual.spec.ts",
        specs: [
          {
            id: "spec0",
            title: "the page renders",
            file: "smoke/visual.spec.ts",
            line: 10,
            tests: [
              {
                projectName: "chromium",
                expectedStatus: "passed",
                results: [
                  {
                    status: "passed",
                    retry: 0,
                    duration: 50,
                    startTime: "2026-10-19T09:00:00.000Z",
                    attachments: [
                      {
                        name: "quality-visual",
                        body: Buffer.from(
                          JSON.stringify({
                            schemaVersion: "1.0.0",
                            pages: [
                              {
                                path: "/",
                                sha256: SHA,
                                bytes: PNG.length,
                                viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
                                browser: "chromium",
                              },
                            ],
                          }),
                          "utf8",
                        ).toString("base64"),
                        contentType: "application/json",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test.describe("the appearance audit the collector writes", () => {
  test("a committed baseline says it has no viewport, rather than claiming 0×0×0", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-visual-collect-"));
    mkdirSync(path.join(root, "artifacts", "json"), { recursive: true });
    const reportPath = path.join(root, "artifacts", "json", "playwright-results.json");
    writeFileSync(reportPath, JSON.stringify(reportFor(root)), "utf8");

    const baseline = baselinePathFor("tests/visual-baselines", "/", "chromium");
    mkdirSync(path.dirname(path.join(root, baseline)), { recursive: true });
    writeFileSync(path.join(root, baseline), PNG);

    const { summary } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      thresholds: THRESHOLDS,
      visual: {
        directory: "artifacts/visual",
        baselineDirectory: "tests/visual-baselines",
        project: "chromium",
        pages: ["/"],
      },
      now: new Date("2026-10-19T09:30:00.000Z"),
      commit: null,
      branch: null,
    });

    expect(summary.visual?.violations).toEqual([]);
    const auditPath = summary.visual?.audit;
    if (auditPath === undefined) throw new Error("the collector wrote no appearance audit");
    const audit = JSON.parse(
      readFileSync(path.join(root, "artifacts", "visual", auditPath), "utf8"),
    ) as {
      pages: { baseline: { viewport: unknown } | null }[];
    };

    expect(audit.pages[0]?.baseline?.viewport).toBeNull();
  });
});
