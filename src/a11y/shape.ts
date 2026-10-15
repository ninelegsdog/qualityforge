/**
 * From axe's answer to an artifact.
 *
 * Two decisions are implemented here, both measured rather than assumed.
 *
 * **Keep `violations` and `incomplete`, drop `passes` and `inapplicable`.** On a
 * real page those last two were 99% of the bytes: on the project's own `/`,
 * `violations + incomplete` came to 33 bytes out of 53 147. An artifact is read
 * by a language model, so carrying them spends the context window on rules that
 * passed.
 *
 * **Cap the nodes of one rule, and say how many there were.** A single rule
 * produced 48 nodes on one real page — `color-contrast`, 18 460 bytes after
 * compression — so uncapped one rule eats the artifact. Ten is enough to see
 * the pattern, because nodes of one rule repeat the same defect. But a silent
 * "there were 48, here are 10" is the class of quiet loss the project forbids,
 * so `totalNodes` and `truncated` travel with every rule.
 *
 * `target` is stored, and `html` only as structure — both are decisions of the
 * owner, recorded in `docs/roadmap.md`.
 */

import { elementShape } from "./html.js";
import type { A11yAudit, A11yNode, A11yViolation } from "./types.js";
import { A11Y_AUDIT_SCHEMA_VERSION } from "./types.js";

/** Nodes kept per rule. The rest are counted, not discarded silently. */
export const MAX_NODES_PER_RULE = 10;

type Impact = "critical" | "serious" | "moderate" | "minor" | null;

export interface RawAxeNode {
  html?: string;
  target?: string[];
  failureSummary?: string;
}

export interface RawAxeRule {
  id: string;
  impact?: string | null;
  nodes?: RawAxeNode[];
}

export interface RawAxeResult {
  testEngine?: { name?: string; version?: string };
  url?: string;
  violations?: RawAxeRule[];
  incomplete?: RawAxeRule[];
}

export interface ShapeOptions {
  /** Explicit so a caller — or a test — can state the cap rather than inherit it. */
  maxNodesPerRule?: number;
  now?: Date;
}

/** Origin only: a path or query string carries whatever the page put there. */
export function originOf(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).origin;
  } catch {
    return "unknown";
  }
}

/** Fail closed: an unrecognised level is not "minor", and `null` must not read as "it passed". */
function normaliseImpact(value: string | null | undefined): Impact {
  if (value === "critical" || value === "serious" || value === "moderate" || value === "minor")
    return value;
  return null;
}

function shapeNode(node: RawAxeNode): A11yNode {
  return {
    target: Array.isArray(node.target)
      ? node.target.filter((t): t is string => typeof t === "string")
      : [],
    html: elementShape(node.html ?? ""),
    failureSummary: node.failureSummary ?? "",
  };
}

function shapeRule(rule: RawAxeRule, limit: number): A11yViolation {
  const all = Array.isArray(rule.nodes) ? rule.nodes : [];
  const kept = all.slice(0, limit);
  return {
    id: rule.id,
    impact: normaliseImpact(rule.impact),
    nodes: kept.map(shapeNode),
    totalNodes: all.length,
    truncated: all.length > kept.length,
  };
}

export function shapeAudit(result: RawAxeResult, options: ShapeOptions = {}): A11yAudit {
  const limit = options.maxNodesPerRule ?? MAX_NODES_PER_RULE;
  const violations = (result.violations ?? []).map((rule) => shapeRule(rule, limit));
  const incomplete = (result.incomplete ?? []).map((rule) => shapeRule(rule, limit));
  const all = [...violations, ...incomplete];

  return {
    schemaVersion: A11Y_AUDIT_SCHEMA_VERSION,
    url: originOf(result.url),
    createdAt: (options.now ?? new Date()).toISOString(),
    engine: {
      name: result.testEngine?.name ?? "unknown",
      version: result.testEngine?.version ?? "unknown",
    },
    counts: {
      violations: violations.length,
      incomplete: incomplete.length,
      nodes: all.reduce((sum, rule) => sum + rule.nodes.length, 0),
      truncatedRules: all.filter((rule) => rule.truncated).length,
    },
    violations,
    incomplete,
  };
}
