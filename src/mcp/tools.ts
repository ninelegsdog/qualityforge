/**
 * The three read-only tools, plus their resources and one prompt.
 *
 * Read-only is enforced structurally, not by convention: there is no code path
 * here that writes, and the store exposes no write method. The one thing the
 * server can influence outside this process is its own log, and that goes to
 * stderr.
 *
 * Tool names follow SEP-986: 1 to 64 characters from `[A-Za-z0-9_./-]`, so
 * `quality_list_failures` is valid, and the `quality_` prefix namespaces them.
 */
import { flakinessReport, trendReport } from "../defect/flakiness.js";
import type { ArtifactStore } from "./store.js";

export const SERVER_INSTRUCTIONS = [
  "QualityForge exposes read-only evidence about browser test failures.",
  "",
  "Use it like this:",
  "1. `quality_get_latest_run` to see the most recent run and its quality gate.",
  "2. `quality_list_failures` to enumerate defects, optionally for one run.",
  "3. `quality_get_defect` to read one defect in full, including captured",
  "   console, network and page-error signals.",
  "",
  "Report facts before hypotheses. Every claim about a failure should point at a",
  "field in a defect artifact. This server cannot run tests, change code, or",
  "publish anything.",
].join("\n");

/** MCP tool descriptor. `inputSchema` is JSON Schema 2020-12. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
}

const NO_PROPERTIES = { type: "object", properties: {}, additionalProperties: false } as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: "quality_get_latest_run",
    title: "Get the latest quality run",
    description:
      "Return the most recent run's summary: pass and fail counts, duration, " +
      "whether the configured quality gate passed, and the defect files it produced. " +
      "Start here. Read-only.",
    inputSchema: NO_PROPERTIES,
    outputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        createdAt: { type: "string" },
        counts: { type: "object" },
        gate: { type: "object" },
        defectCount: { type: "number" },
      },
      required: ["runId", "counts", "gate"],
      additionalProperties: true,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "quality_list_failures",
    title: "List failures",
    description:
      "List defect artifacts, newest run first by default, or restricted to one " +
      "runId. Returns compact records — id, status, test location and flakiness " +
      "verdict — not full defect bodies. Read them one at a time with " +
      "quality_get_defect. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Restrict to one run. Omit for the newest run.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum records to return. Defaults to 20.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        total: { type: "number" },
        defects: { type: "array", items: { type: "object" } },
      },
      required: ["runId", "total", "defects"],
      additionalProperties: true,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "quality_get_defect",
    title: "Get one defect",
    description:
      "Read a single defect artifact in full: failure message and location, " +
      "evidence paths, VCS context, retry history, flakiness verdict, and " +
      "captured console, network and page-error signals. The defect path is " +
      "exactly what quality_list_failures returns. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        defectPath: {
          type: "string",
          description: "Relative artifact path, e.g. <runId>/<defect-id>.v1.json",
        },
      },
      required: ["defectPath"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        runId: { type: "string" },
        status: { type: "string" },
        test: { type: "object" },
        failure: { type: "object" },
        evidence: { type: "object" },
        context: { type: "object" },
        flakiness: { type: "object" },
        signals: { type: "object" },
      },
      required: ["id", "runId", "status", "test", "failure", "flakiness"],
      additionalProperties: true,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "quality_flaky_tests",
    title: "Which tests are flaky across runs",
    description:
      "Compare the run history and report which specs are unstable: `flaky` " +
      "(failed and passed at least once in the window), `failing` (failed in " +
      "every run it appeared in), `new` (failed in the newest run with no earlier " +
      "record), or `quiet` (absent from the newest run). Use this before deciding " +
      "whether a failure is worth chasing: a regression and a known flake call for " +
      "different responses. Empty window when the project keeps no history, which " +
      "is an absence of evidence rather than an all-clear. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many specs to return, 1..100 (default 20), worst first",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        window: { type: "number" },
        latestRunId: { type: "string" },
        tests: { type: "array" },
      },
      required: ["window", "tests"],
      additionalProperties: true,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "quality_get_trend",
    title: "Pass rate and duration across runs",
    description:
      "Read the run history oldest-first and report pass rate per run, a " +
      "direction derived from the first half of the window against the second " +
      "(`improving`, `worsening`, `flat`, or `unknown` below four runs), mean " +
      "duration of each half, and how many distinct specs failed anywhere in the " +
      "window. This is how you tell one bad run from a suite that is actually " +
      "getting worse. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        direction: { type: "string" },
        points: { type: "array" },
        durationMs: { type: "object" },
        distinctFailing: { type: "number" },
      },
      required: ["direction", "points", "distinctFailing"],
      additionalProperties: true,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
}

function text(value: string): ToolCallResult["content"] {
  return [{ type: "text", text: value }];
}

/**
 * Narrowing accessors for untrusted summary JSON.
 *
 * The summary is parsed from disk, so every value is `unknown`. Stringifying it
 * blindly would render "[object Object]" into text a model reads, which is worse
 * than admitting the field is absent.
 */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function show(value: string | number | undefined, fallback = "unknown"): string {
  return value === undefined ? fallback : String(value);
}

