import { test as base, expect } from "@playwright/test";
import { capturePageContext, shouldAttachContext } from "../defect/page-context.js";
import { SignalCollector } from "../quality/signals.js";

/** Attachment name the defect collector looks for. */
export const ATTACHMENT_NAME = "quality-context";

export interface QualityFixtures {
  /** Captured console, page-error and network signals for this test. */
  signals: SignalCollector;
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
});

export { expect };
