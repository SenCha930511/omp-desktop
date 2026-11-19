use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::settings::AppSettings;

pub const CURRENT_DESKTOP_STATE_FILENAME: &str = "omp-desktop-state-v4.json";
pub const LEGACY_DESKTOP_STATE_FILENAME: &str = "omp-desktop-state.json";
pub const CURRENT_DESKTOP_STATE_VERSION: u32 = 4;
const MAX_STATE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVED_SESSIONS: usize = 5_000;
const MAX_PINNED_SESSIONS: usize = 500;
const MAX_DISMISSED_PROJECT_PATHS: usize = 1_024;
const MAX_SCHEDULES: usize = 500;
const WINDOWS_LEGACY_TOMBSTONE_KEY: &str = "gooeyPiV4Migration";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Macos,
    Linux,
    Windows,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }

    pub fn from_override(value: Option<&str>) -> Self {
        match value {
            Some("win32") => Self::Windows,
            Some("darwin") => Self::Macos,
            Some("linux") => Self::Linux,
            _ => Self::current(),
        }
    }

    pub fn is_windows(self) -> bool {
        self == Self::Windows
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "darwin",
            Self::Linux => "linux",
            Self::Windows => "win32",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIdentity {
    pub dev: String,
    pub ino: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub birthtime_ns: Option<String>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScripts {
    pub setup: String,
    pub run: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_last_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_last_exit_code: Option<i64>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedProject {
    pub id: String,
    pub harness: String,
    pub name: String,
    pub path: String,
    pub folders: Vec<String>,
    pub primary_folder: String,
    pub pinned: bool,
    pub created_at: String,
    pub last_opened_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_identities: Option<BTreeMap<String, FolderIdentity>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scripts: Option<ProjectScripts>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

impl ScheduleTarget {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTarget {
    pub kind: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTiming {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dtstart_local: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rrule: Option<String>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleExecution {
    pub model: String,
    pub thinking: String,
    pub speed: String,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunRecord {
    pub id: String,
    pub task_id: String,
    pub task_revision: u64,
    pub trigger: String,
    pub scheduled_for: String,
    pub queued_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub status: String,
    pub execution: ScheduleExecution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_count: Option<u64>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

impl AutomationScheduleRecord {
    pub fn target_project_id(&self) -> Option<&str> {
        Some(self.target.project_id())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationScheduleRecord {
    pub schema_version: u32,
    pub id: String,
    pub harness: String,
    pub revision: u64,
    pub title: String,
    pub prompt: String,
    pub target: ScheduleTarget,
    pub timing: ScheduleTiming,
    pub execution: ScheduleExecution,
    pub status: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    pub runs: Vec<ScheduleRunRecord>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub version: u32,
    pub projects: Vec<PersistedProject>,
    pub settings: AppSettings,
    pub archived_sessions: Vec<String>,
    pub pinned_sessions: Vec<String>,
    pub dismissed_project_paths: Vec<String>,
    pub schedules: Vec<AutomationScheduleRecord>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            version: CURRENT_DESKTOP_STATE_VERSION,
            projects: Vec::new(),
            settings: AppSettings::default(),
            archived_sessions: Vec::new(),
            pinned_sessions: Vec::new(),
            dismissed_project_paths: Vec::new(),
            schedules: Vec::new(),
            unknown: BTreeMap::new(),
        }
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn bounded_string(value: Option<&Value>, max: usize, allow_empty: bool) -> Option<String> {
    let text = value?.as_str()?;
    if text.chars().count() > max || (!allow_empty && text.trim().is_empty()) {
        return None;
    }
    Some(text.to_string())
}

fn valid_date(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text).ok()?;
    Some(text.to_string())
}

fn parse_harness(value: Option<&Value>, pre_harness: bool) -> Option<String> {
    match value {
        Some(Value::String(text)) if text == "omp" || text == "prime" || text == "pi" => {
            Some("omp".to_string())
        }
        None if pre_harness => Some("omp".to_string()),
        _ => None,
    }
}

fn unknown_fields(record: &Map<String, Value>, known: &[&str]) -> BTreeMap<String, Value> {
    record
        .iter()
        .filter(|(key, _)| !known.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn parse_project_scripts(value: Option<&Value>) -> Option<ProjectScripts> {
    let record = value?.as_object()?;
    let setup = bounded_string(record.get("setup"), 64 * 1024, true)
        .filter(|text| !text.contains('\0'))
        .unwrap_or_default();
    let run = bounded_string(record.get("run"), 64 * 1024, true)
        .filter(|text| !text.contains('\0'))
        .unwrap_or_default();
    let setup_last_exit_code = record
        .get("setupLastExitCode")
        .and_then(Value::as_i64)
        .filter(|code| (*code >= i32::MIN as i64) && (*code <= i32::MAX as i64));
    let setup_last_run = setup_last_exit_code
        .and_then(|_| bounded_string(record.get("setupLastRun"), 64 * 1024, true))
        .filter(|text| !text.contains('\0'));
    Some(ProjectScripts {
        setup,
        run,
        setup_last_run,
        setup_last_exit_code,
        unknown: unknown_fields(
            record,
            &["setup", "run", "setupLastRun", "setupLastExitCode"],
        ),
    })
}

fn parse_project(value: &Value, pre_harness: bool) -> Option<PersistedProject> {
    let record = value.as_object()?;
    let id = record.get("id")?.as_str()?;
    let name = record.get("name")?.as_str()?;
    let path = record.get("path")?.as_str()?;
    let folders: Vec<String> = match record.get("folders") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => vec![path.to_string()],
    };
    if folders.is_empty() {
        return None;
    }
    let primary_folder = record.get("primaryFolder")?.as_str()?.to_string();
    let harness = parse_harness(record.get("harness"), pre_harness)?;
    let now = now_iso();
    let mut folder_identities = BTreeMap::new();
    if let Some(Value::Object(identities)) = record.get("folderIdentities") {
        for (folder, identity) in identities {
            let Some(identity) = identity.as_object() else {
                continue;
            };
            let (Some(dev), Some(ino)) = (
                identity.get("dev").and_then(Value::as_str),
                identity.get("ino").and_then(Value::as_str),
            ) else {
                continue;
            };
            let birthtime_ns = identity
                .get("birthtimeNs")
                .and_then(Value::as_str)
                .filter(|text| {
                    !text.is_empty()
                        && text.len() <= 40
                        && text.chars().all(|ch| ch.is_ascii_digit())
                })
                .map(str::to_string);
            folder_identities.insert(
                folder.clone(),
                FolderIdentity {
                    dev: dev.to_string(),
                    ino: ino.to_string(),
                    birthtime_ns,
                    unknown: unknown_fields(identity, &["dev", "ino", "birthtimeNs"]),
                },
            );
        }
    }
    Some(PersistedProject {
        id: if id.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            id.to_string()
        },
        harness,
        name: name.to_string(),
        path: path.to_string(),
        folders,
        primary_folder,
        pinned: record
            .get("pinned")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        created_at: valid_date(record.get("createdAt")).unwrap_or_else(|| now.clone()),
        last_opened_at: valid_date(record.get("lastOpenedAt")).unwrap_or(now),
        folder_identities: if folder_identities.is_empty() {
            None
        } else {
            Some(folder_identities)
        },
        scripts: parse_project_scripts(record.get("scripts")),
        unknown: unknown_fields(
            record,
            &[
                "id",
                "harness",
                "name",
                "path",
                "folders",
                "primaryFolder",
                "pinned",
                "createdAt",
                "lastOpenedAt",
                "folderIdentities",
                "scripts",
            ],
        ),
    })
}

fn parse_schedule_target(value: &Value) -> Option<ScheduleTarget> {
    let record = value.as_object()?;
    let project_id = bounded_string(record.get("projectId"), 256, false)?;
    match record.get("kind").and_then(Value::as_str) {
        Some("project") => Some(ScheduleTarget {
            kind: "project".to_string(),
            project_id,
            session_id: None,
            unknown: unknown_fields(record, &["kind", "projectId"]),
        }),
        Some("session") => Some(ScheduleTarget {
            kind: "session".to_string(),
            project_id,
            session_id: Some(bounded_string(record.get("sessionId"), 256, false)?),
            unknown: unknown_fields(record, &["kind", "projectId", "sessionId"]),
        }),
        _ => None,
    }
}

fn parse_schedule_timing(value: &Value) -> Option<ScheduleTiming> {
    let record = value.as_object()?;
    match record.get("kind").and_then(Value::as_str) {
        Some("once") => Some(ScheduleTiming {
            kind: "once".to_string(),
            at: Some(valid_date(record.get("at"))?),
            dtstart_local: None,
            time_zone: None,
            rrule: None,
            unknown: unknown_fields(record, &["kind", "at"]),
        }),
        Some("rrule") => Some(ScheduleTiming {
            kind: "rrule".to_string(),
            at: None,
            dtstart_local: Some(bounded_string(record.get("dtstartLocal"), 64, false)?),
            time_zone: Some(bounded_string(record.get("timeZone"), 128, false)?),
            rrule: Some(bounded_string(record.get("rrule"), 2_048, false)?),
            unknown: unknown_fields(record, &["kind", "dtstartLocal", "timeZone", "rrule"]),
        }),
        _ => None,
    }
}

pub fn parse_schedule_execution(value: &Value) -> Option<ScheduleExecution> {
    let record = value.as_object()?;
    let model = bounded_string(record.get("model"), 512, false)?;
    let thinking = record.get("thinking")?.as_str()?.to_string();
    if !crate::settings::PRIME_EFFORT_SELECTORS.contains(&thinking.as_str()) {
        return None;
    }
    let speed = record.get("speed")?.as_str()?.to_string();
    if speed != "normal" && speed != "fast" {
        return None;
    }
    Some(ScheduleExecution {
        model,
        thinking,
        speed,
        unknown: unknown_fields(record, &["model", "thinking", "speed"]),
    })
}

fn parse_schedule_run(value: &Value) -> Option<ScheduleRunRecord> {
    const RUN_STATUSES: [&str; 7] = [
        "queued",
        "running",
        "succeeded",
        "failed",
        "skipped",
        "interrupted",
        "cancelled",
    ];
    let record = value.as_object()?;
    let id = bounded_string(record.get("id"), 256, false)?;
    let task_id = bounded_string(record.get("taskId"), 256, false)?;
    let task_revision = record.get("taskRevision")?.as_u64()?;
    if task_revision < 1 {
        return None;
    }
    let status = record.get("status")?.as_str()?.to_string();
    if !RUN_STATUSES.contains(&status.as_str()) {
        return None;
    }
    let trigger = record.get("trigger")?.as_str()?.to_string();
    if trigger != "scheduled" && trigger != "manual" {
        return None;
    }
    Some(ScheduleRunRecord {
        id,
        task_id,
        task_revision,
        trigger,
        scheduled_for: valid_date(record.get("scheduledFor"))?,
        queued_at: valid_date(record.get("queuedAt"))?,
        started_at: valid_date(record.get("startedAt")),
        finished_at: valid_date(record.get("finishedAt")),
        status,
        execution: parse_schedule_execution(record.get("execution")?)?,
        session_id: bounded_string(record.get("sessionId"), 256, false),
        session_file: bounded_string(record.get("sessionFile"), 4_096, false),
        error: bounded_string(record.get("error"), 4_000, true),
        skipped_count: record
            .get("skippedCount")
            .and_then(Value::as_u64)
            .filter(|count| *count > 0),
        unknown: unknown_fields(
            record,
            &[
                "id",
                "taskId",
                "taskRevision",
                "trigger",
                "scheduledFor",
                "queuedAt",
                "startedAt",
                "finishedAt",
                "status",
                "execution",
                "sessionId",
                "sessionFile",
                "error",
                "skippedCount",
            ],
        ),
    })
}

pub fn parse_schedule(value: &Value, pre_harness: bool) -> Option<AutomationScheduleRecord> {
    const SCHEDULE_STATUSES: [&str; 4] = ["active", "paused", "completed", "blocked"];
    let record = value.as_object()?;
    if record.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let id = bounded_string(record.get("id"), 256, false)?;
    let revision = record.get("revision")?.as_u64()?;
    if revision < 1 {
        return None;
    }
    let title = bounded_string(record.get("title"), 200, false)?;
    let prompt = bounded_string(record.get("prompt"), 1024 * 1024, false)?;
    let target = parse_schedule_target(record.get("target")?)?;
    let timing = parse_schedule_timing(record.get("timing")?)?;
    let execution = parse_schedule_execution(record.get("execution")?)?;
    let harness = parse_harness(record.get("harness"), pre_harness)?;
    let status = record.get("status")?.as_str()?.to_string();
    if !SCHEDULE_STATUSES.contains(&status.as_str()) {
        return None;
    }
    let created_by = record.get("createdBy")?.as_str()?.to_string();
    if created_by != "user" && created_by != "agent" {
        return None;
    }
    let runs = record
        .get("runs")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_schedule_run).collect())
        .unwrap_or_default();
    Some(AutomationScheduleRecord {
        schema_version: 1,
        id,
        harness,
        revision,
        title,
        prompt,
        target,
        timing,
        execution,
        status,
        created_by,
        created_at: valid_date(record.get("createdAt"))?,
        updated_at: valid_date(record.get("updatedAt"))?,
        next_run_at: valid_date(record.get("nextRunAt")),
        blocked_reason: bounded_string(record.get("blockedReason"), 4_000, true),
        runs,
        unknown: unknown_fields(
            record,
            &[
                "schemaVersion",
                "id",
                "harness",
                "revision",
                "title",
                "prompt",
                "target",
                "timing",
                "execution",
                "status",
                "createdBy",
                "createdAt",
                "updatedAt",
                "nextRunAt",
                "blockedReason",
                "runs",
            ],
        ),
    })
}

pub fn parse_state(value: &Value, path: &str) -> Result<(u32, DesktopState)> {
    let record = value.as_object().ok_or_else(|| {
        CoreError::new(
            "StateCompatibilityError",
            "Desktop state is missing a supported integer schema version",
        )
    })?;
    let version = record
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            CoreError::new(
                "StateCompatibilityError",
                "Desktop state is missing a supported integer schema version",
            )
        })?;
    if version > CURRENT_DESKTOP_STATE_VERSION as i64 {
        return Err(CoreError::new(
            "UnsupportedStateVersionError",
            format!(
                "Desktop state schema version {version} at {path} is newer than supported version {CURRENT_DESKTOP_STATE_VERSION}. Upgrade OMP Desktop to a compatible version; the state file was left unchanged."
            ),
        ));
    }
    if !(1..=4).contains(&version) {
        return Err(CoreError::new(
            "StateCompatibilityError",
            format!("Desktop state schema version {version} is not supported"),
        ));
    }
    let pre_harness_projects = version <= 2;
    let pre_harness_schedules = version == 2;
    let projects = record
        .get("projects")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| parse_project(item, pre_harness_projects))
                .collect()
        })
        .unwrap_or_default();
    let mut schedules: Vec<AutomationScheduleRecord> = if version != 1 {
        record
            .get("schedules")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| parse_schedule(item, pre_harness_schedules))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    schedules.truncate(MAX_SCHEDULES);
    for schedule in &mut schedules {
        if schedule.runs.len() > 100 {
            let excess = schedule.runs.len() - 100;
            schedule.runs.drain(0..excess);
        }
    }
    let mut archived_sessions: Vec<String> = record
        .get("archivedSessions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if archived_sessions.len() > MAX_ARCHIVED_SESSIONS {
        archived_sessions =
            archived_sessions.split_off(archived_sessions.len() - MAX_ARCHIVED_SESSIONS);
    }
    let mut pinned_sessions: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    if let Some(items) = record.get("pinnedSessions").and_then(Value::as_array) {
        for item in items {
            let Some(text) = item.as_str() else { continue };
            if text.is_empty()
                || text.chars().count() > 4_096
                || text.contains('\0')
                || !seen.insert(text.to_string())
            {
                continue;
            }
            pinned_sessions.push(text.to_string());
        }
    }
    if pinned_sessions.len() > MAX_PINNED_SESSIONS {
        pinned_sessions = pinned_sessions.split_off(pinned_sessions.len() - MAX_PINNED_SESSIONS);
    }
    let mut dismissed_project_paths: Vec<String> = record
        .get("dismissedProjectPaths")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if dismissed_project_paths.len() > MAX_DISMISSED_PROJECT_PATHS {
        dismissed_project_paths = dismissed_project_paths
            .split_off(dismissed_project_paths.len() - MAX_DISMISSED_PROJECT_PATHS);
    }
    Ok((
        version as u32,
        DesktopState {
            version: CURRENT_DESKTOP_STATE_VERSION,
            projects,
            settings: AppSettings::from_persisted(record.get("settings")),
            archived_sessions,
            pinned_sessions,
            dismissed_project_paths,
            schedules,
            unknown: unknown_fields(
                record,
                &[
                    "version",
                    "projects",
                    "settings",
                    "archivedSessions",
                    "pinnedSessions",
                    "dismissedProjectPaths",
                    "schedules",
                ],
            ),
        },
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsLegacyTombstone {
    schema_version: u32,
    status: String,
    current_state_file: String,
    backup_file: Option<String>,
    reason: String,
}

#[derive(Debug, Clone)]
struct Tombstone {
    status: String,
    backup_file: Option<String>,
    reason: String,
}

fn parse_tombstone(value: &Value) -> Option<Tombstone> {
    let record = value.as_object()?;
    if record.get("version").and_then(Value::as_u64) != Some(3) {
        return None;
    }
    if record
        .get("projects")
        .and_then(Value::as_array)
        .is_none_or(|items| !items.is_empty())
    {
        return None;
    }
    if record
        .get("schedules")
        .and_then(Value::as_array)
        .is_none_or(|items| !items.is_empty())
    {
        return None;
    }
    let marker = record.get(WINDOWS_LEGACY_TOMBSTONE_KEY)?.as_object()?;
    if marker.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    if marker.get("currentStateFile").and_then(Value::as_str)
        != Some(CURRENT_DESKTOP_STATE_FILENAME)
    {
        return None;
    }
    let status = marker.get("status").and_then(Value::as_str)?.to_string();
    if status != "pending" && status != "complete" {
        return None;
    }
    let reason = marker.get("reason").and_then(Value::as_str)?.to_string();
    if reason != "fresh" && reason != "migration" && reason != "quarantine" {
        return None;
    }
    let backup_file = match marker.get("backupFile") {
        Some(Value::Null) | None => None,
        Some(Value::String(name)) => {
            let prefix = format!("{LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-");
            if name != Path::new(name).file_name()?.to_str()?
                || !name.starts_with(&prefix)
                || name.len() > 512
            {
                return None;
            }
            Some(name.clone())
        }
        _ => return None,
    };
    if reason == "fresh" && backup_file.is_some() {
        return None;
    }
    if reason == "migration" && backup_file.is_none() {
        return None;
    }
    if reason == "quarantine" && (status != "complete" || backup_file.is_none()) {
        return None;
    }
    Some(Tombstone {
        status,
        backup_file,
        reason,
    })
}

pub struct StateStore {
    file_path: PathBuf,
    legacy_path: Option<PathBuf>,
    platform: Platform,
    state: DesktopState,
}

impl StateStore {
    pub fn open(
        file_path: PathBuf,
        legacy_path: Option<PathBuf>,
        platform: Platform,
    ) -> Result<Self> {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| CoreError::io("Could not create the state directory", error))?;
        }
        let mut store = Self {
            file_path,
            legacy_path,
            platform,
            state: DesktopState::default(),
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn snapshot(&self) -> DesktopState {
        self.state.clone()
    }

    pub fn settings(&self) -> AppSettings {
        self.state.settings.clone()
    }

    pub fn state(&self) -> &DesktopState {
        &self.state
    }

    pub fn state_mut(&mut self) -> &mut DesktopState {
        &mut self.state
    }

    pub fn update<F, T>(&mut self, mutator: F) -> Result<T>
    where
        F: FnOnce(&mut DesktopState) -> Result<T>,
    {
        let mut draft = self.state.clone();
        let result = mutator(&mut draft)?;
        draft.version = CURRENT_DESKTOP_STATE_VERSION;
        self.persist(&draft)?;
        self.state = draft;
        Ok(result)
    }

    pub fn update_settings(&mut self, patch: &Value) -> Result<AppSettings> {
        let next = self.state.settings.apply_patch(patch)?;
        self.update(|state| {
            state.settings = next.clone();
            Ok(())
        })?;
        Ok(next)
    }

    pub fn persist_current(&self) -> Result<()> {
        self.persist(&self.state)
    }

    fn initialize(&mut self) -> Result<()> {
        let current_exists = self.file_path.exists();
        let legacy_exists = self.legacy_path.as_ref().is_some_and(|path| path.exists());
        if current_exists {
            let size = fs::metadata(&self.file_path)
                .map_err(|error| CoreError::io("Could not inspect desktop state", error))?
                .len();
            if size > MAX_STATE_FILE_BYTES {
                return Err(CoreError::new(
                    "StateCompatibilityError",
                    format!(
                        "Desktop state file at {} is {size} bytes, which exceeds the {MAX_STATE_FILE_BYTES}-byte safe parse limit. It was left unchanged.",
                        self.file_path.display()
                    ),
                ));
            }
            let raw = fs::read(&self.file_path)
                .map_err(|error| CoreError::io("Could not read desktop state", error))?;
            let value: Value = serde_json::from_slice(&raw).map_err(|error| {
                CoreError::new(
                    "StateCompatibilityError",
                    format!("Desktop state is unreadable: {error}"),
                )
            })?;
            let (source_version, parsed) =
                parse_state(&value, &self.file_path.display().to_string())?;
            self.state = parsed;
            if self.platform.is_windows() {
                self.ensure_windows_protection(true)?;
            } else if legacy_exists {
                self.retire_legacy()?;
            }
            if source_version != CURRENT_DESKTOP_STATE_VERSION {
                self.persist_current()?;
            }
            return Ok(());
        }
        if legacy_exists {
            let legacy_path = self.legacy_path.clone().expect("legacy path checked");
            let size = fs::metadata(&legacy_path)
                .map_err(|error| CoreError::io("Could not inspect legacy desktop state", error))?
                .len();
            if size > MAX_STATE_FILE_BYTES {
                return Err(CoreError::new(
                    "StateCompatibilityError",
                    format!(
                        "Legacy desktop state file at {} is {size} bytes, which exceeds the {MAX_STATE_FILE_BYTES}-byte safe parse limit. It was left unchanged.",
                        legacy_path.display()
                    ),
                ));
            }
            let raw = fs::read(&legacy_path)
                .map_err(|error| CoreError::io("Could not read legacy desktop state", error))?;
            let value: Value = serde_json::from_slice(&raw).map_err(|error| {
                CoreError::new(
                    "StateCompatibilityError",
                    format!("Legacy desktop state is unreadable: {error}"),
                )
            })?;
            if self.platform.is_windows()
                && let Some(tombstone) = parse_tombstone(&value)
            {
                self.resume_windows_tombstone(&tombstone)?;
                return Ok(());
            }
            let (_, parsed) = parse_state(&value, &legacy_path.display().to_string())?;
            self.state = parsed;
            if self.platform.is_windows() {
                self.migrate_windows_legacy(&raw)?;
            } else {
                self.persist_current()?;
                self.retire_legacy()?;
            }
            return Ok(());
        }
        if self.platform.is_windows() {
            self.initialize_windows_fresh()?;
        } else {
            self.persist_current()?;
        }
        Ok(())
    }

    fn persist(&self, state: &DesktopState) -> Result<()> {
        let serialized = format!("{}\n", serde_json::to_string_pretty(state)?);
        let temp = self.file_path.with_file_name(format!(
            "{}.{}.{}.tmp",
            self.file_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("state"),
            std::process::id(),
            Uuid::new_v4()
        ));
        write_durable(&temp, serialized.as_bytes(), true)?;
        fs::rename(&temp, &self.file_path)
            .map_err(|error| CoreError::io("Could not publish desktop state", error))?;
        sync_parent_directory(&self.file_path);
        Ok(())
    }

    fn retire_legacy(&self) -> Result<()> {
        let Some(legacy_path) = &self.legacy_path else {
            return Ok(());
        };
        let backup = next_backup_path(legacy_path);
        match fs::rename(legacy_path, &backup) {
            Ok(()) => {
                sync_parent_directory(legacy_path);
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(CoreError::new(
                "StateMigrationError",
                format!("Legacy desktop state could not be retired before startup: {error}"),
            )),
        }
    }

    fn initialize_windows_fresh(&mut self) -> Result<()> {
        let pending = WindowsLegacyTombstone {
            schema_version: 1,
            status: "pending".to_string(),
            current_state_file: CURRENT_DESKTOP_STATE_FILENAME.to_string(),
            backup_file: None,
            reason: "fresh".to_string(),
        };
        self.publish_tombstone(&pending)?;
        self.persist_current()?;
        self.publish_tombstone(&WindowsLegacyTombstone {
            status: "complete".to_string(),
            ..pending
        })?;
        Ok(())
    }

    fn migrate_windows_legacy(&mut self, raw: &[u8]) -> Result<()> {
        let legacy_path = self.legacy_path.clone().expect("legacy path present");
        let backup = next_backup_path(&legacy_path);
        write_durable(&backup, raw, false)?;
        let pending = WindowsLegacyTombstone {
            schema_version: 1,
            status: "pending".to_string(),
            current_state_file: CURRENT_DESKTOP_STATE_FILENAME.to_string(),
            backup_file: backup
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string),
            reason: "migration".to_string(),
        };
        self.publish_tombstone(&pending)?;
        self.persist_current()?;
        self.publish_tombstone(&WindowsLegacyTombstone {
            status: "complete".to_string(),
            ..pending
        })?;
        Ok(())
    }

    fn resume_windows_tombstone(&mut self, tombstone: &Tombstone) -> Result<()> {
        if tombstone.status == "complete" {
            return Err(CoreError::new(
                "StateMigrationError",
                "The completed Windows compatibility marker exists, but the authoritative v4 state is missing. Automatic import was refused to avoid restoring stale grants.",
            ));
        }
        if let Some(backup) = &tombstone.backup_file {
            let legacy_path = self.legacy_path.clone().expect("legacy path present");
            let backup_path = legacy_path.with_file_name(backup);
            let size = fs::metadata(&backup_path)
                .map_err(|error| {
                    CoreError::io("Could not inspect the pending migration backup", error)
                })?
                .len();
            if size > MAX_STATE_FILE_BYTES {
                return Err(CoreError::new(
                    "StateCompatibilityError",
                    format!(
                        "Desktop state recovery file at {} exceeds the safe parse limit.",
                        backup_path.display()
                    ),
                ));
            }
            let raw = fs::read(&backup_path).map_err(|error| {
                CoreError::io("Could not read the pending migration backup", error)
            })?;
            let value: Value = serde_json::from_slice(&raw).map_err(|error| {
                CoreError::new(
                    "StateMigrationError",
                    format!(
                        "The pending Windows migration backup could not be read safely: {error}"
                    ),
                )
            })?;
            let (_, parsed) = parse_state(&value, &backup_path.display().to_string())?;
            self.state = parsed;
        } else if tombstone.reason != "fresh" {
            return Err(CoreError::new(
                "StateMigrationError",
                "The pending Windows compatibility marker has no recovery backup",
            ));
        }
        self.persist_current()?;
        self.publish_tombstone(&WindowsLegacyTombstone {
            schema_version: 1,
            status: "complete".to_string(),
            current_state_file: CURRENT_DESKTOP_STATE_FILENAME.to_string(),
            backup_file: tombstone.backup_file.clone(),
            reason: tombstone.reason.clone(),
        })?;
        Ok(())
    }

    fn ensure_windows_protection(&mut self, current_authoritative: bool) -> Result<()> {
        let Some(legacy_path) = self.legacy_path.clone() else {
            return Ok(());
        };
        if !legacy_path.exists() {
            self.publish_tombstone(&WindowsLegacyTombstone {
                schema_version: 1,
                status: "complete".to_string(),
                current_state_file: CURRENT_DESKTOP_STATE_FILENAME.to_string(),
                backup_file: None,
                reason: "fresh".to_string(),
            })?;
            return Ok(());
        }
        let size = fs::metadata(&legacy_path)
            .map_err(|error| CoreError::io("Could not inspect legacy desktop state", error))?
            .len();
        if size <= MAX_STATE_FILE_BYTES
            && let Ok(raw) = fs::read(&legacy_path)
            && let Ok(value) = serde_json::from_slice::<Value>(&raw)
        {
            {
                {
                    if let Some(tombstone) = parse_tombstone(&value) {
                        if tombstone.status == "complete" {
                            return Ok(());
                        }
                        if !current_authoritative {
                            return Ok(());
                        }
                        if let Some(backup) = &tombstone.backup_file {
                            let expected = legacy_path.with_file_name(backup);
                            if !expected.exists() {
                                return Err(CoreError::new(
                                    "StateMigrationError",
                                    format!(
                                        "The pending migration marker names a backup that is missing at {}",
                                        expected.display()
                                    ),
                                ));
                            }
                        }
                        self.publish_tombstone(&WindowsLegacyTombstone {
                            schema_version: 1,
                            status: "complete".to_string(),
                            current_state_file: CURRENT_DESKTOP_STATE_FILENAME.to_string(),
                            backup_file: tombstone.backup_file.clone(),
                            reason: tombstone.reason.clone(),
                        })?;
                        return Ok(());
                    }
                }
            }
        }
        let backup = next_backup_path(&legacy_path);
        fs::rename(&legacy_path, &backup).map_err(|error| CoreError::new("StateMigrationError", format!("Quarantine rename failed for a legacy state recreated by a downgraded binary: {error}")))?;
        self.publish_tombstone(&WindowsLegacyTombstone {
            schema_version: 1,
            status: "complete".to_string(),
            current_state_file: CURRENT_DESKTOP_STATE_FILENAME.to_string(),
            backup_file: backup
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string),
            reason: "quarantine".to_string(),
        })?;
        Ok(())
    }

    fn publish_tombstone(&self, marker: &WindowsLegacyTombstone) -> Result<()> {
        let Some(legacy_path) = &self.legacy_path else {
            return Ok(());
        };
        let serialized = format!(
            "{}\n",
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 3,
                "projects": [],
                "settings": {},
                "archivedSessions": [],
                "dismissedProjectPaths": [],
                "schedules": [],
                WINDOWS_LEGACY_TOMBSTONE_KEY: marker,
            }))?
        );
        let temp = legacy_path.with_file_name(format!(
            "{}.{}.{}.tombstone.tmp",
            legacy_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("legacy"),
            std::process::id(),
            Uuid::new_v4()
        ));
        write_durable(&temp, serialized.as_bytes(), true)?;
        fs::rename(&temp, legacy_path).map_err(|error| {
            CoreError::io("Could not publish the Windows compatibility marker", error)
        })?;
        let _ = fs::remove_file(&temp);
        Ok(())
    }
}

fn next_backup_path(legacy_path: &Path) -> PathBuf {
    let stamp = Utc::now().timestamp_millis();
    legacy_path.with_file_name(format!(
        "{}.migrated-v4-{stamp}-{}",
        legacy_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("legacy"),
        Uuid::new_v4()
    ))
}

fn write_durable(path: &Path, data: &[u8], create_new: bool) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| CoreError::io("Could not create a state file", error))?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(data)?;
        file.sync_all()
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(CoreError::io("Could not write a durable state file", error));
    }
    Ok(())
}

