/**
 * Per-test signal capture: console, uncaught errors, failed and error responses.
 *
 * This is the second most useful thing an agent can read after the assertion
 * message itself. A failure like "element not found" is a symptom; "the page
 * logged a TypeError at app.js:42" or "GET /api/items returned 500" is the
 * cause.
 *
 * The Playwright JSON reporter does not carry any of this — its `stdout` and
 * `stderr` fields were empty on a real failing run — so it has to be collected
 * while the page is live.
 *
 * Everything is bounded. A signal collector that grows without limit turns one
 * failure into a context-window problem for whoever reads it.
 */
import type { ConsoleMessage, Page, Request, Response } from "@playwright/test";
import { redactText, redactUrl, truncate } from "./redact.js";

/** Entries kept per signal category. */
export const MAX_ENTRIES_PER_CATEGORY = 40;

/**
 * The host an entry came from.
 *
 * A third party's failure and the application's own look identical in a capture
 * otherwise: one blocked font from `fonts.gstatic.com` reads exactly like a
 * broken endpoint on the application itself, and a consumer has no way to tell
 * whose problem it is looking at.
 *
 * Recorded as a fact rather than as a verdict. Whether an origin is "ours" is
 * decided by the reader, against `page.url` — which is ground truth in a way
 * `context.baseUrl` is not. Encoding the judgement here would bake in a
 * comparison this collector is not in a position to make correctly.
 *
 * Absent when the entry carries no usable URL. `pageErrors` is a plain string
 * with no location, so those entries are never attributed, and the contract says
 * so rather than leaving the absence to look like an oversight.
 */
function originOf(url: string): { origin?: string } {
  if (url === "") return {};
  try {
    const { host } = new URL(url);
    // A data: or blob: URL parses but carries no host worth reporting.
    return host === "" ? {} : { origin: host };
  } catch {
    return {};
  }
}

export interface ConsoleEntry {
  type: string;
  text: string;
  origin?: string;
  location?: { url: string; line: number; column: number };
}

export interface RequestFailureEntry {
  method: string;
  url: string;
  origin?: string;
  resourceType: string;
  failure: string | null;
}

export interface HttpErrorEntry {
  method: string;
  url: string;
  origin?: string;
  status: number;
  statusText: string;
}

/** The payload attached to a failing test. */
export interface QualitySignals {
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  pageErrors: string[];
  requestFailures: RequestFailureEntry[];
  httpErrors: HttpErrorEntry[];
}

function emptySignals(): QualitySignals {
  return {
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    requestFailures: [],
    httpErrors: [],
  };
}

/**
 * Attaches listeners to a page and accumulates bounded, redacted signals.
 *
 * One instance per test. Listeners are removed by Playwright when the page
 * closes, so there is nothing to dispose.
 */
export class SignalCollector {
  readonly #signals = emptySignals();
  #dropped = 0;
  /** Kept so an entry with no usable location can still be attributed. */
  readonly #page: Page;

  /**
   * The page's own URL, or `""` when it cannot be read.
   *
   * Attribution is a nicety attached to evidence, so it must never be the reason
   * evidence is lost. `url()` is available on every real page, but it throws
   * during teardown and a navigation can invalidate the frame underneath it, and
   * this runs inside a listener where an exception would take the whole capture
   * down with it. A test double is the third case, and it is caught here rather
   * than by making every caller supply a URL it does not otherwise need.
   */
  #pageUrl(): string {
    try {
      return this.#page.url();
    } catch {
      return "";
    }
  }

  constructor(page: Page) {
    this.#page = page;
    page.on("console", (message: ConsoleMessage) => this.#onConsole(message));
    page.on("pageerror", (error: Error) => {
      this.#push("pageErrors", truncate(redactText(error.message)));
    });
    page.on("requestfailed", (request: Request) => {
      const url = redactUrl(request.url());
      this.#push("requestFailures", {
        method: request.method(),
        url,
        ...originOf(url),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText
          ? truncate(redactText(request.failure()?.errorText ?? ""), 200)
          : null,
      });
    });
    page.on("response", (response: Response) => {
      if (response.status() < 400) return;
      const url = redactUrl(response.url());
      this.#push("httpErrors", {
        method: response.request().method(),
        url,
        ...originOf(url),
        status: response.status(),
        statusText: response.statusText(),
      });
    });
  }

  #onConsole(message: ConsoleMessage): void {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;

    const location = message.location();
    const redactedLocationUrl = redactUrl(location.url);
    const entry: ConsoleEntry = {
      type,
      text: truncate(redactText(message.text())),
      // Prefer the location's origin, and fall back to the page's own: Chrome
      // reports `line 0, column 0` with an empty location url for a document
      // that failed to load, which is exactly the entry most worth attributing.
      ...originOf(redactedLocationUrl),
      // Chrome reports an empty location url for a document that failed to load, so
      // fall back to the page's own origin rather than leaving the most
      // interesting entry unattributed.
      ...(originOf(redactedLocationUrl).origin === undefined ? originOf(this.#pageUrl()) : {}),
      ...(location.url === ""
        ? {}
        : {
            location: {
              url: redactedLocationUrl,
              line: location.lineNumber,
              column: location.columnNumber,
            },
          }),
    };

    this.#push(type === "error" ? "consoleErrors" : "consoleWarnings", entry);
  }

  /** Append, respecting the per-category cap. */
  #push<T>(category: keyof QualitySignals, value: T): void {
    const bucket = this.#signals[category] as T[];
    if (bucket.length >= MAX_ENTRIES_PER_CATEGORY) {
      this.#dropped += 1;
      return;
    }
    bucket.push(value);
  }

  /** True when anything worth attaching was captured. */
  hasContent(): boolean {
    const s = this.#signals;
    return (
      s.consoleErrors.length > 0 ||
      s.consoleWarnings.length > 0 ||
      s.pageErrors.length > 0 ||
      s.requestFailures.length > 0 ||
      s.httpErrors.length > 0
    );
  }

  /**
   * Snapshot for attachment. `dropped` records how many entries hit the cap,
   * so a truncated capture never looks complete.
   */
  toPayload(): { signals: QualitySignals; dropped: number } {
    return { signals: this.#signals, dropped: this.#dropped };
  }
}
