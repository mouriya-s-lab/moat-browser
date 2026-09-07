# Upstream CLI sync manifest

This fork keeps the upstream command vocabulary where the moat Controller and Rust
SDK can execute the request. The CLI remains a file-level sync, not a claim that
moat contains the upstream local daemon, browser launcher, plugin runner, or
network document reader.

## Immutable inputs

| Name | Object |
|---|---|
| baseline (ours) | `c385479ec68573d218227218e5c4ab6a2f832291` |
| comparison reference | `44f37c92d3713e0c6f00841bb1bec317d605d018` |
| upstream target | `vercel-labs/agent-browser@4726eceeb3274eef34ab082ee04d7288c54dec70` |
| target checkout | local git worktree at the target object; never reconstructed from a GitHub source API |

The baseline is recorded as a commit rather than inferred from a merge base. The
fork history does not provide a usable `HEAD..upstream/main` merge base, so a
repeatable sync compares the immutable baseline and target files directly before
applying the scoped fork changes.

## File-level decisions

| Fork file | Upstream target comparison | Decision and reason |
|---|---|---|
| `moat-cli/src/commands.rs` | target adds centralized wait timeout injection, shell-split inline batch, tab labels, and local-runtime command families | Retain moat's numeric `index` tab wire and existing command branches. Import wait-family timeout handling and inline batch strings/shell splitting. Tab labels return an explicit `unsupported_in_moat` parser error without creating a tab. Target command families that require the upstream local runtime remain explicit unsupported capabilities. |
| `moat-cli/src/flags.rs` | target adds `default_timeout` plus launcher/plugin flags (`--init-script`, `--enable`, provider/runtime, restore, WebGPU, WebMCP, CA, pin-tab, etc.) | Import `AGENT_BROWSER_DEFAULT_TIMEOUT` as an optional millisecond value. Do not parse launcher/plugin flags into a no-op: `unsupported_flags.rs` rejects target-only flags that require the upstream local runtime. `--controller` and moat session configuration remain fork behavior. |
| `moat-cli/src/main.rs` | target passes inline batch commands to `run_batch` and emits native arrays; target also owns local daemon lifecycle | Keep moat WebSocket transport and the `{success,data:{results}}` batch envelope. Inline arguments are shell-split locally; absent inline arguments preserve the JSON argv-array stdin entry point. Each batch item applies the same unsupported command/flag boundary before parsing, so target-only capabilities cannot become a silent no-op. Failure items are retained, execution continues by default, `--bail` stops after the failure, and either mode exits 1 when any item fails. Non-empty `AGENT_BROWSER_INIT_SCRIPTS`/`AGENT_BROWSER_ENABLE` are rejected rather than silently ignored. |
| `moat-cli/src/output.rs` | target adds local-daemon lifecycle renderers | Keep moat response/error formatting and numeric-tab display. No local-daemon renderer is imported; runtime page navigation and init-script output belong to the separate navigation/script lifecycle implementation. |
| `moat-cli/src/fork_features/help.rs` | target help documents the complete local-browser surface | Help lists the supported moat syntax, inline/stdin batch forms, numeric-tab limitation, default timeout, and explicit unsupported target families/startup environments. It does not advertise local daemon/plugin behavior or runtime navigation/script commands not included in this candidate. |
| `moat-cli/src/fork_features/unsupported_commands.rs` | target parser accepts runtime families absent from moat | Central fork boundary for read, React, vitals, a11y, WebMCP, and target local orchestration commands. Errors are stable `unsupported_in_moat` values rather than `Unknown command`. |
| `moat-cli/src/fork_features/unsupported_flags.rs` | target flags are accepted by the local launcher | Central fork boundary for target-only launcher/plugin flags and existing Controller-owned/local-daemon flags. |
| `cli/sdk/src/lib.rs` | target native daemon handles target actions; moat SDK owns WebSocket and file materialization | Do not import the target daemon. Preserve the accepted remote CLI/SDK adaptations and the moat WebSocket transport. |
| `cli/moat-cli/src/connection.rs` | target uses Unix socket/TCP daemon transport | Keep the moat SDK WebSocket transport unchanged. |

## Public syntax accounting against target

