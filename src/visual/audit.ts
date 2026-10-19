/**
 * Turn captured screenshots into a verdict against the committed baselines.
 *
 * ## Three states, and none of them is "fine"
 *
 * A page whose appearance matched its baseline, a page that changed, and a page
 * nobody has ever reviewed are three different facts. Only the first is a pass, and
 * `no-baseline` is a violation rather than an absence: **an appearance nobody
 * approved is not an approved appearance.** Writing a baseline is therefore a
 * separate, explicit action rather than something a run does on the way past — a
 * collector that silently blessed whatever it saw would approve its own baseline.
 *
 * ## The verdict is a hash comparison, which is zero tolerance by construction
 *
 * Byte equality is a real measurement here, not an approximation: chromium produced
 * byte-identical screenshots across five runs in fresh contexts. Comparing hashes
 * needs no threshold, so there is no size of change that was quietly decided not to
 * look for.
 */

import {
  VISUAL_AUDIT_SCHEMA_VERSION,
  VISUAL_VIOLATION_KINDS,
  type VisualAudit,
  type VisualBaseline,
  type VisualPageResult,
  type VisualViolation,
} from "./types.js";
import type { VisualCapturePayload } from "./observe.js";

/** A declared page, as the configuration states it. */
export interface VisualDeclaration {
  /** The page path to hold to its baseline. */
  path: string;
}

/** What the collector found on disk for one declared page. */
export interface BaselineLookup {
  /** The committed baseline, or `undefined` when the file is not there. */
  baseline: (path: string) => VisualBaseline | undefined;
  /**
   * Where the baseline for this page belongs, whether or not it is there.
   *
   * Asked of the collector rather than worked out here, and that is the point: the
   * naming rule — path, project and platform folded into one filename — has exactly
   * one owner. A second spelling inside the producer is two places to disagree, and
   * when they disagree the reader is told to commit a file under a name nothing
   * reads.
   *
   * It is needed at all only for `no-baseline`, where the file does not exist and so
   * cannot be named by the lookup that found it.
   */
  path: (path: string) => string;
}

export interface BuildVisualAuditInput {
  payloads: VisualCapturePayload[];
  declarations: VisualDeclaration[];
  lookup: BaselineLookup;
  baseUrl?: string;
  /** The engine project this run gated on. */
  project?: string;
  createdAt: string;
}

