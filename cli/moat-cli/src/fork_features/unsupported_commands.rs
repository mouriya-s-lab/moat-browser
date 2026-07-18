/// Commands retained by the upstream parser but intentionally unavailable in
/// moat.  Reject them before argument validation so every invocation has the
/// same machine-readable contract, even when required upstream arguments are
/// absent or meaningless to moat.
pub fn unsupported_command(command: &str) -> Option<String> {
    let reason = match command {
        "auth" => "authentication uses moat profiles and the neko login flow",
        "confirm" | "deny" => "moat has no CLI-local action-policy confirmation layer",
        "inspect" => "CDP is private and Controller-managed",
        "launch" => "the Controller owns browser creation",
        "record" => "browser video recording is outside the Controller contract",
        "stream" => "live viewing uses neko WebRTC",
        "device" => "moat has no local Xcode/Appium device backend",
        _ => return None,
    };
    Some(format!(
        "unsupported_in_moat: {command} is unavailable: {reason}"
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
