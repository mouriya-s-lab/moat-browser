pub fn help_text() -> &'static str {
    r#"moat - remote Chromium automation through the moat Controller

Usage: moat <command> [args] [options]

Session:
  init | connect               Create a Controller-managed browser session
  status                       Show local session/config; does not probe Controller health
  disconnect | destroy | close-session | close
                               Destroy the active session; failures retain ~/.moat/session


Navigation and page actions:
  open <url> | back | forward | reload
  click | dblclick | type | fill | hover | focus | check | uncheck | select
  click <selector> [--new-tab]   Open an HTTP(S) link in a new active tab
  press | keyboard | keydown | keyup | drag | mouse | tap | swipe | scroll
  scroll --selector             Scroll only the matching active-page element;
                                 output reports measured movement and clipping
  keydown/keyup                 Explicit held-key pairing; high-level input
                               rejects while a modifier remains held
  mouse down/up                 Explicit held-button pairing; high-level input
                                 rejects while a mouse button remains held
  wait | find | get | is | eval | highlight
  get text <selector> [--all|--nth <index>]
                               Strict by default; --all reads all matches in order
                               and --nth reads one zero-based match


Page artifacts and state:
  snapshot                     Accessibility snapshot; supports -i/-c/-d/-s
  screenshot                   PNG/JPEG, selector/full-page, and --annotate
  pdf | upload | download | wait --download
  cookies | storage | state
  trace | profiler | network har

Browser and runtime state:
  tab | window | frame | dialog | clipboard
  dialog accept|dismiss|status|result
  window new                   Open a new tab in the shared browser context
  device list                  List remote Chromium emulation descriptors
  set viewport|device|geo|offline|headers|credentials|media
  network route|unroute|requests|request
                                 requests is bounded metadata pagination;
                                 request bodies are explicit readiness states
                                 with continuation chunks; har stop verifies
                                 an owner-scoped artifact before returning a path

Unavailable in moat architecture (stable unsupported_in_moat error):
  auth                         Authentication uses moat profiles + neko login
  confirm | deny               No CLI-local action-policy layer
  inspect                      CDP is private and Controller-managed
  launch | connect <port|url>  Controller creates CDP targets
  record                       Video recording is outside the Controller contract
  stream                       Live viewing uses neko WebRTC
  get cdp-url                  Private container CDP is Controller-only
  install | upgrade | dashboard | profiles | session

Global options:
  --json                       Emit exactly one JSON value per command
  --controller <url>           Use this Controller for network commands in this invocation
  --annotate                   Number interactive elements in screenshots
  --screenshot-format <fmt>    png or jpeg
  --screenshot-quality <n>     JPEG quality 0-100
  --screenshot-dir <path>      Default screenshot output directory
  --content-boundaries         Wrap untrusted page text with boundaries
  --max-output <chars>         Truncate page text output
  --headers <json>             Apply headers before navigation
  --version, -V                Show version
  --help, -h                   Show this help or command help

Environment:
  MOAT_CONTROLLER              Controller WebSocket URL
  ~/.moat/session              Active session ID
  ~/.moat/config.json          Optional Controller configuration

Examples:
  moat init
  moat open https://example.com
  moat snapshot -i
  moat screenshot --annotate ./page.png
  moat diff screenshot --baseline ./before.png --output ./diff.png
  moat disconnect"#
}

