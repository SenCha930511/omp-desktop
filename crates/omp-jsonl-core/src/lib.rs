use chrono::{DateTime, Datelike, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Map, Value};
use std::alloc::{alloc as rust_alloc, dealloc as rust_dealloc, Layout};
use std::cell::RefCell;
use std::slice;

const MAX_RECORDS: usize = 200_000;
const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 4_096;
const MAX_LINEAGE_CHARS: usize = 4_096;
const MAX_PREVIOUS_FILES: usize = 32;
const TRUNCATION_MARKER: &str = "\n… [truncated] …\n";
const MAX_DATE_MS: f64 = 8.64e15;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    unsafe {
        let layout = Layout::from_size_align_unchecked(len, 1);
        rust_alloc(layout)
    }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    unsafe {
        let layout = Layout::from_size_align_unchecked(len, 1);
        rust_dealloc(ptr, layout);
    }
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|result| result.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    RESULT.with(|result| result.borrow().len())
}

#[no_mangle]
pub extern "C" fn clear_result() {
    RESULT.with(|result| result.borrow_mut().clear());
}

fn set_result(value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"status\":\"fallback\",\"reason\":\"serialize\"}".to_vec());
    RESULT.with(|result| *result.borrow_mut() = bytes);
}

fn fallback(reason: &str) -> Value {
    json!({ "status": "fallback", "reason": reason })
}

fn error(reason: &str) -> Value {
    json!({ "status": "error", "reason": reason })
}

