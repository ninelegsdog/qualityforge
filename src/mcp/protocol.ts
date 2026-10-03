/**
 * MCP protocol constants and JSON-RPC types.
 *
 * ## Why this is hand-written
 *
 * The official TypeScript SDK was checked directly rather than assumed.
 * `@modelcontextprotocol/sdk@1.32.0`, published 2026-10-02, declares
 * `LATEST_PROTOCOL_VERSION = "2025-11-25"` and contains no `server/discover`, no
 * `resultType`, no `ttlMs`/`cacheScope` and no `subscriptions/listen`.
 *
 * In other words the SDK does not implement protocol 2026-07-28, which is the
 * version this server targets. Building on it would mean shipping the previous
 * generation of the protocol, so the surface is implemented here instead. That
 * also keeps the project dependency-free, which is a stated goal.
 *
 * If the SDK gains 2026-07-28 support, this module is the only part that needs
 * to change: it is a few hundred lines and has no other responsibility.
 */

/** Protocol versions this server can speak. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25"] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const LATEST_PROTOCOL_VERSION: ProtocolVersion = "2026-07-28";

/** The release that removed sessions, the initialize handshake and logging. */
export const STATELESS_PROTOCOL_VERSION: ProtocolVersion = "2026-07-28";

/** `_meta` keys carrying protocol state per request, from 2026-07-28. */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/**
 * The envelope itself: `params._meta` on a request, `result._meta` on an answer.
 *
 * Named because the two halves are not the same object. The request half states
 * who is speaking; the result half states who answered.
 */
export const META_ENVELOPE = "_meta";

/** Name and version of a peer, as carried in `_meta`. */
export interface Implementation {
  name: string;
  version: string;
}

/**
 * `resultType` values. Every result in 2026-07-28 carries one; clients must
 * treat an absent field as "complete" for backward compatibility.
 */
export const RESULT_TYPE_COMPLETE = "complete";
export const RESULT_TYPE_INPUT_REQUIRED = "input_required";
export type ResultType = typeof RESULT_TYPE_COMPLETE | typeof RESULT_TYPE_INPUT_REQUIRED;

export const CACHE_SCOPE_PUBLIC = "public";
export const CACHE_SCOPE_PRIVATE = "private";
export type CacheScope = typeof CACHE_SCOPE_PUBLIC | typeof CACHE_SCOPE_PRIVATE;

/**
 * Freshness hint for list and read results, in milliseconds. Required by
 * 2026-07-28 on `tools/list`, `prompts/list`, `resources/list`,
 * `resources/read` and `resources/templates/list`.
 *
 * The values differ by method on purpose. A tool list changes only when the
 * build changes, so it can be cached for minutes. A run summary changes on the
 * next test run, so it stays short.
 */
export const TTL_TOOL_LIST_MS = 300_000;
export const TTL_RESOURCE_LIST_MS = 300_000;
export const TTL_RESOURCE_READ_MS = 5_000;

/** JSON-RPC error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * Reserved MCP range, per the 2026-07-28 allocation policy.
 * -32000..-32019 stays implementation-defined; -32020..-32099 belongs to MCP.
 */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export const SERVER_NAME = "qualityforge-mcp";
export const SERVER_VERSION = "0.1.0-alpha.0";

/** A JSON-RPC request. `id` is absent for notifications. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC response carrying a result. */
export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

/** A JSON-RPC response carrying an error. */
export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export function isJsonRpcResponse(value: JsonRpcResponse): value is JsonRpcSuccess {
  return "result" in value;
}

/**
 * `CacheableResult`: the shape 2026-07-28 requires from list and read methods.
 *
 * `ttlMs` is a hint so a client can poll less often; `cacheScope` says whether
 * an intermediary may cache it. Defect data is per-user and per-machine, so it
 * is always "private".
 */
/**
 * Any result. `resultType` is mandatory in 2026-07-28 on every result, not only
 * on the cacheable ones.
 */
export interface CompleteResult {
  resultType: ResultType;
  [key: string]: unknown;
}

/** A cacheable result: `CompleteResult` plus the freshness envelope. */
export interface CacheableResult extends CompleteResult {
  ttlMs: number;
  cacheScope: CacheScope;
}

