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
  /** Labels copied onto every produced defect artifact. */
  tags: string[];
}
