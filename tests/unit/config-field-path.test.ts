import { test, expect } from "@playwright/test";
import { checkFieldPath } from "../../src/config/field-path.js";

/**
 * The field-path grammar, checked one accepted and one rejected shape at a time.
 *
 * A grammar is the kind of thing that passes everything, because every string is
 * either "probably fine" or a mystery. So each case below is one decision the
 * grammar makes, and a change that quietly reverses one of them turns a row red.
 *
 * The paths that matter most are the array ones. The demo app's only JSON
 * response is an array, so `[0].id` is not a hypothetical shape — it is the only
 * way to say anything about `GET /api/items`.
 */
const AT = "api.expectations[0].responseRequires[0]";

test.describe("field paths", () => {
  const accepted: string[] = [
    "received",
    "_private",
    "data.items",
    "kebab-case-key",
    "[0].id",
    "[0]",
    "items[12].name",
    "a.b.c",
    "a[0][1]",
    "a[0].b[1].c",
  ];

  for (const path of accepted) {
    test(`accepts ${JSON.stringify(path)}`, () => {
      expect(checkFieldPath(path, AT)).toBeNull();
    });
  }

  const rejected: [string, string][] = [
    ["", "must not be empty"],
    [".leading", "must not start with"],
    ["trailing.", "must not end with"],
    ["a..b", "empty segment"],
    ["a.[0]", 'must not put "." before'],
    ["a[0", 'unclosed "["'],
    ["[a]", "index must be 0 or digits"],
    ["[01]", "leading zero"],
    ["[-1]", "index must be 0 or digits"],
    ["a[0]b", 'needs "." or "[" after'],
    ["1abc", "segment must start with a letter"],
    ["a b", "segment must start with a letter"],
  ];

  for (const [path, fragment] of rejected) {
    test(`rejects ${JSON.stringify(path)}`, () => {
      const problem = checkFieldPath(path, AT);
      expect(problem, `${JSON.stringify(path)} was accepted`).not.toBeNull();
      expect(problem).toContain(fragment);
    });
  }

  test("names where the path was written, so the message is actionable", () => {
    expect(checkFieldPath("a..b", AT)).toContain(AT);
  });

  test("reports the offending segment rather than the whole path", () => {
    // A five-segment path with one bad step: the message must quote the step, or
    // the reader has to find it themselves.
    expect(checkFieldPath("a.b.2bad.d", AT)).toContain(JSON.stringify("2bad"));
  });
});
