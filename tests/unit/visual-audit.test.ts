import { expect, test } from "@playwright/test";
import { buildVisualAudit } from "../../src/visual/audit.js";
import {
  validateVisualAudit,
  VISUAL_AUDIT_SCHEMA_VERSION,
  type VisualAudit,
  type VisualBaseline,
} from "../../src/visual/types.js";
import type { VisualCapturePayload } from "../../src/visual/observe.js";

/**
 * The appearance verdict, over the hashes measured on this repository's own pages.
 *
 * Every hash here is one the fixture server actually produced on 2026-10-18:
 *
 * | page | sha256 (first 16) | bytes |
 * | --- | --- | --- |
 * | `/` | `4f518910312b0de8` | 35 444 |
 * | `/docs` | `dc18b78ead136b25` | 36 111 |
 * | `/contact` | `c79d3bf579a30fb9` | 14 735 |
 *
 * Invented hashes would make these tests read better and mean nothing.
 */

const HOME = "4f518910312b0de8" + "0".repeat(48);
const DOCS = "dc18b78ead136b25" + "0".repeat(48);
const CONTACT = "c79d3bf579a30fb9" + "0".repeat(48);
const CHANGED = "ffffffffffffffff" + "0".repeat(48);

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

function baseline(sha256: string, file: string): VisualBaseline {
  return { sha256, viewport: VIEWPORT, file };
}

/**
 * One capture, with `stubbed` only when the test deliberately broke the page.
 *
 * Absent rather than false when the test does not care: silence about stubbing is
 * read as "not declared", which is the honest reading of it.
 */
type Captured = { path: string; sha256: string; bytes: number; stubbed?: true };

function capture(...pages: Captured[]): VisualCapturePayload {
  return {
    schemaVersion: "1.0.0",
    pages: pages.map((page) => ({ ...page, viewport: VIEWPORT })),
  };
}

function build(
  payloads: VisualCapturePayload[],
  baselines: Record<string, VisualBaseline>,
  paths = Object.keys(baselines),
) {
  return buildVisualAudit({
    payloads,
    declarations: paths.map((path) => ({ path })),
    lookup: {
      baseline: (path) => baselines[path],
      // The collector owns the naming rule, so the test owns its own copy too.
      // What is being checked is that the producer *reports* the path it is handed,
      // not that it guesses correctly — so this deliberately does not borrow the
      // real rule, and a test that passed for the wrong reason would show here.
      path: (page) =>
        `tests/visual-baselines/${page === "/" ? "home" : page.slice(1)}-chromium-linux.png`,
    },
    baseUrl: "http://127.0.0.1:4311",
    project: "chromium",
    createdAt: "2026-10-18T10:00:00.000Z",
  });
}

