/**
 * The rule that decides whether a failing test's context is recorded at all.
 *
 * It lives here, apart from the fixture, so it can be tested without a browser.
 * That matters more than usual: the rule this encodes was wrong for a long time
 * and every check around it agreed with it, because no check could reach it.
 */

/** Outcomes that are a failure of the test, whatever anyone expected. */
const FAILURE_OUTCOMES = new Set(["failed", "timedOut", "interrupted"]);

/**
 * Whether the fixture should attach its context payload for this test.
 *
 * The comparison is against the **outcome**, never against what was expected.
 *
 * The previous rule was `status !== expectedStatus`, and it deleted the evidence
 * at exactly the moment it was wanted: `test.fail()` is the natural way to write
 * a test asserting that a bug exists, and for an expected failure the two
 * statuses are equal, so nothing was attached. The artifact that resulted read
 * exactly like a failure which produced no signals — which is what made it
 * impossible to tell "nothing was observed" from "the runner considered this
 * failure expected".
 *
 * `timedOut` and `interrupted` are included deliberately, and the previous rule
 * attached for them too: a timeout's expected status is `passed`, so
 * `timedOut !== passed` was already true. Narrowing this to `status === "failed"`
 * would fix the reported case while silently reintroducing the same bug for a
 * timeout — and a timed-out test has page state worth more than a passing one.
 *
 * `expectedStatus` is still taken so that the question stays visible at the call
 * site: "was this a failure, and did anyone expect it?" The answer to the second
 * part does not change what gets recorded.
 */
export function shouldAttachContext(
  status: string | undefined,
  expectedStatus: string | undefined,
): boolean {
  void expectedStatus;
  return status !== undefined && FAILURE_OUTCOMES.has(status);
}
