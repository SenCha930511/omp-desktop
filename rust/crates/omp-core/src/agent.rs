use std::path::Path;
use std::time::Duration;

use omp_rpc::{RpcClient, RpcOptions};
use serde_json::{Value, json};

use crate::error::{CoreError, Result};
use crate::models::CliContext;
use crate::projects;
use crate::sessions;
use crate::state::{Platform, StateStore};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const BASH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const LIVE_PHASES: [&str; 6] = [
    "connecting",
    "listening",
    "working",
    "speaking",
    "muted",
    "error",
];
/// Capture states the harness reports for a dictation session; anything else
/// is a malformed frame and is dropped.
const DICTATION_STATES: [&str; 3] = ["starting", "recording", "transcribing"];
/// Host-generated capture ids are short; a longer id cannot be one of ours.
const DICTATION_CAPTURE_ID_MAX: usize = 128;
/// Cap for transcribed text; longer frames are malformed or truncated.
const DICTATION_TEXT_MAX: usize = 64 * 1024;
const DICTATION_ERROR_MAX: usize = 4_000;
const UNSUPPORTED_COMMANDS: [&str; 12] = [
    "send_message",
    "clone",
    "set_heartbeat",
    "update_heartbeat",
    "manage_heartbeat",
    "observe",
    "unobserve",
    "list_heartbeats",
    "get_heartbeat",
    "agent_messages_status",
    "agent_messages_pause",
    "agent_messages_clear",
];

pub struct AgentRuntime {
    pub runtime_id: String,
    pub session_file: Option<String>,
    pub cwd: String,
    pub client: RpcClient,
}

pub struct AgentManager {
    runtimes: Vec<AgentRuntime>,
    next_id: u64,
    session_root: std::path::PathBuf,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self {
            runtimes: Vec::new(),
            next_id: 1,
            session_root: std::path::PathBuf::new(),
        }
    }
}

