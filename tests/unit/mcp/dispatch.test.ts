import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../../src/mcp/store.js";
import { dispatch, type Logger } from "../../../src/mcp/server.js";
import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  PARSE_ERROR,
  RESULT_TYPE_COMPLETE,
  UNSUPPORTED_PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
} from "../../../src/mcp/protocol.js";

/** Collects diagnostics instead of printing them. */
const silentLogger: Logger = { debug: () => {}, warn: () => {} };

const RUN_ID = "2026-10-03T00-00-00-000Z-abcdef";

function defect(): string {
  return JSON.stringify({
    schemaVersion: "1.1.0",
    id: "demo-shows-the-status",
    runId: RUN_ID,
    createdAt: "2026-10-03T00:00:00.000Z",
    status: "failed",
    test: { title: "shows the status", file: "tests/demo.spec.ts", line: 3 },
    failure: { message: "boom", errorContextRef: "x/error-context.md" },
    evidence: { screenshot: "x/test-failed-1.png" },
    context: { commit: "abc123" },
    flakiness: { verdict: "unknown", attempts: 1 },
    signals: { consoleErrors: [{ type: "error", text: "boom" }] },
  });
}

async function makeContext() {
  const root = await mkdtemp(path.join(tmpdir(), "qf-dispatch-"));
  const runDir = path.join(root, RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "demo-shows-the-status.v1.json"), defect(), "utf8");
  await writeFile(
    path.join(runDir, "quality-summary.v1.json"),
    JSON.stringify({
      schemaVersion: "1.1.0",
      runId: RUN_ID,
      createdAt: "2026-10-03T00:00:00.000Z",
      counts: { specs: 3, passed: 2, failed: 1, timedOut: 0, skipped: 0, flaky: 0 },
      defects: [`${RUN_ID}/demo-shows-the-status.v1.json`],
      thresholds: { maxFailureRate: 0.05, maxAttemptsPerTest: 2, maxDurationMs: 900000 },
      gate: { passed: true, violations: [] },
    }),
    "utf8",
  );
  const store = new ArtifactStore({ root });
  await store.init();
  return { store, logger: silentLogger };
}

function result(response: Awaited<ReturnType<typeof dispatch>>): Record<string, unknown> {
  if (response === null) throw new Error("expected a response, got null");
  if ("error" in response)
    throw new Error(`expected success, got ${JSON.stringify(response.error)}`);
  return response.result as Record<string, unknown>;
}

function errorOf(response: Awaited<ReturnType<typeof dispatch>>): {
  code: number;
  message: string;
} {
  if (response === null) throw new Error("expected a response, got null");
  if (!("error" in response)) throw new Error("expected an error response");
  return response.error;
}

/**
 * The `_meta` a 2026-07-28 client attaches to every request: the revision and
 * its own capabilities. Both keys are mandatory on that revision.
 */
function envelope(
  version: string = LATEST_PROTOCOL_VERSION,
  clientCapabilities: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: version,
    [META_CLIENT_CAPABILITIES]: clientCapabilities,
  };
}

/** `params` for a modern request carrying `envelope`. */
function modern(version = LATEST_PROTOCOL_VERSION): Record<string, unknown> {
  return { _meta: envelope(version) };
}

