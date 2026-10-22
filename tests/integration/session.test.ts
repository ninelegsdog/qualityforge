/**
 * Session semantics over the real wire: a connection is not the process, and it
 * is not another connection.
 *
 * The unit suite cannot answer this at all — `dispatch()` takes a fresh context
 * per call, so "session" has no meaning there. Here a session is a spawned
 * server process with its own stdin/stdout and its own configured artifacts
 * root, and the difference between two calls inside one session and the same
 * calls across two sessions has to be observable:
 *
 * - inside one session, both calls answer from the root chosen at spawn, and
 *   they observe evidence written to that root *after* the connection opened;
 * - across two sessions, each answers only from its own root, whatever the
 *   other one seeds, and closing one leaves the other answering.
 */
import { expect, test } from "@playwright/test";
import {
  closeAllProcesses,
  cleanupTempDirs,
  ensureServerEntry,
  isAlive,
  makeRoot,
  seedRun,
  spawnServer,
  type JsonObject,
  type McpProcess,
} from "./helpers/mcp-proc.js";

/** Directory names sort lexicographically, and that is what "latest" reads. */
const RUN_1 = "2026-10-03T00-00-00-000Z-aaaaaa";
const RUN_2 = "2026-10-04T00-00-00-000Z-bbbbbb";
const OTHER_RUN = "2026-10-05T00-00-00-000Z-cccccc";

const MODERN = "2026-07-28";
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

function modernParams(extra: JsonObject = {}): JsonObject {
  return {
    _meta: { [META_PROTOCOL_VERSION]: MODERN, [META_CLIENT_CAPABILITIES]: {} },
    ...extra,
  };
}

/** The run the server reports as latest; the whole session question in one call. */
async function latestRunId(session: McpProcess): Promise<string> {
  const result = await session.result(
    "tools/call",
    modernParams({
      name: "quality_get_latest_run",
      arguments: {},
    }),
  );
  expect(result.resultType).toBe("complete");
  return String((result.structuredContent as JsonObject).runId);
}

/** Wait until the pid is gone; `close()` already waited, this bounds the race. */
async function expectExited(pid: number | undefined): Promise<void> {
  expect(pid).toBeDefined();
  const deadline = Date.now() + 2_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(isAlive(pid), "the server process outlived its session").toBe(false);
}

let rootA: string;
let rootB: string;

test.beforeAll(async () => {
  await ensureServerEntry();
});

test.beforeEach(() => {
  rootA = makeRoot("qf-mcp-session-a-", [RUN_1]);
  rootB = makeRoot("qf-mcp-session-b-", [OTHER_RUN]);
});

test.afterEach(async () => {
  await closeAllProcesses();
});

test.afterAll(async () => {
  await closeAllProcesses();
  await cleanupTempDirs();
});

test.describe("connection is a session", () => {
  test("two calls in one session answer from the same root, including evidence added after it opened", async () => {
    const session = await spawnServer({ root: rootA });
    const pid = session.pid;

    expect(await latestRunId(session)).toBe(RUN_1);

    // Written while the connection is already open. A server that snapshotted
    // its view at spawn would answer RUN_1 again; a server that reads its
    // configured root answers the run that now exists.
    seedRun(rootA, RUN_2);
    expect(await latestRunId(session)).toBe(RUN_2);

    // One session, one process: the second call did not need a new connection.
    expect(session.pid).toBe(pid);
    expect(isAlive(session.pid)).toBe(true);
  });

  test("two sessions answer from their own roots only, in any order", async () => {
    const a = await spawnServer({ root: rootA });
    const b = await spawnServer({ root: rootB });

    expect(a.pid).not.toBe(b.pid);

    const firstA = await latestRunId(a);
    const firstB = await latestRunId(b);
    expect(firstA).toBe(RUN_1);
    expect(firstB).toBe(OTHER_RUN);

    // New evidence lands in A's root while B is connected: A must see it,
    // B must not — the root is decided by the connection, not by whatever the
    // last caller seeded.
    seedRun(rootA, RUN_2);
    const secondA = await latestRunId(a);
    const secondB = await latestRunId(b);
    expect(secondA).toBe(RUN_2);
    expect(secondB).toBe(OTHER_RUN);

    // Interleaved once more, so the isolation is not an artifact of ordering.
    const thirdA = await latestRunId(a);
    const thirdB = await latestRunId(b);
    expect(thirdA).toBe(RUN_2);
    expect(thirdB).toBe(OTHER_RUN);
    expect(thirdB).not.toBe(thirdA);
  });

  test("closing one session terminates its process and leaves the other answering", async () => {
    const a = await spawnServer({ root: rootA });
    const b = await spawnServer({ root: rootB });

    const pidA = a.pid;
    expect(await latestRunId(a)).toBe(RUN_1);
    expect(await latestRunId(b)).toBe(OTHER_RUN);

    await a.close();
    await expectExited(pidA);

    // The surviving session is unaffected by its neighbour's shutdown — no
    // shared process, no shared stdin, no shared state to corrupt.
    expect(await latestRunId(b)).toBe(OTHER_RUN);
    expect(b.wireViolations).toEqual([]);
  });

  test("a second session negotiates its own handshake", async () => {
    const a = await spawnServer({ root: rootA });
    const b = await spawnServer({ root: rootB });

    const initialize = async (session: McpProcess): Promise<unknown> => {
      const result = await session.result("initialize", {
        protocolVersion: MODERN,
        capabilities: {},
        clientInfo: { name: "qf-integration-client", version: "0.0.0" },
        _meta: {
          [META_PROTOCOL_VERSION]: MODERN,
          [META_CLIENT_CAPABILITIES]: {},
        },
      });
      expect(result.resultType).toBe("complete");
      return result.protocolVersion;
    };

    expect(await initialize(a)).toBe(MODERN);
    expect(await initialize(b)).toBe(MODERN);
    expect(a.wireViolations).toEqual([]);
    expect(b.wireViolations).toEqual([]);
  });
});
