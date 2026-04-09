use std::fmt;

#[derive(Debug)]
pub enum SdkError {
    NoSession,
    ConnectionFailed(String),
    WebSocket(String),
    RegisterFailed { error: String, code: u32 },
    CommandFailed { error: String, code: u32 },
    DeregisterFailed,
    SessionFileError(String),
    ConfigError(String),
}

impl fmt::Display for SdkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoSession => write!(f, "No active session. Run `moat connect` first."),
            Self::ConnectionFailed(msg) => write!(f, "Connection failed: {}", msg),
            Self::WebSocket(msg) => write!(f, "WebSocket error: {}", msg),
            Self::RegisterFailed { error, code } => {
                write!(f, "Register failed (code {}): {}", code, error)
            }
            Self::CommandFailed { error, code } => {
                write!(f, "Command failed (code {}): {}", code, error)
            }
            Self::DeregisterFailed => write!(f, "Deregister failed"),
            Self::SessionFileError(msg) => write!(f, "Session file error: {}", msg),
            Self::ConfigError(msg) => write!(f, "Config error: {}", msg),
        }
    }
}

impl std::error::Error for SdkError {}
