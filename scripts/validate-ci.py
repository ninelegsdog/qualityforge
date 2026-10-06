#!/usr/bin/env python3
"""
Statically validate the GitHub Actions workflow for supply-chain hygiene.

Actions cannot be exercised without a remote, so the properties that matter are
checked here instead. Each rule exists because its absence is silent: a workflow
keeps working after losing `permissions:` or its SHA pins, and nobody notices
until something exploits it.

Usage: python3 scripts/validate-ci.py [project-root]
Requires PyYAML: pip install pyyaml
"""
import json
import pathlib
import re
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml")

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
WF = ROOT / ".github/workflows/ci.yml"

if not WF.exists():
    sys.exit(f"FATAL: {WF} not found")

text = WF.read_text(encoding="utf-8")
doc = yaml.safe_load(text)
if not isinstance(doc, dict):
    sys.exit("FATAL: ci.yml did not parse into a mapping")

problems = []

# YAML 1.1 parses the `on:` key as boolean True. Accept either spelling.
trigger_key = "on" if "on" in doc else True
triggers = doc.get(trigger_key)
jobs = doc.get("jobs") or {}
print(f"workflow parsed: jobs = {', '.join(jobs) or 'none'}")
if isinstance(triggers, (str, list)):
    print(f"triggers: {triggers}")

# --- 1. permissions must be declared and least-privilege -------------------
# Absent permissions means the token inherits repository or organisation
# defaults, which for a write-capable default is more than this workflow needs.
perms = doc.get("permissions")
if perms is None:
    problems.append("no top-level 'permissions:' — the token inherits defaults")
elif isinstance(perms, dict):
    for name, level in perms.items():
        if name == "contents" and level == "read":
            print(f"  permissions: contents: {level}")
        elif level == "none":
            print(f"  permissions: {name}: none")
        elif level == "write" and name not in ("contents",):
            problems.append(f"permissions.{name} is 'write'; this workflow only reads")
elif perms == "read-all":
    print("  permissions: read-all")
elif perms != "none":
    problems.append(f"unexpected permissions value: {perms!r}")

# --- 2. third-party actions must be pinned to a commit SHA -----------------
# A tag such as @v5 is mutable: whoever can push to the action repository can
# repoint it at new code, which then runs inside this pipeline.
SHA_PIN = re.compile(r"^([\w.\-]+/[A-Za-z0-9_.\-]+)@([0-9a-f]{40})$")
uses_steps = []


def collect_uses(node, in_step=False):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "uses" and isinstance(value, str):
                uses_steps.append(value)
            else:
                collect_uses(value, in_step or key == "steps")
    elif isinstance(node, list):
        for item in node:
            collect_uses(item, in_step)


collect_uses(doc)

if not uses_steps:
    problems.append("no steps found; the workflow parsed but contains nothing to run")

for use in sorted(set(uses_steps)):
    m = SHA_PIN.match(use)
    if m:
        print(f"  pinned  {use}")
    else:
        problems.append(
            f"action is not pinned to a commit SHA: {use} "
            "(a tag can be repointed at new code)"
        )

# --- 3. checkout must not persist credentials ------------------------------
# Otherwise the token stays in .git/config, where any later step, including
# dependency code, can read it.


def check_persist_credentials():
    found_bad = []
    for job_name, job in jobs.items():
        for step in (job or {}).get("steps", []) or []:
            if not isinstance(step, dict):
                continue
            use = step.get("uses", "")
            if "actions/checkout" not in use:
                continue
            with_ = step.get("with") or {}
            if with_.get("persist-credentials") is not False:
                found_bad.append(f"{job_name}: persist-credentials not disabled")
    return found_bad


bad_persist = check_persist_credentials()
if bad_persist:
    for item in bad_persist:
        problems.append(item + " — the token stays in .git/config after checkout")

