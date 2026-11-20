use std::path::PathBuf;

pub fn home_dir() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn is_absolute_path(value: &str) -> bool {
    std::path::Path::new(value).is_absolute()
}

/// Canonicalize without leaking Windows verbatim prefixes (`\\?\`) into
/// persisted paths or IPC. Node's realpath returns the plain drive path, so
/// the Rust adapter must match it for cross-language path comparisons.
pub fn canonicalize(path: impl AsRef<std::path::Path>) -> std::io::Result<std::path::PathBuf> {
    let canonical = std::fs::canonicalize(path.as_ref())?;
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(std::path::PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(std::path::PathBuf::from(rest));
        }
    }
    Ok(canonical)
}
