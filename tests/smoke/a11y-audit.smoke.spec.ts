import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.js";
import { shapeAudit, type RawAxeResult } from "../../src/a11y/shape.js";
import { validateAudit } from "../../src/a11y/types.js";

/**
 * The shaping rules, against the real `axe-core`.
 *
 * The unit tests in `tests/unit/a11y-*.test.ts` feed `shapeAudit()` a fixture
 * written by the same hand that wrote the code, so they agree with it by
 * construction — they prove the function drops what it is told to drop, and
 * nothing about `axe-core`. This file is what closes that gap: it runs the
 * published engine in a real browser and shapes whatever it actually returns.
 *
 * That matters because the premise under test is a claim about someone else's
 * output: that `node.html` carries page content. If `axe-core` changed that,
 * these tests would be asserting against a fiction while still green.
 *
 * So the first test asserts the opposite direction — the raw engine output
 * *does* carry the token. Every other assertion here is worthless without it.
 *
 * The page is the project's own fixtures app. No third-party host is involved:
 * a test that depends on somebody else's uptime is a test that will lie to us
 * one day.
 */

/**
 * This project compiles without the DOM lib, which is correct for Node code and
 * wrong for anything that has to reason about a browser. `document` and `axe`
 * are spelled out for the same reason `evidence-capture` spells out
 * `navigator`.
 */
interface AxeEngine {
  run: (context: unknown) => Promise<unknown>;
}

interface Browser {
  document: { body: { insertAdjacentHTML(position: string, markup: string): void } };
  axe: AxeEngine;
}

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const TOKEN = "ghp_Zx8sTR0secretTOKENvalue";

/** Nine positions a real page carried a token in, measured one run per position. */
async function injectTokenAndDefects(page: Page): Promise<void> {
  await page.evaluate((token: string) => {
    const { document } = globalThis as unknown as Browser;
    document.body.insertAdjacentHTML(
      "beforeend",
      `
      <button onclick="send('${token}')"></button>
      <img src="/a.png" alt="pic" data-token="${token}">
      <input type="text" id="probe-${token}" value="${token}">
      <a href="/x?access_token=${token}">link</a>
      <img src="/b.png?token=${token}" alt="q">
      <div title="${token}">titled</div>
      <span aria-label="${token}">aria</span>
      <div>text token: ${token}</div>
      <div id="dup-a"></div><div id="dup-b"></div>
    `,
    );
  }, TOKEN);
}

async function runAxe(page: Page): Promise<RawAxeResult> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const { axe, document } = globalThis as unknown as Browser;
    return (await axe.run(document)) as RawAxeResult;
  });
}

test.describe("a11y shaping against the real axe-core", () => {
  test("the engine really does put page content into node.html", async ({ page }) => {
    await page.goto("/");
    await injectTokenAndDefects(page);
    const raw = await runAxe(page);
    const html = JSON.stringify(raw.violations ?? []);

    // The premise. If this stops holding, the rule "keep the structure, drop
    // the content" is defending against nothing, and the tests below would be
    // passing for the wrong reason.
    expect(html.length).toBeGreaterThan(0);
    expect(html, "axe-core must be putting the injected token into its answer").toContain(TOKEN);
  });

  test("nothing the engine put in node.html survives into the artifact", async ({ page }) => {
    await page.goto("/");
    await injectTokenAndDefects(page);
    const raw = await runAxe(page);
    const audit = shapeAudit(raw);
    const shapes = [...audit.violations, ...audit.incomplete].flatMap((rule) =>
      rule.nodes.map((n) => n.html),
    );

    expect(JSON.stringify(raw.violations ?? [])).toContain(TOKEN);
    expect(shapes.join("\n"), "shaped html must not carry the token").not.toContain(TOKEN);
  });

  test("the whole artifact is clean, not only its html", async ({ page }) => {
    // Expected to fail today, and writing it is the point.
    //
    // Decision 4 is implemented: `html` keeps structure and loses values and
    // text, and the test above proves that against the real engine. Decision 3
    // is not: `target` is stored, and the redactor covers only two of the six
    // selector forms axe builds, so a token in an element `id` reaches `target`
    // intact. Measured, not assumed — 2 of 6 forms covered — and the editor fix
    // is separate work by decision.
    //
    // So this test states the goal and currently fails at exactly that gap.
    // The day the editor is taught the selector forms it will pass, and
    // Playwright will report an expected failure that passed unexpectedly,
    // which is the signal to update the decisions note rather than to relax
    // anything here.
    test.fail(true, "target carries the token until decision 3's editor fix lands");

    await page.goto("/");
    await injectTokenAndDefects(page);
    const audit = shapeAudit(await runAxe(page));

    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  test("html keeps the structure and loses the values", async ({ page }) => {
    await page.goto("/");
    await injectTokenAndDefects(page);
    const audit = shapeAudit(await runAxe(page));
    const shapes = audit.violations.flatMap((rule) => rule.nodes.map((node) => node.html));

    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes.some((shape) => shape.includes("<"))).toBe(true);
    expect(shapes.some((shape) => shape.includes("onclick"))).toBe(true);
  });

  test("a cap that fires says how much it dropped", async ({ page }) => {
    await page.goto("/");
    await injectTokenAndDefects(page);
    const raw = await runAxe(page);

    // One node of one rule on this page: enough to prove the bookkeeping holds
    // against real output, without pretending the fixture can produce the 48
    // nodes a real third-party page does.
    const shaped = shapeAudit(raw, { maxNodesPerRule: 1 });
    const capped = [...shaped.violations, ...shaped.incomplete].filter(
      (rule) => rule.totalNodes > 1,
    );

    expect(capped.length).toBeGreaterThan(0);
    for (const rule of capped) {
      expect(rule.nodes).toHaveLength(1);
      expect(rule.truncated).toBe(true);
    }
  });

  test("what comes out passes its own validation", async ({ page }) => {
    await page.goto("/");
    await injectTokenAndDefects(page);
    const audit = shapeAudit(await runAxe(page));

    expect(validateAudit(audit)).toEqual({ valid: true, problems: [] });
    expect(audit.schemaVersion).toBe("1.0.0");
    expect(audit.engine.name).toBe("axe-core");
  });
});
