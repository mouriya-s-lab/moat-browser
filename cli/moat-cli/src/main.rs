//! moat CLI — agent-browser fork with remote Controller transport.
//!
//! Retains upstream's command parsing (commands.rs), output formatting (output.rs),
//! flags (flags.rs), and color handling (color.rs). Replaces connection.rs with
//! moat-sdk WebSocket transport.

mod color;
mod commands;
mod connection;
mod flags;
mod output;
mod validation;

use serde_json::json;
use std::env;
use std::process::exit;

use commands::{parse_command, ParseError};
use connection::send_command;
use flags::{clean_args, parse_flags};
use output::{print_command_help, print_help, print_response_with_opts, OutputOptions};

use moat_sdk::MoatClient;

fn controller_url() -> Result<String, String> {
    env::var("MOAT_CONTROLLER").or_else(|_| {
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
    })
}

fn print_json_error(message: impl AsRef<str>) {
    println!(
        "{}",
        serde_json::to_string(&json!({
            "success": false,
            "error": message.as_ref(),
        }))
        .unwrap_or_default()
    );
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

    // ─── moat-specific subcommands ───

    match clean[0].as_str() {
        "connect" => {
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

            match MoatClient::connect(&url, profile).await {
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

        "disconnect" => {
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
            match MoatClient::resume(&url, &session_id).await {
                Ok(mut client) => match client.disconnect().await {
                    Ok(()) => {
                        if flags.json {
                            println!(r#"{{"success":true}}"#);
                        } else {
                            println!("{} Disconnected.", color::success_indicator());
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
                },
                Err(_) => {
                    let _ = moat_sdk::session::clear_session_id();
                    if flags.json {
                        println!(r#"{{"success":true}}"#);
                    } else {
                        println!("{} Cleaned up (session already gone).", color::success_indicator());
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
                    "{} '{}' is not available in moat CLI. Use `moat connect` to manage sessions.",
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
                        "type": error_type,
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

    let output_opts = OutputOptions::from_flags(&flags);

    match send_command(cmd.clone(), &url) {
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
                    print_json_error("No active session. Run `moat connect` first.");
                } else {
                    eprintln!(
                        "{} No active session. Run `moat connect` first.",
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

        match send_command(cmd.clone(), &url) {
            Ok(resp) => {
                let action = cmd.get("action").and_then(|v| v.as_str());
                print_response_with_opts(&resp, action, &output_opts);
                if !resp.success && flags.json {
                    exit(1);
                }
            }
            Err(e) => {
                if flags.json {
                    print_json_error(&e);
                } else {
                    eprintln!("{} {}", color::error_indicator(), e);
                }
                exit(1);
            }
        }
    }
}
