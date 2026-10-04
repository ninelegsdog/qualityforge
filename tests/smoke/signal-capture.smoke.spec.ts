import { expect, test } from "../fixtures.js";

/**
 * Signal capture, in every engine in the matrix.
 *
 * `console`, `pageerror`, `requestfailed` and 4xx/5xx responses are captured by
 * the `signals` fixture and land in the defect artifact as `signals`. Until this
 * file existed, that path had only ever run in Chromium - and the demo app is
 * quiet, so it had not really run there either: a clean page produces no
 * signals at all, and an absent `signals` key is indistinguishable from a
 * capture that silently did nothing.
 *
 * Everything below manufactures a signal deliberately. No test may depend on
 * somebody else's site, so the noise is generated here with `page.route` and an
 * init script rather than by asking a public application to misbehave.
 *
 * Assertions are deliberately about what must be identical in every engine -
 * the status code, the method, the redaction, the presence of the entry - and
 * not about the engine's own wording. `request.failure().errorText` and the
 * text of an uncaught error are engine vocabulary, not project behaviour, and
 * pinning them here would turn a browser upgrade into a test failure. What they
 * say is recorded in the browser notes instead.
 */

/** A secret that must never survive into an artifact, in any engine. */
const SECRET = "super-secret-value-1234";

test.describe("signal capture", () => {
  test("captures a console error and redacts the token inside it", async ({ page, signals }) => {
    await page.addInitScript((secret) => {
      console.error(`api call failed: token=${secret}`);
    }, SECRET);
    await page.goto("/");

    await expect
      .poll(() => signals.toPayload().signals.consoleErrors.length, {
        message: "the console error never reached the collector",
      })
      .toBeGreaterThan(0);

    const [entry] = signals.toPayload().signals.consoleErrors;
    expect(entry?.text).toContain("[redacted]");
    expect(entry?.text).not.toContain(SECRET);
    // The part that is not secret has to survive redaction, or the entry is
    // useless for triage.
    expect(entry?.text).toContain("api call failed");
    expect(entry?.type).toBe("error");
  });

  test("captures an uncaught page error", async ({ page, signals }) => {
    await page.addInitScript(() => {
      setTimeout(() => {
        throw new Error("simulated uncaught failure");
      }, 0);
    });
    await page.goto("/");

    await expect
      .poll(() => signals.toPayload().signals.pageErrors, {
        message: "the uncaught error never reached the collector",
      })
      .toContainEqual(expect.stringContaining("simulated uncaught failure"));
  });

  test("captures a failed request without its query string", async ({ page, signals }) => {
    await page.route(
      (url) => url.pathname === "/api/probe",
      // "failed" rather than a specific code: the point is that the request
      // never completed, and the reason string belongs to the engine.
      (route) => route.abort("failed"),
    );
    await page.goto("/");
    await page.evaluate(async () => {
      try {
        await fetch("/api/probe?access_token=super-secret-value-1234");
      } catch {
        // The abort is the thing under test.
      }
    });

    await expect
      .poll(() => signals.toPayload().signals.requestFailures.length, {
        message: "the failed request never reached the collector",
      })
      .toBeGreaterThan(0);

    const [entry] = signals.toPayload().signals.requestFailures;
    expect(entry?.method).toBe("GET");
    expect(entry?.resourceType).toBe("fetch");
    expect(entry?.url).not.toContain("?");
    expect(entry?.url).not.toContain(SECRET);
    // Every engine words this differently, but every engine must say something:
    // an empty reason would be indistinguishable from "not captured".
    expect(entry?.failure).toBeTruthy();
    // Origin is what tells a third party's failure from the application's own.
    // Host *with* the port, as URL.host gives it: a failure on the app's own port
    // and one on a different port on the same machine are different problems.
    //
    // Taken from the page rather than written down. The port belongs to whoever
    // started the fixture, and a test that hardcodes it passes on the one run whose
    // port happens to match — which is how this one shipped failing on every port
    // but the one it was written on.
    expect(entry?.origin).toBe(new URL(page.url()).host);
  });

  test("a third-party failure is attributed to the host that owns it", async ({
    page,
    signals,
  }) => {
    // The case this exists for: a blocked font from a CDN reads exactly like a
    // broken endpoint on the application, and a consumer cannot tell whose problem
    // they are looking at. Proven against a real site - one broken Google font
    // produced entries attributed to fonts.gstatic.com while the page was
    // quotes.toscrape.com.
    await page.route(
      (url) => url.hostname === "fonts.example-cdn.test",
      (route) => route.abort("failed"),
    );
    await page.goto("/");
    await page.evaluate(async () => {
      try {
        await fetch("https://fonts.example-cdn.test/font.woff2");
      } catch {
        // The abort is the thing under test.
      }
    });

    await expect
      .poll(() => signals.toPayload().signals.requestFailures.length, {
        message: "the third-party request never reached the collector",
      })
      .toBeGreaterThan(0);

    const third = signals
      .toPayload()
      .signals.requestFailures.find((e) => e.url.includes("example-cdn"));
    // Its own host, not the page's — which is the whole point.
    expect(third?.origin).toBe("fonts.example-cdn.test");
    // And the application's own entries still carry the application's host, so
    // the two are separable rather than both being labelled by the page.
    const own = signals
      .toPayload()
      .signals.requestFailures.find((e) => !e.url.includes("example-cdn"));
    if (own !== undefined) expect(own.origin).toBe(new URL(page.url()).host);
  });

  test("captures a 5xx response with its method and status", async ({ page, signals }) => {
    await page.route(
      (url) => url.pathname === "/api/items",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "unavailable" }),
        }),
    );
    await page.goto("/");

    // The app turns the failed fetch into visible text, so this waits on the
    // user-visible symptom instead of on the collector.
    await expect(page.getByTestId("entity-error")).toContainText("503");

    const errors = signals.toPayload().signals.httpErrors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ method: "GET", status: 503 });
    expect(errors[0]?.url).not.toContain("?");
  });

  test("a quiet page captures nothing at all", async ({ page, signals }) => {
    await page.goto("/");
    await expect(page.getByTestId("entity")).toHaveCount(3);

    // Absent and empty have to stay distinguishable: an artifact with no
    // `signals` key means "nothing was observed", and this is the test that
    // keeps that true rather than accidental.
    expect(signals.hasContent()).toBe(false);
    expect(signals.toPayload().signals).toEqual({
      consoleErrors: [],
      consoleWarnings: [],
      pageErrors: [],
      requestFailures: [],
      httpErrors: [],
    });
    expect(signals.toPayload().dropped).toBe(0);
  });
});
