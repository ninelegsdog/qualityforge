/**
 * The producer: declared expectations plus captured observations into an audit.
 *
 * The rule this file exists to apply is the owner's fail-closed decision: an
 * expectation nothing matched is a **violation**, not an absence. The tempting
 * alternative — leave a zero-observation expectation clean, so the artifact only
 * lists what it saw — is exactly what would let an application quietly stop
 * calling its own endpoint while every test stayed green.
 *
 * Violations are deduplicated per expectation, one entry per distinct way the
 * contract did not hold. Fifty exchanges with the wrong status are one finding
 * about fifty exchanges, and an artifact a model reads should not spend fifty
 * lines saying the same thing twice.
 *
 * What is *not* stored: the exchanges. An audit that kept every successful
 * exchange would be evidence about nothing and would crowd out the findings in
 * whatever context reads it.
 */
import type { ApiCapturePayload } from "./observe.js";
import type { ApiExpectation } from "../config/types.js";
import { mediaType } from "./observe.js";
import type {
  ApiAudit,
  ApiDeclaredExpectation,
  ApiExpectationResult,
  ApiViolation,
  ApiViolationKind,
} from "./types.js";
import { API_AUDIT_SCHEMA_VERSION } from "./types.js";

export interface BuildAuditOptions {
  /** Declared contracts, from `config/project.json`. */
  declared: ApiExpectation[];
  /** One capture payload per test that ran. */
  payloads: ApiCapturePayload[];
  /** Origin under test, reduced to an origin. Omitted when none is known. */
  baseUrl?: string;
  /** ISO timestamp; supplied so a caller can freeze it in a test. */
  createdAt: string;
}

/** Accumulates one violation kind per expectation, counting where it was seen. */
interface Bucket {
  kind: ApiViolationKind;
  expected: string;
  /** Distinct reasons or values collected across every exchange that showed it. */
  seen: Set<string>;
  /** Matching exchanges that showed it. */
  exchanges: number;
  /** Indices of the tests that showed it, so one test is counted once. */
  tests: Set<number>;
}

function declaredPart(expectation: ApiExpectation): ApiDeclaredExpectation {
  return {
    ...(expectation.status === undefined ? {} : { status: expectation.status }),
    ...(expectation.contentType === undefined ? {} : { contentType: expectation.contentType }),
    ...(expectation.requestRequires === undefined
      ? {}
      : { requestRequires: expectation.requestRequires }),
    ...(expectation.responseRequires === undefined
      ? {}
      : { responseRequires: expectation.responseRequires }),
  };
}

/**
 * The reasons a body could not carry a declared field, as a reader would hear
 * them. `absent from a json body` and `not carried by a text body` are different
 * findings even though both are failures, and collapsing them would lose the
 * only clue about why.
 */
function bodyReason(kind: string | undefined): string {
  switch (kind) {
    case undefined:
      return "absent from a body that was never read";
    case "json":
      return "absent from a json body";
    case "text":
      return "not carried by a text body";
    case "too-large":
      return "not read: the body was over the capture's ceiling";
    case "absent":
      return "not carried: the exchange carried no readable body";
    default:
      return `not carried by a body of kind ${JSON.stringify(kind)}`;
  }
}

/**
 * Build the audit.
 *
 * Returns the artifact and nothing else: every problem here is a fact about the
 * run, and facts belong in the artifact rather than in a code that refuses to
 * speak. A caller that cannot read the report's attachments gets a smaller audit
 * listing every expectation as unobserved, which is the honest reading.
 */
