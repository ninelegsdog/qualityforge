/**
 * Reading run history: which tests are flaky, and which direction the suite is moving.
 *
 * ## The judgement, stated once
 *
 * History exists to answer one question — is this a regression, or has it always
 * been this way — so every verdict here is derived from **what a spec did in each
 * run it appeared in**, never from a count across all runs. A test that failed once
 * in five runs and passed four times is flaky. A test that failed in five runs out
 * of five, and appeared in five, is failing. Those two look identical if you only
 * keep a failure count, and they call for opposite responses.
 *
 * "Appeared" is the whole difficulty: a pass produces no entry of its own, so
 * presence is read from the run's composition rather than inferred from what
 * happens to be recorded. Inferring it would mean a deleted test looked healthy and
 * a newly added test looked like it had always been failing.
 *
 * What this cannot do is tell a brand-new failure from one that was already there
 * before this window started. `new` means "first appearance in these runs", which
 * is a statement about the history rather than about the test.
 */

import type { HistoryRecord } from "./history.js";

/** What history can say about one spec. */
export type FlakyVerdict =
  /** Failed and passed across the window: the definition, and the reason to look. */
  | "flaky"
  /** Failed in every run it appeared in, and appeared at least twice. */
  | "failing"
  /** Failed in the most recent run and has no earlier record. */
  | "new"
  /** Not present in the most recent run, so whatever it did is not happening now. */
  | "quiet";

export interface FlakyTest {
  id: string;
  verdict: FlakyVerdict;
  /** Runs in which this spec appeared. */
  runs: number;
  /** Runs in which it failed or timed out. */
  failedRuns: number;
  /** Runs it appeared in and neither failed nor timed out, including skips. */
  otherRuns: number;
  /** The most recent outcome recorded for it. */
  lastOutcome: string;
}

export interface FlakinessReport {
  /** How many runs were considered. */
  window: number;
  /** Newest run considered, or undefined when there is no history. */
  latestRunId?: string;
  /**
   * True when at least one run's composition could not be read, so presence for
   * those runs is only what they recorded a non-pass for.
   *
   * Reported rather than swallowed: a caller told `failing` should know the window
   * was partially unread before it treats that as settled.
   */
  partial?: boolean;
  tests: FlakyTest[];
}

/**
 * Which specs look flaky, worst first.
 *
 * **Presence comes from the composition, not from `outcomes`.** A pass has no
 * outcome of its own, so a spec that failed in run 1 and passed in run 2 is absent
 * from run 2's `outcomes` — and if absence were read as "not there", that spec would
 * show one run out of one and be called quietly healthy or newly broken rather than
 * flaky. Reading the composition is what makes "it failed and it passed" visible,
 * and that pair is the whole point of the distinction.
 *
 * An entry whose composition is missing (`complete: false`) contributes only the
 * specs it recorded a non-pass for, and marks the report partial. That errs towards
 * `failing` rather than `flaky`: a reader who acts on a false regression
 * investigates, and a reader who acts on a false flake waits.
 *
 * Sorted by failed runs descending, then by id, so the order is stable across calls
 * — an agent that asks twice gets the same answer, and a diff of two reports means
 * something.
 */
export function flakinessReport(records: HistoryRecord[]): FlakinessReport {
  if (records.length === 0) return { window: 0, tests: [] };

  const partial = records.some((record) => !record.complete);
  const newestIndex = records.length - 1;

  interface Stats {
    runs: number;
    failed: number;
    /** Runs it appeared in and finished green, including a pass after a retry. */
    passed: number;
    lastOutcome: string;
    lastSeenIndex: number;
    presentInNewest: boolean;
  }
  const seen = new Map<string, Stats>();

  records.forEach((record, index) => {
    for (const id of record.present) {
      const outcome = record.entry.outcomes[id] ?? "passed";
      const failed = outcome === "failed" || outcome === "timedOut";
      const green = outcome === "passed" || outcome === "flaky";
      const current = seen.get(id);
      if (current === undefined) {
        seen.set(id, {
          runs: 1,
          failed: failed ? 1 : 0,
          passed: green ? 1 : 0,
          lastOutcome: outcome,
          lastSeenIndex: index,
          presentInNewest: index === newestIndex,
        });
      } else {
        current.runs += 1;
        current.failed += failed ? 1 : 0;
        current.passed += green ? 1 : 0;
        current.lastOutcome = outcome;
        current.lastSeenIndex = index;
        if (index === newestIndex) current.presentInNewest = true;
      }
    }
  });

  const tests: FlakyTest[] = [];
  for (const [id, stats] of seen) {
    // Only specs that failed at least once in the window. A suite with one flaky
    // test does not return three hundred green ones, and a test that never failed is
    // not a question worth putting in front of a reader.
    if (stats.failed === 0) continue;

    let verdict: FlakyVerdict;
    if (!stats.presentInNewest) {
      verdict = "quiet";
    } else if (stats.runs === 1) {
      // First appearance in the window is this run, and it failed. That says the
      // spec is new to the history, not that the failure is new — the difference
      // matters, and only the history can tell them apart.
      verdict = "new";
    } else if (stats.passed > 0) {
      verdict = "flaky";
    } else {
      verdict = "failing";
    }

    tests.push({
      id,
      verdict,
      runs: stats.runs,
      failedRuns: stats.failed,
      otherRuns: stats.runs - stats.failed,
      lastOutcome: stats.lastOutcome,
    });
  }

  tests.sort((a, b) =>
    b.failedRuns !== a.failedRuns ? b.failedRuns - a.failedRuns : a.id.localeCompare(b.id),
  );
  const latestRunId = records[newestIndex]?.entry.runId;
  return {
    window: records.length,
    ...(latestRunId === undefined ? {} : { latestRunId }),
    ...(partial ? { partial: true } : {}),
    tests,
  };
}