impl AgentManager {
    pub fn start(
        &mut self,
        store: &StateStore,
        platform: Platform,
        context: &CliContext,
        params: &Value,
    ) -> Result<Value> {
        let cwd_value = params
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| CoreError::invalid("agent.start requires cwd"))?;
        let cwd = projects::authorize_path(store, Path::new(cwd_value), platform)?;
        let session_root = sessions::session_root(&context.home_dir);
        let session_file = match params.get("sessionPath").and_then(Value::as_str) {
            Some(path) => Some(
                sessions::authorize_session_path_under(&session_root, Path::new(path))?
                    .display()
                    .to_string(),
            ),
            None => None,
        };
        let mut args = vec!["--mode".to_string(), "rpc".to_string()];
        if let Some(session) = &session_file {
            args.push("--resume".to_string());
            args.push(session.clone());
        }
        if let Some(model) = params
            .get("model")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
        if let Some(thinking) = params
            .get("thinking")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            args.push("--thinking".to_string());
            args.push(thinking.to_string());
        }
        let approval = store.state().settings.omp_approval_mode;
        if !matches!(approval, crate::settings::OmpApprovalMode::Inherit) {
            args.push("--approval-mode".to_string());
            args.push(
                match approval {
                    crate::settings::OmpApprovalMode::AlwaysAsk => "always-ask",
                    crate::settings::OmpApprovalMode::Write => "write",
                    crate::settings::OmpApprovalMode::Yolo => "yolo",
                    crate::settings::OmpApprovalMode::Inherit => unreachable!(),
                }
                .to_string(),
            );
        }
        let mut env: Vec<(String, String)> = vec![
            ("HOME".to_string(), context.home_dir.display().to_string()),
            (
                "USERPROFILE".to_string(),
                context.home_dir.display().to_string(),
            ),
            (
                "OMP_BINARY".to_string(),
                context.executable.display().to_string(),
            ),
            (
                "OMP_FIXTURE_HOME".to_string(),
                context.home_dir.display().to_string(),
            ),
            (
                "OMP_FIXTURE_STATE_DIR".to_string(),
                context.root_dir.join("fixture-state").display().to_string(),
            ),
        ];
        let sanitized = [
            "NODE_OPTIONS",
            "ELECTRON_RUN_AS_NODE",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
        ];
        env.extend(
            context
                .extra_env
                .iter()
                .filter(|(key, _)| !sanitized.contains(&key.as_str()))
                .cloned(),
        );
        let mut client = RpcClient::spawn(RpcOptions {
            executable: context.executable.clone(),
            args,
            env,
            remove_env: sanitized.iter().map(|key| key.to_string()).collect(),
            cwd: Some(cwd.clone()),
        })
        .map_err(|error| CoreError::new("Error", error.to_string()))?;
        let ready = client.wait_for_event(
            |event| event.get("type").and_then(Value::as_str) == Some("ready"),
            HANDSHAKE_TIMEOUT,
        );
        if ready.is_none() {
            let _ = client.close();
            return Err(CoreError::new(
                "Error",
                "The OMP runtime did not become ready",
            ));
        }
        let negotiated = match client.request(
            json!({ "type": "negotiate_protocol", "protocolVersion": 2 }),
            HANDSHAKE_TIMEOUT,
        ) {
            Ok(response) => response,
            Err(error) => {
                let _ = client.close();
                return Err(CoreError::new("Error", error.to_string()));
            }
        };
        if negotiated.get("success").and_then(Value::as_bool) != Some(true) {
            let _ = client.close();
            return Err(CoreError::new(
                "Error",
                "The OMP runtime rejected protocol negotiation",
            ));
        }
        if params.get("fast").and_then(Value::as_bool) == Some(true) {
            let _ = client.request(
                json!({ "type": "set_fast_mode", "enabled": true }),
                HANDSHAKE_TIMEOUT,
            );
        }
        if store.state().settings.ask_user_enabled {
            let _ = client.request(
                json!({ "type": "set_ask_dialog", "enabled": true }),
                HANDSHAKE_TIMEOUT,
            );
        }
        let runtime_id = format!("omp-{}", self.next_id);
        self.next_id += 1;
        let info = json!({
            "runtimeId": runtime_id,
            "harness": "omp",
            "cwd": cwd.display().to_string(),
            "sessionFile": session_file,
        });
        self.runtimes.push(AgentRuntime {
            runtime_id,
            session_file,
            cwd: cwd.display().to_string(),
            client,
        });
        Ok(info)
    }

    pub fn list(&self) -> Vec<Value> {
        self.runtimes
            .iter()
            .map(|runtime| {
                json!({
                    "runtimeId": runtime.runtime_id,
                    "harness": "omp",
                    "cwd": runtime.cwd,
                    "sessionFile": runtime.session_file,
                    "status": "idle",
                })
            })
            .collect()
    }

    pub fn stop(&mut self, runtime_id: &str) -> bool {
        if let Some(index) = self
            .runtimes
            .iter()
            .position(|runtime| runtime.runtime_id == runtime_id)
        {
            let mut runtime = self.runtimes.remove(index);
            runtime.client.close()
        } else {
            false
        }
    }

    pub fn stop_all(&mut self) {
        for mut runtime in self.runtimes.drain(..) {
            runtime.client.close();
        }
    }

    pub fn command(&mut self, runtime_id: &str, command: &Value) -> Result<Value> {
        let runtime = self
            .runtimes
            .iter_mut()
            .find(|runtime| runtime.runtime_id == runtime_id)
            .ok_or_else(|| CoreError::invalid("Unknown agent runtime"))?;
        let translated = translate_command(command, &self.session_root)?;
        let is_compact = translated.get("type").and_then(Value::as_str) == Some("compact");
        let timeout = if translated.get("type").and_then(Value::as_str) == Some("bash") {
            BASH_TIMEOUT
        } else {
            COMMAND_TIMEOUT
        };
        let response = runtime
            .client
            .request(translated, timeout)
            .map_err(|error| CoreError::new("Error", error.to_string()))?;
        if is_compact
            && let Some(session_file) = &runtime.session_file
            && let Some(record) = last_compaction_record(Path::new(session_file))
        {
            runtime.client.inject_event(serde_json::json!({
                "type": "compaction_end",
                "reason": "manual",
                "aborted": false,
                "willRetry": false,
                "result": {
                    "tokensBefore": record.0,
                    "tokensAfter": record.1,
                }
            }));
        }
        Ok(response)
    }

    pub fn drain_events(&mut self, runtime_id: Option<&str>) -> Vec<Value> {
        let mut envelopes = Vec::new();
        for runtime in &mut self.runtimes {
            if let Some(filter) = runtime_id
                && runtime.runtime_id != filter
            {
                continue;
            }
            for event in runtime.client.drain_events() {
                if let Some(normalized) = normalize_event(&event) {
                    envelopes.push(json!({ "runtimeId": runtime.runtime_id, "event": normalized }));
                }
            }
        }
        envelopes
    }
}

