use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{CoreError, Result};
use crate::state::StateStore;

const MAX_SESSION_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 100;
const MAX_PREVIEW_CHARS: usize = 160;
const MAX_TEXT_CHARS: usize = 1024 * 1024;
const MAX_TOOL_CHARS: usize = 512 * 1024;
const MAX_ARGS_CHARS: usize = 128 * 1024;
const MAX_IMAGE_CHARS: usize = 24 * 1024 * 1024;
const MAX_PARTS_PER_RECORD: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub harness: String,
    pub file_path: String,
    pub project_path: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_user_message_at: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    pub depth: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub last_user_texts: Vec<String>,
    pub pinned: bool,
    pub unread: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPart {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

impl TranscriptPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            kind: "text".to_string(),
            text: Some(text.into()),
            id: None,
            name: None,
            args: None,
            mime_type: None,
            data: None,
            is_error: None,
            status: None,
            tokens_before: None,
            tokens_after: None,
            summary: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    pub id: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    pub parts: Vec<TranscriptPart>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub kind: String,
    pub revision: u64,
    pub records: Vec<SessionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDelta {
    pub kind: String,
    pub base_revision: u64,
    pub revision: u64,
    pub upserts: Vec<SessionRecord>,
    pub removals: Vec<String>,
}

pub fn session_root(home: &Path) -> PathBuf {
    home.join(".omp").join("agent").join("sessions")
}

fn compact_text(value: &str, max: usize) -> String {
    let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > max {
        let mut truncated: String = one_line.chars().take(max.saturating_sub(1)).collect();
        truncated.push('…');
        truncated
    } else {
        one_line
    }
}

fn bounded(value: &str, max: usize) -> String {
    if value.chars().count() > max {
        value.chars().take(max).collect()
    } else {
        value.to_string()
    }
}

fn timestamp_from_name(path: &Path) -> Option<DateTime<Utc>> {
    let name = path.file_name()?.to_str()?;
    let (prefix, _) = name.split_once('_')?;
    let normalized = prefix.replace('-', "");
    if normalized.len() < 15 {
        return None;
    }
    let year = normalized.get(0..4)?;
    let month = normalized.get(4..6)?;
    let day = normalized.get(6..8)?;
    let hour = normalized.get(9..11)?;
    let minute = normalized.get(11..13)?;
    let second = normalized.get(13..15)?;
    let millis = normalized.get(16..19).unwrap_or("000");
    let text = format!("{year}-{month}-{day}T{hour}:{minute}:{second}.{millis}Z");
    DateTime::parse_from_rfc3339(&text)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn id_from_file_name(path: &Path) -> String {
    let base = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    base.split_once('_')
        .map(|(_, id)| id.to_string())
        .unwrap_or_else(|| base.to_string())
}

fn text_from_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(value) if value.is_object() => serde_json::to_string(value).unwrap_or_default(),
        _ => String::new(),
    }
}

#[derive(Default)]
struct MetadataAccumulator {
    id: String,
    project_path: String,
    created_at: Option<String>,
    updated_at: Option<String>,
    last_user_message_at: Option<String>,
    title: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    thinking_level: Option<String>,
    parent_session: Option<String>,
    first_user: String,
    preview: String,
    last_user_texts: Vec<String>,
    last_role: Option<String>,
    stop_reason: Option<String>,
}

