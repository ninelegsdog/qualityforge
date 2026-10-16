import { expect, test } from "../fixtures.js";
import type { ApiCapturePayload } from "../../src/api/observe.js";

/**
 * API capture against the demo app, in a real browser.
 *
 * The unit tests in `tests/unit/api-observe.test.ts` feed `missingFields` a body
 * they wrote themselves, so they agree with it by construction. This file is what
 * closes that gap: it runs against what the fixture server actually sent, over a
 * real `fetch`, and reads the payload the collector will eventually read.
 *
 * Three claims are load-bearing, and each is asserted on the payload rather than
 * on a helper:
 *
 * - **The declared expectations are the ones that matched.** The project declares
 *   two; a third exchange happens on every page load and must not appear.
 * - **No value survives.** The contact endpoint is handed a recognisable string
 *   and the whole payload is read looking for it.
 * - **An expectation nothing matched is still reported, with zero.** That is the
 *   fail-closed case, and it is only derivable because the payload lists every
 *   declaration rather than only what was seen.
 */
function observationFor(payload: ApiCapturePayload, name: string) {
  const found = payload.expectations.find((expectation) => expectation.name === name);
  expect(found, `no observation for ${name}`).toBeDefined();
  return found!;
}

test.describe("API capture", () => {
  test("reports only the exchanges the configuration declared", async ({ page, api }) => {
    await page.goto("/");
    await expect(page.getByRole("listitem").first()).toBeVisible();

    const payload = api.toPayload();
    const items = observationFor(payload, "items-are-json");

    expect(items.observed).toBeGreaterThan(0);
    expect(items.exchanges.length).toBe(items.observed);
    expect(items.dropped).toBe(0);

    // Every other exchange on the page - the document, the stylesheet, the script
    // - is traffic this project declared nothing about, so none of it is here.
    for (const exchange of items.exchanges) {
      expect(items.path).toBe("/api/items");
      expect(exchange.status).toBe(200);
      expect(exchange.contentType).toBe("application/json");
      expect(exchange.responseMissing).toEqual([]);
      expect(exchange.requestMissing).toEqual([]);
    }
  });

  test("reports an expectation nothing matched, with zero rather than absent", async ({
    page,
    api,
  }) => {
    // `/contact` is not visited: the POST expectation has nothing to match. An
    // expectation that vanished from the payload could not be told apart from one
    // that was never declared, and the first is the failure this dimension exists
    // to catch.
    await page.goto("/");

    const contact = observationFor(api.toPayload(), "contact-is-posted-and-accepted");
    expect(contact.observed).toBe(0);
    expect(contact.exchanges).toEqual([]);
    expect(contact.dropped).toBe(0);
  });

  test("keeps no value from either body", async ({ page, api }) => {
    // A canary that is both a valid address — the form refuses to send an invalid
    // one, so a "secret" that fails validation would prove nothing — and a string
    // that cannot appear by accident.
    const canary = "leak-canary-7f3a@example.com";
    await page.goto("/contact");
    await page.getByLabel("Email").fill(canary);
    await page.getByLabel("Message").fill(canary);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("status")).toHaveText("Message sent");

    const payload = api.toPayload();
    const contact = observationFor(payload, "contact-is-posted-and-accepted");

    expect(contact.observed).toBe(1);
    expect(contact.exchanges[0]?.requestMissing).toEqual([]);
    expect(contact.exchanges[0]?.responseMissing).toEqual([]);

    const whole = JSON.stringify(payload);
    expect(whole, "the capture kept a value from a body").not.toContain(canary);
    expect(whole).not.toContain("leak-canary");
  });

  test("records the origin the exchange went to, so attribution can be weighed", async ({
    page,
    api,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("listitem").first()).toBeVisible();

    const items = observationFor(api.toPayload(), "items-are-json");
    expect(items.exchanges[0]?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("reports a body it could not walk rather than an empty answer", async ({ page, api }) => {
    // A JSON endpoint answering something else: the declared fields cannot be
    // present, and fail-closed says say so rather than stay silent.
    await page.route("**/api/items", (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "not json" }),
    );
    await page.goto("/");
    // The payload can only be read once the exchange has happened: reading it
    // straight after goto() reported zero observations, because the fetch had not
    // started yet.
    await expect(page.getByRole("listitem").first()).toBeVisible();

    const items = observationFor(api.toPayload(), "items-are-json");
    expect(items.observed).toBeGreaterThan(0);
    expect(items.exchanges[0]?.responseKind).toBe("text");
    expect(items.exchanges[0]?.responseMissing).toEqual(["[0].id", "[0].name"]);
  });
});