export interface TrendPoint {
  runId: string;
  createdAt?: string;
  specs: number;
  passed: number;
  failed: number;
  durationMs?: number;
  /** 0..1 */
  passRate: number;
}

export interface TrendReport {
  /** Runs considered, oldest first. */
  points: TrendPoint[];
  /** Pass rate over the first half and the second half of the window. */
  direction: "improving" | "worsening" | "flat" | "unknown";
  /** Mean duration of the first half and the second half, when both have runs. */
  durationMs: { earlier?: number | undefined; recent?: number | undefined };
  /** Distinct specs that failed anywhere in the window. */
  distinctFailing: number;
}

/**
 * Pass rate and duration across the window, split in half so the direction has
 * something to be a direction *from*.
 *
 * A single number per run would answer "how are we doing" and not "which way", and
 * the question this exists for is the second one. The split is deliberately blunt:
 * with fewer than four runs there is no trend worth claiming, and `unknown` says so
 * rather than fitting a line through two points.
 */
export function trendReport(
  entries: Array<{
    runId: string;
    createdAt?: string;
    counts: { specs: number; passed: number; failed: number };
    durationMs?: number;
    outcomes?: Record<string, string>;
  }>,
): TrendReport {
  const points: TrendPoint[] = entries.map((entry) => {
    const { specs, passed, failed } = entry.counts;
    return {
      runId: entry.runId,
      ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
      specs,
      passed,
      failed,
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      passRate: specs > 0 ? passed / specs : 0,
    };
  });

  const rate = (slice: TrendPoint[]): number =>
    slice.length === 0 ? 0 : slice.reduce((sum, point) => sum + point.passRate, 0) / slice.length;
  const meanDuration = (slice: TrendPoint[]): number | undefined => {
    const withTime = slice.filter((point) => point.durationMs !== undefined);
    if (withTime.length === 0) return undefined;
    return Math.round(
      withTime.reduce((sum, point) => sum + (point.durationMs ?? 0), 0) / withTime.length,
    );
  };

  const first = (slice: TrendPoint[]): number | undefined => meanDuration(slice);
  const half = Math.floor(points.length / 2);
  const earlier = points.slice(0, half);
  const recent = points.slice(half);
  const earlierRate = rate(earlier);
  const recentRate = rate(recent);

  // Below four runs there is no trend, only two or three points and whatever
  // happened to land in them.
  const direction: TrendReport["direction"] =
    points.length < 4
      ? "unknown"
      : recentRate > earlierRate + 0.01
        ? "improving"
        : recentRate < earlierRate - 0.01
          ? "worsening"
          : "flat";

  // Only genuine failures, not skips and not suites that aborted. A skip is not a
  // defect and an abort never ran, so counting either would make a run where nothing
  // executed look like a run where things broke.
  const failingIds = new Set<string>();
  for (const entry of entries) {
    for (const [id, outcome] of Object.entries(entry.outcomes ?? {})) {
      if (outcome === "failed" || outcome === "timedOut") failingIds.add(id);
    }
  }

  return {
    points,
    direction,
    durationMs: {
      ...(first(earlier) === undefined ? {} : { earlier: first(earlier) }),
      ...(first(recent) === undefined ? {} : { recent: first(recent) }),
    },
    distinctFailing: failingIds.size,
  };
}
