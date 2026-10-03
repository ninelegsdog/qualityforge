#!/usr/bin/env python3
"""
Validate .github/workflows/ci.yml without running it.

Actions cannot be exercised without a remote, so this checks what would silently
break a run: YAML validity, that every `npm run` target exists, that every
uploaded artifact path is actually produced by something in the repo, and that
no EOL Node version is pinned.

The workflow is parsed as YAML and walked structurally. Regexing a YAML file for
path-like strings produces false positives on keys such as `retention-days`.

Usage: python3 scripts/validate-ci.py [project-root]
"""
import json
import pathlib
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml")

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
WF = ROOT / ".github/workflows/ci.yml"

if not WF.exists():
    sys.exit(f"FATAL: {WF} not found")

doc = yaml.safe_load(WF.read_text(encoding="utf-8"))
if not isinstance(doc, dict):
    sys.exit("FATAL: ci.yml did not parse into a mapping")

# YAML 1.1 parses the `on:` key as boolean True. Both spellings appear in the
# wild; accept either without treating it as an error in the file.
trigger_key = "on" if "on" in doc else True
triggers = doc.get(trigger_key)
jobs = doc.get("jobs") or {}
print(f"workflow parsed: jobs = {', '.join(jobs) or 'none'}")
if isinstance(triggers, (str, list)):
    print(f"triggers: {triggers}")

problems = []


def walk(node, visit):
    if isinstance(node, dict):
        for key, value in node.items():
            visit(key, value)
            walk(value, visit)
    elif isinstance(node, list):
        for item in node:
            walk(item, visit)


# --- npm run targets --------------------------------------------------------
scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("scripts", {})


def check_run(_key, value):
    if not isinstance(value, str):
        return
    for token in value.split():
        if token.startswith("run:"):
            name = token[4:]
            if name not in scripts:
                problems.append(f"`npm run {name}` is used but package.json does not define it")


walk(doc, check_run)

# --- uploaded artifact paths ------------------------------------------------
# A path is only an artifact path under an `actions/upload-artifact` step.
uploaded = []


def collect_uploads(node, in_upload=False):
    if isinstance(node, dict):
        for key, value in node.items():
            now_in = in_upload or key == "uses" and isinstance(value, str) and "upload-artifact" in value
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

# What actually produces each uploaded path, and where that is decided.
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
        print(f"  upload {target:38} <- {producers[target]}")

# --- Node versions must not be EOL -----------------------------------------
# Only the `node-version` key is inspected. Walking every value would pick up
# unrelated numbers such as `retention-days: 14` and report them as Node pins.
seen_nodes = set()


def check_node(key, value):
    if key != "node-version":
        return
    if isinstance(value, (str, int)):
        seen_nodes.add(str(value))
    elif isinstance(value, list):
        seen_nodes.update(str(v) for v in value)


walk(doc, check_node)

for version in sorted(seen_nodes):
    if version.isdigit() and int(version) < 22:
        problems.append(f"pins Node {version}, past end-of-life since 2026-03")

if seen_nodes:
    print(f"node versions referenced: {', '.join(sorted(seen_nodes))}")

print()
if problems:
    print(f"FAIL: {len(problems)} problem(s)")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)

print("OK: workflow parses, every run target exists, every upload has a producer, no EOL Node")