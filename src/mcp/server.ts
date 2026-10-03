/**
 * Request dispatch for the MCP server.
 *
 * Kept separate from the transport so the whole protocol surface can be tested
 * by calling `dispatch` with plain objects: no process, no pipes, no timing.
 */
import {
  CACHE_SCOPE_PRIVATE,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  META_PROTOCOL_VERSION,
  RESULT_TYPE_COMPLETE,
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  TTL_RESOURCE_LIST_MS,
  TTL_RESOURCE_READ_MS,
  TTL_TOOL_LIST_MS,
  UNSUPPORTED_PROTOCOL_VERSION,
  cacheable,
  canServe,
  complete,
  parseRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";
import {
  CAPABILITIES,
  PROMPTS,
  RESOURCES,
  RESOURCE_TEMPLATES,
  SERVER_INSTRUCTIONS,
  TOOLS,
  UnknownResourceError,
  buildTriagePrompt,
  callTool,
  readResource,
} from "./tools.js";
import { PathAccessError, type ArtifactStore } from "./store.js";

/** Diagnostics. Must never write to stdout, which carries JSON-RPC frames. */
export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
}

export const stderrLogger: Logger = {
  debug: (message, ...rest) => console.error(`[qualityforge-mcp] ${message}`, ...rest),
  warn: (message, ...rest) => console.error(`[qualityforge-mcp] WARN ${message}`, ...rest),
};

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/** Read the protocol version a request claims, from either location. */
function versionOf(request: JsonRpcRequest): string | undefined {
  const fromMeta = request.params?._meta;
  if (typeof fromMeta === "object" && fromMeta !== null) {
    const value = (fromMeta as Record<string, unknown>)[META_PROTOCOL_VERSION];
    if (typeof value === "string") return value;
  }
  // 2025-11-25 and earlier carried it in params.protocolVersion.
  const legacy = request.params?.protocolVersion;
  return typeof legacy === "string" ? legacy : undefined;
}

export interface DispatchContext {
  store: ArtifactStore;
  logger: Logger;
}

/**
 * Handle one JSON-RPC frame.
 *
 * @returns a response, or null for a notification.
 */
export async function dispatch(
  context: DispatchContext,
  raw: unknown,
): Promise<JsonRpcResponse | null> {
  const request = parseRequest(raw);
  if (request === null) {
    // Without a trustworthy id the only thing to do is answer with a null id.
    return fail(null, INVALID_REQUEST, "Not a valid JSON-RPC 2.0 request");
  }

  const { method, id } = request;
  const isNotification = id === undefined;
  // A notification never gets a response, not even an error.
  const reply = (response: JsonRpcResponse | null): JsonRpcResponse | null =>
    isNotification ? null : response;

  try {
    switch (method) {
      // --- discovery ---------------------------------------------------
      case "server/discover":
        return reply(
          ok(id, {
            resultType: RESULT_TYPE_COMPLETE,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            capabilities: CAPABILITIES,
            instructions: SERVER_INSTRUCTIONS,
          }),
        );

      // Compatibility with clients that still perform the 2025-11-25
      // handshake. Removed in 2026-07-28, but such a client must still get
      // tools/list, and answering costs nothing.
      case "initialize":
        return reply(
          ok(id, {
            resultType: RESULT_TYPE_COMPLETE,
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: CAPABILITIES,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: SERVER_INSTRUCTIONS,
          }),
        );

      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      // --- tools --------------------------------------------------------
      case "tools/list":
        return reply(ok(id, cacheable({ tools: TOOLS }, TTL_TOOL_LIST_MS, CACHE_SCOPE_PRIVATE)));

      case "tools/call": {
        const name = request.params?.name;
        if (typeof name !== "string") {
          return reply(fail(id, INVALID_PARAMS, "tools/call requires a string 'name'"));
        }
        const rawArgs = request.params?.arguments;
        const args =
          typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {};

        const result = await callTool(context.store, name, args);
        return reply(
          ok(id, {
            resultType: RESULT_TYPE_COMPLETE,
            content: result.content,
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent }),
            ...(result.isError === undefined ? {} : { isError: result.isError }),
          }),
        );
      }

      // --- resources ----------------------------------------------------
      case "resources/list":
        return reply(ok(id, cacheable({ resources: RESOURCES }, TTL_RESOURCE_LIST_MS)));

      case "resources/templates/list":
        return reply(
          ok(id, cacheable({ resourceTemplates: RESOURCE_TEMPLATES }, TTL_RESOURCE_LIST_MS)),
        );

      case "resources/read": {
        const uri = request.params?.uri;
        if (typeof uri !== "string") {
          return reply(fail(id, INVALID_PARAMS, "resources/read requires a string 'uri'"));
        }
        try {
          const content = await readResource(context.store, uri);
          return reply(ok(id, cacheable({ contents: [content] }, TTL_RESOURCE_READ_MS)));
        } catch (error) {
          if (error instanceof UnknownResourceError) {
            // 2026-07-28 moved resource-not-found to Invalid Params (-32602).
            return reply(fail(id, INVALID_PARAMS, error.message));
          }
          if (error instanceof PathAccessError) {
            // Deliberately generic. The detail would tell a caller how the
            // filesystem is laid out.
            return reply(fail(id, INVALID_PARAMS, "Resource path is not readable"));
          }
          throw error;
        }
      }

      // --- prompts ------------------------------------------------------
      case "prompts/list":
        return reply(ok(id, cacheable({ prompts: PROMPTS }, TTL_TOOL_LIST_MS)));

      case "prompts/get": {
        const name = request.params?.name;
        if (typeof name !== "string") {
          return reply(fail(id, INVALID_PARAMS, "prompts/get requires a string 'name'"));
        }
        if (name !== "triage_failure") {
          return reply(fail(id, INVALID_PARAMS, `Unknown prompt: ${name}`));
        }
        const args = request.params?.arguments;
        const defectPath =
          typeof args === "object" && args !== null
            ? (args as Record<string, unknown>).defectPath
            : undefined;
        if (typeof defectPath !== "string" || defectPath === "") {
          return reply(
            fail(id, INVALID_PARAMS, "prompts/get requires 'defectPath' as an argument"),
          );
        }
        return reply(
          ok(id, {
            resultType: RESULT_TYPE_COMPLETE,
            description: "Evidence-first failure triage",
            messages: [
              { role: "user", content: { type: "text", text: buildTriagePrompt(defectPath) } },
            ],
          }),
        );
      }

      // --- compatibility acknowledgements -------------------------------
      // logging/setLevel was removed in 2026-07-28 in favour of a per-request
      // `_meta` key. Acknowledged rather than reported as unknown, so a client
      // that still sends it is not left waiting on a reply that never comes.
      case "logging/setLevel":
      case "ping":
        return reply(ok(id, complete()));

      default: {
        const version = versionOf(request);
        if (version !== undefined && !canServe(version)) {
          return reply(
            fail(id, UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version: ${version}`, {
              supported: [...SUPPORTED_PROTOCOL_VERSIONS],
            }),
          );
        }
        return reply(fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`));
      }
    }
  } catch (error) {
    if (error instanceof PathAccessError) {
      context.logger.warn(`path rejected: ${error.message}`);
      return reply(fail(id, INVALID_PARAMS, "Path is not readable"));
    }
    context.logger.warn(`internal error handling ${method}: ${String(error)}`);
    return reply(fail(id, INTERNAL_ERROR, "Internal error", { detail: String(error) }));
  }
}
