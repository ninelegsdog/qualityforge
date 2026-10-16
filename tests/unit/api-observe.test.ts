import { expect, test } from "@playwright/test";
import {
  MAX_BODY_BYTES,
  MAX_EXCHANGES_PER_EXPECTATION,
  matchesExpectation,
  mediaType,
  missingFields,
  walkFieldPath,
} from "../../src/api/observe.js";
import { parseFieldPath } from "../../src/config/field-path.js";
import type { ApiExpectation } from "../../src/config/types.js";

/**
 * API capture, in the parts that need no browser.
 *
 * Three of these tests exist because the alternative is invisible:
 *
 * - **A body that cannot be walked reports every declared path missing.** That is
 *   the fail-closed half, and it is asserted against an *absent* body and a
 *   non-JSON one, because "unknown" would let an expectation pass on a response
 *   nobody could check.
 * - **Nothing keeps a value.** `missingFields` returns names only, and the test
 *   that proves it feeds a body whose values are recognisable strings and then
 *   reads the whole result looking for them.
 * - **The exchange cap counts what it dropped.** An unbounded list is how an
 *   artifact becomes unreadable, and a cap that silently forgets is worse than
 *   no cap.
 */
const ITEMS = [
  { id: "AUTH-001", name: "sign-in with valid credentials" },
  { id: "AUTH-003", name: "reset password link expires" },
];

/** The project's own first expectation, so the test follows the real shape. */
const ITEMS_EXPECTATION: ApiExpectation = {
  name: "items-are-json",
  method: "GET",
  path: "/api/items",
  status: 200,
  contentType: "application/json",
  responseRequires: ["[0].id", "[0].name"],
};

test.describe("media types", () => {
  test("drops parameters, so a charset is not part of the contract", () => {
    expect(mediaType("application/json; charset=utf-8")).toBe("application/json");
  });

  test("lower-cases, so a server's casing cannot fail an expectation", () => {
    expect(mediaType("APPLICATION/JSON")).toBe("application/json");
  });

  test("returns nothing for a header that is absent or empty", () => {
    expect(mediaType(undefined)).toBeUndefined();
    expect(mediaType("")).toBeUndefined();
    expect(mediaType("   ")).toBeUndefined();
  });
});

test.describe("matching", () => {
  test("matches on method and path, and on nothing else", () => {
    expect(matchesExpectation(ITEMS_EXPECTATION, "GET", "/api/items")).toBe(true);
    expect(matchesExpectation(ITEMS_EXPECTATION, "POST", "/api/items")).toBe(false);
    expect(matchesExpectation(ITEMS_EXPECTATION, "GET", "/api/other")).toBe(false);
  });

  test("accepts a lowercase method, because browsers send one", () => {
    expect(matchesExpectation(ITEMS_EXPECTATION, "get", "/api/items")).toBe(true);
  });
});

test.describe("walking a body", () => {
  test("reaches through keys and indices alike", () => {
    expect(walkFieldPath(ITEMS, parseFieldPath("[0].id"))).toBe(true);
    expect(walkFieldPath(ITEMS, parseFieldPath("[1].name"))).toBe(true);
    expect(walkFieldPath({ data: { items: ITEMS } }, parseFieldPath("data.items[1].id"))).toBe(
      true,
    );
  });

  test("says no rather than guessing when a step is missing", () => {
    expect(walkFieldPath(ITEMS, parseFieldPath("[0].missing"))).toBe(false);
    expect(walkFieldPath(ITEMS, parseFieldPath("[9].id"))).toBe(false);
    expect(walkFieldPath(ITEMS, parseFieldPath("id"))).toBe(false); // an array has no keys
  });

  test("does not read through an array as if it were an object", () => {
    // `length` exists on an array but is not a declared field of any element. If
    // walking treated an array as an object, `[0].length` would pass for a body
    // that carries no `length` field at all.
    expect(walkFieldPath(ITEMS, parseFieldPath("[0].length"))).toBe(false);
  });
});

test.describe("missing fields", () => {
  test("reports only what the body did not carry", () => {
    expect(missingFields(ITEMS, ["[0].id", "[0].name"])).toEqual([]);
    expect(missingFields(ITEMS, ["[0].id", "[0].missing"])).toEqual(["[0].missing"]);
  });

  test("reports every declared path when the body cannot be walked", () => {
    const declared = ["received", "fields[0]"];
    expect(missingFields(undefined, declared)).toEqual(declared);
    expect(missingFields("a string body", declared)).toEqual(declared);
    expect(missingFields(null, declared)).toEqual(declared);
  });

  test("keeps no value from the body it walked", () => {
    const secret = "p@ssw0rd-that-must-not-survive";
    const result = missingFields({ email: secret, message: secret }, ["email", "message"]);

    // Nothing is missing, and nothing is a value: the result is only field names.
    expect(result).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("p@ssw0rd");
  });

  test("an expectation that declares nothing asks for nothing", () => {
    expect(missingFields(ITEMS, undefined)).toEqual([]);
    expect(missingFields(ITEMS, [])).toEqual([]);
  });
});

test.describe("the bounds", () => {
  test("the body ceiling matches the demo server's own limit", () => {
    // Two numbers that must agree: the fixture refuses to send more than this,
    // and the capture refuses to read more. If they drift, the capture would
    // report "too large" for a body the application is allowed to send.
    expect(MAX_BODY_BYTES).toBe(64 * 1024);
  });

  test("the exchange cap is a count, like signal capture's", () => {
    expect(MAX_EXCHANGES_PER_EXPECTATION).toBe(40);
  });
});

test.describe("the project's own expectations", () => {
  test("both name paths the grammar accepts and something to assert", () => {
    for (const expectation of [ITEMS_EXPECTATION]) {
      expect(missingFields(ITEMS, expectation.responseRequires)).toEqual([]);
    }
  });
});
