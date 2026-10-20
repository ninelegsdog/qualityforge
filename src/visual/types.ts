/**
 * One run's verdict on whether the pages still look like the ones a person approved.
 *
 * ## The design rule
 *
 * **An appearance is not a defect, and it is not a field on `defect.v1`.** A defect
 * exists because a test failed; a page can look wrong while every behavioural
 * assertion holds, which is the whole reason this dimension exists.
 *
 * ## The baseline is the image, not a manifest
 *
 * There is **no manifest of expected hashes.** The baseline is a committed PNG, and
 * its hash is computed from the file every run. A manifest beside the images would
 * be a second copy of the same fact, and two copies of one fact are two things to
 * drift — the failure this repository keeps paying for in tool counts and version
 * numbers.
 *
 * ## Why the verdict is a hash and not a pixel count
 *
 * Measured 2026-10-18 on this repository's own pages: chromium produced
 * **byte-identical** screenshots across five runs in fresh contexts, and firefox
 * produced **two stable states differing by exactly 253 pixels** on three runs of
 * ten. Byte equality is therefore a *real* measurement here, not a convenient
 * approximation — and comparing hashes is **zero tolerance by construction**, which
 * is what the owner's decision of 2026-10-18 asked for. There is no pixel threshold
 * to tune, and therefore no size of change we decided not to look for.
 */

import type { VisualCapturePayload } from "./observe.js";

export const VISUAL_AUDIT_SCHEMA_VERSION = "1.0.0" as const;

/**
 * The file name a run's audit is written under.
 *
 * Beside the version it names, because a reader — the MCP server included — has to
 * name the file to find it, and two places spelling it differently would be two
 * readers looking in two directories. Same reasoning as `PERF_AUDIT_FILE_NAME`.
 */
export const VISUAL_AUDIT_FILE_NAME = "visual-audit.v1.json";

/**
 * What can be wrong with a page's appearance, in a closed vocabulary.
 *
 * `no-baseline` and `no-observation` are the fail-closed pair, on the same principle
 * as every other dimension: an appearance nobody approved is not an approved
 * appearance, and an appearance nobody looked at is not an unchanged one. They are
 * separate kinds because the reader's next question differs — *did it change, did
 * nobody review it, or did nobody look*.
 */
export const VISUAL_VIOLATION_KINDS = [
  "changed",
  "no-baseline",
  "no-observation",
  "unstable",
] as const;

export type VisualViolationKind = (typeof VISUAL_VIOLATION_KINDS)[number];

export interface VisualViolation {
  kind: VisualViolationKind;
  /** What the configuration allowed, as a reader would state it. */
  expected: string;
  /** What was seen, as a reader would state it. */
  observed: string;
  /** How many times this was seen. */
  observations: number;
  /** Tests in which it was seen. */
  tests: number;
}

/** What a committed baseline says about one page. */
/** Viewport of a capture, in CSS pixels and device pixels per CSS pixel. */
export interface VisualViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface VisualBaseline {
  /** SHA-256 of the baseline image, computed from the file rather than stored. */
  sha256: string;
  /**
   * The viewport the baseline was taken at, or `null` when it is not recorded.
   *
   * The producer writes `null`, and did not always: the live external run found it
   * claiming `0×0×0`. A PNG has pixels, not CSS dimensions, and guessing the viewport
   * from the pixels would be a second fact that could disagree with the capture. The
   * capture beside the verdict is where the actual viewport lives; this field says,
   * honestly, that the baseline does not carry one. A future baseline format that does
   * record it can fill the object in.
   */
  viewport: VisualViewport | null;
  /**
   * Where the image lives, relative to the project root.
   *
   * Recorded so a reader can open both pictures rather than read two hashes, which
   * is the whole point of keeping the images at all.
   */
  file: string;
}

export interface VisualPageResult {
  /** The declared path, as written in the configuration. */
  path: string;
  /** SHA-256 of what was captured, or `null` when nothing was captured. */
  sha256: string | null;
  /** Size of the capture in bytes, or `null`. */
  bytes: number | null;
  /** Viewport the capture was taken at, or `null`. */
  viewport: VisualViewport | null;
  /** What the committed baseline says, or `null` when there is none. */
  baseline: VisualBaseline | null;
  observations: number;
  tests: number;
  violations: VisualViolation[];
}