fn sync_parent_directory(path: &Path) {
    #[cfg(unix)]
    {
        if let Some(parent) = path.parent()
            && let Ok(directory) = fs::File::open(parent)
        {
            let _ = directory.sync_all();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDataMigrationReport {
    pub migrated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub copied_files: Vec<String>,
}

const MIGRATED_FILES: [&str; 7] = [
    "agent-message-signing.key",
    "voice-secrets.json",
    "crash.log",
    CURRENT_DESKTOP_STATE_FILENAME,
    LEGACY_DESKTOP_STATE_FILENAME,
    "prime-work-state-v4.json",
    "prime-work-state.json",
];

pub fn migrate_legacy_user_data(
    app_data_dir: &Path,
    user_data_dir: &Path,
) -> UserDataMigrationReport {
    if user_data_dir.join(CURRENT_DESKTOP_STATE_FILENAME).exists() {
        return UserDataMigrationReport {
            migrated: false,
            reason: Some("new-state-exists".to_string()),
            copied_files: Vec::new(),
        };
    }
    let legacy_dir = app_data_dir.join("GooeyPi");
    if !legacy_dir.exists() {
        return UserDataMigrationReport {
            migrated: false,
            reason: Some("legacy-dir-missing".to_string()),
            copied_files: Vec::new(),
        };
    }
    let mut copyable: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut total_bytes: u64 = 0;
    for name in MIGRATED_FILES {
        let source = legacy_dir.join(name);
        let Ok(info) = fs::metadata(&source) else {
            continue;
        };
        if !info.is_file()
            || info.len() > MAX_STATE_FILE_BYTES
            || total_bytes + info.len() > MAX_STATE_FILE_BYTES
        {
            continue;
        }
        total_bytes += info.len();
        let target_name = match name {
            "prime-work-state-v4.json" => CURRENT_DESKTOP_STATE_FILENAME,
            "prime-work-state.json" => LEGACY_DESKTOP_STATE_FILENAME,
            other => other,
        };
        copyable.push((source, user_data_dir.join(target_name)));
    }
    if copyable.is_empty() {
        return UserDataMigrationReport {
            migrated: false,
            reason: Some("empty".to_string()),
            copied_files: Vec::new(),
        };
    }
    let _ = fs::create_dir_all(user_data_dir);
    let mut copied_files = Vec::new();
    for (source, target) in copyable {
        if target.exists() {
            continue;
        }
        let staging = target.with_file_name(format!(
            "{}.migrating-{}",
            target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("file"),
            std::process::id()
        ));
        if fs::copy(&source, &staging).is_ok() && fs::rename(&staging, &target).is_ok() {
            copied_files.push(target.display().to_string());
        }
    }
    UserDataMigrationReport {
        migrated: true,
        reason: None,
        copied_files,
    }
}
