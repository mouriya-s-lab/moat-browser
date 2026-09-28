use std::sync::OnceLock;

use crate::color;
use crate::connection::Response;
use moat_sdk::wire::CommandFailureCause;

static BOUNDARY_NONCE: OnceLock<String> = OnceLock::new();

/// Per-process nonce for content boundary markers. Uses a CSPRNG (getrandom) so
/// that untrusted page content cannot predict or spoof the boundary delimiter.
/// Process ID or timestamps would be insufficient since pages can read those.
fn get_boundary_nonce() -> &'static str {
    BOUNDARY_NONCE.get_or_init(|| {
        let mut buf = [0u8; 16];
        getrandom::getrandom(&mut buf).expect("failed to generate random nonce");
        buf.iter().map(|b| format!("{:02x}", b)).collect()
    })
}

#[derive(Default)]
pub struct OutputOptions {
    pub json: bool,
    pub content_boundaries: bool,
    pub max_output: Option<usize>,
}

impl OutputOptions {
    pub fn from_flags(flags: &crate::flags::Flags) -> Self {
        Self {
            json: flags.json,
            content_boundaries: flags.content_boundaries,
            max_output: flags.max_output,
        }
    }
}

fn truncate_if_needed(content: &str, max: Option<usize>) -> String {
    let Some(limit) = max else {
        return content.to_string();
    };
    // Fast path: byte length is a lower bound on char count, so if the
    // byte length is within the limit the char count must be too.
    if content.len() <= limit {
        return content.to_string();
    }
    // Find the byte offset of the limit-th character.
    match content.char_indices().nth(limit).map(|(i, _)| i) {
        Some(byte_offset) => {
            let total_chars = content.chars().count();
            format!(
                "{}\n[truncated: showing {} of {} chars. Use --max-output to adjust]",
                &content[..byte_offset],
                limit,
                total_chars
            )
        }
        // Content has fewer than `limit` chars despite more bytes
        None => content.to_string(),
    }
}

fn print_with_boundaries(content: &str, origin: Option<&str>, opts: &OutputOptions) {
    let content = truncate_if_needed(content, opts.max_output);
    if opts.content_boundaries {
        let origin_str = origin.unwrap_or("unknown");
        let nonce = get_boundary_nonce();
        println!(
            "--- AGENT_BROWSER_PAGE_CONTENT nonce={} origin={} ---",
            nonce, origin_str
        );
        println!("{}", content);
        println!("--- END_AGENT_BROWSER_PAGE_CONTENT nonce={} ---", nonce);
    } else {
        println!("{}", content);
    }
}

fn format_storage_value(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default())
}

fn format_storage_text(data: &serde_json::Value) -> Option<String> {
    if let Some(entries) = data.get("data").and_then(|v| v.as_object()) {
        if entries.is_empty() {
            return Some("No storage entries".to_string());
        }

        let lines = entries
            .iter()
            .map(|(key, value)| format!("{}: {}", key, format_storage_value(value)))
            .collect::<Vec<_>>();
        return Some(lines.join("\n"));
    }

    let key = data.get("key").and_then(|v| v.as_str())?;
    let value = data.get("value")?;
    Some(format!("{}: {}", key, format_storage_value(value)))
}

fn format_stream_status_text(action: Option<&str>, data: &serde_json::Value) -> Option<String> {
    match action {
        Some("stream_disable") => data
            .get("disabled")
            .and_then(|v| v.as_bool())
            .filter(|disabled| *disabled)
            .map(|_| "Streaming disabled".to_string()),
        Some("stream_enable") | Some("stream_status") => {
            let enabled = data.get("enabled").and_then(|v| v.as_bool())?;
            if !enabled {
                return Some("Streaming disabled".to_string());
            }

            let port = data.get("port").and_then(|v| v.as_u64())?;
            let connected = data
                .get("connected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let screencasting = data
                .get("screencasting")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            Some(format!(
                "Streaming enabled on ws://127.0.0.1:{port}\nConnected: {connected}\nScreencasting: {screencasting}"
            ))
        }
        _ => None,
    }
}
fn diagnostic_context(record: &serde_json::Value) -> String {
    let session = record
        .get("sessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let page = record
        .get("pageId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let frame = record
        .get("frameId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let page_url = record
        .get("pageUrl")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let frame_url = record
        .get("frameUrl")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let timestamp = record
        .get("timestamp")
        .and_then(|value| value.as_i64())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    format!(
        "session={} page={} frame={} pageUrl={} frameUrl={} timestamp={}",
        session, page, frame, page_url, frame_url, timestamp
    )
}

fn diagnostic_text(record: &serde_json::Value) -> String {
    let tag = record
        .get("_tag")
        .and_then(|value| value.as_str())
        .unwrap_or("Diagnostic");
    let context = diagnostic_context(record);
    match tag {
        "ConsoleDiagnostic" => {
            let kind = record
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("log");
            let text = record
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            format!("[{}] {} {} {}", tag, kind, context, text)
        }
        "PageErrorDiagnostic" => {
            let message = record
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            format!("[{}] {} {}", tag, context, message)
        }
        "ResourceFailureDiagnostic" => {
            let url = record
                .get("url")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let resource_type = record
                .get("resourceType")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let status = record
                .get("status")
                .map(render_json_value)
                .unwrap_or_else(|| "not received".to_string());
            let error = record
                .get("errorText")
                .and_then(|value| value.as_str())
                .unwrap_or("resource loading failed");
            format!(
                "[{}] {} {} resourceType={} status={} error={}",
                tag, context, url, resource_type, status, error
            )
        }
        "PolicyBlockedDiagnostic" => {
            let url = record
                .get("url")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let policy = record
                .get("policy")
                .and_then(|value| value.as_str())
                .unwrap_or("policy");
            let text = record
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            format!(
                "[{}] {} {} policy={} {}",
                tag, context, url, policy, text
            )
        }
        _ => format!("[{}] {}", tag, context),
    }
}

fn render_json_value(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| serde_json::to_string_pretty(value).unwrap_or_default())
}
fn render_eval_value(value: &serde_json::Value) -> String {
    if value.get("_tag").and_then(|tag| tag.as_str()) == Some("UndefinedValue") {
        return "undefined".to_string();
    }
    if value.get("_tag").and_then(|tag| tag.as_str()) == Some("UnserializableValue") {
        let reason = value
            .get("reason")
            .and_then(|reason| reason.as_str())
            .unwrap_or("unknown");
        let value_type = value
            .get("type")
            .and_then(|value_type| value_type.as_str())
            .unwrap_or("value");
        return format!("unserializable {value_type} ({reason})");
    }
    if let Some(text) = value.as_str() {
        return if text.is_empty() {
            "\"\"".to_string()
        } else {
            text.to_string()
        };
    }
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "<unserializable eval value>".to_string())
}

fn render_thrown_value(value: &serde_json::Value) -> String {
    fn render(value: &serde_json::Value, depth: usize) -> String {
        if depth >= 16 {
            return "… (depth limit)".to_string();
        }
        match value {
            serde_json::Value::Null => "null".to_string(),
            serde_json::Value::Bool(value) => value.to_string(),
            serde_json::Value::Number(value) => value.to_string(),
            serde_json::Value::String(value) => format!("{value:?}"),
            serde_json::Value::Array(values) => {
                let items = values
                    .iter()
                    .map(|value| render(value, depth + 1))
                    .collect::<Vec<_>>();
                format!("[{}]", items.join(", "))
            }
            serde_json::Value::Object(fields) => {
                let tag = fields.get("_tag").and_then(|value| value.as_str());
                if tag == Some("UndefinedValue") && fields.len() == 1 {
                    return "undefined".to_string();
                }
                if tag == Some("UnserializableValue") && fields.len() == 3 {
                    let reason = fields
                        .get("reason")
                        .and_then(|value| value.as_str())
                        .unwrap_or("unknown");
                    let value_type = fields
                        .get("type")
                        .and_then(|value| value.as_str())
                        .unwrap_or("value");
                    return format!(
                        "exists but cannot be serialized (type={value_type}, reason={reason})"
                    );
                }
                let items = fields
                    .iter()
                    .map(|(key, value)| {
                        let rendered = value
                            .as_str()
                            .map(ToString::to_string)
                            .unwrap_or_else(|| render(value, depth + 1));
                        format!("{key}={rendered}")
                    })
                    .collect::<Vec<_>>();
                format!("{{{}}}", items.join(", "))
            }
        }
    }

    render(value, 0)
}


fn render_attribute_value(value: &serde_json::Value) -> String {
    match value.get("_tag").and_then(|tag| tag.as_str()) {
        Some("AttributeMissing") => "attribute missing".to_string(),
        Some("AttributePresent") => {
            let present = value.get("value").and_then(|item| item.as_str()).unwrap_or("");
            if present.is_empty() {
                "\"\"".to_string()
            } else {
                present.to_string()
            }
        }
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| "<invalid attribute value>".to_string()),
    }
}

fn render_geometry(value: &serde_json::Value) -> String {
    if value.get("_tag").and_then(|tag| tag.as_str()) == Some("NoLayout") {
        return "unavailable (no layout)".to_string();
    }

    let component = |name: &str| value.get(name).filter(|item| item.is_number()).map(ToString::to_string);
    match (
        component("width"),
        component("height"),
        component("x"),
        component("y"),
    ) {
        (Some(width), Some(height), Some(x), Some(y)) => format!("{width}x{height} at ({x}, {y})"),
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| "<invalid geometry>".to_string()),
    }
}


