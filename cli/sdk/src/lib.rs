pub mod error;
pub mod session;
pub mod wire;

use error::SdkError;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use wire::{Response, WireRequest, WireResponse};

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Stateless client — each operation opens a fresh WebSocket connection.
pub struct MoatClient {
    url: String,
    session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScreenshotOutput {
    requested_path: Option<String>,
    screenshot_dir: Option<String>,
    format: String,
    inline_base64: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BinaryOutput {
    requested_path: Option<String>,
    default_directory: String,
    default_filename: String,
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
        let (screenshot_output, binary_output) = prepare_command(&mut request)?;

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
                if let (Some(ref output), Some(ref mut d)) = (&screenshot_output, &mut data) {
                    materialize_screenshot_response(d, output)?;
                }
                if let (Some(ref output), Some(ref mut d)) = (&binary_output, &mut data) {
                    materialize_binary_response(d, output)?;
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

fn prepare_command(
    request: &mut Value,
) -> Result<(Option<ScreenshotOutput>, Option<BinaryOutput>), SdkError> {
    let mut screenshot_output = None;
    let mut binary_output = None;
    let Some(obj) = request.as_object_mut() else {
        return Ok((screenshot_output, binary_output));
    };

    obj.remove("id");
    if obj.get("action").and_then(|v| v.as_str()) == Some("evaluate") {
        obj.insert("action".into(), Value::String("eval".into()));
        if let Some(script) = obj.remove("script") {
            obj.insert("code".into(), script);
        }
    }

    if let Some(sel) = obj.get("selector").and_then(|v| v.as_str()).map(String::from) {
        if sel.starts_with('@') {
            obj.remove("selector");
            obj.insert("ref".into(), Value::String(sel));
        }
    }

    if obj.get("action").and_then(|v| v.as_str()) == Some("screenshot") {
        screenshot_output = Some(ScreenshotOutput {
            requested_path: obj.get("path").and_then(|v| v.as_str()).map(String::from),
            screenshot_dir: obj
                .get("screenshotDir")
                .and_then(|v| v.as_str())
                .map(String::from),
            format: obj
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("png")
                .to_string(),
            inline_base64: obj
                .get("inlineBase64")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
        obj.remove("path");
        obj.remove("screenshotDir");
        obj.remove("inlineBase64");
    }

    if obj.get("action").and_then(|v| v.as_str()) == Some("upload") {
        let files = obj
            .get("files")
            .and_then(|value| value.as_array())
            .ok_or_else(|| SdkError::CommandFailed {
                error: "upload files must be an array".into(),
                code: 1,
            })?;
        let payloads = files
            .iter()
            .map(|value| {
                let path = value.as_str().ok_or_else(|| SdkError::CommandFailed {
                    error: "upload file path must be a string".into(),
                    code: 1,
                })?;
                let bytes = std::fs::read(path).map_err(|e| SdkError::CommandFailed {
                    error: format!("read upload file {}: {}", path, e),
                    code: 1,
                })?;
                let name = PathBuf::from(path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| SdkError::CommandFailed {
                        error: format!("upload path has no file name: {}", path),
                        code: 1,
                    })?
                    .to_string();
                Ok(serde_json::json!({
                    "name": name,
                    "mimeType": mime_type_for_path(path),
                    "base64": STANDARD.encode(bytes),
                }))
            })
            .collect::<Result<Vec<Value>, SdkError>>()?;
        obj.insert("files".into(), Value::Array(payloads));
    }

    if obj.get("action").and_then(|v| v.as_str()) == Some("state_load") {
        let path = obj
            .get("path")
            .and_then(|value| value.as_str())
            .ok_or_else(|| SdkError::CommandFailed {
                error: "state load requires a path".into(),
                code: 1,
            })?;
        let contents = std::fs::read_to_string(path).map_err(|e| SdkError::CommandFailed {
            error: format!("read state file {}: {}", path, e),
            code: 1,
        })?;
        let state = serde_json::from_str::<Value>(&contents).map_err(|e| SdkError::CommandFailed {
            error: format!("parse state file {}: {}", path, e),
            code: 1,
        })?;
        obj.remove("path");
        obj.insert("state".into(), state);
    }

    match obj.get("action").and_then(|value| value.as_str()) {
        Some("download") | Some("waitfordownload") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj.get("path").and_then(|value| value.as_str()).map(String::from),
                default_directory: "moat-downloads".into(),
                default_filename: "download.bin".into(),
            });
            obj.remove("path");
        }
        Some("pdf") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj.get("path").and_then(|value| value.as_str()).map(String::from),
                default_directory: "moat-pdfs".into(),
                default_filename: "page.pdf".into(),
            });
            obj.remove("path");
        }
        Some("state_save") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj.get("path").and_then(|value| value.as_str()).map(String::from),
                default_directory: "moat-states".into(),
                default_filename: "state.json".into(),
            });
            obj.remove("path");
        }
        Some("trace_stop") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj.get("path").and_then(|value| value.as_str()).map(String::from),
                default_directory: "moat-traces".into(),
                default_filename: "trace.zip".into(),
            });
            obj.remove("path");
        }
        Some("profiler_stop") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj.get("path").and_then(|value| value.as_str()).map(String::from),
                default_directory: "moat-profiles".into(),
                default_filename: "profile.json".into(),
            });
            obj.remove("path");
        }
        Some("har_stop") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj.get("path").and_then(|value| value.as_str()).map(String::from),
                default_directory: "moat-har".into(),
                default_filename: "network.har".into(),
            });
            obj.remove("path");
        }
        _ => {}
    }

    Ok((screenshot_output, binary_output))
}

