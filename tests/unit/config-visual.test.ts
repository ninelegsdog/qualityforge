import { expect, test } from "@playwright/test";
import { ConfigError, parseConfig } from "../../src/config/load-config.js";
import { CONFIG_SCHEMA_VERSION } from "../../src/config/types.js";

/**
 * `visual.observedImages`, the observed-image store.
 *
 * Declaring the block **is** the opt-in, in the shape `history` already uses: a
 * project without the block stores no observed picture at all, and stays with the
 * hash-plus-viewport contract G24 made the default. When it is declared, `keep` is
 * required rather than defaulted — the default a caller did not choose is the
 * default nobody can defend.
 */

function configWith(visual: unknown): unknown {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name: "demo",
    baseUrl: "http://127.0.0.1:4311",
    projects: ["chromium"],
    evidence: {
      trace: "on-first-retry",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    },
    thresholds: {
      maxFailureRate: 0.05,
      maxAttemptsPerTest: 2,
      maxDurationMs: 900000,
    },
    defects: {
      directory: "artifacts/defects",
      writeSummary: true,
      referenceErrorContext: true,
    },
    visual,
    tags: ["demo"],
  };
}

const DECLARED = {
  project: "chromium",
  directory: "tests/visual-baselines",
  pages: ["/"],
};

function problemsFor(visual: unknown): string[] {
  try {
    parseConfig(configWith(visual), "config/project.json");
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

test.describe("visual.observedImages", () => {
  test("is optional, and a project without it stores nothing", () => {
    const config = parseConfig(configWith(DECLARED));

    expect(config.visual?.observedImages).toBeUndefined();
  });

  test("declaring the block is the whole opt-in, and keep is required", () => {
    const config = parseConfig(configWith({ ...DECLARED, observedImages: { keep: 3 } }));

    expect(config.visual?.observedImages).toEqual({ keep: 3 });
  });

  test("a block without keep is refused, rather than defaulted", () => {
    expect(problemsFor({ ...DECLARED, observedImages: {} }).join("; ")).toContain(
      "must be a number, got undefined",
    );
  });

  test("keep must be a number", () => {
    expect(problemsFor({ ...DECLARED, observedImages: { keep: "3" } }).join("; ")).toContain(
      "visual.observedImages.keep must be a number, got",
    );
  });

  test("keep must be a whole number of runs", () => {
    // A fractional keep would silently round, and the root would then hold a
    // number nobody chose.
    expect(problemsFor({ ...DECLARED, observedImages: { keep: 2.5 } }).join("; ")).toContain(
      "visual.observedImages.keep must be a whole number, got 2.5",
    );
  });

  test("keep of zero is refused, because keeping nothing is not a store", () => {
    // Zero is the spelling of "keep no runs", which contradicts the declaration
    // it lives in. Turning the feature off is done by removing the block.
    expect(problemsFor({ ...DECLARED, observedImages: { keep: 0 } }).join("; ")).toContain(
      "visual.observedImages.keep must be between 1 and 100000, got 0",
    );
  });

  test("unknown keys inside the block are refused", () => {
    expect(
      problemsFor({ ...DECLARED, observedImages: { keep: 2, directory: "x" } }).join("; "),
    ).toContain('unknown key "visual.observedImages.directory"');
  });

  test("a value that is not an object is refused", () => {
    expect(problemsFor({ ...DECLARED, observedImages: true }).join("; ")).toContain(
      "visual.observedImages must be an object, got",
    );
  });

  test("none of this widens what the visual block itself accepts", () => {
    expect(problemsFor({ ...DECLARED, enabled: true }).join("; ")).toContain(
      'unknown key "visual.enabled"',
    );
  });
});
