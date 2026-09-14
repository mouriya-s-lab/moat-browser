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
use flags::{clean_args, parse_flags, ControllerOverride};
use fork_features::{command_help_text, help_text, unsupported_command, unsupported_flag};
use output::{print_response_with_opts, OutputOptions};

use moat_sdk::error::SdkError;
use moat_sdk::MoatClient;

const ERROR_UNSUPPORTED: &str = "unsupported_in_moat";
const ERROR_MISSING_ARGUMENTS: &str = "missing_arguments";
const ERROR_INVALID_VALUE: &str = "invalid_value";
const ERROR_TARGET_NOT_FOUND: &str = "target_not_found";
const ERROR_COMMAND_FAILED: &str = "command_failed";

enum ControllerUrlError {
    Missing(String),
    Invalid(String),
}

impl ControllerUrlError {
    fn message(&self) -> &str {
        match self {
            ControllerUrlError::Missing(message) => message,
            ControllerUrlError::Invalid(message) => message,
        }
    }

    fn error_type(&self) -> &'static str {
        match self {
            ControllerUrlError::Missing(_) => ERROR_MISSING_ARGUMENTS,
            ControllerUrlError::Invalid(_) => ERROR_INVALID_VALUE,
        }
    }
}

fn controller_url(controller: &ControllerOverride) -> Result<String, ControllerUrlError> {
    match controller {
        ControllerOverride::Url(url) => return Ok(url.clone()),
        ControllerOverride::MissingValue => {
            return Err(ControllerUrlError::Missing(
                "Usage: moat --controller <url>".into(),
            ));
        }
        ControllerOverride::EmptyValue => {
            return Err(ControllerUrlError::Invalid(
                "--controller requires a non-empty URL".into(),
            ));
        }
        ControllerOverride::Unspecified => {}
    }

    match env::var("MOAT_CONTROLLER") {
        Ok(value) => {
            if value.trim().is_empty() {
                return Err(ControllerUrlError::Invalid(
                    "MOAT_CONTROLLER requires a non-empty URL".into(),
                ));
            }
            return Ok(value);
        }
        Err(env::VarError::NotPresent) => {}
        Err(env::VarError::NotUnicode(_)) => {
            return Err(ControllerUrlError::Invalid(
                "MOAT_CONTROLLER is not valid Unicode".into(),
            ));
        }
    }

    let home = match dirs::home_dir() {
        Some(home) => home,
        None => {
            return Err(ControllerUrlError::Missing("no home dir".into()));
        }
    };
    let config_path = home.join(".moat").join("config.json");
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| ControllerUrlError::Invalid(e.to_string()))?;
        let config: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| ControllerUrlError::Invalid(e.to_string()))?;
        config
            .get("controller")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(String::from)
            .ok_or_else(|| {
                ControllerUrlError::Invalid(
                    "no non-empty 'controller' field in ~/.moat/config.json".into(),
                )
            })
    } else {
        Err(ControllerUrlError::Missing(
            "MOAT_CONTROLLER not set and ~/.moat/config.json not found".into(),
        ))
    }
}

fn print_json_error_with_type(message: impl AsRef<str>, error_type: &str) {
    println!(
        "{}",
        serde_json::to_string(&json!({
            "success": false,
            "error": message.as_ref(),
            "errorType": error_type,
        }))
        .unwrap_or_default()
    );
}
fn sdk_error_type(error: &SdkError) -> &'static str {
    match error {
        SdkError::DeregisterFailed { error_type, .. } => match error_type.as_deref() {
            Some("target_not_found") => "target_not_found",
            _ => "command_failed",
        },
        SdkError::NoSession => "target_not_found",
        SdkError::SessionAlreadyActive { .. }
        | SdkError::ConnectionFailed(_)
        | SdkError::WebSocket(_)
        | SdkError::RegisterFailed { .. }
        | SdkError::CommandFailed { .. }
        | SdkError::SessionFileError(_)
        | SdkError::ConfigError(_) => "command_failed",
    }
}

fn print_sdk_json_error(error: &SdkError) {
    println!(
        "{}",
        serde_json::to_string(&json!({
            "success": false,
            "error": error.to_string(),
            "errorType": sdk_error_type(error),
        }))
        .unwrap_or_default()
    );
}

fn print_json_error(message: impl AsRef<str>) {
    print_json_error_with_type(message, ERROR_COMMAND_FAILED);
}

fn print_json_success(data: serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string(&json!({
            "success": true,
            "data": data,
        }))
        .unwrap_or_default()
    );
}

fn print_help_output(json_mode: bool, command: Option<&str>) {
    let text = command
        .and_then(command_help_text)
        .unwrap_or_else(|| help_text().to_string());
    if json_mode {
        print_json_success(json!({
            "kind": "help",
            "text": text,
        }));
    } else {
        println!("{}", text);
    }
}

fn print_version(json_mode: bool) {
    let version = env!("CARGO_PKG_VERSION");
    if json_mode {
        print_json_success(json!({ "kind": "version", "version": version }));
    } else {
        println!("moat {}", version);
    }
}