export interface VisualAuditCounts {
  /** Declared pages, whatever they looked like. */
  pages: number;
  /** Tests whose capture was read. */
  tests: number;
  /** Pages whose appearance matched the committed baseline. */
  matched: number;
  /** Pages carrying no baseline — nobody has reviewed them. */
  withoutBaseline: number;
  violations: number;
}

export interface VisualAudit {
  schemaVersion: typeof VISUAL_AUDIT_SCHEMA_VERSION;
  createdAt: string;
  /** Origin, or absent. Never a path or a query string: those carry tokens. */
  baseUrl?: string;
  /**
   * The engine project this run gated on.
   *
   * Recorded because the measurement showed a different engine, viewport or scale
   * produces a different picture of the same page: firefox's screenshot shared no
   * hash with chromium's. A reader who does not know which engine approved a
   * baseline cannot interpret a change to it.
   */
  project?: string;
  counts: VisualAuditCounts;
  pages: VisualPageResult[];
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `a ${typeof value}`;
}

/**
 * Check a viewport, or the honest absence of one.
 *
 * A zero dimension is refused rather than read as "unknown". The producer used to
 * write `0×0×0` beside every baseline because the PNG does not carry a viewport; the
 * live external run showed that a reader can only take those numbers as a real
 * measurement of a page nobody rendered. Unknown is `null`, and the four numbers,
 * when present, have to be ones a browser could actually produce.
 */
function checkViewport(value: unknown, where: string, problems: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object or null, got ${describeValue(value)}`);
    return;
  }
  for (const field of ["width", "height", "deviceScaleFactor"] as const) {
    const number = value[field];
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
      problems.push(
        `${where}.${field} must be a positive number, got ${describeValue(number)}; ` +
          `an unknown viewport is null, not zero`,
      );
    }
  }
}

/**
 * Validate a parsed artifact against `visual-audit.v1`.
 *
 * One rule here is the one a JSON Schema cannot state: `counts.violations` equals the
 * number listed. A consumer that trusts the count rather than the array would judge
 * severity from a number nothing maintains.
 *
 * @param value The parsed artifact.
 * @returns Whether it is valid, and every problem found — not just the first.
 */
export function validateVisualAudit(value: unknown): ValidationResult {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, problems: ["an audit must be a JSON object"] };
  }

  if (value.schemaVersion !== VISUAL_AUDIT_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be "${VISUAL_AUDIT_SCHEMA_VERSION}", got ${describeValue(value.schemaVersion)}`,
    );
  }

  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") {
    problems.push(`baseUrl must be a string, got ${describeValue(value.baseUrl)}`);
  }

  if (!isRecord(value.counts)) {
    problems.push("counts must be an object");
  }

  if (!Array.isArray(value.pages)) {
    problems.push("pages must be an array");
    return { valid: false, problems };
  }

  const seen = new Set<string>();
  let listed = 0;
  value.pages.forEach((entry, index) => {
    const where = `pages[${index}]`;
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
    if (entry.sha256 !== null && typeof entry.sha256 !== "string") {
      problems.push(
        `${where}.sha256 must be a hex string or null, got ${describeValue(entry.sha256)}`,
      );
    }
    checkViewport(entry.viewport, `${where}.viewport`, problems);
    if (entry.baseline !== null) {
      if (!isRecord(entry.baseline)) {
        problems.push(`${where}.baseline must be an object or null`);
      } else {
        checkViewport(entry.baseline.viewport, `${where}.baseline.viewport`, problems);
      }
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
      if (!(VISUAL_VIOLATION_KINDS as readonly string[]).includes(String(violation.kind))) {
        problems.push(
          `${where}.violations[].kind must be one of ${VISUAL_VIOLATION_KINDS.join(" | ")}, got ${describeValue(violation.kind)}`,
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

export type { VisualCapturePayload };
