mod diff;
pub mod error;
pub mod session;
pub mod wire;

use base64::{engine::general_purpose::STANDARD, Engine};
use error::SdkError;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream};
use tokio::time::{timeout_at, Instant};
use wire::{CapacityDetails, CommandFailureCause, DialogPage, Response, WireRequest, WireResponse};

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect a client WebSocket and disable Nagle's algorithm on the underlying
/// TCP stream. Large command/artifact responses cross a Docker published-port
/// (userland-proxy) hop where Nagle + delayed-ACK collapses throughput; keeping
/// TCP_NODELAY on every SDK socket bounds per-frame latency to the wire itself.
async fn connect_ws(url: &str) -> Result<WsStream, SdkError> {
    let (ws, _) = connect_async(url)
        .await
        .map_err(|e| SdkError::ConnectionFailed(e.to_string()))?;
    if let MaybeTlsStream::Plain(tcp) = ws.get_ref() {
        let _ = tcp.set_nodelay(true);
    }
    Ok(ws)
}
const DEFAULT_SERVER_COMMAND_BUDGET_MS: u64 = 25_000;
const REGISTER_SERVER_BUDGET_MS: u64 = 45_000;
const CLIENT_GRACE_MS: u64 = 5_000;
const MAX_EXPLICIT_COMMAND_BUDGET_MS: u64 = 120_000;
const MAX_ENCODED_WIRE_BYTES: usize = 8 * 1024 * 1024;
#[derive(Clone, Copy)]
struct ClientDeadline {
    at: Instant,
    server_budget_ms: u64,
}

impl ClientDeadline {
    fn new(server_budget_ms: u64) -> Self {
        let total_ms = server_budget_ms.saturating_add(CLIENT_GRACE_MS);
        Self {
            at: Instant::now() + Duration::from_millis(total_ms),
            server_budget_ms,
        }
    }
}

fn client_timeout(deadline: ClientDeadline, operation: &'static str) -> SdkError {
    SdkError::Timeout {
        operation: operation.into(),
        budget_ms: Some(deadline.server_budget_ms),
    }
}

async fn with_client_deadline<T, F>(
    deadline: ClientDeadline,
    operation: &'static str,
    future: F,
) -> Result<T, SdkError>
where
    F: Future<Output = Result<T, SdkError>>,
{
    match timeout_at(deadline.at, future).await {
        Ok(result) => result,
        Err(_) => Err(client_timeout(deadline, operation)),
    }
}

fn command_server_budget(request: &Value) -> u64 {
    let action = request.get("action").and_then(Value::as_str);
    let is_wait = matches!(
        action,
        Some("wait" | "waitforurl" | "waitforloadstate" | "waitforfunction" | "waitfordownload")
    );
    if !is_wait {
        return DEFAULT_SERVER_COMMAND_BUDGET_MS;
    }
    request
        .get("timeout")
        .and_then(Value::as_u64)
        .filter(|value| (1..=MAX_EXPLICIT_COMMAND_BUDGET_MS).contains(value))
        .unwrap_or(DEFAULT_SERVER_COMMAND_BUDGET_MS)
}

pub fn local_command(request: &Value) -> Option<Result<Response, SdkError>> {
    let action = request.get("action").and_then(Value::as_str)?;
    if let Some(reason) = unsupported_reason(action) {
        return Some(Err(SdkError::CommandFailed {
            error: format!("unsupported_in_moat: {}", reason),
            code: 1,
            cause: CommandFailureCause::Transport,
        }));
    }
    let result = match action {
        "state_list" => local_state_list(),
        "state_show" => local_state_show(request),
        "state_clear" => local_state_clear(request),
        "state_clean" => local_state_clean(request),
        "state_rename" => local_state_rename(request),
        _ => return None,
    };
    Some(result.map(|data| Response {
        success: true,
        data: Some(data),
        error: None,
        error_type: None,
        details: None,
        cause: None,
        operation_id: None,
        dialog_id: None,
        page: None,

        owner: None,
        current: None,
        limit: None,
        owner_current: None,
        owner_limit: None,
        retry_condition: None,
        warning: None,
    }))
}

fn unsupported_reason(action: &str) -> Option<&'static str> {
    match action {
        "auth_save" | "auth_login" | "auth_list" | "auth_show" | "auth_delete" => {
            Some("auth commands are replaced by moat profiles and neko login")
        }
        "confirm" | "deny" => Some("moat-browser has no CLI action-policy confirmation layer"),
        "launch" => Some("CDP targets are created and managed by the moat Controller"),
        "stream_enable" | "stream_disable" | "stream_status" => {
            Some("moat-browser uses neko WebRTC instead of a CLI-local stream server")
        }
        "recording_start" | "recording_stop" | "recording_restart" => {
            Some("browser video recording is not part of the moat Controller contract")
        }
        _ => None,
    }
}

fn state_directory() -> Result<PathBuf, SdkError> {
    let home = dirs::home_dir().ok_or_else(|| SdkError::CommandFailed {
        error: "cannot resolve home directory for moat states".into(),
        code: 1,
        cause: CommandFailureCause::Transport,
    })?;
    let directory = home.join(".moat").join("states");
    std::fs::create_dir_all(&directory).map_err(|e| SdkError::CommandFailed {
        error: format!("create state directory {}: {}", directory.display(), e),
        code: 1,
        cause: CommandFailureCause::Transport,
    })?;
    Ok(directory)
}

fn state_path(name: &str) -> Result<PathBuf, SdkError> {
    let direct = PathBuf::from(name);
    if direct.is_absolute() || direct.components().count() > 1 {
        return Ok(direct);
    }
    let filename = if name.ends_with(".json") {
        name.to_string()
    } else {
        format!("{}.json", name)
    };
    Ok(state_directory()?.join(filename))
}

fn local_state_list() -> Result<Value, SdkError> {
    let directory = state_directory()?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|e| SdkError::CommandFailed {
        error: format!("read state directory {}: {}", directory.display(), e),
        code: 1,
            cause: CommandFailureCause::Transport,
    })? {
        let entry = entry.map_err(|e| SdkError::CommandFailed {
            error: format!("read state entry: {}", e),
            code: 1,
            cause: CommandFailureCause::Transport,
        })?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| SdkError::CommandFailed {
            error: format!("read state metadata {}: {}", path.display(), e),
            code: 1,
            cause: CommandFailureCause::Transport,
        })?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs().to_string())
            .unwrap_or_default();
        files.push(serde_json::json!({
            "filename": path.file_name().and_then(|value| value.to_str()).unwrap_or_default(),
            "path": path,
            "size": metadata.len(),
            "modified": modified,
            "encrypted": false,
            "managed": true,
            "namespace": "default",
        }));
    }
    files.sort_by(|left, right| left["filename"].as_str().cmp(&right["filename"].as_str()));
    Ok(serde_json::json!({ "files": files, "directory": directory }))
}

