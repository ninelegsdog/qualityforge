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
import { PathAccessError, type ArtifactStore } from "./store.js";
import type { ApiAudit } from "../api/types.js";
import type { PerfAudit } from "../perf/types.js";
import type { VisualAudit } from "../visual/types.js";
import type { A11yAudit } from "../a11y/types.js";

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
      "whether the configured quality gate passed, the defect files it produced, " +
      "what earlier runs say about this run's failures — flaky, always failing, " +
      "or a new regression — and the verdicts the summary carries for every " +
      "declared dimension (API contracts, transfer budgets, appearance) plus the " +
      "shared policy chain the run inherited. Start here. Read-only.",
    inputSchema: NO_PROPERTIES,
    outputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        createdAt: { type: "string" },
        counts: { type: "object" },
        gate: { type: "object" },
        defectCount: { type: "number" },
        flakiness: { type: "object" },
        api: { type: "object" },
        perf: { type: "object" },
        visual: { type: "object" },
        policy: { type: "object" },
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
  {
    name: "quality_list_audits",
    title: "List accessibility audits",
    description:
      "List the accessibility audits this project has written, newest first, with " +
      "how many violations and undecided rules each found and how many rules were " +
      "truncated. Use it to see whether anyone has audited accessibility at all, " +
      "and whether the newest audit is clean. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many audits to return (1–100, default 20)." },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        audits: { type: "array" },
      },
      required: ["total", "audits"],
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
    name: "quality_get_audit",
    title: "Read one accessibility audit",
    description:
      "Read one accessibility audit in full: the rules that failed, the elements " +
      "each matched, and for every rule how many nodes were kept against how many " +
      "the rule really produced. Read totalNodes, not nodes.length alone — the " +
      "difference is the truncation you cannot otherwise see. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        auditPath: {
          type: "string",
          description: "Run-relative audit path, as listed by quality_list_audits.",
        },
      },
      required: ["auditPath"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        createdAt: { type: "string" },
        counts: { type: "object" },
        violations: { type: "array" },
        incomplete: { type: "array" },
      },
      required: ["runId", "createdAt", "counts", "violations", "incomplete"],
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
    name: "quality_list_api_audits",
    title: "List API contract audits",
    description:
      "List the API contract audits this project has written, newest first: how many " +
      "contracts were declared, how many tests produced a capture, and how many " +
      "violations and passes each found. Use it to see whether anyone has declared the " +
      "application's API at all. Read tests as well as violations — tests = 0 means the " +
      "dimension never ran, which is not a clean audit. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many audits to return (1–100, default 20)." },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        audits: { type: "array" },
      },
      required: ["total", "audits"],
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
    name: "quality_get_api_audit",
    title: "Read one API contract audit",
    description:
      "Read one API contract audit in full: every declared contract, its violations with " +
      "what was expected against what was observed, and how many tests and exchanges " +
      "were examined. A contract with no exchange is a violation, not an absence — the " +
      "application may have stopped calling its own endpoint. Values never survive a " +
      "body, so only declared paths that were *missing* are recorded. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        auditPath: {
          type: "string",
          description: "Run-relative audit path, as listed by quality_list_api_audits.",
        },
      },
      required: ["auditPath"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        baseUrl: { type: "string" },
        counts: { type: "object" },
        expectations: { type: "array" },
      },
      required: ["counts", "expectations"],
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
    name: "quality_list_perf_audits",
    title: "List transfer-budget audits",
    description:
      "List the transfer-budget audits this project has written, newest first: how many " +
      "budgets were declared, how many pages were measured, how many tests produced a " +
      "capture, and how many budgets held. Use it to see whether anyone has declared a " +
      "budget at all. Read tests as well as violations — tests = 0 means the dimension " +
      "never ran, which is not a clean audit. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many audits to return (1–100, default 20)." },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        audits: { type: "array" },
      },
      required: ["total", "audits"],
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
    name: "quality_get_perf_audit",
    title: "Read one transfer-budget audit",
    description:
      "Read one transfer-budget audit in full: every declared budget, what each page " +
      "actually cost, and its violations with what was allowed against what was " +
      "measured. A measured figure is the LARGEST load seen for that path, never an " +
      "average — a page that is usually fine is what a regression looks like. A budget " +
      "nothing loaded is a violation of its own kind, because a budget never held has " +
      "not been passed. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        auditPath: {
          type: "string",
          description: "Run-relative audit path, as listed by quality_list_perf_audits.",
        },
      },
      required: ["auditPath"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        baseUrl: { type: "string" },
        counts: { type: "object" },
        budgets: { type: "array" },
      },
      required: ["counts", "budgets"],
      additionalProperties: true,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // **Appended, never inserted.** The order of `TOOLS` is part of this project's
  // contract: a client asking for the list by index, and a documentation page listing
  // them in order, would both be reading something a reordering silently changed.
  // Two dimensions have now been added this way and neither moved an existing entry.
  {
    name: "quality_list_visual_audits",
    title: "List appearance audits",
    description:
      "List the appearance audits a project has written: one entry per run, with the " +
      "engine whose appearance was approved and how many pages matched it. A page that " +
      "does not look the way its committed baseline says is a violation, and a page " +
      "nobody ever approved is a violation of its own kind — an appearance nobody " +
      "reviewed is not an approved appearance. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum audits to return, newest first.",
          minimum: 1,
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "integer" },
        audits: { type: "array" },
      },
      required: ["total", "audits"],
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
    name: "quality_get_visual_audit",
    title: "Read one appearance audit",
    description:
      "Read one appearance audit in full: every declared page, the hash it produced, " +
      "and its violations with what was approved against what was seen. Baselines are " +
      "committed images, so 'what was approved' is a file in the repository rather than " +
      "a number somebody typed once. A page seen two ways is reported as unstable " +
      "rather than changed: that is a disagreement about which of them is the page, not " +
      "a picture that moved. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        auditPath: {
          type: "string",
          description: "Run-relative audit path, as listed by quality_list_visual_audits.",
        },
      },
      required: ["auditPath"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        baseUrl: { type: "string" },
        project: { type: "string" },
        counts: { type: "object" },
        pages: { type: "array" },
      },
      required: ["counts", "pages"],
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

