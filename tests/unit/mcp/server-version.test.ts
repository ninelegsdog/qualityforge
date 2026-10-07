import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SERVER_VERSION } from "../../../src/mcp/protocol.js";

/**
 * The version on the wire and the version in the package are two strings
 * that must say the same thing, and until this test neither said so anywhere:
 * `SERVER_VERSION` was hand-maintained in `protocol.ts`, and the
 * `0.1.0-alpha.2` bump caught it still reading `0.1.0-alpha.1` — while
 * `package:check` packed a tarball named for the new release and the battery
 * stayed green, because no check compared the two numbers.
 *
 * This is that comparison. A bump that touches `package.json` and forgets
 * `protocol.ts` fails here and names both values. It was red on its first
 * run, which is the only evidence a new check can offer.
 */
test("SERVER_VERSION says what package.json says", () => {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  };

  expect(
    SERVER_VERSION,
    `src/mcp/protocol.ts reports ${SERVER_VERSION} over the wire, ` +
      `package.json is at ${pkg.version} — one release carries one number`,
  ).toBe(pkg.version);
});
