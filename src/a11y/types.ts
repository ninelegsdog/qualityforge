/**
 * The accessibility audit artifact: `a11y-audit.v1`.
 *
 * A separate contract from `defect.v1`, on purpose. A defect artifact exists
 * because a test failed; an audit exists whether or not anything failed, so
 * tying one to the other would make every audit look like a defect. Measured
 * on the project's own pages: three routes, **zero** violations, and 33 bytes
 * of diagnostic content out of ~55 000 — which is also why the artifact is
 * never allowed to carry axe's raw answer, where `passes` and `inapplicable`
 * account for 99% of the bytes.
 *
 * Contract rules, as for `defect.v1`: validate before writing, fail closed on
 * unknown input, and version any breaking change.
 */

export const A11Y_AUDIT_SCHEMA_VERSION = "1.0.0" as const;

/** What one axe node becomes after shaping. */
export interface A11yNode {
  /** CSS selectors axe built to reach the element. Stored: without it, nodes of one rule are indistinguishable. */
  target: string[];
  /** Tag and attribute names only — never a value, never text. See `elementShape()`. */
  html: string;
  /** axe's own prose about the failure. Measured to carry no page content in any observation. */
  failureSummary: string;
}

/** One axe rule after shaping, with the cap and the count that the cap hides. */
export interface A11yViolation {
  id: string;
  /** `null` is carried through as `null`: "we could not tell" must not read as "it passed". */
  impact: "critical" | "serious" | "moderate" | "minor" | null;
  nodes: A11yNode[];
  /** How many nodes the rule really produced. The cap is visible or it is a silent loss. */
  totalNodes: number;
  /** True when `totalNodes` exceeds `nodes.length`. */
  truncated: boolean;
}

export interface A11yAudit {
  schemaVersion: string;
  /** Origin only. A path or query string here would carry whatever the page put there. */
  url: string;
  createdAt: string;
  engine: { name: string; version: string };
  counts: {
    violations: number;
    incomplete: number;
    nodes: number;
    truncatedRules: number;
  };
  violations: A11yViolation[];
  /** Rules axe could not decide. Same shape as a violation; kept apart because it is not the same claim. */
  incomplete: A11yViolation[];
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const IMPACTS = new Set(["critical", "serious", "moderate", "minor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Render an unknown value for a problem message.
 *
 * `String(value)` on an `unknown` would print `[object Object]` for anything
 * structural, which is a message that cannot be acted on — the whole point of
 * naming a field is that the reader knows what to fix.
 */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  return Object.prototype.toString.call(value);
}

/**
 * Validate an audit before it reaches disk.
 *
 * The rule this encodes is the project's: **if validation fails, fix the
 * producer rather than relaxing the contract.** Every problem is reported, not
 * just the first — a validator that stops at the first one makes fixing slower
 * without making it safer.
 */
export function validateAudit(value: unknown): ValidationResult {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, problems: ["artifact must be a JSON object"] };
  }

  if (typeof value.schemaVersion !== "string" || !SEMVER.test(value.schemaVersion)) {
    problems.push(`schemaVersion must be a semver string, got ${String(value.schemaVersion)}`);
  }
  const url = value.url;
  if (typeof url !== "string" || url.length === 0) {
    problems.push("url must be a non-empty string");
  }
  if (typeof url === "string" && /[?#]/.test(url)) {
    problems.push(`url must be an origin without query or fragment, got ${show(url)}`);
  }
  const createdAt = value.createdAt;
  if (typeof createdAt !== "string" || !ISO_DATE_TIME.test(createdAt)) {
    problems.push(`createdAt must be an ISO-8601 UTC instant, got ${show(createdAt)}`);
  }

  const engine = value.engine;
  if (!isRecord(engine)) {
    problems.push("engine must be an object with name and version");
  } else {
    if (typeof engine.name !== "string" || engine.name.length === 0) {
      problems.push("engine.name must be a non-empty string");
    }
    if (typeof engine.version !== "string" || engine.version.length === 0) {
      problems.push("engine.version must be a non-empty string");
    }
  }

  for (const key of ["violations", "incomplete"] as const) {
    const list = value[key];
    if (!Array.isArray(list)) {
      problems.push(`${key} must be an array`);
      continue;
    }
    for (const [index, rule] of list.entries()) {
      problems.push(...validateRule(`${key}[${index}]`, rule));
    }
  }

  const counts = value.counts;
  if (!isRecord(counts)) {
    problems.push("counts must be an object");
  } else {
    for (const key of ["violations", "incomplete", "nodes", "truncatedRules"]) {
      const n = counts[key];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        problems.push(`counts.${key} must be a non-negative integer, got ${String(n)}`);
      }
    }
  }

  return { valid: problems.length === 0, problems };
}

function validateRule(path: string, rule: unknown): string[] {
  const problems: string[] = [];

  if (!isRecord(rule)) {
    return [`${path} must be an object`];
  }
  if (typeof rule.id !== "string" || rule.id.length === 0) {
    problems.push(`${path}.id must be a non-empty string`);
  }
  if (rule.impact !== null && (typeof rule.impact !== "string" || !IMPACTS.has(rule.impact))) {
    problems.push(`${path}.impact must be a known level or null, got ${show(rule.impact)}`);
  }
  if (
    typeof rule.totalNodes !== "number" ||
    !Number.isInteger(rule.totalNodes) ||
    rule.totalNodes < 0
  ) {
    problems.push(
      `${path}.totalNodes must be a non-negative integer, got ${show(rule.totalNodes)}`,
    );
  }
  if (typeof rule.truncated !== "boolean") {
    problems.push(`${path}.truncated must be a boolean`);
  }

  if (!Array.isArray(rule.nodes)) {
    problems.push(`${path}.nodes must be an array`);
    return problems;
  }
  const totalNodes = rule.totalNodes;
  if (typeof totalNodes === "number" && totalNodes < rule.nodes.length) {
    problems.push(
      `${path}.totalNodes (${totalNodes}) is below the nodes kept (${rule.nodes.length})`,
    );
  }
  if (typeof rule.truncated === "boolean" && typeof totalNodes === "number") {
    if (rule.truncated !== rule.nodes.length < totalNodes) {
      problems.push(`${path}.truncated disagrees with totalNodes`);
    }
  }

  for (const [index, node] of rule.nodes.entries()) {
    if (!isRecord(node)) {
      problems.push(`${path}.nodes[${index}] must be an object`);
      continue;
    }
    if (!Array.isArray(node.target) || node.target.some((t) => typeof t !== "string")) {
      problems.push(`${path}.nodes[${index}].target must be an array of strings`);
    }
    if (typeof node.html !== "string" || node.html.length === 0) {
      problems.push(`${path}.nodes[${index}].html must be a non-empty string`);
    }
    if (typeof node.failureSummary !== "string") {
      problems.push(`${path}.nodes[${index}].failureSummary must be a string`);
    }
  }

  return problems;
}
