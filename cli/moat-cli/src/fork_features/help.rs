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
  snapshot                     Accessibility snapshot; supports -i/-c/-d/-s
  screenshot                   PNG/JPEG, selector/full-page, and --annotate
  pdf | upload | download | wait --download
  cookies | storage | state
  trace | profiler | network har

Browser and runtime state:
  tab | window | frame | dialog | clipboard
  set viewport|device|geo|offline|headers|credentials|media
  network route|unroute|requests
  console | errors | batch | diff

Unavailable in moat architecture (stable unsupported_in_moat error):
  auth                         Authentication uses moat profiles + neko login
  confirm | deny               No CLI-local action-policy layer
  inspect                      CDP is private and Controller-managed
  launch | connect <port|url>  Controller creates CDP targets
  record                       Video recording is outside the Controller contract
  stream                       Live viewing uses neko WebRTC
  device list                  No local Xcode/Appium device backend
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
        "scroll" => "scroll <up|down|left|right> [pixels]",
        "scrollintoview" | "scrollinto" => "scrollintoview <selector>",
        "wait" => "wait <selector|milliseconds|--text|--url|--load|--fn|--download> [value]",
        "screenshot" => "screenshot [selector] [output-path] [--full|-f] [--annotate]",
        "pdf" => "pdf [output-path]",
        "snapshot" => "snapshot [-i] [-c] [-d <depth>] [-s <selector>]",
        "eval" => "eval <javascript> [selector]",
        "close" | "quit" | "exit" => "close",
        "get" => "get <url|title|text|html|value|attr|count|box|styles|cdp-url> [argument]",
        "is" => "is <visible|enabled|checked> <selector>",
        "find" => "find <role|text|label|placeholder|alt|title|testid|first|last|nth> ...",
        "mouse" => "mouse <move|down|up|wheel> ...",
        "set" => "set <viewport|device|geo|offline|headers|credentials|media> ...",
        "network" => "network <route|unroute|requests|request|har> ...",
        "storage" => "storage <local|session> <get|set|clear> ...",
        "cookies" => "cookies <get|set|clear> ...",
        "tab" => "tab <new|list|switch|close> ...",
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
        "diff" => {
            println!(
                "moat diff\n\nUsage: moat diff <snapshot|screenshot|url> ...\n\n\
                 Without --baseline, `diff snapshot` initializes this session's baseline on the\n\
                 first invocation and reports that initialization instead of a comparison; later\n\
                 invocations compare against the previous snapshot.\n\
                 `diff screenshot` reports a diff image only when --output is given and a diff\n\
                 image was actually written.\n\
                 `diff url` compares in a temporary tab and restores the calling page.\n\n\
                 This command runs against the active Controller-managed session.\n\
                 Options: --json emits exactly one JSON value. Run `moat --help` for global options."
            );
            return true;
        }
        "batch" => "batch  # reads a JSON command array from stdin",
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
        for command in ["open", "snapshot", "network", "state", "auth", "stream"] {
            assert!(print_command_help(command));
        }
        assert!(!print_command_help("not-a-command"));
    }
}
