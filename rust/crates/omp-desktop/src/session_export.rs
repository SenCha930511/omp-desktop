//! Session-scoped export state and destination validation.
//!
//! The native picker authorizes a directory, never a caller-provided file. The
//! only filename sent to OMP is derived from the persistent session id, so a
//! display title cannot introduce a separator or parent traversal.

use std::path::{Component, Path, PathBuf};

/// The identity captured before an asynchronous directory picker is opened.
/// The file path distinguishes compacted branches that share a session id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SessionExportTarget {
    pub(super) session_id: String,
    pub(super) file_path: String,
    pub(super) runtime_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ExportPathError {
    InvalidDirectory,
    InvalidSessionId,
    AlreadyExists,
}

/// Builds the only output path the UI is willing to send to `export_html`.
///
/// An explicit user selection is still constrained to one existing absolute
/// directory. Parent components are rejected rather than normalized. The
/// directory is canonicalized before joining a single percent-encoded filename,
/// which also makes symlink resolution and response reconciliation use the same
/// absolute path. Any existing filesystem entry, including a dangling symlink,
/// is refused before the server is asked to write.
pub(super) fn compose_export_path(
    directory: &Path,
    session_id: &str,
) -> Result<PathBuf, ExportPathError> {
    if !directory.is_absolute()
        || directory
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ExportPathError::InvalidDirectory);
    }
    let directory =
        omp_core::paths::canonicalize(directory).map_err(|_| ExportPathError::InvalidDirectory)?;
    if !directory.is_dir() {
        return Err(ExportPathError::InvalidDirectory);
    }

    // UUIDs remain readable. Every other UTF-8 byte is encoded, including '%',
    // both separators, control characters, dots-only input and device names.
    // The fixed prefix and extension keep even an unusual id a normal file.
    // Bound the input before allocation too: session JSONL is untrusted data.
    if session_id.is_empty() || session_id.len() > 180 {
        return Err(ExportPathError::InvalidSessionId);
    }
    let mut encoded = String::new();
    for byte in session_id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
            encoded.push(char::from(byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    // Stay below common per-component limits, and never cut inside a '%XX'.
    // An unusually long id is an explicit error, not a truncating rename that
    // could collide with a different session's output.
    if encoded.is_empty() || encoded.len() > 180 {
        return Err(ExportPathError::InvalidSessionId);
    }
    let output = directory.join(format!("session-{encoded}.html"));
    match std::fs::symlink_metadata(&output) {
        Ok(_) => Err(ExportPathError::AlreadyExists),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(output),
        Err(_) => Err(ExportPathError::AlreadyExists),
    }
}

#[cfg(test)]
mod tests {
    use super::{ExportPathError, compose_export_path};

    #[test]
    fn output_name_percent_encodes_traversal_and_device_text() {
        let directory = tempfile::TempDir::new().expect("selected export directory");
        let output =
            compose_export_path(directory.path(), "../../CON/..\\evil%").expect("safe output");
        assert_eq!(
            output.file_name().and_then(|name| name.to_str()),
            Some("session-%2E%2E%2F%2E%2E%2FCON%2F%2E%2E%5Cevil%25.html")
        );
        assert!(output.starts_with(directory.path().canonicalize().expect("canonical")));
        assert!(!output.exists());
    }

    #[test]
    fn parent_components_and_existing_entries_are_refused() {
        let directory = tempfile::TempDir::new().expect("selected export directory");
        assert_eq!(
            compose_export_path(&directory.path().join("../outside"), "id"),
            Err(ExportPathError::InvalidDirectory)
        );
        let existing = compose_export_path(directory.path(), "taken").expect("first path");
        std::fs::write(&existing, "keep").expect("existing HTML");
        assert_eq!(
            compose_export_path(directory.path(), "taken"),
            Err(ExportPathError::AlreadyExists)
        );
        assert_eq!(std::fs::read_to_string(existing).expect("original"), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_dangling_symlink_is_not_an_available_destination() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::TempDir::new().expect("selected export directory");
        let output = compose_export_path(directory.path(), "link").expect("first path");
        let outside = directory.path().join("outside.html");
        symlink(&outside, &output).expect("dangling destination symlink");
        assert_eq!(
            compose_export_path(directory.path(), "link"),
            Err(ExportPathError::AlreadyExists)
        );
        assert!(!outside.exists());
    }
}