/**
 * Invoke a tool.
 *
 * Errors become tool results with `isError`, not JSON-RPC errors. A model can
 * read and react to a failed tool call; a transport-level error usually ends the
 * turn, and the caller cannot tell a bad argument from a missing file.
 */
export async function callTool(
  store: ArtifactStore,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult & { isError?: boolean }> {
  switch (name) {
    case "quality_get_latest_run":
      return getLatestRun(store);
    case "quality_list_failures":
      return listFailures(store, args);
    case "quality_get_defect":
      return getDefect(store, args);
    case "quality_flaky_tests":
      return flakyTests(store, args);
    case "quality_get_trend":
      return getTrend(store);
    default:
      return {
        content: text(
          `Unknown tool ${JSON.stringify(name)}. Available: ${TOOLS.map((t) => t.name).join(", ")}`,
        ),
        isError: true,
      };
  }
}

async function getLatestRun(store: ArtifactStore): Promise<ToolCallResult> {
  const summary = await store.readLatestSummary();
  const runId = str(summary, "runId") ?? "";
  const counts =
    typeof summary.counts === "object" && summary.counts !== null
      ? (summary.counts as Record<string, unknown>)
      : {};
  const gate =
    typeof summary.gate === "object" && summary.gate !== null
      ? (summary.gate as Record<string, unknown>)
      : {};

  const structured = {
    runId,
    createdAt: str(summary, "createdAt"),
    baseUrl: str(summary, "baseUrl"),
    counts,
    gate,
    durationMs: num(summary, "durationMs"),
    defectCount: Array.isArray(summary.defects) ? summary.defects.length : 0,
  };

  return {
    content: text(
      [
        `Run ${runId}`,
        `specs ${show(num(counts, "specs"), "0")} · passed ${show(num(counts, "passed"), "0")} · ` +
          `failed ${show(num(counts, "failed"), "0")} · flaky ${show(num(counts, "flaky"), "0")}`,
        `quality gate: ${gate.passed === true ? "PASSED" : "FAILED"}`,
        ...(Array.isArray(gate.violations) && gate.violations.length > 0
          ? [
              `violations: ${gate.violations.filter((v): v is string => typeof v === "string").join("; ")}`,
            ]
          : []),
        "",
        `Next: call quality_list_failures to see what failed.`,
      ].join("\n"),
    ),
    structuredContent: structured,
  };
}

async function listFailures(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const runIdRaw = args.runId;
  const limitRaw = args.limit;
  const limit = typeof limitRaw === "number" ? Math.min(Math.max(limitRaw, 1), 100) : 20;

  let runId: string;
  if (typeof runIdRaw === "string" && runIdRaw !== "") {
    runId = runIdRaw;
  } else {
    const runs = await store.listRuns();
    const newest = runs[0];
    if (newest === undefined) {
      return {
        content: text("No runs found. Run the test suite and `npm run defects:collect` first."),
        structuredContent: { runId: "", total: 0, defects: [] },
      };
    }
    runId = newest.runId;
  }

  const paths = await store.listDefects(runId);
  const total = paths.length;
  const selected = paths.slice(0, limit);

  const defects: Record<string, unknown>[] = [];
  for (const defectPath of selected) {
    const defect = await store.readDefect(defectPath);
    // Compact by design. A model that gets five full artifacts to answer
    // "what failed" has spent its context on repetition.
    defects.push({
      defectPath,
      id: defect.id,
      status: defect.status,
      title: defect.test.title,
      file: defect.test.file,
      line: defect.test.line,
      flakiness: defect.flakiness.verdict,
      consoleErrorCount: defect.signals?.consoleErrors?.length ?? 0,
      httpErrorCount: defect.signals?.httpErrors?.length ?? 0,
    });
  }

  return {
    content: text(
      total === 0
        ? `Run ${runId} has no defect artifacts.`
        : [
            `${total} defect(s) in ${runId}` +
              (total > selected.length ? `, showing ${selected.length}` : ""),
            ...defects.map((d) => {
              const line = num(d, "line");
              return (
                `- ${show(str(d, "status"))} ${show(str(d, "id"))} ` +
                `(${show(str(d, "file"))}:${line === undefined ? "?" : line})`
              );
            }),
            "",
            `Next: call quality_get_defect with a defectPath to read one in full.`,
          ].join("\n"),
    ),
    structuredContent: { runId, total, defects },
  };
}

async function getDefect(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult & { isError?: boolean }> {
  const defectPath = args.defectPath;
  if (typeof defectPath !== "string" || defectPath === "") {
    return {
      content: text("defectPath is required and must be a non-empty string."),
      isError: true,
    };
  }

  const defect = await store.readDefect(defectPath);
  return {
    content: text(JSON.stringify(defect, null, 2)),
    structuredContent: defect as unknown as Record<string, unknown>,
  };
}

/** Resource descriptors exposed by this server. */
export interface ResourceDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export const RESOURCES: ResourceDefinition[] = [
  {
    uri: "qualityforge://runs/latest/summary",
    name: "latest-quality-summary",
    title: "Latest run summary",
    description:
      "Machine-readable summary of the most recent run, including the quality gate result.",
    mimeType: "application/json",
  },
  {
    uri: "qualityforge://defect/{defectPath}",
    name: "defect",
    title: "Defect artifact",
    description: "One normalized defect. {defectPath} is a relative path under the artifacts root.",
    mimeType: "application/json",
  },
];

export async function readResource(
  store: ArtifactStore,
  uri: string,
): Promise<{ uri: string; mimeType: string; text: string }> {
  if (uri === "qualityforge://runs/latest/summary") {
    const summary = await store.readLatestSummary();
    return { uri, mimeType: "application/json", text: JSON.stringify(summary, null, 2) };
  }

  const defectPrefix = "qualityforge://defect/";
  if (uri.startsWith(defectPrefix)) {
    const relative = decodeURIComponent(uri.slice(defectPrefix.length));
    const defect = await store.readDefect(relative);
    return { uri, mimeType: "application/json", text: JSON.stringify(defect, null, 2) };
  }

  throw new UnknownResourceError(uri);
}

export class UnknownResourceError extends Error {
  override readonly name = "UnknownResourceError";
  constructor(readonly uri: string) {
    super(`Unknown resource URI: ${uri}`);
  }
}

/** Resource template, advertised through resources/templates/list. */
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "qualityforge://defect/{defectPath}",
    name: "defect",
    title: "Defect artifact",
    description: "One normalized defect artifact by relative path.",
    mimeType: "application/json",
  },
];

