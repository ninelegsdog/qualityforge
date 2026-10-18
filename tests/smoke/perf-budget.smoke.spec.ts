import { expect, test } from "../fixtures.js";

/**
 * The transfer budget, against the demo pages, in a real browser.
 *
 * This file exists for the two halves of #42's criterion, and both halves are here
 * rather than one being assumed:
 *
 * - **The ordinary pages are under budget**, and the numbers are printed so a change
 *   in them is visible rather than inferred.
 * - **The deliberately heavy page breaches it**, at 26 times the budget, and the
 *   breach names the metric, the budget and what was measured — which is the second
 *   criterion, and the reason the violation reads the way it does.
 *
 * The heavy page is served by the fixture server rather than faked by a route in
 * this test. A budget that could only catch a stub would be catching the test.
 */

const BUDGET = 20000;

function reading(pages: { path: string; transferredBytes: number }[], path: string) {
  const found = pages.filter((page) => page.path === path);
  return found.reduce((largest, page) => Math.max(largest, page.transferredBytes), 0);
}

test.describe("the transfer budget", () => {
  test("the ordinary pages are well under it", async ({ page, perf }) => {
    // A reading is of the page **as it stands**, not of the history: once the browser
    // has arrived at `/contact` it can no longer say what `/` cost. So a test that
    // visits two pages measures at each — which is also the honest shape of the rule.
    await page.goto("/");
    await expect(page.getByRole("listitem").first()).toBeVisible();
    await perf.measureNow();

    await page.goto("/contact");
    await expect(page.getByRole("heading", { name: "Contact" })).toBeVisible();
    await perf.measureNow();

    const { pages } = perf.toPayload();
    const home = reading(pages, "/");
    const contact = reading(pages, "/contact");

    // Printed, not just asserted: a budget nobody can see the numbers of is a number
    // that drifts until it is wrong.
    console.log(`  transfer: / = ${home} bytes, /contact = ${contact} bytes, budget = ${BUDGET}`);

    expect(home).toBeGreaterThan(0);
    expect(home).toBeLessThan(BUDGET);
    expect(contact).toBeLessThan(BUDGET);
  });

  test("the deliberately heavy page breaches it, by a wide margin", async ({ page, perf }) => {
    // The red half of the criterion, and it is red by a factor rather than by a
    // rounding difference — which is what makes the budget worth having.
    await page.goto("/heavy");
    await expect(page.getByTestId("heavy")).toBeVisible();

    const { pages } = await perf.measureNow().then(() => perf.toPayload());
    const heavy = reading(pages, "/heavy");

    console.log(
      `  transfer: /heavy = ${heavy} bytes, budget = ${BUDGET}, over by ${heavy - BUDGET}`,
    );

    expect(heavy).toBeGreaterThan(BUDGET * 10);
    // And the observation is not an artefact of the observer returning nothing: an
    // absent measurement must be absent, never zero, because zero is under every
    // budget and would make this test pass for the wrong reason.
    expect(heavy).toBeGreaterThan(0);
  });

  test("the largest single contribution is named, so the page is not just 'heavy'", async ({
    page,
    perf,
  }) => {
    // A number says something went up; a URL says what to look at. The heavy page's
    // budget is breached by one 512 KiB resource, and a reader should not have to
    // guess which one.
    await page.goto("/heavy");
    await expect(page.getByTestId("heavy")).toBeVisible();

    const observation =
      (await perf.measureNow()).path === "/heavy" ? perf.toPayload().pages.at(-1) : undefined;

    expect(observation?.largest?.url).toContain("/heavy/payload.bin");
    // And it is the bulk of the page, not a rounding part of it.
    expect(observation?.largest?.bytes ?? 0).toBeGreaterThan(
      (observation?.transferredBytes ?? 0) / 2,
    );
  });
});
