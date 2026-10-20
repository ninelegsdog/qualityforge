/**
 * Capture what a page looks like, as bytes and as a name a reader can check.
 *
 * ## What is captured, and what that costs
 *
 * **A SHA-256 of the screenshot, never the image.** A screenshot is a few hundred
 * kilobytes of bytes that a language model cannot read usefully and a collector
 * cannot compare cheaply; its hash is fifty-six characters that answer the only
 * question a gate asks — *did this page change at all*.
 *
 * Measured 2026-10-18, and this is why the verdict is a hash and not a pixel count:
 * on this repository's own pages, chromium produced **byte-identical** screenshots
 * across five runs in fresh contexts, so a hash comparison is **zero tolerance by
 * construction**. Firefox produced two stable states differing by exactly 253
 * pixels on 3 runs of 10 — which is why the dimension gates on one engine, on the
 * owner's decision, and why no pixel threshold was needed to make it safe.
 *
 * **The observed image is not kept — unless the project opts in.** By default the
 * current screenshot is page content that could carry a token or a personalised list
 * no field-level redaction can remove, so what crosses the artifact boundary is the
 * hash, the byte size and the viewport; a reviewer who needs the picture reproduces
 * it at that viewport. The owner's decision is recorded as G24 in
 * `docs/defect-schema.md`, and its 2026-10-20 escalation is the opt-in: a project
 * that declares `visual.observedImages` keeps the **judged** captures beside the
 * audit, under bounded retention — snapshots are extra copies of page content, and
 * that is why it is a decision, not a default.
 *
 * What the fixture attaches when the opt-in is on: the bytes of the capture, under a
 * name that carries the capture's hash, so the pairing between a payload entry and
 * its image is a fact about the bytes rather than about attachment order.
 */

import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";

export const VISUAL_CAPTURE_SCHEMA_VERSION = "1.0.0" as const;

/**
 * Attachment-name prefix the fixture writes a capture's image under when the
 * project opted in, with the SHA-256 appended.
 *
 * One constant, imported by the fixture and the collector alike: the two would
 * otherwise be two spellings of one name, and a drift between them breaks the
 * pairing silently. The hash in the name is how a payload page and its image find
 * each other — content-based pairing rather than attachment order — and the
 * collector re-hashes the bytes it reads against the name before storing them, so
 * the name and the file it names cannot disagree.
 */
export const VISUAL_IMAGE_ATTACHMENT_PREFIX = "quality-visual-image-";

/** One page, as the browser rendered it. */
export interface VisualPageObservation {
  /** Path the page was loaded from, including its query string. */
  path: string;
  /** SHA-256 of the screenshot bytes, lowercase hex. */
  sha256: string;
  /** Size of the screenshot in bytes, so a reader can tell a small change from a rewrite. */
  bytes: number;
  /**
   * Viewport the screenshot was taken at.
   *
   * Recorded because the measurement showed a different viewport produces a
   * different screenshot of the same page — without this, a baseline would be
   * matched to a page it was never taken from.
   */
  viewport: { width: number; height: number; deviceScaleFactor: number };
  /**
   * Whether the test declared it broke what this page showed.
   *
   * Optional, and **absent means not declared** — the honest reading of silence. The
   * observer always writes it; a hand-written capture need not, and the producer
   * treats an absent flag exactly like a declared `false`.
   *
   * Found by measurement, not by argument: the home page was seen **four different
   * ways across 21 captures**, because the API capture tests stub `/api/items` on
   * purpose. A stubbed page is evidence about the stub, exactly as it is for the API
   * dimension, and the same marker says so — one convention, two dimensions.
   */
  stubbed?: boolean;
  /**
   * The engine that rendered this page.
   *
   * Not decoration. The dimension approves one engine, and without this the collector
   * judged every capture against that engine's baseline — so CI's firefox and webkit
   * legs reported `changed` on pages they are not gating at all. Measured: firefox gave
   * `/docs` as `ad87d6051c1b` against a chromium baseline of `109c1cec65a4`, and
   * reported the home page three ways.
   *
   * Absent means an engine nobody named, and the producer treats an unnamed engine as
   * **not** the approving one: silence is not consent.
   */
  browser?: string;
}