fn parse_metadata(path: &Path) -> Option<SessionRecord> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_SESSION_FILE_BYTES {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let mut state = MetadataAccumulator {
        id: id_from_file_name(path),
        created_at: timestamp_from_name(path)
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        updated_at: None,
        ..Default::default()
    };
    let mut lines = raw.lines();
    if let Some(first) = lines.next()
        && let Ok(Value::Object(record)) = serde_json::from_str::<Value>(first)
        && record.get("type").and_then(Value::as_str) == Some("title")
    {
        if let Some(title) = record
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
        {
            state.title = Some(bounded(title, MAX_TITLE_CHARS));
        }
        if let Some(updated) = record.get("updatedAt").and_then(Value::as_str) {
            state.updated_at = Some(updated.to_string());
        }
    }
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let record_timestamp = record.get("timestamp").and_then(Value::as_str);
        if let Some(timestamp) = record_timestamp {
            state.updated_at = Some(timestamp.to_string());
        }
        match record.get("type").and_then(Value::as_str) {
            Some("session") => {
                if let Some(id) = record.get("id").and_then(Value::as_str) {
                    state.id = id.to_string();
                }
                if let Some(cwd) = record.get("cwd").and_then(Value::as_str) {
                    state.project_path = cwd.to_string();
                }
                if let Some(timestamp) = record_timestamp {
                    state.created_at = Some(timestamp.to_string());
                }
                if let Some(parent) = record
                    .get("parentSession")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    state.parent_session = Some(parent.to_string());
                }
            }
            Some("model_change") => {
                if let Some(model) = record.get("model").and_then(Value::as_str) {
                    if let Some((provider, id)) = model.split_once('/') {
                        state.provider = Some(provider.to_string());
                        state.model = Some(id.to_string());
                    } else {
                        state.model = Some(model.to_string());
                    }
                }
            }
            Some("thinking_level_change") => {
                state.thinking_level = record
                    .get("configured")
                    .and_then(Value::as_str)
                    .or_else(|| record.get("thinkingLevel").and_then(Value::as_str))
                    .map(str::to_string);
            }
            Some("message") => {
                let Some(message) = record.get("message").and_then(Value::as_object) else {
                    continue;
                };
                let role = message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !role.is_empty() {
                    state.last_role = Some(role.clone());
                }
                if let Some(stop) = message.get("stopReason").and_then(Value::as_str) {
                    state.stop_reason = Some(stop.to_string());
                }
                let text = text_from_content(message.get("content"));
                if role == "user" {
                    if state.first_user.is_empty() && !text.is_empty() {
                        state.first_user = text.clone();
                    }
                    if !text.is_empty() {
                        state.last_user_texts.push(bounded(&text, 4_096));
                        if state.last_user_texts.len() > 3 {
                            state.last_user_texts.remove(0);
                        }
                    }
                    if let Some(timestamp) = message
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .or(record_timestamp)
                    {
                        state.last_user_message_at = Some(timestamp.to_string());
                    }
                }
                if (role == "assistant" || role == "user") && !text.is_empty() {
                    state.preview = bounded(&text, 4_096);
                }
            }
            _ => {}
        }
    }
    let created_at = state
        .created_at
        .clone()
        .or_else(|| {
            metadata.created().ok().map(|time| {
                DateTime::<Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
        })
        .unwrap_or_else(|| Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let updated_at = state
        .updated_at
        .clone()
        .or_else(|| {
            metadata.modified().ok().map(|time| {
                DateTime::<Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
        })
        .unwrap_or_else(|| created_at.clone());
    let title = state
        .title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            (!state.first_user.is_empty()).then(|| compact_text(&state.first_user, MAX_TITLE_CHARS))
        })
        .unwrap_or_else(|| "Untitled session".to_string());
    let status = match state.last_role.as_deref() {
        Some("assistant") | Some("toolResult") => "complete",
        Some("user") => "idle",
        _ if state.stop_reason.as_deref() == Some("error") => "failed",
        _ => "unknown",
    };
    Some(SessionRecord {
        id: state.id,
        harness: "omp".to_string(),
        file_path: path.display().to_string(),
        project_path: state.project_path,
        title,
        created_at,
        updated_at,
        last_user_message_at: state.last_user_message_at,
        status: status.to_string(),
        model: state.model,
        provider: state.provider,
        thinking_level: state.thinking_level,
        depth: 0,
        parent_session: state.parent_session,
        last_user_texts: state.last_user_texts,
        pinned: false,
        unread: false,
        preview: (!state.preview.is_empty())
            .then(|| compact_text(&state.preview, MAX_PREVIEW_CHARS)),
        archived: false,
    })
}

pub fn scan_sessions(store: &StateStore, home: &Path) -> Vec<SessionRecord> {
    let root = session_root(home);
    let archived: BTreeSet<PathBuf> = store
        .state()
        .archived_sessions
        .iter()
        .map(|path| fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)))
        .collect();
    let pinned: BTreeSet<PathBuf> = store
        .state()
        .pinned_sessions
        .iter()
        .map(|path| fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)))
        .collect();
    let mut records = Vec::new();
    let Ok(buckets) = fs::read_dir(&root) else {
        return records;
    };
    for bucket in buckets.flatten() {
        if !bucket
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(files) = fs::read_dir(bucket.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let name = file.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") || name.starts_with('.') {
                continue;
            }
            let Ok(file_type) = file.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let Some(mut record) = parse_metadata(&path) else {
                continue;
            };
            let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            record.archived = archived.contains(&canonical);
            record.pinned = pinned.contains(&canonical);
            records.push(record);
        }
    }
    records.sort_by(|left, right| {
        let left_key = left
            .last_user_message_at
            .as_deref()
            .unwrap_or(&left.created_at);
        let right_key = right
            .last_user_message_at
            .as_deref()
            .unwrap_or(&right.created_at);
        right_key
            .cmp(left_key)
            .then_with(|| left.file_path.cmp(&right.file_path))
    });
    records
}

