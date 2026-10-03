import { expect, test } from "@playwright/test";
import { MAX_ENTRIES_PER_CATEGORY, SignalCollector } from "../../src/quality/signals.js";
import {
  REDACTED,
  redactAssignments,
  redactHeaders,
  redactText,
  redactUrl,
  truncate,
} from "../../src/quality/redact.js";

test.describe("redactUrl", () => {
  test("keeps scheme, host and path", () => {
    expect(redactUrl("https://example.com/app/page?a=1#frag")).toBe("https://example.com/app/page");
  });

  test("drops the query string wholesale rather than filtering it", () => {
    // A filter only knows the names it was told about. Dropping everything
    // means an unlisted parameter cannot leak.
    const out = redactUrl("https://example.com/api?token=abc&unknown_secret_param=xyz");

    expect(out).toBe("https://example.com/api");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("unknown_secret_param");
  });

  test("removes credentials from the userinfo section", () => {
    expect(redactUrl("https://user:hunter2@example.com/x")).toBe("https://example.com/x");
  });

  test("preserves a non-default port", () => {
    expect(redactUrl("http://127.0.0.1:4311/contact")).toBe("http://127.0.0.1:4311/contact");
  });

  test("degrades safely on an unparseable URL", () => {
    const out = redactUrl("not a url?token=abc");

    expect(out).not.toContain("abc");
    expect(out).toContain(REDACTED);
  });
});

test.describe("redactText", () => {
  test("removes a token assignment", () => {
    const out = redactText("failed with token=eyJhbGciOiJIUzI1NiJ9.payload.sig");

    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain(REDACTED);
  });

  test("removes password and api_key assignments in any case", () => {
    expect(redactText("Password=hunter2")).toContain(REDACTED);
    expect(redactText("API_KEY: abcdef123456")).toContain(REDACTED);
    expect(redactText("api_key=abcdef123456")).not.toContain("abcdef123456");
  });

  test("removes an Authorization bearer token", () => {
    const out = redactText("Authorization: Bearer abcdef1234567890");

    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain("Bearer");
  });

  test("removes a bare JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const out = redactText(`token was ${jwt}`);

    expect(out).not.toContain("dBjftJeZ4CVPmB92K27uhbUJU1p1r");
  });

  test("redacts URLs embedded in free text", () => {
    const out = redactText("request to https://example.com/callback?code=secret123 failed");

    expect(out).not.toContain("secret123");
    expect(out).toContain("https://example.com/callback");
  });

  test("leaves ordinary text alone", () => {
    const message = "expect(locator).toHaveText(expected) failed";

    expect(redactText(message)).toBe(message);
  });

  test("keeps the useful part of a redacted assignment", () => {
    // Redaction must not destroy the diagnostic value.
    expect(redactText("api_key=abc123 rejected")).toContain("rejected");
  });
});

test.describe("redactAssignments", () => {
  test("does not eat the surrounding punctuation", () => {
    const out = redactAssignments("a=1, password=hunter2; b=2");

    expect(out).toContain("a=1");
    expect(out).toContain("b=2");
    expect(out).not.toContain("hunter2");
  });
});

test.describe("redactHeaders", () => {
  test("masks sensitive header values but keeps the names", () => {
    const out = redactHeaders({
      authorization: "Bearer secret-token-value",
      cookie: "session=abc",
      "content-type": "application/json",
    });

    // The name is the signal; the value is never needed for triage.
    expect(out.authorization).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out["content-type"]).toBe("application/json");
  });

  test("returns keys in a stable order", () => {
    const a = redactHeaders({ b: "1", a: "2" });
    const b = redactHeaders({ a: "2", b: "1" });

    expect(Object.keys(a)).toEqual(Object.keys(b));
  });
});

test.describe("truncate", () => {
  test("marks that something was cut", () => {
    const out = truncate("x".repeat(50), 10);

    expect(out).toContain("[truncated 40 characters]");
    expect(out.length).toBeLessThan(80);
  });

  test("leaves short values untouched", () => {
    expect(truncate("short", 10)).toBe("short");
  });
});

test.describe("SignalCollector", () => {
  /** Minimal Page stand-in: the collector only needs these three events. */
  function fakePage() {
    const handlers = new Map<string, (arg: unknown) => void>();
    return {
      on(event: string, handler: (arg: unknown) => void) {
        handlers.set(event, handler);
      },
      emit(event: string, arg: unknown) {
        handlers.get(event)?.(arg);
      },
    };
  }

  function consoleMessage(type: string, text: string, url = "") {
    return {
      type: () => type,
      text: () => text,
      location: () => ({ url, lineNumber: 3, columnNumber: 7 }),
    };
  }

  test("reports no content when nothing happened", () => {
    const collector = new SignalCollector(fakePage() as never);

    expect(collector.hasContent()).toBe(false);
  });

  test("captures console errors and ignores ordinary logs", () => {
    const page = fakePage();
    const collector = new SignalCollector(page as never);

    page.emit("console", consoleMessage("error", "boom"));
    page.emit("console", consoleMessage("log", "just a log"));
    page.emit("console", consoleMessage("warning", "careful"));

    const { signals } = collector.toPayload();
    expect(signals.consoleErrors).toHaveLength(1);
    expect(signals.consoleWarnings).toHaveLength(1);
    expect(collector.hasContent()).toBe(true);
  });

  test("captures uncaught page errors", () => {
    const page = fakePage();
    const collector = new SignalCollector(page as never);

    page.emit("pageerror", new Error("TypeError: x is not a function"));

    expect(collector.toPayload().signals.pageErrors).toHaveLength(1);
  });

  test("captures failed requests with a redacted URL", () => {
    const page = fakePage();
    const collector = new SignalCollector(page as never);

    page.emit("requestfailed", {
      method: () => "GET",
      url: () => "https://api.example.com/v1/items?token=secret123",
      resourceType: () => "fetch",
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
    });

    const [entry] = collector.toPayload().signals.requestFailures;
    expect(entry?.method).toBe("GET");
    expect(entry?.url).toBe("https://api.example.com/v1/items");
    expect(entry?.url).not.toContain("secret123");
  });

  test("captures responses at or above 400 and ignores the rest", () => {
    const page = fakePage();
    const collector = new SignalCollector(page as never);

    const response = (status: number) => ({
      status: () => status,
      statusText: () => (status === 500 ? "Internal Server Error" : "Not Found"),
      url: () => `https://api.example.com/v1/items/${status}`,
      request: () => ({ method: () => "GET" }),
    });

    page.emit("response", response(500));
    page.emit("response", response(404));
    page.emit("response", response(200));

    const { httpErrors } = collector.toPayload().signals;
    expect(httpErrors).toHaveLength(2);
    expect(httpErrors.map((e) => e.status)).toEqual([500, 404]);
  });

  test("caps each category and records how many were dropped", () => {
    const page = fakePage();
    const collector = new SignalCollector(page as never);

    for (let i = 0; i < MAX_ENTRIES_PER_CATEGORY + 5; i += 1) {
      page.emit("console", consoleMessage("error", `boom ${i}`));
    }

    const payload = collector.toPayload();
    expect(payload.signals.consoleErrors).toHaveLength(MAX_ENTRIES_PER_CATEGORY);
    // A truncated capture must never look complete.
    expect(payload.dropped).toBe(5);
  });
});