export interface VisualCapturePayload {
  schemaVersion: typeof VISUAL_CAPTURE_SCHEMA_VERSION;
  /** One entry per page the test asked to capture, in capture order. */
  pages: VisualPageObservation[];
}

export class VisualObserver {
  readonly #page: Page;
  readonly #pages: VisualPageObservation[] = [];
  /** Whether the current test declared its page deliberately wrong. */
  #stubbed = false;
  #lastImage: Buffer | undefined;

  /**
   * @param page the page to photograph.
   * @param browserName the engine's own name, recorded with every capture.
   */
  constructor(
    page: Page,
    private readonly browserName: string = "",
  ) {
    this.#page = page;
  }

  /**
   * Declare that this test is showing a page it broke on purpose.
   *
   * The counterpart of `ApiObserver.markStubbed()`, and required for the same
   * reason. A test that stubs `/api/items` to prove the API audit reports a breach
   * also photographs a home page with a stubbed list on it; without this marker that
   * photograph is counted against the project's approved appearance.
   */
  markStubbed(): void {
    this.#stubbed = true;
  }

  /**
   * Capture the page as it stands.
   *
   * On demand rather than on an event, for the same reason the transfer capture is:
   * reading on `load` races the navigation that raised it, and the cost is paid as
   * a destroyed execution context in whichever engine happens to lose the race.
   *
   * Animations disabled and the caret hidden, because a screenshot caught mid-
   * transition is a diff nobody can explain and a blinking caret is a diff nobody
   * caused.
   */
  async captureNow(): Promise<VisualPageObservation> {
    const image = await this.#page.screenshot({
      animations: "disabled",
      caret: "hide",
      scale: "css",
      // The **whole page**, and this has to match the baseline generator exactly.
      // A viewport-only shot approved a baseline of the first screen while the
      // collector photographed everything, and the two hashes never agreed — which is
      // the kind of mismatch that looks like a regression and is really a difference
      // of cameras.
      fullPage: true,
    });
    // Read the scale from the page rather than the context: the context does not
    // expose it, and a guessed `1` would write a baseline whose name says one
    // thing and whose pixels are another.
    // Declared through `globalThis` because this module runs in Node and only reaches
    // `location` and `window` inside the page.
    const reading = await this.#page.evaluate(() => {
      // All three read from the page, and the viewport in **CSS pixels** — which is
      // the unit `scale: "css"` below produces. Recording the device-pixel viewport
      // against a CSS-pixel screenshot would write a baseline that lies about itself.
      const here = globalThis as unknown as {
        location: { pathname: string; search: string };
        devicePixelRatio: number;
        innerWidth: number;
        innerHeight: number;
      };
      return {
        path: `${here.location.pathname}${here.location.search}`,
        deviceScaleFactor: here.devicePixelRatio,
        width: here.innerWidth,
        height: here.innerHeight,
      };
    });

    const observation: VisualPageObservation = {
      path: reading.path,
      sha256: createHash("sha256").update(image).digest("hex"),
      bytes: image.byteLength,
      viewport: {
        width: reading.width,
        height: reading.height,
        deviceScaleFactor: reading.deviceScaleFactor,
      },
      stubbed: this.#stubbed,
      browser: this.browserName,
    };
    // Retained so the fixture can attach the same bytes the hash was computed
    // from — attaching from the observation alone would re-shoot the page, and
    // the two screenshots could disagree with the recorded hash.
    this.#lastImage = image;
    this.#pages.push(observation);
    return observation;
  }

  /**
   * The bytes of the most recent capture, or `undefined` before the first one.
   *
   * For the opt-in storage alone: the default contract carries hashes, and
   * nothing should pay for the bytes of a capture it decided not to keep.
   */
  lastImage(): Buffer | undefined {
    return this.#lastImage;
  }

  /** Everything captured so far. Safe to call more than once. */
  toPayload(): VisualCapturePayload {
    return {
      schemaVersion: VISUAL_CAPTURE_SCHEMA_VERSION,
      pages: this.#pages.map((page) => ({ ...page, viewport: { ...page.viewport } })),
    };
  }
}
