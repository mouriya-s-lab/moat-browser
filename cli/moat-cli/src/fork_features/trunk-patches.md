# Trunk patches

The upstream `parse_command` and batch runner have no option-registration hook
or fork-feature dispatch seam, so the moat option patches live directly in the
upstream branches rather than in a `fork_features` module. Each entry below is a
narrow, tracked patch that emits the existing wire action names.

| File / branch | Missing extension seam | Why it stays a direct patch |
|---|---|---|
| `commands.rs` `type` branch | `parse_command` has no per-command option hook. | `--clear`/`--delay` are parsed before the existing `type` request is built, keeping the flags out of the typed-text payload. A separate parser would duplicate the whole command match. |
| `commands.rs` `snapshot` branch | No option-registration hook for snapshot flags. | `-u`/`--urls` is added inline; the option is consumed by the existing SDK snapshot adapter. |
| `commands.rs` `parse_network` route/har | No registration seam for route or HAR subcommands. | `--resource-type` (route) and `--content` (har start) are added to the existing subcommand grammar, which already emits `route`/`har_start`. #237's rejection of route `--status`/`--delay`/`--headers` is preserved. |
| `commands.rs` `parse_find` | No action/value extension hook. | Semantic-locator subactions and value passthrough are selected in the one upstream `find` match. `getby_subaction_allowed` enforces the per-locator subset; `first`/`last`/`nth` keep the #237 numeric-locator grammar. |
| `commands.rs` `parse_command` wait wrapper | No parser extension hook for wait-family flag handling. | `parse_command` wraps `parse_command_inner` to inject the environment default timeout into wait-family results that carry no explicit `--timeout` (and are not the fixed-duration `time` form). |
| `commands.rs` `pushstate`/`addinitscript`/`removeinitscript` | No parser registration hook for runtime script commands. | These enter the command match so they reach the shared 227 wire actions. |
| `commands.rs` `tab` branch | Upstream tab parser assumes string tab IDs/labels; moat's protocol is numeric `index`. | The fork keeps numeric tab requests and rejects `--label`/label references before a request is sent. |
| `commands.rs` `batch` branch + `main.rs` `run_batch` | Upstream `run_batch` emits a native result array and depends on its local daemon sender. | The moat transport needs one `{success,data:{results}}` envelope, existing stdin argv arrays, inline shell-split commands (`shell_words_split`), per-item unsupported command/flag boundaries, `--bail`, and continue-by-default with exit 1 on any failure. |
| `fork_features/unsupported_commands.rs` / `unsupported_flags.rs` | Upstream has no moat capability-boundary registration API. | These modules reject target syntax whose local daemon/plugin/read runtime is absent, preventing parser acceptance from becoming silent no-op behaviour, while `is_positional_operand` preserves arbitrary text/script operands. |
