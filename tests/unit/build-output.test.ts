import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

/**
 * What a consumer gets, as opposed to what this repository runs.
 *
 * The suite executes `src/` through tsx, so nothing in it would notice if `src`
 * stopped compiling to something loadable. A consuming project never sees `src`
 * at all: it installs the package, and Playwright refuses to transpile
 * TypeScript under `node_modules`. The one import the whole signal-capture
 * story hangs on therefore has to arrive as compiled JavaScript, or it fails at
 * load time, on the consumer's machine, with a message that names this package.
 *
 * The assertions are on the emitted artifact, not on the source: `dist` is
 * deleted first, so a green here cannot be yesterday's output.
 *
 * The packlist check belongs here for the opposite reason: `dist` is gitignored,
 * which is precisely what npm leaves out of a package when there is no `files`
 * whitelist, and the first real consumer install arrived with no `dist` at all
 * while carrying our CI workflow instead. What none of this proves is that
 * `prepare` runs for someone installing over the network — that is checked by
 * installing the package the way a consumer does, from a clean directory,
 * which is `package-check.py`.
 *
 * The entry points and bin targets are in this list because `exports` and
 * `bin` name files inside `dist`, and a name in `package.json` is a promise,
 * not a presence: `npm pack` can succeed while omitting any one of them, and
 * the failure would only surface in a consumer, on import or on first run.
 */

const exec = promisify(execFile);
const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const FIXTURE = path.join(DIST, "fixtures", "quality-context.js");

/** Exit code, stdout and stderr of a command, without the throw `exec` uses for 1. */
interface CommandOutcome {
  code: number;
  out: string;
  error: string;
}

async function run(command: string, args: string[]): Promise<CommandOutcome> {
  try {
    const result = await exec(command, args, { cwd: ROOT, timeout: 120_000 });
    return { code: 0, out: result.stdout, error: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      out: failure.stdout ?? "",
      error: failure.stderr ?? "",
    };
  }
}

/**
 * Written before `beforeAll` fills it in, and the value it starts with is the
 * one a reader sees if the hook never ran: the build did not happen, which is
 * the failure, not a pass by default.
 */
const build: CommandOutcome = { code: 1, out: "", error: "the build never ran" };

/** What a consumer runs: the entry points, the bins, the compiled fixture, the sources `--help` may name. */
const MUST_SHIP = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/cli/collect-defects.js",
  "dist/mcp/index.js",
  "dist/fixtures/quality-context.js",
  "dist/fixtures/quality-context.d.ts",
  "src/cli/collect-defects.ts",
  "src/mcp/index.ts",
  "schemas/defect.v1.schema.json",
];

/**
 * This repository's own files. None of them is gitignored, so without a `files`
 * whitelist they are all packed — and `dist` is gitignored, so without that
 * same whitelist `dist` is the one thing that is not. That combination is what
 * the first real consumer install hit: no fixture, and our CI workflow instead.
 */
const MUST_STAY = [
  "config/project.json",
  "playwright.config.ts",
  "tests/unit/help-text.test.ts",
  "scripts/report-check.py",
  ".github/workflows/ci.yml",
];

test.describe("the built package", () => {
  test.beforeAll(async () => {
    rmSync(DIST, { recursive: true, force: true });
    const outcome = await run("npx", ["tsc", "-p", "tsconfig.build.json"]);
    build.code = outcome.code;
    build.error = outcome.error;
  });

  test("compiles src into dist", () => {
    expect(build.code, `the build must succeed; tsc exited ${build.code}:\n${build.error}`).toBe(0);
    expect(
      existsSync(FIXTURE),
      "the fixture a consumer imports must be emitted at dist/fixtures/",
    ).toBe(true);
    expect(
      existsSync(FIXTURE.replace(/\.js$/, ".d.ts")),
      "a TypeScript consumer resolves the types next to the JavaScript",
    ).toBe(true);
  });

  test("hands out a fixture Node can load and that keeps its contract", async () => {
    // Spawned rather than imported in-process: the module registers fixtures on
    // `@playwright/test`, and a load failure here would otherwise surface as a
    // broken test file instead of the load error itself.
    const script = [
      `const loaded = await import(${JSON.stringify(pathToFileURL(FIXTURE).href)});`,
      `if (typeof loaded.test !== "function") { console.error("test is " + typeof loaded.test); process.exit(3); }`,
      `if (typeof loaded.expect !== "function") { console.error("expect is " + typeof loaded.expect); process.exit(4); }`,
      `if (loaded.ATTACHMENT_NAME !== "quality-context") { console.error("attachment name is " + loaded.ATTACHMENT_NAME); process.exit(5); }`,
    ].join("\n");

    const loaded = await run("node", ["--input-type=module", "-e", script]);

    expect(
      loaded.code,
      `the built fixture must load in Node; exit ${loaded.code}: ${loaded.error}`,
    ).toBe(0);
    expect(loaded.error).toBe("");
  });

  test("packs what a consumer runs, and nothing that is ours alone", async () => {
    // `npm pack` runs `prepare` first, so this is the packing step a git
    // install performs — its own rules, not a re-implementation of them.
    const packed = await run("npm", ["pack", "--dry-run", "--json"]);
    expect(packed.code, `npm pack must succeed; exit ${packed.code}:\n${packed.error}`).toBe(0);

    let files: string[];
    try {
      const parsed = JSON.parse(packed.out) as Array<{ files: Array<{ path: string }> }>;
      files = parsed[0]?.files.map((entry) => entry.path) ?? [];
    } catch {
      files = [];
    }
    expect(files.length, `npm pack reported no files; it printed:\n${packed.out}`).toBeGreaterThan(
      0,
    );

    for (const required of MUST_SHIP) {
      expect(files, `${required} must reach the consumer or nothing they run works`).toContain(
        required,
      );
    }
    for (const ours of MUST_STAY) {
      expect(
        files,
        `${ours} is this repository's, not a consumer's — it needs a place in files`,
      ).not.toContain(ours);
    }
    expect(
      files.filter((file) => file.startsWith("quality-history/")),
      "run history belongs to a repository, never to the package",
    ).toEqual([]);
  });
});
