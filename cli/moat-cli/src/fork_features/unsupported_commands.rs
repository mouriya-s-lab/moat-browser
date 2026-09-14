/// Commands retained by the upstream parser but intentionally unavailable in
/// moat.  Reject them before argument validation so every invocation has the
/// same machine-readable contract, even when required upstream arguments are
/// absent or meaningless to moat.
pub fn unsupported_command(command: &str) -> Option<String> {
    let (reason, alternative) = match command {
        "auth" => (
            "authentication uses moat profiles and the neko login flow",
            "use `moat connect --profile <name>` after logging in through neko",
        ),
        "confirm" | "deny" => (
            "moat has no CLI-local action-policy confirmation layer",
            "use the Controller-supported browser commands",
        ),
        "inspect" => (
            "CDP is private and Controller-managed",
            "use the Controller-managed browser commands through `moat`",
        ),
        "launch" => (
            "the Controller owns browser creation",
            "use `moat connect` to create a browser session",
        ),
        "record" => (
            "browser video recording is outside the Controller contract",
            "use a supported Controller artifact command",
        ),
        "stream" => (
            "live viewing uses neko WebRTC",
            "use the neko WebRTC viewer",
        ),
        "device" => (
            "moat has no local Xcode/Appium device backend",
            "use `moat set device <name>` for supported browser emulation",
        ),
        "install" | "upgrade" => (
            "browser binaries are managed by the Controller",
            "use `moat connect` with a registered profile",
        ),
        "dashboard" => (
            "moat has no CLI-local dashboard server",
            "use `moat status` and the Controller's own observability",
        ),
        "profiles" => (
            "moat accepts registered Controller profile names, not local browser profiles",
            "use `moat connect --profile <name>` with a registered profile",
        ),
        "session" => (
            "moat sessions are managed by the Controller and selected through `moat status`",
            "use `moat status` or `moat connect",
        ),
        _ => return None,
    };
    Some(format!(
        "unsupported_in_moat: {command} is unavailable: {reason}; {alternative}"
    ))
}

#[cfg(test)]
mod tests {
    use super::unsupported_command;

    #[test]
    fn rejects_every_stable_unsupported_command_before_argument_parsing() {
        for command in [
            "auth", "confirm", "deny", "inspect", "launch", "record", "stream", "device",
        ] {
            let error = unsupported_command(command).expect("command must be rejected");
            assert!(error.starts_with("unsupported_in_moat:"));
        }
        assert_eq!(unsupported_command("open"), None);
    }
}
