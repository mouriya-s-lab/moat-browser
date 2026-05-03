# Upstream Sync — agent-browser

## Upstream Remote

```
https://github.com/vercel-labs/agent-browser.git
```

## Fork Strategy

moat CLI is a fork of `vercel-labs/agent-browser`. The fork retains the entire CLI
codebase (commands, output formatting, flags, exit codes) and replaces only the
transport layer.

## Modified Files

| File | Change |
|------|--------|
| `moat-cli/src/connection.rs` | **Replaced**: Unix socket/TCP → moat-sdk WebSocket |
| `moat-cli/src/main.rs` | **Extended**: added `connect`/`disconnect`/`status` subcommands |

## Unmodified Files (keep upstream sync)

- `commands.rs` — command parsing (all action JSON construction)
- `output.rs` — response formatting and display
- `flags.rs` — CLI flag definitions
- `validation.rs` — input validation
- `color.rs` — terminal color helpers
- All other upstream files

## Sync Procedure

```bash
cd cli
git fetch upstream
git merge upstream/main
```

Only `connection.rs` and `main.rs` will produce merge conflicts.

## Workspace Layout

```
cli/
├── Cargo.toml          # Workspace root
├── sdk/                # moat-sdk (new, not from upstream)
│   └── src/
├── moat-cli/           # CLI binary (fork of upstream cli/)
│   └── src/
│       ├── main.rs         # Modified
│       ├── connection.rs   # Replaced
│       ├── commands.rs     # From upstream (unmodified)
│       ├── output.rs       # From upstream (unmodified)
│       └── ...
└── UPSTREAM.md         # This file
```

## Current State

The CLI binary (`moat-cli/`) is feature-complete with upstream parity:
- `connect`/`disconnect`/`status` subcommands — moat-specific, via moat-sdk
- All upstream commands — routed through `parse_command` (commands.rs) + `send_command` (connection.rs)
- Output formatting — upstream's `output.rs` handles JSON/text rendering
- Validation — upstream's `validation.rs` for input checks

**Upstream files integrated**: `commands.rs`, `output.rs`, `flags.rs`, `validation.rs`, `color.rs`
