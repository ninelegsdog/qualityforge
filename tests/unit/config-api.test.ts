import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError, parseConfig } from "../../src/config/load-config.js";
import { CONFIG_SCHEMA_VERSION } from "../../src/config/types.js";

/**
 * `api.expectations`, the declared API contracts.
 *
 * Two of these tests are about a failure the configuration cannot fail:
 *
 * - **An expectation that asserts nothing** would be satisfied by any exchange
 *   at its path, so it would sit in the file looking like coverage while checking
 *   nothing. Refused.
 * - **Two expectations sharing a name** would produce two artifacts with one id.
 *   The collector already refuses that for defects rather than writing both, so
 *   the configuration refuses it at the source instead.
 *
 * The rest is the ordinary grammar, and each case mutates one place so a failure
 * names the rule rather than the shape of the whole file.
 */

/** A valid baseline holding one well-formed expectation. */
function configWith(expectations: unknown[]): unknown {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name: "demo",
    baseUrl: "http://127.0.0.1:4311",
    projects: ["chromium"],
    evidence: {
      trace: "on-first-retry",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    },
    thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 },
    defects: {
      directory: "artifacts/defects",
      writeSummary: true,
      referenceErrorContext: true,
    },
    api: { expectations },
    tags: ["demo"],
  };
}

const GOOD = {
  name: "items-are-json",
  method: "GET",
  path: "/api/items",
  status: 200,
  contentType: "application/json",
  responseRequires: ["[0].id"],
};

/** Validate a config carrying one expectation mutated by `apply`. */
function expectProblem(apply: (entry: Record<string, unknown>) => void): string {
  const entry = { ...GOOD };
  apply(entry);
  try {
    parseConfig(configWith([entry]));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.join("; ");
  }
  throw new Error("the configuration was accepted");
}

test.describe("api.expectations", () => {
  test("is optional, the way history is", () => {
    const config = parseConfig({ ...(configWith([]) as Record<string, unknown>), api: undefined });
    expect(config.api).toBeUndefined();
  });

  test("accepts a well-formed expectation, indices and all", () => {
    const config = parseConfig(configWith([{ ...GOOD, responseRequires: ["data.items[0].name"] }]));
    const expectation = config.api?.expectations?.[0];

    expect(expectation?.name).toBe("items-are-json");
    expect(expectation?.method).toBe("GET");
    expect(expectation?.responseRequires).toEqual(["data.items[0].name"]);
  });

  test("refuses an expectation that asserts nothing", () => {
    // All four assertion kinds removed: with only a method and a path left, any
    // exchange at that path would satisfy it.
    expect(
      expectProblem((entry) => {
        delete entry.status;
        delete entry.contentType;
        delete entry.responseRequires;
      }),
    ).toContain("asserts nothing");
  });

  test("refuses a duplicated name rather than producing two artifacts with one id", () => {
    try {
      parseConfig(configWith([GOOD, { ...GOOD }]));
      throw new Error("the configuration was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.join("; ")).toContain("already used by an earlier");
    }
  });

  test("refuses a name that is not kebab-case", () => {
    expect(expectProblem((entry) => (entry.name = "Items_Are_JSON"))).toContain("kebab-case");
  });

  test("refuses a method it does not know", () => {
    expect(expectProblem((entry) => (entry.method = "FETCH"))).toContain("must be one of");
  });

  test("refuses a path that is not a path", () => {
    expect(expectProblem((entry) => (entry.path = "api/items"))).toContain('must begin with "/"');
    expect(expectProblem((entry) => (entry.path = "/api/items?page=2"))).toContain(
      "must not carry a query string",
    );
    expect(expectProblem((entry) => (entry.path = "/api/../../etc/passwd"))).toContain('".."');
  });

  test("refuses a content type carrying parameters", () => {
    // `application/json; charset=utf-8` is what a response carries. The contract
    // names the media type, or every expectation would have to spell a charset.
    expect(
      expectProblem((entry) => (entry.contentType = "application/json; charset=utf-8")),
    ).toContain("without parameters");
  });

  test("refuses a status outside the HTTP range or a fractional one", () => {
    expect(expectProblem((entry) => (entry.status = 99))).toContain("must be between 100 and 599");
    expect(expectProblem((entry) => (entry.status = 200.5))).toContain("whole number");
  });

  test("refuses a malformed field path and says where it was written", () => {
    const problem = expectProblem((entry) => (entry.responseRequires = ["a..b"]));
    expect(problem).toContain("api.expectations[0].responseRequires[0]");
  });

  test("refuses a non-array where required fields are expected", () => {
    expect(expectProblem((entry) => (entry.responseRequires = "id"))).toContain(
      "must be an array of field paths",
    );
  });

  test("refuses api that is not an object", () => {
    const config = { ...(configWith([]) as Record<string, unknown>), api: [] };
    expect(() => parseConfig(config)).toThrow(/api must be an object/);
  });
});

test.describe("the project's own configuration", () => {
  test("declares expectations the demo app really makes", async () => {
    const raw = await readFile(path.join(process.cwd(), "config", "project.json"), "utf8");
    const config = parseConfig(JSON.parse(raw));
    const names = (config.api?.expectations ?? []).map((e) => e.name);

    // Both directions, and the array syntax that the measurement forced:
    // `GET /api/items` answers with an array, so `[0].id` is the only way to
    // say anything about it.
    expect(names).toEqual(["items-are-json", "contact-is-posted-and-accepted"]);
    expect(config.api?.expectations?.[1]?.requestRequires).toEqual(["email", "message"]);
  });
});
