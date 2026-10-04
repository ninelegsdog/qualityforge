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
  /** Labels copied onto every produced defect artifact. */
  tags: string[];
}
