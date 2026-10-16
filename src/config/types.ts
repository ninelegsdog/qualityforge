/**
 * Project configuration.
 *
 * Shape of `config/project.json`. Kept as the runtime type of the loader and
 * of the collector, so the two cannot drift apart.
 */

export const CONFIG_SCHEMA_VERSION = "1.0.0" as const;

/** Evidence capture policy, per signal. */
export interface EvidenceConfig {
  /**
   * Playwright's `trace` option for the project under test.
   * One of: "on" | "off" | "on-first-retry" | "retain-on-failure".
   */
  trace: "on" | "off" | "on-first-retry" | "retain-on-failure";
  /** Playwright's `screenshot` option. */
  screenshot: "on" | "off" | "only-on-failure";
  /** Playwright's `video` option. */
  video: "on" | "off" | "on-first-retry" | "retain-on-failure";
}

export interface ThresholdsConfig {
  /** Fail the quality gate when the failure rate exceeds this fraction, 0..1. */
  maxFailureRate: number;
  /** Fail the gate when any single test exceeds this many attempts. */
  maxAttemptsPerTest: number;
  /** Fail the gate when total duration exceeds this, milliseconds. */
  maxDurationMs: number;
}

export interface DefectConfig {
  /** Directory, relative to the project root, where defect artifacts are written. */
  directory: string;
  /** Also write an index of every defect from the run. */
  writeSummary: boolean;
  /**
   * Read Playwright's error-context.md alongside each failure and record its
   * path. The artifact complements that file instead of duplicating it.
   */
  referenceErrorContext: boolean;
}

/**
 * Run history: enough to answer "is this a regression, or has it always been this
 * way" across runs.
 *
 * Stored in its own committed directory rather than under `defects.directory`,
 * because the repository rule is that evidence artifacts are output and never
 * committed. A history entry is not an artifact: it is a few hundred bytes of
 * counts and outcomes, it is what makes the project useful over time, and a
 * question with no answer is worth more to keep than to lose to a gitignore.
 *
 * Only outcomes that are *not* a plain pass are recorded. Absence means the spec
 * ran and passed, which keeps an entry small enough that a hundred of them still
 * read as a directory rather than as a dataset.
 */
export interface HistoryConfig {
  /** Directory, relative to the project root, for one compact file per run. */
  directory: string;
  /**
   * How many runs to keep. The oldest entries are deleted past this, so a history
   * cannot grow without bound in a repository.
   */
  keep: number;
}

/** HTTP methods an expectation may name. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * One declared API contract: an exchange the application under test must make.
 *
 * The owner's decision of 2026-10-16 was declarative expectations in
 * `config/project.json` rather than a helper inside a test, so a project's
 * contracts are checked as a whole and an expectation cannot die with the test
 * that happened to carry it.
 *
 * There is no `optional`. An expectation with no captured exchange is a
 * violation, not an absence — the fail-closed rule the owner set, and the reason
 * a config entry here can never quietly stop applying.
 */
export interface ApiExpectation {
  /** Lowercase kebab-case id, carried into the artifact and into messages. */
  name: string;
  /** The HTTP method of the exchange. */
  method: HttpMethod;
  /**
   * Path the exchange must hit, beginning with `/`.
   *
   * A query string is not part of a contract: redaction drops query strings
   * wholesale, so a matcher that required one would be asserting against a value
   * this project deliberately does not keep.
   */
  path: string;
  /** Field paths that must be present in the request body. */
  requestRequires?: string[];
  /** Status the response must carry. */
  status?: number;
  /** Media type the response must carry, compared without parameters. */
  contentType?: string;
  /** Field paths that must be present in the response body. */
  responseRequires?: string[];
}

/**
 * API contracts, checked against traffic the page actually produced.
 *
 * Optional, like `history`: a project that declares none has not opted in, and a
 * missing key is not a mistake worth an error.
 */
export interface ApiConfig {
  expectations?: ApiExpectation[];
}

export interface ProjectConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** Short human-readable project name. */
  name: string;
  /** Origin under test. Only the origin is recorded, never a full path or query. */
  baseUrl: string;
  /** Playwright project names this configuration applies to. */
  projects: string[];
  evidence: EvidenceConfig;
  thresholds: ThresholdsConfig;
  defects: DefectConfig;
  /** Run history across runs. Omitted means history is off. */
  history?: HistoryConfig;
  /** Declared API contracts. Omitted means the dimension is off. */
  api?: ApiConfig;
  /** Labels copied onto every produced defect artifact. */
  tags: string[];
}
