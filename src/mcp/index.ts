#!/usr/bin/env node
/**
 * QualityForge MCP server — read-only evidence about browser test failures.
 *
 * Speaks JSON-RPC 2.0 over stdio. Protocol 2026-07-28, with the 2025-11-25
 * handshake accepted for clients that still send it.
 *
 * Wire it into OpenCode, Kilo or MiMo with the same block, because all three
 * read the same `mcp` shape:
 *
 * ```jsonc
 * {
 *   "mcp": {
 *     "qualityforge": {
 *       "enabled": true,
 *       "type": "local",
 *       "command": ["node", "/path/to/qualityforge/dist/mcp/index.js"]
 *     }
 *   }
 * }
 * ```
 *
 * Flags:
 *   --root <dir>   artifacts root to serve (default artifacts/defects)
 *   --help         print usage to stderr and exit 0
 *
 * Exit codes: 0 clean shutdown, 1 bad usage or unreadable root, 2 if stdin
 * gives up unexpectedly.
 *
 * Nothing here writes to stdout except JSON-RPC frames.
 */
import path from "node:path";
import { serve } from "./stdio.js";
import { stderrLogger } from "./server.js";
import { ArtifactStore } from "./store.js";
import { SERVER_NAME, SERVER_VERSION } from "./protocol.js";

/** Default root: where `npm run defects:collect` writes. */
const DEFAULT_ROOT = "artifacts/defects";

function usage(): string {
  return [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    "",
    "Usage: qualityforge-mcp [--root <dir>]",
    "",
    "  --root <dir>  artifacts root to serve (default: " + DEFAULT_ROOT + ")",
    "  --help        this message",
    "",
    "Reads only. Writes nothing.",
  ].join("\n");
}

function parseArgs(argv: string[]): { root: string | undefined; help: boolean } {
  let root: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--root") {
      root = argv[i + 1];
      i += 1;
      if (root === undefined) {
        // stderr, always: stdout is the protocol channel.
        console.error("[qualityforge-mcp] --root requires a directory");
        process.exit(1);
      }
    } else {
      console.error(`[qualityforge-mcp] unknown argument: ${arg}`);
      console.error(usage());
      process.exit(1);
    }
  }
  return { root, help };
}

async function main(): Promise<number> {
  const { root, help } = parseArgs(process.argv.slice(2));

  if (help) {
    console.error(usage());
    return 0;
  }

  // Resolve relative to the invocation directory, not to this file, so the
  // server can be started from anywhere.
  const cwd = process.cwd();
  const absoluteRoot = path.resolve(cwd, root ?? DEFAULT_ROOT);

  const store = new ArtifactStore({ root: absoluteRoot });
  try {
    await store.init();
  } catch (error) {
    console.error(`[qualityforge-mcp] ${(error as Error).message}`);
    return 1;
  }

  // stderr, not stdout: a startup banner on stdout is a corrupt frame.
  console.error(
    `[qualityforge-mcp] serving ${absoluteRoot} (read-only). ` +
      "Protocol 2026-07-28 with 2025-11-25 handshake accepted.",
  );

  await serve({ context: { store, logger: stderrLogger } });
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[qualityforge-mcp] fatal: ${String(error)}`);
    process.exitCode = 2;
  });