pub fn assert_no_mcp_authentication_command(prompt: &str) -> Result<()> {
    let trimmed = prompt.trim_start();
    if let Some(rest) = trimmed.strip_prefix("/mcp") {
        let action = rest.split_whitespace().next().unwrap_or_default();
        if action == "reauth" || action == "auth" || action == "login" {
            return Err(CoreError::invalid(
                "MCP authentication commands must run in the OMP CLI, not the desktop app",
            ));
        }
    }
    Ok(())
}

const ALLOWED_COMMANDS: &[&str] = &[
    "abort",
    "abort_and_restore_queue",
    "abort_bash",
    "abort_retry",
    "bash",
    "branch",
    "btw",
    "btw_cancel",
    "compact",
    "cycle_model",
    "cycle_thinking_level",
    "dictation_start",
    "dictation_stop",
    "export_html",
    "extension_ui_response",
    "follow_up",
    "fork",
    "get_available_commands",
    "get_available_models",
    "get_branch_messages",
    "get_btw_history",
    "get_commands",
    "get_last_assistant_text",
    "get_login_providers",
    "get_messages",
    "get_messages_page",
    "get_session_stats",
    "get_state",
    "get_subagents",
    "get_tree",
    "handoff",
    "live_mute",
    "live_start",
    "live_stop",
    "manual_compaction_end",
    "manual_compaction_start",
    "navigate_tree",
    "new_session",
    "predict_word",
    "prompt",
    "queue_update",
    "set_ask_dialog",
    "set_fast_mode",
    "set_label",
    "set_model",
    "set_service_tier",
    "set_session_name",
    "set_slow_mode",
    "set_subagent_subscription",
    "set_thinking_level",
    "side_question",
    "side_question_cancel",
    "side_question_history",
    "steer",
    "switch_session",
];

fn translate_command(command: &Value, session_root: &Path) -> Result<Value> {
    let object = command
        .as_object()
        .ok_or_else(|| CoreError::invalid("RPC command must be an object"))?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("RPC command requires a type"))?;
    if UNSUPPORTED_COMMANDS.contains(&kind) {
        return Err(CoreError::invalid(format!(
            "RPC command {kind} is not supported by the OMP harness"
        )));
    }
    if !ALLOWED_COMMANDS.contains(&kind) {
        return Err(CoreError::invalid(format!(
            "RPC command {kind} is not recognized by the OMP harness"
        )));
    }
    if (kind == "prompt" || kind == "steer" || kind == "follow_up")
        && let Some(message) = object.get("message").and_then(Value::as_str)
    {
        assert_no_mcp_authentication_command(message)?;
    }
    if kind == "switch_session" {
        let path = object
            .get("sessionPath")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty() && path.len() <= 4_096)
            .ok_or_else(|| CoreError::invalid("switch_session requires a session path"))?;
        sessions::authorize_session_path_under(session_root, Path::new(path))?;
    }
    if kind == "new_session"
        && let Some(parent) = object.get("parentSession").and_then(Value::as_str)
    {
        sessions::authorize_session_path_under(session_root, Path::new(parent))?;
    }
    let mut translated = object.clone();
    match kind {
        "side_question" => {
            translated.insert("type".to_string(), Value::String("btw".to_string()));
            if let Some(topic) = object.get("topicId").cloned() {
                translated.remove("topicId");
                translated.insert("recordId".to_string(), topic);
            }
        }
        "side_question_cancel" => {
            translated.insert("type".to_string(), Value::String("btw_cancel".to_string()));
            if let Some(topic) = object.get("topicId").cloned() {
                translated.remove("topicId");
                translated.insert("recordId".to_string(), topic);
            }
        }
        "side_question_history" => {
            translated.insert(
                "type".to_string(),
                Value::String("get_btw_history".to_string()),
            );
        }
        "set_service_tier" => {
            let priority = object.get("serviceTier").and_then(Value::as_str) == Some("priority");
            translated.insert(
                "type".to_string(),
                Value::String("set_fast_mode".to_string()),
            );
            translated.remove("serviceTier");
            translated.insert("enabled".to_string(), Value::Bool(priority));
        }
        _ => {}
    }
    Ok(Value::Object(translated))
}

