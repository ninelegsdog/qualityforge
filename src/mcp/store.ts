/**
 * Read-only access to defect artifacts, confined to a configured root.
 *
 * ## The security property
 *
 * Every path from a client is treated as hostile. Client-side path allowlists
 * are not a boundary: the Kilo config on this machine allows `/home/*`, and a
 * prompt can ask for more. Confinement is therefore enforced here, on the
 * server, and it does not depend on the client cooperating.
 *
 * Rejected, in order:
 *   - absolute paths
 *   - `..` traversal, before and after percent-decoding
 *   - NUL bytes
 *   - symlinks that resolve outside the root
 *   - anything that does not exist, or is not a regular file or directory
 *
 * Defences are layered: the string checks reject the obvious attempts, and the
 * realpath check catches what they miss, including a symlink planted inside the
 * root that points out of it.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { validateDefect, type DefectV1 } from "../defect/types.js";
import { validateAudit, type A11yAudit } from "../a11y/types.js";
import { API_AUDIT_FILE_NAME, validateApiAudit, type ApiAudit } from "../api/types.js";
import {
  readHistory,
  readHistoryRecords,
  type HistoryEntry,
  type HistoryRecord,
} from "../defect/history.js";

/** Raised for any rejected path. The message never echoes the absolute target. */
export class PathAccessError extends Error {
  override readonly name = "PathAccessError";
  constructor(
    readonly requested: string,
    reason: string,
  ) {
    // The absolute root is deliberately not included: an error message can end
    // up in a transcript or an LLM prompt.
    super(`Path is outside the configured artifacts root: ${reason}`);
  }
}

export interface StoreOptions {
  /** Absolute path to the directory the server may read. */
  root: string;
  /**
   * Absolute path to the run-history directory, if the project keeps one.
   *
   * A second root, deliberately, and not a subdirectory of the first: artifacts are
   * output and gitignored, history is committed, and pretending otherwise would mean
   * moving or duplicating one of them.
   *
   * Nothing a client sends reaches this path. The tools that read history take no
   * path argument at all — they read the whole directory — so there is no traversal
   * surface here to confine. It is still a configured absolute path rather than
   * something derived from a request, and it is still only ever read.
   */
  historyRoot?: string;
  /**
   * Absolute path to the accessibility-audit directory, if the project runs one.
   *
   * A third root, and a sibling rather than a subdirectory, for the same reason
   * the history root is: `artifacts/defects` and `artifacts/a11y` are different
   * measurements with different contracts, and nesting one inside the other would
   * make `listRuns` read a directory that holds no summary at all.
   *
   * Confinement is unchanged — every path still goes through the same checks —
   * but it resolves against *this* root. That matters: a client path like
   * `../../defects/…` sent to an audit tool must be refused against the audit
   * root, not quietly allowed to reach the defect tree because the server
   * happened to have both open.
   */
  auditRoot?: string;
  /** API audit artifacts, `artifacts/api` by the project's configuration. */
  apiRoot?: string;
}

/** One run directory inside the root. */
export interface RunSummaryRef {
  runId: string;
  /** Relative POSIX path, safe to hand to a client. */
  path: string;
  createdAt?: string;
  passed?: number;
  failed?: number;
}

/** One API audit, as the list tool reports it. */
export interface ApiAuditRunRef {
  runId: string;
  /** Relative POSIX path, safe to hand to a client. */
  path: string;
  baseUrl?: string;
  /** How many contracts the project declared. */
  expectations?: number;
  /**
   * How many tests produced a capture.
   *
   * `0` means the dimension never ran, which is not a clean audit: a run of pure
   * logic tests never imports the fixture. The collector says the same thing, and
   * two tools saying it differently would be worse than one.
   */
  tests?: number;
  violations?: number;
  passed?: number;
}

/** One accessibility audit, as the list tool reports it. */
export interface AuditRunRef {
  runId: string;
  /** Relative POSIX path, safe to hand to a client. */
  path: string;
  createdAt?: string;
  violations?: number;
  incomplete?: number;
  truncatedRules?: number;
}

export class ArtifactStore {
  readonly #root: string;
  /** Absolute realpath of the root, resolved once at construction. */
  #realRoot = "";
  /** Absolute history directory, when the project keeps one. */
  readonly #historyRoot: string | undefined;
  /** Absolute audit directory, when the project runs audits. */
  readonly #auditRoot: string | undefined;
  readonly #apiRoot: string | undefined;
  /** Realpath of the audit root, empty when there is none or it is unreadable. */
  #realAuditRoot = "";
  #realApiRoot = "";