test.describe("protocol envelope", () => {
  test("every successful result carries resultType", async () => {
    const context = await makeContext();
    for (const method of [
      "server/discover",
      "initialize",
      "tools/list",
      "resources/list",
      "prompts/list",
    ]) {
      const response = await dispatch(context, { jsonrpc: "2.0", id: 1, method });
      expect(result(response).resultType, method).toBe(RESULT_TYPE_COMPLETE);
    }
  });

  test("tools/list carries the mandatory ttlMs and cacheScope", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );

    expect(typeof payload.ttlMs).toBe("number");
    expect(payload.cacheScope).toBe("private");
  });

  test("resources/read carries ttlMs and cacheScope", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "qualityforge://runs/latest/summary" },
      }),
    );

    expect(typeof payload.ttlMs).toBe("number");
    expect(payload.cacheScope).toBe("private");
  });

  test("server/discover advertises the current protocol version", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "server/discover" }),
    );

    expect(payload.protocolVersions).toContain(LATEST_PROTOCOL_VERSION);
    expect((payload.serverInfo as Record<string, unknown>).name).toBe("qualityforge-mcp");
  });

  test("accepts the legacy initialize handshake", async () => {
    // A client that never sends initialize must still be able to use tools/list.
    const context = await makeContext();
    const payload = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "initialize" }),
    );

    expect(payload.protocolVersion).toBeDefined();
    expect(payload.capabilities).toBeDefined();
  });

  test("initialize echoes the version the client asked for", async () => {
    // Negotiation, not assertion. OpenCode's default mode is "legacy" and
    // speaks only up to 2025-11-25; answering 2026-07-28 to it gets the
    // connection refused with "Server's protocol version is not supported".
    const context = await makeContext();

    const legacy = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "c", version: "1" },
        },
      }),
    );
    expect(legacy.protocolVersion).toBe("2025-11-25");

    const modern = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "c", version: "1" },
          // A client on this revision states it twice: once here, for the
          // handshake, and once in the envelope every 2026-07-28 request
          // carries. Without the envelope the request is refused outright.
          _meta: envelope(),
        },
      }),
    );
    expect(modern.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  test("initialize falls back to the newest version it serves when it cannot echo", async () => {
    // Two cases that must not produce an absent or invented version: a client
    // that states nothing, and one asking for something unheard of.
    const context = await makeContext();

    const unstated = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "initialize" }),
    );
    expect(unstated.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

    const unknown = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "1999-01-01",
          capabilities: {},
          clientInfo: { name: "c", version: "1" },
        },
      }),
    );
    expect(unknown.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  test("tools/list returns a stable order, so a client cache does not churn", async () => {
    const context = await makeContext();
    const first = result(await dispatch(context, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const second = result(await dispatch(context, { jsonrpc: "2.0", id: 2, method: "tools/list" }));

    const names = (p: Record<string, unknown>) =>
      (p.tools as { name: string }[]).map((t) => t.name).join(",");

    expect(names(first)).toBe(names(second));
  });

  test("every tool name satisfies SEP-986", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );

    for (const tool of payload.tools as { name: string }[]) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
      expect(tool.name, tool.name).toMatch(/^[A-Za-z0-9_./-]+$/);
    }
  });

  test("every tool is marked read-only", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );

    for (const tool of payload.tools as { name: string; annotations: Record<string, unknown> }[]) {
      expect(tool.annotations.readOnlyHint, String(tool.name)).toBe(true);
      expect(tool.annotations.destructiveHint, String(tool.name)).toBe(false);
    }
  });

  test("capabilities omit logging, which is deprecated in 2026-07-28", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "server/discover" }),
    );
    const capabilities = payload.capabilities as Record<string, unknown>;

    expect(capabilities.logging).toBeUndefined();
    expect(capabilities.tools).toBeDefined();
    expect(capabilities.resources).toBeDefined();
  });
});

test.describe("the 2026-07-28 _meta envelope", () => {
  test("a request that declares the revision without the envelope is refused", async () => {
    // 2026-07-28 made the envelope mandatory. Serving this request silently is
    // what lets a client and a server believe they agree on the revision while
    // exchanging results from two different protocols.
    const context = await makeContext();

    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION },
    });

    expect(errorOf(response).code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
  });

  test("an envelope missing the client capabilities is refused", async () => {
    // The revision is stated, so the request is not pre-envelope, but there is
    // nothing in it to negotiate capabilities against.
    const context = await makeContext();

    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { [META_PROTOCOL_VERSION]: LATEST_PROTOCOL_VERSION } },
    });

    expect(errorOf(response).code).toBe(INVALID_PARAMS);
  });

  test("the same request with the envelope is served", async () => {
    const context = await makeContext();
    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: modern(),
    });

    expect(result(response).tools).toBeDefined();
  });

  test("2025-11-25 is served without an envelope", async () => {
    // The revision before the envelope existed. Refusing it would break the
    // legacy mode that clients default to.
    const context = await makeContext();

    const legacy = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(result(legacy).tools).toBeDefined();

    // A client that states nothing at all is older still, and is served.
    const unstated = await dispatch(context, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(result(unstated).tools).toBeDefined();
  });

  test("every answer carries _meta back to the client", async () => {
    const context = await makeContext();

    for (const method of [
      "server/discover",
      "initialize",
      "tools/list",
      "resources/list",
      "resources/templates/list",
      "prompts/list",
      "ping",
    ]) {
      const payload = result(
        await dispatch(context, { jsonrpc: "2.0", id: 1, method, params: modern() }),
      );
      const meta = payload._meta as Record<string, unknown> | undefined;
      expect(meta, method).toBeDefined();
      const info = (meta?.[META_SERVER_INFO] ?? {}) as Record<string, unknown>;
      expect(info.name, method).toBe("qualityforge-mcp");
      expect(typeof info.version, method).toBe("string");
    }
  });

  test("a tool result carries _meta too", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "quality_get_latest_run", arguments: {}, ...modern() },
      }),
    );

    const meta = payload._meta as Record<string, unknown> | undefined;
    expect(meta?.[META_SERVER_INFO]).toBeDefined();
  });

  test("a notification that declares the revision without an envelope stays silent", async () => {
    // The envelope gate runs ahead of the method, so a notification can now fail
    // it. A notification still gets no answer - not even an error one, which
    // would be read by the client as a response it never asked for.
    const context = await makeContext();

    expect(
      await dispatch(context, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, requestId: "1" },
      }),
    ).toBeNull();
  });

  test("capabilities answer the client that declared subscriptions", async () => {
    const context = await makeContext();

    const declared = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          _meta: envelope(LATEST_PROTOCOL_VERSION, { subscriptions: { resources: true } }),
        },
      }),
    );
    const resources = (declared.capabilities as Record<string, unknown>).resources as Record<
      string,
      unknown
    >;
    expect(resources.subscribe).toBe(true);
  });

  test("capabilities do not offer subscriptions to a client that declared none", async () => {
    // Advertising a subscription this server cannot deliver is worse than
    // staying silent about it: the client subscribes and waits.
    const context = await makeContext();

    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: modern(),
      }),
    );
    const resources = (payload.capabilities as Record<string, unknown>).resources as Record<
      string,
      unknown
    >;
    expect(resources.subscribe).toBeUndefined();
  });
});

