use std::fmt;

use crate::wire::{CapacityDetails, CommandFailureCause};

#[derive(Debug)]
pub enum SdkError {
    NoSession,
    SessionAlreadyActive { session_id: String },
    ConnectionFailed(String),
    WebSocket(String),
    RegisterFailed {
        error: String,
        code: u32,
        error_type: Option<String>,
        cause: Option<CommandFailureCause>,
        capacity: Option<CapacityDetails>,
    },
    CommandFailed {
        error: String,
        code: u32,
        cause: CommandFailureCause,
    },
    DeregisterFailed {
        error: String,
        code: u32,
        error_type: Option<String>,
        cause: Option<CommandFailureCause>,
        capacity: Option<CapacityDetails>,
    },
    SessionFileError(String),
    ConfigError(String),
}

impl SdkError {
    pub fn command_failure_cause(&self) -> Option<CommandFailureCause> {
        match self {
            Self::ConnectionFailed(_) | Self::WebSocket(_) => {
                Some(CommandFailureCause::Transport)
            }
            Self::RegisterFailed { cause, .. } | Self::DeregisterFailed { cause, .. } => *cause,
            Self::CommandFailed { cause, .. } => Some(*cause),
            Self::NoSession => None,
            Self::SessionAlreadyActive { .. }
            | Self::SessionFileError(_)
            | Self::ConfigError(_) => Some(CommandFailureCause::Transport),
        }
    }

    pub fn capacity_details(&self) -> Option<&CapacityDetails> {
        match self {
            Self::RegisterFailed { capacity, .. } | Self::DeregisterFailed { capacity, .. } => {
                capacity.as_ref()
            }
            _ => None,
        }
    }
}

impl fmt::Display for SdkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoSession => write!(f, "No active session. Run `moat init` first."),
            Self::SessionAlreadyActive { session_id } => {
                write!(
                    f,
                    "Session already active: {session_id}; disconnect it before connecting again"
                )
            }
            Self::ConnectionFailed(msg) => write!(f, "Connection failed: {}", msg),
            Self::WebSocket(msg) => write!(f, "WebSocket error: {}", msg),
            Self::RegisterFailed { error, code, .. } => {
                write!(f, "Register failed (code {}): {}", code, error)
            }
            Self::CommandFailed { error, code, .. } => {
                write!(f, "Command failed (code {}): {}", code, error)
            }
            Self::DeregisterFailed {
                error,
                code,
                error_type,
                ..
            } => {
                if let Some(error_type) = error_type {
                    write!(f, "Deregister failed ({error_type}, code {code}): {error}")
                } else {
                    write!(f, "Deregister failed (code {code}): {error}")
                }
            }
            Self::SessionFileError(msg) => write!(f, "Session file error: {}", msg),
            Self::ConfigError(msg) => write!(f, "Config error: {}", msg),
        }
    }
}

impl std::error::Error for SdkError {}
