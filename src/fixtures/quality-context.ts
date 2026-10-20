import { test as base, expect } from "@playwright/test";
import { ApiObserver } from "../api/observe.js";
import { PerfObserver } from "../perf/observe.js";
import { VisualObserver, VISUAL_IMAGE_ATTACHMENT_PREFIX } from "../visual/observe.js";
import { loadConfig } from "../config/load-config.js";
import type { ApiExpectation, ProjectConfig } from "../config/types.js";
import { capturePageContext, shouldAttachContext } from "../defect/page-context.js";
import { SignalCollector } from "../quality/signals.js";

/** Attachment name the defect collector looks for. */
export const ATTACHMENT_NAME = "quality-context";

/**
 * Attachment name the API audit collector looks for.
 *
 * Separate from `quality-context` because it is attached on a different rule,
 * and the difference is the whole point: `quality-context` rides on failures, so
 * a run where every test passed attaches nothing. An API contract that broke
 * without breaking a test is precisely the case this dimension exists to catch,
 * so its evidence cannot live on a failure-only attachment.
 */
export const API_ATTACHMENT_NAME = "quality-api";

/**
 * The transfer-budget capture, attached on the same rule as `quality-api` and for
 * the same reason: a page can get twice as heavy while every test stays green, which
 * is the case this dimension exists to catch, so its evidence cannot live on a
 * failure-only attachment.
 */
export const PERF_ATTACHMENT_NAME = "quality-perf";

/**
 * The appearance capture, attached on the same rule as the other two and for the same
 * reason: a page can look wrong while every behavioural assertion holds, which is the
 * case this dimension exists to catch.
 *
 * It carries **hashes, never images** — a screenshot is tens of kilobytes a language
 * model cannot read usefully, while its hash answers the only question a gate asks.
 */
export const VISUAL_ATTACHMENT_NAME = "quality-visual";

export interface QualityFixtures {
  /** Captured console, page-error and network signals for this test. */
  signals: SignalCollector;
  /** Observed exchanges against the project's declared API contracts. */
  api: ApiObserver;
  /** What each page the test loaded cost to transfer. */
  perf: PerfObserver;
  /** What each page the test looked like. */
  visual: VisualObserver;
}

/**
 * The project's configuration, read once per worker.
 *
 * A rejected promise stays rejected, which is the behaviour wanted: an invalid
 * `config/project.json` then fails every test with the loader's own message
 * rather than letting a suite report green while observing nothing.
 */
let pendingConfig: Promise<ProjectConfig> | undefined;

function projectConfig(): Promise<ProjectConfig> {
  pendingConfig ??= loadConfig(process.cwd());
  return pendingConfig;
}

/** The declared contracts, or none. Absence means the dimension is off. */
async function declaredExpectations(): Promise<ApiExpectation[]> {
  const config = await projectConfig();
  return config.api?.expectations ?? [];
}

/** Whether a transfer budget is declared. Absence means the dimension is off. */
async function hasPerfBudget(): Promise<boolean> {
  const config = await projectConfig();
  return config.thresholds.maxTransferredBytes !== undefined;
}

/**
 * Whether appearance is gated at all, and on which engine project.
 *
 * Absence means the dimension is off. When it is on, the project is named rather
 * than derived: measured, firefox and chromium share no screenshot hash for the
 * same page, so a baseline means nothing without saying which engine approved it.
 */
/**
 * `test` and `expect` to import in a browser test.
 *
 * Switching the import from `@playwright/test` to this module is the whole
 * integration: the `signals` fixture is declared `auto`, so console, page-error,
 * network and HTTP-error capture is attached to every failing test without any
 * test having to ask for it.
 *
 * Pure logic tests should keep importing `@playwright/test` directly — they
 * need no browser, and this fixture would give them one.
 */
