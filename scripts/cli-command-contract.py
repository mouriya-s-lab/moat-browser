#!/usr/bin/env python3
"""Emit a source-derived CLI/action inventory and fail on real coverage gaps.

The fork retains upstream parser helpers that can construct action names
dynamically.  Static literals and resolved helper values are kept separate in
the inventory so coverage can be exhaustive without relying on a historical
action count.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMANDS_PATH = ROOT / "cli/moat-cli/src/commands.rs"
MAIN_PATH = ROOT / "cli/moat-cli/src/main.rs"
UNSUPPORTED_COMMANDS_PATH = ROOT / "cli/moat-cli/src/fork_features/unsupported_commands.rs"

# Actions handled without a Controller request.
LOCAL = {
    "state_clean",
    "state_clear",
    "state_list",
    "state_rename",
    "state_show",
}

# Actions composed by the SDK from multiple remote requests or local files.
ORCHESTRATED = {
    "diff_screenshot",
    "diff_snapshot",
    "diff_url",
}

# These actions are deliberately rejected at the moat architecture boundary.
# They remain visible in the inventory and matrix; rejection is not a
# supported success.
UNSUPPORTED = {
    "a11y",
    "auth_delete",
    "auth_list",
    "auth_login",
    "auth_save",
    "auth_show",
    "confirm",
    "deny",
    "inspect",
    "launch",
    "read",
    "react_inspect",
    "react_renders_start",
    "react_renders_stop",
    "react_suspense",
    "react_tree",
    "recording_restart",
    "recording_start",
    "recording_stop",
    "stream_disable",
    "stream_enable",
    "stream_status",
    "vitals",
    "webmcp_cancel",
    "webmcp_invoke",
    "webmcp_list",
    "webmcp_result",
}

# Batch is parsed locally by main.rs and then sends nested commands.  It is
# still part of the public controller action inventory.
CLI_LOCAL_HANDLERS = {"batch"}

TOP_LEVEL_KINDS = {
    "connect": "controller_session",
    "init": "controller_session",
    "disconnect": "controller_session",
    "destroy": "controller_session",
    "close-session": "controller_session",
    "close": "controller_session",
    "use": "local_session",
    "status": "local_session",
    "help": "local_output",
    "--help": "local_output",
    "-h": "local_output",
    "--version": "local_output",
    "-V": "local_output",
    "install": "stable_unsupported",
    "upgrade": "stable_unsupported",
    "dashboard": "stable_unsupported",
    "profiles": "stable_unsupported",
    "session": "stable_unsupported",
    "auth": "stable_unsupported",
    "read": "stable_unsupported",
    "react": "stable_unsupported",
    "vitals": "stable_unsupported",
    "web-vitals": "stable_unsupported",
    "a11y": "stable_unsupported",
    "webmcp": "stable_unsupported",
    "mcp": "stable_unsupported",
    "doctor": "stable_unsupported",
    "skills": "stable_unsupported",
    "plugin": "stable_unsupported",
    "plugins": "stable_unsupported",
    "chat": "stable_unsupported",
    "confirm": "stable_unsupported",
    "deny": "stable_unsupported",
    "inspect": "stable_unsupported",
    "launch": "stable_unsupported",
    "record": "stable_unsupported",
    "stream": "stable_unsupported",
}


def parser_body(source: str) -> str:
    """Ignore parser tests, which are not public command construction paths."""

    return source.split("#[cfg(test)]", 1)[0]


def static_actions(source: str) -> set[str]:
    return set(re.findall(r'"action"\s*:\s*"([a-zA-Z0-9_]+)"', source))


def quoted_actions(source: str) -> set[str]:
    """Compatibility name for callers of the #237-era inventory helper."""

    return static_actions(parser_body(source))


