# Upstream CLI sync manifest

This fork keeps the upstream command vocabulary where the moat Controller and
Rust SDK can execute the request. The CLI is a file-level sync, not a claim that
moat contains the upstream local daemon, browser launcher, plugin runner, or
network document reader.

## Immutable inputs

| Name | Object |
|---|---|
| baseline the candidate patches apply against | `f327c097` (pre-#237, pre-#224-tree) |
| abandoned integrated candidate (spec) | `f285ba48` (= `f327c097` + #226 + #225 + #227 + #228) |
| re-integration target | current `main` HEAD (has #229 + all of #237) |

The #224 tree (#225 CLI sync, #226 param alignment, #227 page navigation and
init scripts) was implemented and merged into abandoned stacked branches that
never reached `main`. Since then umbrella #237 (dogfood hardening) rewrote the
same files on `main`. This manifest records the re-implementation of the #224
CLI surface **onto** post-#237 `main`, using the abandoned candidate as the
spec. The candidate is not applied as a patch: it conflicts with #237, so the
intent was ported and reconciled.

## #237 reconciliation decisions

Post-#237 behaviour is preserved; the #224 additions are layered on top. Where
the candidate assumed pre-#237 shapes, the port follows `main`:

| Area | Candidate (pre-#237) assumption | Re-integrated on `main` |
|---|---|---|
| `wait <ms>` | bare millisecond argument emitted `timeout` | `main` emits `time` (a fixed-duration sleep) distinct from the `--timeout` condition budget; kept. Default-timeout injection therefore never touches the `time` form. |
| default wait timeout | injected only when `AGENT_BROWSER_DEFAULT_TIMEOUT` was set | injected into every wait-family command lacking an explicit `--timeout` (and lacking `time`), defaulting to 25000ms when the env var is absent/malformed/non-positive. |
| `network route --body` | emitted `response.body`, normalized back to `body` in `cli/sdk` | `main` already emits `body` on the wire; the `response.body` round-trip and its SDK normalization are dropped. Only `resourceType` is added. #237's rejection of `--status`/`--delay`/`--headers` is kept. |
| `find` semantic subactions | added subaction detection to the pre-#237 parser | layered onto #237's `first`/`last`/`nth` grammar; per-locator subaction sets and value passthrough added without changing the numeric-locator behaviour. |
| help surface | `print_command_help`/`print_help` text blocks | adapted to #237's `command_help_text`/`help_text`. |
| state summary test | pinned a two-field `{cookies, origins}` summary | corrected to #237's shipped four-field `{cookies, origins, tabs, indexedDB}` summary (production `local_state_show` unchanged). |

## File-level decisions

| Fork file | Decision |
|---|---|
| `moat-cli/src/commands.rs` | Retain moat's numeric `index` tab wire and existing branches. Add: `type --clear/--delay`, `snapshot -u/--urls`, `network route --resource-type`, `network har start --content <all\|text\|none>`, semantic-locator `find` subactions + value passthrough, the `pushstate`/`addinitscript`/`removeinitscript` arms, inline `batch` command collection + `shell_words_split`, and the wait-family default-timeout wrapper. `tab --label` and non-numeric tab references return `unsupported_in_moat` before a tab is created. |
| `moat-cli/src/flags.rs` | Import `AGENT_BROWSER_DEFAULT_TIMEOUT` as an optional millisecond value (`resolve_default_timeout`, default 25000). Launcher/plugin flags are rejected by `unsupported_flags.rs`, not parsed into a no-op. |
| `moat-cli/src/main.rs` | Keep moat WebSocket transport and the `{success,data:{results}}` batch envelope. Inline batch args are shell-split locally; absent inline args preserve the JSON argv-array stdin path. Each batch item applies the same unsupported command/flag boundary before parsing; failing items are retained, execution continues by default, `--bail` stops after a failure, and either mode exits 1 when any item fails. Non-empty `AGENT_BROWSER_INIT_SCRIPTS`/`AGENT_BROWSER_ENABLE` are rejected at startup. |
| `moat-cli/src/output.rs` | Keep moat response/error formatting. Add readable success lines for runtime init-script registration/removal; `pushstate` keeps the returned-URL response path. Upstream's `print_command_help`/`print_help`/`print_version` are not carried: when an upstream merge reintroduces them, drop them from this file and port any wording that applies to a moat-supported command into `fork_features/help.rs`. |
| `moat-cli/src/fork_features/help.rs` | The only help text in the CLI (`help_text`/`command_help_text`, rendered by `main.rs`). Document supported moat syntax, inline/stdin batch forms, numeric-tab limitation, page-navigation/init-script commands, the default timeout, and the explicit unsupported families/startup environments. |
| `moat-cli/src/fork_features/unsupported_commands.rs` | Central boundary for `read`, `react`, `vitals`/`web-vitals`, `a11y`, `webmcp`, and `mcp`/`doctor`/`skills`/`plugin`/`plugins`/`chat`, plus the existing local-orchestration families. Errors are stable `unsupported_in_moat` values, not `Unknown command`. |
| `moat-cli/src/fork_features/unsupported_flags.rs` | Central boundary for target-only launcher/plugin flags and `unsupported_environment()`. Detection preserves arbitrary text/script operands (for example `fill #input --model`, `type #input --verbose`) while rejecting the same flags in genuine option positions. |
| `cli/sdk/src/lib.rs` | Preserve the moat WebSocket transport and file materialization. Forward the snapshot `urls` option; `route` `body`/`resourceType` and the 227 actions pass through the existing JSON command envelope unchanged. |
| `cli/moat-cli/src/connection.rs` | Unchanged moat SDK WebSocket transport. |

## Public syntax accounting against target

Entries marked `unsupported_in_moat` are deliberate capability boundaries, not
parser omissions and not fake success paths.

| Target entry | Moat result |
|---|---|
| `pushstate <url>` | Supported; forwarded as `action: "pushstate"`. |
| `addinitscript <script>` | Supported; forwarded as `action: "addinitscript"`; the returned identifier is per tab/session and applies to future documents only. |
| `removeinitscript <identifier>` | Supported; forwarded as `action: "removeinitscript"`; removal of an identifier owned by another tab/session is rejected. |
| `type <selector> <text> [--clear] [--delay <ms>]` | Supported; `--clear`/`--delay` are command options, never part of the typed text. |
| `snapshot [-u\|--urls]` | Supported; requests DOM-resolved link hrefs. |
| `network route ... [--resource-type <csv>]` | Supported; `--body` kept; `--status`/`--delay`/`--headers` remain rejected. |
| `network har start [--content <all\|text\|none>]` | Supported; default (omitted) is the Controller's `text` mode. |
| `find <locator> <value> [action] [text]` | Supported; per-locator subaction sets with value passthrough; `fill`/`type` require a value. |
| `batch [--bail] ["command ..." ...]` | Supported with local shell splitting and the moat envelope; JSON argv arrays from stdin remain supported. |
| `tab new --label <name>` and string tab references | Explicit `unsupported_in_moat`; numeric `index` remains the protocol contract. |
| `read`, `react`, `vitals`, `web-vitals`, `a11y`, `webmcp` | Explicit `unsupported_in_moat`; the upstream fetch/native/plugin runtime is not imported. |
| `mcp`, `doctor`, `skills`, `plugin`, `plugins`, `chat` | Explicit `unsupported_in_moat`; no moat Controller contract. |
| local lifecycle (`install`, `upgrade`, `profiles`, `session`, `dashboard`, `launch`, `record`, `stream`, `device`, `auth`, `confirm`, `deny`, `inspect`) | Existing moat unsupported boundary; `device list` remains supported. |

### Target-only global flags and environments

Rejected by `unsupported_flags.rs` instead of being accepted and discarded:
`--restore`/`--restore=<name>`, `--restore-save`, `--restore-check-url`,
`--restore-check-text`, `--restore-check-fn`, `--namespace`, `--init-script`,
`--enable`, `--webgpu`, `--no-webmcp`, `--ca-cert`, `--no-ca-cert`,
`--hide-scrollbars`, `--pin-tab`, `--no-pin-tab`, `--no-xvfb`, `--model`,
`--verbose`/`-v`, and `--quiet`/`-q`. Non-empty `AGENT_BROWSER_INIT_SCRIPTS` and
`AGENT_BROWSER_ENABLE` are rejected at process startup.
`AGENT_BROWSER_DEFAULT_TIMEOUT` is the one target environment addition imported
here; it is injected only when a wait-family request has no explicit
`--timeout`.

## Intentional boundaries

- `tab --label` is not silently accepted: moat uses numeric tab indexes and the
  request fails before a tab is created.
- `--init-script` and `AGENT_BROWSER_INIT_SCRIPTS` are startup configuration for
  the upstream local launcher. They are not runtime page init scripts (that is
  `addinitscript`); moat rejects them rather than silently ignoring them.
- The upstream read, React, vitals, a11y, WebMCP, and local orchestration
  families are explicit unsupported capabilities, not parser omissions.
- Batch output remains one moat response envelope even though upstream prints a
  native JSON array. This is a CLI output compatibility boundary, not a wire
  protocol migration.