export const test = base.extend<QualityFixtures>({
  signals: [
    async ({ page }, use, testInfo) => {
      const collector = new SignalCollector(page);
      await use(collector);

      // The page is read before the decision is taken. It is data observable at
      // failure time, and asking for it afterwards would race a navigation that
      // happens during teardown.
      const pageContext = await capturePageContext(page);

      // Decided on the outcome, not on a comparison with what was expected: an
      // expected failure (`test.fail()`) is still a failure, and suppressing its
      // evidence is what made it indistinguishable from a failure with nothing
      // to report. See `shouldAttachContext`.
      //
      // Signals and the page are counted separately on purpose. Signals are
      // absent when nothing was observed; the page is present whenever the test
      // drove one, because a page with no console error is still the page the
      // failure happened on.
      const attach = shouldAttachContext(
        testInfo.status,
        testInfo.expectedStatus,
        collector.hasContent() || pageContext !== undefined,
      );
      if (!attach) return;

      await testInfo.attach(ATTACHMENT_NAME, {
        body: `${JSON.stringify(
          {
            ...collector.toPayload(),
            ...(pageContext === undefined ? {} : { page: pageContext }),
          },
          null,
          2,
        )}\n`,
        contentType: "application/json",
      });
    },
    { auto: true },
  ],

  api: [
    // `_visual` is requested and not used, and that is the whole point of it.
    //
    // Playwright tears fixtures down in the **reverse** of the order they were
    // requested, so taking `visual` here makes it set up first and tear down last.
    // That ordering is load-bearing: `visual` reloads the page before photographing
    // it, and a reload navigates away from a response whose body the API capture is
    // still reading — which showed up as `too-late` on `/api/items` and two
    // violations against a run that had changed nothing.
    async ({ page, visual: _visual }, use, testInfo) => {
      const expectations = await declaredExpectations();
      const config = await projectConfig();
      const observer = new ApiObserver(page, expectations, config.baseUrl);

      // No declared contracts means no listeners: an `auto` fixture must not cost
      // anything on a project that has not opted in.
      if (expectations.length > 0) {
        observer.attach();
      }

      await use(observer);

      if (expectations.length === 0) {
        return;
      }

      // Attached whatever the outcome, and including expectations that matched
      // nothing. An expectation with no exchange is the fail-closed case the
      // owner decided on, and it can only be ruled on from a payload that says so.
      await testInfo.attach(API_ATTACHMENT_NAME, {
        body: `${JSON.stringify(await observer.toPayload(), null, 2)}\n`,
        contentType: "application/json",
      });
    },
    { auto: true },
  ],

  perf: [
    async ({ page }, use, testInfo) => {
      const declared = await hasPerfBudget();
      const observer = new PerfObserver(page);

      // No declared budget means no listener: an `auto` fixture must not cost
      // anything on a project that has not opted in.
      if (declared) {
        observer.attach();
      }

      await use(observer);

      if (!declared) {
        return;
      }

      // Attached whatever the outcome. A page nobody measured is the fail-closed
      // case, and it can only be ruled on from a payload that says so.
      // Read after the test body, so the page has settled. Reading on `load`
      // races the navigation that raised it — measured: nine firefox tests
      // failing with a destroyed execution context.
      await observer.measureNow();

      await testInfo.attach(PERF_ATTACHMENT_NAME, {
        body: `${JSON.stringify(observer.toPayload(), null, 2)}\n`,
        contentType: "application/json",
      });
    },
    { auto: true },
  ],

  visual: [
    async ({ page, browserName }, use, testInfo) => {
      const config = await projectConfig();
      // The engine's own name, so the collector knows which captures it is allowed to
      // judge. Playwright knows it and this is the only place it can be told.
      const observer = new VisualObserver(page, browserName);

      await use(observer);

      if (config.visual === undefined) {
        return;
      }
      const project = config.visual.project;

      // **Photograph only a page that went quiet**, and the bound is not a hope about
      // timing — it is measured. A screenshot of a page whose list is still being
      // fetched is a photograph of a half-rendered page, and the collector then
      // reports a change nobody made. That is how this rule was found: with only
      // `fonts.ready`, the home page hashed differently between the baseline generator
      // and the suite run at the same viewport.
      //
      // **Bounded, and a timeout is not an error.** `networkidle` never arrives on a
      // test that deliberately holds a request open — which is a whole category here,
      // the API capture tests among them — and waiting out twenty seconds on each of
      // them would be both slow and wrong. So a page that does not settle within the
      // bound contributes no visual observation, and says nothing.
      //
      // The declared pages are still measured: every test that settles contributes,
      // and one unsettled test does not make a page unmeasurable.
      // **Reload before photographing, and this is the meaning of an appearance.**
      //
      // Measured: `/contact` was seen five ways across nine captures — because tests
      // fill the form, submit it, and leave error states behind. Those are not five
      // appearances of the page, they are one page and five things a test did to it.
      // A baseline approved from a clean load means *the page at rest*, and the only
      // way to compare like with like is to photograph the same thing.
      //
      // Safe because the test body has finished: nothing downstream still needs the
      // state the test left, so reloading costs nothing but a request.
      const resting = page.url();
      await page.goto(resting, { waitUntil: "load" }).catch(() => undefined);
      try {
        await page.waitForLoadState("networkidle", { timeout: 2000 });
      } catch {
        // A page that never goes quiet — one holding a request open on purpose — is
        // not photographed. Silence about a picture is better than a wrong one.
        return;
      }
      const captured = await observer.captureNow();

      await testInfo.attach(VISUAL_ATTACHMENT_NAME, {
        body: `${JSON.stringify(observer.toPayload(), null, 2)}\n`,
        contentType: "application/json",
      });

      // The stored-observed-image opt-in. Two gates, both about not paying for
      // what nobody asked for: the config may not declare the block, and a leg may
      // not be the approving engine — a firefox capture the collector sets up to
      // ignore would be bytes paid for and never read.
      if (config.visual.observedImages === undefined || browserName !== project) {
        return;
      }
      const image = observer.lastImage();
      if (image === undefined) {
        // The capture above produced the hash, so this cannot happen in a fixture
        // run where the screenshot succeeded — and refusing loudly here beats an
        // audit whose opt-in silently points at nothing.
        throw new Error(
          "the visual capture produced a hash but no image bytes, " +
            "so the opted-in observed image could not be attached",
        );
      }
      // The name carries the hash, and the collector re-hashes the bytes against
      // it: pairing a payload page with its image is a fact about the bytes, not
      // about attachment order. Inline `body` rather than a temp file, so no path
      // contract with a cleanup run has to hold.
      await testInfo.attach(`${VISUAL_IMAGE_ATTACHMENT_PREFIX}${captured.sha256}`, {
        body: image,
        contentType: "image/png",
      });
    },
    { auto: true },
  ],
});

export { expect };