/** A JSON object, or `undefined` for anything else — including arrays and `null`. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
    case "quality_list_audits":
      return listAudits(store, args);
    case "quality_get_audit":
      return getAudit(store, args);
    case "quality_list_api_audits":
      return listApiAudits(store, args);
    case "quality_get_api_audit":
      return getApiAudit(store, args);
    case "quality_list_visual_audits":
      return listVisualAudits(store, args);
    case "quality_get_visual_audit":
      return getVisualAudit(store, args);
    case "quality_list_perf_audits":
      return listPerfAudits(store, args);
    case "quality_get_perf_audit":
      return getPerfAudit(store, args);
    default:
      return {
        content: text(
          `Unknown tool ${JSON.stringify(name)}. Available: ${TOOLS.map((t) => t.name).join(", ")}`,
        ),
        isError: true,
      };
  }
}

/**
 * One line for one declared dimension, read from the summary block that already
 * carries the verdict.
 *
 * `ran: false` is its own sentence rather than "0 violations": a dimension that
 * never executed has not passed, and a client that reads only this tool must be
 * able to tell the two apart.
 */
function dimensionLine(
  label: string,
  block: Record<string, unknown> | undefined,
  totalKey: string,
  passedKey: string,
  noun: string,
): string | undefined {
  if (block === undefined) return undefined;
  if (block.ran === false) return `${label}: NOT RUN`;
  const counts = asObject(block.counts) ?? {};
  const violations = num(counts, "violations") ?? 0;
  const total = num(counts, totalKey);
  const passed = num(counts, passedKey);
  const detail = total === undefined ? "" : ` (${show(passed, "0")} of ${total} ${noun})`;
  const tail = violations > 0 ? `, ${violations} violation(s)` : "";
  return `${label}: ${violations === 0 ? "PASSED" : "FAILED"}${detail}${tail}`;
}

