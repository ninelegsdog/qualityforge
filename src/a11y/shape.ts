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
import { redactAssignments } from "../quality/redact.js";
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
    const parsed = new URL(url);
    // `file:` and a few other schemes have no origin, and the platform reports
    // that as the literal string "null". Recording it puts a reader one
    // character away from mistaking it for a missing value; the scheme says the
    // same thing honestly and leaks no filesystem path.
    if (parsed.origin === "null" || parsed.origin === "") return parsed.protocol;
    return parsed.origin;
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
    /**
     * `target` keeps its structure and loses only what is shaped like a secret.
     *
     * The decision was to store `target` at all — without it, 48 nodes of one
     * rule are indistinguishable and "where" is half the message. So its value
     * is not dropped the way `html`'s is: a selector like `#password` is the
     * most useful thing in the artifact.
     *
     * Measured before: the redactor covered 2 of the 6 forms axe builds, and the
     * misses were exactly the ones carrying a token — an id selector, an id with
     * a prefix, an attribute value, an attribute-value tail. The shape rule from
     * PR #68 closed those; this is where it is applied.
     *
     * `redactAssignments` rather than `redactText`, because a selector is not a
     * URL: the URL rule would cut at the `?` of `[href$='/reset?access_token=…']`
     * and truncate the very selector we are trying to keep.
     */
    target: Array.isArray(node.target)
      ? node.target
          .filter((selector): selector is string => typeof selector === "string")
          .map((selector) => redactAssignments(selector))
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