test.describe("notifications and malformed frames", () => {
  test("a notification gets no response", async () => {
    const context = await makeContext();

    expect(
      await dispatch(context, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
  });

  test("an unknown notification is silently dropped rather than answered", async () => {
    const context = await makeContext();

    expect(
      await dispatch(context, { jsonrpc: "2.0", method: "notifications/whatever" }),
    ).toBeNull();
  });

  test("a frame that is not a request yields Invalid Request", async () => {
    const context = await makeContext();

    expect(errorOf(await dispatch(context, { nonsense: true })).code).toBe(INVALID_REQUEST);
    expect(errorOf(await dispatch(context, null)).code).toBe(INVALID_REQUEST);
    expect(errorOf(await dispatch(context, [])).code).toBe(INVALID_REQUEST);
  });

  test("a wrong jsonrpc version is rejected", async () => {
    const context = await makeContext();

    expect(
      errorOf(await dispatch(context, { jsonrpc: "1.0", id: 1, method: "tools/list" })).code,
    ).toBe(INVALID_REQUEST);
  });

  test("an unknown method yields Method Not Found", async () => {
    const context = await makeContext();

    expect(errorOf(await dispatch(context, { jsonrpc: "2.0", id: 1, method: "nope" })).code).toBe(
      METHOD_NOT_FOUND,
    );
  });

  test("an unsupported protocol version gets the reserved MCP code", async () => {
    const context = await makeContext();
    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "something/unknown",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } },
    });

    expect(errorOf(response).code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    // In the MCP-reserved range, not the implementation-defined one.
    expect(UNSUPPORTED_PROTOCOL_VERSION).toBeLessThanOrEqual(-32020);
  });

  test("a version we do speak is not rejected for its version", async () => {
    const context = await makeContext();
    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
    });

    expect(result(response).tools).toBeDefined();
  });
});

test.describe("tools", () => {
  test("get_latest_run reports counts and the gate", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "quality_get_latest_run", arguments: {} },
      }),
    );

    expect(payload.resultType).toBe(RESULT_TYPE_COMPLETE);
    const structured = payload.structuredContent as Record<string, unknown>;
    expect(structured.runId).toBe(RUN_ID);
    expect((structured.gate as Record<string, unknown>).passed).toBe(true);
  });

  test("list_failures returns compact records, not full artifacts", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "quality_list_failures", arguments: {} },
      }),
    );

    const structured = payload.structuredContent as {
      total: number;
      defects: Record<string, unknown>[];
    };
    expect(structured.total).toBe(1);
    // A model asking "what failed" should not receive five whole artifacts.
    expect(structured.defects[0]).not.toHaveProperty("failure");
    expect(structured.defects[0]).toHaveProperty("defectPath");
    expect(structured.defects[0]).toHaveProperty("consoleErrorCount");
  });

  test("list_failures clamps a hostile limit", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "quality_list_failures", arguments: { limit: 100000 } },
      }),
    );

    const structured = payload.structuredContent as { defects: unknown[] };
    expect(structured.defects.length).toBeLessThanOrEqual(100);
  });

  test("get_defect returns the full artifact including signals", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "quality_get_defect",
          arguments: { defectPath: `${RUN_ID}/demo-shows-the-status.v1.json` },
        },
      }),
    );

    const structured = payload.structuredContent as Record<string, unknown>;
    expect(structured.id).toBe("demo-shows-the-status");
    expect(structured.signals).toBeDefined();
  });

  test("get_defect refuses a traversal attempt with Invalid Params", async () => {
    const context = await makeContext();
    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "quality_get_defect",
        arguments: { defectPath: "../../../../etc/passwd" },
      },
    });

    expect(errorOf(response).code).toBe(INVALID_PARAMS);
  });

  test("get_defect without a path is an error result, not a protocol error", async () => {
    const context = await makeContext();
    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "quality_get_defect", arguments: {} },
    });

    // A model can read and react to this; a transport error usually ends the turn.
    const payload = result(response);
    expect(payload.isError).toBe(true);
  });

  test("an unknown tool name is an error result listing what exists", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "quality_run_test", arguments: {} },
      }),
    );

    expect(payload.isError).toBe(true);
    expect(JSON.stringify(payload.content)).toContain("quality_list_failures");
  });

  test("tools/call without a name is Invalid Params", async () => {
    const context = await makeContext();

    expect(
      errorOf(await dispatch(context, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }))
        .code,
    ).toBe(INVALID_PARAMS);
  });

  test("there is no write-capable tool", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );

    const names = (payload.tools as { name: string }[]).map((t) => t.name);
    expect(
      names.some((n) => /^(quality_run|quality_fix|quality_write|quality_publish)/.test(n)),
    ).toBe(false);
  });
});

