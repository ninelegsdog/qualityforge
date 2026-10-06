#!/usr/bin/env node
/**
 * QualityForge MCP server — read-only evidence about browser test failures.
 *
 * Speaks JSON-RPC 2.0 over stdio. Protocol 2026-07-28, with the 2025-11-25
 * handshake accepted for clients that still send it.
 *
 * Wired into OpenCode, which is the only client this has ever been connected
 * with:
 *
 * ```jsonc
 * {
 *   "$schema": "https://opencode.ai/config.json",
 *   "mcp": {
 *     "qualityforge": {
 *       "enabled": true,
 *       "type": "local",
 *       "command": [
 *         "node",
 *         "/absolute/path/to/qualityforge/node_modules/tsx/dist/cli.mjs",
 *         "/absolute/path/to/qualityforge/src/mcp/index.ts",
 *       ],
 *     },
 *   },
 * }
 * ```
 *
 * The compiled entry is the published one: `bin["qualityforge-mcp"]` points at
 * `dist/mcp/index.js`, `prepare` builds it, and `npm run mcp:live` — the CI
 * check that connects a real client — spawns exactly that path, from a
 * directory outside the project, because that is how a client starts it. The
 * `tsx` invocation above still works for development (it is what
 * `npm run mcp` runs), but `dist/` is no longer hypothetical: an earlier
 * version of this comment said the project had no build step and no install
 * had ever produced `dist/mcp/index.js`. Packaging changed that; the comment
 * had to follow.
 *
 * Kilo and MiMo are **not supported, by decision** — they read a similar `mcp`
 * shape, but only OpenCode was ever connected, so "all three read the same
 * shape" was a claim about the format and not about this server working. See
 * the end of the MCP section in `README.md`.
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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./stdio.js";
import { stderrLogger } from "./server.js";
import { ArtifactStore } from "./store.js";
import { SERVER_NAME, SERVER_VERSION } from "./protocol.js";

/** Default root: where `npm run defects:collect` writes. */
const DEFAULT_ROOT = "artifacts/defects";

/** Root of this checkout, used to resolve a relative root when cwd has none. */
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

function usage(): string {
  return [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    "",
    "Usage:",
    "  this repository     npm run mcp -- [--root <dir>] [--history <dir>]",
    "  a consuming project npx --no-install qualityforge-mcp [--root <dir>] [--history <dir>]",
    "",
    "  --root <dir>    artifacts root to serve (default: " + DEFAULT_ROOT + ")",
    "  --history <dir> run-history directory to serve, if the project keeps one",
    "                  (default: quality-history, when that directory exists)",
    "  --help          this message",
    "",
    "Reads only. Writes nothing.",
  ].join("\n");
}

function parseArgs(argv: string[]): {
  root: string | undefined;
  history: string | undefined;
  help: boolean;
} {
  let root: string | undefined;
  let history: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--root" || arg === "--history") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) {
        // stderr, always: stdout is the protocol channel.
        console.error(`[qualityforge-mcp] ${arg} requires a directory`);
        process.exit(1);
      }
      if (arg === "--root") {
        root = value;
      } else {
        history = value;
      }
    } else {
      console.error(`[qualityforge-mcp] unknown argument: ${arg}`);
      console.error(usage());
      process.exit(1);
    }
  }
  return { root, history, help };
}

async function main(): Promise<number> {
  const { root, history, help } = parseArgs(process.argv.slice(2));

  if (help) {
    console.error(usage());
    return 0;
  }

  // Resolution order, and the reason for it.
  //
  // A relative root is resolved against the invocation directory first, because
  // that is what someone who `cd`s into a project expects. But an MCP client
  // does not do that: OpenCode, Kilo and MiMo spawn the server with their own
  // working directory, which is the user's project, not this repository. The
  // relative root then resolves to a directory that does not exist, the store
  // fails to initialise, and the client reports only "Connection closed" - the
  // actionable message goes to stderr, which the client discards.
  //
  // So when the working-directory root is absent, fall back to the root of the
  // checkout this file lives in. An explicit --root is always honoured as given.
  const cwd = process.cwd();
  const fromCwd = path.resolve(cwd, root ?? DEFAULT_ROOT);
  let absoluteRoot = fromCwd;
  let usedFallback = false;
  if (!existsSync(fromCwd)) {
    const fromPackage = path.resolve(PACKAGE_ROOT, root ?? DEFAULT_ROOT);
    if (existsSync(fromPackage)) {
      absoluteRoot = fromPackage;
      usedFallback = true;
    }
  }

  // The history directory is a second root, not a subdirectory of the artifacts
  // root: artifacts are gitignored output, history is committed, and neither lives
  // under the other. An explicit flag wins; otherwise the conventional name is used
  // only if it exists, so a project that keeps no history gets no history rather
  // than a path that fails to resolve.
  const historyDir =
    history ?? ["quality-history"].find((candidate) => existsSync(path.resolve(cwd, candidate)));
  const store = new ArtifactStore({
    root: absoluteRoot,
    ...(historyDir === undefined ? {} : { historyRoot: path.resolve(cwd, historyDir) }),
  });
  try {
    await store.init();
  } catch (error) {
    console.error(`[qualityforge-mcp] ${(error as Error).message}`);
    return 1;
  }

  // stderr, not stdout: a startup banner on stdout is a corrupt frame.
  // Say so when the root came from the fallback, because the user did not ask
  // for that path and would otherwise have no idea which directory is served.
  if (usedFallback) {
    console.error(
      `[qualityforge-mcp] no artifacts root at ${fromCwd} relative to the ` +
        `working directory; falling back to this checkout at ${absoluteRoot}`,
    );
  }
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
