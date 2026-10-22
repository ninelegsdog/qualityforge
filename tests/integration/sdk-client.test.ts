/**
 * The official MCP SDK client against this server, over stdio.
 *
 * This is the "real client" half of the layer: `Client` + `StdioClientTransport`
 * spawn `dist/mcp/index.js`, perform the handshake, list the tools and call one —
 * the whole path `tests/unit/mcp/dispatch.test.ts` replaces with hand-built
 * objects. It exercises the SDK's own protocol validation, which is a different
 * set of assertions from ours: a result the SDK's schemas reject fails here even
 * when every hand-written expectation passes.
 *
 * It negotiates the SDK's epoch (2025-11-25), because
 * `@modelcontextprotocol/sdk` has no notion of 2026-07-28 — see the header of
 * `src/mcp/protocol.ts`. That is still the right check: `initialize` must echo a
 * version the SDK accepts, or `connect()` itself fails schema validation. The
 * modern epoch is covered by `modern-epoch.test.ts`, which speaks it by hand.
 *
 * ## Why this file skips instead of failing
 *
 * The SDK is not a dependency of this package and `package.json` is
 * integrator-only, so this agent cannot add it. Without the package the dynamic
 * import returns null and both tests skip, naming what is missing. Once
 * `@modelcontextprotocol/sdk` lands in devDependencies the tests run with no
 * change here — the specifier is an expression so that `tsc --noEmit` stays
 * green in a checkout that does not have it.
 */
import { expect, test } from "@playwright/test";
import {
  cleanupTempDirs,
  ensureServerEntry,
  makeRoot,
  makeTempDir,
  seedRun,
} from "./helpers/mcp-proc.js";

const RUN_1 = "2026-10-03T00-00-00-000Z-aaaaaa";
const RUN_2 = "2026-10-04T00-00-00-000Z-bbbbbb";
const OTHER_RUN = "2026-10-05T00-00-00-000Z-cccccc";

const MISSING_SDK_REASON =
  "@modelcontextprotocol/sdk is not installed; add it to devDependencies (package.json is " +
  "integrator-only) and `npm install`, and this test will run instead of skipping.";

/** Built as an expression so TypeScript cannot resolve it statically. */
const SDK_SPECIFIER = ["@modelcontextprotocol/sdk", "client", "index.js"].join("/");
const SDK_STDIO_SPECIFIER = ["@modelcontextprotocol/sdk", "client", "stdio.js"].join("/");

interface Implementation {
  name: string;
  version: string;
}

interface SdkTransport {
  readonly stderr: { on(event: string, listener: (chunk: unknown) => void): void } | null;
}

interface SdkClient {
  connect(transport: SdkTransport): Promise<void>;
  close(): Promise<void>;
  getServerVersion(): Implementation | undefined;
  getServerCapabilities(): Record<string, unknown> | undefined;
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ content: unknown; structuredContent?: Record<string, unknown>; isError?: boolean }>;
}

interface ClientModule {
  Client: new (
    info: Implementation,
    options?: { capabilities?: Record<string, unknown> },
  ) => SdkClient;
}

interface StdioModule {
  StdioClientTransport: new (params: {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    stderr?: string;
  }) => SdkTransport;
}

/** Narrow the dynamic import result without letting `any` reach the assertions. */
function asModule<T>(value: unknown): T {
  return value as T;
}

async function loadSdk(): Promise<{ client: ClientModule; stdio: StdioModule } | null> {
  try {
    const clientModule: unknown = await import(SDK_SPECIFIER);
    const stdioModule: unknown = await import(SDK_STDIO_SPECIFIER);
    return {
      client: asModule<ClientModule>(clientModule),
      stdio: asModule<StdioModule>(stdioModule),
    };
  } catch {
    return null;
  }
}

/** Environment for the spawned server: strings only, like the SDK's own default. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

interface Session {
  client: SdkClient;
  root: string;
  stderrOf: () => string;
}

test.beforeAll(async () => {
  await ensureServerEntry();
});

test.afterAll(async () => {
  await cleanupTempDirs();
});

/** One SDK client with its own server process and its own artifacts root. */
async function openSession(
  sdk: { client: ClientModule; stdio: StdioModule },
  runIds: string[],
): Promise<Session> {
  const entry = await ensureServerEntry();
  const root = makeRoot("qf-mcp-sdk-", runIds);
  let stderr = "";
  const transport = new sdk.stdio.StdioClientTransport({
    command: process.execPath,
    args: [entry, "--root", root],
    cwd: makeTempDir("qf-mcp-sdk-cwd-"),
    env: childEnv(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });

  const client = new sdk.client.Client(
    { name: "qf-integration-sdk-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, root, stderrOf: () => stderr };
}

/** Re-throw a failure with the server's stderr attached; clients discard it. */
async function withStderr<T>(session: Session, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw new Error(`${detail}\nserver stderr:\n${session.stderrOf() || "  (empty)"}`, {
      cause: error,
    });
  }
}

test.describe("official SDK client over stdio", () => {
  test("connects, lists tools and calls one through the SDK's own transport", async () => {
    const sdk = await loadSdk();
    if (sdk === null) {
      test.skip(true, MISSING_SDK_REASON);
      return;
    }

    const session = await openSession(sdk, [RUN_1]);
    try {
      await withStderr(session, async () => {
        // connect() has already run `initialize` and validated the server's
        // answer against the SDK's schemas — a version it cannot accept, or a
        // result missing a required field, would have thrown right here.
        expect(session.client.getServerVersion()?.name).toBe("qualityforge-mcp");
        expect(session.client.getServerCapabilities()?.tools).toBeDefined();

        const listed = await session.client.listTools();
        const names = listed.tools.map((tool) => tool.name);
        expect(names).toContain("quality_get_latest_run");
        expect(names[0]).toBe("quality_get_latest_run");

        const first = await session.client.callTool({
          name: "quality_get_latest_run",
          arguments: {},
        });
        expect(first.isError ?? false).toBe(false);
        expect(first.structuredContent?.runId).toBe(RUN_1);

        // Session semantics with the real client: a run written after the
        // connection opened is visible to the next call on that connection.
        seedRun(session.root, RUN_2);
        const second = await session.client.callTool({
          name: "quality_get_latest_run",
          arguments: {},
        });
        expect(second.structuredContent?.runId).toBe(RUN_2);
      });
    } finally {
      await session.client.close();
    }
  });

  test("two SDK clients are two sessions over two roots", async () => {
    const sdk = await loadSdk();
    if (sdk === null) {
      test.skip(true, MISSING_SDK_REASON);
      return;
    }

    const a = await openSession(sdk, [RUN_1]);
    const b = await openSession(sdk, [OTHER_RUN]);
    try {
      await withStderr(a, async () => {
        await withStderr(b, async () => {
          const callRun = async (session: Session): Promise<unknown> => {
            const answer = await session.client.callTool({
              name: "quality_get_latest_run",
              arguments: {},
            });
            return answer.structuredContent?.runId;
          };

          expect(await callRun(a)).toBe(RUN_1);
          expect(await callRun(b)).toBe(OTHER_RUN);

          seedRun(a.root, RUN_2);
          expect(await callRun(a)).toBe(RUN_2);
          // B's answer is unchanged by evidence written under A: the root is
          // decided per connection, so nothing crosses between the sessions.
          expect(await callRun(b)).toBe(OTHER_RUN);
        });
      });
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });
});
