/**
 * Run history: enough to answer "is this a regression, or has it always been this
 * way" across runs.
 *
 * ## Why this is not an artifact
 *
 * The repository rule is that evidence artifacts are output and are never
 * committed. A history entry is not an artifact. It is a few hundred bytes of
 * counts and outcomes, it is what makes the project worth having over time rather
 * than over one run, and a question with no answer is worth less than the bytes it
 * would cost to store. So history lives in its own committed directory, configured
 * through `history.directory`, and never inside `defects.directory`.
 *
 * ## Why the composition is stored separately
 *
 * Absence from `outcomes` only means "passed" if the spec was in the run at all. A
 * spec that failed in run 1 and was deleted before run 2 did not pass run 2, and a
 * spec that failed in run 2 and was added after run 1 was never given the chance to
 * fail run 1. Without knowing who was present, "failed once in two runs" and
 * "failed every time it ran" are the same string — which is exactly the distinction
 * between a flake and a regression, and the only reason this file exists.
 *
 * So each entry carries a `composition` key: a hash of every spec id that ran, in
 * report order. The id list itself is written once per *distinct* composition into
 * `compositions/<hash>.json` and reused by every run in that state, which is nearly
 * all of them — the suite's membership changes far less often than it runs. A run
 * entry therefore stays a few hundred bytes instead of repeating three hundred
 * ids, and `git diff` of a run shows counts rather than a rewritten list.
 *
 * ## Why only non-passes are in `outcomes`
 *
 * With presence settled by the composition, `outcomes` holds only what went
 * otherwise: a few lines for a typical run. A missing composition file — a pruned,
 * hand-edited or partial checkout — is reported as `complete: false` rather than
 * silently degrading back to guessing, because a reader that cannot tell the
 * difference between "present" and "unknown" will call a regression a flake.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Bumped if the entry's shape ever changes incompatibly. */
export const HISTORY_SCHEMA_VERSION = "1.0.0" as const;

/** The outcome recorded for one spec that did not simply pass. */
export type HistoryOutcome = "failed" | "timedOut" | "flaky" | "skipped" | "aborted";

export interface HistoryCounts {
  specs: number;
  passed: number;
  failed: number;
  timedOut: number;
  skipped: number;
  flaky: number;
  /** Specs whose suite aborted, so no artifact exists for them. */
  aborted: number;
}

export interface HistoryEntry {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  runId: string;
  createdAt: string;
  /** What was configured, not necessarily where the browser went. See `targetSource`. */
  baseUrl?: string;
  targetSource?: string;
  counts: HistoryCounts;
  durationMs?: number;
  /** Key into `compositions/`: every spec id that ran, in report order. */
  composition: string;
  /** Only the specs that were not a plain pass, keyed by stable spec id. */
  outcomes: Record<string, HistoryOutcome>;
}

/** One run, together with who was in it. */
export interface HistoryRecord {
  entry: HistoryEntry;
  /**
   * Every spec id that ran in this run.
   *
   * Equal to the composition when it could be read, and to the keys of `outcomes`
   * otherwise — a lower bound, since a pass has no outcome of its own. `complete`
   * says which of the two this is.
   */
  present: Set<string>;
  /** False when the composition file was missing, so presence is only a guess. */
  complete: boolean;
}

const COMPOSITION_DIR = "compositions";

/** Names this module owns: an ISO timestamp and a run id's shape. */
function isRunFile(name: string): boolean {
  return name.endsWith(".json") && /^\d{4}-\d{2}-\d{2}T/.test(name);
}

function isCompositionFile(name: string): boolean {
  return name.endsWith(".json") && /^[0-9a-f]{12}\.json$/.test(name);
}

/**
 * Key of a composition: 12 hex characters of its hash.
 *
 * Twelve, not six, because a collision would merge two different suites into one
 * presence set and the failure would be a wrong verdict rather than a wrong error
 * message. At this width two suites of any realistic size cannot collide by
 * accident, and the check below makes a collision detectable anyway.
 */
export function compositionKey(specIds: string[]): string {
  return createHash("sha256").update(specIds.join("\n")).digest("hex").slice(0, 12);
}

function serializeComposition(specIds: string[]): string {
  return `${JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, specIds }, null, 2)}\n`;
}

function parseComposition(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ids = (value as { specIds?: unknown }).specIds;
  if (!Array.isArray(ids)) return undefined;
  if (!ids.every((id): id is string => typeof id === "string")) return undefined;
  return ids;
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HistoryEntry>;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.counts === "object" &&
    candidate.counts !== null &&
    typeof candidate.outcomes === "object" &&
    candidate.outcomes !== null &&
    typeof candidate.composition === "string"
  );
}

function serializeHistoryEntry(entry: HistoryEntry): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

export interface HistoryWriteResult {
  /** Absolute path of the run entry. */
  path: string;
  /** Run ids deleted by rotation. */
  removed: string[];
  /** Composition files deleted because no kept run references them any more. */
  removedCompositions: string[];
  /** Set when the entry was written but rotation could not finish. */
  rotationFailed?: string;
  /** Set when neither the entry nor the composition could be written. */
  failed?: string;
}

/**
 * Write one run's composition and entry, then drop what no kept run needs.
 *
 * The composition is written only when it does not already exist, so a hundred
 * runs of an unchanged suite produce one composition file and a hundred entries.
 * Rotation deletes run entries past `keep`, then any composition no surviving entry
 * references — so the directory cannot grow without bound either, which matters
 * because compositions are the large half.
 *
 * Ordering matters: the entry is written after the composition, because an entry
 * pointing at a composition that does not exist is exactly the `complete: false`
 * case this format is trying to avoid.
 */
