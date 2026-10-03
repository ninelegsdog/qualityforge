import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../fixtures.js";

/**
 * The defect contract against an application we do not own.
 *
 * Everything else in `tests/smoke/` runs against `fixtures/`, which this
 * repository also wrote and also controls the suite for. A contract that has
 * only ever met its own producer has not been tested: the fixture has correct
 * labels, one origin, no redirects, no foreign assets and English titles, so
 * every shape the contract is likely to get wrong is absent by construction.
 *
 * The target is quotes.toscrape.com, Zyte's public scraping sandbox: a real
 * application with a real form, a real 302 after a POST, real duplicate
 * accessible names, a real HTML 404 page, and real assets loaded from Google's
 * font CDN. It needs no account, no API key and no code of ours, and it is
 * built to be driven by automation, so it does not answer a headless browser
 * with a challenge page.
 *
 * ## The three rules this file has to obey
 *
 * 1. **It never runs by default.** Someone else's uptime is not a dependency of
 *    `npm test`. Opt in explicitly:
 *
 *        QUALITYFORGE_THIRD_PARTY=1 npx playwright test tests/smoke/third-party
 *
 *    Point `QUALITYFORGE_THIRD_PARTY_URL` at another public application to
 *    retarget it. Every navigation below builds an absolute URL from that value
 *    rather than using a relative one, so this file cannot be redirected at
 *    `fixtures/` by a `BASE_URL` that was left pointing at home.
 *
 * 2. **When the target is down, it fails for that reason.** The probe below
 *    reaches the application over HTTP with a hard timeout and aborts the suite
 *    with a message that says "the target is unavailable". Without it, an outage
 *    arrives as a pile of locator timeouts and is indistinguishable from a
 *    contract defect: the failure would describe somebody else's server while
 *    appearing in our artifacts.
 *
 * 3. **The probes fail on purpose, and the run is expected to be red.** Each
 *    probe asks one question about `defect.v1`, so each one ends on an assertion
 *    the target does not satisfy. Five failures is a correct run:
 *
 *        QUALITYFORGE_THIRD_PARTY=1 npx playwright test tests/smoke/third-party
 *        npm run defects:collect
 *
 *    `test.fail()` was tried here and removed. It keeps the suite green, and it
 *    costs the whole point: for an expected failure Playwright attaches no
 *    screenshot and no video, and the `signals` fixture — which decides what to
 *    record by comparing `testInfo.status` with `testInfo.expectedStatus` — sees
 *    `failed === failed` and attaches nothing. The artifacts came out with
 *    `evidence: {}` and no `signals`, which is indistinguishable from a failure
 *    that really produced no signals. Probes need evidence, so the probes are
 *    honestly red.
 */
const ENABLED = process.env.QUALITYFORGE_THIRD_PARTY === "1";
const TARGET = (process.env.QUALITYFORGE_THIRD_PARTY_URL ?? "https://quotes.toscrape.com").replace(
  /\/+$/,
  "",
);

/** User-visible text the application is known to serve. A challenge page will not have it. */
const APP_MARKER = "Quotes to Scrape";

/** Hard bound on the reachability probe. A hung probe is the failure mode to avoid. */
const PROBE_TIMEOUT_MS = 10_000;

function targetUrl(pathname: string): string {
  return `${TARGET}${pathname}`;
}

let probe: Promise<void> | undefined;

/**
 * Refuse to run against a target that cannot be used.
 *
 * One probe per worker process, then cached: four workers asking a public site
 * whether it is up is four times the traffic for one answer. The cached
 * rejection is returned to every caller, so the whole suite stops with the same
 * message rather than four different ones.
 */
function verifyTarget(request: APIRequestContext): Promise<void> {
  probe ??= (async () => {
    let response;
    try {
      response = await request.get(targetUrl("/"), {
        timeout: PROBE_TIMEOUT_MS,
        // A 4xx or 5xx from the application still means the application answered.
        // Whether it is a healthy one is what the tests below are for.
        failOnStatusCode: false,
      });
    } catch (error) {
      throw new Error(
        `Third-party target ${TARGET} is unreachable, so this suite did not run.\n` +
          `  request: GET ${targetUrl("/")}\n` +
          `  reason:  ${(error as Error).message.split("\n")[0]}\n` +
          `  This suite is the only place the defect.v1 contract meets an application\n` +
          `  QualityForge did not build. Running it against an unreachable host would\n` +
          `  file somebody else's outage as a contract defect. Retry later, or point\n` +
          `  QUALITYFORGE_THIRD_PARTY_URL at another public application.`,
        { cause: error },
      );
    }

    const body = await response.text().catch(() => "");
    if (!body.includes(APP_MARKER)) {
      throw new Error(
        `Third-party target ${TARGET} answered ${response.status()} but is not serving the\n` +
          `  application: the body does not contain ${JSON.stringify(APP_MARKER)}.\n` +
          `  A challenge page, an interstitial or a parked domain all look like this, and\n` +
          `  assertions against one would produce failures that say nothing about the contract.`,
      );
    }
  })();
  return probe;
}

