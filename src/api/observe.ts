/**
 * API contract capture, bounded by the configuration.
 *
 * The bound is the whole point. Reading every response body would make capture
 * proportional to the traffic of whatever application the suite drives, which is
 * not this repository's traffic to predict — the demo app answers nine requests
 * across three pages and 7.6 KB, and that figure says nothing about a consumer's
 * product. So a body is read only when a declared expectation names its path, and
 * what is kept from it is **presence, never values**: the same "keep the
 * structure, drop the content" rule the accessibility audit settled, reached here
 * by a different road.
 *
 * What survives a body is a list of the declared paths that were *not* found. The
 * found ones are not recorded, because the declared list is in the configuration
 * and two copies of the same list are two things to drift.
 *
 * **A body that could not be read makes every declared path missing.** Not
 * "unknown": unknown would let an expectation pass on a response nobody could
 * check, which is the failure the owner's fail-closed decision exists to prevent.
 * `kind` records *why* it could not be read, so the failure can say "body was not
 * JSON" instead of implying a missing field.
 */
import type { Page, Request, Response } from "@playwright/test";
import { parseFieldPath, type FieldPathStep } from "../config/field-path.js";
import type { ApiExpectation, HttpMethod } from "../config/types.js";

/** Why a body could not be walked. `none` means it was walked and matched. */
/**
 * Why a body could not be walked.
 *
 * `too-late` is **measured, and only on chromium**. Probed 2026-10-17 against the
 * demo app on all three engines: every GET answered `response.body()` everywhere,
 * and the `POST /api/contact` answer was `json` on firefox and webkit — but
 * chromium **never answered at all** while the page stayed open, and only rejected
 * once the browser closed.
 *
 * So the dimension works on two engines of three, and the read is bounded rather
 * than awaited forever, because on chromium an unbounded read holds the fixture
 * teardown to its 30-second test timeout. A bound that expires is recorded as its
 * own kind: "the engine did not answer" is a different fact from "the field is
 * missing", and a consumer acting on the second would chase the wrong thing.
 */
export type BodyKind = "json" | "text" | "absent" | "too-large" | "too-late" | "pending";

/**
 * Ceiling on a body the capture will read.
 *
 * Matches the demo server's own limit so the two cannot disagree about what the
 * application is capable of sending. A larger response is not read at all, and
 * every declared path on it is reported missing rather than silently skipped.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** Matching exchanges kept per expectation. Bounded like signal capture. */
export const MAX_EXCHANGES_PER_EXPECTATION = 40;

/**
 * How long a body read may take before the exchange is recorded as unread.
 *
 * Measured against the real behaviour rather than chosen: reads that do answer
 * answer in single-digit milliseconds, and the one that never answers would
 * otherwise hold the fixture teardown to its 30-second test timeout. Two seconds
 * is far above the slowest observed and far below that timeout.
 */
export const MAX_BODY_READ_MS = 2000;

/** One observed exchange, holding no value from either body. */
export interface ApiExchangeObservation {
  /** Origin the exchange went to, recorded so a consumer can weigh attribution. */
  origin?: string | undefined;
  /** Status the response carried. Absent when no response came. */
  status?: number | undefined;
  /** Response media type, compared without parameters. */
  contentType?: string | undefined;
  requestKind: BodyKind;
  /** Declared request paths this body did not carry. */
  requestMissing: string[];
  responseKind: BodyKind;
  /** Declared response paths this body did not carry. */
  responseMissing: string[];
  /**
   * Whether a test declared it broke this exchange on purpose.
   *
   * The suite's own capture tests stub a declared endpoint to prove the audit
   * reports a breach, and without this flag those deliberate failures would be
   * counted against the project's real contracts. The same reason the third-party
   * suites sit behind an environment flag: a test that breaks a thing on purpose
   * must not then be evidence that the thing is broken.
   */
  stubbed: boolean;
}

/** What was seen for one declared expectation, across the test. */
export interface ApiExpectationObservation {
  name: string;
  method: HttpMethod;
  path: string;
  /** Matching exchanges, capped at {@link MAX_EXCHANGES_PER_EXPECTATION}. */
  exchanges: ApiExchangeObservation[];
  /** How many matched in total, including any dropped by the cap. */
  observed: number;
  dropped: number;
}

/** The attachment body: every declared expectation, matched or not. */
export interface ApiCapturePayload {
  schemaVersion: "1.0.0";
  baseUrl?: string;
  expectations: ApiExpectationObservation[];
}

/**
 * The media type of a `content-type` header, without its parameters.
 *
 * `application/json; charset=utf-8` and `application/json` are the same contract,
 * and the configuration names the media type precisely so no expectation has to
 * spell a charset the response chose for itself.
 */
export function mediaType(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const value = header.split(";")[0]?.trim();
  return value === undefined || value === "" ? undefined : value.toLowerCase();
}

/** Whether an exchange is the one an expectation declared. */
export function matchesExpectation(
  expectation: ApiExpectation,
  method: string,
  pathname: string,
): boolean {
  return expectation.method === method.toUpperCase() && expectation.path === pathname;
}

