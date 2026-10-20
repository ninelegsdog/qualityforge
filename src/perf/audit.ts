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

export interface BuildPerfAuditInput {
  /** Every capture read from the run, however many tests produced one. */
  payloads: PerfCapturePayload[];
  /**
   * The declared pages, in configuration order, or omitted to hold every page the
   * run actually loaded.
   *
   * The two modes answer two different questions. A declared page that nobody
   * measured is `no-observation`: the project said the budget held there. With no
   * declaration the budget is a statement about the application, and the pages it
   * holds are the pages that were loaded — inventing absences for routes the project
   * never named would make enabling the dimension look like a failure.
   *
   * Empty is refused rather than treated as "everything": that would give one list
   * two opposite meanings, and the two modes already have spellings.
   */
  paths?: string[];
  /** The declared limit, in bytes, held against each page. */
  maxBytes: number;
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
 * @param input The captures, the declared page list, and the budget.
 * @returns The audit, with one entry per held page.
 */
export function buildPerfAudit(input: BuildPerfAuditInput): PerfAudit {
  const ran = input.payloads.length > 0;

  if (input.paths !== undefined && input.paths.length === 0) {
    throw new Error(
      "perf paths must name at least one page, or be omitted to hold every page the run loaded",
    );
  }

  // First-seen order, so an artifact reads in the order the run visited its pages
  // rather than in whatever order a Set happens to enumerate. The same set is what
  // `counts.pages` reports, so a reader can reconcile the two without opening the
  // payloads.
  const observed = [
    ...new Set(input.payloads.flatMap((payload) => payload.pages.map((page) => page.path))),
  ];
  const paths = input.paths ?? observed;

  const budgets: PerfBudgetResult[] = paths.map((pagePath) => {
    let measuredBytes: number | null = null;
    let observations = 0;
    const tests = new Set<number>();

    input.payloads.forEach((payload, index) => {
      const pages = payload.pages.filter((page) => page.path === pagePath);
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
        expected: `at most ${thousands(input.maxBytes)} bytes`,
        observed: "no page load was measured",
        observations: 0,
        tests: ran ? tests.size : 0,
      });
    } else if (measuredBytes !== null && measuredBytes > input.maxBytes) {
      violations.push({
        kind: "over-budget",
        expected: `at most ${thousands(input.maxBytes)} bytes`,
        // The overage in bytes as well, so a reader can judge whether this is a
        // rounding difference or a different application.
        observed: `${thousands(measuredBytes)} bytes, ${thousands(measuredBytes - input.maxBytes)} over`,
        observations,
        tests: tests.size,
      });
    }

    return {
      path: pagePath,
      budgetBytes: input.maxBytes,
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
      pages: observed.length,
      passed: budgets.filter((budget) => budget.violations.length === 0).length,
      violations,
    },
    budgets,
  };
}

export { PERF_VIOLATION_KINDS };
