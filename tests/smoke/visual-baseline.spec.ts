import { expect, test } from "@playwright/test";

/**
 * The appearance baseline, generated rather than asserted.
 *
 * Run with `--update-snapshots`, this writes the committed images that
 * `src/defect/collect.ts` hashes on every run. Playwright's own screenshot
 * comparison is the mechanism, as #41's issue suggests — the policy is what this
 * repository adds: one engine, zero tolerance, and images a reviewer can see.
 *
 * **The engine matters and is named in the filename.** Measured 2026-10-18: the same
 * page produced no shared screenshot hash between firefox and chromium, and every
 * viewport and scale produced its own. A baseline that does not say which engine
 * approved it says nothing.
 *
 * **Only chromium.** FireFox renders two stable states for this page, differing by
 * exactly 253 pixels on 3 runs of 10, and waiting does not settle it — the owner's
 * decision of 2026-10-19.
 *
 * This file is the *generator*. The check that matters is the collector's audit,
 * which runs on every suite run and is not here.
 */
const PAGES = [
  { path: "/", name: "home" },
  { path: "/docs", name: "docs" },
  { path: "/contact", name: "contact" },
];

/** The one page that exists to be wrong, and is therefore never approved. */
const HEAVY = { path: "/heavy", name: "heavy" };

test.describe("the appearance baseline", () => {
  // **Chromium only, and the skip is stated rather than assumed.**
  //
  // Playwright will happily write a baseline for whatever engine ran this file, and
  // a firefox or webkit image sitting in the approved directory says the page's
  // appearance is approved on an engine the dimension does not gate on. Measured:
  // firefox renders two stable states for this page, 253 pixels apart, on three runs
  // of ten — an approval made from one of those states is an approval of a coin flip.
  test.skip(({ browserName }) => browserName !== "chromium", "only chromium is gated");

  for (const page of [...PAGES, HEAVY]) {
    test(`${page.path} looks the way it is approved to look`, async ({ page: target }) => {
      await target.goto(page.path);
      // The same two conditions the fixture waits for before it photographs a page.
      // Both sides have to wait for the same things or they are not comparable, and a
      // baseline generated under different conditions is a baseline of a page that
      // never existed.
      await target.waitForLoadState("networkidle");
      await expect(target.locator("body")).toBeVisible();
      // Through `globalThis`, because `document` has no declaration in this Node
      // context and the same line has been wrong in every probe this session.
      await target.evaluate(() => {
        const here = globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } };
        return here.document.fonts.ready;
      });

      // No extension here: Playwright appends `{ext}` to the engine and platform it
      // already knows, so `home` becomes `home-chromium-linux.png`. Spelling the
      // platform out in this string is how the name ends up saying
      // `home-chromium-linux-chromium-linux`.
      await expect(target).toHaveScreenshot(`${page.name}.png`, {
        animations: "disabled",
        caret: "hide",
        scale: "css",
        fullPage: true,
      });
    });
  }
});
