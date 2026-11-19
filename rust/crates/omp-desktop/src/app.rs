use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::component::ActiveTheme;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use omp_core::agent::AgentManager;
use omp_core::geometry::{ResolvedLayout, UiGeometry};
use omp_core::git::{self, GitStatus};
use omp_core::models::CliContext;
use omp_core::projects::{self, ProjectRecord};
use omp_core::sessions::{self, SessionRecord, TranscriptMessage, TranscriptPart};
use omp_core::settings::AppSettings;
use omp_core::state::{
    CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, Platform, StateStore,
};
use omp_core::turn_changes::{TurnBaseline, TurnChanges, compute_turn_changes};
use serde_json::{Value, json};

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
    layout: ResolvedLayout,
    settings: AppSettings,
    projects: Vec<ProjectRecord>,
    sessions: Vec<SessionRecord>,
    transcript: Vec<TranscriptMessage>,
    transcript_error: Option<String>,
    selected_session: Option<usize>,
    composer: Entity<InputState>,
    right_pane: RightPane,
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
        let composer = cx.new(|cx| InputState::new(window, cx).placeholder("Ask OMP…"));
        let store = StateStore::open(
            data.user_data_dir.join(CURRENT_DESKTOP_STATE_FILENAME),
            Some(data.user_data_dir.join(LEGACY_DESKTOP_STATE_FILENAME)),
            Platform::current(),
        )
        .ok()
        .map(|store| Arc::new(Mutex::new(store)));
        Self {
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
            layout,
            settings: data.settings,
            projects: data.projects,
            sessions: data.sessions,
            transcript: Vec::new(),
            transcript_error: None,
            selected_session: None,
            composer,
            right_pane: RightPane::Launcher,
            overview_open: false,
            menu_open: false,
            turn_changes: TurnChanges::default(),
            turn_baseline: None,
            review_status: None,
            review_error: None,
            last_bounds: None,
            save_task: None,
        }
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
            maximized: false,
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
            Err(error) => self.transcript_error = Some(error.message),
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
                    if let Some(delta) = event
                        .pointer("/assistantMessageEvent/delta")
                        .and_then(Value::as_str)
                    {
                        self.append_assistant_delta(delta);
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

    fn append_assistant_delta(&mut self, delta: &str) {
        let index = match self.streaming_index {
            Some(index) => index,
            None => {
                self.transcript.push(TranscriptMessage {
                    id: format!("assistant-{}", self.transcript.len()),
                    role: "assistant".to_string(),
                    timestamp: None,
                    agent_name: None,
                    parts: vec![TranscriptPart::text("")],
                });
                let index = self.transcript.len() - 1;
                self.streaming_index = Some(index);
                index
            }
        };
        if let Some(message) = self.transcript.get_mut(index)
            && let Some(part) = message.parts.first_mut()
        {
            let text = part.text.get_or_insert_with(String::new);
            text.push_str(delta);
        }
    }

    pub fn send_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().to_string();
        if text.trim().is_empty() {
            return;
        }
        let Some(runtime_id) = self.runtime_id.clone() else {
            self.transcript_error =
                Some("Select a granted project session before sending a prompt.".to_string());
            cx.notify();
            return;
        };
        if self.turn_baseline.is_none() {
            self.turn_baseline = self.capture_turn_baseline();
        }
        if let Err(error) = self
            .agents
            .command(&runtime_id, &json!({ "type": "prompt", "message": text }))
        {
            self.transcript_error = Some(error.message);
            cx.notify();
            return;
        }
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
                .child(error.clone());
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
                .child(text);
        }
        div()
            .flex()
            .flex_col()
            .flex_1()
            .overflow_hidden()
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
        (!files.is_empty()).then(|| TurnBaseline::capture(files))
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
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().flex_1().child(Input::new(&self.composer)))
                    .child(
                        div()
                            .id("send-prompt")
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
                    .child("Enter to steer · Ctrl+Enter to queue")
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
            .w(px(self.layout.right_pane_width as f32))
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
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.right_pane = pane;
                            if pane == RightPane::Review {
                                this.refresh_review();
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
        if let Err(error) = result {
            self.review_error = Some(error.message);
        } else {
            self.refresh_review();
        }
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
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .hover(|style| style.bg(colors.accent))
                            .child(label)
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
        self.track_bounds(window, cx);
        let colors = cx.theme().colors;
        let show_sidebar = self.layout.sidebar_docked;
        let show_right = self.layout.right_pane_docked;
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
            .when(self.overview_open, |element| {
                element.child(self.overview_popover(cx))
            })
            .when(self.menu_open, |element| {
                element.child(self.session_menu(cx))
            })
    }
}