# --- 4. jobs need a timeout -------------------------------------------------
# The default is 360 minutes per job.
for job_name, job in jobs.items():
    if "timeout-minutes" not in (job or {}):
        problems.append(f"job '{job_name}' has no timeout-minutes (default 360)")

# --- 5. npm ci must not run dependency lifecycle scripts ------------------
# Lifecycle scripts are arbitrary code execution on the runner.
for line in re.findall(r"^\s*-?\s*run:\s*(.+)$", text, re.MULTILINE):
    if re.search(r"\bnpm\s+(?:i|install|ci)\b", line) and "--ignore-scripts" not in line:
        problems.append(f"install without --ignore-scripts: {line.strip()[:60]}")

# --- 6. pull_request_target must not be used ------------------------------
# It runs with repository secrets against untrusted code. `pull_request` is the
# safe form and is what this workflow uses.
if re.search(r"pull_request_target", text):
    problems.append("pull_request_target grants secrets to untrusted code; use pull_request")

# --- 7. every npm run target exists ----------------------------------------
manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
scripts = manifest.get("scripts", {})
for line in re.findall(r"^\s*-?\s*run:\s*(.+)$", text, re.MULTILINE):
    for token in line.split():
        if token.startswith("run:"):
            if token[4:] not in scripts:
                problems.append(f"`npm run {token[4:]}` is used but package.json does not define it")

# --- 8. every uploaded artifact path has a producer ------------------------
uploaded = []


def collect_uploads(node, in_upload=False):
    """Find `with.path` inside upload-artifact steps.

    Whether a dict *is* an upload step is a property of the whole dict, not of
    one key. Testing the key alone means `with` is never recognised, because
    `uses` and `with` are siblings and the earlier sibling's verdict does not
    carry. The check then silently passes on every workflow.
    """
    if isinstance(node, dict):
        has_upload = any(
            key == "uses" and isinstance(value, str) and "upload-artifact" in value
            for key, value in node.items()
        )
        now_in = in_upload or has_upload
        for key, value in node.items():
            if now_in and key == "with" and isinstance(value, dict):
                target = value.get("path")
                if isinstance(target, str):
                    for line in target.splitlines():
                        if line.strip():
                            uploaded.append(line.strip())
            collect_uploads(value, now_in)
    elif isinstance(node, list):
        for item in node:
            collect_uploads(item, in_upload)


collect_uploads(doc)

producers = {
    "playwright-report/": "html reporter outputFolder in playwright.config.ts",
    "test-results/": "Playwright outputDir in playwright.config.ts",
    "test-results/junit.xml": "junit reporter in playwright.config.ts",
    "artifacts/json/playwright-results.json": "json reporter in playwright.config.ts",
    "artifacts/defects/": "npm run defects:collect, defects.directory in config/project.json",
}
for target in sorted(set(uploaded)):
    if target.startswith("/") or "${{" in target:
        continue
    if target not in producers:
        problems.append(f"uploads {target!r}, which nothing in the repo produces")
    else:
        print(f"  upload  {target:38} <- {producers[target]}")

# --- 9. Node versions must not be EOL --------------------------------------
seen = set()


def check_node(key, value):
    if key != "node-version":
        return
    if isinstance(value, (str, int)):
        seen.add(str(value))
    elif isinstance(value, list):
        seen.update(str(v) for v in value)


def walk(node, visit):
    if isinstance(node, dict):
        for key, value in node.items():
            visit(key, value)
            walk(value, visit)
    elif isinstance(node, list):
        for item in node:
            walk(item, visit)


walk(doc, check_node)
for version in sorted(seen):
    if version.isdigit() and int(version) < 22:
        problems.append(f"pins Node {version}, past end-of-life since 2026-03")
if seen:
    print(f"  node versions: {', '.join(sorted(seen))}")

