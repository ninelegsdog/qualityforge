/**
 * Remove generated output. Safe by construction: every path it touches is one
 * this project's tooling produces, and it refuses to act outside the project.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const TARGETS = ["playwright-report", "test-results", "artifacts"];

for (const target of TARGETS) {
  const absolute = path.join(ROOT, target);
  const relative = path.relative(ROOT, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    console.error(`[clean] refusing to remove ${absolute}: outside the project`);
    process.exitCode = 1;
    continue;
  }
  await rm(absolute, { recursive: true, force: true });
  console.log(`[clean] removed ${target}/`);
}
