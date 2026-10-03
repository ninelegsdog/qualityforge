import { expect, test } from "../fixtures.js";

/**
 * Navigation between the demo pages.
 *
 * The point of these tests is the journey, not the destination: that the link
 * is reachable by its accessible name and that the URL actually changes.
 */
test.describe("navigation", () => {
  test("user reaches the documentation from the overview", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("link", { name: "Documentation" }).click();

    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
  });

  test("user returns to the overview from the documentation", async ({ page }) => {
    await page.goto("/docs");

    await page.getByRole("link", { name: "Back to overview" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Browser Quality Core" }),
    ).toBeVisible();
  });

  test("user reaches the contact form from the overview", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("link", { name: "Contact" }).click();

    await expect(page).toHaveURL(/\/contact$/);
    await expect(page.getByRole("heading", { level: 1, name: "Contact" })).toBeVisible();
  });

  test("documentation can be opened directly by URL", async ({ page }) => {
    await page.goto("/docs");

    await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
  });
});
