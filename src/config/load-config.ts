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
import { CONFIG_SCHEMA_VERSION, type ProjectConfig } from "./types.js";

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

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // No bare String(object): that yields "[object Object]", which tells the
  // reader nothing about what was actually configured.
  return `a ${typeof value}`;
}

/** Validate a parsed JSON value as a ProjectConfig. Throws ConfigError on any problem. */
export function parseConfig(raw: unknown, source = "<inline>"): ProjectConfig {
  const problems: string[] = [];

  if (!isRecord(raw)) {
    throw new ConfigError(`${source} must contain a JSON object, got ${describe(raw)}`);
  }

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
    requireOneOf(raw.evidence.trace, "evidence.trace", TRACE_VALUES, problems);
    requireOneOf(raw.evidence.screenshot, "evidence.screenshot", SCREENSHOT_VALUES, problems);
    requireOneOf(raw.evidence.video, "evidence.video", VIDEO_VALUES, problems);
  }

  if (!isRecord(raw.thresholds)) {
    problems.push("thresholds must be an object");
  } else {
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
      requireNumberInRange(raw.history.keep, "history.keep", 1, 100000, problems);
      // Whole runs only. A fractional keep would silently round, and the directory
      // would then hold a number nobody chose.
      if (typeof raw.history.keep === "number" && !Number.isInteger(raw.history.keep)) {
        problems.push(`history.keep must be a whole number, got ${raw.history.keep}`);
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
