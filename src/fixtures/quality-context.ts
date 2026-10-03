import { test as base, expect } from "@playwright/test";
import { shouldAttachContext } from "../defect/page-context.js";
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

      // Decided on the outcome, not on a comparison with what was expected: an
      // expected failure (`test.fail()`) is still a failure, and suppressing its
      // evidence is what made it indistinguishable from a failure with nothing
      // to report. See `shouldAttachContext`.
      const failed = shouldAttachContext(testInfo.status, testInfo.expectedStatus);
      if (!failed || !collector.hasContent()) return;

      await testInfo.attach(ATTACHMENT_NAME, {
        body: `${JSON.stringify(collector.toPayload(), null, 2)}\n`,
        contentType: "application/json",
      });
    },
    { auto: true },
  ],
});

export { expect };
