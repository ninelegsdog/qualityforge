/**
 * The modern epoch (2026-07-28) over the real wire.
 *
 * `tests/unit/mcp/dispatch.test.ts` asserts every one of these properties by
 * calling `dispatch()` with a hand-built object. That reaches the protocol logic
 * and nothing else: no stdio framing, no serialization, no process, no stdin.
 * This file sends the same frames through a child process and reads the answers
 * back off its stdout, which is the only path a client ever uses.
 *
 * The `_meta` keys are written out as literals rather than imported from
 * `src/mcp/protocol.ts` on purpose. An import would make the assertion agree
 * with whatever the source currently says — a rename there would turn green here
 * too, and the wire is what a client validates. These strings are the contract.
 */
import { expect, test } from "@playwright/test";
import {
  closeAllProcesses,
  cleanupTempDirs,
  ensureServerEntry,
  makeRoot,
  spawnServer,
  type JsonObject,
  type McpProcess,
} from "./helpers/mcp-proc.js";

/** The epoch this file exercises, and the one it must stay compatible with. */
const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

/** `_meta` keys of the 2026-07-28 era (see src/mcp/protocol.ts). */
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** Reserved MCP code for a revision this server cannot speak. */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const RUN_ID = "2026-10-03T00-00-00-000Z-abcdef";

const CLIENT_INFO = { name: "qf-integration-client", version: "0.0.0" };

/** The envelope every 2026-07-28 request carries; both keys are mandatory. */
function modernEnvelope(): JsonObject {
  return {
    [META_PROTOCOL_VERSION]: MODERN,
    [META_CLIENT_CAPABILITIES]: {},
    [META_CLIENT_INFO]: CLIENT_INFO,
  };
}

/** `params` for a modern request: the envelope, and nothing else. */
function modernParams(extra: JsonObject = {}): JsonObject {
  return { _meta: modernEnvelope(), ...extra };
}

/** The server identity an answer must carry back, per era. */
function serverInfoOf(result: JsonObject): JsonObject {
  const meta = result._meta;
  expect(typeof meta, `answer has no _meta: ${JSON.stringify(result)}`).toBe("object");
  const info = (meta as JsonObject)[META_SERVER_INFO] as JsonObject | undefined;
  expect(info, `answer _meta has no ${META_SERVER_INFO}`).toBeDefined();
  return info as JsonObject;
}

let root: string;
let server: McpProcess;

test.beforeAll(async () => {
  await ensureServerEntry();
});

test.beforeEach(async () => {
  root = makeRoot("qf-mcp-modern-", [RUN_ID]);
  server = await spawnServer({ root });
});

test.afterEach(async () => {
  await server.close();
});

test.afterAll(async () => {
  await closeAllProcesses();
  await cleanupTempDirs();
});