fn local_state_show(request: &Value) -> Result<Value, SdkError> {
    let name =
        request
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| SdkError::CommandFailed {
                error: "state show requires a filename".into(),
                code: 1,
                cause: CommandFailureCause::Transport,
            })?;
    let path = state_path(name)?;
    let contents = std::fs::read_to_string(&path).map_err(|e| SdkError::CommandFailed {
        error: format!("read state file {}: {}", path.display(), e),
        code: 1,
        cause: CommandFailureCause::Transport,
    })?;
    let state: Value = serde_json::from_str(&contents).map_err(|e| SdkError::CommandFailed {
        error: format!("parse state file {}: {}", path.display(), e),
        code: 1,
        cause: CommandFailureCause::Transport,
    })?;
    let cookies = state
        .get("cookies")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let origins = state
        .get("origins")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let tabs = state
        .get("tabs")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let indexed_db = state
        .get("origins")
        .and_then(Value::as_array)
        .map(|origins| {
            origins
                .iter()
                .filter_map(|origin| origin.get("indexedDB").and_then(Value::as_array))
                .map(Vec::len)
                .sum::<usize>()
        })
        .unwrap_or(0);
    let default_directory = state_directory()?;
    let managed = path.parent() == Some(default_directory.as_path());
    Ok(serde_json::json!({
        "path": path,
        "encrypted": false,
        "managed": managed,
        "namespace": if managed { "default" } else { "explicit" },
        "summary": { "cookies": cookies, "origins": origins, "tabs": tabs, "indexedDB": indexed_db },
    }))
}

fn local_state_clear(request: &Value) -> Result<Value, SdkError> {
    let all = request.get("all").and_then(Value::as_bool) == Some(true);
    let confirmed = request.get("confirm").and_then(Value::as_bool) == Some(true);
    if all && !confirmed {
        return Err(SdkError::MissingArguments {
            error: "state clear --all requires explicit confirmation; rerun with --confirm".into(),
        });
    }

    let directory = state_directory()?;
    let mut cleared = 0_u64;
    if all {
        for entry in std::fs::read_dir(&directory).map_err(|e| SdkError::CommandFailed {
            error: format!("read state directory {}: {}", directory.display(), e),
            code: 1,
            cause: CommandFailureCause::Transport,
        })? {
            let path = entry
                .map_err(|e| SdkError::CommandFailed {
                    error: format!("read state entry: {}", e),
                    code: 1,
                    cause: CommandFailureCause::Transport,
                })?
                .path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                std::fs::remove_file(&path).map_err(|e| SdkError::CommandFailed {
                    error: format!("remove state file {}: {}", path.display(), e),
                    code: 1,
                    cause: CommandFailureCause::Transport,
                })?;
                cleared += 1;
            }
        }
    } else if let Some(name) = request.get("sessionName").and_then(Value::as_str) {
        let path = state_path(name)?;
        std::fs::remove_file(&path).map_err(|e| SdkError::CommandFailed {
            error: format!("remove state file {}: {}", path.display(), e),
            code: 1,
            cause: CommandFailureCause::Transport,
        })?;
        cleared = 1;
    } else {
        return Err(SdkError::CommandFailed {
            error: "state clear requires a state name or --all".into(),
            code: 1,
            cause: CommandFailureCause::Transport,
        });
    }
    Ok(serde_json::json!({
        "cleared": cleared,
        "directory": directory,
        "managed": true,
    }))
}

fn local_state_clean(request: &Value) -> Result<Value, SdkError> {
    let days =
        request
            .get("days")
            .and_then(Value::as_i64)
            .ok_or_else(|| SdkError::CommandFailed {
                error: "state clean requires --older-than <days>".into(),
                code: 1,
                cause: CommandFailureCause::Transport,
            })?;
    if days < 0 {
        return Err(SdkError::CommandFailed {
            error: "state clean days cannot be negative".into(),
            code: 1,
            cause: CommandFailureCause::Transport,
        });
    }
    let directory = state_directory()?;
    let threshold = std::time::Duration::from_secs(days as u64 * 86_400);
    let now = SystemTime::now();
    let mut cleaned = 0_u64;
    for entry in std::fs::read_dir(&directory).map_err(|e| SdkError::CommandFailed {
        error: format!("read state directory {}: {}", directory.display(), e),
        code: 1,
            cause: CommandFailureCause::Transport,
    })? {
        let entry = entry.map_err(|e| SdkError::CommandFailed {
            error: e.to_string(),
            code: 1,
            cause: CommandFailureCause::Transport,
        })?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > threshold);
        if old {
            std::fs::remove_file(&path).map_err(|e| SdkError::CommandFailed {
                error: format!("remove state file {}: {}", path.display(), e),
                code: 1,
                cause: CommandFailureCause::Transport,
            })?;
            cleaned += 1;
        }
    }
    Ok(serde_json::json!({ "cleaned": cleaned, "days": days }))
}

fn local_state_rename(request: &Value) -> Result<Value, SdkError> {
    let old_name = request
        .get("oldName")
        .and_then(Value::as_str)
        .ok_or_else(|| SdkError::CommandFailed {
            error: "state rename requires an old name".into(),
            code: 1,
            cause: CommandFailureCause::Transport,
        })?;
    let new_name = request
        .get("newName")
        .and_then(Value::as_str)
        .ok_or_else(|| SdkError::CommandFailed {
            error: "state rename requires a new name".into(),
            code: 1,
            cause: CommandFailureCause::Transport,
        })?;
    let old_path = state_path(old_name)?;
    let new_path = state_directory()?.join(format!("{}.json", new_name.trim_end_matches(".json")));
    std::fs::rename(&old_path, &new_path).map_err(|e| SdkError::CommandFailed {
        error: format!(
            "rename state {} to {}: {}",
            old_path.display(),
            new_path.display(),
            e
        ),
        code: 1,
        cause: CommandFailureCause::Transport,
    })?;
    Ok(serde_json::json!({
        "renamed": true,
        "oldName": old_name,
        "newName": new_name,
        "path": new_path,
    }))
}

