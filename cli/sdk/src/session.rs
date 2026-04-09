use std::fs;
use std::path::PathBuf;

use crate::error::SdkError;

/// Returns the path to ~/.moat/session
fn session_file() -> Result<PathBuf, SdkError> {
    let home = dirs::home_dir().ok_or_else(|| SdkError::SessionFileError("no home dir".into()))?;
    let dir = home.join(".moat");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| SdkError::SessionFileError(format!("mkdir: {}", e)))?;
    }
    Ok(dir.join("session"))
}

/// Read the stored session ID, if any.
pub fn read_session_id() -> Result<Option<String>, SdkError> {
    let path = session_file()?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| SdkError::SessionFileError(format!("read: {}", e)))?;
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed))
    }
}

/// Write a session ID to ~/.moat/session.
pub fn write_session_id(session_id: &str) -> Result<(), SdkError> {
    let path = session_file()?;
    fs::write(&path, session_id)
        .map_err(|e| SdkError::SessionFileError(format!("write: {}", e)))
}

/// Clear the stored session ID.
pub fn clear_session_id() -> Result<(), SdkError> {
    let path = session_file()?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| SdkError::SessionFileError(format!("remove: {}", e)))?;
    }
    Ok(())
}