pub fn list_sessions(
    store: &StateStore,
    home: &Path,
    include_archived: bool,
    project_path: Option<&str>,
) -> Vec<SessionRecord> {
    let project =
        project_path.map(|path| fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)));
    scan_sessions(store, home)
        .into_iter()
        .filter(|record| include_archived || !record.archived)
        .filter(|record| match &project {
            Some(project) => fs::canonicalize(&record.project_path)
                .map(|path| &path == project)
                .unwrap_or(false),
            None => true,
        })
        .collect()
}

pub fn set_pinned(
    store: &mut StateStore,
    root: &Path,
    file_path: &str,
    pinned: bool,
) -> Result<()> {
    let safe = authorize_session_path_under(root, Path::new(file_path))?;
    let canonical = safe.display().to_string();
    store.update(|state| {
        state.pinned_sessions.retain(|path| {
            fs::canonicalize(path)
                .map(|path| path != safe)
                .unwrap_or(true)
        });
        if pinned {
            state.pinned_sessions.push(canonical);
        }
        Ok(())
    })
}

pub fn set_archived(
    store: &mut StateStore,
    root: &Path,
    file_path: &str,
    archived: bool,
) -> Result<bool> {
    let safe = authorize_session_path_under(root, Path::new(file_path))?;
    let canonical = safe.display().to_string();
    store.update(|state| {
        state.archived_sessions.retain(|path| {
            fs::canonicalize(path)
                .map(|path| path != safe)
                .unwrap_or(true)
        });
        if archived {
            state.archived_sessions.push(canonical);
        }
        Ok(())
    })?;
    Ok(true)
}

pub fn delete_session(store: &mut StateStore, root: &Path, file_path: &str) -> Result<bool> {
    let safe = authorize_session_path_under(root, Path::new(file_path))?;
    fs::remove_file(&safe)
        .map_err(|error| CoreError::io("Could not delete the session file", error))?;
    store.update(|state| {
        state.archived_sessions.retain(|path| {
            fs::canonicalize(path)
                .map(|path| path != safe)
                .unwrap_or(true)
        });
        Ok(())
    })?;
    Ok(true)
}

pub fn authorize_session_path_under(root: &Path, path: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(root).map_err(|error| {
        CoreError::invalid(format!("Session directory is unavailable: {error}"))
    })?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| CoreError::invalid(format!("Session file is unavailable: {error}")))?;
    let relative = canonical
        .strip_prefix(&root)
        .map_err(|_| CoreError::invalid("Session path is outside the OMP session directory"))?;
    let components: Vec<Component> = relative.components().collect();
    if components.len() != 2 || !canonical.to_string_lossy().ends_with(".jsonl") {
        return Err(CoreError::invalid(
            "Session path is outside the OMP session directory",
        ));
    }
    Ok(canonical)
}

