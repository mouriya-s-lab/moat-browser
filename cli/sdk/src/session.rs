use crate::error::SdkError;

/// Read session ID from MOAT_SESSION env var.
pub fn read_session_id() -> Result<Option<String>, SdkError> {
    match std::env::var("MOAT_SESSION") {
        Ok(val) if !val.is_empty() => Ok(Some(val)),
        _ => Ok(None),
    }
}
