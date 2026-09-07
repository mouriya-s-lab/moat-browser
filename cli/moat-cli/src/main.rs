//! moat CLI — agent-browser fork with remote Controller transport.
//!
//! Retains upstream's command parsing (commands.rs), output formatting (output.rs),
//! flags (flags.rs), and color handling (color.rs). Replaces connection.rs with
//! moat-sdk WebSocket transport.

mod color;
mod commands;
mod connection;
mod flags;
mod fork_features;
mod output;
mod validation;

use serde_json::json;
use std::env;
use std::process::exit;

use commands::{parse_command, shell_words_split, ParseError};
use connection::send_command;
use flags::{clean_args, parse_flags, ControllerOverride};
use fork_features::{
    print_command_help, print_help, unsupported_command, unsupported_environment, unsupported_flag,
};
use output::{print_response_with_opts, OutputOptions};

use moat_sdk::MoatClient;

fn controller_url(controller: &ControllerOverride) -> Result<String, String> {
    match controller {
        ControllerOverride::Url(url) => return Ok(url.clone()),
        ControllerOverride::MissingValue => return Err("Usage: moat --controller <url>".into()),
        ControllerOverride::EmptyValue => {
            return Err("--controller requires a non-empty URL".into());
        }
        ControllerOverride::Unspecified => {}
    }

    if let Ok(value) = env::var("MOAT_CONTROLLER") {
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }

    let home = dirs::home_dir().ok_or("no home dir")?;
    let config_path = home.join(".moat").join("config.json");
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        let config: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        config
            .get("controller")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(String::from)
            .ok_or_else(|| "no non-empty 'controller' field in ~/.moat/config.json".into())
    } else {
        Err("MOAT_CONTROLLER not set and ~/.moat/config.json not found".into())
    }
}

fn print_json_error(message: impl AsRef<str>) {
    let message = message.as_ref();
    println!(
        "{}",
        serde_json::to_string(&json!({
            "success": false,
            "error": message,
            "errorType": error_type(message),
        }))
        .unwrap_or_default()
    );
}

fn error_type(message: &str) -> &'static str {
    if message.contains("unsupported_in_moat") || message.contains("not available in moat CLI") {
        "unsupported_in_moat"
    } else if message.contains("No active session") || message.contains("NoSession") {
        "no_session"
    } else if message.starts_with("Usage:") || message.contains("Missing required") {
        "missing_arguments"
    } else if message.contains("Invalid JSON") || message.contains("invalid_value") {
        "invalid_input"
    } else if message.contains("--controller")
        || message.contains("MOAT_CONTROLLER")
        || message.contains("no home dir")
        || message.contains("controller")
    {
        "configuration_error"
    } else {
        "command_failed"
    }
}

fn print_version() {
    println!("moat {}", env!("CARGO_PKG_VERSION"));
}