fn print_network_body(label: &str, snapshot: &serde_json::Value) {
    let readiness = snapshot.get("readiness");
    let state = readiness
        .and_then(|value| value.get("_tag"))
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let known = readiness
        .and_then(|value| value.get("knownBytes"))
        .and_then(|value| (!value.is_null()).then(|| render_json_value(value)))
        .unwrap_or_else(|| "unknown".to_string());
    let total = readiness
        .and_then(|value| value.get("totalBytes"))
        .and_then(|value| (!value.is_null()).then(|| render_json_value(value)))
        .unwrap_or_else(|| "unknown".to_string());
    let transfer = snapshot
        .get("transfer")
        .and_then(|value| value.get("_tag"))
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    println!(
        "  {label} state: {state} (known bytes: {known}, total bytes: {total}, transfer: {transfer})"
    );
    if let Some(continuation) = readiness
        .and_then(|value| value.get("continuation"))
        .and_then(|value| value.get("token"))
        .and_then(|value| value.as_str())
    {
        println!("  {label} continuation: {continuation}");
    }
    if let Some(continuation) = snapshot
        .get("transfer")
        .and_then(|value| value.get("continuation"))
        .and_then(|value| value.get("token"))
        .and_then(|value| value.as_str())
    {
        println!("  {label} chunk continuation: {continuation}");
    }
    if let Some(next_action) = readiness
        .and_then(|value| value.get("nextAction"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            snapshot
                .get("transfer")
                .and_then(|value| value.get("nextAction"))
                .and_then(|value| value.as_str())
        })
    {
        println!("  {label} next action: {next_action}");
    }
}
fn network_body_summary(request: &serde_json::Value) -> String {
    let Some(snapshot) = request.get("responseBody") else {
        return "body=unknown".to_string();
    };
    let readiness = snapshot.get("readiness");
    let state = readiness
        .and_then(|value| value.get("_tag"))
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let known = readiness
        .and_then(|value| value.get("knownBytes"))
        .map(render_json_value)
        .unwrap_or_else(|| "unknown".to_string());
    let transfer = snapshot
        .get("transfer")
        .and_then(|value| value.get("_tag"))
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    format!("body={state}/{transfer} bytes={known}")
}