  constructor(options: StoreOptions) {
    this.#root = path.resolve(options.root);
    this.#historyRoot =
      options.historyRoot === undefined ? undefined : path.resolve(options.historyRoot);
    this.#auditRoot = options.auditRoot === undefined ? undefined : path.resolve(options.auditRoot);
    this.#apiRoot = options.apiRoot === undefined ? undefined : path.resolve(options.apiRoot);
  }

  /**
   * Every run-history entry, oldest first.
   *
   * Empty when the project keeps no history, which is the ordinary case rather than
   * an error: a tool that answers "I have nothing to compare" is more useful to an
   * agent than one that fails.
   */
  async readHistory(): Promise<HistoryEntry[]> {
    if (this.#historyRoot === undefined) return [];
    return readHistory(this.#historyRoot, ".");
  }

  /**
   * Every run with who was present in it, oldest first.
   *
   * The composition is what separates a flake from a regression: a pass leaves no
   * outcome of its own, so presence has to be read rather than assumed. Empty when
   * the project keeps no history, which tools report as an absence of evidence.
   */
  async readHistoryRecords(): Promise<HistoryRecord[]> {
    if (this.#historyRoot === undefined) return [];
    return readHistoryRecords(this.#historyRoot, ".");
  }

  /**
   * Resolve the root and verify it exists.
   *
   * Done once so the realpath check per request is cheap, and so a missing root
   * fails at startup with a clear message rather than on first use.
   */
  async init(): Promise<void> {
    let resolved: string;
    try {
      resolved = await realpath(this.#root);
    } catch (error) {
      throw new Error(
        `Artifacts root does not exist or is not readable: ${this.#root}. ` +
          `Run the test suite and \`npm run defects:collect\` first.`,
        { cause: error },
      );
    }
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new Error(`Artifacts root is not a directory: ${resolved}`);
    }
    this.#realRoot = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;

    /**
     * The audit root is optional and its absence is not an error.
     *
     * Most projects that use this server have never run an audit, and a missing
     * `artifacts/a11y` says exactly that. Failing at startup would mean a server
     * that refuses to answer about defects because nobody has audited
     * accessibility — where the tools could have answered "no audits yet", which
     * is evidence rather than a complaint.
     */
    if (this.#auditRoot !== undefined) {
      try {
        const auditReal = await realpath(this.#auditRoot);
        this.#realAuditRoot = auditReal.endsWith(path.sep) ? auditReal : auditReal + path.sep;
      } catch {
        this.#realAuditRoot = "";
      }
    }

    // The third root gets the same treatment for the same reason. A project that
    // declares no contracts has no `artifacts/api`, and that absence is evidence
    // — "nobody has asked" — not a reason to refuse to answer about defects.
    if (this.#apiRoot !== undefined) {
      try {
        const apiReal = await realpath(this.#apiRoot);
        this.#realApiRoot = apiReal.endsWith(path.sep) ? apiReal : apiReal + path.sep;
      } catch {
        this.#realApiRoot = "";
      }
    }
  }

  get root(): string {
    return this.#root;
  }

  /**
   * Resolve a client-supplied relative path inside the root.
   *
   * @returns the absolute path, guaranteed to be inside the real root.
   */
  async resolve(relative: string): Promise<string> {
    return this.#resolveIn(this.#root, this.#realRoot, relative);
  }

  /**
   * Resolve a client-supplied relative path inside the audit root.
   *
   * Refuses when the project runs no audits, rather than reporting an empty
   * result that a client could mistake for "clean".
   */
  async resolveAudit(relative: string): Promise<string> {
    if (this.#auditRoot === undefined || this.#realAuditRoot === "") {
      throw new Error(
        "No accessibility audits found. Run `npm run a11y:audit` before asking about them.",
      );
    }
    return this.#resolveIn(this.#auditRoot, this.#realAuditRoot, relative);
  }

  /** True when the project has an audit root that exists. */
  /**
   * Resolve a client-supplied relative path inside the API audit root.
   *
   * Refuses when the project declares no contracts, rather than reporting an empty
   * result a client could mistake for "every contract held" — the same distinction
   * the collector's `summary.api` draws when the dimension did not run.
   */
  async resolveApi(relative: string): Promise<string> {
    if (this.#apiRoot === undefined || this.#realApiRoot === "") {
      throw new Error(
        "No API audits found. A project declares its contracts in config/project.json and a " +
          "run writes artifacts/api/<runId>/api-audit.v1.json — without that, nobody has asked " +
          "whether the application still honours its own API.",
      );
    }
    return this.#resolveIn(this.#apiRoot, this.#realApiRoot, relative);
  }

  /** True when the project has an API audit root that exists. */
  get hasApiRoot(): boolean {
    return this.#apiRoot !== undefined && this.#realApiRoot !== "";
  }

  get hasAuditRoot(): boolean {
    return this.#auditRoot !== undefined && this.#realAuditRoot !== "";
  }

  async #resolveIn(root: string, realRoot: string, relative: string): Promise<string> {
    if (typeof relative !== "string" || relative === "") {
      throw new PathAccessError(String(relative), "empty path");
    }
    if (relative.includes("\0")) {
      throw new PathAccessError(relative, "NUL byte in path");
    }

    // Decode first, then normalise: `%2e%2e%2f` must be judged as `../`, not as
    // an opaque string that happens to match no file.
    let decoded: string;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      throw new PathAccessError(relative, "malformed percent-encoding");
    }
    if (decoded.includes("\0")) {
      throw new PathAccessError(relative, "NUL byte after decoding");
    }

    if (path.isAbsolute(decoded) || /^[a-zA-Z]:[\\/]/.test(decoded)) {
      throw new PathAccessError(relative, "absolute path");
    }

    const joined = path.resolve(root, decoded);

    // Normalisation already collapses `..`, but check the literal prefix too:
    // belt and braces, because this is the security boundary.
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (joined !== root && !joined.startsWith(withSep)) {
      throw new PathAccessError(relative, "resolves outside the root");
    }

    // The decisive check: where does it really point? This catches a symlink
    // inside the root aimed at /etc or at the user's SSH key.
    let real: string;
    try {
      real = await realpath(joined);
    } catch {
      throw new PathAccessError(relative, "does not exist");
    }
    const realWithSep = realRoot;
    if (real !== root && !real.startsWith(realWithSep)) {
      throw new PathAccessError(relative, "symlink resolves outside the root");
    }

    return real;
  }

  /** List run directories, newest first by id. */
  async listRuns(): Promise<RunSummaryRef[]> {
    const entries = await readdir(this.#root, { withFileTypes: true });
    const runs: RunSummaryRef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summary = await this.#readSummary(entry.name).catch(() => null);
      if (summary === null) continue;
      const counts =
        typeof summary.counts === "object" && summary.counts !== null
          ? (summary.counts as Record<string, unknown>)
          : {};

      // Omit absent fields rather than setting them to undefined: the type is
      // exactOptional, so an explicit undefined is not assignable.
      runs.push({
        runId: entry.name,
        path: `${entry.name}/quality-summary.v1.json`,
        ...(typeof summary.createdAt === "string" ? { createdAt: summary.createdAt } : {}),
        ...(typeof counts.passed === "number" ? { passed: counts.passed } : {}),
        ...(typeof counts.failed === "number" ? { failed: counts.failed } : {}),
      });
    }
    return runs.sort((a, b) => b.runId.localeCompare(a.runId));
  }

  async #readSummary(runId: string): Promise<Record<string, unknown>> {
    const absolute = await this.resolve(path.join(runId, "quality-summary.v1.json"));
    return JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>;
  }

  /** Read one run's summary. `runId` is untrusted input. */
  async readSummary(runId: string): Promise<Record<string, unknown>> {
    return this.#readSummary(runId);
  }

  /** Read the newest run's summary. Throws when the root holds no runs. */
  async readLatestSummary(): Promise<Record<string, unknown>> {
    const runs = await this.listRuns();
    const newest = runs[0];
    if (newest === undefined) {
      throw new Error(
        "No runs found under the artifacts root. Run `npm test` and `npm run defects:collect` first.",
      );
    }
    return this.#readSummary(newest.runId);
  }

  /**
   * Read one defect, validating it against the contract.
   *
   * Validation on read, not just on write: an artifact may have been produced
   * by an older version, or edited by hand. A malformed artifact is reported as
   * such instead of being passed to a model as if it were sound.
   */
  async readDefect(relativePath: string): Promise<DefectV1> {
    const absolute = await this.resolve(relativePath);
    const text = await readFile(absolute, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Defect artifact is not valid JSON: ${relativePath}`, { cause: error });
    }

    const { valid, problems } = validateDefect(parsed);
    if (!valid) {
      throw new Error(
        `Defect artifact violates the v1 contract: ${relativePath}\n  - ${problems.join("\n  - ")}`,
      );
    }
    return parsed as DefectV1;
  }

  /**
   * List the defect artifacts of one run.
   *
   * Only files ending in `.v1.json` are considered, so a stray file in the
   * directory cannot be served as a defect.
   */
  async listDefects(runId: string): Promise<string[]> {
    const dir = await this.resolve(runId);
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error(`Not a run directory: ${runId}`);
    }
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.endsWith(".v1.json") && name !== "quality-summary.v1.json")
      .sort()
      .map((name) => `${runId}/${name}`);
  }

  /**
   * Every accessibility audit this project has written, newest first.
   *
   * Empty when the project runs no audits, which is the ordinary case: an absent
   * `artifacts/a11y` is evidence that nothing has been audited, and a tool that
   * says so is more useful to an agent than one that fails.
   */
  async listAudits(): Promise<AuditRunRef[]> {
    if (!this.hasAuditRoot || this.#auditRoot === undefined) return [];

    const entries = await readdir(this.#auditRoot, { withFileTypes: true });
    const audits: AuditRunRef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = `${entry.name}/audit.v1.json`;
      const parsed = await this.readAudit(relative).catch(() => null);
      // A directory without a readable audit is not a run; skipping it is the
      // same rule `listRuns` follows for a directory with no summary.
      if (parsed === null) continue;
      const counts =
        typeof parsed.counts === "object" && parsed.counts !== null
          ? (parsed.counts as Record<string, unknown>)
          : {};
      audits.push({
        runId: entry.name,
        path: relative,
        createdAt: parsed.createdAt,
        // Omit absent fields rather than setting them to undefined, for the same
        // reason `listRuns` does: the type is exactOptional.
        ...(typeof counts.violations === "number" ? { violations: counts.violations } : {}),
        ...(typeof counts.incomplete === "number" ? { incomplete: counts.incomplete } : {}),
        ...(typeof counts.truncatedRules === "number"
          ? { truncatedRules: counts.truncatedRules }
          : {}),
      });
    }
    return audits.sort((a, b) => b.runId.localeCompare(a.runId));
  }

  /**
   * Read one audit. The path is client-supplied and confined like any other.
   *
   * Validated on read for the same reason a defect is: the artifact crosses a
   * trust boundary here, and a server that passed on whatever the file said would
   * be handing a model a claim nobody checked.
   */
  /**
   * List the API audits, newest first.
   *
   * A directory without a readable audit is not a run, for the same reason
   * `listRuns` skips a directory with no summary: a run is what it wrote, not what
   * its name claims.
   */
  async listApiAudits(): Promise<ApiAuditRunRef[]> {
    if (!this.hasApiRoot || this.#apiRoot === undefined) return [];

    const entries = await readdir(this.#apiRoot, { withFileTypes: true });
    const audits: ApiAuditRunRef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = `${entry.name}/${API_AUDIT_FILE_NAME}`;
      const parsed = await this.readApiAudit(relative).catch(() => null);
      if (parsed === null) continue;
      const counts =
        typeof parsed.counts === "object" && parsed.counts !== null
          ? (parsed.counts as unknown as Record<string, unknown>)
          : {};
      audits.push({
        runId: entry.name,
        path: relative,
        // Omit absent rather than undefined, for the same reason `listAudits` does:
        // the type is exactOptional.
        ...(typeof parsed.baseUrl === "string" ? { baseUrl: parsed.baseUrl } : {}),
        ...(typeof counts.expectations === "number" ? { expectations: counts.expectations } : {}),
        ...(typeof counts.tests === "number" ? { tests: counts.tests } : {}),
        ...(typeof counts.violations === "number" ? { violations: counts.violations } : {}),
        ...(typeof counts.passed === "number" ? { passed: counts.passed } : {}),
      });
    }
    return audits.sort((a, b) => b.runId.localeCompare(a.runId));
  }

  /**
   * Read one API audit in full.
   *
   * The violations, not the exchanges: an artifact read by a model should not
   * carry a list of successful traffic, which is evidence about nothing.
   */
  async readApiAudit(relativePath: string): Promise<ApiAudit> {
    const absolute = await this.resolveApi(relativePath);
    const text = await readFile(absolute, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`API audit artifact is not valid JSON: ${relativePath}`, { cause: error });
    }

    const { valid, problems } = validateApiAudit(parsed);
    if (!valid) {
      throw new Error(
        `API audit artifact violates the api-audit.v1 contract: ${relativePath}\n  - ${problems.join("\n  - ")}`,
      );
    }
    return parsed as ApiAudit;
  }

  async readAudit(relativePath: string): Promise<A11yAudit> {
    const absolute = await this.resolveAudit(relativePath);
    const text = await readFile(absolute, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Audit artifact is not valid JSON: ${relativePath}`, { cause: error });
    }

    const { valid, problems } = validateAudit(parsed);
    if (!valid) {
      throw new Error(
        `Audit artifact violates the a11y-audit.v1 contract: ${relativePath}\n  - ${problems.join("\n  - ")}`,
      );
    }
    return parsed as A11yAudit;
  }
}
