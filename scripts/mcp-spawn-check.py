#!/usr/bin/env python3
"""
Start the MCP server the way a client starts it, and check what it serves.

## Why this check exists

Every other MCP check in this repository spawns the server from the project root
through `npx`. A client does neither. It spawns the server with its own working
directory - the user's project, not this repository - and it spawns the entry
point by absolute path, because that is all a config file has. AGENTS.md records
that as the difference which broke the artifacts root once already: the relative
`--root` default resolved against the client's directory, the root did not exist,
the store failed to initialise, and the client reported only "Connection closed" -
the message naming the cause went to stderr, which clients discard.

Both other checks pass that arrangement forever and could never have found it.
They are not wrong; they are blind in exactly one direction, and this check is
that direction.

So: two temporary directories outside the project, the server started from them by
absolute path with no `npx`, and four things asserted over the wire:

1. it starts at all - which from a foreign directory it did not, before the
   fallback in `index.ts`;
2. the root it serves is inside this checkout and not inside the foreign
   directory - read out of the server's own stderr line, and confirmed at the data
   level by a marker run that exists only in the checkout;
3. `initialize` echoes the version the client asked for, for both revisions this
   server speaks;
4. a directory that *does* hold an `artifacts/defects` is served in preference to
   the checkout.

Point 4 is the control for point 2. Without it, a server that ignored its working
directory entirely would pass point 2, and so would a server that served the
checkout no matter where it was started. The two behaviours are distinguishable
only by running both and comparing.

## What it deliberately does not use

`npx`. `npx` resolves a relative entry path against the working directory, so a
check that uses it cannot tell "the server resolved the root" from "npx put us
somewhere else". The loader is therefore named by absolute path.

Usage: python3 scripts/mcp-spawn-check.py [project-root]
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from tool_list import EXPECTED_TOOLS  # noqa: E402  (needs the path above)

MODERN = "2026-07-28"
LEGACY = "2025-11-25"
META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"


def envelope(version: str = MODERN) -> dict:
    """The `_meta` a 2026-07-28 client attaches to every request."""
    return {META_PROTOCOL_VERSION: version, META_CLIENT_CAPABILITIES: {}}


# Every spawn sends these. Discovery, the tool list, both revisions this server
# speaks, and a ping that is neither a list nor a read.
#
# The two `initialize` requests are the point of ids 3 and 4: the echo is the whole
# handshake, and answering with our newest regardless of what the client asked for
# is what got a real client to refuse the connection outright.
HANDSHAKE: list[dict] = [
    {"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {"_meta": envelope()}},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": envelope()}},
    {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "initialize",
        "params": {
            "protocolVersion": MODERN,
            "capabilities": {},
            "clientInfo": {"name": "opencode", "version": "2.0.16"},
            "_meta": envelope(),
        },
    },
    {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "initialize",
        "params": {
            "protocolVersion": LEGACY,
            "capabilities": {},
            "clientInfo": {"name": "opencode", "version": "2.0.16"},
        },
    },
    {"jsonrpc": "2.0", "id": 5, "method": "ping", "params": {"_meta": envelope()}},
]

# Two tools that report the run they read. Sent only where a root is known to hold
# one, because an empty root legitimately answers with no runs - and answers with a
# JSON-RPC error rather than an isError result, which is a separate observation and
# not this check's business.
TOOL_CALLS: list[dict] = [
    {
        "jsonrpc": "2.0",
        "id": 6,
        "method": "tools/call",
        "params": {"name": "quality_get_latest_run", "arguments": {}, "_meta": envelope()},
    },
    {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {"name": "quality_list_failures", "arguments": {}, "_meta": envelope()},
    },
]

# A run directory name that sorts last, so it is the newest and
# `quality_get_latest_run` returns it whatever else the root holds.
MARKER_RUN = "9999-12-31T23-59-59-999Z-mcp-spawn-check"
SCRATCH_RELATIVE = "artifacts/.mcp-spawn-check/defects"

# `serving <path> (read-only)` on stderr. The server states which directory it
# serves; a client cannot see stderr, which is exactly why this line is the only
# direct evidence of the resolution and has to be read here.
SERVING = re.compile(r"serving (.+?) \(read-only\)")

problems: list[str] = []
notes: list[str] = []


def find_loader() -> pathlib.Path | None:
    """The tsx ESM loader, by absolute path, or None if it cannot be found.

    `node_modules` may be a symlink into a shared installation; that is fine, and
    deliberately not resolved away - the path a client is given would have the
    same shape.
    """
    for candidate in (ROOT / "node_modules/tsx/dist/loader.mjs", ROOT.parent / "node_modules/tsx/dist/loader.mjs"):
        if candidate.is_file():
            return candidate
    return None


def seed_marker_run() -> pathlib.Path:
    """
    Write a recognisable run into a scratch root inside the checkout.

    Returns the scratch directory. It lives under `artifacts/`, which is
    ignored in full and is this project's own output directory, and it is named so
    it cannot be confused with collected evidence. `defects:collect` writes to
    `artifacts/defects` and CI uploads that path, so neither sees this.
    """
    scratch = ROOT / "artifacts/.mcp-spawn-check"
    absolute = ROOT / SCRATCH_RELATIVE
    run_dir = absolute / MARKER_RUN
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "quality-summary.v1.json").write_text(
        json.dumps(
            {
                "schemaVersion": "1.1.0",
                "runId": MARKER_RUN,
                "createdAt": "9999-12-31T23:59:59.999Z",
                "baseUrl": "http://127.0.0.1:4412",
                "counts": {"specs": 1, "passed": 1, "failed": 0, "timedOut": 0, "skipped": 0, "flaky": 0},
                "defects": [],
                "thresholds": {"maxFailureRate": 0.05, "maxAttemptsPerTest": 2, "maxDurationMs": 900000},
                "gate": {"passed": True, "violations": []},
            },
            indent=2,
        ),
        encoding="utf8",
    )
    return scratch


def ensure_default_root() -> bool:
    """
    Make sure `<checkout>/artifacts/defects` exists, as `defects:collect` leaves it.

    The default root only exists here if somebody has run the pipeline. A check
    that needs its input prepared by a human tests the human, so this creates the
    directory when it is absent - it is empty, ignored, and is the shape the
    project produces anyway. Returns True when it had to create it, so a green run
    can leave the tree as it found it.
    """
    root = ROOT / "artifacts/defects"
    if root.is_dir():
        return False
    try:
        root.mkdir(parents=True)
    except OSError as error:
        problems.append(f"could not create {root} for the default-root case: {error}")
        return False
    return True


def spawn(
    cwd: pathlib.Path,
    loader: pathlib.Path,
    entry: pathlib.Path,
    extra: list[str],
    requests: list[dict] | None = None,
) -> tuple[dict, list, int, str]:
    """
    Drive the real server over a real pipe, from `cwd`, and collect its frames.

    No `npx`, no shell, absolute paths - the argv a client config carries.
    """
    payload = "".join(json.dumps(r) + "\n" for r in (requests if requests is not None else HANDSHAKE))
    node = shutil.which("node")
    if node is None:
        problems.append("node is not on PATH, so the server cannot be started the way a client starts it")
        return {}, [], -1, ""

    proc = subprocess.run(
        [node, "--import", str(loader), str(entry), *extra],
        input=payload,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=120,
    )
    frames: dict = {}
    corrupt: list = []
    for line in proc.stdout.split("\n"):
        if not line.strip():
            continue
        try:
            frame = json.loads(line)
            frames[frame.get("id")] = frame
        except json.JSONDecodeError:
            corrupt.append(line)
    return frames, corrupt, proc.returncode, proc.stderr


def served_path(stderr: str) -> str | None:
    """The directory the server says it is serving, from its startup line."""
    for line in stderr.split("\n"):
        match = SERVING.search(line)
        if match:
            return match.group(1)
    return None


def inside(child: str, parent: pathlib.Path) -> bool:
    """Whether `child` resolves to somewhere at or under `parent`."""
    try:
        resolved = pathlib.Path(child).resolve()
    except OSError:
        return False
    return resolved == parent.resolve() or parent.resolve() in resolved.parents


def result_of(frame: dict) -> dict:
    result = frame.get("result")
    return result if isinstance(result, dict) else {}


def report(label: str, frames: dict, corrupt: list, code: int, stderr: str) -> tuple[str | None, bool]:
    """Shared post-spawn checks. Returns `(served_directory, initialize_echoed)`."""
    if corrupt:
        problems.append(f"{label}: {len(corrupt)} stdout line(s) were not valid JSON")
    if code != 0:
        first = next((l for l in stderr.strip().split("\n") if l.strip()), "")
        problems.append(f"{label}: exited {code}, expected 0 — {first.strip()[:140]}")
        return None, False
    for req_id in (1, 2, 3, 4, 5):
        if req_id not in frames:
            problems.append(f"{label}: no answer for id {req_id}")
    if not frames:
        return None, False

    # stdout carried frames only, and the server is still answering.
    tools = [t.get("name") for t in (result_of(frames.get(2, {})).get("tools") or [])]
    if tools != EXPECTED_TOOLS:
        problems.append(f"{label}: unexpected tool list {tools}")

    echoed = True
    for req_id, version in ((3, MODERN), (4, LEGACY)):
        frame = frames.get(req_id, {})
        if "error" in frame:
            problems.append(f"{label}: initialize for {version} failed: {frame['error']}")
            echoed = False
            continue
        answered = result_of(frame).get("protocolVersion")
        if answered != version:
            problems.append(
                f"{label}: initialize asked for {version} and was answered {answered!r}; "
                "a client that is offered a revision it did not request refuses the "
                "connection outright"
            )
            echoed = False
        meta = result_of(frame).get("_meta")
        if not isinstance(meta, dict) or META_SERVER_INFO not in meta:
            problems.append(f"{label}: the initialize answer for {version} carries no _meta.{META_SERVER_INFO}")
            echoed = False

    if "error" in frames.get(5, {}):
        problems.append(f"{label}: ping answered {frames[5]['error']}")

    return served_path(stderr), echoed


def main() -> int:
    node = shutil.which("node")
    entry = ROOT / "src/mcp/index.ts"
    loader = find_loader()

    if node is None:
        print("FAIL: node is not on PATH")
        return 1
    if not entry.is_file():
        print(f"FAIL: {entry} does not exist")
        return 1
    if loader is None:
        print(f"FAIL: no tsx loader at {ROOT}/node_modules/tsx/dist/loader.mjs")
        return 1

    print(f"project root: {ROOT}")
    print(f"spawning:     node --import {loader} {entry}")
    print(f"  (no npx: a client names the entry by absolute path, and npx resolves a")
    print(f"   relative one against the working directory, which is the thing under test)")
    print()

    made_default_root = ensure_default_root()
    scratch = seed_marker_run()
    marker_root = ROOT / SCRATCH_RELATIVE

    # Outside the project, deliberately and verifiably. A temporary directory
    # created inside the checkout would exercise the same code and prove nothing.
    foreign = pathlib.Path(tempfile.mkdtemp(prefix="qualityforge-mcp-spawn-"))
    bare = foreign / "a-foreign-project"
    decoy = foreign / "a-foreign-project-with-evidence"
    bare.mkdir(parents=True)
    (decoy / "artifacts/defects").mkdir(parents=True)
    try:
        if ROOT in foreign.resolve().parents or foreign.resolve() == ROOT:
            problems.append(f"the foreign directory is inside the project: {foreign}")
        print(f"foreign directory (outside the project): {bare}")
        print(f"decoy directory, holds its own artifacts/defects: {decoy}")
        print()

        # --- case 1: the default root, started the way a client starts it ----
        # No --root at all, which is what the client config block in index.ts
        # does. From a foreign directory the relative default resolves to a path
        # that does not exist, and the server must fall back to this checkout.
        print("=== case 1: no --root, started from a directory that has no artifacts ===")
        frames, corrupt, code, stderr = spawn(bare, loader, entry, [])
        served, echoed = report("default root", frames, corrupt, code, stderr)
        for line in stderr.strip().split("\n"):
            if line.strip():
                print(f"  stderr: {line.strip()}")
        if served is None:
            problems.append(
                "default root: the server never said which directory it serves, so "
                "the resolution cannot be judged"
            )
        else:
            print(f"  serving: {served}")
            if inside(served, bare):
                problems.append(
                    f"default root: served {served}, which is inside the foreign "
                    f"directory {bare}; the root resolved to the client's directory "
                    "instead of the checkout"
                )
            elif not inside(served, ROOT / "artifacts/defects"):
                problems.append(
                    f"default root: served {served}, which is neither the checkout's "
                    f"artifacts root ({ROOT / 'artifacts/defects'}) nor the foreign one"
                )
            else:
                print(f"  resolved into the checkout: yes ({ROOT / 'artifacts/defects'})")
        print(f"  initialize echoed {MODERN} and {LEGACY}: {'yes' if echoed else 'NO'}")
        print()

        # --- case 2: a relative --root that exists only in the checkout -----
        # The data-level half of case 1. The marker run exists in exactly one
        # place on this machine, so a returned runId cannot be produced by a root
        # that resolved anywhere else.
        print("=== case 2: a relative --root that exists only in the checkout ===")
        frames, corrupt, code, stderr = spawn(bare, loader, entry, ["--root", SCRATCH_RELATIVE], HANDSHAKE + TOOL_CALLS)
        served, echoed = report("relative --root", frames, corrupt, code, stderr)
        for line in stderr.strip().split("\n"):
            if line.strip():
                print(f"  stderr: {line.strip()}")
        if served is None or pathlib.Path(served).resolve() != marker_root.resolve():
            problems.append(
                f"relative --root: served {served}, expected the checkout's {marker_root}"
            )
        else:
            print("  resolved into the checkout: yes")
        print(f"  initialize echoed {MODERN} and {LEGACY}: {'yes' if echoed else 'NO'}")

        # The data half. The marker run exists in exactly one place on this machine,
        # so a returned runId cannot be produced by a root that resolved anywhere
        # else. This is what stops case 2 from passing on the strength of a log line
        # alone.
        for req_id, method in ((6, "quality_get_latest_run"), (7, "quality_list_failures")):
            returned = (result_of(frames.get(req_id, {})).get("structuredContent") or {}).get("runId")
            if returned != MARKER_RUN:
                problems.append(
                    f"{method} returned runId {returned!r}, expected the marker run "
                    f"{MARKER_RUN!r}; the served root is not the one the relative "
                    "--root resolved to"
                )
            else:
                print(f"  {method}: {returned}")
        print()

        # --- case 3: the control --------------------------------------------
        # A server that ignored its working directory would pass cases 1 and 2.
        # Only a foreign directory that actually holds an artifacts root tells the
        # two behaviours apart.
        print("=== case 3 (control): a foreign directory that does hold artifacts/defects ===")
        frames, corrupt, code, stderr = spawn(decoy, loader, entry, [])
        served, echoed = report("decoy root", frames, corrupt, code, stderr)
        for line in stderr.strip().split("\n"):
            if line.strip():
                print(f"  stderr: {line.strip()}")
        if served is None or not inside(served, decoy):
            problems.append(
                f"decoy root: served {served}, expected something inside {decoy}; a "
                "server that resolves to the checkout regardless of its working "
                "directory would pass the other two cases and fail this one"
            )
        else:
            print(f"  the working directory is genuinely consulted: yes ({served})")
        print(f"  initialize echoed {MODERN} and {LEGACY}: {'yes' if echoed else 'NO'}")
        print()

    finally:
        shutil.rmtree(foreign, ignore_errors=True)
        if not problems:
            shutil.rmtree(scratch, ignore_errors=True)
            if made_default_root:
                # Only if this run made it, and only while it is still empty: a
                # concurrent `defects:collect` may have filled it in the meantime.
                default_root = ROOT / "artifacts/defects"
                try:
                    if not any(default_root.iterdir()):
                        default_root.rmdir()
                except OSError:
                    pass

    if made_default_root:
        notes.append(f"created and removed an empty {ROOT / 'artifacts/defects'}")

    for note in notes:
        print(f"note: {note}")

    if problems:
        print(f"\nFAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        print(f"  scratch kept at {scratch}")
        return 1

    print(
        "OK: started from a directory outside the project with no npx — the root "
        "resolved into this checkout, the working directory is still honoured when "
        "it holds evidence, and initialize echoed both revisions"
    )
    return 0


sys.exit(main())