/// Stateless client — each operation opens a fresh WebSocket connection.
pub struct MoatClient {
    url: String,
    session_id: String,
    slot: String,
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

fn protocol_error(message: impl Into<String>) -> SdkError {
    SdkError::CommandFailed {
        error: message.into(),
        code: 1,
        cause: CommandFailureCause::Transport,
    }
}

fn validate_wire_failure(
    error_type: Option<&str>,
    cause: Option<CommandFailureCause>,
) -> Result<Option<CommandFailureCause>, SdkError> {
    match (error_type, cause) {
        (Some("command_failed"), Some(cause)) => Ok(Some(cause)),
        (Some("command_failed"), None) => {
            Err(protocol_error("command_failed response missing cause"))
        }
        (Some(_), None) => Ok(None),
        (Some(error_type), Some(_)) => Err(protocol_error(format!(
            "wire failure cause is only valid for errorType=command_failed (got {error_type})"
        ))),
        (None, Some(_)) => Err(protocol_error("wire failure has cause but missing errorType")),
        (None, None) => Err(protocol_error("wire failure missing errorType")),
    }
}
fn validate_dialog_pending_failure(
    error_type: Option<&str>,
    cause: Option<&CommandFailureCause>,
    operation_id: Option<String>,
    dialog_id: Option<String>,
    page: Option<DialogPage>,
) -> Result<(Option<String>, Option<String>, Option<DialogPage>), SdkError> {
    if !matches!(cause, Some(CommandFailureCause::DialogPending)) {
        return Ok((operation_id, dialog_id, page));
    }
    if error_type != Some("command_failed") {
        return Err(protocol_error(
            "dialog_pending cause requires errorType=command_failed",
        ));
    }
    match (dialog_id, page) {
        (Some(dialog_id), Some(page)) => Ok((operation_id, Some(dialog_id), Some(page))),
        _ => Err(protocol_error(
            "dialog_pending response missing dialog/page identity",
        )),
    }
}


fn parse_capacity_details(
    error_type: Option<&str>,
    owner: Option<String>,
    current: Option<u32>,
    limit: Option<u32>,
    owner_current: Option<u32>,
    owner_limit: Option<u32>,
    retry_condition: Option<String>,
) -> Result<Option<CapacityDetails>, SdkError> {
    if error_type != Some("capacity_exceeded") {
        return Ok(None);
    }
    match (
        owner,
        current,
        limit,
        owner_current,
        owner_limit,
        retry_condition,
    ) {
        (
            Some(owner),
            Some(current),
            Some(limit),
            Some(owner_current),
            Some(owner_limit),
            Some(retry_condition),
        ) => Ok(Some(CapacityDetails {
            owner,
            current,
            limit,
            owner_current,
            owner_limit,
            retry_condition,
        })),
        _ => Err(protocol_error(
            "capacity_exceeded response missing quota details",
        )),
    }
}

impl MoatClient {
    /// The selected slot is claimed before any Controller request.
    pub async fn init(url: &str, profile: Option<&str>, slot: &str) -> Result<Self, SdkError> {
        let claim = session::claim_session(slot)?;
        let deadline = ClientDeadline::new(REGISTER_SERVER_BUDGET_MS);
        let profile = profile.map(String::from);
        let resp = with_client_deadline(deadline, "register", async {
            let mut ws = connect_ws(url).await?;

            let req = WireRequest::Register { profile };
            send_json(&mut ws, &req).await?;
            let resp = recv_json(&mut ws, deadline).await?;

            // Close ws — session lives server-side, not tied to this connection.
            let _ = ws.close(None).await;
            Ok(resp)
        })
        .await?;

        match resp {
            WireResponse::RegisterResult {
                success: true,
                session_id: Some(sid),
                ..
            } => {
                claim.save(&sid)?;
                Ok(Self {
                    url: url.to_string(),
                    session_id: sid,
                    slot: slot.to_string(),
                })
            }
            WireResponse::RegisterResult {
                success: false,
                error,
                error_type,
                cause,
                code,
                owner,
                current,
                limit,
                owner_current,
                owner_limit,
                retry_condition,
                ..
            } => {
                let cause = validate_wire_failure(error_type.as_deref(), cause)?;
                let capacity = parse_capacity_details(
                    error_type.as_deref(),
                    owner,
                    current,
                    limit,
                    owner_current,
                    owner_limit,
                    retry_condition,
                )?;
                Err(SdkError::RegisterFailed {
                    error: error.unwrap_or_default(),
                    code: code.unwrap_or(1),
                    error_type,
                    cause,
                    capacity,
                })
            }
            _ => Err(SdkError::RegisterFailed {
                error: "unexpected response".into(),
                code: 1,
                error_type: Some("command_failed".into()),
                cause: Some(CommandFailureCause::Transport),
                capacity: None,
            }),
        }
    }

    /// Create client from an existing session ID in a selected local slot.
    pub fn from_session(url: String, session_id: String, slot: &str) -> Result<Self, SdkError> {
        session::validate_name(slot)?;
        Ok(Self {
            url,
            session_id,
            slot: slot.to_string(),
        })
    }

    /// Send a command — opens a fresh ws, sends Command, receives response, closes ws.
    pub async fn command(&self, request: Value) -> Result<Response, SdkError> {
        match request.get("action").and_then(Value::as_str) {
            Some("diff_snapshot") => return self.diff_snapshot(&request).await,
            Some("diff_screenshot") => return self.diff_screenshot(&request).await,
            Some("diff_url") => return self.diff_url(&request).await,
            _ => {}
        }
        self.command_remote(request).await
    }

    async fn command_remote(&self, request: Value) -> Result<Response, SdkError> {
        let deadline = ClientDeadline::new(command_server_budget(&request));
        self.command_remote_at(request, deadline).await
    }

    async fn command_remote_at(
        &self,
        request: Value,
        deadline: ClientDeadline,
    ) -> Result<Response, SdkError> {
        let is_har_stop = request
            .get("action")
            .and_then(Value::as_str)
            == Some("har_stop");
        if is_har_stop {
            return self.command_remote_inner(request, deadline).await;
        }
        with_client_deadline(
            deadline,
            "command",
            self.command_remote_inner(request, deadline),
        )
        .await
    }

    async fn command_remote_wire(
        &self,
        request: Value,
        deadline: ClientDeadline,
    ) -> Result<WireResponse, SdkError> {
        let mut ws = connect_ws(&self.url).await?;
        let wire_req = WireRequest::Command {
            session_id: self.session_id.clone(),
            command: request,
        };
        send_json(&mut ws, &wire_req).await?;
        let response = recv_json(&mut ws, deadline).await?;
        drop(ws);
        Ok(response)
    }

    async fn command_remote_inner(
        &self,
        mut request: Value,
        deadline: ClientDeadline,
    ) -> Result<Response, SdkError> {
        let (screenshot_output, binary_output) = prepare_command(&mut request)?;

        // close → deregister
        if request.get("action").and_then(|v| v.as_str()) == Some("close") {
            self.destroy().await?;
            return Ok(Response {
                success: true,
                data: None,
                error: None,
                error_type: None,
                details: None,
                cause: None,
                operation_id: None,
                dialog_id: None,
                page: None,
                owner: None,
                current: None,
                limit: None,
                owner_current: None,
                owner_limit: None,
                retry_condition: None,
                warning: None,
            });
        }

        let action = request
            .get("action")
            .and_then(Value::as_str)
            .map(String::from);
        let wire_response = if action.as_deref() == Some("har_stop") {
            with_client_deadline(
                deadline,
                "command",
                self.command_remote_wire(request, deadline),
            )
            .await?
        } else {
            self.command_remote_wire(request, deadline).await?
        };
        let mut response = decode_wire_response(wire_response)?;
        if action.as_deref() == Some("har_stop") {
            if !response.success {
                return Ok(response);
            }
            let output = binary_output
                .as_ref()
                .ok_or_else(|| command_error("HAR output path state is missing".into()))?;
            return self.materialize_har_response(response.data.take(), output).await;
        }
        // Strip _tag from data (CLI doesn't need discriminant)
        if let Some(data) = &mut response.data {
            if let Some(obj) = data.as_object_mut() {
                obj.remove("_tag");
            }
        }
        if let (Some(output), Some(data)) = (&screenshot_output, &mut response.data) {
            materialize_screenshot_response(data, output)?;
        }
        if let (Some(output), Some(data)) = (&binary_output, &mut response.data) {
            materialize_binary_response(data, output)?;
        }
        Ok(response)
    }

