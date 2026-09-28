//! Moat connection — stateless command sender.
//! Each command opens a fresh WebSocket, sends one command, closes.

use moat_sdk::error::SdkError;
use moat_sdk::MoatClient;
use serde_json::Value;

// Re-export Response so output.rs can use `crate::connection::Response`
pub use moat_sdk::wire::Response;

/// Send a command through a fresh WebSocket connection to the Controller.
pub async fn send_command(
    cmd: Value,
    controller_url: &str,
    slot: &str,
) -> Result<Response, SdkError> {
    if let Some(result) = moat_sdk::local_command(&cmd) {
        return result;
    }
    let session_id = moat_sdk::session::read_session_id(slot)?
        .ok_or(SdkError::NoSession)?;
    let client = MoatClient::from_session(controller_url.to_string(), session_id, slot)?;
    client.command(cmd).await
}
