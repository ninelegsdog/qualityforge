import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { shapeAudit, type RawAxeResult } from "../../src/a11y/shape.js";
import { validateAudit } from "../../src/a11y/types.js";

/**
 * The published JSON Schema, against what the producer actually writes.
 *
 * `validateAudit()` checks the artifact at runtime and this schema is what a
 * consumer validates against. Nothing connected the two, which means the schema
 * could describe a shape the producer stopped writing while every existing check
 * stayed green — the class of drift this repository keeps being bitten by, in
 * cheaper forms.
 *
 * So the schema is used here as what it is for: a real validator, over a real
 * artifact, produced by the real shaper. The negative cases are the half that
 * matters — a schema that accepts everything also "validates" an artifact that
 * hides what it dropped, which is the failure the cap exists to prevent.
 */

const require = createRequire(import.meta.url);

/**
 * The 2020-12 build, not the default one.
 *
 * The schema is written in the same dialect as `defect.v1.schema.json`, and
 * ajv's default export is draft-07 — compiling a 2020-12 schema with it fails on
 * `$defs` before a single assertion runs, which is a confusing way to learn that
 * the version matters.
 */
const ajv2020 = require("ajv/dist/2020.js") as {
  default: new (options: { allErrors: boolean; strict: boolean }) => {
    compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown[] };
  };
};

const schema = JSON.parse(
  readFileSync(path.join(process.cwd(), "schemas", "a11y-audit.v1.schema.json"), "utf8"),
) as unknown;

const validate = new ajv2020.default({ allErrors: true, strict: true }).compile(schema);

const REAL: RawAxeResult = {
  testEngine: { name: "axe-core", version: "4.14.0" },
  url: "https://quotes.toscrape.com/login?next=%2Fadmin#form",
  violations: [
    {
      id: "color-contrast",
      impact: "serious",
      nodes: Array.from({ length: 48 }, (_, i) => ({
        html: `<span class="q" title="secret">text token</span>`,
        target: [`.quote:nth-child(${i + 1}) > span`],
        failureSummary: "Fix any of the following: element has insufficient contrast",
      })),
    },
    { id: "unknown-rule", impact: "unheard-of", nodes: [] },
  ],
  incomplete: [{ id: "color-contrast", impact: null, nodes: [] }],
};

test.describe("a11y-audit.v1.schema.json", () => {
  test("accepts what the producer writes", () => {
    const audit = shapeAudit(REAL);

    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(validate(audit)).toBe(true);
  });

  test("the cap invariant lives in the runtime validator, not in the schema", () => {
    const audit = shapeAudit(REAL);
    (audit.violations[0] as { totalNodes: number }).totalNodes = 1;

    /**
     * A schema describes one value at a time and cannot say "`totalNodes` is at
     * least as large as `nodes.length`". The first version of this test asserted
     * that it could, and failed — which is the useful part: it is exactly why
     * `validateAudit()` exists next to this schema, and why the audit is checked
     * before it is written rather than trusted afterwards.
     *
     * So the boundary is pinned rather than wished for: the schema accepts what
     * it cannot express, and the runtime validator refuses it.
     */
    expect(validate(audit)).toBe(true);
    expect(validateAudit(audit).problems.join("\n")).toContain("totalNodes");
  });

  test("rejects a url carrying a query, which is where a token would ride", () => {
    const audit = shapeAudit(REAL);
    audit.url = "https://quotes.toscrape.com/login?access_token=ghp_x";

    expect(validate(audit)).toBe(false);
  });

  test("rejects an impact level the engine never said", () => {
    const audit = shapeAudit(REAL);
    (audit.violations[1] as { impact: string }).impact = "catastrophic";

    expect(validate(audit)).toBe(false);
  });

  test("rejects a field nobody declared", () => {
    const audit = { ...shapeAudit(REAL), surprise: true };

    expect(validate(audit)).toBe(false);
  });
});