function short(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Build one run's audit.
 *
 * @param input The captures, the declared pages, and what is on disk.
 * @returns The audit, with one entry per declared page.
 */
/**
 * A page this leg did not look at, with nothing claimed about it.
 *
 * Used when the run is not the approved engine. `observations: 0` is the honest count —
 * zero — rather than a number borrowed from a leg that did photograph something, and
 * `baseline: null` says the baseline was not consulted rather than that none exists.
 */
function unobserved(path: string): VisualPageResult {
  return {
    path,
    sha256: null,
    bytes: null,
    viewport: null,
    baseline: null,
    observations: 0,
    tests: 0,
    violations: [],
  };
}

export function buildVisualAudit(input: BuildVisualAuditInput): VisualAudit {
  // Whether this **leg** is the one being gated.
  //
  // Not the same question as "did anything render". The dimension approves one engine,
  // and CI runs three, so on the firefox and webkit legs nothing here is being judged —
  // and a leg that is not judging anything must not fail. Measured: both legs reported
  // `no-observation` on all three pages against a rule that has nothing to say about
  // them.
  //
  // So there are three states, and each is one answer to one question:
  //
  // | state | meaning | a failure |
  // | --- | --- | --- |
  // | not run here | this leg is not the approved engine | no |
  // | ran, page unobserved | the approved engine ran and never looked at this page | yes |
  // | ran, page observed, differs | the approved engine looked and it moved | yes |
  //
  // Fail-closed applies inside the run that is judging. Outside it, there is nothing to
  // be closed about.
  const ran = input.payloads.some((payload) =>
    payload.pages.some((page) => page.browser === input.project),
  );

  const pages: VisualPageResult[] = input.declarations.map((declaration) => {
    let sha256: string | null = null;
    let bytes: number | null = null;
    let viewport: VisualPageResult["viewport"] = null;
    let observations = 0;
    const tests = new Set<number>();
    const distinct = new Set<string>();

    // A plain loop, not `forEach`, and that is not a style preference: TypeScript does
    // not track assignments made inside a callback, so every value written in one
    // stayed narrowed to its initialiser — `null` — and every `!== null` branch below
    // was typed `never`. The linter was right about the code it was shown.
    // This leg is not the approved engine, so there is nothing to say about any page:
    // not a violation, because the question was never asked here.
    if (!ran) return unobserved(declaration.path);

    for (const [index, payload] of input.payloads.entries()) {
      // A test that broke this page on purpose is evidence about its own stub. Counted,
      // recorded, and **not judged** — the same separation the API dimension makes,
      // and for the same reason: without it a green run cannot be told from a
      // deliberately broken one.

      const captured = payload.pages.filter(
        (page) =>
          page.path === declaration.path &&
          page.stubbed !== true &&
          // **Only the approving engine.** The dimension approves one, and judging
          // every engine against its baseline made CI's firefox and webkit legs report
          // `changed` on pages they do not gate. An absent engine is not the approving
          // one: silence is not consent, and treating it as consent would judge a
          // capture against a baseline that never claimed it.
          (page.browser ?? undefined) === input.project,
      );
      if (captured.length === 0) continue;
      observations += captured.length;
      tests.add(index);
      for (const page of captured) {
        // **Every** capture is kept and judged, not just the first. Written after a
        // run reported a change that was not one: the producer kept the first capture
        // of `/` it happened to see, and the baseline had been generated from a clean
        // single-page load — so which test ran first decided the verdict. A page that
        // changed is changed whichever load noticed, and a page seen two ways is a
        // different finding again.
        distinct.add(page.sha256);
        if (sha256 === null) {
          sha256 = page.sha256;
          bytes = page.bytes;
          viewport = page.viewport;
        }
      }
    }

    const baseline = input.lookup.baseline(declaration.path) ?? null;
    const violations: VisualViolation[] = [];

    // Built here, while the values are still `number | null`: further down, the
    // control flow has already proved `sha256` is a string, and describing the
    // viewport from a proven-non-null sibling is the kind of narrowing that turns a
    // real value into `never` without anybody noticing.
    const captured = sha256 === null ? "no screenshot" : `sha256 ${short(sha256)}`;
    const shape =
      viewport === null
        ? "unknown viewport"
        : `${viewport.width}×${viewport.height} dpr${viewport.deviceScaleFactor}`;
    const size = bytes === null ? "" : `, ${bytes} bytes`;

    if (!ran || observations === 0) {
      violations.push({
        kind: "no-observation",
        expected: "the approved appearance",
        observed: "no screenshot was captured",
        observations: 0,
        tests: ran ? tests.size : 0,
      });
    } else if (baseline === null) {
      violations.push({
        kind: "no-baseline",
        expected: "an approved appearance in the repository",
        // Naming the file is the whole difference between a finding a reader can act
        // on and one they can only note. The path comes from the declaration and the
        // baseline lookup, so it is the same string the writer would have used — not a
        // second place spelling out where a baseline lives.
        observed: `no baseline is committed at ${input.lookup.path(declaration.path)}; run \`npm run visual:baselines\` and commit the image it writes`,
        observations,
        tests: tests.size,
      });
    } else if (distinct.size > 1) {
      violations.push({
        kind: "unstable",
        expected: `one appearance, as committed in ${baseline.file}`,
        // How many ways, and the one that was approved, so a reader knows whether
        // they are looking at a disagreement about the page or about the capture.
        observed: `the page rendered ${distinct.size} different ways across ${observations} capture(s)`,
        observations,
        tests: tests.size,
      });
    } else if (sha256 !== null && sha256 !== baseline.sha256) {
      violations.push({
        kind: "changed",
        expected: `sha256 ${short(baseline.sha256)} as committed in ${baseline.file}`,
        // Both hashes, and the byte count beside them: two hashes tell a reader the
        // picture moved, and the sizes tell them whether it moved a little or a lot.
        observed: `${captured} at ${shape}${size}`,
        observations,
        tests: tests.size,
      });
    }

    return {
      path: declaration.path,
      sha256,
      bytes,
      viewport,
      baseline,
      observations,
      tests: tests.size,
      violations,
    };
  });

  const violations = pages.reduce((total, page) => total + page.violations.length, 0);

  return {
    schemaVersion: VISUAL_AUDIT_SCHEMA_VERSION,
    createdAt: input.createdAt,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.project === undefined ? {} : { project: input.project }),
    counts: {
      pages: pages.length,
      tests: input.payloads.length,
      matched: pages.filter((page) => page.violations.length === 0).length,
      withoutBaseline: pages.filter((page) => page.baseline === null).length,
      violations,
    },
    pages,
  };
}

export { VISUAL_VIOLATION_KINDS };
