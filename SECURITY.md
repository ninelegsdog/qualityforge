# Security Policy

## Reporting a vulnerability

**Do not open a public issue.**

Email the maintainer directly, or use GitHub's private vulnerability reporting
if it is enabled for the repository. Include:

- what the issue is and what an attacker gains;
- steps to reproduce;
- the affected version or commit.

You should get an acknowledgement within a few days. Fixes for confirmed issues
ship in a patch release, and the reporter is credited unless they prefer
otherwise.

## Scope

In scope:

- the MCP server and the file access it exposes;
- the evidence artifact format and anything that writes it;
- the CI workflow and its permissions;
- dependency compromise affecting this project.

Out of scope:

- vulnerabilities in Playwright itself — report those to Microsoft;
- findings that require an attacker who already has write access to the
  repository;
- missing hardening on applications that use QualityForge, since QualityForge
  does not control them.

## Design commitments

These are properties the project holds itself to. A change that breaks one is a
security change and needs review.

1. **The MCP server is read-only.** It exposes facts, not actions. No file
   writes, no shell, no issue creation, no publishing.
2. **File access is confined server-side.** The server reads only within its
   configured artifacts root. `..` traversal, absolute paths and symlinks that
   escape the root are rejected. Client-side path allowlists are treated as a
   convenience, never as the boundary.
3. **Released builds run over stdio.** Per the MCP security guidance, stdio
   limits access to the client that spawned the server. HTTP transports are
   not in scope; adding one would be a security change under this policy.
4. **Secrets never enter evidence.** Redaction is applied to textual reports and
   artifacts before they are written.
5. **CI runs with least privilege.** No secrets are exposed to test jobs beyond
   what they need, and third-party actions are pinned to major versions.
6. **No `test.only` in committed code.** A skipped test is a silent quality
   regression, which is a supply-chain problem for a quality tool.

## Supported versions

**There are no supported versions.** The package is pre-release: the most
recent published build is `qualityforge@0.1.0-alpha.2`, tagged
`v0.1.0-alpha.2`. Security fixes land on the `main` branch and are cut into
patch releases from there. No long-term-support branches exist yet.
