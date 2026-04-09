//! Replacement for agent-browser's connection.rs.
//!
//! Original: Unix socket / TCP to local daemon.
//! Moat:     WebSocket via moat-sdk to remote Controller.

use moat_sdk::error::SdkError;
use moat_sdk::MoatClient;
use serde_json::Value;

// Re-export Response so output.rs can use `crate::connection::Response`
pub use moat_sdk::wire::Response;

pub struct Connection {
    client: MoatClient,
}

impl Connection {
    /// Establish a connection by resuming the stored session.
    pub async fn connect(controller_url: &str) -> Result<Self, SdkError> {
        let session_id = moat_sdk::session::read_session_id()?
            .ok_or(SdkError::NoSession)?;
        let client = MoatClient::resume(controller_url, &session_id).await?;
        Ok(Self { client })
    }

    /// Send a command in agent-browser Request format, receive a Response.
    pub async fn send(&mut self, request: Value) -> Result<Response, SdkError> {
        self.client.command(request).await
    }
}

/// Send a command through a fresh connection to the Controller.
pub async fn send_command(cmd: Value, controller_url: &str) -> Result<Response, String> {
    let mut conn = Connection::connect(controller_url)
        .await
        .map_err(|e| e.to_string())?;
    conn.send(cmd).await.map_err(|e| e.to_string())
}
