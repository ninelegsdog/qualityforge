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
  /**
   * Largest total transfer a page may cost, in bytes.
   *
   * The one budget this project declares, and the choice is measured rather than
   * preferred. On 2026-10-18, over five runs on the demo pages:
   *
   * - `transferSize` from Resource Timing: **3 922 bytes, spread 0** on the home
   *   page and **526 538 bytes, spread 0** on a deliberately heavy one;
   * - summing response bodies instead: spread of 397 bytes on the *same* page,
   *   because the engine does not always hand a body over.
   *
   * So the metric is the network layer's own count, which needs no body read and
   * cannot depend on the engine's cooperation, and the budget is an absolute number
   * with a wide margin — 20 000 is five times the page and twenty-six times below
   * the heavy one, so it can only fail for a real change and not for jitter.
   *
   * Omitted means the dimension is off, rather than measured and ignored.
   */
  maxTransferredBytes?: number;
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
export interface VisualConfig {
  /**
   * The engine project whose appearance is approved.
   *
   * Named rather than derived, because measurement showed it cannot be derived: on
   * 2026-10-18 the same page produced **no shared screenshot hash** between firefox
   * and chromium, and every viewport and scale produced its own. A baseline says
   * nothing without saying which engine approved it.
   *
   * One project on the owner's decision of 2026-10-19: firefox renders two stable
   * states for this page, differing by exactly 253 pixels on 3 runs of 10, and
   * waiting does not settle it. Chromium was byte-identical across five runs.
   */
  project: string;
  /**
   * Where committed baseline images live, relative to the project root.
   *
   * The images **are** the baselines; there is no manifest of expected hashes
   * beside them. A manifest would be a second copy of one fact, and two copies of one
   * fact are two things to drift.
   */
  directory: string;
  /** The pages held to their baselines. */
  pages: string[];
  /**
   * Keep the judged captures as images beside the audit, for the newest runs.
   *
   * Declaring the block **is** the opt-in, in the same shape `history` uses: a
   * project without the block stores no observed picture at all, and the audit
   * stays with hashes, byte counts and the capture viewport — the owner's decision
   * recorded as G24. When the block is present, the collector writes each distinct
   * judged appearance under `artifacts/visual/<runId>/observed/<sha256>.png` and
   * points at it from the audit; nothing else ever needs to discover the name,
   * which is why the block carries no directory of its own.
   *
   * `keep` bounds the storage rather than leaving it unbounded, because a stored
   * observed image is page content — the thing no field-level redaction can
   * sanitise — so the copy exists for as long as a reviewer can need the newest
   * runs, and no longer. The audits themselves are never pruned by this rule.
   * There is no diff overlay either way: a reviewer opens the two pictures side
   * by side, or reproduces the page at the recorded viewport.
   */
  observedImages?: {
    /** How many of the newest runs may hold stored observed images. */
    keep: number;
  };
}

/**
 * The pages a transfer budget holds.
 *
 * Optional, and the choice matters. A project that names pages is held to exactly
 * those: a page nobody measured is `no-observation`, because the project said the
 * budget applied there. A project that names none is held to every page the run
 * actually loaded, so enabling the dimension cannot produce a false absence just
 * because nobody wrote the page list twice.
 *
 * This repository names three and omits `/heavy`: the demo server keeps that page
 * to breach a budget, and a fixture cannot both contain an over-budget page and pass
 * its own budget.
 */
export interface PerfConfig {
  /**
   * Absolute page paths the budget holds, in configuration order.
   *
   * Empty is refused rather than read as "no pages": if a project wanted no pages it
   * should omit the block, and an empty list would otherwise mean two opposite things
   * depending on which code path read it.
   */
  pages?: string[];
}

export interface ApiConfig {
  /**
   * Directory, relative to the project root, for `api-audit.v1.json`.
   *
   * Omitted means the default, `artifacts/api` — a sibling of the defects
   * directory, not a subdirectory of it. The contract reserves a run directory
   * for one artifact per failure, and an audit is not a failure.
   */
  directory?: string;
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
  /** Appearance comparison. Omitted means the dimension is off. */
  visual?: VisualConfig;
  /** Pages a transfer budget holds, when `thresholds.maxTransferredBytes` is set. */
  perf?: PerfConfig;
  /** Labels copied onto every produced defect artifact. */
  tags: string[];
}
