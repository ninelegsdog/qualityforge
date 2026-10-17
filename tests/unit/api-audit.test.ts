import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildApiAudit } from "../../src/api/audit.js";
import type { ApiCapturePayload } from "../../src/api/observe.js";
import { API_AUDIT_SCHEMA_VERSION, validateApiAudit } from "../../src/api/types.js";
import type { ApiExpectation } from "../../src/config/types.js";

/**
 * The producer, judged against the contract it has to satisfy.
 *
 * Every test here builds the audit from **captured payloads shaped like the
 * fixture's**, not from an artifact written by hand. A test that asserted against
 * its own output would agree with the producer by construction and prove nothing;
 * feeding it observations is the only way to ask whether the producer reads what
 * the capture actually emits.
 *
 * The fail-closed cases carry the file. Three of them are the whole reason the
 * audit exists:
 *
 * - an expectation nothing matched,
 * - a response whose status differs,
 * - a body that could not carry the declared field.
 *
 * And one is the limit nobody asked for: an expectation where the capture's cap
 * dropped exchanges has **not** been proved, which is what `exchanges-dropped`
 * says.
 */
const ITEMS: ApiExpectation = {
  name: "items-are-json",
  method: "GET",
  path: "/api/items",
  status: 200,
  contentType: "application/json",
  responseRequires: ["[0].id", "[0].name"],
};

const CONTACT: ApiExpectation = {
  name: "contact-is-posted-and-accepted",
  method: "POST",
  path: "/api/contact",
  requestRequires: ["email", "message"],
  status: 200,
  contentType: "application/json",
  responseRequires: ["received"],
};

const AT = { baseUrl: "http://127.0.0.1:4311", createdAt: "2026-10-17T09:00:00.000Z" };

/** One test's capture, with the named expectation behaving as asked. */
function payload(overrides: {
  exchanges?: ApiCapturePayload["expectations"][number]["exchanges"];
  observed?: number;
  dropped?: number;
}): ApiCapturePayload {
  return {
    schemaVersion: "1.0.0",
    baseUrl: "http://127.0.0.1:4311",
    expectations: [
      {
        name: ITEMS.name,
        method: "GET",
        path: "/api/items",
        observed: overrides.observed ?? 1,
        dropped: overrides.dropped ?? 0,
        exchanges: overrides.exchanges ?? [
          {
            origin: "http://127.0.0.1:4311",
            status: 200,
            contentType: "application/json",
            requestKind: "absent",
            requestMissing: [],
            responseKind: "json",
            responseMissing: [],
          },
        ],
      },
    ],
  };
}

/** A capture in which the named expectation never matched. */
function silentPayload(): ApiCapturePayload {
  return {
    schemaVersion: "1.0.0",
    baseUrl: "http://127.0.0.1:4311",
    expectations: [
      {
        name: ITEMS.name,
        method: "GET",
        path: "/api/items",
        observed: 0,
        dropped: 0,
        exchanges: [],
      },
    ],
  };
}

function build(declared: ApiExpectation[], payloads: ApiCapturePayload[]) {
  return buildApiAudit({ declared, payloads, ...AT });
}

test.describe("a contract that holds", () => {
  test("reports no violation, and passes its own validation", () => {
    const audit = build([ITEMS], [payload({})]);

    expect(audit.counts.violations).toBe(0);
    expect(audit.counts.passed).toBe(1);
    expect(audit.expectations[0]?.observed.exchanges).toBe(1);
    expect(validateApiAudit(audit).valid).toBe(true);
  });

  test("carries the declared assertions, so the artifact stands alone", () => {
    const audit = build([ITEMS], [payload({})]);

    expect(audit.expectations[0]?.declared).toEqual({
      status: 200,
      contentType: "application/json",
      responseRequires: ["[0].id", "[0].name"],
    });
  });

  test("sums across every test that ran", () => {
    const audit = build([ITEMS], [payload({}), payload({}), payload({})]);

    expect(audit.expectations[0]?.observed).toEqual({ exchanges: 3, dropped: 0, tests: 3 });
    expect(audit.counts.tests).toBe(3);
  });
});