export function buildApiAudit(options: BuildAuditOptions): ApiAudit {
  const { declared, payloads, baseUrl, createdAt } = options;

  const ran = payloads.length > 0;
  const expectations: ApiExpectationResult[] = declared.map((expectation) => {
    // One bucket per distinct way the contract did not hold: fifty exchanges with
    // the wrong status are one finding about fifty exchanges.
    const buckets = new Map<string, Bucket>();
    const reasons = new Map<string, Set<string>>();
    let exchanges = 0;
    let dropped = 0;
    let tests = 0;

    /** Record one exchange showing a violation, keyed on kind and expectation. */
    const note = (kind: ApiViolationKind, expected: string, at: number): Bucket => {
      const key = `${kind}|${expected}`;
      const bucket = buckets.get(key) ?? {
        kind,
        expected,
        seen: new Set<string>(),
        exchanges: 0,
        tests: new Set<number>(),
      };
      bucket.exchanges += 1;
      bucket.tests.add(at);
      buckets.set(key, bucket);
      return bucket;
    };

    payloads.forEach((payload, at) => {
      const entry = payload.expectations?.find((candidate) => candidate.name === expectation.name);
      if (entry === undefined) {
        return;
      }
      tests += 1;
      exchanges += entry.observed ?? 0;
      dropped += entry.dropped ?? 0;

      for (const exchange of entry.exchanges ?? []) {
        if (expectation.status !== undefined && exchange.status !== expectation.status) {
          const seen =
            exchange.status === undefined ? "status: no response" : `status ${exchange.status}`;
          note("status", String(expectation.status), at).seen.add(seen);
        }

        if (expectation.contentType !== undefined) {
          const actual = mediaType(exchange.contentType);
          if (actual !== expectation.contentType) {
            const seen = actual === undefined ? "content type: none" : `content type ${actual}`;
            note("content-type", expectation.contentType, at).seen.add(seen);
          }
        }

        for (const field of exchange.requestMissing ?? []) {
          const seen = bodyReason(exchange.requestKind);
          note("missing-request-field", field, at).seen.add(seen);
          const set = reasons.get(`request|${field}`) ?? new Set<string>();
          set.add(seen);
          reasons.set(`request|${field}`, set);
        }

        for (const field of exchange.responseMissing ?? []) {
          const seen = bodyReason(exchange.responseKind);
          note("missing-response-field", field, at).seen.add(seen);
          const set = reasons.get(`response|${field}`) ?? new Set<string>();
          set.add(seen);
          reasons.set(`response|${field}`, set);
        }
      }
    });

    // Fail-closed, the owner's decision of 2026-10-16: an expectation nothing
    // matched is a violation. Listing only what was seen would let an application
    // stop calling its own endpoint while every test stayed green.
    if (exchanges === 0 && ran) {
      buckets.set("no-exchange|none", {
        kind: "no-exchange",
        expected: "at least one exchange",
        // The endpoint belongs in the finding: a reader who sees only this line
        // has to know which contract went unsatisfied.
        seen: new Set([
          `no exchange matched ${expectation.method} ${expectation.path} across ${tests} test(s)`,
        ]),
        exchanges: 0,
        tests: new Set(payloads.map((_, at) => at)),
      });
    }

    // A capture that kept 40 of 50 exchanges has not proved the other 10, and a
    // verdict that ignored that would be a claim about traffic nobody looked at.
    if (dropped > 0) {
      buckets.set("exchanges-dropped|every exchange examined", {
        kind: "exchanges-dropped",
        expected: `every exchange examined`,
        seen: new Set([`${dropped} exchange(s) matched but were not kept`]),
        exchanges: dropped,
        tests: new Set(payloads.map((_, at) => at)),
      });
    }

    const violations: ApiViolation[] = [...buckets.values()].map((bucket) => ({
      kind: bucket.kind,
      expected: bucket.expected,
      observed: [...bucket.seen].sort().join("; "),
      exchanges: bucket.exchanges,
      tests: bucket.tests.size,
    }));

    return {
      name: expectation.name,
      method: expectation.method,
      path: expectation.path,
      declared: declaredPart(expectation),
      observed: { exchanges, dropped, tests },
      violations,
    };
  });

  // **No capture at all means the dimension never ran**, which is not the same as
  // the contracts having held and is not the same as them having broken. Found by
  // CI: the unit job runs pure logic tests that never import the fixture, so
  // nothing was ever going to produce an exchange, and fail-closed duly reported
  // two violations for a run that had made no claim at all.
  //
  // So a run with no capture produces no violations and `tests: 0`, and the
  // collector says `NOT RUN` rather than `PASSED`. Fail-closed still holds wherever
  // the fixture *did* run: once a single capture exists, an expectation nothing
  // matched is a violation.
  const violations = expectations.reduce(
    (total, entry) => total + (ran ? entry.violations.length : 0),
    0,
  );

  return {
    schemaVersion: API_AUDIT_SCHEMA_VERSION,
    createdAt,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    counts: {
      expectations: expectations.length,
      tests: payloads.length,
      violations,
      // Not "passed": a run that never exercised the dimension has not passed it.
      passed: ran ? expectations.filter((entry) => entry.violations.length === 0).length : 0,
    },
    expectations,
  };
}
