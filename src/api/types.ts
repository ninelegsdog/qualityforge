/**
 * The `api-audit.v1` contract.
 *
 * A run-level artifact: what the project's **declared API contracts** did during
 * the run, and where they did not hold. Deliberately its own contract and not
 * fields on `defect.v1`, by the owner's decision of 2026-10-16 — an assertion
 * about what an application sends and receives is a different claim, with a
 * different owner, than a test's failure.
 *
 * Two shapes here are worth naming:
 *
 * - **There is no gate.** The artifact is evidence; the quality gate is a
 *   run-level verdict and belongs to the run summary, which already has one. A
 *   second gate would be a second place for two verdicts to disagree.
 * - **Exchanges are not stored.** An artifact is read by a language model, and a
 *   list of successful exchanges is evidence about nothing. What is kept is the
 *   violations, each saying what was expected and what was observed. The
 *   accessibility audit reached the same conclusion by a different road: it caps
 *   nodes and records the cap rather than the payload.
 *
 * The JSON Schema lives at `schemas/api-audit.v1.schema.json`. The types below
 * are the runtime mirror of it.
 */

import { describeValue as show } from "../describe-value.js";

export const API_AUDIT_SCHEMA_VERSION = "1.0.0" as const;

/**
 * What went wrong, in a closed vocabulary.
 *
 * `no-exchange` and `exchanges-dropped` are the fail-closed pair: both mean the
 * verdict is not "this contract held". The first is the owner's decision of
 * 2026-10-16 — an expectation nothing matched is a violation, not an absence.
 * The second exists because a capture that examined 40 of 50 exchanges has not
 * proved the other 10, and a verdict that ignored that would be a claim about
 * traffic nobody looked at.
 */
export const API_VIOLATION_KINDS = [
  "no-exchange",
  "exchanges-dropped",
  "status",
  "content-type",
  "missing-request-field",
  "missing-response-field",
] as const;

export type ApiViolationKind = (typeof API_VIOLATION_KINDS)[number];

export interface ApiViolation {
  kind: ApiViolationKind;
  /** What the configuration declared, as a reader would state it. */
  expected: string;
  /** What was actually seen, as a reader would state it. */
  observed: string;
  /** Matching exchanges that showed this. */
  exchanges: number;
  /** Tests in which this was seen. */
  tests: number;
}

/** The assertions a single expectation was judged against, as declared. */
export interface ApiDeclaredExpectation {
  status?: number;
  contentType?: string;
  requestRequires?: string[];
  responseRequires?: string[];
}

/** What was seen for one declared expectation, across the whole run. */
export interface ApiObserved {
  /** Matching exchanges, summed over every test that ran. */
  exchanges: number;
  /** Exchanges the capture's cap refused to keep, summed the same way. */
  dropped: number;
  /** Tests that carried this expectation. */
  tests: number;
}

export interface ApiExpectationResult {
  name: string;
  method: string;
  path: string;
  declared: ApiDeclaredExpectation;
  observed: ApiObserved;
  /** Deduplicated: one entry per distinct way the contract did not hold. */
  violations: ApiViolation[];
}

export interface ApiAuditCounts {
  /** Declared expectations, whatever they observed. */
  expectations: number;
  /** Tests whose capture was read. */
  tests: number;
  /** Distinct violations across every expectation. */
  violations: number;
  /** Expectation results that hold no violation. */
  passed: number;
}

export interface ApiAudit {
  schemaVersion: typeof API_AUDIT_SCHEMA_VERSION;
  createdAt: string;
  /**
   * Origin under test, reduced to an origin.
   *
   * Optional, and the reason is the same as `defect.v1`'s: an artifact that
   * cannot establish its origin must say so rather than carry a guess. The
   * collector resolves one from `BASE_URL`, the report's `webServer.url` or the
   * configured value, and when none of those exist — a run whose config declares
   * no base URL and whose report declares no server — there is nothing true to
   * write, so the field is absent.
   */
  baseUrl?: string;
  counts: ApiAuditCounts;
  /** Declared order, so a consumer reads this beside `config/project.json`. */
  expectations: ApiExpectationResult[];
}

