const CONTROLLER_OWNED_FLAGS: &[&str] = &[
    "--headed",
    "--executable-path",
    "--extension",
    "--args",
    "--user-agent",
    "--proxy",
    "--proxy-bypass",
    "--ignore-https-errors",
    "--allow-file-access",
    "--auto-connect",
    "--engine",
    "--cdp",
    "-p",
    "--provider",
    "--device",
];

const UPSTREAM_LOCAL_FLAGS: &[&str] = &[
    "--session",
    "--session-name",
    "--state",
    "--download-path",
    "--allowed-domains",
    "--action-policy",
    "--confirm-actions",
    "--confirm-interactive",
    "--idle-timeout",
    "--no-auto-dialog",
    "--config",
    "--debug",
    "--color-scheme",
];

// These flags are valid upstream syntax but require the upstream local
// launcher/plugin runtime. Reject them instead of parsing and silently
// discarding their effect in the moat Controller transport.
const UPSTREAM_UNAVAILABLE_FLAGS: &[&str] = &[
    "--restore",
    "--restore-save",
    "--restore-check-url",
    "--restore-check-text",
    "--restore-check-fn",
    "--namespace",
    "--init-script",
    "--enable",
    "--webgpu",
    "--no-webmcp",
    "--ca-cert",
    "--no-ca-cert",
    "--hide-scrollbars",
    "--pin-tab",
    "--no-pin-tab",
    "--no-xvfb",
    "--model",
    "--verbose",
    "--quiet",
];
fn is_upstream_unavailable_flag(arg: &str) -> bool {
    UPSTREAM_UNAVAILABLE_FLAGS.contains(&arg)
        || arg.starts_with("--restore=")
        || matches!(arg, "-v" | "-q")
}


pub fn unsupported_environment() -> Option<String> {
    for (name, reason) in [
        (
            "AGENT_BROWSER_INIT_SCRIPTS",
            "startup init scripts require the upstream local browser launcher",
        ),
        (
            "AGENT_BROWSER_ENABLE",
            "startup feature scripts require the upstream plugin/runtime launcher",
        ),
    ] {
        if std::env::var_os(name).is_some_and(|value| !value.is_empty()) {
            return Some(format!("unsupported_in_moat: {name} is unavailable: {reason}"));
        }
    }
    None
}

fn is_positional_operand(args: &[String], command: &str, index: usize) -> bool {
    let Some(command_index) = args.iter().position(|arg| arg == command) else {
        return false;
    };
    if index <= command_index {
        return false;
    }
    let offset = index - command_index;
    match command {
        // These commands intentionally accept arbitrary text/script operands.
        "eval" | "addinitscript" => offset >= 1,
        "fill" | "type" | "select" | "upload" | "download" => offset >= 2,
        "clipboard" => offset >= 2,
        "keyboard" => offset >= 2,
        "find" => offset >= 2,
        "wait" => args
            .get(index.saturating_sub(1))
            .is_some_and(|previous| {
                matches!(
                    previous.as_str(),
                    "--url" | "-u" | "--load" | "-l" | "--fn" | "-f" | "--text" | "-t"
                )
            }),
        _ => false,
    }
}

pub fn unsupported_flag(args: &[String], command: &str) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if arg == "--controller" && command == "use" {
            return Some(format!(
                "unsupported_in_moat: --controller is not valid for the local `{command}` command"
            ));
        }
        if CONTROLLER_OWNED_FLAGS.contains(&arg.as_str()) {
            return Some(format!(
                "unsupported_in_moat: {arg} is a local browser launch option; the Controller owns browser creation"
            ));
        }
        if UPSTREAM_LOCAL_FLAGS.contains(&arg.as_str()) {
            return Some(format!(
                "unsupported_in_moat: {arg} belongs to agent-browser local daemon state and is unavailable in moat"
            ));
        }
        if is_upstream_unavailable_flag(arg)
            && !is_positional_operand(args, command, index)
        {
            return Some(format!(
                "unsupported_in_moat: {arg} requires the upstream local launcher or plugin runtime and is unavailable in moat"
            ));
        }
        if arg == "--profile" && !matches!(command, "init" | "connect") {
            return Some(
                "unsupported_in_moat: --profile is selected when creating a session with `moat init --profile <name>`"
                    .into(),
            );
        }
        if arg == "--headers" && !matches!(command, "open" | "goto" | "navigate") {
            return Some(
                "unsupported_in_moat: --headers only applies to navigation commands".into(),
            );
        }
        if arg == "--annotate" && command != "screenshot" {
            return Some("unsupported_in_moat: --annotate only applies to screenshot".into());
        }
        if matches!(
            arg.as_str(),
            "--screenshot-dir" | "--screenshot-quality" | "--screenshot-format"
        ) && command != "screenshot"
        {
            return Some(format!(
                "unsupported_in_moat: {arg} only applies to screenshot"
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn rejects_controller_owned_and_local_daemon_flags() {
        assert!(
            unsupported_flag(&args(&["open", "x", "--proxy", "p"]), "open")
                .unwrap()
                .contains("unsupported_in_moat")
        );
        assert!(
            unsupported_flag(&args(&["snapshot", "--session", "x"]), "snapshot")
                .unwrap()
                .contains("unsupported_in_moat")
        );
        for flag in UPSTREAM_LOCAL_FLAGS {
            assert!(
                unsupported_flag(&args(&["open", "x", *flag]), "open")
                    .expect("every upstream local flag must be rejected")
                    .contains("unsupported_in_moat")
            );
        }
    }

    #[test]
    fn rejects_controller_for_use_command() {
        assert!(
            unsupported_flag(&args(&["use", "session", "--controller", "ws://example"]), "use")
                .unwrap()
                .contains("unsupported_in_moat")
        );
    }

    #[test]
    fn allows_profile_only_for_session_creation_and_scoped_output_flags() {
        assert_eq!(
            unsupported_flag(&args(&["init", "--profile", "p"]), "init"),
            None
        );
        assert!(unsupported_flag(&args(&["open", "x", "--profile", "p"]), "open").is_some());
        assert_eq!(
            unsupported_flag(&args(&["screenshot", "--annotate"]), "screenshot"),
            None
        );
        assert_eq!(
            unsupported_flag(&args(&["open", "x", "--headers", "{}"]), "open"),
            None
        );
    }
    #[test]
    fn rejects_upstream_local_runtime_flags() {
        for flag in [
            "--init-script",
            "--enable",
            "--no-webmcp",
            "--restore",
            "--pin-tab",
        ] {
            assert!(
                unsupported_flag(&args(&["open", "x", flag]), "open")
                    .expect("flag must be rejected")
                    .contains("unsupported_in_moat")
            );
        }
    }
    #[test]
    fn recognizes_equals_and_short_forms() {
        for flag in ["--restore=work", "-v", "-q"] {
            assert!(
                unsupported_flag(&args(&["open", "x", flag]), "open")
                    .expect("flag must be rejected")
                    .contains("unsupported_in_moat")
            );
        }
    }

    #[test]
    fn preserves_flag_like_text_operands() {
        assert_eq!(
            unsupported_flag(&args(&["fill", "#input", "--model"]), "fill"),
            None
        );
        assert_eq!(
            unsupported_flag(&args(&["type", "#input", "--verbose"]), "type"),
            None
        );
    }
}