The target additions are accounted for individually; entries marked
`unsupported_in_moat` are deliberate capability boundaries rather than parser
omissions.

### Top-level commands

| Target entry | Moat result in this candidate |
|---|---|
| `batch [--bail] ["command ..." ...]` | Supported with local shell splitting and the moat envelope; JSON argv arrays from stdin remain supported. |
| `tab new --label <name>` and string tab references | Explicit `unsupported_in_moat`; numeric `index` remains the protocol contract. |
| `read`, `react`, `vitals`, `web-vitals`, `a11y`, `webmcp` | Explicit `unsupported_in_moat`; the upstream fetch/native/plugin runtime is not imported. |
| `mcp`, `doctor`, `skills`, `plugin`, `plugins`, `chat` | Explicit `unsupported_in_moat`; these target local orchestration/plugin paths have no moat Controller contract. |
| target local lifecycle (`install`, `upgrade`, `profiles`, `session`, `dashboard`, `launch`, `record`, `stream`, `device`, `auth`, `confirm`, `deny`, `inspect`) | Existing moat unsupported boundary remains explicit and machine-readable. |
| `pushstate`, `addinitscript`, `removeinitscript` | Deferred to the separate page-navigation and init-script implementation; this candidate does not advertise or claim those commands. |
| `open` with no URL | Not imported: moat sessions are created by `init`; `open` requires a navigation URL. |

### Target-only global flags and environments

The following target flags are rejected by `unsupported_flags.rs` instead of
being accepted and discarded: `--restore`/`--restore=<name>`, `--restore-save`,
`--restore-check-url`, `--restore-check-text`, `--restore-check-fn`,
`--namespace`, `--init-script`, `--enable`, `--webgpu`, `--no-webmcp`,
`--ca-cert`, `--no-ca-cert`, `--hide-scrollbars`, `--pin-tab`,
`--no-pin-tab`, `--no-xvfb`, `--model`, `--verbose`/`-v`, and
`--quiet`/`-q`. Non-empty `AGENT_BROWSER_INIT_SCRIPTS` and
`AGENT_BROWSER_ENABLE` are rejected at process startup for the same reason.
`AGENT_BROWSER_DEFAULT_TIMEOUT` is the one target environment addition imported
in this sync; it is injected only when a wait-family request has no explicit
`--timeout`.

Unsupported-flag detection preserves arbitrary text/script operands (for
example `fill #input --model` and `type #input --verbose`) while rejecting these
flags in global positions; this prevents the capability boundary from changing
the existing text payload contract.

### Target output families

Target-only WebMCP, vitals, a11y, React tree/render, local daemon lifecycle, and
native batch-array renderers are not copied. Moat keeps its response formatter
and retains the `{success,data:{results}}` envelope for both inline and stdin
batch modes.

## Reproducible sync procedure

1. Check out the immutable baseline and target objects in local worktrees. Do not
   reconstruct source files from a repository API.
2. Compare `cli/moat-cli/src/commands.rs`, `flags.rs`, `main.rs`, and `output.rs`
   by symbols, then inspect the fork feature files and the `cli/sdk` boundary.
3. Apply only the retained upstream syntax and the fork patches recorded in
   `fork_features/trunk-patches.md`; preserve the moat SDK transport and JSON
   envelope.
4. Keep unsupported target-only commands and flags at the fork boundary with a
   stable `unsupported_in_moat` result. Do not import upstream `native`, `read`,
   plugin, or launcher modules merely because a parser helper references them.
5. Preserve the separate implementation boundary for page navigation and
   runtime init scripts; do not claim those commands from this CLI sync alone.

## Intentional boundaries

- `tab --label` is not silently accepted: moat continues to use numeric tab
  indexes, and the request fails before a tab is created.
- `--init-script` and `AGENT_BROWSER_INIT_SCRIPTS` are startup configuration for
  the upstream local launcher. They are not runtime page init scripts; moat
  rejects them until a complete transport path exists.
- The upstream read, React, vitals, a11y, WebMCP, and local orchestration
  families are explicit unsupported capabilities, not parser omissions and not
  fake success paths.
- Batch output remains one moat response envelope even though upstream prints a
  native JSON array. This is a CLI output compatibility boundary, not a wire
  protocol migration.