    /// Destroy session — opens ws, sends Deregister, closes ws.
    pub async fn destroy(&self) -> Result<(), SdkError> {
        let deadline = ClientDeadline::new(DEFAULT_SERVER_COMMAND_BUDGET_MS);
        with_client_deadline(
            deadline,
            "deregister",
            self.destroy_inner(deadline),
        )
        .await
    }

    async fn destroy_inner(&self, deadline: ClientDeadline) -> Result<(), SdkError> {
        let mut ws = connect_ws(&self.url).await?;

        let req = WireRequest::Deregister {
            session_id: self.session_id.clone(),
        };
        send_json(&mut ws, &req).await?;
        let resp = recv_json(&mut ws, deadline).await?;

        let _ = ws.close(None).await;

        match resp {
            WireResponse::DeregisterResult {
                success: true, ..
            } => {
                // The retry handle is removed only after the controller proves
                // that the owner-scoped remote cleanup succeeded.
                session::clear_session_id(&self.slot)?;
                Ok(())
            }
            WireResponse::DeregisterResult {
                success: false,
                error,
                error_type,
                cause,
                code,
                owner,
                current,
                limit,
                owner_current,
                owner_limit,
                retry_condition,
                ..
            } => {
                let cause = validate_wire_failure(error_type.as_deref(), cause)?;
                let capacity = parse_capacity_details(
                    error_type.as_deref(),
                    owner,
                    current,
                    limit,
                    owner_current,
                    owner_limit,
                    retry_condition,
                )?;
                Err(SdkError::DeregisterFailed {
                    error: error.unwrap_or_else(|| "Deregister failed".into()),
                    code: code.unwrap_or(1),
                    error_type,
                    cause,
                    capacity,
                })
            }
            WireResponse::Error { error, code } => Err(SdkError::DeregisterFailed {
                error,
                code,
                error_type: Some("command_failed".into()),
                cause: Some(CommandFailureCause::Transport),
                capacity: None,
            }),
            _ => Err(SdkError::DeregisterFailed {
                error: "unexpected response".into(),
                code: 1,
                error_type: Some("command_failed".into()),
                cause: Some(CommandFailureCause::Transport),
                capacity: None,
            }),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    async fn diff_snapshot(&self, request: &Value) -> Result<Response, SdkError> {
        let snapshot_request = snapshot_request(request);
        let current = response_string(self.command_remote(snapshot_request).await?, "snapshot")?;
        if let Some(path) = request.get("baseline").and_then(Value::as_str) {
            let baseline = std::fs::read_to_string(path)
                .map_err(|e| command_error(format!("read snapshot baseline {path}: {e}")))?;
            let mut result = diff::snapshots(&baseline, &current);
            if let Some(data) = result.as_object_mut() {
                data.insert("status".into(), Value::String("compared".into()));
            }
            return Ok(success(result));
        }

        let path = snapshot_baseline_path(&self.session_id)?;
        if !path.exists() {
            std::fs::write(&path, &current).map_err(|e| {
                command_error(format!("write previous snapshot {}: {e}", path.display()))
            })?;
            return Ok(success(serde_json::json!({
                "status": "baseline-initialized",
                "baselineInitialized": true,
            })));
        }

        let baseline = std::fs::read_to_string(&path).map_err(|e| {
            command_error(format!("read previous snapshot {}: {e}", path.display()))
        })?;
        std::fs::write(&path, &current).map_err(|e| {
            command_error(format!("write previous snapshot {}: {e}", path.display()))
        })?;
        let mut result = diff::snapshots(&baseline, &current);
        if let Some(data) = result.as_object_mut() {
            data.insert("status".into(), Value::String("compared".into()));
            data.insert("baselineInitialized".into(), Value::Bool(false));
        }
        Ok(success(result))
    }

    async fn diff_screenshot(&self, request: &Value) -> Result<Response, SdkError> {
        let baseline_path = required_string(request, "baseline")?;
        let baseline = std::fs::read(&baseline_path)
            .map_err(|e| command_error(format!("read screenshot baseline {baseline_path}: {e}")))?;
        let current = self.capture_screenshot(request).await?;
        let threshold = request
            .get("threshold")
            .and_then(Value::as_f64)
            .unwrap_or(0.1);
        let result = diff::screenshots(&baseline, &current, threshold).map_err(command_error)?;
        let requested_path = request.get("output").and_then(Value::as_str);
        let diff_path = match (requested_path, result.diff_image.as_ref()) {
            (Some(path), Some(bytes)) => {
                write_file(path, bytes)?;
                let metadata = std::fs::metadata(path)
                    .map_err(|e| command_error(format!("verify diff image {path}: {e}")))?;
                if !metadata.is_file() {
                    return Err(command_error(format!("diff image is not a file: {path}")));
                }
                Some(path.to_string())
            }
            _ => None,
        };
        let diff_image_generated = diff_path.is_some();
        Ok(success(serde_json::json!({
            "match": result.matched,
            "mismatchPercentage": result.mismatch_percentage,
            "totalPixels": result.total_pixels,
            "differentPixels": result.different_pixels,
            "diffPath": diff_path,
            "diffImageGenerated": diff_image_generated,
            "outputPath": requested_path,
            "dimensionMismatch": result.dimension_mismatch,
        })))
    }

    async fn diff_url(&self, request: &Value) -> Result<Response, SdkError> {
        let url1 = required_string(request, "url1")?;
        let url2 = required_string(request, "url2")?;
        let wait_until = request.get("waitUntil").cloned();

        let caller_data = require_success(
            self.command_remote(serde_json::json!({ "action": "tab_list" }))
                .await?,
        )?;
        let (caller_index, caller_frame) = active_tab_state(&caller_data)?;
        let temporary_data = require_success(
            self.command_remote(serde_json::json!({ "action": "tab_new" }))
                .await?,
        )?;
        let (temporary_index, _) = active_tab_state(&temporary_data)?;

        let comparison = async {
            let mut navigate1 = serde_json::json!({ "action": "navigate", "url": url1 });
            let mut navigate2 = serde_json::json!({ "action": "navigate", "url": url2 });
            if let Some(value) = wait_until {
                navigate1["waitUntil"] = value.clone();
                navigate2["waitUntil"] = value;
            }
            require_success(self.command_remote(navigate1).await?)?;
            let first_snapshot = response_string(
                self.command_remote(snapshot_request(request)).await?,
                "snapshot",
            )?;
            let first_screenshot =
                if request.get("screenshot").and_then(Value::as_bool) == Some(true) {
                    Some(self.capture_screenshot(request).await?)
                } else {
                    None
                };
            require_success(self.command_remote(navigate2).await?)?;
            let second_snapshot = response_string(
                self.command_remote(snapshot_request(request)).await?,
                "snapshot",
            )?;
            let snapshot = diff::snapshots(&first_snapshot, &second_snapshot);
            let screenshot = if let Some(first) = first_screenshot {
                let second = self.capture_screenshot(request).await?;
                let result = diff::screenshots(&first, &second, 0.1).map_err(command_error)?;
                Some(serde_json::json!({
                    "match": result.matched,
                    "mismatchPercentage": result.mismatch_percentage,
                    "totalPixels": result.total_pixels,
                    "differentPixels": result.different_pixels,
                    "dimensionMismatch": result.dimension_mismatch,
                }))
            } else {
                None
            };
            Ok::<Value, SdkError>(serde_json::json!({
                "url1": url1,
                "url2": url2,
                "snapshot": snapshot,
                "screenshot": screenshot,
            }))
        }
        .await;

        let cleanup = self
            .cleanup_diff_page(temporary_index, caller_index, caller_frame.as_deref())
            .await;
        match (comparison, cleanup) {
            (Ok(result), Ok(())) => Ok(success(result)),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(command_error(format!("diff url cleanup failed: {error}"))),
            (Err(error), Err(cleanup_error)) => Err(command_error(format!(
                "diff url failed: {error}; cleanup failed: {cleanup_error}"
            ))),
        }
    }

    async fn cleanup_diff_page(
        &self,
        temporary_index: usize,
        caller_index: usize,
        caller_frame: Option<&str>,
    ) -> Result<(), SdkError> {
        let mut errors = Vec::new();
        if let Err(error) = self
            .command_remote(serde_json::json!({
                "action": "tab_close",
                "index": temporary_index,
            }))
            .await
            .and_then(require_success)
        {
            errors.push(error.to_string());
        }
        if let Err(error) = self
            .command_remote(serde_json::json!({
                "action": "tab_switch",
                "index": caller_index,
            }))
            .await
            .and_then(require_success)
        {
            errors.push(error.to_string());
        }
        let restore = match caller_frame {
            Some(selector) => serde_json::json!({
                "action": "frame",
                "selector": selector,
            }),
            None => serde_json::json!({ "action": "mainframe" }),
        };
        if let Err(error) = self.command_remote(restore).await.and_then(require_success) {
            errors.push(error.to_string());
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(command_error(errors.join("; ")))
        }
    }

    async fn materialize_har_response(
        &self,
        data: Option<Value>,
        output: &BinaryOutput,
    ) -> Result<Response, SdkError> {
        let mut descriptor = data.ok_or_else(|| command_error(
            "HAR stop returned no artifact descriptor (phase=descriptor)".into(),
        ))?;
        if let Some(obj) = descriptor.as_object_mut() {
            obj.remove("_tag");
        }
        let status = descriptor.get("status").and_then(Value::as_str);
        if status == Some("incomplete") {
            return Ok(success(descriptor));
        }
        if status != Some("complete") {
            return Err(command_error(
                "HAR stop returned an unknown artifact status (phase=descriptor)".into(),
            ));
        }
        let artifact_id = descriptor
            .get("artifactId")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("HAR descriptor has no artifactId (phase=descriptor)".into()))?
            .to_string();
        let expected_bytes = descriptor
            .get("bytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| command_error("HAR descriptor has no byte length (phase=descriptor)".into()))?;
        let expected_requests = descriptor
            .get("requestCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| command_error("HAR descriptor has no request count (phase=descriptor)".into()))?;
        let suggested = descriptor
            .get("suggestedFilename")
            .and_then(Value::as_str)
            .unwrap_or(&output.default_filename);
        let destination = match output.requested_path.as_deref() {
            Some(requested) => {
                let requested_path = PathBuf::from(requested);
                if requested.ends_with(std::path::MAIN_SEPARATOR) || requested_path.is_dir() {
                    requested_path.join(suggested)
                } else {
                    requested_path
                }
            }
            None => std::env::temp_dir().join(&output.default_directory).join(suggested),
        };
        if let Some(parent) = destination.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    command_error(format!("HAR create destination directory (phase=prepare): {error}"))
                })?;
            }
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| command_error(format!("HAR temp name clock failed (phase=prepare): {error}")))?
            .as_nanos();
        let temporary = PathBuf::from(format!("{}.part-{}", destination.display(), nonce));
        // Reuse one stateless command socket for every artifact chunk. Closing each
        // intermediate socket can race the server's response write.
        let connect_deadline = ClientDeadline::new(DEFAULT_SERVER_COMMAND_BUDGET_MS);
        let mut artifact_ws = with_client_deadline(
            connect_deadline,
            "command",
            connect_ws(&self.url),
        )
        .await?;
        let result: Result<(), SdkError> = async {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| command_error(format!("HAR open temporary output (phase=write): {error}")))?;
            let mut offset = 0_u64;
            let mut continuation: Option<String> = None;
            loop {
                let mut command = serde_json::json!({
                    "action": "network_artifact_read",
                    "artifactId": artifact_id,
                });
                if let Some(token) = continuation.take() {
                    command["continuation"] = Value::String(token);
                }
                let chunk_deadline = ClientDeadline::new(command_server_budget(&command));
                let response = decode_wire_response(
                    with_client_deadline(
                        chunk_deadline,
                        "command",
                        async {
                            let wire_req = WireRequest::Command {
                                session_id: self.session_id.clone(),
                                command,
                            };
                            send_json(&mut artifact_ws, &wire_req).await?;
                            recv_json(&mut artifact_ws, chunk_deadline).await
                        },
                    )
                    .await?,
                )?;
                let chunk = require_success(response)?;
                let chunk_offset = chunk
                    .get("offset")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| command_error("HAR chunk has no offset (phase=read)".into()))?;
                let chunk_total = chunk
                    .get("totalBytes")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| command_error("HAR chunk has no total length (phase=read)".into()))?;
                if chunk_offset != offset || chunk_total != expected_bytes {
                    return Err(command_error(format!(
                        "HAR chunk offset/length mismatch at {} bytes (phase=read, expected={expected_bytes})",
                        offset
                    )));
                }
                let encoded = chunk
                    .get("base64")
                    .and_then(Value::as_str)
                    .ok_or_else(|| command_error("HAR chunk has no base64 data (phase=read)".into()))?;
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|error| command_error(format!("HAR chunk base64 invalid (phase=read): {error}")))?;
                let declared = chunk
                    .get("bytes")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| command_error("HAR chunk has no byte count (phase=read)".into()))?;
                if declared != bytes.len() as u64 || offset.saturating_add(declared) > expected_bytes {
                    return Err(command_error(format!(
                        "HAR chunk byte count mismatch at {} bytes (phase=read)",
                        offset
                    )));
                }
                file.write_all(&bytes)
                    .map_err(|error| command_error(format!("HAR write failed at {offset} bytes (phase=write): {error}")))?;
                offset = offset.saturating_add(declared);
                continuation = chunk
                    .get("continuation")
                    .and_then(|value| value.get("token"))
                    .and_then(Value::as_str)
                    .map(String::from);
                if continuation.is_none() {
                    if offset != expected_bytes {
                        return Err(command_error(format!(
                            "HAR ended at {offset} of {expected_bytes} bytes (phase=read); retry artifact retrieval"
                        )));
                    }
                    break;
                }
            }
            file.sync_all()
                .map_err(|error| command_error(format!("HAR sync failed at {offset} bytes (phase=verify): {error}")))?;
            drop(file);
            let metadata = std::fs::metadata(&temporary)
                .map_err(|error| command_error(format!("HAR temporary length read failed (phase=verify): {error}")))?;
            if metadata.len() != expected_bytes {
                return Err(command_error(format!(
                    "HAR length check failed: {} of {expected_bytes} bytes (phase=verify)",
                    metadata.len()
                )));
            }
            let contents = std::fs::read(&temporary)
                .map_err(|error| command_error(format!("HAR readback failed (phase=verify): {error}")))?;
            let parsed: Value = serde_json::from_slice(&contents)
                .map_err(|error| command_error(format!("HAR JSON check failed (phase=verify): {error}")))?;
            let entries = parsed
                .get("log")
                .and_then(|value| value.get("entries"))
                .and_then(Value::as_array)
                .ok_or_else(|| command_error("HAR has no log.entries (phase=verify)".into()))?;
            if entries.len() as u64 != expected_requests {
                return Err(command_error(format!(
                    "HAR entry count check failed: {} of {expected_requests} entries (phase=verify)",
                    entries.len()
                )));
            }
            std::fs::rename(&temporary, &destination)
                .map_err(|error| command_error(format!("HAR atomic rename failed (phase=commit): {error}")))?;
            Ok(())
        }
        .await;
        drop(artifact_ws);
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        if let Some(obj) = descriptor.as_object_mut() {
            obj.insert(
                "path".into(),
                Value::String(destination.to_string_lossy().to_string()),
            );
            obj.insert("size".into(), Value::Number(expected_bytes.into()));
            obj.remove("artifactId");
        }
        Ok(success(descriptor))
    }

    async fn capture_screenshot(&self, request: &Value) -> Result<Vec<u8>, SdkError> {
        let mut command = serde_json::json!({
            "action": "screenshot",
            "format": "png",
            "inlineBase64": true,
        });
        for key in ["selector", "fullPage"] {
            if let Some(value) = request.get(key) {
                command[key] = value.clone();
            }
        }
        let encoded = response_string(self.command_remote(command).await?, "base64")?;
        STANDARD
            .decode(encoded)
            .map_err(|e| command_error(format!("decode current screenshot: {e}")))
    }
}