/** The evidence-first triage prompt. */
export const PROMPTS = [
  {
    name: "triage_failure",
    title: "Evidence-first failure triage",
    description: "Analyse one failed test using only what the defect artifacts actually say.",
    arguments: [
      {
        name: "defectPath",
        description: "Relative artifact path, from quality_list_failures.",
        required: true,
      },
    ],
  },
];

export function buildTriagePrompt(defectPath: string): string {
  return [
    "Triage one failed browser test using the QualityForge defect artifacts.",
    "",
    `Defect to analyse: ${defectPath}`,
    "",
    "Method. Do not skip the first step.",
    "",
    "1. Call quality_get_defect with that path. Read it before writing anything.",
    "2. Separate what the artifact states from what you infer. Label each",
    "   inference as such.",
    "3. List the facts that bear on the cause: failure message and location,",
    "   console errors, uncaught page errors, failed requests, HTTP responses",
    "   at or above 400, retry history and flakiness verdict.",
    "4. Give at most three hypotheses, each with a confidence level and a",
    "   specific, safe check that would confirm or refute it.",
    "5. Recommend the smallest next action. Propose no code change you cannot",
    "   justify from a field in the artifact.",
    "",
    "Constraints:",
    "- You cannot run tests or change code. Say what a human should run instead.",
    "- Do not guess at product behaviour that no artifact records.",
    "- If the evidence is insufficient for a cause, say so plainly. That is a",
    "  more useful answer than a confident guess.",
  ].join("\n");
}

