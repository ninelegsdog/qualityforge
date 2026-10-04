"""The tool list every MCP check compares against.

One copy, because two checks hold this literal — `mcp-session-check.py` and
`mcp-spawn-check.py` — and a feature appending two tools is a change neither of
them would have caught if only one had been updated. `mcp-tools-check.py` does not
list the tools; it calls them.

Order is part of the contract, not decoration. A client caches `tools/list` by
content, so inserting a tool in the middle churns that cache for no reason — new
tools are appended.

Keeping the list here means adding a tool is one edit rather than two, and never
half of two.
"""

EXPECTED_TOOLS = [
    "quality_get_latest_run",
    "quality_list_failures",
    "quality_get_defect",
    "quality_flaky_tests",
    "quality_get_trend",
]