fn decode_wire_response(resp: WireResponse) -> Result<Response, SdkError> {
    match resp {
        WireResponse::CommandResult {
            success: true,
            data,
            operation_id,
            dialog_id,
            page,
            details,
            ..
        } => Ok(Response {
            success: true,
            data,
            error: None,
            error_type: None,
            details,
            cause: None,
            operation_id,
            dialog_id,
            page,
            owner: None,
            current: None,
            limit: None,
            owner_current: None,
            owner_limit: None,
            retry_condition: None,
            warning: None,
        }),
        WireResponse::CommandResult {
            success: false,
            error,
            error_type,
            cause,
            operation_id,
            dialog_id,
            page,
            details,
            owner,
            current,
            limit,
            owner_current,
            owner_limit,
            retry_condition,
            ..
        } => {
            let cause = validate_wire_failure(error_type.as_deref(), cause)?;
            let (operation_id, dialog_id, page) = validate_dialog_pending_failure(
                error_type.as_deref(),
                cause.as_ref(),
                operation_id,
                dialog_id,
                page,
            )?;
            Ok(Response {
                success: false,
                data: None,
                error,
                error_type,
                details,
                cause,
                operation_id,
                dialog_id,
                page,
                owner,
                current,
                limit,
                owner_current,
                owner_limit,
                retry_condition,
                warning: None,
            })
        }
        WireResponse::Error { error, .. } => {
            let error = if error.contains("Message too long")
                || error.contains("Space limit exceeded")
            {
                "Encoded network envelope exceeded the receive budget; retry with pagination or smaller body chunks".into()
            } else {
                error
            };
            Ok(Response {
                success: false,
                data: None,
                error: Some(error),
                error_type: Some("command_failed".into()),
                details: None,
                cause: Some(CommandFailureCause::Transport),
                operation_id: None,
                dialog_id: None,
                page: None,
                owner: None,
                current: None,
                limit: None,
                owner_current: None,
                owner_limit: None,
                retry_condition: None,
                warning: None,
            })
        }
        _ => Err(protocol_error("unexpected response")),
    }
}
fn command_error(error: String) -> SdkError {
    SdkError::CommandFailed {
        error,
        code: 1,
        cause: CommandFailureCause::Cdp,
    }
}

