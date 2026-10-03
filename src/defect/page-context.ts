/**
 * What the fixture records about a failure: whether to record it, and which page
 * it happened on.
 *
 * It lives here, apart from the fixture, so both rules can be tested without a
 * browser. That matters more than usual: the attach rule was wrong for a long
 * time and every check around it agreed with it, because no check could reach
 * it.
 */
import { redactUrl } from "../quality/redact.js";

/** The page as it was when the test failed. */
export interface PageContext {
  /** Page URL, redacted the way captured signal URLs are. */
  url: string;
  /** Document title, when the page had one. */
  title?: string;
}

/** The subset of Playwright's Page this needs. Keeps the rule testable. */
export interface PageLike {
  url(): string;
  title(): Promise<string>;
}

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
 *
 * `hasContent` is the caller's statement that there is something to record at
 * all. Failing with nothing observed and nothing on the page attaches nothing,
 * because an empty payload would read as "we looked and found nothing" — and
 * for the page that is not the same claim as "we never got to a page".
 */
export function shouldAttachContext(
  status: string | undefined,
  expectedStatus: string | undefined,
  hasContent: boolean,
): boolean {
  void expectedStatus;
  return status !== undefined && FAILURE_OUTCOMES.has(status) && hasContent;
}

/**
 * Read the page's URL and title, or nothing.
 *
 * Returns undefined rather than a placeholder when there is no URL to record:
 * "the page was somewhere" and "there was no page" are different facts, and the
 * contract already insists those must not be conflated.
 *
 * The URL is redacted here, at capture time, and not at write time in the
 * collector — by then the secret has already touched a file. A query string can
 * carry a token, and a page reached through a reset link is exactly that.
 *
 * The title is best-effort. `page.title()` can reject on a page that has just
 * navigated away, and losing a title is never worth failing a test over.
 */
export async function capturePageContext(page: PageLike): Promise<PageContext | undefined> {
  let url: string;
  try {
    url = page.url();
  } catch {
    return undefined;
  }
  if (url === "") return undefined;

  let title: string | undefined;
  try {
    const value = await page.title();
    if (value !== "") title = value;
  } catch {
    // Best effort, as above.
  }

  return { url: redactUrl(url), ...(title === undefined ? {} : { title }) };
}
