/**
 * One quality policy, shared by many repositories.
 *
 * ## Why this exists
 *
 * Every project that adopts QualityForge writes its own `config/project.json`, and
 * the same policy — which evidence matters, how a defect is classified, what a
 * shared threshold is — is written again in each one and drifts. There is no way to
 * say "this is how we do quality" once and have it apply everywhere.
 *
 * A project declares one key, `extends`, naming a file. That file carries the shared
 * values; the project's own values win wherever the two overlap.
 *
 * ## The shape of the answer, and why
 *
 * **Per-field merge, project wins.** An organisation that sets a failure-rate
 * threshold and a developer who raises it for one repository must be able to say so
 * without copying the whole section, because copying the whole section is how a
 * shared policy starts drifting again.
 *
 * **After the owner's decisions of 2026-10-18, a policy contains no arrays at all.**
 * Everything shareable — `evidence`, `thresholds`, `defects.writeSummary`,
 * `defects.referenceErrorContext`, `history.keep`, `schemaVersion` — is a scalar or
 * an object of scalars. That removes the one question per-field merging usually
 * gets wrong: what a list from two sources should mean. Here it never arises, and
 * that is a consequence of what was forbidden rather than a convenience.
 *
 * **What may not be shared is refused, not ignored.** `name`, `baseUrl`,
 * `projects`, `tags`, the three artifact directories, `api.expectations` and
 * `perf.pages` all belong to the project that runs the application. A policy that
 * carries them would look authoritative and mean nothing, or worse, mean the wrong
 * thing: a shared `baseUrl` would send every project's artifacts to somebody else's
 * origin.
 */

import path from "node:path";
import { realpath } from "node:fs/promises";

import { ConfigError, parseConfig } from "./load-config.js";

/**
 * Keys a policy may carry.
 *
 * Everything absent from this list and from {@link FORBIDDEN_IN_POLICY} is an
 * error, which is what makes the rule checkable rather than aspirational: a typo in
 * a policy key is a refusal, not a silently ignored line.
 */
export const POLICY_KEYS = [
  "schemaVersion",
  "extends",
  "evidence",
  "thresholds",
  "defects",
] as const;

/**
 * Keys that must stay in the project, each with the reason it is refused.
 *
 * An error rather than an ignored key, and the difference matters: a policy carrying
 * `baseUrl` and being quietly overruled by the project reads as a working shared
 * policy, and a reader would conclude the organisation had declared an origin when
 * nobody did.
 */
export const FORBIDDEN_IN_POLICY: Record<string, string> = {
  name: "it names the project under test, which is the one thing a policy cannot know",
  baseUrl:
    "the origin under test belongs to the project; a shared one would point every project's artifacts at somebody else's server",
  projects:
    "these are the Playwright project names of this repository, and another repository's names do not exist here",
  tags: "artifact labels mix this project's release marks with organisation-wide policy marks, and one filter pulls the wrong one",
  "defects.directory": "where a repository keeps its artifacts is its own arrangement",
  "history.directory": "where a repository keeps its history is its own arrangement",
  "api.directory": "where a repository keeps its API audits is its own arrangement",
  history:
    "a history section needs `directory`, and the directory is this project's own arrangement — so a policy could set `keep` only by shipping a section that is invalid on its own, and 'keep 50 runs' is not worth a configuration that fails to load",
  "api.expectations":
    "contracts describe this application's own endpoints; shared ones would be checked against an address that does not exist here",
  "perf.pages":
    "the pages a budget holds are this application's routes; a shared list would name pages another project does not serve, and an unobserved page is a violation",
};

/** How many `extends` links may be followed before the chain is called a loop. */
export const MAX_POLICY_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A parsed shared policy: the fields a policy may carry, and nothing else. */
export interface SharedPolicy {
  schemaVersion?: string;
  extends?: string;
  evidence?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  defects?: Record<string, unknown>;
  history?: Record<string, unknown>;
}

/**
 * Validate one policy file, before anything is merged from it.
 *
 * Fail-closed at the **load** step and not after merging, because the criterion in
 * #44 is that an invalid shared policy "fails both consumers loudly, at load,
 * rather than half-applying". Validating afterwards would mean a policy half
 * applied before anyone noticed, which is the exact failure the criterion forbids.
 */