/** Result of {@link validateApiAudit}. */
export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const KINDS = new Set<string>(API_VIOLATION_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed audit artifact against the v1 contract.
 *
 * Two rules here cannot live in the JSON Schema, so they live here and are
 * pinned by `tests/unit/api-audit-schema.test.ts`:
 *
 * - `counts.violations` equals the number of violations actually listed. A
 *   consumer that trusts the count rather than the array would judge severity
 *   from a number nothing maintains.
 * - Expectation names are unique. `uniqueItems` compares whole objects, and two
 *   results differing only in their observations would satisfy it.
 *
 * @param value The parsed artifact.
 * @returns Whether it is valid, and every problem found — not just the first.
 */
export function validateApiAudit(value: unknown): ValidationResult {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, problems: [`audit must be an object, got ${show(value)}`] };
  }

  if (value.schemaVersion !== API_AUDIT_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be ${JSON.stringify(API_AUDIT_SCHEMA_VERSION)}, got ${show(value.schemaVersion)}`,
    );
  }

  if (typeof value.createdAt !== "string" || !ISO_DATE_TIME.test(value.createdAt)) {
    problems.push(`createdAt must be an ISO 8601 timestamp, got ${show(value.createdAt)}`);
  }

  if (value.baseUrl === undefined) {
    // Checked above as absent rather than required: see the note on the type.
  } else if (typeof value.baseUrl !== "string" || value.baseUrl === "") {
    problems.push(`baseUrl must be a non-empty string, got ${show(value.baseUrl)}`);
  } else {
    // An origin and nothing else. The loader refuses a configured base URL that
    // carries credentials, a query or a fragment, and the artifact must not be
    // able to hold one even if a producer change slipped past that: a query
    // string is exactly where a token rides.
    let origin: URL | undefined;
    try {
      origin = new URL(value.baseUrl);
    } catch {
      problems.push(`baseUrl must be an absolute URL, got ${show(value.baseUrl)}`);
    }
    if (origin !== undefined) {
      if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
        problems.push(
          `baseUrl must be an origin with no path, query string or fragment, got ${show(value.baseUrl)}`,
        );
      }
      if (origin.username !== "" || origin.password !== "") {
        problems.push(`baseUrl must not carry credentials, got ${show(value.baseUrl)}`);
      }
    }
  }

  if (!isRecord(value.counts)) {
    problems.push(`counts must be an object, got ${show(value.counts)}`);
  } else {
    for (const key of ["expectations", "tests", "violations", "passed"] as const) {
      const entry = value.counts[key];
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
        problems.push(`counts.${key} must be a whole number of zero or more, got ${show(entry)}`);
      }
    }
  }

  if (!Array.isArray(value.expectations)) {
    problems.push(`expectations must be an array, got ${show(value.expectations)}`);
    return { valid: problems.length === 0, problems };
  }

  const names = new Set<string>();
  let listed = 0;

  value.expectations.forEach((entry, at) => {
    const where = `expectations[${at}]`;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object, got ${show(entry)}`);
      return;
    }
    if (typeof entry.name !== "string" || entry.name === "") {
      problems.push(`${where}.name must be a non-empty string, got ${show(entry.name)}`);
    } else if (names.has(entry.name)) {
      problems.push(
        `${where}.name is ${JSON.stringify(entry.name)}, already used earlier in the audit`,
      );
    } else {
      names.add(entry.name);
    }
    if (typeof entry.method !== "string" || entry.method === "") {
      problems.push(`${where}.method must be a non-empty string, got ${show(entry.method)}`);
    }
    if (typeof entry.path !== "string" || !entry.path.startsWith("/")) {
      problems.push(`${where}.path must be a string beginning with "/", got ${show(entry.path)}`);
    }
    if (!isRecord(entry.declared)) {
      problems.push(`${where}.declared must be an object, got ${show(entry.declared)}`);
    }
    if (!isRecord(entry.observed)) {
      problems.push(`${where}.observed must be an object, got ${show(entry.observed)}`);
    } else {
      for (const key of ["exchanges", "dropped", "tests"] as const) {
        const figure = entry.observed[key];
        if (typeof figure !== "number" || !Number.isInteger(figure) || figure < 0) {
          problems.push(
            `${where}.observed.${key} must be a whole number of zero or more, got ${show(figure)}`,
          );
        }
      }
    }

    if (!Array.isArray(entry.violations)) {
      problems.push(`${where}.violations must be an array, got ${show(entry.violations)}`);
      return;
    }
    listed += entry.violations.length;

    entry.violations.forEach((violation, position) => {
      const at2 = `${where}.violations[${position}]`;
      if (!isRecord(violation)) {
        problems.push(`${at2} must be an object, got ${show(violation)}`);
        return;
      }
      if (typeof violation.kind !== "string" || !KINDS.has(violation.kind)) {
        problems.push(
          `${at2}.kind must be one of ${API_VIOLATION_KINDS.join(" | ")}, got ${show(violation.kind)}`,
        );
      }
      if (typeof violation.expected !== "string" || violation.expected === "") {
        problems.push(
          `${at2}.expected must be a non-empty string, got ${show(violation.expected)}`,
        );
      }
      if (typeof violation.observed !== "string" || violation.observed === "") {
        problems.push(
          `${at2}.observed must be a non-empty string, got ${show(violation.observed)}`,
        );
      }
      for (const key of ["exchanges", "tests"] as const) {
        const figure = violation[key];
        if (typeof figure !== "number" || !Number.isInteger(figure) || figure < 0) {
          problems.push(
            `${at2}.${key} must be a whole number of zero or more, got ${show(figure)}`,
          );
        }
      }
    });
  });

  // The count and the array are two copies of one fact, and JSON Schema cannot
  // tie a property to the length of a sibling array.
  if (isRecord(value.counts) && typeof value.counts.violations === "number") {
    if (value.counts.violations !== listed) {
      problems.push(
        `counts.violations says ${value.counts.violations} but ${listed} violation(s) are listed`,
      );
    }
  }
  if (isRecord(value.counts) && typeof value.counts.expectations === "number") {
    if (value.counts.expectations !== value.expectations.length) {
      problems.push(
        `counts.expectations says ${value.counts.expectations} but ${value.expectations.length} are listed`,
      );
    }
  }

  return { valid: problems.length === 0, problems };
}