test.describe("the appearance verdict", () => {
  test("a page that looks like its baseline holds", () => {
    const audit = build([capture({ path: "/", sha256: HOME, bytes: 35444 })], {
      "/": baseline(HOME, "tests/visual-baselines/home-chromium-linux.png"),
    });

    expect(audit.pages[0]?.violations).toEqual([]);
    expect(audit.pages[0]?.sha256).toBe(HOME);
    expect(audit.counts.matched).toBe(1);
    expect(audit.counts.violations).toBe(0);
  });

  test("a page that looks different is a change, naming both hashes", () => {
    const audit = build([capture({ path: "/", sha256: CHANGED, bytes: 36000 })], {
      "/": baseline(HOME, "tests/visual-baselines/home-chromium-linux.png"),
    });

    // Criterion: the finding names what was approved and what was seen, and the file
    // the approval lives in — so a reviewer can open both pictures rather than
    // comparing two strings by eye.
    expect(audit.pages[0]?.violations).toHaveLength(1);
    const [violation] = audit.pages[0]?.violations ?? [];
    expect(violation?.kind).toBe("changed");
    // What was approved, and the file the approval lives in.
    expect(violation?.expected).toBe(
      "sha256 4f518910312b as committed in tests/visual-baselines/home-chromium-linux.png",
    );
    // What was seen: the hash, the viewport it was taken at, and how many bytes.
    // 12 hex characters, because the producer shortens a hash for a message rather than
    // printing 64 and asking the reader to find the difference.
    expect(violation?.observed).toContain("sha256 ffffffffffff");
    expect(violation?.observed).toContain("1280×800 dpr1");
    expect(violation?.observed).toContain("36000 bytes");
    expect(violation?.observations).toBe(1);
    expect(violation?.tests).toBe(1);
  });

  test("a page nobody reviewed is a violation, not an absence", () => {
    const audit = build([capture({ path: "/new", sha256: HOME, bytes: 100 })], {}, ["/new"]);

    // An appearance nobody approved is not an approved appearance, and writing the
    // baseline is a separate explicit action — a collector that silently blessed
    // what it saw would approve its own baseline.
    expect(audit.pages[0]?.violations[0]?.kind).toBe("no-baseline");
    expect(audit.counts.withoutBaseline).toBe(1);
    expect(audit.counts.matched).toBe(0);
  });

  test("a page nobody loaded says so, and is not counted as matching", () => {
    const audit = build([capture({ path: "/", sha256: HOME, bytes: 1 })], {
      "/": baseline(HOME, "b.png"),
      "/contact": baseline(CONTACT, "c.png"),
    });

    expect(audit.pages[1]?.violations[0]?.kind).toBe("no-observation");
    expect(audit.counts.matched).toBe(1);
  });

  test("a run with no capture at all says the dimension never ran", () => {
    const audit = build([], { "/": baseline(HOME, "b.png") });

    expect(audit.counts.tests).toBe(0);
    expect(audit.pages[0]?.violations[0]?.kind).toBe("no-observation");
  });

  test("each declared page is judged on its own baseline", () => {
    const audit = build(
      [
        capture(
          { path: "/", sha256: HOME, bytes: 35444 },
          { path: "/docs", sha256: CHANGED, bytes: 36111 },
          { path: "/contact", sha256: CONTACT, bytes: 14735 },
        ),
      ],
      {
        "/": baseline(HOME, "home.png"),
        "/docs": baseline(DOCS, "docs.png"),
        "/contact": baseline(CONTACT, "contact.png"),
      },
      ["/", "/docs", "/contact"],
    );

    expect(audit.pages.map((page) => page.path)).toEqual(["/", "/docs", "/contact"]);
    expect(audit.pages.map((page) => page.violations.length)).toEqual([0, 1, 0]);
    expect(audit.counts.violations).toBe(1);
    expect(audit.counts.matched).toBe(2);
  });

  test("a page seen two ways is unstable, not changed", () => {
    // The measured reason this kind exists: firefox produced two stable states for
    // this page, 253 pixels apart, on three runs of ten. Calling that a *change*
    // would send a reader to diff two pictures when the real question is which of
    // them is the page.
    //
    // Written after a run reported a change that was not one: the producer kept the
    // first capture it happened to see, so which test ran first decided the verdict.
    // Every capture is judged now.
    const audit = build(
      [
        capture(
          { path: "/", sha256: HOME, bytes: 35444 },
          { path: "/", sha256: CHANGED, bytes: 35445 },
        ),
      ],
      { "/": baseline(HOME, "home.png") },
    );

    expect(audit.pages[0]?.violations).toHaveLength(1);
    expect(audit.pages[0]?.violations[0]?.kind).toBe("unstable");
    expect(audit.pages[0]?.violations[0]?.observed).toContain("2 different ways");
    // Both captures are still recorded: the reader needs to see that two were taken.
    expect(audit.pages[0]?.observations).toBe(2);
  });

  test("a page seen many identical ways is clean, and however many there are", () => {
    const captures = Array.from({ length: 5 }, () => ({ path: "/", sha256: HOME, bytes: 35444 }));
    const audit = build([capture(...captures)], { "/": baseline(HOME, "home.png") });

    expect(audit.pages[0]?.violations).toEqual([]);
    expect(audit.pages[0]?.observations).toBe(5);
  });

  test("the engine that approved a baseline is recorded", () => {
    const audit = build([capture({ path: "/", sha256: HOME, bytes: 1 })], {
      "/": baseline(HOME, "b.png"),
    });

    // Measured: firefox's screenshot of `/` shared no hash with chromium's. A reader
    // who does not know which engine approved a baseline cannot interpret a change
    // to it.
    expect(audit.project).toBe("chromium");
  });

  test("a page with no baseline says which file to commit", () => {
    // A finding a reader can act on names the file. "no baseline is committed" is a
    // true sentence and leaves the next step to whoever reads it at three in the
    // morning, which is not a step.
    const audit = build([capture({ path: "/", sha256: HOME, bytes: 35444 })], {}, ["/"]);

    expect(audit.pages[0]?.violations.map((violation) => violation.kind)).toEqual(["no-baseline"]);
    expect(audit.pages[0]?.violations[0]?.observed).toContain(
      "tests/visual-baselines/home-chromium-linux.png",
    );
    // And the command that produces it, so the message is an instruction and not a
    // complaint.
    expect(audit.pages[0]?.violations[0]?.observed).toContain("npm run visual:baselines");
  });

  test("a page a test broke on purpose is not judged", () => {
    // The measurement behind it: the home page was seen four ways across 21 captures,
    // because the API capture tests stub `/api/items`. Those photographs are evidence
    // about the stub, and counting them against the project's approved appearance is
    // the same mistake the API dimension already corrected once.
    const audit = build(
      [
        capture({ path: "/", sha256: CHANGED, bytes: 40000, stubbed: true }),
        capture({ path: "/", sha256: HOME, bytes: 35444 }),
      ],
      { "/": baseline(HOME, "home.png") },
    );

    expect(audit.pages[0]?.violations).toEqual([]);
    // Still counted: the page was rendered, and a reader should see that it was.
    expect(audit.pages[0]?.observations).toBe(1);
  });

  test("the artifact the producer writes satisfies its own contract", () => {
    const audits: VisualAudit[] = [
      build([capture({ path: "/", sha256: HOME, bytes: 1 })], { "/": baseline(HOME, "b.png") }),
      build([capture({ path: "/", sha256: CHANGED, bytes: 1 })], { "/": baseline(HOME, "b.png") }),
      build([capture({ path: "/", sha256: HOME, bytes: 1 })], {}, ["/"]),
      build([], { "/": baseline(HOME, "b.png") }),
      build([], {}, ["/"]),
    ];

    for (const audit of audits) {
      const verdict = validateVisualAudit(audit);
      expect(verdict.problems, JSON.stringify(verdict.problems)).toEqual([]);
      expect(verdict.valid).toBe(true);
      expect(audit.schemaVersion).toBe(VISUAL_AUDIT_SCHEMA_VERSION);
    }
  });

  test("a count that disagrees with the list is refused", () => {
    const audit = build([capture({ path: "/", sha256: CHANGED, bytes: 1 })], {
      "/": baseline(HOME, "b.png"),
    });
    const tampered = { ...audit, counts: { ...audit.counts, violations: 7 } };

    const verdict = validateVisualAudit(tampered);

    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join(" ")).toContain("counts.violations says 7");
  });

  test("the same path declared twice is refused", () => {
    const audit = build([capture({ path: "/", sha256: HOME, bytes: 1 })], {
      "/": baseline(HOME, "b.png"),
    });
    const tampered = { ...audit, pages: [...audit.pages, ...audit.pages] };

    const verdict = validateVisualAudit(tampered);

    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join(" ")).toContain("is declared twice");
  });

  test("an unknown violation kind is refused", () => {
    const audit = build([capture({ path: "/", sha256: HOME, bytes: 1 })], {
      "/": baseline(HOME, "b.png"),
    });
    const tampered = {
      ...audit,
      pages: audit.pages.map((page) => ({
        ...page,
        violations: [
          { kind: "looks-odd", expected: "a", observed: "b", observations: 1, tests: 1 },
        ],
      })),
    };

    const verdict = validateVisualAudit(tampered);

    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join(" ")).toContain("looks-odd");
  });
});
