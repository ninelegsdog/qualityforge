import { expect, test } from "@playwright/test";

import { baselinePathFor } from "../../src/defect/collect.js";

/**
 * Where a baseline lives, and the fact that the reader and the reader's *message* agree.
 *
 * Written because CI found the opposite, and the unit test for the producer could not:
 * that test supplied its own `lookup`, so the two spellings of the path never met and
 * the assertion agreed with whatever the author believed. This one asks the real
 * function, so a reader and a message that diverge cannot both look right.
 *
 * The bug this pins: the collector printed `home-chromium-linux.png` while it looked in
 * `tests/visual-baselines/`. A filename is not a place.
 */
test.describe("where an appearance baseline lives", () => {
  test("the path carries the directory the project declared", () => {
    // The bare-name regression: dropping the directory makes the message true of a
    // file in the current working directory, which is not where anything looks.
    expect(baselinePathFor("tests/visual-baselines", "/", "chromium", "linux")).toBe(
      "tests/visual-baselines/home-chromium-linux.png",
    );
  });

  test("the root page is named, not left with an empty slug", () => {
    // `/` folding to nothing gives `-chromium-linux.png`, which is a filename and
    // nobody would guess it.
    expect(baselinePathFor("tests/visual-baselines", "/", "chromium", "linux")).not.toContain(
      '-chromium-linux.png"/"',
    );
    expect(baselinePathFor("tests/visual-baselines", "/", "chromium", "linux")).toContain("/home-");
  });

  test("a nested page folds its separators and keeps its shape", () => {
    expect(
      baselinePathFor("tests/visual-baselines", "/docs/getting-started", "chromium", "linux"),
    ).toBe("tests/visual-baselines/docs-getting-started-chromium-linux.png");
  });

  test("the approving engine and the platform are in the name, or the name says nothing", () => {
    // Measured 2026-10-18: no two engines or viewports share a screenshot hash. A file
    // called `home.png` cannot say which of them approved the picture.
    expect(baselinePathFor("b", "/", "chromium", "linux")).not.toBe(
      baselinePathFor("b", "/", "firefox", "linux"),
    );
    expect(baselinePathFor("b", "/", "chromium", "linux")).not.toBe(
      baselinePathFor("b", "/", "chromium", "darwin"),
    );
  });

  test("the platform defaults to this machine's", () => {
    // The one convenience worth having, and tested because a default nobody checks is a
    // default that quietly stops matching.
    expect(baselinePathFor("d", "/", "chromium")).toBe(
      baselinePathFor("d", "/", "chromium", process.platform),
    );
  });
});
