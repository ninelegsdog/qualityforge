import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../fixtures.js";

/**
 * The defect contract against GitHub — the second application we did not build.
 *
 * The first object, quotes.toscrape.com, is server-rendered classic HTML:
 * every navigation is a full page load, one origin serves everything, nothing
 * is lazy, and ten repeated accessible names were already a lot. Every
 * conclusion the contract drew there could have been a property of that shape.
 * E2 — the owner's decision of 2026-10-06 — asks the same questions of an
 * application built the modern way:
 *
 *   - **client-side navigation.** The repository header navigates through
 *     Turbo: the body is swapped and the URL is rewritten without a document
 *     load, so a failure afterwards has no "page loaded" behind it;
 *   - **a first-party CDN under another registrable domain.** GitHub's own
 *     avatars live on `avatars.githubusercontent.com` — same product, a
 *     different eTLD+1 — which is the case a naive `sameOriginAsTarget` flag
 *     (gap G5) would answer wrongly;
 *   - **lazy content.** Sections below the fold are not fetched at all until
 *     something scrolls them into view, so "never requested" and "requested
 *     and failed" look identical from the page;
 *   - **real scale.** One busy issue list wears the accessible name "Open" on
 *     twenty-five rows, where quotes.toscrape had ten "(about)" links.
 *
 * Public pages only, no account, no API key, nothing written: four page loads
 * of ordinary signed-out GitHub per test. The target was reached over plain
 * HTTP while writing this file, and the reachability probe below is what keeps
 * that true at run time.
 *
 * ## The three rules this file has to obey
 *
 * 1. **It never runs by default.** Someone else's uptime is not a dependency of
 *    `npm test`. Opt in explicitly, and say which object you mean:
 *
 *        # this file only, one browser leg, one worker:
 *        QUALITYFORGE_THIRD_PARTY=1 npx playwright test \
 *          tests/smoke/third-party/github.smoke.spec.ts \
 *          --project=chromium --workers=1
 *
 *        # both third-party objects, every project:
 *        QUALITYFORGE_THIRD_PARTY=1 npx playwright test \
 *          tests/smoke/third-party --workers=1
 *
 *    `QUALITYFORGE_THIRD_PARTY_GITHUB_URL` overrides the target — separate
 *    from quotes' `QUALITYFORGE_THIRD_PARTY_URL` on purpose: every marker and
 *    locator below is GitHub-shaped, so pointing this file at some other
 *    application fails the marker check rather than silently retargeting, and
 *    an unreachable override fails the reachability probe. Both refusals are
 *    the correct answer for a target this file cannot describe.
 *
 * 2. **When the target is down — or is not GitHub — it fails for that
 *    reason.** The probe reaches the application over HTTP with a hard timeout
 *    and refuses a body that does not carry the signed-out header. Without it,
 *    an outage or a challenge page arrives as a pile of locator timeouts and
 *    is indistinguishable from a contract defect: the failure would describe
 *    somebody else's server while appearing in our artifacts.
 *
 * 3. **The probes fail on purpose, and the run is expected to be red.** Each
 *    probe asks one question about `defect.v1`, so each one ends on an
 *    assertion the target does not satisfy. Four failures from this file are a
 *    correct run. `--workers=1` keeps the run honest in two ways: one
 *    reachability probe instead of one per worker against somebody else's
 *    server, and no contention between our own workers for the target's
 *    attention — a race our own parallelism would have created and GitHub
 *    would have been blamed for:
 *
 *        QUALITYFORGE_THIRD_PARTY=1 npx playwright test \
 *          tests/smoke/third-party/github.smoke.spec.ts \
 *          --project=chromium --workers=1
 *        npm run defects:collect
 *
 *    `test.fail()` is not used here for the same reason it was removed from
 *    the quotes suite: Playwright attaches no screenshot and no video to an
 *    expected failure, and the `signals` fixture — which compares
 *    `testInfo.status` with `testInfo.expectedStatus` — records nothing for
 *    `failed === failed`. The artifacts came out with `evidence: {}` and no
 *    `signals`, indistinguishable from a failure that really produced none.
 *    Probes need evidence, so the probes are honestly red.
 *
 * ## What is asserted
 *
 * Four tests establish that the application is the application — signed-out
 * front page, repository page, a client-side navigation that keeps page state,
 * and the login form — and they are what makes the probes mean something: if
 * GitHub changes shape, a probe's failure stops being evidence about the
 * contract. Four probes then ask their questions. Two notes on choosing the
 * targets:
 *
 * - The lazy probe waits on a screenshot caption deep in a marketing section
 *   (below the fold at any viewport this suite uses). Marketing copy drifts;
 *   when it does, this probe fails on the locator instead of on the load
 *   state — still red, but a different question, and the sanity tests above
 *   are what will say the target itself moved.
 * - The duplicate-name probe reads `microsoft/vscode`'s issue list rather
 *   than this repository's own: "two rows" would prove nothing about scale,
 *   and a busy public list is the condition the finding is about.
 */