fn mime_type_for_path(path: &str) -> &'static str {
    match PathBuf::from(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("txt") => "text/plain",
        Some("html") | Some("htm") => "text/html",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn materialize_binary_response(
    data: &mut Value,
    output: &BinaryOutput,
) -> Result<(), SdkError> {
    let Some(obj) = data.as_object_mut() else {
        return Ok(());
    };
    let Some(base64_value) = obj.get("base64").and_then(|value| value.as_str()) else {
        return Ok(());
    };
    let bytes = STANDARD
        .decode(base64_value)
        .map_err(|e| SdkError::CommandFailed {
            error: format!("invalid file base64: {}", e),
            code: 1,
        })?;
    let suggested = obj
        .get("suggestedFilename")
        .and_then(|value| value.as_str())
        .unwrap_or(&output.default_filename);
    let path = match output.requested_path.as_deref() {
        Some(requested) => {
            let requested_path = PathBuf::from(requested);
            if requested.ends_with(std::path::MAIN_SEPARATOR) || requested_path.is_dir() {
                requested_path.join(suggested)
            } else {
                requested_path
            }
        }
        None => std::env::temp_dir()
            .join(&output.default_directory)
            .join(suggested),
    };
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| SdkError::CommandFailed {
                error: format!("create output directory {}: {}", parent.display(), e),
                code: 1,
            })?;
        }
    }
    std::fs::write(&path, &bytes).map_err(|e| SdkError::CommandFailed {
        error: format!("write output {}: {}", path.display(), e),
        code: 1,
    })?;
    obj.insert(
        "path".into(),
        Value::String(path.to_string_lossy().to_string()),
    );
    obj.insert("size".into(), Value::Number(bytes.len().into()));
    obj.remove("base64");
    Ok(())
}