pub fn read_transcript(root: &Path, file_path: &str) -> Result<Vec<TranscriptMessage>> {
    const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;
    const MAX_MESSAGES: usize = 400;
    let safe = authorize_session_path_under(root, Path::new(file_path))?;
    let metadata = fs::metadata(&safe)
        .map_err(|error| CoreError::io("Could not inspect the session file", error))?;
    if metadata.len() > MAX_SESSION_FILE_BYTES {
        return Err(CoreError::invalid(
            "Session transcript is too large to display",
        ));
    }
    let raw = fs::read_to_string(&safe)
        .map_err(|error| CoreError::io("Could not read the session file", error))?;
    let mut messages = Vec::new();
    for line in raw.lines().skip(1) {
        if messages.len() >= MAX_MESSAGES {
            break;
        }
        if line.len() > MAX_RECORD_BYTES {
            return Err(CoreError::invalid("Session record is too large to display"));
        }
        if line.trim().is_empty() {
            continue;
        }
        let Ok(Value::Object(entry)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("entry")
            .to_string();
        let timestamp = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        match entry.get("type").and_then(Value::as_str) {
            Some("message") => {
                let Some(message) = entry.get("message").and_then(Value::as_object) else {
                    continue;
                };
                let role = match message.get("role").and_then(Value::as_str) {
                    Some("user") => "user",
                    Some("assistant") => "assistant",
                    Some("system") => "system",
                    _ => "tool",
                };
                let parts = parts_from_message(message);
                messages.push(TranscriptMessage {
                    id,
                    role: role.to_string(),
                    timestamp,
                    agent_name: None,
                    parts,
                });
            }
            Some("compaction") => {
                let part = TranscriptPart {
                    kind: "compaction".to_string(),
                    text: None,
                    id: None,
                    name: None,
                    args: None,
                    mime_type: None,
                    data: None,
                    is_error: None,
                    status: Some("done".to_string()),
                    tokens_before: entry.get("tokensBefore").and_then(Value::as_u64),
                    tokens_after: entry.get("tokensAfter").and_then(Value::as_u64),
                    summary: entry
                        .get("summary")
                        .and_then(Value::as_str)
                        .map(|text| bounded(text, MAX_TEXT_CHARS)),
                };
                messages.push(TranscriptMessage {
                    id,
                    role: "system".to_string(),
                    timestamp,
                    agent_name: None,
                    parts: vec![part],
                });
            }
            Some("custom_message") => {
                if entry.get("display").and_then(Value::as_bool) != Some(true) {
                    continue;
                }
                let details = entry.get("details").and_then(Value::as_object);
                let custom_type = entry
                    .get("customType")
                    .and_then(Value::as_str)
                    .unwrap_or("activity");
                if custom_type == "agent_message" {
                    let text = details
                        .and_then(|details| details.get("message"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| text_from_content(entry.get("content")));
                    let agent_name = details
                        .and_then(|details| details.get("from"))
                        .and_then(Value::as_object)
                        .and_then(|from| from.get("sessionName"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    messages.push(TranscriptMessage {
                        id,
                        role: "agent".to_string(),
                        timestamp,
                        agent_name,
                        parts: vec![TranscriptPart {
                            kind: "text".to_string(),
                            text: Some(bounded(&text, MAX_TEXT_CHARS)),
                            ..empty_part()
                        }],
                    });
                } else {
                    let text = details
                        .and_then(|details| details.get("message"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| text_from_content(entry.get("content")));
                    messages.push(TranscriptMessage {
                        id: id.clone(),
                        role: "tool".to_string(),
                        timestamp,
                        agent_name: None,
                        parts: vec![
                            TranscriptPart {
                                kind: "toolCall".to_string(),
                                id: Some(id),
                                name: Some(custom_type.to_string()),
                                ..empty_part()
                            },
                            TranscriptPart {
                                kind: "toolResult".to_string(),
                                name: Some(custom_type.to_string()),
                                text: Some(bounded(&text, MAX_TOOL_CHARS)),
                                ..empty_part()
                            },
                        ],
                    });
                }
            }
            _ => {}
        }
    }
    Ok(messages)
}

fn empty_part() -> TranscriptPart {
    TranscriptPart {
        kind: String::new(),
        text: None,
        id: None,
        name: None,
        args: None,
        mime_type: None,
        data: None,
        is_error: None,
        status: None,
        tokens_before: None,
        tokens_after: None,
        summary: None,
    }
}

fn parts_from_message(message: &Map<String, Value>) -> Vec<TranscriptPart> {
    let mut parts = Vec::new();
    match message.get("content") {
        Some(Value::String(text)) => parts.push(TranscriptPart {
            kind: "text".to_string(),
            text: Some(bounded(text, MAX_TEXT_CHARS)),
            ..empty_part()
        }),
        Some(Value::Array(items)) => {
            let selected: Vec<&Value> = if items.len() > MAX_PARTS_PER_RECORD {
                items
                    .iter()
                    .take(20)
                    .chain(
                        items
                            .iter()
                            .skip(items.len().saturating_sub(MAX_PARTS_PER_RECORD - 20)),
                    )
                    .collect()
            } else {
                items.iter().collect()
            };
            for raw in selected {
                let Some(block) = raw.as_object() else {
                    continue;
                };
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            parts.push(TranscriptPart {
                                kind: "text".to_string(),
                                text: Some(bounded(text, MAX_TEXT_CHARS)),
                                ..empty_part()
                            });
                        }
                    }
                    Some("thinking") => {
                        if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                            parts.push(TranscriptPart {
                                kind: "thinking".to_string(),
                                text: Some(bounded(text, MAX_TEXT_CHARS)),
                                ..empty_part()
                            });
                        }
                    }
                    Some("toolCall") | Some("tool_call") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let args = block
                            .get("arguments")
                            .or_else(|| block.get("args"))
                            .cloned();
                        let args = args.map(|value| {
                            let serialized = value.to_string();
                            if serialized.len() > MAX_ARGS_CHARS {
                                Value::String(bounded(&serialized, MAX_ARGS_CHARS))
                            } else {
                                value
                            }
                        });
                        parts.push(TranscriptPart {
                            kind: "toolCall".to_string(),
                            id: block
                                .get("id")
                                .and_then(Value::as_str)
                                .map(|id| bounded(id, 1_024)),
                            name: Some(bounded(name, 512)),
                            args,
                            ..empty_part()
                        });
                    }
                    Some("image") => {
                        let data = block.get("data").and_then(Value::as_str);
                        parts.push(TranscriptPart {
                            kind: "image".to_string(),
                            mime_type: block
                                .get("mimeType")
                                .and_then(Value::as_str)
                                .map(|value| bounded(value, 128)),
                            data: data.map(|value| bounded(value, MAX_IMAGE_CHARS)),
                            ..empty_part()
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    if message.get("role").and_then(Value::as_str) == Some("toolResult") {
        let text = parts
            .iter()
            .filter(|part| part.kind == "text")
            .filter_map(|part| part.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        let kept: Vec<TranscriptPart> = parts
            .into_iter()
            .filter(|part| part.kind == "image")
            .collect();
        let mut result = vec![TranscriptPart {
            kind: "toolResult".to_string(),
            name: message
                .get("toolName")
                .and_then(Value::as_str)
                .map(|value| bounded(value, 512)),
            text: Some(bounded(&text, MAX_TOOL_CHARS)),
            is_error: message.get("isError").and_then(Value::as_bool),
            ..empty_part()
        }];
        result.extend(kept);
        return result;
    }
    parts
}

pub fn sync_snapshot(store: &StateStore, home: &Path) -> CatalogSnapshot {
    let records = list_sessions(store, home, true, None);
    CatalogSnapshot {
        kind: "snapshot".to_string(),
        revision: 1,
        records,
    }
}

pub fn sync_delta(
    store: &StateStore,
    home: &Path,
    revision: u64,
    previous: &[SessionRecord],
) -> CatalogDelta {
    let current = list_sessions(store, home, true, None);
    let previous_by_path: BTreeMap<&str, &SessionRecord> = previous
        .iter()
        .map(|record| (record.file_path.as_str(), record))
        .collect();
    let current_paths: BTreeSet<&str> = current
        .iter()
        .map(|record| record.file_path.as_str())
        .collect();
    let upserts: Vec<SessionRecord> = current
        .iter()
        .filter(|record| {
            previous_by_path
                .get(record.file_path.as_str())
                .map(|old| {
                    old.updated_at != record.updated_at
                        || old.title != record.title
                        || old.pinned != record.pinned
                        || old.archived != record.archived
                })
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    let removals: Vec<String> = previous
        .iter()
        .filter(|record| !current_paths.contains(record.file_path.as_str()))
        .map(|record| record.file_path.clone())
        .collect();
    CatalogDelta {
        kind: "delta".to_string(),
        base_revision: revision,
        revision: revision.saturating_add(1),
        upserts,
        removals,
    }
}