def dynamic_action_sources(source: str) -> dict[str, set[str]]:
    """Resolve known action-valued helper calls without hiding unknown ones."""

    sources: dict[str, set[str]] = {}
    for action in re.findall(r"\bflag\(\s*\"([a-zA-Z0-9_]+)\"\s*\)", source):
        sources.setdefault(action, set()).add("flag")
    for action in re.findall(
        r"\bparse_record_take\(\s*&id\s*,\s*\"([a-zA-Z0-9_]+)\"",
        source,
        re.DOTALL,
    ):
        sources.setdefault(action, set()).add("parse_record_take")
    return sources


def dynamic_action_fields(source: str) -> set[str]:
    return set(
        re.findall(
            r'"action"\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*)',
            source,
        )
    )


def schema_actions(source: str) -> set[str]:
    return set(re.findall(r'action:\s*"\'([a-zA-Z0-9_]+)\'"', source))


def local_top_level_entries(main_source: str) -> tuple[set[str], list[str]]:
    """Extract the pre-parser match in main.rs, not nested command payloads."""

    match = re.search(
        r"match\s+clean\[0\]\.as_str\(\)\s*\{(?P<body>.*?)"
        r"\n\s*_\s*=>\s*\{\}\s*//",
        main_source,
        re.DOTALL,
    )
    if not match:
        return set(), ["main.rs top-level dispatch match was not found"]
    names: set[str] = set()
    body = match.group("body")
    for arm in re.finditer(
        r'(?P<head>(?:"[a-zA-Z0-9_-]+"\s*(?:\|\s*)?)+)\s*=>',
        body,
    ):
        names.update(re.findall(r'"([a-zA-Z0-9_-]+)"', arm.group("head")))
    return names, []


def unsupported_match_body(source: str) -> tuple[str, list[str]]:
    match = re.search(
        r"match\s+command\s*\{(?P<body>.*?)"
        r"\n\s*_ =>",
        source,
        re.DOTALL,
    )
    if not match:
        return "", ["unsupported command match was not found"]
    return match.group("body"), []


def unsupported_top_level_entries(source: str) -> tuple[set[str], list[str]]:
    body, gaps = unsupported_match_body(source)
    if gaps:
        return set(), gaps
    return set(re.findall(r'"([a-zA-Z0-9_-]+)"', body)), []


def unsupported_command_covers_action(action: str, source: str) -> bool:
    roots = {
        "auth_": "auth",
        "react_": "react",
        "webmcp_": "webmcp",
        "recording_": "record",
        "stream_": "stream",
    }
    prefix = next((prefix for prefix in roots if action.startswith(prefix)), None)
    command = roots[prefix] if prefix is not None else action
    body, gaps = unsupported_match_body(source)
    return not gaps and re.search(rf'"{re.escape(command)}"', body) is not None


def top_level_inventory(
    main_source: str, unsupported_source: str
) -> tuple[dict[str, str], list[str]]:
    entries, gaps = local_top_level_entries(main_source)
    unsupported, unsupported_gaps = unsupported_top_level_entries(unsupported_source)
    entries.update(unsupported)
    gaps.extend(unsupported_gaps)
    entries.update({"help", "--help", "-h", "--version", "-V"})

    top_level: dict[str, str] = {}
    unknown: list[str] = []
    for name in sorted(entries):
        kind = TOP_LEVEL_KINDS.get(name)
        if kind is None:
            # An unclassified new branch must not disappear from the report.
            unknown.append(name)
            continue
        top_level[name] = kind
    gaps.extend(f"unclassified top-level entry: {name}" for name in unknown)
    return top_level, gaps


