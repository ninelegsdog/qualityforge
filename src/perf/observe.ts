/**
 * Measure what a page costs to load, from inside the browser.
 *
 * ## The one metric, and why that one
 *
 * **Total transferred bytes, taken from Resource Timing's `transferSize`.** Both
 * halves of that were measured on 2026-10-18, five runs each, because a budget is
 * only as good as the stability of the number it judges:
 *
 * | what was measured | home page | heavy page | spread |
 * | --- | --- | --- | --- |
 * | `transferSize` (Resource Timing) | 3 922 | 526 538 | **0** |
 * | sum of response bodies | 1 704 / 2 101 | 525 638 | 397 |
 *
 * The second row is why the first was chosen. Summing bodies needs the engine to
 * hand each body over, and it does not always: the same page measured 1 704 and
 * 2 101 across five runs. `transferSize` is the network layer's own count, needs no
 * body read, and came back identical every time.
 *
 * **Timing was measured and rejected.** It separates a real regression — 70 ms
 * became 401 ms — but its noise grows with the machine: spread 4 ms idle, 39 ms with
 * four CPUs busy, on the same host. A budget there is possible only with a wide
 * margin, and the margin would then be the number nobody could argue about. A budget
 * that can only fail for one reason is worth more than a second budget that can fail
 * for two.
 */

import type { Page } from "@playwright/test";
import { PERF_CAPTURE_SCHEMA_VERSION } from "./types.js";

export { PERF_CAPTURE_SCHEMA_VERSION } from "./types.js";

/**
 * One page load, as the browser accounted for it.
 *
 * `transferSize` covers the navigation and every resource the page fetched,
 * headers included — what a user actually downloads, which is what a budget is
 * about.
 */
export interface PerfPageObservation {
  /** Path the page was loaded from, including its query string. */
  path: string;
  /** Total bytes transferred for this load. */
  transferredBytes: number;
  /** How many resources the load fetched, the navigation itself excluded. */
  resources: number;
  /** Largest single contribution, when it is worth naming. */
  largest?: { url: string; bytes: number };
}

export interface PerfCapturePayload {
  schemaVersion: typeof PERF_CAPTURE_SCHEMA_VERSION;
  /** One entry per page the test visited, in visit order. */
  pages: PerfPageObservation[];
}

/**
 * Watch one page and record what each load costs.
 *
 * Attached to the page rather than to the test: a load is a property of a page, and
 * a test that navigates twice should produce two observations rather than one
 * number for whichever load happened to be last.
 */
export class PerfObserver {
  readonly #page: Page;
  readonly #pages: PerfPageObservation[] = [];

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * Start observing. Safe to call once per page.
   *
   * **Deliberately does not listen for `load`.** Reading on the event races the
   * navigation that raised it: on firefox the first version failed nine tests with
   * `Execution context was destroyed, most likely because of a navigation`, and the
   * engine that does not fail is not thereby correct — it merely hid it. The page
   * is read when the test asks, which is after the page has settled.
   */
  attach(): void {
    // Kept as an explicit call rather than a constructor side effect, so a test can
    // see when observation begins and the fixture reads as a sequence of steps.
  }

  /**
   * Take a reading of the page as it stands.
   *
   * One reading per call rather than one per load: what a budget judges is what the
   * page cost to arrive at, and a test that navigated twice is describing two pages
   * while holding one budget.
   */
  async measureNow(): Promise<PerfPageObservation> {
    const reading = await this.#read();
    this.#pages.push(reading);
    return reading;
  }

  /** Everything observed so far. Safe to call more than once. */
  toPayload(): PerfCapturePayload {
    return {
      schemaVersion: PERF_CAPTURE_SCHEMA_VERSION,
      pages: this.#pages.map((page) => ({ ...page })),
    };
  }

  async #read(): Promise<PerfPageObservation> {
    // Nothing inside `evaluate` may be a named function: `tsx` wraps those in a
    // `__name` helper that exists only in the build output, and the page has never
    // heard of it. Found by running the observer — the failure was a
    // `ReferenceError: __name is not defined` on the first real page load.
    //
    // The types are declared locally for the same reason as elsewhere in this file:
    // this module runs in Node and only reaches them inside the page.
    const reading = await this.#page.evaluate(() => {
      const here = globalThis as unknown as {
        location: { pathname: string; search: string };
        performance: { getEntriesByType: (type: string) => unknown };
      };
      // No function value of any kind inside `evaluate` — not even a `const` arrow,
      // because `tsx` wraps those in a `__name` helper that exists only in the build
      // output. Both kinds are read here with a loop instead.
      const entries: { name: string; bytes: number }[] = [];
      for (const entry of here.performance.getEntriesByType("resource") as unknown[]) {
        const item = entry as { name?: unknown; transferSize?: unknown };
        entries.push({
          name: typeof item.name === "string" ? item.name : "",
          bytes: typeof item.transferSize === "number" ? item.transferSize : 0,
        });
      }
      const navigation = here.performance.getEntriesByType("navigation") as unknown[];
      for (const entry of navigation) {
        const item = entry as { name?: unknown; transferSize?: unknown };
        entries.push({
          name: typeof item.name === "string" ? item.name : "",
          bytes: typeof item.transferSize === "number" ? item.transferSize : 0,
        });
      }

      let largest: { url: string; bytes: number } | undefined;
      let total = 0;
      for (const entry of entries) {
        total += entry.bytes;
        if (largest === undefined || entry.bytes > largest.bytes) {
          largest = { url: entry.name, bytes: entry.bytes };
        }
      }

      return {
        path: `${here.location.pathname}${here.location.search}`,
        transferredBytes: total,
        resources: entries.length - navigation.length,
        ...(largest === undefined || largest.bytes === 0 ? {} : { largest }),
      };
    });

    return reading;
  }
}
