# Upstream Sync — agent-browser

## Upstream Remote

```
https://github.com/vercel-labs/agent-browser.git
```

## Fork Strategy

moat CLI is a fork of `vercel-labs/agent-browser`. The fork retains the upstream
command vocabulary, exit-code conventions, and transport boundary while routing
remote execution through moat-sdk. Fork-only behavior is isolated in
`fork_features/` where a registration seam exists; parser branches without an
upstream extension seam are tracked as narrow trunk patches.

## Modified Files

| File | Change |
|------|--------|
| `moat-cli/src/connection.rs` | **Replaced**: Unix socket/TCP → moat-sdk WebSocket |
| `moat-cli/src/main.rs` | **Extended**: added `connect`/`disconnect`/`status` and per-invocation Controller selection |
| `moat-cli/src/flags.rs` | **Extended**: parse and clean `--controller` while preserving missing-value boundaries |
| `moat-cli/src/commands.rs` | **Narrow patches**: parse `type --clear`/`--delay`, `snapshot --urls`, `network route --body`/`--resource-type`, HAR `--content`, and complete `find` locator payloads |
| `moat-cli/src/output.rs` | **Extended**: help and output text for snapshot URLs, route filters, and HAR content modes |
| `moat-cli/src/fork_features/help.rs` | **Extended**: moat-specific help for the added command options |
| `moat-cli/src/fork_features/unsupported_flags.rs` | **Extended**: reject `--controller` on local-only `use` |
| `cli/sdk/src/lib.rs` | **Extended**: normalize route response bodies, forward snapshot URL options, and materialize HAR artifacts |
| `moat-cli/src/fork_features/trunk-patches.md` | Records why the `commands.rs` parser branch cannot use an extension module |

## Unmodified Files (keep upstream sync)

- `validation.rs` — input validation
- `color.rs` — terminal color helpers
- Controller and protocol changes live outside the upstream CLI fork

## Sync Procedure

```bash
cd cli
git fetch upstream
git merge upstream/main
```

`commands.rs`, `output.rs`, `flags.rs`, `main.rs`, and `fork_features/` need review
when syncing because moat's remote transport and command-option patches must be
reapplied or replaced if upstream changes those branches.

## Workspace Layout

```
cli/
├── Cargo.toml          # Cargo workspace root
├── sdk/                # moat-sdk (new, not from upstream)
│   └── src/
├── moat-cli/           # CLI binary (fork of upstream cli/)
│   └── src/
│       ├── main.rs         # Modified
│       ├── connection.rs   # Replaced
│       ├── commands.rs     # Upstream parser plus tracked moat option patches
│       ├── flags.rs        # Modified for Controller selection
│       ├── output.rs       # Modified help/output text
│       └── ...
└── UPSTREAM.md         # This file
```

## Current State

The CLI binary (`moat-cli/`) routes remote commands through moat-sdk:
- `connect`/`disconnect`/`status` subcommands — moat-specific, via moat-sdk
- Per-invocation `--controller` precedence — CLI flag, environment, then config
- Upstream commands plus the tracked type, snapshot, route, HAR, and locator patches
- Output formatting — moat's remote response and artifact handling
- Validation — upstream's `validation.rs` for input checks