/** Walk a parsed body along the steps of a field path. */
export function walkFieldPath(value: unknown, steps: FieldPathStep[]): boolean {
  let current = value;
  for (const step of steps) {
    if (step.kind === "index") {
      if (!Array.isArray(current) || step.index >= current.length) {
        return false;
      }
      current = current[step.index];
      continue;
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return false;
    }
    if (!(step.key in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[step.key];
  }
  return true;
}

/**
 * Declared paths a body did not carry.
 *
 * A body that is not an object cannot carry any of them, so `undefined` — an
 * absent, unreadable or unparsable body — reports every path as missing. That is
 * the fail-closed half, and it lives here rather than in the contract so no later
 * layer has to remember to special-case it.
 */
export function missingFields(body: unknown, paths: string[] | undefined): string[] {
  if (paths === undefined || paths.length === 0) {
    return [];
  }
  return paths.filter((path) => !walkFieldPath(body, parseFieldPath(path)));
}

/** An empty observation for an expectation, before anything has matched it. */
export function emptyObservation(expectation: ApiExpectation): ApiExpectationObservation {
  return {
    name: expectation.name,
    method: expectation.method,
    path: expectation.path,
    exchanges: [],
    observed: 0,
    dropped: 0,
  };
}

/** A record of an exchange whose response has not been read yet. */
interface PendingExchange extends ApiExchangeObservation {
  /** Response fields, filled when the response arrives. */
  responseRead: boolean;
}

/**
 * Observe the exchanges a project declared, and nothing else.
 *
 * One instance per test, attached by the fixture. Every declared expectation
 * appears in the payload whether it matched or not: an expectation with no
 * matching exchange is the case the owner's fail-closed decision is about, and a
 * payload that omitted it would leave the contract with nothing to rule on.
 */
export class ApiObserver {
  readonly #page: Page;
  readonly #expectations: ApiExpectation[];
  /** How many exchanges matched each declared expectation, and how many were dropped. */
  readonly #counts = new Map<string, { observed: number; dropped: number }>();
  /** Expectations a request matched, so its response can be attributed back. */
  readonly #matched = new WeakMap<Request, string[]>();
  /** One record per matching exchange, each still waiting for its response. */
  readonly #records = new Map<string, PendingExchange[]>();
  /** Base URL of the project under test, recorded as an origin at most. */
  readonly #baseUrl?: string;
  /**
   * Body reads still in flight.
   *
   * `response.body()` resolves later than the page does, so a caller reading the
   * payload the moment the rendered page appeared could see a response whose body
   * had not been read yet — `responseKind` still `absent`. That was a real race,
   * caught by a full-suite run that the isolated run kept missing. Tracked here
   * so {@link toPayload} can wait rather than hope.
   */
  readonly #reading = new Set<Promise<void>>();
  /** Whether the current test declared its exchanges deliberate. */
  #stubbed = false;

  constructor(page: Page, expectations: ApiExpectation[], baseUrl?: string) {
    this.#page = page;
    this.#expectations = expectations;
    if (baseUrl !== undefined) {
      try {
        this.#baseUrl = new URL(baseUrl).origin;
      } catch {
        // A base URL the loader has already refused is recorded as absent rather
        // than guessed at; the loader owns that complaint, not the capture.
      }
    }
  }

  /**
   * Declare that every exchange from now on is broken on purpose.
   *
   * The test-suite counterpart of Playwright's `test.fail()`: a test that means to
   * break something says so, and the evidence it produces is kept for that test's
   * own assertions while the run's verdict ignores it.
   */
  markStubbed(): void {
    this.#stubbed = true;
  }

  /** Start observing. Safe to call once per page. */
  attach(): void {
    this.#page.on("request", (request) => this.#onRequest(request));
    this.#page.on("response", (response) => this.#onResponse(response));
  }

  #expectationFor(name: string): ApiExpectation {
    const expectation = this.#expectations.find((e) => e.name === name);
    // The loader guarantees every declared name; an unknown one here would be a
    // programming error, and inventing a record for it would hide that.
    if (expectation === undefined) {
      throw new Error(`no expectation is named ${JSON.stringify(name)}`);
    }
    return expectation;
  }

  #recordsFor(name: string): PendingExchange[] {
    const existing = this.#records.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created: PendingExchange[] = [];
    this.#records.set(name, created);
    this.#counts.set(name, { observed: 0, dropped: 0 });
    return created;
  }

  #onRequest(request: Request): void {
    let pathname: string;
    let origin: string | undefined;
    try {
      const url = new URL(request.url());
      pathname = url.pathname;
      origin = url.origin;
    } catch {
      return; // not a URL this project can reason about
    }

    const names = this.#expectations
      .filter((e) => matchesExpectation(e, request.method(), pathname))
      .map((e) => e.name);
    if (names.length === 0) {
      return;
    }

    const postData = request.postData();
    const body = postData === null ? undefined : safeJson(postData);

    for (const name of names) {
      const expectation = this.#expectationFor(name);
      this.#matched.set(request, [...(this.#matched.get(request) ?? []), name]);

      const counts = this.#counts.get(name) ?? { observed: 0, dropped: 0 };
      counts.observed += 1;
      const records = this.#recordsFor(name);
      if (records.length >= MAX_EXCHANGES_PER_EXPECTATION) {
        counts.dropped += 1;
        this.#counts.set(name, counts);
        continue;
      }
      this.#counts.set(name, counts);

      const record: PendingExchange = {
        origin,
        requestKind: postData === null ? "absent" : "json",
        requestMissing: missingFields(body, expectation?.requestRequires),
        responseKind: "absent",
        responseMissing: [],
        stubbed: this.#stubbed,
        responseRead: false,
      };
      records.push(record);
    }
  }

  #onResponse(response: Response): void {
    const names = this.#matched.get(response.request());
    if (names === undefined) {
      return; // a response to a request no expectation declared
    }

    for (const name of names) {
      const expectation = this.#expectationFor(name);
      const records = this.#recordsFor(name);
      const record = records.find((candidate) => !candidate.responseRead);
      if (record === undefined) {
        continue;
      }
      record.responseRead = true;
      record.status = response.status();
      record.contentType = mediaType(response.headers()["content-type"]);
      let handle: ReturnType<typeof setTimeout> | undefined;

      // Bounded, because Playwright answers `response.body()` for a GET and never
      // answers it for a POST — measured, not assumed. An unbounded read hangs the
      // fixture teardown to its 30-second timeout.
      //
      // The timer is *cleared*, never `unref`ed: an unrefed timer does not fire in
      // a Playwright worker, which is idle waiting on the driver, so the bound
      // would silently stop existing.
      const timer = new Promise<never>((_resolve, rejectBound) => {
        handle = setTimeout(
          () => rejectBound(new Error("body read exceeded the capture's wait")),
          MAX_BODY_READ_MS,
        );
      });
      const reading = Promise.race([response.body(), timer])
        .then((buffer) => {
          const announced = Number(response.headers()["content-length"]);
          if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
            record.responseKind = "too-large";
            record.responseMissing = [...(expectation?.responseRequires ?? [])];
            return;
          }
          const text = buffer.toString("utf8");
          const type = record.contentType ?? "";
          if (type.includes("json")) {
            record.responseKind = "json";
            record.responseMissing = missingFields(safeJson(text), expectation?.responseRequires);
          } else if (type.startsWith("text/")) {
            record.responseKind = "text";
            // A text body is a body that could not answer a field requirement.
            record.responseMissing = [...(expectation?.responseRequires ?? [])];
          } else {
            record.responseKind = "absent";
            record.responseMissing = [...(expectation?.responseRequires ?? [])];
          }
        })
        .catch(() => {
          // Either the read never answered inside the bound, or it failed outright.
          // Both leave the declared paths unchecked, and fail-closed says report
          // them as missing rather than pass an expectation nobody could verify.
          record.responseKind = "too-late";
          record.responseMissing = [...(expectation?.responseRequires ?? [])];
        })
        .finally(() => {
          clearTimeout(handle);
        });
      this.#reading.add(reading);
      void reading.then(() => this.#reading.delete(reading));
    }
  }

  /**
   * The attachment body.
   *
   * Waits for every body read still in flight. Reading without waiting is the
   * race described on `#reading`: a payload can say a response carried no readable
   * body when in fact the body had simply not been read yet, which is the one
   * sentence a consumer would be misled by.
   */
  async toPayload(): Promise<ApiCapturePayload> {
    // A request whose response never arrived is an **unfinished observation**, not a
    // contract breach. Found by CI: three tests fire `/api/items` on page load and
    // finish before its response lands, and reporting `status: no response` for each
    // made a green run read as three broken contracts. A request that failed
    // outright is a different fact, and `signals.requestFailures` already records
    // it — so this dimension does not duplicate that evidence here.
    for (const records of this.#records.values()) {
      for (const record of records) {
        if (!record.responseRead) {
          record.responseKind = "pending";
        }
      }
    }

    // One snapshot, not a loop. A loop that re-checks the set spins: the delete is
    // queued behind the await, so the set can still hold a settled promise on the
    // next turn. A loop over a set that removes its own entries is a busy-wait, and
    // it hung the fixture teardown past the 30-second test timeout.
    await Promise.allSettled([...this.#reading]);
    return {
      schemaVersion: "1.0.0",
      ...(this.#baseUrl === undefined ? {} : { baseUrl: this.#baseUrl }),
      // Declared order, not observation order: a consumer reads a configuration
      // and wants the audit in the same order, and two expectations may match the
      // same exchange and so be created out of order.
      expectations: this.#expectations.map((expectation) => {
        const counts = this.#counts.get(expectation.name) ?? { observed: 0, dropped: 0 };
        return {
          name: expectation.name,
          method: expectation.method,
          path: expectation.path,
          exchanges: this.#recordsFor(expectation.name).map(
            ({ responseRead: _read, ...rest }) => rest,
          ),
          observed: counts.observed,
          dropped: counts.dropped,
        };
      }),
    };
  }
}

/** Parse JSON without letting a malformed body become a captured error. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
