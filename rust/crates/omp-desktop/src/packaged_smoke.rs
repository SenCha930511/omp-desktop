use std::io;
use std::path::Path;

pub const PACKAGED_SMOKE_EVENT: &str = "gooeypi-packaged-smoke-ready";
pub const MAX_MARKER_BYTES: usize = 4_096;

/// Writes the packaged-smoke marker only after the real GPUI window has drawn
/// its first frame. The Electron version wrote it after an authorized IPC
/// round trip; the native version must prove the window exists and painted.
pub fn write_marker(path: &Path, url: &str, version: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let marker = serde_json::json!({
        "event": PACKAGED_SMOKE_EVENT,
        "url": url,
        "version": version,
        "renderedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    let serialized = serde_json::to_vec(&marker)?;
    if serialized.len() > MAX_MARKER_BYTES {
        return Err(io::Error::other(
            "packaged-smoke marker exceeds its size limit",
        ));
    }
    std::fs::write(path, serialized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_has_the_expected_event_and_stays_bounded() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let path = dir.path().join("smoke-ready.json");
        write_marker(&path, "omp-desktop://app/index.html", "2.0.0").expect("write marker");
        let raw = std::fs::read_to_string(&path).expect("read marker");
        assert!(raw.len() <= MAX_MARKER_BYTES);
        let value: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(value["event"], PACKAGED_SMOKE_EVENT);
        assert_eq!(value["url"], "omp-desktop://app/index.html");
        assert_eq!(value["version"], "2.0.0");
    }
}