fn materialize_screenshot_response(
    data: &mut Value,
    output: &ScreenshotOutput,
) -> Result<(), SdkError> {
    let Some(obj) = data.as_object_mut() else {
        return Ok(());
    };
    let Some(base64_value) = obj.get("base64").and_then(|v| v.as_str()) else {
        return Ok(());
    };

    let bytes = STANDARD
        .decode(base64_value)
        .map_err(|e| SdkError::CommandFailed {
            error: format!("invalid screenshot base64: {}", e),
            code: 1,
        })?;
    let path = resolve_screenshot_path(output)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| SdkError::CommandFailed {
                error: format!("create screenshot directory {}: {}", parent.display(), e),
                code: 1,
            })?;
        }
    }
    std::fs::write(&path, &bytes).map_err(|e| SdkError::CommandFailed {
        error: format!("write screenshot {}: {}", path.display(), e),
        code: 1,
    })?;

    obj.insert(
        "path".to_string(),
        Value::String(path.to_string_lossy().to_string()),
    );
    obj.insert(
        "size".to_string(),
        Value::Number(serde_json::Number::from(bytes.len())),
    );
    if !output.inline_base64 {
        obj.remove("base64");
    }

    Ok(())
}

fn resolve_screenshot_path(output: &ScreenshotOutput) -> Result<PathBuf, SdkError> {
    if let Some(path) = output.requested_path.as_deref() {
        let requested = PathBuf::from(path);
        if path.ends_with(std::path::MAIN_SEPARATOR) || requested.is_dir() {
            return Ok(requested.join(default_screenshot_filename(&output.format)?));
        }
        return Ok(requested);
    }

    let dir = output
        .screenshot_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("moat-screenshots"));
    Ok(dir.join(default_screenshot_filename(&output.format)?))
}

fn default_screenshot_filename(format: &str) -> Result<String, SdkError> {
    let ext = match format {
        "jpeg" => "jpg",
        "png" => "png",
        other => {
            return Err(SdkError::CommandFailed {
                error: format!("unsupported screenshot format: {}", other),
                code: 1,
            });
        }
    };
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| SdkError::CommandFailed {
            error: format!("system clock before UNIX_EPOCH: {}", e),
            code: 1,
        })?
        .as_nanos();
    Ok(format!("moat-screenshot-{}.{}", nanos, ext))
}

// ─── WebSocket helpers ───

