pub mod error;
pub mod session;
pub mod wire;

use error::SdkError;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use wire::{Response, WireRequest, WireResponse};

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Stateless client — each operation opens a fresh WebSocket connection.
pub struct MoatClient {
    url: String,
    session_id: String,
}

impl MoatClient {
    /// Init: register a new session (creates container + CDP).
    /// Opens ws, sends Register, receives session ID, closes ws.
    pub async fn init(url: &str, profile: Option<&str>) -> Result<Self, SdkError> {
        let (mut ws, _) = connect_async(url)
            .await
            .map_err(|e| SdkError::ConnectionFailed(e.to_string()))?;

        let req = WireRequest::Register {
            profile: profile.map(String::from),
        };
        send_json(&mut ws, &req).await?;
        let resp = recv_json(&mut ws).await?;

        // Close ws — session lives server-side, not tied to this connection
        let _ = ws.close(None).await;

        match resp {
            WireResponse::RegisterResult {
                success: true,
                session_id: Some(sid),
                ..
            } => {
                session::write_session_id(&sid)?;
                Ok(Self {
                    url: url.to_string(),
                    session_id: sid,
                })
            }
            WireResponse::RegisterResult {
                success: false,
                error,
                code,
                ..
            } => Err(SdkError::RegisterFailed {
                error: error.unwrap_or_default(),
                code: code.unwrap_or(1),
            }),
            _ => Err(SdkError::RegisterFailed {
                error: "unexpected response".into(),
                code: 1,
            }),
        }
    }

    /// Create client from an existing session ID (for subsequent commands).
    pub fn from_session(url: String, session_id: String) -> Self {
        Self { url, session_id }
    }

    /// Send a command — opens a fresh ws, sends Command, receives response, closes ws.
    pub async fn command(&self, mut request: Value) -> Result<Response, SdkError> {
        // Strip "id" field (CLI artifact, not needed for WebSocket)
        if let Some(obj) = request.as_object_mut() {
            obj.remove("id");

            // evaluate → eval name mapping
            if obj.get("action").and_then(|v| v.as_str()) == Some("evaluate") {
                obj.insert("action".into(), Value::String("eval".into()));
                // script → code field mapping
                if let Some(script) = obj.remove("script") {
                    obj.insert("code".into(), script);
                }
            }

            // @eN in selector → move to ref field (CLI puts @refs in selector,
            // but Controller expects them in ref for refStore lookup)
            if let Some(sel) = obj.get("selector").and_then(|v| v.as_str()).map(String::from) {
                if sel.starts_with("@e") || sel.starts_with("@") {
                    obj.remove("selector");
                    obj.insert("ref".into(), Value::String(sel));
                }
            }
        }

        // close → deregister
        if request
            .get("action")
            .and_then(|v| v.as_str())
            == Some("close")
        {
            self.destroy().await?;
            return Ok(Response {
                success: true,
                data: None,
                error: None,
                warning: None,
            });
        }

        let (mut ws, _) = connect_async(&self.url)
            .await
            .map_err(|e| SdkError::ConnectionFailed(e.to_string()))?;

        let wire_req = WireRequest::Command {
            session_id: self.session_id.clone(),
            command: request,
        };
        send_json(&mut ws, &wire_req).await?;
        let resp = recv_json(&mut ws).await?;

        let _ = ws.close(None).await;

        match resp {
            WireResponse::CommandResult {
                success: true,
                mut data,
                ..
            } => {
                // Strip _tag from data (CLI doesn't need discriminant)
                if let Some(ref mut d) = data {
                    if let Some(obj) = d.as_object_mut() {
                        obj.remove("_tag");
                    }
                }
                Ok(Response {
                    success: true,
                    data,
                    error: None,
                    warning: None,
                })
            }
            WireResponse::CommandResult {
                success: false,
                error,
                ..
            } => Ok(Response {
                success: false,
                data: None,
                error,
                warning: None,
            }),
            WireResponse::Error { error, .. } => Ok(Response {
                success: false,
                data: None,
                error: Some(error),
                warning: None,
            }),
            _ => Err(SdkError::CommandFailed {
                error: "unexpected response".into(),
                code: 1,
            }),
        }
    }

    /// Destroy session — opens ws, sends Deregister, closes ws.
    pub async fn destroy(&self) -> Result<(), SdkError> {
        let (mut ws, _) = connect_async(&self.url)
            .await
            .map_err(|e| SdkError::ConnectionFailed(e.to_string()))?;

        let req = WireRequest::Deregister {
            session_id: self.session_id.clone(),
        };
        send_json(&mut ws, &req).await?;
        let resp = recv_json(&mut ws).await?;

        let _ = ws.close(None).await;

        session::clear_session_id()?;

        match resp {
            WireResponse::DeregisterResult { success: true, .. } => Ok(()),
            _ => Err(SdkError::DeregisterFailed),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

// ─── WebSocket helpers ───

async fn send_json<T: serde::Serialize>(ws: &mut WsStream, msg: &T) -> Result<(), SdkError> {
    let json = serde_json::to_string(msg).map_err(|e| SdkError::WebSocket(e.to_string()))?;
    ws.send(Message::Text(json))
        .await
        .map_err(|e| SdkError::WebSocket(e.to_string()))
}

async fn recv_json(ws: &mut WsStream) -> Result<WireResponse, SdkError> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str(&text)
                    .map_err(|e| SdkError::WebSocket(format!("parse: {} | raw: {}", e, text)));
            }
            Some(Ok(Message::Ping(_))) => continue,
            Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) => {
                return Err(SdkError::WebSocket("connection closed".into()));
            }
            Some(Err(e)) => return Err(SdkError::WebSocket(e.to_string())),
            None => return Err(SdkError::WebSocket("stream ended".into())),
            _ => continue,
        }
    }
}
