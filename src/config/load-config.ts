/**
 * Configuration loader with explicit validation.
 *
 * Deliberately hand-written rather than schema-driven. The configuration is a
 * closed shape of about a dozen fields that a human edits by hand, and a
 * hand-written validator produces messages like
 * "thresholds.maxFailureRate must be a number between 0 and 1, got \"high\""
 * instead of a JSON-pointer path into a validator's internals. That difference
 * matters for the only person who will ever read this error.
 *
 * There is no .yaml support on purpose: parsing YAML needs a dependency, and the
 * project has none. config/project.json keeps the config in the same format as
 * the artifacts it describes.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describeValue as describe } from "../describe-value.js";
import { KEBAB_ID } from "../id-pattern.js";
import { checkFieldPath } from "./field-path.js";
import { CONFIG_SCHEMA_VERSION, HTTP_METHODS, type ProjectConfig } from "./types.js";

const TRACE_VALUES = ["on", "off", "on-first-retry", "retain-on-failure"] as const;
const SCREENSHOT_VALUES = ["on", "off", "only-on-failure"] as const;
const VIDEO_VALUES = ["on", "off", "on-first-retry", "retain-on-failure"] as const;

/** Thrown when configuration is missing, malformed or out of range. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly problems: string[];

  constructor(message: string, problems: string[] = [], options?: ErrorOptions) {
    super(problems.length > 0 ? `${message}\n  - ${problems.join("\n  - ")}` : message, options);
    this.problems = problems;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuse a key this configuration does not define.
 *
 * Measured before this existed, 2026-10-18: `nonsenseKey` at the top level,
 * `evidence.nonsense` and `thresholds.extraKey` were **all accepted**, because
 * nothing here ever asked which keys were present. Values the schema does know were
 * checked strictly, so the validator was strict about what it understood and silent
 * about everything else.
 *
 * That is fail-open, and #44 is what made it matter: the shared-policy feature
 * introduces a key (`extends`) whose typo would otherwise **silently disable
 * inheritance** — both projects would believe they share a policy while reading
 * none of it. A validator that cannot fail on a key it does not know cannot hold up
 * a feature whose whole point is that one key must be right.
 *
 * The message names the offending key and suggests the nearest known one, because a
 * typo is nearly always a transposition, a hyphen instead of an underscore, or a
 * camelCase spelling of a kebab-case name.
 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: string[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (known.has(key)) continue;
    const where = path === "" ? key : `${path}.${key}`;
    const near = closestKey(key, allowed);
    problems.push(
      `unknown key ${JSON.stringify(where)}` +
        (near === undefined
          ? `; known keys here are ${allowed.join(", ")}`
          : `; did you mean ${JSON.stringify(path === "" ? near : `${path}.${near}`)}?`),
    );
  }
}

/** The known key nearest to an unknown one, when one is close enough to suggest. */
function closestKey(key: string, allowed: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Two edits is a suggestion; more than that is a coincidence.
  return bestDistance <= 2 ? best : undefined;
}

/** Levenshtein distance, small inputs only — a dozen keys, not a corpus. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1]!
          : 1 + Math.min(previous[j - 1]!, previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  return previous[b.length]!;
}

function requireString(
  value: unknown,
  path: string,
  problems: string[],
  { nonEmpty = true }: { nonEmpty?: boolean } = {},
): void {
  if (typeof value !== "string") {
    problems.push(`${path} must be a string, got ${describe(value)}`);
    return;
  }
  if (nonEmpty && value.trim() === "") {
    problems.push(`${path} must not be empty`);
  }
}

function requireOneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  problems: string[],
): void {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    problems.push(`${path} must be one of ${allowed.join(" | ")}, got ${describe(value)}`);
  }
}

function requireNumberInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  problems: string[],
): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    problems.push(`${path} must be a number, got ${describe(value)}`);
    return;
  }
  if (value < min || value > max) {
    problems.push(`${path} must be between ${min} and ${max}, got ${value}`);
  }
}

function requireStringArray(value: unknown, path: string, problems: string[]): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    problems.push(`${path} must be an array of strings, got ${describe(value)}`);
  }
}

function requireBoolean(value: unknown, path: string, problems: string[]): void {
  if (typeof value !== "boolean") {
    problems.push(`${path} must be true or false, got ${describe(value)}`);
  }
}

/**
 * Validate the declared API contracts.
 *
 * Two rules here are about preventing a configuration that *cannot fail*:
 *
 * - **An expectation must assert something.** A record with a method and a path
 *   but no `status`, no `contentType` and no required field would be satisfied by
 *   any exchange at all, so it would read as a contract while checking nothing.
 * - **Names must be unique.** They become artifact ids, and the collector
 *   already refuses two defects sharing one rather than writing both.
 */