# --- 10. node-version must not be an array inside a matrix job -------------
# An array in `node-version` makes setup-node expand the matrix itself. Combined
# with a job that already declares strategy.matrix, GitHub rejects the workflow
# at validation time: the run fails in zero seconds, with no jobs and no logs.
#
# This is invisible to every local check. The YAML is valid, PyYAML parses it,
# and the failure appears only as "this run likely failed because of a workflow
# file issue". Found by bisection against the real GitHub runner, after a static
# validator had passed the broken file.
for job_name, job in jobs.items():
    has_matrix = bool((job or {}).get("strategy", {}).get("matrix"))
    if not has_matrix:
        continue
    for step in (job or {}).get("steps", []) or []:
        if not isinstance(step, dict):
            continue
        if "actions/setup-node" not in str(step.get("uses", "")):
            continue
        version = (step.get("with") or {}).get("node-version")
        if isinstance(version, list):
            problems.append(
                f"job '{job_name}': node-version is a list while the job declares "
                "strategy.matrix — GitHub rejects the workflow and the run fails "
                "instantly. Put the versions in the matrix instead, e.g. "
                "matrix: { node: [22, 24] } with node-version: ${{ matrix.node }}"
            )
        elif isinstance(version, str) and "${{" not in version and not version.isdigit():
            problems.append(
                f"job '{job_name}': node-version {version!r} is neither a version "
                "number nor a matrix reference"
            )

# --- 11. artifact names must be unique across a matrix ---------------------
# Two matrix legs uploading to the same artifact name collide, and the second
# upload fails or silently overwrites the first.
for job_name, job in jobs.items():
    matrix_keys = list(((job or {}).get("strategy", {}) or {}).get("matrix", {}) or {})
    if len(matrix_keys) < 1:
        continue
    for step in (job or {}).get("steps", []) or []:
        if not isinstance(step, dict):
            continue
        use = str(step.get("uses", ""))
        if "upload-artifact" not in use:
            continue
        name = str((step.get("with") or {}).get("name", ""))
        referenced = {k for k in matrix_keys if f"matrix.{k}" in name}
        if len(referenced) < len(matrix_keys):
            problems.append(
                f"job '{job_name}': artifact name {name!r} does not reference every "
                f"matrix key {matrix_keys}, so matrix legs would collide"
            )

# --- 12. the engines floor must equal the lowest line CI runs ---------------
# `engines` is what package.json promises consumers can run; the matrix is what
# actually runs. A floor below the matrix promises a version nobody executes —
# `>=20.19.0` sat there while CI ran 22 and 24 (B4, owner's decision
# 2026-10-06). A floor above it promises compatibility CI has just disproved by
# running a lower line. Either way the two drift apart silently, which is the
# pattern this file exists for: an unparseable floor fails closed too.
floor_node = str((manifest.get("engines") or {}).get("node", ""))
floor_match = re.match(r">=\s*(\d+)", floor_node)
matrix_lines: set[int] = set()
for job in jobs.values():
    value = ((job or {}).get("strategy") or {}).get("matrix") or {}
    value = value.get("node") if isinstance(value, dict) else None
    if isinstance(value, list):
        matrix_lines.update(int(v) for v in value if str(v).isdigit())
    elif isinstance(value, int):
        matrix_lines.add(value)
if not floor_match:
    problems.append(f"engines.node is {floor_node!r}; expected a floor like '>=22'")
elif not matrix_lines:
    problems.append("engines.node exists but no numeric node matrix was found to check it against")
elif int(floor_match.group(1)) != min(matrix_lines):
    problems.append(
        f"engines.node claims {floor_node!r} while CI's lowest line is {min(matrix_lines)}: "
        "a lower floor promises a version nobody runs, a higher one a version CI has disproved"
    )
else:
    print(f"  engines {floor_node} = lowest CI line ({min(matrix_lines)})")

print()
if problems:
    print(f"FAIL: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

print(
    "OK: permissions least-privilege, actions SHA-pinned, no persisted credentials, "
    "timeouts set, installs without lifecycle scripts, every upload has a producer, "
    "no EOL Node, engines matches the CI matrix"
)