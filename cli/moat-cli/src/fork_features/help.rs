pub fn print_help() {
    println!(
        r#"moat - remote Chromium automation through the moat Controller

Usage: moat <command> [args] [options]

Session:
  init | connect               Create a Controller-managed browser session
  status                       Show the active session and Controller
  disconnect | close-session  Destroy the active session
  close                        Destroy the active session (command alias)

Navigation and page actions:
  open <url> | back | forward | reload
  click | dblclick | type | fill | hover | focus | check | uncheck | select
  press | keyboard | drag | mouse | tap | swipe | scroll | scrollintoview
  wait | find | get | is | eval | highlight

Page artifacts and state:
  snapshot                     Accessibility snapshot; supports -i/-u/-c/-d/-s
  screenshot                   PNG/JPEG, selector/full-page, and --annotate
  pdf | upload | download | wait --download
  cookies | storage | state
  trace | profiler | network har start [--content all|text|none] | stop [path]

Browser and runtime state:
  tab | window | frame | dialog | clipboard
  set viewport|device|geo|offline|headers|credentials|media
  network route|unroute|requests|request
  console | errors | batch | diff
  pushstate

Unavailable in moat architecture (stable unsupported_in_moat error):
  read                        Upstream document fetching is not in moat
  react                       React inspection is not in moat
  vitals | web-vitals         Web Vitals collection is not in moat
  a11y                        Upstream accessibility audit is not in moat
  webmcp                      WebMCP page tools are not in moat
  auth                         Authentication uses moat profiles + neko login
  confirm | deny               No CLI-local action-policy layer
  inspect                      CDP is private and Controller-managed
  launch | connect <port|url>  Controller creates CDP targets
  record                       Video recording is outside the Controller contract
  stream                       Live viewing uses neko WebRTC
  device list                  No local Xcode/Appium device backend
  install | upgrade | dashboard | profiles | session
  mcp | doctor | skills | plugin | plugins | chat

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
  AGENT_BROWSER_DEFAULT_TIMEOUT Default wait timeout in milliseconds
  AGENT_BROWSER_INIT_SCRIPTS   Unsupported: upstream local launcher only
  AGENT_BROWSER_ENABLE         Unsupported: upstream plugin/runtime launcher only
  ~/.moat/session              Active session ID
  ~/.moat/config.json          Optional Controller configuration

Examples:
  moat init
  moat open https://example.com
  moat snapshot -i
  moat screenshot --annotate ./page.png
  moat diff screenshot --baseline ./before.png --output ./diff.png
  moat disconnect"#
    );
}

/// Print moat-specific command help without inheriting upstream's local-browser
/// daemon, named-session, or browser-launch claims.
pub fn print_command_help(command: &str) -> bool {
    let usage = match command {
        "init" => "init [--profile <name>] [--controller <url>]",
        "connect" => "connect [--profile <name>] [--controller <url>]",
        "use" => "use <session-id>",
        "status" => "status",
        "disconnect" | "destroy" | "close-session" => "disconnect",
        "open" | "goto" | "navigate" => "open <url> [--headers <json>]",
        "back" => "back",
        "forward" => "forward",
        "reload" => "reload",
        "click" => "click <selector> [--new-tab]",
        "dblclick" => "dblclick <selector>",
        "fill" => "fill <selector> <text>",
        "type" => "type <selector> <text> [--clear] [--delay <ms>]",
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
        "scroll" => "scroll <up|down|left|right> [pixels]",
        "scrollintoview" | "scrollinto" => "scrollintoview <selector>",
        "wait" => "wait <selector|milliseconds|--text|--url|--load|--fn|--download> [value] [--timeout <ms>]",
        "screenshot" => "screenshot [selector] [output-path] [--full|-f] [--annotate]",
        "pdf" => "pdf [output-path]",
        "snapshot" => "snapshot [-i] [-u] [-c] [-d <depth>] [-s <selector>]",
        "eval" => "eval <javascript> [selector]",
        "close" | "quit" | "exit" => "close",
        "get" => "get <url|title|text|html|value|attr|count|box|styles|cdp-url> [argument]",
        "is" => "is <visible|enabled|checked> <selector>",
        "find" => "find <locator> <value> [action] [text]; omitted action queries, actions: click|fill|type|check|uncheck|hover|text",
        "mouse" => "mouse <move|down|up|wheel> ...",
        "set" => "set <viewport|device|geo|offline|headers|credentials|media> ...",
        "network" => "network <route|unroute|requests|request|har> ... (route supports --abort, --body <json>, --resource-type <csv>; har start [--content <all|text|none>])",
        "storage" => "storage <local|session> <get|set|clear> ...",
        "cookies" => "cookies <get|set|clear> ...",
        "tab" => "tab <new|list|switch|close> ... (numeric indexes only; --label unavailable)",
        "window" => "window new",
        "frame" => "frame <selector|main>",
        "dialog" => "dialog <accept|dismiss> [text]",
        "trace" => "trace <start|stop> [output-path]",
        "profiler" => "profiler <start|stop> [output-path]",
        "console" => "console [--clear]",
        "errors" => "errors [--clear]",
        "highlight" => "highlight <selector>",
        "clipboard" => "clipboard <read|write> [text]",
        "state" => "state <save|load|list|show|rename|clean|clear> ...",
        "tap" => "tap <selector>",
        "swipe" => "swipe <up|down|left|right> [distance]",
        "diff" => "diff <snapshot|screenshot|url> ...",
        "batch" => "batch [--bail] [\"command ...\" ...]  # inline or JSON stdin",
        "pushstate" => "pushstate <url>",
        "read" | "react" | "vitals" | "web-vitals" | "a11y" | "webmcp"
        | "mcp" | "doctor" | "skills" | "plugin" | "plugins" | "chat" => {
            println!(
                "moat {command} - unavailable in the moat Controller architecture\n\n\
                 This command returns a nonzero unsupported_in_moat error.\n\
                 Run `moat --help` for the supported alternative."
            );
            return true;
        }
        "auth" | "confirm" | "deny" | "inspect" | "record" | "stream" | "device" | "install"
        | "upgrade" | "dashboard" | "profiles" | "session" | "launch" => {
            println!(
                "moat {command} - unavailable in the moat Controller architecture\n\n\
                 This command returns a nonzero unsupported_in_moat error.\n\
                 Run `moat --help` for the supported alternative."
            );
            return true;
        }
        _ => return false,
    };

    println!(
        "moat {command}\n\nUsage: moat {usage}\n\n\
         This command runs against the active Controller-managed session.\n\
         Options: --json emits exactly one JSON value. Run `moat --help` for global options."
    );
    true
}

#[cfg(test)]
mod tests {
    use super::print_command_help;

    #[test]
    fn recognizes_supported_and_unavailable_commands() {
        for command in [
            "open",
            "snapshot",
            "network",
            "state",
            "batch",
            "pushstate",
            "read",
            "react",
            "vitals",
            "a11y",
            "webmcp",
            "auth",
            "stream",
        ] {
            assert!(print_command_help(command));
        }
        assert!(!print_command_help("not-a-command"));
    }
}
