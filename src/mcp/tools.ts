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
import type { ArtifactStore } from "./store.js";
import { declaresSubscriptions } from "./protocol.js";

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
 * What this server offers.
 *
 * `logging` is absent on purpose: deprecated in 2026-07-28. `tools.listChanged`
 * and `resources.listChanged` are false because nothing here mutates, which is
 * the read-only guarantee stated structurally elsewhere in this file.
 */
export interface ServerCapabilities {
  tools: { listChanged: boolean };
  resources: { listChanged: boolean; subscribe?: boolean };
  prompts: { listChanged: boolean };
}

/**
 * Advertised capabilities, answered against what the client declared.
 *
 * `resources.subscribe` is advertised only to a client that asked for
 * subscriptions in its envelope. Advertising a subscription this server cannot
 * deliver is worse than saying nothing about it: the client subscribes, waits for
 * a notification that never arrives, and reports the server as broken.
 *
 * The capability is conditional rather than constant for the same reason it is
 * read from the envelope at all — the client states what it wants, and the answer
 * is not the same to every caller.
 */
export function capabilitiesFor(
  clientCapabilities: Record<string, unknown> | undefined,
): ServerCapabilities {
  const subscribe = declaresSubscriptions(clientCapabilities);
  return {
    tools: { listChanged: false },
    resources: subscribe ? { listChanged: false, subscribe: true } : { listChanged: false },
    prompts: { listChanged: false },
  };
}