fn print_request_detail(request: &serde_json::Value) {
    let request_id = request
        .get("requestId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let method = request
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("GET");
    let url = request
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let resource_type = request
        .get("resourceType")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    println!("Request {}:", request_id);
    println!("  URL: {}", url);
    println!("  Method: {}", method);
    println!("  Resource type: {}", resource_type);
    if let Some(status) = request.get("status") {
        println!("  Status: {}", render_json_value(status));
    } else {
        println!("  Status: pending (no response received)");
    }
    println!(
        "  Request headers: {}",
        request
            .get("requestHeaders")
            .map(render_json_value)
            .unwrap_or_else(|| "absent".to_string())
    );
    println!(
        "  Response headers: {}",
        request
            .get("responseHeaders")
            .map(render_json_value)
            .unwrap_or_else(|| "absent (no response received)".to_string())
    );
    if let Some(bytes) = request.get("requestBodyBytes") {
        println!("  Request body bytes: {}", render_json_value(bytes));
    }
    if let Some(snapshot) = request.get("requestBody") {
        print_network_body("Request body", snapshot);
    } else if let Some(post_data) = request.get("postData") {
        println!("  Request body: {}", render_json_value(post_data));
    } else {
        println!("  Request body: absent");
    }
    if let Some(snapshot) = request.get("responseBody") {
        print_network_body("Response body", snapshot);
    } else if request.get("status").is_none() {
        println!("  Response body: pending (response has not completed)");
    } else {
        println!("  Response body: absent (Controller did not provide a body)");
    }
}

pub fn print_response_with_opts(resp: &Response, action: Option<&str>, opts: &OutputOptions) {
    // The Controller's CDP endpoint is private to its Docker network. Keep
    // this guard even though the moat CLI rejects `get cdp-url` before send:
    // a malformed or older Controller response must not become a URL leak.
    if action == Some("cdp_url") {
        let message =
            "unsupported_in_moat: get cdp-url is unavailable because the container CDP endpoint is private; use moat browser commands through the active session";
        if opts.json {
            println!(
                "{}",
                serde_json::json!({
                    "success": false,
                    "error": message,
                    "errorType": "unsupported_in_moat",
                })
            );
        } else {
            eprintln!("{} {}", color::error_indicator(), message);
        }
        return;
    }

    if opts.json {
        let response_json = || {
            let mut value = serde_json::to_value(resp).unwrap_or_default();
            if !resp.success {
                if let Some(obj) = value.as_object_mut() {
                    let error_type = obj
                        .get("errorType")
                        .and_then(|value| value.as_str())
                        .unwrap_or("command_failed");
                    obj.insert(
                        "errorType".into(),
                        serde_json::Value::String(error_type.into()),
                    );
                }
            }
            value
        };
        if opts.content_boundaries {
            let mut json_val = response_json();
            if let Some(obj) = json_val.as_object_mut() {
                let nonce = get_boundary_nonce();
                let origin = obj
                    .get("data")
                    .and_then(|d| d.get("origin"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                obj.insert(
                    "_boundary".to_string(),
                    serde_json::json!({
                        "nonce": nonce,
                        "origin": origin,
                    }),
                );
            }
            println!("{}", serde_json::to_string(&json_val).unwrap_or_default());
        } else {
            println!(
                "{}",
                serde_json::to_string(&response_json()).unwrap_or_default()
            );
        }
        // JSON mode includes the warning field in the JSON payload already
        return;
    }
    if !resp.success {
        if matches!(resp.cause.as_ref(), Some(CommandFailureCause::DialogPending)) {
            let dialog_id = resp.dialog_id.as_deref().unwrap_or("unknown");
            let page_id = resp
                .page
                .as_ref()
                .map(|page| page.page_id.as_str())
                .unwrap_or("unknown");
            match resp.operation_id.as_deref() {
                Some(operation_id) => eprintln!(
                    "{} Dialog pending (operation={}, dialog={}, page={}); run `dialog accept|dismiss`",
                    color::error_indicator(),
                    operation_id,
                    dialog_id,
                    page_id,
                ),
                None => eprintln!(
                    "{} Dialog pending (dialog={}, page={}); run `dialog accept|dismiss`",
                    color::error_indicator(),
                    dialog_id,
                    page_id,
                ),
            }
        } else {
            eprintln!(
                "{} {}",
                color::error_indicator(),
                resp.error.as_deref().unwrap_or("Unknown error")
            );
        }
        if let Some(details) = &resp.details {
            let tag = details.get("_tag").and_then(|value| value.as_str());
            if resp.error_type.as_deref() == Some("command_failed")
                && tag == Some("ThrownValue")
            {
                if let Some(value) = details.get("value") {
                    eprintln!("  Thrown value: {}", render_thrown_value(value));
                } else {
                    eprintln!("  Command details: {}", render_json_value(details));
                }
            } else {
                eprintln!("  Command details: {}", render_json_value(details));
            }
        }
        // Preserve any server warning alongside the structured failure.
        if let Some(warning) = &resp.warning {
            eprintln!("{} {}", color::warning_indicator(), warning);
        }
        return;
    }

    if let Some(data) = &resp.data {
        if action == Some("scroll") {
            let target = match data.get("target").and_then(|v| v.as_str()) {
                Some("element") => format!(
                    "element {}",
                    data.get("selector").and_then(|v| v.as_str()).unwrap_or("unknown"),
                ),
                _ => "window".to_string(),
            };
            let direction = data
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let requested = data
                .get("requested")
                .map(render_json_value)
                .unwrap_or_else(|| "unknown".to_string());
            let before = data
                .get("before")
                .map(render_json_value)
                .unwrap_or_else(|| "unknown".to_string());
            let after = data
                .get("after")
                .map(render_json_value)
                .unwrap_or_else(|| "unknown".to_string());
            let delta = data
                .get("delta")
                .map(render_json_value)
                .unwrap_or_else(|| "unknown".to_string());
            let max = data
                .get("max")
                .map(render_json_value)
                .unwrap_or_else(|| "unknown".to_string());
            let clipped = data.get("clipped").and_then(|v| v.as_bool()).unwrap_or(false);
            println!(
                "{} Scroll {} {}: before={} after={} delta={} requested={} max={} clipped={}",
                color::success_indicator(),
                target,
                direction,
                before,
                after,
                delta,
                requested,
                max,
                clipped,
            );
            return;
        }
        if matches!(action, Some("mousedown" | "mouseup")) {
            let held = data
                .get("heldMouseButtons")
                .map(render_json_value)
                .unwrap_or_else(|| "unknown".to_string());
            println!("{} Mouse buttons held: {}", color::success_indicator(), held);
            return;
        }

        if data.get("_tag").and_then(|v| v.as_str()) == Some("BatchResult") {
            let entries = data
                .get("results")
                .and_then(|v| v.as_array())
                .map(|values| values.as_slice())
                .unwrap_or(&[]);
            for (index, entry) in entries.iter().enumerate() {
                let child = index.saturating_add(1);
                if entry.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
                    println!("  Batch child {} completed", child);
                    continue;
                }
                if entry.get("cause").and_then(|v| v.as_str()) == Some("dialog_pending") {
                    let dialog_id = entry
                        .get("dialogId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let page_id = entry
                        .get("page")
                        .and_then(|v| v.get("pageId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    if let Some(operation_id) = entry.get("operationId").and_then(|v| v.as_str()) {
                        println!(
                            "  Batch child {} blocked: Dialog pending (operation={}, dialog={}, page={}); run `dialog accept|dismiss`, then retry this child",
                            child, operation_id, dialog_id, page_id
                        );
                    } else {
                        println!(
                            "  Batch child {} blocked: Dialog pending (dialog={}, page={}); run `dialog accept|dismiss`, then retry this child",
                            child, dialog_id, page_id
                        );
                    }
                } else {
                    let error = entry
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    println!("  Batch child {} failed: {}", child, error);
                }
            }
            if let Some(stopped_at) = data.get("stoppedAt").and_then(|v| v.as_u64()) {
                println!(
                    "{} Batch stopped at child {} (index {}) because the dialog is pending",
                    color::warning_indicator(),
                    stopped_at.saturating_add(1),
                    stopped_at
                );
            } else {
                println!("{} Batch completed", color::success_indicator());
            }
            print_warning(resp);
            return;
        }

        // Dialog results carry explicit Page/dialog and operation identity.
        if action == Some("dialog") {
            if data.get("state").and_then(|v| v.as_str()) == Some("handled") {
                let accepted = data.get("accepted").and_then(|v| v.as_bool()).unwrap_or(false);
                let action_name = if accepted { "accepted" } else { "dismissed" };
                let dialog_id = data.get("dialogId").and_then(|v| v.as_str()).unwrap_or("unknown");
                let page_id = data
                    .get("page")
                    .and_then(|v| v.get("pageId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                println!(
                    "{} Dialog {} (dialog={}, page={})",
                    color::success_indicator(),
                    action_name,
                    dialog_id,
                    page_id
                );
                if let Some(operation) = data.get("operation") {
                    if let Some(result) = operation.get("result") {
                        println!("  Evaluation result: {}", serde_json::to_string_pretty(result).unwrap_or_default());
                    } else if let Some(operation_id) = operation.get("operationId").and_then(|v| v.as_str()) {
                        println!("  Operation {} remains pending; run `dialog result {}`", operation_id, operation_id);
                    }
                }
                print_warning(resp);
                return;
            }
            if data.get("state").and_then(|v| v.as_str()) == Some("operation") {
                let operation_id = data
                    .get("operationId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                println!("{} Operation {}", color::warning_indicator(), operation_id);
                if let Some(operation) = data.get("operation") {
                    if operation.get("_tag").and_then(|v| v.as_str()) == Some("TimedOutOperation") {
                        let phase = operation.get("phase").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let budget = operation.get("budget").and_then(|v| v.as_u64()).map(|value| value.to_string()).unwrap_or_else(|| "unknown".to_string());
                        let side_effects = operation.get("sideEffects").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let session_id = operation.get("sessionId").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let dialog_id = operation.get("dialogId").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let page_id = operation
                            .get("page")
                            .and_then(|v| v.get("pageId"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        println!(
                            "  Timed out: phase={} budget={}ms sideEffects={} session={} operation={} dialog={} page={}",
                            phase, budget, side_effects, session_id, operation_id, dialog_id, page_id
                        );
                    } else if let Some(result) = operation.get("result") {
                        println!("  Evaluation result: {}", serde_json::to_string_pretty(result).unwrap_or_default());
                    } else {
                        println!("  {}", serde_json::to_string(operation).unwrap_or_default());
                    }
                }
                print_warning(resp);
                return;
            }
            if let Some(has_dialog) = data.get("hasDialog").and_then(|v| v.as_bool()) {
                if has_dialog {
                    let dtype = data
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let message = data.get("message").and_then(|v| v.as_str()).unwrap_or("");
                    let dialog_id = data.get("dialogId").and_then(|v| v.as_str()).unwrap_or("unknown");
                    let page_id = data
                        .get("page")
                        .and_then(|v| v.get("pageId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let page_index = data
                        .get("page")
                        .and_then(|v| v.get("pageIndex"))
                        .and_then(|v| v.as_i64())
                        .map(|index| index.to_string())
                        .unwrap_or_else(|| "unknown".to_string());
                    println!(
                        "{} JavaScript {} dialog is open: \"{}\" (dialog={}, page={} index={})",
                        color::warning_indicator(),
                        dtype,
                        message,
                        dialog_id,
                        page_id,
                        page_index
                    );
                    if let Some(default_prompt) = data.get("defaultPrompt").and_then(|v| v.as_str()) {
                        println!("  Default prompt text: \"{}\"", default_prompt);
                    }
                    if let Some(operation_id) = data
                        .get("operation")
                        .and_then(|v| v.get("operationId"))
                        .and_then(|v| v.as_str())
                    {
                        println!("  Evaluation operation: {}", operation_id);
                    }
                    println!("  Use `dialog accept [text]` or `dialog dismiss` to resolve it");
                } else {
                    println!("{} No dialog is currently open", color::success_indicator());
                }
                print_warning(resp);
                return;
            }
        }
        if data.get("state").and_then(|v| v.as_str()) == Some("pending") {
            let operation_id = data
                .get("operation")
                .and_then(|v| v.get("operationId"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let dialog_id = data.get("dialogId").and_then(|v| v.as_str()).unwrap_or("unknown");
            let page_id = data
                .get("page")
                .and_then(|v| v.get("pageId"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            println!(
                "{} Evaluation is pending on dialog {} (page={}); run `dialog accept|dismiss`, then `dialog result {}`",
                color::warning_indicator(),
                dialog_id,
                page_id,
                operation_id
            );
            print_warning(resp);
            return;
        }
        if let Some(output) = format_stream_status_text(action, data) {
            println!("{}", output);
            return;
        }
        if action == Some("storage_get") {
            if let Some(output) = format_storage_text(data) {
                println!("{}", output);
                return;
            }
        }
        // Inspect response (check before generic URL handler since it also has a "url" field)
        if action == Some("inspect") {
            let opened = data
                .get("opened")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if opened {
                if let Some(url) = data.get("url").and_then(|v| v.as_str()) {
                    println!("{} Opened DevTools: {}", color::success_indicator(), url);
                } else {
                    println!("{} Opened DevTools", color::success_indicator());
                }
            } else if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
                eprintln!("Could not open DevTools: {}", err);
            }
            return;
        }
        // Navigation response
        if let Some(url) = data.get("url").and_then(|v| v.as_str()) {
            if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
                println!("{} {}", color::success_indicator(), color::bold(title));
                println!("  {}", color::dim(url));
                return;
            }
            println!("{}", url);
            return;
        }
        // Diff responses -- route by action to avoid fragile shape probing
        if let Some(obj) = data.as_object() {
            match action {
                Some("diff_snapshot") => {
                    print_snapshot_diff(obj);
                    return;
                }
                Some("diff_screenshot") => {
                    print_screenshot_diff(obj);
                    return;
                }
                Some("diff_url") => {
                    if let Some(snap_data) = obj.get("snapshot").and_then(|v| v.as_object()) {
                        println!("{}", color::bold("Snapshot diff:"));
                        print_snapshot_diff(snap_data);
                    }
                    if let Some(ss_data) = obj.get("screenshot").and_then(|v| v.as_object()) {
                        println!("\n{}", color::bold("Screenshot diff:"));
                        print_screenshot_diff(ss_data);
                    }
                    return;
                }
                _ => {}
            }
        }
        let origin = data.get("origin").and_then(|v| v.as_str());
        // Snapshot
        if let Some(snapshot) = data.get("snapshot").and_then(|v| v.as_str()) {
            print_with_boundaries(snapshot, origin, opts);
            return;
        }
        // Title
        if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
            println!("{}", title);
            return;
        }
        // Multi-element text getter
        if action == Some("gettext") {
            if let Some(texts) = data.get("texts").and_then(|value| value.as_array()) {
                if texts.is_empty() {
                    println!("[]");
                } else {
                    for text in texts {
                        if let Some(text) = text.as_str() {
                            print_with_boundaries(text, origin, opts);
                        } else {
                            println!("{}", serde_json::to_string_pretty(text).unwrap_or_else(|_| "<invalid text value>".to_string()));
                        }
                    }
                }
                return;
            }
        }

        // Text
        if let Some(text) = data.get("text").and_then(|v| v.as_str()) {
            print_with_boundaries(text, origin, opts);
            return;
        }
        // HTML
        if let Some(html) = data.get("html").and_then(|v| v.as_str()) {
            print_with_boundaries(html, origin, opts);
            return;
        }
        // Attribute result
        if action == Some("getattribute") {
            if let Some(value) = data.get("value") {
                println!("{}", render_attribute_value(value));
                return;
            }
        }

        // Value
        if let Some(value) = data.get("value").and_then(|v| v.as_str()) {
            println!("{}", value);
            return;
        }
        // Count
        if let Some(count) = data.get("count").and_then(|v| v.as_i64()) {
            println!("{}", count);
            return;
        }
        // Boolean results
        // Visibility results retain the Controller's layout-visibility semantics.
        if let Some(visible) = data.get("visible").and_then(|v| v.as_bool()) {
            if action == Some("isvisible") {
                println!(
                    "{} (layout-visible; does not prove opacity, occlusion, perceptual visibility, or interactivity)",
                    visible
                );
            } else {
                println!("{}", visible);
            }
            return;
        }

        if let Some(enabled) = data.get("enabled").and_then(|v| v.as_bool()) {
            println!("{}", enabled);
            return;
        }
        if let Some(checked) = data.get("checked").and_then(|v| v.as_bool()) {
            println!("{}", checked);
            return;
        }
        // Eval result
        // Eval result: values are already encoded once by the Controller.
        if let Some(result) = data.get("result") {
            let formatted = render_eval_value(result);
            print_with_boundaries(&formatted, origin, opts);
            return;
        }
        if action == Some("device_list") {
            let descriptors = data
                .get("devices")
                .and_then(|value| value.as_array())
                .map(|values| values.as_slice())
                .unwrap_or(&[]);
            if descriptors.is_empty() {
                println!("No remote Chromium device descriptors available.");
                return;
            }
            println!("Remote Chromium device descriptors:");
            for descriptor in descriptors {
                let name = descriptor
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Unknown");
                let viewport = descriptor.get("viewport").and_then(|value| value.as_object());
                let width = viewport
                    .and_then(|value| value.get("width"))
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let height = viewport
                    .and_then(|value| value.get("height"))
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let dpr = descriptor
                    .get("deviceScaleFactor")
                    .and_then(|value| value.as_f64())
                    .unwrap_or(1.0);
                let touch = descriptor
                    .get("hasTouch")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                let mobile = descriptor
                    .get("isMobile")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                println!(
                    "  {} ({}x{}, DPR {}, touch {}, mobile {})",
                    name, width, height, dpr, touch, mobile
                );
            }
            return;
        }

        // iOS Devices
        if let Some(devices) = data.get("devices").and_then(|v| v.as_array()) {
            if devices.is_empty() {
                println!("No iOS devices available. Open Xcode to download simulator runtimes.");
                return;
            }

            // Separate real devices from simulators
            let real_devices: Vec<_> = devices
                .iter()
                .filter(|d| {
                    d.get("isRealDevice")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                })
                .collect();
            let simulators: Vec<_> = devices
                .iter()
                .filter(|d| {
                    !d.get("isRealDevice")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                })
                .collect();

            if !real_devices.is_empty() {
                println!("Connected Devices:\n");
                for device in real_devices.iter() {
                    let name = device
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown");
                    let runtime = device.get("runtime").and_then(|v| v.as_str()).unwrap_or("");
                    let udid = device.get("udid").and_then(|v| v.as_str()).unwrap_or("");
                    println!("  {} {} ({})", color::green("●"), name, runtime);
                    println!("    {}", color::dim(udid));
                }
                println!();
            }

            if !simulators.is_empty() {
                println!("Simulators:\n");
                for device in simulators.iter() {
                    let name = device
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown");
                    let runtime = device.get("runtime").and_then(|v| v.as_str()).unwrap_or("");
                    let state = device
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown");
                    let udid = device.get("udid").and_then(|v| v.as_str()).unwrap_or("");
                    let state_indicator = if state == "Booted" {
                        color::green("●")
                    } else {
                        color::dim("○")
                    };
                    println!("  {} {} ({})", state_indicator, name, runtime);
                    println!("    {}", color::dim(udid));
                }
            }
            return;
        }
        // Tabs
        if let Some(tabs) = data.get("tabs").and_then(|v| v.as_array()) {
            if action == Some("window_new") {
                println!("Opened a new tab in the shared browser context:");
            }
            for (i, tab) in tabs.iter().enumerate() {
                let title = tab
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Untitled");
                let url = tab.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let active = tab.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                let marker = if active {
                    color::cyan("→")
                } else {
                    " ".to_string()
                };
                println!("{} [{}] {} - {}", marker, i, title, url);
            }
            return;
        }
        // Console and browser-generated diagnostics
        if let Some(logs) = data.get("messages").and_then(|v| v.as_array()) {
            if opts.content_boundaries {
                let mut console_output = String::new();
                for log in logs {
                    let level = log
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("error");
                    console_output.push_str(&format!(
                        "{} {}\n",
                        color::console_level_prefix(level),
                        diagnostic_text(log)
                    ));
                }
                if console_output.ends_with('\n') {
                    console_output.pop();
                }
                print_with_boundaries(&console_output, origin, opts);
            } else {
                for log in logs {
                    let level = log
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("error");
                    println!(
                        "{} {}",
                        color::console_level_prefix(level),
                        diagnostic_text(log)
                    );
                }
            }
            return;
        }
        // Page errors and browser-generated failures
        if let Some(errors) = data.get("errors").and_then(|v| v.as_array()) {
            for error in errors {
                println!("{} {}", color::error_indicator(), diagnostic_text(error));
            }
            return;
        }
        // Full network request detail (the JSON response remains the source of truth).
        if action == Some("request_detail") {
            if let Some(request) = data.get("request") {
                print_request_detail(request);
                return;
            }
        }
        // Cookies
        if let Some(cookies) = data.get("cookies").and_then(|v| v.as_array()) {
            for cookie in cookies {
                let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let value = cookie.get("value").and_then(|v| v.as_str()).unwrap_or("");
                println!("{}={}", name, value);
            }
            return;
        }
        // Network requests
        if let Some(requests) = data.get("requests").and_then(|v| v.as_array()) {
            if requests.is_empty() {
                println!("No requests captured");
            } else {
                for req in requests {
                    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
                    let url = req.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let resource_type = req
                        .get("resourceType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let request_id = req.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
                    let status = req.get("status").and_then(|v| v.as_i64());
                    let body = network_body_summary(req);
                    match status {
                        Some(s) => println!(
                            "[{}] {} {} ({}) {} {}",
                            request_id, method, url, resource_type, s, body
                        ),
                        None => println!(
                            "[{}] {} {} ({}) {}",
                            request_id, method, url, resource_type, body
                        ),
                    }
                }
            }
            return;
        }
        // Cleared (cookies, console, or request log)
        if let Some(cleared) = data.get("cleared").and_then(|v| v.as_bool()) {
            if cleared {
                let label = match action {
                    Some("cookies_clear") => "Cookies cleared",
                    Some("console") => "Console log cleared",
                    Some("errors") => "Page error log cleared",
                    _ => "Request log cleared",
                };
                println!("{} {}", color::success_indicator(), label);
                return;
            }
        }
        // Bounding box
        if let Some(box_data) = data.get("box") {
            println!(
                "{}",
                serde_json::to_string_pretty(box_data).unwrap_or_default()
            );
            return;
        }
        // Element styles
        if let Some(elements) = data.get("elements").and_then(|v| v.as_array()) {
            for (i, el) in elements.iter().enumerate() {
                let tag = el.get("tag").and_then(|v| v.as_str()).unwrap_or("?");
                let text = el.get("text").and_then(|v| v.as_str()).unwrap_or("");
                println!("[{}] {} \"{}\"", i, tag, text);

                if let Some(box_data) = el.get("box") {
                    println!("    box: {}", render_geometry(box_data));
                }

                if let Some(styles) = el.get("styles") {
                    let font_size = styles
                        .get("fontSize")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let font_weight = styles
                        .get("fontWeight")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let font_family = styles
                        .get("fontFamily")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let color = styles.get("color").and_then(|v| v.as_str()).unwrap_or("");
                    let bg = styles
                        .get("backgroundColor")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let radius = styles
                        .get("borderRadius")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    println!("    font: {} {} {}", font_size, font_weight, font_family);
                    println!("    color: {}", color);
                    println!("    background: {}", bg);
                    if radius != "0px" {
                        println!("    border-radius: {}", radius);
                    }
                }
                println!();
            }
            return;
        }
        // Closed (browser or tab)
        if data.get("closed").is_some() {
            let label = match action {
                Some("tab_close") => "Tab closed",
                _ => "Browser closed",
            };
            println!("{} {}", color::success_indicator(), label);
            return;
        }
        // Started actions (profiling, HAR, recording)
        if let Some(started) = data.get("started").and_then(|v| v.as_bool()) {
            if started {
                match action {
                    Some("profiler_start") => {
                        println!("{} Profiling started", color::success_indicator());
                    }
                    Some("har_start") => {
                        println!("{} HAR recording started", color::success_indicator());
                    }
                    _ => {
                        if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
                            println!("{} Recording started: {}", color::success_indicator(), path);
                        } else {
                            println!("{} Recording started", color::success_indicator());
                        }
                    }
                }
                return;
            }
        }
        // Recording restart (has "stopped" field - from recording_restart action)
        if data.get("stopped").is_some() {
            let path = data
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            if let Some(prev_path) = data.get("previousPath").and_then(|v| v.as_str()) {
                println!(
                    "{} Recording restarted: {} (previous saved to {})",
                    color::success_indicator(),
                    path,
                    prev_path
                );
            } else {
                println!("{} Recording started: {}", color::success_indicator(), path);
            }
            return;
        }
        // Recording stop (has "frames" field - from recording_stop action)
        if data.get("frames").is_some() {
            if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
                if let Some(error) = data.get("error").and_then(|v| v.as_str()) {
                    println!(
                        "{} Recording saved to {} - {}",
                        color::warning_indicator(),
                        path,
                        error
                    );
                } else {
                    println!("{} Recording saved to {}", color::success_indicator(), path);
                }
            } else {
                println!("{} Recording stopped", color::success_indicator());
            }
            return;
        }
        // Download response (has "suggestedFilename" or "filename" field)
        if matches!(action, Some("download" | "waitfordownload"))
            && (data.get("suggestedFilename").is_some() || data.get("filename").is_some())
        {
            if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
                let filename = data
                    .get("suggestedFilename")
                    .or_else(|| data.get("filename"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if filename.is_empty() {
                    println!(
                        "{} Downloaded to {}",
                        color::success_indicator(),
                        color::green(path)
                    );
                } else {
                    println!(
                        "{} Downloaded to {} ({})",
                        color::success_indicator(),
                        color::green(path),
                        filename
                    );
                }
                return;
            }
        }
        // Trace stop without path
        if data.get("traceStopped").is_some() {
            println!("{} Trace stopped", color::success_indicator());
            return;
        }
        if action == Some("har_stop")
            && data.get("status").and_then(|value| value.as_str()) == Some("incomplete")
        {
            let message = data
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("HAR capture is incomplete");
            let next_action = data
                .get("nextAction")
                .and_then(|value| value.as_str())
                .unwrap_or("retry HAR recording after the request bodies settle");
            println!(
                "{} HAR incomplete: {}. Next: {}",
                color::warning_indicator(),
                message,
                next_action
            );
            return;
        }

        // Path-based operations (screenshot/pdf/trace/har/download/state/video)
        if !matches!(action, Some("state_show" | "state_rename")) {
            if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
                match action.unwrap_or("") {
                    "screenshot" => {
                        println!(
                            "{} Screenshot saved to {}",
                            color::success_indicator(),
                            color::green(path)
                        );
                        if let Some(annotations) =
                            data.get("annotations").and_then(|v| v.as_array())
                        {
                            for ann in annotations {
                                let num = ann.get("number").and_then(|n| n.as_u64()).unwrap_or(0);
                                let ref_id = ann.get("ref").and_then(|r| r.as_str()).unwrap_or("");
                                let role = ann.get("role").and_then(|r| r.as_str()).unwrap_or("");
                                let name = ann.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                if name.is_empty() {
                                    println!(
                                        "   {} @{} {}",
                                        color::dim(&format!("[{}]", num)),
                                        ref_id,
                                        role,
                                    );
                                } else {
                                    println!(
                                        "   {} @{} {} {:?}",
                                        color::dim(&format!("[{}]", num)),
                                        ref_id,
                                        role,
                                        name,
                                    );
                                }
                            }
                        }
                    }
                    "pdf" => println!(
                        "{} PDF saved to {}",
                        color::success_indicator(),
                        color::green(path)
                    ),
                    "trace_stop" => println!(
                        "{} Trace saved to {}",
                        color::success_indicator(),
                        color::green(path)
                    ),
                    "profiler_stop" => println!(
                        "{} Profile saved to {} ({} events)",
                        color::success_indicator(),
                        color::green(path),
                        data.get("eventCount").and_then(|c| c.as_u64()).unwrap_or(0)
                    ),
                    "har_stop" => println!(
                        "{} HAR saved to {} ({} requests)",
                        color::success_indicator(),
                        color::green(path),
                        data.get("requestCount")
                            .and_then(|c| c.as_u64())
                            .unwrap_or(0)
                    ),
                    "download" | "waitfordownload" => println!(
                        "{} Download saved to {}",
                        color::success_indicator(),
                        color::green(path)
                    ),
                    "video_stop" => println!(
                        "{} Video saved to {}",
                        color::success_indicator(),
                        color::green(path)
                    ),
                    "state_save" => println!(
                        "{} State saved to {}",
                        color::success_indicator(),
                        color::green(path)
                    ),
                    "state_load" => {
                        if let Some(note) = data.get("note").and_then(|v| v.as_str()) {
                            println!("{}", note);
                        }
                        println!(
                            "{} State path set to {}",
                            color::success_indicator(),
                            color::green(path)
                        );
                    }
                    // video_start and other commands that provide a path with a note
                    "video_start" => {
                        if let Some(note) = data.get("note").and_then(|v| v.as_str()) {
                            println!("{}", note);
                        }
                        println!("Path: {}", path);
                    }
                    _ => println!(
                        "{} Saved to {}",
                        color::success_indicator(),
                        color::green(path)
                    ),
                }
                return;
            }
        }

        if action == Some("state_load") {
            if let Some(status) = data.get("status").and_then(|v| v.as_str()) {
                let cookies = data.get("cookies").and_then(|v| v.as_i64()).unwrap_or(0);
                let origins = data.get("origins").and_then(|v| v.as_i64()).unwrap_or(0);
                let tabs = data.get("tabs").and_then(|v| v.as_i64()).unwrap_or(0);
                let indexed_db = data.get("indexedDB").and_then(|v| v.as_i64()).unwrap_or(0);
                match status {
                    "complete" => println!(
                        "{} State restored completely (cookies: {}, origins: {}, tabs: {}, IndexedDB: {})",
                        color::success_indicator(),
                        cookies,
                        origins,
                        tabs,
                        indexed_db
                    ),
                    "incomplete" => println!(
                        "{} State restore incomplete ({}, cookies: {}, origins: {}, tabs: {}, IndexedDB: {})",
                        color::warning_indicator(),
                        data.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown"),
                        cookies,
                        origins,
                        tabs,
                        indexed_db
                    ),
                    "unsupported" => println!(
                        "{} State restore unsupported ({}, cookies: {}, origins: {}, tabs: {}, IndexedDB: {})",
                        color::warning_indicator(),
                        data.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown"),
                        cookies,
                        origins,
                        tabs,
                        indexed_db
                    ),
                    _ => println!(
                        "{} State restore returned unknown status {}",
                        color::warning_indicator(),
                        status
                    ),
                }
                return;
            }
        }

        // State list
        if let Some(files) = data.get("files").and_then(|v| v.as_array()) {
            if let Some(dir) = data.get("directory").and_then(|v| v.as_str()) {
                println!("{}", color::bold(&format!("Saved states in {}", dir)));
            }
            if files.is_empty() {
                println!("{}", color::dim("  No state files found"));
            } else {
                for file in files {
                    let filename = file.get("filename").and_then(|v| v.as_str()).unwrap_or("");
                    let size = file.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
                    let modified = file.get("modified").and_then(|v| v.as_str()).unwrap_or("");
                    let encrypted = file
                        .get("encrypted")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let managed = file.get("managed").and_then(|v| v.as_bool()).unwrap_or(false);
                    let size_str = if size > 1024 {
                        format!("{:.1}KB", size as f64 / 1024.0)
                    } else {
                        format!("{}B", size)
                    };
                    let date_str = modified.split('T').next().unwrap_or(modified);
                    let enc_str = if encrypted { " [encrypted]" } else { "" };
                    let namespace = if managed { "default" } else { "explicit" };
                    println!(
                        "  {} {}",
                        filename,
                        color::dim(&format!("({}, {}, {}){}", size_str, date_str, namespace, enc_str))
                    );
                }
            }
            return;
        }

        // State rename
        if let Some(true) = data.get("renamed").and_then(|v| v.as_bool()) {
            let old_name = data.get("oldName").and_then(|v| v.as_str()).unwrap_or("");
            let new_name = data.get("newName").and_then(|v| v.as_str()).unwrap_or("");
            println!(
                "{} Renamed {} -> {}",
                color::success_indicator(),
                old_name,
                new_name
            );
            return;
        }

        // State clear
        if let Some(cleared) = data.get("cleared").and_then(|v| v.as_i64()) {
            println!(
                "{} Cleared {} state file(s)",
                color::success_indicator(),
                cleared
            );
            return;
        }

        // State show summary
        if let Some(summary) = data.get("summary") {
            let cookies = summary.get("cookies").and_then(|v| v.as_i64()).unwrap_or(0);
            let origins = summary.get("origins").and_then(|v| v.as_i64()).unwrap_or(0);
            let tabs = summary.get("tabs").and_then(|v| v.as_i64()).unwrap_or(0);
            let indexed_db = summary.get("indexedDB").and_then(|v| v.as_i64()).unwrap_or(0);
            let encrypted = data
                .get("encrypted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let managed = data
                .get("managed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let enc_str = if encrypted { " (encrypted)" } else { "" };
            let namespace = if managed { "default namespace" } else { "explicit path" };
            println!("State file summary{} [{}]:", enc_str, namespace);
            println!("  Cookies: {}", cookies);
            println!("  Origins with localStorage: {}", origins);
            println!("  Tabs with sessionStorage: {}", tabs);
            println!("  IndexedDB databases: {}", indexed_db);
            return;
        }

        // State clean
        if let Some(cleaned) = data.get("cleaned").and_then(|v| v.as_i64()) {
            println!(
                "{} Cleaned {} old state file(s)",
                color::success_indicator(),
                cleaned
            );
            return;
        }

        // Runtime init-script lifecycle responses (issue 227)
        if action == Some("addinitscript")
            && data.get("added").and_then(|v| v.as_bool()) == Some(true)
        {
            let identifier = data.get("identifier").and_then(|v| v.as_str()).unwrap_or("");
            println!(
                "{} Init script registered: {}",
                color::success_indicator(),
                identifier
            );
            return;
        }
        if action == Some("removeinitscript")
            && data.get("removed").and_then(|v| v.as_bool()) == Some(true)
        {
            let identifier = data.get("identifier").and_then(|v| v.as_str()).unwrap_or("");
            println!(
                "{} Init script removed: {}",
                color::success_indicator(),
                identifier
            );
            return;
        }

        // Informational note
        if let Some(note) = data.get("note").and_then(|v| v.as_str()) {
            println!("{}", note);
            return;
        }
        // Auth list
        if let Some(profiles) = data.get("profiles").and_then(|v| v.as_array()) {
            if profiles.is_empty() {
                println!("{}", color::dim("No auth profiles saved"));
            } else {
                println!("{}", color::bold("Auth profiles:"));
                for p in profiles {
                    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let url = p.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let user = p.get("username").and_then(|v| v.as_str()).unwrap_or("");
                    println!(
                        "  {} {} {}",
                        color::green(name),
                        color::dim(user),
                        color::dim(url)
                    );
                }
            }
            return;
        }

        // Auth show
        if let Some(profile) = data.get("profile").and_then(|v| v.as_object()) {
            let name = profile.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let url = profile.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let user = profile
                .get("username")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let created = profile
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let last_login = profile.get("lastLoginAt").and_then(|v| v.as_str());
            println!("Name: {}", name);
            println!("URL: {}", url);
            println!("Username: {}", user);
            println!("Created: {}", created);
            if let Some(ll) = last_login {
                println!("Last login: {}", ll);
            }
            return;
        }

        // Auth save/update/login/delete
        if data.get("saved").and_then(|v| v.as_bool()).unwrap_or(false) {
            let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
            println!(
                "{} Auth profile '{}' saved",
                color::success_indicator(),
                name
            );
            return;
        }
        if data
            .get("updated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            && !data.get("saved").and_then(|v| v.as_bool()).unwrap_or(false)
        {
            let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
            println!(
                "{} Auth profile '{}' updated",
                color::success_indicator(),
                name
            );
            return;
        }
        if data
            .get("loggedIn")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
                println!(
                    "{} Logged in as '{}' - {}",
                    color::success_indicator(),
                    name,
                    title
                );
            } else {
                println!("{} Logged in as '{}'", color::success_indicator(), name);
            }
            return;
        }
        if data
            .get("deleted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
                println!(
                    "{} Auth profile '{}' deleted",
                    color::success_indicator(),
                    name
                );
                return;
            }
        }

        // Confirmation required (for orchestrator use)
        if data
            .get("confirmation_required")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            let category = data.get("category").and_then(|v| v.as_str()).unwrap_or("");
            let description = data
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let cid = data
                .get("confirmation_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            println!("Confirmation required:");
            println!("  {}: {}", category, description);
            println!("  Run: agent-browser confirm {}", cid);
            println!("  Or:  agent-browser deny {}", cid);
            return;
        }
        if data
            .get("confirmed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            println!("{} Action confirmed", color::success_indicator());
            return;
        }
        if data
            .get("denied")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            println!("{} Action denied", color::success_indicator());
            return;
        }

        // Default success
        println!("{} Done", color::success_indicator());
    }

    print_warning(resp);
}

fn print_warning(resp: &Response) {
    if let Some(ref warning) = resp.warning {
        eprintln!("{} {}", color::warning_indicator(), warning);
    }
}

fn print_snapshot_diff(data: &serde_json::Map<String, serde_json::Value>) {
    if data.get("status").and_then(|v| v.as_str()) == Some("baseline-initialized") {
        println!(
            "{} Baseline initialized; no comparison performed",
            color::success_indicator()
        );
        return;
    }
    let changed = data
        .get("changed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !changed {
        println!("{} No changes detected", color::success_indicator());
        return;
    }
    if let Some(diff) = data.get("diff").and_then(|v| v.as_str()) {
        for line in diff.lines() {
            if line.starts_with("+ ") {
                println!("{}", color::green(line));
            } else if line.starts_with("- ") {
                println!("{}", color::red(line));
            } else {
                println!("{}", color::dim(line));
            }
        }
        let additions = data.get("additions").and_then(|v| v.as_i64()).unwrap_or(0);
        let removals = data.get("removals").and_then(|v| v.as_i64()).unwrap_or(0);
        let unchanged = data.get("unchanged").and_then(|v| v.as_i64()).unwrap_or(0);
        println!(
            "\n{} additions, {} removals, {} unchanged",
            color::green(&additions.to_string()),
            color::red(&removals.to_string()),
            unchanged
        );
    }
}

fn print_screenshot_diff(data: &serde_json::Map<String, serde_json::Value>) {
    let mismatch = data
        .get("mismatchPercentage")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let is_match = data.get("match").and_then(|v| v.as_bool()).unwrap_or(false);
    let dim_mismatch = data
        .get("dimensionMismatch")
        .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false));
    if dim_mismatch {
        println!(
            "{} Images have different dimensions",
            color::error_indicator()
        );
    } else if is_match {
        println!(
            "{} Images match (0% difference)",
            color::success_indicator()
        );
    } else {
        println!(
            "{} {:.2}% pixels differ",
            color::error_indicator(),
            mismatch
        );
    }
    let output_requested = data
        .get("outputPath")
        .and_then(|v| v.as_str())
        .is_some();
    if output_requested {
        if let Some(diff_path) = data.get("diffPath").and_then(|v| v.as_str()) {
            println!("  Diff image: {}", color::green(diff_path));
        } else {
            println!("  No diff image generated");
        }
    }
    let total = data
        .get("totalPixels")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let different = data
        .get("differentPixels")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    println!(
        "  {} different / {} total pixels",
        color::red(&different.to_string()),
        total
    );
}

#[cfg(test)]
mod tests {
    use super::format_storage_text;
    use serde_json::json;

    #[test]
    fn test_format_stream_status_text_for_enabled_stream() {
        let data = json!({
            "enabled": true,
            "port": 9223,
            "connected": true,
            "screencasting": false
        });

        let rendered = super::format_stream_status_text(Some("stream_status"), &data).unwrap();

        assert_eq!(
            rendered,
            "Streaming enabled on ws://127.0.0.1:9223\nConnected: true\nScreencasting: false"
        );
    }

    #[test]
    fn test_format_stream_status_text_for_disabled_stream() {
        let data =
            json!({ "enabled": false, "port": null, "connected": false, "screencasting": false });

        let rendered = super::format_stream_status_text(Some("stream_status"), &data).unwrap();

        assert_eq!(rendered, "Streaming disabled");
    }

    #[test]
    fn test_format_storage_text_for_all_entries() {
        let data = json!({
            "data": {
                "token": "abc123",
                "user": "alice"
            }
        });

        let rendered = format_storage_text(&data).unwrap();

        assert_eq!(rendered, "token: abc123\nuser: alice");
    }

    #[test]
    fn test_format_storage_text_for_key_lookup() {
        let data = json!({
            "key": "token",
            "value": "abc123"
        });

        let rendered = format_storage_text(&data).unwrap();

        assert_eq!(rendered, "token: abc123");
    }

    #[test]
    fn test_format_storage_text_for_empty_store() {
        let data = json!({
            "data": {}
        });

        let rendered = format_storage_text(&data).unwrap();

        assert_eq!(rendered, "No storage entries");
    }
}