fn parse_error_type(error: &ParseError) -> &'static str {
    match error {
        ParseError::Unsupported { .. } => ERROR_UNSUPPORTED,
        ParseError::MissingArguments { .. } => ERROR_MISSING_ARGUMENTS,
        ParseError::UnknownCommand { .. }
        | ParseError::UnknownSubcommand { .. }
        | ParseError::InvalidValue { .. }
        | ParseError::InvalidSessionName { .. } => ERROR_INVALID_VALUE,
    }
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
        print_help_output(flags.json, clean.get(1).map(String::as_str));
        return;
    }

    // --help
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help_output(flags.json, clean.first().map(String::as_str));
        return;
    }

    // --version
    if args.iter().any(|a| a == "--version" || a == "-V") {
        print_version(flags.json);
        return;
    }
    let controller_override_error = match &flags.controller {
        ControllerOverride::MissingValue => {
            Some((ERROR_MISSING_ARGUMENTS, "Usage: moat --controller <url>"))
        }
        ControllerOverride::EmptyValue => {
            Some((ERROR_INVALID_VALUE, "--controller requires a non-empty URL"))
        }
        ControllerOverride::Url(_) | ControllerOverride::Unspecified => None,
    };
    if let Some((error_type, message)) = controller_override_error {
        if flags.json {
            print_json_error_with_type(message, error_type);
        } else {
            eprintln!("{} {}", color::error_indicator(), message);
        }
        exit(78);
    }

    if clean.is_empty() {
        print_help_output(flags.json, None);
        return;
    }

    // This must precede parse_command: upstream argument validation must not
    // turn an architectural rejection into missing_arguments/invalid_input.
    if let Some(message) = unsupported_command(&clean[0]) {
        if flags.json {
            print_json_error_with_type(message, ERROR_UNSUPPORTED);
        } else {
            eprintln!("{} {}", color::error_indicator(), message);
        }
        exit(1);
    }

    if let Some(message) = unsupported_flag(&args, &clean[0]) {
        if flags.json {
            print_json_error_with_type(message, ERROR_UNSUPPORTED);
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
                    print_json_error_with_type(message, ERROR_UNSUPPORTED);
                } else {
                    eprintln!("{} {}", color::error_indicator(), message);
                }
                exit(1);
            }
            let url = match controller_url(&flags.controller) {
                Ok(u) => u,
                Err(e) => {
                    if flags.json {
                        print_json_error_with_type(e.message(), e.error_type());
                    } else {
                        eprintln!("{} {}", color::error_indicator(), e.message());
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
                        print_json_error_with_type(
                            "Missing arguments for: use\nUsage: moat use <session-id>",
                            ERROR_MISSING_ARGUMENTS,
                        );
                    } else {
                        eprintln!(
                            "{} Missing arguments for: use\nUsage: moat use <session-id>",
                            color::error_indicator()
                        );
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
        "disconnect" | "destroy" | "close-session" | "close" => {
            let url = match controller_url(&flags.controller) {
                Ok(u) => u,
                Err(e) => {
                    if flags.json {
                        print_json_error_with_type(e.message(), e.error_type());
                    } else {
                        eprintln!("{} {}", color::error_indicator(), e.message());
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
                Err(error) => {
                    if flags.json {
                        print_sdk_json_error(&error);
                    } else {
                        eprintln!("{} {}", color::error_indicator(), error);
                    }
                    exit(1);
                }
            }
            return;
        }

        "status" => {
            match moat_sdk::session::read_session_id() {
                Ok(Some(id)) => {
                    let url =
                        controller_url(&flags.controller).unwrap_or_else(|_| "(not set)".into());
                    if flags.json {
                        println!(
                            "{}",
                            serde_json::to_string(&json!({
                                "success": true,
                                "data": {
                                    "sessionId": id,
                                    "controller": url,
                                    "view": "local_session_config",
                                    "remoteChecked": false
                                }
                            }))
                            .unwrap()
                        );
                    } else {
                        println!("Session:    {}", id);
                        println!("Controller: {}", url);
                        println!("View:       local session/config (remote health not checked)");
                    }
                }
                _ => {
                    if flags.json {
                        print_json_error_with_type("No active session", ERROR_TARGET_NOT_FOUND);
                    } else {
                        eprintln!("{} No active session.", color::error_indicator());
                    }
                    exit(77);
                }
            }
            return;
        }

        _ => {} // Fall through to command execution
    }

    // ─── Parse command using upstream's parse_command ───

    let cmd = match parse_command(&clean, &flags) {
        Ok(c) => c,
        Err(e) => {
            if flags.json {
                print_json_error_with_type(e.format(), parse_error_type(&e));
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

    let url = match controller_url(&flags.controller) {
        Ok(u) => u,
        Err(e) => {
            if flags.json {
                print_json_error_with_type(e.message(), e.error_type());
            } else {
                eprintln!("{} {}", color::error_indicator(), e.message());
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
                    print_json_error_with_type(
                        "No active session. Run `moat init` first.",
                        ERROR_TARGET_NOT_FOUND,
                    );
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

    let url = match controller_url(&flags.controller) {
        Ok(u) => u,
        Err(e) => {
            if flags.json {
                print_json_error_with_type(e.message(), e.error_type());
            } else {
                eprintln!("{} {}", color::error_indicator(), e.message());
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
                    print_json_error_with_type(e.format(), parse_error_type(&e));
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
                        "errorType": ERROR_COMMAND_FAILED,
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
