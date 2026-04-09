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

The CLI binary (`moat-cli/`) currently has a minimal implementation:
- `connect`/`disconnect`/`status` subcommands — fully functional via moat-sdk
- Command passthrough — simplified (not yet using upstream's `parse_command`)

**Next step**: Copy upstream's CLI source files into `moat-cli/src/`, replace
`connection.rs`, and add the moat-specific subcommands to `main.rs`.
