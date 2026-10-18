import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, loadConfig } from "../../src/config/load-config.js";
import { FORBIDDEN_IN_POLICY, mergePolicy, parsePolicy } from "../../src/config/policy.js";

/**
 * One policy, many projects — and what a policy is not allowed to say.
 *
 * #44's criterion is that the precedence is **shown, not described**, so the tests
 * below assert outcomes rather than shapes, and each rule has a reverse run that
 * breaks it. Two of them found real problems during this phase:
 *
 * - the cycle check compared declared paths rather than realpaths, so a cycle written
 *   `a/../policy.json` was not recognised as the loop it was;
 * - an invalid policy that happened to be read after the project was silently
 *   overridden field by field, which is the "half-applying" the criterion forbids.
 */

/** A minimal valid project configuration, as the loader accepts it. */
function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    name: "checkout",
    baseUrl: "http://127.0.0.1:4311",
    projects: ["chromium"],
    evidence: { trace: "on-first-retry", screenshot: "only-on-failure", video: "off" },
    thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 },
    defects: { directory: "artifacts/defects", writeSummary: true, referenceErrorContext: true },
    tags: [],
    ...overrides,
  };
}

/** A tree with a policy file and a project that extends it. */
function tree(
  policy: Record<string, unknown> | null,
  overrides: Record<string, unknown> = {},
  policyName = "policy.json",
): string {
  const root = mkdtempSync(path.join(tmpdir(), "qf-policy-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  if (policy !== null) {
    writeFileSync(path.join(root, policyName), JSON.stringify(policy, null, 2), "utf8");
  }
  const target = path.join(root, "config", "project.json");
  writeFileSync(target, JSON.stringify(project(overrides)), "utf8");
  return root;
}

function policyFile(root: string, name = "policy.json"): string {
  return path.join(root, name);
}

async function load(root: string) {
  return loadConfig(root);
}

/**
 * The problems a rejection named, joined for one substring check.
 *
 * `paths()` for anything about *which* file, and this for anything about *why*.
 * Mixing them is how a check starts passing for the wrong reason: the cycle tests
 * searched this text for "cycle" and matched the temporary directory's own name —
 * `qf-cycle-a1b2` — in every path the report listed, so both passed with the cycle
 * detection switched off. A check that cannot fail is worse than no check, and that
 * one was failing quietly inside a passing test.
 */
function said(error: unknown): string {
  return (error as Error).message
    .split("\n")
    .map((line) => line.trim())
    .join(" | ");
}

/** The headline a reader sees first, with every path stripped out. */
function headline(error: unknown): string {
  return ((error as Error).message.split("\n")[0] ?? "").replaceAll("/", " ");
}

test.describe("a project that shares a policy", () => {
  test("takes a shared value the project never mentions", async () => {
    // The project states no thresholds at all, which is the whole point of sharing:
    // the answer nobody had to write twice. Written first with a fixture that
    // mentioned all three, where "the project never mentions" was false and the
    // project correctly won.
    const root = mkdtempSync(path.join(tmpdir(), "qf-shared-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "policy.json"),
      JSON.stringify({
        thresholds: { maxFailureRate: 0.02, maxAttemptsPerTest: 3, maxDurationMs: 600000 },
      }),
      "utf8",
    );
    const withoutThresholds = project({ extends: "../policy.json" });
    delete withoutThresholds.thresholds;
    writeFileSync(
      path.join(root, "config", "project.json"),
      JSON.stringify(withoutThresholds),
      "utf8",
    );

    const config = await load(root);

    expect(config.thresholds.maxAttemptsPerTest).toBe(3);
    expect(config.thresholds.maxDurationMs).toBe(600000);
    expect(config.thresholds.maxFailureRate).toBe(0.02);
  });

  test("the project's own value wins over the policy, field by field", async () => {
    // The precedence #44 says must be shown. One field raised, one left shared:
    // if merging were whole-section, the second would move too.
    const root = tree(
      { thresholds: { maxFailureRate: 0.02, maxAttemptsPerTest: 3, maxDurationMs: 600000 } },
      { extends: "../policy.json", thresholds: { maxFailureRate: 0.25 } },
    );

    const config = await load(root);

    expect(config.thresholds.maxFailureRate).toBe(0.25);
    expect(config.thresholds.maxAttemptsPerTest).toBe(3);
  });

  test("a section the policy says nothing about is the project's alone", async () => {
    const root = tree({ thresholds: { maxFailureRate: 0.02 } }, { extends: "../policy.json" });

    const config = await load(root);

    expect(config.evidence.video).toBe("off");
    expect(config.defects.directory).toBe("artifacts/defects");
  });

  test("the project keeps everything a policy is not allowed to set", async () => {
    const root = tree({ thresholds: { maxAttemptsPerTest: 4 } }, { extends: "../policy.json" });

    const config = await load(root);

    expect(config.name).toBe("checkout");
    expect(config.baseUrl).toBe("http://127.0.0.1:4311");
    expect(config.projects).toEqual(["chromium"]);
  });

  test("the merged result is a project configuration, not a hybrid", async () => {
    // `extends` is gone by the time validation runs, so the loader's own strictness
    // applies to exactly the shape a project may write.
    const root = tree({ thresholds: { maxAttemptsPerTest: 4 } }, { extends: "../policy.json" });

    await expect(load(root)).resolves.toBeDefined();
    const config = await load(root);
    expect(Object.keys(config)).not.toContain("extends");
  });
});

test.describe("a policy that cannot be shared", () => {
  for (const [key, value] of [
    ["baseUrl", "https://shared.example.com"],
    ["name", "the-organisation"],
    ["tags", ["org"]],
    ["projects", ["chromium", "firefox"]],
  ] as const) {
    test(`refuses ${key}, and says why`, async () => {
      const root = tree({ [key]: value }, { extends: "../policy.json" });

      const error = await load(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ConfigError);
      expect(said(error)).toContain(`policy must not set "${key}"`);
      // The reason, not only the key: someone editing a shared policy at midnight
      // should learn why this one field is off-limits and what to do instead.
      expect(said(error)).toContain(FORBIDDEN_IN_POLICY[key]!.split(" ")[0]!);
    });
  }

  for (const [section, key, value] of [
    ["defects", "directory", "artifacts/defects"],
    ["history", "directory", "quality-history"],
    ["api", "directory", "artifacts/api"],
  ] as const) {
    test(`refuses ${section}.${key}, and says why`, async () => {
      const root = tree({ [section]: { [key]: value } }, { extends: "../policy.json" });

      const error = await load(root).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(said(error)).toContain(`policy must not set "${section}.${key}"`);
    });
  }

  test("refuses api.expectations, which describe one application's endpoints", async () => {
    const root = tree(
      {
        api: {
          expectations: [{ name: "shared", method: "GET", path: "/api/shared", status: 200 }],
        },
      },
      { extends: "../policy.json" },
    );

    const error = await load(root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(said(error)).toContain('policy must not set "api.expectations"');
  });

  test("an unknown key in a policy is refused rather than ignored", async () => {
    const root = tree({ threshold: { maxFailureRate: 0.02 } }, { extends: "../policy.json" });

    const error = await load(root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(said(error)).toContain('unknown policy key "threshold"');
  });
});

test.describe("a policy that cannot be loaded", () => {
  test("a missing file fails at load, naming the path", async () => {
    const root = tree(null, { extends: "../nowhere.json" });

    const error = await load(root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(said(error)).toContain("nowhere.json");
  });

  test("an invalid policy applies nothing at all", async () => {
    // The criterion's exact words: fails loudly **rather than half-applying**. A
    // policy with one good threshold and one impossible one must leave neither
    // behind, so there is no state in which the project is partly shared.
    // One good threshold and one impossible one. `maxFailureRate` is bounded to
    // 0..1, so 5 cannot survive into a configuration — and the point is that it is
    // refused rather than half-applied with the good value left behind.
    const root = mkdtempSync(path.join(tmpdir(), "qf-halfapply-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "policy.json"),
      JSON.stringify({ thresholds: { maxFailureRate: 5, maxAttemptsPerTest: 3 } }),
      "utf8",
    );
    const silent = project({ extends: "../policy.json" });
    delete silent.thresholds;
    writeFileSync(path.join(root, "config", "project.json"), JSON.stringify(silent), "utf8");

    const error = await load(root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConfigError);
    // The policy is named, and it is the **only** file named: a reader sent to the
    // project would fix the wrong file. Before the policy's own values were checked
    // this error came out as `project.json (with its shared policy)`, which is the
    // same failure with one extra file in the way.
    expect(said(error)).toContain("policy.json");
    expect(said(error)).not.toContain("project.json");
  });

  test("a cycle is refused, and the report names the whole chain", async () => {
    // A loop is not a slow run; it is a policy that would apply forever.
    const root = mkdtempSync(path.join(tmpdir(), "qf-loop-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "one.json"),
      JSON.stringify({ extends: "config/two.json" }),
      "utf8",
    );
    writeFileSync(
      path.join(root, "config", "two.json"),
      JSON.stringify({ extends: "../one.json" }),
      "utf8",
    );
    writeFileSync(
      path.join(root, "config", "project.json"),
      JSON.stringify(project({ extends: "../one.json" })),
      "utf8",
    );

    const error = await load(root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(headline(error)).toContain("cycle");
    // Both links named, so a reader can see which pair closes the loop.
    expect(said(error)).toContain("one.json");
    expect(said(error)).toContain("two.json");
  });

  test("a cycle written in a different spelling is still a cycle", async () => {
    // Found by a reverse run: comparing declared paths let `a/../policy.json` slip
    // past, and the chain ran until the depth cap caught it instead of the cycle
    // check — which is a different error naming a different thing.
    const root = mkdtempSync(path.join(tmpdir(), "qf-loopspelled-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "config", "policy.json"),
      JSON.stringify({ extends: "./../config/policy.json" }),
      "utf8",
    );
    writeFileSync(
      path.join(root, "config", "project.json"),
      JSON.stringify(project({ extends: "./policy.json" })),
      "utf8",
    );

    const error = await load(root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(headline(error)).toContain("cycle");
  });

  test("a chain of policies resolves, and the one named first wins", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-chain-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "config", "org.json"),
      JSON.stringify({
        thresholds: { maxFailureRate: 0.02, maxAttemptsPerTest: 2, maxDurationMs: 900000 },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(root, "config", "team.json"),
      JSON.stringify({
        extends: "./org.json",
        thresholds: { maxAttemptsPerTest: 5 },
      }),
      "utf8",
    );
    const silent = project({ extends: "./team.json" });
    delete silent.thresholds;
    writeFileSync(path.join(root, "config", "project.json"), JSON.stringify(silent), "utf8");

    const config = await load(root);

    // The team's value, where the team spoke; the org's, where it did not.
    expect(config.thresholds.maxAttemptsPerTest).toBe(5);
    expect(config.thresholds.maxDurationMs).toBe(900000);
    expect(config.thresholds.maxFailureRate).toBe(0.02);
  });

  test("a policy declaring another schemaVersion than the project is refused", async () => {
    // Two configuration versions in one load, with no way to say which rules applied,
    // is the thing this check exists to prevent.
    const root = mkdtempSync(path.join(tmpdir(), "qf-version-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "policy.json"),
      JSON.stringify({ schemaVersion: "9.9.9", thresholds: { maxAttemptsPerTest: 4 } }),
      "utf8",
    );
    writeFileSync(
      path.join(root, "config", "project.json"),
      JSON.stringify(project({ extends: "../policy.json" })),
      "utf8",
    );

    const error = await load(root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(said(error)).toContain("schemaVersion");
  });
});

test.describe("the policy pieces on their own", () => {
  test("parsePolicy refuses a forbidden key even when nothing else is wrong", () => {
    expect(() => parsePolicy({ baseUrl: "https://x.example" }, "policy.json")).toThrow(
      /must not set/,
    );
  });

  test("mergePolicy takes the project's value and keeps the policy's other one", () => {
    const merged = mergePolicy(
      { thresholds: { maxFailureRate: 0.25 } },
      { thresholds: { maxFailureRate: 0.02, maxAttemptsPerTest: 3 } },
    );

    expect(merged).toEqual({
      thresholds: { maxFailureRate: 0.25, maxAttemptsPerTest: 3 },
    });
  });

  test("an array from the policy would be taken whole, not concatenated", () => {
    // Stated rather than assumed. No array can reach here today — see policy.ts —
    // and a later change that lets one must not quietly invent concatenation.
    const merged = mergePolicy({ tags: ["local"] }, { tags: ["shared"] } as never);

    expect(merged.tags).toEqual(["local"]);
  });

  test("a policy file that is not an object is refused", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qf-notobject-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(path.join(root, "policy.json"), "[1, 2, 3]", "utf8");
    writeFileSync(
      path.join(root, "config", "project.json"),
      JSON.stringify(project({ extends: "../policy.json" })),
      "utf8",
    );

    const error = await load(root).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(said(error)).toContain("must contain a JSON object");
  });

  test("the policy path is resolved against the file that named it, not the cwd", async () => {
    // A relative path meaning "next to me" rather than "next to wherever the process
    // happens to be", which is the only reading that survives being run from a
    // different directory.
    const root = mkdtempSync(path.join(tmpdir(), "qf-relative-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "policy.json"),
      JSON.stringify({
        thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 7, maxDurationMs: 900000 },
      }),
      "utf8",
    );
    const silent = project({ extends: "../policy.json" });
    delete silent.thresholds;
    writeFileSync(path.join(root, "config", "project.json"), JSON.stringify(silent), "utf8");
    // The one that matters: the same file, reached by an explicit path rather than
    // by convention, from a process whose working directory is the repository.
    const config = await loadConfig(root, path.join(root, "config", "project.json"));

    expect(config.thresholds.maxAttemptsPerTest).toBe(7);
    expect(policyFile(root)).toContain("policy.json");
  });
});
