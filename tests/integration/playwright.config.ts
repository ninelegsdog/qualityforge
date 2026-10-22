import { defineConfig } from "@playwright/test";

/**
 * Config for the MCP integration layer only.
 *
 * The root `playwright.config.ts` matches only two patterns, each anchored to
 * its own directory: unit tests with a `.test.ts` suffix and smoke tests with a
 * `.spec.ts` suffix. So a file under `tests/integration/` belongs to no project
 * there and `npx playwright test tests/integration` reports "No tests found".
 * The root config is integrator-owned, so this layer carries its own config
 * instead of editing it (the pattern `scripts/report-check.py` already uses: it
 * writes a scratch config and runs `playwright test --config`).
 *
 * Run this layer with:
 *
 *   npx playwright test --config tests/integration/playwright.config.ts
 *
 * Deliberately different from the root config:
 *
 * - No `globalSetup` and no `webServer`: nothing here opens a browser or an HTTP
 *   endpoint. The MCP server speaks stdio, so the fixture app on BASE_URL is not
 *   part of this layer and requiring it would make these tests depend on a port.
 * - `outputDir` is a sibling of the root suite's `test-results/`, because
 *   Playwright clears `outputDir` on every run — running this layer must not
 *   delete whatever the browser suite left behind.
 * - `reporter` is `list` only: the root config writes `artifacts/json/*`, which
 *   `npm run defects:check` reads as evidence of a suite run. A layer run must
 *   not overwrite it with its own results.
 * - The timeout is 60s rather than 30s: the first run in a fresh checkout builds
 *   `dist/` (tsc over the whole project) before the server can be spawned.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.test\.ts$/,
  outputDir: "../../test-results/mcp-integration",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  projects: [{ name: "integration" }],
});
