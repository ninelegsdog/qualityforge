import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

type AuditOnDisk = {
  pages: {
    observed?: { sha256: string; bytes: number; file: string }[];
    violations?: { kind: string }[];
    baseline: { viewport: unknown } | null;
  }[];
};

/** A second, differently rendered appearance, so the tests have a real second hash. */
const APPEARANCE_B = Buffer.from("a second, differently rendered appearance", "utf8");
const SHA_B = createHash("sha256").update(APPEARANCE_B).digest("hex");

/** One spec whose last attempt carries a visual payload and, optionally, image bytes. */
function specWith(
  title: string,
  payload: { sha256: string; bytes: number },
  images: { name: string; bytes: Buffer }[] = [],
): unknown {
  return {
    id: `spec-${title}`,
    title,
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
                        sha256: payload.sha256,
                        bytes: payload.bytes,
                        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
                        browser: "chromium",
                      },
                    ],
                  }),
                  "utf8",
                ).toString("base64"),
                contentType: "application/json",
              },
              ...images.map((image) => ({
                name: image.name,
                body: image.bytes.toString("base64"),
                contentType: "image/png",
              })),
            ],
          },
        ],
      },
    ],
  };
}

/**
 * The root a collection runs in: a committed baseline on disk and the JSON report
 * beside it, exactly what the CLI produces and then consumes.
 */
function seededRoot(specs: unknown[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "qf-visual-observed-"));
  mkdirSync(path.join(root, "artifacts", "json"), { recursive: true });
  writeFileSync(
    path.join(root, "artifacts", "json", "playwright-results.json"),
    JSON.stringify({
      config: { rootDir: path.join(root, "tests") },
      stats: { startTime: "2026-10-19T09:00:00.000Z", duration: 100 },
      suites: [
        {
          title: "tests/smoke/visual.spec.ts",
          file: "smoke/visual.spec.ts",
          specs,
        },
      ],
    }),
    "utf8",
  );
  const baseline = baselinePathFor("tests/visual-baselines", "/", "chromium");
  mkdirSync(path.dirname(path.join(root, baseline)), { recursive: true });
  writeFileSync(path.join(root, baseline), PNG);
  return root;
}

function collectOptions(
  root: string,
  observedImages?: { keep: number },
): Parameters<typeof collectDefects>[0] {
  return {
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
      ...(observedImages === undefined ? {} : { observedImages }),
    },
    now: new Date("2026-10-19T09:30:00.000Z"),
    commit: null,
    branch: null,
  };
}

function readAudit(root: string, auditPath: string): AuditOnDisk {
  return JSON.parse(
    readFileSync(path.join(root, "artifacts", "visual", auditPath), "utf8"),
  ) as AuditOnDisk;
}

