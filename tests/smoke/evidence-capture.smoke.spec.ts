import { readdir, stat } from "node:fs/promises";
import { expect, test } from "../fixtures.js";

/**
 * The evidence pipeline, exercised in whichever engine this project runs.
 *
 * `tests/smoke/evidence-pipeline.spec.ts` proves capture by failing on purpose,
 * and it is gated behind `QUALITYFORGE_EVIDENCE_CHECK=1`, so a normal CI run
 * never reaches it. That leaves the central claim untested in CI: trace and
 * video are `on-first-retry` and `retain-on-failure`, so on a green run nothing
 * is written, and the collector records absent evidence without complaining -
 * by design, "do not guess". An engine that quietly stopped producing either
 * file would leave the build green.
 *
 * So produce them on purpose, through the public Playwright API rather than
 * through a failure, and assert the files are real. This runs in all three
 * browser projects, which is the point: capture is claimed to be
 * browser-agnostic and until now only Chromium had ever been asked.
 */

test.describe("evidence capture", () => {
  test("the project keeps the evidence policy the contract promises", () => {
    // Guards the matrix itself. A new project that forgets `trace`, or that
    // stubs the device descriptor away, would silently produce thinner evidence
    // than the contract claims, and no artifact would ever say so.
    //
    // No fixtures are destructured on purpose: this must not depend on a page
    // existing, because it is asserting what the project promised before any
    // test asked for a browser.
    const use = test.info().project.use;
    expect(use.trace).toBe("on-first-retry");
    expect(use.screenshot).toBe("only-on-failure");
    expect(use.video).toBe("retain-on-failure");
  });

  test("the engine and the device descriptor are both the ones this project claims", async ({
    browser,
    page,
  }) => {
    // Two separate claims, checked separately, because they fail differently.
    //
    // The engine comes from the project name, not from `use`. Verified by
    // putting devices["Desktop Chrome"] on the webkit project: the leg still ran
    // WebKit and still passed. So the engine has to be read back from the
    // running browser, and the descriptor from the user agent, or a
    // copy-pasted project checks green while testing something else.
    const project = test.info().project.name;
    expect(browser.browserType().name(), `project ${project} ran a different engine`).toBe(project);

    // The descriptor has to match the engine too, or the leg is a Safari
    // viewport reporting a Chrome string - evidence that misdescribes itself.
    // `navigator` is spelled out because this project compiles without the DOM
    // lib, which is correct for Node code and wrong for anything that has to
    // reason about a browser.
    const userAgent = await page.evaluate(
      () => (globalThis as unknown as { navigator: { userAgent: string } }).navigator.userAgent,
    );
    const expectedToken: Record<string, string> = {
      chromium: "Chrome/",
      firefox: "Firefox/",
      webkit: "Safari/",
    };
    expect(userAgent, `project ${project} ran with UA ${userAgent}`).toContain(
      expectedToken[project],
    );
  });

  test("writes a non-empty trace and video in this engine", async ({ browser }) => {
    // Own context rather than the `page` fixture: video is recorded per context
    // and only becomes readable once the context is closed.
    const context = await browser.newContext({
      recordVideo: { dir: test.info().outputDir, size: { width: 640, height: 480 } },
    });
    const page = await context.newPage();
    await context.tracing.start({ screenshots: true, snapshots: true });

    await page.goto("/contact");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("alert")).toHaveText("Email is required");

    const tracePath = `${test.info().outputDir}/trace.zip`;
    await context.tracing.stop({ path: tracePath });
    await context.close();

    const files = await readdir(test.info().outputDir);
    const trace = await stat(tracePath);
    const video = files.find((name) => name.endsWith(".webm"));
    expect(video, `no video was written; output dir held ${JSON.stringify(files)}`).toBeTruthy();

    const videoStat = await stat(`${test.info().outputDir}/${video as string}`);
    // A zero-byte file is what a failed recording actually looks like, and it
    // passes an existence check. Size is the only cheap way to tell.
    expect(trace.size).toBeGreaterThan(0);
    expect(videoStat.size).toBeGreaterThan(0);
  });
});
