import { expect, test } from "../fixtures.js";
import { ContactPage, OverviewPage } from "./pages/base-page.js";

/**
 * The page-object reference, exercised against the demo app.
 *
 * The file it imports (pages/base-page.ts) is what consumers are told to copy,
 * so it runs here for the same reason every other claim runs: an example that
 * is only written down rots silently, and the day a selector in it stops
 * matching, a document would be promising something untrue. Break a locator in
 * the page objects and exactly the test that reads it goes red — which is what
 * makes the reference trustworthy.
 */
test.describe("page-object reference", () => {
  test("OverviewPage reads the heading, the status and the entity list", async ({ page }) => {
    const overview = new OverviewPage(page);
    await overview.open();

    await expect(overview.heading).toBeVisible();
    await expect(overview.status).toHaveText("ready");
    await expect(overview.entities).toContainText("AUTH-003");
    await expect(overview.entityItems).toHaveCount(3);
    await expect(overview.entities).not.toContainText("loading…");
  });

  test("BasePage's shared header navigates from any page", async ({ page }) => {
    const contact = new ContactPage(page);
    await contact.open();

    await contact.brand.click();

    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Browser Quality Core" }),
    ).toBeVisible();
  });

  test("ContactPage submits a valid message and reports success", async ({ page }) => {
    const contact = new ContactPage(page);
    await contact.open();

    await contact.submitWith("team@example.com", "Interested in the evidence layer.");

    await expect(contact.success).toHaveText("Message sent");
    await expect(contact.validationError).toBeHidden();
    await expect(contact.email).toHaveValue("");
  });

  test("ContactPage surfaces the first validation problem through the alert", async ({ page }) => {
    const contact = new ContactPage(page);
    await contact.open();

    await contact.submit.click();

    await expect(contact.validationError).toHaveText("Email is required");
    await expect(contact.success).toBeHidden();
  });
});
