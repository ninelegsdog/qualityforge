import { expect, test } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfiguration } from "../../src/config/load-config.js";
import { collectDefects } from "../../src/defect/collect.js";

/**
 * Two throwaway projects, one shared policy — and the precedence shown.
 *
 * #44's criterion is that the override precedence is **shown, not described**, so
 * this file reads the checked-in example under `examples/shared-policy/` rather
 * than building a tree in a temporary directory. A reader who wants to see how
 * sharing looks has something to open, and the numbers below cannot drift from it:
 * they are read out of the same files a person would read.
 *
 * The example states, deliberately, what each project insists on:
 *
 * - `checkout` overrides **nothing**, so every shared value reaches it;
 * - `support` overrides **one threshold**, so the reader can see a single field win
 *   while the other two arrive from the policy — which is the case a whole-section
 *   merge would get wrong.
 *
 * And the third assertion is the one a real repository needs: **change the shared
 * value and both projects observe it.** A policy that only one of two projects reads
 * is not a shared policy, and nothing in a single-project test could tell.
 */

const EXAMPLE = path.join(process.cwd(), "examples", "shared-policy");

function projectConfig(name: string): string {
  return path.join(EXAMPLE, name, "config", "project.json");
}

test.describe("two projects, one policy", () => {
  test("a project that overrides nothing takes every shared value", async () => {
    const { config, policyChain } = await loadConfiguration(EXAMPLE, projectConfig("checkout"));

    // Shared, and the project's own file says none of them.
    expect(config.thresholds.maxFailureRate).toBe(0.02);
    expect(config.thresholds.maxAttemptsPerTest).toBe(3);
    expect(config.evidence.video).toBe("off");
    expect(config.defects.writeSummary).toBe(true);

    // And the chain says where they came from, which is the whole point of the field
    // that arrived with #44: two projects on one policy produce artifacts that
    // otherwise look exactly like projects that wrote everything themselves.
    //
    // Paths are relative to the **project root**, which here is the example directory
    // itself, so the policy inside it reads as `policy.json`. Run against
    // `examples/shared-policy/checkout` it would read `../../policy.json`, and both
    // are the same file — the point being that a reader is told which file, not
    // handed a chain of `../..` that means nothing outside the checkout.
    expect(policyChain).toEqual(["policy.json"]);
  });

  test("a project that overrides one field wins that field and inherits the rest", async () => {
    // The case a whole-section merge gets wrong, and the reason merging is per field:
    // `support` needs a slower checkout than the organisation's default, and must not
    // have to copy the other two thresholds to say so.
    const { config } = await loadConfiguration(EXAMPLE, projectConfig("support"));

    expect(config.thresholds.maxDurationMs).toBe(1800000);
    expect(config.thresholds.maxFailureRate).toBe(0.02);
    expect(config.thresholds.maxAttemptsPerTest).toBe(3);
  });

  test("each project keeps the things a policy is not allowed to say", async () => {
    const checkout = (await loadConfiguration(EXAMPLE, projectConfig("checkout"))).config;
    const support = (await loadConfiguration(EXAMPLE, projectConfig("support"))).config;

    expect(checkout.name).toBe("checkout");
    expect(checkout.baseUrl).toBe("http://127.0.0.1:4311");
    expect(checkout.tags).toEqual(["team-payments"]);

    expect(support.name).toBe("support");
    expect(support.baseUrl).toBe("http://127.0.0.1:4312");
    expect(support.tags).toEqual(["team-infra"]);
  });

  test("changing the shared value moves both projects at once", async () => {
    // The property that makes this a *shared* policy rather than two files that happen
    // to agree. A policy only one of two projects reads is not shared, and nothing
    // inside one project could tell.
    //
    // On a **copy** of the example, and that is a correction: the first version edited
    // the checked-in policy in place, and because the tests in this file run in
    // parallel the siblings read the half-applied value and failed with `0.01` where
    // they expected `0.02`. A test that mutates a tracked file corrupts whatever runs
    // beside it, so the copy is the fix rather than a slower run.
    const scratch = mkdtempSync(path.join(tmpdir(), "qf-shared-example-"));
    cpSync(EXAMPLE, scratch, { recursive: true });
    const policyPath = path.join(scratch, "policy.json");
    const original = readFileSync(policyPath, "utf8");

    const checkoutPath = path.join(scratch, "checkout", "config", "project.json");
    const supportPath = path.join(scratch, "support", "config", "project.json");
    const loadCheckout = () => loadConfiguration(scratch, checkoutPath);
    const loadSupport = () => loadConfiguration(scratch, supportPath);

    const before = {
      checkout: (await loadCheckout()).config.thresholds.maxFailureRate,
      support: (await loadSupport()).config.thresholds.maxFailureRate,
    };
    expect(before.checkout).toBe(0.02);

    const moved = original.replace('"maxFailureRate": 0.02', '"maxFailureRate": 0.01');
    expect(moved, "the policy no longer holds the value this test edits").not.toBe(original);
    writeFileSync(policyPath, moved, "utf8");

    // Both move together.
    expect((await loadCheckout()).config.thresholds.maxFailureRate).toBe(0.01);
    expect((await loadSupport()).config.thresholds.maxFailureRate).toBe(0.01);
    // And the shared change did not flatten the override.
    expect((await loadSupport()).config.thresholds.maxDurationMs).toBe(1800000);
    // While both still know they share a policy.
    expect((await loadCheckout()).policyChain).toEqual(["policy.json"]);
  });

  test("the example's own files are valid, with nothing borrowed from elsewhere", async () => {
    // A guard against the example rotting into something that only works because of
    // this repository's configuration: both projects load against the example's
    // policy and nothing else.
    for (const name of ["checkout", "support"]) {
      const { config } = await loadConfiguration(EXAMPLE, projectConfig(name));
      expect(config.name, `${name} did not load its own name`).toBe(name);
    }
  });
});