/// Moat-specific command help without inheriting upstream's local-browser
/// daemon, named-session, or browser-launch claims.
pub fn command_help_text(command: &str) -> Option<String> {
    let usage = match command {
        "init" => "init [--profile <name>] [--controller <url>]",
        "connect" => "connect [--profile <name>] [--controller <url>]",
        "use" => "use <session-id>",
        "status" => "status",
        "disconnect" | "destroy" | "close-session" | "close" => "disconnect",
        "open" | "goto" | "navigate" => "open <url> [--headers <json>]",
        "back" => "back",
        "forward" => "forward",
        "reload" => "reload",
        "click" => "click <selector> [--new-tab]",
        "dblclick" => "dblclick <selector>",
        "fill" => "fill <selector> <text>",
        "type" => "type <selector> <text>",
        "hover" => "hover <selector>",
        "focus" => "focus <selector>",
        "check" => "check <selector>",
        "uncheck" => "uncheck <selector>",
        "select" => "select <selector> <value...>",
        "drag" => "drag <source> <target>",
        "upload" => "upload <selector> <file...>",
        "download" => "download <selector> <output-path>",
        "press" | "key" => "press <key>",
        "keydown" => "keydown <key>",
        "keyup" => "keyup <key>",
        "keyboard" => "keyboard <type|inserttext> <text>",
        "scroll" => "scroll <up|down|left|right> [pixels] [--selector <sel>]",
        "scrollintoview" | "scrollinto" => "scrollintoview <selector>",
        "wait" => "wait <selector|milliseconds|--text|--url|--load|--fn|--download> [value] [--timeout <ms>]  # integer 1-120000ms; default 25000ms",
        "screenshot" => "screenshot [selector] [output-path] [--full|-f] [--annotate]",
        "pdf" => "pdf [output-path]",
        "snapshot" => "snapshot [-i] [-c] [-d <depth>] [-s <selector>]",
        "eval" => "eval <javascript> [selector]",
        "get" => "get <url|title|text|html|value|attr|count|box|styles> [argument] [--all|--nth <index>]",
        "is" => "is <visible|enabled|checked> <selector>",

        "find" => "find <role|text|label|placeholder|alt|title|testid|first|last|nth> ...",
        "mouse" => "mouse <move|down|up|wheel> ...",
        "device" => "device list",
        "set" => "set <viewport|device|geo|offline|headers|credentials|media> ...",
        "network" => "network <route|unroute|requests|request|har> ...",
        "storage" => "storage <local|session> <get|set|clear> ...",
        "cookies" => "cookies <get|set|clear> ... (set uses either --url or --domain/--path, never both)",
        "tab" => "tab <new|list|switch|close> ...",
        "window" => "window new",
        "dialog" => "dialog <accept|dismiss|status|result> [text|operation-id]",
        "trace" => "trace <start|stop> [output-path]",
        "profiler" => "profiler <start|stop> [output-path]",
        "console" => "console [--clear]",
        "errors" => "errors [--clear]",
        "highlight" => "highlight <selector>",
        "clipboard" => "clipboard <read|write> [text]",
        "state" => "state <save|load|list|show|rename|clean|clear> ... (clear --all requires --confirm/--yes; missing confirmation: missing_arguments)",
        "tap" => "tap <selector>",
        "swipe" => "swipe <up|down|left|right> [distance]",
        "diff" => {
            return Some(
                concat!(
                    "moat diff\n\nUsage: moat diff <snapshot|screenshot|url> ...\n\n",
                    "Without --baseline, `diff snapshot` initializes this session's baseline on the\n",
                    "first invocation and reports that initialization instead of a comparison; later\n",
                    "invocations compare against the previous snapshot.\n",
                    "`diff screenshot` reports a diff image only when --output is given and a diff\n",
                    "image was actually written.\n",
                    "`diff url` compares in a temporary tab and restores the calling page.\n\n",
                    "This command runs against the active Controller-managed session.\n",
                    "Options: --json emits exactly one JSON value. Run `moat --help` for global options.",
                )
                .to_string(),
            );
        }
        "batch" => "batch  # reads a JSON command array from stdin",
        "auth" | "confirm" | "deny" | "inspect" | "record" | "stream" | "install"
        | "upgrade" | "dashboard" | "profiles" | "session" | "launch" => {
            return Some(format!(
                "moat {command} - unavailable in the moat Controller architecture\n\n\
                 This command returns a nonzero unsupported_in_moat error.\n\
                 Run `moat --help` for the supported alternative."
            ));
        }
        _ => return None,
    };

    let description = match command {
        "scroll" => {
            "Without --selector, scrolls the active window. With --selector, scrolls only the first matching element in the active page/frame and leaves the window unchanged. Successful output reports before/after positions, actual delta, maximum position, and boundary clipping; missing selectors return target_not_found and non-scrollable axes return invalid_value."
        },
        "get" => {
            "text is strict for one match by default; use `--all` for all matches or `--nth <index>` for one zero-based match. `attr` reports missing versus present-empty explicitly, and `styles` preserves fractional geometry with a distinct no-layout state."
        },
        "is" => {
            "`is visible` reports layout visibility only. It does not prove opacity, occlusion, perceptual visibility, interactivity, or click safety."
        },
        "eval" => {
            "Results preserve scalar, object, array, and undefined values after one serialization; undefined is marked explicitly and is distinct from an empty string, empty object, or void success. A non-Error throw is reported as command_failed with cause cdp and readable structured details rather than Object."
        },
        "click" => {
            "With --new-tab, open a non-empty HTTP(S) link in a new active tab and leave the original tab unchanged; elements without an openable link are rejected."
        },
        "find" => {
            "first, last, and nth support click, fill, type, hover, dblclick, focus, select, check, and uncheck; unknown actions and invalid occurrences fail before page side effects."
        },
        "network" => {
            "route accepts only --abort and --body <json>; network requests returns bounded metadata pages (--page-token/--page-size), request detail reports pending/complete/absent/failed body readiness and resumable base64 chunks (--continuation/--chunk-size), and HAR stop returns a path only after owner-scoped artifact length and JSON entry verification."
        },
        "console" | "errors" => {
            "Diagnostics include category, session/page/frame identity, event-time page/frame URLs, and a timestamp; browser resource and policy failures are included."
        },
        "keydown" | "keyup" => {
            "Low-level key state is explicit and paired; high-level input rejects while a modifier remains held."
        },
        "mouse" => {
            "Low-level mouse down/up operations are explicitly paired and return the currently held buttons in `heldMouseButtons`; high-level input rejects while a button remains held, while mouse move, wheel, and up stay available for drag gestures."
        },
        "device" => "List remote Chromium descriptors usable by `set device`.",
        "tab" => {
            "Closing the last remaining tab is rejected before page close with `errorType: \"invalid_value\"` and the stable message `Validation failed: Cannot close the last tab; at least one tab must remain open`; use `moat disconnect` when the whole session should be destroyed. If browser-side events leave no open pages, commands return `errorType: \"target_not_found\"` for `page` without ending the session."
        },
        "dialog" => {
            "Dialog status and handling are Page-scoped. An eval-triggered modal waits up to 3s for explicit accept/dismiss so a concurrent client receives the original result; within grace eval returns its script result, otherwise eval returns a pending operation handle. Complete it with `dialog accept|dismiss`, then inspect the settled value with `dialog result <operation-id>`. If the command deadline wins first, `dialog result <operation-id>` returns a structured `TimedOutOperation` with phase, budget, possible side effects, session, dialog, operation, and Page identity; the modal remains handleable and the session stays usable. A command sent to the same Page while its modal is pending is rejected before page side effects with `cause: \"dialog_pending\"` and the operation/dialog/Page identities."
        },
        "status" => {
            "Show the local session/config view; this command does not probe remote Controller health."
        },
        "cookies" => {
            "Cookie scope is URL-only or domain/path-only; combining --url with --domain or --path is rejected before writing."
        },
        "state" => {
            "State names resolve under ~/.moat/states; explicit paths stay explicit. State save/load preserves IndexedDB and per-tab sessionStorage. `state clear --all` requires --confirm (or --yes); missing confirmation returns `errorType: \"missing_arguments\"` without reading stdin or changing files."
        },
        _ => "This command runs against the active Controller-managed session.",
    };
    Some(format!(
        "moat {command}\n\nUsage: moat {usage}\n\n\
         {description}\n\
         Options: --json emits exactly one JSON value. Run `moat --help` for global options."
    ))
}

#[cfg(test)]
mod tests {
    use super::command_help_text;

    #[test]
    fn recognizes_supported_and_unavailable_commands() {
        for command in ["open", "snapshot", "network", "state", "auth", "stream"] {
            assert!(command_help_text(command).is_some());
        }
        assert!(command_help_text("not-a-command").is_none());
    }
}
