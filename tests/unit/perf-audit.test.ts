import { expect, test } from "@playwright/test";
import { buildPerfAudit } from "../../src/perf/audit.js";
import { validatePerfAudit } from "../../src/perf/types.js";
import type { PerfCapturePayload } from "../../src/perf/observe.js";

/**
 * The transfer-budget verdict, over measured numbers rather than invented ones.
 *
 * Every byte count here comes from the demo server, measured on 2026-10-18: the home
 * page costs 3 922, the contact page 5 266, the heavy page 526 538, each with a
 * spread of zero across five runs. Invented numbers would make the tests read better
 * and mean nothing.
 *
 * **The largest, not the average** is the rule this file exists to pin. A first
 * version of the browser test loaded the heavy page exactly once, and flipping the
 * producer's maximum to a minimum left it green — with one observation there is no
 * difference between the two. A rule no test can distinguish is a rule no test holds.
 */

const HOME = 3922;
const CONTACT = 5266;
const HEAVY = 526538;
const BUDGET = 20000;

function capture(...pages: { path: string; transferredBytes: number }[]): PerfCapturePayload {
  return {
    schemaVersion: "1.0.0",
    pages: pages.map((page) => ({ ...page, resources: 1 })),
  };
}

function build(payloads: PerfCapturePayload[], paths: string[] = ["/"]) {
  return buildPerfAudit({
    payloads,
    budgets: paths.map((path) => ({ path, maxBytes: BUDGET })),
    baseUrl: "http://127.0.0.1:4311",
    createdAt: "2026-10-18T09:00:00.000Z",
  });
}

test.describe("the verdict", () => {
  test("a page under the budget holds", () => {
    const audit = build([capture({ path: "/", transferredBytes: HOME })]);

    expect(audit.budgets[0]?.measuredBytes).toBe(HOME);
    expect(audit.budgets[0]?.violations).toEqual([]);
    expect(audit.counts.violations).toBe(0);
    expect(audit.counts.passed).toBe(1);
  });

  test("a page over the budget names the path, the budget and the measurement", () => {
    const audit = build([capture({ path: "/", transferredBytes: HEAVY })]);

    // Criterion 2: "a page was slow" is not evidence. All three numbers present.
    expect(audit.budgets[0]?.violations).toEqual([
      {
        kind: "over-budget",
        expected: "at most 20,000 bytes",
        observed: "526,538 bytes, 506,538 over",
        observations: 1,
        tests: 1,
      },
    ]);
  });

  test("one heavy load among light ones is still a breach", () => {
    // The rule the browser test could not pin: three loads of the same path, the
    // last one enormous. A verdict from the average would pass this, and a page that
    // is usually fine is exactly what a regression looks like.
    const audit = build([
      capture({ path: "/", transferredBytes: HOME }),
      capture({ path: "/", transferredBytes: HOME }),
      capture({ path: "/", transferredBytes: HEAVY }),
    ]);

    expect(audit.budgets[0]?.measuredBytes).toBe(HEAVY);
    expect(audit.budgets[0]?.violations[0]?.kind).toBe("over-budget");
  });

  test("a warm second visit does not hide a cold first one", () => {
    // The realistic version of the same rule: a second visit is served from cache
    // and costs almost nothing. Taking the *last* reading, or the smallest, would let
    // a cold-cache regression disappear the moment anyone reloaded.
    const audit = build(
      [
        capture(
          { path: "/heavy", transferredBytes: HEAVY },
          { path: "/heavy", transferredBytes: 729 },
        ),
      ],
      ["/heavy"],
    );

    expect(audit.budgets[0]?.measuredBytes).toBe(HEAVY);
    expect(audit.budgets[0]?.observations).toBe(2);
  });

  test("a budget nothing loaded is a violation, not an absence", () => {
    const audit = build([capture({ path: "/contact", transferredBytes: CONTACT })]);

    // Fail-closed, on the same principle as the API dimension, and kept separate from
    // `over-budget` because the reader's next question differs: did it get heavier,
    // or did nobody look.
    expect(audit.budgets[0]?.measuredBytes).toBeNull();
    expect(audit.budgets[0]?.violations[0]?.kind).toBe("no-observation");
  });

  test("a run with no capture at all says the dimension did not run", () => {
    const audit = build([]);

    expect(audit.counts.tests).toBe(0);
    expect(audit.budgets[0]?.violations[0]?.kind).toBe("no-observation");
  });

  test("each declared path is judged on its own measurements", () => {
    const audit = build(
      [
        capture(
          { path: "/", transferredBytes: HOME },
          { path: "/contact", transferredBytes: CONTACT },
        ),
        capture(
          { path: "/", transferredBytes: HEAVY },
          { path: "/contact", transferredBytes: CONTACT },
        ),
      ],
      ["/", "/contact"],
    );

    expect(audit.budgets.map((budget) => budget.path)).toEqual(["/", "/contact"]);
    expect(audit.budgets[0]?.violations[0]?.kind).toBe("over-budget");
    expect(audit.budgets[1]?.violations).toEqual([]);
    expect(audit.counts.violations).toBe(1);
    expect(audit.counts.passed).toBe(1);
    expect(audit.counts.pages).toBe(2);
  });

  test("two tests are counted as two tests, not as one", () => {
    const audit = build([
      capture({ path: "/", transferredBytes: HOME }),
      capture({ path: "/", transferredBytes: HEAVY }),
    ]);

    expect(audit.budgets[0]?.tests).toBe(2);
    expect(audit.budgets[0]?.violations[0]?.tests).toBe(2);
  });

  test("the artifact the producer writes satisfies its own contract", () => {
    for (const audit of [
      build([capture({ path: "/", transferredBytes: HOME })]),
      build([capture({ path: "/", transferredBytes: HEAVY })]),
      build([]),
      build(
        [
          capture(
            { path: "/", transferredBytes: HOME },
            { path: "/contact", transferredBytes: CONTACT },
          ),
        ],
        ["/", "/contact", "/nowhere"],
      ),
    ]) {
      const verdict = validatePerfAudit(audit);
      expect(verdict.problems, JSON.stringify(verdict.problems)).toEqual([]);
      expect(verdict.valid).toBe(true);
    }
  });

  test("a count that disagrees with the list is refused", () => {
    const audit = build([capture({ path: "/", transferredBytes: HEAVY })]);
    const tampered = { ...audit, counts: { ...audit.counts, violations: 9 } };

    const verdict = validatePerfAudit(tampered);

    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join(" ")).toContain("counts.violations says 9");
  });

  test("the same path declared twice is refused", () => {
    const audit = build([capture({ path: "/", transferredBytes: HOME })]);
    const tampered = { ...audit, budgets: [...audit.budgets, ...audit.budgets] };

    const verdict = validatePerfAudit(tampered);

    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join(" ")).toContain("is declared twice");
  });
});
