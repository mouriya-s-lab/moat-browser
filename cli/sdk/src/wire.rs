use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── WireRequest (sent to Controller) ───

#[derive(Serialize)]
#[serde(tag = "type")]
pub enum WireRequest {
    #[serde(rename = "register")]
    Register {
        #[serde(skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
    },
    #[serde(rename = "deregister")]
    Deregister {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "command")]
    Command {
        #[serde(rename = "sessionId")]
        session_id: String,
        command: Value,
    },
}

// ─── WireResponse (received from Controller) ───

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandFailureCause {
    ContainerCreation,
    Cdp,
    Cleanup,
    Transport,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
pub enum WireResponse {
    #[serde(rename = "register_result")]
    RegisterResult {
        success: bool,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        error: Option<String>,
        #[serde(rename = "errorType")]
        error_type: Option<String>,
        code: Option<u32>,
        cause: Option<CommandFailureCause>,
    },
    #[serde(rename = "command_result")]
    CommandResult {
        #[serde(rename = "sessionId")]
        session_id: String,
        success: bool,
        data: Option<Value>,
        error: Option<String>,
        #[serde(rename = "errorType")]
        error_type: Option<String>,
        code: Option<u32>,
        cause: Option<CommandFailureCause>,
    },
    #[serde(rename = "deregister_result")]
    DeregisterResult {
        #[serde(rename = "sessionId")]
        session_id: String,
        success: bool,
        error: Option<String>,
        #[serde(rename = "errorType")]
        error_type: Option<String>,
        code: Option<u32>,
        cause: Option<CommandFailureCause>,
    },
    #[serde(rename = "error")]
    Error { error: String, code: u32 },
}

// ─── Response (agent-browser compatible format returned to CLI) ───

#[derive(Serialize, Deserialize, Debug)]
pub struct Response {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "errorType", skip_serializing_if = "Option::is_none")]
    pub error_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<CommandFailureCause>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}
