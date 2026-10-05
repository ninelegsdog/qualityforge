/**
 * Defect collector: Playwright JSON report in, `defect.v1` artifacts out.
 *
 * Three decisions worth stating, because they are the ones a reader will
 * question:
 *
 * 1. It does not parse `error-context.md`. It records a path to it. That file
 *    already holds the error, the expected-versus-received diff and a page
 *    snapshot, phrased as an instruction to an assistant. Parsing prose written
 *    for a human reader would be the most fragile link in this pipeline, so the
 *    artifact extends that file by reference instead of copying it.
 *
 * 2. Terminal colour codes are stripped from messages. Playwright embeds ANSI
 *    escapes in `error.message`, and a defect artifact full of escape sequences
 *    is unreadable to both a human and a model.
 *
 * 3. Evidence pointers are optional and never guessed. A local run with no
 *    retry legitimately has no trace, so the collector reports what exists.
 *
 * Field names follow Playwright's JSON report, verified against 1.63.0:
 *   spec   -> file, line, column, title, id, tags, ok, tests[]
 *   test   -> projectName, expectedStatus, status, results[]
 *   result -> status, retry, duration, startTime, error{location,message,snippet,stack},
 *             attachments[{name, path}]   (paths absolute)
 *   stats  -> startTime, duration, expected, skipped, unexpected, flaky
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../config/types.js";
import {
  DEFECT_SCHEMA_VERSION,
  type DefectLocation,
  type DefectPage,
  type DefectSignals,
  type DefectStatus,
  type DefectV1,
  type FailureAttribution,
  type FlakinessVerdict,
  type RetryEntry,
  type TargetSource,
  type TestStatus,
  validateDefect,
} from "./types.js";
import {
  HISTORY_SCHEMA_VERSION,
  readHistoryRecords,
  recordHistory,
  rotateHistory,
  type HistoryEntry,
  type HistoryOutcome,
} from "./history.js";
import { trendReport, windowVerdicts } from "./flakiness.js";

/**
 * An attachment as the JSON reporter writes it.
 *
 * Two shapes exist, and the difference matters. `path` is set when the runner
 * wrote a file (trace, screenshot, video, error-context). `body` is base64 for
 * content attached from memory with `testInfo.attach({ body })`, which writes
 * nothing to disk. A reader that assumes `path` is always present silently
 * ignores every inline attachment.
 */
interface PwAttachment {
  name: string;
  contentType?: string;
  path?: string;
  body?: string;
}

interface PwErrorLocation {
  file?: string;
  line?: number;
  column?: number;
}

interface PwError {
  message?: string;
  stack?: string;
  snippet?: string;
  location?: PwErrorLocation;
}

interface PwResult {
  status?: string;
  retry?: number;
  duration?: number;
  startTime?: string;
  error?: PwError;
  errors?: PwError[];
  attachments?: PwAttachment[];
}

interface PwTest {
  projectName?: string;
  expectedStatus?: string;
  results?: PwResult[];
}

interface PwSpec {
  id?: string;
  title?: string;
  file?: string;
  line?: number;
  column?: number;
  tags?: string[];
  tests?: PwTest[];
}

interface PwSuite {
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

interface PwJsonReport {
  config?: {
    rootDir?: string;
    /**
     * Present only when the project declares a `webServer`. Verified against
     * 1.63.0: `use` is serialised as null, so `use.baseURL` is not available.
     */
    webServer?: { url?: string } | null;
  };
  stats?: {
    startTime?: string;
    duration?: number;
    expected?: number;
    skipped?: number;
    unexpected?: number;
    flaky?: number;
  };
  suites?: PwSuite[];
}

/** Test statuses Playwright uses per attempt. */
const ATTEMPT_STATUSES: TestStatus[] = ["passed", "failed", "timedOut", "skipped", "interrupted"];

/** Terminal outcomes recorded on a defect. */
const DEFECT_STATUSES: DefectStatus[] = ["failed", "timedOut", "skipped", "interrupted"];

/**
 * CSI and OSC escape sequences.
 *
 * Playwright writes them into `error.message` whenever colour is enabled, which
 * it is by default. Left in place they make the artifact both unreadable and
 * needlessly large.
 */
const ANSI_PATTERN = new RegExp(
  [
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)", // OSC
    "\\u001B[@-Z\\\\-_]|\\u001B\\[[0-?]*[ -/]*[@-~]", // CSI and friends
  ].join("|"),
  "g",
);

