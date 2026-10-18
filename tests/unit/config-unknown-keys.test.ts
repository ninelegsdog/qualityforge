import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseConfig } from "../../src/config/load-config.js";

/**
 * The configuration validator is fail-closed on keys, not only on values.
 *
 * Measured before this rule existed, 2026-10-18, and it is the reason #44 could not
 * proceed first: `nonsenseKey` at the top level, `evidence.nonsense` and
 * `thresholds.extraKey` were **all accepted**. Values the schema knows were checked
 * strictly, so the validator was strict about what it understood and silent about
 * everything else.
 *
 * #44 makes that fatal rather than untidy. The shared-policy feature introduces one
 * key — `extends` — and its whole function depends on that key being read. A typo
 * in it (`extend`) would have silently disabled inheritance in **every** project
 * that misspelled it, and each of them would have gone on believing it shared a
 * policy with the others.
 *
 * So the rule is: a key this configuration does not define is an error, at every
 * level, and the message says which key and which ones were available.
 */

/** This repository's own configuration, so a test case starts from something valid. */
function valid(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "config", "project.json"), "utf8"),
  ) as Record<string, unknown>;
}

function withChange(change: (config: Record<string, unknown>) => void): unknown {
  const config = valid();
  change(config);
  return config;
}

/** The problems `parseConfig` raised, or `[]` when it raised nothing. */
function problemsFor(raw: unknown): string[] {
  try {
    parseConfig(raw, "config/project.json");
    return [];
  } catch (error) {
    const listed = (error as Error).message.split("\n").slice(1);
    return listed.map((line) => line.trim());
  }
}

test.describe("unknown keys", () => {
  test("this repository's own configuration carries none", () => {
    // A guard with nothing to guard passes forever. If this ever fails, the
    // strictness was made to accommodate a config rather than to catch a mistake.
    expect(problemsFor(valid())).toEqual([]);
  });

  test("an unknown key at the top level is refused", () => {
    const problems = problemsFor(
      withChange((config) => {
        config.nonsenseKey = 1;
      }),
    );

    expect(problems.join("\n")).toContain('unknown key "nonsenseKey"');
  });

  test("an unknown key inside a section is refused", () => {
    // A typo three objects deep is the same mistake as one at the top, and the
    // third one is the hardest to notice — which is why the rule is per level.
    const problems = problemsFor(
      withChange((config) => {
        (config.thresholds as Record<string, unknown>).extraKey = 1;
      }),
    );

    expect(problems.join("\n")).toContain('unknown key "thresholds.extraKey"');
  });

  test("an unknown key in an optional section is refused too", () => {
    const problems = problemsFor(
      withChange((config) => {
        config.api = { directory: "artifacts/api", nonsense: true };
      }),
    );

    expect(problems.join("\n")).toContain('unknown key "api.nonsense"');
  });

  test("the message names the key and suggests the nearest one that exists", () => {
    // The audience is a person editing a file at midnight. "unknown key" alone
    // tells them they made a mistake without helping them find it.
    const problems = problemsFor(
      withChange((config) => {
        (config.thresholds as Record<string, unknown>).maxAttemptsPertest = 2;
      }),
    );

    const said = problems.join("\n");
    expect(said).toContain('unknown key "thresholds.maxAttemptsPertest"');
    expect(said).toContain('did you mean "thresholds.maxAttemptsPerTest"');
  });

  test("a transposed section name is caught, not merely rejected", () => {
    const problems = problemsFor(
      withChange((config) => {
        config.histori = { directory: "quality-history", keep: 3 };
      }),
    );

    expect(problems.join("\n")).toContain('did you mean "history"');
  });

  test("an unknown key far from any real one lists what is available instead", () => {
    // Suggesting the *nearest* key when nothing is close produces confident nonsense,
    // so past two edits the message stops guessing.
    const problems = problemsFor(
      withChange((config) => {
        config.zzzzzzzzzzzzzzzz = 1;
      }),
    );

    const said = problems.join("\n");
    expect(said).toContain('unknown key "zzzzzzzzzzzzzzzz"');
    expect(said).toContain("known keys here are");
    expect(said).not.toContain("did you mean");
  });

  test("the key that #44 depends on is the one thing that must be recognised", () => {
    // `extends` is named in the allowed list from the first commit, before the
    // shared-policy layer exists. A feature whose own key is rejected on day one
    // and accepted on day two is a feature nobody can test until it is finished.
    const problems = problemsFor(
      withChange((config) => {
        config.extends = "../../quality-policy.json";
      }),
    );

    expect(problems.join("\n")).not.toContain("unknown key");
  });
});
