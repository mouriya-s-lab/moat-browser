#!/usr/bin/env python3
"""Fail when a public CLI action has no explicit moat execution contract."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

LOCAL = {
    "state_clean",
    "state_clear",
    "state_list",
    "state_rename",
    "state_show",
}

ORCHESTRATED = {
    "diff_screenshot",
    "diff_snapshot",
    "diff_url",
}

UNSUPPORTED = {
    "auth_delete",
    "auth_list",
    "auth_login",
    "auth_save",
    "auth_show",
    "confirm",
    "deny",
    "device_list",
    "inspect",
    "launch",
    "recording_restart",
    "recording_start",
    "recording_stop",
    "stream_disable",
    "stream_enable",
    "stream_status",
}

# These are handled by main.rs before parse_command rather than represented as
# BrowserCommand actions.
TOP_LEVEL = {
    "connect": "controller_session",
    "init": "controller_session",
    "disconnect": "controller_session",
    "close-session": "controller_session",
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
}


def quoted_actions(source: str) -> set[str]:
    return set(re.findall(r'"action"\s*:\s*"([a-zA-Z0-9_]+)"', source))


def schema_actions(source: str) -> set[str]:
    return set(re.findall(r'action:\s*"\'([a-zA-Z0-9_]+)\'"', source))


def main() -> None:
    parser = quoted_actions((ROOT / "cli/moat-cli/src/commands.rs").read_text())
    schema = schema_actions((ROOT / "packages/types/src/index.ts").read_text())
    sdk = (ROOT / "cli/sdk/src/lib.rs").read_text()
    controller = (ROOT / "packages/controller/src/cdp-bridge.ts").read_text()

    classified = LOCAL | ORCHESTRATED | UNSUPPORTED
    controller_actions = parser - classified
    wire_actions = {"eval" if action == "evaluate" else action for action in controller_actions}
    missing_schema = sorted(wire_actions - schema)
    overlap = sorted(
        (LOCAL & ORCHESTRATED)
        | (LOCAL & UNSUPPORTED)
        | (ORCHESTRATED & UNSUPPORTED)
    )
    unknown_classification = sorted(classified - parser)

    missing_unsupported_implementation = sorted(
        action
        for action in UNSUPPORTED
        if action not in sdk and action not in controller
    )
    missing_local_implementation = sorted(action for action in LOCAL if action not in sdk)
    missing_orchestration = sorted(action for action in ORCHESTRATED if action not in sdk)

    failures = {
        "missing_schema": missing_schema,
        "classification_overlap": overlap,
        "classification_not_in_parser": unknown_classification,
        "missing_unsupported_implementation": missing_unsupported_implementation,
        "missing_local_implementation": missing_local_implementation,
        "missing_orchestration": missing_orchestration,
    }
    failed = {name: values for name, values in failures.items() if values}
    if failed:
        raise SystemExit(json.dumps(failed, indent=2, sort_keys=True))

    inventory = {
        "actions": {
            "controller": sorted(controller_actions),
            "local": sorted(LOCAL),
            "orchestrated": sorted(ORCHESTRATED),
            "stable_unsupported": sorted(UNSUPPORTED),
        },
        "topLevel": TOP_LEVEL,
        "counts": {
            "parserActions": len(parser),
            "controller": len(controller_actions),
            "local": len(LOCAL),
            "orchestrated": len(ORCHESTRATED),
            "stableUnsupported": len(UNSUPPORTED),
            "topLevel": len(TOP_LEVEL),
        },
    }
    print(json.dumps(inventory, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
