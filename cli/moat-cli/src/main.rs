//! moat CLI — agent-browser fork with remote Controller transport.
//!
//! This binary will contain the full agent-browser CLI codebase
//! (commands.rs, output.rs, flags.rs, etc.) once the fork is populated.
//! For now, it implements the moat-specific subcommands (connect/disconnect/status)
//! and a command passthrough to demonstrate the SDK integration.

mod connection;

use moat_sdk::error::SdkError;
use moat_sdk::MoatClient;
use std::env;
use std::process::ExitCode;

fn controller_url() -> Result<String, SdkError> {
    env::var("MOAT_CONTROLLER")
        .or_else(|_| {
            // Try config file
            let home = dirs::home_dir().ok_or(SdkError::ConfigError("no home dir".into()))?;
            let config_path = home.join(".moat").join("config.json");
            if config_path.exists() {
                let content = std::fs::read_to_string(&config_path)
                    .map_err(|e| SdkError::ConfigError(e.to_string()))?;
                let config: serde_json::Value = serde_json::from_str(&content)
                    .map_err(|e| SdkError::ConfigError(e.to_string()))?;
                config
                    .get("controller")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .ok_or(SdkError::ConfigError("no controller in config".into()))
            } else {
                Err(SdkError::ConfigError(
                    "MOAT_CONTROLLER not set and no config file found".into(),
                ))
            }
        })
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        eprintln!("Usage: moat <command> [args...]");
        eprintln!("  moat connect [--profile <name>]  — start a session");
        eprintln!("  moat disconnect                  — end the session");
        eprintln!("  moat status                      — show session info");
        eprintln!("  moat <agent-browser command>     — execute via Controller");
        return ExitCode::from(2);
    }

    match args[0].as_str() {
        "connect" => {
            let url = match controller_url() {
                Ok(u) => u,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return ExitCode::from(78);
                }
            };
            let profile = args
                .iter()
                .position(|a| a == "--profile")
                .and_then(|i| args.get(i + 1))
                .map(String::as_str);

            match MoatClient::connect(&url, profile).await {
                Ok(client) => {
                    println!("Connected. Session: {}", client.session_id());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("Error: {}", e);
                    ExitCode::from(69)
                }
            }
        }

        "disconnect" => {
            let url = match controller_url() {
                Ok(u) => u,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return ExitCode::from(78);
                }
            };
            let session_id = match moat_sdk::session::read_session_id() {
                Ok(Some(id)) => id,
                _ => {
                    eprintln!("No active session.");
                    return ExitCode::from(77);
                }
            };
            match MoatClient::resume(&url, &session_id).await {
                Ok(mut client) => match client.disconnect().await {
                    Ok(()) => {
                        println!("Disconnected.");
                        ExitCode::SUCCESS
                    }
                    Err(e) => {
                        eprintln!("Error: {}", e);
                        ExitCode::FAILURE
                    }
                },
                Err(e) => {
                    // Session might already be gone, just clean up locally
                    let _ = moat_sdk::session::clear_session_id();
                    eprintln!("Cleaned up. ({})", e);
                    ExitCode::SUCCESS
                }
            }
        }

        "status" => match moat_sdk::session::read_session_id() {
            Ok(Some(id)) => {
                println!("Session: {}", id);
                let url = controller_url().unwrap_or_else(|_| "(not set)".into());
                println!("Controller: {}", url);
                ExitCode::SUCCESS
            }
            _ => {
                eprintln!("No active session.");
                ExitCode::from(77)
            }
        },

        // All other commands: passthrough to Controller via SDK
        _ => {
            let url = match controller_url() {
                Ok(u) => u,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return ExitCode::from(78);
                }
            };

            let mut conn = match connection::Connection::connect(&url).await {
                Ok(c) => c,
                Err(SdkError::NoSession) => {
                    eprintln!("No active session. Run `moat connect` first.");
                    return ExitCode::from(77);
                }
                Err(e) => {
                    eprintln!("Error: {}", e);
                    return ExitCode::from(69);
                }
            };

            // Build a minimal request from CLI args.
            // NOTE: In the full fork, this will be replaced by agent-browser's
            // parse_command() which handles all the CLI argument parsing.
            let request = serde_json::json!({
                "id": format!("r{}", std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap().as_micros() % 1000000),
                "action": args[0],
                // Pass remaining args as-is (simplified; full fork uses parse_command)
            });

            match conn.send(request).await {
                Ok(resp) => {
                    // In the full fork, output.rs handles formatting.
                    // For now, just print JSON.
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&resp).unwrap_or_default()
                    );
                    if resp.success {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::FAILURE
                    }
                }
                Err(e) => {
                    eprintln!("Error: {}", e);
                    ExitCode::FAILURE
                }
            }
        }
    }
}
