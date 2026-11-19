use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::sessions::{SessionRecord, read_transcript, scan_sessions};
use crate::state::StateStore;

const BEGIN: &str = "===== BEGIN GOOEYPI AGENT MESSAGE =====";
const END: &str = "===== END GOOEYPI AGENT MESSAGE =====";
const KEY_BYTES: usize = 32;

pub fn load_or_create_key(path: &Path) -> Result<Vec<u8>> {
    if path.exists() {
        let bytes = fs::read(path).map_err(|error| {
            CoreError::io("Could not read the agent-message signing key", error)
        })?;
        if bytes.len() != KEY_BYTES {
            return Err(CoreError::new(
                "Error",
                "The OMP Desktop agent-message signing key is invalid",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        return Ok(bytes);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| CoreError::io("Could not create the signing-key directory", error))?;
    }
    let mut key = vec![0u8; KEY_BYTES];
    let uuid = Uuid::new_v4();
    key[..16].copy_from_slice(uuid.as_bytes());
    key[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(&key).map_err(|error| {
                CoreError::io("Could not create the agent-message signing key", error)
            })?;
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let bytes = fs::read(path).map_err(|error| {
                CoreError::io("Could not read the agent-message signing key", error)
            })?;
            if bytes.len() != KEY_BYTES {
                return Err(CoreError::new(
                    "Error",
                    "The OMP Desktop agent-message signing key is invalid",
                ));
            }
            Ok(bytes)
        }
        Err(error) => Err(CoreError::io(
            "Could not create the agent-message signing key",
            error,
        )),
    }
}

fn signature(key: &[u8], metadata: &Value, text: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    let serialized = serde_json::to_string(metadata).expect("metadata serializes");
    mac.update(serialized.as_bytes());
    mac.update(b"\0");
    mac.update(text.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

pub fn encode(key: &[u8], from_session_id: &str, text: &str) -> Result<String> {
    let unsigned = json!({
        "version": 3,
        "from_session_id": from_session_id,
        "reply_with": "gooeypi_session_send",
        "nonce": Uuid::new_v4().to_string(),
        "sent_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    let signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature(key, &unsigned, text));
    let mut metadata = unsigned.as_object().expect("object").clone();
    metadata.insert("signature".to_string(), Value::String(signature));
    Ok(format!(
        "{BEGIN}\n{}\n{END}\n\n{text}",
        Value::Object(metadata)
    ))
}

pub fn verify(key: &[u8], value: &str) -> Option<Value> {
    let rest = value.strip_prefix(&format!("{BEGIN}\n"))?;
    let metadata_end = rest.find(&format!("\n{END}\n"))?;
    let metadata: Value = serde_json::from_str(&rest[..metadata_end]).ok()?;
    let object = metadata.as_object()?;
    let version = object.get("version").and_then(Value::as_u64)?;
    if !(1..=3).contains(&version) {
        return None;
    }
    let from_session_id = object.get("from_session_id").and_then(Value::as_str)?;
    if from_session_id.is_empty() || from_session_id.len() > 128 {
        return None;
    }
    let nonce = object.get("nonce").and_then(Value::as_str)?;
    if !valid_uuid_v4(nonce) {
        return None;
    }
    let sent_at = object.get("sent_at").and_then(Value::as_str)?;
    if sent_at.len() > 64 || chrono::DateTime::parse_from_rfc3339(sent_at).is_err() {
        return None;
    }
    let encoded_signature = object.get("signature").and_then(Value::as_str)?;
    if encoded_signature.len() != 43
        || !encoded_signature
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }
    let text = rest[metadata_end + END.len() + 2..]
        .strip_prefix('\n')
        .unwrap_or(&rest[metadata_end + END.len() + 2..]);
    if text.is_empty() {
        return None;
    }
    let unsigned = match version {
        1 => {
            let from_title = object.get("from_title").and_then(Value::as_str)?;
            let from_harness = object.get("from_harness").and_then(Value::as_str)?;
            if from_title.is_empty()
                || from_title.len() > 200
                || !["prime", "omp", "pi"].contains(&from_harness)
            {
                return None;
            }
            let reply_with = object.get("reply_with");
            if reply_with.is_some() && reply_with.and_then(Value::as_str) != Some("session_send") {
                return None;
            }
            let mut metadata = serde_json::Map::new();
            metadata.insert("version".to_string(), json!(1));
            metadata.insert("from_session_id".to_string(), json!(from_session_id));
            metadata.insert("from_title".to_string(), json!(from_title));
            metadata.insert("from_harness".to_string(), json!(from_harness));
            if reply_with.is_some() {
                metadata.insert("reply_with".to_string(), json!("session_send"));
            }
            metadata.insert("nonce".to_string(), json!(nonce));
            metadata.insert("sent_at".to_string(), json!(sent_at));
            Value::Object(metadata)
        }
        2 => {
            if object.get("reply_with").and_then(Value::as_str) != Some("session_send") {
                return None;
            }
            json!({
                "version": 2,
                "from_session_id": from_session_id,
                "reply_with": "session_send",
                "nonce": nonce,
                "sent_at": sent_at,
            })
        }
        _ => {
            if object.get("reply_with").and_then(Value::as_str) != Some("gooeypi_session_send") {
                return None;
            }
            json!({
                "version": 3,
                "from_session_id": from_session_id,
                "reply_with": "gooeypi_session_send",
                "nonce": nonce,
                "sent_at": sent_at,
            })
        }
    };
    let actual = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .ok()?;
    let expected = signature(key, &unsigned, text);
    if actual.len() != expected.len() || actual.ct_eq(&expected).unwrap_u8() != 1 {
        return None;
    }
    Some(json!({ "fromSessionId": from_session_id, "text": text }))
}

fn valid_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let positions = [8, 13, 18, 23];
    for (index, byte) in bytes.iter().enumerate() {
        if positions.contains(&index) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    bytes[14] == b'4' && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

pub fn key_path(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join("agent-message-signing.key")
}

pub fn peer_sessions(
    store: &StateStore,
    home: &Path,
    cwd: &Path,
    source_session: Option<&Path>,
) -> Vec<SessionRecord> {
    let canonical_cwd = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let source =
        source_session.map(|path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()));
    scan_sessions(store, home)
        .into_iter()
        .filter(|record| {
            let project = fs::canonicalize(&record.project_path)
                .unwrap_or_else(|_| PathBuf::from(&record.project_path));
            if project != canonical_cwd {
                return false;
            }
            match &source {
                Some(source) => fs::canonicalize(&record.file_path)
                    .map(|path| path != *source)
                    .unwrap_or(true),
                None => true,
            }
        })
        .collect()
}

pub fn peer_messages(home: &Path, record: &SessionRecord) -> Result<Value> {
    let root = crate::sessions::session_root(home);
    let transcript = read_transcript(&root, &record.file_path)?;
    let messages: Vec<Value> = transcript
        .iter()
        .filter(|message| message.role == "user" || message.role == "assistant")
        .map(|message| {
            let text = message
                .parts
                .iter()
                .filter(|part| part.kind == "text")
                .filter_map(|part| part.text.as_deref())
                .collect::<Vec<_>>()
                .join("\n");
            json!({ "role": message.role, "text": text })
        })
        .collect();
    Ok(json!({ "cursor": format!("{}", messages.len()), "messages": messages }))
}
