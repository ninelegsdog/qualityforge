import { expect, test } from "@playwright/test";

/**
 * Day 1 smoke test.
 *
 * Deliberately asserts only user-visible behaviour: what a person opening the
 * page would see. Nothing here depends on CSS classes or DOM structure, so a
 * restyle cannot break it.
 */
test.describe("homepage", () => {
  test("renders the product name and a ready status", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/QualityForge/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("QualityForge");
    await expect(page.getByTestId("status")).toHaveText("ready");
  });

  test("is served over HTTP and reports a healthy response", async ({ request }) => {
    const response = await request.get("/");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
  });

  test("returns 404 for a path that does not exist", async ({ request }) => {
    const response = await request.get("/definitely-not-here");

    expect(response.status()).toBe(404);
  });
});