fn success(data: Value) -> Response {
    Response {
        success: true,
        data: Some(data),
        error: None,
        details: None,
        operation_id: None,
        dialog_id: None,
        page: None,
        error_type: None,
        cause: None,
        owner: None,
        current: None,
        limit: None,
        owner_current: None,
        owner_limit: None,
        retry_condition: None,
        warning: None,
    }
}

fn require_success(response: Response) -> Result<Value, SdkError> {
    if response.success {
        Ok(response.data.unwrap_or(Value::Null))
    } else {
        let error = response.error.unwrap_or_else(|| "command failed".into());
        if response.error_type.as_deref() == Some("timeout") {
            return Err(SdkError::Timeout {
                operation: error,
                budget_ms: None,
            });
        }
        Err(SdkError::CommandFailed {
            error,
            code: 1,
            cause: response.cause.unwrap_or(CommandFailureCause::Cdp),
        })
    }
}

fn response_string(response: Response, field: &str) -> Result<String, SdkError> {
    let data = require_success(response)?;
    data.get(field)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| command_error(format!("response has no {field}")))
}

fn required_string(request: &Value, field: &str) -> Result<String, SdkError> {
    request
        .get(field)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| command_error(format!("missing {field}")))
}

fn snapshot_request(request: &Value) -> Value {
    let mut command = serde_json::json!({ "action": "snapshot" });
    for key in ["selector", "compact", "maxDepth", "interactive", "urls"] {
        if let Some(value) = request.get(key) {
            command[key] = value.clone();
        }
    }
    command
}

