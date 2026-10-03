/**
 * Redaction for captured signals.
 *
 * Captured console text and request URLs are attacker-adjacent data: an
 * application under test will happily print a token into a console warning, and
 * a failing request will happily carry one in its query string. Since these
 * values end up in a committed artifact, they are redacted at the source
 * rather than trusted.
 */

/** Query and body parameter names whose values must never be recorded. */
const SENSITIVE_KEYS = [
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "code",
  "cookie",
  "credential",
  "csrf",
  "id_token",
  "key",
  "password",
  "passwd",
  "private_token",
  "pwd",
  "refresh_token",
  "secret",
  "session",
  "set-cookie",
  "sig",
  "signature",
  "token",
  "x-api-key",
] as const;

export const REDACTED = "[redacted]";

/**
 * Longest console or error text kept per entry.
 *
 * Bounded on purpose. An artifact is read by a language model, and a single
 * multi-kilobyte stack dump can crowd out everything else in the context
 * window. Truncation is visible, which is honest; silently dropping entries
 * would not be.
 */
export const MAX_TEXT_LENGTH = 2_000;

/** Truncate on a character budget, marking that something was cut. */
export function truncate(value: string, limit = MAX_TEXT_LENGTH): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} characters]`;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((candidate) => lower === candidate || lower.includes(candidate));
}

/**
 * Reduce a URL to what is safe to record: scheme, host, port and path.
 *
 * The query string is dropped wholesale rather than filtered, because a filter
 * can only know the names it was told about. A fragment never leaves the
 * browser, so it is not recorded either. Credentials in the userinfo section
 * are removed because a basic-auth URL is a real pattern in test suites.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    // A non-special scheme (data:, blob:) has no meaningful host to keep.
    return url.host === "" ? `${url.protocol}//` : url.toString();
  } catch {
    // Not a parseable absolute URL. Keep the shape but drop anything after a
    // question mark, which is where parameters live.
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : `${raw.slice(0, cut)}${REDACTED}`;
  }
}

/**
 * Replace `key=value` and `key: value` pairs for sensitive keys.
 *
 * Order matters. The auth-header rules run first, because otherwise the generic
 * assignment pattern matches `Authorization: Bearer` and consumes the word
 * "Bearer" as the value, leaving the actual token exposed.
 */
export function redactAssignments(value: string): string {
  return (
    value
      // Authorization headers: Bearer <token> or Basic <blob>
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`)
      // Bare JWTs, which have three dot-separated base64url segments.
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
      .replace(
        // Negative lookahead for an already-redacted value and for an auth scheme
        // word. Without it, "Authorization: Bearer [redacted]" would be rewritten
        // again to "Authorization: [redacted] [redacted]", losing the scheme —
        // which is exactly the part worth keeping for diagnosis.
        /(\b(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|credential|cookie)[A-Za-z0-9_-]*)\b\s*[=:]\s*)("?)(?!\[redacted\]|Bearer\b|Basic\b)([^\s"',;&)]+)\2/gi,
        (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
      )
  );
}

/**
 * Redact one free-text value: sensitive assignments, auth headers, bare JWTs,
 * any URLs it mentions, then truncate.
 */
export function redactText(value: string, limit = MAX_TEXT_LENGTH): string {
  return truncate(
    redactAssignments(value).replace(/https?:\/\/[^\s'"<>)\]]+/gi, (match) => redactUrl(match)),
    limit,
  );
}

/**
 * Redact a headers object, keeping only the names.
 *
 * Header values are the single most common place a secret appears in a
 * network log, and none of them are needed to diagnose a browser test. The
 * presence of `authorization` is itself the useful signal.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(headers).sort()) {
    out[name] = isSensitiveKey(name) ? REDACTED : truncate(headers[name] ?? "", 200);
  }
  return out;
}
