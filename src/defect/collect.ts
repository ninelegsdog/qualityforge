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
  type DefectSignals,
  type DefectStatus,
  type DefectV1,
  type FlakinessVerdict,
  type RetryEntry,
  type TestStatus,
  validateDefect,
} from "./types.js";

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
  config?: { rootDir?: string };
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

/** Turn a test identity into a stable kebab-case defect id. */
export function defectIdFrom(file: string, title: string): string {
  const withExt = path.basename(file);
  // Drop the extension, then a trailing .spec/.test, so
  // "homepage.smoke.spec.ts" contributes "homepage-smoke" rather than
  // "homepage-smoke-spec". The suffix carries no information an id needs.
  const base = withExt.replace(/\.(?:spec|test)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");

  const slug = `${base} ${title}`
    .toLowerCase()
    .normalize("NFKD")
    // The contract allows only [a-z0-9-]; accents and symbols fold away.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
  // A title made entirely of symbols would slugify to nothing.
  return slug.length > 0 ? slug : "unknown-defect";
}

/** Build a run id: sortable timestamp plus a short digest for uniqueness. */
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

interface SignalsPayload {
  signals?: DefectSignals;
  dropped?: number;
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
 * Read the fixture's captured signals.
 *
 * Returns undefined when there is nothing to report, which is different from an
 * empty signals object: absent means "not observed", empty means "observed and
 * found nothing". Consumers should not have to guess which they are looking at.
 */
async function readSignals(attachment: PwAttachment): Promise<DefectSignals | undefined> {
  const text = await readAttachmentText(attachment);
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A malformed attachment must not fail the whole collection. The defect
    // itself is still worth recording.
    return undefined;
  }

  // Parsed as unknown and checked at runtime, because a file on disk is not a
  // trustworthy source of a type.
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const payload = parsed as SignalsPayload;
  const signals = payload.signals ?? {};
  const hasAny = Object.values(signals).some(
    (entries) => Array.isArray(entries) && entries.length > 0,
  );
  if (!hasAny) return undefined;

  return {
    ...signals,
    ...(typeof payload.dropped === "number" ? { dropped: payload.dropped } : {}),
  };
}

export interface CollectOptions {
  /** Absolute project root. Every recorded path is relative to it. */
  projectRoot: string;
  /** Playwright's `testDir`, as a path relative to projectRoot. */
  testDir: string;
  /** Defect output directory, relative to projectRoot. */
  outputDir: string;
  /** Playwright JSON report path, relative to projectRoot. */
  reportPath: string;
  /** Origin under test; reduced to an origin before recording. */
  baseUrl?: string;
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

export interface RunSummary {
  schemaVersion: string;
  runId: string;
  createdAt: string;
  baseUrl?: string;
  counts: {
    specs: number;
    passed: number;
    failed: number;
    timedOut: number;
    skipped: number;
    flaky: number;
  };
  durationMs?: number;
  startedAt?: string;
  defects: string[];
  thresholds: ProjectConfig["thresholds"];
  gate: {
    passed: boolean;
    violations: string[];
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
 * Collect defect artifacts from a Playwright JSON report.
 *
 * @returns the artifacts in write order, the run summary, and the run directory.
 */
export async function collectDefects(options: CollectOptions): Promise<{
  defects: DefectV1[];
  summary: RunSummary;
  runDir: string;
}> {
  const {
    projectRoot,
    testDir,
    outputDir,
    reportPath,
    referenceErrorContext = false,
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

  const origin = originOf(options.baseUrl);
  const defects: DefectV1[] = [];
  let specs = 0;
  let passed = 0;
  let skipped = 0;
  let timedOut = 0;
  let flakySpecs = 0;

  for (const spec of walkSpecs(report.suites)) {
    specs += 1;

    const pwFile = spec.file ?? "unknown.spec.ts";
    // spec.file is relative to testDir, not to the project root.
    const absoluteTestFile = path.isAbsolute(pwFile)
      ? pwFile
      : path.resolve(projectRoot, testDir, pwFile);
    const relativeTestFile = path.isAbsolute(pwFile)
      ? relativize(projectRoot, pwFile)
      : relativize(projectRoot, absoluteTestFile);

    const attempts = spec.tests?.flatMap((t) => t.results ?? []) ?? [];
    const statuses = attempts.length > 0 ? attempts.map((a) => attemptStatus(a.status)) : [];
    const finalStatus: TestStatus = statuses[statuses.length - 1] ?? "failed";
    const lastAttempt = attempts[attempts.length - 1];
    const projectName = spec.tests?.[0]?.projectName;

    if (finalStatus === "passed") {
      passed += 1;
      if (statuses.some((s) => s !== "passed" && s !== "skipped")) flakySpecs += 1;
      continue;
    }
    if (finalStatus === "skipped") {
      skipped += 1;
      continue;
    }
    if (finalStatus === "timedOut") timedOut += 1;

    const { verdict, passed: passedAttempts, failed: failedAttempts } = classifyAttempts(statuses);

    const retryHistory: RetryEntry[] = attempts.map((attempt, i) => ({
      attempt: attempt.retry ?? i,
      status: attemptStatus(attempt.status),
      ...(attempt.duration === undefined ? {} : { durationMs: Math.round(attempt.duration) }),
      ...(attempt.startTime === undefined ? {} : { startedAt: attempt.startTime }),
    }));

    const error = firstError(lastAttempt);
    const message = stripAnsi(error.message ?? "");

    // Evidence comes from the runner's own attachment list rather than from
    // guessing file names, because the runner knows what it actually wrote.
    const evidence: DefectV1["evidence"] = {};
    let errorContextRef: string | undefined;
    let signals: DefectSignals | undefined;
    for (const attachment of lastAttempt?.attachments ?? []) {
      if (attachment.name === SIGNALS_ATTACHMENT) {
        // Inline attachment: read the content, there is no file to point at.
        signals = await readSignals(attachment);
        continue;
      }
      if (attachment.path === undefined) continue;
      if (!(await isFile(attachment.path))) continue;
      const field = EVIDENCE_BY_ATTACHMENT[attachment.name];
      if (field !== undefined) {
        evidence[field] = relativize(projectRoot, attachment.path);
      } else if (attachment.name === "error-context" && referenceErrorContext) {
        errorContextRef = relativize(projectRoot, attachment.path);
      }
    }
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
      id: defectIdFrom(pwFile, spec.title ?? "untitled"),
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
      },
      evidence,
      context: {
        ...(origin === undefined ? {} : { baseUrl: origin }),
        commit,
        branch,
        ci,
        retries,
        runStartedAt: report.stats?.startTime ?? createdAt,
        ...(report.stats?.duration === undefined
          ? {}
          : { durationMs: Math.round(report.stats.duration) }),
      },
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
    await writeFile(path.join(runDir, fileName), `${JSON.stringify(defect, null, 2)}\n`, "utf8");
    defects.push(defect);
  }

  const failureCount = defects.length;
  const failureRate = specs === 0 ? 0 : failureCount / specs;
  const violations: string[] = [];
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

  const summary: RunSummary = {
    schemaVersion: DEFECT_SCHEMA_VERSION,
    runId,
    createdAt,
    ...(origin === undefined ? {} : { baseUrl: origin }),
    counts: {
      specs,
      passed,
      failed: failureCount,
      timedOut,
      skipped,
      flaky: flakySpecs,
    },
    ...(runDuration === undefined ? {} : { durationMs: Math.round(runDuration) }),
    ...(report.stats?.startTime === undefined ? {} : { startedAt: report.stats.startTime }),
    // Run-prefixed, not a bare filename, so a value from the summary can be
    // passed straight back as quality_get_defect's defectPath. One canonical
    // form avoids the caller having to guess which one it is holding.
    defects: defects.map((d) => `${runId}/${d.id}.v1.json`),
    thresholds,
    gate: {
      passed: violations.length === 0,
      violations,
    },
  };

  await writeFile(
    path.join(runDir, "quality-summary.v1.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  return { defects, summary, runDir };
}