test.describe("fail-closed", () => {
  test("an expectation nothing matched is a violation, not an absence", () => {
    const audit = build([ITEMS], [silentPayload(), silentPayload()]);
    const violations = audit.expectations[0]?.violations ?? [];

    expect(audit.counts.violations).toBe(1);
    expect(violations[0]?.kind).toBe("no-exchange");
    // The finding names the endpoint, because a finding that does not is a
    // finding nobody can act on.
    expect(violations[0]?.observed).toContain("GET /api/items");
    expect(violations[0]?.observed).toContain("2 test(s)");
    expect(violations[0]?.exchanges).toBe(0);
  });

  test("no capture at all still lists every declared expectation", () => {
    const audit = build([ITEMS, CONTACT], []);

    expect(audit.expectations.map((entry) => entry.name)).toEqual([ITEMS.name, CONTACT.name]);
    expect(audit.counts.violations).toBe(2);
    expect(audit.counts.passed).toBe(0);
  });

  test("a wrong status is a violation naming what was expected and seen", () => {
    const audit = build(
      [ITEMS],
      [
        payload({
          exchanges: [
            {
              origin: "http://127.0.0.1:4311",
              status: 500,
              contentType: "application/json",
              requestKind: "absent",
              requestMissing: [],
              responseKind: "json",
              responseMissing: [],
            },
          ],
        }),
      ],
    );
    const violation = audit.expectations[0]?.violations[0];

    expect(violation?.kind).toBe("status");
    expect(violation?.expected).toBe("200");
    expect(violation?.observed).toBe("status 500");
  });

  test("a body that could not carry the field says why", () => {
    const audit = build(
      [ITEMS],
      [
        payload({
          exchanges: [
            {
              origin: "http://127.0.0.1:4311",
              status: 200,
              contentType: "text/plain",
              requestKind: "absent",
              requestMissing: [],
              responseKind: "text",
              responseMissing: ["[0].id", "[0].name"],
            },
          ],
        }),
      ],
    );
    const violations = audit.expectations[0]?.violations ?? [];

    // Two findings, not one: the content type and each missing field, because a
    // reader fixing this needs to know it was the body, not the field.
    expect(violations.map((violation) => violation.kind).sort()).toEqual([
      "content-type",
      "missing-response-field",
      "missing-response-field",
    ]);
    const field = violations.find((violation) => violation.kind === "missing-response-field");
    expect(field?.expected).toBe("[0].id");
    expect(field?.observed).toBe("not carried by a text body");
  });

  test("exchanges the capture's cap dropped are a violation of their own", () => {
    const audit = build([ITEMS], [payload({ observed: 40, dropped: 10 })]);
    const violation = audit.expectations[0]?.violations[0];

    expect(violation?.kind).toBe("exchanges-dropped");
    expect(violation?.observed).toContain("10");
    expect(audit.expectations[0]?.observed.dropped).toBe(10);
  });

  test("the same failure seen twice is one finding about both", () => {
    const audit = build(
      [ITEMS],
      [
        payload({
          exchanges: [
            {
              origin: "http://127.0.0.1:4311",
              status: 500,
              contentType: "application/json",
              requestKind: "absent",
              requestMissing: [],
              responseKind: "json",
              responseMissing: [],
            },
            {
              origin: "http://127.0.0.1:4311",
              status: 503,
              contentType: "application/json",
              requestKind: "absent",
              requestMissing: [],
              responseKind: "json",
              responseMissing: [],
            },
          ],
        }),
      ],
    );
    const violations = audit.expectations[0]?.violations ?? [];

    expect(violations).toHaveLength(1);
    expect(violations[0]?.exchanges).toBe(2);
    // Both statuses are named: one finding, and the reader still sees the range.
    expect(violations[0]?.observed).toBe("status 500; status 503");
  });

  test("one test showing a failure is counted once, not once per exchange", () => {
    const audit = build(
      [ITEMS],
      [
        payload({
          exchanges: [
            {
              origin: "http://127.0.0.1:4311",
              status: 500,
              contentType: "application/json",
              requestKind: "absent",
              requestMissing: [],
              responseKind: "json",
              responseMissing: [],
            },
            {
              origin: "http://127.0.0.1:4311",
              status: 500,
              contentType: "application/json",
              requestKind: "absent",
              requestMissing: [],
              responseKind: "json",
              responseMissing: [],
            },
          ],
        }),
      ],
    );

    expect(audit.expectations[0]?.violations[0]?.exchanges).toBe(2);
    expect(audit.expectations[0]?.violations[0]?.tests).toBe(1);
  });

  test("the order is the declared order, so the audit reads beside the config", () => {
    const audit = build([CONTACT, ITEMS], [payload({})]);

    expect(audit.expectations.map((entry) => entry.name)).toEqual([CONTACT.name, ITEMS.name]);
  });
});

