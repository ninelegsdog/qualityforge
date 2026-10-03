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

export class ArtifactStore {
  readonly #root: string;
  /** Absolute realpath of the root, resolved once at construction. */
  #realRoot = "";

  constructor(options: StoreOptions) {
    this.#root = path.resolve(options.root);
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

    const joined = path.resolve(this.#root, decoded);

    // Normalisation already collapses `..`, but check the literal prefix too:
    // belt and braces, because this is the security boundary.
    const withSep = this.#root.endsWith(path.sep) ? this.#root : this.#root + path.sep;
    if (joined !== this.#root && !joined.startsWith(withSep)) {
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
    const realWithSep = this.#realRoot;
    if (real !== this.#root && !real.startsWith(realWithSep)) {
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
}
