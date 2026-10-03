/**
 * The defect artifact contract.
 *
 * Design rule: this extends Playwright's `error-context.md`, it does not
 * duplicate it. `error-context.md` already carries the error text, the expected
 * and received values, and a page snapshot, phrased as an instruction to an
 * assistant. What it does not carry is stable identity, run correlation, VCS
 * context, evidence pointers and a flakiness verdict. Those are what live here.
 *
 * The JSON Schema lives at `schemas/defect.v1.schema.json`. The types below are
 * the runtime mirror of it.
 */

export const DEFECT_SCHEMA_VERSION = "1.0.0" as const;

/** Outcome of a single attempt. Mirrors Playwright's status vocabulary. */
export type TestStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

/** Terminal outcome recorded on the defect. `passed` is not one of them. */
export type DefectStatus = Extract<TestStatus, "failed" | "timedOut" | "skipped" | "interrupted">;

/**
 * Flakiness classification.
 *
 * - `flaky` — passed on a retry after failing. The dangerous one.
 * - `failing` — failed on every attempt.
 * - `passedAfterRetry` — passed eventually; recorded for completeness.
 * - `unknown` — a single attempt, no retry configured. Not a failure to classify.
 */
export type FlakinessVerdict = "flaky" | "failing" | "passedAfterRetry" | "unknown";

export interface DefectTest {
  playwrightId?: string;
  title: string;
  file: string;
  line?: number;
  column?: number;
  project?: string;
  tags?: string[];
}

/** Where the assertion lives, which is usually not where the test failed. */
export interface DefectLocation {
  file: string;
  line: number;
  column?: number;
}

export interface DefectFailure {
  message: string;
  location?: DefectLocation;
  snippet?: string;
  stack?: string;
  /** Relative path to Playwright's error-context.md, when it was captured. */
  errorContextRef?: string;
}

/**
 * Evidence pointers. Every field is optional on purpose: a local run with no
 * retry legitimately has no trace, and that must not be an error.
 */
export interface DefectEvidence {
  trace?: string;
  screenshot?: string;
  video?: string;
  snapshot?: string;
  report?: string;
  resultsDir?: string;
}

/**
 * Run context. Excludes anything secret by construction: no environment values,
 * no credentials. `baseUrl` is reduced to an origin before it gets here.
 */
export interface DefectContext {
  baseUrl?: string;
  commit?: string | null;
  branch?: string | null;
  ci?: boolean;
  retries?: number;
  runStartedAt?: string;
  durationMs?: number;
}

export interface RetryEntry {
  attempt: number;
  status: TestStatus;
  durationMs?: number;
  startedAt?: string;
}

export interface DefectFlakiness {
  verdict: FlakinessVerdict;
  attempts?: number;
  passedAttempts?: number;
  failedAttempts?: number;
}

export interface DefectV1 {
  $schema?: string;
  schemaVersion: typeof DEFECT_SCHEMA_VERSION;
  id: string;
  runId: string;
  createdAt: string;
  status: DefectStatus;
  test: DefectTest;
  failure: DefectFailure;
  evidence: DefectEvidence;
  context: DefectContext;
  retryHistory?: RetryEntry[];
  flakiness: DefectFlakiness;
  tags?: string[];
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DEFECT_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCHEMA_VERSION = /^\d+\.\d+\.\d+$/;

/** Result of {@link validateDefect}. */
export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed defect artifact against the v1 contract.
 *
 * Hand-written for the same reason as the config validator: precise messages,
 * no dependency. It checks presence, types and the constraints that actually
 * matter for a consumer; it is not a general JSON Schema implementation.
 */
export function validateDefect(value: unknown): ValidationResult {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, problems: ["artifact must be a JSON object"] };
  }

  if (typeof value.schemaVersion !== "string" || !SCHEMA_VERSION.test(value.schemaVersion)) {
    problems.push(`schemaVersion must be a semver string, got ${String(value.schemaVersion)}`);
  }
  if (typeof value.id !== "string" || !DEFECT_ID.test(value.id)) {
    problems.push(
      `id must be lowercase kebab-case (pattern ${DEFECT_ID.source}), got ${JSON.stringify(value.id)}`,
    );
  }
  if (typeof value.runId !== "string" || value.runId.length === 0) {
    problems.push("runId must be a non-empty string");
  }
  if (typeof value.createdAt !== "string" || !ISO_DATE_TIME.test(value.createdAt)) {
    problems.push(
      `createdAt must be an ISO 8601 date-time, got ${JSON.stringify(value.createdAt)}`,
    );
  }

  const allowedStatus: DefectStatus[] = ["failed", "timedOut", "skipped", "interrupted"];
  if (!allowedStatus.includes(value.status as DefectStatus)) {
    problems.push(
      `status must be one of ${allowedStatus.join(" | ")}, got ${String(value.status)}`,
    );
  }

  if (!isRecord(value.test)) {
    problems.push("test must be an object");
  } else {
    if (typeof value.test.title !== "string" || value.test.title.length === 0) {
      problems.push("test.title must be a non-empty string");
    }
    if (typeof value.test.file !== "string" || value.test.file.length === 0) {
      problems.push("test.file must be a non-empty string");
    }
    if (value.test.line !== undefined && !Number.isInteger(value.test.line)) {
      problems.push("test.line must be an integer when present");
    }
  }

  if (!isRecord(value.failure)) {
    problems.push("failure must be an object");
  } else if (typeof value.failure.message !== "string") {
    problems.push("failure.message must be a string");
  }

  if (!isRecord(value.evidence)) {
    problems.push("evidence must be an object");
  }

  if (!isRecord(value.context)) {
    problems.push("context must be an object");
  }

  if (!isRecord(value.flakiness)) {
    problems.push("flakiness must be an object");
  } else {
    const verdicts: FlakinessVerdict[] = ["flaky", "failing", "passedAfterRetry", "unknown"];
    if (!verdicts.includes(value.flakiness.verdict as FlakinessVerdict)) {
      problems.push(
        `flakiness.verdict must be one of ${verdicts.join(" | ")}, got ${String(value.flakiness.verdict)}`,
      );
    }
  }

  if (value.retryHistory !== undefined) {
    if (!Array.isArray(value.retryHistory)) {
      problems.push("retryHistory must be an array when present");
    } else {
      for (const [i, entry] of value.retryHistory.entries()) {
        if (!isRecord(entry)) {
          problems.push(`retryHistory[${i}] must be an object`);
          continue;
        }
        if (!Number.isInteger(entry.attempt)) {
          problems.push(`retryHistory[${i}].attempt must be an integer`);
        }
        const statuses: TestStatus[] = ["passed", "failed", "timedOut", "skipped", "interrupted"];
        if (!statuses.includes(entry.status as TestStatus)) {
          problems.push(
            `retryHistory[${i}].status must be one of ${statuses.join(" | ")}, got ${String(entry.status)}`,
          );
        }
      }
    }
  }

  return { valid: problems.length === 0, problems };
}

/** Narrowing helper for consumers: throws when the artifact is not valid v1. */
export function assertDefect(value: unknown): DefectV1 {
  const { valid, problems } = validateDefect(value);
  if (!valid) {
    throw new Error(`Invalid defect artifact:\n  - ${problems.join("\n  - ")}`);
  }
  return value as DefectV1;
}
