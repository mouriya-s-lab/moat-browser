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

use commands::{parse_command, ParseError};
use connection::send_command;
use flags::{clean_args, parse_flags};
use fork_features::{print_command_help, print_help, unsupported_flag};
use output::{print_response_with_opts, OutputOptions};

use moat_sdk::MoatClient;

fn controller_url() -> Result<String, String> {
    match env::var("MOAT_CONTROLLER") {
        Ok(val) if !val.is_empty() => return Ok(val),
        _ => {}
    }
    {
        let home = dirs::home_dir().ok_or("no home dir")?;
        let config_path = home.join(".moat").join("config.json");
        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
            let config: serde_json::Value =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;
            config
                .get("controller")
                .and_then(|v| v.as_str())
                .map(String::from)
                .ok_or_else(|| "no 'controller' field in config".into())
        } else {
            Err("MOAT_CONTROLLER not set and ~/.moat/config.json not found".into())
        }
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
    } else if message.contains("MOAT_CONTROLLER") || message.contains("no home dir") {
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

    if clean.is_empty() {
        print_help();
        return;
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
            let url = match controller_url() {
                Ok(u) => u,
                Err(e) => {
                    eprintln!("{} {}", color::error_indicator(), e);
                    exit(78);
                }
            };
            let profile = args
                .iter()
                .position(|a| a == "--profile")
                .and_then(|i| args.get(i + 1))
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
            let url = match controller_url() {
                Ok(u) => u,
                Err(e) => {
                    eprintln!("{} {}", color::error_indicator(), e);
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
                    let url = controller_url().unwrap_or_else(|_| "(not set)".into());
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
            if flags.json {
                let error_type = match &e {
                    ParseError::UnknownCommand { .. } => "unknown_command",
                    ParseError::UnknownSubcommand { .. } => "unknown_subcommand",
                    ParseError::MissingArguments { .. } => "missing_arguments",
                    ParseError::InvalidValue { .. } => "invalid_value",
                    ParseError::InvalidSessionName { .. } => "invalid_session_name",
                };
                println!(
                    "{}",
                    serde_json::to_string(&json!({
                        "success": false,
                        "error": e.format(),
                        "errorType": error_type,
                    }))
                    .unwrap_or_default()
                );
            } else {
                eprintln!("{}", color::red(&e.format()));
            }
            exit(1);
        }
    };

    // ─── Batch mode ───

    if cmd.get("action").and_then(|v| v.as_str()) == Some("batch") {
        run_batch(&flags).await;
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

    let url = match controller_url() {
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

/// Batch mode: read commands from stdin, execute sequentially.
async fn run_batch(flags: &flags::Flags) {
    use std::io::Read as _;

    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        if flags.json {
            print_json_error(format!("Failed to read stdin: {}", e));
        } else {
            eprintln!("{} Failed to read stdin: {}", color::error_indicator(), e);
        }
        exit(1);
    }

    let commands: Vec<Vec<String>> = match serde_json::from_str(&input) {
        Ok(c) => c,
        Err(e) => {
            if flags.json {
                print_json_error(format!("Invalid JSON: {}", e));
            } else {
                eprintln!("{} Invalid JSON: {}", color::error_indicator(), e);
            }
            exit(1);
        }
    };

    let url = match controller_url() {
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

    let output_opts = OutputOptions::from_flags(&flags);
    let mut json_results = Vec::new();
    let mut json_success = true;

    for args in &commands {
        let cmd = match parse_command(args, flags) {
            Ok(c) => c,
            Err(e) => {
                if flags.json {
                    print_json_error(e.format());
                } else {
                    eprintln!("{}", color::red(&e.format()));
                }
                exit(1);
            }
        };

        match send_command(cmd.clone(), &url).await {
            Ok(resp) => {
                if flags.json {
                    json_success &= resp.success;
                    json_results.push(serde_json::to_value(&resp).unwrap_or_default());
                } else {
                    let action = cmd.get("action").and_then(|v| v.as_str());
                    print_response_with_opts(&resp, action, &output_opts);
                }
            }
            Err(e) => {
                if flags.json {
                    json_success = false;
                    json_results.push(json!({
                        "success": false,
                        "error": e,
                        "errorType": error_type(&e),
                    }));
                } else {
                    eprintln!("{} {}", color::error_indicator(), e);
                    exit(1);
                }
            }
        }
    }

    if flags.json {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "success": json_success,
                "data": { "results": json_results },
            }))
            .unwrap_or_default()
        );
        if !json_success {
            exit(1);
        }
    }
}