export function parsePolicy(raw: unknown, source: string): SharedPolicy {
  const problems: string[] = [];

  if (!isRecord(raw)) {
    throw new ConfigError(`${source} must contain a JSON object`);
  }

  // Refused before anything else, and named with the reason rather than just the
  // key: someone reading this error should learn *why* the field cannot be shared,
  // not only that it cannot.
  for (const [key, reason] of Object.entries(FORBIDDEN_IN_POLICY)) {
    const head = key.split(".")[0]!;
    const tail = key.split(".")[1];
    const section = raw[head];
    const present =
      tail === undefined ? section !== undefined : isRecord(section) && section[tail] !== undefined;
    if (present) {
      problems.push(`policy must not set ${JSON.stringify(key)} — ${reason}`);
    }
  }

  for (const key of Object.keys(raw)) {
    if (!(POLICY_KEYS as readonly string[]).includes(key)) {
      // Already-reported forbidden keys are not also "unknown": two complaints for
      // one line buries the one that explains why.
      if (FORBIDDEN_IN_POLICY[key] !== undefined) continue;
      const nested = Object.entries(FORBIDDEN_IN_POLICY).find(([name]) =>
        name.startsWith(`${key}.`),
      );
      if (nested !== undefined) continue;
      problems.push(
        `unknown policy key ${JSON.stringify(key)}; a policy may set ${POLICY_KEYS.join(", ")}`,
      );
    }
  }

  if (raw.extends !== undefined && (typeof raw.extends !== "string" || raw.extends.trim() === "")) {
    problems.push(`policy extends must be a non-empty string path`);
  }

  for (const section of ["evidence", "thresholds", "defects"] as const) {
    if (raw[section] !== undefined && !isRecord(raw[section])) {
      problems.push(`policy ${section} must be an object`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid shared policy in ${source}`, problems);
  }

  // Now the policy's **values**, by running them through the project's own rules
  // rather than a second copy of them. A second copy would be a fifth place for
  // these rules to live and would drift; this one borrows them.
  //
  // The synthetic project underneath is valid, so every problem that comes back was
  // caused by the policy and is named against the policy. Without this step an
  // impossible value — `maxFailureRate: 5` — survived the policy check, was merged,
  // and failed later with the *project* in the message, so the reader was sent to
  // the wrong file. That is the "half-applying" #44 forbids, in the only disguise
  // it can reach this code in.
  validatePolicyValues(raw, source);

  // Already validated: every key is known and forbidden keys are refused above.
  return raw;
}

/**
 * Overlay a project's own values on a policy's.
 *
 * The project wins, at every level, and a field the project does not mention keeps
 * the policy's value. Objects merge key by key; scalars and arrays are taken whole
 * from the side that has them. Arrays never actually reach here — see the note at
 * the top of this file — but the rule is stated rather than assumed, because a later
 * field becoming shareable should not silently pick up merge-by-concatenation.
 */
export function mergePolicy(
  project: Record<string, unknown>,
  policy: SharedPolicy,
): Record<string, unknown> {
  const inheritedPolicy: Record<string, unknown> = { ...policy };
  const merged: Record<string, unknown> = { ...inheritedPolicy };
  for (const [key, value] of Object.entries(project)) {
    const inherited = inheritedPolicy[key];
    merged[key] = isRecord(value) && isRecord(inherited) ? mergePolicy(value, inherited) : value;
  }
  return merged;
}

/**
 * A project configuration that is valid by construction.
 *
 * Only ever used as the floor under a policy's values, so that a problem reported
 * afterwards can only have come from the policy.
 */
function validProject(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    name: "policy-value-check",
    baseUrl: "http://127.0.0.1:4311",
    projects: ["chromium"],
    evidence: { trace: "on-first-retry", screenshot: "only-on-failure", video: "off" },
    thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 },
    defects: { directory: "artifacts/defects", writeSummary: true, referenceErrorContext: true },
    tags: [],
  };
}

function validatePolicyValues(policy: Record<string, unknown>, source: string): void {
  const overlay: Record<string, unknown> = { ...validProject() };
  for (const section of ["evidence", "thresholds", "defects"] as const) {
    const value = policy[section];
    if (value === undefined) continue;
    overlay[section] = {
      ...(overlay[section] as Record<string, unknown>),
      ...(value as Record<string, unknown>),
    };
  }

  try {
    parseConfig(overlay, "<policy value check>");
    return;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`Invalid shared policy in ${source}`, error.problems);
    }
    throw error;
  }
}

/** One policy, with the file it was read from. */
export interface ResolvedPolicy {
  /** Absolute path, as resolved from the file that named it. */
  file: string;
  policy: SharedPolicy;
}

/** One link in the chain, for a cycle report a reader can follow. */
export interface PolicyLink {
  /** The file that named the next one. */
  from: string;
  /** What it named. */
  to: string;
}

/**
 * Follow `extends` to its end, collecting every policy in the order it applies.
 *
 * Later policies are applied **first**, so the one named first wins — the same way a
 * project's own values win over all of them. Reading the list left to right therefore
 * goes from weakest to strongest, which is what a person wants when reading a chain.
 *
 * A cycle is refused rather than survived. A chain that loops is not a slow run, it
 * is a policy that would keep applying forever, and the visible failure has to come
 * before the invisible one.
 */
export async function collectPolicies(
  first: string,
  readPolicy: (target: string) => Promise<SharedPolicy>,
  resolve: (from: string, declared: string) => string,
  links: PolicyLink[],
  depth = 0,
  read_: string[] = [],
): Promise<ResolvedPolicy[]> {
  if (depth > MAX_POLICY_DEPTH) {
    throw new ConfigError(
      `Shared policy chain is deeper than ${MAX_POLICY_DEPTH} links`,
      links.map((link) => `${link.from} → ${link.to}`),
    );
  }

  // Realpath, so `a/../policy.json` and `policy.json` are recognised as the same
  // file. A cycle written in a different spelling is still a cycle.
  let identity: string;
  try {
    identity = await realpath(first);
  } catch {
    identity = path.resolve(first);
  }
  // Already **read**, not merely named. Every file on the way down appears as some
  // link's target, so matching on links calls the second file of any chain a cycle
  // — found by the chain test refusing to load org.json from team.json, which is
  // inheritance working exactly as intended.
  if (read_.includes(identity)) {
    throw new ConfigError(
      "Shared policy chain contains a cycle",
      links.map((link) => `${link.from} → ${link.to}`).concat([`${first} (already in the chain)`]),
    );
  }

  const policy = await readPolicy(first);
  const collected: ResolvedPolicy[] = [{ file: first, policy }];
  if (policy.extends === undefined) return collected;

  const next = resolve(first, policy.extends);
  const deeper = await collectPolicies(
    next,
    readPolicy,
    resolve,
    [...links, { from: first, to: next }],
    depth + 1,
    [...read_, identity],
  );
  return [...deeper, ...collected];
}
