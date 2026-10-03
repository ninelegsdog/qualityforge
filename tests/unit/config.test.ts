import { expect, test } from "@playwright/test";
import { ConfigError, parseConfig } from "../../src/config/load-config.js";
import { CONFIG_SCHEMA_VERSION } from "../../src/config/types.js";

/** A valid baseline that each case mutates in one place. */
function validConfig(): Record<string, unknown> {
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
    tags: ["demo"],
  };
}

/** Apply a mutation by dotted path and validate. */
function withMutation(apply: (config: Record<string, unknown>) => void): unknown {
  const config = validConfig();
  apply(config);
  return config;
}

test.describe("parseConfig", () => {
  test("accepts a valid configuration unchanged", () => {
    const config = parseConfig(validConfig());

    expect(config.name).toBe("demo");
    expect(config.evidence.trace).toBe("on-first-retry");
    expect(config.thresholds.maxFailureRate).toBeCloseTo(0.05);
  });

  test("rejects a non-object root", () => {
    expect(() => parseConfig("nope")).toThrow(ConfigError);
    expect(() => parseConfig([1, 2])).toThrow(/must contain a JSON object/);
  });

  test("rejects a wrong schema version", () => {
    expect(() => parseConfig(withMutation((c) => (c.schemaVersion = "9.9.9")))).toThrow(
      /schemaVersion must be "1\.0\.0"/,
    );
  });

  test("rejects an out-of-range failure rate", () => {
    expect(() =>
      parseConfig(
        withMutation(
          (c) => ((c.thresholds as never as Record<string, unknown>).maxFailureRate = 1.5),
        ),
      ),
    ).toThrow(/between 0 and 1/);
  });

  test("rejects a non-boolean flag", () => {
    expect(() =>
      parseConfig(
        withMutation((c) => ((c.defects as never as Record<string, unknown>).writeSummary = "yes")),
      ),
    ).toThrow(/defects\.writeSummary must be true or false/);
  });

  test("rejects an unknown evidence mode", () => {
    expect(() =>
      parseConfig(
        withMutation((c) => ((c.evidence as never as Record<string, unknown>).trace = "always")),
      ),
    ).toThrow(/evidence\.trace must be one of on \| off/);
  });

  test("rejects a baseUrl carrying credentials", () => {
    // A baseUrl with a token in it must never reach a committed artifact.
    expect(() =>
      parseConfig(withMutation((c) => (c.baseUrl = "https://user:token@example.com"))),
    ).toThrow(/must not contain credentials/);
  });

  test("rejects a baseUrl with a query string", () => {
    expect(() =>
      parseConfig(withMutation((c) => (c.baseUrl = "https://example.com/?token=abc"))),
    ).toThrow(/must not contain credentials/);
  });

  test("rejects a non-absolute baseUrl", () => {
    expect(() => parseConfig(withMutation((c) => (c.baseUrl = "/relative/path")))).toThrow(
      /must be an absolute URL/,
    );
  });

  test("rejects a non-http protocol", () => {
    expect(() => parseConfig(withMutation((c) => (c.baseUrl = "file:///etc/passwd")))).toThrow(
      /must use http or https/,
    );
  });

  test("reports every problem at once rather than one per run", () => {
    // Built as a literal rather than by mutating a valid one: three separate
    // problems must survive into parseConfig, and casting through `unknown` to
    // inject them would hide whether the validator really sees them.
    const invalid = {
      ...validConfig(),
      name: 42,
      thresholds: { maxFailureRate: "high", maxAttemptsPerTest: 2, maxDurationMs: 900000 },
      tags: "not-an-array",
    };

    try {
      parseConfig(invalid);
      throw new Error("parseConfig should have thrown for an invalid config");
    } catch (error) {
      if (!(error instanceof ConfigError)) {
        throw new Error("expected ConfigError", { cause: error });
      }
      const { problems } = error;
      expect(problems).toHaveLength(3);
      expect(problems.join("\n")).toContain("name must be a string");
      expect(problems.join("\n")).toContain("thresholds.maxFailureRate");
      expect(problems.join("\n")).toContain("tags must be an array of strings");
    }
  });
});