test.describe("the observed images the collector stores", () => {
  test("by default the audit stays picture-free", async () => {
    // The owner's decision recorded as G24: hashes, byte counts and the viewport
    // cross the artifact boundary, and no observed picture does, unless a project
    // asks for one. This is the shape every run wrote before the escalation, and
    // it is still the shape every run writes without the block.
    const root = seededRoot([specWith("the page renders", { sha256: SHA, bytes: PNG.length })]);

    const { summary } = await collectDefects(collectOptions(root));
    const auditPath = summary.visual?.audit;
    if (auditPath === undefined) throw new Error("the collector wrote no appearance audit");
    const audit = readAudit(root, auditPath);

    expect("observed" in audit.pages[0]!).toBe(false);
    expect(existsSync(path.join(root, "artifacts", "visual", summary.runId, "observed"))).toBe(
      false,
    );
  });

  test("an opted-in project stores the judged capture beside the audit", async () => {
    const root = seededRoot([
      specWith("the page renders", { sha256: SHA, bytes: PNG.length }, [
        { name: `quality-visual-image-${SHA}`, bytes: PNG },
      ]),
    ]);

    const { summary } = await collectDefects(collectOptions(root, { keep: 2 }));
    const auditPath = summary.visual?.audit;
    if (auditPath === undefined) throw new Error("the collector wrote no appearance audit");
    const audit = readAudit(root, auditPath);
    const [stored] = audit.pages[0]?.observed ?? [];
    if (stored === undefined) throw new Error("the opted-in audit stored no observed image");

    expect(audit.pages[0]?.violations).toEqual([]);
    expect(stored.sha256).toBe(SHA);
    expect(stored.bytes).toBe(PNG.length);
    // The pointer is project-root-relative and human-openable, and the file it
    // names is the bytes the capture produced — opening the file answers sha256
    // again, which is what makes the name and the file one fact.
    expect(stored.file).toBe(`artifacts/visual/${summary.runId}/observed/${SHA}.png`);
    expect(readFileSync(path.join(root, stored.file)).equals(PNG)).toBe(true);
  });

  test("retention frees the copies of the runs nobody wants, and keeps their audits", async () => {
    const root = seededRoot([
      specWith("the page renders", { sha256: SHA, bytes: PNG.length }, [
        { name: `quality-visual-image-${SHA}`, bytes: PNG },
      ]),
    ]);
    const visualRoot = path.join(root, "artifacts", "visual");
    // Two older runs that also stored images. Run ids sort lexicographically into
    // chronological order, so a keep of 2 frees the oldest copy and keeps the
    // middle run's — the current run is the newest of the three.
    const olderRuns: [string, string][] = [
      ["2026-10-18T00-00-00-000Z-older", "the oldest copy"],
      ["2026-10-19T00-00-00-000Z-newer", "a newer copy"],
    ];
    for (const [name, content] of olderRuns) {
      const runDir = path.join(visualRoot, name);
      mkdirSync(path.join(runDir, "observed"), { recursive: true });
      writeFileSync(path.join(runDir, "observed", "kept.png"), content, "utf8");
      writeFileSync(
        path.join(runDir, "visual-audit.v1.json"),
        JSON.stringify({ runId: name }),
        "utf8",
      );
    }

    await collectDefects(collectOptions(root, { keep: 2 }));

    expect(existsSync(path.join(visualRoot, "2026-10-18T00-00-00-000Z-older", "observed"))).toBe(
      false,
    );
    // The audit of the pruned run survives: it is the contract, not the copy.
    expect(
      existsSync(path.join(visualRoot, "2026-10-18T00-00-00-000Z-older", "visual-audit.v1.json")),
    ).toBe(true);
    expect(
      readFileSync(
        path.join(visualRoot, "2026-10-19T00-00-00-000Z-newer", "observed", "kept.png"),
        "utf8",
      ),
    ).toBe("a newer copy");
  });

  test("an attachment whose name does not match its bytes stops the run", async () => {
    const claimed = createHash("sha256").update("some other bytes entirely").digest("hex");
    const root = seededRoot([
      specWith("the page renders", { sha256: SHA, bytes: PNG.length }, [
        { name: `quality-visual-image-${claimed}`, bytes: PNG },
      ]),
    ]);

    // The name is the pairing, and the content is the truth. An audit whose
    // pointed-to file opens as different bytes is exactly two appearances wearing
    // one hash, so the collector refuses before the run is collected at all.
    await expect(collectDefects(collectOptions(root, { keep: 2 }))).rejects.toThrow(
      /bytes hash to/,
    );
  });

  test("a judged capture with no carried bytes stops the run", async () => {
    const root = seededRoot([specWith("the page renders", { sha256: SHA, bytes: PNG.length })]);

    // The opt-in is a promise the producer makes: every judged appearance's bytes
    // ride along. A payload whose sha256 has no image behind it would write an audit
    // that points at an emptiness the reader cannot tell from "stored on purpose",
    // so the collector refuses instead.
    await expect(collectDefects(collectOptions(root, { keep: 2 }))).rejects.toThrow(
      /did not carry its bytes/,
    );
  });

  test("an unstable page stores every way it rendered, in first-appearance order", async () => {
    const root = seededRoot([
      specWith("the first look", { sha256: SHA, bytes: PNG.length }, [
        { name: `quality-visual-image-${SHA}`, bytes: PNG },
      ]),
      specWith("the second look", { sha256: SHA_B, bytes: APPEARANCE_B.length }, [
        { name: `quality-visual-image-${SHA_B}`, bytes: APPEARANCE_B },
      ]),
    ]);

    const { summary } = await collectDefects(collectOptions(root, { keep: 2 }));
    const auditPath = summary.visual?.audit;
    if (auditPath === undefined) throw new Error("the collector wrote no appearance audit");
    const audit = readAudit(root, auditPath);

    // Both ways are part of the finding the reviewer must make sense of, and the
    // order tells them which of the pictures the run saw first.
    expect(audit.pages[0]?.violations?.[0]?.kind).toBe("unstable");
    expect(audit.pages[0]?.observed?.map((image) => image.sha256)).toEqual([SHA, SHA_B]);
    expect(
      existsSync(path.join(root, "artifacts", "visual", summary.runId, "observed", `${SHA}.png`)),
    ).toBe(true);
    expect(
      existsSync(path.join(root, "artifacts", "visual", summary.runId, "observed", `${SHA_B}.png`)),
    ).toBe(true);
  });
});
