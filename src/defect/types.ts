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

/**
 * 1.1.0 added the optional `signals` block. Per the versioning rule in
 * docs/defect-schema.md, an additive optional field is a minor bump: the file
 * suffix stays `v1`, and a 1.0.0 reader keeps working because it ignores
 * unknown fields.
 *
 * 1.2.0 adds two more optional fields, `page` and `context.targetSource`. Both
 * are new keys with new meanings and no existing key changed, so the bump is
 * minor again for the same reason. Nothing was removed, renamed, retyped or
 * given a new sense.
 */
export const DEFECT_SCHEMA_VERSION = "1.3.0" as const;

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

/**
 * The page the failure happened on, as it was at that moment.
 *
 * `error-context.md`, which this contract extends by reference, carries no URL,
 * and the assertion message usually carries only a locator. On the bundled demo
 * app, origin plus test title reconstructs the page because it has three routes;
 * a real application has hundreds.
 *
 * The URL is redacted exactly as captured signal URLs are: scheme, host, port
 * and path, no query string, no fragment, no credentials.
 */
export interface DefectPage {
  url: string;
  title?: string;
}

/** Where the assertion lives, which is usually not where the test failed. */
export interface DefectLocation {
  file: string;
  line: number;
  column?: number;
}

/**
 * Where the failure was raised, as far as the report shows.
 *
 * This says **where the error came from**, not whose fault it is. A collector
 * cannot decide whether a failure is the application's, the environment's or the
 * suite's — that needs judgement the report does not contain, and writing a
 * value it cannot justify would be a guess dressed up as a verdict. So the
 * vocabulary is limited to what source locations actually prove:
 *
 * - `suite` — raised outside this spec's own body. Proven two ways: the error's
 *   source location is in a different file, or it is at a line *before* this
 *   spec's declaration. A `beforeEach`, a file-level fixture, or a helper
 *   declared above the test all land here, and none of them is a defect in the
 *   test body.
 * - `unknown` — the runner reported no source location at all, so nothing can be
 *   said in either direction.
 *
 * Absent means the error was raised at or after this spec's own declaration in
 * its own file, which is the ordinary case and carries no information. It is not
 * a claim that the error was raised in the body: an error thrown by a helper
 * defined *below* the test also lands here, because "not provably above" is all a
 * line number can establish.
 *
 * Where a whole file failed on one identical error, no artifact is written at
 * all and this field has nothing to say — see `counts.aborted` on the run
 * summary.
 */
/**
 * Where a failure was raised, as far as the report shows.
 *
 * Not whose fault it is — no producer can decide that.
 *
 * - `suite` — raised in a **different file** from the spec, so outside its body by
 *   definition. A shared helper module, or a fixture another spec file owns.
 * - `hook` — raised in this spec's own file, but at or above the line where the
 *   spec is declared, which a test body cannot do. A `beforeAll` that throws is the
 *   measured case.
 * - `unknown` — no location at all.
 *
 * `hook` is separated from `suite` because the two need different things from a
 * reader. A `suite` failure points at code the reader does not own. A `hook`
 * failure points at a line in the reader's own file, above their test, which is
 * where a `beforeAll` or a `describe`-level fixture lives — so the first place to
 * look is that hook, not the test.
 *
 * Both mean "not a defect in this test". Neither is a verdict on blame.
 */
export type FailureAttribution = "suite" | "hook" | "unknown";