test.describe("resources and prompts", () => {
  test("reads the latest summary resource", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "qualityforge://runs/latest/summary" },
      }),
    );

    const contents = payload.contents as { text: string; mimeType: string }[];
    expect(contents[0]?.mimeType).toBe("application/json");
    expect((JSON.parse(contents[0]!.text) as { runId: string }).runId).toBe(RUN_ID);
  });

  test("an unknown resource URI is Invalid Params, per 2026-07-28", async () => {
    const context = await makeContext();
    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "qualityforge://nope" },
    });

    // Moved from -32002 to -32602 by this revision.
    expect(errorOf(response).code).toBe(INVALID_PARAMS);
  });

  test("a traversal in a resource URI is refused", async () => {
    const context = await makeContext();
    const response = await dispatch(context, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "qualityforge://defect/..%2F..%2Fetc%2Fpasswd" },
    });

    expect(errorOf(response).code).toBe(INVALID_PARAMS);
  });

  test("reads a defect resource", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: `qualityforge://defect/${RUN_ID}/demo-shows-the-status.v1.json` },
      }),
    );

    const contents = payload.contents as { text: string }[];
    expect((JSON.parse(contents[0]!.text) as { id: string }).id).toBe("demo-shows-the-status");
  });

  test("advertises a resource template", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, { jsonrpc: "2.0", id: 1, method: "resources/templates/list" }),
    );

    expect(payload.resourceTemplates).toBeDefined();
    expect(payload.ttlMs).toBeDefined();
  });

  test("get_prompt builds the triage prompt", async () => {
    const context = await makeContext();
    const payload = result(
      await dispatch(context, {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: {
          name: "triage_failure",
          arguments: { defectPath: `${RUN_ID}/demo-shows-the-status.v1.json` },
        },
      }),
    );

    const messages = payload.messages as { content: { text: string } }[];
    expect(messages[0]?.content.text).toContain("quality_get_defect");
    expect(messages[0]?.content.text).toContain("at most three hypotheses");
  });

  test("get_prompt without a defectPath is Invalid Params", async () => {
    const context = await makeContext();

    expect(
      errorOf(
        await dispatch(context, {
          jsonrpc: "2.0",
          id: 1,
          method: "prompts/get",
          params: { name: "triage_failure" },
        }),
      ).code,
    ).toBe(INVALID_PARAMS);
  });

  test("an unknown prompt is Invalid Params", async () => {
    const context = await makeContext();

    expect(
      errorOf(
        await dispatch(context, {
          jsonrpc: "2.0",
          id: 1,
          method: "prompts/get",
          params: { name: "x" },
        }),
      ).code,
    ).toBe(INVALID_PARAMS);
  });
});

test.describe("compatibility acknowledgements", () => {
  test("logging/setLevel is acknowledged rather than reported unknown", async () => {
    // A client that still sends it must not be left waiting on a reply.
    const context = await makeContext();

    expect(
      result(await dispatch(context, { jsonrpc: "2.0", id: 1, method: "logging/setLevel" }))
        .resultType,
    ).toBe(RESULT_TYPE_COMPLETE);
  });

  test("PARSE_ERROR is the documented code for a bad frame", () => {
    expect(PARSE_ERROR).toBe(-32700);
  });
});
