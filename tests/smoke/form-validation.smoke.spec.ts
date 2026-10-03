import { expect, test } from "../fixtures.js";

/**
 * Contact form validation.
 *
 * Controls are located by their label and messages by their alert role, so the
 * tests survive a restyle. The happy path matters as much as the error path:
 * a form that always shows an error would pass only the negative tests.
 */
test.describe("contact form validation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/contact");
  });

  test("shows an error when email is empty", async ({ page }) => {
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("alert")).toHaveText("Email is required");
    await expect(page.getByRole("status")).toBeHidden();
  });

  test("shows an error when email is malformed", async ({ page }) => {
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("alert")).toHaveText("Enter a valid email address");
  });

  test("shows an error when the message is missing", async ({ page }) => {
    await page.getByLabel("Email").fill("team@example.com");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("alert")).toHaveText("Message is required");
  });

  test("accepts a valid submission and clears the form", async ({ page }) => {
    await page.getByLabel("Email").fill("team@example.com");
    await page.getByLabel("Message").fill("Interested in the evidence layer.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("status")).toHaveText("Message sent");
    await expect(page.getByRole("alert")).toBeHidden();
    await expect(page.getByLabel("Email")).toHaveValue("");
  });

  test("recovers after a failed submission is corrected", async ({ page }) => {
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("alert")).toHaveText("Email is required");

    await page.getByLabel("Email").fill("team@example.com");
    await page.getByLabel("Message").fill("Second attempt.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("status")).toHaveText("Message sent");
    await expect(page.getByRole("alert")).toBeHidden();
  });
});
