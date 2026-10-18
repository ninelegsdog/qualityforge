/**
 * One run's verdict on the transfer budgets a project declared.
 *
 * ## The design rule
 *
 * **A budget is not a defect, and it is not a field on `defect.v1`.** A defect exists
 * because a test failed; a budget can be exceeded while every test stays green — that
 * is the entire reason the dimension exists — and binding the two would make every
 * measurement look like a failure.
 *
 * What this artifact is instead: **one number per page, the limit it was held to,
 * and whether it held** — plus what it would take to move it.
 */

import type { PerfCapturePayload } from "./observe.js";
import { describeValue as describe } from "../describe-value.js";

/** The version a capture attachment carries. Belongs here, beside the audit version. */
export const PERF_CAPTURE_SCHEMA_VERSION = "1.0.0" as const;

export const PERF_AUDIT_SCHEMA_VERSION = "1.0.0" as const;

/**
 * The file name a run's audit is written under.
 *
 * Beside the version it names, because a reader — the MCP server included — has to
 * name the file to find it, and two places spelling it differently would be two
 * readers looking in two directories. Same reasoning as `API_AUDIT_FILE_NAME`.
 */
export const PERF_AUDIT_FILE_NAME = "perf-audit.v1.json";

/**
 * What can be wrong with a transfer budget, in a closed vocabulary.
 *
 * `no-observation` is the fail-closed one, on the owner's principle from the API
 * dimension: a page nobody measured has not passed a budget it was never held to.
 * The rest are facts a reader would otherwise have to infer from a count.
 */
export const PERF_VIOLATION_KINDS = ["over-budget", "no-observation", "unmeasurable"] as const;

export type PerfViolationKind = (typeof PERF_VIOLATION_KINDS)[number];

export interface PerfViolation {
  kind: PerfViolationKind;
  /** What the configuration allowed, as a reader would state it. */
  expected: string;
  /** What was measured, as a reader would state it. */
  observed: string;
  /** How many times this was seen. */
  observations: number;
  /** Tests in which it was seen. */
  tests: number;
}

export interface PerfBudgetResult {
  /** The declared path, as written in the configuration. */
  path: string;
  /** The declared limit in bytes. */
  budgetBytes: number;
  /** Largest measurement for this path, or `null` when nothing was measured. */
  measuredBytes: number | null;
  observations: number;
  tests: number;
  violations: PerfViolation[];
}

export interface PerfAuditCounts {
  /** Declared budgets, whatever they observed. */
  budgets: number;
  /** Tests whose capture was read. */
  tests: number;
  /** Distinct page paths measured. */
  pages: number;
  /** Budgets with no violation. */
  passed: number;
  violations: number;
}

export interface PerfAudit {
  schemaVersion: typeof PERF_AUDIT_SCHEMA_VERSION;
  createdAt: string;
  /** Origin, or absent. Never a path or a query string: those carry tokens. */
  baseUrl?: string;
  counts: PerfAuditCounts;
  budgets: PerfBudgetResult[];
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed artifact against `perf-audit.v1`.
 *
 * Two rules here are the ones a JSON Schema cannot state:
 *
 * - `counts.violations` equals the number listed. A consumer that trusts the count
 *   rather than the array would judge severity from a number nothing maintains.
 * - Budget paths are unique. `uniqueItems` compares whole objects, and two results
 *   differing only in their measurements would satisfy it.
 *
 * @param value The parsed artifact.
 * @returns Whether it is valid, and every problem found — not just the first.
 */
export function validatePerfAudit(value: unknown): ValidationResult {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, problems: ["an audit must be a JSON object"] };
  }

  if (value.schemaVersion !== PERF_AUDIT_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be "${PERF_AUDIT_SCHEMA_VERSION}", got ${describe(value.schemaVersion)}`,
    );
  }

  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") {
    problems.push(`baseUrl must be a string, got ${describe(value.baseUrl)}`);
  }

  if (!isRecord(value.counts)) {
    problems.push("counts must be an object");
  }

  if (!Array.isArray(value.budgets)) {
    problems.push("budgets must be an array");
    return { valid: false, problems };
  }

  const seen = new Set<string>();
  let listed = 0;
  value.budgets.forEach((entry, index) => {
    const where = `budgets[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    if (typeof entry.path !== "string" || entry.path === "") {
      problems.push(`${where}.path must be a non-empty string`);
    } else if (seen.has(entry.path)) {
      problems.push(`${where}.path ${JSON.stringify(entry.path)} is declared twice`);
    } else {
      seen.add(entry.path);
    }
    if (typeof entry.budgetBytes !== "number" || !Number.isInteger(entry.budgetBytes)) {
      problems.push(
        `${where}.budgetBytes must be a whole number, got ${describe(entry.budgetBytes)}`,
      );
    }
    if (entry.measuredBytes !== null && typeof entry.measuredBytes !== "number") {
      problems.push(
        `${where}.measuredBytes must be a number or null, got ${describe(entry.measuredBytes)}`,
      );
    }
    if (!Array.isArray(entry.violations)) {
      problems.push(`${where}.violations must be an array`);
      return;
    }
    for (const violation of entry.violations) {
      if (!isRecord(violation)) {
        problems.push(`${where}.violations must hold objects`);
        continue;
      }
      if (!(PERF_VIOLATION_KINDS as readonly string[]).includes(String(violation.kind))) {
        problems.push(
          `${where}.violations[].kind must be one of ${PERF_VIOLATION_KINDS.join(" | ")}, got ${describe(violation.kind)}`,
        );
      }
      if (typeof violation.expected !== "string" || typeof violation.observed !== "string") {
        problems.push(
          `${where}.violations[] must state what was expected and observed, as strings`,
        );
      }
      listed += 1;
    }
  });

  if (isRecord(value.counts) && typeof value.counts.violations === "number") {
    if (value.counts.violations !== listed) {
      problems.push(
        `counts.violations says ${value.counts.violations} but ${listed} violation(s) are listed`,
      );
    }
  }

  return { valid: problems.length === 0, problems };
}

export type { PerfCapturePayload };