test.describe("2026-07-28 over stdio", () => {
  test("server/discover answers on the wire with the modern epoch and its capabilities", async () => {
    const result = await server.result("server/discover", modernParams());

    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toContain(MODERN);
    expect(result.supportedVersions).toContain(LEGACY);

    const info = result.serverInfo as JsonObject;
    expect(info.name).toBe("qualityforge-mcp");
    expect(typeof info.version).toBe("string");

    // The exact flags a client gates its own methods on, and no `logging`
    // surface, which the epoch deprecated.
    expect(result.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    });
    expect(typeof result.instructions).toBe("string");

    expect(serverInfoOf(result).name).toBe("qualityforge-mcp");
    // stdout carries JSON-RPC frames and nothing else — a stray banner or a
    // console.log from anywhere would surface here as a non-frame line.
    expect(server.wireViolations).toEqual([]);
  });

  test("initialize on 2026-07-28 echoes the epoch and carries the era's _meta keys", async () => {
    const result = await server.result("initialize", {
      protocolVersion: MODERN,
      capabilities: {},
      clientInfo: CLIENT_INFO,
      _meta: modernEnvelope(),
    });

    expect(result.resultType).toBe("complete");
    expect(result.protocolVersion).toBe(MODERN);
    expect(result.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    });
    expect((result.serverInfo as JsonObject).name).toBe("qualityforge-mcp");

    const info = serverInfoOf(result);
    expect(info.name).toBe("qualityforge-mcp");
    expect(typeof info.version).toBe("string");
  });

  test("initialize answers a legacy client with the legacy version, over the wire", async () => {
    // The failure this guards is on record: initialize used to answer with the
    // server's newest revision whatever the client asked for, and OpenCode —
    // whose default is legacy — refused the connection outright with
    // "Server's protocol version is not supported: 2026-07-28". The unit suite
    // pins the negotiation; this runs the same frame through a real process,
    // with the 2025-11-25 shape (no envelope at all).
    const result = await server.result("initialize", {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });

    expect(result.resultType).toBe("complete");
    expect(result.protocolVersion).toBe(LEGACY);
    expect((result.serverInfo as JsonObject).name).toBe("qualityforge-mcp");
    expect(server.wireViolations).toEqual([]);
  });

  test("tools/list on the modern epoch carries resultType, ttlMs and cacheScope", async () => {
    const first = await server.result("tools/list", modernParams());
    const second = await server.result("tools/list", modernParams());

    expect(first.resultType).toBe("complete");
    expect(typeof first.ttlMs).toBe("number");
    expect(first.cacheScope).toBe("private");

    const names = (payload: JsonObject): string =>
      (payload.tools as { name: string }[]).map((tool) => tool.name).join(",");
    expect(names(first)).toBe(names(second));
    expect(names(first)).toContain("quality_get_latest_run");
  });

  test("tools/call on the modern epoch returns the store's evidence with resultType", async () => {
    const latest = await server.result(
      "tools/call",
      modernParams({
        name: "quality_get_latest_run",
        arguments: {},
      }),
    );

    expect(latest.resultType).toBe("complete");
    expect((latest.structuredContent as JsonObject).runId).toBe(RUN_ID);
    expect(((latest.structuredContent as JsonObject).gate as JsonObject).passed).toBe(true);
    expect(serverInfoOf(latest).name).toBe("qualityforge-mcp");

    const failures = await server.result(
      "tools/call",
      modernParams({
        name: "quality_list_failures",
        arguments: {},
      }),
    );

    expect(failures.resultType).toBe("complete");
    const structured = failures.structuredContent as JsonObject;
    expect(structured.total).toBe(1);
    const defects = structured.defects as JsonObject[];
    expect(defects[0]?.defectPath).toBe(`${RUN_ID}/demo-shows-the-status.v1.json`);
    expect(server.wireViolations).toEqual([]);
  });

  test("a request claiming the modern epoch without its envelope is refused", async () => {
    // The control first: the identical request with an envelope is served.
    const served = await server.result("tools/list", modernParams());
    expect(served.resultType).toBe("complete");

    const error = await server.expectError("tools/list", { protocolVersion: MODERN });
    expect(error.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(error.message).toContain("_meta");
    expect((error.data as JsonObject).supported).toEqual([MODERN, LEGACY]);
  });

  test("a notification gets no answer and the same connection stays usable", async () => {
    server.notify("notifications/cancelled", modernParams({ requestId: "1" }));

    // Nothing may arrive: a response to a notification would be read by a client
    // as the answer to a request it never sent.
    expect(await server.framesDuring(400)).toEqual([]);

    const pong = await server.result("ping", modernParams());
    expect(pong.resultType).toBe("complete");
    expect(server.wireViolations).toEqual([]);
  });

  test("one connection carries interleaved requests and matches the answers by id", async () => {
    const [discover, latest, tools] = await Promise.all([
      server.exchange("server/discover", modernParams()),
      server.exchange(
        "tools/call",
        modernParams({
          name: "quality_get_latest_run",
          arguments: {},
        }),
      ),
      server.exchange("tools/list", modernParams()),
    ]);

    const ids = [discover.id, latest.id, tools.id];
    expect(new Set(ids).size).toBe(3);

    if ("error" in discover || "error" in latest || "error" in tools) {
      throw new Error(
        `an interleaved request failed: ${JSON.stringify([discover, latest, tools])}`,
      );
    }
    expect(discover.result.supportedVersions).toBeDefined();
    expect((latest.result.structuredContent as JsonObject).runId).toBe(RUN_ID);
    expect(tools.result.tools).toBeDefined();
  });
});