const ENABLED = process.env.QUALITYFORGE_THIRD_PARTY === "1";
const TARGET = (process.env.QUALITYFORGE_THIRD_PARTY_GITHUB_URL ?? "https://github.com").replace(
  /\/+$/,
  "",
);

/** Header text the signed-out application serves on every public page. A
 * challenge page, a rate-limit page or an interstitial will not have it. */
const APP_MARKER = "Sign in";

/** Hard bound on the reachability probe. A hung probe is the failure mode to avoid. */
const PROBE_TIMEOUT_MS = 10_000;

const REPO_PATH = "/ninelegsdog/qualityforge";
/** This repository's own issue list: the navigation target for the Turbo probe. */
const REPO_ISSUES_PATH = `${REPO_PATH}/issues`;
/** A busy public issue list: twenty-five open rows, every one named "Open". */
const BUSY_ISSUES_PATH = "/microsoft/vscode/issues";

function targetUrl(pathname: string): string {
  return `${TARGET}${pathname}`;
}

/**
 * The repository tab strip. Two things about it were learned by failing first:
 * the accessible name carries the live open-issue count — "Issues (3)" — so
 * an exact "Issues" never matches and the number drifts with the project's
 * own issues; and the repository page renders no level-1 heading at all, so a
 * breadcrumb plus this navigation is what says "this is a repository page".
 * A prefix match scoped to the navigation is the stable statement of intent.
 */
function issuesTab(page: Page): Locator {
  return page
    .getByRole("navigation", { name: "Repository", exact: true })
    .getByRole("link", { name: /^Issues/ });
}

/**
 * Navigate and wait for the document, not for every resource: `load` on the
 * video-heavy front page exceeded Playwright's 20-second navigation timeout
 * once from this machine (observed while writing this file), and nothing
 * asserted below depends on resources finishing — the assertions are DOM
 * ones, and they retry on their own.
 */
async function load(page: Page, pathname: string): Promise<void> {
  await page.goto(targetUrl(pathname), { waitUntil: "domcontentloaded" });
}

let probe: Promise<void> | undefined;

/**
 * Refuse to run against a target that cannot be used.
 *
 * One probe per worker process, then cached: workers asking a public site
 * whether it is up is traffic for one answer. The cached rejection is returned
 * to every caller, so the whole suite stops with the same message rather than
 * different ones.
 */