#[tokio::main]
async fn main() {
    // Reset SIGPIPE to default on Unix
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }

    let args: Vec<String> = env::args().skip(1).collect();
    let flags = parse_flags(&args);
    let clean = clean_args(&args);

    // `help` is a local documentation command, not a Controller wire action.
    if clean.first().map(String::as_str) == Some("help") {
        if let Some(cmd) = clean.get(1) {
            if print_command_help(cmd) {
                return;
            }
        }
        print_help();
        return;
    }

    // --help
    if args.iter().any(|a| a == "--help" || a == "-h") {
        if let Some(cmd) = clean.first() {
            if print_command_help(cmd) {
                return;
            }
        }
        print_help();
        return;
    }

    // --version
    if args.iter().any(|a| a == "--version" || a == "-V") {
        print_version();
        return;
    }
    if let Some(message) = unsupported_environment() {
        if flags.json {
            print_json_error(&message);
        } else {
            eprintln!("{} {}", color::error_indicator(), message);
        }
        exit(1);
    }

    let controller_override_error = match &flags.controller {
        ControllerOverride::MissingValue => Some("Usage: moat --controller <url>"),
        ControllerOverride::EmptyValue => Some("--controller requires a non-empty URL"),
        ControllerOverride::Url(_) | ControllerOverride::Unspecified => None,
    };
    if let Some(message) = controller_override_error {
        if flags.json {
            print_json_error(message);
        } else {
            eprintln!("{} {}", color::error_indicator(), message);
        }
        exit(78);
    }


    if clean.is_empty() {
        print_help();
        return;
    }

    // This must precede parse_command: upstream argument validation must not
    // turn an architectural rejection into missing_arguments/invalid_input.
    if let Some(message) = unsupported_command(&clean[0]) {
        if flags.json {
            print_json_error(message);
        } else {
            eprintln!("{} {}", color::error_indicator(), message);
        }
        exit(1);
    }

    if let Some(message) = unsupported_flag(&args, &clean[0]) {
        if flags.json {
            print_json_error(message);
        } else {
            eprintln!("{} {}", color::error_indicator(), message);
        }
        exit(1);
    }

    // ─── moat-specific subcommands ───

    match clean[0].as_str() {
        // init: register session, create container + CDP
        "connect" | "init" => {
            if clean.len() > 1 {
                let message = "unsupported_in_moat: direct CDP connect is unavailable; use `moat init` and let the Controller create the browser";
                if flags.json {
                    print_json_error(message);
                } else {
                    eprintln!("{} {}", color::error_indicator(), message);
                }
                exit(1);
            }
            let url = match controller_url(&flags.controller) {
                Ok(u) => u,
                Err(e) => {
                    if flags.json {
                        print_json_error(&e);
                    } else {
                        eprintln!("{} {}", color::error_indicator(), e);
                    }
                    exit(78);
                }
            };
            let profile = args
                .iter()
                .position(|a| a == "--profile")
                .and_then(|i| args.get(i + 1))
                .filter(|value| !value.starts_with("--"))
                .map(String::as_str);

            match MoatClient::init(&url, profile).await {
                Ok(client) => {
                    if flags.json {
                        println!(
                            "{}",
                            serde_json::to_string(&json!({
                                "success": true,
                                "data": { "sessionId": client.session_id() }
                            }))
                            .unwrap()
                        );
                    } else {
                        println!(
                            "{} Connected. Session: {}",
                            color::success_indicator(),
                            client.session_id()
                        );
                    }
                }
                Err(e) => {
                    if flags.json {
                        print_json_error(e.to_string());
                    } else {
                        eprintln!("{} {}", color::error_indicator(), e);
                    }
                    exit(69);
                }
            }
            return;
        }

        // use: select an existing session
        "use" => {
            let session_id = match clean.get(1) {
                Some(id) => id.clone(),
                None => {
                    if flags.json {
                        print_json_error("Usage: moat use <session-id>");
                    } else {
                        eprintln!("{} Usage: moat use <session-id>", color::error_indicator());
                    }
                    exit(1);
                }
            };
            match moat_sdk::session::write_session_id(&session_id) {
                Ok(()) => {
                    if flags.json {
                        println!(
                            "{}",
                            serde_json::to_string(&json!({
                                "success": true,
                                "data": { "sessionId": session_id }
                            }))
                            .unwrap()
                        );
                    } else {
                        println!("Now using session: {}", session_id);
                    }
                }
                Err(e) => {
                    if flags.json {
                        print_json_error(e.to_string());
                    } else {
                        eprintln!("{} {}", color::error_indicator(), e);
                    }
                    exit(1);
                }
            }
            return;
        }

        // destroy: deregister session, destroy container
        "disconnect" | "destroy" | "close-session" => {
            let url = match controller_url(&flags.controller) {
                Ok(u) => u,
                Err(e) => {
                    if flags.json {
                        print_json_error(&e);
                    } else {
                        eprintln!("{} {}", color::error_indicator(), e);
                    }
                    exit(78);
                }
            };
            let session_id = match moat_sdk::session::read_session_id() {
                Ok(Some(id)) => id,
                _ => {
                    if flags.json {
                        print_json_error("No active session");
                    } else {
                        eprintln!("{} No active session.", color::error_indicator());
                    }
                    exit(77);
                }
            };
            let client = MoatClient::from_session(url, session_id);
            match client.destroy().await {
                Ok(()) => {
                    if flags.json {
                        println!(r#"{{"success":true}}"#);
                    } else {
                        println!("{} Disconnected.", color::success_indicator());
                    }
                }
                Err(e) => {
                    // Session may already be gone — clean up local state
                    let _ = moat_sdk::session::clear_session_id();
                    if flags.json {
                        println!(r#"{{"success":true}}"#);
                    } else {
                        println!(
                            "{} Cleaned up (session already gone).",
                            color::success_indicator()
                        );
                    }
                }
            }
            return;
        }

        "status" => {
            match moat_sdk::session::read_session_id() {
                Ok(Some(id)) => {
                    let url = controller_url(&ControllerOverride::Unspecified)
                        .unwrap_or_else(|_| "(not set)".into());
                    if flags.json {
                        println!(
                            "{}",
                            serde_json::to_string(&json!({
                                "success": true,
                                "data": { "sessionId": id, "controller": url }
                            }))
                            .unwrap()
                        );
                    } else {
                        println!("Session:    {}", id);
                        println!("Controller: {}", url);
                    }
                }
                _ => {
                    if flags.json {
                        print_json_error("No active session");
                    } else {
                        eprintln!("{} No active session.", color::error_indicator());
                    }
                    exit(77);
                }
            }
            return;
        }

        // Skip upstream-only commands that don't apply to moat
        "install" | "upgrade" | "dashboard" | "profiles" | "session" => {
            if flags.json {
                print_json_error(format!("'{}' is not available in moat CLI", clean[0]));
            } else {
                eprintln!(
                    "{} '{}' is not available in moat CLI. Use `moat init` to create sessions.",
                    color::error_indicator(),
                    clean[0]
                );
            }
            exit(1);
        }

        _ => {} // Fall through to command execution
    }

    // ─── Parse command using upstream's parse_command ───

    let cmd = match parse_command(&clean, &flags) {
        Ok(c) => c,
        Err(e) => {
            let message = e.format();
            if flags.json {
                let error_type = if message.contains("unsupported_in_moat") {
                    "unsupported_in_moat"
                } else {
                    match &e {
                        ParseError::UnknownCommand { .. } => "unknown_command",
                        ParseError::UnknownSubcommand { .. } => "unknown_subcommand",
                        ParseError::MissingArguments { .. } => "missing_arguments",
                        ParseError::InvalidValue { .. } => "invalid_value",
                        ParseError::InvalidSessionName { .. } => "invalid_session_name",
                    }
                };
                println!(
                    "{}",
                    serde_json::to_string(&json!({
                        "success": false,
                        "error": message,
                        "errorType": error_type,
                    }))
                    .unwrap_or_default()
                );
            } else {
                eprintln!("{}", color::red(&message));
            }
            exit(1);
        }
    };

    // ─── Batch mode ───

    if cmd.get("action").and_then(|v| v.as_str()) == Some("batch") {
        let bail = cmd.get("bail").and_then(|v| v.as_bool()).unwrap_or(false);
        let inline_commands = cmd.get("commands").and_then(|value| value.as_array()).map(|commands| {
            commands
                .iter()
                .filter_map(|value| value.as_str())
                .map(shell_words_split)
                .collect::<Vec<Vec<String>>>()
        });
        run_batch(&flags, bail, inline_commands).await;
        return;
    }

    let output_opts = OutputOptions::from_flags(&flags);
    if let Some(result) = moat_sdk::local_command(&cmd) {
        match result {
            Ok(resp) => {
                let action = cmd.get("action").and_then(|value| value.as_str());
                print_response_with_opts(&resp, action, &output_opts);
            }
            Err(error) => {
                if flags.json {
                    print_json_error(error.to_string());
                } else {
                    eprintln!("{} {}", color::error_indicator(), error);
                }
                exit(1);
            }
        }
        return;
    }

    // ─── Send command to Controller via SDK ───

    let url = match controller_url(&flags.controller) {
        Ok(u) => u,
        Err(e) => {
            if flags.json {
                print_json_error(e);
            } else {
                eprintln!("{} {}", color::error_indicator(), e);
            }
            exit(78);
        }
    };

    match send_command(cmd.clone(), &url).await {
        Ok(resp) => {
            let success = resp.success;
            let action = cmd.get("action").and_then(|v| v.as_str());
            print_response_with_opts(&resp, action, &output_opts);
            if !success {
                exit(1);
            }
        }
        Err(e) => {
            if e.contains("No active session") || e.contains("NoSession") {
                if flags.json {
                    print_json_error("No active session. Run `moat init` first.");
                } else {
                    eprintln!(
                        "{} No active session. Run `moat init` first.",
                        color::error_indicator()
                    );
                }
                exit(77);
            }
            if flags.json {
                print_json_error(&e);
            } else {
                eprintln!("{} {}", color::error_indicator(), e);
            }
            exit(1);
        }
    }
}

/// Batch mode: execute inline shell-split commands when present; otherwise read
/// the established JSON argv-array format from stdin. Every JSON invocation
/// emits one moat `{success,data:{results}}` envelope.
async fn run_batch(
    flags: &flags::Flags,
    bail: bool,
    inline_commands: Option<Vec<Vec<String>>>,
) {
    use std::io::Read as _;

    let commands: Vec<Vec<String>> = match inline_commands {
        Some(commands) => commands,
        None => {
            let mut input = String::new();
            if let Err(error) = std::io::stdin().read_to_string(&mut input) {
                if flags.json {
                    print_json_error(format!("Failed to read stdin: {}", error));
                } else {
                    eprintln!("{} Failed to read stdin: {}", color::error_indicator(), error);
                }
                exit(1);
            }
            match serde_json::from_str(&input) {
                Ok(commands) => commands,
                Err(error) => {
                    if flags.json {
                        print_json_error(format!("Invalid JSON: {}", error));
                    } else {
                        eprintln!("{} Invalid JSON: {}", color::error_indicator(), error);
                    }
                    exit(1);
                }
            }
        }
    };

    let url = match controller_url(&flags.controller) {
        Ok(url) => url,
        Err(error) => {
            if flags.json {
                print_json_error(error);
            } else {
                eprintln!("{} {}", color::error_indicator(), error);
            }
            exit(78);
        }
    };
    let output_opts = OutputOptions::from_flags(flags);
    let mut results = Vec::new();
    let mut success = true;

    for command_args in commands {
        if command_args.is_empty() {
            continue;
        }
        if let Some(message) = command_args
            .first()
            .and_then(|command| unsupported_command(command))
        {
            success = false;
            if flags.json {
                results.push(json!({
                    "command": command_args,
                    "success": false,
                    "error": message,
                    "errorType": "unsupported_in_moat",
                }));
            } else {
                eprintln!("{} {}", color::error_indicator(), message);
            }
            if bail {
                break;
            }
            continue;
        }
        let command_name = command_args
            .first()
            .map(String::as_str)
            .unwrap_or_default();
        if let Some(message) = unsupported_flag(&command_args, command_name) {
            success = false;
            if flags.json {
                results.push(json!({
                    "command": command_args,
                    "success": false,
                    "error": message,
                    "errorType": "unsupported_in_moat",
                }));
            } else {
                eprintln!("{} {}", color::error_indicator(), message);
            }
            if bail {
                break;
            }
            continue;
        }

        let command = match parse_command(&command_args, flags) {
            Ok(command) => command,
            Err(error) => {
                success = false;
                let message = error.format();
                if flags.json {
                    results.push(json!({
                        "command": command_args,
                        "success": false,
                        "error": message,
                        "errorType": if message.contains("unsupported_in_moat") {
                            "unsupported_in_moat"
                        } else {
                            "invalid_command"
                        }
                    }));
                } else {
                    eprintln!("{} {}", color::error_indicator(), message);
                }
                if bail {
                    break;
                }
                continue;
            }
        };
        let action = command.get("action").and_then(|value| value.as_str());
        match send_command(command.clone(), &url).await {
            Ok(response) => {
                if !response.success {
                    success = false;
                }
                if flags.json {
                    let mut result = json!({
                        "command": command_args,
                        "success": response.success,
                        "result": response.data,
                        "error": response.error,
                    });
                    if let Some(warning) = response.warning {
                        result["warning"] = json!(warning);
                    }
                    results.push(result);
                } else {
                    print_response_with_opts(&response, action, &output_opts);
                }
                if !response.success && bail {
                    break;
                }
            }
            Err(error) => {
                success = false;
                if flags.json {
                    results.push(json!({
                        "command": command_args,
                        "success": false,
                        "error": error,
                        "errorType": error_type(&error),
                    }));
                } else {
                    eprintln!("{} {}", color::error_indicator(), error);
                }
                if bail {
                    break;
                }
            }
        }
    }

    if flags.json {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "success": success,
                "data": { "results": results },
            }))
            .unwrap_or_default()
        );
    }
    if !success {
        exit(1);
    }
}
