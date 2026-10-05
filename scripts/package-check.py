#!/usr/bin/env python3
"""Install the package the way a consumer does, and run what it promises.

Why this exists: `exports` and `bin` are promises written into `package.json`,
and nothing in this repository reads them. The suite runs `src/` through tsx,
the packlist test only lists file names, and both stay green if the exports map
points at a file `tsc` never emits, if `bin` names a script without a shebang,
or if the executable bit is missing — because none of those ever reaches a
consumer's shell. Every failure of that kind surfaces for the first time in the
one place this repository does not run.

So a real tarball is packed (`npm pack`, which runs `prepare`, which is the
same build a git install performs), installed into a throwaway project outside
this checkout, and exercised there: the entry point imported, the fixture
subpath resolved, both binaries executed by hand and through `npx`, and the MCP
server started the way a client starts it — from the consumer's working
directory, with no `npx` in the spawn.

Two controls keep it honest, because a check that cannot fail is not one:

  - The same tarball, re-wrapped with `exports` stripped, must **not** refuse
    the internal `dist/` path, and must still contain the file it resolves to.
    That proves the refusal asserted above comes from the exports map, and not
    from a file that was never there — which is the only other reason the
    assertion would pass.
  - With `bin` stripped, `npx --no-install qualityforge` must fail and no link
    may appear in `node_modules/.bin`. Without it, the binary assertions could
    be satisfied by anything at all, and `npx`'s registry fallback would be the
    only thing standing between a typo and a stranger's package.

Both controls are re-wrapped with plain `tar` rather than `npm pack`, because
`npm pack` re-runs `prepare` unconditionally — `--ignore-scripts` does not
stop it — and the extracted copy has no `tsconfig.build.json` and no
`node_modules` to build with.

Usage: python3 scripts/package-check.py [project-root]
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

MODERN_PROTOCOL = "2026-07-28"
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": MODERN_PROTOCOL,
        "capabilities": {},
        "clientInfo": {"name": "package-check", "version": "1"},
        # What a 2026-07-28 client attaches to every request. The shape is
        # shared with mcp-session-check.py rather than invented here.
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
            "io.modelcontextprotocol/clientCapabilities": {},
        },
    },
}

# A bare specifier resolving inside the package, used to prove the exports map
# rather than the file layout: `dist/fixtures/quality-context.js` exists in both
# the checked package and the control, so existence cannot distinguish them.
INTERNAL_PATH = "qualityforge/dist/fixtures/quality-context.js"

PROBE_ENTRY = """\
const entry = await import("qualityforge");
if (entry.PACKAGE_NAME !== "qualityforge") {
  console.error("PACKAGE_NAME is " + entry.PACKAGE_NAME);
  process.exit(3);
}
const fixture = import.meta.resolve("qualityforge/fixtures/quality-context.js");
if (!fixture.endsWith("/node_modules/qualityforge/dist/fixtures/quality-context.js")) {
  console.error("fixture resolved to " + fixture);
  process.exit(4);
}
const pkg = (await import("qualityforge/package.json", { with: { type: "json" } })).default;
if (pkg.name !== "qualityforge") {
  console.error("package.json resolved to a package named " + pkg.name);
  process.exit(5);
}
console.log("entry, fixture subpath and package.json all resolved");
"""

# mode: "refuse" for the real package, "allow" for the control with `exports`
# stripped. The same file in both roles is the point — the difference must come
# from the package, not from two probes that assert different things.
PROBE_INTERNAL_PATH = """\
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
try {
  const resolved = import.meta.resolve("QUALITYFORGE_INTERNAL_PATH");
  if (mode === "refuse") {
    console.error("the internal path resolved to " + resolved);
    process.exit(3);
  }
  if (!existsSync(fileURLToPath(resolved))) {
    console.error("resolved to a file that is not there: " + resolved);
    process.exit(4);
  }
  console.log("resolved to " + resolved);
} catch (error) {
  if (mode !== "refuse") {
    console.error("resolution failed with " + error.code);
    process.exit(5);
  }
  if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    console.error("refused with " + error.code + ", not ERR_PACKAGE_PATH_NOT_EXPORTED");
    process.exit(6);
  }
}
"""

problems: list[str] = []


def check(ok: bool, message: str) -> None:
    """Record one claim about the installed package. Every call can fail."""
    if ok:
        print(f"  ok      {message}")
    else:
        problems.append(message)
        print(f"  FAIL    {message}")


def run(cmd: list[str], cwd: pathlib.Path, timeout: int = 600, input_text: str = "") -> tuple[int, str, str]:
    """Exit code, stdout, stderr.

    A timeout, a missing executable and an unloadable binary are all outcomes
    to assert on, not exceptions to escape with: `run(["./node_modules/.bin/…"])`
    with the link absent raised `FileNotFoundError`, which ends the script with
    a traceback and a code 1 — indistinguishable, from outside, from the check
    having failed for its own reasons. Found by the `bin`-stripped control.
    """
    try:
        done = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input_text,
        )
        return done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"timed out after {timeout}s"
    except OSError as error:
        # ENOENT (no such binary) and ENOEXEC (not executable) among them.
        return 126, "", f"{cmd[0]}: {error.strerror or error}"


def write(path: pathlib.Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def promised_paths(manifest: dict) -> list[str]:
    """Every file `exports` and `bin` name, relative to the package root."""
    found: list[str] = []

    def walk(node) -> None:
        if isinstance(node, str):
            if node.startswith("./"):
                found.append(node[2:])
        elif isinstance(node, dict):
            for value in node.values():
                walk(value)

    walk(manifest.get("exports"))
    walk(manifest.get("bin"))
    return found


def pack(tmp: pathlib.Path) -> tuple[pathlib.Path | None, list[str]]:
    """`npm pack` for real: `prepare` runs, so this is the build a git install does."""
    code, out, err = run(["npm", "pack", "--json", "--pack-destination", str(tmp)], ROOT, 900)
    if code != 0:
        check(False, f"npm pack must succeed; exit {code}:\n{err[-2000:]}")
        return None, []
    try:
        payload = json.loads(out)
        files = [entry["path"] for entry in payload[0]["files"]]
        filename = payload[0]["filename"]
    except (json.JSONDecodeError, KeyError, IndexError) as error:
        check(False, f"npm pack --json was not parseable ({error}); stdout was:\n{out[:2000]}")
        return None, []
    print(f"  packed {filename}: {len(files)} files")
    return tmp / filename, files


def install(consumer: pathlib.Path, tarball: pathlib.Path) -> tuple[bool, str]:
    write(
        consumer / "package.json",
        json.dumps({"name": "qualityforge-consumer", "version": "0.0.0", "private": True}) + "\n",
    )
    code, _, err = run(
        ["npm", "install", "--no-audit", "--no-fund", "--no-progress", str(tarball)],
        consumer,
        600,
    )
    return code == 0, err


def main() -> int:
    print(f"project root: {ROOT}")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="qualityforge-package-"))
    print(f"scratch:      {tmp}\n")

    print("packing (npm pack runs prepare — the build a git install performs)")
    tarball, packed_files = pack(tmp)
    if tarball is None:
        return finish(tmp)

    # --- the consumer's install ------------------------------------------------
    consumer = tmp / "consumer"
    consumer.mkdir()
    ok, err = install(consumer, tarball)
    check(ok, "the tarball installs into a fresh project outside this checkout" + ("" if ok else f": {err[-800:]}"))
    if not ok:
        return finish(tmp)

    package_root = consumer / "node_modules" / "qualityforge"
    manifest = json.loads((package_root / "package.json").read_text(encoding="utf-8"))

    print("\nwhat package.json promises")
    promised = promised_paths(manifest)
    check(bool(promised), "exports and bin together name at least one file")
    missing = [relative for relative in promised if not (package_root / relative).exists()]
    check(not missing, f"every path exports and bin name exists after install; missing: {missing}")

    print("\nimports from the consumer's directory")
    write(consumer / "probe-entry.mjs", PROBE_ENTRY)
    code, out, err = run(["node", "probe-entry.mjs"], consumer, 60)
    check(code == 0, f'import "qualityforge" and its documented subpaths resolve; exit {code} {err.strip()}')

    write(consumer / "probe-internal.mjs", PROBE_INTERNAL_PATH.replace("QUALITYFORGE_INTERNAL_PATH", INTERNAL_PATH))
    code, out, err = run(["node", "probe-internal.mjs", "refuse"], consumer, 60)
    check(code == 0, f"the internal dist/ path is refused by the exports map, not by a missing file; exit {code} {err.strip()}")

    print("\nbinaries as the shell sees them")
    for name, relative in (("qualityforge", "dist/cli/collect-defects.js"), ("qualityforge-mcp", "dist/mcp/index.js")):
        target = package_root / relative
        first_line = target.read_text(encoding="utf-8").split("\n", 1)[0] if target.exists() else "<absent>"
        check(first_line == "#!/usr/bin/env node", f"{relative} carries a node shebang (found: {first_line})")
        check(target.exists() and os.access(target, os.X_OK), f"{relative} is executable after npm's bin linking")
        check((consumer / "node_modules" / ".bin" / name).exists(), f"node_modules/.bin/{name} links to it")

    code, out, err = run(["./node_modules/.bin/qualityforge", "--help"], consumer, 60)
    check(code == 0 and "npx --no-install qualityforge" in out, f"./node_modules/.bin/qualityforge --help exits 0 and names the consumer's invocation; exit {code}")

    code, out, err = run(["npx", "--no-install", "qualityforge", "--help"], consumer, 60)
    check(code == 0 and "Usage:" in out, f"npx --no-install qualityforge --help works from the consumer directory; exit {code} {err.strip()[:300]}")

    # --- the MCP server, started the way a client starts it --------------------
    print("\nthe MCP server as a client starts it (cwd = consumer, no npx in the spawn)")
    code, out, err = run(["./node_modules/.bin/qualityforge-mcp"], consumer, 60)
    check(code != 0 and "Artifacts root" in err, f"without an artifacts directory it fails closed instead of serving a missing root; exit {code}")

    (consumer / "artifacts" / "defects").mkdir(parents=True)
    frame = json.dumps(INITIALIZE) + "\n"
    code, out, err = run(["./node_modules/.bin/qualityforge-mcp"], consumer, 60, input_text=frame)
    lines = [line for line in out.splitlines() if line.strip()]
    answered = False
    if len(lines) == 1:
        try:
            reply = json.loads(lines[0])
            answered = (
                reply.get("id") == 1
                and reply.get("result", {}).get("protocolVersion") == MODERN_PROTOCOL
                and reply.get("result", {}).get("serverInfo", {}).get("name") == "qualityforge-mcp"
            )
        except json.JSONDecodeError:
            answered = False
    check(code == 0 and answered, f"initialize is answered on {MODERN_PROTOCOL} with frames only on stdout; exit {code}, stdout was: {out[:300]}")

    # --- control: the same package, minus the promises it makes ----------------
    print("\ncontrol: the same tarball with exports and bin stripped")
    neg = tmp / "neg"
    neg.mkdir()
    code, _, err = run(["tar", "-xzf", str(tarball), "-C", str(neg)], tmp, 120)
    if code != 0:
        check(False, f"the control tarball must extract; exit {code}: {err[:300]}")
        return finish(tmp)

    neg_pkg = neg / "package"
    control_manifest = json.loads((neg_pkg / "package.json").read_text(encoding="utf-8"))
    control_manifest.pop("exports", None)
    control_manifest.pop("bin", None)
    write(neg_pkg / "package.json", json.dumps(control_manifest, indent=2) + "\n")
    neg_tarball = neg / "without-exports-and-bin.tgz"
    code, _, err = run(["tar", "-czf", str(neg_tarball), "-C", str(neg), "package"], tmp, 120)
    if code != 0:
        check(False, f"the control tarball must re-pack; exit {code}: {err[:300]}")
        return finish(tmp)

    control = tmp / "consumer-control"
    control.mkdir()
    ok, err = install(control, neg_tarball)
    check(ok, "the control tarball installs" + ("" if ok else f": {err[-800:]}"))
    if not ok:
        return finish(tmp)

    # The same probe file in both roles: the two directories differ only in the
    # package they hold, so any difference in outcome belongs to the package.
    write(control / "probe-internal.mjs", PROBE_INTERNAL_PATH.replace("QUALITYFORGE_INTERNAL_PATH", INTERNAL_PATH))
    code, out, err = run(["node", "probe-internal.mjs", "allow"], control, 60)
    check(code == 0, f"without exports the same internal path resolves — so the refusal above is the map's, not a missing file's; exit {code} {err.strip()}")

    check(not (control / "node_modules" / ".bin" / "qualityforge").exists(), "without a bin field npm links nothing")
    code, _, _ = run(["npx", "--no-install", "qualityforge", "--help"], control, 60)
    check(code != 0, f"and npx --no-install qualityforge fails, so the binary assertions cannot pass by chance (exit {code})")

    return finish(tmp)


def finish(tmp: pathlib.Path) -> int:
    if problems:
        print(f"\nFAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        print(f"\nThe scratch directory is kept for inspection: {tmp}")
        return 1
    shutil.rmtree(tmp, ignore_errors=True)
    print("\nOK: the installed package imports, links and runs the way package.json promises, and both controls fail as they must")
    return 0


if __name__ == "__main__":
    sys.exit(main())