function verifyTarget(request: APIRequestContext): Promise<void> {
  probe ??= (async () => {
    let response;
    try {
      response = await request.get(targetUrl("/"), {
        timeout: PROBE_TIMEOUT_MS,
        // A 4xx or 5xx from the application still means the application
        // answered. Whether it is a healthy one is what the tests below are for.
        failOnStatusCode: false,
      });
    } catch (error) {
      throw new Error(
        `Third-party target ${TARGET} is unreachable, so this suite did not run.\n` +
          `  request: GET ${targetUrl("/")}\n` +
          `  reason:  ${(error as Error).message.split("\n")[0]}\n` +
          `  This suite asks what defect.v1 can say about an application QualityForge\n` +
          `  did not build. Running it against an unreachable host would file\n` +
          `  somebody else's outage as a contract defect. Retry later, or point\n` +
          `  QUALITYFORGE_THIRD_PARTY_GITHUB_URL at a reachable GitHub.`,
        { cause: error },
      );
    }

    const body = await response.text().catch(() => "");
    if (!body.includes(APP_MARKER)) {
      throw new Error(
        `Third-party target ${TARGET} answered ${response.status()} but is not serving the\n` +
          `  application: the body does not contain ${JSON.stringify(APP_MARKER)}.\n` +
          `  A challenge page, a rate-limit notice or a parked domain all look like this,\n` +
          `  and assertions against one would produce failures that say nothing about\n` +
          `  the contract.`,
      );
    }
  })();
  return probe;
}