test.describe("what a run records about it", () => {
  // Found by a reverse run: breaking the summary's policy field left every other test
  // green, because they all read `policyChain` from `loadConfiguration` and none of
  // them looked at what a run writes down. A contract field with no test is a field
  // nobody can break on purpose.
  async function collect(root: string, policyChain?: string[]) {
    mkdirSync(path.join(root, "artifacts", "json"), { recursive: true });
    writeFileSync(
      path.join(root, "artifacts/json/playwright-results.json"),
      JSON.stringify({
        config: { rootDir: path.join(root, "tests") },
        stats: { startTime: "2026-10-17T09:00:00.000Z", duration: 100 },
        suites: [],
      }),
      "utf8",
    );
    const { summary } = await collectDefects({
      projectRoot: root,
      testDir: "tests",
      outputDir: "artifacts/defects",
      reportPath: "artifacts/json/playwright-results.json",
      baseUrl: "http://127.0.0.1:4311",
      thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 },
      now: new Date("2026-10-18T09:00:00.000Z"),
      commit: "deadbeef",
      branch: "main",
      ...(policyChain === undefined ? {} : { policyChain }),
    });
    return summary;
  }

  test("a run that inherited a policy records the chain", async () => {
    const summary = await collect(mkdtempSync(path.join(tmpdir(), "qf-chain-recorded-")), [
      "../../quality-policy.json",
      "./team-policy.json",
    ]);

    // In application order: weakest first, the one named first last.
    expect(summary.policy).toEqual({
      chain: ["../../quality-policy.json", "./team-policy.json"],
    });
  });

  test("a run that inherited nothing carries no policy at all", async () => {
    // Absent, not empty. An empty chain would claim a check was made — that nothing
    // was inherited — which is true here, and false of every run for which nobody
    // asked. The field only appears when the caller resolved a policy.
    const summary = await collect(mkdtempSync(path.join(tmpdir(), "qf-chain-absent-")));

    expect(summary.policy).toBeUndefined();
  });
});
