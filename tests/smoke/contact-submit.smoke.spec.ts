import { expect, test } from "../fixtures.js";
import { ContactPage } from "./pages/base-page.js";

/**
 * The contact form, as far as delivery is concerned.
 *
 * This file exists for one claim: **the confirmation is the server's verdict.**
 * The form used to announce "Message sent" without a request ever leaving the
 * page, so the happy-path tests in `form-validation.smoke.spec.ts` were asserting
 * that a browser could render a string — true, and worth nothing.
 *
 * That is why there is no positive test here. A stubbed failure is what proves
 * the positive path: if the endpoint were never called, no stub could produce an
 * error, and the confirmation would be unreachable rather than untested.
 *
 * Nothing here asserts on the request that was sent. What the application sends
 * is an evidence dimension of its own (#43) and is checked there; these tests
 * check only what a user sees.
 */
test.describe("contact form delivery", () => {
  test("does not confirm a message the server rejected", async ({ page, api, visual }) => {
    // This test breaks a declared endpoint on purpose, so its exchange is evidence
    // about the stub and not about the application's contract.
    api.markStubbed();
    visual.markStubbed();
    await page.route("**/api/contact", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
    );

    const contact = new ContactPage(page);
    await contact.open();
    await contact.submitWith("team@example.com", "Interested in the evidence layer.");

    await expect(contact.validationError).toHaveText("The message could not be sent. Try again.");
    await expect(contact.success).toBeHidden();
    // The message survives a failed send, so a retry needs no retyping.
    await expect(contact.message).toHaveValue("Interested in the evidence layer.");
  });

  test("does not confirm a message that never reached a server", async ({ page, api, visual }) => {
    api.markStubbed();
    visual.markStubbed();
    await page.route("**/api/contact", (route) => route.abort("failed"));

    const contact = new ContactPage(page);
    await contact.open();
    await contact.submitWith("team@example.com", "Interested in the evidence layer.");

    await expect(contact.validationError).toHaveText("The message could not be sent. Try again.");
    await expect(contact.success).toBeHidden();
  });
});