async function getLatestRun(store: ArtifactStore): Promise<ToolCallResult> {
  const summary = await store.readLatestSummary();
  const runId = str(summary, "runId") ?? "";
  const counts = asObject(summary.counts) ?? {};
  const gate = asObject(summary.gate) ?? {};

  /**
   * The dimension blocks and the policy chain travel with the summary, and this
   * tool is the documented first call. Dropping them here made an agent that read
   * only the entry point report that the API, transfer-budget and appearance
   * verdicts did not exist, and that no tool exposed the policy chain — while the
   * file held all four. The separate audit tools are for reading one audit in
   * full; they are not a reason for the summary to withhold its own verdicts.
   *
   * Absent on an older summary or a project that declared no such dimension, and
   * then the key is omitted rather than sent as an empty verdict.
   */
  const api = asObject(summary.api);
  const perf = asObject(summary.perf);
  const visual = asObject(summary.visual);
  const policy = asObject(summary.policy);
  const policyChain = Array.isArray(policy?.chain)
    ? policy.chain.filter((entry): entry is string => typeof entry === "string")
    : [];

  const structured = {
    runId,
    createdAt: str(summary, "createdAt"),
    baseUrl: str(summary, "baseUrl"),
    counts,
    gate,
    durationMs: num(summary, "durationMs"),
    defectCount: Array.isArray(summary.defects) ? summary.defects.length : 0,
    // The window verdict, passed through rather than re-derived: it is what turns
    // "five specs failed" into "three of them are known flakes", and an agent that
    // reads only this tool would otherwise have no way to ask. A summary written
    // without the field (a hand-made fixture, an older collector) simply omits it.
    ...(typeof summary.flakiness === "object" && summary.flakiness !== null
      ? { flakiness: summary.flakiness as Record<string, unknown> }
      : {}),
    ...(api === undefined ? {} : { api }),
    ...(perf === undefined ? {} : { perf }),
    ...(visual === undefined ? {} : { visual }),
    ...(policy === undefined ? {} : { policy }),
  };

  const dimensions = [
    dimensionLine("api", api, "expectations", "passed", "contracts passed"),
    dimensionLine("perf", perf, "budgets", "passed", "budgets passed"),
    dimensionLine("appearance", visual, "pages", "matched", "pages matched"),
    policy === undefined
      ? undefined
      : `policy: ${policyChain.length} shared file(s)${
          policyChain.length === 0 ? "" : ` — ${policyChain.join(" → ")}`
        }`,
  ].filter((line): line is string => line !== undefined);

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
        ...(dimensions.length === 0 ? [] : ["", ...dimensions]),
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

/**
 * Accessibility audits.
 *
 * Two tools rather than one, for the same reason defects have two: a model
 * asking "what failed" should not receive five full audits to answer it, and a
 * model asking about one rule needs the whole artifact.
 *
 * The empty answer is a first-class result. A project that has never run
 * `npm run a11y:audit` is told so in words that name the command, because
 * "no audits" and "no violations" are different claims and only one of them is
 * good news.
 */
async function listAudits(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const limitRaw = args.limit;
  const limit = typeof limitRaw === "number" ? Math.min(Math.max(limitRaw, 1), 100) : 20;

  const audits = await store.listAudits();
  const selected = audits.slice(0, limit);

  if (audits.length === 0) {
    return {
      content: text(
        "No accessibility audits found. Run `npm run a11y:audit` — this says nothing " +
          "about whether the project is accessible, only that nobody has looked.",
      ),
      structuredContent: { total: 0, audits: [] },
    };
  }

  return {
    content: text(
      [
        `${audits.length} accessibility audit(s)` +
          (audits.length > selected.length ? `, showing ${selected.length}` : ""),
        ...selected.map((audit) => {
          const truncated = audit.truncatedRules ?? 0;
          return (
            `- ${audit.runId}: ${audit.violations ?? 0} violation(s), ` +
            `${audit.incomplete ?? 0} undecided` +
            (truncated > 0 ? `, ${truncated} rule(s) truncated` : "")
          );
        }),
        "",
        `Next: call quality_get_audit with an auditPath to read one in full.`,
      ].join("\n"),
    ),
    structuredContent: { total: audits.length, audits: selected },
  };
}

async function listApiAudits(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const limitRaw = args.limit;
  const limit = typeof limitRaw === "number" ? Math.min(Math.max(limitRaw, 1), 100) : 20;

  const audits = await store.listApiAudits();
  const selected = audits.slice(0, limit);

  if (audits.length === 0) {
    return {
      content: text(
        "No API contract audits found. Declare the contracts in config/project.json and run " +
          "the suite — this says nothing about whether the API is sound, only that nobody has " +
          "asked.",
      ),
      structuredContent: { total: 0, audits: [] },
    };
  }

  return {
    content: text(
      [
        `${audits.length} API contract audit(s)` +
          (audits.length > selected.length ? `, showing ${selected.length}` : ""),
        ...selected.map((audit) => {
          // `tests: 0` gets its own word. A run of pure logic tests never imports the
          // fixture, so zero captures means nobody looked — which is not a clean
          // audit, and printing it as one would be the same mistake the collector
          // corrected when CI found it.
          const state =
            audit.tests === 0
              ? "NOT RUN (no test produced a capture)"
              : `${audit.violations ?? 0} violation(s), ${audit.passed ?? 0} passed`;
          return `- ${audit.runId}: ${audit.expectations ?? 0} declared, ${audit.tests ?? 0} test(s), ${state}`;
        }),
        "",
        `Next: call quality_get_api_audit with an auditPath to read one in full.`,
      ].join("\n"),
    ),
    structuredContent: { total: audits.length, audits: selected },
  };
}

async function listPerfAudits(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const limitRaw = args.limit;
  const limit = typeof limitRaw === "number" ? Math.min(Math.max(limitRaw, 1), 100) : 20;

  const audits = await store.listPerfAudits();
  const selected = audits.slice(0, limit);

  if (audits.length === 0) {
    return {
      content: text(
        "No transfer-budget audits found. Declare thresholds.maxTransferredBytes in " +
          "config/project.json and run the suite — this says nothing about whether the " +
          "pages are within budget, only that nobody has asked.",
      ),
      structuredContent: { total: 0, audits: [] },
    };
  }

  return {
    content: text(
      [
        `${audits.length} transfer-budget audit(s)` +
          (audits.length > selected.length ? `, showing ${selected.length}` : ""),
        ...selected.map((audit) => {
          const state =
            audit.tests === 0
              ? "NOT RUN (no test loaded a page)"
              : `${audit.violations ?? 0} breach(es), ${audit.passed ?? 0} held`;
          return `- ${audit.runId}: ${audit.budgets ?? 0} budget(s), ${audit.pages ?? 0} page(s), ${audit.tests ?? 0} test(s), ${state}`;
        }),
        "",
        `Next: call quality_get_perf_audit with an auditPath to read one in full.`,
      ].join("\n"),
    ),
    structuredContent: { total: audits.length, audits: selected },
  };
}

async function listVisualAudits(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const audits = await store.listVisualAudits();
  if (audits.length === 0) {
    return {
      content: text(
        "No appearance audits found. Declare visual in config/project.json, commit " +
          "baselines with npm run visual:baselines, and run the suite — this says " +
          "nothing about whether pages still look right, only that nobody has asked.",
      ),
      structuredContent: { total: 0, audits: [] },
    };
  }

  const limit = num(args, "limit");
  const selected = limit === undefined ? audits : audits.slice(0, limit);

  return {
    content: text(
      [
        `${audits.length} appearance audit(s)` +
          (selected.length < audits.length ? `, showing ${selected.length}` : ""),
        ...selected.map((audit) => {
          const state =
            audit.tests === 0
              ? "NOT RUN (this leg is not the approved engine)"
              : `${audit.violations ?? 0} finding(s), ${audit.matched ?? 0} matched`;
          const engine = audit.project === undefined ? "" : ` on ${audit.project}`;
          return `- ${audit.runId}: ${audit.pages ?? 0} page(s),${engine} ${state}`;
        }),
        "",
        "Next: call quality_get_visual_audit with an auditPath to read one in full.",
      ].join("\n"),
    ),
    structuredContent: { total: audits.length, audits: selected },
  };
}

async function getVisualAudit(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult & { isError?: boolean }> {
  const auditPath = args.auditPath;
  if (typeof auditPath !== "string" || auditPath === "") {
    return {
      content: text(
        "auditPath is required; list the audits first with quality_list_visual_audits.",
      ),
      isError: true,
    };
  }

  // A refusal is a readable answer, not a crash: the project may compare no appearance
  // at all. `PathAccessError` still escapes, because the server logs it and answers
  // "Path is not readable" — swallowing that would lose the log line.
  let audit: VisualAudit;
  try {
    audit = await store.readVisualAudit(auditPath);
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    return { content: text((error as Error).message), isError: true };
  }
  const runId = auditPath.split("/")[0] ?? auditPath;
  const { counts } = audit;

  return {
    content: text(
      [
        `appearance audit ${runId}${audit.baseUrl === undefined ? "" : ` · ${audit.baseUrl}`}` +
          (audit.project === undefined ? "" : ` · ${audit.project}`),
        counts.tests === 0
          ? `NOT RUN · ${counts.pages} page(s) declared, this leg is not the approved engine`
          : `${counts.violations} finding(s), ${counts.matched} matched, ` +
            `${counts.pages} page(s) across ${counts.tests} test(s)`,
        ...audit.pages.map((page) => {
          const header =
            `- ${page.path}: ` +
            (page.sha256 === null ? "no screenshot" : `sha256 ${page.sha256.slice(0, 12)}`);
          if (page.violations.length === 0) return `${header}, as approved`;
          return (
            header +
            "\n    " +
            page.violations
              .map(
                (violation) =>
                  `${violation.kind}: ${violation.expected} — observed ${violation.observed}`,
              )
              .join("\n    ")
          );
        }),
      ].join("\n"),
    ),
    structuredContent: {
      runId,
      counts,
      pages: audit.pages,
      ...(audit.baseUrl === undefined ? {} : { baseUrl: audit.baseUrl }),
      ...(audit.project === undefined ? {} : { project: audit.project }),
    },
  };
}

async function getPerfAudit(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult & { isError?: boolean }> {
  const auditPath = args.auditPath;
  if (typeof auditPath !== "string" || auditPath === "") {
    return {
      content: text("auditPath is required; list the audits first with quality_list_perf_audits."),
      isError: true,
    };
  }

  // A refusal is a readable answer, not a crash: the project may declare no budget at
  // all. `PathAccessError` still escapes, because the server logs it and answers
  // "Path is not readable" — swallowing that would lose the log line.
  let audit: PerfAudit;
  try {
    audit = await store.readPerfAudit(auditPath);
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    return { content: text((error as Error).message), isError: true };
  }
  const runId = auditPath.split("/")[0] ?? auditPath;
  const { counts } = audit;

  return {
    content: text(
      [
        `transfer-budget audit ${runId}${audit.baseUrl === undefined ? "" : ` · ${audit.baseUrl}`}`,
        counts.tests === 0
          ? `NOT RUN · ${counts.budgets} budget(s) declared, no test loaded a page`
          : `${counts.violations} breach(es), ${counts.passed} held, ` +
            `${counts.pages} page(s) measured across ${counts.tests} test(s)`,
        ...audit.budgets.map((budget) => {
          const measured =
            budget.measuredBytes === null ? "never measured" : `${budget.measuredBytes} bytes`;
          const header = `- ${budget.path}: ${measured} of ${budget.budgetBytes} allowed`;
          if (budget.violations.length === 0) return `${header}, held`;
          return (
            header +
            "\n    " +
            budget.violations
              .map((violation) => `${violation.expected} — observed ${violation.observed}`)
              .join("\n    ")
          );
        }),
        "",
        "A measured figure is the LARGEST load for that path, never an average.",
      ].join("\n"),
    ),
    structuredContent: {
      runId,
      ...(audit.baseUrl === undefined ? {} : { baseUrl: audit.baseUrl }),
      counts: audit.counts,
      budgets: audit.budgets,
    } as unknown as Record<string, unknown>,
  };
}

async function getApiAudit(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult & { isError?: boolean }> {
  const auditPath = args.auditPath;
  if (typeof auditPath !== "string" || auditPath === "") {
    return {
      content: text("auditPath is required; list the audits first with quality_list_api_audits."),
      isError: true,
    };
  }

  // A refusal is a readable answer, not a crash: the project may simply have
  // nothing there yet. `PathAccessError` still escapes, because the server logs it
  // and answers "Path is not readable" — swallowing that would lose both.
  let audit: ApiAudit;
  try {
    audit = await store.readApiAudit(auditPath);
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    return { content: text((error as Error).message), isError: true };
  }
  const runId = auditPath.split("/")[0] ?? auditPath;
  const { counts } = audit;
  const totals = audit.expectations.reduce(
    (sum, expectation) => ({
      exchanges: sum.exchanges + expectation.observed.exchanges,
      dropped: sum.dropped + expectation.observed.dropped,
    }),
    { exchanges: 0, dropped: 0 },
  );

  return {
    content: text(
      [
        `API contract audit ${runId}${audit.baseUrl === undefined ? "" : ` · ${audit.baseUrl}`}`,
        counts.tests === 0
          ? `NOT RUN · ${counts.expectations} contract(s) declared, no test produced a capture`
          : `${counts.violations} violation(s), ${counts.passed} passed, ` +
            `${counts.tests} test(s), ${totals.exchanges} exchange(s) examined`,
        ...audit.expectations.map((expectation) => {
          const header = `- ${expectation.method} ${expectation.path} (${expectation.name})`;
          if (expectation.violations.length === 0) {
            return `${header}: held across ${expectation.observed.tests} test(s), ${expectation.observed.exchanges} exchange(s)`;
          }
          return (
            header +
            "\n    " +
            expectation.violations
              .map((violation) => `${violation.expected} — observed ${violation.observed}`)
              .join("\n    ") +
            (expectation.observed.dropped > 0
              ? `\n    … and ${expectation.observed.dropped} exchange(s) the capture refused`
              : "")
          );
        }),
        "",
        "Values never survive a body: only the declared paths a response did NOT carry are recorded.",
      ].join("\n"),
    ),
    structuredContent: {
      runId,
      ...(audit.baseUrl === undefined ? {} : { baseUrl: audit.baseUrl }),
      counts: audit.counts,
      expectations: audit.expectations,
    } as unknown as Record<string, unknown>,
  };
}

async function getAudit(
  store: ArtifactStore,
  args: Record<string, unknown>,
): Promise<ToolCallResult & { isError?: boolean }> {
  const auditPath = args.auditPath;
  if (typeof auditPath !== "string" || auditPath === "") {
    return {
      content: text("auditPath is required; list the audits first with quality_list_audits."),
      isError: true,
    };
  }

  // A refusal is a readable answer, not a crash: the project may simply have
  // nothing there yet. `PathAccessError` still escapes, because the server logs it
  // and answers "Path is not readable" — swallowing that would lose both.
  let audit: A11yAudit;
  try {
    audit = await store.readAudit(auditPath);
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    return { content: text((error as Error).message), isError: true };
  }
  const runId = auditPath.split("/")[0] ?? auditPath;

  return {
    content: text(
      [
        `accessibility audit ${runId} · ${audit.url} · axe-core ${audit.engine.version}`,
        `${audit.counts.violations} violation(s), ${audit.counts.incomplete} undecided, ` +
          `${audit.counts.nodes} node(s) kept`,
        ...[...audit.violations, ...audit.incomplete].map((rule) => {
          const level = rule.impact === null ? "impact unknown" : rule.impact;
          return (
            `- ${rule.id} [${level}]: ${rule.nodes.length} of ${rule.totalNodes} node(s)` +
            (rule.truncated ? " — truncated" : "") +
            (rule.nodes.length === 0
              ? ""
              : "\n    " +
                rule.nodes
                  .slice(0, 3)
                  .map((node) => `${node.html} (${node.target.join(" ")})`)
                  .join("\n    ") +
                (rule.nodes.length > 3 ? `\n    … ${rule.nodes.length - 3} more` : ""))
          );
        }),
      ].join("\n"),
    ),
    structuredContent: {
      runId,
      createdAt: audit.createdAt,
      counts: audit.counts,
      violations: audit.violations,
      incomplete: audit.incomplete,
    } as unknown as Record<string, unknown>,
  };
}
