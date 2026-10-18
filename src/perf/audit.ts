/**
 * Turn captured page loads into a verdict against the declared budget.
 *
 * ## What this does not do
 *
 * **It does not average, and it does not trim.** A budget that passes because four
 * loads were small and one was enormous is a budget that has stopped being a budget,
 * so the verdict is taken from the **largest** load seen for a path. Mean, median and
 * percentile are all ways of saying "usually fine", and "usually" is not what a
 * regression looks like.
 *
 * ## What a page nobody measured means
 *
 * `no-observation` is a violation, on the same principle as the API dimension: a
 * budget nothing was held to has not been passed. It is separated from
 * `over-budget` because the reader's next question differs — *did it get heavier, or
 * did nobody look* — and one number cannot answer both.
 */

import {
  PERF_AUDIT_SCHEMA_VERSION,
  PERF_VIOLATION_KINDS,
  type PerfAudit,
  type PerfBudgetResult,
  type PerfViolation,
} from "./types.js";
import type { PerfCapturePayload } from "./observe.js";

/** The declared limit, as a configuration field: bytes per page path. */
export interface PerfBudget {
  /** The page path this budget holds, as written in the configuration. */
  path: string;
  /** Largest transfer allowed, in bytes. */
  maxBytes: number;
}

export interface BuildPerfAuditInput {
  /** Every capture read from the run, however many tests produced one. */
  payloads: PerfCapturePayload[];
  /** The declared budgets, in configuration order. */
  budgets: PerfBudget[];
  /** Origin of the run, recorded and never a path. */
  baseUrl?: string;
  /** Timestamp for the artifact. */
  createdAt: string;
}

function thousands(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Build one run's audit.
 *
 * @param input The captures and the declared budgets.
 * @returns The audit, with one entry per declared budget.
 */
export function buildPerfAudit(input: BuildPerfAuditInput): PerfAudit {
  const ran = input.payloads.length > 0;

  const budgets: PerfBudgetResult[] = input.budgets.map((budget) => {
    let measuredBytes: number | null = null;
    let observations = 0;
    const tests = new Set<number>();

    input.payloads.forEach((payload, index) => {
      const pages = payload.pages.filter((page) => page.path === budget.path);
      if (pages.length === 0) return;
      observations += pages.length;
      tests.add(index);
      for (const page of pages) {
        if (measuredBytes === null || page.transferredBytes > measuredBytes) {
          measuredBytes = page.transferredBytes;
        }
      }
    });

    const violations: PerfViolation[] = [];

    // Fail-closed: a declared budget that nothing was measured against has not been
    // held. Reported as its own kind, because the fix is "visit the page", not
    // "make it lighter".
    if (!ran || observations === 0) {
      violations.push({
        kind: "no-observation",
        expected: `at most ${thousands(budget.maxBytes)} bytes`,
        observed: "no page load was measured",
        observations: 0,
        tests: ran ? tests.size : 0,
      });
    } else if (measuredBytes !== null && measuredBytes > budget.maxBytes) {
      violations.push({
        kind: "over-budget",
        expected: `at most ${thousands(budget.maxBytes)} bytes`,
        // The overage in bytes as well, so a reader can judge whether this is a
        // rounding difference or a different application.
        observed: `${thousands(measuredBytes)} bytes, ${thousands(measuredBytes - budget.maxBytes)} over`,
        observations,
        tests: tests.size,
      });
    }

    return {
      path: budget.path,
      budgetBytes: budget.maxBytes,
      measuredBytes,
      observations,
      tests: tests.size,
      violations,
    };
  });

  const violations = budgets.reduce((total, budget) => total + budget.violations.length, 0);

  return {
    schemaVersion: PERF_AUDIT_SCHEMA_VERSION,
    createdAt: input.createdAt,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    counts: {
      budgets: budgets.length,
      tests: input.payloads.length,
      pages: new Set(input.payloads.flatMap((payload) => payload.pages.map((page) => page.path)))
        .size,
      passed: budgets.filter((budget) => budget.violations.length === 0).length,
      violations,
    },
    budgets,
  };
}

export { PERF_VIOLATION_KINDS };
