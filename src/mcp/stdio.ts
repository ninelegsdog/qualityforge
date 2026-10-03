/**
 * stdio transport: newline-delimited JSON-RPC 2.0.
 *
 * Two rules govern this file, and breaking either corrupts the protocol:
 *
 * 1. **stdout carries JSON-RPC frames and nothing else.** Not a banner, not a
 *    warning, not a stray `console.log` from a dependency. Diagnostics go to
 *    stderr, which the transport spec designates for logging.
 * 2. **Responses may be written out of order.** A 2026-07-28 client can have
 *    several requests in flight, so replies are written as they resolve rather
 *    than in arrival order. JSON-RPC matches them by id, and serialising would
 *    make a slow artifact read block every other answer.
 */
import { createInterface } from "node:readline";
import { dispatch, stderrLogger, type DispatchContext, type Logger } from "./server.js";

export interface ServeOptions {
  context: DispatchContext;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  logger?: Logger;
}

/** Write one frame followed by a newline. */
function writeFrame(output: NodeJS.WritableStream, frame: unknown): void {
  output.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Read frames until the input stream ends.
 *
 * @returns the number of frames processed.
 */
export async function serve(options: ServeOptions): Promise<number> {
  const { context } = options;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const logger = options.logger ?? stderrLogger;

  // `crlfDelay: Infinity` matters: without it a CRLF-terminated frame keeps the
  // carriage return inside the JSON string, and `JSON.parse` still accepts it,
  // so the corruption shows up later as a bizarre tool name instead of here.
  const lines = createInterface({ input, crlfDelay: Infinity });

  // Rejections are handled per frame; nothing may escape as an unhandled
  // rejection and take the process down mid-conversation.
  const inFlight = new Set<Promise<void>>();
  let handled = 0;

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    handled += 1;

    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      // -32700. Handled here because dispatch only sees parsed input.
      writeFrame(output, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: frame is not valid JSON" },
      });
      continue;
    }

    const task = dispatch(context, frame)
      .then((response) => {
        if (response !== null) writeFrame(output, response);
      })
      .catch((error: unknown) => {
        logger.warn(`dispatch threw: ${String(error)}`);
      })
      .finally(() => {
        inFlight.delete(task);
      });

    inFlight.add(task);
  }

  // Drain in-flight work before the process exits, so the last answer is not
  // lost to a closing stream.
  await Promise.allSettled([...inFlight]);
  return handled;
}