export async function recordHistory(options: {
  projectRoot: string;
  directory: string;
  keep: number;
  specIds: string[];
  entry: Omit<HistoryEntry, "composition">;
}): Promise<HistoryWriteResult> {
  const dir = path.resolve(options.projectRoot, options.directory);
  const compositionsDir = path.join(dir, COMPOSITION_DIR);
  const key = compositionKey(options.specIds);

  try {
    await mkdir(compositionsDir, { recursive: true });
    const compositionPath = path.join(compositionsDir, `${key}.json`);
    try {
      await writeFile(compositionPath, serializeComposition(options.specIds), {
        flag: "wx",
        encoding: "utf8",
      });
    } catch (error) {
      // "Already exists" is the normal outcome for every run after the first with
      // an unchanged suite, and is not an error. Anything else is.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `${options.entry.runId}.json`);
    await writeFile(target, serializeHistoryEntry({ ...options.entry, composition: key }), "utf8");
    return { path: target, removed: [], removedCompositions: [] };
  } catch (error) {
    return {
      path: "",
      removed: [],
      removedCompositions: [],
      failed: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Prune past `keep`: oldest run entries first, then compositions nobody references.
 *
 * Only files this module wrote are considered — run files by their naming pattern,
 * compositions by their hash shape — so an unrelated file in the same directory is
 * left alone. Returns what was removed so the caller can say so; a failure to prune
 * is reported rather than thrown, since a directory that grows by one file is a
 * nuisance and not a defect.
 */
export async function rotateHistory(options: {
  projectRoot: string;
  directory: string;
  keep: number;
}): Promise<{ removed: string[]; removedCompositions: string[]; failed?: string }> {
  const dir = path.resolve(options.projectRoot, options.directory);
  const compositionsDir = path.join(dir, COMPOSITION_DIR);
  const removed: string[] = [];
  const removedCompositions: string[] = [];

  try {
    const runNames = (await readdir(dir)).filter(isRunFile).sort();
    // Run ids start with an ISO timestamp, so a lexicographic sort is chronological.
    const excess = Math.max(0, runNames.length - options.keep);
    for (const name of runNames.slice(0, excess)) {
      await rm(path.join(dir, name), { force: true });
      removed.push(name.replace(/\.json$/, ""));
    }

    if (removed.length > 0) {
      // Names, not run ids: the file on disk is `<runId>.json`, and stripping the
      // suffix first makes every read below miss and report the composition as
      // unreferenced — which deletes every composition the suite still needs. Found
      // by this test, not by a type: nothing about the mistake is a type error.
      const keptNames = (await readdir(dir)).filter(isRunFile);
      const referenced = new Set<string>();
      for (const name of keptNames) {
        try {
          const parsed: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
          if (isEntry(parsed)) referenced.add(parsed.composition);
        } catch {
          // An unreadable entry is not a reason to keep every composition forever,
          // and not a reason to delete one either: it contributes no reference.
        }
      }
      for (const name of (await readdir(compositionsDir)).filter(isCompositionFile)) {
        if (referenced.has(name.replace(/\.json$/, ""))) continue;
        await rm(path.join(compositionsDir, name), { force: true });
        removedCompositions.push(name.replace(/\.json$/, ""));
      }
    }
  } catch (error) {
    return {
      removed,
      removedCompositions,
      failed: error instanceof Error ? error.message : String(error),
    };
  }
  return { removed, removedCompositions };
}

/** Every run entry, oldest first. Unreadable files are skipped, not fatal. */
export async function readHistory(projectRoot: string, directory: string): Promise<HistoryEntry[]> {
  const dir = path.resolve(projectRoot, directory);
  let names: string[];
  try {
    names = (await readdir(dir)).filter(isRunFile).sort();
  } catch {
    // No history yet is the ordinary state of a fresh repository.
    return [];
  }

  const entries: HistoryEntry[] = [];
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      // A half-written or hand-edited file must not hide the runs around it.
    }
  }
  return entries;
}

/**
 * Every run with who was present, oldest first.
 *
 * Compositions are read once and shared, since nearly every run references the same
 * one. An entry whose composition cannot be read still appears, with presence
 * reduced to the specs it recorded a non-pass for and `complete` set to false —
 * losing the run would hide a window, and pretending the guess were fact would hide
 * the difference between a flake and a regression.
 */
export async function readHistoryRecords(
  projectRoot: string,
  directory: string,
): Promise<HistoryRecord[]> {
  const dir = path.resolve(projectRoot, directory);
  const entries = await readHistory(projectRoot, directory);
  if (entries.length === 0) return [];

  const compositions = new Map<string, Set<string>>();
  try {
    for (const name of (await readdir(path.join(dir, COMPOSITION_DIR))).filter(isCompositionFile)) {
      try {
        const parsed: unknown = JSON.parse(
          await readFile(path.join(dir, COMPOSITION_DIR, name), "utf8"),
        );
        const ids = parseComposition(parsed);
        if (ids !== undefined) {
          // Deduplicated: two specs can share a defect id when a title repeats within
          // one file, and presence is a set question anyway.
          compositions.set(name.replace(/\.json$/, ""), new Set(ids));
        }
      } catch {
        // One unreadable composition affects only the entries that reference it.
      }
    }
  } catch {
    // No compositions directory at all: every entry below reports complete: false.
  }

  return entries.map((entry) => {
    const present = compositions.get(entry.composition);
    if (present !== undefined) return { entry, present, complete: true };
    return { entry, present: new Set(Object.keys(entry.outcomes)), complete: false };
  });
}
