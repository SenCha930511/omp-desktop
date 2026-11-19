use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{CoreError, Result};

pub const ACCENT_COLORS: [&str; 6] = ["prime", "blue", "teal", "green", "orange", "pink"];
pub const INTERFACE_FONT_SCALES: [u16; 3] = [105, 110, 115];
pub const PROJECT_SORT_MODES: [&str; 2] = ["recent", "alphabetical"];
pub const IDLE_SESSION_MINUTES: [u16; 4] = [0, 5, 15, 30];
pub const PRIME_THINKING_LEVELS: [&str; 7] =
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
pub const PRIME_EFFORT_SELECTORS: [&str; 8] = [
    "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];
pub const HARNESS_IDS: [&str; 1] = ["omp"];

const KNOWN_FIELDS: [&str; 43] = [
    "conversationDensity",
    "subagentsPanelPinned",
    "theme",
    "locale",
    "accentColor",
    "interfaceFontScale",
    "projectSortMode",
    "sidebarOpen",
    "inspectorOpen",
    "showFileChangesPopup",
    "checkoutStrategy",
    "idleSessionMinutes",
    "keepRunningInBackground",
    "launchAtLogin",
    "terminalOpen",
    "defaultInspectorTab",
    "browserHome",
    "browserAskForDownloads",
    "terminalShell",
    "reduceMotion",
    "showReasoningSummaries",
    "reasoningExpandedByDefault",
    "defaultEffort",
    "showToolCalls",
    "messageEnterAction",
    "inputShortcutsVersion",
    "runtimePaths",
    "telemetry",
    "askUserEnabled",
    "browserEnabled",
    "computerUseEnabled",
    "lastSelectedModels",
    "activeHarness",
    "ompApprovalMode",
    "voiceTranscriptionProvider",
    "voiceOpenAiLiveTranscriptionModel",
    "voiceOpenAiTranscriptionModel",
    "voiceGroqTranscriptionModel",
    "voiceDeepgramTranscriptionModel",
    "voiceSelfHostedUrl",
    "voiceSelfHostedModel",
    "voiceLocalWhisperExecutable",
    "voiceLocalWhisperModel",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    System,
    Light,
    Dark,
}

impl Theme {
    fn parse(value: Option<&Value>) -> Self {
        match value.and_then(Value::as_str) {
            Some("light") => Self::Light,
            Some("dark") => Self::Dark,
            _ => Self::System,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Locale {
    #[serde(rename = "system")]
    System,
    #[serde(rename = "en")]
    En,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
}

impl Locale {
    fn parse(value: Option<&Value>) -> Self {
        match value.and_then(Value::as_str) {
            Some("en") => Self::En,
            Some("zh-CN") => Self::ZhCn,
            Some("zh-TW") => Self::ZhTw,
            _ => Self::System,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConversationDensity {
    Compact,
    Comfortable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckoutStrategy {
    Branch,
    Worktree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InspectorTab {
    Summary,
    Changes,
    Browser,
    Files,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MessageEnterAction {
    Queue,
    Steer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OmpApprovalMode {
    Inherit,
    AlwaysAsk,
    Write,
    Yolo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum VoiceTranscriptionProvider {
    #[serde(rename = "openai-live")]
    OpenAiLive,
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "groq")]
    Groq,
    #[serde(rename = "deepgram")]
    Deepgram,
    #[serde(rename = "self-hosted")]
    SelfHosted,
    #[serde(rename = "local-whisper")]
    LocalWhisper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectSortMode {
    Recent,
    Alphabetical,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub conversation_density: ConversationDensity,
    pub subagents_panel_pinned: bool,
    pub theme: Theme,
    pub locale: Locale,
    pub accent_color: String,
    pub interface_font_scale: u16,
    pub project_sort_mode: ProjectSortMode,
    pub sidebar_open: bool,
    pub inspector_open: bool,
    pub show_file_changes_popup: bool,
    pub checkout_strategy: CheckoutStrategy,
    pub idle_session_minutes: u16,
    pub keep_running_in_background: bool,
    pub launch_at_login: bool,
    pub terminal_open: bool,
    pub default_inspector_tab: InspectorTab,
    pub browser_home: String,
    pub browser_ask_for_downloads: bool,
    pub terminal_shell: String,
    pub reduce_motion: bool,
    pub show_reasoning_summaries: bool,
    pub reasoning_expanded_by_default: bool,
    pub default_effort: String,
    pub show_tool_calls: bool,
    pub message_enter_action: MessageEnterAction,
    pub input_shortcuts_version: u32,
    pub runtime_paths: Map<String, Value>,
    pub telemetry: bool,
    pub ask_user_enabled: bool,
    pub browser_enabled: bool,
    pub computer_use_enabled: bool,
    pub last_selected_models: Map<String, Value>,
    pub active_harness: String,
    pub omp_approval_mode: OmpApprovalMode,
    pub voice_transcription_provider: VoiceTranscriptionProvider,
    pub voice_open_ai_live_transcription_model: String,
    pub voice_open_ai_transcription_model: String,
    pub voice_groq_transcription_model: String,
    pub voice_deepgram_transcription_model: String,
    pub voice_self_hosted_url: String,
    pub voice_self_hosted_model: String,
    pub voice_local_whisper_executable: String,
    pub voice_local_whisper_model: String,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

fn default_shell() -> String {
    if cfg!(windows) {
        match std::env::var("ComSpec") {
            Ok(value) if Path::new(&value).is_absolute() => value,
            _ => "C:\\Windows\\System32\\cmd.exe".to_string(),
        }
    } else {
        match std::env::var("SHELL") {
            Ok(value) if value.starts_with('/') => value,
            _ => "/bin/zsh".to_string(),
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            conversation_density: ConversationDensity::Comfortable,
            subagents_panel_pinned: false,
            theme: Theme::System,
            locale: Locale::System,
            accent_color: "prime".to_string(),
            interface_font_scale: 110,
            project_sort_mode: ProjectSortMode::Recent,
            sidebar_open: true,
            inspector_open: true,
            show_file_changes_popup: true,
            checkout_strategy: CheckoutStrategy::Worktree,
            idle_session_minutes: 5,
            keep_running_in_background: false,
            launch_at_login: false,
            terminal_open: false,
            default_inspector_tab: InspectorTab::Summary,
            browser_home: "https://www.google.com/".to_string(),
            browser_ask_for_downloads: true,
            terminal_shell: default_shell(),
            reduce_motion: false,
            show_reasoning_summaries: true,
            reasoning_expanded_by_default: false,
            default_effort: "medium".to_string(),
            show_tool_calls: true,
            message_enter_action: MessageEnterAction::Steer,
            input_shortcuts_version: 1,
            runtime_paths: Map::from_iter([("omp".to_string(), Value::String(String::new()))]),
            telemetry: false,
            ask_user_enabled: false,
            browser_enabled: true,
            computer_use_enabled: false,
            last_selected_models: Map::from_iter([(
                "omp".to_string(),
                Value::String(String::new()),
            )]),
            active_harness: "omp".to_string(),
            omp_approval_mode: OmpApprovalMode::Inherit,
            voice_transcription_provider: VoiceTranscriptionProvider::OpenAiLive,
            voice_open_ai_live_transcription_model: "gpt-live-transcribe".to_string(),
            voice_open_ai_transcription_model: "gpt-4o-transcribe".to_string(),
            voice_groq_transcription_model: "whisper-large-v3-turbo".to_string(),
            voice_deepgram_transcription_model: "nova-3".to_string(),
            voice_self_hosted_url: String::new(),
            voice_self_hosted_model: String::new(),
            voice_local_whisper_executable: String::new(),
            voice_local_whisper_model: String::new(),
            unknown: BTreeMap::new(),
        }
    }
}

impl AppSettings {
    pub fn from_persisted(value: Option<&Value>) -> Self {
        let defaults = Self::default();
        let Some(record) = value.and_then(Value::as_object) else {
            return defaults;
        };
        let unknown = record
            .iter()
            .filter(|(key, _)| !KNOWN_FIELDS.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();

        Self {
            conversation_density: match record.get("conversationDensity").and_then(Value::as_str) {
                Some("compact") => ConversationDensity::Compact,
                Some("comfortable") => ConversationDensity::Comfortable,
                _ => defaults.conversation_density,
            },
            subagents_panel_pinned: bool_or(
                record,
                "subagentsPanelPinned",
                defaults.subagents_panel_pinned,
            ),
            theme: Theme::parse(record.get("theme")),
            locale: Locale::parse(record.get("locale")),
            accent_color: allowed_string(record, "accentColor", &ACCENT_COLORS)
                .unwrap_or(defaults.accent_color),
            interface_font_scale: allowed_u16(record, "interfaceFontScale", &INTERFACE_FONT_SCALES)
                .unwrap_or(defaults.interface_font_scale),
            project_sort_mode: match record.get("projectSortMode").and_then(Value::as_str) {
                Some("alphabetical") => ProjectSortMode::Alphabetical,
                Some("recent") => ProjectSortMode::Recent,
                _ => defaults.project_sort_mode,
            },
            sidebar_open: bool_or(record, "sidebarOpen", defaults.sidebar_open),
            inspector_open: bool_or(record, "inspectorOpen", defaults.inspector_open),
            show_file_changes_popup: bool_or(
                record,
                "showFileChangesPopup",
                defaults.show_file_changes_popup,
            ),
            checkout_strategy: match record.get("checkoutStrategy").and_then(Value::as_str) {
                Some("branch") => CheckoutStrategy::Branch,
                Some("worktree") => CheckoutStrategy::Worktree,
                _ => defaults.checkout_strategy,
            },
            idle_session_minutes: allowed_u16(record, "idleSessionMinutes", &IDLE_SESSION_MINUTES)
                .unwrap_or(defaults.idle_session_minutes),
            keep_running_in_background: bool_or(
                record,
                "keepRunningInBackground",
                defaults.keep_running_in_background,
            ),
            launch_at_login: bool_or(record, "launchAtLogin", defaults.launch_at_login),
            terminal_open: bool_or(record, "terminalOpen", defaults.terminal_open),
            default_inspector_tab: match record.get("defaultInspectorTab").and_then(Value::as_str) {
                Some("changes") => InspectorTab::Changes,
                Some("browser") => InspectorTab::Browser,
                Some("files") => InspectorTab::Files,
                Some("summary") => InspectorTab::Summary,
                _ => defaults.default_inspector_tab,
            },
            browser_home: string_or(record, "browserHome", &defaults.browser_home),
            browser_ask_for_downloads: bool_or(
                record,
                "browserAskForDownloads",
                defaults.browser_ask_for_downloads,
            ),
            terminal_shell: string_or(record, "terminalShell", &defaults.terminal_shell),
            reduce_motion: bool_or(record, "reduceMotion", defaults.reduce_motion),
            show_reasoning_summaries: bool_or(
                record,
                "showReasoningSummaries",
                defaults.show_reasoning_summaries,
            ),
            reasoning_expanded_by_default: bool_or(
                record,
                "reasoningExpandedByDefault",
                defaults.reasoning_expanded_by_default,
            ),
            default_effort: allowed_string(record, "defaultEffort", &PRIME_EFFORT_SELECTORS)
                .unwrap_or(defaults.default_effort),
            show_tool_calls: bool_or(record, "showToolCalls", defaults.show_tool_calls),
            message_enter_action: match record.get("messageEnterAction").and_then(Value::as_str) {
                Some("steer") => MessageEnterAction::Steer,
                Some("queue")
                    if record.get("inputShortcutsVersion").and_then(Value::as_u64) == Some(1) =>
                {
                    MessageEnterAction::Queue
                }
                _ => defaults.message_enter_action,
            },
            input_shortcuts_version: 1,
            runtime_paths: parse_runtime_paths(record.get("runtimePaths"))
                .unwrap_or(defaults.runtime_paths),
            telemetry: bool_or(record, "telemetry", defaults.telemetry),
            ask_user_enabled: bool_or(record, "askUserEnabled", defaults.ask_user_enabled),
            browser_enabled: bool_or(record, "browserEnabled", defaults.browser_enabled),
            computer_use_enabled: bool_or(
                record,
                "computerUseEnabled",
                defaults.computer_use_enabled,
            ),
            last_selected_models: parse_last_selected_models(record.get("lastSelectedModels"))
                .unwrap_or(defaults.last_selected_models),
            active_harness: "omp".to_string(),
            omp_approval_mode: match record.get("ompApprovalMode").and_then(Value::as_str) {
                Some("always-ask") => OmpApprovalMode::AlwaysAsk,
                Some("write") => OmpApprovalMode::Write,
                Some("yolo") => OmpApprovalMode::Yolo,
                Some("inherit") => OmpApprovalMode::Inherit,
                _ => defaults.omp_approval_mode,
            },
            voice_transcription_provider: match record
                .get("voiceTranscriptionProvider")
                .and_then(Value::as_str)
            {
                Some("openai") => VoiceTranscriptionProvider::OpenAi,
                Some("groq") => VoiceTranscriptionProvider::Groq,
                Some("deepgram") => VoiceTranscriptionProvider::Deepgram,
                Some("self-hosted") => VoiceTranscriptionProvider::SelfHosted,
                Some("local-whisper") => VoiceTranscriptionProvider::LocalWhisper,
                Some("openai-live") => VoiceTranscriptionProvider::OpenAiLive,
                _ => defaults.voice_transcription_provider,
            },
            voice_open_ai_live_transcription_model: bounded_or(
                record,
                "voiceOpenAiLiveTranscriptionModel",
                128,
                &defaults.voice_open_ai_live_transcription_model,
            ),
            voice_open_ai_transcription_model: bounded_or(
                record,
                "voiceOpenAiTranscriptionModel",
                128,
                &defaults.voice_open_ai_transcription_model,
            ),
            voice_groq_transcription_model: bounded_or(
                record,
                "voiceGroqTranscriptionModel",
                128,
                &defaults.voice_groq_transcription_model,
            ),
            voice_deepgram_transcription_model: bounded_or(
                record,
                "voiceDeepgramTranscriptionModel",
                128,
                &defaults.voice_deepgram_transcription_model,
            ),
            voice_self_hosted_url: bounded_or(
                record,
                "voiceSelfHostedUrl",
                2_048,
                &defaults.voice_self_hosted_url,
            ),
            voice_self_hosted_model: bounded_or(
                record,
                "voiceSelfHostedModel",
                128,
                &defaults.voice_self_hosted_model,
            ),
            voice_local_whisper_executable: bounded_or(
                record,
                "voiceLocalWhisperExecutable",
                4_096,
                &defaults.voice_local_whisper_executable,
            ),
            voice_local_whisper_model: bounded_or(
                record,
                "voiceLocalWhisperModel",
                4_096,
                &defaults.voice_local_whisper_model,
            ),
            unknown,
        }
    }

    pub fn omp_runtime_path(&self) -> String {
        self.runtime_paths
            .get("omp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    pub fn last_selected_model(&self) -> String {
        self.last_selected_models
            .get("omp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    pub fn apply_patch(&self, patch: &Value) -> Result<Self> {
        let record = patch
            .as_object()
            .ok_or_else(|| CoreError::invalid("settings patch must be an object"))?;
        for key in record.keys() {
            if !KNOWN_FIELDS.contains(&key.as_str()) {
                return Err(CoreError::invalid(format!("Unknown settings key: {key}")));
            }
        }
        let mut next = self.clone();
        for (key, value) in record {
            match key.as_str() {
                "conversationDensity" => {
                    next.conversation_density = match value.as_str() {
                        Some("compact") => ConversationDensity::Compact,
                        Some("comfortable") => ConversationDensity::Comfortable,
                        _ => return Err(CoreError::invalid("Invalid conversation density")),
                    }
                }
                "idleSessionMinutes" => {
                    let number = value
                        .as_u64()
                        .and_then(|item| u16::try_from(item).ok())
                        .filter(|item| IDLE_SESSION_MINUTES.contains(item));
                    next.idle_session_minutes =
                        number.ok_or_else(|| CoreError::invalid("Invalid idle session minutes"))?;
                }
                "theme" => {
                    next.theme = match value.as_str() {
                        Some("system") => Theme::System,
                        Some("light") => Theme::Light,
                        Some("dark") => Theme::Dark,
                        _ => return Err(CoreError::invalid("Invalid theme")),
                    }
                }
                "locale" => {
                    next.locale = match value.as_str() {
                        Some("system") => Locale::System,
                        Some("en") => Locale::En,
                        Some("zh-CN") => Locale::ZhCn,
                        Some("zh-TW") => Locale::ZhTw,
                        _ => return Err(CoreError::invalid("Invalid locale")),
                    }
                }
                "accentColor" => {
                    next.accent_color = allowed_string(record, "accentColor", &ACCENT_COLORS)
                        .ok_or_else(|| CoreError::invalid("Invalid accent color"))?;
                }
                "interfaceFontScale" => {
                    let scale = value
                        .as_u64()
                        .and_then(|item| u16::try_from(item).ok())
                        .filter(|item| INTERFACE_FONT_SCALES.contains(item));
                    next.interface_font_scale =
                        scale.ok_or_else(|| CoreError::invalid("Invalid interface font scale"))?;
                }
                "projectSortMode" => {
                    next.project_sort_mode = match value.as_str() {
                        Some("recent") => ProjectSortMode::Recent,
                        Some("alphabetical") => ProjectSortMode::Alphabetical,
                        _ => return Err(CoreError::invalid("Invalid project sort mode")),
                    }
                }
                "sidebarOpen" => next.sidebar_open = require_bool(value, "sidebarOpen")?,
                "inspectorOpen" => next.inspector_open = require_bool(value, "inspectorOpen")?,
                "showFileChangesPopup" => {
                    next.show_file_changes_popup = require_bool(value, "showFileChangesPopup")?
                }
                "checkoutStrategy" => {
                    next.checkout_strategy = match value.as_str() {
                        Some("branch") => CheckoutStrategy::Branch,
                        Some("worktree") => CheckoutStrategy::Worktree,
                        _ => return Err(CoreError::invalid("Invalid checkout strategy")),
                    }
                }
                "keepRunningInBackground" => {
                    next.keep_running_in_background =
                        require_bool(value, "keepRunningInBackground")?
                }
                "launchAtLogin" => next.launch_at_login = require_bool(value, "launchAtLogin")?,
                "terminalOpen" => next.terminal_open = require_bool(value, "terminalOpen")?,
                "defaultInspectorTab" => {
                    next.default_inspector_tab = match value.as_str() {
                        Some("summary") => InspectorTab::Summary,
                        Some("changes") => InspectorTab::Changes,
                        Some("browser") => InspectorTab::Browser,
                        Some("files") => InspectorTab::Files,
                        _ => return Err(CoreError::invalid("Invalid inspector tab")),
                    }
                }
                "browserHome" => next.browser_home = require_web_url(value)?,
                "browserAskForDownloads" => {
                    next.browser_ask_for_downloads = require_bool(value, "browserAskForDownloads")?
                }
                "terminalShell" => {
                    let shell = require_string(value, "terminalShell", 4_096, true)?;
                    next.terminal_shell = shell;
                }
                "reduceMotion" => next.reduce_motion = require_bool(value, "reduceMotion")?,
                "showReasoningSummaries" => {
                    next.show_reasoning_summaries = require_bool(value, "showReasoningSummaries")?
                }
                "reasoningExpandedByDefault" => {
                    next.reasoning_expanded_by_default =
                        require_bool(value, "reasoningExpandedByDefault")?
                }
                "defaultEffort" => {
                    next.default_effort =
                        allowed_string(record, "defaultEffort", &PRIME_EFFORT_SELECTORS)
                            .ok_or_else(|| {
                                CoreError::invalid("Invalid default reasoning effort")
                            })?;
                }
                "showToolCalls" => next.show_tool_calls = require_bool(value, "showToolCalls")?,
                "messageEnterAction" => {
                    next.message_enter_action = match value.as_str() {
                        Some("queue") => MessageEnterAction::Queue,
                        Some("steer") => MessageEnterAction::Steer,
                        _ => return Err(CoreError::invalid("Invalid message Enter action")),
                    }
                }
                "inputShortcutsVersion" => {
                    let version = value.as_u64().ok_or_else(|| {
                        CoreError::invalid("inputShortcutsVersion must be a non-negative integer")
                    })?;
                    next.input_shortcuts_version = u32::try_from(version).map_err(|_| {
                        CoreError::invalid("inputShortcutsVersion must be a non-negative integer")
                    })?;
                }
                "runtimePaths" => next.runtime_paths = require_runtime_paths(value)?,
                "telemetry" => next.telemetry = require_bool(value, "telemetry")?,
                "askUserEnabled" => next.ask_user_enabled = require_bool(value, "askUserEnabled")?,
                "browserEnabled" => next.browser_enabled = require_bool(value, "browserEnabled")?,
                "computerUseEnabled" => {
                    next.computer_use_enabled = require_bool(value, "computerUseEnabled")?
                }
                "lastSelectedModels" => {
                    next.last_selected_models = require_last_selected_models(value)?
                }
                "activeHarness" => {
                    if value.as_str() != Some("omp") {
                        return Err(CoreError::invalid("Invalid harness"));
                    }
                    next.active_harness = "omp".to_string();
                }
                "ompApprovalMode" => {
                    next.omp_approval_mode = match value.as_str() {
                        Some("inherit") => OmpApprovalMode::Inherit,
                        Some("always-ask") => OmpApprovalMode::AlwaysAsk,
                        Some("write") => OmpApprovalMode::Write,
                        Some("yolo") => OmpApprovalMode::Yolo,
                        _ => return Err(CoreError::invalid("Invalid OMP approval mode")),
                    }
                }
                "voiceTranscriptionProvider" => {
                    next.voice_transcription_provider = match value.as_str() {
                        Some("openai-live") => VoiceTranscriptionProvider::OpenAiLive,
                        Some("openai") => VoiceTranscriptionProvider::OpenAi,
                        Some("groq") => VoiceTranscriptionProvider::Groq,
                        Some("deepgram") => VoiceTranscriptionProvider::Deepgram,
                        Some("self-hosted") => VoiceTranscriptionProvider::SelfHosted,
                        Some("local-whisper") => VoiceTranscriptionProvider::LocalWhisper,
                        _ => {
                            return Err(CoreError::invalid("Invalid voice transcription provider"));
                        }
                    }
                }
                "voiceOpenAiLiveTranscriptionModel" => {
                    next.voice_open_ai_live_transcription_model =
                        require_voice_model(value, "voiceOpenAiLiveTranscriptionModel")?
                }
                "voiceOpenAiTranscriptionModel" => {
                    next.voice_open_ai_transcription_model =
                        require_voice_model(value, "voiceOpenAiTranscriptionModel")?
                }
                "voiceGroqTranscriptionModel" => {
                    next.voice_groq_transcription_model =
                        require_voice_model(value, "voiceGroqTranscriptionModel")?
                }
                "voiceDeepgramTranscriptionModel" => {
                    next.voice_deepgram_transcription_model =
                        require_voice_model(value, "voiceDeepgramTranscriptionModel")?
                }
                "voiceSelfHostedUrl" => {
                    let url = require_string(value, "voiceSelfHostedUrl", 2_048, true)?;
                    if !url.is_empty()
                        && !url.starts_with("http://")
                        && !url.starts_with("https://")
                    {
                        return Err(CoreError::invalid(
                            "voiceSelfHostedUrl must be an http(s) URL",
                        ));
                    }
                    next.voice_self_hosted_url = url;
                }
                "voiceSelfHostedModel" => {
                    let model = require_string(value, "voiceSelfHostedModel", 128, true)?;
                    if !model.is_empty() && !valid_voice_model(&model) {
                        return Err(CoreError::invalid("voiceSelfHostedModel is not valid"));
                    }
                    next.voice_self_hosted_model = model;
                }
                "voiceLocalWhisperExecutable" => {
                    next.voice_local_whisper_executable =
                        require_string(value, "voiceLocalWhisperExecutable", 4_096, true)?
                }
                "voiceLocalWhisperModel" => {
                    next.voice_local_whisper_model =
                        require_string(value, "voiceLocalWhisperModel", 4_096, true)?
                }
                _ => {}
            }
        }
        Ok(next)
    }
}

fn bool_or(record: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    record.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn string_or(record: &Map<String, Value>, key: &str, fallback: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn bounded_or(record: &Map<String, Value>, key: &str, max: usize, fallback: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| value.chars().count() <= max)
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn allowed_string(record: &Map<String, Value>, key: &str, allowed: &[&str]) -> Option<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .map(str::to_string)
}

fn allowed_u16(record: &Map<String, Value>, key: &str, allowed: &[u16]) -> Option<u16> {
    record
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| allowed.contains(value))
}

fn parse_runtime_paths(value: Option<&Value>) -> Option<Map<String, Value>> {
    let record = value?.as_object()?;
    let mut paths = Map::new();
    for (key, item) in record {
        let path = item.as_str()?;
        if path.chars().count() > 4_096 || (!path.is_empty() && !Path::new(path).is_absolute()) {
            return None;
        }
        paths.insert(key.clone(), Value::String(path.to_string()));
    }
    Some(paths)
}

fn parse_last_selected_models(value: Option<&Value>) -> Option<Map<String, Value>> {
    let record = value?.as_object()?;
    let mut models = Map::new();
    for (key, item) in record {
        let model = item.as_str()?;
        if model.chars().count() > 385 || (!model.is_empty() && !valid_model_key(model)) {
            return None;
        }
        models.insert(key.clone(), Value::String(model.to_string()));
    }
    Some(models)
}

fn valid_model_key(value: &str) -> bool {
    let Some((provider, model)) = value.split_once('/') else {
        return false;
    };
    let mut provider_chars = provider.chars();
    let Some(first) = provider_chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    if provider.len() > 128
        || !provider
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return false;
    }
    if model.is_empty() || model.len() > 256 {
        return false;
    }
    model
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '+' | '-'))
}

fn valid_voice_model(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() || value.len() > 128 {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

fn require_bool(value: &Value, key: &str) -> Result<bool> {
    value
        .as_bool()
        .ok_or_else(|| CoreError::invalid(format!("{key} must be a boolean")))
}

fn require_string(value: &Value, key: &str, max: usize, allow_empty: bool) -> Result<String> {
    let Some(text) = value.as_str() else {
        return Err(CoreError::invalid(format!("{key} must be a string")));
    };
    if text.chars().count() > max || (!allow_empty && text.trim().is_empty()) {
        return Err(CoreError::invalid(format!("{key} is out of bounds")));
    }
    Ok(text.to_string())
}

fn require_web_url(value: &Value) -> Result<String> {
    let text = require_string(value, "browserHome", 2_048, false)?;
    if !text.starts_with("https://") && !text.starts_with("http://") {
        return Err(CoreError::invalid("browserHome must be an http(s) URL"));
    }
    Ok(text)
}

fn require_voice_model(value: &Value, key: &str) -> Result<String> {
    let text = require_string(value, key, 128, false)?;
    if !valid_voice_model(&text) {
        return Err(CoreError::invalid(format!("{key} is not valid")));
    }
    Ok(text)
}

fn require_runtime_paths(value: &Value) -> Result<Map<String, Value>> {
    let record = value
        .as_object()
        .ok_or_else(|| CoreError::invalid("runtimePaths must be an object"))?;
    for key in record.keys() {
        if !HARNESS_IDS.contains(&key.as_str()) {
            return Err(CoreError::invalid(format!(
                "Unknown runtimePaths key: {key}"
            )));
        }
    }
    let mut paths = Map::new();
    for harness in HARNESS_IDS {
        let path = record.get(harness).ok_or_else(|| {
            CoreError::invalid(format!("runtimePaths.{harness} must be a string"))
        })?;
        let path = path.as_str().ok_or_else(|| {
            CoreError::invalid(format!("runtimePaths.{harness} must be a string"))
        })?;
        if path.chars().count() > 4_096 {
            return Err(CoreError::invalid(format!(
                "runtimePaths.{harness} is out of bounds"
            )));
        }
        if !path.is_empty() && !Path::new(path).is_absolute() {
            return Err(CoreError::invalid(format!(
                "runtimePaths.{harness} must be absolute"
            )));
        }
        paths.insert(harness.to_string(), Value::String(path.to_string()));
    }
    Ok(paths)
}

fn require_last_selected_models(value: &Value) -> Result<Map<String, Value>> {
    let record = value
        .as_object()
        .ok_or_else(|| CoreError::invalid("lastSelectedModels must be an object"))?;
    for key in record.keys() {
        if !HARNESS_IDS.contains(&key.as_str()) {
            return Err(CoreError::invalid(format!(
                "Unknown lastSelectedModels key: {key}"
            )));
        }
    }
    let mut models = Map::new();
    for harness in HARNESS_IDS {
        let model = record.get(harness).and_then(Value::as_str).ok_or_else(|| {
            CoreError::invalid(format!("lastSelectedModels.{harness} must be a string"))
        })?;
        if model.chars().count() > 385 || (!model.is_empty() && !valid_model_key(model)) {
            return Err(CoreError::invalid(format!(
                "lastSelectedModels.{harness} is not a valid model key"
            )));
        }
        models.insert(harness.to_string(), Value::String(model.to_string()));
    }
    Ok(models)
}
