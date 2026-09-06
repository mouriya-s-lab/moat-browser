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

pub fn unsupported_flag(args: &[String], command: &str) -> Option<String> {
    for arg in args {
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
}
