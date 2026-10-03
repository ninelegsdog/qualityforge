/**
 * Thin re-export so test files read as `import { test, expect } from "../fixtures.js"`.
 *
 * The implementation lives in `src/` because it is product code that consumers
 * of this package reuse, not a test helper of this repository.
 */
export { ATTACHMENT_NAME, expect, test } from "../src/fixtures/quality-context.js";
export type { QualityFixtures } from "../src/fixtures/quality-context.js";
