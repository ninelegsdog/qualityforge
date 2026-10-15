import { expect, test } from "@playwright/test";
import {
  MAX_NODES_PER_RULE,
  originOf,
  shapeAudit,
  type RawAxeResult,
} from "../../src/a11y/shape.js";
import { validateAudit } from "../../src/a11y/types.js";

/**
 * Decisions 1, 2 and 4 in one place: what is kept, what is capped, and what
 * says so out loud.
 *
 * The cap is the interesting one. Ten nodes were chosen because nodes of one
 * rule repeat the same defect, and a rule measured 48 nodes on a real page — so
 * the cap is not decorative. What makes it safe is that the discarded count
 * travels with the kept ones: `totalNodes` and `truncated`. A cap that does not
 * announce itself is the silent loss this project forbids.
 */

function nodes(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    html: `<div id="n${i}" title="secret">text</div>`,
    target: [`#n${i}`],
    failureSummary: "Fix any of the following: something is wrong",
  }));
}

const ONE_RULE: RawAxeResult = {
  testEngine: { name: "axe-core", version: "4.14.0" },
  url: "https://quotes.toscrape.com/login?next=%2Fadmin#form",
  violations: [{ id: "color-contrast", impact: "serious", nodes: nodes(48) }],
  incomplete: [],
};

test.describe("shapeAudit", () => {
  test("caps the nodes of a rule and says how many there were", () => {
    const audit = shapeAudit(ONE_RULE);
    const rule = audit.violations[0];
    if (!rule) throw new Error("the fixture must produce one rule");

    expect(rule.nodes).toHaveLength(MAX_NODES_PER_RULE);
    expect(rule.totalNodes).toBe(48);
    expect(rule.truncated).toBe(true);
    expect(audit.counts.nodes).toBe(MAX_NODES_PER_RULE);
    expect(audit.counts.truncatedRules).toBe(1);
  });

  test("a rule inside the cap is not marked truncated", () => {
    const audit = shapeAudit({
      violations: [{ id: "region", impact: "moderate", nodes: nodes(3) }],
    });

    expect(audit.violations[0]?.truncated).toBe(false);
    expect(audit.violations[0]?.totalNodes).toBe(3);
    expect(audit.counts.truncatedRules).toBe(0);
  });

  test("an unknown impact stays null rather than becoming minor", () => {
    const audit = shapeAudit({
      violations: [{ id: "x", impact: "catastrophic", nodes: nodes(1) }],
    });

    // Fail closed: `null` reads as "we could not tell". Reading it as a level
    // would invent a severity nobody observed.
    expect(audit.violations[0]?.impact).toBeNull();
  });

  test("records the origin and drops the path and query", () => {
    expect(originOf("https://example.com/a/b?token=x#y")).toBe("https://example.com");
    expect(originOf("not a url")).toBe("unknown");
    expect(shapeAudit(ONE_RULE).url).toBe("https://quotes.toscrape.com");
  });

  test("passes and inapplicable never reach the artifact", () => {
    const raw = {
      ...ONE_RULE,
      passes: [{ id: "region", nodes: nodes(500) }],
      inapplicable: [{ id: "color-contrast", nodes: nodes(500) }],
    } as unknown as RawAxeResult;

    const audit = shapeAudit(raw);

    expect(Object.keys(audit)).not.toContain("passes");
    expect(Object.keys(audit)).not.toContain("inapplicable");
    expect(JSON.stringify(audit).length).toBeLessThan(10_000);
  });

  test("a rule with no nodes is kept, not dropped", () => {
    const audit = shapeAudit({ violations: [{ id: "empty", nodes: [] }] });

    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]?.totalNodes).toBe(0);
  });
});

test.describe("validateAudit", () => {
  test("accepts what shapeAudit produced", () => {
    expect(validateAudit(shapeAudit(ONE_RULE))).toEqual({ valid: true, problems: [] });
  });

  test("rejects a cap that hides more than it admits", () => {
    const audit = shapeAudit(ONE_RULE);
    const rule = audit.violations[0];
    if (!rule) throw new Error("the fixture must produce one rule");
    rule.totalNodes = 2;

    const result = validateAudit(audit);

    expect(result.valid).toBe(false);
    expect(result.problems.join("\n")).toContain("totalNodes");
  });

  test("rejects a truncated flag that disagrees with the counts", () => {
    const audit = shapeAudit(ONE_RULE);
    const rule = audit.violations[0];
    if (!rule) throw new Error("the fixture must produce one rule");
    rule.truncated = false;

    expect(validateAudit(audit).problems.join("\n")).toContain("truncated disagrees");
  });

  test("rejects a url carrying a query, which is where a token would ride", () => {
    const audit = shapeAudit(ONE_RULE);
    audit.url = "https://quotes.toscrape.com/?access_token=ghp_x";

    expect(validateAudit(audit).problems.join("\n")).toContain("origin without query");
  });

  test("reports every problem rather than the first", () => {
    const result = validateAudit({ schemaVersion: "one", url: "", createdAt: "yesterday" });

    expect(result.valid).toBe(false);
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});
