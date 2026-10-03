/**
 * Global setup: fail loudly, early, and with an actionable message.
 *
 * A missing or unreachable target otherwise surfaces as a pile of confusing
 * per-test timeouts. One clear error here is cheaper to diagnose.
 */
import type { FullConfig } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4311";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(BASE_URL);
  } catch {
    throw new Error(
      `BASE_URL is not a valid URL: ${JSON.stringify(BASE_URL)}. ` +
        `Set it to an absolute http(s) URL, or unset it to use the bundled fixture app.`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`BASE_URL must use http or https, got ${parsed.protocol}. Got: ${BASE_URL}`);
  }

  let response: Response;
  try {
    response = await fetch(parsed, { redirect: "follow" });
  } catch (error) {
    throw new Error(
      `Could not reach BASE_URL ${BASE_URL}: ${(error as Error).message}. ` +
        `Is the application running, or did you point BASE_URL at the wrong address?`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(
      `BASE_URL ${BASE_URL} answered ${response.status} ${response.statusText}. ` +
        `The target must be healthy before the suite starts.`,
    );
  }
}
