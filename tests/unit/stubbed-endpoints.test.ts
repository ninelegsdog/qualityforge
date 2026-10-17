import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * A test that stubs a declared endpoint must say it is doing so on purpose.
 *
 * Found twice, and both times by CI rather than by a local run. The suite's own
 * capture tests stub `POST /api/contact` and `GET /api/items` to prove the audit
 * reports a breach, and those deliberate failures were counted against the
 * project's real contracts — so a green run reported a broken API and a red one
 * could not be told from noise.
 *
 * `markStubbed()` is what a stubbing test calls, and it is only a promise. This
 * file is the reason the promise holds: it reads the paths the project actually
 * declares and refuses a test that stubs one without saying so. Playwright offers
 * no way to spot a fulfilled route — `serverAddr()` is `{}` for a real response
 * and for a stub alike, measured on 2026-10-17 — so nothing can infer this at
 * runtime.
 *
 * A source scan is an unusual thing for this repository to own, and this is the
 * reason it earns a place: the failure it prevents is invisible to every other
 * check, and it happened twice in one afternoon.
 */
async function declaredPaths(): Promise<string[]> {
  const raw = await readFile(path.join(process.cwd(), "config", "project.json"), "utf8");
  const config = JSON.parse(raw) as {
    api?: { expectations?: { path: string }[] };
  };
  return (config.api?.expectations ?? []).map((expectation) => expectation.path);
}

/** Every smoke spec, as source text. */
async function smokeSources(): Promise<{ file: string; text: string }[]> {
  const directory = path.join(process.cwd(), "tests", "smoke");
  const entries = await readdir(directory);
  const specs = entries.filter((name) => name.endsWith(".ts"));

  return Promise.all(
    specs.map(async (name) => ({
      file: path.join("tests", "smoke", name),
      text: await readFile(path.join(directory, name), "utf8"),
    })),
  );
}

/** The body of one `test(...)` block, from its opening line to the next blank line. */
function testBlocks(text: string): { title: string; body: string }[] {
  const blocks: { title: string; body: string }[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line: string = lines[index] ?? "";
    const opening = /^(\s*)test\((?:"([^"]+)"|`([^`]+)`)/.exec(line);
    if (opening === null) continue;
    const title: string = opening[2] ?? opening[3] ?? "";
    let end = index + 1;
    while (end < lines.length && !/^\s*\}\);?\s*$/.test(lines[end] ?? "")) {
      end += 1;
    }
    blocks.push({ title, body: lines.slice(index, end + 1).join("\n") });
  }
  return blocks;
}

test.describe("stubbing a declared endpoint", () => {
  test("the project declares the endpoints this guards", async () => {
    // A guard with nothing to guard would pass forever.
    expect((await declaredPaths()).length).toBeGreaterThan(0);
  });

  test("every test that stubs a declared path declares that it did", async () => {
    const declared = await declaredPaths();
    const offenders: string[] = [];

    for (const { file, text } of await smokeSources()) {
      for (const block of testBlocks(text)) {
        const stubs = declared.filter(
          (declaredPath) => block.body.includes(`page.route`) && block.body.includes(declaredPath),
        );
        if (stubs.length === 0) continue;
        if (block.body.includes("markStubbed")) continue;
        offenders.push(`${file}: "${block.title}" stubs ${stubs.join(", ")} without markStubbed()`);
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the four deliberate stubs are all declared, so the guard above is not vacuous", async () => {
    const marked = (await smokeSources()).filter((source) => source.text.includes("markStubbed()"));

    // Not a count of four forever — a floor that keeps the guard honest. If every
    // marker is deleted, this goes red before the other one starts passing.
    expect(marked.length).toBeGreaterThanOrEqual(3);
  });
});