export interface DefectFailure {
  message: string;
  location?: DefectLocation;
  snippet?: string;
  stack?: string;
  /** Relative path to Playwright's error-context.md, when it was captured. */
  errorContextRef?: string;
  /**
   * Size of the referenced file in bytes, when it was read.
   *
   * The artifact points at `error-context.md` rather than embedding it, which is
   * the right design — but it means a consumer has no idea whether it is about to
   * read three kilobytes or thirty before deciding to open it. Measured: about 3 KB
   * against this project's fixture, and 34 KB for an ariaSnapshot of a mainstream
   * site. An artifact is read by a language model, so the number belongs here
   * rather than in the reader's judgement after the fact.
   */
  errorContextBytes?: number;
  /** Absent for the ordinary case; see {@link FailureAttribution}. */
  attribution?: FailureAttribution;
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
 * Where `baseUrl` came from.
 *
 * Recorded because `baseUrl` alone is ambiguous: the configured value is not
 * necessarily the application the browser was on. A consumer grouping defects by
 * origin needs to know whether it is reading the configured target or the
 * effective one before it trusts the grouping.
 *
 * - `environment` — `BASE_URL`, which is what the runner was pointed at.
 * - `report` — `webServer.url` from the Playwright report, the runner's own view.
 * - `config` — `config/project.json`, the fallback when nothing said otherwise.
 */
/**
 * Which input the recorded `baseUrl` came from.
 *
 * - `environment` — `BASE_URL`, which is the value the runner's config reads.
 * - `report` — `webServer.url` from the report.
 * - `config` — `config/project.json`.
 * - `observed` — the page the browser was actually on, recorded because it
 *   **disagreed** with every configured candidate. Added in 1.3.0; a run whose
 *   inputs agree is unaffected and keeps its configured source.
 */
export type TargetSource = "environment" | "report" | "config" | "observed";

/**
 * Run context. Excludes anything secret by construction: no environment values,
 * no credentials. `baseUrl` is reduced to an origin before it gets here.
 */
export interface DefectContext {
  baseUrl?: string;
  /** Which input `baseUrl` was taken from. Absent only when there was none. */
  targetSource?: TargetSource;
  commit?: string | null;
  branch?: string | null;
  ci?: boolean;
  retries?: number;
  runStartedAt?: string;
  durationMs?: number;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  /** Host the entry came from; absent when no usable URL was available. */
  origin?: string;
  location?: { url: string; line: number; column: number };
}

export interface RequestFailureEntry {
  method: string;
  url: string;
  /** Host the failure came from. */
  origin?: string;
  resourceType?: string;
  failure?: string | null;
}

export interface HttpErrorEntry {
  method: string;
  url: string;
  /** Host the response came from. */
  origin?: string;
  status: number;
  statusText?: string;
}

/**
 * Console, uncaught-error and network evidence captured while the test ran.
 *
 * Every array is optional and may be empty. The whole block is absent when the
 * test drove no page or captured nothing, which is why it is optional rather
 * than an empty object: an absent field means "not observed", an empty array
 * means "observed, nothing found", and the two should not be confused.
 *
 * Values arrive already redacted. URLs keep scheme, host and path; query
 * strings, fragments and credentials are removed at capture time.
 */
export interface DefectSignals {
  consoleErrors?: ConsoleEntry[];
  consoleWarnings?: ConsoleEntry[];
  pageErrors?: string[];
  requestFailures?: RequestFailureEntry[];
  httpErrors?: HttpErrorEntry[];
  /** Entries that hit the per-category cap, so a truncated capture is visible. */
  dropped?: number;
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
  /** The page under test when it failed. Absent when no page was driven. */
  page?: DefectPage;
  retryHistory?: RetryEntry[];
  flakiness: DefectFlakiness;
  signals?: DefectSignals;
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
  } else {
    if (typeof value.failure.message !== "string") {
      problems.push("failure.message must be a string");
    }
    const attribution = value.failure.attribution;
    if (attribution !== undefined) {
      const allowed: FailureAttribution[] = ["suite", "hook", "unknown"];
      if (!allowed.includes(attribution as FailureAttribution)) {
        problems.push(
          `failure.attribution must be one of ${allowed.join(" | ")}, got ${JSON.stringify(attribution)}`,
        );
      }
    }
  }

  if (!isRecord(value.evidence)) {
    problems.push("evidence must be an object");
  }

  if (!isRecord(value.context)) {
    problems.push("context must be an object");
  } else {
    const source = value.context.targetSource;
    if (source !== undefined) {
      const allowed: TargetSource[] = ["environment", "report", "config", "observed"];
      if (!allowed.includes(source as TargetSource)) {
        problems.push(
          `context.targetSource must be one of ${allowed.join(" | ")}, got ${JSON.stringify(source)}`,
        );
      }
    }
  }

  if (value.page !== undefined) {
    if (!isRecord(value.page)) {
      problems.push("page must be an object when present");
    } else if (typeof value.page.url !== "string" || value.page.url === "") {
      problems.push("page.url must be a non-empty string when page is present");
    } else if (value.page.title !== undefined && typeof value.page.title !== "string") {
      problems.push("page.title must be a string when present");
    }
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

  if (value.signals !== undefined) {
    if (!isRecord(value.signals)) {
      problems.push("signals must be an object when present");
    } else {
      for (const field of [
        "consoleErrors",
        "consoleWarnings",
        "pageErrors",
        "requestFailures",
        "httpErrors",
      ]) {
        const entries = value.signals[field];
        if (entries !== undefined && !Array.isArray(entries)) {
          problems.push(`signals.${field} must be an array when present`);
        }
      }
      const dropped = value.signals.dropped;
      if (
        dropped !== undefined &&
        (typeof dropped !== "number" || !Number.isInteger(dropped) || dropped < 0)
      ) {
        problems.push("signals.dropped must be a non-negative integer when present");
      }
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