function checkExpectations(list: unknown[], problems: string[]): void {
  const seen = new Set<string>();

  list.forEach((entry, at) => {
    const where = `api.expectations[${at}]`;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object, got ${describe(entry)}`);
      return;
    }

    requireString(entry.name, `${where}.name`, problems);
    if (typeof entry.name === "string") {
      if (!KEBAB_ID.test(entry.name)) {
        problems.push(
          `${where}.name must be lowercase kebab-case (pattern ${KEBAB_ID.source}), ` +
            `got ${JSON.stringify(entry.name)}`,
        );
      } else if (seen.has(entry.name)) {
        problems.push(
          `${where}.name is ${JSON.stringify(entry.name)}, already used by an earlier expectation`,
        );
      } else {
        seen.add(entry.name);
      }
    }

    requireOneOf(entry.method, `${where}.method`, HTTP_METHODS, problems);

    requireString(entry.path, `${where}.path`, problems);
    if (typeof entry.path === "string") {
      if (!entry.path.startsWith("/")) {
        problems.push(`${where}.path must begin with "/", got ${JSON.stringify(entry.path)}`);
      } else if (entry.path.includes("?") || entry.path.includes("#")) {
        problems.push(
          `${where}.path must not carry a query string or fragment, ` +
            `got ${JSON.stringify(entry.path)}`,
        );
      } else if (entry.path.includes("..")) {
        problems.push(`${where}.path must not contain "..", got ${JSON.stringify(entry.path)}`);
      }
    }

    if (entry.status !== undefined) {
      requireNumberInRange(entry.status, `${where}.status`, 100, 599, problems);
      if (typeof entry.status === "number" && !Number.isInteger(entry.status)) {
        problems.push(`${where}.status must be a whole number, got ${entry.status}`);
      }
    }

    if (entry.contentType !== undefined) {
      requireString(entry.contentType, `${where}.contentType`, problems);
      if (typeof entry.contentType === "string" && entry.contentType.includes(";")) {
        problems.push(
          `${where}.contentType must be a media type without parameters — ` +
            `"application/json; charset=utf-8" is what a response carries, the contract names ` +
            `"application/json" — got ${JSON.stringify(entry.contentType)}`,
        );
      }
    }

    for (const key of ["requestRequires", "responseRequires"] as const) {
      if (entry[key] === undefined) {
        continue;
      }
      if (!Array.isArray(entry[key])) {
        problems.push(
          `${where}.${key} must be an array of field paths, got ${describe(entry[key])}`,
        );
        continue;
      }
      (entry[key] as unknown[]).forEach((field, position) => {
        if (typeof field !== "string") {
          problems.push(`${where}.${key}[${position}] must be a string, got ${describe(field)}`);
          return;
        }
        const problem = checkFieldPath(field, `${where}.${key}[${position}]`);
        if (problem !== null) {
          problems.push(problem);
        }
      });
    }

    // A record that asserts nothing is a contract that cannot fail: any exchange
    // at that path satisfies it, so it would sit in the configuration looking like
    // coverage while checking nothing.
    const assertsSomething =
      entry.status !== undefined ||
      entry.contentType !== undefined ||
      Array.isArray(entry.requestRequires) ||
      Array.isArray(entry.responseRequires);
    if (!assertsSomething) {
      problems.push(
        `${where} asserts nothing: no status, no contentType and no required field, so any ` +
          `exchange at that path would satisfy it`,
      );
    }
  });
}

/** Validate a parsed JSON value as a ProjectConfig. Throws ConfigError on any problem. */
export function parseConfig(raw: unknown, source = "<inline>"): ProjectConfig {
  const problems: string[] = [];

  if (!isRecord(raw)) {
    throw new ConfigError(`${source} must contain a JSON object, got ${describe(raw)}`);
  }

  // Every level, not just the root: a typo three objects deep is the same mistake as
  // one at the top, and the third one is the hardest to notice. `extends` is named
  // here so this call is not revisited when phase 2 adds it.
  rejectUnknownKeys(
    raw,
    [
      "schemaVersion",
      "name",
      "baseUrl",
      "projects",
      "evidence",
      "thresholds",
      "defects",
      "history",
      "api",
      "tags",
      "extends",
    ],
    "",
    problems,
  );

  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be "${CONFIG_SCHEMA_VERSION}", got ${describe(raw.schemaVersion)}`,
    );
  }

  requireString(raw.name, "name", problems);
  requireString(raw.baseUrl, "baseUrl", problems);

  if (typeof raw.baseUrl === "string" && raw.baseUrl !== "") {
    try {
      const url = new URL(raw.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        problems.push(`baseUrl must use http or https, got ${url.protocol}`);
      }
      if (url.search !== "" || url.username !== "" || url.password !== "") {
        // A baseUrl with credentials or a query string would end up in artifacts.
        problems.push("baseUrl must not contain credentials, a query string or a fragment");
      }
    } catch {
      problems.push(`baseUrl must be an absolute URL, got ${describe(raw.baseUrl)}`);
    }
  }

  requireStringArray(raw.projects, "projects", problems);

  if (!isRecord(raw.evidence)) {
    problems.push("evidence must be an object");
  } else {
    rejectUnknownKeys(raw.evidence, ["trace", "screenshot", "video"], "evidence", problems);
    requireOneOf(raw.evidence.trace, "evidence.trace", TRACE_VALUES, problems);
    requireOneOf(raw.evidence.screenshot, "evidence.screenshot", SCREENSHOT_VALUES, problems);
    requireOneOf(raw.evidence.video, "evidence.video", VIDEO_VALUES, problems);
  }

  if (!isRecord(raw.thresholds)) {
    problems.push("thresholds must be an object");
  } else {
    rejectUnknownKeys(
      raw.thresholds,
      ["maxFailureRate", "maxAttemptsPerTest", "maxDurationMs"],
      "thresholds",
      problems,
    );
    requireNumberInRange(
      raw.thresholds.maxFailureRate,
      "thresholds.maxFailureRate",
      0,
      1,
      problems,
    );
    requireNumberInRange(
      raw.thresholds.maxAttemptsPerTest,
      "thresholds.maxAttemptsPerTest",
      1,
      Number.MAX_SAFE_INTEGER,
      problems,
    );
    requireNumberInRange(
      raw.thresholds.maxDurationMs,
      "thresholds.maxDurationMs",
      1,
      Number.MAX_SAFE_INTEGER,
      problems,
    );
  }

  if (!isRecord(raw.defects)) {
    problems.push("defects must be an object");
  } else {
    requireString(raw.defects.directory, "defects.directory", problems);
    rejectUnknownKeys(
      raw.defects,
      ["directory", "writeSummary", "referenceErrorContext"],
      "defects",
      problems,
    );
    requireBoolean(raw.defects.writeSummary, "defects.writeSummary", problems);
    requireBoolean(raw.defects.referenceErrorContext, "defects.referenceErrorContext", problems);
  }

  // Optional, and validated when present rather than required. A repository that
  // has not opted in should not be forced to invent a directory for a feature it
  // is not using, and a missing key is not a mistake worth an error.
  if (raw.history !== undefined) {
    if (!isRecord(raw.history)) {
      problems.push("history must be an object");
    } else {
      requireString(raw.history.directory, "history.directory", problems);
      rejectUnknownKeys(raw.history, ["directory", "keep"], "history", problems);
      requireNumberInRange(raw.history.keep, "history.keep", 1, 100000, problems);
      // Whole runs only. A fractional keep would silently round, and the directory
      // would then hold a number nobody chose.
      if (typeof raw.history.keep === "number" && !Number.isInteger(raw.history.keep)) {
        problems.push(`history.keep must be a whole number, got ${raw.history.keep}`);
      }
    }
  }

  // Optional, and validated when present rather than required, for the same
  // reason as `history`.
  if (raw.api !== undefined) {
    if (!isRecord(raw.api)) {
      problems.push("api must be an object");
    } else {
      rejectUnknownKeys(raw.api, ["directory", "expectations"], "api", problems);
      if (raw.api.directory !== undefined) {
        requireString(raw.api.directory, "api.directory", problems);
      }
    }
    if (isRecord(raw.api) && raw.api.expectations !== undefined) {
      const list = raw.api.expectations;
      if (!Array.isArray(list)) {
        problems.push(`api.expectations must be an array, got ${describe(list)}`);
      } else {
        checkExpectations(list, problems);
      }
    }
  }

  requireStringArray(raw.tags, "tags", problems);

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration in ${source}`, problems);
  }

  return raw as unknown as ProjectConfig;
}

/**
 * Load and validate config/project.json.
 *
 * @param projectRoot Directory to resolve the default path against.
 * @param configPath  Optional explicit path, overriding the default.
 */
export async function loadConfig(projectRoot: string, configPath?: string): Promise<ProjectConfig> {
  const target = configPath ?? path.join(projectRoot, "config", "project.json");
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read configuration at ${target}`, [], { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Configuration at ${target} is not valid JSON`, [], {
      cause: error,
    });
  }

  return parseConfig(parsed, target);
}
