import { expect, test } from "@playwright/test";

/**
 * Overview page: renders, is healthy, reports a 404 for unknown paths.
 *
 * Selectors follow the project policy: role first, then label, then text, and
 * data-testid only when nothing user-visible identifies the element.
 */
test.describe("overview page", () => {
  test("renders the product heading and a ready status", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/QualityForge/i);
    await expect(
      page.getByRole("heading", { level: 1, name: "Browser Quality Core" }),
    ).toBeVisible();
    await expect(page.getByTestId("status")).toHaveText("ready");
  });

  test("renders the monitored entity list returned by the API", async ({ page }) => {
    await page.goto("/");

    // Auto-retrying assertion on user-visible text. No sleep, no fixed wait:
    // the assertion itself waits for the fetch to resolve and render.
    await expect(page.getByTestId("entities")).toContainText("AUTH-003");
    await expect(page.getByTestId("entity")).toHaveCount(3);
    await expect(page.getByTestId("entities")).not.toContainText("loading…");
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
