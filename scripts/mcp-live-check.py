#!/usr/bin/env python3
"""
Connect the real `opencode` client to this server and assert what crossed the
wire.

Usage: python3 scripts/mcp-live-check.py [project-root]
Env:   OPENCODE_BIN          - explicit client binary (else `opencode` on PATH)
       EXPECT_OPENCODE_VERSION- required client version, e.g. "2.0.16"

What the other MCP checks cannot do: they speak to the server with frames we
wrote, so they can only prove the server answers frames like ours. This check
starts the server exactly the way a client starts it - from a fresh directory
outside the project, no `npx`, no project environment - runs the actual client
until it reports `connected`, and then asserts on the captured frames.

Everything here reads exit codes and parsed JSON, never a grepped line, with
one documented exception: `opencode mcp list` exits 0 whether the connection
succeeded or not, so its printed verdict IS the signal for that one step. That
is checked by attempting a connection to a server that never answers (the
status stays `pending` and the loop below turns it into a failure). The
attempts are spaced by `ATTEMPT_GAP_S`, because the verdict arrives long
before the server it spawned has finished booting — see the constant for the
measurements.

The wire is read through scripts/mcp-wire-log.mjs, a pass-through that tags
every frame it forwards. The proxy exists because "connected" is a weaker
claim than "connected and answered initialize with our capabilities, our
`_meta`, and a tools/list our schema promises" - the client connects to a
server that has quietly lost any one of those.

Fresh directory per run, deliberately: the CLI caches connection state per
directory, so a directory that has already seen a failure keeps reporting it
after the server is fixed.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

SCRIPTS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from tool_list import EXPECTED_TOOLS  # noqa: E402

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
SERVER = ROOT / "dist/mcp/index.js"
PROXY = SCRIPTS / "mcp-wire-log.mjs"
SERVER_NAME = "qualityforge-mcp"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"
MAX_ATTEMPTS = 4
ATTEMPT_TIMEOUT_S = 120
# Wall-clock between attempts. `mcp list` prints its verdict and exits in
# roughly 150ms on a fast runner, while the server it spawned keeps booting
# after the client is gone — the two are racing, and back-to-back attempts
# gave the whole connection about one second of real time. On 2026-10-06 two
# consecutive runs on main failed with every attempt `pending` and the entire
# check lasting 1.04s, while runs where each invocation happened to take
# longer passed on the last attempt. The gap, not more attempts, is what
# turns a background boot into a verdict: observed locally, attempt 1 found
# nothing, a 2-second gap, attempt 2 connected.
ATTEMPT_GAP_S = 2.0


def fatal(message: str) -> "int":
    print(f"FATAL: {message}")
    return 2


def main() -> int:
    problems: list[str] = []

    if not SERVER.exists():
        return fatal(f"{SERVER} not found - run `npm run build` first")
    node = shutil.which("node")
    if node is None:
        return fatal("node not found on PATH")

    # --- locate the client -------------------------------------------------
    binary = os.environ.get("OPENCODE_BIN") or shutil.which("opencode")
    if not binary:
        return fatal(
            "opencode binary not found (set OPENCODE_BIN or install it). "
            "This check exists to run against the real client; skipping "
            "silently would make it decoration."
        )
    version_out = subprocess.run(
        [binary, "--version"], capture_output=True, text=True, timeout=60
    )
    reported = version_out.stdout.strip()
    # e.g. "opencode v2.0.16" -> "2.0.16"
    client_version = reported.rsplit("v", 1)[-1].strip() if "v" in reported else reported
    print(f"client: {binary} -> {reported or '(no version output)'}")
    expected = os.environ.get("EXPECT_OPENCODE_VERSION")
    if expected and client_version != expected:
        return fatal(
            f"expected client version {expected}, found {client_version!r} - "
            "the pin is only real if the installed binary is the pinned one"
        )

    # --- a fresh directory, wired the way a client wires it ----------------
    fresh = pathlib.Path(tempfile.mkdtemp(prefix="qualityforge-live-"))
    wire = fresh / "wire.log"
    evidence = fresh / "evidence"
    subprocess.run(["git", "init", "-q"], cwd=fresh, check=True, capture_output=True)
    evidence.mkdir()
    (fresh / "opencode.json").write_text(
        json.dumps(
            {
                "$schema": "https://opencode.ai/config.json",
                "mcp": {
                    "qualityforge": {
                        "type": "local",
                        "command": [
                            node,
                            str(PROXY),
                            str(wire),
                            "--",
                            node,
                            str(SERVER),
                            "--root",
                            str(evidence),
                        ],
                        "enabled": True,
                    }
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    # --- connect. The client's exit code says nothing: it is 0 either way --
    verdict = ""
    never_connected_output = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        run = subprocess.run(
            [binary, "mcp", "list"],
            cwd=fresh,
            capture_output=True,
            text=True,
            timeout=ATTEMPT_TIMEOUT_S,
        )
        combined = run.stdout + run.stderr
        never_connected_output = combined
        lines = [
            line.strip()
            for line in combined.splitlines()
            if "qualityforge" in line and "connected" in line
        ]
        if lines:
            verdict = lines[0]
            print(f"  attempt {attempt}: {verdict}")
            break
        if "failed" in combined:
            problems.append(f"client reported a failed connection: {combined.strip()!r}")
            break
        print(f"  attempt {attempt}: not connected yet")
        if attempt < MAX_ATTEMPTS:
            time.sleep(ATTEMPT_GAP_S)
    else:
        problems.append(
            f"never reached `connected` in {MAX_ATTEMPTS} attempts; last output: "
            f"{never_connected_output.strip()!r}"
        )

    if not wire.exists():
        problems.append(
            "no wire log was written - the client never started the server, or "
            "the proxy did not run"
        )
        return report(fresh, problems)

    sessions = read_sessions(wire, problems)
    if not sessions:
        problems.append("wire log holds no initialize frame from a client")
        return report(fresh, problems)
    frames = sessions[-1]
    print(f"  sessions: {len(sessions)}, frames in last: {len(frames)}")

    # --- initialize: the handshake, exactly as the client sent it ----------
    sent = [f for f in frames if f["dir"] == "C->S" and f.get("method") == "initialize"]
    if len(sent) != 1:
        problems.append(f"expected one initialize request in the session, got {len(sent)}")
    else:
        init = sent[0]
        requested = (init.get("params") or {}).get("protocolVersion")
        info = (init.get("params") or {}).get("clientInfo") or {}
        print(f"  initialize: client {info.get('name')} {info.get('version')} -> {requested}")
        if not isinstance(requested, str):
            problems.append("initialize request states no protocolVersion")
        if info.get("version") != client_version:
            problems.append(
                f"wire clientInfo.version {info.get('version')!r} != reported "
                f"{client_version!r} - a different client than the pinned one is connecting"
            )
        answer = answer_to(frames, init.get("id"))
        if answer is None:
            problems.append("initialize got no answer")
        else:
            result = answer.get("result")
            if not isinstance(result, dict):
                problems.append(f"initialize answered with an error: {answer.get('error')}")
            else:
                if result.get("protocolVersion") != requested:
                    problems.append(
                        f"initialize echoed {result.get('protocolVersion')!r}, "
                        f"client asked {requested!r}"
                    )
                server_info = result.get("serverInfo") or {}
                if server_info.get("name") != SERVER_NAME:
                    problems.append(f"initialize result serverInfo.name = {server_info!r}")
                caps = result.get("capabilities") or {}
                for needed in ("tools", "resources", "prompts"):
                    if needed not in caps:
                        problems.append(f"initialize capabilities omit {needed}")
                # The plan's reverse probe removes this envelope; a client that
                # reads server identity from `_meta` (2026-07-28 readers do)
                # finds nothing there. See withResultMeta in src/mcp/protocol.ts.
                meta = (result.get("_meta") or {}).get(META_SERVER_INFO) or {}
                if meta.get("name") != SERVER_NAME:
                    problems.append(
                        "initialize result carries no `_meta[io.modelcontextprotocol/"
                        f"serverInfo]` for {SERVER_NAME} (found {meta!r})"
                    )
                else:
                    print(f"  initialize result: _meta[{META_SERVER_INFO}] ok")

    initialized = [
        f
        for f in frames
        if f["dir"] == "C->S" and f.get("method") == "notifications/initialized"
    ]
    if not initialized:
        problems.append("client never sent notifications/initialized")

    # --- tools/list: what the client will actually load -------------------
    tool_requests = [f for f in frames if f.get("method") == "tools/list"]
    if not tool_requests:
        problems.append("client never asked for tools/list")
    else:
        answer = answer_to(frames, tool_requests[-1].get("id"))
        if answer is None or not isinstance(answer.get("result"), dict):
            problems.append(f"tools/list answered badly: {answer}")
        else:
            result = answer["result"]
            if result.get("resultType") != "complete":
                problems.append(f"tools/list resultType = {result.get('resultType')!r}")
            ttl = result.get("ttlMs")
            if not isinstance(ttl, int) or isinstance(ttl, bool) or ttl <= 0:
                problems.append(f"tools/list ttlMs = {ttl!r}")
            if result.get("cacheScope") != "private":
                problems.append(f"tools/list cacheScope = {result.get('cacheScope')!r}")
            names = [t.get("name") for t in result.get("tools") or []]
            if names != EXPECTED_TOOLS:
                problems.append(f"tools/list names {names} != {EXPECTED_TOOLS}")
            else:
                print(f"  tools/list: {len(names)} tools, resultType/ttlMs/cacheScope ok")

    # --- every question the client asked got an answer, and none an error --
    requests = [f for f in frames if f["dir"] == "C->S" and f.get("id") is not None]
    for request in requests:
        answer = answer_to(frames, request.get("id"))
        if answer is None:
            problems.append(
                f"{request.get('method')} (id {request.get('id')}) was never answered"
            )
        elif "error" in answer:
            problems.append(
                f"{request.get('method')} answered with an error: {answer['error']}"
            )

    return report(fresh, problems)


def read_sessions(wire: pathlib.Path, problems: list) -> list:
    """Split the log at every client initialize: each connection is one session.

    The CLI may reconnect across attempts, and frame ids restart at 0 each
    time, so pairing requests with answers across sessions would match ids
    that merely share a number. Only the last session is asserted on: it is
    the one whose verdict was `connected`.
    """
    sessions: list = []
    current: list = []
    for line in wire.read_text(encoding="utf-8", errors="replace").splitlines():
        direction, sep, raw = line.partition(" ")
        if not sep or direction not in ("C->S", "S->C"):
            problems.append(f"wire log line is not a tagged frame: {line[:80]!r}")
            continue
        try:
            frame = json.loads(raw)
        except ValueError:
            problems.append(f"unparseable frame: {raw[:80]!r}")
            continue
        frame["dir"] = direction
        if direction == "C->S" and frame.get("method") == "initialize":
            if current:
                sessions.append(current)
            current = []
        current.append(frame)
    if current:
        sessions.append(current)
    return sessions


def answer_to(frames: list, request_id):
    for frame in frames:
        if frame["dir"] == "S->C" and frame.get("id") == request_id and (
            "result" in frame or "error" in frame
        ):
            return frame
    return None


def report(fresh: pathlib.Path, problems: list) -> int:
    print()
    if problems:
        print(f"FAIL: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  - {problem}")
        print(f"  evidence kept at {fresh}")
        return 1
    shutil.rmtree(fresh, ignore_errors=True)
    print("OK: live client connected from a fresh directory and the frames match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