async fn send_json<T: serde::Serialize>(ws: &mut WsStream, msg: &T) -> Result<(), SdkError> {
    let json = serde_json::to_string(msg).map_err(|e| SdkError::WebSocket(e.to_string()))?;
    ws.send(Message::Text(json))
        .await
        .map_err(|e| SdkError::WebSocket(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "moat-sdk-test-{}-{}",
            name,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn prepare_upload_embeds_bytes_filename_and_mime_type() {
        let dir = test_dir("upload");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.json");
        std::fs::write(&path, br#"{"ok":true}"#).unwrap();
        let mut request = json!({
            "id": "cli-id",
            "action": "upload",
            "selector": "input[type=file]",
            "files": [path.to_string_lossy()]
        });

        let outputs = prepare_command(&mut request).unwrap();

        assert_eq!(outputs, (None, None));
        assert!(request.get("id").is_none());
        assert_eq!(request["files"][0]["name"], "audit.json");
        assert_eq!(request["files"][0]["mimeType"], "application/json");
        assert_eq!(
            request["files"][0]["base64"],
            STANDARD.encode(br#"{"ok":true}"#)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prepare_download_keeps_local_path_out_of_wire_request() {
        let mut request = json!({
            "action": "download",
            "selector": "#download",
            "path": "artifacts/report.txt"
        });

        let (_, output) = prepare_command(&mut request).unwrap();

        assert!(request.get("path").is_none());
        assert_eq!(
            output,
            Some(BinaryOutput {
                requested_path: Some("artifacts/report.txt".into()),
                default_directory: "moat-downloads".into(),
                default_filename: "download.bin".into(),
            })
        );
    }

    #[test]
    fn prepare_state_save_keeps_output_path_local() {
        let mut request = json!({
            "action": "state_save",
            "path": "artifacts/auth-state.json"
        });

        let (_, output) = prepare_command(&mut request).unwrap();

        assert_eq!(request, json!({ "action": "state_save" }));
        assert_eq!(
            output,
            Some(BinaryOutput {
                requested_path: Some("artifacts/auth-state.json".into()),
                default_directory: "moat-states".into(),
                default_filename: "state.json".into(),
            })
        );
    }

    #[test]
    fn prepare_state_load_reads_and_parses_local_state_file() {
        let dir = test_dir("state-load");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let state = json!({ "cookies": [], "origins": [] });
        std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
        let mut request = json!({
            "action": "state_load",
            "path": path.to_string_lossy()
        });

        let outputs = prepare_command(&mut request).unwrap();

        assert_eq!(outputs, (None, None));
        assert_eq!(request, json!({ "action": "state_load", "state": state }));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn materialize_binary_writes_download_to_requested_path() {
        let dir = test_dir("download");
        let path = dir.join("report.txt");
        let mut data = json!({
            "base64": STANDARD.encode(b"downloaded bytes"),
            "suggestedFilename": "server-name.txt"
        });
        let output = BinaryOutput {
            requested_path: Some(path.to_string_lossy().to_string()),
            default_directory: "moat-downloads".into(),
            default_filename: "download.bin".into(),
        };

        materialize_binary_response(&mut data, &output).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"downloaded bytes");
        assert_eq!(data["path"], path.to_string_lossy().to_string());
        assert_eq!(data["size"], 16);
        assert!(data.get("base64").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn materialize_binary_uses_suggested_filename_for_requested_directory() {
        let dir = test_dir("pdf-directory");
        std::fs::create_dir_all(&dir).unwrap();
        let mut data = json!({
            "base64": STANDARD.encode(b"pdf bytes"),
            "suggestedFilename": "page.pdf"
        });
        let output = BinaryOutput {
            requested_path: Some(format!("{}{}", dir.display(), std::path::MAIN_SEPARATOR)),
            default_directory: "moat-pdfs".into(),
            default_filename: "page.pdf".into(),
        };

        materialize_binary_response(&mut data, &output).unwrap();

        let path = dir.join("page.pdf");
        assert_eq!(std::fs::read(&path).unwrap(), b"pdf bytes");
        assert_eq!(data["path"], path.to_string_lossy().to_string());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn materialize_screenshot_writes_requested_path_and_removes_base64_by_default() {
        let dir = std::env::temp_dir().join(format!(
            "moat-sdk-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("shot.png");
        let mut data = json!({
            "base64": STANDARD.encode(b"png-data"),
            "format": "png"
        });
        let output = ScreenshotOutput {
            requested_path: Some(path.to_string_lossy().to_string()),
            screenshot_dir: None,
            format: "png".to_string(),
            inline_base64: false,
        };

        materialize_screenshot_response(&mut data, &output).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"png-data");
        assert_eq!(data["path"], path.to_string_lossy().to_string());
        assert_eq!(data["size"], 8);
        assert!(data.get("base64").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn materialize_screenshot_keeps_base64_when_explicitly_requested() {
        let dir = std::env::temp_dir().join(format!(
            "moat-sdk-test-inline-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut data = json!({
            "base64": STANDARD.encode(b"jpeg-data"),
            "format": "jpeg"
        });
        let output = ScreenshotOutput {
            requested_path: None,
            screenshot_dir: Some(dir.to_string_lossy().to_string()),
            format: "jpeg".to_string(),
            inline_base64: true,
        };

        materialize_screenshot_response(&mut data, &output).unwrap();

        let written_path = data["path"].as_str().unwrap();
        assert!(written_path.ends_with(".jpg"));
        assert_eq!(std::fs::read(written_path).unwrap(), b"jpeg-data");
        assert_eq!(data["base64"], STANDARD.encode(b"jpeg-data"));
        std::fs::remove_dir_all(dir).unwrap();
    }
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