def main() -> None:
    raw_parser = COMMANDS_PATH.read_text()
    parser_source = parser_body(raw_parser)
    schema_source = (ROOT / "packages/types/src/index.ts").read_text()
    sdk = (ROOT / "cli/sdk/src/lib.rs").read_text()
    controller = (ROOT / "packages/controller/src/cdp-bridge.ts").read_text()
    main_source = MAIN_PATH.read_text()
    unsupported_source = UNSUPPORTED_COMMANDS_PATH.read_text()

    static = static_actions(parser_source)
    dynamic_sources = dynamic_action_sources(parser_source)
    dynamic = set(dynamic_sources)
    parser = static | dynamic

    fields = dynamic_action_fields(parser_source)
    resolved_fields: set[str] = set()
    if re.search(r"\bflag\s*=\s*\|[^|]*\bkey\b", parser_source):
        resolved_fields.add("key")
    if "fn parse_record_take" in parser_source:
        resolved_fields.add("action")
    unresolved_dynamic_fields = sorted(fields - resolved_fields)

    classified = LOCAL | ORCHESTRATED | UNSUPPORTED
    controller_actions = parser - classified
    wire_actions = {"eval" if action == "evaluate" else action for action in controller_actions}
    overlap = sorted(
        (LOCAL & ORCHESTRATED)
        | (LOCAL & UNSUPPORTED)
        | (ORCHESTRATED & UNSUPPORTED)
    )
    missing_local_implementation = sorted(LOCAL - parser)
    unknown_classification = sorted(ORCHESTRATED - parser)
    missing_schema = sorted(wire_actions - schema_actions(schema_source))
    missing_execution = sorted(
        action
        for action in controller_actions
        if action not in CLI_LOCAL_HANDLERS
        and action not in sdk
        and ("eval" if action == "evaluate" else action) not in controller
    )
    missing_unsupported_implementation = sorted(
        action
        for action in UNSUPPORTED
        if action in parser
        and action not in sdk
        and action not in controller
        and not unsupported_command_covers_action(action, unsupported_source)
    )
    unsupported_target_gaps = sorted(
        action
        for action in UNSUPPORTED
        if action not in parser
        and not unsupported_command_covers_action(action, unsupported_source)
    )
    missing_orchestration = sorted(action for action in ORCHESTRATED if action not in sdk)
    top_level, top_level_gaps = top_level_inventory(main_source, unsupported_source)

    failures = {
        "unresolved_dynamic_fields": unresolved_dynamic_fields,
        "classification_overlap": overlap,
        "classification_not_in_parser": unknown_classification,
        "missing_schema": missing_schema,
        "missing_execution": missing_execution,
        "missing_unsupported_implementation": missing_unsupported_implementation,
        "unsupported_target_gaps": unsupported_target_gaps,
        "missing_local_implementation": missing_local_implementation,
        "missing_orchestration": missing_orchestration,
        "top_level": top_level_gaps,
    }

    inventory_actions = parser | UNSUPPORTED
    entries = [
        {
            "action": action,
            "sourceKind": "dynamic" if action in dynamic else "static",
            "dynamicSources": sorted(dynamic_sources.get(action, set())),
            "availability": (
                "local"
                if action in LOCAL
                else "orchestrated"
                if action in ORCHESTRATED
                else "stable_unsupported"
                if action in UNSUPPORTED
                else "controller"
            ),
        }
        for action in sorted(inventory_actions)
    ]
    failed = {name: values for name, values in failures.items() if values}
    inventory = {
        "target": {"commandsSource": str(COMMANDS_PATH.relative_to(ROOT))},
        "actions": {
            "controller": sorted(controller_actions),
            "local": sorted(LOCAL & parser),
            "orchestrated": sorted(ORCHESTRATED & parser),
            "stable_unsupported": sorted(UNSUPPORTED),
        },
        "entries": entries,
        "topLevel": top_level,
        "gaps": failed,
        "counts": {
            "parserActions": len(parser),
            "staticActions": len(static),
            "dynamicActions": len(dynamic),
            "uniqueEntries": len(entries),
            "controller": len(controller_actions),
            "local": len(LOCAL & parser),
            "orchestrated": len(ORCHESTRATED & parser),
            "stableUnsupported": len(UNSUPPORTED),
            "targetUnsupported": len(UNSUPPORTED - parser),
            "topLevel": len(top_level),
        },
    }
    print(json.dumps(inventory, indent=2, sort_keys=True))
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