fn snapshot_baseline_path(session_id: &str) -> Result<PathBuf, SdkError> {
    let directory = state_directory()?.parent().unwrap().join("diff-snapshots");
    std::fs::create_dir_all(&directory)
        .map_err(|e| command_error(format!("create snapshot baseline directory: {e}")))?;
    Ok(directory.join(format!("{session_id}.txt")))
}

fn write_file(path: &str, bytes: &[u8]) -> Result<(), SdkError> {
    if let Some(parent) = PathBuf::from(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                command_error(format!("create output directory {}: {e}", parent.display()))
            })?;
        }
    }
    std::fs::write(path, bytes).map_err(|e| command_error(format!("write {path}: {e}")))
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
    if let Some(action) = obj.get("action").and_then(|value| value.as_str()) {
        if let Some(reason) = unsupported_reason(action) {
            return Err(SdkError::CommandFailed {
                error: format!("unsupported_in_moat: {}", reason),
                code: 1,
                cause: CommandFailureCause::Transport,
            });
        }
    }
    if obj.get("action").and_then(|v| v.as_str()) == Some("evaluate") {
        obj.insert("action".into(), Value::String("eval".into()));
        if let Some(script) = obj.remove("script") {
            obj.insert("code".into(), script);
        }
    }

    if let Some(sel) = obj
        .get("selector")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
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
                cause: CommandFailureCause::Transport,
            })?;
        let payloads = files
            .iter()
            .map(|value| {
                let path = value.as_str().ok_or_else(|| SdkError::CommandFailed {
                    error: "upload file path must be a string".into(),
                    code: 1,
                    cause: CommandFailureCause::Transport,
                })?;
                let bytes = std::fs::read(path).map_err(|e| SdkError::CommandFailed {
                    error: format!("read upload file {}: {}", path, e),
                    code: 1,
                    cause: CommandFailureCause::Transport,
                })?;
                let name = PathBuf::from(path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| SdkError::CommandFailed {
                        error: format!("upload path has no file name: {}", path),
                        code: 1,
                        cause: CommandFailureCause::Transport,
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
        let requested_path = obj
            .get("path")
            .and_then(|value| value.as_str())
            .ok_or_else(|| SdkError::CommandFailed {
                error: "state load requires a path".into(),
                code: 1,
                cause: CommandFailureCause::Transport,
            })?;
        let path = state_path(requested_path)?;
        let contents = std::fs::read_to_string(&path).map_err(|e| SdkError::CommandFailed {
            error: format!("read state file {}: {}", path.display(), e),
            code: 1,
            cause: CommandFailureCause::Transport,
        })?;
        let state =
            serde_json::from_str::<Value>(&contents).map_err(|e| SdkError::CommandFailed {
                error: format!("parse state file {}: {}", path.display(), e),
                code: 1,
                cause: CommandFailureCause::Transport,
            })?;
        obj.remove("path");
        obj.insert("state".into(), state);
    }

    match obj.get("action").and_then(|value| value.as_str()) {
        Some("download") | Some("waitfordownload") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj
                    .get("path")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                default_directory: "moat-downloads".into(),
                default_filename: "download.bin".into(),
            });
            obj.remove("path");
        }
        Some("pdf") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj
                    .get("path")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                default_directory: "moat-pdfs".into(),
                default_filename: "page.pdf".into(),
            });
            obj.remove("path");
        }
        Some("state_save") => {
            let requested_path = obj
                .get("path")
                .and_then(|value| value.as_str())
                .ok_or_else(|| SdkError::CommandFailed {
                    error: "state save requires a path".into(),
                    code: 1,
                    cause: CommandFailureCause::Transport,
                })?;
            let path = state_path(requested_path)?;
            binary_output = Some(BinaryOutput {
                requested_path: Some(path.to_string_lossy().to_string()),
                default_directory: "moat-states".into(),
                default_filename: "state.json".into(),
            });
            obj.remove("path");
        }
        Some("trace_stop") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj
                    .get("path")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                default_directory: "moat-traces".into(),
                default_filename: "trace.zip".into(),
            });
            obj.remove("path");
        }
        Some("profiler_stop") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj
                    .get("path")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                default_directory: "moat-profiles".into(),
                default_filename: "profile.json".into(),
            });
            obj.remove("path");
        }
        Some("har_stop") => {
            binary_output = Some(BinaryOutput {
                requested_path: obj
                    .get("path")
                    .and_then(|value| value.as_str())
                    .map(String::from),
                default_directory: "moat-har".into(),
                default_filename: "network.har".into(),
            });
            obj.remove("path");
        }
        _ => {}
    }

    // CLI parsers use JSON null for absent optional positional values. The wire
    // contract represents absence by omitting the property.
    obj.retain(|_, value| !value.is_null());

    Ok((screenshot_output, binary_output))
}
fn active_tab_state(data: &Value) -> Result<(usize, Option<String>), SdkError> {
    let tabs = data
        .get("tabs")
        .and_then(Value::as_array)
        .ok_or_else(|| command_error("response has no tabs".into()))?;
    let active_tab = tabs
        .iter()
        .find(|tab| tab.get("active").and_then(Value::as_bool) == Some(true))
        .ok_or_else(|| command_error("response has no active tab".into()))?;
    let index = active_tab
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| command_error("response has invalid active tab index".into()))?;
    let frame = data
        .get("activeFrame")
        .and_then(Value::as_str)
        .map(String::from);
    Ok((index, frame))
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

fn materialize_binary_response(data: &mut Value, output: &BinaryOutput) -> Result<(), SdkError> {
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
            cause: CommandFailureCause::Transport,
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
                cause: CommandFailureCause::Transport,
            })?;
        }
    }
    std::fs::write(&path, &bytes).map_err(|e| SdkError::CommandFailed {
        error: format!("write output {}: {}", path.display(), e),
        code: 1,
        cause: CommandFailureCause::Transport,
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
            cause: CommandFailureCause::Transport,
        })?;
    let path = resolve_screenshot_path(output)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| SdkError::CommandFailed {
                error: format!("create screenshot directory {}: {}", parent.display(), e),
                code: 1,
                cause: CommandFailureCause::Transport,
            })?;
        }
    }
    std::fs::write(&path, &bytes).map_err(|e| SdkError::CommandFailed {
        error: format!("write screenshot {}: {}", path.display(), e),
        code: 1,
        cause: CommandFailureCause::Transport,
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
                cause: CommandFailureCause::Transport,
            });
        }
    };
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| SdkError::CommandFailed {
            error: format!("system clock before UNIX_EPOCH: {}", e),
            code: 1,
            cause: CommandFailureCause::Transport,
        })?
        .as_nanos();
    Ok(format!("moat-screenshot-{}.{}", nanos, ext))
}