fn string_arg(ptr: *const u8, len: usize) -> Option<String> {
    if len == 0 {
        return Some(String::new());
    }
    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

#[no_mangle]
pub extern "C" fn scan(
    bytes_ptr: *const u8,
    bytes_len: usize,
    id_ptr: *const u8,
    id_len: usize,
    created_ptr: *const u8,
    created_len: usize,
    updated_ptr: *const u8,
    updated_len: usize,
    title_slot_len: usize,
) -> usize {
    let bytes = unsafe { slice::from_raw_parts(bytes_ptr, bytes_len) };
    let Some(id) = string_arg(id_ptr, id_len) else {
        set_result(fallback("id"));
        return result_len();
    };
    let Some(created_at) = string_arg(created_ptr, created_len) else {
        set_result(fallback("created"));
        return result_len();
    };
    let Some(updated_at) = string_arg(updated_ptr, updated_len) else {
        set_result(fallback("updated"));
        return result_len();
    };
    set_result(scan_inner(bytes, id, created_at, updated_at, title_slot_len));
    result_len()
}

struct Accumulator {
    id: String,
    project_path: String,
    created_at: String,
    updated_at: String,
    saw_record_timestamp: bool,
    last_user_message_at: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    thinking_level: Option<String>,
    display_name: Option<String>,
    parent_session: Option<String>,
    previous_session_files: Vec<String>,
    first_user: String,
    preview: String,
    last_user_texts: Vec<String>,
    last_role: Option<String>,
    stop_reason: Option<String>,
    records: usize,
}

fn scan_inner(bytes: &[u8], id: String, created_at: String, updated_at: String, title_slot_len: usize) -> Value {
    let mut state = Accumulator {
        id,
        project_path: String::new(),
        created_at,
        updated_at,
        saw_record_timestamp: false,
        last_user_message_at: None,
        model: None,
        provider: None,
        thinking_level: None,
        display_name: None,
        parent_session: None,
        previous_session_files: Vec::new(),
        first_user: String::new(),
        preview: String::new(),
        last_user_texts: Vec::new(),
        last_role: None,
        stop_reason: None,
        records: 0,
    };

    let mut record_start = 0;
    let mut title_slot_title: Option<String> = None;
    if title_slot_len > 0 {
        record_start = title_slot_len.min(bytes.len());
        let slot = &bytes[..record_start];
        if let Some(newline) = slot.iter().position(|byte| *byte == b'\n') {
            let line = slot[..newline].strip_suffix(b"\r").unwrap_or(&slot[..newline]);
            if let Ok(text) = std::str::from_utf8(line) {
                if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text) {
                    if object.get("type").and_then(Value::as_str) == Some("title") {
                        if let Some(title) = object.get("title").and_then(Value::as_str) {
                            if !is_blank(title) {
                                title_slot_title = Some(title.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    for raw_line in bytes[record_start..].split(|byte| *byte == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_RECORD_BYTES {
            return error("record-too-large");
        }
        state.records += 1;
        if state.records > MAX_RECORDS {
            return error("too-many-records");
        }
        let Ok(text) = std::str::from_utf8(line) else {
            return fallback("utf8");
        };
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        let Some(object) = value.as_object() else {
            continue;
        };
        if let Some(timestamp) = object.get("timestamp") {
            match valid_timestamp(timestamp) {
                Ok(Some(parsed)) => {
                    state.updated_at = parsed;
                    state.saw_record_timestamp = true;
                }
                Ok(None) => {}
                Err(()) => return fallback("timestamp"),
            }
        }
        let record_type = object.get("type").and_then(Value::as_str);
        match record_type {
            Some("session") => {
                if let Err(reason) = ingest_session(&mut state, object) {
                    return fallback(reason);
                }
            }
            Some("thinking_level_change") => ingest_thinking_level(&mut state, object),
            Some("message") => {
                if let Err(reason) = ingest_message(&mut state, object) {
                    return fallback(reason);
                }
            }
            Some("model_change") => ingest_model_change(&mut state, object),
            Some("title_change") | Some("title") => {
                if let Some(title) = object.get("title").and_then(Value::as_str) {
                    state.display_name = Some(title.to_string());
                }
            }
            _ => {}
        }
    }

    if let Some(title) = title_slot_title {
        state.display_name = Some(title);
    }

    json!({
        "status": "ok",
        "accumulator": {
            "id": state.id,
            "projectPath": state.project_path,
            "createdAt": state.created_at,
            "updatedAt": state.updated_at,
            "sawRecordTimestamp": state.saw_record_timestamp,
            "lastUserMessageAt": state.last_user_message_at,
            "model": state.model,
            "provider": state.provider,
            "thinkingLevel": state.thinking_level,
            "displayName": state.display_name,
            "parentSession": state.parent_session,
            "previousSessionFiles": state.previous_session_files,
            "firstUser": state.first_user,
            "preview": state.preview,
            "lastUserTexts": state.last_user_texts,
            "lastRole": state.last_role,
            "stopReason": state.stop_reason,
            "records": state.records
        }
    })
}

fn ingest_session(state: &mut Accumulator, object: &Map<String, Value>) -> Result<(), &'static str> {
    if let Some(id) = object.get("id").and_then(Value::as_str) {
        state.id = id.to_string();
    }
    if let Some(cwd) = object.get("cwd").and_then(Value::as_str) {
        state.project_path = cwd.to_string();
    }
    if let Some(timestamp) = object.get("timestamp") {
        match valid_timestamp(timestamp) {
            Ok(Some(parsed)) => state.created_at = parsed,
            Ok(None) => {}
            Err(()) => return Err("timestamp"),
        }
    }
    if let Some(parent) = object.get("parentSession").and_then(Value::as_str) {
        if !parent.is_empty() && utf16_len(parent) <= MAX_LINEAGE_CHARS {
            state.parent_session = Some(parent.to_string());
        }
    }
    if let Some(previous) = object.get("previousSessionFiles").and_then(Value::as_array) {
        for raw in previous {
            let Some(value) = raw.as_str() else {
                continue;
            };
            if value.is_empty() || utf16_len(value) > MAX_LINEAGE_CHARS {
                continue;
            }
            if state.previous_session_files.len() >= MAX_PREVIOUS_FILES {
                break;
            }
            if !state.previous_session_files.iter().any(|existing| existing == value) {
                state.previous_session_files.push(value.to_string());
            }
        }
    }
    Ok(())
}

fn ingest_thinking_level(state: &mut Accumulator, object: &Map<String, Value>) {
    let configured_auto = object.get("configured").and_then(Value::as_str) == Some("auto");
    if configured_auto {
        state.thinking_level = Some("auto".to_string());
    } else if let Some(level) = object.get("thinkingLevel").and_then(Value::as_str) {
        state.thinking_level = Some(level.to_string());
    }
}

fn ingest_model_change(state: &mut Accumulator, object: &Map<String, Value>) {
    let role = object.get("role").and_then(Value::as_str);
    if role.is_some() && role != Some("default") {
        return;
    }
    let Some(model) = object.get("model").and_then(Value::as_str) else {
        return;
    };
    if let Some(separator) = model.find('/') {
        if separator > 0 {
            state.provider = Some(model[..separator].to_string());
            state.model = Some(model[separator + 1..].to_string());
            return;
        }
    }
    state.provider = None;
    state.model = Some(model.to_string());
}

fn ingest_message(state: &mut Accumulator, record: &Map<String, Value>) -> Result<(), &'static str> {
    let Some(message) = record.get("message").and_then(Value::as_object) else {
        return Ok(());
    };
    let role = message.get("role").and_then(Value::as_str);
    if let Some(role) = role {
        state.last_role = Some(role.to_string());
    }
    if let Some(stop_reason) = message.get("stopReason").and_then(Value::as_str) {
        state.stop_reason = Some(stop_reason.to_string());
    }
    let content = message.get("content").unwrap_or(&Value::Null);
    let text = text_from_content(content)?;
    if role == Some("user") {
        if state.first_user.is_empty() && !text.is_empty() {
            state.first_user = text.clone();
        }
        if !text.is_empty() {
            state.last_user_texts.push(text.clone());
            if state.last_user_texts.len() > 3 {
                state.last_user_texts.remove(0);
            }
        }
        let message_timestamp = match message.get("timestamp") {
            Some(value) => valid_timestamp(value).map_err(|_| "timestamp")?,
            None => None,
        };
        let record_timestamp = match record.get("timestamp") {
            Some(value) => valid_timestamp(value).map_err(|_| "timestamp")?,
            None => None,
        };
        let fallback = state.last_user_message_at.clone().unwrap_or_else(|| state.created_at.clone());
        state.last_user_message_at = Some(message_timestamp.or(record_timestamp).unwrap_or(fallback));
    }
    if (role == Some("assistant") || role == Some("user")) && !text.is_empty() {
        state.preview = text;
    }
    Ok(())
}

fn is_blank(value: &str) -> bool {
    value.chars().all(|character| character.is_whitespace() || character == '\u{FEFF}')
}

fn valid_timestamp(value: &Value) -> Result<Option<String>, ()> {
    if let Some(number) = value.as_f64() {
        if !number.is_finite() || number.abs() > MAX_DATE_MS {
            return Ok(None);
        }
        let millis = number.trunc() as i64;
        let Some(date) = Utc.timestamp_millis_opt(millis).single() else {
            return Ok(None);
        };
        return Ok(Some(date.to_rfc3339_opts(SecondsFormat::Millis, true)));
    }
    if let Some(text) = value.as_str() {
        let Ok(date) = DateTime::parse_from_rfc3339(text) else {
            return Err(());
        };
        let utc = date.with_timezone(&Utc);
        if !(0..=9999).contains(&utc.year()) {
            return Err(());
        }
        return Ok(Some(utc.to_rfc3339_opts(SecondsFormat::Millis, true)));
    }
    Ok(None)
}

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

fn prefix_utf16(value: &str, units: usize) -> Option<String> {
    let mut used = 0;
    for (index, character) in value.char_indices() {
        let length = character.len_utf16();
        if used + length > units {
            return if used == units { Some(value[..index].to_string()) } else { None };
        }
        used += length;
    }
    Some(value.to_string())
}

fn suffix_utf16(value: &str, units: usize) -> Option<String> {
    let total = utf16_len(value);
    if units >= total {
        return Some(value.to_string());
    }
    let start = total - units;
    let mut used = 0;
    for (index, character) in value.char_indices() {
        let length = character.len_utf16();
        if used + length > start {
            return if used == start { Some(value[index..].to_string()) } else { None };
        }
        used += length;
    }
    Some(String::new())
}

fn bounded_string(value: &str, max: usize) -> Result<String, ()> {
    if max == 0 {
        return Ok(String::new());
    }
    let length = utf16_len(value);
    if length <= max {
        return Ok(value.to_string());
    }
    let marker_length = utf16_len(TRUNCATION_MARKER);
    if max <= marker_length {
        return suffix_utf16(value, max).ok_or(());
    }
    let available = max - marker_length;
    let head_units = available / 3;
    let tail_units = available - head_units;
    let head = prefix_utf16(value, head_units).ok_or(())?;
    let tail = suffix_utf16(value, tail_units).ok_or(())?;
    Ok(format!("{head}{TRUNCATION_MARKER}{tail}"))
}

fn text_from_content(content: &Value) -> Result<String, &'static str> {
    if let Some(text) = content.as_str() {
        return bounded_string(text, MAX_TEXT_CHARS).map_err(|_| "truncation");
    }
    let Some(parts) = content.as_array() else {
        return Ok(String::new());
    };
    let mut text = String::new();
    for part in parts {
        let Some(block) = part.as_object() else {
            continue;
        };
        let addition = match block.get("type").and_then(Value::as_str) {
            Some("text") => block.get("text").and_then(Value::as_str),
            Some("thinking") => block.get("thinking").and_then(Value::as_str),
            _ => None,
        };
        let Some(addition) = addition else {
            continue;
        };
        if addition.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(addition);
        if utf16_len(&text) > MAX_TEXT_CHARS {
            return bounded_string(&text, MAX_TEXT_CHARS).map_err(|_| "truncation");
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_by_utf16_units() {
        assert_eq!(bounded_string("abc", 4).unwrap(), "abc");
        assert_eq!(bounded_string("abcdef", 4).unwrap(), "cdef");
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(bounded_string("a😀bcdef", 4).unwrap(), "cdef");
        assert_eq!(bounded_string(&"a".repeat(30), 20).unwrap(), format!("a{}aa", TRUNCATION_MARKER));
    }

    #[test]
    fn parses_a_basic_session() {
        let bytes = br#"{"type":"session","id":"s1","cwd":"/p","timestamp":"2026-01-01T00:00:00.000Z"}
{"type":"message","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}
{"type":"message","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":"world","stopReason":"end"}}
"#;
        let value = scan_inner(bytes, "fallback".to_string(), "2026-01-01T00:00:00.000Z".to_string(), "2026-01-01T00:00:00.000Z".to_string(), 0);
        assert_eq!(value["status"], "ok");
        assert_eq!(value["accumulator"]["id"], "s1");
        assert_eq!(value["accumulator"]["firstUser"], "hello");
        assert_eq!(value["accumulator"]["preview"], "world");
    }
}
