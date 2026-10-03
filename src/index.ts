/**
 * QualityForge — package entry point.
 *
 * Intentionally thin on Day 1. The exported surface grows here as the
 * evidence schema and collectors land; see docs/architecture.md.
 */

export const PACKAGE_NAME = "qualityforge";

/** Evidence policy shared by the runner config and the collectors. */
export const EVIDENCE_POLICY = {
  /** A full trace is expensive; capture it only when a test already failed. */
  trace: "on-first-retry",
  screenshot: "only-on-failure",
  video: "retain-on-failure",
} as const;

export type EvidencePolicy = typeof EVIDENCE_POLICY;