/** Build a cacheable result with the required envelope. */
export function cacheable<T extends object>(
  payload: T,
  ttlMs: number,
  cacheScope: CacheScope = CACHE_SCOPE_PRIVATE,
): CacheableResult {
  return {
    resultType: RESULT_TYPE_COMPLETE,
    ttlMs,
    cacheScope,
    ...payload,
  };
}

/** Build a plain, non-cacheable result carrying the mandatory `resultType`. */
export function complete(payload: Record<string, unknown> = {}): CompleteResult {
  return { resultType: RESULT_TYPE_COMPLETE, ...payload };
}

/**
 * What a request's `_meta` actually said.
 *
 * The three fields are reported separately, and two of them are typed as
 * possibly-undefined, because "no envelope at all" and "an envelope that cannot
 * be used" are different faults and get different answers. Collapsing them into
 * one boolean is how a malformed envelope ends up served as if it were absent.
 */
export interface EnvelopeContents {
  /** The `params._meta` object, or undefined when it was not an object. */
  readonly raw: Record<string, unknown> | undefined;
  /** The revision the envelope claims, when it claims a string. */
  readonly version: string | undefined;
  /** The client's declared capabilities, when it declared an object. */
  readonly clientCapabilities: Record<string, unknown> | undefined;
}

/**
 * Read the request envelope.
 *
 * 2026-07-28 requires both `io.modelcontextprotocol/protocolVersion` and
 * `io.modelcontextprotocol/clientCapabilities` here. Reading them without
 * deciding what their absence means keeps this module free of policy; the caller
 * decides, and the difference between "absent" and "unusable" survives.
 */
export function readEnvelope(params: Record<string, unknown> | undefined): EnvelopeContents {
  const raw = params?.[META_ENVELOPE];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { raw: undefined, version: undefined, clientCapabilities: undefined };
  }
  const envelope = raw as Record<string, unknown>;

  const version = envelope[META_PROTOCOL_VERSION];
  const capabilities = envelope[META_CLIENT_CAPABILITIES];

  return {
    raw: envelope,
    version: typeof version === "string" ? version : undefined,
    clientCapabilities:
      typeof capabilities === "object" && capabilities !== null && !Array.isArray(capabilities)
        ? (capabilities as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Attach the `_meta` an answer carries on 2026-07-28 and later.
 *
 * Server identity belongs in `result._meta` on that revision, not in the result
 * body, and a client on it looks for it there. It is written on every answer,
 * including the ones to a pre-envelope client: those ignore keys they do not
 * know, and a client that negotiates its way up to 2026-07-28 mid-session then
 * finds the field already there.
 *
 * A payload that carries its own `_meta` keeps it. This fills in what the server
 * knows about itself and never overwrites what a handler decided.
 */
export function withResultMeta(result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const payload = result as Record<string, unknown>;
  if (META_ENVELOPE in payload) return result;
  return {
    ...payload,
    [META_ENVELOPE]: {
      [META_SERVER_INFO]: { name: SERVER_NAME, version: SERVER_VERSION } satisfies Implementation,
    },
  };
}

/**
 * Narrow an untrusted JSON-RPC frame.
 *
 * `id` may legitimately be null, and a missing `id` means a notification.
 * Returning null rather than throwing lets the caller answer with a proper
 * error instead of crashing the loop.
 */
export function parseRequest(raw: unknown): JsonRpcRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;

  if (candidate.jsonrpc !== "2.0") return null;
  if (typeof candidate.method !== "string" || candidate.method === "") return null;

  const hasId = "id" in candidate;
  if (hasId) {
    const id = candidate.id;
    const valid = id === null || typeof id === "string" || typeof id === "number";
    if (!valid) return null;
  }

  if (candidate.params !== undefined) {
    if (typeof candidate.params !== "object" || candidate.params === null) return null;
  }

  return candidate as unknown as JsonRpcRequest;
}

/**
 * Whether a protocol version can be served.
 *
 * Unknown versions are rejected rather than assumed: silently speaking a
 * version the client did not ask for is how protocol bugs become invisible.
 */
export function canServe(version: string | undefined): version is ProtocolVersion {
  if (version === undefined) {
    // No version stated. Treat as a pre-stateless client rather than an error,
    // because a client that never sends one still needs tools/list.
    return true;
  }
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}
