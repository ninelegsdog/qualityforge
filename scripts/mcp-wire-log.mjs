#!/usr/bin/env node
/**
 * A stdio pass-through that writes every MCP frame it forwards to a file.
 *
 * Exists because "the client connected" is a weaker claim than "the client
 * asked for what we think it asks for". `opencode mcp list` reports one word,
 * and that word cannot distinguish a pinned 2026-07-28 handshake from a
 * legacy one, nor a `tools/list` answer carrying `resultType` from one that
 * does not. The live-client check reads this log and asserts the frames.
 *
 * Contract:
 *   node mcp-wire-log.mjs <log-path> -- <command> [args...]
 *
 * stdin/stdout carry the JSON-RPC stream and are forwarded line by line, one
 * frame per line, unmodified. The log gets one line per frame, prefixed
 * `C->S ` or `S->C `. stderr is inherited, not logged: the server's
 * diagnostics belong on stderr, and the client discards it either way.
 *
 * Dependency-free on purpose: this runs in CI between the client and the
 * server, where installing anything would be one more thing that can fail
 * without saying why.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (argv.length < 3 || sep !== 1) {
  console.error("usage: mcp-wire-log.mjs <log-path> -- <command> [args...]");
  process.exit(2);
}
const logPath = argv[0];
const childArgs = argv.slice(sep + 1);
if (childArgs.length === 0) {
  console.error("usage: mcp-wire-log.mjs <log-path> -- <command> [args...]");
  process.exit(2);
}

const log = fs.createWriteStream(logPath, { flags: "a" });
const write = (dir, line) => log.write(`${dir} ${line}\n`);

const child = spawn(childArgs[0], childArgs.slice(1), {
  stdio: ["pipe", "pipe", "inherit"],
});

const up = readline.createInterface({ input: process.stdin });
up.on("line", (line) => {
  write("C->S", line);
  child.stdin.write(line + "\n");
});
up.on("close", () => child.stdin.end());

const down = readline.createInterface({ input: child.stdout });
down.on("line", (line) => {
  write("S->C", line);
  process.stdout.write(line + "\n");
});

child.on("exit", (code) => {
  // End the log and exit only from its flush callback: `process.exit()` right
  // after `end()` races the write buffer and silently drops the last frames,
  // which once produced an "answer never arrived" verdict that was an artifact
  // of this proxy, not of the server.
  up.close();
  down.close();
  log.end(() => process.exit(code === null ? 1 : code));
});
child.on("error", (error) => {
  console.error(`mcp-wire-log: cannot start ${childArgs[0]}: ${error.message}`);
  log.end(() => process.exit(1));
});