// ─── WebSocket helpers ───

async fn send_json<T: serde::Serialize>(ws: &mut WsStream, msg: &T) -> Result<(), SdkError> {
    let json = serde_json::to_string(msg).map_err(|e| SdkError::WebSocket(e.to_string()))?;
    if json.len() > MAX_ENCODED_WIRE_BYTES {
        return Err(command_error(format!(
            "Encoded wire request is {} bytes, above the {}-byte budget; retry with network pagination or smaller body chunks",
            json.len(),
            MAX_ENCODED_WIRE_BYTES
        )));
    }
    ws.send(Message::Text(json))
        .await
        .map_err(|e| SdkError::WebSocket(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    static HOME_LOCK: Mutex<()> = Mutex::new(());

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
    fn existing_session_constructor_rejects_invalid_slot_before_transport() {
        assert!(matches!(
            MoatClient::from_session("ws://127.0.0.1:1".into(), "session-id".into(), "../x"),
            Err(SdkError::InvalidSessionName(_))
        ));
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
    fn prepare_omits_null_optional_cli_fields() {
        let mut request = json!({
            "action": "screenshot",
            "path": null,
            "selector": null,
            "fullPage": false,
            "annotate": false
        });
        prepare_command(&mut request).unwrap();
        assert!(request.get("path").is_none());
        assert!(request.get("selector").is_none());
        assert_eq!(request["fullPage"], false);
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
    fn prepare_route_forwards_body_and_resource_type_unchanged() {
        // Post-#237 the CLI emits `body` directly (no `response` wrapper); the
        // SDK must forward it and `resourceType` to the wire untouched.
        let mut request = json!({
            "id": "cli-id",
            "action": "route",
            "url": "**/json",
            "abort": false,
            "body": "{\"mock\":true}",
            "resourceType": "XHR, Fetch"
        });

        let outputs = prepare_command(&mut request).unwrap();

        assert_eq!(outputs, (None, None));
        assert_eq!(
            request,
            json!({
                "action": "route",
                "url": "**/json",
                "abort": false,
                "body": "{\"mock\":true}",
                "resourceType": "XHR, Fetch"
            })
        );
    }

    #[test]
    fn snapshot_request_forwards_urls_option() {
        let source = json!({
            "id": "cli-id",
            "action": "snapshot",
            "selector": "main",
            "interactive": true,
            "urls": true
        });
        let built = snapshot_request(&source);
        assert_eq!(built["urls"], true);
        assert_eq!(built["selector"], "main");
        assert_eq!(built["interactive"], true);
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
    fn prepare_rejects_architecturally_unsupported_command_families() {
        for action in [
            "auth_list",
            "confirm",
            "launch",
            "stream_status",
            "recording_stop",
        ] {
            let mut request = json!({ "action": action });
            let error = prepare_command(&mut request).unwrap_err().to_string();
            assert!(
                error.contains("unsupported_in_moat:"),
                "action={action}, error={error}"
            );
        }
    }

    #[test]
    fn local_state_management_lists_shows_renames_cleans_and_clears_files() {
        let _lock = HOME_LOCK.lock().unwrap();
        let original_home = std::env::var_os("HOME");
        let home = test_dir("state-home");
        std::fs::create_dir_all(home.join(".moat/states")).unwrap();
        std::env::set_var("HOME", &home);
        let states = home.join(".moat/states");
        std::fs::write(
            states.join("first.json"),
            br#"{"cookies":[{"name":"sid"}],"origins":[{"origin":"https://example.com"}]}"#,
        )
        .unwrap();

        let listed = local_command(&json!({ "action": "state_list" }))
            .unwrap()
            .unwrap()
            .data
            .unwrap();
        assert_eq!(listed["files"].as_array().unwrap().len(), 1);
        assert_eq!(listed["files"][0]["filename"], "first.json");

        let shown = local_command(&json!({ "action": "state_show", "path": "first" }))
            .unwrap()
            .unwrap()
            .data
            .unwrap();
        // #237 state summaries always report the four counts; this file has no
        // tabs/indexedDB, so those are zero rather than omitted.
        assert_eq!(
            shown["summary"],
            json!({ "cookies": 1, "origins": 1, "tabs": 0, "indexedDB": 0 })
        );

        let renamed = local_command(&json!({
            "action": "state_rename",
            "oldName": "first",
            "newName": "second"
        }))
        .unwrap()
        .unwrap()
        .data
        .unwrap();
        assert_eq!(renamed["renamed"], true);
        assert!(states.join("second.json").exists());

        let cleaned = local_command(&json!({ "action": "state_clean", "days": 0 }))
            .unwrap()
            .unwrap()
            .data
            .unwrap();
        assert_eq!(cleaned["cleaned"], 1);

        std::fs::write(states.join("third.json"), br#"{"cookies":[],"origins":[]}"#).unwrap();
        let cleared = local_command(&json!({ "action": "state_clear", "all": true, "confirm": true }))
            .unwrap()
            .unwrap()
            .data
            .unwrap();
        assert_eq!(cleared["cleared"], 1);

        match original_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        std::fs::remove_dir_all(home).unwrap();
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

async fn recv_json(
    ws: &mut WsStream,
    deadline: ClientDeadline,
) -> Result<WireResponse, SdkError> {
    loop {
        let message = timeout_at(deadline.at, ws.next())
            .await
            .map_err(|_| client_timeout(deadline, "receive response"))?;
        match message {
            Some(Ok(Message::Text(text))) => {
                if text.len() > MAX_ENCODED_WIRE_BYTES {
                    return Err(command_error(format!(
                        "Encoded wire response is {} bytes, above the {}-byte budget; retry with network pagination or smaller body chunks",
                        text.len(),
                        MAX_ENCODED_WIRE_BYTES
                    )));
                }
                return serde_json::from_str(&text).map_err(|e| {
                    command_error(format!("Wire response decode failed (phase=receive): {e}"))
                });
            }
            Some(Ok(Message::Ping(_))) => continue,
            Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) => {
                return Err(SdkError::WebSocket("connection closed".into()));
            }
            Some(Err(e)) => {
                let message = e.to_string();
                if message.contains("Message too long") || message.contains("Space limit exceeded") {
                    return Err(command_error(
                        "Encoded network envelope exceeded the receive budget; retry with pagination or smaller body chunks".into(),
                    ));
                }
                return Err(SdkError::WebSocket(message));
            }
            None => return Err(SdkError::WebSocket("stream ended".into())),
            _ => continue,
        }
    }
}