/** Remove terminal escape sequences and collapse the trailing whitespace. */
export function stripAnsi(value: string): string {
  return value
    .replace(ANSI_PATTERN, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * Reduce a URL to its origin.
 *
 * Credentials, paths and query strings must never reach an artifact: a baseUrl
 * carrying a token would otherwise be committed alongside the defect.
 */
export function originOf(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * The application under test, and where that answer came from.
 *
 * `config/project.json`'s `baseUrl` is what *this project* is usually pointed at,
 * which is not the same claim as what the browser was on. Pointing the suite at a
 * third party with `BASE_URL` leaves the configured value untouched, and
 * Playwright's JSON report does not serialise `use.baseURL` — so every artifact
 * from a third-party run claimed the bundled fixture's origin while the browser
 * was somewhere else entirely. A consumer grouping defects by origin then
 * silently merged two applications' failures.
 *
 * Three inputs, most trustworthy first:
 *
 * - `environment` — `BASE_URL`. This is the strongest available evidence, since
 *   it is the very value the runner's config reads. Not absolute proof: a
 *   project whose Playwright config derives its base URL some other way would
 *   report `environment` incorrectly. That is why the source is recorded.
 * - `report` — `webServer.url` from the report. The runner's own view of what it
 *   serves, but present only when the project declares a `webServer`, and it
 *   describes the fixture rather than the target in a `BASE_URL`-driven run.
 * - `config` — `config/project.json`. The fallback, and correct exactly when
 *   nothing overrode it.
 */
export interface TargetResolution {
  origin?: string;
  source?: TargetSource;
}

/**
 * The directory a report's `spec.file` values are relative to.
 *
 * `report.config.rootDir` when the runner recorded one, resolved against
 * `projectRoot` if it is itself relative. Otherwise the configured `testDir`, which
 * is what a report without a `rootDir` implies.
 */
function rootDirFor(projectRoot: string, testDir: string, reported: unknown): string {
  if (typeof reported === "string" && reported !== "") {
    return path.isAbsolute(reported) ? reported : path.resolve(projectRoot, reported);
  }
  return path.resolve(projectRoot, testDir);
}

export function resolveTarget(input: {
  environmentBaseUrl?: string;
  reportWebServerUrl?: string;
  configuredBaseUrl?: string;
  /**
   * The URL the browser was actually on, when a failing test drove a page.
   *
   * This is the only input that is not a declaration of intent. The three
   * configured sources all say what someone *meant* the target to be, and in a run
   * against an application this project did not build they are wrong in the same
   * way - the report named the bundled fixture's origin while the browser was on
   * the target. So when an observed origin disagrees with the configured answer,
   * the observation wins and the source is recorded as `observed`.
   *
   * Compared against the candidate that would have won anyway, not against all
   * three. A lower-priority candidate that disagrees is irrelevant when a
   * higher-priority one agrees: the artifact would have carried the winner either
   * way, so nothing is being corrected.
   *
   * When they agree, or when there is no observation, the configured answer and
   * its name are returned unchanged. Only the disagreement case is new, and that
   * is the case that was wrong.
   */
  observedPageUrl?: string;
}): TargetResolution {
  let resolved: { origin: string; source: TargetSource } | undefined;
  for (const [source, value] of [
    ["environment", input.environmentBaseUrl],
    ["report", input.reportWebServerUrl],
    ["config", input.configuredBaseUrl],
  ] as const) {
    // Only an absolute, parseable URL counts. A relative BASE_URL is a
    // configuration error that Playwright reports far more clearly than this
    // function could, so it must not become a recorded origin.
    const origin = originOf(value ?? "");
    if (origin !== undefined) {
      resolved = { origin, source };
      break;
    }
  }

  const observed = originOf(input.observedPageUrl ?? "");

  // Nothing was configured. An observation is then the only thing known, and it is
  // worth recording rather than dropping - "there was no configuration" and "the
  // browser was here" are different facts.
  if (resolved === undefined) {
    return observed === undefined ? {} : { origin: observed, source: "observed" };
  }

  if (observed === undefined || observed === resolved.origin) return resolved;

  return { origin: observed, source: "observed" };
}

/**
 * Turn a test identity into a stable kebab-case defect id.
 *
 * `project` is part of the identity only when the run had more than one project.
 * A single-project report is the common case and its ids are unchanged; a matrix
 * run needs the engine in the id, because the same spec in chromium and in
 * firefox is two different observations and would otherwise collide into one
 * filename — which the collector now refuses rather than silently overwriting.
 */
export function defectIdFrom(file: string, title: string, project?: string): string {
  const withExt = path.basename(file);
  // Drop the extension, then a trailing .spec/.test, so
  // "homepage.smoke.spec.ts" contributes "homepage-smoke" rather than
  // "homepage-smoke-spec". The suffix carries no information an id needs.
  const base = withExt.replace(/\.(?:spec|test)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");

  // Slug the project separately, then append, so a project name cannot eat the
  // 120-character budget the title was given.
  const suffix =
    project === undefined || project === ""
      ? ""
      : `-${project
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")}`;

  const slug = `${base} ${title}`
    .toLowerCase()
    .normalize("NFKD")
    // The contract allows only [a-z0-9-]; accents and symbols fold away.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
  // A title made entirely of symbols would slugify to nothing.
  return slug.length > 0 ? `${slug}${suffix}` : `unknown-defect${suffix}`;
}

/**
 * Build a run id: a sortable timestamp plus a short digest.
 *
 * The id must sort lexicographically into chronological order, because that is
 * how the artifact store decides which run is the latest one - it compares the
 * strings and nothing else. So every field keeps a fixed width, and a change to
 * the format that drops the padding breaks "latest run" silently rather than
 * loudly. `tests/unit/defect-collector.test.ts` pins that property.
 *
 * The digest does not make the id unique. It is derived from the same timestamp
 * the stamp already encodes, so two calls for the same instant return the same
 * id and both runs would share one directory. An earlier comment here claimed the
 * digest was "for uniqueness", which was not true of the code.
 *
 * Reaching it needs two collections inside one millisecond, which no CI job does
 * - separate legs are separate runners - so this is left as it is rather than
 * changed under an artifact contract. It is written down so that the day it does
 * bite, the cause is a two-line read rather than a mystery.
 */
export function makeRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/z$/, "Z");
  const digest = createHash("sha256").update(now.toISOString()).digest("hex").slice(0, 6);
  return `${stamp}-${digest}`;
}

function attemptStatus(raw: string | undefined): TestStatus {
  return ATTEMPT_STATUSES.includes(raw as TestStatus) ? (raw as TestStatus) : "failed";
}

function toDefectStatus(status: TestStatus): DefectStatus {
  return DEFECT_STATUSES.includes(status as DefectStatus) ? (status as DefectStatus) : "failed";
}

/**
 * Classify flakiness from the attempts of a single run.
 *
 * `unknown` for one attempt is deliberate. Claiming "failing" from a single
 * observation would be a guess dressed up as a verdict.
 */
export function classifyAttempts(statuses: TestStatus[]): {
  verdict: FlakinessVerdict;
  passed: number;
  failed: number;
} {
  const passed = statuses.filter((s) => s === "passed").length;
  const failed = statuses.filter((s) => s !== "passed" && s !== "skipped").length;

  if (statuses.length <= 1) {
    return { verdict: "unknown", passed, failed };
  }
  const first = statuses[0];
  const last = statuses[statuses.length - 1];
  if (first !== "passed" && last === "passed") {
    return { verdict: "flaky", passed, failed };
  }
  if (first !== "passed" && last !== "passed") {
    return { verdict: "failing", passed, failed };
  }
  return { verdict: "passedAfterRetry", passed, failed };
}

/** Walk nested suites, yielding every spec together with its file. */
function* walkSpecs(suites: PwSuite[] | undefined): Generator<PwSpec> {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      yield spec;
    }
    yield* walkSpecs(suite.suites);
  }
}

