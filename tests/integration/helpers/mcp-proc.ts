/**
 * Process harness for the MCP integration layer.
 *
 * Everything in this layer drives the server the way a real client does: a
 * child process, JSON-RPC frames over stdin/stdout, no imports from `src/mcp`.
 * The unit suite already covers `dispatch()` in-process; what it cannot reach is
 * the wire — stdio framing, serialization, the handshake and the lifetime of a
 * connection — and this module is the only place that owns it.
 *
 * Three pieces:
 *
 * - `ensureServerEntry()` builds `dist/mcp/index.js` when it is missing, because
 *   that file is what `bin["qualityforge-mcp"]` points at and what a consuming
 *   project actually spawns. The build is guarded by an atomic lock directory so
 *   parallel Playwright workers cannot run tsc on the same tree at once.
 * - `spawnServer()` starts that entry with an absolute `--root` and a working
 *   directory *outside the checkout*, which is the shape a client uses (see the
 *   two defects recorded in `src/mcp/index.ts` and AGENTS.md: a relative root
 *   resolved against the wrong cwd is exactly what broke once).
 * - `McpProcess` is a minimal JSON-RPC-over-stdio client: numbered requests
 *   matched by id, notifications with no id, an explicit per-request timeout, and
 *   the server's stderr kept as part of every failure message — a client that
 *   reports only "no answer" throws away the one line that names the cause.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Repository root: this file lives at tests/integration/helpers/mcp-proc.ts. */
export const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** The entry a consumer runs: `bin["qualityforge-mcp"]`. */
const SERVER_ENTRY = path.join(PACKAGE_ROOT, "dist", "mcp", "index.js");

/** Atomic build lock, shared by every worker of this layer. */
const BUILD_LOCK = path.join(tmpdir(), "qf-mcp-integration-build.lock");

/** A lock older than this is a crashed build, not a running one. */
const STALE_LOCK_MS = 5 * 60_000;

/** How long to wait for another worker's build before giving up. */
const BUILD_WAIT_MS = 180_000;

/** Default per-request budget. Explicit, so a hang fails instead of stalling. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** How long `close()` waits for a clean exit before it kills the process. */
const CLOSE_TIMEOUT_MS = 3_000;

export type JsonObject = Record<string, unknown>;

/** A server stdout line that was not valid JSON — stdout must carry frames only. */
export type WireLine = { raw: string };