fn last_compaction_record(path: &Path) -> Option<(u64, u64)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut found = None;
    for line in raw.lines() {
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("compaction") {
            continue;
        }
        let before = record
            .get("tokensBefore")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let after = record
            .get("tokensAfter")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        found = Some((before, after));
    }
    found
}

fn clamp_level(value: f64) -> f64 {
    if value <= 0.0 { 0.0 } else { value.min(1.0) }
}
/// Returns the capture id when it is a plausible host-generated id.
fn dictation_capture_id(event: &Value) -> Option<&str> {
    event
        .get("captureId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= DICTATION_CAPTURE_ID_MAX)
}

/// Truncates to a character cap so an oversized frame cannot reach the UI.
fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn normalize_event(event: &Value) -> Option<Value> {
    let kind = event.get("type").and_then(Value::as_str)?;
    match kind {
        "auto_compaction_start" => {
            let mut object = event.as_object()?.clone();
            object.insert(
                "type".to_string(),
                Value::String("compaction_start".to_string()),
            );
            Some(Value::Object(object))
        }
        "auto_compaction_end" => {
            let mut object = event.as_object()?.clone();
            object.insert(
                "type".to_string(),
                Value::String("compaction_end".to_string()),
            );
            Some(Value::Object(object))
        }
        "agent_end" if event.get("isTerminal").and_then(Value::as_bool) != Some(true) => None,
        "btw_record" => {
            let record = event.get("record")?.clone();
            Some(json!({ "type": "side_question_record", "topic": record }))
        }
        "btw_delta" => {
            let record_id = event.get("recordId").and_then(Value::as_str)?;
            let delta = event.get("delta").and_then(Value::as_str)?;
            Some(json!({ "type": "side_question_delta", "topicId": record_id, "delta": delta }))
        }
        "live_phase" => {
            let phase = event.get("phase").and_then(Value::as_str)?;
            LIVE_PHASES
                .contains(&phase)
                .then(|| json!({ "type": "live_phase", "phase": phase }))
        }
        "live_levels" => {
            let input = event.get("input").and_then(Value::as_f64)?;
            let output = event.get("output").and_then(Value::as_f64)?;
            Some(
                json!({ "type": "live_levels", "input": clamp_level(input), "output": clamp_level(output) }),
            )
        }
        "live_transcript" => {
            let role = event.get("role").and_then(Value::as_str)?;
            if role != "user" && role != "assistant" {
                return None;
            }
            let turn = event.get("turn").and_then(Value::as_i64)?;
            if turn < 0 {
                return None;
            }
            let text = event.get("text").and_then(Value::as_str)?;
            if text.len() > 64 * 1024 {
                return None;
            }
            let final_value = event.get("final").and_then(Value::as_bool)?;
            Some(
                json!({ "type": "live_transcript", "role": role, "turn": turn, "text": text, "final": final_value }),
            )
        }
        "live_end" => {
            if let Some(error) = event.get("error") {
                if !error.is_string() {
                    return None;
                }
                return Some(
                    json!({ "type": "live_end", "error": error.as_str().unwrap_or_default().chars().take(4_000).collect::<String>() }),
                );
            }
            Some(json!({ "type": "live_end" }))
        }
        "dictation_state" => {
            let capture_id = dictation_capture_id(event)?;
            let state = event.get("state").and_then(Value::as_str)?;
            DICTATION_STATES.contains(&state).then(
                || json!({ "type": "dictation_state", "captureId": capture_id, "state": state }),
            )
        }
        "dictation_transcript" => {
            let capture_id = dictation_capture_id(event)?;
            let text = event.get("text").and_then(Value::as_str)?;
            if text.len() > DICTATION_TEXT_MAX {
                return None;
            }
            Some(json!({ "type": "dictation_transcript", "captureId": capture_id, "text": text }))
        }
        "dictation_end" => {
            let capture_id = dictation_capture_id(event)?;
            let text = truncate_chars(
                event
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                DICTATION_TEXT_MAX,
            );
            let mut frame =
                json!({ "type": "dictation_end", "captureId": capture_id, "text": text });
            if let Some(error) = event.get("error") {
                let error = error.as_str()?;
                if !error.is_empty() {
                    frame["error"] = Value::String(truncate_chars(error, DICTATION_ERROR_MAX));
                }
            }
            Some(frame)
        }
        _ => Some(event.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn session_root() -> (tempfile::TempDir, std::path::PathBuf) {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("sessions");
        let bucket = root.join("-project");
        fs::create_dir_all(&bucket).expect("bucket");
        let file = bucket.join("2026-01-01T00-00-00-000Z_session.jsonl");
        fs::write(&file, "{}\n").expect("session");
        (temp, root)
    }

    #[test]
    fn rejects_commands_outside_the_allowlist() {
        let (_temp, root) = session_root();
        assert!(translate_command(&json!({ "type": "clone" }), &root).is_err());
        assert!(translate_command(&json!({ "type": "totally_new" }), &root).is_err());
    }

    #[test]
    fn authorizes_session_paths_before_translation() {
        let (temp, root) = session_root();
        let inside = root.join("-project/2026-01-01T00-00-00-000Z_session.jsonl");
        assert!(
            translate_command(
                &json!({ "type": "switch_session", "sessionPath": inside }),
                &root
            )
            .is_ok()
        );
        let outside = temp.path().join("outside.jsonl");
        fs::write(&outside, "{}\n").expect("outside");
        assert!(
            translate_command(
                &json!({ "type": "switch_session", "sessionPath": outside }),
                &root
            )
            .is_err()
        );
        assert!(
            translate_command(
                &json!({ "type": "new_session", "parentSession": outside }),
                &root
            )
            .is_err()
        );
    }

    #[test]
    fn blocks_mcp_authentication_commands_on_follow_up() {
        let (_temp, root) = session_root();
        assert!(
            translate_command(
                &json!({ "type": "follow_up", "message": "/mcp reauth" }),
                &root
            )
            .is_err()
        );
    }

    #[test]
    fn normalizes_dictation_frames_and_drops_malformed_ones() {
        let capture = "dictation-1-1";
        assert_eq!(
            normalize_event(
                &json!({ "type": "dictation_state", "captureId": capture, "state": "recording" })
            ),
            Some(json!({ "type": "dictation_state", "captureId": capture, "state": "recording" }))
        );
        assert_eq!(
            normalize_event(
                &json!({ "type": "dictation_transcript", "captureId": capture, "text": "hello" })
            ),
            Some(json!({ "type": "dictation_transcript", "captureId": capture, "text": "hello" }))
        );

        // The state whitelist and capture id shape are enforced.
        assert!(
            normalize_event(
                &json!({ "type": "dictation_state", "captureId": capture, "state": "bogus" })
            )
            .is_none()
        );
        assert!(
            normalize_event(&json!({ "type": "dictation_state", "state": "recording" })).is_none()
        );
        assert!(
            normalize_event(
                &json!({ "type": "dictation_state", "captureId": "", "state": "starting" })
            )
            .is_none()
        );
        let long_id = "c".repeat(DICTATION_CAPTURE_ID_MAX + 1);
        assert!(
            normalize_event(
                &json!({ "type": "dictation_transcript", "captureId": long_id, "text": "hi" })
            )
            .is_none()
        );
        assert!(
            normalize_event(&json!({
                "type": "dictation_transcript",
                "captureId": capture,
                "text": "x".repeat(DICTATION_TEXT_MAX + 1),
            }))
            .is_none()
        );

        // The terminal frame carries the text and an optional error, capped.
        let end = normalize_event(
            &json!({ "type": "dictation_end", "captureId": capture, "text": "done", "error": "boom" }),
        )
        .expect("dictation_end");
        assert_eq!(end["type"], "dictation_end");
        assert_eq!(end["captureId"], capture);
        assert_eq!(end["text"], "done");
        assert_eq!(end["error"], "boom");
        let bare_end =
            normalize_event(&json!({ "type": "dictation_end", "captureId": capture, "text": "" }))
                .expect("bare dictation_end");
        assert!(bare_end.get("error").is_none());
        let oversized = normalize_event(&json!({
            "type": "dictation_end",
            "captureId": capture,
            "text": "y".repeat(DICTATION_TEXT_MAX + 5),
        }))
        .expect("oversized dictation_end is truncated, not dropped");
        assert_eq!(
            oversized["text"].as_str().map(str::len),
            Some(DICTATION_TEXT_MAX)
        );
        assert!(
            normalize_event(
                &json!({ "type": "dictation_end", "captureId": capture, "text": "x", "error": 7 })
            )
            .is_none()
        );
    }
}
