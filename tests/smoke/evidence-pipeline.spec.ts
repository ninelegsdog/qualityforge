import { expect, test } from "@playwright/test";

/**
 * Evidence pipeline check.
 *
 * This suite contains a deliberately failing assertion. It exists to prove that
 * a failure really produces trace, screenshot and video — the whole promise of
 * the project. It is skipped unless explicitly requested, so CI stays green.
 *
 * Run it with:
 *   QUALITYFORGE_EVIDENCE_CHECK=1 npx playwright test tests/smoke/evidence-pipeline.spec.ts
 *
 * There is deliberately no npm script for this: a portable one would need
 * `cross-env`, and a new dependency is not worth a convenience alias.
 *
 * Then inspect test-results/ for the screenshot, and open the report for the
 * trace. The run exits non-zero by design.
 */
const ENABLED = process.env.QUALITYFORGE_EVIDENCE_CHECK === "1";

test.describe("evidence pipeline", () => {
  test.skip(!ENABLED, "set QUALITYFORGE_EVIDENCE_CHECK=1 to run the deliberate failure");

  test("a failing assertion still captures evidence", async ({ page }) => {
    await page.goto("/");

    // This can never pass: the demo app renders "ready". The failure is the point.
    await expect(page.getByTestId("status")).toHaveText("a value the app never produces");
  });

  test("a failing navigation still captures evidence", async ({ page }) => {
    // Proves the capture path is not specific to one kind of assertion.
    await page.goto("/");
    await expect(page).toHaveURL(/\/a-url-the-demo-app-never-serves/);
  });
});