export type Exchange =
  | { id: number; result: JsonObject }
  | { id: number; error: { code: number; message: string; data?: unknown } };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runBuild(): Promise<void> {
  try {
    const { stderr } = await execFileAsync("npm", ["run", "build"], {
      cwd: PACKAGE_ROOT,
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (stderr.trim() !== "") {
      // tsc is quiet on success; anything on stderr is worth surfacing later.
      process.stderr.write(`[qf-integration] build: ${stderr}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // execFile rejects with a message naming the exit code; the compiler's own
    // output is on `stderr`, and that is the part that says what broke.
    const captured = (error as { stderr?: unknown }).stderr;
    const tail =
      typeof captured === "string" ? captured.trim().split("\n").slice(-30).join("\n") : "";
    throw new Error(
      `\`npm run build\` failed, and this layer spawns the compiled server ` +
        `(${path.relative(PACKAGE_ROOT, SERVER_ENTRY)}). Fix the build first.\n${detail}` +
        (tail === "" ? "" : `\n${tail}`),
      { cause: error },
    );
  }
}

/**
 * Absolute path to the compiled MCP server, building it when absent.
 *
 * @throws when the build fails or another worker never produces the entry.
 */
export async function ensureServerEntry(): Promise<string> {
  if (existsSync(SERVER_ENTRY)) return SERVER_ENTRY;

  // A crashed build must not wedge every later run, so a lock whose mtime is
  // older than STALE_LOCK_MS is removed and the attempt retried once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (existsSync(SERVER_ENTRY)) return SERVER_ENTRY;

    let owner = false;
    try {
      mkdirSync(BUILD_LOCK);
      owner = true;
    } catch {
      try {
        if (Date.now() - statSync(BUILD_LOCK).mtimeMs > STALE_LOCK_MS) {
          rmSync(BUILD_LOCK, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock vanished between the two calls; the next attempt re-tries mkdir.
      }
    }

    if (owner) {
      try {
        await runBuild();
      } finally {
        rmSync(BUILD_LOCK, { recursive: true, force: true });
      }
      if (existsSync(SERVER_ENTRY)) return SERVER_ENTRY;
      throw new Error(`\`npm run build\` finished but ${SERVER_ENTRY} is still missing.`);
    }

    const deadline = Date.now() + BUILD_WAIT_MS;
    while (Date.now() < deadline && !existsSync(SERVER_ENTRY)) {
      await sleep(250);
    }
  }

  throw new Error(
    `Timed out waiting for ${SERVER_ENTRY}. Another worker may hold ` +
      `${BUILD_LOCK}; remove it if no build is running.`,
  );
}

/** Every child this worker started, so nothing is left behind as a zombie. */
const LIVE: McpProcess[] = [];

/** Temp directories this layer created: artifact roots and client cwds. */
const TEMP_DIRS: string[] = [];

/**
 * Start the compiled MCP server as a child process.
 *
 * The working directory defaults to a fresh directory outside the checkout —
 * that is where a client's cwd is — and `root` must be absolute, so no fallback
 * resolution is involved and the test observes exactly the root it configured.
 */
export async function spawnServer(options: {
  root: string;
  cwd?: string;
  args?: string[];
}): Promise<McpProcess> {
  const entry = await ensureServerEntry();
  const cwd = options.cwd ?? makeTempDir("qf-mcp-cwd-");
  const args = [entry, "--root", options.root, ...(options.args ?? [])];
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const proc = new McpProcess(child, cwd, args);
  LIVE.push(proc);
  return proc;
}

/** A fresh temp directory, tracked so `cleanupTempDirs()` can remove it. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

/**
 * Write one run of seeded evidence (a summary plus one defect) into `root`.
 *
 * The payload mirrors `tests/unit/mcp/dispatch.test.ts`, because the integration
 * layer must serve the same artifacts the unit suite asserts on: a fixture that
 * differs would let this layer pass on shapes the collector never writes.
 *
 * `runId` doubles as the directory name, and `quality_get_latest_run` picks the
 * newest by directory name, so callers order runs by giving ascending ids.
 */
export function seedRun(root: string, runId: string): void {
  const runDir = path.join(root, runId);
  mkdirSync(runDir, { recursive: true });

  const defectPath = `${runId}/demo-shows-the-status.v1.json`;
  writeFileSync(
    path.join(runDir, "demo-shows-the-status.v1.json"),
    JSON.stringify({
      schemaVersion: "1.1.0",
      id: "demo-shows-the-status",
      runId,
      createdAt: `${runId.slice(0, 10)}T00:00:00.000Z`,
      status: "failed",
      test: { title: "shows the status", file: "tests/demo.spec.ts", line: 3 },
      failure: { message: "boom", errorContextRef: "x/error-context.md" },
      evidence: { screenshot: "x/test-failed-1.png" },
      context: { commit: "abc123" },
      flakiness: { verdict: "unknown", attempts: 1 },
      signals: { consoleErrors: [{ type: "error", text: "boom" }] },
    }),
    "utf8",
  );

  writeFileSync(
    path.join(runDir, "quality-summary.v1.json"),
    JSON.stringify({
      schemaVersion: "1.1.0",
      runId,
      createdAt: `${runId.slice(0, 10)}T00:00:00.000Z`,
      counts: { specs: 3, passed: 2, failed: 1, timedOut: 0, skipped: 0, flaky: 0 },
      defects: [defectPath],
      thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 },
      gate: { passed: true, violations: [] },
      api: {
        audit: `${runId}/api-audit.v1.json`,
        counts: { expectations: 2, tests: 3, violations: 1, passed: 1 },
        ran: true,
        violations: ["GET /api/items: application/json — observed content type text/html"],
      },
      perf: {
        audit: `${runId}/perf-audit.v1.json`,
        counts: { budgets: 3, tests: 3, pages: 2, violations: 1, passed: 2 },
        ran: true,
        violations: ["/heavy: at most 20,000 bytes — observed 526,538 bytes, 506,538 over"],
      },
      visual: {
        audit: `${runId}/visual-audit.v1.json`,
        counts: { pages: 2, tests: 3, matched: 1, withoutBaseline: 0, violations: 1 },
        ran: true,
        violations: ["/docs: sha256 a — observed sha256 b"],
      },
      policy: { chain: ["../../quality-policy.json"] },
    }),
    "utf8",
  );
}

/** An empty artifacts root with `runIds` seeded into it, oldest first. */
export function makeRoot(prefix: string, runIds: string[]): string {
  const root = makeTempDir(prefix);
  for (const runId of runIds) seedRun(root, runId);
  return root;
}

/** True while the process is running; ESRCH means it has exited. */
export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Close every child this worker started. Safe to call more than once. */
export async function closeAllProcesses(): Promise<void> {
  const open = LIVE.splice(0, LIVE.length);
  await Promise.all(open.map((proc) => proc.close()));
}

/** Remove every temp directory this layer created. */
export function cleanupTempDirs(): Promise<void> {
  for (const dir of TEMP_DIRS.splice(0, TEMP_DIRS.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
  return Promise.resolve();
}

/**
 * One server process and one connection to it.
 *
 * A "session" in the tests is exactly this object: one process, one stdin, one
 * stdout, one set of negotiated state. Nothing is shared between two of them,
 * which is the property the session tests assert.
 */
export class McpProcess {
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: Exchange) => void; reject: (error: Error) => void }
  >();
  #frames: JsonObject[] = [];
  #rawLines: string[] = [];
  #stderr = "";
  #closed = false;

  constructor(
    readonly child: ChildProcess,
    readonly cwd: string,
    readonly args: string[],
  ) {
    // stdio is ["pipe", "pipe", "pipe"], so both streams exist; the null check
    // is for the type, and a missing stdout would fail every request anyway.
    const stdout = child.stdout;
    if (stdout !== null) {
      stdout.setEncoding("utf8");
      const lines = createInterface({ input: stdout, crlfDelay: Infinity });
      lines.on("line", (line: string) => this.#onLine(line));
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });

    child.on("error", (error: Error) => {
      this.#failAll(new Error(`server process errored: ${error.message}\n${this.describe()}`));
    });
    child.on("exit", (code, signal) => {
      this.#failAll(
        new Error(
          `server exited before answering (code ${code}, signal ${signal})\n${this.describe()}`,
        ),
      );
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Everything the server wrote to stdout as JSON frames. */
  get frames(): readonly JsonObject[] {
    return this.#frames;
  }

  /** Stdout lines that were not valid JSON. Must stay empty: frames only. */
  get wireViolations(): readonly string[] {
    return this.#rawLines;
  }

  get stderrText(): string {
    return this.#stderr;
  }

  /** Diagnostic block appended to every failure this client raises. */
  describe(): string {
    const tail = this.#stderr.trim().split("\n").slice(-8).join("\n");
    return [
      `server args: node ${this.args.map((a) => JSON.stringify(a)).join(" ")}`,
      `cwd: ${this.cwd}`,
      `frames received so far: ${this.#frames.length}`,
      `stderr:\n${tail === "" ? "  (empty)" : tail}`,
    ].join("\n");
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.#rawLines.push(trimmed);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.#rawLines.push(trimmed);
      return;
    }
    const frame = parsed as JsonObject;
    this.#frames.push(frame);

    const id = frame.id;
    if (typeof id === "number") {
      const waiter = this.#pending.get(id);
      if (waiter !== undefined) {
        this.#pending.delete(id);
        if ("error" in frame) {
          const error = frame.error as { code?: unknown; message?: unknown; data?: unknown };
          waiter.resolve({
            id,
            error: {
              code: typeof error.code === "number" ? error.code : -1,
              message: typeof error.message === "string" ? error.message : String(error.message),
              ...(error.data === undefined ? {} : { data: error.data }),
            },
          });
        } else {
          waiter.resolve({ id, result: (frame.result ?? {}) as JsonObject });
        }
      }
    }
  }

  #failAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const waiter of pending) waiter.reject(error);
  }

  #write(frame: JsonObject): void {
    const stdin = this.child.stdin;
    if (stdin === null || stdin.destroyed || !stdin.writable) {
      throw new Error(`stdin is closed; the connection is gone.\n${this.describe()}`);
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /**
   * Send a request and wait for its answer, matched by id.
   *
   * JSON-RPC errors are returned, not thrown — a negative test asserts on the
   * code — while a timeout or a dead process throws, carrying stderr.
   */
  async exchange(
    method: string,
    params?: JsonObject,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Exchange> {
    const id = this.#nextId;
    this.#nextId += 1;

    const answer = new Promise<Exchange>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });

    try {
      this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`no answer for ${method} within ${timeoutMs}ms\n${this.describe()}`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([answer, budget]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** A request whose result is expected; throws on a JSON-RPC error. */
  async result(method: string, params?: JsonObject, timeoutMs?: number): Promise<JsonObject> {
    const exchange = await this.exchange(method, params, timeoutMs);
    if ("error" in exchange) {
      throw new Error(
        `${method} answered with an error: ${JSON.stringify(exchange.error)}\n${this.describe()}`,
      );
    }
    return exchange.result;
  }

  /** A request whose error is expected; throws when it succeeded. */
  async expectError(
    method: string,
    params?: JsonObject,
    timeoutMs?: number,
  ): Promise<{ code: number; message: string; data?: unknown }> {
    const exchange = await this.exchange(method, params, timeoutMs);
    if (!("error" in exchange)) {
      throw new Error(
        `${method} was expected to fail but answered: ${JSON.stringify(exchange.result)}\n` +
          this.describe(),
      );
    }
    return exchange.error;
  }

  /** A notification: no id, so the server must never answer it. */
  notify(method: string, params?: JsonObject): void {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Frames that arrived during `ms`, used to assert that none did. */
  async framesDuring(ms: number): Promise<JsonObject[]> {
    const before = this.#frames.length;
    await sleep(ms);
    return this.#frames.slice(before);
  }

  /** End stdin (the client's half of the close handshake) and reap the process. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin?.end();
      await this.#waitForExit(CLOSE_TIMEOUT_MS);
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await this.#waitForExit(2_000);
    }
    this.#failAll(new Error(`connection closed.\n${this.describe()}`));
  }

  #waitForExit(timeoutMs: number): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.child.removeListener("exit", done);
        resolve();
      }, timeoutMs);
      this.child.once("exit", done);
    });
  }
}