test.describe("the two invariants JSON Schema cannot hold", () => {
  test("counts.violations must equal the number listed", () => {
    const audit = build([ITEMS], [silentPayload()]);
    const broken = { ...audit, counts: { ...audit.counts, violations: 7 } };

    const result = validateApiAudit(broken);
    expect(result.valid).toBe(false);
    expect(result.problems.join("; ")).toContain("counts.violations says 7 but 1 violation(s)");
  });

  test("counts.expectations must equal the number listed", () => {
    const audit = build([ITEMS], [payload({})]);
    const broken = { ...audit, counts: { ...audit.counts, expectations: 3 } };

    expect(validateApiAudit(broken).problems.join("; ")).toContain("counts.expectations says 3");
  });

  test("expectation names are unique", () => {
    const audit = build([ITEMS, ITEMS], [payload({})]);
    const result = validateApiAudit(audit);

    expect(result.valid).toBe(false);
    expect(result.problems.join("; ")).toContain("already used earlier");
  });
});

test.describe("the contract rejects what the producer should never write", () => {
  test("a violation kind nobody declared", () => {
    const audit = build([ITEMS], [payload({})]);
    const broken = {
      ...audit,
      expectations: [
        {
          ...audit.expectations[0],
          violations: [{ ...audit.expectations[0]!.violations[0], kind: "vibes" }],
        },
      ],
    };

    expect(validateApiAudit(broken).problems.join("; ")).toContain("kind must be one of");
  });

  test("a baseUrl carrying a query string, which is where a token would ride", () => {
    const audit = build([ITEMS], [payload({})]);
    const result = validateApiAudit({
      ...audit,
      baseUrl: "http://127.0.0.1:4311?token=abc",
    });

    // The producer reduces the configured value to an origin; this asserts the
    // artifact cannot carry one even if a producer change slipped past it.
    expect(result.valid).toBe(false);
    expect(result.problems.join("; ")).toContain("origin");
  });
});

test("the schema file is readable JSON", async () => {
  const raw = await readFile(
    path.join(process.cwd(), "schemas", "api-audit.v1.schema.json"),
    "utf8",
  );
  const schema = JSON.parse(raw) as Record<string, unknown>;

  expect(schema.title).toBe("api-audit.v1");
  expect(Object.keys(schema.properties as object).sort()).toContain("expectations");
});

test("the runtime validator accepts what the producer writes", () => {
  for (const payloads of [
    [payload({})],
    [silentPayload()],
    [payload({ observed: 40, dropped: 10 })],
    [],
  ]) {
    const audit = build([ITEMS], payloads);
    const result = validateApiAudit(audit);
    expect(result.problems, JSON.stringify(audit.counts)).toEqual([]);
    expect(API_AUDIT_SCHEMA_VERSION).toBe("1.0.0");
  }
});
