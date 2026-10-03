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
export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
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
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["json", { outputFile: "artifacts/json/playwright-results.json" }],
        ["junit", { outputFile: "artifacts/json/junit.xml" }],
      ]
    : [
        ["list"],
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["json", { outputFile: "artifacts/json/playwright-results.json" }],
      ],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /**
   * Starts the fixture server before the suite and stops it afterwards.
   * `reuseExistingServer` keeps local iteration fast when the server is already up.
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