/**
 * What this server offers, in the 2026-07-28 shape.
 *
 * ## This shape is the modern one, and the surprise is that it did not change
 *
 * Issue #12 recorded this as "the pre-2026 form" and asked for
 * `experimental, logging, completions, prompts, resources, tools, extensions` to
 * replace `tools.listChanged`, `resources.subscribe` and `prompts.listChanged`.
 * That reading does not survive the client. In the OpenCode 2.0.16 binary the
 * `ServerCapabilitiesSchema` for 2026-07-28 is:
 *
 * ```js
 * h({
 *   experimental: record(string, json).optional(),
 *   logging: object.optional(),
 *   completions: object.optional(),
 *   prompts:    h({ listChanged: boolean.optional() }).optional(),
 *   resources:  h({ subscribe: boolean.optional(), listChanged: boolean.optional() }).optional(),
 *   tools:      h({ listChanged: boolean.optional() }).optional(),
 *   tasks:      object.optional(),
 *   extensions: record(string, json).optional(),
 * })
 * ```
 *
 * The three members named in the issue are still there, still optional, and are
 * what the client reads. So dropping them would not modernise the contract, it
 * would delete the only signal the client acts on.
 *
 * `subscriptions/listen` is a separate mechanism, not a replacement: it is a
 * client-to-server request whose `notifications` filter carries
 * `toolsListChanged`, `promptsListChanged`, `resourcesListChanged` and
 * `resourceSubscriptions`. The client decides *whether to send* it by reading
 * `capabilities.tools.listChanged` and its two siblings out of the
 * `server/discover` result. Both halves have to stay for the pair to work.
 *
 * ## What is advertised, and why so little
 *
 * Every member is optional, so this is the whole of what can be said truthfully:
 *
 * - `tools`, `resources`, `prompts` are present because the client gates the
 *   corresponding methods on them. `assertCapabilityForMethod` reads
 *   `_serverCapabilities?.tools`, `.resources` and `.prompts` and throws
 *   `CapabilityNotSupported` when a member is missing, which would make
 *   `tools/list`, `resources/list` and `prompts/list` uncallable. They carry
 *   `listChanged: false`, which is the truth: nothing here mutates, so a client
 *   is told not to open a subscription.
 * - `completions` is absent: this server implements no `completion/complete`.
 * - `logging` is absent: deprecated in 2026-07-28.
 * - `experimental`, `extensions` and `tasks` are absent: there is nothing to put
 *   in them. An empty object would be a claim of an extension surface that does
 *   not exist.
 *
 * ## What was removed, and why it was a lie
 *
 * `resources.subscribe` used to be advertised, conditionally, to a client that
 * declared a `subscriptions` capability. Two facts made that wrong. This server
 * has no `resources/subscribe` case in its dispatch, so the capability promised
 * a method that answers -32601. And the condition could only ever select *who*
 * to mislead, never change the answer: the 2026-07-28 `ClientCapabilitiesSchema`
 * has no `subscriptions` member at all - its members are experimental, sampling,
 * elicitation, roots, tasks and extensions - so a conforming client can never
 * switch it on. A capability this server cannot deliver is worse than silence
 * about it: the client subscribes, waits for a notification that never arrives,
 * and reports the server as broken.
 *
 * The absence is also the useful answer. With `resources.subscribe` missing, the
 * client's own `assertCapabilityForMethod` refuses `resources/subscribe` before
 * it is sent, which is a clear refusal instead of a method that vanishes.
 */