test.describe("third-party application", () => {
  test.skip(!ENABLED, "set QUALITYFORGE_THIRD_PARTY=1 to run against a real third-party app");

  test.beforeAll(async ({ request }) => {
    await verifyTarget(request);
  });

  // ---------------------------------------------------------------------------
  // What the application actually does. These pass, and they are what makes the
  // probes below mean something: if the application changed shape, a probe's
  // failure is no longer evidence about the contract.
  // ---------------------------------------------------------------------------

  test("serves the quote index at the configured target", async ({ page }) => {
    await page.goto(targetUrl("/"));

    expect(new URL(page.url()).origin).toBe(new URL(TARGET).origin);
    await expect(page).toHaveTitle(APP_MARKER);
    await expect(page.getByRole("heading", { level: 1, name: APP_MARKER })).toBeVisible();
    await expect(page.getByRole("link", { name: "Login" })).toBeVisible();
  });

  test("paginates to a second page of quotes", async ({ page }) => {
    await page.goto(targetUrl("/"));

    await page.getByRole("link", { name: "Next" }).click();

    await expect(page).toHaveURL(/\/page\/2\/$/);
    await expect(page.getByRole("link", { name: "Previous" })).toBeVisible();
  });

  test("links a quote to its tag page", async ({ page }) => {
    await page.goto(targetUrl("/"));

    // "change" is the first quote's first tag and appears exactly once on the
    // index, which is the only reason this locator is not ambiguous. The index
    // carries 30 tag links across 10 quotes plus a 10-entry sidebar, so several
    // tag names resolve to more than one element — "inspirational" to 4 — and all
    // 10 author links share the name "(about)". Repeated accessible names are the
    // normal condition in a real application, and our fixture cannot produce one.
    await page.getByRole("link", { name: "change", exact: true }).click();

    await expect(page).toHaveURL(/\/tag\/change\/page\/1\/$/);
  });

  test("serves 404 for a path the application does not have", async ({ request }) => {
    const response = await request.get(targetUrl("/definitely-not-here"));

    expect(response.status()).toBe(404);
  });

  test("offers a login form with a username control", async ({ page }) => {
    await page.goto(targetUrl("/login"));

    await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Probes. Each fails on purpose, each answers one question about what
  // `defect.v1` can say about a failure in an application it did not produce,
  // and together they are this suite's five expected artifacts.
  // ---------------------------------------------------------------------------

  test.describe("contract probes", () => {
    test("a missing element is reported together with the page it was missing from", async ({
      page,
    }) => {
      await page.goto(targetUrl("/"));

      // Nothing on this page is called "Documentation". What matters is what the
      // artifact says about it: the locator, the test, the file — and no URL,
      // neither in the artifact nor in the error-context.md it points at.
      await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
    });

    test("a login form whose labels point at the wrong control is reported as such", async ({
      page,
    }) => {
      await page.goto(targetUrl("/login"));

      // The application ships <label for="username">Password</label>, so the
      // accessible name "Password" resolves to the username textbox: filling by
      // label types the password into the username field, the POST body carries
      // an empty password, and the application accepts the login.
      await page.getByLabel("Username").fill("contract-probe@example.com");
      await page.getByLabel("Password").fill("not-a-real-password");
      await page.getByRole("button", { name: "Login" }).click();

      // A rejected login reports itself and stays on the page. This one does
      // neither: it answers 302, lands on the index and renders "Logout".
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
    });

    test("a duplicated accessible name is reported as ambiguous", async ({ page }) => {
      await page.goto(targetUrl("/"));

      // Ten author links share the accessible name "(about)". Playwright refuses
      // the strict-mode action and names all ten in its error message, but the
      // artifact keeps no count and no way to say which one the test meant.
      await expect(page.getByRole("link", { name: "about" })).toHaveCount(1);
    });

    test("a failed third-party asset is attributed to the application that owns it", async ({
      page,
    }) => {
      // Stubbed rather than waited for: the project rule is to stub an external
      // service instead of inheriting its uptime, and a font CDN is somebody
      // else's uptime by definition. The abort is local and deterministic.
      await page.route("**://fonts.gstatic.com/**", (route) => route.abort("failed"));

      await page.goto(targetUrl("/"));

      // The application still renders; its font does not. The assertion below
      // exists only to make the runner attach the signals, which then carry one
      // requestFailure against fonts.gstatic.com and nothing that says whose
      // problem it is.
      await expect(page.getByRole("heading", { level: 1, name: APP_MARKER })).toHaveText(
        "a heading the application never renders",
      );
    });

    test("a 4xx from the application is recorded once", async ({ page }) => {
      // A real 404 page from a real server. Chromium also logs "Failed to load
      // resource: the server responded with a status of 404 ()" as a console
      // error, so the artifact carries the same fact twice — with an empty
      // statusText and a console location of line 0, column 0 on the document.
      await page.goto(targetUrl("/definitely-not-here"));

      await expect(page.getByRole("heading", { level: 1, name: APP_MARKER })).toHaveText(
        "a heading the 404 page does not render",
      );
    });
  });
});
