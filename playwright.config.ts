import { defineConfig, devices } from "@playwright/test";

/**
 * Base URL of the system under test.
 *
 * Defaults to the bundled zero-dependency fixture server so that `npm test`
 * works on a fresh clone with no setup and no third-party network dependency.
 * Point BASE_URL at a real application to run the same suite against it.
 */
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4311";

/**
 * Artifact policy.
 *
 * - trace: on-first-retry, NOT "on". A trace on every test is very expensive;
 *   on CI we only pay for it when something already failed. Locally use
 *   `--trace on` when you actually need it.
 * - screenshot: only-on-failure. Evidence, not noise.
 * - video: retain-on-failure. Keeps the clip only for failures.
 *
 * Rationale: on CI, the trace viewer is the primary debugging tool - it gives
 * the DOM snapshot at each action plus the network log, which screenshots and
 * videos cannot.
 */
/** Pure-logic tests: no browser fixture, so one run is enough. */
const UNIT_TESTS = /tests[\\/]unit[\\/].*\.test\.ts$/;

/** Tests that drive a real browser, and therefore the ones worth repeating. */
const SMOKE_TESTS = /tests[\\/]smoke[\\/].*\.spec\.ts$/;

export default defineConfig({
  testDir: "./tests",
  // Overridable because Playwright clears outputDir on every run. The MCP
  // server check seeds its own evidence in a temporary directory and must not
  // delete test-results/ from whatever suite ran before it.
  outputDir: process.env.QUALITYFORGE_OUTPUT_DIR ?? "./test-results",
  globalSetup: "./tests/setup/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Omit the key entirely rather than passing undefined: the config type is
  // exactOptional, so an explicit undefined is not assignable.
  ...(process.env.CI ? { workers: 2 } : {}),
  timeout: 30_000,
  expect: { timeout: 5_000 },

  /**
   * Reports.
   *
   * JSON and JUnit land in artifacts/json/ so the defect collector, and any CI
   * dashboard, can read machine-readable output instead of scraping the HTML
   * report. Locally the list reporter stays for immediate feedback.
   */
  reporter: process.env.CI
    ? [
        ["github"],
        [
          "html",
          {
            outputFolder: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR ?? "playwright-report",
            open: "never",
          },
        ],
        [
          "json",
          {
            outputFile:
              process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? "artifacts/json/playwright-results.json",
          },
        ],
        ["junit", { outputFile: "artifacts/json/junit.xml" }],
      ]
    : [
        ["list"],
        [
          "html",
          {
            outputFolder: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR ?? "playwright-report",
            open: "never",
          },
        ],
        [
          "json",
          {
            outputFile:
              process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? "artifacts/json/playwright-results.json",
          },
        ],
      ],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  /**
   * The browser matrix.
   *
   * The evidence pipeline is claimed to be browser-agnostic, and until now
   * nothing tested that claim because every leg was Chromium. Each project gets
   * a real device descriptor: the viewport, user agent and locale are part of
   * what a user actually gets, so stubbing them would defeat the point.
   * `tests/smoke/evidence-capture.smoke.spec.ts` asserts both the engine and the
   * descriptor, because they fail independently - the engine comes from the
   * project name, so a copy-pasted descriptor leaves a green leg testing the
   * wrong thing.
   *
   * Unit tests declare no browser fixture, so they run identically in every
   * project. They are held in a `unit` project of their own instead, so that
   * tripling the matrix does not triple the pure-logic tests. That keeps the
   * cost of a new browser in the smoke suite, where the cost actually is.
   *
   * The split is one line of intent: a browser only ever learns something from
   * the smoke suite, so only the smoke suite is worth repeating per browser.
   */
  projects: [
    {
      name: "unit",
      testMatch: UNIT_TESTS,
    },
    {
      name: "chromium",
      testMatch: SMOKE_TESTS,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Firefox pays for a browser context far more than Chromium does.
      // Measured on an 8-core Linux host, warm cache, first call in a process:
      //
      //   engine    launch()   newContext+newPage()   goto()
      //   chromium     0.30s            0.27s        0.19s
      //   firefox      2.50s            4.11s        1.63s
      //   webkit       0.36s            1.19s        0.13s
      //
      // A context is what every single test opens first, and it is 15x more
      // expensive in Firefox. The global 30s timeout was calibrated when every
      // leg was Chromium. The full Firefox smoke suite at 2 workers - the shape
      // CI uses - peaks at 10.3s per test on this host, but a GitHub standard
      // runner has 4 vCPU against this host's 8, and the measured suite is 49s
      // against Chromium's 17s. That is not enough margin to leave the budget
      // alone. Chromium keeps the global timeout unchanged; only the engines
      // that need the headroom get it.
      name: "firefox",
      testMatch: SMOKE_TESTS,
      timeout: 60_000,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      // Same reasoning, smaller factor: 51s against Chromium's 17s at 2 workers,
      // peaking at 7.6s per test on this host.
      name: "webkit",
      testMatch: SMOKE_TESTS,
      timeout: 45_000,
      use: { ...devices["Desktop Safari"] },
    },
  ],

  /**
   * Starts the fixture server before the suite and stops it afterwards.
   * `reuseExistingServer` keeps local iteration fast when the server is already up.
   *
   * One server serves the whole matrix: Playwright starts `webServer` once per
   * run, not once per project, so all browser projects hit the same origin.
   * Verified rather than assumed - a run across all three browsers logged
   * exactly one "serving ... at" line. The consequence is that the port is the
   * shared resource when agents work in parallel, which is why FIXTURE_PORT and
   * BASE_URL must both be exported. See docs/parallel-work.md.
   */
  webServer: {
    command: "node scripts/serve.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
