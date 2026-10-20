import { expect, test } from "@playwright/test";
import { ConfigError, parseConfig } from "../../src/config/load-config.js";
import { CONFIG_SCHEMA_VERSION } from "../../src/config/types.js";

/**
 * `perf.pages`, the list a transfer budget holds.
 *
 * Two rules here prevent a list that cannot mean what its author thought:
 *
 * - **Empty is refused.** Omitting `pages` means "every page the run loaded"; an
 *   empty list would be the same spelling for that and for "no page at all".
 * - **A block without a budget is refused.** `thresholds.maxTransferredBytes` is
 *   what turns the dimension on. Pages named beside no budget would sit in the file
 *   looking like coverage while nothing measured them.
 */

function configWith(perf: unknown, withBudget = true): unknown {
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
      ...(withBudget ? { maxTransferredBytes: 20000 } : {}),
    },
    defects: {
      directory: "artifacts/defects",
      writeSummary: true,
      referenceErrorContext: true,
    },
    perf,
    tags: ["demo"],
  };
}

function problemsFor(perf: unknown, withBudget = true): string[] {
  try {
    parseConfig(configWith(perf, withBudget), "config/project.json");
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

test.describe("perf.pages", () => {
  test("is optional: a budget with no list holds every page the run loads", () => {
    const config = parseConfig(configWith({}));

    expect(config.perf).toEqual({});
    expect(config.thresholds.maxTransferredBytes).toBe(20000);
  });

  test("accepts absolute pages in configuration order", () => {
    const config = parseConfig(configWith({ pages: ["/", "/docs", "/contact"] }));

    expect(config.perf?.pages).toEqual(["/", "/docs", "/contact"]);
  });

  test("refuses an empty list rather than reading it as every page", () => {
    expect(problemsFor({ pages: [] }).join("; ")).toContain("must name at least one page");
  });

  test("refuses a relative page", () => {
    expect(problemsFor({ pages: ["docs"] }).join("; ")).toContain('must begin with "/"');
  });

  test("refuses the same page twice", () => {
    expect(problemsFor({ pages: ["/", "/"] }).join("; ")).toContain("already named by an earlier");
  });

  test("refuses a list that is not an array of strings", () => {
    expect(problemsFor({ pages: "/docs" }).join("; ")).toContain("must be an array of strings");
  });

  test("refuses a page list with no budget to hold it", () => {
    // A page list without `thresholds.maxTransferredBytes` cannot cause a
    // measurement, and a configuration that looks like coverage while doing
    // nothing is the failure mode this validator exists to refuse.
    expect(problemsFor({ pages: ["/"] }, false).join("; ")).toContain(
      "perf is declared but thresholds.maxTransferredBytes is not",
    );
  });

  test("refuses an unknown key in the block", () => {
    expect(problemsFor({ pages: ["/"], path: "/" }).join("; ")).toContain(
      'unknown key "perf.path"',
    );
  });

  test("refuses a block that is not an object", () => {
    expect(problemsFor(["/"]).join("; ")).toContain("perf must be an object");
  });
});
