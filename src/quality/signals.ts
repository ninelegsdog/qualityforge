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

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: { url: string; line: number; column: number };
}

export interface RequestFailureEntry {
  method: string;
  url: string;
  resourceType: string;
  failure: string | null;
}

export interface HttpErrorEntry {
  method: string;
  url: string;
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

  constructor(page: Page) {
    page.on("console", (message: ConsoleMessage) => this.#onConsole(message));
    page.on("pageerror", (error: Error) => {
      this.#push("pageErrors", truncate(redactText(error.message)));
    });
    page.on("requestfailed", (request: Request) => {
      this.#push("requestFailures", {
        method: request.method(),
        url: redactUrl(request.url()),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText
          ? truncate(redactText(request.failure()?.errorText ?? ""), 200)
          : null,
      });
    });
    page.on("response", (response: Response) => {
      if (response.status() < 400) return;
      this.#push("httpErrors", {
        method: response.request().method(),
        url: redactUrl(response.url()),
        status: response.status(),
        statusText: response.statusText(),
      });
    });
  }

  #onConsole(message: ConsoleMessage): void {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;

    const location = message.location();
    const entry: ConsoleEntry = {
      type,
      text: truncate(redactText(message.text())),
      ...(location.url === ""
        ? {}
        : {
            location: {
              url: redactUrl(location.url),
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
