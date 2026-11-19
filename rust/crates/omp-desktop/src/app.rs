use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;

use gpui_kit::InteractiveElement as _;
use gpui_kit::StatefulInteractiveElement as _;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, Theme, ThemeMode};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use omp_core::agent::AgentManager;
use omp_core::geometry::{ResolvedLayout, UiGeometry};
use omp_core::git::{self, GitStatus};
use omp_core::models::CliContext;
use omp_core::plugins::{self, PluginCatalog};
use omp_core::projects::{self, ProjectRecord};
use omp_core::scheduler;
use omp_core::schedules;
use omp_core::sessions::{self, SessionRecord, TranscriptMessage, TranscriptPart};
use omp_core::settings::AppSettings;
use omp_core::state::{
    CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, Platform, StateStore,
};
use omp_core::turn_changes::{TurnBaseline, TurnChanges, compute_turn_changes};
use serde_json::{Value, json};

#[path = "browser.rs"]
mod browser;

use browser::BrowserPane;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppView {
    Workspace,
    Settings,
    Plugins,
    Schedules,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RightPane {
    Launcher,
    Summary,
    Review,
    Files,
    Browser,
    SideQuestion,
    Subagents,
}

pub struct WorkspaceData {
    pub geometry: UiGeometry,
    pub geometry_path: PathBuf,
    pub home_dir: PathBuf,
    pub user_data_dir: PathBuf,
    pub omp_executable: PathBuf,
    pub settings: AppSettings,
    pub projects: Vec<ProjectRecord>,
    pub sessions: Vec<SessionRecord>,
}

pub struct Workspace {
    geometry: UiGeometry,
    geometry_path: PathBuf,
    home_dir: PathBuf,
    user_data_dir: PathBuf,
    omp_executable: PathBuf,
    store: Option<Arc<Mutex<StateStore>>>,
    agents: AgentManager,
    runtime_id: Option<String>,
    streaming_index: Option<usize>,
    drain_task: Option<Task<()>>,
    scheduler_task: Option<Task<()>>,
    scheduled_runtimes: Vec<String>,
    layout: ResolvedLayout,
    settings: AppSettings,
    projects: Vec<ProjectRecord>,
    sessions: Vec<SessionRecord>,
    transcript: Vec<TranscriptMessage>,
    transcript_error: Option<String>,
    runtime_error: Option<String>,
    selected_session: Option<usize>,
    composer: Entity<InputState>,
    _composer_subscription: Subscription,
    submit_requested: Option<bool>,
    view: AppView,
    plugin_catalog: Option<PluginCatalog>,
    plugin_error: Option<String>,
    schedules: Vec<Value>,
    right_pane: RightPane,
    browser: BrowserPane,
    overview_open: bool,
    menu_open: bool,
    turn_changes: TurnChanges,
    turn_baseline: Option<TurnBaseline>,
    review_status: Option<GitStatus>,
    review_error: Option<String>,
    last_bounds: Option<(f32, f32, f32, f32)>,
    save_task: Option<Task<()>>,
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, data: WorkspaceData) -> Self {
        let width = f32::from(window.bounds().size.width);
        let layout = data.geometry.resolve(width as f64);
        let composer = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Ask OMP…")
                .submit_on_enter(true)
        });
        let composer_subscription = cx.subscribe(&composer, |this, _, event: &InputEvent, cx| {
            if let InputEvent::PressEnter { secondary, .. } = event {
                this.submit_requested = Some(*secondary);
                cx.notify();
            }
        });
        let store = StateStore::open(
            data.user_data_dir.join(CURRENT_DESKTOP_STATE_FILENAME),
            Some(data.user_data_dir.join(LEGACY_DESKTOP_STATE_FILENAME)),
            Platform::current(),
        )
        .ok()
        .map(|store| Arc::new(Mutex::new(store)));
        let theme_mode = match data.settings.theme {
            omp_core::settings::Theme::Light => ThemeMode::Light,
            omp_core::settings::Theme::Dark => ThemeMode::Dark,
            omp_core::settings::Theme::System => ThemeMode::from(window.appearance()),
        };
        Theme::change(theme_mode, Some(window), cx);
        let browser = BrowserPane::new(window, cx);
        let mut workspace = Self {
            geometry: data.geometry,
            geometry_path: data.geometry_path,
            home_dir: data.home_dir,
            user_data_dir: data.user_data_dir,
            omp_executable: data.omp_executable,
            store,
            agents: AgentManager::default(),
            runtime_id: None,
            streaming_index: None,
            drain_task: None,
            scheduler_task: None,
            scheduled_runtimes: Vec::new(),
            layout,
            settings: data.settings,
            projects: data.projects,
            sessions: data.sessions,
            transcript: Vec::new(),
            transcript_error: None,
            runtime_error: None,
            selected_session: None,
            composer,
            _composer_subscription: composer_subscription,
            submit_requested: None,
            view: AppView::Workspace,
            plugin_catalog: None,
            plugin_error: None,
            schedules: Vec::new(),
            right_pane: RightPane::Launcher,
            browser,
            overview_open: false,
            menu_open: false,
            turn_changes: TurnChanges::default(),
            turn_baseline: None,
            review_status: None,
            review_error: None,
            last_bounds: None,
            save_task: None,
        };
        workspace.start_scheduler(cx);
        workspace
    }

    pub fn layout(&self) -> &ResolvedLayout {
        &self.layout
    }

    pub fn transcript_messages(&self) -> &[TranscriptMessage] {
        &self.transcript
    }

    pub fn composer_entity(&self) -> &Entity<InputState> {
        &self.composer
    }

    pub fn projects(&self) -> &[ProjectRecord] {
        &self.projects
    }

    pub fn review_status(&self) -> Option<&GitStatus> {
        self.review_status.as_ref()
    }

    pub fn settings(&self) -> &AppSettings {
        &self.settings
    }

    fn track_bounds(&mut self, window: &Window, cx: &mut Context<Self>) {
        let bounds = window.bounds();
        let current = (
            f32::from(bounds.origin.x),
            f32::from(bounds.origin.y),
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
        );
        if self.last_bounds == Some(current) {
            return;
        }
        self.last_bounds = Some(current);
        self.layout = self.geometry.resolve(current.2 as f64);
        self.geometry.window_bounds = Some(omp_core::geometry::WindowBounds {
            x: current.0 as f64,
            y: current.1 as f64,
            width: current.2 as f64,
            height: current.3 as f64,
            maximized: window.is_maximized(),
        });
        let geometry = self.geometry.clone();
        let path = self.geometry_path.clone();
        self.save_task = Some(cx.spawn(async move |_this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(300))
                .await;
            let _ = geometry.save(&path);
        }));
    }

    fn schedule_geometry_save(&mut self, cx: &mut Context<Self>) {
        let geometry = self.geometry.clone();
        let path = self.geometry_path.clone();
        self.save_task = Some(cx.spawn(async move |_this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(300))
                .await;
            let _ = geometry.save(&path);
        }));
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        div()
            .flex()
            .flex_col()
            .h_full()
            .w(px(self.layout.sidebar_width as f32))
            .bg(colors.sidebar)
            .border_r_1()
            .border_color(colors.border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_3()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(28.0))
                            .rounded(px(8.0))
                            .bg(colors.accent)
                            .text_color(colors.accent_foreground)
                            .text_size(px(16.0))
                            .child(IconName::SquarePen),
                    )
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(colors.foreground)
                            .child("New session"),
                    )
                    .child(
                        div()
                            .ml_auto()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child("⌘N"),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .overflow_hidden()
                    .px_2()
                    .child(
                        div()
                            .px_2()
                            .py_1()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child("PROJECTS"),
                    )
                    .children(self.projects.iter().map(|project| {
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .text_sm()
                            .text_color(colors.foreground)
                            .child(IconName::Folder)
                            .child(project.name.clone())
                    }))
                    .child(
                        div()
                            .px_2()
                            .py_1()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child("SESSIONS"),
                    )
                    .children(self.sessions.iter().enumerate().map(|(index, session)| {
                        let selected = self.selected_session == Some(index);
                        div()
                            .id(format!("session-{index}"))
                            .aria_label(session.title.clone())
                            .flex()
                            .flex_col()
                            .gap_0p5()
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .when(selected, |element| element.bg(colors.accent))
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(colors.foreground)
                                    .child(session.title.clone()),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(colors.muted_foreground)
                                    .child(session.project_path.clone()),
                            )
                    })),
            )
            .child(
                div().border_t_1().border_color(colors.border).p_2().child(
                    div()
                        .id("schedules-nav")
                        .aria_label("Schedules")
                        .flex()
                        .items_center()
                        .gap_2()
                        .px_2()
                        .py_1()
                        .rounded(px(6.0))
                        .text_sm()
                        .text_color(colors.foreground)
                        .when(self.view == AppView::Schedules, |element| {
                            element.bg(colors.accent)
                        })
                        .hover(|style| style.bg(colors.accent))
                        .child(IconName::Clock)
                        .child("Schedules")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.set_view(AppView::Schedules, cx);
                        })),
                ),
            )
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let title = self
            .selected_session
            .and_then(|index| self.sessions.get(index))
            .map(|session| session.title.clone())
            .unwrap_or_else(|| "OMP Desktop".to_string());
        div()
            .flex()
            .items_center()
            .gap_2()
            .h(px(44.0))
            .px_3()
            .border_b_1()
            .border_color(colors.border)
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(colors.foreground)
                    .child(title),
            )
            .child(
                div()
                    .px_2()
                    .py_0p5()
                    .rounded(px(999.0))
                    .bg(colors.accent)
                    .text_xs()
                    .text_color(colors.accent_foreground)
                    .child("idle"),
            )
            .child(div().flex_1())
            .child(self.toolbar_icon(
                "session-menu",
                IconName::EllipsisVertical,
                colors.foreground,
                cx.listener(|this, _, _, cx| {
                    this.menu_open = !this.menu_open;
                    cx.notify();
                }),
            ))
            .child(self.toolbar_icon(
                "overview",
                IconName::Menu,
                colors.foreground,
                cx.listener(|this, _, _, cx| {
                    this.overview_open = !this.overview_open;
                    cx.notify();
                }),
            ))
            .child(self.toolbar_icon(
                "right-pane",
                IconName::PanelRight,
                colors.foreground,
                cx.listener(|this, _, _, cx| {
                    this.geometry.right_pane_open = !this.geometry.right_pane_open;
                    if let Some(bounds) = this.last_bounds {
                        this.layout = this.geometry.resolve(bounds.2 as f64);
                    }
                    this.schedule_geometry_save(cx);
                    cx.notify();
                }),
            ))
    }

    fn toolbar_icon(
        &self,
        id: &'static str,
        icon: IconName,
        color: gpui::Hsla,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        div()
            .id(id)
            .aria_label(id)
            .flex()
            .items_center()
            .justify_center()
            .size(px(28.0))
            .rounded(px(6.0))
            .text_size(px(16.0))
            .text_color(color)
            .hover(|style| style.bg(color.opacity(0.12)))
            .child(icon)
            .on_click(on_click)
    }

    pub fn select_session(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(runtime_id) = self.runtime_id.take() {
            self.agents.stop(&runtime_id);
        }
        self.streaming_index = None;
        self.runtime_error = None;
        self.turn_baseline = None;
        self.turn_changes = TurnChanges::default();
        self.selected_session = Some(index);
        self.transcript.clear();
        self.transcript_error = None;
        if let Some(session) = self.sessions.get(index) {
            let root = sessions::session_root(&self.home_dir);
            match sessions::read_transcript(&root, &session.file_path) {
                Ok(messages) => self.transcript = messages,
                Err(error) => self.transcript_error = Some(error.message),
            }
        }
        if self.right_pane == RightPane::Review {
            self.refresh_review();
        }
        self.ensure_runtime(cx);
        cx.notify();
    }

    pub fn add_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let _ = window;
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add project folder".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await
                && let Some(path) = paths.first().cloned()
            {
                let _ = this.update(cx, |this, cx| this.grant_project(&path, cx));
            }
        })
        .detach();
    }

    pub fn grant_project(&mut self, path: &std::path::Path, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else {
            self.transcript_error = Some("The desktop state store is unavailable.".to_string());
            cx.notify();
            return;
        };
        let mut store = store.lock().expect("state lock");
        match projects::grant_project(
            &mut store,
            &self.home_dir,
            Platform::current(),
            &path.display().to_string(),
        ) {
            Ok(_) => {
                self.projects = projects::list_projects(&store);
                self.transcript_error = None;
            }
            Err(error) => self.transcript_error = Some(error.message),
        }
        cx.notify();
    }

    fn ensure_runtime(&mut self, cx: &mut Context<Self>) {
        if self.runtime_id.is_some() {
            return;
        }
        let Some(store) = self.store.clone() else {
            return;
        };
        let Some(index) = self.selected_session else {
            return;
        };
        let Some(session) = self.sessions.get(index) else {
            return;
        };
        let cwd = session.project_path.clone();
        let session_path = session.file_path.clone();
        let context = CliContext {
            executable: self.omp_executable.clone(),
            home_dir: self.home_dir.clone(),
            root_dir: self.user_data_dir.clone(),
            extra_env: Vec::new(),
        };
        let store = store.lock().expect("state lock");
        match self.agents.start(
            &store,
            Platform::current(),
            &context,
            &json!({ "cwd": cwd, "sessionPath": session_path }),
        ) {
            Ok(info) => {
                self.runtime_id = info
                    .get("runtimeId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.start_drain(cx);
            }
            Err(error) => self.runtime_error = Some(error.message),
        }
    }

    fn start_drain(&mut self, cx: &mut Context<Self>) {
        if self.drain_task.is_some() {
            return;
        }
        self.drain_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
                if this
                    .update(cx, |this, cx| {
                        this.drain_agent_events();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    pub fn drain_agent_events(&mut self) {
        let Some(runtime_id) = self.runtime_id.clone() else {
            return;
        };
        for envelope in self.agents.drain_events(Some(&runtime_id)) {
            let event = &envelope["event"];
            match event.get("type").and_then(Value::as_str) {
                Some("message_update") => {
                    let kind = event
                        .pointer("/assistantMessageEvent/type")
                        .and_then(Value::as_str)
                        .unwrap_or("text_delta");
                    if let Some(delta) = event
                        .pointer("/assistantMessageEvent/delta")
                        .and_then(Value::as_str)
                    {
                        self.append_assistant_delta(kind, delta);
                    }
                }
                Some("agent_end") => {
                    self.streaming_index = None;
                    self.finish_turn();
                }
                Some("compaction_end") => {
                    let before = event
                        .get("result")
                        .and_then(|result| result.get("tokensBefore"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let after = event
                        .get("result")
                        .and_then(|result| result.get("tokensAfter"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    self.transcript.push(TranscriptMessage {
                        id: format!("compaction-{}", self.transcript.len()),
                        role: "system".to_string(),
                        timestamp: None,
                        agent_name: None,
                        parts: vec![TranscriptPart {
                            kind: "compaction".to_string(),
                            tokens_before: Some(before),
                            tokens_after: Some(after),
                            status: Some("done".to_string()),
                            ..TranscriptPart::text("")
                        }],
                    });
                }
                _ => {}
            }
        }
    }

    fn append_assistant_delta(&mut self, kind: &str, delta: &str) {
        let index = match self.streaming_index {
            Some(index) => index,
            None => {
                self.transcript.push(TranscriptMessage {
                    id: format!("assistant-{}", self.transcript.len()),
                    role: "assistant".to_string(),
                    timestamp: None,
                    agent_name: None,
                    parts: Vec::new(),
                });
                let index = self.transcript.len() - 1;
                self.streaming_index = Some(index);
                index
            }
        };
        let target = if kind == "thinking_delta" {
            "thinking"
        } else {
            "text"
        };
        if let Some(message) = self.transcript.get_mut(index) {
            if let Some(part) = message.parts.iter_mut().find(|part| part.kind == target) {
                let text = part.text.get_or_insert_with(String::new);
                text.push_str(delta);
            } else {
                message.parts.push(TranscriptPart {
                    kind: target.to_string(),
                    text: Some(delta.to_string()),
                    ..TranscriptPart::text("")
                });
            }
        }
    }

    pub fn send_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.send_prompt_with_action(window, cx, false);
    }

    fn send_prompt_with_action(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        follow_up: bool,
    ) {
        let text = self.composer.read(cx).value().to_string();
        if text.trim().is_empty() {
            return;
        }
        let Some(runtime_id) = self.runtime_id.clone() else {
            self.runtime_error =
                Some("Select a granted project session before sending a prompt.".to_string());
            cx.notify();
            return;
        };
        if self.turn_baseline.is_none() {
            self.turn_changes = TurnChanges::default();
            self.turn_baseline = self.capture_turn_baseline();
        }
        match self.agents.command(
            &runtime_id,
            &json!({ "type": if follow_up { "follow_up" } else { "prompt" }, "message": text }),
        ) {
            Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {}
            Ok(response) => {
                self.turn_baseline = None;
                self.runtime_error = Some(
                    response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OMP rejected the prompt")
                        .to_string(),
                );
                cx.notify();
                return;
            }
            Err(error) => {
                self.turn_baseline = None;
                self.runtime_error = Some(error.message);
                cx.notify();
                return;
            }
        }
        self.runtime_error = None;
        self.transcript.push(TranscriptMessage {
            id: format!("user-{}", self.transcript.len()),
            role: "user".to_string(),
            timestamp: None,
            agent_name: None,
            parts: vec![TranscriptPart::text(text)],
        });
        let composer = self.composer.clone();
        composer.update(cx, |state, cx| state.set_value("", window, cx));
        cx.notify();
    }

    fn transcript(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        if let Some(error) = &self.transcript_error {
            return div()
                .p_6()
                .text_sm()
                .text_color(colors.danger)
                .child(error.clone())
                .into_any_element();
        }
        if self.transcript.is_empty() {
            let text = if self.selected_session.is_some() {
                "This session has no renderable messages yet."
            } else {
                "Select a session or create a new one."
            };
            return div()
                .p_6()
                .text_sm()
                .text_color(colors.muted_foreground)
                .child(text)
                .into_any_element();
        }
        div()
            .id("transcript-scroll")
            .flex()
            .flex_col()
            .flex_1()
            .overflow_y_scroll()
            .gap_4()
            .p_6()
            .children(self.transcript.iter().map(|message| {
                let role = match message.role.as_str() {
                    "user" => "You".to_string(),
                    "assistant" => "OMP".to_string(),
                    "agent" => message
                        .agent_name
                        .clone()
                        .unwrap_or_else(|| "Agent".to_string()),
                    other => other.to_string(),
                };
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(colors.muted_foreground)
                            .child(role),
                    )
                    .children(message.parts.iter().map(|part| {
                        let text = match part.kind.as_str() {
                            "text" => part.text.clone().unwrap_or_default(),
                            "thinking" => part.text.clone().unwrap_or_default(),
                            "toolCall" => format!(
                                "⚙ {}",
                                part.name.clone().unwrap_or_else(|| "tool".to_string())
                            ),
                            "toolResult" => format!("↳ {}", part.text.clone().unwrap_or_default()),
                            "compaction" => format!(
                                "Context compacted · {} → {} tokens",
                                part.tokens_before.unwrap_or(0),
                                part.tokens_after.unwrap_or(0)
                            ),
                            "image" => "[image]".to_string(),
                            other => format!("[{other}]"),
                        };
                        div().text_sm().text_color(colors.foreground).child(text)
                    }))
            }))
            .into_any_element()
    }

    fn project_cwd(&self) -> Option<String> {
        self.selected_session
            .and_then(|index| self.sessions.get(index))
            .map(|session| session.project_path.clone())
            .or_else(|| {
                self.projects
                    .first()
                    .map(|project| project.primary_folder.clone())
            })
    }

    fn capture_turn_baseline(&self) -> Option<TurnBaseline> {
        let store = self.store.as_ref()?;
        let cwd = self.project_cwd()?;
        let store = store.lock().expect("state lock");
        let files = git::snapshot_files(&store, Platform::current(), &cwd);
        Some(TurnBaseline::capture(files))
    }

    fn finish_turn(&mut self) {
        let Some(baseline) = self.turn_baseline.take() else {
            return;
        };
        let Some(store) = self.store.clone() else {
            return;
        };
        let Some(cwd) = self.project_cwd() else {
            return;
        };
        let files = {
            let store = store.lock().expect("state lock");
            git::snapshot_files(&store, Platform::current(), &cwd)
        };
        self.turn_changes = compute_turn_changes(&baseline, files);
        self.refresh_review();
    }

    pub fn refresh_review(&mut self) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let Some(cwd) = self.project_cwd() else {
            return;
        };
        let store = store.lock().expect("state lock");
        let status = git::status(&store, Platform::current(), &cwd);
        if let Some(error) = status.error.clone() {
            self.review_error = Some(error);
            self.review_status = None;
        } else {
            self.review_error = None;
            self.review_status = Some(status);
        }
    }

    fn turn_changes_card(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        div()
            .mx_6()
            .mb_2()
            .px_3()
            .py_2()
            .rounded(px(8.0))
            .border_1()
            .border_color(colors.border)
            .bg(colors.background)
            .flex()
            .items_center()
            .gap_2()
            .child(
                div()
                    .text_xs()
                    .text_color(colors.foreground)
                    .child(format!("{} file(s) changed", self.turn_changes.files.len())),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(colors.success)
                    .child(format!("+{}", self.turn_changes.additions)),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(colors.danger)
                    .child(format!("-{}", self.turn_changes.deletions)),
            )
            .child(div().flex_1())
            .child(
                div()
                    .id("turn-review")
                    .aria_label("Review this turn's changes")
                    .px_2()
                    .py_0p5()
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(colors.border)
                    .text_xs()
                    .text_color(colors.foreground)
                    .child("📄+ Review")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.right_pane = RightPane::Review;
                        this.geometry.right_pane_open = true;
                        if let Some(bounds) = this.last_bounds {
                            this.layout = this.geometry.resolve(bounds.2 as f64);
                        }
                        this.refresh_review();
                        cx.notify();
                    })),
            )
    }

    fn composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_4()
            .border_t_1()
            .border_color(colors.border)
            .when(self.runtime_error.is_some(), |element| {
                element.child(
                    div()
                        .text_xs()
                        .text_color(colors.danger)
                        .child(self.runtime_error.clone().unwrap_or_default()),
                )
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().flex_1().child(Input::new(&self.composer)))
                    .child(
                        div()
                            .id("send-prompt")
                            .aria_label("Send prompt")
                            .px_3()
                            .py_1()
                            .rounded(px(6.0))
                            .bg(colors.primary)
                            .text_color(colors.primary_foreground)
                            .text_sm()
                            .child("Send")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.send_prompt(window, cx)),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child("Enter to send · Ctrl+Enter to follow up")
                    .child(div().flex_1())
                    .child({
                        let model = self.settings.last_selected_model();
                        if model.is_empty() {
                            "Model: auto".to_string()
                        } else {
                            format!("Model: {model}")
                        }
                    }),
            )
    }

    pub fn set_view(&mut self, view: AppView, cx: &mut Context<Self>) {
        self.view = view;
        if view == AppView::Schedules {
            self.refresh_schedules();
        }
        cx.notify();
    }

    pub fn refresh_schedules(&mut self) {
        self.schedules = match self.store.as_ref() {
            Some(store) => {
                let store = store.lock().expect("state lock");
                schedules::list(&store)
            }
            None => Vec::new(),
        };
    }

    pub fn schedules(&self) -> &[Value] {
        &self.schedules
    }

    pub fn set_schedule_status(&mut self, id: &str, status: &str, cx: &mut Context<Self>) {
        if let Some(store) = self.store.clone() {
            let mut store = store.lock().expect("state lock");
            let _ = schedules::set_status(&mut store, id, status);
        }
        self.refresh_schedules();
        cx.notify();
    }

    pub fn delete_schedule(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(store) = self.store.clone() {
            let mut store = store.lock().expect("state lock");
            let _ = schedules::delete(&mut store, id);
        }
        self.refresh_schedules();
        cx.notify();
    }

    fn start_scheduler(&mut self, cx: &mut Context<Self>) {
        if self.scheduler_task.is_some() {
            return;
        }
        self.scheduler_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_secs(30))
                    .await;
                if this
                    .update(cx, |this, cx| {
                        this.run_due_schedules(cx);
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    fn run_due_schedules(&mut self, cx: &mut Context<Self>) {
        self.drain_scheduled_runtimes();
        let Some(store) = self.store.clone() else {
            return;
        };
        let now = Utc::now();
        let due = {
            let store = store.lock().expect("state lock");
            scheduler::due(&store, now)
        };
        if due.is_empty() {
            return;
        }
        let context = CliContext {
            executable: self.omp_executable.clone(),
            home_dir: self.home_dir.clone(),
            root_dir: self.user_data_dir.clone(),
            extra_env: Vec::new(),
        };
        for schedule in due.into_iter().take(2) {
            let scheduled_for = schedule.next_run_at.clone().unwrap_or_default();
            let Some(project) = self
                .projects
                .iter()
                .find(|project| project.id == schedule.target.project_id)
                .cloned()
            else {
                self.record_schedule_outcome(
                    &store,
                    &schedule.id,
                    &scheduled_for,
                    "failed",
                    None,
                    Some("Schedule target project is not loaded".to_string()),
                );
                continue;
            };
            let session = schedule
                .target
                .session_id
                .as_ref()
                .and_then(|id| self.sessions.iter().find(|session| session.id == *id))
                .cloned();
            let cwd = session
                .as_ref()
                .map(|session| session.project_path.clone())
                .unwrap_or_else(|| project.primary_folder.clone());
            let mut params = json!({ "cwd": cwd });
            if let Some(session) = &session {
                params["sessionPath"] = json!(session.file_path);
            }
            if !schedule.execution.model.is_empty() {
                params["model"] = json!(schedule.execution.model);
            }
            if !schedule.execution.thinking.is_empty() {
                params["thinking"] = json!(schedule.execution.thinking);
            }
            let started = {
                let store = store.lock().expect("state lock");
                self.agents
                    .start(&store, Platform::current(), &context, &params)
            };
            match started {
                Ok(info) => {
                    let runtime_id = info
                        .get("runtimeId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let command = runtime_id.as_deref().map(|runtime_id| {
                        self.agents.command(
                            runtime_id,
                            &json!({ "type": "prompt", "message": schedule.prompt }),
                        )
                    });
                    let (status, error) = match command {
                        Some(Ok(response))
                            if response.get("success").and_then(Value::as_bool) == Some(true) =>
                        {
                            ("running".to_string(), None)
                        }
                        Some(Ok(response)) => (
                            "failed".to_string(),
                            Some(
                                response
                                    .pointer("/error/message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("OMP rejected the scheduled prompt")
                                    .to_string(),
                            ),
                        ),
                        Some(Err(error)) => ("failed".to_string(), Some(error.message)),
                        None => (
                            "failed".to_string(),
                            Some("The scheduled runtime did not return an id".to_string()),
                        ),
                    };
                    if status == "failed"
                        && let Some(runtime_id) = runtime_id.as_deref()
                    {
                        self.agents.stop(runtime_id);
                    } else if let Some(runtime_id) = runtime_id.as_deref() {
                        self.scheduled_runtimes.push(runtime_id.to_string());
                    }
                    self.record_schedule_outcome(
                        &store,
                        &schedule.id,
                        &scheduled_for,
                        &status,
                        runtime_id,
                        error,
                    );
                }
                Err(error) => {
                    self.record_schedule_outcome(
                        &store,
                        &schedule.id,
                        &scheduled_for,
                        "failed",
                        None,
                        Some(error.message),
                    );
                }
            }
        }
        if self.view == AppView::Schedules {
            self.refresh_schedules();
        }
        cx.notify();
    }

    fn drain_scheduled_runtimes(&mut self) {
        let mut active = Vec::new();
        for runtime_id in std::mem::take(&mut self.scheduled_runtimes) {
            let events = self.agents.drain_events(Some(&runtime_id));
            let ended = events.iter().any(|envelope| {
                envelope.pointer("/event/type").and_then(Value::as_str) == Some("agent_end")
            });
            if ended {
                self.agents.stop(&runtime_id);
            } else {
                active.push(runtime_id);
            }
        }
        while active.len() > 8 {
            let runtime_id = active.remove(0);
            self.agents.stop(&runtime_id);
        }
        self.scheduled_runtimes = active;
    }

    fn record_schedule_outcome(
        &self,
        store: &Arc<Mutex<StateStore>>,
        id: &str,
        scheduled_for: &str,
        status: &str,
        session_id: Option<String>,
        error: Option<String>,
    ) {
        let now = Utc::now();
        let outcome = scheduler::ScheduleRunOutcome {
            status: status.to_string(),
            session_id,
            error,
        };
        let mut store = store.lock().expect("state lock");
        let _ = scheduler::record(&mut store, id, scheduled_for, &outcome, now);
    }

    pub fn update_setting(&mut self, patch: Value, cx: &mut Context<Self>) {
        if let Some(store) = self.store.clone() {
            let mut store = store.lock().expect("state lock");
            if let Ok(next) = store.update_settings(&patch) {
                self.settings = next;
            }
        }
        cx.notify();
    }

    fn settings_row(
        &self,
        label: &'static str,
        value: String,
        colors: gpui_kit::component::ThemeColor,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        div()
            .id(label)
            .aria_label(label)
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .rounded(px(8.0))
            .border_1()
            .border_color(colors.border)
            .text_sm()
            .text_color(colors.foreground)
            .hover(|style| style.bg(colors.accent))
            .child(label)
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(value),
            )
            .on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
    }

    fn schedules_page(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        self.refresh_schedules();
        let store_available = self.store.is_some();
        let rows = self
            .schedules
            .iter()
            .map(|schedule| {
                let id = schedule
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let title = schedule
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Untitled schedule")
                    .to_string();
                let project = schedule
                    .pointer("/target/projectId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let next_run = schedule
                    .get("nextRunAt")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let status = schedule
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let last_run = schedule
                    .get("runs")
                    .and_then(Value::as_array)
                    .and_then(|runs| runs.last())
                    .map(|run| {
                        let status = run
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        match run.get("error").and_then(Value::as_str) {
                            Some(error) => format!("Last run: {status} · {error}"),
                            None => format!("Last run: {status}"),
                        }
                    });
                (id, title, project, next_run, status, last_run)
            })
            .collect::<Vec<_>>();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .h_full()
            .p_6()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .id("schedules-back")
                            .aria_label("Back to workspace")
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child("‹ Workspace")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.view = AppView::Workspace;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .text_lg()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Schedules"),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("schedules-refresh")
                            .aria_label("Refresh schedules")
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .child("Refresh")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.refresh_schedules();
                                cx.notify();
                            })),
                    ),
            )
            .when(!store_available, |element| {
                element.child(
                    div()
                        .text_sm()
                        .text_color(colors.muted_foreground)
                        .child("The desktop state store is unavailable."),
                )
            })
            .when(store_available && rows.is_empty(), |element| {
                element.child(
                    div()
                        .text_sm()
                        .text_color(colors.muted_foreground)
                        .child("No scheduled work yet."),
                )
            })
            .children(
                rows.into_iter()
                    .map(|(id, title, project, next_run, status, last_run)| {
                        let active = status == "active";
                        let status_color = match status.as_str() {
                            "active" => colors.success,
                            "blocked" => colors.danger,
                            _ => colors.muted_foreground,
                        };
                        let toggle_label = if active { "Pause" } else { "Resume" };
                        let toggle_status = if active { "paused" } else { "active" };
                        let toggle_id = format!("schedule-toggle-{id}");
                        let delete_id = format!("schedule-delete-{id}");
                        let toggle_schedule = id.clone();
                        let delete_schedule = id.clone();
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .px_3()
                            .py_2()
                            .rounded(px(8.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_sm()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .font_weight(gpui::FontWeight::MEDIUM)
                                            .text_color(colors.foreground)
                                            .child(title),
                                    )
                                    .child(div().flex_1())
                                    .child(div().text_xs().text_color(status_color).child(status)),
                            )
                            .child(div().text_xs().text_color(colors.muted_foreground).child(
                                if project.is_empty() {
                                    "Project —".to_string()
                                } else {
                                    format!("Project {project}")
                                },
                            ))
                            .child(div().text_xs().text_color(colors.muted_foreground).child(
                                match next_run {
                                    Some(at) => format!("Next run {at}"),
                                    None => "Next run —".to_string(),
                                },
                            ))
                            .children(last_run.map(|last_run| {
                                div()
                                    .text_xs()
                                    .text_color(colors.muted_foreground)
                                    .child(last_run)
                            }))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .id(toggle_id)
                                            .aria_label(toggle_label)
                                            .px_2()
                                            .py_1()
                                            .rounded(px(6.0))
                                            .border_1()
                                            .border_color(colors.border)
                                            .text_xs()
                                            .text_color(colors.foreground)
                                            .hover(|style| style.bg(colors.accent))
                                            .child(toggle_label)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.set_schedule_status(
                                                    &toggle_schedule,
                                                    toggle_status,
                                                    cx,
                                                );
                                            })),
                                    )
                                    .child(
                                        div()
                                            .id(delete_id)
                                            .aria_label("Delete")
                                            .px_2()
                                            .py_1()
                                            .rounded(px(6.0))
                                            .border_1()
                                            .border_color(colors.border)
                                            .text_xs()
                                            .text_color(colors.danger)
                                            .hover(|style| style.bg(colors.accent))
                                            .child("Delete")
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.delete_schedule(&delete_schedule, cx);
                                            })),
                                    ),
                            )
                    }),
            )
    }

    pub fn refresh_plugins(&mut self) {
        let agent_dir = self.home_dir.join(".omp").join("agent");
        let project = self.project_cwd().map(std::path::PathBuf::from);
        self.plugin_catalog = Some(plugins::discover(&agent_dir, project.as_deref()));
        self.plugin_error = None;
    }

    pub fn plugin_catalog(&self) -> Option<&PluginCatalog> {
        self.plugin_catalog.as_ref()
    }

    fn plugins_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let catalog = self.plugin_catalog.as_ref();
        let warnings = catalog
            .map(|catalog| catalog.warnings.clone())
            .unwrap_or_default();
        let skills = catalog
            .map(|catalog| {
                catalog
                    .skills
                    .iter()
                    .filter(|skill| skill.kind == "skill")
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let packages = catalog
            .map(|catalog| {
                catalog
                    .skills
                    .iter()
                    .filter(|skill| skill.kind == "package")
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mcp = catalog
            .map(|catalog| {
                catalog
                    .skills
                    .iter()
                    .filter(|skill| skill.kind == "mcp")
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .h_full()
            .p_6()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .id("plugins-back")
                            .aria_label("Back to workspace")
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child("‹ Workspace")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.view = AppView::Workspace;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .text_lg()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Extensions"),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("plugins-refresh")
                            .aria_label("Refresh extensions")
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .child("Refresh")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.refresh_plugins();
                                cx.notify();
                            })),
                    ),
            )
            .when(!warnings.is_empty(), |element| {
                element.children(warnings.into_iter().map(|warning| {
                    div()
                        .px_3()
                        .py_2()
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(colors.danger)
                        .text_xs()
                        .text_color(colors.danger)
                        .child(warning.message)
                }))
            })
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child("SKILLS"),
            )
            .children(skills.into_iter().map(|skill| {
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(colors.border)
                    .text_sm()
                    .child(skill.name)
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child(skill.location),
                    )
            }))
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child("PACKAGES"),
            )
            .children(packages.into_iter().map(|package| {
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(colors.border)
                    .text_sm()
                    .child(package.name)
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child(package.location),
                    )
            }))
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child("MCP SERVERS"),
            )
            .children(mcp.into_iter().map(|server| {
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(colors.border)
                    .text_sm()
                    .child(server.name)
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(if server.enabled {
                                colors.success
                            } else {
                                colors.muted_foreground
                            })
                            .child(if server.enabled {
                                "enabled"
                            } else {
                                "disabled"
                            }),
                    )
            }))
            .when(
                catalog
                    .map(|catalog| catalog.skills.is_empty())
                    .unwrap_or(true),
                |element| {
                    element.child(
                        div()
                            .text_sm()
                            .text_color(colors.muted_foreground)
                            .child("No extensions discovered for this project."),
                    )
                },
            )
    }

    fn settings_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let theme = match self.settings.theme {
            omp_core::settings::Theme::System => "system",
            omp_core::settings::Theme::Light => "light",
            omp_core::settings::Theme::Dark => "dark",
        };
        let density = match self.settings.conversation_density {
            omp_core::settings::ConversationDensity::Compact => "compact",
            omp_core::settings::ConversationDensity::Comfortable => "comfortable",
        };
        let enter = match self.settings.message_enter_action {
            omp_core::settings::MessageEnterAction::Steer => "steer",
            omp_core::settings::MessageEnterAction::Queue => "queue",
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .h_full()
            .p_6()
            .gap_4()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .id("settings-back")
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child("‹ Workspace")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.view = AppView::Workspace;
                                cx.notify();
                            })),
                    )
                    .child(div().text_lg().font_weight(gpui::FontWeight::SEMIBOLD).child("Settings")),
            )
            .child(div().text_xs().text_color(colors.muted_foreground).child("APPEARANCE"))
            .child(self.settings_row("Theme", theme.to_string(), colors, cx, |this, window, cx| {
                let (next, mode) = match this.settings.theme {
                    omp_core::settings::Theme::System => ("light", ThemeMode::Light),
                    omp_core::settings::Theme::Light => ("dark", ThemeMode::Dark),
                    omp_core::settings::Theme::Dark => ("system", ThemeMode::from(window.appearance())),
                };
                this.update_setting(json!({ "theme": next }), cx);
                Theme::change(mode, Some(window), cx);
            }))
            .child(self.settings_row("Accent", self.settings.accent_color.clone(), colors, cx, |this, _window, cx| {
                let colors = ["prime", "blue", "teal", "green", "orange", "pink"];
                let index = colors.iter().position(|color| *color == this.settings.accent_color).unwrap_or(0);
                let next = colors[(index + 1) % colors.len()];
                this.update_setting(json!({ "accentColor": next }), cx);
            }))
            .child(self.settings_row("Interface font scale", format!("{}%", self.settings.interface_font_scale), colors, cx, |this, _window, cx| {
                let next = match this.settings.interface_font_scale {
                    105 => 110,
                    110 => 115,
                    _ => 105,
                };
                this.update_setting(json!({ "interfaceFontScale": next }), cx);
            }))
            .child(self.settings_row("Conversation density", density.to_string(), colors, cx, |this, _window, cx| {
                let next = if this.settings.conversation_density == omp_core::settings::ConversationDensity::Compact {
                    "comfortable"
                } else {
                    "compact"
                };
                this.update_setting(json!({ "conversationDensity": next }), cx);
            }))
            .child(div().text_xs().text_color(colors.muted_foreground).child("CONVERSATION"))
            .child(self.settings_row("Enter sends", enter.to_string(), colors, cx, |this, _window, cx| {
                let next = if this.settings.message_enter_action == omp_core::settings::MessageEnterAction::Steer {
                    "queue"
                } else {
                    "steer"
                };
                this.update_setting(json!({ "messageEnterAction": next }), cx);
            }))
            .child(self.settings_row("Idle session timeout", format!("{} min", self.settings.idle_session_minutes), colors, cx, |this, _window, cx| {
                let next = match this.settings.idle_session_minutes {
                    0 => 5,
                    5 => 15,
                    15 => 30,
                    _ => 0,
                };
                this.update_setting(json!({ "idleSessionMinutes": next }), cx);
            }))
            .child(div().text_xs().text_color(colors.muted_foreground).child("VOICE"))
            .child(
                div()
                    .px_3()
                    .py_2()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(colors.border)
                    .text_sm()
                    .text_color(colors.muted_foreground)
                    .child("Voice is configured by the OMP CLI. Set stt.* or live.* with omp config; the composer reads that state when dictation is enabled."),
            )
            .child(div().text_xs().text_color(colors.muted_foreground).child("ABOUT"))
            .child(
                div()
                    .px_3()
                    .py_2()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(colors.border)
                    .text_sm()
                    .child(format!("OMP Desktop {} · Rust/GPUI", env!("CARGO_PKG_VERSION"))),
            )
    }

    fn right_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let items = [
            (RightPane::Summary, "Summary", IconName::FileText),
            (RightPane::Review, "Review", IconName::GitBranch),
            (RightPane::Files, "Files", IconName::Folder),
            (RightPane::Browser, "Browser", IconName::Globe),
            (
                RightPane::SideQuestion,
                "Side Question",
                IconName::MessageSquare,
            ),
            (RightPane::Subagents, "Subagents", IconName::Bot),
        ];
        let content = match self.right_pane {
            RightPane::Launcher => None,
            RightPane::Summary => Some(self.summary_content(cx).into_any_element()),
            RightPane::Review => Some(self.review_content(cx).into_any_element()),
            RightPane::Browser => Some(self.browser.content(cx).into_any_element()),
            other => Some(self.placeholder_content(other, cx).into_any_element()),
        };
        let title = match self.right_pane {
            RightPane::Launcher => "Overview",
            RightPane::Summary => "Summary",
            RightPane::Review => "Review",
            RightPane::Files => "Files",
            RightPane::Browser => "Browser",
            RightPane::SideQuestion => "Side Question",
            RightPane::Subagents => "Subagents",
        };
        div()
            .flex()
            .flex_col()
            .h_full()
            .w(px(if self.layout.right_pane_docked {
                self.layout.right_pane_width
            } else {
                omp_core::geometry::clamp_right_pane(self.geometry.right_pane_width)
            } as f32))
            .bg(colors.sidebar)
            .border_l_1()
            .border_color(colors.border)
            .p_3()
            .gap_1()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_2()
                    .rounded(px(8.0))
                    .bg(colors.background)
                    .border_1()
                    .border_color(colors.border)
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(IconName::Search)
                    .child("Search or enter a URL"),
            )
            .when(self.right_pane != RightPane::Launcher, |element| {
                element.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .px_2()
                        .py_1()
                        .text_sm()
                        .text_color(colors.foreground)
                        .child(
                            div()
                                .id("right-pane-back")
                                .px_2()
                                .rounded(px(6.0))
                                .text_xs()
                                .text_color(colors.muted_foreground)
                                .hover(|style| style.bg(colors.accent))
                                .child("‹ Back")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.right_pane = RightPane::Launcher;
                                    cx.notify();
                                })),
                        )
                        .child(title),
                )
            })
            .children(content)
            .when(self.right_pane == RightPane::Launcher, |element| {
                element.children(items.into_iter().map(|(pane, label, icon)| {
                    let selected = self.right_pane == pane;
                    div()
                        .id(label)
                        .aria_label(label)
                        .flex()
                        .items_center()
                        .gap_2()
                        .px_2()
                        .py_1p5()
                        .rounded(px(6.0))
                        .text_sm()
                        .text_color(colors.foreground)
                        .when(selected, |element| element.bg(colors.accent))
                        .child(icon)
                        .child(label)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.right_pane = pane;
                            if pane == RightPane::Review {
                                this.refresh_review();
                            }
                            if pane == RightPane::Browser {
                                this.browser.ensure(window, cx);
                            }
                            cx.notify();
                        }))
                }))
            })
            .child(div().h(px(1.0)).my_2().bg(colors.border))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .text_sm()
                    .text_color(colors.foreground)
                    .child(IconName::Activity)
                    .child("Background Tasks")
                    .child(div().flex_1())
                    .child(
                        div()
                            .px_2()
                            .rounded(px(999.0))
                            .bg(colors.accent)
                            .text_xs()
                            .child("0"),
                    ),
            )
    }

    fn summary_content(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let (title, project, status) = self
            .selected_session
            .and_then(|index| self.sessions.get(index))
            .map(|session| {
                (
                    session.title.clone(),
                    session.project_path.clone(),
                    session.status.clone(),
                )
            })
            .unwrap_or_else(|| {
                (
                    "No session selected".to_string(),
                    String::new(),
                    "idle".to_string(),
                )
            });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(colors.foreground)
                    .child(title),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(project),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child("Status")
                    .child(
                        div()
                            .px_2()
                            .rounded(px(999.0))
                            .bg(colors.accent)
                            .child(status),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child("todoPhases"),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(colors.foreground)
                    .child("No plan items yet."),
            )
    }

    fn review_content(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        if let Some(error) = &self.review_error {
            return div()
                .p_2()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    div()
                        .text_sm()
                        .text_color(colors.danger)
                        .child(error.clone()),
                )
                .child(
                    div()
                        .id("review-refresh")
                        .px_2()
                        .py_1()
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(colors.border)
                        .text_xs()
                        .child("Refresh")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.refresh_review();
                            cx.notify();
                        })),
                );
        }
        let Some(status) = &self.review_status else {
            return div()
                .p_2()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    div()
                        .text_xs()
                        .text_color(colors.muted_foreground)
                        .child("Load the current branch and changed files."),
                )
                .child(
                    div()
                        .id("review-load")
                        .px_2()
                        .py_1()
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(colors.border)
                        .text_xs()
                        .child("Refresh")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.refresh_review();
                            cx.notify();
                        })),
                );
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(format!(
                        "Branch: {}",
                        status
                            .branch
                            .clone()
                            .unwrap_or_else(|| "detached".to_string())
                    ))
                    .child(format!("{} changed", status.files.len())),
            )
            .children(status.files.iter().map(|file| {
                let path = file.path.clone();
                let staged = file.staged;
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .hover(|style| style.bg(colors.accent))
                    .child(
                        div()
                            .text_sm()
                            .text_color(colors.foreground)
                            .child(path.clone()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(if staged {
                                colors.success
                            } else {
                                colors.muted_foreground
                            })
                            .child(if staged { "staged" } else { "unstaged" }),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id(format!("toggle-{path}"))
                            .aria_label(if staged { "Unstage file" } else { "Stage file" })
                            .px_2()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .child(if staged { "Unstage" } else { "Stage" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.stage_path(&path, !staged, cx);
                            })),
                    )
            }))
    }

    fn placeholder_content(&self, pane: RightPane, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let label = match pane {
            RightPane::Files => "Files",
            RightPane::Browser => "Browser",
            RightPane::SideQuestion => "Side Question",
            RightPane::Subagents => "Subagents",
            _ => "Panel",
        };
        div()
            .p_2()
            .text_sm()
            .text_color(colors.muted_foreground)
            .child(format!("{label} is not wired to a native view yet."))
    }

    pub fn stage_path(&mut self, path: &str, staged: bool, cx: &mut Context<Self>) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let Some(cwd) = self.project_cwd() else {
            return;
        };
        let store = store.lock().expect("state lock");
        let result = if staged {
            git::stage(&store, Platform::current(), &cwd, &[path.to_string()])
        } else {
            git::unstage(&store, Platform::current(), &cwd, &[path.to_string()])
        };
        drop(store);
        match result {
            Ok(true) => self.refresh_review(),
            Ok(false) => self.review_error = Some("Git rejected the stage request.".to_string()),
            Err(error) => self.review_error = Some(error.message),
        }
        cx.notify();
    }

    pub fn session_menu_action(&mut self, action: &str, cx: &mut Context<Self>) {
        let Some(index) = self.selected_session else {
            return;
        };
        let Some(store) = self.store.clone() else {
            return;
        };
        let file = self.sessions[index].file_path.clone();
        let pinned = self.sessions[index].pinned;
        let root = sessions::session_root(&self.home_dir);
        let mut store = store.lock().expect("state lock");
        match action {
            "Pin" => {
                let _ = sessions::set_pinned(&mut store, &root, &file, !pinned);
            }
            "Archive" => {
                let _ = sessions::set_archived(&mut store, &root, &file, true);
            }
            "Delete" => {
                let _ = sessions::delete_session(&mut store, &root, &file);
                self.selected_session = None;
                self.transcript.clear();
            }
            _ => {}
        }
        self.sessions = sessions::list_sessions(&store, &self.home_dir, false, None);
        drop(store);
        self.menu_open = false;
        cx.notify();
    }

    fn overview_popover(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        div()
            .absolute()
            .top(px(48.0))
            .right(px(48.0))
            .w(px(220.0))
            .rounded(px(10.0))
            .border_1()
            .border_color(colors.border)
            .bg(colors.sidebar)
            .p_2()
            .gap_1()
            .flex()
            .flex_col()
            .text_sm()
            .child(
                div()
                    .px_2()
                    .py_1()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child("Overview"),
            )
            .children(
                [
                    ("Summary", "summary"),
                    ("Review", "review"),
                    ("Files", "files"),
                    ("Browser", "browser"),
                    ("Side Question", "side-question"),
                    ("Subagents", "subagents"),
                ]
                .into_iter()
                .map(|(label, id)| {
                    div()
                        .id(id)
                        .px_2()
                        .py_1()
                        .rounded(px(6.0))
                        .hover(|style| style.bg(colors.accent))
                        .child(label)
                }),
            )
            .child(div().h(px(1.0)).my_1().bg(colors.border))
            .child(div().px_2().py_1().child("Background Tasks"))
    }

    fn session_menu(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        div()
            .absolute()
            .top(px(48.0))
            .right(px(12.0))
            .w(px(220.0))
            .rounded(px(10.0))
            .border_1()
            .border_color(colors.border)
            .bg(colors.sidebar)
            .p_2()
            .gap_1()
            .flex()
            .flex_col()
            .text_sm()
            .children(
                ["Rename", "Pin", "Archive", "Delete", "Remote Control"]
                    .into_iter()
                    .map(|label| {
                        div()
                            .id(format!("session-action-{label}"))
                            .aria_label(label)
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .hover(|style| style.bg(colors.accent))
                            .child(label)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.session_menu_action(label, cx);
                            }))
                    }),
            )
            .child(div().h(px(1.0)).my_1().bg(colors.border))
            .children(
                [
                    "Session Tree",
                    "Fork / Split ›",
                    "Copy ›",
                    "Project Scripts ›",
                ]
                .into_iter()
                .map(|label| {
                    div()
                        .px_2()
                        .py_1()
                        .rounded(px(6.0))
                        .hover(|style| style.bg(colors.accent))
                        .child(label)
                }),
            )
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(follow_up) = self.submit_requested.take() {
            cx.defer_in(window, move |this, window, cx| {
                this.send_prompt_with_action(window, cx, follow_up);
            });
        }
        self.track_bounds(window, cx);
        let colors = cx.theme().colors;
        let show_sidebar = self.layout.sidebar_docked;
        let show_right = self.layout.right_pane_docked;
        // A native webview keeps its last frame when the pane stops rendering, and on Windows
        // it covers everything in its bounds, so it is shown only while the pane is on screen.
        let browser_visible =
            self.view == AppView::Workspace && show_right && self.right_pane == RightPane::Browser;
        self.browser.set_visible(browser_visible, cx);
        if browser_visible {
            if self.browser.needs_webview() {
                cx.defer_in(window, |this, window, cx| {
                    this.browser.ensure(window, cx);
                    cx.notify();
                });
            }
            if self.browser.take_navigate_request() {
                cx.defer_in(window, |this, window, cx| this.browser.submit(window, cx));
            }
        } else {
            // Leaving the pane discards a pending address submission.
            let _ = self.browser.take_navigate_request();
        }
        if self.view == AppView::Settings {
            return div()
                .flex()
                .flex_row()
                .size_full()
                .bg(colors.background)
                .text_color(colors.foreground)
                .when(show_sidebar, |element| element.child(self.sidebar(cx)))
                .child(self.settings_page(cx));
        }
        if self.view == AppView::Plugins {
            return div()
                .flex()
                .flex_row()
                .size_full()
                .bg(colors.background)
                .text_color(colors.foreground)
                .when(show_sidebar, |element| element.child(self.sidebar(cx)))
                .child(self.plugins_page(cx));
        }
        if self.view == AppView::Schedules {
            return div()
                .flex()
                .flex_row()
                .size_full()
                .bg(colors.background)
                .text_color(colors.foreground)
                .when(show_sidebar, |element| element.child(self.sidebar(cx)))
                .child(self.schedules_page(cx));
        }
        div()
            .relative()
            .flex()
            .flex_row()
            .size_full()
            .bg(colors.background)
            .text_color(colors.foreground)
            .when(show_sidebar, |element| element.child(self.sidebar(cx)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .h_full()
                    .min_w(px(360.0))
                    .child(self.toolbar(cx))
                    .child(self.transcript(cx))
                    .when(!self.turn_changes.is_empty(), |element| {
                        element.child(self.turn_changes_card(cx))
                    })
                    .child(self.composer(cx)),
            )
            .when(show_right, |element| element.child(self.right_pane(cx)))
            .when(self.overview_open && !browser_visible, |element| {
                element.child(self.overview_popover(cx))
            })
            .when(self.menu_open && !browser_visible, |element| {
                element.child(self.session_menu(cx))
            })
    }
}