async function fileSize(absolute: string): Promise<number | undefined> {
  try {
    const info = await stat(absolute);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** Attachment name to artifact field. `error-context` becomes failure.errorContextRef. */
const EVIDENCE_BY_ATTACHMENT: Record<string, "trace" | "screenshot" | "video"> = {
  trace: "trace",
  screenshot: "screenshot",
  video: "video",
};

/** Attachment written by the QualityForge fixture on a failing test. */
const SIGNALS_ATTACHMENT = "quality-context";

/**
 * The run summary's own filename.
 *
 * A defect's filename is `<id>.v1.json`, and an id is a slug, so a defect whose
 * id slugifies to `quality-summary` lands on this exact name. It is reserved so
 * that collision fails loudly instead of the summary quietly replacing a defect
 * at the end of the run.
 */
const SUMMARY_FILE_NAME = "quality-summary.v1.json";

/** One line naming a test, for a message its reader has to act on. */
function describeTest(defect: DefectV1): string {
  return (
    `  - ${defect.test.file}:${defect.test.line ?? "?"} ` +
    `${JSON.stringify(defect.test.title)}` +
    (defect.test.playwrightId === undefined ? "" : ` (playwrightId ${defect.test.playwrightId})`)
  );
}

/**
 * The error raised when two failures want the same filename.
 *
 * Overwriting on a key collision is the defect itself: the first failure
 * disappears with no warning, `validateDefect()` passes what is left, and the
 * run summary lists one path twice while the directory holds one file. So the
 * collector refuses, and says which two tests collided and why their ids
 * matched - the reader should not have to work that out by hand.
 */
function duplicateIdError(id: string, first: DefectV1, second: DefectV1): Error {
  return new Error(
    `Refusing to write a second defect artifact for id ${JSON.stringify(id)} ` +
      "(duplicate defect id).\n" +
      "Both of these failed, and one filename cannot hold both:\n" +
      `${describeTest(first)}\n` +
      `${describeTest(second)}\n` +
      "Nothing was overwritten: the artifact already on disk is untouched, and no\n" +
      "run summary is written, so nothing on disk claims this run was collected in full.\n" +
      "The id is a slug of the file basename and the title, so two tests collide when the\n" +
      "slug is identical: two files sharing a basename, a title with no [a-z0-9]\n" +
      "characters, or two titles that agree past the 120-character cap.\n" +
      "Give the two tests distinguishable titles, or rename one of the files.",
  );
}

interface SignalsPayload {
  signals?: DefectSignals;
  dropped?: number;
  page?: DefectPage;
}

/**
 * Read the page the failure happened on.
 *
 * A URL is required and non-empty; anything else is dropped rather than
 * half-recorded, because a page block with no URL states nothing a consumer can
 * act on. The title is optional and left absent when the page had none.
 */
function readPageContext(payload: SignalsPayload): DefectPage | undefined {
  const page = payload.page;
  if (page === undefined) return undefined;
  if (typeof page !== "object" || page === null) return undefined;
  const candidate = page as { url?: unknown; title?: unknown };
  if (typeof candidate.url !== "string" || candidate.url === "") return undefined;
  return {
    url: candidate.url,
    ...(typeof candidate.title === "string" && candidate.title !== ""
      ? { title: candidate.title }
      : {}),
  };
}

/**
 * Read an attachment's text from either shape.
 *
 * Inline `body` wins over `path`: an attachment is one or the other, never both.
 */
async function readAttachmentText(attachment: PwAttachment): Promise<string | undefined> {
  if (attachment.body !== undefined) {
    try {
      return Buffer.from(attachment.body, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  if (attachment.path !== undefined && (await isFile(attachment.path))) {
    try {
      return await readFile(attachment.path, "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The fixture's context payload: captured signals plus the page.
 *
 * Split from `readSignals` because the two blocks have genuinely different
 * rules. Signals are absent unless something was observed; the page is present
 * whenever the test drove a page, because a page with no console errors and no
 * failed requests is still the page the failure happened on. Returning them
 * together from one function would force one of those rules to be wrong.
 */
interface FixtureContext {
  signals?: DefectSignals;
  page?: DefectPage;
}

async function readFixtureContext(attachment: PwAttachment): Promise<FixtureContext> {
  const text = await readAttachmentText(attachment);
  if (text === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A malformed attachment must not fail the whole collection. The defect
    // itself is still worth recording.
    return {};
  }

  // Parsed as unknown and checked at runtime, because a file on disk is not a
  // trustworthy source of a type.
  if (typeof parsed !== "object" || parsed === null) return {};
  const payload = parsed as SignalsPayload;

  const signals = payload.signals ?? {};
  const hasAny = Object.values(signals).some(
    (entries) => Array.isArray(entries) && entries.length > 0,
  );
  const page = readPageContext(payload);

  return {
    ...(hasAny
      ? {
          signals: {
            ...signals,
            ...(typeof payload.dropped === "number" ? { dropped: payload.dropped } : {}),
          },
        }
      : {}),
    ...(page === undefined ? {} : { page }),
  };
}

export interface CollectOptions {
  /** Absolute project root. Every recorded path is relative to it. */
  projectRoot: string;
  /** Playwright's `testDir`, as a path relative to projectRoot. */
  testDir: string;
  /** Defect output directory, relative to projectRoot. */
  outputDir: string;
  /**
   * Where to keep one compact entry per run, and how many to keep.
   *
   * Omitted means history is off and nothing extra is written. Not an error: a
   * project that has not opted in should not be forced to invent a directory for a
   * feature it does not use.
   */
  history?: { directory: string; keep: number };
  /** Playwright JSON report path, relative to projectRoot. */
  reportPath: string;
  /**
   * The configured origin, from config/project.json.
   *
   * A fallback, not the answer: see `resolveTarget`. Reduced to an origin before
   * recording.
   */
  baseUrl?: string;
  /**
   * `BASE_URL` from the environment, when set.
   *
   * Preferred over the configured value, because it is what the runner's config
   * actually reads. Ignored unless it parses as an absolute URL.
   */
  environmentBaseUrl?: string;
  /**
   * Record a path to error-context.md on each defect.
   *
   * Defaults to false: an artifact should point at prose only when asked to,
   * so that the flag's effect is visible in the output rather than implicit.
   */
  referenceErrorContext?: boolean;
  /** Labels copied onto every artifact. */
  tags?: string[];
  /** Gate thresholds from configuration. */
  thresholds: ProjectConfig["thresholds"];
  /** Injected so tests can pin the clock. */
  now?: Date;
  /** Injected so this module never shells out to git. */
  commit?: string | null;
  branch?: string | null;
  ci?: boolean;
  retries?: number;
}

/**
 * What run history says about the specs this run failed, read before this run was
 * appended to it.
 *
 * The per-defect `flakiness` verdict answers a question about one artifact and dies
 * with it, so a reader holding only the summary could not tell a flake from a
 * regression — which is the distinction this whole repository is built on. This is
 * the same judgement, lifted to the run.
 *
 * `window` is how many earlier runs were consulted, and it is deliberately written
 * rather than implied: a run citing itself as evidence about itself would be
 * circular, and a consumer seeing `window: 0` knows it is reading nothing.
 */
export interface RunFlakiness {
  /** Runs of history consulted. Zero means none were configured or readable. */
  window: number;
  /**
   * The strongest claim this run's failures support, worst first: `failing` and
   * `regression` beat `flaky`, which beats `new` — the same order a reader would
   * triage them in. `none` means nothing failed, `unknown` that no history existed
   * to ask.
   */
  verdict: "unknown" | "none" | "flaky" | "failing" | "regression" | "new";
  /** How many of this run's failures landed in each bucket. */
  counts: { flaky: number; failing: number; regression: number; new: number };
  /** Pass-rate direction over the same window; `unknown` below four runs. */
  direction: "improving" | "worsening" | "flat" | "unknown";
  /**
   * At least one run in the window had no readable composition, so its passes are
   * hidden and the flaky/failing split may be wrong. Reported, not smoothed over.
   */
  partial?: boolean;
}

export interface RunSummary {
  schemaVersion: string;
  runId: string;
  createdAt: string;
  baseUrl?: string;
  /** Which input `baseUrl` came from, so a consumer can weigh it. */
  targetSource?: TargetSource;
  counts: {
    specs: number;
    passed: number;
    failed: number;
    timedOut: number;
    skipped: number;
    flaky: number;
    /**
     * Specs that failed on an error raised outside their own bodies, and for
     * which no artifact was written. `failed` excludes them; the gate does not.
     */
    aborted: number;
  };
  durationMs?: number;
  startedAt?: string;
  defects: string[];
  /** What the runs before this one said about what this one failed. */
  flakiness: RunFlakiness;
  thresholds: ProjectConfig["thresholds"];
  gate: {
    passed: boolean;
    violations: string[];
  };
}

/**
 * Reduce the history window to this run's question: of the specs that failed here,
 * what had earlier runs already said about them?
 *
 * Read **before** the summary is written and therefore before this run's own record
 * exists, so `window` never contains the run it describes — a summary citing itself
 * as evidence about itself is the circularity the window exists to avoid.
 *
 * With history off the answer is `unknown`: not an empty object, and not a guess.
 * A summary claiming `new` for a project with no history would be an unfounded
 * claim wearing the clothes of a measurement, which is the failure mode this
 * repository's "fail closed, do not guess" rule exists to prevent.
 */
async function historyFlakiness(
  projectRoot: string,
  history: { directory: string } | undefined,
  failingIds: string[],
): Promise<RunFlakiness> {
  const records =
    history === undefined ? [] : await readHistoryRecords(projectRoot, history.directory);

  const counts: RunFlakiness["counts"] = { flaky: 0, failing: 0, regression: 0, new: 0 };
  let partial = false;
  if (records.length > 0) {
    const window = windowVerdicts(records, failingIds);
    partial = window.partial;
    for (const verdict of window.verdicts.values()) counts[verdict] += 1;
  }

  // Only runs that already have entries: trendReport is the same function
  // quality_get_trend calls, so the direction in a summary and the direction an
  // agent is told are one number computed one way rather than two.
  const trend = trendReport(
    records.map((record) => ({
      runId: record.entry.runId,
      ...(record.entry.createdAt === undefined ? {} : { createdAt: record.entry.createdAt }),
      counts: record.entry.counts,
      ...(record.entry.durationMs === undefined ? {} : { durationMs: record.entry.durationMs }),
      outcomes: record.entry.outcomes,
    })),
  );

  const verdict: RunFlakiness["verdict"] =
    failingIds.length === 0
      ? "none"
      : records.length === 0
        ? "unknown"
        : counts.failing > 0
          ? "failing"
          : counts.regression > 0
            ? "regression"
            : counts.flaky > 0
              ? "flaky"
              : "new";

  return {
    window: records.length,
    verdict,
    counts,
    direction: trend.direction,
    ...(partial ? { partial: true } : {}),
  };
}

function firstError(result: PwResult | undefined): PwError {
  if (!result) return { message: "no attempt result recorded" };
  if (result.error?.message !== undefined) return result.error;
  const first = result.errors?.find((e) => e.message !== undefined);
  if (first) return first;
  return { message: "the runner reported a failure without a message" };
}

function relativize(projectRoot: string, absolute: string): string {
  return path.relative(projectRoot, absolute).split(path.sep).join("/");
}

/**
 * One spec that produced a non-passing, non-skipped outcome, reduced to what the
 * abort rule needs.
 *
 * Collected before anything is written, because deciding whether a failure is a
 * defect needs its siblings: whether a `beforeAll` aborted a file is a fact about
 * all of that file's failures together, not about any one of them.
 */
export interface AbortableFailure {
  /** `spec.file` as the report names it; the grouping key. */
  file: string;
  /** Stripped failure message, exactly as it would be written to an artifact. */
  message: string;
  /** The runner's source location for the error, when it reported one. */
  errorLocation?: { file?: string; line?: number; column?: number };
  /**
   * True when the error was raised above this spec's own declaration, which a
   * test body cannot do.
   */
  raisedAboveDeclaration?: boolean;
  /**
   * How many specs in the same file were skipped rather than run.
   *
   * This is what separates a suite that aborted from a suite where one test
   * failed for its own reason. Verified against real Playwright output: a
   * `beforeAll` throw produces one `failed` and then `skipped` for the rest of
   * the file, while a genuine assertion failure leaves the siblings `passed`.
   * Location alone is not enough - a helper defined above the test and called
   * from its body raises the same way, so requiring both keeps a real defect
   * from being silently dropped.
   */
  skippedInFile?: number;
}

/** A file whose specs did not run, and why that is one fact rather than many. */
export interface SuiteAbort {
  file: string;
  /** How many failures are written off as this one outage. */
  count: number;
  /** The message every one of them carries. */
  message: string;
  /** `file:line:column` the error was raised at. */
  site: string;
  /**
   * Which of the two shapes produced it.
   *
   * They look nothing alike in a report and the gate message has to describe
   * the real one, or it explains a five-failure outage using words that fit a
   * single one.
   *
   * - `repeated` - several specs failed on one identical error, which is what a
   *   serial-mode runner produces when a shared fixture dies.
   * - `hook` - one spec failed above its own declaration and the rest of the
   *   file was skipped, which is what Playwright actually produces for a
   *   `beforeAll` throw. Measured, not assumed: the first spec is `failed` and
   *   every later one is `skipped`, never `failed`.
   */
  shape: "repeated" | "hook";
}

/**
 * One failing spec, held between the walk and the write.
 *
 * The walk counts and classifies; the write happens after the abort decision, so
 * nothing derived from the report is computed twice and no artifact is written
 * for a spec that turns out to have been aborted.
 */
interface PendingFailure {
  spec: PwSpec;
  /** `spec.file` as the report names it. */
  pwFile: string;
  /** Resolved against testDir, for comparing against error locations. */
  absoluteTestFile: string;
  relativeTestFile: string;
  attempts: PwResult[];
  statuses: TestStatus[];
  finalStatus: TestStatus;
  lastAttempt: PwResult | undefined;
  projectName: string | undefined;
  error: PwError;
  message: string;
  verdict: FlakinessVerdict;
  passedAttempts: number;
  failedAttempts: number;
  retryHistory: RetryEntry[];
}

/**
 * Identify the raise site of an error, so two failures can be compared.
 *
 * The message alone is not enough: two tests waiting for the same element produce
 * byte-identical messages while failing at different lines, and those are two real
 * defects. The location is what distinguishes one `throw` executed four times from
 * four separate assertions.
 */
function raiseSite(location: AbortableFailure["errorLocation"]): string | undefined {
  if (location?.file === undefined || location.line === undefined) return undefined;
  return `${location.file}:${location.line}:${location.column ?? 0}`;
}

/**
 * Decide which files were aborted by a failure raised outside their test bodies.
 *
 * ## Why the report cannot answer this directly
 *
 * The obvious key does not exist. Playwright 1.63.0's JSON reporter serialises
 * `result.error` straight through, and `TestError` carries no `stage` field — there
 * is no `before-all-hook` marker anywhere in the report to key off. Verified by
 * reading the reporter source and by running a real `beforeAll` failure end to end.
 * In the report, a hook failure and a spec failure are structurally identical.
 *
 * ## What does distinguish them
 *
 * One `throw` cannot be the body of four tests. When every failed spec in a file
 * reports the same error at the same source location, the failure was raised once,
 * outside the test bodies, and those specs never ran. Pointed at a dead port, the
 * third-party suite produced four artifacts that said `status: failed` with
 * identical messages; a triage agent would have opened four tickets on somebody
 * else's codebase for one outage.
 *
 * ## Why every condition is required
 *
 * Each one exists because without it the rule would swallow a real defect:
 *
 * - **At least two specs.** One spec failing alone proves nothing: a helper called
 *   by a single test raises from the helper, and that is a defect worth recording.
 * - **Every** failing spec in the file accounted for. One outlier means the bodies
 *   did run, and a file that half ran did not abort.
 * - **Every one of them carries a location.** No location means no comparison to
 *   make, and guessing here is how data goes missing.
 * - **One single message at one single site across all of them.** Two tests failing
 *   at different lines are two assertions, not one hook, and two failures that
 *   read differently are two facts even when they share a line.
 *
 * Passing specs in the file are not counted and do not veto the rule. A
 * `beforeAll` inside one describe takes that describe's specs down and leaves a
 * sibling describe green, and those green results say nothing about whether the
 * failing bodies ran.
 */
export function findSuiteAborts(failures: AbortableFailure[]): Map<string, SuiteAbort> {
  const byFile = new Map<string, AbortableFailure[]>();
  for (const failure of failures) {
    const list = byFile.get(failure.file);
    if (list === undefined) byFile.set(failure.file, [failure]);
    else list.push(failure);
  }

  const aborts = new Map<string, SuiteAbort>();
  for (const [file, list] of byFile) {
    const sites = list.map((failure) => raiseSite(failure.errorLocation));
    // No raise site means no site to explain it by, and a guess is worse than
    // writing a defect we can defend.
    if (sites.some((site) => site === undefined)) continue;
    const site = sites[0];
    if (site === undefined) continue;

    // The message is part of the identity of the failure, not decoration. One
    // raise site producing four different messages is four facts, not one outage.
    const message = list[0]?.message ?? "";
    const oneMessage = list.every((failure) => failure.message === message);

    // Shape `repeated`: one raise site, one message, several failures.
    if (list.length >= 2 && sites.every((other) => other === site) && oneMessage) {
      aborts.set(file, { file, count: list.length, message, site, shape: "repeated" });
      continue;
    }

    // Shape `hook`: a single failure, raised above the spec's own declaration,
    // with the rest of the file never having run.
    //
    // This is the shape Playwright really emits for a `beforeAll` throw, and the
    // one that matters: the original rule needed two or more failures and so
    // never fired on it, leaving one artifact per unreachable target - the exact
    // outcome this detector exists to prevent. Its unit coverage was green
    // throughout, because it was fed a synthetic report of four failures rather
    // than a real one.
    //
    // Both signals are required. Location alone would also catch a helper
    // defined above the test and called from its body, and suppressing a real
    // defect is the worse error to make.
    const only = list.length === 1 ? list[0] : undefined;
    if (
      only !== undefined &&
      only.raisedAboveDeclaration === true &&
      (only.skippedInFile ?? 0) > 0
    ) {
      aborts.set(file, { file, count: 1, message, site, shape: "hook" });
    }
  }
  return aborts;
}

/**
 * Whether this failure was raised outside the spec's own body.
 *
 * Sound in both the directions it claims and silent in the one it cannot:
 *
 * - `suite` — the location names a different file. Outside the body by definition,
 *   because the body is in this file.
 * - `hook` — the location is in this spec's own file but at or above the line
 *   where the spec is declared, which a test body cannot do. A `beforeAll` that
 *   throws is the measured case: the error carries the hook's line, and the spec
 *   reported as failed is declared below it.
 * - `unknown` — no location at all.
 * - absent — at or after the declaration in its own file. Not a claim that the body
 *   raised it: an error from a helper defined *below* the test is equally
 *   consistent with that, and "not provably above" is all a line number proves.
 */
export function attributionFor(input: {
  errorLocation?: { file?: string; line?: number; column?: number };
  specLine: number | undefined;
  absoluteTestFile: string;
  projectRoot: string;
}): FailureAttribution | undefined {
  const { file, line } = input.errorLocation ?? {};
  if (file === undefined || line === undefined) return "unknown";
  const absolute = path.isAbsolute(file) ? file : path.resolve(input.projectRoot, file);
  // A different file is a different file, whatever the line number says: a line in
  // another file cannot be "above this spec" in any meaningful sense, and folding
  // it into `hook` would send a reader looking at a hook in their own file for a
  // failure that came from someone else's.
  if (absolute !== input.absoluteTestFile) return "suite";
  if (input.specLine !== undefined && line < input.specLine) return "hook";
  return undefined;
}

/**
 * Collect defect artifacts from a Playwright JSON report.
 *
 * @returns the artifacts in write order, the run summary, and the run directory.
 */
export async function collectDefects(options: CollectOptions): Promise<{
  defects: DefectV1[];
  summary: RunSummary;
  runDir: string;
  /**
   * What history recording did, or `undefined` when history is off.
   *
   * Reported rather than thrown on purpose: the caller is a CI step whose artifact
   * upload is already wired up, and turning a missing convenience index into a red
   * build would train people to ignore it.
   */
  history?: {
    path: string;
    removed: string[];
    removedCompositions: string[];
    rotationFailed?: string;
    failed?: string;
  };
}> {
  const {
    projectRoot,
    testDir,
    outputDir,
    reportPath,
    referenceErrorContext = false,
    history,
    tags = [],
    thresholds,
    now = new Date(),
    commit = null,
    branch = null,
    ci = false,
    retries = 0,
  } = options;

  // path.resolve, not path.join: join concatenates even when the second
  // argument is absolute, so passing --report /tmp/x.json would silently read
  // <projectRoot>/tmp/x.json and report that as the missing path. resolve
  // honours an absolute argument and resolves a relative one against the root,
  // which is the behaviour a caller passing a flag expects.
  const absoluteReport = path.resolve(projectRoot, reportPath);
  let report: PwJsonReport;
  try {
    report = JSON.parse(await readFile(absoluteReport, "utf8")) as PwJsonReport;
  } catch (error) {
    throw new Error(
      `Cannot read the Playwright JSON report at ${absoluteReport}. ` +
        "Run the suite first, or check the reporter path in playwright.config.ts.",
      { cause: error },
    );
  }

  const runId = makeRunId(now);
  const createdAt = now.toISOString();
  const runDir = path.resolve(projectRoot, outputDir, runId);
  await mkdir(runDir, { recursive: true });

  // The three configured inputs, kept as one object so a defect can re-resolve with
  // its own observed page instead of repeating the precedence.
  const targetInputs = {
    ...(options.environmentBaseUrl === undefined
      ? {}
      : { environmentBaseUrl: options.environmentBaseUrl }),
    ...(report.config?.webServer?.url === undefined
      ? {}
      : { reportWebServerUrl: report.config.webServer.url }),
    ...(options.baseUrl === undefined ? {} : { configuredBaseUrl: options.baseUrl }),
  };
  const { origin, source: targetSource } = resolveTarget(targetInputs);
  const defects: DefectV1[] = [];
  /**
   * Id to artifact, for the run being collected.
   *
   * Checked before every write rather than inferred from the filesystem. The
   * two differ exactly when the run directory is not empty, which is also when
   * a stale artifact from a previous run could be mistaken for this run's -
   * so the in-memory map is the truth and the directory is not consulted.
   */
  const writtenIds = new Map<string, DefectV1>();
  let specs = 0;
  let passed = 0;
  let skipped = 0;
  let timedOut = 0;
  let flakySpecs = 0;
  /**
   * Every non-passing, non-skipped spec, in report order.
   *
   * Filled during the walk below and consulted once, before anything is written:
   * whether a file was aborted by a `beforeAll` is a fact about all of that file's
   * failures together, so the decision cannot be made one spec at a time.
   */
  const abortable: AbortableFailure[] = [];
  /** Every failing spec with its derived data, held until the abort decision. */
  const pending: PendingFailure[] = [];
  /** Specs whose file turned out to be aborted, so no artifact is written. */
  const suppressedSpecs = new Set<PwSpec>();
  /** Specs that never ran because something outside their bodies raised. */
  let aborted = 0;
  /** Built here so an abort violation is reported before the threshold ones. */
  const gateViolations: string[] = [];

  // One unit per spec *per project*.
  //
  // A Playwright report holds one entry per (spec, project) inside
  // `spec.tests[]`, and flattening them into a single attempts list treats
  // "ran in three engines" as "retried three times". That was invisible while
  // every leg was Chromium. With a matrix it means two things are wrong at once:
  // a test that passes in chromium and fails in firefox is recorded as one
  // defect attributed to chromium with a `passedAfterRetry` verdict, and the
  // same spec in several engines produces several identical ids, which the
  // duplicate guard then refuses — so a multi-browser run collects nothing.
  const units: Array<{ spec: PwSpec; test: PwTest | undefined }> = [];
  for (const spec of walkSpecs(report.suites)) {
    const entries = spec.tests ?? [];
    if (entries.length === 0) {
      units.push({ spec, test: undefined });
      continue;
    }
    for (const entry of entries) {
      units.push({ spec, test: entry });
    }
  }
  // The engine only joins the id when more than one engine ran, so a
  // single-project report keeps the ids it always had.
  const projectCount = new Set(
    units.map((u) => u.test?.projectName).filter((n): n is string => typeof n === "string"),
  ).size;

  /**
   * Non-pass outcomes per spec id, for the history entry.
   *
   * Absence means "ran and passed", which is what keeps a full run down to a few
   * lines. `aborted` is a value of its own rather than being folded into `failed`,
   * because a spec whose suite died never ran at all, and recording that as a
   * failure would make one outage look like a regression on the next run.
   */
  const historyOutcomes: Record<string, HistoryOutcome> = {};
  /**
   * Every spec id that ran, in report order — the composition the entry points at.
   * Without it, "failed in one run of two" and "failed every time it ran" are the
   * same string, because a pass has no outcome of its own.
   */
  const historyIds: string[] = [];
  let historyResult:
    | {
        path: string;
        removed: string[];
        removedCompositions: string[];
        rotationFailed?: string;
        failed?: string;
      }
    | undefined;

  // Counted here, read after the loop: Playwright emits the specs that never ran
  // *after* the one that failed, so a failure cannot know about its own skipped
  // siblings while it is still being recorded.
  const skippedByFile = new Map<string, number>();

  for (const { spec, test: pwTest } of units) {
    specs += 1;

    const pwFile = spec.file ?? "unknown.spec.ts";
    // `spec.file` is relative to the **runner's** rootDir — the directory holding
    // the specs — and to nothing else. Not to this process's working directory, and
    // not to the configured `testDir`, which is a separate value that happens to
    // coincide with rootDir in this repository's own layout.
    //
    // Measured, after `defects:check` started failing for no visible reason: a
    // report whose specs live in `test-results/report-check-<pid>/tests` records
    // `spec.file: "hook.spec.ts"` and `rootDir` pointing at that directory, so
    // resolving against `testDir` produced a path that does not exist. Two things
    // broke quietly: `test.file` in the artifact pointed at nothing, and
    // `attributionFor` concluded the error came from a different file, so a dead
    // `beforeAll` was reported as a defect instead of an outage.
    //
    // `testDir` stays as the fallback for a report with no `rootDir`, which is the
    // case a hand-written report describes.
    const absoluteTestFile = path.isAbsolute(pwFile)
      ? pwFile
      : path.resolve(rootDirFor(projectRoot, testDir, report.config?.rootDir), pwFile);
    const relativeTestFile = path.isAbsolute(pwFile)
      ? relativize(projectRoot, pwFile)
      : relativize(projectRoot, absoluteTestFile);

    const attempts = pwTest?.results ?? [];
    const statuses = attempts.length > 0 ? attempts.map((a) => attemptStatus(a.status)) : [];
    const finalStatus: TestStatus = statuses[statuses.length - 1] ?? "failed";
    const lastAttempt = attempts[attempts.length - 1];
    const projectName = pwTest?.projectName;

    // One id per unit, taken before any branch: the composition needs an entry for
    // every spec that ran, not only for the ones that misbehaved. Identical to the
    // defect id, including the `?? "untitled"` and the single-project elision — a
    // history key that did not match the id in the artifact would join two different
    // identities of the same spec.
    const historyId = defectIdFrom(
      pwFile,
      spec.title ?? "untitled",
      projectCount > 1 ? projectName : undefined,
    );
    historyIds.push(historyId);

    if (finalStatus === "passed") {
      passed += 1;
      if (statuses.some((s) => s !== "passed" && s !== "skipped")) {
        flakySpecs += 1;
        historyOutcomes[historyId] = "flaky";
      }
      continue;
    }
    if (finalStatus === "skipped") {
      skipped += 1;
      skippedByFile.set(pwFile, (skippedByFile.get(pwFile) ?? 0) + 1);
      historyOutcomes[historyId] = "skipped";
      continue;
    }
    if (finalStatus === "timedOut") timedOut += 1;

    const { verdict, passed: passedAttempts, failed: failedAttempts } = classifyAttempts(statuses);

    // Entries that turn out to be part of an outage are overwritten with `aborted`
    // below, once the whole file is known.
    historyOutcomes[historyId] = finalStatus === "timedOut" ? "timedOut" : "failed";

    const retryHistory: RetryEntry[] = attempts.map((attempt, i) => ({
      attempt: attempt.retry ?? i,
      status: attemptStatus(attempt.status),
      ...(attempt.duration === undefined ? {} : { durationMs: Math.round(attempt.duration) }),
      ...(attempt.startTime === undefined ? {} : { startedAt: attempt.startTime }),
    }));

    const error = firstError(lastAttempt);
    const message = stripAnsi(error.message ?? "");

    pending.push({
      spec,
      pwFile,
      absoluteTestFile,
      relativeTestFile,
      attempts,
      statuses,
      finalStatus,
      lastAttempt,
      projectName,
      error,
      message,
      passedAttempts,
      failedAttempts,
      verdict,
      retryHistory,
    });

    const raisedAbove =
      attributionFor({
        ...(error.location === undefined ? {} : { errorLocation: error.location }),
        specLine: spec.line,
        absoluteTestFile,
        projectRoot,
      }) === "hook";

    abortable.push({
      file: pwFile,
      message,
      ...(error.location === undefined ? {} : { errorLocation: error.location }),
      ...(raisedAbove ? { raisedAboveDeclaration: true } : {}),
    });

    continue;
  }

  for (const failure of abortable) {
    const siblings = skippedByFile.get(failure.file) ?? 0;
    if (siblings > 0) failure.skippedInFile = siblings;
  }

  // The decision that needs every spec at once, taken before anything is written.
  const aborts = findSuiteAborts(abortable);
  for (const abort of aborts.values()) {
    for (const entry of pending) {
      if (entry.pwFile === abort.file) {
        suppressedSpecs.add(entry.spec);
        // Never ran, as distinct from ran and failed. Its own outcome, so an outage
        // does not read as a regression on the next run.
        historyOutcomes[
          defectIdFrom(
            entry.pwFile,
            entry.spec.title ?? "untitled",
            projectCount > 1 ? entry.projectName : undefined,
          )
        ] = "aborted";
      }
    }
    aborted += abort.count;
    gateViolations.push(
      abort.shape === "hook"
        ? `1 spec in ${abort.file} failed on a hook, not on its own body: the error was ` +
            `raised at ${abort.site}, above the spec's declaration, and the rest of the file ` +
            `was skipped rather than run.\n` +
            `    This is a suite or environment failure, not a defect, so no artifact was ` +
            `written for it.\n`
        : `${abort.count} spec(s) in ${abort.file} never ran: every one failed on the same ` +
            `error raised at ${abort.site}, outside the test bodies.\n` +
            `    This is a suite or environment failure, not ${abort.count} defects, so no ` +
            `artifact was written for them.\n` +
            `    message: ${abort.message.split("\n")[0] ?? ""}`,
    );
  }

  for (const entry of pending) {
    const {
      spec,
      pwFile,
      absoluteTestFile,
      relativeTestFile,
      statuses,
      finalStatus,
      lastAttempt,
      projectName,
      error,
      message,
      passedAttempts,
      failedAttempts,
      verdict,
      retryHistory,
    } = entry;
    if (suppressedSpecs.has(spec)) continue;

    const attribution = attributionFor({
      ...(error.location === undefined ? {} : { errorLocation: error.location }),
      specLine: spec.line,
      absoluteTestFile,
      projectRoot,
    });

    // Evidence comes from the runner's own attachment list rather than from
    // guessing file names, because the runner knows what it actually wrote.
    const evidence: DefectV1["evidence"] = {};
    let errorContextRef: string | undefined;
    let errorContextBytes: number | undefined;
    let signals: DefectSignals | undefined;
    let page: DefectPage | undefined;
    for (const attachment of lastAttempt?.attachments ?? []) {
      if (attachment.name === SIGNALS_ATTACHMENT) {
        // Inline attachment: read the content, there is no file to point at.
        const context = await readFixtureContext(attachment);
        signals = context.signals;
        page = context.page;
        continue;
      }
      if (attachment.path === undefined) continue;
      if (!(await isFile(attachment.path))) continue;
      const field = EVIDENCE_BY_ATTACHMENT[attachment.name];
      if (field !== undefined) {
        evidence[field] = relativize(projectRoot, attachment.path);
      } else if (attachment.name === "error-context" && referenceErrorContext) {
        errorContextRef = relativize(projectRoot, attachment.path);
        // Record the size alongside the reference. The artifact points at this
        // file rather than embedding it, which is the right design — but it
        // means a consumer following the reference has no idea whether it is
        // about to read three kilobytes or thirty. Measured: 3 KB on our own
        // fixture, 34 KB and 933 lines for an ariaSnapshot of a mainstream
        // encyclopedia front page. An artifact is read by a language model, so
        // the size belongs in the artifact rather than in the reader's
        // judgement after the fact.
        const size = await fileSize(attachment.path);
        if (size !== undefined) errorContextBytes = size;
      }
    }

    // Where the browser actually was, when the failure drove a page. Resolved per
    // defect rather than once per run, because `page` belongs to this defect and a
    // run can visit more than one origin.
    const observed = resolveTarget({
      ...targetInputs,
      ...(page?.url === undefined ? {} : { observedPageUrl: page.url }),
    });

    // Evidence is whatever the runner actually attached. An absent trace on a
    // local run with no retry is normal, so nothing is invented to fill a gap.

    const location: DefectLocation | undefined =
      error.location?.file !== undefined && error.location.line !== undefined
        ? {
            file: path.isAbsolute(error.location.file)
              ? relativize(projectRoot, error.location.file)
              : error.location.file,
            line: error.location.line,
            ...(error.location.column === undefined ? {} : { column: error.location.column }),
          }
        : undefined;

    const defect: DefectV1 = {
      $schema: "https://qualityforge.dev/schemas/defect.v1.schema.json",
      schemaVersion: DEFECT_SCHEMA_VERSION,
      id: defectIdFrom(
        pwFile,
        spec.title ?? "untitled",
        projectCount > 1 ? projectName : undefined,
      ),
      runId,
      createdAt,
      status: toDefectStatus(finalStatus),
      test: {
        ...(spec.id === undefined ? {} : { playwrightId: spec.id }),
        title: spec.title ?? "untitled",
        file: relativeTestFile,
        ...(spec.line === undefined ? {} : { line: spec.line }),
        ...(spec.column === undefined ? {} : { column: spec.column }),
        ...(projectName === undefined ? {} : { project: projectName }),
        ...(spec.tags === undefined || spec.tags.length === 0 ? {} : { tags: spec.tags }),
      },
      failure: {
        message,
        ...(location === undefined ? {} : { location }),
        ...(error.snippet === undefined ? {} : { snippet: stripAnsi(error.snippet) }),
        ...(error.stack === undefined ? {} : { stack: stripAnsi(error.stack) }),
        ...(errorContextRef === undefined ? {} : { errorContextRef }),
        ...(errorContextBytes === undefined ? {} : { errorContextBytes }),
        ...(attribution === undefined ? {} : { attribution }),
      },
      evidence,
      context: {
        // Re-resolved per defect, because only here is the page known. The run-level
        // answer says what was configured; a defect can say where the browser
        // actually was. When the two disagree the artifact records the observation
        // and marks it `observed`, so a consumer grouping defects by origin cannot
        // merge two applications' failures under one wrong origin.
        ...(observed.origin === undefined ? {} : { baseUrl: observed.origin }),
        ...(observed.source === undefined ? {} : { targetSource: observed.source }),
        commit,
        branch,
        ci,
        retries,
        runStartedAt: report.stats?.startTime ?? createdAt,
        ...(report.stats?.duration === undefined
          ? {}
          : { durationMs: Math.round(report.stats.duration) }),
      },
      ...(page === undefined ? {} : { page }),
      ...(retryHistory.length > 1 ? { retryHistory } : {}),
      flakiness: {
        verdict,
        attempts: Math.max(statuses.length, 1),
        passedAttempts,
        failedAttempts,
      },
      ...(signals === undefined ? {} : { signals }),
      ...(tags.length === 0 ? {} : { tags }),
    };

    const validation = validateDefect(defect);
    if (!validation.valid) {
      throw new Error(
        `Collected defect "${defect.test.title}" violates its own contract:\n  - ${validation.problems.join("\n  - ")}`,
      );
    }

    const fileName = `${defect.id}.v1.json`;
    if (fileName === SUMMARY_FILE_NAME) {
      throw new Error(
        `Defect "${defect.test.title}" would be written as ${fileName}, which is the run ` +
          `summary's own filename, and the summary is written after every defect.\n` +
          `${describeTest(defect)}\n` +
          "Nothing was written. Rename the test file, or give the test a title that\n" +
          "slugs to something other than quality-summary.",
      );
    }

    // Fail closed on a key collision. Two failures, one filename, means one of
    // them is destroyed with no signal, which is worse than a red run.
    const collision = writtenIds.get(defect.id);
    if (collision !== undefined) {
      throw duplicateIdError(defect.id, collision, defect);
    }

    writtenIds.set(defect.id, defect);
    await writeFile(path.join(runDir, fileName), `${JSON.stringify(defect, null, 2)}\n`, "utf8");
    defects.push(defect);
  }

  const failureCount = defects.length;
  const failureRate = specs === 0 ? 0 : failureCount / specs;
  const violations = gateViolations;
  if (specs > 0 && failureRate > thresholds.maxFailureRate) {
    violations.push(
      `failure rate ${(failureRate * 100).toFixed(1)}% exceeds maxFailureRate ` +
        `${(thresholds.maxFailureRate * 100).toFixed(1)}% (${failureCount}/${specs})`,
    );
  }
  const maxAttempts = defects.reduce((max, d) => Math.max(max, d.flakiness.attempts ?? 1), 1);
  if (maxAttempts > thresholds.maxAttemptsPerTest) {
    violations.push(
      `a test used ${maxAttempts} attempts, above maxAttemptsPerTest ${thresholds.maxAttemptsPerTest}`,
    );
  }
  const runDuration = report.stats?.duration;
  if (runDuration !== undefined && Math.round(runDuration) > thresholds.maxDurationMs) {
    violations.push(
      `run took ${Math.round(runDuration)}ms, above maxDurationMs ${thresholds.maxDurationMs}`,
    );
  }
  if (flakySpecs > 0) {
    violations.push(`${flakySpecs} test(s) passed only after a retry`);
  }

  // Which specs failed this run, as history ids: the same keys the window is
  // indexed by, so the verdicts land on the specs that produced the artifacts.
  const failingIds = Object.entries(historyOutcomes)
    .filter(([, outcome]) => outcome === "failed" || outcome === "timedOut")
    .map(([id]) => id)
    .sort();
  const flakiness = await historyFlakiness(projectRoot, history, failingIds);

  const summary: RunSummary = {
    schemaVersion: DEFECT_SCHEMA_VERSION,
    runId,
    createdAt,
    ...(origin === undefined ? {} : { baseUrl: origin }),
    ...(targetSource === undefined ? {} : { targetSource }),
    counts: {
      specs,
      passed,
      failed: failureCount,
      timedOut,
      skipped,
      flaky: flakySpecs,
      /**
       * Specs whose failure was raised outside their own bodies, so no artifact
       * exists for them. `failed` deliberately excludes them: they are not
       * defects, and counting them is what produced four tickets for one outage.
       * They still fail the gate, which is why an outage cannot pass silently.
       */
      aborted,
    },
    ...(runDuration === undefined ? {} : { durationMs: Math.round(runDuration) }),
    ...(report.stats?.startTime === undefined ? {} : { startedAt: report.stats.startTime }),
    // Run-prefixed, not a bare filename, so a value from the summary can be
    // passed straight back as quality_get_defect's defectPath. One canonical
    // form avoids the caller having to guess which one it is holding.
    defects: defects.map((d) => `${runId}/${d.id}.v1.json`),
    flakiness,
    thresholds,
    gate: {
      passed: violations.length === 0,
      violations,
    },
  };

  await writeFile(
    path.join(runDir, SUMMARY_FILE_NAME),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  if (history !== undefined) {
    // After the summary, so a history entry never claims a run whose summary is
    // missing. Reported rather than thrown: the artifacts are the product, and losing
    // them because a convenience index could not be appended is the wrong trade.
    const entry: Omit<HistoryEntry, "composition"> = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      runId,
      createdAt,
      ...(origin === undefined ? {} : { baseUrl: origin }),
      ...(targetSource === undefined ? {} : { targetSource }),
      counts: summary.counts,
      ...(runDuration === undefined ? {} : { durationMs: Math.round(runDuration) }),
      outcomes: historyOutcomes,
    };
    // Written first, then rotated. Pruning after the write means this run's own entry
    // is never the one deleted; pruning before it would drop the run it was called
    // for as soon as `keep` is one.
    const recorded = await recordHistory({
      projectRoot,
      directory: history.directory,
      keep: history.keep,
      specIds: historyIds,
      entry,
    });
    if (recorded.failed !== undefined) {
      historyResult = { path: "", removed: [], removedCompositions: [], failed: recorded.failed };
    } else {
      const rotated = await rotateHistory({
        projectRoot,
        directory: history.directory,
        keep: history.keep,
      });
      historyResult = {
        path: recorded.path,
        removed: rotated.removed,
        removedCompositions: rotated.removedCompositions,
        ...(rotated.failed === undefined ? {} : { rotationFailed: rotated.failed }),
      };
    }
  }

  return {
    defects,
    summary,
    runDir,
    ...(historyResult === undefined ? {} : { history: historyResult }),
  };
}
