use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::PathBuf;

use crate::error::SdkError;

/// Only a single, non-empty filename component may identify a local slot.
pub fn validate_name(name: &str) -> Result<(), SdkError> {
    if name.is_empty()
        || name.len() > 255
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(SdkError::InvalidSessionName(name.to_string()));
    }
    Ok(())
}

fn session_file(name: &str) -> Result<PathBuf, SdkError> {
    validate_name(name)?;
    let home = dirs::home_dir().ok_or_else(|| SdkError::SessionFileError("no home dir".into()))?;
    let dir = home.join(".moat").join("sessions");
    fs::create_dir_all(&dir)
        .map_err(|e| SdkError::SessionFileError(format!("mkdir: {}", e)))?;
    Ok(dir.join(name))
}

/// Read the selected slot. An empty file means registration is in progress.
pub fn read_session_id(name: &str) -> Result<Option<String>, SdkError> {
    let path = session_file(name)?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(SdkError::SessionFileError(format!("read: {}", error))),
    };
    let trimmed = content.trim();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

/// Claim a vacant slot before the first network request. The guard removes the
/// empty file if registration fails or is cancelled (including timeout).
pub fn claim_session(name: &str) -> Result<SessionClaim, SdkError> {
    let path = session_file(name)?;
    let file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return Err(SdkError::SessionAlreadyActive {
                session_id: read_session_id(name)?
                    .unwrap_or_else(|| "registration in progress".into()),
            });
        }
        Err(error) => return Err(SdkError::SessionFileError(format!("claim: {}", error))),
    };
    Ok(SessionClaim {
        path,
        file,
        saved: false,
    })
}

pub struct SessionClaim {
    path: PathBuf,
    file: File,
    saved: bool,
}

impl SessionClaim {
    pub fn save(mut self, session_id: &str) -> Result<(), SdkError> {
        if session_id.trim().is_empty() {
            return Err(SdkError::SessionFileError("cannot save an empty session id".into()));
        }
        self.file
            .write_all(session_id.as_bytes())
            .map_err(|error| SdkError::SessionFileError(format!("write: {}", error)))?;
        self.saved = true;
        Ok(())
    }
}

impl Drop for SessionClaim {
    fn drop(&mut self) {
        if !self.saved {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Select an existing Controller session only into a vacant slot. In
/// particular, `use` cannot overwrite a connect claim or a live handle while
/// a command or deregistration is using it.
pub fn write_session_id(name: &str, session_id: &str) -> Result<(), SdkError> {
    claim_session(name)?.save(session_id)
}

/// Clear only the selected slot after successful remote deregistration.
pub fn clear_session_id(name: &str) -> Result<(), SdkError> {
    let path = session_file(name)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SdkError::SessionFileError(format!("remove: {}", error))),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_name;

    #[test]
    fn accepts_safe_slot_names_and_rejects_path_components() {
        for name in ["default", "a", "Agent_7-2"] {
            assert!(validate_name(name).is_ok(), "{name}");
        }
        for name in ["", ".", "..", "../x", "a/b", "a\\b", "x.y", "x y", "é"] {
            assert!(validate_name(name).is_err(), "{name}");
        }
        assert!(validate_name(&"a".repeat(256)).is_err());
    }
}