export interface ServerCapabilities {
  tools: { listChanged: boolean };
  resources: { listChanged: boolean };
  prompts: { listChanged: boolean };
}

/**
 * Advertised capabilities.
 *
 * Constant, and no longer conditional. That is a change of substance rather than
 * of style: it used to answer against the client's declared capabilities, and the
 * reason it did was to advertise `resources.subscribe`. With that gone there is
 * nothing left to vary, and a conditional answer is how an advertisement becomes
 * something different to each caller - which is how a server ends up stating a
 * capability to one client that it denies to the next.
 *
 * The parameter is kept so the call sites carry the envelope they were already
 * reading, and so a future conditional capability has an obvious home. It is
 * ignored, and that is deliberate rather than forgotten.
 */
export function capabilitiesFor(_clientCapabilities?: Record<string, unknown>): ServerCapabilities {
  return {
    tools: { listChanged: false },
    resources: { listChanged: false },
    prompts: { listChanged: false },
  };
}

async function flakyTests(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const limitRaw = args.limit;
  const limit = typeof limitRaw === "number" ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const records = await store.readHistoryRecords();

  if (records.length === 0) {
    return {
      content: text(
        "No run history. Either config/project.json has no `history` block, or nothing " +
          "has been collected since one was added. Nothing to compare against — this is " +
          "an absence of evidence, not an all-clear.",
      ),
      structuredContent: { window: 0, tests: [] },
    };
  }

  const report = flakinessReport(records);
  const tests = report.tests.slice(0, limit);
  const lines = tests.map(
    (test) =>
      `  ${test.verdict.padEnd(7)} ${test.id} ` +
      `(${test.failedRuns}/${test.runs} run(s) failed, last: ${test.lastOutcome})`,
  );
  const body =
    report.tests.length === 0
      ? "  none — every spec passed every run in the window"
      : lines.join("\n");
  // A window whose compositions could not all be read cannot separate a flake from a
  // regression with confidence, and saying so is better than a verdict the reader
  // will take at face value.
  const caveat =
    report.partial === true
      ? "\n\nNote: at least one run's composition file was missing, so presence for that run " +
        "is only what it recorded a non-pass for. Treat `failing` there as unconfirmed."
      : "";
  return {
    content: text(
      `Window: ${report.window} run(s), newest ${report.latestRunId ?? "unknown"}. ` +
        `Specs that failed at least once: ${report.tests.length}.\n${body}` +
        caveat,
    ),
    structuredContent: {
      window: report.window,
      latestRunId: report.latestRunId ?? "",
      partial: report.partial === true,
      tests,
    },
  };
}

async function getTrend(store: ArtifactStore): Promise<ToolCallResult> {
  const entries = await store.readHistory();

  if (entries.length === 0) {
    return {
      content: text(
        "No run history, so there is no trend to read. Collect a run with a `history` " +
          "block configured in config/project.json.",
      ),
      structuredContent: { direction: "unknown", points: [], distinctFailing: 0 },
    };
  }

  const report = trendReport(entries);
  const lines = report.points.map(
    (point) =>
      `  ${point.runId}  specs ${point.specs} · passed ${point.passed} · ` +
      `failed ${point.failed} · ${(point.passRate * 100).toFixed(1)}%` +
      (point.durationMs === undefined ? "" : ` · ${(point.durationMs / 1000).toFixed(1)}s`),
  );
  const { earlier, recent } = report.durationMs;
  const duration =
    earlier === undefined && recent === undefined
      ? "no timings recorded"
      : `mean duration ${earlier ?? "n/a"}ms → ${recent ?? "n/a"}ms`;

  return {
    content: text(
      `Direction: ${report.direction} over ${report.points.length} run(s) ` +
        `(fewer than four runs cannot show a direction).\n` +
        `Mean duration: ${duration}. Distinct failing specs in window: ` +
        `${report.distinctFailing}.\n${lines.join("\n")}`,
    ),
    structuredContent: report as unknown as Record<string, unknown>,
  };
}