test.describe("third-party application: GitHub", () => {
  test.skip(!ENABLED, "set QUALITYFORGE_THIRD_PARTY=1 to run against a real third-party app");

  // 60 seconds per test: every wait in this file runs on a real site's
  // schedule, and the 30-second default was observed racing it — a test
  // timing out with its URL wait still in progress, which would file
  // network patience as a contract defect.
  test.beforeEach(() => {
    test.setTimeout(60_000);
  });

  test.beforeAll(async ({ request }) => {
    await verifyTarget(request);
  });

  // ---------------------------------------------------------------------------
  // What the application actually does. These pass, and they are what makes the
  // probes below mean something: if the application changed shape, a probe's
  // failure is no longer evidence about the contract.
  // ---------------------------------------------------------------------------

  test("serves the signed-out front page", async ({ page }) => {
    await load(page, "/");

    expect(new URL(page.url()).origin).toBe(new URL(TARGET).origin);
    // The <title> carries campaign copy that changes; "GitHub" does not.
    await expect(page).toHaveTitle(/GitHub/);
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  test("serves a repository page", async ({ page }) => {
    await load(page, REPO_PATH);

    // No level-1 heading exists here (the first version of this test assumed
    // one and failed): the repository's new layout speaks through the title,
    // the breadcrumbs and the repository navigation — whose label needs
    // `exact`, or it also matches the "Repository files" strip below it.
    await expect(page).toHaveTitle(/ninelegsdog\/qualityforge/);
    await expect(
      page
        .getByRole("navigation", { name: "Breadcrumbs" })
        .getByRole("link", { name: "qualityforge" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Repository", exact: true })).toBeVisible();
  });

  test("keeps page state across a client-side navigation", async ({ page }) => {
    await load(page, REPO_PATH);

    // Mark the window, follow a link the application handles without a
    // document load, and require the mark to survive. A full reload would
    // answer `undefined` here, which would say the premise of the navigation
    // probe below is false — that GitHub reloads after all.
    // `lib` here has no DOM — correct for Node code, wrong for a browser — so
    // the established pattern is `globalThis`, which in the page is the window.
    await page.evaluate(() => {
      (globalThis as unknown as Record<string, string>).__qualityforgeKept = "kept";
    });

    await issuesTab(page).click();

    // 20s, not the 5-second default: the URL is rewritten when Turbo's fetch
    // returns, on GitHub's schedule and from GitHub's network — the default
    // is a localhost number.
    await expect(page).toHaveURL(targetUrl(REPO_ISSUES_PATH), { timeout: 20_000 });
    const kept = await page.evaluate(
      () => (globalThis as unknown as Record<string, string | undefined>).__qualityforgeKept,
    );
    expect(kept).toBe("kept");
  });

  test("offers a login form with a username control", async ({ page }) => {
    await load(page, "/login");

    await expect(page.getByLabel("Username or email address")).toBeVisible();
    // exact: the page also offers "Sign in with a passkey", and a substring
    // match resolves to both buttons.
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Probes. Each fails on purpose, each answers one question about what
  // `defect.v1` can say about a failure in an application it did not produce,
  // and together they are this suite's four expected artifacts.
  // ---------------------------------------------------------------------------

  test.describe("contract probes", () => {
    test("a failure after client-side navigation reports the page reached without a reload", async ({
      page,
    }) => {
      await load(page, REPO_PATH);

      // The user gets to the issue list without a document load: Turbo swaps
      // the body and rewrites the URL. Read afterwards from the artifact:
      // do `page.url` and `page.title` name the issue list — captured at
      // failure time, with no "load" event anywhere behind it — and does
      // `context.baseUrl` still claim the fixture this run was pointed at?
      await issuesTab(page).click();
      // 20s for the same reason as the sanity test above: a slow Turbo
      // fetch must not become the probe's failure — the question this probe
      // asks is asked of the page after the navigation lands.
      await expect(page).toHaveURL(targetUrl(REPO_ISSUES_PATH), { timeout: 20_000 });

      // This issue list has no such section. The failure puts the browser on
      // a page reached by client-side navigation and asks the artifact to say
      // which page that was.
      await expect(page.getByRole("heading", { level: 1, name: "Roadmap board" })).toBeVisible();
    });

    test("an image the page never requested is distinguishable from one that failed", async ({
      page,
    }) => {
      await load(page, "/");

      // `loading="lazy"` below the fold: the browser never sends a request for
      // this image, so `complete` stays false and no failure signal of any
      // kind exists to capture — while an image that was requested and broke
      // produces a requestFailure and a console entry. From the artifact the
      // two situations must be tellable apart; from the page alone they are
      // not. `toHaveJSProperty` is the browser's own load state, which is what
      // a user sees as an empty box — not a class or an index.
      const image = page.getByRole("img", {
        name: "List of dependencies defined in a requirements .txt file.",
      });
      await expect(image).toHaveJSProperty("complete", true);
    });

    test("a duplicated accessible name on twenty-five rows is reported as ambiguous", async ({
      page,
    }) => {
      await load(page, BUSY_ISSUES_PATH);

      // Every open row wears the same state icon: `<svg role="img
      // aria-label="Open">`, twenty-five times on this list. Playwright
      // refuses the strict-mode action and names all twenty-five, but the
      // artifact must be read afterwards for whether it keeps the count and a
      // way to say which row the test meant — quotes.toscrape's ten "(about)"
      // links asked the same question at a tenth of the scale.
      await expect(page.getByRole("img", { name: "Open", exact: true })).toHaveCount(1);
    });

    test("a first-party CDN under another domain is attributed so a consumer can act on it", async ({
      page,
    }) => {
      // Stubbed rather than waited for: the project rule is to stub an
      // external service instead of inheriting its uptime. The subtlety is
      // whose stub this is — avatars.githubusercontent.com is GitHub's own
      // image CDN, same product, different registrable domain from
      // github.com, so a `sameOriginAsTarget` flag (gap G5) would answer
      // "third party" about the target's own assets. The abort is local and
      // deterministic.
      await page.route("**://avatars.githubusercontent.com/**", (route) => route.abort("failed"));

      await load(page, BUSY_ISSUES_PATH);

      // The issue list still renders; its avatars do not. The assertion below
      // exists only to make the runner attach the signals, which then carry
      // requestFailures against avatars.githubusercontent.com and nothing
      // that says whose problem it is — while `page.url` reads github.com and
      // `context.baseUrl` still reads the bundled fixture.
      await expect(
        page.getByRole("heading", { level: 1, name: "Dependency review dashboard" }),
      ).toBeVisible();
    });
  });
});
