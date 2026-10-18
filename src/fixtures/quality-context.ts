import { test as base, expect } from "@playwright/test";
import { ApiObserver } from "../api/observe.js";
import { PerfObserver } from "../perf/observe.js";
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

export interface QualityFixtures {
  /** Captured console, page-error and network signals for this test. */
  signals: SignalCollector;
  /** Observed exchanges against the project's declared API contracts. */
  api: ApiObserver;
  /** What each page the test loaded cost to transfer. */
  perf: PerfObserver;
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
    async ({ page }, use, testInfo) => {
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
});

export { expect };
