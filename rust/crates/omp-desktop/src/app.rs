use crate::i18n::{self, Language};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};

use crate::ime::CompositionGuard;
use gpui_kit::InteractiveElement as _;
use gpui_kit::StatefulInteractiveElement as _;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, Theme, ThemeColor, ThemeMode};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use omp_core::agent::AgentManager;
use omp_core::geometry::{
    CENTER_MIN_WIDTH, CollapsedPane, ResolvedLayout, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH,
    UiGeometry,
};
use omp_core::git::{self, GitStatus};
use omp_core::models::{self, CliContext, ModelCatalog, ModelDescriptor};
use omp_core::plugins::{self, PluginCatalog};
use omp_core::projects::{self, ProjectRecord};
use omp_core::scheduler;
use omp_core::schedules;
use omp_core::sessions::{self, SessionRecord, TranscriptMessage, TranscriptPart};
use omp_core::settings::AppSettings;
use omp_core::state::{
    CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, NotificationRecord, Platform,
    StateStore,
};
use omp_core::turn_changes::{TurnBaseline, TurnChanges, TurnFileKind, compute_turn_changes};
use serde_json::{Value, json};

#[path = "browser.rs"]
mod browser;
#[path = "interaction.rs"]
mod interaction;
#[path = "markdown.rs"]
mod markdown;

use browser::BrowserPane;
#[path = "terminal.rs"]
mod terminal;

use terminal::{TerminalSession, TerminalTabSpec, TerminalTabSpecs};
use updates::UpdateCheckState;
#[path = "updates.rs"]
mod updates;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppView {
    Workspace,
    Settings,
    Plugins,
    Schedules,
}

impl AppView {
    /// The snapshot's spelling of this view.
    fn name(self) -> &'static str {
        match self {
            AppView::Workspace => "workspace",
            AppView::Settings => "settings",
            AppView::Plugins => "plugins",
            AppView::Schedules => "schedules",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RightPane {
    Launcher,
    Summary,
    Review,
    Files,
    Browser,
    SideQuestion,
    // The harness's `ask` dialog: opened by an `extension_ui_request`, never
    // by a launcher row, and it owns no transcript entries.
    Ask,
    LiveVoice,
    Subagents,
    Activity,
}

impl RightPane {
    /// The snapshot's spelling of this pane; also what `set_right_pane` takes.
    fn name(self) -> &'static str {
        match self {
            RightPane::Launcher => "launcher",
            RightPane::Summary => "summary",
            RightPane::Review => "review",
            RightPane::Files => "files",
            RightPane::Browser => "browser",
            RightPane::SideQuestion => "side-question",
            RightPane::Ask => "ask",
            RightPane::Subagents => "subagents",
            RightPane::LiveVoice => "live-voice",
            RightPane::Activity => "activity",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "launcher" => RightPane::Launcher,
            "summary" => RightPane::Summary,
            "review" => RightPane::Review,
            "files" => RightPane::Files,
            "browser" => RightPane::Browser,
            "side-question" => RightPane::SideQuestion,
            "ask" => RightPane::Ask,
            "subagents" => RightPane::Subagents,
            "live-voice" => RightPane::LiveVoice,
            "activity" => RightPane::Activity,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TurnUndoTarget {
    WholeTurn,
    File(String),
}

/// Expansion, dismissal and confirmation are mutually exclusive: a dismissed
/// card cannot regain an expander through a redraw, and only this state can
/// authorize the destructive Undo action.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum TurnCardState {
    #[default]
    Collapsed,
    Expanded,
    Dismissed,
    ConfirmingUndo {
        target: TurnUndoTarget,
    },
}

impl TurnCardState {
    fn name(&self) -> &'static str {
        match self {
            Self::Collapsed => "collapsed",
            Self::Expanded => "expanded",
            Self::Dismissed => "dismissed",
            Self::ConfirmingUndo { .. } => "confirmingUndo",
        }
    }

    fn undo_target(&self) -> Option<&TurnUndoTarget> {
        match self {
            Self::ConfirmingUndo { target } => Some(target),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SettingsSection {
    General,
    Appearance,
    Agent,
    Session,
    Providers,
    Voice,
    Browser,
    Privacy,
    About,
}

impl SettingsSection {
    const ALL: [Self; 9] = [
        Self::General,
        Self::Appearance,
        Self::Agent,
        Self::Session,
        Self::Providers,
        Self::Voice,
        Self::Browser,
        Self::Privacy,
        Self::About,
    ];

    fn key(self) -> &'static str {
        match self {
            Self::General => "settings.general",
            Self::Appearance => "settings.appearance",
            Self::Agent => "settings.harness",
            Self::Session => "settings.session",
            Self::Providers => "settings.providers",
            Self::Voice => "settings.voice",
            Self::Browser => "settings.browser",
            Self::Privacy => "settings.privacy",
            Self::About => "settings.about",
        }
    }
}

/// One project-shaped row in the sidebar: a granted project, or the project
/// inferred from a session whose folder was never granted.
struct SidebarGroup {
    key: String,
    name: String,
    path: String,
    project_id: Option<String>,
    sessions: Vec<usize>,
}

/// The presentation fields of one sidebar navigation row.
struct SidebarNavItem {
    id: &'static str,
    icon: IconName,
    label: &'static str,
    shortcut: Option<&'static str>,
    active: bool,
}

/// The core geometry model owns this cutoff so rendering and docking cannot diverge.
pub const COMPACT_LAYOUT_BREAKPOINT: f32 = omp_core::geometry::COMPACT_BREAKPOINT as f32;

pub fn compact_layout(width: f32) -> bool {
    width <= COMPACT_LAYOUT_BREAKPOINT
}

fn session_path_is_inside(session_path: &str, project: &ProjectRecord) -> bool {
    let session_path = Path::new(session_path);
    let canonical = omp_core::paths::canonicalize(session_path).ok();
    project
        .folders
        .iter()
        .chain(std::iter::once(&project.primary_folder))
        .any(|folder| {
            !folder.is_empty()
                && (session_path.starts_with(Path::new(folder))
                    || canonical
                        .as_ref()
                        .is_some_and(|path| path.starts_with(Path::new(folder))))
        })
}

fn sidebar_project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// Replaces gpui-kit's stock palette with the Electron theme the redesign
/// references. The component tokens are written too: an input or menu that
/// kept the old surface would break the three-pane color rhythm.
fn apply_electron_palette(cx: &mut Context<Workspace>, accent: &str) {
    let dark = cx.theme().mode == ThemeMode::Dark;
    Theme::update(cx, |theme| {
        let (canvas, sidebar, subtle, hover, selected, raised) = if dark {
            (0x171716, 0x20201f, 0x242423, 0x2b2b29, 0x333330, 0x222220)
        } else {
            (0xffffff, 0xf3f3f1, 0xf7f7f5, 0xececea, 0xe5e5e2, 0xffffff)
        };
        let (text, secondary, tertiary, border, strong) = if dark {
            (0xf5f5f2, 0xbabab4, 0xa1a19b, 0x343431, 0x474743)
        } else {
            (0x20201e, 0x686863, 0x6f6f69, 0xe3e3df, 0xd3d3ce)
        };
        let prime = match (accent, dark) {
            ("blue", true) => 0x7da2ff,
            ("blue", false) => 0x2563eb,
            ("teal", true) => 0x5eead4,
            ("teal", false) => 0x0d9488,
            ("green", true) => 0x7ee2a0,
            ("green", false) => 0x1e8e3e,
            ("orange", true) => 0xffb77d,
            ("orange", false) => 0xea580c,
            ("pink", true) => 0xff8fd0,
            ("pink", false) => 0xdb2777,
            (_, true) => 0xa595ff,
            (_, false) => 0x5f4bd3,
        };
        let (focus, danger, success, warning) = if dark {
            (0x82b5ff, 0xed8a82, 0x75c897, 0xdeb967)
        } else {
            (0x6aa9ff, 0xa93b34, 0x21754d, 0x7a520b)
        };
        theme.colors.background = gpui::rgb(canvas).into();
        theme.colors.sidebar = gpui::rgb(sidebar).into();
        theme.colors.foreground = gpui::rgb(text).into();
        theme.colors.muted = gpui::rgb(secondary).into();
        theme.colors.muted_foreground = gpui::rgb(tertiary).into();
        theme.colors.border = gpui::rgb(border).into();
        theme.colors.accent = gpui::rgb(hover).into();
        theme.colors.accent_foreground = gpui::rgb(text).into();
        theme.colors.primary = gpui::rgb(prime).into();
        theme.colors.primary_foreground = gpui::rgb(canvas).into();
        theme.colors.danger = gpui::rgb(danger).into();
        theme.colors.danger_foreground = gpui::rgb(canvas).into();
        theme.colors.success = gpui::rgb(success).into();
        theme.colors.warning = gpui::rgb(warning).into();
        theme.colors.info = gpui::rgb(focus).into();
        theme.colors.link = gpui::rgb(focus).into();
        theme.colors.ring = gpui::rgb(focus).into();
        theme.colors.caret = gpui::rgb(prime).into();
        theme.colors.popover = gpui::rgb(raised).into();
        theme.colors.popover_foreground = gpui::rgb(text).into();
        theme.colors.selection = gpui::rgb(selected).into();
        theme.colors.scrollbar = gpui::rgb(border).into();
        theme.colors.scrollbar_thumb = gpui::rgb(strong).into();
        theme.colors.tab = gpui::rgb(subtle).into();
        theme.colors.tab_active = gpui::rgb(raised).into();
        theme.colors.tab_bar = gpui::rgb(canvas).into();
        theme.colors.title_bar = gpui::rgb(canvas).into();
        theme.colors.title_bar_border = gpui::rgb(border).into();
        theme.colors.status_bar = gpui::rgb(sidebar).into();
        theme.colors.button = gpui::rgb(raised).into();
        theme.colors.button_hover = gpui::rgb(hover).into();
        theme.colors.button_active = gpui::rgb(selected).into();
        theme.colors.button_foreground = gpui::rgb(text).into();
        theme.colors.button_primary = gpui::rgb(prime).into();
        theme.colors.button_primary_hover = gpui::rgb(prime).into();
        theme.colors.button_primary_active = gpui::rgb(prime).into();
        theme.colors.button_primary_foreground = gpui::rgb(canvas).into();
        theme.colors.button_secondary = gpui::rgb(subtle).into();
        theme.colors.button_secondary_hover = gpui::rgb(hover).into();
        theme.colors.button_secondary_active = gpui::rgb(selected).into();
        theme.colors.button_secondary_foreground = gpui::rgb(text).into();
        theme.radius = px(8.0);
        theme.radius_lg = px(12.0);
        theme.font_size = px(13.0);
        theme.mono_font_size = px(12.0);
    });
}

/// Which entry point asked to close, so the confirmation's `Close anyway`
/// finishes that action instead of guessing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseIntent {
    /// The window's own close button or shortcut.
    Window,
    /// The tray's Quit command.
    Quit,
}

/// Whether a close has to ask first.
///
/// Closing with no agent run is immediate; a live run gets the confirmation
/// overlay, exactly like the Electron app's `shutdownPrompt`.
pub fn should_confirm_close(running: bool) -> bool {
    running
}

/// The app-wide close guard.
///
/// The window's `on_window_should_close` handler, the tray's Quit command and
/// the Workspace that draws the confirmation all read the same guard, so one
/// approval covers both entry points. The flags are atomics so the guard can be
/// cloned into each of them; the view link never leaves the GPUI main thread.
#[derive(Clone, Default)]
pub struct CloseGuard {
    agent_active: Arc<AtomicBool>,
    approved: Arc<AtomicBool>,
    workspace: Rc<RefCell<Option<WeakEntity<Workspace>>>>,
}

impl CloseGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records whether an agent run is live. The Workspace writes this whenever
    /// a runtime starts or stops, which is what the tray's Quit reads.
    pub fn set_agent_active(&self, active: bool) {
        self.agent_active.store(active, Ordering::SeqCst);
    }

    pub fn agent_active(&self) -> bool {
        self.agent_active.load(Ordering::SeqCst)
    }

    /// Records the user's approval, so the close that follows the confirmation
    /// is let through without asking again.
    pub fn approve(&self) {
        self.approved.store(true, Ordering::SeqCst);
    }

    pub fn approved(&self) -> bool {
        self.approved.load(Ordering::SeqCst)
    }

    /// Forgets an approval: a cancelled prompt asks again next time.
    pub fn clear_approval(&self) {
        self.approved.store(false, Ordering::SeqCst);
    }

    /// Links the live view, which is what a close has to ask.
    fn attach(&self, workspace: WeakEntity<Workspace>) {
        *self.workspace.borrow_mut() = Some(workspace);
    }

    /// The live view, unless it has been dropped.
    fn workspace(&self) -> Option<Entity<Workspace>> {
        self.workspace
            .borrow()
            .as_ref()
            .and_then(WeakEntity::upgrade)
    }
}

impl gpui_kit::Global for CloseGuard {}

/// How full the session's context window is, as `get_session_stats` reports it.
///
/// `percent` is the harness's own estimate and is clamped for display, so a
/// malformed frame cannot draw outside the dial.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContextUsage {
    pub tokens: u64,
    pub window: u64,
    pub percent: f64,
}

/// Reads `data.contextUsage` out of a `get_session_stats` response.
///
/// The harness may omit the field, or report a window of zero, a negative
/// token count or a non-finite percent (older builds do omit it); none of
/// those is a reading the dial can draw, so the caller keeps its last one.
fn parse_context_usage(response: &Value) -> Option<ContextUsage> {
    let usage = response.pointer("/data/contextUsage")?;
    let window = usage
        .get("contextWindow")
        .and_then(Value::as_u64)
        .filter(|window| *window > 0)?;
    let tokens = usage.get("tokens").and_then(Value::as_u64)?;
    let percent = usage
        .get("percent")
        .and_then(Value::as_f64)
        .filter(|percent| percent.is_finite() && *percent >= 0.0)?;
    Some(ContextUsage {
        tokens,
        window,
        percent,
    })
}

/// The dial's percentage: the harness's estimate clamped into `0..=100`.
///
/// NaN has no fill to draw, so it reads as zero rather than poisoning the
/// comparison.
fn context_percent(percent: f64) -> u32 {
    if !percent.is_finite() {
        return 0;
    }
    percent.clamp(0.0, 100.0).round() as u32
}

/// `1234567` as `1,234,567`, the way the Electron dial writes token counts.
fn group_digits(value: u64) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// The dial's accessible label: the visible percent plus the token detail the
/// pill has no room for, which is what a tooltip and a screen reader read.
fn context_usage_label(usage: &ContextUsage) -> String {
    format!(
        "Context usage: {} of {} tokens ({}%)",
        group_digits(usage.tokens),
        group_digits(usage.window),
        context_percent(usage.percent),
    )
}

/// One image waiting to ride along with the next prompt or follow-up.
///
/// The bytes are kept encoded rather than as a path: the send happens later,
/// possibly after the file moved or changed, and the harness wants the image
/// inline in the command.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingImage {
    name: String,
    mime: &'static str,
    data: String,
    size: u64,
}

/// The largest attachment the composer reads, in bytes.
///
/// The image travels as base64 inside one JSON line to the harness, so the cap
/// is a whole-message limit, not a rendering one.
const ATTACHMENT_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// How many activity notifications the list keeps. The state parser prunes to
/// the same number, so a record the app appends here survives the next reload.
const MAX_ACTIVITY_NOTIFICATIONS: usize = 200;

/// The mime for a supported image, decided by its magic bytes.
///
/// The extension only says what the user expects; the harness needs the type
/// the bytes actually are, and a mismatch is a rejection, not a guess.
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Whether the file name advertises one of the four accepted image types.
///
/// The magic check decides the mime; this keeps a file named `.txt` from
/// attaching just because its bytes happen to be a PNG.
fn image_extension_supported(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif")
    )
}

/// Standard base64 with padding, which is what `ImageContent.data` carries.
///
/// An attachment is the only thing in this crate that encodes bytes, so the
/// encoder lives here instead of pulling in another dependency.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        encoded.push(ALPHABET[(triple >> 18) as usize & 0x3F] as char);
        encoded.push(ALPHABET[(triple >> 12) as usize & 0x3F] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3F] as char
        } else {
            '='
        });
    }
    encoded
}

/// Reads one image for the composer, or explains why it cannot be attached.
///
/// The size is checked before the bytes are read, so an oversized file is a
/// message instead of a multi-megabyte allocation. An unsupported name, bytes
/// that are not one of the four image types and an unreadable file are all
/// errors: the caller keeps whatever it already had.
fn read_pending_image(path: &Path) -> Result<PendingImage, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image")
        .to_string();
    if !image_extension_supported(path) {
        return Err(format!(
            "Unsupported attachment {name}: choose a PNG, JPEG, WebP or GIF image."
        ));
    }
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("Could not read {name}: {error}"))?;
    if metadata.len() > ATTACHMENT_MAX_BYTES {
        return Err(format!(
            "Attachment {name} is {} MB; images must be 10 MB or smaller.",
            metadata.len().div_ceil(1024 * 1024)
        ));
    }
    let bytes = std::fs::read(path).map_err(|error| format!("Could not read {name}: {error}"))?;
    let Some(mime) = image_mime(&bytes) else {
        return Err(format!(
            "Unsupported attachment {name}: the file is not a PNG, JPEG, WebP or GIF image."
        ));
    };
    Ok(PendingImage {
        name,
        mime,
        data: base64_encode(&bytes),
        size: bytes.len() as u64,
    })
}

/// How many catalog models the Settings picker lists at once.
///
/// The catalog is the harness's whole provider list, which can run to
/// hundreds of entries; the picker is a shortcut to the handful the user
/// switches between, not a catalog browser.
const MODEL_PICKER_LIMIT: usize = 12;

/// How many catalog providers the Settings picker offers as filter chips.
///
/// The catalog can carry a provider per login; the filter row is a shortcut to
/// the few the user switches between, not a second catalog browser.
const MODEL_PROVIDER_LIMIT: usize = 8;

/// One provider chip above the model list: the catalog's own name, and whether
/// the harness has credentials for it when the catalog says.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderChip {
    id: String,
    name: String,
    configured: Option<bool>,
}

/// The `lastSelectedModels` key for one catalog model: `provider/id`.
///
/// The provider is everything before the first `/`, so a model id may itself
/// contain slashes (`openrouter/anthropic/claude-…` stays one selection).
fn model_key(provider: &str, id: &str) -> String {
    format!("{provider}/{id}")
}

/// Splits a persisted `provider/id` selection back into its halves.
///
/// An empty key (the harness default), or one with an empty half on either
/// side of the first `/`, is not a selection.
fn parse_model_key(key: &str) -> Option<(&str, &str)> {
    let (provider, id) = key.split_once('/')?;
    if provider.is_empty() || id.is_empty() {
        return None;
    }
    Some((provider, id))
}

/// The composer footer's model label. An empty selection is the harness
/// default, which the app cannot name without a catalog.
fn composer_model_label(model: &str) -> String {
    if model.is_empty() {
        "Model: auto".to_string()
    } else {
        format!("Model: {model}")
    }
}

/// The models one provider chip lists. `None` is the `All` chip.
///
/// The filter is pure: the current selection is not consulted here, so a
/// provider that does not carry it lists only its own models and the picker's
/// current-model row keeps showing the selection.
fn filter_models<'a>(
    models: &'a [ModelDescriptor],
    provider: Option<&str>,
) -> Vec<&'a ModelDescriptor> {
    models
        .iter()
        .filter(|model| provider.is_none_or(|provider| model.provider == provider))
        .collect()
}

/// The chips above the model list, bounded to [`MODEL_PROVIDER_LIMIT`].
///
/// The catalog's provider list carries the display name and whether it is
/// configured; a catalog that only lists models still gets one chip per
/// provider, without the configured hint.
fn provider_chips(catalog: &ModelCatalog) -> Vec<ProviderChip> {
    if !catalog.providers.is_empty() {
        return catalog
            .providers
            .iter()
            .take(MODEL_PROVIDER_LIMIT)
            .map(|provider| ProviderChip {
                id: provider.id.clone(),
                name: provider.name.clone(),
                configured: Some(provider.configured),
            })
            .collect();
    }
    let mut chips: Vec<ProviderChip> = Vec::new();
    for model in &catalog.models {
        if chips.len() == MODEL_PROVIDER_LIMIT {
            break;
        }
        if chips.iter().any(|chip| chip.id == model.provider) {
            continue;
        }
        chips.push(ProviderChip {
            id: model.provider.clone(),
            name: model.provider.clone(),
            configured: None,
        });
    }
    chips
}

/// The catalog rows the Settings picker lists: the provider filter's models,
/// capped at [`MODEL_PICKER_LIMIT`], with the current selection kept even when
/// it falls past the cap.
///
/// A selection the filter (or the catalog) does not carry stays out of the
/// list; the picker's current-model row is what shows it.
fn visible_models<'a>(
    models: &'a [ModelDescriptor],
    selected: &str,
    provider: Option<&str>,
) -> Vec<&'a ModelDescriptor> {
    let filtered = filter_models(models, provider);
    let mut visible: Vec<&ModelDescriptor> =
        filtered.iter().copied().take(MODEL_PICKER_LIMIT).collect();
    if selected.is_empty()
        || visible
            .iter()
            .any(|model| model_key(&model.provider, &model.id) == selected)
    {
        return visible;
    }
    if let Some(current) = filtered
        .iter()
        .copied()
        .find(|model| model_key(&model.provider, &model.id) == selected)
    {
        if visible.len() == MODEL_PICKER_LIMIT {
            visible.pop();
        }
        visible.push(current);
    }
    visible
}

/// Draws the toolbar's context dial: the window's fill as a percent, ringed in
/// the warning colour as it nears the window's limit.
///
/// It is a reading, not a control, so it carries no click listener: the token
/// detail lives in the label instead of a popover.
fn context_usage_dial(usage: ContextUsage, colors: ThemeColor) -> impl IntoElement {
    let percent = context_percent(usage.percent);
    let ring = if percent >= 95 {
        colors.danger
    } else if percent >= 80 {
        colors.warning
    } else {
        colors.border
    };
    div()
        .id("context-usage")
        .aria_label(context_usage_label(&usage))
        .flex()
        .items_center()
        .justify_center()
        .size(px(26.0))
        .rounded(px(999.0))
        .border_2()
        .border_color(ring)
        .text_size(px(8.5))
        .text_color(colors.muted_foreground)
        .child(format!("{percent}"))
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

struct ScheduledRun {
    runtime_id: String,
    schedule_id: String,
    run_id: String,
}

/// The bucket a new, not yet saved session files its terminal tabs under. It
/// lives only until the session list hands out a real id.
const DRAFT_TERMINAL_KEY: &str = "new-session";

/// The label a sent terminal selection carries into the composer draft, so the
/// prompt says where the quoted output came from.
const TERMINAL_SELECTION_LABEL: &str = "Terminal output:";

/// What `Send selection` reports when the screen has nothing to send. The
/// composer is left untouched: an empty quote is not a prompt.
const TERMINAL_EMPTY_SELECTION_STATUS: &str = "No terminal output to send.";

/// How many sessions the composer's mention menu lists at once. The menu is a
/// popover above the input, so it stays bounded instead of growing with the
/// catalog.
const MENTION_MENU_LIMIT: usize = 8;

/// What the mention menu says when the catalog has no session to insert.
const MENTION_EMPTY_STATUS: &str = "No sessions to mention yet.";

/// The session menu's actionable rows, in draw order. `debug_snapshot` reads
/// this list, so a scenario can prove a new row is wired and drawn without
/// measuring the popover.
const SESSION_MENU_ACTIONS: [&str; 6] = [
    "Rename",
    "Pin",
    "Archive",
    "Delete",
    "Fork session",
    "Remote Control",
];

/// How the Extensions page runs a plugin install.
///
/// The default calls [`plugins::install`], which shells out to the harness's
/// `omp plugin install`. The parity suite never spawns a real `omp`, so a
/// scenario replaces this with a stand-in to prove the page submits the
/// source, refreshes the catalog and reports the outcome.
pub type PluginInstaller = Arc<dyn Fn(&CliContext, &str) -> Result<Value, String> + Send + Sync>;

fn default_plugin_installer() -> PluginInstaller {
    Arc::new(|context, source| plugins::install(context, source).map_err(|error| error.message))
}

struct CommandPaletteState {
    input: Entity<InputState>,
    active: usize,
    previous_focus: Option<FocusHandle>,
}

struct TranscriptSearch {
    input: Entity<InputState>,
    scope: interaction::SearchScope,
    index: usize,
    previous_focus: Option<FocusHandle>,
    revealed_target: Option<(String, String, interaction::SearchScope)>,
}

pub struct Workspace {
    command_palette: Option<CommandPaletteState>,
    palette_subscription: Option<Subscription>,
    transcript_search: Option<TranscriptSearch>,
    transcript_search_subscription: Option<Subscription>,
    workspace_focus: FocusHandle,
    ime_guard: CompositionGuard,
    last_seen_composing: bool,
    keystroke_subscription: Option<Subscription>,
    geometry: UiGeometry,
    geometry_path: PathBuf,
    home_dir: PathBuf,
    user_data_dir: PathBuf,
    omp_executable: PathBuf,
    store: Option<Arc<Mutex<StateStore>>>,
    agents: AgentManager,
    runtime_id: Option<String>,
    streaming_index: Option<usize>,
    // Whether a turn is in flight on the main runtime. A prompt is accepted
    // before the harness finishes streaming, so this stays true from the
    // accepted send until `agent_end`: a send in between is a follow-up.
    running: bool,
    drain_task: Option<Task<()>>,
    scheduler_task: Option<Task<()>>,
    scheduled_runs: Vec<ScheduledRun>,
    layout: ResolvedLayout,
    settings: AppSettings,
    projects: Vec<ProjectRecord>,
    sessions: Vec<SessionRecord>,
    transcript: Vec<TranscriptMessage>,
    // The transcript's own scroll state: the handle carries the offset, range
    // and child bounds the at-bottom check reads, and `scroll_to_item` is how
    // an append follows the newest message.
    transcript_scroll: ScrollHandle,
    // Whether the transcript is pinned to its newest message. It starts true
    // and is re-read on every scroll event, so a reader who scrolls up stops
    // the auto-follow until the `Jump to latest` control re-pins it.
    transcript_at_bottom: bool,
    // The harness's own view of the queued follow-ups (`session_action_update`).
    // The optimistic queued row in the transcript is the immediate trace; this
    // list is what the harness reports, and the two are never merged.
    queued_follow_ups: Vec<String>,
    transcript_error: Option<String>,
    // The session file the transcript was read from, and the file state that
    // read saw. The watcher compares this against a fresh `stat`, so a write
    // from another process is the only thing that triggers a re-read: the
    // view never polls the file's contents.
    transcript_file: Option<String>,
    transcript_stamp: Option<TranscriptStamp>,
    // The file state that last failed to read. A failure is only surfaced
    // once it repeats for the same state, so a file caught mid-write is not
    // reported; the retry keeps the previous stamp, so it recovers on its own.
    transcript_failure: Option<TranscriptStamp>,
    // How many times an external change re-read the transcript. The parity
    // harness reads this back to prove a check really reloaded the file.
    transcript_reloads: u64,
    transcript_animation_floor: usize,
    transcript_task: Option<Task<()>>,
    runtime_error: Option<String>,
    // The composer banner's last fork outcome. A successful fork leaves the
    // short notice `Forked session` here; a failed one is an error and lands in
    // `runtime_error`, so the two never share the banner.
    fork_status: Option<String>,
    // The harness's last `get_session_stats` reading. It is cleared on a
    // session switch, so the dial never shows another session's fill.
    context_usage: Option<ContextUsage>,
    selected_session: Option<usize>,
    collapsed_projects: HashSet<String>,
    expanded_thinking: HashSet<String>,
    expanded_tool_results: HashSet<String>,
    todo_open: bool,
    sidebar_search_open: bool,
    sidebar_filter: Entity<InputState>,
    _sidebar_filter_subscription: Subscription,
    composer: Entity<InputState>,
    _composer_subscription: Subscription,
    right_pane_search: Entity<InputState>,
    submit_requested: Option<bool>,
    // The composer's mention menu: the bounded list of sessions it draws, and
    // the status it shows when the catalog has nothing to mention. A selection
    // inserts `@<file_path>` into the draft and closes the list; nothing is
    // sent until the user presses Send.
    mention_menu_open: bool,
    mention_status: Option<String>,
    // The image waiting for the next prompt or follow-up, if one is attached.
    // It clears only once the harness accepts the command, so a rejected send
    // keeps it for a retry.
    pending_image: Option<PendingImage>,
    // Why the last attach was refused: an unsupported or oversized file. It
    // is the composer banner's own line, so a failed attach never overwrites
    // a prompt's error and a successful attach clears it.
    image_error: Option<String>,
    side_input: Entity<InputState>,
    _side_input_subscription: Subscription,
    side_submit_requested: bool,
    side_runtime_id: Option<String>,
    side_answer: String,
    side_error: Option<String>,
    side_streaming: bool,
    view: AppView,
    settings_section: SettingsSection,
    plugin_catalog: Option<PluginCatalog>,
    // The Extensions page's last toggle outcome: `plugin_status` is the
    // `Extensions updated` notice, `plugin_error` the reason a change failed.
    // Only one is set, and both are cleared by a refresh.
    plugin_status: Option<String>,
    plugin_error: Option<String>,
    // The Extensions page's install row: `plugin_source` is the field the
    // button submits, and `plugin_install_task` is the background install
    // while it runs. The field keeps its text after a failure, so a source
    // the harness rejects is still there to correct.
    plugin_source: Entity<InputState>,
    _plugin_source_subscription: Subscription,
    plugin_submit_requested: bool,
    plugin_installer: PluginInstaller,
    plugin_install_task: Option<Task<()>>,
    // The Settings picker's model list. It is loaded once from the harness
    // when Settings opens and cached here, so switching views never spawns
    // `omp models` again.
    model_catalog: Option<ModelCatalog>,
    model_load_task: Option<Task<()>>,
    // The Settings picker's provider chip: `None` is the `All` chip. It starts
    // on the current model's provider when a catalog arrives, and only filters
    // the list the page draws: the persisted selection is never rewritten by a
    // filter change.
    provider_filter: Option<String>,
    // Why the last `set_model` was refused. The persisted default still
    // applies to the next runtime, so this is a notice, not a failure state.
    model_status: Option<String>,
    schedules: Vec<Value>,
    // The in-app activity list mirrors the persisted notifications: the state
    // file is the source of truth, so clearing here goes through `store.update`.
    notifications: Vec<NotificationRecord>,
    // The activity entries this window appended, so a completion notice id
    // stays unique even when two turns end in the same millisecond.
    notification_counter: u64,
    right_pane: RightPane,
    // Whether the window is narrow enough for the compact layout, read from
    // the bounds in `new` and refreshed by `track_bounds`. The right pane then
    // collapses into the toolbar's Details toggle.
    compact_layout: bool,
    // Compact windows keep at most one sidebar or right-pane drawer open.
    active_drawer: Option<CollapsedPane>,
    // Live voice is RPC-driven: the harness owns the microphone and the pane only
    // mirrors the normalized `live_*` events plus the commands it sent.
    live_phase: String,
    live_levels: f32,
    live_transcript: Vec<String>,
    live_muted: bool,
    live_active: bool,
    live_error: Option<String>,
    // Dictation is RPC-driven as well: the harness owns the microphone, and the
    // host only sends `dictation_start`/`dictation_stop` and renders the frames.
    dictation_phase: String,
    dictation_capture_id: Option<String>,
    dictation_preview: String,
    dictation_error: Option<String>,
    dictation_active: bool,
    // The terminal text waits here until `render` has a window to insert it.
    dictation_pending_text: Option<String>,
    dictation_counter: u64,
    // The `ask` dialog is RPC-driven like live voice: the harness pushes an
    // `extension_ui_request` and the pane answers it with one
    // `extension_ui_response`. Only one dialog is live at a time, and its free
    // text lives in per-question inputs created while the pane draws.
    ask_dialog: Option<AskDialog>,
    ask_inputs: HashMap<String, Entity<InputState>>,
    browser: BrowserPane,
    // Each tab owns its own shell; `active_terminal` indexes the one the panel
    // draws and sends input to, and stays in range while any tab is open.
    terminals: Vec<TerminalSession>,
    active_terminal: usize,
    // A live PTY cannot be serialized, so a session switch stops the shells and
    // files what each tab was (`shell`, `cwd`) under that session's id. The
    // panel's open state stays global; switching back reopens fresh shells from
    // the spec instead of reusing the previous session's shell.
    terminal_specs: HashMap<String, TerminalTabSpecs>,
    terminal_open: bool,
    terminal_input: Entity<InputState>,
    _terminal_input_subscription: Subscription,
    terminal_submit_requested: bool,
    terminal_error: Option<String>,
    // The last `Send selection` outcome, shown under the screen: a no-op on a
    // blank terminal explains itself instead of silently doing nothing.
    terminal_status: Option<String>,
    // The header's menu is a popup of the panel itself: it is only drawn while
    // the panel is open, and any row closes it again.
    terminal_menu_open: bool,
    // One watcher per tab, woken by its session's output. A tab's watcher ends
    // when its channel closes, so this only grows while the panel stays open.
    terminal_tasks: Vec<Task<()>>,
    files: Vec<omp_core::projects::ProjectFileEntry>,
    files_skipped: u64,
    files_error: Option<String>,
    // The toolbar's overview popover is a different control from the launcher
    // pane; `overview_pinned` belongs to the launcher below.
    overview_open: bool,
    // Session-only, like the launcher itself: a pinned Overview rides along to
    // the next view or session instead of being left behind by the switch.
    overview_pinned: bool,
    // Unread notifications plus unread sessions. Both lists reload on their own
    // paths, so this is recomputed after each of them and read by the launcher.
    attention_count: usize,
    menu_open: bool,
    model_menu_open: bool,
    // Which project row has its menu open. One at a time: the row's ellipsis
    // button toggles it, and every menu row closes it again.
    project_menu: Option<String>,
    turn_changes: TurnChanges,
    turn_baseline: Option<TurnBaseline>,
    turn_card: TurnCardState,
    turn_card_error: Option<String>,
    review_focus_path: Option<String>,
    review_status: Option<GitStatus>,
    review_error: Option<String>,
    last_bounds: Option<(f32, f32, f32, f32)>,
    save_task: Option<Task<()>>,
    update_check: UpdateCheckState,
    update_task: Option<Task<()>>,
    // The toolbar's Capture workspace result: the PNG it wrote under
    // `captures/`, or why the frame could not be written. Only one is set.
    capture_path: Option<PathBuf>,
    capture_error: Option<String>,
    // The close guard is shared with `main`'s window handler and the tray's
    // Quit command; the confirmation below is the one dialog both entry
    // points draw, and it only exists while a close is being asked about.
    close_guard: CloseGuard,
    close_prompt: Option<CloseIntent>,
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, data: WorkspaceData) -> Self {
        let width = f32::from(window.bounds().size.width);
        let layout = data.geometry.resolve(width as f64);
        // `main` installs the guard before the window opens, so the close
        // handler and this view share one; a test without one gets its own.
        let close_guard = cx.try_global::<CloseGuard>().cloned().unwrap_or_default();
        interaction::apply_reduce_motion(data.settings.reduce_motion, cx);
        let language = i18n::resolve(data.settings.locale);
        let composer = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t(language, "composer.placeholder"))
                .submit_on_enter(true)
        });
        let composer_subscription = cx.subscribe(&composer, |this, _, event: &InputEvent, cx| {
            if let InputEvent::PressEnter { secondary, .. } = event {
                this.submit_requested = Some(*secondary);
                cx.notify();
            }
        });
        let right_pane_search = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t(language, "rightPane.searchPlaceholder"))
        });
        let side_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t(language, "sideQuestion.placeholder"))
                .submit_on_enter(true)
        });
        let side_input_subscription =
            cx.subscribe(&side_input, |this, _, event: &InputEvent, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.side_submit_requested = true;
                    cx.notify();
                }
            });
        let terminal_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t(language, "terminal.placeholder"))
                .submit_on_enter(true)
        });
        let terminal_input_subscription =
            cx.subscribe(&terminal_input, |this, _, event: &InputEvent, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.terminal_submit_requested = true;
                    cx.notify();
                }
            });
        let plugin_source = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t(language, "plugin.sourcePlaceholder"))
                .submit_on_enter(true)
        });
        let plugin_source_subscription = cx.subscribe(
            &plugin_source,
            |this, _, event: &InputEvent, cx| match event {
                // The row's Enter key and its button both submit. The key is
                // only recorded here: the field cannot be read while it is
                // emitting its own event, so `render` runs the submit.
                InputEvent::PressEnter { .. } => {
                    this.plugin_submit_requested = true;
                    cx.notify();
                }
                // The install button is live only while the field has text.
                InputEvent::Change => cx.notify(),
                _ => {}
            },
        );
        let sidebar_filter = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t(language, "sidebar.sessionsPlaceholder"))
        });
        let sidebar_filter_subscription =
            cx.subscribe(&sidebar_filter, |_this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
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
        // A removed project's session files outlive its grant, so the catalog
        // the caller scanned is filtered against what the state file dismisses.
        let (dismissed, granted) = match &store {
            Some(store) => {
                let store = store.lock().expect("state lock");
                let state = store.state();
                (
                    state.dismissed_project_paths.clone(),
                    state
                        .projects
                        .iter()
                        .flat_map(|project| project.folders.clone())
                        .collect::<Vec<String>>(),
                )
            }
            None => (Vec::new(), Vec::new()),
        };
        let sessions = data
            .sessions
            .into_iter()
            .filter(|session| !session_hidden(&dismissed, &granted, &session.project_path))
            .collect();
        let theme_mode = match data.settings.theme {
            omp_core::settings::Theme::Light => ThemeMode::Light,
            omp_core::settings::Theme::Dark => ThemeMode::Dark,
            omp_core::settings::Theme::System => ThemeMode::from(window.appearance()),
        };
        Theme::change(theme_mode, Some(window), cx);
        apply_electron_palette(cx, &data.settings.accent_color);
        let browser = BrowserPane::new(window, cx);
        let workspace_focus = cx.focus_handle();
        let mut workspace = Self {
            command_palette: None,
            palette_subscription: None,
            transcript_search: None,
            transcript_search_subscription: None,
            workspace_focus,
            ime_guard: CompositionGuard::default(),
            last_seen_composing: false,
            keystroke_subscription: None,
            geometry: data.geometry,
            geometry_path: data.geometry_path,
            home_dir: data.home_dir,
            user_data_dir: data.user_data_dir,
            omp_executable: data.omp_executable,
            store,
            agents: AgentManager::default(),
            runtime_id: None,
            streaming_index: None,
            running: false,
            drain_task: None,
            scheduler_task: None,
            scheduled_runs: Vec::new(),
            layout,
            settings: data.settings,
            projects: data.projects,
            sessions,
            transcript: Vec::new(),
            transcript_scroll: ScrollHandle::new(),
            transcript_at_bottom: true,
            queued_follow_ups: Vec::new(),
            transcript_error: None,
            transcript_file: None,
            transcript_stamp: None,
            transcript_failure: None,
            transcript_reloads: 0,
            transcript_animation_floor: 0,
            transcript_task: None,
            runtime_error: None,
            fork_status: None,
            context_usage: None,
            selected_session: None,
            collapsed_projects: HashSet::new(),
            expanded_thinking: HashSet::new(),
            expanded_tool_results: HashSet::new(),
            todo_open: false,
            sidebar_search_open: false,
            sidebar_filter,
            _sidebar_filter_subscription: sidebar_filter_subscription,
            composer,
            _composer_subscription: composer_subscription,
            right_pane_search,
            submit_requested: None,
            mention_menu_open: false,
            mention_status: None,
            pending_image: None,
            image_error: None,
            side_input,
            _side_input_subscription: side_input_subscription,
            side_submit_requested: false,
            side_runtime_id: None,
            side_answer: String::new(),
            side_error: None,
            side_streaming: false,
            view: AppView::Workspace,
            settings_section: SettingsSection::General,
            plugin_catalog: None,
            plugin_status: None,
            plugin_error: None,
            plugin_source,
            _plugin_source_subscription: plugin_source_subscription,
            plugin_submit_requested: false,
            plugin_installer: default_plugin_installer(),
            plugin_install_task: None,
            model_catalog: None,
            model_load_task: None,
            provider_filter: None,
            model_status: None,
            schedules: Vec::new(),
            notifications: Vec::new(),
            notification_counter: 0,
            right_pane: RightPane::Launcher,
            compact_layout: compact_layout(width),
            active_drawer: None,
            live_phase: "idle".to_string(),
            live_levels: 0.0,
            live_transcript: Vec::new(),
            live_muted: false,
            live_active: false,
            live_error: None,
            dictation_phase: "idle".to_string(),
            dictation_capture_id: None,
            dictation_preview: String::new(),
            dictation_error: None,
            dictation_active: false,
            dictation_pending_text: None,
            dictation_counter: 0,
            ask_dialog: None,
            ask_inputs: HashMap::new(),
            browser,
            terminals: Vec::new(),
            active_terminal: 0,
            terminal_specs: HashMap::new(),
            terminal_open: false,
            terminal_input,
            _terminal_input_subscription: terminal_input_subscription,
            terminal_submit_requested: false,
            terminal_error: None,
            terminal_status: None,
            terminal_menu_open: false,
            terminal_tasks: Vec::new(),
            files: Vec::new(),
            files_skipped: 0,
            files_error: None,
            overview_open: false,
            overview_pinned: false,
            attention_count: 0,
            menu_open: false,
            model_menu_open: false,
            project_menu: None,
            turn_changes: TurnChanges::default(),
            turn_baseline: None,
            turn_card: TurnCardState::default(),
            turn_card_error: None,
            review_focus_path: None,
            review_status: None,
            review_error: None,
            last_bounds: None,
            save_task: None,
            update_check: updates::initial_state(),
            update_task: None,
            capture_path: None,
            capture_error: None,
            close_guard,
            close_prompt: None,
        };
        workspace.keystroke_subscription =
            Some(cx.observe_keystrokes(|this, _, window, cx| this.poll_composition(window, cx)));
        workspace.refresh_notifications();
        workspace.close_guard.attach(cx.weak_entity());
        workspace.sync_close_guard();
        workspace.start_scheduler(cx);
        workspace.start_transcript_watch(cx);
        workspace
    }

    pub fn layout(&self) -> &ResolvedLayout {
        &self.layout
    }

    pub fn transcript_messages(&self) -> &[TranscriptMessage] {
        &self.transcript
    }

    pub fn apply_transcript_delta(&mut self, kind: &str, delta: &str, cx: &mut Context<Self>) {
        self.append_assistant_delta(kind, delta);
        cx.notify();
    }

    /// Copies the visible transcript as plain text, one block per message.
    ///
    /// The toolbar's `Copy transcript` button and the parity harness both call
    /// this; an empty transcript leaves the clipboard untouched.
    pub fn copy_transcript(&self, cx: &mut Context<Self>) {
        let text = transcript_clipboard_text(&self.transcript);
        if text.is_empty() {
            return;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }

    /// Re-pins the transcript to its newest message.
    ///
    /// The `Jump to latest` control and the parity harness both call this, so
    /// a scenario never has to click a measured position. The scroll is
    /// requested on the handle and lands in the frame `cx.notify` requests.
    pub fn jump_to_transcript_latest(&mut self, cx: &mut Context<Self>) {
        self.transcript_at_bottom = true;
        self.follow_transcript_tail();
        cx.notify();
    }

    /// Re-reads whether the transcript sits at its bottom edge.
    ///
    /// `on_scroll` calls this after the handle has taken the event's delta, so
    /// the drawn `Jump to latest` control follows the reader instead of a
    /// stale frame.
    fn sync_transcript_at_bottom(&mut self) {
        let handle = &self.transcript_scroll;
        self.transcript_at_bottom = transcript_is_at_bottom(
            f32::from(handle.offset().y),
            f32::from(handle.max_offset().y),
            f32::from(handle.bounds().size.height),
            TRANSCRIPT_BOTTOM_THRESHOLD,
        );
    }

    /// Keeps the transcript on its newest message after an append, but only
    /// while the reader is already at the bottom: someone who scrolled up
    /// keeps their place and gets the `Jump to latest` control instead.
    fn follow_transcript_tail(&self) {
        if !self.transcript_at_bottom {
            return;
        }
        // Scroll to the content edge, not the last item's top: a tool card
        // taller than the viewport would otherwise leave its bottom (and the
        // jump control's target) below the fold.
        self.transcript_scroll.scroll_to_bottom();
    }

    /// Why the transcript could not be read, while the pane shows it.
    ///
    /// The parity harness reads it back after an external write that left the
    /// session file unreadable; a later readable state clears it.
    pub fn transcript_error(&self) -> Option<&str> {
        self.transcript_error.as_deref()
    }

    /// Drops the transcript and the file baseline the watcher compares against.
    ///
    /// Every path that stops showing a session calls this, so a stale file is
    /// never watched under the next selection.
    fn clear_transcript(&mut self) {
        self.transcript.clear();
        self.transcript_animation_floor = 0;
        self.transcript_file = None;
        self.transcript_stamp = None;
        self.transcript_failure = None;
    }

    /// Re-reads the selected session's file when another process changed it.
    ///
    /// The harness writes to the session JSONL from its own process, so a
    /// resumed session would otherwise show a stale transcript until it was
    /// opened again. The check is a `stat`: only a moved length or modified
    /// time triggers the read, and the reader keeps their place — the tail is
    /// followed only when the view was already pinned to it.
    ///
    /// A read that fails keeps the rows already on screen and is reported once
    /// it repeats for the same file state, so a file caught mid-write is not
    /// reported and recovers on its own. The timer and the parity harness both
    /// call this.
    pub fn check_transcript_external_change(&mut self, cx: &mut Context<Self>) {
        let Some(index) = self.selected_session else {
            return;
        };
        let Some(session) = self.sessions.get(index) else {
            return;
        };
        // The watcher follows the file the transcript was read from: a
        // refreshed catalog can move the index, and re-reading a different
        // session's file would show its rows under this selection.
        if self.transcript_file.as_deref() != Some(session.file_path.as_str()) {
            return;
        }
        let file_path = session.file_path.clone();
        let stamp = transcript_stamp(Path::new(&file_path));
        if stamp == self.transcript_stamp {
            return;
        }
        let root = sessions::session_root(&self.home_dir);
        let messages = match sessions::read_transcript(&root, &file_path) {
            Ok(messages) => messages,
            Err(error) => {
                // One failed read is a file that is still being written; the
                // same state failing twice is a file the view cannot show.
                let persistent = self.transcript_failure == stamp;
                self.transcript_failure = stamp;
                if persistent && self.transcript_error.is_none() {
                    self.transcript_error = Some(error.message);
                    cx.notify();
                }
                return;
            }
        };
        // A queued follow-up is the harness's own queue trace and never doubles
        // as the turn's user message, so it always survives the read. A turn in
        // flight owns rows the file has not caught up with, so those are
        // carried over too instead of erasing the stream.
        let in_flight = self.running || self.streaming_index.is_some();
        let streaming_id = self
            .streaming_index
            .and_then(|index| self.transcript.get(index))
            .map(|message| message.id.clone());
        let carried: Vec<TranscriptMessage> = self
            .transcript
            .iter()
            .filter(|message| {
                message.id.starts_with("queued-")
                    || (in_flight && is_local_transcript_row(&message.id))
            })
            .filter(|message| {
                // A row the file already holds under the harness's own id is
                // not carried twice: the read copy is the persisted one.
                let queued = message.id.starts_with("queued-");
                !messages.iter().any(|fresh| {
                    fresh.id == message.id
                        || (!queued
                            && fresh.role == message.role
                            && transcript_row_text(fresh) == transcript_row_text(message))
                })
            })
            .cloned()
            .collect();
        self.transcript = messages;
        self.transcript.extend(carried);
        self.transcript_animation_floor = self.transcript.len();
        // A carried streaming row keeps its slot, so the next delta grows it
        // instead of minting a second reply.
        self.streaming_index =
            streaming_id.and_then(|id| self.transcript.iter().position(|message| message.id == id));
        self.transcript_stamp = stamp;
        self.transcript_failure = None;
        self.transcript_error = None;
        self.transcript_reloads += 1;
        // The reader keeps their place: only a pinned view follows the append.
        self.follow_transcript_tail();
        cx.notify();
    }

    /// Polls the selected session's file so a write from another process shows
    /// up without a manual reload.
    ///
    /// Each tick is one `stat` of the file the transcript came from; the file
    /// itself is only read when that `stat` moved.
    fn start_transcript_watch(&mut self, cx: &mut Context<Self>) {
        if self.transcript_task.is_some() {
            return;
        }
        self.transcript_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(TRANSCRIPT_WATCH_INTERVAL)
                    .await;
                if this
                    .update(cx, |this, cx| this.check_transcript_external_change(cx))
                    .is_err()
                {
                    break;
                }
            }
        }));
    }

    /// Renders the whole window into `<user_data_dir>/captures` and reports the
    /// outcome in the toolbar's status row.
    ///
    /// The frame comes from the platform renderer, so a backend that cannot
    /// produce one (the test platform without a headless renderer) reports the
    /// error instead of panicking, exactly like a failed write does.
    pub fn capture_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let frame = window
            .render_to_image()
            .map_err(|error| format!("Capture failed: {error}"));
        self.finish_capture(frame, cx);
    }

    /// Captures one rendered frame to an explicit path. The visual-parity
    /// check uses this instead of OS screen capture, which needs a separate
    /// privacy grant and can miss a background window.
    pub fn capture_to_path(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let saved = match window.render_to_image() {
            Ok(frame) => {
                if let Some(parent) = path.parent()
                    && let Err(error) = std::fs::create_dir_all(parent)
                {
                    self.capture_error = Some(format!("Capture failed: {error}"));
                    cx.notify();
                    return;
                }
                frame
                    .save(&path)
                    .map_err(|error| format!("Capture failed: {error}"))
            }
            Err(error) => Err(format!("Capture failed: {error}")),
        };
        match saved {
            Ok(()) => {
                self.capture_path = Some(path);
                self.capture_error = None;
            }
            Err(error) => {
                self.capture_path = None;
                self.capture_error = Some(error);
            }
        }
        cx.notify();
    }

    /// Saves a rendered frame and parks the result in the status row: the path
    /// it wrote, or the error that stood in for it.
    ///
    /// Taking the frame as a value is what lets a test drive both outcomes
    /// without a platform renderer behind the window.
    fn finish_capture(&mut self, frame: Result<image::RgbaImage, String>, cx: &mut Context<Self>) {
        let saved = frame.and_then(|frame| write_capture(&self.user_data_dir, Utc::now(), &frame));
        match saved {
            Ok(path) => {
                self.capture_path = Some(path);
                self.capture_error = None;
            }
            Err(error) => {
                self.capture_path = None;
                self.capture_error = Some(error);
            }
        }
        cx.notify();
    }

    /// Whether an agent run is live: a streaming runtime or a scheduled run.
    ///
    /// This is the one definition of "active" for closing; the Electron app
    /// reaches the same answer from its runtime list.
    pub fn agent_active(&self) -> bool {
        self.runtime_id.is_some() || !self.scheduled_runs.is_empty()
    }

    /// Mirrors [`Workspace::agent_active`] into the shared guard, which is what
    /// the tray's Quit command reads without touching the view.
    fn sync_close_guard(&self) {
        self.close_guard.set_agent_active(self.agent_active());
    }

    /// Whether the close confirmation is on screen.
    pub fn close_prompt_open(&self) -> bool {
        self.close_prompt.is_some()
    }

    /// Asks to close, and reports whether the caller may close now.
    ///
    /// With no agent run the answer is immediate; a live run parks the question
    /// in the confirmation overlay and answers `false`, so the window stays up
    /// and the app keeps streaming while the user decides.
    pub fn request_close(&mut self, intent: CloseIntent, cx: &mut Context<Self>) -> bool {
        self.sync_close_guard();
        if !should_confirm_close(self.agent_active()) {
            // The quit intent has no window to close, so it finishes here.
            if intent == CloseIntent::Quit {
                cx.quit();
            }
            return true;
        }
        self.close_prompt = Some(intent);
        cx.notify();
        false
    }

    /// `Close anyway`: records the approval and finishes the close that asked.
    pub fn confirm_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(intent) = self.close_prompt.take() else {
            return;
        };
        self.close_guard.approve();
        cx.notify();
        match intent {
            CloseIntent::Window => window.remove_window(),
            CloseIntent::Quit => cx.quit(),
        }
    }

    /// `Cancel`: the app keeps running, and the next close asks again.
    pub fn cancel_close(&mut self, cx: &mut Context<Self>) {
        if self.close_prompt.take().is_some() {
            self.close_guard.clear_approval();
            cx.notify();
        }
    }

    fn focused_input(&self, window: &Window, cx: &App) -> Option<Entity<InputState>> {
        let focused = window.focused(cx)?;
        let mut inputs = vec![
            &self.composer,
            &self.sidebar_filter,
            &self.right_pane_search,
            &self.side_input,
            &self.plugin_source,
            &self.terminal_input,
        ];
        inputs.push(self.browser.address_input());
        inputs.extend(self.ask_inputs.values());
        if let Some(palette) = &self.command_palette {
            inputs.push(&palette.input);
        }
        if let Some(search) = &self.transcript_search {
            inputs.push(&search.input);
        }
        inputs
            .into_iter()
            .find(|input| input.read(cx).focus_handle(cx) == focused)
            .cloned()
    }

    fn poll_composition(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let composing = self.focused_input(window, cx).is_some_and(|input| {
            input.update(cx, |input, cx| {
                input.marked_text_range(window, cx).is_some()
            })
        });
        match (self.last_seen_composing, composing) {
            (_, true) => self.ime_guard.composition_started(),
            (true, false) => self.ime_guard.composition_ended(Instant::now()),
            (false, false) => {}
        }
        self.last_seen_composing = composing;
    }

    fn visible_palette_commands(&self, cx: &App) -> Vec<interaction::WorkspaceCommand> {
        let query = self
            .command_palette
            .as_ref()
            .map(|palette| palette.input.read(cx).value().trim().to_lowercase())
            .unwrap_or_default();
        interaction::WorkspaceCommand::PALETTE
            .into_iter()
            .filter(|command| {
                query.is_empty()
                    || i18n::t(self.language(), command.label_key())
                        .to_lowercase()
                        .contains(&query)
                    || command.id().contains(&query)
            })
            .collect()
    }

    fn normalize_palette_active(&mut self, cx: &App) {
        let count = self.visible_palette_commands(cx).len();
        if let Some(palette) = self.command_palette.as_mut() {
            palette.active = if count == 0 {
                0
            } else {
                palette.active.min(count - 1)
            };
        }
    }

    pub fn open_command_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.command_palette.is_some() {
            return;
        }
        let previous_focus = window.focused(cx);
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t(self.language(), "commandPalette.placeholder"))
        });
        input.update(cx, |input, cx| {
            input.select_all(window, cx);
            let focus = input.focus_handle(cx);
            window.focus(&focus, cx);
        });
        self.palette_subscription =
            Some(cx.subscribe(&input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.normalize_palette_active(cx);
                    cx.notify();
                }
            }));
        self.command_palette = Some(CommandPaletteState {
            input,
            active: 0,
            previous_focus,
        });
        cx.notify();
    }

    pub fn close_command_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(palette) = self.command_palette.take() else {
            return;
        };
        self.palette_subscription = None;
        let focus = palette
            .previous_focus
            .unwrap_or_else(|| self.workspace_focus.clone());
        window.focus(&focus, cx);
        cx.notify();
    }

    fn transcript_search_status(&self, cx: &App) -> (Vec<String>, usize, Option<usize>) {
        let Some(search) = &self.transcript_search else {
            return (Vec::new(), 0, None);
        };
        let query = search.input.read(cx).value();
        let matches = interaction::search_transcript(&self.transcript, &query, search.scope);
        let index = if matches.is_empty() {
            0
        } else {
            search.index % matches.len()
        };
        let active_row = matches
            .get(index)
            .and_then(|id| self.transcript.iter().position(|message| &message.id == id));
        (matches, index, active_row)
    }

    pub fn open_transcript_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(search) = &self.transcript_search {
            let input = search.input.clone();
            input.update(cx, |input, cx| {
                input.select_all(window, cx);
                let focus = input.focus_handle(cx);
                window.focus(&focus, cx);
            });
            cx.notify();
            return;
        }
        let previous_focus = window.focused(cx);
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(i18n::t(self.language(), "transcript.searchPlaceholder"))
                .submit_on_enter(true)
        });
        input.update(cx, |input, cx| {
            let focus = input.focus_handle(cx);
            window.focus(&focus, cx);
        });
        self.transcript_search_subscription =
            Some(cx.subscribe(&input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change)
                    && let Some(search) = this.transcript_search.as_mut()
                {
                    search.index = 0;
                    search.revealed_target = None;
                    cx.notify();
                }
            }));
        self.transcript_search = Some(TranscriptSearch {
            input,
            scope: interaction::SearchScope::All,
            index: 0,
            previous_focus,
            revealed_target: None,
        });
        cx.notify();
    }

    pub fn close_transcript_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(search) = self.transcript_search.take() else {
            return;
        };
        self.transcript_search_subscription = None;
        let focus = search
            .previous_focus
            .unwrap_or_else(|| self.workspace_focus.clone());
        window.focus(&focus, cx);
        if window.focused(cx).is_none() {
            window.focus(&self.workspace_focus, cx);
        }
        cx.notify();
    }

    fn set_transcript_search_scope(
        &mut self,
        scope: interaction::SearchScope,
        cx: &mut Context<Self>,
    ) {
        if let Some(search) = &mut self.transcript_search {
            search.scope = scope;
            search.index = 0;
            search.revealed_target = None;
        }
        cx.notify();
    }

    fn move_transcript_search(&mut self, forward: bool, cx: &mut Context<Self>) {
        let (matches, index, _) = self.transcript_search_status(cx);
        if let Some(next) = interaction::cyclic_index(index, matches.len(), forward)
            && let Some(search) = &mut self.transcript_search
        {
            search.index = next;
            search.revealed_target = None;
            self.transcript_at_bottom = false;
        }
        cx.notify();
    }

    fn reset_transcript_search(&mut self, cx: &mut Context<Self>) {
        if self.transcript_search.take().is_some() {
            self.transcript_search_subscription = None;
            cx.notify();
        }
    }

    pub fn transcript_search_entity(&self) -> Option<Entity<InputState>> {
        self.transcript_search
            .as_ref()
            .map(|search| search.input.clone())
    }

    fn execute_workspace_command(
        &mut self,
        command: interaction::WorkspaceCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if command == interaction::WorkspaceCommand::OpenPalette && self.transcript_search.is_some()
        {
            self.close_transcript_search(window, cx);
        }
        if self.command_palette.is_some() {
            self.close_command_palette(window, cx);
        }
        match command {
            interaction::WorkspaceCommand::OpenPalette => self.open_command_palette(window, cx),
            interaction::WorkspaceCommand::OpenSearch => {
                self.set_view(AppView::Workspace, cx);
                self.open_transcript_search(window, cx);
            }
            interaction::WorkspaceCommand::NewSession => {
                self.set_view(AppView::Workspace, cx);
                if let Some(project) = self.projects.first().cloned() {
                    self.start_new_session(project, cx);
                } else {
                    self.add_project(window, cx);
                }
            }
            interaction::WorkspaceCommand::OpenProjects => {
                self.set_view(AppView::Workspace, cx);
                self.geometry.sidebar_open = true;
                self.sidebar_search_open = true;
                self.reflow_panes();
                self.schedule_geometry_save(cx);
            }
            interaction::WorkspaceCommand::OpenActivity => {
                self.set_view(AppView::Workspace, cx);
                self.set_right_pane("activity", cx);
            }
            interaction::WorkspaceCommand::OpenSchedules => self.set_view(AppView::Schedules, cx),
            interaction::WorkspaceCommand::OpenCapabilities => self.set_view(AppView::Plugins, cx),
            interaction::WorkspaceCommand::OpenBrowser => {
                self.set_view(AppView::Workspace, cx);
                self.set_right_pane("browser", cx);
            }
            interaction::WorkspaceCommand::ToggleSidebar => self.toggle_sidebar(cx),
            interaction::WorkspaceCommand::OpenSettings => self.set_view(AppView::Settings, cx),
            interaction::WorkspaceCommand::Dismiss => {
                self.dismiss_one_layer(window, cx);
            }
        }
        cx.notify();
    }

    fn dismiss_one_layer(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.close_prompt.is_some() {
            self.cancel_close(cx);
            return true;
        }
        if self.ask_dialog.is_some() {
            self.cancel_ask(cx);
            return true;
        }
        if self.command_palette.is_some() {
            self.close_command_palette(window, cx);
            return true;
        }
        if self.transcript_search.is_some() {
            self.close_transcript_search(window, cx);
            return true;
        }
        for menu in [&mut self.mention_menu_open, &mut self.model_menu_open] {
            if *menu {
                *menu = false;
                cx.notify();
                return true;
            }
        }
        if self.project_menu.take().is_some() {
            cx.notify();
            return true;
        }
        for menu in [
            &mut self.terminal_menu_open,
            &mut self.overview_open,
            &mut self.menu_open,
        ] {
            if *menu {
                *menu = false;
                cx.notify();
                return true;
            }
        }
        if self.active_drawer.take().is_some() {
            cx.notify();
            return true;
        }
        false
    }

    fn handle_workspace_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.poll_composition(window, cx);
        let key = event.keystroke.key.to_lowercase();
        let guarded = self.ime_guard.blocks_commit_key(Instant::now());
        if self.command_palette.is_some() {
            match key.as_str() {
                "down" | "up" | "enter" | "escape" => {
                    cx.stop_propagation();
                    if guarded {
                        return;
                    }
                    match key.as_str() {
                        "down" | "up" => {
                            let forward = key == "down";
                            let count = self.visible_palette_commands(cx).len();
                            if let Some(palette) = self.command_palette.as_mut()
                                && let Some(next) =
                                    interaction::cyclic_index(palette.active, count, forward)
                            {
                                palette.active = next;
                                cx.notify();
                            }
                        }
                        "enter" => {
                            self.normalize_palette_active(cx);
                            let command = self.command_palette.as_ref().and_then(|palette| {
                                self.visible_palette_commands(cx)
                                    .get(palette.active)
                                    .copied()
                            });
                            if let Some(command) = command {
                                self.execute_workspace_command(command, window, cx);
                            }
                        }
                        "escape" => {
                            self.dismiss_one_layer(window, cx);
                        }
                        _ => unreachable!(),
                    }
                    return;
                }
                "tab" => {
                    cx.stop_propagation();
                    if let Some(palette) = &self.command_palette {
                        let focus = palette.input.read(cx).focus_handle(cx);
                        window.focus(&focus, cx);
                    }
                    return;
                }
                _ => {
                    if interaction::WorkspaceCommand::from_keystroke(&event.keystroke)
                        .is_some_and(|command| command != interaction::WorkspaceCommand::Dismiss)
                    {
                        cx.stop_propagation();
                    }
                    return;
                }
            }
        }
        if self.transcript_search.is_some() {
            match key.as_str() {
                "enter" | "escape" => {
                    cx.stop_propagation();
                    if guarded {
                        return;
                    }
                    if key == "enter" {
                        self.move_transcript_search(!event.keystroke.modifiers.shift, cx);
                    } else {
                        self.dismiss_one_layer(window, cx);
                    }
                    return;
                }
                _ => {
                    if interaction::WorkspaceCommand::from_keystroke(&event.keystroke)
                        .is_some_and(|command| command != interaction::WorkspaceCommand::Dismiss)
                    {
                        cx.stop_propagation();
                    }
                }
            }
        }
        let Some(command) = interaction::WorkspaceCommand::from_keystroke(&event.keystroke) else {
            return;
        };
        if command == interaction::WorkspaceCommand::Dismiss {
            cx.stop_propagation();
            if !guarded {
                self.dismiss_one_layer(window, cx);
            }
            return;
        }
        if self.close_prompt.is_some() || self.ask_dialog.is_some() {
            return;
        }
        cx.stop_propagation();
        self.execute_workspace_command(command, window, cx);
    }

    pub fn command_palette_entity(&self) -> Option<Entity<InputState>> {
        self.command_palette
            .as_ref()
            .map(|palette| palette.input.clone())
    }

    pub fn browser_address_entity(&self) -> Entity<InputState> {
        self.browser.address_input().clone()
    }

    pub fn browser_navigation_pending(&self) -> bool {
        self.browser.navigation_pending()
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

    /// Selects a right-pane page by name and refreshes what it shows.
    ///
    /// The launcher rows and the parity harness both funnel through here, so a
    /// scenario can reach a pane without clicking a measured position.
    /// `terminal` names the panel under the transcript rather than a right-pane
    /// page: opening it shows the panel but never spawns a shell.
    pub fn set_right_pane(&mut self, pane: &str, cx: &mut Context<Self>) {
        if pane == "terminal" {
            self.terminal_open = true;
            cx.notify();
            return;
        }
        let Some(target) = RightPane::from_name(pane) else {
            panic!("unknown right pane: {pane}");
        };
        self.right_pane = target;
        // The pane only draws while the geometry docks it, so asking for a pane
        // opens it first, exactly like the toolbar's panel button.
        self.geometry.right_pane_open = true;
        self.reflow_panes();
        // A compact window has no docked column to put the pane in, so asking
        // for one raises the same overlay the toolbar's Details toggle draws.
        if self.right_drawer_layout() {
            self.active_drawer = Some(CollapsedPane::RightPane);
            self.geometry.compact_restore = Some("rightPane".to_string());
        }
        if let Some(bounds) = self.last_bounds {
            self.layout = self.geometry.resolve(bounds.2 as f64);
        }
        self.resize_terminal();
        self.schedule_geometry_save(cx);
        match target {
            RightPane::Review => self.refresh_review(),
            RightPane::Files => self.refresh_files(),
            // Opening the pane is the acknowledgement: the list is shown, so
            // its records are marked read and the toolbar badge clears.
            RightPane::Activity => self.mark_notifications_read(cx),
            // The Browser pane opens one blank tab; its webview needs a window,
            // so `render` builds it on the next frame.
            RightPane::Browser => self.browser.prepare(),
            _ => {}
        }
        cx.notify();
    }

    /// A read-only JSON view of the state the parity harness asserts on.
    ///
    /// Every field is copied out of live state: nothing is fetched, spawned or
    /// mutated, so a scenario can snapshot before and after an action. The
    /// composer's text lives in its own entity, which is why this needs `cx`.
    pub fn debug_snapshot(&self, cx: &mut Context<Self>) -> Value {
        let sessions: Vec<Value> = self
            .sessions
            .iter()
            .map(|session| {
                json!({
                    "title": session.title,
                    "pinned": session.pinned,
                    "archived": session.archived,
                    "projectPath": session.project_path,
                })
            })
            .collect();
        let transcript: Vec<Value> = self
            .transcript
            .iter()
            .map(|message| {
                json!({
                    "id": message.id,
                    "role": message.role,
                    "parts": message
                        .parts
                        .iter()
                        .map(|part| json!({
                            "kind": part.kind,
                            "text": part.text,
                            // How many `$…$`/`$$…$$` runs the part is drawn
                            // with, so a scenario can see the styled spans.
                            "mathSegments": transcript_math_segments(part),
                        }))
                        .collect::<Vec<Value>>(),
                })
            })
            .collect();
        let files: Vec<Value> = self
            .files
            .iter()
            .map(|entry| json!({ "path": entry.path, "kind": entry.kind }))
            .collect();
        let projects: Vec<Value> = self
            .projects
            .iter()
            .map(|project| {
                json!({
                    "id": project.id,
                    "name": project.name,
                    "path": project.path,
                })
            })
            .collect();
        let sidebar_groups: Vec<Value> = self
            .sidebar_groups()
            .iter()
            .map(|group| {
                json!({
                    "key": group.key,
                    "name": group.name,
                    "path": group.path,
                    "projectId": group.project_id,
                    "sessions": group.sessions,
                })
            })
            .collect();
        // The Settings picker's view of the catalog: the bounded list the page
        // draws, the provider chips above it, the persisted selection the
        // composer footer reads, and why the list is empty when it is.
        let selected_model = self.settings.last_selected_model();
        let provider_filter = self.provider_filter.as_deref();
        let available_models: Vec<String> = self
            .model_catalog
            .as_ref()
            .map(|catalog| {
                visible_models(&catalog.models, &selected_model, provider_filter)
                    .into_iter()
                    .map(|model| model_key(&model.provider, &model.id))
                    .collect()
            })
            .unwrap_or_default();
        let providers: Vec<Value> = self
            .model_catalog
            .as_ref()
            .map(|catalog| {
                provider_chips(catalog)
                    .into_iter()
                    .map(|chip| {
                        json!({
                            "id": chip.id,
                            "name": chip.name,
                            "configured": chip.configured,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Built in one macro literal for the harness, then extended below: two
        // more keys inside the literal would push the `json!` expansion past
        // the crate's recursion limit.
        let mut snapshot = json!({
            "view": self.view.name(),
            "rightPane": self.right_pane.name(),
            // The close confirmation, while a close is waiting on an answer.
            "closePrompt": self.close_prompt.map(|intent| match intent {
                CloseIntent::Window => "window",
                CloseIntent::Quit => "quit",
            }),
            // The launcher's pin and what it is counting. `overviewVisible`
            // is derived: the launcher is drawn for the workspace view, and for
            // every other view only while it is pinned.
            "overviewPinned": self.overview_pinned,
            "overviewVisible": self.overview_visible(),
            "attention": self.attention_count,
            "layout": {
                "sidebarDocked": self.layout.sidebar_docked,
                "sidebarWidth": self.layout.sidebar_width,
                "rightPaneDocked": self.layout.right_pane_docked,
                "rightPaneWidth": self.layout.right_pane_width,
                "centerWidth": self.layout.center_width,
                "overlay": self.layout.overlay,
            },
            "projects": projects,
            "sidebarGroups": sidebar_groups,
            // Which project row has its menu open, if any.
            "projectMenu": self.project_menu,
            "sessions": sessions,
            "selectedSession": self.selected_session,
            "transcript": transcript,
            // Whether the transcript is pinned to its newest message: false
            // means a reader scrolled up and the jump control is drawn.
            "transcriptAtBottom": self.transcript_at_bottom,
            // The selected session file's own clock and how many external
            // changes re-read it: the parity harness proves the watcher noticed
            // a write from another process without measuring the rows alone.
            "transcriptMtime": self.transcript_stamp.and_then(TranscriptStamp::modified_millis),
            "transcriptReloads": self.transcript_reloads,
            // Whether a turn is in flight, so a send would queue a follow-up.
            "running": self.running,
            // What the harness reports as queued behind the running turn.
            "queuedFollowUps": self.queued_follow_ups,
            // The composer banner's last fork notice: `Forked session` until
            // the next fork. A fork failure is a `runtimeError` instead.
            "forkStatus": self.fork_status,
            // The session menu's actionable rows, in draw order, and whether
            // it is open: a scenario proves a new action is both wired and
            // drawn without measuring a popover's pixels.
            "sessionMenu": {
                "open": self.menu_open,
                "actions": SESSION_MENU_ACTIONS,
            },
            // The harness's last context-window reading, if one arrived.
            "contextUsage": self.context_usage.map(|usage| json!({
                "tokens": usage.tokens,
                "window": usage.window,
                "percent": usage.percent,
            })),
            "settings": {
                "theme": self.settings.theme,
                "density": self.settings.conversation_density,
                // The persisted model selection the composer footer reads.
                "selectedModel": selected_model,
                "showFileChangesPopup": self.settings.show_file_changes_popup,
            },
            // The Settings picker: the bounded catalog list, the provider
            // chips that filter it, the selection it highlights, and a load
            // failure (the current model still works).
            "models": {
                "selected": selected_model,
                "available": available_models,
                "providers": providers,
                "providerFilter": self.provider_filter,
                "error": self.model_catalog_error(),
                "loading": self.model_load_task.is_some(),
                "status": self.model_status,
            },
            "composer": {
                "text": self.composer.read(cx).value().to_string(),
                // The image waiting for the next send. The name, mime and
                // byte size are what the chip draws; the encoded length is
                // enough to prove the bytes are held without copying a whole
                // attachment into the snapshot.
                "pendingImage": self.pending_image.as_ref().map(|image| json!({
                    "name": image.name,
                    "mime": image.mime,
                    "size": image.size,
                    "dataLength": image.data.len(),
                })),
                // Why the last attach was refused, while the banner shows it.
                "imageError": self.image_error,
                // The mention menu's state: whether the popover is drawn, how
                // many rows it holds (bounded by `MENTION_MENU_LIMIT`) and the
                // empty status it shows when that count is zero.
                "mentionMenuOpen": self.mention_menu_open,
                "mentionCount": self.mention_candidates().len(),
                "mentionStatus": self.mention_status,
            },
            "files": {
                "entries": files,
                "skipped": self.files_skipped,
                "error": self.files_error,
            },
            "subagents": self.agents.list(),
            "liveVoice": {
                "runtime": self.runtime_id.is_some(),
                "phase": self.live_phase,
                "active": self.live_active,
                "muted": self.live_muted,
                "error": self.live_error,
            },
            // The live `ask` dialog, if one is waiting. Questions carry only
            // what the pane draws; the selection map is the pane's own state.
            "askDialog": self.ask_dialog.as_ref().map(|dialog| json!({
                "id": dialog.request_id,
                "runtimeId": dialog.runtime_id,
                "title": dialog.title,
                "error": dialog.error,
                "questions": dialog
                    .questions
                    .iter()
                    .map(|question| json!({
                        "id": question.id,
                        "question": question.question,
                        "header": question.header,
                        "multi": question.multi,
                        "recommended": question.recommended,
                        "options": question
                            .options
                            .iter()
                            .map(|option| option.label.clone())
                            .collect::<Vec<String>>(),
                    }))
                    .collect::<Vec<Value>>(),
                "selected": dialog.selected,
            })),
            "terminal": {
                "open": self.terminal_open,
                "session": !self.terminals.is_empty(),
                "running": self
                    .terminals
                    .get(self.active_terminal)
                    .is_some_and(TerminalSession::is_running),
                "error": self.terminal_error,
                "tabs": self.terminals.len(),
                "activeTab": self.active_terminal,
                // What a switch would reopen: live shells are never reused,
                // only the specs filed under the selected session are.
                "restoredTabs": self
                    .terminal_specs
                    .get(&self.terminal_key())
                    .map_or(0, TerminalTabSpecs::len),
            },
            "browser": {
                "visible": self.browser_is_visible(),
                "webviewPending": self.browser.needs_webview(),
                "annotation": {
                    "error": self.browser.annotation_error(),
                    "preview": self.browser.annotation_preview(),
                },
                "tabs": self.browser.tab_count(),
                "activeTab": self.browser.active_tab(),
            },
                       "review": {
                "selectedPath": self.review_focus_path,
                "status": self.review_status,
                "error": self.review_error,
            },
            // The toolbar's last Capture workspace result, if one was taken.
            "capture": {
                "path": self
                    .capture_path
                    .as_ref()
                    .map(|path| path.display().to_string()),
                "error": self.capture_error,
            },
            // The Extensions page: the last toggle's notice or failure and the
            // rows a toggle can reach, read back from the refreshed catalog.
            "extensionStatus": {
                "status": self.plugin_status,
                "error": self.plugin_error,
                "rows": self
                    .plugin_catalog
                    .as_ref()
                    .map(|catalog| {
                        catalog
                            .skills
                            .iter()
                            .filter(|skill| matches!(skill.kind.as_str(), "mcp" | "package"))
                            .map(|skill| json!({
                                "name": skill.name,
                                "kind": skill.kind,
                                "enabled": skill.enabled,
                                "scope": skill.location,
                            }))
                            .collect::<Vec<Value>>()
                    })
                    .unwrap_or_default(),
            },
            // The Extensions install row's field and in-flight state. The
            // source stays here after a failure, so the next attempt can fix
            // it instead of retyping it; the outcome itself is the page's
            // banner, read back through `extensionStatus`.
            "pluginInstallStatus": {
                "source": self.plugin_source.read(cx).value().to_string(),
                "installing": self.plugin_install_task.is_some(),
            },
            "schedules": self.schedules,
            "notifications": self.notifications,
        });
        snapshot["settings"]["locale"] = json!(self.settings.locale);
        snapshot["shell"] = json!({
            "rightPaneTitle": self.right_pane_title(),
            "placeholders": {
                "composer": self.composer.read(cx).presentation().placeholder().to_string(),
                "rightPaneSearch": self.right_pane_search.read(cx).presentation().placeholder().to_string(),
                "sideQuestion": self.side_input.read(cx).presentation().placeholder().to_string(),
                "terminal": self.terminal_input.read(cx).presentation().placeholder().to_string(),
                "pluginSource": self.plugin_source.read(cx).presentation().placeholder().to_string(),
                "sidebar": self.sidebar_filter.read(cx).presentation().placeholder().to_string(),
            },
        });
        // The render's breakpoint decision and whether the compact layout is
        // drawing the right pane as an overlay over the transcript.
        snapshot["turnCard"] = json!({
            "state": self.turn_card.name(),
            "visible": self.turn_card_visible(),
            "baselinePending": self.turn_baseline.is_some(),
            "changes": self.turn_changes,
            "undoTarget": self.turn_card.undo_target().map(|target| match target {
                TurnUndoTarget::WholeTurn => json!({ "kind": "wholeTurn" }),
                TurnUndoTarget::File(path) => json!({ "kind": "file", "path": path }),
            }),
            "error": self.turn_card_error,
        });
        snapshot["compactLayout"] = json!(self.compact_layout);
        snapshot["detailsOpen"] =
            json!(self.compact_layout && self.active_drawer == Some(CollapsedPane::RightPane));
        snapshot["drawer"] = json!(match self.active_drawer {
            Some(CollapsedPane::Sidebar) => "sidebar",
            Some(CollapsedPane::RightPane) => "rightPane",
            None => "none",
        });
        snapshot["streamFeedback"] = json!(match interaction::StreamFeedback::derive(
            self.running,
            self.streaming_index.is_some(),
        ) {
            interaction::StreamFeedback::Idle => "idle",
            interaction::StreamFeedback::AwaitingFirstDelta => "awaitingFirstDelta",
            interaction::StreamFeedback::Receiving => "receiving",
        });
        // The toolbar badge's own count: unread notifications only, so a
        // scenario can watch it clear when the Activity pane opens.
        snapshot["unreadNotifications"] = json!(self.unread_notifications());
        // The terminal's `Send selection` state: what the action would quote
        // and what it last reported. Both are derived, so a scenario can prove
        // the screen survived a send by comparing the selection around it.
        snapshot["terminal"]["selection"] = json!(self.terminal_selection_text());
        snapshot["terminal"]["status"] = json!(self.terminal_status);
        snapshot["terminal"]["screen"] = json!(
            self.terminals
                .get(self.active_terminal)
                .map(TerminalSession::screen_text)
                .unwrap_or_default()
        );
        snapshot["commandPalette"] = self
            .command_palette
            .as_ref()
            .map_or(Value::Null, |palette| {
                let commands = self.visible_palette_commands(cx);
                json!({
                    "open": true,
                    "query": palette.input.read(cx).value().to_string(),
                    "active": palette.active,
                    "activeCommand": commands.get(palette.active).map(|command| command.id()),
                    "commands": commands.iter().map(|command| command.id()).collect::<Vec<_>>(),
                })
            });
        let (search_matches, search_index, search_row) = self.transcript_search_status(cx);
        snapshot["transcriptSearch"] =
            self.transcript_search
                .as_ref()
                .map_or(Value::Null, |search| {
                    let active_match = search_row.map(|row| self.transcript[row].id.clone());
                    let active_bounds = search_row
                        .and_then(|row| self.transcript_scroll.bounds_for_item(row))
                        .map(|bounds| {
                            json!([
                                f32::from(bounds.origin.x),
                                f32::from(bounds.origin.y),
                                f32::from(bounds.size.width),
                                f32::from(bounds.size.height),
                            ])
                        })
                        .unwrap_or(Value::Null);
                    let viewport = self.transcript_scroll.bounds();
                    let query = search.input.read(cx).value().to_string();
                    let needle = query.trim().to_lowercase();
                    let revealed_parts = search_row
                        .map(|row| {
                            self.transcript[row]
                                .parts
                                .iter()
                                .filter(|part| {
                                    matches!(part.kind.as_str(), "thinking" | "toolResult")
                                        && interaction::part_matches_search(
                                            part,
                                            &needle,
                                            search.scope,
                                        )
                                })
                                .map(|part| {
                                    format!(
                                        "{}:{}",
                                        search_row
                                            .map(|row| self.transcript[row].id.clone())
                                            .unwrap_or_default(),
                                        part.id.clone().unwrap_or_else(|| {
                                            part.name.clone().unwrap_or_default()
                                        })
                                    )
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let mut manual_thinking = self.expanded_thinking.iter().collect::<Vec<_>>();
                    manual_thinking.sort();
                    let mut manual_tools = self.expanded_tool_results.iter().collect::<Vec<_>>();
                    manual_tools.sort();
                    json!({
                        "open": true,
                        "query": query,
                        "scope": search.scope.name(),
                        "index": search_index,
                        "count": search_matches.len(),
                        "results": search_matches,
                        "activeMatch": active_match,
                        "activeRow": search_row,
                        "activeBounds": active_bounds,
                        "viewport": [
                            f32::from(viewport.origin.x),
                            f32::from(viewport.origin.y),
                            f32::from(viewport.size.width),
                            f32::from(viewport.size.height),
                        ],
                        "scrollChildren": self.transcript_scroll.children_count(),
                        "scrollOffset": f32::from(self.transcript_scroll.offset().y),
                        "revealedParts": revealed_parts,
                        "manualThinking": manual_thinking,
                        "manualToolResults": manual_tools,
                    })
                });
        snapshot
    }

    fn browser_is_visible(&self) -> bool {
        self.view == AppView::Workspace
            && (self.layout.right_pane_docked
                || self.active_drawer == Some(CollapsedPane::RightPane))
            && self.right_pane == RightPane::Browser
            && self.close_prompt.is_none()
            && self.command_palette.is_none()
            && self.transcript_search.is_none()
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
        let first_bounds = self.last_bounds.is_none();
        let was_compact = self.compact_layout;
        self.last_bounds = Some(current);
        self.compact_layout = compact_layout(current.2);
        self.reflow_panes();
        if !self.layout.right_pane_docked
            && (first_bounds || !was_compact)
            && self.geometry.right_pane_open
        {
            self.geometry.compact_restore = Some("rightPane".to_string());
        }
        self.resize_terminal();
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

    /// A collapsed tool-result disclosure. The header keeps the tool name and
    /// the first line; the full output is one click away, so a long test log
    /// does not take over the transcript.
    fn tool_result_element(
        &self,
        part: &TranscriptPart,
        message_id: &str,
        reveal: bool,
        colors: ThemeColor,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = format!(
            "{message_id}:{}",
            part.id
                .clone()
                .unwrap_or_else(|| part.name.clone().unwrap_or_default())
        );
        let expanded = reveal || self.expanded_tool_results.contains(&key);
        let text = part.text.clone().unwrap_or_default();
        let preview: String = text
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(120)
            .collect();
        let toggle_key = key.clone();
        let body_key = key.clone();
        let color = if part.is_error == Some(true) {
            colors.danger
        } else {
            colors.muted_foreground
        };
        let tool_name = part
            .name
            .clone()
            .unwrap_or_else(|| self.t("transcript.tool").to_string());
        let (state_icon, state_color) = if part.is_error == Some(true) {
            (IconName::CircleAlert, colors.danger)
        } else {
            (IconName::Check, colors.success)
        };
        div()
            .flex()
            .flex_col()
            .gap_1()
            .w_full()
            .child(
                div()
                    .id(format!("tool-result-{key}"))
                    .aria_label("Tool result")
                    .flex()
                    .items_center()
                    .gap_2()
                    .min_h(px(30.0))
                    .py(px(3.0))
                    .text_size(px(13.0))
                    .text_color(colors.muted_foreground)
                    .hover(|style| style.text_color(colors.foreground))
                    .child(
                        div()
                            .size(px(16.0))
                            .text_color(colors.muted_foreground)
                            .child(tool_icon(&tool_name)),
                    )
                    .child(
                        div()
                            .text_color(colors.foreground)
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .child(tool_name),
                    )
                    .child(div().flex_1().overflow_hidden().text_ellipsis().child(
                        if expanded || preview.is_empty() {
                            String::new()
                        } else {
                            format!("· {preview}")
                        },
                    ))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1()
                            .text_size(px(10.0))
                            .text_color(state_color)
                            .child(div().size(px(12.0)).child(state_icon)),
                    )
                    .child(
                        div()
                            .size(px(14.0))
                            .text_color(colors.muted_foreground)
                            .child(if expanded {
                                IconName::ChevronDown
                            } else {
                                IconName::ChevronRight
                            }),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.expanded_tool_results.remove(&toggle_key) {
                            this.expanded_tool_results.insert(toggle_key.clone());
                        }
                        cx.notify();
                    })),
            )
            .when(expanded, |element| {
                element.child(
                    div()
                        .id(format!("tool-result-body-{body_key}"))
                        .ml(px(24.0))
                        .mt(px(1.5))
                        .max_h(px(260.0))
                        .overflow_y_scroll()
                        .rounded(px(11.0))
                        .border_1()
                        .border_color(colors.border)
                        .bg(colors.background)
                        .p(px(9.0))
                        .font_family("Menlo")
                        .text_size(px(11.5))
                        .text_color(color)
                        .child(text)
                        .with_animation(
                            "tool-result-body",
                            interaction::motion_spec(interaction::Motion::Disclosure).animation(),
                            |element, delta| element.opacity(delta),
                        ),
                )
            })
            .into_any_element()
    }

    /// A collapsed thinking disclosure. The body is only built when the row
    /// is open, so a long reasoning block does not dominate the transcript by
    /// default; the Electron version starts folded too.
    fn thinking_part_element(
        &self,
        part: &TranscriptPart,
        message_id: &str,
        reveal: bool,
        colors: ThemeColor,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = format!(
            "{message_id}:{}",
            part.id
                .clone()
                .or_else(|| part.name.clone())
                .unwrap_or_default()
        );
        let expanded = reveal || self.expanded_thinking.contains(&key);
        let text = part.text.clone().unwrap_or_default();
        let preview: String = text
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(120)
            .collect();
        let toggle_key = key.clone();
        let body_key = key.clone();
        div()
            .flex()
            .flex_col()
            .gap_1()
            .w_full()
            .child(
                div()
                    .id(format!("thinking-{key}"))
                    .aria_label("Thinking")
                    .flex()
                    .items_center()
                    .gap_2()
                    .min_h(px(30.0))
                    .py(px(3.0))
                    .text_size(px(13.0))
                    .text_color(colors.muted_foreground)
                    .hover(|style| style.text_color(colors.foreground))
                    .child(div().size(px(14.0)).child(if expanded {
                        IconName::ChevronDown
                    } else {
                        IconName::ChevronRight
                    }))
                    .child(
                        div()
                            .text_color(colors.foreground)
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .child(self.t("transcript.thinking")),
                    )
                    .child(div().flex_1().overflow_hidden().text_ellipsis().child(
                        if expanded || preview.is_empty() {
                            String::new()
                        } else {
                            format!("· {preview}")
                        },
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.expanded_thinking.remove(&toggle_key) {
                            this.expanded_thinking.insert(toggle_key.clone());
                        }
                        cx.notify();
                    })),
            )
            .when(expanded, |element| {
                element.child(
                    div()
                        .id(format!("thinking-body-{body_key}"))
                        .ml(px(24.0))
                        .mt(px(1.5))
                        .text_size(px(13.0))
                        .line_height(px(21.0))
                        .text_color(colors.muted_foreground)
                        .child(text)
                        .test_support()
                        .with_animation(
                            "thinking-body",
                            interaction::motion_spec(interaction::Motion::Timeline).animation(),
                            |element, delta| element.opacity(delta),
                        ),
                )
            })
            .into_any_element()
    }

    /// Builds the sidebar's project rows: granted projects first, then one
    /// row per session folder that was never granted. Session indices stay
    /// the catalog's, so a row click still selects the same record.
    fn sidebar_groups(&self) -> Vec<SidebarGroup> {
        let mut groups: Vec<SidebarGroup> = Vec::new();
        let mut assigned = vec![false; self.sessions.len()];
        for project in &self.projects {
            let mut sessions = Vec::new();
            for (index, session) in self.sessions.iter().enumerate() {
                if assigned[index] {
                    continue;
                }
                if session_path_is_inside(&session.project_path, project) {
                    assigned[index] = true;
                    sessions.push(index);
                }
            }
            groups.push(SidebarGroup {
                key: project.id.clone(),
                name: project.name.clone(),
                path: project.primary_folder.clone(),
                project_id: Some(project.id.clone()),
                sessions,
            });
        }
        for (index, session) in self.sessions.iter().enumerate() {
            if assigned[index] {
                continue;
            }
            if let Some(group) = groups
                .iter_mut()
                .find(|group| group.project_id.is_none() && group.path == session.project_path)
            {
                group.sessions.push(index);
            } else {
                groups.push(SidebarGroup {
                    key: format!("inferred:{}", session.project_path),
                    name: sidebar_project_name(&session.project_path),
                    path: session.project_path.clone(),
                    project_id: None,
                    sessions: vec![index],
                });
            }
        }
        groups
    }

    pub fn toggle_project_collapsed(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.collapsed_projects.remove(key) {
            self.collapsed_projects.insert(key.to_string());
        }
        cx.notify();
    }

    fn sidebar_nav_row(
        &self,
        item: SidebarNavItem,
        colors: ThemeColor,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        div()
            .id(item.id)
            .aria_label(item.label)
            .flex()
            .items_center()
            .gap_2()
            .h(px(32.0))
            .px_2()
            .rounded(px(7.0))
            .text_size(px(13.0))
            .text_color(colors.foreground)
            .when(item.active, |element| element.bg(colors.accent))
            .hover(|style| style.bg(colors.accent))
            .child(
                div()
                    .text_size(px(16.0))
                    .text_color(colors.muted_foreground)
                    .child(item.icon),
            )
            .child(div().flex_1().child(item.label))
            .when_some(item.shortcut, |element, shortcut| {
                element.child(
                    div()
                        .text_size(px(10.5))
                        .text_color(colors.muted_foreground)
                        .child(shortcut),
                )
            })
            .on_click(on_click)
    }

    fn sidebar_session_row(
        &self,
        index: usize,
        session: &SessionRecord,
        colors: ThemeColor,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let selected = self.selected_session == Some(index);
        div()
            .id(format!("session-{index}"))
            .aria_label(session.title.clone())
            .flex()
            .items_center()
            .h(px(37.0))
            .pl(px(26.0))
            .pr_2()
            .rounded(px(7.0))
            .text_size(px(13.0))
            .text_color(if selected {
                colors.foreground
            } else {
                colors.muted_foreground
            })
            .when(selected, |element| element.bg(colors.selection))
            .hover(|style| style.bg(colors.accent))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(session.title.clone()),
            )
            .when(session.pinned, |element| {
                element.child(
                    div()
                        .text_size(px(12.0))
                        .text_color(colors.primary)
                        .child(IconName::Pin),
                )
            })
            .when(session.status == "running", |element| {
                element.child(
                    div()
                        .text_size(px(14.0))
                        .text_color(colors.muted_foreground)
                        .child(IconName::LoaderCircle),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| this.select_session(index, cx)))
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let query = self.sidebar_filter.read(cx).value().trim().to_lowercase();
        let groups: Vec<SidebarGroup> = self
            .sidebar_groups()
            .into_iter()
            .filter_map(|mut group| {
                if !query.is_empty() {
                    group.sessions.retain(|index| {
                        let session = &self.sessions[*index];
                        session.title.to_lowercase().contains(&query)
                            || session.project_path.to_lowercase().contains(&query)
                    });
                    if group.sessions.is_empty() {
                        return None;
                    }
                }
                Some(group)
            })
            .collect();
        div()
            .id("sidebar")
            .test_support()
            .flex()
            .flex_col()
            .h_full()
            .w(px(if self.layout.sidebar_docked {
                self.layout.sidebar_width
            } else {
                omp_core::geometry::clamp_sidebar(self.geometry.sidebar_width)
            } as f32))
            // The resolved width is already clamped; the bounds make the
            // sidebar's floor and ceiling explicit in the layout itself.
            .min_w(px(SIDEBAR_MIN_WIDTH as f32))
            .max_w(px(SIDEBAR_MAX_WIDTH as f32))
            .bg(colors.sidebar)
            .border_r_1()
            .border_color(colors.border)
            .child(
                div()
                    .h(px(52.0))
                    .flex()
                    .items_center()
                    .gap_1()
                    .pr_2()
                    .child(div().w(px(84.0)))
                    .child(div().flex_1())
                    .child(self.toolbar_icon(
                        "sidebar-new-session",
                        IconName::SquarePen,
                        colors.muted_foreground,
                        cx.listener(|this, _, window, cx| {
                            if let Some(project) = this.projects.first().cloned() {
                                this.start_new_session(project, cx);
                            } else {
                                this.add_project(window, cx);
                            }
                        }),
                    ))
                    .child(self.toolbar_icon(
                        "sidebar-collapse",
                        IconName::PanelLeftClose,
                        colors.muted_foreground,
                        cx.listener(|this, _, _, cx| this.toggle_sidebar(cx)),
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .px_2()
                    .pb_2()
                    .border_b_1()
                    .border_color(colors.border)
                    .child(self.sidebar_nav_row(
                        SidebarNavItem {
                            id: "new-session",
                            icon: IconName::SquarePen,
                            label: self.t("sidebar.newSession"),
                            shortcut: Some("⌘N"),
                            active: false,
                        },
                        colors,
                        cx.listener(|this, _, window, cx| {
                            if let Some(project) = this.projects.first().cloned() {
                                this.start_new_session(project, cx);
                            } else {
                                this.add_project(window, cx);
                            }
                        }),
                    ))
                    .child(self.sidebar_nav_row(
                        SidebarNavItem {
                            id: "search-nav",
                            icon: IconName::Search,
                            label: self.t("sidebar.search"),
                            shortcut: None,
                            active: self.sidebar_search_open,
                        },
                        colors,
                        cx.listener(|this, _, _, cx| {
                            this.sidebar_search_open = !this.sidebar_search_open;
                            cx.notify();
                        }),
                    ))
                    .child(self.sidebar_nav_row(
                        SidebarNavItem {
                            id: "projects-nav",
                            icon: IconName::Folder,
                            label: self.t("sidebar.projects"),
                            shortcut: None,
                            active: self.view == AppView::Workspace
                                && self.selected_session.is_none()
                                && !self.sidebar_search_open,
                        },
                        colors,
                        cx.listener(|this, _, _, cx| {
                            this.sidebar_search_open = false;
                            this.set_view(AppView::Workspace, cx);
                        }),
                    ))
                    .child(self.sidebar_nav_row(
                        SidebarNavItem {
                            id: "activity-nav",
                            icon: IconName::Activity,
                            label: self.t("sidebar.activity"),
                            shortcut: None,
                            active: self.right_pane == RightPane::Activity,
                        },
                        colors,
                        cx.listener(|this, _, _, cx| this.set_right_pane("activity", cx)),
                    ))
                    .child(self.sidebar_nav_row(
                        SidebarNavItem {
                            id: "schedules-nav",
                            icon: IconName::Clock,
                            label: self.t("sidebar.schedules"),
                            shortcut: None,
                            active: self.view == AppView::Schedules,
                        },
                        colors,
                        cx.listener(|this, _, _, cx| this.set_view(AppView::Schedules, cx)),
                    ))
                    .child(self.sidebar_nav_row(
                        SidebarNavItem {
                            id: "capabilities-nav",
                            icon: IconName::Puzzle,
                            label: self.t("sidebar.capabilities"),
                            shortcut: None,
                            active: self.view == AppView::Plugins,
                        },
                        colors,
                        cx.listener(|this, _, _, cx| this.set_view(AppView::Plugins, cx)),
                    ))
                    .when(self.sidebar_search_open, |element| {
                        element.child(div().px_2().pb_1().child(Input::new(&self.sidebar_filter)))
                    }),
            )
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h(px(0.0))
                    .overflow_y_scroll()
                    .px_2()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .px_2()
                            .py_1()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(colors.muted_foreground)
                                    .child(self.t("sidebar.projectsHeading")),
                            )
                            .child(
                                div()
                                    .id("add-project")
                                    .aria_label("Add project")
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(22.0))
                                    .rounded(px(6.0))
                                    .text_color(colors.muted_foreground)
                                    .hover(|style| style.bg(colors.accent))
                                    .child(IconName::Plus)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.add_project(window, cx);
                                    })),
                            ),
                    )
                    .when(groups.is_empty(), |element| {
                        element.child(
                            div()
                                .px_2()
                                .py_3()
                                .text_size(px(12.0))
                                .text_color(colors.muted_foreground)
                                .child(if query.is_empty() {
                                    self.t("sidebar.noProjects")
                                } else {
                                    self.t("sidebar.noMatches")
                                }),
                        )
                    })
                    .children(groups.into_iter().map(|group| {
                        let key = group.key.clone();
                        let header_key = key.clone();
                        let menu_key = key.clone();
                        let collapsed = self.collapsed_projects.contains(&key);
                        let project_id = group.project_id.clone();
                        let project = project_id.as_ref().and_then(|id| {
                            self.projects
                                .iter()
                                .find(|project| &project.id == id)
                                .cloned()
                        });
                        let menu_open = project_id.is_some()
                            && project_id.as_deref() == self.project_menu.as_deref();
                        let project_group = format!("project-row-{key}");
                        let project_selected = group
                            .sessions
                            .iter()
                            .any(|index| self.selected_session == Some(*index));
                        let group_running = group
                            .sessions
                            .iter()
                            .any(|index| self.sessions[*index].status == "running");
                        div()
                            .flex()
                            .flex_col()
                            .gap_0p5()
                            .child(
                                div()
                                    .id(format!("project-group-{key}"))
                                    .aria_label(group.name.clone())
                                    .flex()
                                    .items_center()
                                    .gap_1()
                                    .h(px(34.0))
                                    .px_1()
                                    .rounded(px(7.0))
                                    .group(project_group.clone())
                                    .hover(|style| style.bg(colors.accent))
                                    .when(project_selected, |element| element.bg(colors.selection))
                                    .child(
                                        div()
                                            .text_size(px(14.0))
                                            .text_color(colors.muted_foreground)
                                            .child(if collapsed {
                                                IconName::ChevronRight
                                            } else {
                                                IconName::ChevronDown
                                            }),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(16.0))
                                            .text_color(colors.muted_foreground)
                                            .child(IconName::Folder),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(0.0))
                                            .overflow_hidden()
                                            .text_ellipsis()
                                            .text_size(px(13.0))
                                            .font_weight(gpui::FontWeight::MEDIUM)
                                            .child(group.name.clone()),
                                    )
                                    .when(collapsed && group_running, |element| {
                                        element.child(
                                            div()
                                                .size(px(16.0))
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .rounded(px(999.0))
                                                .bg(colors.primary.opacity(0.13))
                                                .with_animation(
                                                    "project-working",
                                                    interaction::motion_spec(
                                                        interaction::Motion::ProjectPulse,
                                                    )
                                                    .animation(),
                                                    |element, delta| {
                                                        element.opacity(
                                                            0.45 + 0.55
                                                                * (1.0 - (2.0 * delta - 1.0).abs()),
                                                        )
                                                    },
                                                )
                                                .child(
                                                    div()
                                                        .size(px(6.0))
                                                        .rounded(px(999.0))
                                                        .bg(colors.primary),
                                                ),
                                        )
                                    })
                                    .when(
                                        project.as_ref().is_some_and(|project| project.pinned),
                                        |element| {
                                            element.child(
                                                div()
                                                    .text_size(px(14.0))
                                                    .text_color(colors.primary)
                                                    .child(IconName::Pin),
                                            )
                                        },
                                    )
                                    .when_some(project.clone(), |element, project| {
                                        element.child(
                                            div()
                                                .id(format!("project-new-{}", project.id))
                                                .aria_label("New session")
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .size(px(22.0))
                                                .rounded(px(5.0))
                                                .text_color(colors.muted_foreground)
                                                .opacity(0.0)
                                                .group_hover(project_group.clone(), |style| {
                                                    style.opacity(1.0)
                                                })
                                                .hover(|style| style.bg(colors.background))
                                                .child(
                                                    div()
                                                        .text_size(px(14.0))
                                                        .child(IconName::SquarePen),
                                                )
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.start_new_session(project.clone(), cx);
                                                    cx.stop_propagation();
                                                })),
                                        )
                                    })
                                    .when_some(project_id.clone(), |element, id| {
                                        element.child(
                                            div()
                                                .id(format!("project-menu-{id}"))
                                                .aria_label("Project menu")
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .size(px(22.0))
                                                .rounded(px(5.0))
                                                .text_color(colors.muted_foreground)
                                                .opacity(0.0)
                                                .group_hover(project_group, |style| {
                                                    style.opacity(1.0)
                                                })
                                                .hover(|style| style.bg(colors.background))
                                                .child(
                                                    div()
                                                        .text_size(px(14.0))
                                                        .child(IconName::EllipsisVertical),
                                                )
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.toggle_project_menu(&id, cx);
                                                    cx.stop_propagation();
                                                })),
                                        )
                                    })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.toggle_project_collapsed(&header_key, cx);
                                    })),
                            )
                            .when(menu_open, |element| {
                                let menu_key = menu_key.clone();
                                element.child(
                                    div()
                                        .id(format!("project-menu-panel-{menu_key}"))
                                        .ml(px(24.0))
                                        .flex()
                                        .flex_col()
                                        .gap_0p5()
                                        .child(
                                            div()
                                                .id(format!("project-remove-{menu_key}"))
                                                .aria_label("Remove project")
                                                .px_2()
                                                .py_1()
                                                .rounded(px(6.0))
                                                .text_size(px(12.0))
                                                .text_color(colors.foreground)
                                                .hover(|style| style.bg(colors.accent))
                                                .child("Remove project")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.project_menu_action(
                                                        &menu_key,
                                                        "Remove project",
                                                        cx,
                                                    );
                                                })),
                                        ),
                                )
                            })
                            .when(!collapsed, |element| {
                                element.children(group.sessions.into_iter().map(|index| {
                                    self.sidebar_session_row(
                                        index,
                                        &self.sessions[index],
                                        colors,
                                        cx,
                                    )
                                }))
                            })
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .border_t_1()
                    .border_color(colors.border)
                    .p_2()
                    .child(
                        div()
                            .id("update-nav")
                            .aria_label("Check for updates")
                            .flex()
                            .items_center()
                            .gap_2()
                            .h(px(32.0))
                            .px_2()
                            .rounded(px(7.0))
                            .text_size(px(13.0))
                            .text_color(colors.foreground)
                            .hover(|style| style.bg(colors.accent))
                            .child(
                                div()
                                    .text_size(px(16.0))
                                    .text_color(colors.muted_foreground)
                                    .child(IconName::Download),
                            )
                            .child(div().flex_1().overflow_hidden().text_ellipsis().child(
                                match self.update_check.label().as_str() {
                                    "not configured" => {
                                        self.t("sidebar.update.notConfigured").to_string()
                                    }
                                    label => label.to_string(),
                                },
                            ))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.start_update_check(cx);
                            })),
                    )
                    .child(self.sidebar_nav_row(
                        SidebarNavItem {
                            id: "settings-nav",
                            icon: IconName::Settings,
                            label: self.t("sidebar.settings"),
                            shortcut: None,
                            active: self.view == AppView::Settings,
                        },
                        colors,
                        cx.listener(|this, _, _, cx| this.set_view(AppView::Settings, cx)),
                    )),
            )
    }

    fn language(&self) -> Language {
        i18n::resolve(self.settings.locale)
    }

    fn t(&self, key: &'static str) -> &'static str {
        i18n::t(self.language(), key)
    }

    fn sync_localized_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let language = self.language();
        let inputs = [
            (&self.composer, "composer.placeholder"),
            (&self.right_pane_search, "rightPane.searchPlaceholder"),
            (&self.side_input, "sideQuestion.placeholder"),
            (&self.terminal_input, "terminal.placeholder"),
            (&self.plugin_source, "plugin.sourcePlaceholder"),
            (&self.sidebar_filter, "sidebar.sessionsPlaceholder"),
        ];
        for (input, key) in inputs {
            let placeholder = i18n::t(language, key);
            if input.read(cx).presentation().placeholder().as_str() == placeholder {
                continue;
            }
            input.update(cx, |state, cx| {
                state.set_placeholder(placeholder, window, cx);
            });
        }

        let placeholder = i18n::t(language, "ask.answerPlaceholder");
        for input in self.ask_inputs.values().cloned().collect::<Vec<_>>() {
            if input.read(cx).presentation().placeholder().as_str() == placeholder {
                continue;
            }
            input.update(cx, |state, cx| {
                state.set_placeholder(placeholder, window, cx);
            });
        }
    }

    fn right_pane_title(&self) -> &'static str {
        match self.right_pane {
            RightPane::Launcher => self.t("rightPane.overview"),
            RightPane::Summary => self.t("rightPane.summary"),
            RightPane::Review => self.t("rightPane.review"),
            RightPane::Files => self.t("rightPane.files"),
            RightPane::Browser => self.t("rightPane.browser"),
            RightPane::SideQuestion => self.t("rightPane.sideQuestion"),
            RightPane::Ask => self.t("rightPane.ask"),
            RightPane::Subagents => self.t("rightPane.subagents"),
            RightPane::LiveVoice => self.t("rightPane.liveVoice"),
            RightPane::Activity => self.t("sidebar.activity"),
        }
    }

    fn locale_label(&self) -> &'static str {
        match self.settings.locale {
            omp_core::settings::Locale::System => self.t("settings.locale.system"),
            omp_core::settings::Locale::En => "en",
            omp_core::settings::Locale::ZhTw => "zh-TW",
            omp_core::settings::Locale::ZhCn => "zh-CN",
        }
    }

    fn reflow_panes(&mut self) {
        if let Some(bounds) = self.last_bounds {
            self.layout = self.geometry.resolve(bounds.2 as f64);
        }
        if self.layout.right_pane_docked {
            if self.active_drawer == Some(CollapsedPane::RightPane) {
                self.active_drawer = None;
            }
            self.geometry.compact_restore = None;
        }
        if self.layout.sidebar_docked && self.active_drawer == Some(CollapsedPane::Sidebar) {
            self.active_drawer = None;
        }
    }

    fn right_drawer_layout(&self) -> bool {
        self.compact_layout || self.layout.overlay.as_deref() == Some("rightPane")
    }

    pub fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        let small = self
            .last_bounds
            .is_some_and(|bounds| bounds.2 <= omp_core::geometry::SMALL_BREAKPOINT as f32);
        if small {
            if self.active_drawer == Some(CollapsedPane::Sidebar) {
                self.active_drawer = None;
                self.geometry.sidebar_open = false;
            } else {
                self.active_drawer = Some(CollapsedPane::Sidebar);
                self.geometry.sidebar_open = true;
                self.geometry.compact_restore = Some("sidebar".to_string());
            }
        } else {
            self.geometry.sidebar_open = !self.geometry.sidebar_open;
        }
        self.reflow_panes();
        self.schedule_geometry_save(cx);
        cx.notify();
    }

    /// Toggles the right pane: the docked pane in a wide window, the overlay
    /// in a compact one. The toolbar button and the parity test both call this
    /// path, so the control and its test cannot drift apart.
    pub fn toggle_details(&mut self, cx: &mut Context<Self>) {
        if self.right_drawer_layout() {
            if self.active_drawer == Some(CollapsedPane::RightPane) {
                self.active_drawer = None;
            } else {
                self.active_drawer = Some(CollapsedPane::RightPane);
                self.geometry.right_pane_open = true;
                self.geometry.compact_restore = Some("rightPane".to_string());
            }
            self.reflow_panes();
            self.schedule_geometry_save(cx);
        } else {
            self.geometry.right_pane_open = !self.geometry.right_pane_open;
            self.reflow_panes();
            self.resize_terminal();
            self.schedule_geometry_save(cx);
        }
        cx.notify();
    }

    pub fn close_drawer(&mut self, cx: &mut Context<Self>) {
        if self.active_drawer.take().is_some() {
            cx.notify();
        }
    }

    fn command_palette(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let commands = self.visible_palette_commands(cx);
        let active = self
            .command_palette
            .as_ref()
            .map_or(0, |palette| palette.active);
        div()
            .id("command-palette")
            .aria_label(self.t("sidebar.commands"))
            .test_support()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .bg(black().opacity(0.32))
            .on_click(|_, _, _| {})
            .child(
                div()
                    .id("command-palette-card")
                    .test_support()
                    .mt(px(96.0))
                    .max_h(px(480.0))
                    .w(px(560.0))
                    .overflow_hidden()
                    .rounded(px(12.0))
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.background)
                    .p_2()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .id("command-palette-input")
                            .test_support()
                            .px_3()
                            .py_2()
                            .border_b_1()
                            .border_color(colors.border)
                            .children(
                                self.command_palette
                                    .as_ref()
                                    .map(|palette| Input::new(&palette.input)),
                            ),
                    )
                    .child(
                        div()
                            .id("command-results")
                            .test_support()
                            .flex()
                            .flex_col()
                            .gap_0p5()
                            .overflow_y_scroll()
                            .children(commands.iter().enumerate().map(|(index, command)| {
                                let command = *command;
                                div()
                                    .id(format!("command-{}", command.id()))
                                    .test_support()
                                    .aria_label(self.t(command.label_key()))
                                    .px_3()
                                    .py_2()
                                    .rounded(px(7.0))
                                    .bg(if index == active {
                                        colors.selection
                                    } else {
                                        colors.background
                                    })
                                    .hover(|style| style.bg(colors.accent))
                                    .child(self.t(command.label_key()))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.execute_workspace_command(command, window, cx);
                                    }))
                            }))
                            .when(commands.is_empty(), |element| {
                                element.child(
                                    div()
                                        .id("command-no-match")
                                        .px_3()
                                        .py_2()
                                        .text_color(colors.muted_foreground)
                                        .child(self.t("commandPalette.noMatch")),
                                )
                            }),
                    ),
            )
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let selected = self
            .selected_session
            .and_then(|index| self.sessions.get(index));
        let title = selected
            .map(|session| session.title.clone())
            .unwrap_or_else(|| "OMP Desktop".to_string());
        let branch = selected
            .and_then(|session| {
                self.projects
                    .iter()
                    .find(|project| session_path_is_inside(&session.project_path, project))
            })
            .and_then(|project| project.git_branch.clone());
        let panel_active = if self.right_drawer_layout() {
            self.active_drawer == Some(CollapsedPane::RightPane)
        } else {
            self.geometry.right_pane_open
        };
        let (status, status_color, status_bg, status_icon) = if self.running {
            (
                self.t("sidebar.status.running"),
                colors.success,
                colors.success.opacity(0.14),
                Some(IconName::LoaderCircle),
            )
        } else if !self.transcript.is_empty() {
            (
                self.t("sidebar.status.completed"),
                colors.success,
                colors.success.opacity(0.14),
                Some(IconName::Check),
            )
        } else {
            (
                self.t("sidebar.status.idle"),
                colors.muted_foreground,
                colors.accent,
                None,
            )
        };
        div()
            .flex()
            .items_center()
            .gap_2()
            .h(px(52.0))
            .px_3()
            .border_b_1()
            .border_color(colors.border)
            .when(!self.layout.sidebar_docked, |element| {
                element.child(self.toolbar_icon(
                    "sidebar-toggle",
                    IconName::PanelLeft,
                    colors.foreground,
                    cx.listener(|this, _, _, cx| this.toggle_sidebar(cx)),
                ))
            })
            .child(
                div()
                    .text_size(px(12.5))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(colors.foreground)
                    .child(title),
            )
            .when_some(branch, |element, branch| {
                element.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_1()
                        .h(px(24.0))
                        .max_w(px(180.0))
                        .overflow_hidden()
                        .px_2()
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(colors.border)
                        .bg(colors.tab)
                        .text_size(px(11.5))
                        .text_color(colors.muted_foreground)
                        .child(IconName::GitBranch)
                        .child(div().overflow_hidden().text_ellipsis().child(branch)),
                )
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .py_0p5()
                    .rounded(px(999.0))
                    .bg(status_bg)
                    .text_size(px(10.5))
                    .text_color(status_color)
                    .when_some(status_icon, |element, icon| {
                        element.child(div().text_size(px(12.0)).child(icon))
                    })
                    .child(status),
            )
            .child(div().flex_1())
            .child(
                div()
                    .id("transcript-search-trigger")
                    .aria_label(self.t("transcript.search"))
                    .child(self.toolbar_icon(
                        "transcript-search-open",
                        IconName::Search,
                        if self.transcript_search.is_some() {
                            colors.primary
                        } else {
                            colors.foreground
                        },
                        cx.listener(|this, _, window, cx| {
                            this.open_transcript_search(window, cx);
                        }),
                    ))
                    .test_support(),
            )
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
                if self.overview_open {
                    colors.primary
                } else {
                    colors.foreground
                },
                cx.listener(|this, _, _, cx| {
                    this.overview_open = !this.overview_open;
                    cx.notify();
                }),
            ))
            .child(self.toolbar_icon(
                "right-pane-toggle",
                IconName::PanelRight,
                if panel_active {
                    colors.primary
                } else {
                    colors.foreground
                },
                cx.listener(|this, _, _, cx| this.toggle_details(cx)),
            ))
    }

    fn toolbar_icon(
        &self,
        id: &'static str,
        icon: IconName,
        color: gpui::Hsla,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let label = match id {
            "transcript-search-open" => self.t("transcript.search"),
            "transcript-search-previous" => self.t("common.previous"),
            "transcript-search-next" => self.t("common.next"),
            "transcript-search-close" => self.t("common.close"),
            _ => id,
        };
        div()
            .id(id)
            .aria_label(label)
            .flex()
            .items_center()
            .justify_center()
            .size(px(28.0))
            .rounded(px(6.0))
            .text_size(px(16.0))
            .text_color(color)
            .hover(|style| style.bg(color.opacity(0.12)))
            .child(icon)
            .on_click(move |event, window, cx| {
                on_click(event, window, cx);
                cx.stop_propagation();
            })
            .test_support()
    }

    /// The one-line result of the last capture: the saved path, or the error
    /// that replaced it. Nothing is drawn until a capture has been taken.
    fn capture_status_row(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let (text, color) = match (&self.capture_error, &self.capture_path) {
            (Some(error), _) => (error.clone(), colors.danger),
            (None, Some(path)) => (format!("Saved {}", path.display()), colors.muted_foreground),
            (None, None) => (String::new(), colors.muted_foreground),
        };
        div()
            .id("capture-status")
            .aria_label("Capture status")
            .px_3()
            .py_1()
            .text_xs()
            .text_color(color)
            .border_b_1()
            .border_color(colors.border)
            .child(text)
    }

    /// The bucket a session's terminal tabs are filed under: the session's
    /// stable id, or the draft key while a new session has no id yet.
    fn terminal_key(&self) -> String {
        self.selected_session
            .and_then(|index| self.sessions.get(index))
            .map(|session| session.id.clone())
            .unwrap_or_else(|| DRAFT_TERMINAL_KEY.to_string())
    }

    /// The tabs the selected session remembers, if any.
    fn current_terminal_specs(&self) -> TerminalTabSpecs {
        self.terminal_specs
            .get(&self.terminal_key())
            .cloned()
            .unwrap_or_default()
    }

    /// Opens the terminal panel and restores the selected session's tabs.
    ///
    /// A session with no saved tabs starts one shell in the selected project's
    /// directory; a session that has some reopens exactly those. Either way a
    /// PTY or spawn failure is shown inside the panel instead of panicking.
    fn start_terminal(&mut self, cx: &mut Context<Self>) {
        self.terminal_open = true;
        if self.terminals.is_empty() {
            let specs = self.current_terminal_specs();
            if specs.is_empty() {
                self.open_terminal_tab(cx);
            } else {
                self.reopen_terminal_tabs(&specs, cx);
            }
        }
        cx.notify();
    }

    /// Opens a tab in the selected project's directory and makes it active,
    /// opening the panel first.
    fn new_terminal_tab(&mut self, cx: &mut Context<Self>) {
        self.terminal_open = true;
        self.open_terminal_tab(cx);
        cx.notify();
    }

    /// Starts one shell for a new tab, files its spec under the current
    /// session and watches its output.
    ///
    /// A spawn failure is recorded instead of panicking; the panel stays open
    /// so the message is visible and `+` can retry.
    fn open_terminal_tab(&mut self, cx: &mut Context<Self>) {
        let cwd = self
            .project_cwd()
            .map(PathBuf::from)
            .filter(|path| path.is_dir());
        let (rows, cols) = terminal::size_for_width(self.layout.center_width);
        match TerminalSession::spawn(cwd.as_deref(), rows, cols) {
            Ok(session) => {
                let spec = TerminalTabSpec::from_session(&session);
                self.adopt_terminal(session, cx);
                let key = self.terminal_key();
                self.terminal_specs.entry(key).or_default().add(spec);
            }
            Err(error) => self.terminal_error = Some(error),
        }
    }

    /// Reopens one saved tab with a fresh shell: the session that owned the
    /// old shell is gone, so only the spec's program and directory carry over.
    fn restore_terminal_tab(&mut self, spec: &TerminalTabSpec, cx: &mut Context<Self>) {
        let (rows, cols) = terminal::size_for_width(self.layout.center_width);
        match TerminalSession::spawn_with_shell(
            spec.shell.as_str(),
            spec.cwd.as_deref(),
            rows,
            cols,
        ) {
            Ok(session) => self.adopt_terminal(session, cx),
            Err(error) => self.terminal_error = Some(error),
        }
    }

    /// Reopens every spec in order and selects the tab that was active.
    fn reopen_terminal_tabs(&mut self, specs: &TerminalTabSpecs, cx: &mut Context<Self>) {
        for spec in specs.tabs() {
            self.restore_terminal_tab(spec, cx);
        }
        if !self.terminals.is_empty() {
            self.active_terminal = specs.active().min(self.terminals.len() - 1);
        }
    }

    /// Stops the live shells and reopens the tabs the newly selected session
    /// remembers. A closed panel only drops the shells: its specs stay filed
    /// for the next open, and `terminal_open` itself is global.
    fn restore_terminal_tabs(&mut self, cx: &mut Context<Self>) {
        self.terminals.clear();
        self.terminal_tasks.clear();
        self.active_terminal = 0;
        self.terminal_error = None;
        self.terminal_status = None;
        self.terminal_menu_open = false;
        if !self.terminal_open {
            return;
        }
        let specs = self.current_terminal_specs();
        self.reopen_terminal_tabs(&specs, cx);
    }

    /// Pushes a freshly started shell into the panel and watches its output.
    fn adopt_terminal(&mut self, session: TerminalSession, cx: &mut Context<Self>) {
        let notifications = session.notifications();
        self.terminals.push(session);
        self.active_terminal = self.terminals.len() - 1;
        self.terminal_error = None;
        self.terminal_status = None;
        // Wake on output bursts rather than polling; the channel closes when
        // this tab's session is dropped, which ends this task.
        self.terminal_tasks.push(cx.spawn(async move |this, cx| {
            while notifications.recv().await.is_ok() {
                let still_open = this
                    .update(cx, |this, cx| {
                        // Fresh output supersedes the last send notice, so an
                        // empty-screen status never outlives the blank screen.
                        this.terminal_status = None;
                        cx.notify();
                        !this.terminals.is_empty()
                    })
                    .unwrap_or(false);
                if !still_open {
                    break;
                }
            }
        }));
    }

    /// Makes `index` the tab the panel draws and sends input to, and remembers
    /// it as the session's active tab.
    fn select_terminal_tab(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.terminals.len() {
            self.active_terminal = index;
            let key = self.terminal_key();
            if let Some(specs) = self.terminal_specs.get_mut(&key) {
                specs.select(index);
            }
            cx.notify();
        }
    }

    /// Closes one tab, selecting the nearest remaining one; closing the last
    /// tab closes the panel. Dropping the session kills its shell.
    fn close_terminal_tab(&mut self, index: usize, cx: &mut Context<Self>) {
        let len = self.terminals.len();
        if index >= len {
            return;
        }
        self.terminals.remove(index);
        let next = terminal::tab_after_close(self.active_terminal, index, len);
        let key = self.terminal_key();
        if let Some(specs) = self.terminal_specs.get_mut(&key) {
            specs.close(index);
            if let Some(next) = next {
                specs.select(next);
            }
        }
        match next {
            Some(next) => {
                self.active_terminal = next;
                cx.notify();
            }
            None => self.close_terminal(cx),
        }
    }

    /// Closes the panel and every live tab; dropping the sessions kills the
    /// shells. The session's specs stay filed, so reopening the panel restores
    /// the same tabs; a bucket left empty is dropped.
    fn close_terminal(&mut self, cx: &mut Context<Self>) {
        self.terminals.clear();
        self.terminal_tasks.clear();
        self.active_terminal = 0;
        self.terminal_open = false;
        self.terminal_error = None;
        self.terminal_status = None;
        self.terminal_menu_open = false;
        let key = self.terminal_key();
        if self
            .terminal_specs
            .get(&key)
            .is_some_and(TerminalTabSpecs::is_empty)
        {
            self.terminal_specs.remove(&key);
        }
        cx.notify();
    }

    /// Keeps every shell's column count in step with the center column.
    fn resize_terminal(&mut self) {
        let (rows, cols) = terminal::size_for_width(self.layout.center_width);
        for session in &mut self.terminals {
            if let Err(error) = session.resize(rows, cols) {
                self.terminal_error = Some(error);
            }
        }
    }

    /// Sends the input line to the active tab's shell and clears it.
    fn send_terminal_line(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let line = self.terminal_input.read(cx).value().to_string();
        self.terminal_input
            .update(cx, |input, cx| input.set_value("", window, cx));
        if let Some(session) = self.terminals.get_mut(self.active_terminal)
            && let Err(error) = session.send_line(&line)
        {
            self.terminal_error = Some(error);
        }
        cx.notify();
    }

    /// Runs one row of the terminal header menu and closes it.
    ///
    /// Copy puts the active screen's text on the clipboard, Paste appends the
    /// clipboard to the input line (never to the PTY), Send selection quotes
    /// the screen's last output row into the composer draft without sending,
    /// and Clear resets the screen mirror while the shell keeps running. An
    /// unknown id closes the menu and does nothing else.
    fn terminal_menu_click(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.terminal_menu_open = false;
        match terminal_menu_action(id) {
            Some(TerminalMenuAction::Copy) => self.copy_terminal_screen(cx),
            Some(TerminalMenuAction::Paste) => self.paste_terminal_clipboard(window, cx),
            Some(TerminalMenuAction::SendSelection) => {
                self.send_terminal_selection(window, cx);
            }
            Some(TerminalMenuAction::Clear) => self.clear_terminal_screen(cx),
            None => {}
        }
        cx.notify();
    }

    /// Copies the active tab's screen text, with no session or an empty screen
    /// leaving the clipboard untouched.
    fn copy_terminal_screen(&self, cx: &mut Context<Self>) {
        let Some(session) = self.terminals.get(self.active_terminal) else {
            return;
        };
        let text = session.screen_text();
        if text.is_empty() {
            return;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }

    /// Appends the clipboard to the terminal input line, so the user reviews
    /// and submits it instead of pasting straight into the running shell.
    fn paste_terminal_clipboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        let current = self.terminal_input.read(cx).value().to_string();
        let next = append_clipboard_text(&current, &text);
        if next == current {
            return;
        }
        self.terminal_input
            .update(cx, |input, cx| input.set_value(next, window, cx));
    }

    /// Clears the active tab's screen; the shell keeps running.
    fn clear_terminal_screen(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.terminals.get_mut(self.active_terminal) {
            session.clear();
        }
        self.terminal_status = None;
        cx.notify();
    }

    /// The text `Send selection` would quote: the active tab's selection, or
    /// the last non-empty visible line when the mirror has none.
    pub fn terminal_selection_text(&self) -> String {
        self.terminals
            .get(self.active_terminal)
            .map(TerminalSession::selection_text)
            .unwrap_or_default()
    }

    /// Quotes the terminal's selection into the composer draft.
    ///
    /// The row lands after a short `Terminal output:` label, separated from an
    /// existing draft by one space, and nothing is sent: Send is still the
    /// user's press. The terminal keeps its screen and its focus; a blank
    /// terminal is a no-op that reports a status instead of inserting a bare
    /// label.
    pub fn send_terminal_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let selection = self.terminal_selection_text();
        if selection.is_empty() {
            self.terminal_status = Some(TERMINAL_EMPTY_SELECTION_STATUS.to_string());
            cx.notify();
            return;
        }
        let text = terminal_selection_text_block(&selection);
        self.insert_composer_text(&text, window, cx);
        self.terminal_status = None;
        cx.notify();
    }

    /// Appends `text` to the composer draft, without sending.
    ///
    /// The draft the user already typed is kept and separated by one space, so
    /// inserted text does not run into the word before it. Focus is untouched:
    /// the composer is not raised and the menu that inserted the text keeps
    /// the keyboard.
    pub fn insert_composer_text(
        &mut self,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if text.is_empty() {
            return;
        }
        let draft = self.composer.read(cx).value().to_string();
        let next = append_composer_text(&draft, text);
        if next == draft {
            return;
        }
        let composer = self.composer.clone();
        composer.update(cx, |state, cx| state.set_value(next, window, cx));
        cx.notify();
    }

    /// Test seam: opens the panel with one shell-less tab and a blank screen.
    ///
    /// The parity harness drives `Send selection` through this so the action
    /// runs against a real `vt100` mirror without spawning a PTY. The tab is
    /// not filed as a spec: there is no shell to reopen later.
    #[doc(hidden)]
    pub fn open_terminal_screen(&mut self, cx: &mut Context<Self>) {
        let (rows, cols) = terminal::size_for_width(self.layout.center_width);
        self.terminal_open = true;
        self.adopt_terminal(TerminalSession::detached(rows, cols), cx);
        cx.notify();
    }

    /// Test seam: parses `bytes` into the active tab's mirror, as if the shell
    /// had printed them. Returns false when no tab accepts output.
    #[doc(hidden)]
    pub fn feed_terminal_output(&mut self, bytes: &[u8], cx: &mut Context<Self>) -> bool {
        let fed = self
            .terminals
            .get_mut(self.active_terminal)
            .is_some_and(|session| session.feed(bytes));
        if fed {
            // Mirrors the live watcher: new output clears the last notice.
            self.terminal_status = None;
            cx.notify();
        }
        fed
    }

    fn terminal_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let active = self.terminals.get(self.active_terminal);
        let (screen, running, location) = match active {
            Some(session) => (
                session.screen_text(),
                session.is_running(),
                terminal::tab_label(session.shell(), session.cwd()),
            ),
            None => (String::new(), false, "not started".to_string()),
        };
        let error = self
            .terminal_error
            .clone()
            .or_else(|| active.and_then(TerminalSession::error));
        // With no live shell the bar still shows the session's saved tabs, so a
        // panel opened without a shell is not blank; no specs means no tabs.
        let (labels, active_tab) = if self.terminals.is_empty() {
            let specs = self.current_terminal_specs();
            let labels: Vec<String> = specs.tabs().iter().map(TerminalTabSpec::label).collect();
            (labels, specs.active())
        } else {
            let labels: Vec<String> = self
                .terminals
                .iter()
                .map(|session| terminal::tab_label(session.shell(), session.cwd()))
                .collect();
            (labels, self.active_terminal)
        };
        let entity = cx.entity();
        let select = {
            let entity = entity.clone();
            move |index: usize, _: &mut Window, cx: &mut App| {
                entity.update(cx, |this, cx| this.select_terminal_tab(index, cx));
            }
        };
        let close_tab = {
            let entity = entity.clone();
            move |index: usize, _: &mut Window, cx: &mut App| {
                entity.update(cx, |this, cx| this.close_terminal_tab(index, cx));
            }
        };
        let pick = {
            let entity = entity.clone();
            move |id: &'static str, window: &mut Window, cx: &mut App| {
                entity.update(cx, |this, cx| this.terminal_menu_click(id, window, cx));
            }
        };
        let new_tab = move |_: &mut Window, cx: &mut App| {
            entity.update(cx, |this, cx| this.new_terminal_tab(cx));
        };
        div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .relative()
            .border_t_1()
            .border_color(colors.border)
            .bg(colors.sidebar)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_1()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(IconName::Terminal)
                    .child("Terminal")
                    .child(location)
                    .child(div().flex_1())
                    .child(if running { "running" } else { "stopped" })
                    .child(
                        div()
                            .id("terminal-menu")
                            .aria_label("Terminal menu")
                            .px_2()
                            .rounded(px(6.0))
                            .hover(|style| style.bg(colors.accent))
                            .child("⋯")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.terminal_menu_open = !this.terminal_menu_open;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("terminal-close")
                            .aria_label("Close terminal")
                            .px_2()
                            .rounded(px(6.0))
                            .hover(|style| style.bg(colors.accent))
                            .child(IconName::X)
                            .test_support()
                            .on_click(cx.listener(|this, _, _, cx| this.close_terminal(cx))),
                    ),
            )
            .child(terminal_tab_bar(
                &labels, active_tab, colors, select, close_tab, new_tab,
            ))
            .child(
                div()
                    .id("terminal-screen")
                    .mx_3()
                    .h(px(232.0))
                    .overflow_hidden()
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.background)
                    .p_2()
                    .font_family(terminal::monospace_font())
                    .text_size(px(11.0))
                    .whitespace_nowrap()
                    .text_color(colors.foreground)
                    .child(screen),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .child(div().flex_1().child(Input::new(&self.terminal_input)))
                    .child(
                        div()
                            .id("terminal-send")
                            .aria_label("Send to terminal")
                            .px_3()
                            .py_1()
                            .rounded(px(6.0))
                            .bg(colors.primary)
                            .text_color(colors.primary_foreground)
                            .text_sm()
                            .child("Send")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.send_terminal_line(window, cx);
                            })),
                    ),
            )
            .when(error.is_some(), |element| {
                element.child(
                    div()
                        .px_3()
                        .pb_2()
                        .text_xs()
                        .text_color(colors.danger)
                        .child(error.unwrap_or_default()),
                )
            })
            .when_some(self.terminal_status.clone(), |element, status| {
                element.child(
                    div()
                        .px_3()
                        .pb_2()
                        .text_xs()
                        .text_color(colors.muted_foreground)
                        .child(status),
                )
            })
            .when(self.terminal_menu_open, |element| {
                element.child(terminal_menu(colors, pick))
            })
    }

    pub fn select_session(&mut self, index: usize, cx: &mut Context<Self>) {
        self.reset_transcript_search(cx);
        if let Some(runtime_id) = self.runtime_id.take() {
            self.agents.stop(&runtime_id);
        }
        // The runtime is gone, so a close no longer has to ask.
        self.sync_close_guard();
        self.reset_live_voice();
        self.reset_dictation();
        self.streaming_index = None;
        // The stopped runtime took its turn and its queue with it.
        self.running = false;
        self.queued_follow_ups.clear();
        self.runtime_error = None;
        self.clear_turn_state();
        // The dial reports the session it was read from, never the previous one.
        self.context_usage = None;
        // The mention list is a view of this catalog, so a switch closes it
        // rather than leaving a row that inserts the previous session's path.
        self.mention_menu_open = false;
        self.mention_status = None;
        self.selected_session = Some(index);
        // The previous session's shells stop here; the new session's own tabs
        // are reopened from its spec, never handed over from the old one.
        self.restore_terminal_tabs(cx);
        self.clear_transcript();
        // A switch lands on the newest message of the session it opens, the
        // same way a fresh read of this one would.
        self.transcript_at_bottom = true;
        self.transcript_error = None;
        if let Some(session) = self.sessions.get(index) {
            let root = sessions::session_root(&self.home_dir);
            let file_path = session.file_path.clone();
            match sessions::read_transcript(&root, &file_path) {
                Ok(messages) => {
                    self.transcript = messages;
                    self.follow_transcript_tail();
                }
                Err(error) => self.transcript_error = Some(error.message),
            }
            // The stamp is recorded whether the read succeeded or not: a file
            // that is still broken is not retried until it changes, and a file
            // that becomes readable again is what recovers the view.
            self.transcript_animation_floor = self.transcript.len();
            self.transcript_stamp = transcript_stamp(Path::new(&file_path));
            self.transcript_file = Some(file_path);
        }
        if self.right_pane == RightPane::Review {
            self.refresh_review();
        }
        if self.right_pane == RightPane::Files {
            self.refresh_files();
        }
        self.apply_overview_pin();
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
                self.ensure_runtime(cx);
            }
            Err(error) => self.transcript_error = Some(error.message),
        }
        cx.notify();
    }

    /// Opens or closes one project row's menu.
    ///
    /// The row's ellipsis button and the parity harness both come through here,
    /// so the menu never needs a measured click position.
    pub fn toggle_project_menu(&mut self, id: &str, cx: &mut Context<Self>) {
        self.project_menu = if self.project_menu.as_deref() == Some(id) {
            None
        } else {
            Some(id.to_string())
        };
        cx.notify();
    }

    /// Dispatches one row of the project menu. The menu closes after the row
    /// runs, the same way the session menu does.
    pub fn project_menu_action(&mut self, id: &str, action: &str, cx: &mut Context<Self>) {
        if action == "Remove project" {
            self.remove_project(id, cx);
        }
    }

    /// Removes a project's grant and drops its sessions from the sidebar.
    ///
    /// Only the grant goes away: the folder on disk and the session JSONL files
    /// under the omp home are left alone, so granting the folder again finds its
    /// history. The Electron app deletes the saved sessions with the project;
    /// here the harness owns those files, so removal hides them from the catalog
    /// instead of deleting them.
    pub fn remove_project(&mut self, id: &str, cx: &mut Context<Self>) {
        self.project_menu = None;
        let Some(store) = self.store.clone() else {
            self.transcript_error = Some("The desktop state store is unavailable.".to_string());
            cx.notify();
            return;
        };
        let folders = self
            .projects
            .iter()
            .find(|project| project.id == id)
            .map(|project| project.folders.clone())
            .unwrap_or_default();
        // The selected session is judged before the catalog is filtered: once
        // its row is gone the index would point at its neighbour. A session from
        // another project is kept, but its index moves with the catalog.
        let selected = self
            .selected_session
            .and_then(|index| self.sessions.get(index));
        let doomed = selected
            .filter(|session| session_in_folders(&folders, &session.project_path))
            .map(|session| session.id.clone());
        let selected_file = selected.map(|session| session.file_path.clone());
        let mut store = store.lock().expect("state lock");
        let result = projects::remove_project(&mut store, id);
        let mut removed = false;
        match result {
            Ok(true) => {
                self.projects = projects::list_projects(&store);
                // A scan still finds the JSONL files, so the catalog hides the
                // folders the state file dismisses — this removal and the ones
                // before it — unless a grant still covers them.
                let dismissed = store.state().dismissed_project_paths.clone();
                let granted: Vec<String> = self
                    .projects
                    .iter()
                    .flat_map(|project| project.folders.clone())
                    .collect();
                self.sessions = sessions::list_sessions(&store, &self.home_dir, false, None)
                    .into_iter()
                    .filter(|session| !session_hidden(&dismissed, &granted, &session.project_path))
                    .collect();
                self.refresh_attention();
                self.transcript_error = None;
                removed = true;
            }
            Ok(false) => {}
            Err(error) => self.transcript_error = Some(error.message),
        }
        drop(store);
        if removed {
            if let Some(session_id) = doomed {
                // The removed project's session cannot stay open: stop its
                // runtime and drop the shells filed under it, like the
                // single-session delete path does.
                if let Some(runtime_id) = self.runtime_id.take() {
                    self.agents.stop(&runtime_id);
                }
                self.sync_close_guard();
                self.reset_live_voice();
                self.reset_dictation();
                self.streaming_index = None;
                self.running = false;
                self.queued_follow_ups.clear();
                self.runtime_error = None;
                self.selected_session = None;
                self.clear_transcript();
                // The session that reported the window is gone with its project.
                self.context_usage = None;
                self.clear_turn_state();
                self.terminal_specs.remove(&session_id);
                self.terminals.clear();
                self.terminal_tasks.clear();
                self.active_terminal = 0;
            } else if let Some(file_path) = selected_file {
                // Another project's session stays open, at its new index.
                match self
                    .sessions
                    .iter()
                    .position(|session| session.file_path == file_path)
                {
                    Some(index) => self.selected_session = Some(index),
                    None => {
                        self.selected_session = None;
                        self.clear_transcript();
                        self.context_usage = None;
                    }
                }
            }
            // Neither pane can keep showing a folder that is no longer granted.
            self.refresh_files();
            self.refresh_review();
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
                self.sync_close_guard();
                // A resumed session already has tokens in its window, so the
                // dial starts from the harness's reading instead of blank.
                self.refresh_context_usage();
            }
            Err(error) => self.runtime_error = Some(error.message),
        }
    }

    fn start_new_session(&mut self, project: ProjectRecord, cx: &mut Context<Self>) {
        self.reset_transcript_search(cx);
        if let Some(runtime_id) = self.runtime_id.take() {
            self.agents.stop(&runtime_id);
        }
        // The replaced session's runtime stopped above, so the guard follows.
        self.sync_close_guard();
        self.reset_live_voice();
        self.reset_dictation();
        self.streaming_index = None;
        // The replaced runtime's turn and queue end with it.
        self.running = false;
        self.queued_follow_ups.clear();
        self.selected_session = None;
        // A new session starts with a fresh terminal: the draft bucket held
        // the tabs of the session it replaced, so it is dropped rather than
        // carried into this one.
        self.terminal_specs.remove(DRAFT_TERMINAL_KEY);
        self.restore_terminal_tabs(cx);
        self.clear_transcript();
        // The draft starts empty and follows the first message it gets.
        self.transcript_at_bottom = true;
        self.transcript_error = None;
        self.runtime_error = None;
        self.clear_turn_state();
        // A new session's window starts empty; nothing carries over from the
        // session it replaced.
        self.context_usage = None;
        let Some(store) = self.store.clone() else {
            self.runtime_error = Some("The desktop state store is unavailable.".to_string());
            cx.notify();
            return;
        };
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
            &json!({ "cwd": project.primary_folder }),
        ) {
            Ok(info) => {
                self.runtime_id = info
                    .get("runtimeId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.start_drain(cx);
                self.sync_close_guard();
                self.refresh_context_usage();
            }
            Err(error) => self.runtime_error = Some(error.message),
        }
        cx.notify();
    }

    fn refresh_sessions(&mut self) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let store = store.lock().expect("state lock");
        self.sessions = sessions::list_sessions(&store, &self.home_dir, false, None);
        self.refresh_attention();
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
        self.drain_main_events();
        self.drain_side_events();
    }

    /// Applies one `get_session_stats` response: `data.contextUsage` becomes
    /// the reading the dial draws.
    ///
    /// A response without a usable reading (an older harness omits the field)
    /// leaves the last one alone, so a failed refresh never blanks the dial.
    pub fn apply_session_stats(&mut self, response: &Value) {
        if let Some(usage) = parse_context_usage(response) {
            self.context_usage = Some(usage);
        }
    }

    /// Asks the running harness how full the context window is.
    ///
    /// The command is local and answered from the harness's own counters, so
    /// it is sent inline like the other runtime commands. A runtime that is
    /// gone, or one whose harness does not answer, keeps the last reading.
    fn refresh_context_usage(&mut self) {
        let Some(runtime_id) = self.runtime_id.clone() else {
            return;
        };
        let Ok(response) = self
            .agents
            .command(&runtime_id, &json!({ "type": "get_session_stats" }))
        else {
            return;
        };
        self.apply_session_stats(&response);
    }

    fn drain_main_events(&mut self) {
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
                Some("agent_start") => self.running = true,
                Some("agent_end") => {
                    self.streaming_index = None;
                    self.running = false;
                    self.finish_turn();
                    // A finished turn leaves one unread Activity entry, the
                    // persisted form of the Electron app's completion notice.
                    let body = self
                        .selected_session
                        .and_then(|index| self.sessions.get(index))
                        .map(|session| session.title.clone())
                        .unwrap_or_else(|| "OMP finished its work.".to_string());
                    self.record_completion_notification("Task complete", &body);
                    self.refresh_sessions();
                    // The turn just spent tokens, so the dial catches up now
                    // instead of waiting for the next prompt.
                    self.refresh_context_usage();
                }
                Some("session_action_update") => {
                    // The harness owns the queue: mirror what it reports so the
                    // composer can show the follow-ups waiting behind the turn.
                    self.queued_follow_ups = event
                        .pointer("/actions/followUps")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
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
                    self.follow_transcript_tail();
                }
                Some("live_phase" | "live_levels" | "live_transcript" | "live_end") => {
                    // Live voice never touches the transcript: the pane owns these frames.
                    self.apply_live_event(event);
                }
                Some("dictation_state" | "dictation_transcript" | "dictation_end") => {
                    // Dictation never touches the transcript: the composer owns these frames.
                    self.apply_dictation_event(event);
                }
                Some("extension_ui_request") => {
                    // Dialogs never touch the transcript: the Ask pane answers
                    // them, and every unsupported method is dismissed here.
                    let runtime_id = envelope
                        .get("runtimeId")
                        .and_then(Value::as_str)
                        .unwrap_or(&runtime_id);
                    self.apply_extension_ui_request(runtime_id, event);
                }
                _ => {}
            }
        }
    }

    fn drain_side_events(&mut self) {
        let Some(runtime_id) = self.side_runtime_id.clone() else {
            return;
        };
        for envelope in self.agents.drain_events(Some(&runtime_id)) {
            let event = &envelope["event"];
            if let Some(delta) = side_answer_delta(event) {
                append_side_answer(&mut self.side_answer, delta);
                continue;
            }
            match event.get("type").and_then(Value::as_str) {
                Some("agent_end") => self.stop_side_runtime(),
                Some("error") => {
                    let message = event
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .or_else(|| event.get("message").and_then(Value::as_str))
                        .unwrap_or("The side question runtime failed")
                        .to_string();
                    self.stop_side_runtime();
                    self.side_error = Some(message);
                }
                Some("extension_ui_request") => {
                    // The side runtime opts into dialogs too, but this pane can
                    // only show one dialog: dismiss its requests so the harness
                    // never waits on a question nobody can see.
                    if let Some(id) = event.get("id").and_then(Value::as_str)
                        && event.get("method").and_then(Value::as_str) != Some("cancel")
                    {
                        let _ = self.agents.respond(&runtime_id, &ask_cancel_payload(id));
                    }
                }
                _ => {}
            }
        }
    }

    fn stop_side_runtime(&mut self) {
        if let Some(runtime_id) = self.side_runtime_id.take() {
            self.agents.stop(&runtime_id);
        }
        self.side_streaming = false;
    }

    /// Mirrors one normalized `live_*` event into the pane state.
    ///
    /// Returns whether the event belonged to live voice. The harness owns the
    /// audio; the pane only reflects what it reports.
    fn apply_live_event(&mut self, event: &Value) -> bool {
        let mut state = LiveVoiceState {
            phase: &mut self.live_phase,
            levels: &mut self.live_levels,
            transcript: &mut self.live_transcript,
            muted: &mut self.live_muted,
            active: &mut self.live_active,
            error: &mut self.live_error,
        };
        apply_live_voice_event(&mut state, event)
    }

    /// Asks the main runtime to open live voice; the harness captures the audio.
    fn start_live_voice(&mut self, cx: &mut Context<Self>) {
        let Some(runtime_id) = self.runtime_id.clone() else {
            self.live_error = Some("Select a session before starting live voice.".to_string());
            cx.notify();
            return;
        };
        self.live_error = None;
        match self.agents.command(
            &runtime_id,
            &json!({ "type": "live_start", "voice": "sol" }),
        ) {
            Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
                self.live_active = true;
                self.live_phase = "connecting".to_string();
                self.live_levels = 0.0;
                self.start_drain(cx);
            }
            Ok(response) => {
                self.live_active = false;
                self.live_error = Some(
                    response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OMP rejected live voice")
                        .to_string(),
                );
            }
            Err(error) => {
                self.live_active = false;
                self.live_error = Some(error.message);
            }
        }
        cx.notify();
    }

    /// Asks the runtime to close live voice and resets the local pane state.
    fn stop_live_voice(&mut self, cx: &mut Context<Self>) {
        let Some(runtime_id) = self.runtime_id.clone() else {
            self.live_error = Some("Select a session before stopping live voice.".to_string());
            cx.notify();
            return;
        };
        match self
            .agents
            .command(&runtime_id, &json!({ "type": "live_stop" }))
        {
            Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
                self.live_error = None;
            }
            Ok(response) => {
                self.live_error = Some(
                    response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OMP rejected the live stop")
                        .to_string(),
                );
            }
            Err(error) => self.live_error = Some(error.message),
        }
        self.reset_live_voice();
        cx.notify();
    }

    /// Toggles the harness mute flag for the running live session.
    fn toggle_live_voice_mute(&mut self, cx: &mut Context<Self>) {
        let Some(runtime_id) = self.runtime_id.clone() else {
            self.live_error = Some("Select a session before muting live voice.".to_string());
            cx.notify();
            return;
        };
        let muted = !self.live_muted;
        match self
            .agents
            .command(&runtime_id, &json!({ "type": "live_mute", "muted": muted }))
        {
            Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
                self.live_error = None;
                self.live_muted = muted;
                if self.live_active {
                    self.live_phase = if muted { "muted" } else { "listening" }.to_string();
                }
            }
            Ok(response) => {
                self.live_error = Some(
                    response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OMP rejected the mute request")
                        .to_string(),
                );
            }
            Err(error) => self.live_error = Some(error.message),
        }
        cx.notify();
    }

    /// Clears the running flags after the runtime goes away; transcript history stays.
    fn reset_live_voice(&mut self) {
        self.live_active = false;
        self.live_muted = false;
        self.live_levels = 0.0;
        self.live_phase = "idle".to_string();
    }

    /// Starts a dictation capture on the main runtime.
    ///
    /// Live voice owns the microphone as well, so an active live session is
    /// stopped first; the harness then captures and transcribes the audio. The
    /// generated capture id lets the harness tag every frame of this session.
    fn start_dictation(&mut self, cx: &mut Context<Self>) {
        if self.dictation_active {
            return;
        }
        let Some(runtime_id) = self.runtime_id.clone() else {
            self.dictation_error = Some("Select a session before starting dictation.".to_string());
            cx.notify();
            return;
        };
        if self.live_active {
            self.stop_live_voice(cx);
        }
        let capture_id = self.next_dictation_capture_id();
        self.dictation_error = None;
        self.dictation_preview.clear();
        self.dictation_pending_text = None;
        match self.agents.command(
            &runtime_id,
            &json!({ "type": "dictation_start", "captureId": capture_id }),
        ) {
            Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
                self.dictation_active = true;
                self.dictation_phase = "starting".to_string();
                self.dictation_capture_id = Some(capture_id);
                self.start_drain(cx);
            }
            Ok(response) => {
                self.dictation_active = false;
                self.dictation_phase = "idle".to_string();
                self.dictation_capture_id = None;
                self.dictation_error = Some(
                    response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OMP rejected the dictation start")
                        .to_string(),
                );
            }
            Err(error) => {
                self.dictation_active = false;
                self.dictation_phase = "idle".to_string();
                self.dictation_capture_id = None;
                self.dictation_error = Some(error.message);
            }
        }
        cx.notify();
    }

    /// Asks the harness to finish the capture.
    ///
    /// The stop response may carry the transcribed text, but `dictation_end`
    /// is the single terminal result, so the response is not applied here.
    fn stop_dictation(&mut self, cx: &mut Context<Self>) {
        if !self.dictation_active || self.dictation_phase == "transcribing" {
            return;
        }
        let Some(runtime_id) = self.runtime_id.clone() else {
            self.dictation_error = Some("Select a session before stopping dictation.".to_string());
            cx.notify();
            return;
        };
        match self
            .agents
            .command(&runtime_id, &json!({ "type": "dictation_stop" }))
        {
            Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
                self.dictation_phase = "transcribing".to_string();
                self.dictation_error = None;
            }
            Ok(response) => {
                self.dictation_error = Some(
                    response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OMP rejected the dictation stop")
                        .to_string(),
                );
            }
            Err(error) => self.dictation_error = Some(error.message),
        }
        cx.notify();
    }

    /// Starts or finishes a capture from the single composer button.
    fn toggle_dictation(&mut self, cx: &mut Context<Self>) {
        if self.dictation_active {
            self.stop_dictation(cx);
        } else {
            self.start_dictation(cx);
        }
    }

    /// Clears the running flags after the runtime goes away; preview and error
    /// belong to the capture that produced them.
    fn reset_dictation(&mut self) {
        self.dictation_active = false;
        self.dictation_phase = "idle".to_string();
        self.dictation_capture_id = None;
        self.dictation_preview.clear();
        self.dictation_error = None;
        self.dictation_pending_text = None;
    }

    /// A per-session id: the timestamp keeps ids distinct across runs, and the
    /// counter keeps them distinct within one millisecond.
    fn next_dictation_capture_id(&mut self) -> String {
        self.dictation_counter += 1;
        format!(
            "dictation-{}-{}",
            Utc::now().timestamp_millis(),
            self.dictation_counter
        )
    }

    /// Mirrors one normalized `dictation_*` frame into the composer state.
    fn apply_dictation_event(&mut self, event: &Value) -> bool {
        let mut state = DictationState {
            phase: &mut self.dictation_phase,
            capture_id: &mut self.dictation_capture_id,
            preview: &mut self.dictation_preview,
            error: &mut self.dictation_error,
            active: &mut self.dictation_active,
            pending_text: &mut self.dictation_pending_text,
        };
        apply_dictation_frame(&mut state, event)
    }

    /// Label for the composer button and its status row.
    fn dictation_label(&self) -> &'static str {
        match self.dictation_phase.as_str() {
            "starting" => "Starting…",
            "recording" => "Stop",
            "transcribing" => "Transcribing…",
            _ => "Dictate",
        }
    }

    /// Opens the pane for one normalized `extension_ui_request`.
    ///
    /// An `ask` request with renderable questions opens the Ask pane; every
    /// other dialog method (and an ask that cannot be rendered) is answered
    /// `cancelled` so the harness is never left waiting. A harness-side
    /// `cancel` frame closes the matching dialog without a response. Nothing
    /// here touches the transcript.
    fn apply_extension_ui_request(&mut self, runtime_id: &str, event: &Value) -> bool {
        if event.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
            return false;
        }
        let Some(request_id) = event.get("id").and_then(Value::as_str) else {
            return false;
        };
        let Some(method) = event.get("method").and_then(Value::as_str) else {
            return false;
        };
        if method == "cancel" {
            let Some(target) = event.get("targetId").and_then(Value::as_str) else {
                return false;
            };
            if self
                .ask_dialog
                .as_ref()
                .is_some_and(|dialog| dialog.request_id == target)
            {
                self.close_ask_dialog();
            }
            return true;
        }
        let questions = if method == "ask" {
            parse_ask_questions(event)
        } else {
            None
        };
        let Some(questions) = questions else {
            // Unsupported methods and unusable asks are dismissed, never shown.
            let _ = self
                .agents
                .respond(runtime_id, &ask_cancel_payload(request_id));
            return true;
        };
        // One dialog at a time: dismissing the previous request keeps the
        // harness from waiting on a pane the user can no longer see.
        if let Some(previous) = self.ask_dialog.take()
            && previous.request_id != request_id
        {
            let previous_runtime = previous.runtime_id.as_deref().unwrap_or(runtime_id);
            let _ = self
                .agents
                .respond(previous_runtime, &ask_cancel_payload(&previous.request_id));
        }
        self.ask_inputs.clear();
        self.ask_dialog = Some(AskDialog {
            request_id: request_id.to_string(),
            runtime_id: Some(runtime_id.to_string()),
            title: ask_title(event, &questions),
            questions,
            selected: HashMap::new(),
            error: None,
        });
        self.right_pane = RightPane::Ask;
        self.geometry.right_pane_open = true;
        if let Some(bounds) = self.last_bounds {
            self.layout = self.geometry.resolve(bounds.2 as f64);
        }
        self.resize_terminal();
        true
    }

    /// Forgets the live dialog and its inputs, returning to the launcher.
    fn close_ask_dialog(&mut self) {
        self.ask_dialog = None;
        self.ask_inputs.clear();
        if self.right_pane == RightPane::Ask {
            self.right_pane = RightPane::Launcher;
        }
    }

    /// Toggles one option of the live dialog.
    ///
    /// Multi-select questions toggle independently; single-select ones keep at
    /// most one label and clear the question's free-text field, because an
    /// answer is exactly one of the two.
    fn toggle_ask_option(
        &mut self,
        question_id: &str,
        label: &str,
        multi: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(dialog) = self.ask_dialog.as_mut() else {
            return;
        };
        let selected = dialog.selected.entry(question_id.to_string()).or_default();
        let mut clear_custom = false;
        if multi {
            match selected.iter().position(|item| item == label) {
                Some(index) => {
                    selected.remove(index);
                }
                None => selected.push(label.to_string()),
            }
        } else if selected.len() == 1 && selected[0] == label {
            selected.clear();
        } else {
            *selected = vec![label.to_string()];
            clear_custom = true;
        }
        if clear_custom && let Some(input) = self.ask_inputs.get(question_id) {
            input.update(cx, |state, cx| state.set_value("", window, cx));
        }
        cx.notify();
    }

    /// Reads the free-text field of every question, keyed by question id.
    fn ask_custom_values(&self, dialog: &AskDialog, cx: &Context<Self>) -> HashMap<String, String> {
        dialog
            .questions
            .iter()
            .filter_map(|question| {
                self.ask_inputs
                    .get(&question.id)
                    .map(|input| (question.id.clone(), input.read(cx).value().to_string()))
            })
            .collect()
    }

    /// Sends the dialog's answers and settles the pane.
    fn submit_ask(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.ask_dialog.clone() else {
            return;
        };
        let custom = self.ask_custom_values(&dialog, cx);
        if !ask_answers_ready(&dialog.questions, &dialog.selected, &custom) {
            if let Some(open) = self.ask_dialog.as_mut() {
                open.error = Some("Answer every question before submitting.".to_string());
            }
            cx.notify();
            return;
        }
        let payload = ask_submit_payload(&dialog, &custom);
        self.send_ask_response(&dialog, payload, cx);
    }

    /// Dismisses the dialog without answers.
    fn cancel_ask(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.ask_dialog.clone() else {
            return;
        };
        self.send_ask_response(&dialog, ask_cancel_payload(&dialog.request_id), cx);
    }

    /// Writes one `extension_ui_response` and settles the pane.
    ///
    /// The response is fire-and-forget: the harness answers it with events, so
    /// a closed pane is the whole acknowledgement.
    fn send_ask_response(&mut self, dialog: &AskDialog, payload: Value, cx: &mut Context<Self>) {
        let runtime_id = dialog
            .runtime_id
            .clone()
            .or_else(|| self.runtime_id.clone());
        let Some(runtime_id) = runtime_id else {
            if let Some(open) = self.ask_dialog.as_mut() {
                open.error = Some("No OMP runtime is selected.".to_string());
            }
            cx.notify();
            return;
        };
        match self.agents.respond(&runtime_id, &payload) {
            Ok(()) => self.close_ask_dialog(),
            Err(error) => {
                if let Some(open) = self.ask_dialog.as_mut() {
                    open.error = Some(error.message);
                }
            }
        }
        cx.notify();
    }

    /// Creates one free-text input per question of the live dialog.
    ///
    /// The entities need a window, so they are built while the pane draws and
    /// kept until the dialog settles.
    fn ensure_ask_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ids: Vec<String> = match self.ask_dialog.as_ref() {
            Some(dialog) => dialog
                .questions
                .iter()
                .map(|question| question.id.clone())
                .collect(),
            None => {
                self.ask_inputs.clear();
                return;
            }
        };
        self.ask_inputs.retain(|id, _| ids.contains(id));
        for id in ids {
            if self.ask_inputs.contains_key(&id) {
                continue;
            }
            let placeholder = self.t("ask.answerPlaceholder");
            let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
            self.ask_inputs.insert(id, input);
        }
    }

    fn ask_side_question(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.side_input.read(cx).value().trim().to_string();
        if text.is_empty() {
            return;
        }
        self.stop_side_runtime();
        self.side_answer.clear();
        self.side_error = None;
        let Some(store) = self.store.clone() else {
            self.side_error = Some("The desktop state store is unavailable.".to_string());
            cx.notify();
            return;
        };
        let Some(cwd) = self.project_cwd() else {
            self.side_error =
                Some("Grant a project folder before asking a side question.".to_string());
            cx.notify();
            return;
        };
        let context = CliContext {
            executable: self.omp_executable.clone(),
            home_dir: self.home_dir.clone(),
            root_dir: self.user_data_dir.clone(),
            extra_env: Vec::new(),
        };
        let store = store.lock().expect("state lock");
        if let Err(error) =
            projects::authorize_path(&store, std::path::Path::new(&cwd), Platform::current())
        {
            drop(store);
            self.side_error = Some(error.message);
            cx.notify();
            return;
        }
        let started = self.agents.start(
            &store,
            Platform::current(),
            &context,
            &json!({ "cwd": cwd }),
        );
        drop(store);
        let runtime_id = match started {
            Ok(info) => info
                .get("runtimeId")
                .and_then(Value::as_str)
                .map(str::to_string),
            Err(error) => {
                self.side_error = Some(error.message);
                cx.notify();
                return;
            }
        };
        let Some(runtime_id) = runtime_id else {
            self.side_error = Some("The side question runtime did not return an id.".to_string());
            cx.notify();
            return;
        };
        self.side_runtime_id = Some(runtime_id.clone());
        self.side_streaming = true;
        let sent = self
            .agents
            .command(&runtime_id, &json!({ "type": "prompt", "message": text }));
        match sent {
            Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {}
            Ok(response) => {
                self.stop_side_runtime();
                self.side_error = Some(
                    response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OMP rejected the side question")
                        .to_string(),
                );
                cx.notify();
                return;
            }
            Err(error) => {
                self.stop_side_runtime();
                self.side_error = Some(error.message);
                cx.notify();
                return;
            }
        }
        self.side_input
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.start_drain(cx);
        cx.notify();
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
        // A streamed reply grows the last row, so a reader at the bottom keeps
        // seeing it arrive; one who scrolled up stays where they were.
        self.follow_transcript_tail();
    }

    /// Opens the native file picker and attaches the chosen image.
    ///
    /// The picker answers on the app's task queue, so the click only starts
    /// it; the selection lands in `attach_image_from_path`, which is also the
    /// parity harness's entry point and never opens a dialog.
    pub fn pick_image(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let _ = window;
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Attach image".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = receiver.await
                && let Some(path) = paths.first().cloned()
            {
                let _ = this.update(cx, |this, cx| this.attach_image_from_path(&path, cx));
            }
        })
        .detach();
    }

    /// Attaches one image to the next prompt or follow-up.
    ///
    /// A rejected file leaves the composer as it was — including an image that
    /// is already attached — and reports why in the status banner, so the
    /// draft stays usable.
    pub fn attach_image_from_path(&mut self, path: &Path, cx: &mut Context<Self>) {
        match read_pending_image(path) {
            Ok(image) => {
                self.pending_image = Some(image);
                self.image_error = None;
            }
            Err(error) => self.image_error = Some(error),
        }
        cx.notify();
    }

    /// Drops the pending attachment, leaving the draft text alone.
    pub fn clear_pending_image(&mut self, cx: &mut Context<Self>) {
        self.pending_image = None;
        self.image_error = None;
        cx.notify();
    }

    /// The sessions the mention menu draws, newest first, in catalog order.
    ///
    /// The list is bounded by [`MENTION_MENU_LIMIT`] so the popover never
    /// outgrows the composer, and a record without a file cannot be mentioned.
    fn mention_candidates(&self) -> Vec<usize> {
        self.sessions
            .iter()
            .enumerate()
            .filter(|(_, session)| !session.file_path.is_empty())
            .map(|(index, _)| index)
            .take(MENTION_MENU_LIMIT)
            .collect()
    }

    /// A session's file path as the menu shows it: relative to the harness's
    /// home directory when the file lives there, else the bare file name. The
    /// inserted mention always carries the full path.
    fn mention_relative_path(&self, file_path: &str) -> String {
        let path = Path::new(file_path);
        match path.strip_prefix(&self.home_dir) {
            Ok(relative) => relative.display().to_string(),
            Err(_) => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| file_path.to_string()),
        }
    }

    /// Opens or closes the mention menu. Opening an empty catalog keeps the
    /// menu up with the empty status, so the button always answers.
    pub fn toggle_mention_menu(&mut self, cx: &mut Context<Self>) {
        if self.mention_menu_open {
            self.mention_menu_open = false;
            self.mention_status = None;
        } else {
            self.mention_menu_open = true;
            self.mention_status = self
                .mention_candidates()
                .is_empty()
                .then(|| MENTION_EMPTY_STATUS.to_string());
        }
        cx.notify();
    }

    /// Appends `@<file_path>` for one of the menu's rows to the draft.
    ///
    /// The mention is plain prompt text: the harness resolves it, so the app
    /// only inserts the path (with a leading space when the draft would run
    /// into it). The draft and the session selection stay put and nothing is
    /// sent — Send is still the user's press. A row the menu does not have
    /// leaves the draft alone and shows the empty status.
    pub fn select_mention(&mut self, row: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.mention_candidates().get(row).copied() else {
            self.mention_status = Some(MENTION_EMPTY_STATUS.to_string());
            cx.notify();
            return;
        };
        let file_path = self.sessions[index].file_path.clone();
        let draft = self.composer.read(cx).value().to_string();
        let mention = format!("@{file_path}");
        let next = if draft.is_empty() || draft.ends_with(char::is_whitespace) {
            format!("{draft}{mention}")
        } else {
            format!("{draft} {mention}")
        };
        let composer = self.composer.clone();
        composer.update(cx, |state, cx| state.set_value(next, window, cx));
        self.mention_menu_open = false;
        self.mention_status = None;
        cx.notify();
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
        // A send during a live turn is a follow-up: the harness queues it
        // behind the running turn instead of rejecting the prompt. Ctrl+Enter
        // asks for the same queue on an idle turn.
        let queued = follow_up || self.running;
        let begin_new_turn = !self.running && self.turn_baseline.is_none();
        if begin_new_turn {
            self.begin_turn();
        }
        // An attachment rides with both a prompt and a follow-up: the harness
        // reads `images` on either, and a queued turn must not lose its image
        // just because it waits behind a running one.
        let mut payload = json!({
            "type": if queued { "follow_up" } else { "prompt" },
            "message": text,
        });
        if let Some(image) = &self.pending_image {
            payload["images"] = json!([{
                "type": "image",
                "data": image.data,
                "mimeType": image.mime,
            }]);
        }
        let response = match self.agents.command(&runtime_id, &payload) {
            Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {
                response
            }
            Ok(response) => {
                // A queued send never starts a turn, so the running turn keeps
                // its baseline; only a rejected prompt drops the new one.
                if !queued || begin_new_turn {
                    self.turn_baseline = None;
                }
                let message = response
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or(if queued {
                        "OMP rejected the follow-up"
                    } else {
                        "OMP rejected the prompt"
                    });
                self.runtime_error = Some(if queued {
                    format!("OMP could not queue the follow-up: {message}")
                } else {
                    message.to_string()
                });
                cx.notify();
                return;
            }
            Err(error) => {
                if !queued || begin_new_turn {
                    self.turn_baseline = None;
                }
                // A follow-up is never retried as a prompt: a harness that
                // cannot queue it would otherwise be sent the text twice.
                self.runtime_error = Some(if queued {
                    format!("OMP could not queue the follow-up: {}", error.message)
                } else {
                    error.message
                });
                cx.notify();
                return;
            }
        };
        // The image rode with the accepted command; a rejected send returned
        // above with it still attached, so the user can retry without picking
        // the file again.
        self.pending_image = None;
        self.image_error = None;
        self.runtime_error = None;
        if queued {
            // The harness owns the queued turn, so this row is only its trace
            // until the harness starts it. The distinct part kind keeps it
            // from doubling as the turn's own user message.
            self.transcript.push(TranscriptMessage {
                id: format!("queued-{}", self.transcript.len()),
                role: "user".to_string(),
                timestamp: None,
                agent_name: None,
                parts: vec![TranscriptPart {
                    kind: "queued".to_string(),
                    text: Some(text),
                    ..TranscriptPart::text("")
                }],
            });
        } else {
            // The harness accepted the prompt and streams until `agent_end`;
            // sends in between are queued rather than rejected. A pure slash
            // command resolves without invoking the model, so it starts no
            // turn and must not leave the composer in the running state.
            self.running = response
                .pointer("/data/agentInvoked")
                .and_then(Value::as_bool)
                != Some(false);
            self.transcript.push(TranscriptMessage {
                id: format!("user-{}", self.transcript.len()),
                role: "user".to_string(),
                timestamp: None,
                agent_name: None,
                parts: vec![TranscriptPart::text(text)],
            });
        }
        // Both rows land at the tail, so a reader at the bottom sees their own
        // message; a reader who scrolled up keeps their place.
        self.follow_transcript_tail();
        let composer = self.composer.clone();
        composer.update(cx, |state, cx| state.set_value("", window, cx));
        cx.notify();
    }

    fn transcript_search_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let colors = cx.theme().colors;
        let Some(search) = &self.transcript_search else {
            return div().into_any_element();
        };
        let input = search.input.clone();
        let scope = search.scope;
        let (matches, index, _) = self.transcript_search_status(cx);
        let count = if matches.is_empty() {
            "0/0".to_string()
        } else {
            format!("{}/{}", index + 1, matches.len())
        };
        div()
            .id("transcript-search")
            .aria_label(self.t("transcript.search"))
            .test_support()
            .absolute()
            .top(px(8.0))
            .left(px(16.0))
            .right(px(16.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .w_full()
                    .max_w(px(680.0))
                    .mx_auto()
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.popover)
                    .p_2()
                    .text_size(px(12.0))
                    .child(IconName::Search)
                    .child(
                        div().flex_1().min_w(px(80.0)).child(
                            Input::new(&input)
                                .appearance(false)
                                .bordered(false)
                                .aria_label(self.t("transcript.searchPlaceholder")),
                        ),
                    )
                    .child(
                        div()
                            .id("transcript-search-count")
                            .aria_label(count.clone())
                            .text_color(colors.muted_foreground)
                            .child(count),
                    )
                    .children(interaction::SearchScope::ALL.into_iter().map(|candidate| {
                        div()
                            .id(format!("transcript-search-scope-{}", candidate.name()))
                            .aria_label(format!(
                                "{}: {}",
                                self.t("transcript.searchScope"),
                                self.t(candidate.label_key())
                            ))
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .bg(if candidate == scope {
                                colors.selection
                            } else {
                                colors.background
                            })
                            .text_color(if candidate == scope {
                                colors.foreground
                            } else {
                                colors.muted_foreground
                            })
                            .hover(|style| style.bg(colors.accent))
                            .child(self.t(candidate.label_key()))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.set_transcript_search_scope(candidate, cx);
                                cx.stop_propagation();
                            }))
                            .test_support()
                    }))
                    .child(self.toolbar_icon(
                        "transcript-search-previous",
                        IconName::ChevronUp,
                        colors.foreground,
                        cx.listener(|this, _, _, cx| this.move_transcript_search(false, cx)),
                    ))
                    .child(self.toolbar_icon(
                        "transcript-search-next",
                        IconName::ChevronDown,
                        colors.foreground,
                        cx.listener(|this, _, _, cx| this.move_transcript_search(true, cx)),
                    ))
                    .child(self.toolbar_icon(
                        "transcript-search-close",
                        IconName::X,
                        colors.foreground,
                        cx.listener(|this, _, window, cx| {
                            this.close_transcript_search(window, cx);
                        }),
                    )),
            )
            .into_any_element()
    }

    fn transcript(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        if let Some(error) = &self.transcript_error {
            return div()
                .flex()
                .flex_col()
                .flex_1()
                .min_h(px(0.0))
                .p_6()
                .text_sm()
                .text_color(colors.danger)
                .child(error.clone())
                .into_any_element();
        }
        if self.transcript.is_empty() {
            return div()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .flex_1()
                .gap_4()
                .p_6()
                .child(
                    div()
                        .text_size(px(34.0))
                        .text_color(colors.muted_foreground)
                        .child(IconName::Sparkles),
                )
                .child(
                    div()
                        .text_size(px(24.0))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(colors.foreground)
                        .child(self.t("transcript.welcomeTitle")),
                )
                .child(
                    div()
                        .max_w(px(460.0))
                        .text_center()
                        .text_size(px(13.0))
                        .text_color(colors.muted_foreground)
                        .child(self.t("transcript.welcomeBody")),
                )
                .into_any_element();
        }
        let (_, _, active_search_row) = self.transcript_search_status(cx);
        let active_search_id = active_search_row.map(|row| self.transcript[row].id.clone());
        let (search_needle, search_scope) = self
            .transcript_search
            .as_ref()
            .map(|search| {
                (
                    search.input.read(cx).value().trim().to_lowercase(),
                    search.scope,
                )
            })
            .unwrap_or_else(|| (String::new(), interaction::SearchScope::All));
        if let Some(row) = active_search_row {
            let target = self.transcript_search.as_ref().map(|search| {
                (
                    self.transcript[row].id.clone(),
                    search.input.read(cx).value().to_string(),
                    search.scope,
                )
            });
            let should_scroll = self
                .transcript_search
                .as_ref()
                .is_some_and(|search| search.revealed_target != target);
            if should_scroll {
                // GPUI's FirstVisible strategy is the closest available equivalent to
                // Electron's centered reveal; it does not promise vertical centering.
                self.transcript_at_bottom = false;
                self.transcript_scroll.scroll_to_item(row);
                if let Some(search) = &mut self.transcript_search {
                    search.revealed_target = target;
                }
            }
        } else if let Some(search) = &mut self.transcript_search {
            search.revealed_target = None;
        }
        let todo_phases = latest_todo_phases(&self.transcript);
        let todo_total: usize = todo_phases.iter().map(|phase| phase.tasks.len()).sum();
        let todo_done = todo_phases
            .iter()
            .flat_map(|phase| &phase.tasks)
            .filter(|task| task.status == TodoStatus::Completed)
            .count();
        let todo_current = todo_phases
            .iter()
            .flat_map(|phase| &phase.tasks)
            .find(|task| task.status == TodoStatus::InProgress)
            .map(|task| task.content.clone());
        let todo_hud = if todo_phases.is_empty() {
            None
        } else {
            let panel = div()
                .flex()
                .flex_col()
                .gap_2()
                .children(todo_phases.iter().map(|phase| {
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(10.5))
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(colors.muted_foreground)
                                .child(phase.name.clone()),
                        )
                        .children(phase.tasks.iter().map(|task| {
                            let marker = match task.status {
                                TodoStatus::Completed => div()
                                    .text_color(colors.success)
                                    .child(IconName::Check)
                                    .into_any_element(),
                                TodoStatus::InProgress => div()
                                    .size(px(6.0))
                                    .rounded(px(999.0))
                                    .bg(colors.primary)
                                    .with_animation(
                                        "todo-pulse",
                                        interaction::motion_spec(interaction::Motion::TodoPulse)
                                            .animation(),
                                        |element, delta| {
                                            element.opacity(
                                                0.35 + 0.65 * (1.0 - (2.0 * delta - 1.0).abs()),
                                            )
                                        },
                                    )
                                    .into_any_element(),
                                TodoStatus::Pending => div()
                                    .size(px(8.0))
                                    .rounded(px(999.0))
                                    .border_1()
                                    .border_color(colors.border)
                                    .into_any_element(),
                            };
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .text_size(px(11.5))
                                .when(task.status == TodoStatus::Completed, |element| {
                                    element.text_color(colors.muted_foreground)
                                })
                                .child(marker)
                                .child(div().flex_1().child(task.content.clone()))
                        }))
                }));
            Some(
                div()
                    .w_full()
                    .max_w(px(960.0))
                    .mx_auto()
                    .px_6()
                    .py_2()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .id("todo-hud")
                                    .aria_label("Plan")
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .px_2()
                                    .py_1()
                                    .rounded(px(10.0))
                                    .border_1()
                                    .border_color(colors.border)
                                    .bg(colors.tab)
                                    .text_size(px(11.5))
                                    .text_color(colors.foreground)
                                    .hover(|style| style.bg(colors.accent))
                                    .child(IconName::ListTodo)
                                    .child(self.t("transcript.plan"))
                                    .child(
                                        div()
                                            .text_size(px(10.5))
                                            .text_color(colors.muted_foreground)
                                            .child(format!(
                                                "{todo_done}/{todo_total} {}",
                                                self.t("transcript.done")
                                            )),
                                    )
                                    .when_some(todo_current, |element, current| {
                                        element.child(
                                            div()
                                                .flex_1()
                                                .overflow_hidden()
                                                .text_ellipsis()
                                                .text_size(px(11.0))
                                                .text_color(colors.muted_foreground)
                                                .child(current),
                                        )
                                    })
                                    .child(div().flex_1())
                                    .child(if self.todo_open {
                                        IconName::ChevronDown
                                    } else {
                                        IconName::ChevronRight
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.todo_open = !this.todo_open;
                                        cx.notify();
                                    })),
                            )
                            .when(self.todo_open, |element| element.child(panel)),
                    )
                    .into_any_element(),
            )
        };
        let scroll = div()
            .id("transcript-scroll")
            .flex()
            .flex_col()
            .flex_1()
            .min_h(px(0.0))
            .overflow_y_scroll()
            .track_scroll(&self.transcript_scroll)
            .on_scroll(cx.listener(|this, _, _, cx| {
                let was_at_bottom = this.transcript_at_bottom;
                this.sync_transcript_at_bottom();
                // The scroll area redraws itself for the new offset; this
                // frame is for the control that appears once the reader
                // leaves the bottom.
                if this.transcript_at_bottom != was_at_bottom {
                    cx.notify();
                }
            }))
            .p_6()
            .gap(px(0.0))
            .children(self.transcript.iter().enumerate().map(|(index, message)| {
                let is_user = message.role == "user";
                let is_assistant = message.role == "assistant";
                let is_toolish = message.parts.is_empty()
                    || message.parts.iter().all(|part| {
                        part.kind == "thinking"
                            || part.kind == "toolResult"
                            || part.kind == "toolCall"
                    });
                let message_group = format!("message-{}", message.id);
                let copy_text = transcript_row_text(message);
                let copy = (!copy_text.is_empty()).then(|| {
                    let text = copy_text.clone();
                    div()
                        .id(format!("transcript-copy-{}", message.id))
                        .aria_label(self.t("transcript.copy"))
                        .text_size(px(10.5))
                        .text_color(colors.muted_foreground)
                        .hover(|style| style.text_color(colors.foreground))
                        .child(self.t("transcript.copy"))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                        }))
                });
                let forkable = forkable_transcript_row(message);
                let fork = forkable.then(|| {
                    let entry_id = message.id.clone();
                    div()
                        .id(format!("transcript-fork-{}", message.id))
                        .aria_label(self.t("transcript.fork"))
                        .text_size(px(10.5))
                        .text_color(colors.muted_foreground)
                        .hover(|style| style.text_color(colors.foreground))
                        .child(self.t("transcript.fork"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.fork_from_message(&entry_id, cx);
                        }))
                });
                let parts: Vec<AnyElement> = message
                    .parts
                    .iter()
                    .filter(|part| part.kind != "toolCall")
                    .map(|part| {
                        let reveal = active_search_id.as_deref() == Some(message.id.as_str())
                            && interaction::part_matches_search(part, &search_needle, search_scope);
                        if part.kind == "thinking" {
                            self.thinking_part_element(part, &message.id, reveal, colors, cx)
                        } else if part.kind == "toolResult" {
                            self.tool_result_element(part, &message.id, reveal, colors, cx)
                        } else {
                            transcript_part_element(part, &message.role, colors)
                        }
                    })
                    .collect();
                let body = if is_user {
                    div().flex().flex_col().items_end().w_full().child(
                        div()
                            .max_w(px(640.0))
                            .px(px(14.0))
                            .py(px(9.0))
                            .rounded(px(18.0))
                            .bg(colors.tab)
                            .text_size(px(13.0))
                            .flex()
                            .flex_col()
                            .gap_1()
                            .children(parts),
                    )
                } else {
                    div().flex().flex_col().gap_2().w_full().children(parts)
                };
                let actions = div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .opacity(0.0)
                    .group_hover(message_group.clone(), |style| style.opacity(1.0))
                    .when(is_assistant, |element| element.justify_start())
                    .when(!is_assistant, |element| element.justify_end())
                    .when_some(copy, |element, copy| element.child(copy))
                    .when_some(fork, |element, fork| element.child(fork));
                let body = if index >= self.transcript_animation_floor {
                    let (motion, distance) = if is_user {
                        (interaction::Motion::UserEnter, 6.0)
                    } else {
                        (interaction::Motion::AssistantEnter, 10.0)
                    };
                    body.with_animation(
                        format!("message-enter-{}", message.id),
                        interaction::motion_spec(motion).animation(),
                        move |element, delta| {
                            element
                                .opacity(delta.clamp(0.0, 1.0))
                                .relative()
                                .top(px(distance * (1.0 - delta)))
                        },
                    )
                    .into_any_element()
                } else {
                    body.into_any_element()
                };
                div()
                    .id(format!("transcript-message-{}", message.id))
                    .flex()
                    .flex_col()
                    .gap_1()
                    .w_full()
                    .max_w(px(960.0))
                    .mx_auto()
                    .rounded(px(8.0))
                    .when(
                        active_search_id.as_deref() == Some(message.id.as_str()),
                        |row| row.bg(colors.selection),
                    )
                    .pb(px(if is_toolish { 10.0 } else { 32.0 }))
                    .group(message_group)
                    .child(body)
                    .child(actions)
                    .into_any_element()
            }));
        // The rows and the `Jump to latest` control share one box, so the
        // control floats over the transcript instead of taking height away
        // from it and shifting what the reader was looking at.
        div()
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h(px(0.0))
            .when_some(todo_hud, |element, hud| element.child(hud))
            .child(scroll)
            .when(!self.transcript_at_bottom, |element| {
                element.child(
                    div()
                        .absolute()
                        .left(px(0.0))
                        .right(px(0.0))
                        .bottom(px(16.0))
                        .flex()
                        .justify_center()
                        .child(
                            div()
                                .id("transcript-jump-latest")
                                .aria_label(self.t("transcript.jumpLatest"))
                                .px_3()
                                .py_1()
                                .bg(colors.popover)
                                .text_color(colors.muted_foreground)
                                .hover(|style| style.bg(colors.accent))
                                .child(self.t("transcript.jumpLatest"))
                                .test_support()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.jump_to_transcript_latest(cx);
                                }))
                                .with_animation(
                                    "jump-latest",
                                    interaction::motion_spec(interaction::Motion::JumpLatest)
                                        .animation(),
                                    |element, delta| element.opacity(delta),
                                ),
                        ),
                )
            })
            .when(
                interaction::StreamFeedback::derive(self.running, self.streaming_index.is_some())
                    != interaction::StreamFeedback::Idle,
                |element| {
                    element.child(
                        div()
                            .id("transcript-streaming-cue")
                            .aria_label(self.t("transcript.streaming"))
                            .absolute()
                            .left(px(24.0))
                            .bottom(px(16.0))
                            .flex()
                            .items_center()
                            .gap_2()
                            .rounded(px(999.0))
                            .border_1()
                            .border_color(colors.border)
                            .bg(colors.popover)
                            .px_3()
                            .py_1()
                            .text_size(px(11.0))
                            .text_color(colors.muted_foreground)
                            .child(
                                div()
                                    .size(px(6.0))
                                    .rounded(px(999.0))
                                    .bg(colors.primary)
                                    .with_animation(
                                        "transcript-streaming-pulse",
                                        interaction::motion_spec(interaction::Motion::StreamPulse)
                                            .animation(),
                                        |element, delta| element.opacity(0.45 + 0.55 * delta),
                                    ),
                            )
                            .child(self.t("transcript.streaming"))
                            .test_support(),
                    )
                },
            )
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

    fn clear_turn_state(&mut self) {
        self.turn_baseline = None;
        self.turn_changes = TurnChanges::default();
        self.turn_card = TurnCardState::default();
        self.turn_card_error = None;
        self.review_focus_path = None;
    }

    /// An idle prompt or follow-up gets a fresh baseline; an already-running turn keeps one.
    /// The parity harness edits between this capture and `finish_turn` rather than substituting data.
    pub fn begin_turn(&mut self) {
        self.clear_turn_state();
        self.turn_baseline = self.capture_turn_baseline();
    }

    fn turn_card_visible(&self) -> bool {
        !self.turn_changes.is_empty()
            && self.settings.show_file_changes_popup
            && self.turn_card != TurnCardState::Dismissed
    }

    fn capture_turn_baseline(&self) -> Option<TurnBaseline> {
        let store = self.store.as_ref()?;
        let cwd = self.project_cwd()?;
        let store = store.lock().expect("state lock");
        let files = git::snapshot_files(&store, Platform::current(), &cwd);
        Some(TurnBaseline::capture(files))
    }

    pub fn finish_turn(&mut self) {
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

    pub fn open_turn_review(&mut self, path: Option<&str>, cx: &mut Context<Self>) {
        self.review_focus_path = path.map(str::to_string);
        self.set_right_pane("review", cx);
    }

    pub fn toggle_turn_card(&mut self, cx: &mut Context<Self>) {
        self.turn_card = match &self.turn_card {
            TurnCardState::Collapsed => TurnCardState::Expanded,
            TurnCardState::Expanded => TurnCardState::Collapsed,
            TurnCardState::Dismissed => TurnCardState::Dismissed,
            TurnCardState::ConfirmingUndo { target } => TurnCardState::ConfirmingUndo {
                target: target.clone(),
            },
        };
        cx.notify();
    }

    pub fn dismiss_turn_card(&mut self, cx: &mut Context<Self>) {
        self.turn_card = TurnCardState::Dismissed;
        self.turn_card_error = None;
        cx.notify();
    }

    pub fn request_turn_undo(&mut self, path: Option<&str>, cx: &mut Context<Self>) {
        if self.turn_changes.is_empty() || self.turn_card == TurnCardState::Dismissed {
            return;
        }
        let language = i18n::resolve(self.settings.locale);
        let target = path.map_or(TurnUndoTarget::WholeTurn, |path| {
            TurnUndoTarget::File(path.to_string())
        });
        let contains_preexisting = match &target {
            TurnUndoTarget::WholeTurn => self
                .turn_changes
                .files
                .iter()
                .any(|file| file.kind == TurnFileKind::PreexistingUntracked),
            TurnUndoTarget::File(path) => self
                .turn_changes
                .files
                .iter()
                .find(|file| file.path == *path)
                .is_some_and(|file| file.kind == TurnFileKind::PreexistingUntracked),
        };
        if contains_preexisting {
            self.turn_card = TurnCardState::Expanded;
            self.turn_card_error =
                Some(i18n::t(language, "turnChanges.preexistingUntrackedWarning").to_string());
            cx.notify();
            return;
        }
        if matches!(&target, TurnUndoTarget::File(path) if !self.turn_changes.files.iter().any(|file| file.path == *path))
        {
            return;
        }
        self.turn_card_error = None;
        self.turn_card = TurnCardState::ConfirmingUndo { target };
        cx.notify();
    }

    pub fn cancel_turn_undo(&mut self, cx: &mut Context<Self>) {
        if self.turn_card.undo_target().is_some() {
            self.turn_card = TurnCardState::Expanded;
            cx.notify();
        }
    }

    pub fn confirm_turn_undo(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.turn_card.undo_target().cloned() else {
            return;
        };
        let language = i18n::resolve(self.settings.locale);
        let files = match &target {
            TurnUndoTarget::WholeTurn => self.turn_changes.files.clone(),
            TurnUndoTarget::File(path) => self
                .turn_changes
                .files
                .iter()
                .filter(|file| file.path == *path)
                .cloned()
                .collect(),
        };
        // Recheck inside the confirmation boundary: no stale state may turn a
        // pre-existing untracked file into a restore or deletion target.
        if files
            .iter()
            .any(|file| file.kind == TurnFileKind::PreexistingUntracked)
        {
            self.turn_card = TurnCardState::Expanded;
            self.turn_card_error =
                Some(i18n::t(language, "turnChanges.preexistingUntrackedWarning").to_string());
            cx.notify();
            return;
        }
        let cwd = self.project_cwd();
        let Some(store) = self.store.clone().zip(cwd) else {
            self.turn_card = TurnCardState::Expanded;
            self.turn_card_error =
                Some(i18n::t(language, "turnChanges.undoUnavailable").to_string());
            cx.notify();
            return;
        };
        let (store, cwd) = store;
        let mut undo_error = None;
        {
            let store = store.lock().expect("state lock");
            for file in &files {
                let paths = std::slice::from_ref(&file.path);
                let result = match file.kind {
                    TurnFileKind::Tracked | TurnFileKind::Removed => {
                        match git::unstage(&store, Platform::current(), &cwd, paths) {
                            Ok(true) => git::restore(&store, Platform::current(), &cwd, paths),
                            Ok(false) => Ok(false),
                            Err(error) => Err(error),
                        }
                    }
                    TurnFileKind::CreatedUntracked => {
                        git::remove_untracked(&store, Platform::current(), &cwd, &file.path)
                    }
                    TurnFileKind::PreexistingUntracked => unreachable!("filtered above"),
                };
                match result {
                    Ok(true) => {}
                    Ok(false) => {
                        undo_error = Some(format!(
                            "{} {}",
                            i18n::t(language, "turnChanges.undoRejected"),
                            file.path
                        ));
                        break;
                    }
                    Err(error) => {
                        undo_error = Some(error.message);
                        break;
                    }
                }
            }
        }
        if let Some(error) = undo_error {
            self.turn_card = TurnCardState::Expanded;
            self.turn_card_error = Some(error);
        } else {
            match target {
                TurnUndoTarget::WholeTurn => self.turn_changes = TurnChanges::default(),
                TurnUndoTarget::File(path) => {
                    if let Some(index) = self
                        .turn_changes
                        .files
                        .iter()
                        .position(|file| file.path == path)
                    {
                        let removed = self.turn_changes.files.remove(index);
                        self.turn_changes.additions = self
                            .turn_changes
                            .additions
                            .saturating_sub(removed.additions);
                        self.turn_changes.deletions = self
                            .turn_changes
                            .deletions
                            .saturating_sub(removed.deletions);
                    }
                }
            }
            self.turn_card = if self.turn_changes.is_empty() {
                TurnCardState::Collapsed
            } else {
                TurnCardState::Expanded
            };
            self.turn_card_error = None;
            self.review_focus_path = None;
        }
        self.refresh_review();
        cx.notify();
    }

    fn turn_changes_card(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let expanded = matches!(
            self.turn_card,
            TurnCardState::Expanded | TurnCardState::ConfirmingUndo { .. }
        );
        let confirmation = self.turn_card.undo_target().cloned();
        let file_rows: Vec<AnyElement> = self
            .turn_changes
            .files
            .iter()
            .enumerate()
            .map(|(index, file)| {
                let path = file.path.clone();
                let source = match file.kind {
                    TurnFileKind::Tracked => self.t("turnChanges.trackedSource"),
                    TurnFileKind::CreatedUntracked => self.t("turnChanges.createdSource"),
                    TurnFileKind::PreexistingUntracked => self.t("turnChanges.preexistingSource"),
                    TurnFileKind::Removed => self.t("turnChanges.removedSource"),
                };
                let can_undo = file.kind != TurnFileKind::PreexistingUntracked;
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .child(
                        div()
                            .id(format!("turn-file-{index}"))
                            .aria_label(self.t("turnChanges.openFileInReview"))
                            .text_sm()
                            .text_color(colors.foreground)
                            .child(path.clone())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_turn_review(Some(&path), cx);
                            }))
                            .test_support(),
                    )
                    .child(
                        div()
                            .text_size(px(10.0))
                            .text_color(colors.muted_foreground)
                            .child(source),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.success)
                            .child(format!("+{}", file.additions)),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.danger)
                            .child(format!("-{}", file.deletions)),
                    )
                    .when(can_undo, |element| {
                        let path = file.path.clone();
                        element.child(
                            div()
                                .id(format!("turn-file-undo-{index}"))
                                .aria_label(self.t("turnChanges.undoFile"))
                                .px_2()
                                .rounded(px(6.0))
                                .border_1()
                                .border_color(colors.border)
                                .text_xs()
                                .child(self.t("turnChanges.undo"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.request_turn_undo(Some(&path), cx);
                                }))
                                .test_support(),
                        )
                    })
                    .into_any_element()
            })
            .collect();
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
            .flex_col()
            .gap_1()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .id("turn-card-toggle")
                            .aria_label(if expanded {
                                self.t("turnChanges.collapse")
                            } else {
                                self.t("turnChanges.expand")
                            })
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_xs()
                            .text_color(colors.foreground)
                            .child(format!(
                                "{} {}",
                                self.turn_changes.files.len(),
                                self.t("turnChanges.filesChanged")
                            ))
                            .child(
                                div()
                                    .text_color(colors.success)
                                    .child(format!("+{}", self.turn_changes.additions)),
                            )
                            .child(
                                div()
                                    .text_color(colors.danger)
                                    .child(format!("-{}", self.turn_changes.deletions)),
                            )
                            .child(if expanded { "⌄" } else { ">" })
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_turn_card(cx)))
                            .test_support(),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("turn-review")
                            .aria_label(self.t("turnChanges.reviewAria"))
                            .px_2()
                            .py_0p5()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .text_color(colors.foreground)
                            .child(format!("📄+ {}", self.t("rightPane.review")))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.open_turn_review(None, cx);
                            }))
                            .test_support(),
                    )
                    .child(
                        div()
                            .id("turn-dismiss")
                            .aria_label(self.t("turnChanges.dismiss"))
                            .px_1()
                            .text_sm()
                            .text_color(colors.muted_foreground)
                            .child("×")
                            .on_click(cx.listener(|this, _, _, cx| this.dismiss_turn_card(cx)))
                            .test_support(),
                    ),
            )
            .when(expanded, |element| {
                element.children(file_rows).child(
                    div().pt_1().child(
                        div()
                            .id("turn-undo")
                            .aria_label(self.t("turnChanges.undoTurn"))
                            .px_2()
                            .py_0p5()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .text_color(colors.danger)
                            .child(self.t("turnChanges.undoTurn"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.request_turn_undo(None, cx);
                            }))
                            .test_support(),
                    ),
                )
            })
            .when_some(confirmation, |element, target| {
                element.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .p_2()
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(colors.danger)
                        .child(
                            div()
                                .text_xs()
                                .text_color(colors.foreground)
                                .child(match target {
                                    TurnUndoTarget::WholeTurn => {
                                        self.t("turnChanges.undoTurn").to_string()
                                    }
                                    TurnUndoTarget::File(path) => path,
                                }),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(colors.danger)
                                .child(self.t("turnChanges.undoWarning")),
                        )
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .child(
                                    div()
                                        .id("turn-undo-cancel")
                                        .px_2()
                                        .py_0p5()
                                        .rounded(px(6.0))
                                        .border_1()
                                        .border_color(colors.border)
                                        .text_xs()
                                        .child(self.t("common.cancel"))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.cancel_turn_undo(cx);
                                        }))
                                        .test_support(),
                                )
                                .child(
                                    div()
                                        .id("turn-undo-confirm")
                                        .px_2()
                                        .py_0p5()
                                        .rounded(px(6.0))
                                        .bg(colors.danger)
                                        .text_xs()
                                        .text_color(colors.primary_foreground)
                                        .child(self.t("common.confirm"))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.confirm_turn_undo(cx);
                                        }))
                                        .test_support(),
                                ),
                        ),
                )
            })
            .when_some(self.turn_card_error.clone(), |element, error| {
                element.child(
                    div()
                        .px_2()
                        .text_xs()
                        .text_color(colors.danger)
                        .child(error),
                )
            })
    }

    fn cycle_effort(&mut self, cx: &mut Context<Self>) {
        let next = match self.settings.default_effort.as_str() {
            "low" => "medium",
            "medium" => "high",
            "high" => "max",
            _ => "low",
        };
        self.update_setting(json!({ "defaultEffort": next }), cx);
    }

    fn cycle_approval(&mut self, cx: &mut Context<Self>) {
        let next = match self.settings.omp_approval_mode {
            omp_core::settings::OmpApprovalMode::Inherit => "always-ask",
            omp_core::settings::OmpApprovalMode::AlwaysAsk => "write",
            omp_core::settings::OmpApprovalMode::Write => "yolo",
            omp_core::settings::OmpApprovalMode::Yolo => "inherit",
        };
        self.update_setting(json!({ "ompApprovalMode": next }), cx);
    }

    fn model_menu(&self, colors: ThemeColor, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.settings.last_selected_model();
        let rows: Vec<AnyElement> = self
            .model_catalog
            .as_ref()
            .map(|catalog| {
                visible_models(&catalog.models, &selected, None)
                    .into_iter()
                    .map(|model| {
                        Self::model_row(
                            model.key.clone(),
                            model.name.clone(),
                            model.key == selected,
                            colors,
                            cx,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        div()
            .id("composer-model-menu")
            .absolute()
            .left(px(0.0))
            .bottom(px(44.0))
            .w(px(420.0))
            .max_h(px(300.0))
            .overflow_y_scroll()
            .p_1()
            .rounded(px(10.0))
            .border_1()
            .border_color(colors.border)
            .bg(colors.popover)
            .shadow(vec![gpui::BoxShadow {
                color: black().opacity(0.38),
                offset: point(px(0.0), px(12.0)),
                blur_radius: px(32.0),
                spread_radius: px(0.0),
                inset: false,
            }])
            .when(rows.is_empty(), |element| {
                element.child(
                    div()
                        .p_2()
                        .text_sm()
                        .text_color(colors.muted_foreground)
                        .child(self.t("common.loading")),
                )
            })
            .children(rows)
            .on_click(cx.listener(|this, _, _, cx| {
                this.model_menu_open = false;
                cx.notify();
            }))
    }

    fn composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let dictation_status = self
            .dictation_error
            .clone()
            .unwrap_or_else(|| format!("Dictation: {}", self.dictation_phase));
        let dictation_preview = self.dictation_preview.clone();
        // One status banner above the input: a runtime error outranks a
        // refused attachment, and the last fork notice comes last. Both
        // failures are errors; a notice keeps the plain confirmation color.
        let banner = self
            .runtime_error
            .clone()
            .or_else(|| self.image_error.clone())
            .map(|error| (error, colors.danger))
            .or_else(|| {
                self.fork_status
                    .clone()
                    .map(|status| (status, colors.muted_foreground))
            });
        let model_label = if self.settings.last_selected_model().is_empty() {
            self.t("common.auto").to_string()
        } else {
            composer_model_label(&self.settings.last_selected_model())
                .trim_start_matches("Model: ")
                .to_string()
        };
        let effort_label = match self.settings.default_effort.as_str() {
            "low" => self.t("common.low"),
            "high" => self.t("common.high"),
            "max" => self.t("common.max"),
            _ => self.t("common.medium"),
        };
        let approval_label = match self.settings.omp_approval_mode {
            omp_core::settings::OmpApprovalMode::Inherit => self.t("common.inherit"),
            omp_core::settings::OmpApprovalMode::AlwaysAsk => "Ask",
            omp_core::settings::OmpApprovalMode::Write => "Write",
            omp_core::settings::OmpApprovalMode::Yolo => "Yolo",
        };
        let has_draft = !self.composer.read(cx).value().trim().is_empty();

        div()
            .flex()
            .flex_col()
            .gap_2()
            .relative()
            .mx(px(24.0))
            .mt(px(8.0))
            .mb(px(13.0))
            .min_h(px(92.0))
            .px(px(11.0))
            .pt(px(10.0))
            .pb(px(9.0))
            .rounded(px(14.0))
            .border_1()
            .border_color(colors.border)
            .bg(colors.popover)
            .shadow(vec![
                gpui::BoxShadow {
                    color: black().opacity(0.28),
                    offset: point(px(0.0), px(4.0)),
                    blur_radius: px(20.0),
                    spread_radius: px(0.0),
                    inset: false,
                },
                gpui::BoxShadow {
                    color: white().opacity(0.09),
                    offset: point(px(0.0), px(0.0)),
                    blur_radius: px(0.0),
                    spread_radius: px(0.5),
                    inset: true,
                },
            ])
            .when_some(banner, |element, (text, color)| {
                element.child(
                    div()
                        .id("status-banner")
                        .aria_label("Status")
                        .text_xs()
                        .text_color(color)
                        .child(text),
                )
            })
            .when(
                self.runtime_error
                    .as_deref()
                    .is_some_and(|error| error.contains("not inside a granted project")),
                |element| {
                    element.child(
                        div()
                            .id("grant-session-project")
                            .aria_label("Add this project folder")
                            .self_start()
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .bg(colors.primary)
                            .text_size(px(11.0))
                            .text_color(colors.primary_foreground)
                            .child(self.t("common.addFolder"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                let path = this
                                    .selected_session
                                    .and_then(|index| this.sessions.get(index))
                                    .map(|session| session.project_path.clone());
                                if let Some(path) = path {
                                    this.grant_project(Path::new(&path), cx);
                                }
                            })),
                    )
                },
            )
            // The pending attachment sits above the input as one chip: the
            // file the next prompt will carry, and the control that drops it.
            .when_some(self.pending_image.clone(), |element, image| {
                element.child(
                    div()
                        .id("composer-attachment")
                        .flex()
                        .items_center()
                        .gap_2()
                        .test_support()
                        .with_animation(
                            "composer-attachment",
                            interaction::motion_spec(interaction::Motion::Attachment).animation(),
                            |element, delta| {
                                element
                                    .opacity(delta.clamp(0.0, 1.0))
                                    .relative()
                                    .top(px(4.0 * (1.0 - delta)))
                            },
                        )
                        .child(
                            div()
                                .id("pending-image")
                                .aria_label(format!("Image: {}", image.name))
                                .px_2()
                                .py_1()
                                .rounded(px(6.0))
                                .border_1()
                                .border_color(colors.border)
                                .text_xs()
                                .text_color(colors.foreground)
                                .child(format!("Image: {}", image.name)),
                        )
                        .child(
                            div()
                                .id("clear-image")
                                .aria_label("Remove image")
                                .px_2()
                                .py_1()
                                .rounded(px(6.0))
                                .text_xs()
                                .text_color(colors.muted_foreground)
                                .child("×")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.clear_pending_image(cx);
                                })),
                        ),
                )
            })
            .when(
                self.dictation_active
                    || self.dictation_error.is_some()
                    || !dictation_preview.is_empty(),
                |element| {
                    element.child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_xs()
                            .text_color(if self.dictation_error.is_some() {
                                colors.danger
                            } else {
                                colors.muted_foreground
                            })
                            .child(dictation_status.clone())
                            .when(!dictation_preview.is_empty(), |element| {
                                element.child(
                                    div()
                                        .flex_1()
                                        .overflow_hidden()
                                        .child(dictation_preview.clone()),
                                )
                            }),
                    )
                },
            )
            // The mention popover sits directly above the input: one row per
            // recent session, bounded by `MENTION_MENU_LIMIT`, or the empty
            // status when the catalog has nothing to mention.
            .when(self.mention_menu_open, |element| {
                let candidates = self.mention_candidates();
                element.child(
                    div()
                        .id("mention-menu")
                        .aria_label("Mention session")
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .p_1()
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(colors.border)
                        .when(candidates.is_empty(), |element| {
                            element.child(
                                div()
                                    .id("mention-empty")
                                    .px_2()
                                    .py_1()
                                    .text_xs()
                                    .text_color(colors.muted_foreground)
                                    .child(
                                        self.mention_status
                                            .clone()
                                            .unwrap_or_else(|| MENTION_EMPTY_STATUS.to_string()),
                                    ),
                            )
                        })
                        .children(candidates.into_iter().enumerate().map(|(row, index)| {
                            let session = &self.sessions[index];
                            div()
                                .id(format!("mention-{row}"))
                                .aria_label(format!("Mention {}", session.title))
                                .flex()
                                .items_center()
                                .gap_2()
                                .px_2()
                                .py_1()
                                .rounded(px(6.0))
                                .text_sm()
                                .text_color(colors.foreground)
                                .hover(|style| style.bg(colors.accent))
                                .child(session.title.clone())
                                .child(
                                    div()
                                        .flex_1()
                                        .text_xs()
                                        .text_color(colors.muted_foreground)
                                        .child(self.mention_relative_path(&session.file_path)),
                                )
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.select_mention(row, window, cx);
                                }))
                        })),
                )
            })
            .child(
                div().flex().items_center().min_h(px(36.0)).child(
                    div()
                        .id("composer-input")
                        .test_support()
                        .flex_1()
                        .child(Input::new(&self.composer).appearance(false).bordered(false)),
                ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .min_h(px(28.0))
                    .pt(px(6.0))
                    .border_t_1()
                    .border_color(colors.border.opacity(0.62))
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(
                        div()
                            .id("composer-plus")
                            .aria_label(self.t("common.attach"))
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(28.0))
                            .rounded(px(6.0))
                            .text_color(colors.muted_foreground)
                            .hover(|style| style.bg(colors.accent))
                            .child(div().text_size(px(16.0)).child(IconName::Plus))
                            .on_click(
                                cx.listener(|this, _, window, cx| this.pick_image(window, cx)),
                            ),
                    )
                    .child(
                        div()
                            .id("model-picker")
                            .aria_label(self.t("composer.model"))
                            .flex()
                            .items_center()
                            .gap_1()
                            .h(px(26.0))
                            .max_w(px(170.0))
                            .overflow_hidden()
                            .px_2()
                            .rounded(px(999.0))
                            .text_size(px(11.0))
                            .text_color(colors.muted_foreground)
                            .hover(|style| style.bg(colors.accent))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.model_menu_open = !this.model_menu_open;
                                if this.model_menu_open {
                                    this.ensure_models(cx);
                                }
                                cx.notify();
                            }))
                            .child(div().text_size(px(14.0)).child(IconName::Brain))
                            .child(div().overflow_hidden().text_ellipsis().child(model_label))
                            .child(div().text_size(px(12.0)).child(IconName::ChevronDown)),
                    )
                    .child(
                        div()
                            .id("effort-picker")
                            .aria_label(self.t("composer.effort"))
                            .flex()
                            .items_center()
                            .gap_1()
                            .h(px(26.0))
                            .px_2()
                            .rounded(px(999.0))
                            .text_size(px(11.0))
                            .text_color(colors.muted_foreground)
                            .hover(|style| style.bg(colors.accent))
                            .on_click(cx.listener(|this, _, _, cx| this.cycle_effort(cx)))
                            .child(div().text_size(px(14.0)).child(IconName::Gauge))
                            .child(effort_label)
                            .child(div().text_size(px(12.0)).child(IconName::ChevronDown)),
                    )
                    .child(
                        div()
                            .id("approval-mode")
                            .aria_label(self.t("composer.approval"))
                            .flex()
                            .items_center()
                            .gap_1()
                            .h(px(26.0))
                            .px_2()
                            .rounded(px(999.0))
                            .text_size(px(11.0))
                            .text_color(colors.muted_foreground)
                            .hover(|style| style.bg(colors.accent))
                            .on_click(cx.listener(|this, _, _, cx| this.cycle_approval(cx)))
                            .child(div().text_size(px(14.0)).child(IconName::Shield))
                            .child(approval_label),
                    )
                    .child(div().flex_1())
                    .when_some(self.context_usage, |element, usage| {
                        element.child(context_usage_dial(usage, colors))
                    })
                    .child(
                        div()
                            .id("live-voice")
                            .aria_label(self.t("common.live"))
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(28.0))
                            .rounded(px(6.0))
                            .text_color(colors.muted_foreground)
                            .hover(|style| style.bg(colors.accent))
                            .child(div().text_size(px(16.0)).child(IconName::AudioLines))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.set_right_pane("live-voice", cx);
                            })),
                    )
                    .child(
                        div()
                            .id("dictate")
                            .aria_label(self.dictation_label())
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(28.0))
                            .rounded(px(6.0))
                            .text_color(if self.dictation_active {
                                colors.danger
                            } else {
                                colors.muted_foreground
                            })
                            .hover(|style| style.bg(colors.accent))
                            .child(div().text_size(px(16.0)).child(IconName::Mic))
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_dictation(cx))),
                    )
                    .child(
                        div()
                            .id("send-prompt")
                            .aria_label(if self.running {
                                self.t("common.stop")
                            } else {
                                self.t("common.send")
                            })
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(30.0))
                            .rounded(px(999.0))
                            .bg(if self.running {
                                colors.danger
                            } else if has_draft {
                                colors.foreground
                            } else {
                                colors.selection
                            })
                            .text_color(if self.running {
                                white()
                            } else if has_draft {
                                colors.background
                            } else {
                                colors.muted_foreground
                            })
                            .child(div().text_size(px(16.0)).child(if self.running {
                                IconName::Square
                            } else {
                                IconName::ArrowUp
                            }))
                            .on_click(
                                cx.listener(|this, _, window, cx| this.send_prompt(window, cx)),
                            ),
                    ),
            )
            .child(
                div()
                    .text_size(px(9.5))
                    .text_color(colors.muted_foreground)
                    .text_center()
                    .child(self.t("composer.note")),
            )
            .when(self.model_menu_open, |element| {
                element.child(self.model_menu(colors, cx))
            })
    }

    pub fn set_view(&mut self, view: AppView, cx: &mut Context<Self>) {
        if view != AppView::Workspace {
            self.reset_transcript_search(cx);
        }
        self.view = view;
        if view == AppView::Schedules {
            self.refresh_schedules();
        }
        if view == AppView::Settings {
            // Opening Settings is what needs the picker's list; the load is
            // cached, so every later visit reuses it.
            self.ensure_models(cx);
        }
        self.apply_overview_pin();
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

    /// Reloads the activity list from the state file, which owns it.
    pub fn refresh_notifications(&mut self) {
        self.notifications = match self.store.as_ref() {
            Some(store) => {
                let store = store.lock().expect("state lock");
                store.state().notifications.clone()
            }
            None => Vec::new(),
        };
        self.refresh_attention();
    }

    /// How many notifications still want the user's eyes. The toolbar's badge
    /// and the launcher's attention count both read this, so the two never
    /// disagree about what is unread.
    pub fn unread_notifications(&self) -> usize {
        self.notifications.iter().filter(|item| !item.read).count()
    }

    /// Counts what still wants the user's eyes: unread notifications plus
    /// unread sessions. Every reload of either list ends here, so the badge
    /// never reports a count the lists no longer back.
    fn refresh_attention(&mut self) {
        let notifications = self.unread_notifications();
        let sessions = self
            .sessions
            .iter()
            .filter(|session| session.unread)
            .count();
        self.attention_count = notifications + sessions;
    }

    /// Whether the Overview launcher is on screen. The launcher is the pane the
    /// workspace view starts on; a pinned one also rides along to the other
    /// views, which is what keeps it visible across a view switch.
    fn overview_visible(&self) -> bool {
        self.right_pane == RightPane::Launcher
            && self.layout.right_pane_docked
            && (self.view == AppView::Workspace || self.overview_pinned)
    }

    /// Keeps the launcher on screen across a view or session switch while the
    /// overview is pinned. Unpinned, the switch leaves the right pane alone.
    fn apply_overview_pin(&mut self) {
        if self.overview_pinned {
            self.right_pane = RightPane::Launcher;
        }
    }

    pub fn notifications(&self) -> &[NotificationRecord] {
        &self.notifications
    }

    /// Clears the activity list through `store.update`, so the empty list is
    /// what a reload reads. A failed save leaves the list untouched.
    pub fn clear_notifications(&mut self, cx: &mut Context<Self>) {
        if let Some(store) = self.store.clone() {
            let mut store = store.lock().expect("state lock");
            let _ = store.update(|state| {
                state.notifications.clear();
                Ok(())
            });
        }
        self.refresh_notifications();
        cx.notify();
    }

    /// Marks every notification the Activity pane lists as read through
    /// `store.update`, so opening the pane clears the badge and a reload reads
    /// the same state back. An already-read list is not rewritten.
    pub fn mark_notifications_read(&mut self, cx: &mut Context<Self>) {
        // The store owns the list, so read what it holds before deciding: a
        // record another window appended is marked read too, not missed.
        self.refresh_notifications();
        if self.unread_notifications() > 0
            && let Some(store) = self.store.clone()
        {
            let mut store = store.lock().expect("state lock");
            let _ = store.update(|state| {
                for notification in &mut state.notifications {
                    notification.read = true;
                }
                Ok(())
            });
        }
        self.refresh_notifications();
        cx.notify();
    }

    /// Appends one agent completion to the persisted activity list. It is
    /// recorded unread, so the toolbar badge counts it until the Activity pane
    /// is opened; the list keeps the newest `MAX_ACTIVITY_NOTIFICATIONS`
    /// entries, matching the state parser's own prune.
    pub fn record_completion_notification(&mut self, title: &str, body: &str) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let record = NotificationRecord {
            id: format!("agent-end-{now}-{}", self.notification_counter),
            title: title.to_string(),
            body: body.to_string(),
            created_at: now,
            read: false,
            unknown: Default::default(),
        };
        self.notification_counter = self.notification_counter.wrapping_add(1);
        {
            let mut store = store.lock().expect("state lock");
            let _ = store.update(|state| {
                state.notifications.push(record);
                let excess = state
                    .notifications
                    .len()
                    .saturating_sub(MAX_ACTIVITY_NOTIFICATIONS);
                state.notifications.drain(0..excess);
                Ok(())
            });
        }
        self.refresh_notifications();
    }

    pub fn refresh_files(&mut self) {
        let Some(store) = self.store.clone() else {
            self.files.clear();
            self.files_skipped = 0;
            self.files_error = Some("The desktop state store is unavailable.".to_string());
            return;
        };
        let Some(cwd) = self.project_cwd() else {
            self.files.clear();
            self.files_skipped = 0;
            self.files_error = Some("Select a project to browse its files.".to_string());
            return;
        };
        let store = store.lock().expect("state lock");
        match projects::list_files(&store, Platform::current(), &cwd) {
            Ok(listing) => {
                self.files = listing.entries;
                self.files_skipped = listing.skipped;
                self.files_error = None;
            }
            Err(error) => {
                self.files.clear();
                self.files_skipped = 0;
                self.files_error = Some(error.message);
            }
        }
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
                    let runtime_for_run = runtime_id.clone();
                    let run_id = self.record_schedule_outcome(
                        &store,
                        &schedule.id,
                        &scheduled_for,
                        &status,
                        runtime_id,
                        error,
                    );
                    if status == "failed" {
                        if let Some(runtime_id) = runtime_for_run.as_deref() {
                            self.agents.stop(runtime_id);
                        }
                    } else if let (Some(runtime_id), Some(run_id)) = (runtime_for_run, run_id) {
                        self.scheduled_runs.push(ScheduledRun {
                            runtime_id,
                            schedule_id: schedule.id.clone(),
                            run_id,
                        });
                    }
                    // A scheduled run counts as an active agent for closing.
                    self.sync_close_guard();
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
        for run in std::mem::take(&mut self.scheduled_runs) {
            let events = self.agents.drain_events(Some(&run.runtime_id));
            let ended = events.iter().any(|envelope| {
                envelope.pointer("/event/type").and_then(Value::as_str) == Some("agent_end")
            });
            if ended {
                self.finish_schedule_run(&run.schedule_id, &run.run_id, "succeeded");
                self.agents.stop(&run.runtime_id);
            } else {
                active.push(run);
            }
        }
        while active.len() > 8 {
            let run = active.remove(0);
            self.finish_schedule_run(&run.schedule_id, &run.run_id, "interrupted");
            self.agents.stop(&run.runtime_id);
        }
        self.scheduled_runs = active;
        self.sync_close_guard();
    }

    fn finish_schedule_run(&self, schedule_id: &str, run_id: &str, status: &str) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut store = store.lock().expect("state lock");
        let _ = store.update(|state| {
            if let Some(schedule) = state
                .schedules
                .iter_mut()
                .find(|schedule| schedule.id == schedule_id)
                && let Some(run) = schedule.runs.iter_mut().find(|run| run.id == run_id)
            {
                run.status = status.to_string();
                run.finished_at = Some(now.clone());
                schedule.revision += 1;
                schedule.updated_at = now.clone();
            }
            Ok(())
        });
    }

    fn record_schedule_outcome(
        &self,
        store: &Arc<Mutex<StateStore>>,
        id: &str,
        scheduled_for: &str,
        status: &str,
        session_id: Option<String>,
        error: Option<String>,
    ) -> Option<String> {
        let now = Utc::now();
        let outcome = scheduler::ScheduleRunOutcome {
            status: status.to_string(),
            session_id,
            error,
        };
        let mut store = store.lock().expect("state lock");
        let value = scheduler::record(&mut store, id, scheduled_for, &outcome, now).ok()?;
        value
            .get("runs")?
            .as_array()?
            .last()?
            .get("id")?
            .as_str()
            .map(str::to_string)
    }

    pub fn update_setting(&mut self, patch: Value, cx: &mut Context<Self>) {
        let previous_reduce_motion = self.settings.reduce_motion;
        if let Some(store) = self.store.clone() {
            let mut store = store.lock().expect("state lock");
            if let Ok(next) = store.update_settings(&patch) {
                self.settings = next;
            }
        }
        if self.settings.reduce_motion != previous_reduce_motion {
            interaction::apply_reduce_motion(self.settings.reduce_motion, cx);
        }
        cx.notify();
    }

    /// The composer footer's model label, kept in sync with the selection.
    pub fn model_footer(&self) -> String {
        composer_model_label(&self.settings.last_selected_model())
    }

    /// Loads the harness model catalog once and caches it in the workspace.
    ///
    /// `omp models --json` spawns the harness, so it runs on the background
    /// executor: the Settings page draws the current model immediately and the
    /// list arrives on a later frame. A cached catalog, or one already in
    /// flight, is reused instead of spawning the harness again.
    fn ensure_models(&mut self, cx: &mut Context<Self>) {
        if self.model_catalog.is_some() || self.model_load_task.is_some() {
            return;
        }
        let context = CliContext {
            executable: self.omp_executable.clone(),
            home_dir: self.home_dir.clone(),
            root_dir: self.user_data_dir.clone(),
            extra_env: Vec::new(),
        };
        self.model_load_task = Some(cx.spawn(async move |this, cx| {
            let catalog = cx
                .background_executor()
                .spawn(async move { models::load_catalog(&context) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.model_load_task = None;
                this.apply_model_catalog(catalog);
                cx.notify();
            });
        }));
    }

    /// Replaces the cached catalog the Settings picker lists.
    ///
    /// `load_catalog` reports a harness that could not answer as an empty
    /// catalog with a warning, so a load failure is visible through
    /// [`Self::model_catalog_error`] instead of leaving the picker blank.
    ///
    /// The provider row starts on the current model's provider, so the list
    /// opens narrowed to the choice the footer already names. A selection the
    /// catalog does not carry, or the harness default, starts on `All`.
    pub fn apply_model_catalog(&mut self, catalog: ModelCatalog) {
        self.provider_filter = parse_model_key(&self.settings.last_selected_model())
            .map(|(provider, _)| provider)
            .filter(|provider| {
                catalog
                    .models
                    .iter()
                    .any(|model| model.provider == *provider)
            })
            .map(str::to_string);
        self.model_catalog = Some(catalog);
    }

    /// Why the picker has no catalog models, if it has none. The current
    /// selection stays selectable either way, so this is inline text rather
    /// than a failure state.
    fn model_catalog_error(&self) -> Option<String> {
        let catalog = self.model_catalog.as_ref()?;
        if !catalog.models.is_empty() {
            return None;
        }
        Some(
            catalog
                .warning
                .clone()
                .unwrap_or_else(|| "OMP returned an empty model catalog.".to_string()),
        )
    }

    /// Filters the Settings model list to one catalog provider.
    ///
    /// `None` is the `All` chip. The filter is a view of the catalog only: the
    /// persisted selection is untouched, so a chip that does not carry the
    /// current model still leaves it drawn in the current-model row and
    /// applied to the next runtime.
    pub fn select_provider_filter(&mut self, provider: Option<&str>, cx: &mut Context<Self>) {
        self.provider_filter = provider.map(str::to_string);
        cx.notify();
    }

    /// Selects a catalog model by its `provider/id` key: the choice becomes the
    /// persisted harness default, the composer footer follows it, and a live
    /// runtime is switched with `set_model`.
    ///
    /// A rejected `set_model` is reported in Settings; the persisted default
    /// still applies to the next runtime, so it is not rolled back.
    pub fn select_model(&mut self, key: &str, cx: &mut Context<Self>) {
        let Some((provider, id)) = parse_model_key(key) else {
            return;
        };
        // A choice from another provider would vanish under the active chip,
        // so the row falls back to `All` and keeps the choice in the list.
        if self
            .provider_filter
            .as_deref()
            .is_some_and(|filter| filter != provider)
        {
            self.provider_filter = None;
        }
        self.update_setting(json!({ "lastSelectedModels": { "omp": key } }), cx);
        self.model_status = None;
        if let Some(runtime_id) = self.runtime_id.clone() {
            match self.agents.command(
                &runtime_id,
                &json!({ "type": "set_model", "provider": provider, "modelId": id }),
            ) {
                Ok(response) if response.get("success").and_then(Value::as_bool) == Some(true) => {}
                Ok(response) => {
                    let message = response
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("OMP rejected the model switch");
                    self.model_status = Some(format!("OMP could not switch the model: {message}"));
                }
                Err(error) => {
                    self.model_status =
                        Some(format!("OMP could not switch the model: {}", error.message));
                }
            }
        }
        cx.notify();
    }

    /// Check the release feed off the UI thread and reflect the outcome in the
    /// Settings row. This only reads the feed; it never downloads or installs.
    fn start_update_check(&mut self, cx: &mut Context<Self>) {
        if self.update_check == UpdateCheckState::Checking {
            return;
        }
        let configured = updates::is_configured();
        if !configured {
            // No feed or public key in this build: say so instead of opening a
            // socket to a release that does not exist yet.
            self.update_check = UpdateCheckState::Unconfigured;
            cx.notify();
            return;
        }
        self.update_check = UpdateCheckState::Checking;
        cx.notify();
        // The check blocks on the network, so it runs on the background
        // executor; only the state update touches GPUI.
        self.update_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async { updates::check() })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.update_check = updates::state_for_result(configured, result);
                cx.notify();
            });
        }));
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
            .min_h(px(64.0))
            .py(px(15.0))
            .border_b_1()
            .border_color(colors.border)
            .text_size(px(12.0))
            .text_color(colors.foreground)
            .hover(|style| style.bg(colors.accent))
            .child(label)
            .child(div().flex_1())
            .child(
                div()
                    .text_size(px(10.5))
                    .text_color(colors.muted_foreground)
                    .child(value),
            )
            .on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
    }

    fn settings_info_card(
        &self,
        label: &'static str,
        value: impl Into<String>,
        colors: ThemeColor,
    ) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .px_3()
            .py_2()
            .rounded(px(8.0))
            .border_1()
            .border_color(colors.border)
            .child(div().text_sm().text_color(colors.foreground).child(label))
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(value.into()),
            )
    }

    /// The provider chips above the model list: `All` plus one chip per
    /// catalog provider. A chip only changes what the list draws, so the
    /// persisted selection survives every filter change.
    fn provider_filter_row(
        chips: &[ProviderChip],
        active: Option<&str>,
        colors: ThemeColor,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut row = div()
            .id("model-provider-filter")
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .child(Self::provider_chip(
                "All",
                None,
                None,
                active.is_none(),
                colors,
                cx,
            ));
        for chip in chips {
            row = row.child(Self::provider_chip(
                &chip.name,
                Some(&chip.id),
                chip.configured,
                active == Some(chip.id.as_str()),
                colors,
                cx,
            ));
        }
        row.into_any_element()
    }

    /// One provider filter chip. The hint names whether the harness has
    /// credentials for the provider; an unconfigured provider stays selectable
    /// because the harness reports the auth error when its model is chosen.
    fn provider_chip(
        label: &str,
        id: Option<&str>,
        configured: Option<bool>,
        selected: bool,
        colors: ThemeColor,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let element_id = format!("model-provider-{}", id.unwrap_or("all"));
        let aria = match id {
            Some(id) => format!("{label} provider ({id})"),
            None => "All providers".to_string(),
        };
        let hint = match configured {
            Some(true) => Some(("configured", colors.muted_foreground)),
            Some(false) => Some(("not configured", colors.warning)),
            None => None,
        };
        let target = id.map(str::to_string);
        let mut chip = div()
            .id(SharedString::from(element_id))
            .aria_label(aria)
            .flex()
            .items_center()
            .gap_1()
            .px_2()
            .py_0p5()
            .rounded(px(999.0))
            .border_1()
            .border_color(if selected {
                colors.primary
            } else {
                colors.border
            })
            .text_xs()
            .text_color(colors.foreground)
            .hover(|style| style.bg(colors.accent))
            .child(label.to_string());
        if let Some((hint, color)) = hint {
            chip = chip.child(div().text_color(color).child(hint));
        }
        chip.on_click(cx.listener(move |this, _, _, cx| {
            this.select_provider_filter(target.as_deref(), cx);
        }))
        .into_any_element()
    }

    /// One selectable catalog model in the Settings picker. The row's id and
    /// aria label are its `provider/id` key, so the choice is addressable and
    /// the highlighted row is the persisted selection.
    fn model_row(
        key: String,
        name: String,
        selected: bool,
        colors: ThemeColor,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let detail = if selected {
            format!("{key} · selected")
        } else {
            key.clone()
        };
        div()
            .id(SharedString::from(key.clone()))
            .aria_label(key.clone())
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .rounded(px(8.0))
            .border_1()
            .border_color(if selected {
                colors.primary
            } else {
                colors.border
            })
            .text_sm()
            .text_color(colors.foreground)
            .hover(|style| style.bg(colors.accent))
            .child(name)
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(detail),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select_model(&key, cx);
            }))
            .into_any_element()
    }

    /// The picker's current selection. It is drawn even when the catalog
    /// cannot list it, because the persisted default is usable on its own.
    fn current_model_row(model: &str, colors: ThemeColor) -> AnyElement {
        let value = if model.is_empty() {
            "auto".to_string()
        } else {
            model.to_string()
        };
        div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .rounded(px(8.0))
            .border_1()
            .border_color(colors.primary)
            .text_sm()
            .text_color(colors.foreground)
            .child("Current model")
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child(value),
            )
            .into_any_element()
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
            .min_w(px(0.0))
            .w_full()
            .max_w(px(960.0))
            .mx_auto()
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
        self.plugin_status = None;
        self.plugin_error = None;
    }

    pub fn plugin_catalog(&self) -> Option<&PluginCatalog> {
        self.plugin_catalog.as_ref()
    }

    /// The Extensions page's install field, so a scenario can type a source
    /// into the same control the page draws.
    pub fn plugin_source_entity(&self) -> &Entity<InputState> {
        &self.plugin_source
    }

    /// Replaces how the Extensions page installs a plugin.
    ///
    /// The real installer spawns `omp`, which the parity suite never does, so a
    /// scenario substitutes a stand-in for the harness. The seam is the whole
    /// contract: the same `CliContext` the rest of the app builds, the source
    /// exactly as submitted, and the install's JSON answer.
    pub fn set_plugin_installer(
        &mut self,
        installer: impl Fn(&CliContext, &str) -> Result<Value, String> + Send + Sync + 'static,
    ) {
        self.plugin_installer = Arc::new(installer);
    }

    /// Submits the Extensions page's install field.
    ///
    /// The field is the only source: an empty one does nothing, so a stray
    /// Enter on the page never spawns the harness.
    pub fn submit_plugin_install(&mut self, cx: &mut Context<Self>) {
        let source = self.plugin_source.read(cx).value().trim().to_string();
        if source.is_empty() {
            return;
        }
        self.install_plugin(&source, cx);
    }

    /// Installs one plugin source and refreshes the catalog.
    ///
    /// `plugins::install` shells out to the harness, so the call runs on the
    /// background executor and its result is applied on the UI thread: the
    /// catalog is re-read and the page's banner states the outcome. One install
    /// runs at a time, so a second submit while one is in flight is ignored
    /// rather than spawning the harness twice. A result without `ok: true`
    /// counts as a failure: the core's install reports a command that exited
    /// non-zero as `{ "ok": false }`, not as an error.
    pub fn install_plugin(&mut self, source: &str, cx: &mut Context<Self>) {
        if self.plugin_install_task.is_some() {
            return;
        }
        let source = source.trim().to_string();
        if source.is_empty() {
            return;
        }
        let context = CliContext {
            executable: self.omp_executable.clone(),
            home_dir: self.home_dir.clone(),
            root_dir: self.user_data_dir.clone(),
            extra_env: Vec::new(),
        };
        let installer = self.plugin_installer.clone();
        // The previous outcome is not this install's, so it is cleared before
        // the harness is asked: the page never shows a stale banner.
        self.plugin_status = None;
        self.plugin_error = None;
        self.plugin_install_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { installer(&context, &source) })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.plugin_install_task = None;
                // `refresh_plugins` clears the banner, so the outcome is set
                // after the catalog has been re-read.
                this.refresh_plugins();
                match result {
                    Ok(value) if value.get("ok").and_then(Value::as_bool) == Some(true) => {
                        this.plugin_status = Some("Plugin installed".to_string());
                    }
                    Ok(_) => {
                        this.plugin_error = Some(
                            "OMP could not install the plugin: the install command did not report success"
                                .to_string(),
                        );
                    }
                    Err(error) => {
                        this.plugin_error =
                            Some(format!("OMP could not install the plugin: {error}"));
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// Enables or disables one MCP server or package row.
    ///
    /// The page's toggle and the parity harness both come through here. The
    /// change is written by the core (`set_mcp_enabled` for a server,
    /// `mutate_capability` for a package), then the catalog is re-read so the
    /// row shows what is actually on disk. A change the core accepts but the
    /// refreshed catalog does not reflect is reported as a failure: the page
    /// never claims a row changed while it still draws the old state.
    pub fn set_extension_enabled(&mut self, name: &str, enabled: bool, cx: &mut Context<Self>) {
        let outcome = self.apply_extension_change(name, enabled);
        self.refresh_plugins();
        match outcome {
            Err(error) => {
                self.plugin_status = None;
                self.plugin_error = Some(error);
            }
            Ok(()) => {
                if self.extension_enabled(name) == Some(enabled) {
                    self.plugin_status = Some("Extensions updated".to_string());
                    self.plugin_error = None;
                } else {
                    self.plugin_status = None;
                    self.plugin_error = Some(format!(
                        "OMP could not update extensions: {name} is still {} after the change",
                        if enabled { "disabled" } else { "enabled" }
                    ));
                }
            }
        }
        cx.notify();
    }

    /// The refreshed catalog's own answer for a row, so the page reads the
    /// same record it draws instead of trusting the request it just sent.
    fn extension_enabled(&self, name: &str) -> Option<bool> {
        self.plugin_catalog
            .as_ref()?
            .skills
            .iter()
            .find(|skill| skill.name == name && matches!(skill.kind.as_str(), "mcp" | "package"))
            .map(|skill| skill.enabled)
    }

    fn apply_extension_change(&mut self, name: &str, enabled: bool) -> Result<(), String> {
        let record = self
            .plugin_catalog
            .as_ref()
            .and_then(|catalog| {
                catalog.skills.iter().find(|skill| {
                    skill.name == name && matches!(skill.kind.as_str(), "mcp" | "package")
                })
            })
            .cloned()
            .ok_or_else(|| {
                format!("OMP could not update extensions: {name} is not in the catalog")
            })?;
        let scope = self.extension_scope(&record)?;
        let project = match scope {
            "project" => Some(self.project_cwd().ok_or_else(|| {
                format!(
                    "OMP could not update extensions: open a project before changing the project {} {name}",
                    record.kind
                )
            })?),
            _ => None,
        };
        let store = self.store.clone().ok_or_else(|| {
            "OMP could not update extensions: the desktop state store is unavailable".to_string()
        })?;
        let agent_dir = self.home_dir.join(".omp").join("agent");
        let mut input = if record.kind == "mcp" {
            json!({ "name": record.name, "scope": scope, "enabled": enabled })
        } else {
            let mut input = json!({
                "kind": "package",
                "action": if enabled { "enable" } else { "disable" },
                "name": record.name,
                "scope": scope,
            });
            if let Some(source) = record.source.as_ref() {
                input["source"] = json!(source);
            }
            input
        };
        if let Some(project) = project.as_ref() {
            input["projectPath"] = json!(project);
        }
        let store = store.lock().expect("state lock");
        let result = if record.kind == "mcp" {
            plugins::set_mcp_enabled(&agent_dir, &store, Platform::current(), &input)
        } else {
            plugins::mutate_capability(&agent_dir, &store, Platform::current(), &input)
        };
        result
            .map(|_| ())
            .map_err(|error| format!("OMP could not update extensions: {}", error.message))
    }

    /// The scope a row writes to. Discovery labels every row `user` or
    /// `project`; when a catalog came from another caller the row's own path
    /// decides. An undeducible scope is an error rather than a guess: writing
    /// the user file for a project row would edit a file the row is not from.
    fn extension_scope(&self, record: &plugins::SkillRecord) -> Result<&'static str, String> {
        match record.location.as_str() {
            "user" => return Ok("user"),
            "project" => return Ok("project"),
            _ => {}
        }
        if let Some(path) = record.path.as_deref().map(PathBuf::from) {
            if path.starts_with(self.home_dir.join(".omp").join("agent")) {
                return Ok("user");
            }
            if let Some(project) = self.project_cwd().map(PathBuf::from)
                && path.starts_with(project)
            {
                return Ok("project");
            }
        }
        Err(format!(
            "OMP could not update extensions: the scope of {} could not be derived",
            record.name
        ))
    }

    /// One Extensions row's enable/disable control.
    ///
    /// The label names the action the click performs, so an enabled row offers
    /// `Disable` and a disabled one offers `Enable`; the row itself keeps
    /// drawing the config's state next to it.
    fn extension_toggle(
        record: &plugins::SkillRecord,
        colors: ThemeColor,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let name = record.name.clone();
        let enabled = record.enabled;
        let label = if enabled { "Disable" } else { "Enable" };
        div()
            .id(format!("extension-toggle:{}", record.id))
            .aria_label(label)
            .px_2()
            .py_1()
            .rounded(px(6.0))
            .border_1()
            .border_color(colors.border)
            .text_xs()
            .text_color(colors.foreground)
            .hover(|style| style.bg(colors.accent))
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.set_extension_enabled(&name, !enabled, cx);
            }))
            .into_any_element()
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
            .min_w(px(0.0))
            .w_full()
            .max_w(px(960.0))
            .mx_auto()
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
            // The last toggle's outcome. An error outranks the success notice
            // so a failed change is never hidden behind an older success.
            .when(
                self.plugin_status.is_some() || self.plugin_error.is_some(),
                |element| {
                    let (message, color) = match self.plugin_error.as_ref() {
                        Some(error) => (error.clone(), colors.danger),
                        None => (
                            self.plugin_status.clone().unwrap_or_default(),
                            colors.success,
                        ),
                    };
                    element.child(
                        div()
                            .id("plugins-status")
                            .px_3()
                            .py_2()
                            .rounded(px(8.0))
                            .border_1()
                            .border_color(color)
                            .text_xs()
                            .text_color(color)
                            .child(message),
                    )
                },
            )
            // The install row: the field's source goes to the harness as-is
            // and the catalog below is re-read when it returns. The button is
            // inert while the field is empty or an install is in flight.
            .child({
                let has_source = !self.plugin_source.read(cx).value().trim().is_empty();
                let installing = self.plugin_install_task.is_some();
                let mut install = div()
                    .id("plugins-install")
                    .aria_label("Install plugin")
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(colors.border)
                    .text_xs()
                    .child(if installing {
                        "Installing…"
                    } else {
                        "Install"
                    });
                if has_source && !installing {
                    install = install
                        .text_color(colors.foreground)
                        .hover(|style| style.bg(colors.accent))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.submit_plugin_install(cx);
                        }));
                } else {
                    install = install.text_color(colors.muted_foreground);
                }
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child("Install plugin"),
                    )
                    .child(
                        div()
                            .flex_1()
                            .child(Input::new(&self.plugin_source).aria_label("Plugin source")),
                    )
                    .child(install)
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
                let toggle = Self::extension_toggle(&package, colors, cx);
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
                    .child(toggle)
            }))
            .child(
                div()
                    .text_xs()
                    .text_color(colors.muted_foreground)
                    .child("MCP SERVERS"),
            )
            .children(mcp.into_iter().map(|server| {
                // The row states what the config says before the button acts on
                // it, so disabling the server in use is never a silent switch.
                let toggle = Self::extension_toggle(&server, colors, cx);
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
                    .child(toggle)
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
        div()
            .id("settings-page")
            .flex()
            .h_full()
            .w_full()
            .child(self.settings_nav(colors, cx))
            .child(
                div()
                    .id("settings-content")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w(px(0.0))
                    .h_full()
                    .overflow_y_scroll()
                    .bg(colors.background)
                    .px(px(32.0))
                    .pt(px(36.0))
                    .pb(px(70.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_4()
                            .w_full()
                            .max_w(px(720.0))
                            .mx_auto()
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
                                    .child(
                                        div()
                                            .text_size(px(22.0))
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child(self.t(self.settings_section.key())),
                                    ),
                            )
                            .child(self.settings_section_content(colors, cx)),
                    ),
            )
    }

    fn settings_nav(&self, colors: ThemeColor, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .w(px(190.0))
            .h_full()
            .px(px(10.0))
            .py(px(20.0))
            .gap(px(2.0))
            .border_r_1()
            .border_color(colors.border)
            .bg(colors.tab)
            .children(SettingsSection::ALL.into_iter().map(|section| {
                let active = self.settings_section == section;
                div()
                    .id(section.key())
                    .aria_label(self.t(section.key()))
                    .flex()
                    .items_center()
                    .h(px(33.0))
                    .px_2()
                    .rounded(px(7.0))
                    .text_sm()
                    .text_color(if active {
                        colors.foreground
                    } else {
                        colors.muted_foreground
                    })
                    .when(active, |element| element.bg(colors.accent))
                    .hover(|style| style.bg(colors.accent))
                    .child(self.t(section.key()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.settings_section = section;
                        cx.notify();
                    }))
            }))
    }

    fn settings_section_content(&self, colors: ThemeColor, cx: &mut Context<Self>) -> AnyElement {
        match self.settings_section {
            SettingsSection::General => {
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
                    .gap_3()
                    .child(self.settings_row(
                        self.t("settings.language"),
                        self.locale_label().to_string(),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let next = match this.settings.locale {
                                omp_core::settings::Locale::System => "en",
                                omp_core::settings::Locale::En => "zh-TW",
                                omp_core::settings::Locale::ZhTw => "zh-CN",
                                omp_core::settings::Locale::ZhCn => "system",
                            };
                            this.update_setting(json!({ "locale": next }), cx);
                        },
                    ))
                    .child(self.settings_row(
                        "Conversation density",
                        density.to_string(),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let next = if this.settings.conversation_density
                                == omp_core::settings::ConversationDensity::Compact
                            {
                                "comfortable"
                            } else {
                                "compact"
                            };
                            this.update_setting(json!({ "conversationDensity": next }), cx);
                        },
                    ))
                    .child(self.settings_row(
                        "Enter sends",
                        enter.to_string(),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let next = if this.settings.message_enter_action
                                == omp_core::settings::MessageEnterAction::Steer
                            {
                                "queue"
                            } else {
                                "steer"
                            };
                            this.update_setting(json!({ "messageEnterAction": next }), cx);
                        },
                    ))
                    .child(self.settings_row(
                        "Idle session timeout",
                        format!("{} min", self.settings.idle_session_minutes),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let next = match this.settings.idle_session_minutes {
                                0 => 5,
                                5 => 15,
                                15 => 30,
                                _ => 0,
                            };
                            this.update_setting(json!({ "idleSessionMinutes": next }), cx);
                        },
                    ))
                    .into_any_element()
            }
            SettingsSection::Appearance => {
                let theme = match self.settings.theme {
                    omp_core::settings::Theme::System => "system",
                    omp_core::settings::Theme::Light => "light",
                    omp_core::settings::Theme::Dark => "dark",
                };
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(self.settings_row(
                        "Theme",
                        theme.to_string(),
                        colors,
                        cx,
                        |this, window, cx| {
                            let (next, mode) = match this.settings.theme {
                                omp_core::settings::Theme::System => ("light", ThemeMode::Light),
                                omp_core::settings::Theme::Light => ("dark", ThemeMode::Dark),
                                omp_core::settings::Theme::Dark => {
                                    ("system", ThemeMode::from(window.appearance()))
                                }
                            };
                            this.update_setting(json!({ "theme": next }), cx);
                            Theme::change(mode, Some(window), cx);
                            apply_electron_palette(cx, &this.settings.accent_color);
                        },
                    ))
                    .child(self.settings_row(
                        "Accent",
                        self.settings.accent_color.clone(),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let colors = ["prime", "blue", "teal", "green", "orange", "pink"];
                            let index = colors
                                .iter()
                                .position(|color| *color == this.settings.accent_color)
                                .unwrap_or(0);
                            let next = colors[(index + 1) % colors.len()];
                            this.update_setting(json!({ "accentColor": next }), cx);
                            apply_electron_palette(cx, &this.settings.accent_color);
                        },
                    ))
                    .child(self.settings_row(
                        "Interface font scale",
                        format!("{}%", self.settings.interface_font_scale),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let next = match this.settings.interface_font_scale {
                                105 => 110,
                                110 => 115,
                                _ => 105,
                            };
                            this.update_setting(json!({ "interfaceFontScale": next }), cx);
                        },
                    ))
                    .into_any_element()
            }
            SettingsSection::Agent => {
                let approval = match self.settings.omp_approval_mode {
                    omp_core::settings::OmpApprovalMode::Inherit => "Inherit",
                    omp_core::settings::OmpApprovalMode::AlwaysAsk => "Ask",
                    omp_core::settings::OmpApprovalMode::Write => "Write",
                    omp_core::settings::OmpApprovalMode::Yolo => "Yolo",
                };
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(self.settings_info_card(
                        "Harness",
                        self.settings.active_harness.clone(),
                        colors,
                    ))
                    .child(self.settings_row(
                        "Default effort",
                        self.settings.default_effort.clone(),
                        colors,
                        cx,
                        |this, _window, cx| this.cycle_effort(cx),
                    ))
                    .child(self.settings_row(
                        "Approval mode",
                        approval.to_string(),
                        colors,
                        cx,
                        |this, _window, cx| this.cycle_approval(cx),
                    ))
                    .child(self.settings_row(
                        "Show reasoning summaries",
                        if self.settings.show_reasoning_summaries {
                            "On"
                        } else {
                            "Off"
                        }
                        .to_string(),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let next = !this.settings.show_reasoning_summaries;
                            this.update_setting(json!({ "showReasoningSummaries": next }), cx);
                        },
                    ))
                    .child(self.settings_row(
                        "Show tool calls",
                        if self.settings.show_tool_calls {
                            "On"
                        } else {
                            "Off"
                        }
                        .to_string(),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let next = !this.settings.show_tool_calls;
                            this.update_setting(json!({ "showToolCalls": next }), cx);
                        },
                    ))
                    .child(self.settings_row(
                        "Reasoning expanded by default",
                        if self.settings.reasoning_expanded_by_default {
                            "On"
                        } else {
                            "Off"
                        }
                        .to_string(),
                        colors,
                        cx,
                        |this, _window, cx| {
                            let next = !this.settings.reasoning_expanded_by_default;
                            this.update_setting(
                                json!({ "reasoningExpandedByDefault": next }),
                                cx,
                            );
                        },
                    ))
                    .into_any_element()
            }
            SettingsSection::Session => div()
                .flex()
                .flex_col()
                .gap_3()
                .child(self.settings_row(
                    "Show file changes popup",
                    if self.settings.show_file_changes_popup {
                        "On"
                    } else {
                        "Off"
                    }
                    .to_string(),
                    colors,
                    cx,
                    |this, _window, cx| {
                        let next = !this.settings.show_file_changes_popup;
                        this.update_setting(json!({ "showFileChangesPopup": next }), cx);
                    },
                ))
                .child(self.settings_row(
                    "Keep running in background",
                    if self.settings.keep_running_in_background {
                        "On"
                    } else {
                        "Off"
                    }
                    .to_string(),
                    colors,
                    cx,
                    |this, _window, cx| {
                        let next = !this.settings.keep_running_in_background;
                        this.update_setting(json!({ "keepRunningInBackground": next }), cx);
                    },
                ))
                .child(self.settings_row(
                    "Launch at login",
                    if self.settings.launch_at_login {
                        "On"
                    } else {
                        "Off"
                    }
                    .to_string(),
                    colors,
                    cx,
                    |this, _window, cx| {
                        let next = !this.settings.launch_at_login;
                        this.update_setting(json!({ "launchAtLogin": next }), cx);
                    },
                ))
                .into_any_element(),
            SettingsSection::Providers => {
                let selected_model = self.settings.last_selected_model();
                let provider_filter = self.provider_filter.clone();
                let provider_list: Vec<ProviderChip> = self
                    .model_catalog
                    .as_ref()
                    .map(provider_chips)
                    .unwrap_or_default();
                let model_error = self.model_catalog_error();
                let model_loading = self.model_load_task.is_some();
                let model_status = self.model_status.clone();
                let model_rows: Vec<(String, String, bool)> = self
                    .model_catalog
                    .as_ref()
                    .map(|catalog| {
                        visible_models(
                            &catalog.models,
                            &selected_model,
                            provider_filter.as_deref(),
                        )
                        .into_iter()
                        .map(|model| {
                            let key = model_key(&model.provider, &model.id);
                            let selected = key == selected_model;
                            (key, model.name.clone(), selected)
                        })
                        .collect()
                    })
                    .unwrap_or_default();
                let model_elements: Vec<AnyElement> = model_rows
                    .into_iter()
                    .map(|(key, name, selected)| {
                        Self::model_row(key, name, selected, colors, cx)
                    })
                    .collect();
                let provider_row = (!provider_list.is_empty()).then(|| {
                    Self::provider_filter_row(
                        &provider_list,
                        provider_filter.as_deref(),
                        colors,
                        cx,
                    )
                });
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(Self::current_model_row(&selected_model, colors))
                    .when_some(provider_row, |element, row| element.child(row))
                    .when_some(model_error, |element, error| {
                        element.child(
                            div()
                                .px_3()
                                .py_2()
                                .rounded(px(8.0))
                                .border_1()
                                .border_color(colors.danger)
                                .text_xs()
                                .text_color(colors.danger)
                                .child(format!("Model catalog unavailable: {error}")),
                        )
                    })
                    .when(model_loading, |element| {
                        element.child(
                            div()
                                .px_3()
                                .py_2()
                                .text_xs()
                                .text_color(colors.muted_foreground)
                                .child("Loading models…"),
                        )
                    })
                    .when_some(model_status, |element, status| {
                        element.child(
                            div()
                                .px_3()
                                .py_2()
                                .text_xs()
                                .text_color(colors.danger)
                                .child(status),
                        )
                    })
                    .children(model_elements)
                    .into_any_element()
            }
            SettingsSection::Voice => div()
                .px_3()
                .py_2()
                .rounded(px(8.0))
                .border_1()
                .border_color(colors.border)
                .text_sm()
                .text_color(colors.muted_foreground)
                .child("Live voice is RPC-driven: the Live Voice pane sends live_start, live_stop, and live_mute to the OMP harness, which owns the microphone, audio, and transcription. Dictation works the same way: the composer's Dictate button sends dictation_start/dictation_stop and inserts the transcript the harness returns.")
                .into_any_element(),
            SettingsSection::Browser => div()
                .flex()
                .flex_col()
                .gap_3()
                .child(self.settings_info_card(
                    "Home page",
                    self.settings.browser_home.clone(),
                    colors,
                ))
                .child(self.settings_row(
                    "Ask before downloads",
                    if self.settings.browser_ask_for_downloads {
                        "On"
                    } else {
                        "Off"
                    }
                    .to_string(),
                    colors,
                    cx,
                    |this, _window, cx| {
                        let next = !this.settings.browser_ask_for_downloads;
                        this.update_setting(json!({ "browserAskForDownloads": next }), cx);
                    },
                ))
                .into_any_element(),
            SettingsSection::Privacy => div()
                .flex()
                .flex_col()
                .gap_3()
                .child(self.settings_info_card(
                    "Telemetry",
                    if self.settings.telemetry {
                        "Enabled"
                    } else {
                        "Disabled"
                    },
                    colors,
                ))
                .child(self.settings_info_card(
                    "Local data",
                    "Sessions and settings stay on this machine.",
                    colors,
                ))
                .into_any_element(),
            SettingsSection::About => div()
                .flex()
                .flex_col()
                .gap_3()
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
                .child(self.settings_row(
                    "Check for updates",
                    self.update_check.label(),
                    colors,
                    cx,
                    |this, _window, cx| this.start_update_check(cx),
                ))
                .into_any_element(),
        }
    }

    fn right_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let items = [
            (
                RightPane::Summary,
                "Summary",
                "rightPane.summary",
                IconName::FileText,
            ),
            (
                RightPane::Review,
                "Review",
                "rightPane.review",
                IconName::GitBranch,
            ),
            (
                RightPane::Files,
                "Files",
                "rightPane.files",
                IconName::Folder,
            ),
            (
                RightPane::Browser,
                "Browser",
                "rightPane.browser",
                IconName::Globe,
            ),
            (
                RightPane::SideQuestion,
                "Side Question",
                "rightPane.sideQuestion",
                IconName::MessageSquare,
            ),
            (
                RightPane::Subagents,
                "Subagents",
                "rightPane.subagents",
                IconName::Bot,
            ),
        ];
        let content = match self.right_pane {
            RightPane::Launcher => None,
            RightPane::Summary => Some(self.summary_content(cx).into_any_element()),
            RightPane::Review => Some(self.review_content(cx).into_any_element()),
            RightPane::Browser => Some(self.browser.content(cx).into_any_element()),
            RightPane::Files => Some(self.files_content(cx).into_any_element()),
            RightPane::Subagents => Some(self.subagents_content(cx).into_any_element()),
            RightPane::SideQuestion => Some(self.side_question_content(cx).into_any_element()),
            RightPane::Ask => Some(self.ask_content(cx).into_any_element()),
            RightPane::LiveVoice => Some(self.live_voice_content(cx).into_any_element()),
            RightPane::Activity => Some(self.activity_content(cx).into_any_element()),
        };
        let title = self.right_pane_title();
        div()
            .id("right-pane")
            .flex()
            .flex_col()
            .h_full()
            // A compact window always draws the pane over the transcript at
            // its preferred width, never at the docked column's resolved one.
            .w(px(if self.layout.right_pane_docked {
                self.layout.right_pane_width
            } else {
                omp_core::geometry::clamp_right_pane(self.geometry.right_pane_width)
            } as f32))
            .bg(colors.background)
            .border_l_1()
            .border_color(colors.border)
            .p_3()
            .gap_1()
            .when(self.right_pane == RightPane::Launcher, |element| {
                element.child(
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
                        .child(
                            div().flex_1().child(
                                Input::new(&self.right_pane_search)
                                    .appearance(false)
                                    .bordered(false)
                                    .aria_label(self.t("rightPane.searchPlaceholder")),
                            ),
                        )
                        .child(self.toolbar_icon(
                            "right-pane-menu",
                            IconName::EllipsisVertical,
                            colors.foreground,
                            cx.listener(|this, _, _, cx| {
                                this.menu_open = !this.menu_open;
                                cx.notify();
                            }),
                        )),
                )
            })
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
                                .child(self.t("rightPane.back"))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if this.right_pane == RightPane::Ask {
                                        // Backing out of a live dialog dismisses
                                        // it: the harness must not wait on a
                                        // question that is no longer shown.
                                        this.cancel_ask(cx);
                                    } else {
                                        this.right_pane = RightPane::Launcher;
                                        cx.notify();
                                    }
                                })),
                        )
                        .child(title),
                )
            })
            .children(content)
            .when(self.right_pane == RightPane::Launcher, |element| {
                element.children(items.into_iter().map(|(pane, label, key, icon)| {
                    let selected = self.right_pane == pane;
                    div()
                        .id(label)
                        .aria_label(label)
                        .flex()
                        .items_center()
                        .gap_2()
                        .min_h(px(32.0))
                        .px_2()
                        .rounded(px(6.0))
                        .text_sm()
                        .text_color(colors.foreground)
                        .when(selected, |element| element.bg(colors.accent))
                        .child(
                            div()
                                .text_size(px(16.0))
                                .text_color(colors.muted_foreground)
                                .child(icon),
                        )
                        .child(self.t(key))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.set_right_pane(pane.name(), cx);
                            // A launcher row is the only control that can build
                            // the webview, and it has the window to attach it to.
                            if pane == RightPane::Browser {
                                this.browser.ensure(window, cx);
                            }
                        }))
                }))
            })
            .child(div().h(px(1.0)).my_2().bg(colors.border))
            .child(
                div()
                    .id("activity")
                    .aria_label("Activity")
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .text_sm()
                    .text_color(colors.foreground)
                    .hover(|style| style.bg(colors.accent))
                    .child(IconName::Activity)
                    .child(self.t("rightPane.backgroundTasks"))
                    .child(div().flex_1())
                    .child(
                        div()
                            .px_2()
                            .rounded(px(999.0))
                            .bg(colors.accent)
                            .text_xs()
                            .child(self.attention_count.to_string()),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.set_right_pane("activity", cx);
                    })),
            )
            .test_support()
            .with_animation(
                format!("right-pane-{}", self.right_pane.name()),
                interaction::motion_spec(interaction::Motion::RightPane).animation(),
                |element, delta| {
                    element
                        .opacity(delta)
                        .relative()
                        .left(px(8.0 * (1.0 - delta)))
                },
            )
    }

    /// The compact layout's right pane, drawn over the transcript from the
    /// window's right edge. It is the same pane the wide layout docks, so the
    /// Details toggle, the toolbar's panel button and the launcher rows all
    /// reach one view; closing it only hides the overlay.
    fn details_overlay(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(
                div()
                    .id("details-scrim")
                    .test_support()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .bg(black().opacity(0.24))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.close_drawer(cx);
                        cx.stop_propagation();
                    }))
                    .with_animation(
                        "details-scrim",
                        interaction::motion_spec(interaction::Motion::DetailsOverlay).animation(),
                        |element, delta| element.opacity(delta),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .right_0()
                    .h_full()
                    .flex()
                    .w(px(
                        omp_core::geometry::clamp_right_pane(self.geometry.right_pane_width) as f32,
                    ))
                    .child(self.right_pane(cx))
                    .with_animation(
                        "details-overlay",
                        interaction::motion_spec(interaction::Motion::DetailsOverlay).animation(),
                        |element, delta| {
                            element
                                .opacity(delta)
                                .relative()
                                .left(px(8.0 * (1.0 - delta)))
                        },
                    ),
            )
    }

    fn sidebar_overlay(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(
                div()
                    .id("sidebar-scrim")
                    .test_support()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .bg(black().opacity(0.24))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.close_drawer(cx);
                        cx.stop_propagation();
                    })),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .h_full()
                    .child(self.sidebar(cx))
                    .with_animation(
                        "sidebar-overlay",
                        interaction::motion_spec(interaction::Motion::DetailsOverlay).animation(),
                        |element, delta| {
                            element
                                .opacity(delta)
                                .relative()
                                .right(px(8.0 * (1.0 - delta)))
                        },
                    ),
            )
    }

    fn files_content(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let mut list = div().flex().flex_col().gap_1();
        for (index, entry) in self.files.iter().take(200).enumerate() {
            let icon = if entry.kind == "directory" {
                IconName::Folder
            } else {
                IconName::FileText
            };
            list = list.child(
                div()
                    .id(format!("file-{index}"))
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .hover(|style| style.bg(colors.accent))
                    .child(icon)
                    .child(
                        div()
                            .text_sm()
                            .text_color(colors.foreground)
                            .child(entry.path.clone()),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child(entry.kind.clone()),
                    ),
            );
        }
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
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Files"),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("files-refresh")
                            .aria_label("Refresh files")
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .child("Refresh")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.refresh_files();
                                cx.notify();
                            })),
                    ),
            )
            .when(self.files_error.is_some(), |element| {
                element.child(
                    div()
                        .text_sm()
                        .text_color(colors.danger)
                        .child(self.files_error.clone().unwrap_or_default()),
                )
            })
            .when(
                self.files_error.is_none() && self.files.is_empty(),
                |element| {
                    element.child(
                        div()
                            .text_sm()
                            .text_color(colors.muted_foreground)
                            .child("No files found."),
                    )
                },
            )
            .child(list)
            .when(self.files_skipped > 0, |element| {
                element.child(
                    div()
                        .text_xs()
                        .text_color(colors.muted_foreground)
                        .child(format!("{} entries skipped.", self.files_skipped)),
                )
            })
    }

    fn subagents_content(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let agents = self.agents.list();
        let mut list = div().flex().flex_col().gap_1();
        for (index, agent) in agents.iter().enumerate() {
            let runtime_id = agent
                .get("runtimeId")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let cwd = agent
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let session = agent
                .get("sessionFile")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let stop_id = runtime_id.clone();
            list = list.child(
                div()
                    .id(format!("subagent-{index}"))
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .hover(|style| style.bg(colors.accent))
                    .child(IconName::Bot)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_0p5()
                            .text_sm()
                            .text_color(colors.foreground)
                            .child(runtime_id)
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(colors.muted_foreground)
                                    .child(cwd),
                            )
                            .when(!session.is_empty(), |element| {
                                element.child(
                                    div()
                                        .text_xs()
                                        .text_color(colors.muted_foreground)
                                        .child(session),
                                )
                            }),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id(format!("subagent-stop-{index}"))
                            .aria_label("Stop subagent")
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .child("Stop")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.agents.stop(&stop_id);
                                cx.notify();
                            })),
                    ),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child("Subagents"),
            )
            .when(agents.is_empty(), |element| {
                element.child(
                    div()
                        .text_sm()
                        .text_color(colors.muted_foreground)
                        .child("No background runtimes."),
                )
            })
            .child(list)
    }

    /// The Activity pane lists the persisted notifications newest first and
    /// clears them through the state file.
    fn activity_content(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let unread = self
            .notifications
            .iter()
            .filter(|notification| !notification.read)
            .count();
        let mut list = div().flex().flex_col().gap_1();
        for notification in self.notifications.iter().rev() {
            let read = notification.read;
            list = list.child(
                div()
                    .id(format!("notification-{}", notification.id))
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .px_2()
                    .py_1p5()
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.background)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(colors.foreground)
                                    .child(notification.title.clone()),
                            )
                            .child(div().flex_1())
                            .when(!read, |element| {
                                element.child(
                                    div().size(px(6.0)).rounded(px(999.0)).bg(colors.primary),
                                )
                            }),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child(notification.body.clone()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child(notification.created_at.clone()),
                    ),
            );
        }
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
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Activity"),
                    )
                    .child(
                        div()
                            .px_2()
                            .rounded(px(999.0))
                            .bg(colors.accent)
                            .text_xs()
                            .child(format!("{unread} unread")),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("clear-notifications")
                            .aria_label("Clear all")
                            .px_2()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_xs()
                            .text_color(colors.foreground)
                            .hover(|style| style.bg(colors.accent))
                            .child("Clear all")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.clear_notifications(cx);
                            })),
                    ),
            )
            .when(self.notifications.is_empty(), |element| {
                element.child(
                    div()
                        .text_sm()
                        .text_color(colors.muted_foreground)
                        .child("No activity yet."),
                )
            })
            .child(list)
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
                let selected = self.review_focus_path.as_deref() == Some(path.as_str());
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .when(selected, |element| element.bg(colors.accent))
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

    /// Ask pane: one card per question with its header, options (radio for
    /// single select, checkbox for multi), the recommended marker and a
    /// free-text field, plus the two ways to settle the dialog.
    ///
    /// The inputs themselves are created in `render`; a question whose input is
    /// not built yet simply draws without one for a frame.
    fn ask_content(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let Some(dialog) = self.ask_dialog.as_ref() else {
            return div()
                .flex()
                .flex_col()
                .flex_1()
                .gap_2()
                .p_2()
                .child(
                    div()
                        .text_sm()
                        .text_color(colors.muted_foreground)
                        .child("No ask request is waiting."),
                )
                .into_any_element();
        };
        let mut cards = div()
            .id("ask-questions")
            .flex()
            .flex_col()
            .flex_1()
            .gap_2()
            .overflow_y_scroll();
        for question in &dialog.questions {
            let selected = dialog
                .selected
                .get(&question.id)
                .cloned()
                .unwrap_or_default();
            let mut options = div().flex().flex_col().gap_1();
            for (index, option) in question.options.iter().enumerate() {
                let is_selected = selected.iter().any(|label| label == &option.label);
                let marker = match (question.multi, is_selected) {
                    (true, true) => "☑",
                    (true, false) => "☐",
                    (false, true) => "●",
                    (false, false) => "○",
                };
                let question_id = question.id.clone();
                let label = option.label.clone();
                let multi = question.multi;
                let mut row = div()
                    .id(SharedString::from(format!(
                        "ask-option-{}-{index}",
                        question.id
                    )))
                    .aria_label(option.label.clone())
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .hover(|style| style.bg(colors.accent))
                    .when(is_selected, |element| element.bg(colors.accent))
                    .child(div().text_sm().text_color(colors.foreground).child(marker))
                    .child(
                        div().flex().flex_col().flex_1().child(
                            div()
                                .text_sm()
                                .text_color(colors.foreground)
                                .child(option.label.clone()),
                        ),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.toggle_ask_option(&question_id, &label, multi, window, cx);
                    }));
                if question.recommended == Some(index) {
                    row = row.child(
                        div()
                            .px_2()
                            .rounded(px(999.0))
                            .bg(colors.accent)
                            .text_xs()
                            .text_color(colors.accent_foreground)
                            .child("Recommended"),
                    );
                }
                if let Some(description) = &option.description {
                    row = row.child(
                        div()
                            .text_xs()
                            .text_color(colors.muted_foreground)
                            .child(description.clone()),
                    );
                }
                options = options.child(row);
            }
            let mut card = div()
                .flex()
                .flex_col()
                .gap_1()
                .p_2()
                .rounded(px(8.0))
                .border_1()
                .border_color(colors.border)
                .bg(colors.background);
            if let Some(header) = &question.header {
                card = card.child(
                    div()
                        .text_xs()
                        .text_color(colors.muted_foreground)
                        .child(header.clone()),
                );
            }
            card = card.child(
                div()
                    .text_sm()
                    .text_color(colors.foreground)
                    .child(question.question.clone()),
            );
            card = card.child(options);
            if let Some(input) = self.ask_inputs.get(&question.id) {
                card = card.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(
                            div()
                                .text_xs()
                                .text_color(colors.muted_foreground)
                                .child("Your own answer"),
                        )
                        .child(Input::new(input)),
                );
            }
            cards = cards.child(card);
        }
        let mut footer = div().flex().items_center().gap_2();
        if let Some(error) = &dialog.error {
            footer = footer.child(
                div()
                    .flex_1()
                    .text_xs()
                    .text_color(colors.danger)
                    .child(error.clone()),
            );
        } else {
            footer = footer.child(div().flex_1());
        }
        footer = footer
            .child(
                div()
                    .id("ask-submit")
                    .aria_label("Submit answers")
                    .px_3()
                    .py_1()
                    .rounded(px(6.0))
                    .bg(colors.primary)
                    .text_color(colors.primary_foreground)
                    .text_sm()
                    .child("Submit")
                    .on_click(cx.listener(|this, _, _, cx| this.submit_ask(cx))),
            )
            .child(
                div()
                    .id("ask-cancel")
                    .aria_label("Cancel ask")
                    .px_3()
                    .py_1()
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(colors.border)
                    .text_sm()
                    .text_color(colors.foreground)
                    .child("Cancel")
                    .on_click(cx.listener(|this, _, _, cx| this.cancel_ask(cx))),
            );
        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap_2()
            .p_2()
            .child(
                div()
                    .text_sm()
                    .text_color(colors.foreground)
                    .child(dialog.title.clone()),
            )
            .child(cards)
            .child(footer)
            .into_any_element()
    }

    fn side_question_content(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let has_answer = !self.side_answer.is_empty();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap_2()
            .p_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().flex_1().child(Input::new(&self.side_input)))
                    .child(
                        div()
                            .id("side-question-ask")
                            .aria_label("Ask side question")
                            .px_3()
                            .py_1()
                            .rounded(px(6.0))
                            .bg(colors.primary)
                            .text_color(colors.primary_foreground)
                            .text_sm()
                            .child(self.t("rightPane.ask"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.ask_side_question(window, cx);
                            })),
                    ),
            )
            .when(self.side_streaming, |element| {
                element.child(
                    div()
                        .text_xs()
                        .text_color(colors.muted_foreground)
                        .child("Answering…"),
                )
            })
            .when(self.side_error.is_some(), |element| {
                element.child(
                    div()
                        .text_sm()
                        .text_color(colors.danger)
                        .child(self.side_error.clone().unwrap_or_default()),
                )
            })
            .when(has_answer, |element| {
                element.child(
                    div()
                        .id("side-question-answer")
                        .flex()
                        .flex_col()
                        .flex_1()
                        .overflow_y_scroll()
                        .p_2()
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(colors.border)
                        .bg(colors.background)
                        .text_sm()
                        .text_color(colors.foreground)
                        .child(self.side_answer.clone()),
                )
            })
            .when(
                !has_answer && !self.side_streaming && self.side_error.is_none(),
                |element| {
                    element.child(
                        div()
                            .text_sm()
                            .text_color(colors.muted_foreground)
                            .child("Ask a question without touching the main transcript."),
                    )
                },
            )
    }

    /// Live Voice pane: it only sends `live_*` commands and mirrors the events
    /// the harness reports. Audio capture lives in the harness, never here.
    fn live_voice_content(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let phase = if self.live_phase.is_empty() {
            "idle".to_string()
        } else {
            self.live_phase.clone()
        };
        let level = self.live_levels.clamp(0.0, 1.0);
        let level_width = (level * 160.0).round();
        let running = self.live_active;
        let can_start = self.runtime_id.is_some();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap_2()
            .p_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_sm()
                    .text_color(colors.foreground)
                    .child(IconName::Mic)
                    .child(self.t("rightPane.liveVoice"))
                    .child(div().flex_1())
                    .child(
                        div()
                            .px_2()
                            .rounded(px(999.0))
                            .bg(colors.accent)
                            .text_xs()
                            .text_color(colors.accent_foreground)
                            .child(phase),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .id("live-start")
                            .aria_label("Start live voice")
                            .px_3()
                            .py_1()
                            .rounded(px(6.0))
                            .bg(colors.primary)
                            .text_color(if can_start {
                                colors.primary_foreground
                            } else {
                                colors.muted_foreground
                            })
                            .text_sm()
                            .child("Start")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.start_live_voice(cx);
                            })),
                    )
                    .child(
                        div()
                            .id("live-stop")
                            .aria_label("Stop live voice")
                            .px_3()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_sm()
                            .text_color(colors.foreground)
                            .child("Stop")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.stop_live_voice(cx);
                            })),
                    )
                    .child(
                        div()
                            .id("live-mute")
                            .aria_label(if self.live_muted {
                                "Unmute live voice"
                            } else {
                                "Mute live voice"
                            })
                            .px_3()
                            .py_1()
                            .rounded(px(6.0))
                            .border_1()
                            .border_color(colors.border)
                            .text_sm()
                            .text_color(colors.foreground)
                            .child(if self.live_muted { "Unmute" } else { "Mute" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.toggle_live_voice_mute(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .id("live-level")
                    .h(px(6.0))
                    .w(px(160.0))
                    .rounded(px(999.0))
                    .bg(colors.accent)
                    .child(
                        div()
                            .h_full()
                            .w(px(level_width))
                            .rounded(px(999.0))
                            .bg(if self.live_muted {
                                colors.muted_foreground
                            } else {
                                colors.primary
                            }),
                    ),
            )
            .when(self.live_error.is_some(), |element| {
                element.child(
                    div()
                        .text_sm()
                        .text_color(colors.danger)
                        .child(self.live_error.clone().unwrap_or_default()),
                )
            })
            .when(!running && self.live_transcript.is_empty(), |element| {
                element.child(
                    div()
                        .text_sm()
                        .text_color(colors.muted_foreground)
                        .child("Start live voice to talk with OMP. The harness captures audio; this pane only sends commands and shows what it reports."),
                )
            })
            .child(
                div()
                    .id("live-transcript")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .gap_1()
                    .overflow_y_scroll()
                    .p_2()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.background)
                    .when(self.live_transcript.is_empty(), |element| {
                        element.child(
                            div()
                                .text_xs()
                                .text_color(colors.muted_foreground)
                                .child("No live transcript yet."),
                        )
                    })
                    .children(self.live_transcript.iter().map(|line| {
                        div()
                            .text_sm()
                            .text_color(colors.foreground)
                            .child(line.clone())
                    })),
            )
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

    /// Forks the selected session through the live harness and moves to the
    /// fork.
    ///
    /// The harness owns the fork: it copies the history into a new session
    /// file before it answers `{ cancelled }`. A cancelled fork is the user's
    /// own "no" and changes nothing. A successful one re-reads the catalog and
    /// selects its newest row, which is the file the harness just wrote; a
    /// fork that wrote nothing leaves the catalog unchanged, so the current
    /// selection, its transcript and the composer draft all stay put.
    fn fork_session(&mut self, cx: &mut Context<Self>) {
        self.request_fork(None, cx);
    }

    /// Forks the selected session at one transcript message.
    ///
    /// The harness copies the history up to `entry_id` into a new session file
    /// and answers `{ cancelled, entryId }`, so the fork continues from that
    /// message instead of the end of the session. Everything after the command
    /// is the whole-session fork's: the same banner, catalog refresh and
    /// selection, which makes a cancelled entry fork just as silent. A row the
    /// view minted itself has no harness entry to fork from, so its id is
    /// refused before anything reaches the runtime.
    pub fn fork_from_message(&mut self, entry_id: &str, cx: &mut Context<Self>) {
        if entry_id.is_empty() || is_local_transcript_row(entry_id) {
            return;
        }
        self.request_fork(Some(entry_id), cx);
    }

    fn request_fork(&mut self, entry_id: Option<&str>, cx: &mut Context<Self>) {
        let Some(runtime_id) = self.runtime_id.clone() else {
            self.fork_status = None;
            self.runtime_error =
                Some("OMP could not fork the session: no live session is selected.".to_string());
            cx.notify();
            return;
        };
        // A whole-session fork sends no `entryId`; an entry fork names the
        // message the new session continues from.
        let command = match entry_id {
            Some(entry_id) => json!({ "type": "fork", "entryId": entry_id }),
            None => json!({ "type": "fork" }),
        };
        let response = match self.agents.command(&runtime_id, &command) {
            Ok(response) => response,
            Err(error) => {
                self.fork_status = None;
                self.runtime_error =
                    Some(format!("OMP could not fork the session: {}", error.message));
                cx.notify();
                return;
            }
        };
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            let message = response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("OMP rejected the fork");
            self.fork_status = None;
            self.runtime_error = Some(format!("OMP could not fork the session: {message}"));
            cx.notify();
            return;
        }
        // Cancelled is the user's own "no": no file was written, so nothing
        // moves and no status is claimed.
        if response.pointer("/data/cancelled").and_then(Value::as_bool) == Some(true) {
            cx.notify();
            return;
        }
        self.runtime_error = None;
        self.fork_status = Some("Forked session".to_string());
        // The refresh is what finds the fork. The transcript is only cleared by
        // the selection below, so a fork that wrote no file keeps the view.
        let previous = self
            .selected_session
            .and_then(|index| self.sessions.get(index))
            .map(|session| session.file_path.clone());
        let before: Vec<String> = self
            .sessions
            .iter()
            .map(|session| session.file_path.clone())
            .collect();
        self.refresh_sessions();
        let after: Vec<String> = self
            .sessions
            .iter()
            .map(|session| session.file_path.clone())
            .collect();
        let newest = self
            .sessions
            .first()
            .map(|session| session.file_path.clone());
        if after != before && newest != previous {
            self.select_session(0, cx);
        } else {
            cx.notify();
        }
    }

    pub fn session_menu_action(&mut self, action: &str, cx: &mut Context<Self>) {
        // A fork needs neither a catalog write nor a selection index: the
        // harness owns the new session file and the runtime is the only thing
        // it talks to, so it is dispatched before the store-backed actions.
        if action == "Fork session" {
            self.menu_open = false;
            self.fork_session(cx);
            return;
        }
        let Some(index) = self.selected_session else {
            return;
        };
        let Some(store) = self.store.clone() else {
            return;
        };
        let file = self.sessions[index].file_path.clone();
        let id = self.sessions[index].id.clone();
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
                // The deleted session's shells cannot outlive it: stop the live
                // ones and drop the spec that would reopen them.
                self.terminal_specs.remove(&id);
                self.terminals.clear();
                self.terminal_tasks.clear();
                self.active_terminal = 0;
                self.selected_session = None;
                self.clear_transcript();
                self.clear_turn_state();
                // Nothing is selected any more, so nothing has a window to report.
                self.context_usage = None;
            }
            _ => {}
        }
        self.sessions = sessions::list_sessions(&store, &self.home_dir, false, None);
        self.refresh_attention();
        drop(store);
        self.menu_open = false;
        cx.notify();
    }

    fn overview_popover(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors;
        div()
            .absolute()
            .top(px(56.0))
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
                    ("Open File", "files"),
                    ("Browser", "browser"),
                    ("Side Question", "side-question"),
                    ("Subagents", "subagents"),
                ]
                .into_iter()
                .map(|(label, id)| {
                    div()
                        .id(id)
                        .aria_label(label)
                        .px_2()
                        .py_1()
                        .rounded(px(6.0))
                        .hover(|style| style.bg(colors.accent))
                        .child(label)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.set_right_pane(id, cx);
                            this.overview_open = false;
                            if id == "browser" {
                                this.browser.ensure(window, cx);
                            }
                            cx.notify();
                        }))
                }),
            )
            .child(div().h(px(1.0)).my_1().bg(colors.border))
            .child(
                div()
                    .id("background-tasks")
                    .aria_label("Background Tasks")
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .hover(|style| style.bg(colors.accent))
                    .child("Background Tasks")
                    .child(div().flex_1())
                    .child(
                        div()
                            .px_2()
                            .rounded(px(999.0))
                            .bg(colors.accent)
                            .text_xs()
                            .child(self.attention_count.to_string()),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.set_right_pane("activity", cx);
                        this.overview_open = false;
                        cx.notify();
                    })),
            )
            .with_animation(
                "overview-popover",
                interaction::motion_spec(interaction::Motion::OverviewPopover).animation(),
                |element, delta| {
                    element
                        .opacity(delta)
                        .relative()
                        .top(px(-5.0 * (1.0 - delta)))
                },
            )
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
            // The rows are the same list `debug_snapshot` reports, so the
            // harness can never assert an action the menu does not draw.
            .children(SESSION_MENU_ACTIONS.into_iter().map(|label| {
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
            }))
            .child(div().h(px(1.0)).my_1().bg(colors.border))
            .child(
                div()
                    .id("menu-copy-transcript")
                    .aria_label("Copy transcript")
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .hover(|style| style.bg(colors.accent))
                    .child("Copy transcript")
                    .on_click(cx.listener(|this, _, _, cx| this.copy_transcript(cx))),
            )
            .child(
                div()
                    .id("menu-capture-workspace")
                    .aria_label("Capture workspace")
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .hover(|style| style.bg(colors.accent))
                    .child("Capture workspace")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture_workspace(window, cx);
                    })),
            )
            .child(
                div()
                    .id("menu-terminal")
                    .aria_label("Terminal")
                    .px_2()
                    .py_1()
                    .rounded(px(6.0))
                    .hover(|style| style.bg(colors.accent))
                    .child(if self.terminal_open {
                        "Close terminal"
                    } else {
                        "Terminal"
                    })
                    .on_click(cx.listener(|this, _, _, cx| {
                        if this.terminal_open {
                            this.close_terminal(cx);
                        } else {
                            this.start_terminal(cx);
                        }
                    })),
            )
            .with_animation(
                "session-menu",
                interaction::motion_spec(interaction::Motion::SessionMenu).animation(),
                |element, delta| {
                    element
                        .opacity(delta)
                        .relative()
                        .top(px(-5.0 * (1.0 - delta)))
                },
            )
    }

    /// The close confirmation for whichever entry point asked, wired to this
    /// view's own `Close anyway` and `Cancel`.
    fn close_confirmation(&self, cx: &mut Context<Self>) -> impl IntoElement {
        close_confirmation(
            cx.theme().colors,
            cx.listener(|this, _: &ClickEvent, window, cx| this.confirm_close(window, cx)),
            cx.listener(|this, _: &ClickEvent, _, cx| this.cancel_close(cx)),
        )
    }
}

/// The tray's Quit command funnels through here, so quitting asks the same
/// question the window's close does.
///
/// Returns whether the caller may stop: quitting with no agent run is
/// immediate, while a live run leaves the app up with the confirmation overlay
/// and a later Quit asks again. The caller runs on the GPUI thread (the tray
/// forwards its menu events to it), so this only touches app state.
pub fn request_app_quit(app: &mut App) -> bool {
    let guard = app.try_global::<CloseGuard>().cloned().unwrap_or_default();
    if guard.approved() {
        // The user already answered this shutdown; a closed window has no
        // overlay left to draw, so the answer stands.
        app.quit();
        return true;
    }
    let Some(workspace) = guard.workspace() else {
        // No view to ask: quitting is all that is left.
        guard.approve();
        app.quit();
        return true;
    };
    workspace.update(app, |this, cx| this.request_close(CloseIntent::Quit, cx))
}

/// The confirmation's copy, shared by the renderer and the test that draws it
/// with no agent behind it.
const CLOSE_CONFIRM_TITLE: &str = "Close OMP Desktop while an agent is running?";
const CLOSE_CONFIRM_DETAIL: &str = "An agent run is still in progress and will be stopped.";
const CLOSE_CONFIRM_ACCEPT: &str = "Close anyway";
const CLOSE_CONFIRM_CANCEL: &str = "Cancel";

/// A confirmation button click: the caller already knows which button it drew,
/// so the handlers share the click listener shape `on_click` takes.
type CloseConfirmAction = dyn Fn(&ClickEvent, &mut Window, &mut App);

/// Draws the close confirmation over the whole window: a dimmed backdrop and a
/// centered card with `Cancel` and `Close anyway`.
///
/// The window's close and the tray's Quit both land here, so the app asks the
/// same question either way and only `Close anyway` lets the close through.
fn close_confirmation(
    colors: ThemeColor,
    on_accept: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_cancel: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_accept: Rc<CloseConfirmAction> = Rc::new(on_accept);
    let on_cancel: Rc<CloseConfirmAction> = Rc::new(on_cancel);
    div()
        .id("close-confirmation")
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(black().opacity(0.32))
        // A modal: the backdrop takes the clicks that miss the card, so the
        // view underneath cannot be driven while the question is open.
        .on_click(|_, _, _| {})
        .test_support()
        .with_animation(
            "close-confirmation-backdrop",
            interaction::motion_spec(interaction::Motion::ModalBackdrop).animation(),
            |element, delta| element.opacity(delta),
        )
        .child(
            div()
                .w(px(380.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(colors.border)
                .bg(colors.background)
                .p_4()
                .flex()
                .flex_col()
                .gap_3()
                .id("close-confirmation-card")
                .test_support()
                .with_animation(
                    "close-confirmation-card",
                    interaction::motion_spec(interaction::Motion::ModalCard).animation(),
                    |element, delta| {
                        element
                            .opacity(delta)
                            .relative()
                            .top(px(5.0 * (1.0 - delta)))
                    },
                )
                .child(div().text_base().child(CLOSE_CONFIRM_TITLE))
                .child(
                    div()
                        .text_sm()
                        .text_color(colors.muted_foreground)
                        .child(CLOSE_CONFIRM_DETAIL),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap_2()
                        .child(
                            div()
                                .id("close-confirmation-cancel")
                                .aria_label(CLOSE_CONFIRM_CANCEL)
                                .px_3()
                                .py_1()
                                .rounded(px(6.0))
                                .border_1()
                                .border_color(colors.border)
                                .text_sm()
                                .child(CLOSE_CONFIRM_CANCEL)
                                .hover(|style| style.bg(colors.accent))
                                .on_click({
                                    let on_cancel = on_cancel.clone();
                                    move |event, window, cx| on_cancel(event, window, cx)
                                }),
                        )
                        .child(
                            div()
                                .id("close-confirmation-accept")
                                .aria_label(CLOSE_CONFIRM_ACCEPT)
                                .px_3()
                                .py_1()
                                .rounded(px(6.0))
                                .bg(colors.danger)
                                .text_color(colors.primary_foreground)
                                .text_sm()
                                .child(CLOSE_CONFIRM_ACCEPT)
                                .on_click({
                                    let on_accept = on_accept.clone();
                                    move |event, window, cx| on_accept(event, window, cx)
                                }),
                        ),
                ),
        )
}

/// A tab bar click that names the tab it came from.
type TabClick = dyn Fn(usize, &mut Window, &mut App);
/// The tab bar's `+` click, which names no tab.
type NewTabClick = dyn Fn(&mut Window, &mut App);

/// One terminal header menu row's action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalMenuAction {
    Copy,
    Paste,
    SendSelection,
    Clear,
}

/// The terminal header menu's rows, in order: element id, label and action.
const TERMINAL_MENU_ITEMS: [(&str, &str, TerminalMenuAction); 4] = [
    (
        "terminal-menu-copy",
        "Copy screen",
        TerminalMenuAction::Copy,
    ),
    ("terminal-menu-paste", "Paste", TerminalMenuAction::Paste),
    (
        "terminal-menu-send-selection",
        "Send selection",
        TerminalMenuAction::SendSelection,
    ),
    ("terminal-menu-clear", "Clear", TerminalMenuAction::Clear),
];

/// The action a menu row's element id names; an unknown id runs nothing.
fn terminal_menu_action(id: &str) -> Option<TerminalMenuAction> {
    TERMINAL_MENU_ITEMS
        .iter()
        .find(|(row_id, _, _)| *row_id == id)
        .map(|(_, _, action)| *action)
}

/// A menu row click that names the row it came from.
type TerminalMenuPick = dyn Fn(&'static str, &mut Window, &mut App);

/// Draws the terminal header's menu: copy the screen, paste into the input
/// line, quote the selection into the composer, or clear the screen. It is
/// anchored to the panel, which is relative, and the caller owns both the open
/// flag and the actions.
fn terminal_menu(
    colors: ThemeColor,
    on_pick: impl Fn(&'static str, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_pick: Rc<TerminalMenuPick> = Rc::new(on_pick);
    div()
        .id("terminal-menu-popup")
        .absolute()
        .top(px(28.0))
        .right(px(12.0))
        .w(px(170.0))
        .flex()
        .flex_col()
        .gap_1()
        .p_2()
        .rounded(px(8.0))
        .border_1()
        .border_color(colors.border)
        .bg(colors.sidebar)
        .text_sm()
        .children(TERMINAL_MENU_ITEMS.into_iter().map(|(id, label, _)| {
            let on_pick = Rc::clone(&on_pick);
            div()
                .id(id)
                .aria_label(label)
                .px_2()
                .py_1()
                .rounded(px(6.0))
                .hover(|style| style.bg(colors.accent))
                .child(label)
                .on_click(move |_, window, cx| on_pick(id, window, cx))
        }))
}

/// Appends pasted text to the terminal input line.
///
/// The input holds one line and submits on Enter, so the trailing newline most
/// clipboards carry is dropped and inner line breaks become spaces: one paste
/// stays one command instead of submitting the first of several lines.
fn append_clipboard_text(current: &str, clipboard: &str) -> String {
    let text = clipboard.trim_end_matches(['\r', '\n']);
    if text.is_empty() {
        return current.to_string();
    }
    let mut next = String::with_capacity(current.len() + text.len());
    next.push_str(current);
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            next.push(' ');
        }
        next.push_str(line.trim_end_matches('\r'));
    }
    next
}

/// The text `Send selection` inserts: the quoted row after its label.
///
/// The composer is a single-line prompt, so the quote stays on one line; the
/// label is what keeps it readable next to the user's own draft.
fn terminal_selection_text_block(selection: &str) -> String {
    format!("{TERMINAL_SELECTION_LABEL} {selection}")
}

/// Appends `text` to `draft`, separated by one space.
///
/// The composer holds a single line, so a newline separator would be stripped
/// by the input itself; a space keeps the inserted text apart from the draft
/// without rewriting it.
fn append_composer_text(draft: &str, text: &str) -> String {
    if draft.is_empty() || draft.ends_with(char::is_whitespace) {
        format!("{draft}{text}")
    } else {
        format!("{draft} {text}")
    }
}

/// How close to the transcript's bottom edge still counts as pinned: a few
/// lines of slack, so a rounding gap or a partially scrolled row does not
/// unpin the auto-follow.
const TRANSCRIPT_BOTTOM_THRESHOLD: f32 = 24.0;

/// How often the watcher looks at the selected session file. It is one `stat`,
/// so a two-second tick costs nothing while the file is quiet.
const TRANSCRIPT_WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// The state of the session file the transcript was read from: its length and
/// modified time. Both are compared, because a filesystem whose modified time
/// only moves once a second still reports an append as a longer file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TranscriptStamp {
    len: u64,
    modified: Option<SystemTime>,
}

impl TranscriptStamp {
    /// The modified time in milliseconds since the epoch, for the snapshot.
    fn modified_millis(self) -> Option<u64> {
        self.modified
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
    }
}

/// Reads the file state a change check compares against, or `None` when the
/// file cannot be inspected at all.
fn transcript_stamp(path: &Path) -> Option<TranscriptStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(TranscriptStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

/// Whether a row was minted by the view instead of read from the session file:
/// a queued follow-up trace, a prompt or reply still streaming, or a compaction
/// notice that arrived as an event before the file had it.
fn is_local_transcript_row(id: &str) -> bool {
    ["queued-", "user-", "assistant-", "compaction-"]
        .iter()
        .any(|prefix| id.starts_with(prefix))
}

fn tool_icon(name: &str) -> IconName {
    let lower = name.to_lowercase();
    if lower.contains("bash") || lower.contains("shell") || lower.contains("terminal") {
        IconName::Terminal
    } else if lower.contains("git") {
        IconName::GitBranch
    } else if lower.contains("todo") || lower.contains("plan") {
        IconName::ListTodo
    } else if lower.contains("ask") || lower.contains("question") {
        IconName::MessageCircleQuestionMark
    } else if lower.contains("read")
        || lower.contains("write")
        || lower.contains("edit")
        || lower.contains("file")
    {
        IconName::FileCode
    } else if lower.contains("web") || lower.contains("browser") || lower.contains("fetch") {
        IconName::Globe
    } else {
        IconName::Wrench
    }
}

/// Whether a row can be forked from: it carries an id the harness wrote, so
/// `fork` has an entry to continue at. A view-minted row has none, and a row
/// whose parts are all compaction is the harness's own summarisation rather
/// than a message the reader can branch on.
fn forkable_transcript_row(message: &TranscriptMessage) -> bool {
    !message.id.is_empty()
        && !is_local_transcript_row(&message.id)
        && !message.parts.iter().all(|part| part.kind == "compaction")
}

/// The visible text of a row, used to recognise a row the file already holds
/// under the harness's own id.
fn transcript_row_text(message: &TranscriptMessage) -> String {
    message
        .parts
        .iter()
        .filter_map(|part| part.text.as_deref())
        .collect()
}

/// Whether a scroll area sits at its bottom edge.
///
/// `offset` is the scroll offset gpui reports, which grows more negative as
/// the content scrolls up, and `max_offset` is the positive distance the
/// content can scroll, so `max_offset + offset` is the gap left below the
/// viewport: zero at the bottom and growing as the reader scrolls up.
/// `viewport` is the scroll area's height; before its first layout it is zero,
/// and a view with nothing to scroll has no bottom to be away from, so both
/// count as at the bottom.
fn transcript_is_at_bottom(offset: f32, max_offset: f32, viewport: f32, threshold: f32) -> bool {
    if viewport <= 0.0 || max_offset <= 0.0 {
        return true;
    }
    max_offset + offset <= threshold
}

/// The transcript's name for a message's author: the two known roles are
/// relabelled, an agent carries its own name, and anything else keeps its role.
fn transcript_role_label(message: &TranscriptMessage) -> String {
    match message.role.as_str() {
        "user" => "You".to_string(),
        "assistant" => "OMP".to_string(),
        "agent" => message
            .agent_name
            .clone()
            .unwrap_or_else(|| "Agent".to_string()),
        other => other.to_string(),
    }
}

/// One task in the harness's `todo` tool result.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TodoTask {
    content: String,
    status: TodoStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

/// One phase of the plan, in the order the harness printed it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TodoPhase {
    name: String,
    tasks: Vec<TodoTask>,
}

/// Parses the phase blocks of a `todo` tool result.
///
/// The harness prints a human-readable summary first and the structured phase
/// blocks at the tail. Only the tail is authoritative; an unrecognized format
/// yields no phases so the plain tool row stays visible instead of a guessed
/// plan.
fn parse_todo_tool_result(text: &str) -> Vec<TodoPhase> {
    let mut phases: Vec<TodoPhase> = Vec::new();
    let mut current: Option<usize> = None;
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if !line.starts_with("    ")
            && let Some(name) = line
                .strip_prefix("  ")
                .and_then(|line| line.strip_suffix(':'))
        {
            phases.push(TodoPhase {
                name: name.trim().to_string(),
                tasks: Vec::new(),
            });
            current = Some(phases.len() - 1);
            continue;
        }
        let Some(task) = line.strip_prefix("    - [") else {
            continue;
        };
        let Some((mark, rest)) = task.split_at_checked(1) else {
            continue;
        };
        let Some(rest) = rest.strip_prefix("] ") else {
            continue;
        };
        let raw_content = rest.trim();
        let in_progress = raw_content.ends_with("(in progress)");
        let content = raw_content
            .strip_suffix("(in progress)")
            .unwrap_or(raw_content)
            .trim()
            .to_string();
        let status = match mark {
            "X" | "x" => TodoStatus::Completed,
            _ if in_progress => TodoStatus::InProgress,
            _ => TodoStatus::Pending,
        };
        if let Some(index) = current {
            phases[index].tasks.push(TodoTask { content, status });
        }
    }
    phases.retain(|phase| !phase.tasks.is_empty());
    phases
}

/// The newest plan in the transcript: the last `todo` tool result with a
/// parseable phase block wins, so a later update replaces the previous plan.
fn latest_todo_phases(messages: &[TranscriptMessage]) -> Vec<TodoPhase> {
    for message in messages.iter().rev() {
        for part in &message.parts {
            if part.kind == "toolResult" && part.name.as_deref() == Some("todo") {
                let phases = parse_todo_tool_result(part.text.as_deref().unwrap_or(""));
                if !phases.is_empty() {
                    return phases;
                }
            }
        }
    }
    Vec::new()
}

/// The text the transcript draws for one part: text and thinking as written,
/// tool calls and results with their glyphs, compaction as its token counts.
fn transcript_part_text(part: &TranscriptPart) -> String {
    match part.kind.as_str() {
        "text" | "thinking" => part.text.clone().unwrap_or_default(),
        // A follow-up waiting behind the running turn: the harness owns the
        // real user message, so this row only shows what was queued.
        "queued" => format!("Queued: {}", part.text.clone().unwrap_or_default()),
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
    }
}

/// One run of a transcript part: plain prose, or the body of a `$…$` or
/// `$$…$$` span with its delimiters stripped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MathSegmentKind {
    Text,
    InlineMath,
    DisplayMath,
}

/// A run of transcript text and what kind of run it is. Math segments keep the
/// source between the delimiters, so nothing is reinterpreted: this renderer
/// marks math readable, it does not lay TeX out.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MathSegment {
    kind: MathSegmentKind,
    text: String,
}

/// Splits transcript text into plain runs and math runs.
///
/// `$$…$$` wins over `$…$`, a `\$` neither opens nor closes a span, and a
/// marker with no closer stays plain text. Text with no math comes back as one
/// `Text` segment holding the original string, so the split never rewrites a
/// message.
fn math_segments(text: &str) -> Vec<MathSegment> {
    let mut segments: Vec<MathSegment> = Vec::new();
    let mut plain_start = 0;
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        let Some(current) = rest.chars().next() else {
            break;
        };
        if current == '\\' {
            // `\$` is a literal dollar sign: step over both bytes so it cannot
            // open or close a span. Any other backslash is ordinary text.
            index += current.len_utf8();
            if rest[current.len_utf8()..].starts_with('$') {
                index += 1;
            }
            continue;
        }
        if current != '$' {
            index += current.len_utf8();
            continue;
        }
        let display = rest.starts_with("$$");
        let open = if display { "$$" } else { "$" };
        let body_start = index + open.len();
        match math_close(&text[body_start..], display) {
            // An empty body is not math either: `$$` on its own stays text.
            Some(close) if close > 0 => {
                push_plain_segment(&mut segments, &text[plain_start..index]);
                segments.push(MathSegment {
                    kind: if display {
                        MathSegmentKind::DisplayMath
                    } else {
                        MathSegmentKind::InlineMath
                    },
                    text: text[body_start..body_start + close].to_string(),
                });
                index = body_start + close + open.len();
                plain_start = index;
            }
            // Unmatched: the marker is skipped but stays in the plain run.
            _ => index = body_start,
        }
    }
    push_plain_segment(&mut segments, &text[plain_start..]);
    segments
}

/// The byte offset of the delimiter that closes a math body, if there is one.
///
/// An escaped `\$` inside the body closes nothing. An inline body ends at the
/// first `$`; a display body ends only at `$$`.
fn math_close(body: &str, display: bool) -> Option<usize> {
    let mut index = 0;
    while index < body.len() {
        let rest = &body[index..];
        let current = rest.chars().next()?;
        if current == '\\' {
            index += current.len_utf8();
            if rest[current.len_utf8()..].starts_with('$') {
                index += 1;
            }
            continue;
        }
        if current == '$' && (!display || rest.starts_with("$$")) {
            return Some(index);
        }
        index += current.len_utf8();
    }
    None
}

/// Appends `text` as a plain run, skipping the empty runs a split leaves at the
/// edges of a part that opens or closes with math.
fn push_plain_segment(segments: &mut Vec<MathSegment>, text: &str) {
    if !text.is_empty() {
        segments.push(MathSegment {
            kind: MathSegmentKind::Text,
            text: text.to_string(),
        });
    }
}

/// The text a split came from: every run with its delimiters back, so the
/// transcript's copy output stays the message as written.
fn math_plain_text(segments: &[MathSegment]) -> String {
    let mut text = String::new();
    for segment in segments {
        match segment.kind {
            MathSegmentKind::Text => text.push_str(&segment.text),
            MathSegmentKind::InlineMath => {
                text.push('$');
                text.push_str(&segment.text);
                text.push('$');
            }
            MathSegmentKind::DisplayMath => {
                text.push_str("$$");
                text.push_str(&segment.text);
                text.push_str("$$");
            }
        }
    }
    text
}

/// How many math runs a part draws. `debug_snapshot` reports it so a scenario
/// can prove the styled spans exist without measuring pixels.
fn transcript_math_segments(part: &TranscriptPart) -> usize {
    math_segments(&transcript_part_text(part))
        .iter()
        .filter(|segment| segment.kind != MathSegmentKind::Text)
        .count()
}

/// One math run as the reader sees it: the raw source in an italic chip, tinted
/// and outlined so it reads as math rather than prose. The chip inherits the
/// part's text color, so a queued row stays muted.
fn math_span(segment: &MathSegment, colors: ThemeColor) -> AnyElement {
    let chip = div()
        .italic()
        .rounded(px(4.0))
        .px_1()
        .border_1()
        .border_color(colors.border)
        .bg(colors.accent)
        .child(math_plain_text(std::slice::from_ref(segment)));
    match segment.kind {
        // Display math takes its own centred line; inline math flows with the
        // words around it.
        MathSegmentKind::DisplayMath => chip.w_full().text_center().into_any_element(),
        MathSegmentKind::InlineMath | MathSegmentKind::Text => chip.into_any_element(),
    }
}

/// Draws one transcript part. A part with no math is the single text run it
/// always was; a part with math is wrapped spans, its prose untouched and each
/// math run in its own chip. Only the drawing splits, so `Copy transcript`
/// still yields the message as written.
fn transcript_part_element(part: &TranscriptPart, role: &str, colors: ThemeColor) -> AnyElement {
    match part.kind.as_str() {
        "text" => {
            let text = part.text.clone().unwrap_or_default();
            if text.is_empty() {
                return div().into_any_element();
            }
            if role == "tool" {
                return div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .w_full()
                    .child(
                        div()
                            .id("tool-message-scroll")
                            .max_h(px(220.0))
                            .overflow_y_scroll()
                            .rounded(px(8.0))
                            .border_1()
                            .border_color(colors.border)
                            .bg(colors.tab)
                            .p_2()
                            .font_family("Menlo")
                            .text_size(px(11.5))
                            .text_color(colors.muted_foreground)
                            .child(text),
                    )
                    .into_any_element();
            }
            let size = if role == "user" { 13.0 } else { 14.0 };
            if role == "assistant" {
                return markdown::render_markdown(&text, colors, |text, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(text.to_string()));
                });
            }
            let segments = math_segments(&text);
            if segments
                .iter()
                .all(|segment| segment.kind == MathSegmentKind::Text)
            {
                return div()
                    .text_size(px(size))
                    .text_color(colors.foreground)
                    .child(text)
                    .into_any_element();
            }
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .text_size(px(size))
                .text_color(colors.foreground)
                .children(
                    segments
                        .into_iter()
                        .filter(|segment| !segment.text.is_empty())
                        .map(|segment| match segment.kind {
                            MathSegmentKind::Text => div().child(segment.text).into_any_element(),
                            MathSegmentKind::InlineMath | MathSegmentKind::DisplayMath => {
                                math_span(&segment, colors)
                            }
                        }),
                )
                .into_any_element()
        }
        "thinking" => div()
            .flex()
            .flex_col()
            .gap_1()
            .w_full()
            .p_2()
            .rounded(px(8.0))
            .bg(colors.tab)
            .child(
                div()
                    .text_size(px(10.5))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(colors.muted_foreground)
                    .child("Thinking"),
            )
            .child(
                div()
                    .text_size(px(12.5))
                    .text_color(colors.muted_foreground)
                    .child(part.text.clone().unwrap_or_default()),
            )
            .into_any_element(),
        "toolCall" => {
            let name = part.name.clone().unwrap_or_else(|| "tool".to_string());
            let command = part
                .args
                .as_ref()
                .and_then(|args| {
                    args.get("command")
                        .or_else(|| args.get("cmd"))
                        .or_else(|| args.get("description"))
                })
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            div()
                .flex()
                .items_center()
                .gap_2()
                .w_full()
                .min_h(px(30.0))
                .py(px(3.0))
                .text_size(px(13.0))
                .text_color(colors.muted_foreground)
                .child(
                    div()
                        .size(px(16.0))
                        .text_color(colors.muted_foreground)
                        .child(tool_icon(&name)),
                )
                .child(
                    div()
                        .text_color(colors.foreground)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(name),
                )
                .when(!command.is_empty(), |element| {
                    element.child(
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(format!("· {command}")),
                    )
                })
                .child(div().flex_1())
                .when_some(part.status.clone(), |element, status| {
                    element.child(
                        div()
                            .text_size(px(10.0))
                            .text_color(colors.muted_foreground)
                            .child(status),
                    )
                })
                .into_any_element()
        }
        "toolResult" => {
            let text = part.text.clone().unwrap_or_default();
            let color = if part.is_error == Some(true) {
                colors.danger
            } else {
                colors.muted_foreground
            };
            div()
                .flex()
                .flex_col()
                .gap_1()
                .w_full()
                .child(
                    div()
                        .id("tool-result-scroll")
                        .max_h(px(260.0))
                        .overflow_y_scroll()
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(colors.border)
                        .bg(colors.background)
                        .p_2()
                        .font_family("Menlo")
                        .text_size(px(11.5))
                        .text_color(color)
                        .child(text),
                )
                .into_any_element()
        }
        "compaction" => div()
            .flex()
            .items_center()
            .gap_2()
            .w_full()
            .py_1()
            .child(div().h(px(1.0)).flex_1().bg(colors.border))
            .child(
                div()
                    .text_size(px(10.5))
                    .text_color(colors.muted_foreground)
                    .child(format!(
                        "Context compacted · {} → {} tokens",
                        part.tokens_before.unwrap_or(0),
                        part.tokens_after.unwrap_or(0)
                    )),
            )
            .child(div().h(px(1.0)).flex_1().bg(colors.border))
            .into_any_element(),
        "queued" => div()
            .text_size(px(12.0))
            .text_color(colors.muted_foreground)
            .child(format!("Queued: {}", part.text.clone().unwrap_or_default()))
            .into_any_element(),
        "image" => div()
            .px_2()
            .py_1()
            .rounded(px(6.0))
            .border_1()
            .border_color(colors.border)
            .text_size(px(11.5))
            .text_color(colors.muted_foreground)
            .child("[image]")
            .into_any_element(),
        other => div()
            .text_size(px(13.0))
            .text_color(colors.muted_foreground)
            .child(format!("[{other}]"))
            .into_any_element(),
    }
}

/// The folder under the user data directory that captures land in.
const CAPTURE_DIR: &str = "captures";

/// Where a capture taken at `at` is written: `<user_data_dir>/captures/omp-<stamp>.png`.
///
/// The stamp is UTC to the millisecond and carries no separators, so the name is
/// valid on every desktop platform and sorts chronologically.
fn capture_path(user_data_dir: &Path, at: DateTime<Utc>) -> PathBuf {
    user_data_dir
        .join(CAPTURE_DIR)
        .join(format!("omp-{}.png", at.format("%Y%m%dT%H%M%S%3f")))
}

/// Writes a rendered frame to `capture_path`, creating the captures folder.
///
/// The error is the message the status row shows: the caller never panics over
/// a full disk or a read-only user data directory.
fn write_capture(
    user_data_dir: &Path,
    at: DateTime<Utc>,
    frame: &image::RgbaImage,
) -> Result<PathBuf, String> {
    let path = capture_path(user_data_dir, at);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("Capture failed: {error}"))?;
    }
    frame
        .save(&path)
        .map_err(|error| format!("Capture failed: {error}"))?;
    Ok(path)
}

/// The plain text `Copy transcript` puts on the clipboard: one block per
/// message, its author line followed by the parts the transcript shows, with a
/// blank line between blocks. A message with no visible part text contributes
/// nothing, so an empty transcript yields an empty string and copying no-ops.
fn transcript_clipboard_text(messages: &[TranscriptMessage]) -> String {
    let mut blocks: Vec<String> = Vec::new();
    for message in messages {
        let mut lines = vec![transcript_role_label(message)];
        lines.extend(
            message
                .parts
                .iter()
                .map(transcript_part_text)
                .filter(|text| !text.is_empty()),
        );
        if lines.len() > 1 {
            blocks.push(lines.join("\n"));
        }
    }
    blocks.join("\n\n")
}

/// Draws the terminal panel's tab bar: one tab per shell, then a `+` button.
///
/// Labels and callbacks are all it reads, so a test can render it without a
/// live shell: selecting, closing and opening tabs are the caller's jobs.
fn terminal_tab_bar(
    labels: &[String],
    active: usize,
    colors: ThemeColor,
    on_select: impl Fn(usize, &mut Window, &mut App) + 'static,
    on_close: impl Fn(usize, &mut Window, &mut App) + 'static,
    on_new: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_select: Rc<TabClick> = Rc::new(on_select);
    let on_close: Rc<TabClick> = Rc::new(on_close);
    let on_new: Rc<NewTabClick> = Rc::new(on_new);
    div()
        .id("terminal-tabs")
        .flex()
        .items_center()
        .gap_1()
        .px_3()
        .pb_1()
        .children(labels.iter().enumerate().map(|(index, label)| {
            let is_active = index == active;
            let select = Rc::clone(&on_select);
            let close = Rc::clone(&on_close);
            div()
                .id(("terminal-tab", index))
                .aria_label("Terminal tab")
                .flex()
                .items_center()
                .gap_1()
                .px_2()
                .py_1()
                .rounded(px(6.0))
                .text_xs()
                .text_color(if is_active {
                    colors.foreground
                } else {
                    colors.muted_foreground
                })
                .when(is_active, |style| style.bg(colors.accent))
                .hover(|style| style.bg(colors.accent))
                .child(label.clone())
                .child(
                    div()
                        .id(("terminal-tab-close", index))
                        .aria_label("Close tab")
                        .rounded(px(4.0))
                        .hover(|style| style.bg(colors.background))
                        .child(IconName::X)
                        .on_click(move |_, window, cx| {
                            close(index, window, cx);
                            // The tab under the button would otherwise also be
                            // selected, moving the active tab as it closes.
                            cx.stop_propagation();
                        }),
                )
                .on_click(move |_, window, cx| select(index, window, cx))
        }))
        .child(
            div()
                .id("terminal-new-tab")
                .aria_label("New terminal tab")
                .px_2()
                .py_1()
                .rounded(px(6.0))
                .text_xs()
                .text_color(colors.muted_foreground)
                .hover(|style| style.bg(colors.accent))
                .child("+")
                .on_click(move |_, window, cx| on_new(window, cx)),
        )
}

/// Whether a session's recorded cwd sits inside one of a project's folders.
///
/// Session files keep the cwd exactly as the harness saw it, which can differ
/// from the granted folder by a symlink (`/var` versus `/private/var`), so both
/// sides are canonicalized before the prefix check.
fn session_in_folders(folders: &[String], project_path: &str) -> bool {
    let path =
        omp_core::paths::canonicalize(project_path).unwrap_or_else(|_| PathBuf::from(project_path));
    folders.iter().any(|folder| {
        let root = omp_core::paths::canonicalize(folder).unwrap_or_else(|_| PathBuf::from(folder));
        projects::path_within(&root, &path)
    })
}

/// Whether a session row is hidden from the sidebar catalog.
///
/// A session disappears once its folder is dismissed — the project it belonged
/// to was removed — unless a grant still covers it: a removed parent folder must
/// not hide the sessions of a project granted inside it later.
fn session_hidden(dismissed: &[String], granted: &[String], project_path: &str) -> bool {
    session_in_folders(dismissed, project_path) && !session_in_folders(granted, project_path)
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // InputState's live setter needs a window, so settings changes reach
        // existing placeholders here. Unchanged values avoid a notify loop.
        self.sync_localized_inputs(window, cx);
        // The guard is `main`'s and the tray's view of "an agent is live"; this
        // view owns the truth, so every frame mirrors it and the confirmation
        // below only exists while a close is being asked about.
        self.sync_close_guard();
        if window.focused(cx).is_none() {
            let focus = self.workspace_focus.clone();
            window.focus(&focus, cx);
        }
        self.poll_composition(window, cx);
        if self.ime_guard.blocks_commit_key(Instant::now()) {
            self.submit_requested = None;
            self.side_submit_requested = false;
            self.terminal_submit_requested = false;
            self.plugin_submit_requested = false;
            let _ = self.browser.take_navigate_request();
        }
        if self.plugin_submit_requested {
            self.plugin_submit_requested = false;
            self.submit_plugin_install(cx);
        }
        let close_prompt = self.close_prompt.is_some();
        if let Some(follow_up) = self.submit_requested.take() {
            cx.defer_in(window, move |this, window, cx| {
                this.send_prompt_with_action(window, cx, follow_up);
            });
        }
        if self.side_submit_requested {
            self.side_submit_requested = false;
            cx.defer_in(window, |this, window, cx| {
                this.ask_side_question(window, cx);
            });
        }
        if self.terminal_submit_requested {
            self.terminal_submit_requested = false;
            cx.defer_in(window, |this, window, cx| {
                this.send_terminal_line(window, cx);
            });
        }
        // The Browser pane's picker hands its annotation over here, where a window is
        // available to edit the composer; an existing draft is kept and appended to.
        if let Some(annotation) = self.browser.take_annotation() {
            cx.defer_in(window, move |this, window, cx| {
                let composer = this.composer.clone();
                composer.update(cx, |state, cx| {
                    let next = browser::append_annotation(&state.value(), &annotation);
                    state.set_value(next, window, cx);
                });
                cx.notify();
            });
        }
        // A finished dictation parks its text here because `render` is the only
        // place with a window to write into the composer. `take` makes the
        // insert happen once: the stop response is never applied as well.
        if let Some(text) = self.dictation_pending_text.take() {
            // The preview's job is done once its text is in the composer.
            self.dictation_preview.clear();
            cx.defer_in(window, move |this, window, cx| {
                let composer = this.composer.clone();
                composer.update(cx, |state, cx| {
                    let next = append_dictation_text(&state.value(), &text);
                    state.set_value(next, window, cx);
                });
                cx.notify();
            });
        }
        // The Ask pane's free-text fields are entities, and only a window can
        // build one, so they are created here before the pane draws.
        if self.right_pane == RightPane::Ask {
            self.ensure_ask_inputs(window, cx);
        }
        self.track_bounds(window, cx);
        if let Some(palette) = &self.command_palette {
            let focus = palette.input.read(cx).focus_handle(cx);
            if window.focused(cx).as_ref() != Some(&focus) {
                window.focus(&focus, cx);
            }
        }
        let colors = cx.theme().colors;
        let show_sidebar = self.layout.sidebar_docked;
        let show_right = self.layout.right_pane_docked;
        let show_details = self.active_drawer == Some(CollapsedPane::RightPane);
        let show_sidebar_overlay = self.active_drawer == Some(CollapsedPane::Sidebar);
        // A native webview keeps its last frame when the pane stops rendering, and on Windows
        // it covers everything in its bounds, so it is shown only while the pane is on screen
        // and no confirmation is covering it.
        let browser_visible = self.browser_is_visible();
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
            // The view can also be set without `set_view` (startup restore,
            // tests), so the first Settings frame is the other place the
            // catalog is needed; `ensure_models` caches, so this is a no-op
            // once a load is in flight or cached.
            self.ensure_models(cx);
            return div()
                .relative()
                .track_focus(&self.workspace_focus)
                .on_key_down(cx.listener(|this, event, window, cx| {
                    this.handle_workspace_key(event, window, cx);
                }))
                .flex()
                .flex_row()
                .size_full()
                .bg(colors.background)
                .text_color(colors.foreground)
                .when(show_sidebar, |element| element.child(self.sidebar(cx)))
                // A pinned overview keeps the launcher on screen while another
                // view is active; unpinned, the page stands alone.
                .when(self.overview_visible(), |element| {
                    element.child(self.right_pane(cx))
                })
                .child(self.settings_page(cx))
                .when(self.command_palette.is_some(), |element| {
                    element.child(self.command_palette(cx))
                })
                .when(close_prompt, |element| {
                    element.child(self.close_confirmation(cx))
                });
        }
        if self.view == AppView::Plugins {
            return div()
                .relative()
                .track_focus(&self.workspace_focus)
                .on_key_down(cx.listener(|this, event, window, cx| {
                    this.handle_workspace_key(event, window, cx);
                }))
                .flex()
                .flex_row()
                .size_full()
                .bg(colors.background)
                .text_color(colors.foreground)
                .when(show_sidebar, |element| element.child(self.sidebar(cx)))
                .when(self.overview_visible(), |element| {
                    element.child(self.right_pane(cx))
                })
                .child(self.plugins_page(cx))
                .when(self.command_palette.is_some(), |element| {
                    element.child(self.command_palette(cx))
                })
                .when(close_prompt, |element| {
                    element.child(self.close_confirmation(cx))
                });
        }
        if self.view == AppView::Schedules {
            return div()
                .relative()
                .track_focus(&self.workspace_focus)
                .on_key_down(cx.listener(|this, event, window, cx| {
                    this.handle_workspace_key(event, window, cx);
                }))
                .flex()
                .flex_row()
                .size_full()
                .bg(colors.background)
                .text_color(colors.foreground)
                .when(show_sidebar, |element| element.child(self.sidebar(cx)))
                .when(self.overview_visible(), |element| {
                    element.child(self.right_pane(cx))
                })
                .child(self.schedules_page(cx))
                .when(self.command_palette.is_some(), |element| {
                    element.child(self.command_palette(cx))
                })
                .when(close_prompt, |element| {
                    element.child(self.close_confirmation(cx))
                });
        }
        div()
            .relative()
            .track_focus(&self.workspace_focus)
            .on_key_down(cx.listener(|this, event, window, cx| {
                this.handle_workspace_key(event, window, cx);
            }))
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
                    // The transcript keeps a usable width even when the
                    // window is squeezed; the geometry module resolves the
                    // same floor for the docked widths.
                    .min_w(px(CENTER_MIN_WIDTH as f32))
                    .child(self.toolbar(cx))
                    // Only drawn once a capture ran, so the transcript keeps
                    // the height it had before the first press.
                    .when(
                        self.capture_path.is_some() || self.capture_error.is_some(),
                        |element| element.child(self.capture_status_row(cx)),
                    )
                    .child(
                        div()
                            .relative()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_h(px(0.0))
                            .child(self.transcript(cx))
                            .when(self.transcript_search.is_some(), |element| {
                                element.child(self.transcript_search_bar(cx))
                            }),
                    )
                    .when(self.terminal_open, |element| {
                        element.child(self.terminal_panel(cx))
                    })
                    .when(self.turn_card_visible(), |element| {
                        element.child(self.turn_changes_card(cx))
                    })
                    .child(self.composer(cx)),
            )
            .when(show_right, |element| element.child(self.right_pane(cx)))
            .when(show_details, |element| {
                element.child(self.details_overlay(cx))
            })
            .when(show_sidebar_overlay, |element| {
                element.child(self.sidebar_overlay(cx))
            })
            .when(self.overview_open && !browser_visible, |element| {
                element.child(self.overview_popover(cx))
            })
            .when(self.menu_open && !browser_visible, |element| {
                element.child(self.session_menu(cx))
            })
            .when(self.command_palette.is_some(), |element| {
                element.child(self.command_palette(cx))
            })
            .when(close_prompt, |element| {
                element.child(self.close_confirmation(cx))
            })
    }
}

/// Appends one streamed text delta to the side-question answer.
fn append_side_answer(answer: &mut String, delta: &str) {
    answer.push_str(delta);
}

/// Returns the text delta carried by a side runtime `message_update` event.
///
/// Thinking and tool deltas are ignored so the pane shows only the answer.
fn side_answer_delta(event: &Value) -> Option<&str> {
    if event.get("type").and_then(Value::as_str) != Some("message_update") {
        return None;
    }
    let kind = event
        .pointer("/assistantMessageEvent/type")
        .and_then(Value::as_str)
        .unwrap_or("text_delta");
    if kind != "text_delta" {
        return None;
    }
    event
        .pointer("/assistantMessageEvent/delta")
        .and_then(Value::as_str)
}

/// Newest transcript lines the live pane keeps; older lines fall off.
const LIVE_TRANSCRIPT_LIMIT: usize = 200;

/// Mutable view of the live-voice fields.
///
/// The pane and the event drain share one state, and this view lets event
/// application stay a pure function tests can drive without a window or an
/// agent runtime.
struct LiveVoiceState<'a> {
    phase: &'a mut String,
    levels: &'a mut f32,
    transcript: &'a mut Vec<String>,
    muted: &'a mut bool,
    active: &'a mut bool,
    error: &'a mut Option<String>,
}

/// Mirrors one normalized `live_*` event into the pane state.
///
/// Returns whether the event belonged to live voice. The harness owns the audio
/// and its phase machine; this only records what it reports. Levels are clamped
/// again here so a malformed frame cannot overflow the bar, and transcript
/// frames keep only the newest [`LIVE_TRANSCRIPT_LIMIT`] lines.
fn apply_live_voice_event(state: &mut LiveVoiceState<'_>, event: &Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("live_phase") => {
            let Some(phase) = event.get("phase").and_then(Value::as_str) else {
                return false;
            };
            *state.phase = phase.to_string();
            // The harness reports a dedicated muted phase, so it is authoritative.
            *state.muted = phase == "muted";
            if phase == "error" {
                *state.active = false;
                *state.levels = 0.0;
            } else {
                *state.active = true;
            }
            true
        }
        Some("live_levels") => {
            // One bar shows the loudest channel: the microphone or the reply.
            let input = event.get("input").and_then(Value::as_f64).unwrap_or(0.0);
            let output = event.get("output").and_then(Value::as_f64).unwrap_or(0.0);
            *state.levels = clamp_live_level(input.max(output));
            true
        }
        Some("live_transcript") => {
            let Some(text) = event.get("text").and_then(Value::as_str) else {
                return false;
            };
            push_live_transcript(state.transcript, text);
            true
        }
        Some("live_end") => {
            *state.active = false;
            *state.levels = 0.0;
            if let Some(error) = event.get("error").and_then(Value::as_str)
                && !error.is_empty()
            {
                *state.error = Some(error.to_string());
            }
            true
        }
        _ => false,
    }
}

/// Appends one transcript frame as lines, skipping blanks and dropping the
/// oldest lines past [`LIVE_TRANSCRIPT_LIMIT`].
fn push_live_transcript(lines: &mut Vec<String>, text: &str) {
    for line in text.split('\n') {
        let line = line.trim();
        if !line.is_empty() {
            lines.push(line.to_string());
        }
    }
    let excess = lines.len().saturating_sub(LIVE_TRANSCRIPT_LIMIT);
    if excess > 0 {
        lines.drain(..excess);
    }
}

/// Clamps a reported level into `0.0..=1.0`; NaN and negatives become zero.
fn clamp_live_level(level: f64) -> f32 {
    if level > 0.0 {
        level.min(1.0) as f32
    } else {
        0.0
    }
}

/// Mutable view of the dictation fields, mirroring [`LiveVoiceState`].
///
/// The composer and the event drain share one state, and this view lets frame
/// application stay a pure function tests can drive without a window or an
/// agent runtime.
struct DictationState<'a> {
    phase: &'a mut String,
    capture_id: &'a mut Option<String>,
    preview: &'a mut String,
    error: &'a mut Option<String>,
    active: &'a mut bool,
    pending_text: &'a mut Option<String>,
}

/// Mirrors one normalized `dictation_*` frame into the host state.
///
/// Returns whether the event belonged to dictation. The harness owns the audio;
/// `dictation_end` is the single terminal result, so its text is parked in
/// `pending_text` for the render loop to append to the composer exactly once.
fn apply_dictation_frame(state: &mut DictationState<'_>, event: &Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("dictation_state") => {
            let Some(phase) = event.get("state").and_then(Value::as_str) else {
                return false;
            };
            if !matches!(phase, "starting" | "recording" | "transcribing") {
                return false;
            }
            if let Some(capture_id) = event.get("captureId").and_then(Value::as_str) {
                *state.capture_id = Some(capture_id.to_string());
            }
            *state.phase = phase.to_string();
            *state.active = true;
            if phase == "starting" {
                // A new capture starts clean; the previous preview is stale.
                state.preview.clear();
                *state.error = None;
            }
            true
        }
        Some("dictation_transcript") => {
            let Some(text) = event.get("text").and_then(Value::as_str) else {
                return false;
            };
            if let Some(capture_id) = event.get("captureId").and_then(Value::as_str) {
                *state.capture_id = Some(capture_id.to_string());
            }
            // The newest transcript frame is the live preview; the terminal
            // text arrives once more in `dictation_end`.
            *state.preview = text.to_string();
            true
        }
        Some("dictation_end") => {
            let text = event
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            *state.active = false;
            *state.phase = "idle".to_string();
            *state.capture_id = None;
            if let Some(error) = event.get("error").and_then(Value::as_str)
                && !error.is_empty()
            {
                // A failed capture keeps its text out of the composer.
                *state.error = Some(error.to_string());
                *state.pending_text = None;
                state.preview.clear();
                return true;
            }
            *state.error = None;
            if !text.trim().is_empty() {
                *state.pending_text = Some(text.to_string());
            }
            true
        }
        _ => false,
    }
}

/// Appends a finished dictation to the draft, keeping any text already typed.
fn append_dictation_text(draft: &str, text: &str) -> String {
    let text = text.trim();
    let draft = draft.trim_end();
    if draft.is_empty() {
        text.to_string()
    } else {
        format!("{draft} {text}")
    }
}

/// One option of an `ask` question, as the pane renders it.
#[derive(Debug, Clone, PartialEq)]
struct AskOption {
    label: String,
    description: Option<String>,
    preview: Option<String>,
}

/// One question of a grouped `ask` request.
#[derive(Debug, Clone, PartialEq)]
struct AskQuestion {
    id: String,
    question: String,
    header: Option<String>,
    options: Vec<AskOption>,
    multi: bool,
    recommended: Option<usize>,
}

/// The live `ask` dialog plus what the user has picked so far.
#[derive(Debug, Clone, Default)]
struct AskDialog {
    request_id: String,
    runtime_id: Option<String>,
    title: String,
    questions: Vec<AskQuestion>,
    selected: HashMap<String, Vec<String>>,
    error: Option<String>,
}

/// Reads the `ask` questions out of a normalized request frame.
///
/// `None` when the frame cannot be rendered faithfully (no questions, a
/// duplicate id, an empty option list); those requests are answered
/// `cancelled` instead of guessing at answers the harness would reject.
fn parse_ask_questions(event: &Value) -> Option<Vec<AskQuestion>> {
    let questions = event.get("questions")?.as_array()?;
    if questions.is_empty() {
        return None;
    }
    let mut seen: Vec<&str> = Vec::with_capacity(questions.len());
    let mut parsed = Vec::with_capacity(questions.len());
    for question in questions {
        let id = question
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())?;
        if seen.contains(&id) {
            return None;
        }
        seen.push(id);
        let text = question
            .get("question")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())?;
        let options = question.get("options")?.as_array()?;
        if options.is_empty() {
            return None;
        }
        let mut parsed_options = Vec::with_capacity(options.len());
        for option in options {
            let label = option
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.is_empty())?;
            parsed_options.push(AskOption {
                label: label.to_string(),
                description: option
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                preview: option
                    .get("preview")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        let recommended = question
            .get("recommended")
            .and_then(Value::as_u64)
            .map(|index| index as usize)
            .filter(|index| *index < parsed_options.len());
        parsed.push(AskQuestion {
            id: id.to_string(),
            question: text.to_string(),
            header: question
                .get("header")
                .and_then(Value::as_str)
                .map(str::to_string),
            options: parsed_options,
            multi: question.get("multi").and_then(Value::as_bool) == Some(true),
            recommended,
        });
    }
    Some(parsed)
}

/// The pane's title: the request's own title, else the first question's header.
fn ask_title(event: &Value, questions: &[AskQuestion]) -> String {
    event
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .or_else(|| {
            questions
                .first()
                .and_then(|question| question.header.clone())
        })
        .or_else(|| questions.first().map(|question| question.question.clone()))
        .unwrap_or_else(|| "Question from OMP".to_string())
}

/// Builds the `answers` array of an `ask` response.
///
/// One entry per question, in question order, carrying the selected option
/// labels and any custom text. A single-select question is exactly one of an
/// option or custom text, so custom text wins over a stale selection; labels
/// that are unknown or repeated are dropped because the harness rejects them.
fn ask_answers(
    questions: &[AskQuestion],
    selected: &HashMap<String, Vec<String>>,
    custom: &HashMap<String, String>,
) -> Vec<Value> {
    questions
        .iter()
        .map(|question| {
            let custom = custom
                .get(&question.id)
                .map(|text| text.trim())
                .unwrap_or_default();
            let mut labels: Vec<String> = Vec::new();
            for label in selected.get(&question.id).into_iter().flatten() {
                if question.options.iter().any(|option| &option.label == label)
                    && !labels.contains(label)
                {
                    labels.push(label.clone());
                }
            }
            if !question.multi && !custom.is_empty() {
                labels.clear();
            }
            let mut answer = json!({ "id": question.id, "selectedOptions": labels });
            if !custom.is_empty() {
                answer["customInput"] = json!(custom);
            }
            answer
        })
        .collect()
}

/// Whether every question has an answer the harness accepts.
///
/// Multi-select questions may be answered with nothing; single-select ones need
/// exactly one option or custom text.
fn ask_answers_ready(
    questions: &[AskQuestion],
    selected: &HashMap<String, Vec<String>>,
    custom: &HashMap<String, String>,
) -> bool {
    questions.iter().all(|question| {
        question.multi
            || selected
                .get(&question.id)
                .is_some_and(|labels| !labels.is_empty())
            || custom
                .get(&question.id)
                .is_some_and(|text| !text.trim().is_empty())
    })
}

/// The response that settles a dialog with the current selections.
fn ask_submit_payload(dialog: &AskDialog, custom: &HashMap<String, String>) -> Value {
    json!({
        "type": "extension_ui_response",
        "id": dialog.request_id,
        "answers": ask_answers(&dialog.questions, &dialog.selected, custom),
    })
}

/// The response that dismisses a dialog without answers.
fn ask_cancel_payload(request_id: &str) -> Value {
    json!({ "type": "extension_ui_response", "id": request_id, "cancelled": true })
}

#[cfg(test)]
mod tests {
    // Imported explicitly: `use super::*` would also pull in `gpui_kit`'s
    // `test` attribute macro, which shadows the built-in one and does not
    // expand under this crate root's default `recursion_limit`.
    use gpui_kit::AppContext as _;
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::PathBuf;

    use omp_core::geometry::UiGeometry;
    use omp_core::settings::AppSettings;

    use super::{
        ATTACHMENT_MAX_BYTES, AppView, AskDialog, AskOption, AskQuestion, CLOSE_CONFIRM_ACCEPT,
        CLOSE_CONFIRM_CANCEL, COMPACT_LAYOUT_BREAKPOINT, CloseGuard, CloseIntent, ContextUsage,
        DictationState, LIVE_TRANSCRIPT_LIMIT, LiveVoiceState, MODEL_PROVIDER_LIMIT, MathSegment,
        MathSegmentKind, RightPane, TERMINAL_EMPTY_SELECTION_STATUS, TERMINAL_MENU_ITEMS,
        TERMINAL_SELECTION_LABEL, TRANSCRIPT_BOTTOM_THRESHOLD, TerminalMenuAction, TerminalSession,
        TerminalTabSpec, TerminalTabSpecs, TodoStatus, UpdateCheckState, Workspace, WorkspaceData,
        append_clipboard_text, append_composer_text, append_dictation_text, append_side_answer,
        apply_dictation_frame, apply_live_voice_event, ask_answers_ready, ask_cancel_payload,
        ask_submit_payload, base64_encode, capture_path, close_confirmation, compact_layout,
        composer_model_label, context_percent, context_usage_label, filter_models, group_digits,
        image_mime, math_plain_text, math_segments, model_key, parse_ask_questions,
        parse_context_usage, parse_model_key, parse_todo_tool_result, provider_chips,
        read_pending_image, should_confirm_close, side_answer_delta, terminal_menu,
        terminal_menu_action, terminal_selection_text_block, terminal_tab_bar,
        transcript_is_at_bottom, transcript_part_text, updates, write_capture,
    };
    use omp_core::sessions::{TranscriptMessage, TranscriptPart};

    /// The render breakpoint: a wide window keeps the docked right pane, while
    /// anything narrower collapses it behind the Details toggle. Exactly at
    /// the breakpoint stays wide, so the existing three-pane layout survives.
    #[test]
    fn compact_layout_breakpoint_splits_wide_and_narrow_windows() {
        assert_eq!(COMPACT_LAYOUT_BREAKPOINT, 980.0);
        assert!(compact_layout(COMPACT_LAYOUT_BREAKPOINT));
        assert!(!compact_layout(COMPACT_LAYOUT_BREAKPOINT + 1.0));
        assert!(!compact_layout(1400.0));
        assert!(!compact_layout(1280.0));
        assert!(compact_layout(COMPACT_LAYOUT_BREAKPOINT - 1.0));
        assert!(compact_layout(900.0));
        assert!(compact_layout(0.0));
    }

    /// A model selection is `provider/id`: the key the settings file stores,
    /// the footer prints and `set_model` splits back apart.
    #[test]
    fn model_keys_round_trip_and_format_for_the_footer() {
        assert_eq!(
            model_key("anthropic", "claude-fixture"),
            "anthropic/claude-fixture"
        );
        // A provider whose ids carry slashes keeps the first `/` as the split.
        assert_eq!(
            model_key("openrouter", "anthropic/claude-3.5"),
            "openrouter/anthropic/claude-3.5"
        );
        assert_eq!(
            parse_model_key("anthropic/claude-fixture"),
            Some(("anthropic", "claude-fixture"))
        );
        assert_eq!(
            parse_model_key("openrouter/anthropic/claude-3.5"),
            Some(("openrouter", "anthropic/claude-3.5"))
        );
        // The harness default is the empty key, not a malformed selection.
        assert_eq!(parse_model_key(""), None);
        assert_eq!(parse_model_key("anthropic"), None);
        assert_eq!(parse_model_key("/claude-fixture"), None);
        assert_eq!(parse_model_key("anthropic/"), None);

        assert_eq!(composer_model_label(""), "Model: auto");
        assert_eq!(
            composer_model_label("anthropic/claude-fixture"),
            "Model: anthropic/claude-fixture"
        );
    }

    /// A catalog model the provider-filter tests can match by key.
    fn filter_model(provider: &str, id: &str) -> omp_core::models::ModelDescriptor {
        omp_core::models::ModelDescriptor {
            key: model_key(provider, id),
            provider: provider.to_string(),
            id: id.to_string(),
            name: format!("{provider} {id}"),
            reasoning: false,
            input: vec!["text".to_string()],
            context_window: 100_000,
            max_tokens: 8_192,
            available_thinking_levels: Vec::new(),
            fast_mode_supported: false,
            available: true,
        }
    }

    /// The provider chip filters the list purely: `All` keeps the catalog
    /// order, one provider keeps its own models, and a provider the catalog
    /// does not carry lists nothing rather than falling back to `All`.
    #[test]
    fn provider_filter_lists_only_the_selected_provider() {
        let models = [
            filter_model("anthropic", "claude-fixture"),
            filter_model("openai-codex", "gpt-5.4"),
            filter_model("anthropic", "claude-opus"),
        ];
        let keys = |provider: Option<&str>| {
            filter_models(&models, provider)
                .into_iter()
                .map(|model| model_key(&model.provider, &model.id))
                .collect::<Vec<String>>()
        };
        assert_eq!(
            keys(None),
            [
                "anthropic/claude-fixture",
                "openai-codex/gpt-5.4",
                "anthropic/claude-opus",
            ]
        );
        assert_eq!(
            keys(Some("anthropic")),
            ["anthropic/claude-fixture", "anthropic/claude-opus"]
        );
        assert_eq!(keys(Some("openai-codex")), ["openai-codex/gpt-5.4"]);
        assert!(keys(Some("local")).is_empty());
    }

    /// The chips are the catalog's providers, bounded to eight; a catalog that
    /// only lists models still gets one chip per provider, without the
    /// configured hint.
    #[test]
    fn provider_chips_bound_the_catalog_and_fall_back_to_models() {
        fn catalog(
            providers: Vec<omp_core::models::ProviderDescriptor>,
            models: Vec<omp_core::models::ModelDescriptor>,
        ) -> omp_core::models::ModelCatalog {
            omp_core::models::ModelCatalog {
                prime_version: "17.2.15".to_string(),
                refreshed_at: "2026-04-02T00:00:00.000Z".to_string(),
                models,
                providers,
                warning: None,
                vision_delegation: None,
                presets: Vec::new(),
            }
        }
        fn provider(id: &str, configured: bool) -> omp_core::models::ProviderDescriptor {
            omp_core::models::ProviderDescriptor {
                id: id.to_string(),
                name: id.to_uppercase(),
                auth_method: "oauth".to_string(),
                configured,
            }
        }

        let chips = provider_chips(&catalog(
            vec![provider("anthropic", true), provider("local", false)],
            vec![filter_model("anthropic", "claude-fixture")],
        ));
        assert_eq!(chips.len(), 2);
        assert_eq!(chips[0].id, "anthropic");
        assert_eq!(chips[0].name, "ANTHROPIC");
        assert_eq!(chips[0].configured, Some(true));
        assert_eq!(chips[1].id, "local");
        assert_eq!(chips[1].configured, Some(false));

        let many = (0..10)
            .map(|index| provider(&format!("provider-{index}"), true))
            .collect();
        let chips = provider_chips(&catalog(many, Vec::new()));
        assert_eq!(chips.len(), MODEL_PROVIDER_LIMIT);
        assert_eq!(chips[MODEL_PROVIDER_LIMIT - 1].id, "provider-7");

        let chips = provider_chips(&catalog(
            Vec::new(),
            vec![
                filter_model("anthropic", "claude-fixture"),
                filter_model("local", "plain-model"),
                filter_model("anthropic", "claude-opus"),
            ],
        ));
        assert_eq!(
            chips
                .iter()
                .map(|chip| chip.id.as_str())
                .collect::<Vec<_>>(),
            ["anthropic", "local"]
        );
        assert!(chips.iter().all(|chip| chip.configured.is_none()));
    }

    /// A capture is stamped in UTC under `<user_data_dir>/captures`, and the PNG
    /// that name points at decodes back to the frame that was written.
    #[test]
    fn capture_path_is_stamped_and_saved_as_a_png() {
        let root = tempfile::TempDir::new().expect("test root");
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-20T05:06:07.089Z")
            .expect("timestamp")
            .with_timezone(&chrono::Utc);
        let expected = root
            .path()
            .join("captures")
            .join("omp-20261120T050607089.png");
        assert_eq!(capture_path(root.path(), at), expected);

        let frame = image::RgbaImage::from_pixel(2, 2, image::Rgba([12, 34, 56, 255]));
        let saved = write_capture(root.path(), at, &frame).expect("saved capture");
        assert_eq!(saved, expected);
        assert_eq!(
            image::open(&saved).expect("decode capture").to_rgba8(),
            frame
        );

        // The millisecond stamp keeps back-to-back captures apart.
        let later = chrono::DateTime::parse_from_rfc3339("2026-11-20T05:06:07.090Z")
            .expect("timestamp")
            .with_timezone(&chrono::Utc);
        assert_ne!(capture_path(root.path(), later), saved);
    }

    /// The one-pixel PNG the attachment tests write, magic included: the
    /// composer trusts the bytes, not the file name.
    const ONE_PIXEL_PNG: [u8; 70] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xFC,
        0xCF, 0xC0, 0x50, 0x0F, 0x00, 0x04, 0x85, 0x01, 0x80, 0x84, 0xA9, 0x8C, 0x21, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    /// An attachment is standard padded base64 of the file's bytes, and the
    /// magic decides the mime the harness receives.
    #[test]
    fn attachments_encode_to_base64_and_identify_their_mime() {
        // The vectors are RFC 4648's, padding included.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(
            base64_encode(&ONE_PIXEL_PNG),
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        );

        assert_eq!(image_mime(&ONE_PIXEL_PNG), Some("image/png"));
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(image_mime(b"RIFF\x00\x00\x00\x00WEBP"), Some("image/webp"));
        assert_eq!(image_mime(b"not an image"), None);
    }

    /// A file only attaches when its name and bytes agree with one of the four
    /// image types, and an oversized file is rejected before it is read.
    #[test]
    fn attachments_reject_unsupported_and_oversized_files() {
        let root = tempfile::TempDir::new().expect("test root");
        let png = root.path().join("dot.png");
        std::fs::write(&png, ONE_PIXEL_PNG).expect("png");
        let attached = read_pending_image(&png).expect("attached png");
        assert_eq!(attached.name, "dot.png");
        assert_eq!(attached.mime, "image/png");
        assert_eq!(attached.size, ONE_PIXEL_PNG.len() as u64);

        // A name the composer does not accept is refused even when the bytes
        // are an image; a supported name with other bytes is refused too.
        let text = root.path().join("note.txt");
        std::fs::write(&text, ONE_PIXEL_PNG).expect("text");
        assert!(
            read_pending_image(&text)
                .expect_err("unsupported name")
                .contains("Unsupported")
        );

        let mislabelled = root.path().join("fake.png");
        std::fs::write(&mislabelled, b"hello").expect("fake");
        assert!(
            read_pending_image(&mislabelled)
                .expect_err("unsupported bytes")
                .contains("not a PNG")
        );

        // The size comes from the metadata, so the sparse file is never read.
        let oversized = root.path().join("big.png");
        std::fs::File::create(&oversized)
            .expect("big")
            .set_len(ATTACHMENT_MAX_BYTES + 1)
            .expect("size");
        let error = read_pending_image(&oversized).expect_err("oversized");
        assert!(error.contains("11 MB"), "{error}");
    }

    /// A reading needs every field: a missing `contextUsage`, a zero window, a
    /// negative count or a negative percent is not something the dial can
    /// draw, so it parses to nothing and the caller keeps its last reading.
    #[test]
    fn context_usage_parses_only_a_complete_reading() {
        assert_eq!(
            parse_context_usage(&json!({
                "success": true,
                "data": {
                    "contextUsage": {
                        "tokens": 123456,
                        "contextWindow": 200000,
                        "percent": 61.7,
                    }
                }
            })),
            Some(ContextUsage {
                tokens: 123456,
                window: 200000,
                percent: 61.7,
            })
        );

        // An older harness omits the field, and a failed command carries no data.
        assert_eq!(
            parse_context_usage(&json!({ "success": true, "data": {} })),
            None
        );
        assert_eq!(
            parse_context_usage(&json!({ "success": false, "error": { "message": "no" } })),
            None
        );
        // A zero window has no denominator; a negative token count and a
        // negative percent are not counters the harness can report.
        for usage in [
            json!({ "tokens": 10, "contextWindow": 0, "percent": 5.0 }),
            json!({ "tokens": -1, "contextWindow": 100, "percent": 5.0 }),
            json!({ "tokens": 10, "contextWindow": 100, "percent": -0.5 }),
            json!({ "tokens": 10, "contextWindow": 100 }),
        ] {
            assert_eq!(
                parse_context_usage(&json!({ "data": { "contextUsage": usage } })),
                None
            );
        }
    }

    /// The dial's percent is clamped into its ring and rounded like the
    /// Electron dial; the label carries the token detail the pill cannot show.
    #[test]
    fn context_percent_clamps_and_the_label_carries_the_tokens() {
        assert_eq!(context_percent(-4.0), 0);
        assert_eq!(context_percent(0.0), 0);
        assert_eq!(context_percent(42.4), 42);
        assert_eq!(context_percent(42.6), 43);
        assert_eq!(context_percent(100.0), 100);
        assert_eq!(context_percent(140.0), 100);
        // A malformed frame has no fill to draw.
        assert_eq!(context_percent(f64::NAN), 0);
        assert_eq!(context_percent(f64::INFINITY), 0);

        assert_eq!(group_digits(0), "0");
        assert_eq!(group_digits(999), "999");
        assert_eq!(group_digits(1000), "1,000");
        assert_eq!(group_digits(1_234_567), "1,234,567");

        let usage = ContextUsage {
            tokens: 1_234_567,
            window: 2_000_000,
            percent: 61.7,
        };
        assert_eq!(
            context_usage_label(&usage),
            "Context usage: 1,234,567 of 2,000,000 tokens (62%)"
        );
    }

    /// A capture that wrote its frame reports the path and no error; one that
    /// could not reports the error and keeps no path, so the status row shows
    /// exactly one of them.
    #[test]
    fn capture_reports_the_saved_path_or_the_error() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });

        let frame = image::RgbaImage::from_pixel(2, 2, image::Rgba([12, 34, 56, 255]));
        let (path, error) = handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.finish_capture(Ok(frame), cx);
                (
                    workspace.capture_path.clone(),
                    workspace.capture_error.clone(),
                )
            })
            .expect("workspace window");
        let path = path.expect("saved path");
        assert!(
            path.starts_with(root.join("captures")),
            "{}",
            path.display()
        );
        assert!(path.exists(), "{}", path.display());
        assert_eq!(error, None);

        handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.finish_capture(Err("Capture failed: no renderer".to_string()), cx);
                assert_eq!(workspace.capture_path, None);
                assert_eq!(
                    workspace.capture_error.as_deref(),
                    Some("Capture failed: no renderer")
                );
            })
            .expect("workspace window");
    }

    /// A close asks only while an agent run is live: an idle app closes at
    /// once, a live runtime parks the question in the confirmation overlay,
    /// `Cancel` clears it, and `Close anyway` approves the close.
    #[test]
    fn close_confirmation_guards_a_live_runtime() {
        assert!(!should_confirm_close(false));
        assert!(should_confirm_close(true));

        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        // `main` installs the guard before the window opens; the view picks it
        // up from there, so a close attempt and the overlay share one state.
        let guard = CloseGuard::new();
        cx.update(|cx| cx.set_global(guard.clone()));
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: root.join("missing-omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });

        // No agent run: the close is allowed and nothing is asked.
        let (allowed, prompt) = handle
            .update(&mut cx, |workspace, _, cx| {
                let allowed = workspace.request_close(CloseIntent::Window, cx);
                (allowed, workspace.close_prompt_open())
            })
            .expect("workspace window");
        assert!(allowed);
        assert!(!prompt);
        assert!(!guard.agent_active());

        // A live runtime (the id is all "active" needs; no agent starts): the
        // close is refused and the question is on screen.
        let (allowed, prompt, guard_active) = handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.runtime_id = Some("test-runtime".to_string());
                let allowed = workspace.request_close(CloseIntent::Window, cx);
                (
                    allowed,
                    workspace.debug_snapshot(cx)["closePrompt"].clone(),
                    workspace.close_guard.agent_active(),
                )
            })
            .expect("workspace window");
        assert!(!allowed);
        assert_eq!(prompt, json!("window"));
        assert!(guard_active);
        assert!(guard.agent_active());

        // The overlay is what the refused close draws; drawing the frame
        // exercises it with no agent behind it.
        cx.update(|cx| {
            cx.update_window(*handle, |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw close confirmation");
        });

        // Cancel keeps the app running and leaves no approval behind.
        let (prompt, approved) = handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.cancel_close(cx);
                (
                    workspace.close_prompt_open(),
                    workspace.close_guard.approved(),
                )
            })
            .expect("workspace window");
        assert!(!prompt);
        assert!(!approved);

        // The tray's Quit asks the same question, and names itself so
        // `Close anyway` can quit instead of closing a window.
        let (allowed, prompt) = handle
            .update(&mut cx, |workspace, _, cx| {
                let allowed = workspace.request_close(CloseIntent::Quit, cx);
                (allowed, workspace.debug_snapshot(cx)["closePrompt"].clone())
            })
            .expect("workspace window");
        assert!(!allowed);
        assert_eq!(prompt, json!("quit"));
        handle
            .update(&mut cx, |workspace, _, cx| workspace.cancel_close(cx))
            .expect("workspace window");

        // A second close asks again, and `Close anyway` approves it.
        let (prompt, approved) = handle
            .update(&mut cx, |workspace, window, cx| {
                assert!(!workspace.request_close(CloseIntent::Window, cx));
                workspace.confirm_close(window, cx);
                (
                    workspace.close_prompt_open(),
                    workspace.close_guard.approved(),
                )
            })
            .expect("workspace window");
        assert!(!prompt);
        assert!(approved);
        assert!(guard.approved());
    }

    /// The confirmation overlay draws with no agent behind it: a dimmed
    /// backdrop and the two buttons the close handler asks about.
    #[test]
    fn close_confirmation_renders_without_an_agent() {
        use gpui_kit::component::ActiveTheme as _;

        struct TestOverlay;

        impl gpui_kit::Render for TestOverlay {
            fn render(
                &mut self,
                _window: &mut gpui_kit::Window,
                cx: &mut gpui_kit::Context<Self>,
            ) -> impl gpui_kit::IntoElement {
                close_confirmation(cx.theme().colors, |_, _, _| {}, |_, _, _| {})
            }
        }

        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let handle = cx.add_window(|_, _| TestOverlay);
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw close confirmation");
        });
        cx.quit();
        // The two answers are the ones the Electron dialog offered.
        assert_eq!(CLOSE_CONFIRM_CANCEL, "Cancel");
        assert_eq!(CLOSE_CONFIRM_ACCEPT, "Close anyway");
    }

    /// The handler `main` registers is what the platform asks: an idle app lets
    /// the window close, and a live runtime refuses the close and raises the
    /// overlay instead.
    #[test]
    fn registered_close_handler_asks_the_view() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let guard = CloseGuard::new();
        cx.update(|cx| cx.set_global(guard.clone()));
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: root.join("missing-omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        // The same registration `main` performs once the window opens.
        let workspace = handle.root(&mut cx).expect("workspace root");
        cx.update(|cx| {
            (*handle)
                .update(cx, |_, window, cx| {
                    window.on_window_should_close(cx, move |_window, app| {
                        workspace
                            .update(app, |this, cx| this.request_close(CloseIntent::Window, cx))
                    });
                })
                .expect("register close handler");
        });

        // No agent run: the window closes without a question.
        let mut visual = gpui_kit::VisualTestContext::from_window(*handle, &cx);
        assert!(visual.simulate_close(), "an idle app closes at once");
        let prompt = handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.debug_snapshot(cx)["closePrompt"].clone()
            })
            .expect("workspace window");
        assert_eq!(prompt, json!(null));

        // A live runtime: the close is refused and the overlay is raised.
        handle
            .update(&mut cx, |workspace, _, _| {
                workspace.runtime_id = Some("test-runtime".to_string());
            })
            .expect("workspace window");
        let mut visual = gpui_kit::VisualTestContext::from_window(*handle, &cx);
        assert!(!visual.simulate_close(), "a live runtime refuses the close");
        let prompt = handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.debug_snapshot(cx)["closePrompt"].clone()
            })
            .expect("workspace window");
        assert_eq!(prompt, json!("window"));
    }

    /// The Settings page must render the update row, and an unconfigured build
    /// must land on the "not configured" label instead of touching the network.
    #[test]
    fn settings_page_renders_the_update_row() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        let configured = updates::is_configured();
        let (state, spawned) = handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.view = AppView::Settings;
                if !configured {
                    workspace.start_update_check(cx);
                }
                (
                    workspace.update_check.clone(),
                    workspace.update_task.is_some(),
                )
            })
            .expect("workspace window");
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                // Drawing the Settings page is what exercises the row: it
                // builds every ABOUT row, including this one. Element queries
                // are opt-in (`.test_support()`) and unused in this app.
                window.draw(cx).clear(cx);
            })
            .expect("draw settings frame");
        });
        cx.quit();
        if configured {
            // A build with a real feed would check the network on click; the
            // suite never triggers that, and only the offline path is asserted.
            return;
        }
        assert_eq!(state, UpdateCheckState::Unconfigured);
        assert_eq!(state.label(), "not configured");
        // Nothing was queued: an unconfigured build does no network work at all.
        assert!(!spawned);
    }

    /// The Side Question pane draws its own input and leaves the main
    /// transcript untouched.
    #[test]
    fn side_question_pane_renders_without_touching_the_transcript() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, _, _| {
                workspace.right_pane = RightPane::SideQuestion;
                workspace.layout = workspace.geometry.resolve(1600.0);
            })
            .expect("workspace window");
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw side question frame");
        });
        let (transcript, answer, error, streaming) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.transcript.len(),
                    workspace.side_answer.clone(),
                    workspace.side_error.clone(),
                    workspace.side_streaming,
                )
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(transcript, 0);
        assert!(answer.is_empty());
        assert!(error.is_none());
        assert!(!streaming);
    }

    /// The terminal panel draws with no shell attached: rendering must not
    /// spawn a PTY, and the transcript stays untouched.
    #[test]
    fn terminal_panel_renders_without_starting_a_shell() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, _, _| {
                workspace.terminal_open = true;
                workspace.terminal_error = Some("shell unavailable".to_string());
                workspace.layout = workspace.geometry.resolve(1600.0);
            })
            .expect("workspace window");
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw terminal frame");
        });
        let (transcript, open, tabs) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.transcript.len(),
                    workspace.terminal_open,
                    workspace.terminals.len(),
                )
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(transcript, 0);
        assert!(open);
        assert_eq!(tabs, 0);
    }

    /// A session with no saved tabs draws the panel's empty state: nothing is
    /// restored, no shell starts, and the snapshot reports zero restorable
    /// tabs.
    #[test]
    fn terminal_panel_renders_empty_without_restored_tabs() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: root.join("missing-omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        let (restored, tabs, open, buckets) = handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.terminal_open = true;
                workspace.layout = workspace.geometry.resolve(1600.0);
                let state = workspace.debug_snapshot(cx);
                (
                    state["terminal"]["restoredTabs"].clone(),
                    state["terminal"]["tabs"].clone(),
                    state["terminal"]["open"].clone(),
                    workspace.terminal_specs.len(),
                )
            })
            .expect("workspace window");
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw terminal frame");
        });
        cx.quit();
        assert_eq!(restored, json!(0));
        assert_eq!(tabs, json!(0));
        assert_eq!(open, json!(true));
        // Neither the render nor the snapshot invents a spec bucket.
        assert_eq!(buckets, 0);
    }

    /// Switching sessions files each session's tabs under its own id: the
    /// specs survive the switch, no shell is reused, and a closed panel never
    /// spawns one.
    #[test]
    fn switching_sessions_restores_only_that_sessions_tabs() {
        fn record(root: &std::path::Path, id: &str) -> omp_core::sessions::SessionRecord {
            omp_core::sessions::SessionRecord {
                id: id.to_string(),
                harness: "omp".to_string(),
                file_path: root.join(format!("{id}.jsonl")).display().to_string(),
                project_path: root.display().to_string(),
                title: id.to_string(),
                created_at: "2026-04-01T00:00:00.000Z".to_string(),
                updated_at: "2026-04-01T00:00:00.000Z".to_string(),
                last_user_message_at: None,
                status: "complete".to_string(),
                model: None,
                provider: None,
                thinking_level: None,
                depth: 0,
                parent_session: None,
                last_user_texts: Vec::new(),
                pinned: false,
                unread: false,
                preview: None,
                archived: false,
            }
        }

        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window({
            let root = root.clone();
            move |window, cx| {
                Workspace::new(
                    window,
                    cx,
                    WorkspaceData {
                        geometry: UiGeometry::default(),
                        geometry_path: root.join("ui-geometry.json"),
                        home_dir: root.clone(),
                        user_data_dir: root.clone(),
                        // The runtime never starts: the path does not resolve.
                        omp_executable: root.join("missing-omp"),
                        settings: AppSettings::default(),
                        projects: Vec::new(),
                        sessions: vec![record(&root, "session-a"), record(&root, "session-b")],
                    },
                )
            }
        });
        let (first, second, back, live) = handle
            .update(&mut cx, |workspace, _, cx| {
                let mut one = TerminalTabSpecs::default();
                one.add(TerminalTabSpec {
                    cwd: Some(PathBuf::from("/tmp/a")),
                    shell: "/bin/sh".to_string(),
                });
                let mut two = TerminalTabSpecs::default();
                two.add(TerminalTabSpec {
                    cwd: Some(PathBuf::from("/tmp/b")),
                    shell: "/bin/sh".to_string(),
                });
                two.add(TerminalTabSpec {
                    cwd: None,
                    shell: "/bin/sh".to_string(),
                });
                workspace
                    .terminal_specs
                    .insert("session-a".to_string(), one);
                workspace
                    .terminal_specs
                    .insert("session-b".to_string(), two);

                workspace.select_session(0, cx);
                let first = workspace.debug_snapshot(cx)["terminal"]["restoredTabs"].clone();
                let closed = workspace.terminals.len();
                workspace.select_session(1, cx);
                let second = workspace.debug_snapshot(cx)["terminal"]["restoredTabs"].clone();
                let still_closed = workspace.terminals.len();
                workspace.select_session(0, cx);
                let back = workspace.debug_snapshot(cx)["terminal"]["restoredTabs"].clone();
                (first, second, back, closed + still_closed)
            })
            .expect("workspace window");
        let (error, tabs) = handle
            .update(&mut cx, |workspace, _, cx| {
                // Reopening the panel replays the selected session's spec. The
                // spec names a program that is not installed, so the restore
                // records the failure instead of starting a shell: the replay
                // path runs and never falls back to another session's shell.
                let mut bogus = TerminalTabSpecs::default();
                bogus.add(TerminalTabSpec {
                    cwd: None,
                    shell: "/nonexistent/omp-test-shell".to_string(),
                });
                workspace
                    .terminal_specs
                    .insert("session-b".to_string(), bogus);
                workspace.terminal_open = true;
                workspace.select_session(1, cx);
                (workspace.terminal_error.clone(), workspace.terminals.len())
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(first, json!(1));
        assert_eq!(second, json!(2));
        // Back on the first session: its own single tab, untouched by the
        // second session's two.
        assert_eq!(back, json!(1));
        // The panel stayed closed, so no shell was ever started.
        assert_eq!(live, 0);
        assert_eq!(tabs, 0);
        assert!(error.is_some());
    }

    /// The tab bar draws with no tabs (just `+`) and with one tab, without a
    /// shell: it only reads labels and callbacks.
    #[test]
    fn terminal_tab_bar_renders_with_zero_and_one_tab() {
        use gpui_kit::component::ActiveTheme as _;

        struct TestTabBar {
            labels: Vec<String>,
        }

        impl gpui_kit::Render for TestTabBar {
            fn render(
                &mut self,
                _window: &mut gpui_kit::Window,
                cx: &mut gpui_kit::Context<Self>,
            ) -> impl gpui_kit::IntoElement {
                terminal_tab_bar(
                    &self.labels,
                    0,
                    cx.theme().colors,
                    |_, _, _| {},
                    |_, _, _| {},
                    |_, _| {},
                )
            }
        }

        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        for labels in [Vec::new(), vec!["/bin/sh · home".to_string()]] {
            let handle = cx.add_window(|_, _| TestTabBar { labels });
            cx.update(|cx| {
                cx.update_window(handle.into(), |_, window, cx| {
                    window.draw(cx).clear(cx);
                })
                .expect("draw tab bar frame");
            });
        }
        cx.quit();
    }

    /// The menu's rows name their ids, labels and actions in one order: the
    /// renderer and the click handler read the same table.
    #[test]
    fn terminal_menu_rows_copy_paste_send_and_clear() {
        assert_eq!(
            TERMINAL_MENU_ITEMS.map(|(id, label, _)| (id, label)),
            [
                ("terminal-menu-copy", "Copy screen"),
                ("terminal-menu-paste", "Paste"),
                ("terminal-menu-send-selection", "Send selection"),
                ("terminal-menu-clear", "Clear"),
            ]
        );
        assert_eq!(
            terminal_menu_action("terminal-menu-copy"),
            Some(TerminalMenuAction::Copy)
        );
        assert_eq!(
            terminal_menu_action("terminal-menu-paste"),
            Some(TerminalMenuAction::Paste)
        );
        assert_eq!(
            terminal_menu_action("terminal-menu-send-selection"),
            Some(TerminalMenuAction::SendSelection)
        );
        assert_eq!(
            terminal_menu_action("terminal-menu-clear"),
            Some(TerminalMenuAction::Clear)
        );
        // Anything else closes the menu without running an action.
        assert_eq!(terminal_menu_action("terminal-close"), None);
        assert_eq!(terminal_menu_action(""), None);
    }

    /// Pasting keeps the terminal input on one line: the clipboard's trailing
    /// newline is dropped and inner breaks become spaces.
    #[test]
    fn pasted_clipboard_text_stays_on_one_input_line() {
        assert_eq!(append_clipboard_text("", "ls\r\n"), "ls");
        assert_eq!(append_clipboard_text("git ", "status\n"), "git status");
        assert_eq!(append_clipboard_text("echo ", "a\nb\r\n"), "echo a b");
        assert_eq!(append_clipboard_text("kept", "\n\n"), "kept");
        assert_eq!(append_clipboard_text("kept", ""), "kept");
    }

    /// The header menu draws with no session: opening it does not start a
    /// shell, and the panel keeps its empty tab bar.
    #[test]
    fn terminal_menu_renders_without_a_session() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, _, _| {
                workspace.terminal_open = true;
                workspace.terminal_menu_open = true;
                workspace.layout = workspace.geometry.resolve(1600.0);
            })
            .expect("workspace window");
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw terminal menu frame");
        });
        let (open, terminals) = handle
            .update(&mut cx, |workspace, _, _| {
                (workspace.terminal_menu_open, workspace.terminals.len())
            })
            .expect("workspace window");
        cx.quit();
        assert!(open);
        assert_eq!(terminals, 0);
    }

    /// Copy, Paste, Send selection and Clear with no session leave the panel
    /// usable: Paste fills the input line from the clipboard instead of
    /// writing to a PTY, Send selection reports the empty screen, and every
    /// row closes the menu.
    #[test]
    fn terminal_menu_actions_without_a_session_do_not_panic() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        cx.update(|cx| {
            cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("ls -la\n".to_string()));
        });
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, window, cx| {
                workspace.terminal_open = true;
                workspace.terminal_menu_open = true;
                // Copy and Clear have no session to read or reset.
                workspace.terminal_menu_click("terminal-menu-copy", window, cx);
                assert!(!workspace.terminal_menu_open);
                workspace.terminal_menu_click("terminal-menu-clear", window, cx);
                // Paste lands in the input line, never in a shell.
                workspace.terminal_menu_click("terminal-menu-paste", window, cx);
                assert_eq!(workspace.terminal_input.read(cx).value().as_ref(), "ls -la");
                // Send selection has no screen to quote, so it only reports.
                workspace.terminal_menu_click("terminal-menu-send-selection", window, cx);
                assert_eq!(
                    workspace.terminal_status.as_deref(),
                    Some(TERMINAL_EMPTY_SELECTION_STATUS)
                );
                assert_eq!(workspace.composer.read(cx).value().as_ref(), "");
                workspace.terminal_menu_click("terminal-menu-unknown", window, cx);
                assert!(workspace.terminals.is_empty());
            })
            .expect("workspace window");
        cx.quit();
    }

    /// The composer text keeps the draft the user typed and separates the
    /// quote with one space, so inserted text does not run into the word
    /// before it.
    #[test]
    fn composer_text_appends_without_rewriting_the_draft() {
        let text = terminal_selection_text_block("ok");
        assert_eq!(text, format!("{TERMINAL_SELECTION_LABEL} ok"));
        assert_eq!(append_composer_text("", &text), text);
        assert_eq!(
            append_composer_text("draft", &text),
            format!("draft {text}")
        );
        assert_eq!(
            append_composer_text("draft ", &text),
            format!("draft {text}")
        );
        // Trailing spaces the user typed are kept: only the separator is new.
        assert_eq!(
            append_composer_text("  keep me  ", &text),
            format!("  keep me  {text}")
        );
    }

    /// `Send selection` quotes the screen's last output row into the composer
    /// under its label, keeps the terminal screen and input untouched, and
    /// never sends: the transcript stays empty and no turn starts.
    #[test]
    fn terminal_selection_reaches_the_composer_without_clearing_the_screen() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: root.join("missing-omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        let (draft, before, after, screen, input, sent) = handle
            .update(&mut cx, |workspace, window, cx| {
                workspace.layout = workspace.geometry.resolve(1600.0);
                workspace.open_terminal_screen(cx);
                assert!(workspace.feed_terminal_output(b"npm run build\r\nok\r\n", cx));
                let before = workspace.terminal_selection_text();
                let screen = workspace
                    .terminals
                    .get(workspace.active_terminal)
                    .map(TerminalSession::screen_text);
                workspace.terminal_menu_click("terminal-menu-send-selection", window, cx);
                (
                    workspace.composer.read(cx).value().to_string(),
                    before,
                    workspace.terminal_selection_text(),
                    screen,
                    workspace.terminal_input.read(cx).value().to_string(),
                    (
                        workspace.transcript.len(),
                        workspace.running,
                        workspace.terminal_status.clone(),
                    ),
                )
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(before, "ok");
        assert_eq!(draft, format!("{TERMINAL_SELECTION_LABEL} ok"));
        // The send reads the screen; it never edits or clears it.
        assert_eq!(after, before);
        assert_eq!(screen.as_deref(), Some("npm run build\nok"));
        assert_eq!(input, "");
        assert_eq!(sent, (0, false, None));
    }

    /// Sending with an empty screen is a no-op that reports a status: the
    /// composer keeps its draft, and nothing is quoted.
    #[test]
    fn sending_an_empty_terminal_reports_a_status_and_keeps_the_draft() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: root.join("missing-omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        let (draft, status, selection) = handle
            .update(&mut cx, |workspace, window, cx| {
                workspace.layout = workspace.geometry.resolve(1600.0);
                workspace
                    .composer
                    .update(cx, |state, cx| state.set_value("keep this", window, cx));
                workspace.open_terminal_screen(cx);
                workspace.send_terminal_selection(window, cx);
                let state = workspace.debug_snapshot(cx);
                (
                    workspace.composer.read(cx).value().to_string(),
                    state["terminal"]["status"].clone(),
                    state["terminal"]["selection"].clone(),
                )
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(draft, "keep this");
        assert_eq!(status, json!(TERMINAL_EMPTY_SELECTION_STATUS));
        assert_eq!(selection, json!(""));
    }

    /// A second send appends another quote instead of replacing the first, and
    /// the existing draft stays ahead of both.
    #[test]
    fn repeated_sends_append_to_the_draft() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: root.join("missing-omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        let draft = handle
            .update(&mut cx, |workspace, window, cx| {
                workspace.layout = workspace.geometry.resolve(1600.0);
                workspace
                    .composer
                    .update(cx, |state, cx| state.set_value("ask about", window, cx));
                workspace.open_terminal_screen(cx);
                assert!(workspace.feed_terminal_output(b"first\r\n", cx));
                workspace.send_terminal_selection(window, cx);
                assert!(workspace.feed_terminal_output(b"second\r\n", cx));
                workspace.send_terminal_selection(window, cx);
                workspace.composer.read(cx).value().to_string()
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(
            draft,
            "ask about Terminal output: first Terminal output: second"
        );
    }

    /// The menu element itself draws all four rows without a workspace.
    #[test]
    fn terminal_menu_draws_its_rows() {
        use gpui_kit::component::ActiveTheme as _;

        struct TestMenu;

        impl gpui_kit::Render for TestMenu {
            fn render(
                &mut self,
                _window: &mut gpui_kit::Window,
                cx: &mut gpui_kit::Context<Self>,
            ) -> impl gpui_kit::IntoElement {
                terminal_menu(cx.theme().colors, |_, _, _| {})
            }
        }

        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let handle = cx.add_window(|_, _| TestMenu);
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw terminal menu rows");
        });
        cx.quit();
    }

    /// The Browser pane draws its blank state with no tabs: rendering must not
    /// build a webview, and the pane stays usable for the next `+` or address.
    #[test]
    fn browser_pane_renders_blank_with_no_tabs() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, _, _| {
                // Set the pane directly, so no blank tab is prepared for it.
                workspace.right_pane = RightPane::Browser;
                workspace.layout = workspace.geometry.resolve(1600.0);
            })
            .expect("workspace window");
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw browser frame");
        });
        let (tabs, active, pending) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.browser.tab_count(),
                    workspace.browser.active_tab(),
                    workspace.browser.needs_webview(),
                )
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(tabs, 0);
        assert_eq!(active, 0);
        // An empty pane is not waiting for a webview: it waits for a tab.
        assert!(!pending);
    }

    /// Selecting or closing a tab with no sessions is a no-op, and closing the
    /// panel afterwards clears the open flag: neither path panics.
    #[test]
    fn terminal_tab_actions_without_sessions_do_not_panic() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.terminal_open = true;
                workspace.close_terminal_tab(0, cx);
                workspace.select_terminal_tab(3, cx);
                assert!(workspace.terminal_open);
                assert_eq!(workspace.active_terminal, 0);
                assert!(workspace.terminals.is_empty());
                workspace.close_terminal(cx);
                assert!(!workspace.terminal_open);
            })
            .expect("workspace window");
        cx.quit();
    }

    /// Side-question deltas accumulate in order; thinking deltas are skipped.
    #[test]
    fn side_answer_deltas_accumulate_text_only() {
        let events = [
            json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "text_delta", "delta": "The answer " },
            }),
            json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "thinking_delta", "delta": "hidden" },
            }),
            json!({
                "type": "message_update",
                "assistantMessageEvent": { "delta": "is 42." },
            }),
            json!({ "type": "agent_end" }),
        ];
        let mut answer = String::new();
        for event in &events {
            if let Some(delta) = side_answer_delta(event) {
                append_side_answer(&mut answer, delta);
            }
        }
        assert_eq!(answer, "The answer is 42.");
        assert!(side_answer_delta(&events[3]).is_none());
    }

    /// The live-voice event helper mirrors phases, clamps levels, appends
    /// transcript lines, bounds their count, and reports end errors — all
    /// without a window or an agent runtime.
    #[test]
    fn live_voice_events_mirror_state_without_a_runtime() {
        let mut phase = String::from("idle");
        let mut levels = 0.0_f32;
        let mut transcript: Vec<String> = Vec::new();
        let mut muted = false;
        let mut active = false;
        let mut error: Option<String> = None;
        let mut state = LiveVoiceState {
            phase: &mut phase,
            levels: &mut levels,
            transcript: &mut transcript,
            muted: &mut muted,
            active: &mut active,
            error: &mut error,
        };

        assert!(apply_live_voice_event(
            &mut state,
            &json!({ "type": "live_phase", "phase": "listening" })
        ));
        assert_eq!(*state.phase, "listening");
        assert!(*state.active);
        assert!(!*state.muted);

        // The loudest channel drives the single bar, clamped to 0..=1.
        assert!(apply_live_voice_event(
            &mut state,
            &json!({ "type": "live_levels", "input": 0.25, "output": 2.5 })
        ));
        assert_eq!(*state.levels, 1.0);
        assert!(apply_live_voice_event(
            &mut state,
            &json!({ "type": "live_levels", "input": -1.0, "output": 0.0 })
        ));
        assert_eq!(*state.levels, 0.0);

        assert!(apply_live_voice_event(
            &mut state,
            &json!({
                "type": "live_transcript",
                "role": "user",
                "turn": 0,
                "text": "hello\nthere",
                "final": true,
            })
        ));
        assert_eq!(
            *state.transcript,
            vec!["hello".to_string(), "there".to_string()]
        );

        // The pane keeps only the newest lines.
        for index in 0..(LIVE_TRANSCRIPT_LIMIT + 5) {
            assert!(apply_live_voice_event(
                &mut state,
                &json!({
                    "type": "live_transcript",
                    "role": "assistant",
                    "turn": 1,
                    "text": format!("line {index}"),
                    "final": false,
                })
            ));
        }
        assert_eq!(state.transcript.len(), LIVE_TRANSCRIPT_LIMIT);
        let newest = format!("line {}", LIVE_TRANSCRIPT_LIMIT + 4);
        assert_eq!(
            state.transcript.last().map(String::as_str),
            Some(newest.as_str())
        );

        // The harness reports mute through its phase machine.
        assert!(apply_live_voice_event(
            &mut state,
            &json!({ "type": "live_phase", "phase": "muted" })
        ));
        assert!(*state.muted);

        assert!(apply_live_voice_event(
            &mut state,
            &json!({ "type": "live_end", "error": "microphone denied" })
        ));
        assert!(!*state.active);
        assert_eq!(*state.levels, 0.0);
        assert_eq!(state.error.as_deref(), Some("microphone denied"));

        // Frames from other subsystems and malformed live frames are ignored.
        assert!(!apply_live_voice_event(
            &mut state,
            &json!({ "type": "agent_end" })
        ));
        assert!(!apply_live_voice_event(
            &mut state,
            &json!({ "type": "live_transcript" })
        ));
    }

    /// The Live Voice pane draws with no runtime attached: rendering must not
    /// send an RPC command, and the main transcript stays untouched.
    #[test]
    fn live_voice_pane_renders_without_a_runtime() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, _, _| {
                workspace.right_pane = RightPane::LiveVoice;
                workspace.layout = workspace.geometry.resolve(1600.0);
                workspace.live_phase = "listening".to_string();
                workspace.live_levels = 0.4;
                workspace.live_transcript = vec!["hello from the harness".to_string()];
                workspace.live_active = true;
            })
            .expect("workspace window");
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw live voice frame");
        });
        let (transcript, runtime, phase, levels, muted, active, error) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.transcript.len(),
                    workspace.runtime_id.clone(),
                    workspace.live_phase.clone(),
                    workspace.live_levels,
                    workspace.live_muted,
                    workspace.live_active,
                    workspace.live_error.clone(),
                )
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(transcript, 0);
        assert!(runtime.is_none());
        assert_eq!(phase, "listening");
        assert_eq!(levels, 0.4);
        assert!(!muted);
        assert!(active);
        assert!(error.is_none());
    }

    /// The dictation helper tracks the harness state, previews transcripts, and
    /// parks the terminal text for a single insert — all without a window or an
    /// agent runtime.
    #[test]
    fn dictation_frames_preview_and_hand_back_text_once() {
        let mut phase = String::from("idle");
        let mut capture_id: Option<String> = None;
        let mut preview = String::new();
        let mut error: Option<String> = None;
        let mut active = false;
        let mut pending: Option<String> = None;
        let mut state = DictationState {
            phase: &mut phase,
            capture_id: &mut capture_id,
            preview: &mut preview,
            error: &mut error,
            active: &mut active,
            pending_text: &mut pending,
        };

        assert!(apply_dictation_frame(
            &mut state,
            &json!({ "type": "dictation_state", "captureId": "cap-1", "state": "starting" })
        ));
        assert_eq!(*state.phase, "starting");
        assert!(*state.active);
        assert_eq!(state.capture_id.as_deref(), Some("cap-1"));

        assert!(apply_dictation_frame(
            &mut state,
            &json!({ "type": "dictation_state", "captureId": "cap-1", "state": "recording" })
        ));
        assert_eq!(*state.phase, "recording");

        assert!(apply_dictation_frame(
            &mut state,
            &json!({ "type": "dictation_transcript", "captureId": "cap-1", "text": "hello" })
        ));
        assert_eq!(*state.preview, "hello");
        assert!(state.pending_text.is_none());

        // The terminal frame hands the text over exactly once; the stop
        // response carrying the same text never reaches this state.
        assert!(apply_dictation_frame(
            &mut state,
            &json!({ "type": "dictation_end", "captureId": "cap-1", "text": "hello world" })
        ));
        assert!(!*state.active);
        assert_eq!(*state.phase, "idle");
        assert!(state.capture_id.is_none());
        assert_eq!(state.pending_text.as_deref(), Some("hello world"));
        let text = state.pending_text.take().expect("terminal text");
        assert!(state.pending_text.is_none());
        assert_eq!(append_dictation_text("draft", &text), "draft hello world");
        assert_eq!(append_dictation_text("", &text), "hello world");
        assert_eq!(
            append_dictation_text("trailing  ", &text),
            "trailing hello world"
        );

        // A failed capture reports the error and leaves the composer alone.
        assert!(apply_dictation_frame(
            &mut state,
            &json!({ "type": "dictation_state", "captureId": "cap-2", "state": "recording" })
        ));
        assert!(apply_dictation_frame(
            &mut state,
            &json!({
                "type": "dictation_end",
                "captureId": "cap-2",
                "text": "ignored",
                "error": "microphone denied",
            })
        ));
        assert_eq!(state.error.as_deref(), Some("microphone denied"));
        assert!(state.preview.is_empty());
        assert!(state.pending_text.is_none());
        assert!(!*state.active);

        // Blank text is not worth inserting, and other frames are ignored.
        assert!(apply_dictation_frame(
            &mut state,
            &json!({ "type": "dictation_end", "captureId": "cap-3", "text": "   " })
        ));
        assert!(state.pending_text.is_none());
        assert!(!apply_dictation_frame(
            &mut state,
            &json!({ "type": "agent_end" })
        ));
        assert!(!apply_dictation_frame(
            &mut state,
            &json!({ "type": "dictation_state", "captureId": "cap-4", "state": "bogus" })
        ));
        assert!(!apply_dictation_frame(
            &mut state,
            &json!({ "type": "dictation_transcript" })
        ));
    }

    /// A finished dictation is inserted into the composer by the render pass,
    /// once, and keeps whatever the user had already typed.
    #[test]
    fn finished_dictation_lands_in_the_composer_once() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, window, cx| {
                workspace.composer.update(cx, |state, cx| {
                    state.set_value("draft", window, cx);
                });
                workspace.dictation_pending_text = Some("hello world".to_string());
                workspace.layout = workspace.geometry.resolve(1600.0);
            })
            .expect("workspace window");
        // Two frames: the deferred insert runs after the first, and the second
        // proves the pending text is not inserted twice.
        for _ in 0..2 {
            cx.update(|cx| {
                cx.update_window(handle.into(), |_, window, cx| {
                    window.draw(cx).clear(cx);
                })
                .expect("draw workspace frame");
            });
        }
        let (value, pending) = handle
            .update(&mut cx, |workspace, _, cx| {
                (
                    workspace.composer.read(cx).value().to_string(),
                    workspace.dictation_pending_text.clone(),
                )
            })
            .expect("workspace window");
        cx.quit();
        assert_eq!(value, "draft hello world");
        assert!(pending.is_none());
    }

    /// The two questions every ask test builds: a single-select one with a
    /// header, a description and a recommendation, and a multi-select one.
    fn ask_questions_fixture() -> Vec<AskQuestion> {
        vec![
            AskQuestion {
                id: "q1".to_string(),
                question: "Which channel?".to_string(),
                header: Some("Release".to_string()),
                options: vec![
                    AskOption {
                        label: "Stable".to_string(),
                        description: Some("Ship the current build".to_string()),
                        preview: None,
                    },
                    AskOption {
                        label: "Beta".to_string(),
                        description: None,
                        preview: Some("beta notes".to_string()),
                    },
                ],
                multi: false,
                recommended: Some(0),
            },
            AskQuestion {
                id: "q2".to_string(),
                question: "What should OMP optimize for?".to_string(),
                header: None,
                options: vec![
                    AskOption {
                        label: "Speed".to_string(),
                        description: None,
                        preview: None,
                    },
                    AskOption {
                        label: "Safety".to_string(),
                        description: None,
                        preview: None,
                    },
                ],
                multi: true,
                recommended: None,
            },
        ]
    }

    fn ask_request_frame() -> serde_json::Value {
        json!({
            "type": "extension_ui_request",
            "id": "ask-1",
            "method": "ask",
            "questions": [
                {
                    "id": "q1",
                    "question": "Which channel?",
                    "header": "Release",
                    "options": [
                        { "label": "Stable", "description": "Ship the current build" },
                        { "label": "Beta", "preview": "beta notes" },
                    ],
                    "recommended": 0,
                },
                {
                    "id": "q2",
                    "question": "What should OMP optimize for?",
                    "options": [{ "label": "Speed" }, { "label": "Safety" }],
                    "multi": true,
                },
            ],
        })
    }

    /// Answers are built in question order, carry only labels the harness
    /// knows, and never mix a single-select option with custom text.
    #[test]
    fn ask_answers_are_built_in_question_order() {
        let questions = ask_questions_fixture();
        let mut selected: HashMap<String, Vec<String>> = HashMap::new();
        let mut custom: HashMap<String, String> = HashMap::new();

        // A single-select question needs an option or custom text first.
        assert!(!ask_answers_ready(&questions, &selected, &custom));
        selected.insert("q1".to_string(), vec!["Stable".to_string()]);
        assert!(ask_answers_ready(&questions, &selected, &custom));

        let mut dialog = AskDialog {
            request_id: "ask-1".to_string(),
            runtime_id: Some("omp-1".to_string()),
            title: "Release".to_string(),
            questions: questions.clone(),
            selected: selected.clone(),
            error: None,
        };
        assert_eq!(
            ask_submit_payload(&dialog, &custom),
            json!({
                "type": "extension_ui_response",
                "id": "ask-1",
                "answers": [
                    { "id": "q1", "selectedOptions": ["Stable"] },
                    { "id": "q2", "selectedOptions": [] },
                ],
            })
        );

        // Custom text answers a single-select question on its own and replaces
        // a stale selection; a multi-select keeps its labels and the text, and
        // unknown or repeated labels are dropped.
        custom.insert("q1".to_string(), "  Nightly  ".to_string());
        custom.insert("q2".to_string(), "Both".to_string());
        selected.insert(
            "q2".to_string(),
            vec![
                "Speed".to_string(),
                "Speed".to_string(),
                "Unknown".to_string(),
            ],
        );
        // The dialog reads its own selection map, so refresh it before asking
        // for a payload with the multi-select answer added.
        dialog.selected = selected.clone();
        assert_eq!(
            ask_submit_payload(&dialog, &custom),
            json!({
                "type": "extension_ui_response",
                "id": "ask-1",
                "answers": [
                    { "id": "q1", "selectedOptions": [], "customInput": "Nightly" },
                    { "id": "q2", "selectedOptions": ["Speed"], "customInput": "Both" },
                ],
            })
        );
        assert_eq!(
            ask_cancel_payload("ask-1"),
            json!({ "type": "extension_ui_response", "id": "ask-1", "cancelled": true })
        );

        // The parser keeps exactly what the pane draws, and refuses frames it
        // could not answer faithfully.
        assert_eq!(
            parse_ask_questions(&ask_request_frame()).expect("renderable ask"),
            questions
        );
        assert!(parse_ask_questions(&json!({ "questions": [] })).is_none());
        assert!(
            parse_ask_questions(
                &json!({ "questions": [{ "id": "q", "question": "Pick", "options": [] }] })
            )
            .is_none()
        );
        assert!(
            parse_ask_questions(&json!({
                "questions": [
                    { "id": "q", "question": "One", "options": [{ "label": "A" }] },
                    { "id": "q", "question": "Two", "options": [{ "label": "B" }] },
                ],
            }))
            .is_none()
        );
    }

    /// A grouped ask request opens the pane and draws every question; an
    /// unsupported method is dismissed without touching the pane, and a
    /// harness-side cancel closes the dialog. None of it reaches the
    /// transcript, and no agent runtime is involved.
    #[test]
    fn ask_pane_renders_a_seeded_request_without_the_transcript() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.clone(),
                    user_data_dir: root.clone(),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.layout = workspace.geometry.resolve(1600.0);
                assert!(workspace.apply_extension_ui_request("omp-1", &ask_request_frame()));
                // The drain loop notifies after applying a frame; the test
                // stands in for it so the pane is rebuilt on the next draw.
                cx.notify();
                assert_eq!(workspace.right_pane, RightPane::Ask);
                assert_eq!(workspace.transcript.len(), 0);
                let dialog = workspace.ask_dialog.as_ref().expect("ask dialog");
                assert_eq!(dialog.request_id, "ask-1");
                assert_eq!(dialog.runtime_id.as_deref(), Some("omp-1"));
                // Upstream sends no title for `ask`: the first header stands in.
                assert_eq!(dialog.title, "Release");
                assert_eq!(dialog.questions, ask_questions_fixture());
            })
            .expect("workspace window");

        // Two frames: the first builds the per-question inputs, the second
        // draws the pane with them.
        for _ in 0..2 {
            cx.update(|cx| {
                cx.update_window(handle.into(), |_, window, cx| {
                    window.draw(cx).clear(cx);
                })
                .expect("draw ask frame");
            });
        }

        handle
            .update(&mut cx, |workspace, window, cx| {
                assert_eq!(workspace.ask_inputs.len(), 2);
                assert_eq!(workspace.transcript.len(), 0);
                // Picking an option is pane state only; picking it again clears it.
                workspace.toggle_ask_option("q1", "Stable", false, window, cx);
                let dialog = workspace.ask_dialog.as_ref().expect("ask dialog");
                assert_eq!(
                    dialog.selected.get("q1").map(Vec::as_slice),
                    Some(["Stable".to_string()].as_slice())
                );
                workspace.toggle_ask_option("q1", "Stable", false, window, cx);
                let dialog = workspace.ask_dialog.as_ref().expect("ask dialog");
                assert!(dialog.selected.get("q1").is_none_or(Vec::is_empty));

                // An unsupported method is answered cancelled (no runtime here,
                // so the write fails silently) and never replaces the pane.
                assert!(workspace.apply_extension_ui_request(
                    "omp-1",
                    &json!({
                        "type": "extension_ui_request",
                        "id": "select-1",
                        "method": "select",
                        "title": "Allow tool: bash",
                        "options": ["Approve", "Deny"],
                    }),
                ));
                assert_eq!(workspace.right_pane, RightPane::Ask);
                assert_eq!(
                    workspace
                        .ask_dialog
                        .as_ref()
                        .map(|dialog| dialog.request_id.as_str()),
                    Some("ask-1")
                );
                assert_eq!(workspace.transcript.len(), 0);

                // Submit without an answer explains itself instead of sending
                // an answer the harness would reject.
                workspace.submit_ask(cx);
                assert_eq!(
                    workspace
                        .ask_dialog
                        .as_ref()
                        .and_then(|dialog| dialog.error.as_deref()),
                    Some("Answer every question before submitting.")
                );

                // A harness-side cancel closes the dialog and the pane.
                assert!(workspace.apply_extension_ui_request(
                    "omp-1",
                    &json!({
                        "type": "extension_ui_request",
                        "id": "cancel-1",
                        "method": "cancel",
                        "targetId": "ask-1",
                    }),
                ));
                assert!(workspace.ask_dialog.is_none());
                assert!(workspace.ask_inputs.is_empty());
                assert_eq!(workspace.right_pane, RightPane::Launcher);
                assert_eq!(workspace.transcript.len(), 0);
                assert_eq!(workspace.debug_snapshot(cx)["askDialog"], json!(null));
            })
            .expect("workspace window");
        cx.quit();
    }

    /// A send during a running turn that the harness cannot queue reports a
    /// clear status error, keeps the draft and never falls back to a prompt.
    #[test]
    fn running_send_without_a_queue_reports_an_error_and_keeps_the_draft() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root");
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.path().join("ui-geometry.json"),
                    home_dir: root.path().join("home"),
                    user_data_dir: root.path().join("user-data"),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, window, cx| {
                // A runtime id with no process behind it: the follow-up command
                // fails the way an unavailable API does.
                workspace.runtime_id = Some("omp-missing".to_string());
                workspace.running = true;
                let composer = workspace.composer.clone();
                composer.update(cx, |state, cx| {
                    state.set_value("second thought", window, cx);
                });

                workspace.send_prompt(window, cx);

                assert!(workspace.transcript.is_empty());
                assert_eq!(composer.read(cx).value().to_string(), "second thought");
                assert!(workspace.running);
                let error = workspace.runtime_error.as_deref().expect("status error");
                assert!(
                    error.starts_with("OMP could not queue the follow-up:"),
                    "error: {error}"
                );
                assert!(error.contains("Unknown agent runtime"), "error: {error}");
            })
            .expect("workspace window");
    }

    /// A fork with no live runtime reports the banner error and claims no
    /// status: the harness owns the fork, so there is no local fallback that
    /// could copy the session itself.
    #[test]
    fn fork_without_a_runtime_reports_the_banner_error() {
        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root");
        let handle = cx.add_window(|window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.path().join("ui-geometry.json"),
                    home_dir: root.path().join("home"),
                    user_data_dir: root.path().join("user-data"),
                    omp_executable: PathBuf::from("omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });
        handle
            .update(&mut cx, |workspace, _, cx| {
                // Nothing is selected, so there is no runtime to fork on.
                workspace.session_menu_action("Fork session", cx);
                let error = workspace.runtime_error.as_deref().expect("status error");
                assert!(
                    error.starts_with("OMP could not fork the session:"),
                    "error: {error}"
                );
                assert!(error.contains("no live session"), "error: {error}");
                assert_eq!(workspace.fork_status, None);
                assert!(!workspace.menu_open);
                assert!(workspace.transcript.is_empty());

                // A runtime id with no process behind it fails the way the
                // unavailable API does, and the banner says the same thing.
                workspace.runtime_id = Some("omp-missing".to_string());
                workspace.session_menu_action("Fork session", cx);
                let error = workspace.runtime_error.as_deref().expect("status error");
                assert!(
                    error.starts_with("OMP could not fork the session:"),
                    "error: {error}"
                );
                assert!(error.contains("Unknown agent runtime"), "error: {error}");
                assert_eq!(workspace.fork_status, None);
            })
            .expect("workspace window");
    }

    /// A plain run for the math-splitter cases.
    fn plain_run(text: &str) -> MathSegment {
        MathSegment {
            kind: MathSegmentKind::Text,
            text: text.to_string(),
        }
    }

    /// An inline `$…$` run, its delimiters stripped.
    fn inline_run(text: &str) -> MathSegment {
        MathSegment {
            kind: MathSegmentKind::InlineMath,
            text: text.to_string(),
        }
    }

    /// A display `$$…$$` run, its delimiters stripped.
    fn display_run(text: &str) -> MathSegment {
        MathSegment {
            kind: MathSegmentKind::DisplayMath,
            text: text.to_string(),
        }
    }

    /// `$…$` and `$$…$$` become their own runs, display first, and joining the
    /// runs back puts every delimiter where the message had it.
    #[test]
    fn todo_tool_result_parses_phases_and_statuses() {
        let text = "Remaining items (1):\n  - task2 [in_progress] (phase A)\nOverall: 1/3 done, 2 open.\nActive phase 1/2 \"phase A\" (1/2).\n  phase A:\n    - [X] task1\n    - [ ] task2 (in progress)\n  phase B:\n    - [ ] task3\n";
        let phases = parse_todo_tool_result(text);
        assert_eq!(phases.len(), 2);
        assert_eq!(phases[0].name, "phase A");
        assert_eq!(phases[0].tasks.len(), 2);
        assert_eq!(phases[0].tasks[0].content, "task1");
        assert_eq!(phases[0].tasks[0].status, TodoStatus::Completed);
        assert_eq!(phases[0].tasks[1].content, "task2");
        assert_eq!(phases[0].tasks[1].status, TodoStatus::InProgress);
        assert_eq!(phases[1].name, "phase B");
        assert_eq!(phases[1].tasks[0].status, TodoStatus::Pending);
    }

    #[test]
    fn math_segments_split_inline_and_display_runs() {
        let text = "area is $x^2$ and $$y$$ wide";
        let segments = math_segments(text);
        assert_eq!(
            segments,
            [
                plain_run("area is "),
                inline_run("x^2"),
                plain_run(" and "),
                display_run("y"),
                plain_run(" wide"),
            ]
        );
        // The copy output is this join: the split never rewrites the message.
        assert_eq!(math_plain_text(&segments), text);
        // Copying reads the part as written, so drawing is the only thing that
        // splits.
        assert_eq!(transcript_part_text(&TranscriptPart::text(text)), text);
    }

    /// Text with no math is one run holding the original string; unmatched,
    /// empty and escaped markers stay the words the message had.
    #[test]
    fn math_segments_leave_plain_and_malformed_text_alone() {
        assert_eq!(math_segments("just words"), [plain_run("just words")]);
        assert_eq!(math_segments(""), []);
        assert_eq!(math_segments("cost is $5"), [plain_run("cost is $5")]);
        assert_eq!(math_segments("$$"), [plain_run("$$")]);
        assert_eq!(math_segments("$$y$"), [plain_run("$$y$")]);
        assert_eq!(math_segments(r"cost is \$5"), [plain_run(r"cost is \$5")]);
        // A dollar escaped inside the body closes nothing.
        assert_eq!(math_segments(r"$a\$b$"), [inline_run(r"a\$b")]);
        assert_eq!(math_plain_text(&math_segments(r"$a\$b$")), r"$a\$b$");
    }

    /// Every marker in a part splits, and adjacent spans keep nothing between
    /// them.
    #[test]
    fn math_segments_split_multiple_runs() {
        assert_eq!(
            math_segments("$a$ $b$"),
            [inline_run("a"), plain_run(" "), inline_run("b")]
        );
        assert_eq!(
            math_segments("$$a$$$$b$$"),
            [display_run("a"), display_run("b")]
        );
        assert_eq!(
            math_segments("$a^2$ then $$b$$ then $c$"),
            [
                inline_run("a^2"),
                plain_run(" then "),
                display_run("b"),
                plain_run(" then "),
                inline_run("c"),
            ]
        );
        assert_eq!(
            math_plain_text(&math_segments("$a^2$ then $$b$$ then $c$")),
            "$a^2$ then $$b$$ then $c$"
        );
    }

    /// The at-bottom reading has a little slack, treats a view that never laid
    /// out or cannot scroll as pinned, and notices a reader who scrolled up.
    #[test]
    fn transcript_at_bottom_threshold_reads_the_scroll_gap() {
        const SLACK: f32 = 24.0;
        // An empty transcript, or one whose scroll area has no height yet, has
        // no bottom to be away from.
        assert!(transcript_is_at_bottom(0.0, 0.0, 600.0, SLACK));
        assert!(transcript_is_at_bottom(-120.0, 0.0, 600.0, SLACK));
        assert!(transcript_is_at_bottom(0.0, 500.0, 0.0, SLACK));
        // At the bottom the offset equals the range; a few pixels up is still
        // the bottom, while most of a viewport is not.
        assert!(transcript_is_at_bottom(-500.0, 500.0, 600.0, SLACK));
        assert!(transcript_is_at_bottom(-480.0, 500.0, 600.0, SLACK));
        assert!(!transcript_is_at_bottom(-400.0, 500.0, 600.0, SLACK));
        assert!(!transcript_is_at_bottom(0.0, 500.0, 600.0, SLACK));
    }

    /// The transcript follows its newest row while the reader stays at the
    /// bottom; a scroll up stops the follow and draws the jump control, and a
    /// click on that control re-pins the view. Frames are really drawn, so the
    /// scroll handle has the bounds and range the workspace reads.
    #[test]
    fn transcript_follows_the_tail_until_the_reader_scrolls_up() {
        use gpui_kit::test::TestEventExt as _;
        use gpui_kit::{
            InputEvent as _, MouseButton, ScrollDelta, ScrollEvent, ScrollSource, TouchPhase,
            point, px, size,
        };

        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
            Workspace::new(
                window,
                cx,
                WorkspaceData {
                    geometry: UiGeometry::default(),
                    geometry_path: root.join("ui-geometry.json"),
                    home_dir: root.join("home"),
                    user_data_dir: root.join("user-data"),
                    omp_executable: root.join("missing-omp"),
                    settings: AppSettings::default(),
                    projects: Vec::new(),
                    sessions: Vec::new(),
                },
            )
        });

        // A transcript long enough to scroll. The rows are pushed directly
        // because this case is about the scroll state, not about a session read.
        handle
            .update(&mut cx, |workspace, _, cx| {
                for index in 0..40 {
                    workspace.transcript.push(TranscriptMessage {
                        id: format!("user-{index}"),
                        role: "user".to_string(),
                        timestamp: None,
                        agent_name: None,
                        parts: vec![TranscriptPart::text(format!(
                            "message {index} {}",
                            "padding ".repeat(24)
                        ))],
                    });
                }
                // The same tail-follow a session read performs.
                workspace.follow_transcript_tail();
                cx.notify();
            })
            .expect("workspace window");

        let draw = |cx: &mut gpui_kit::TestAppContext| {
            cx.update(|cx| {
                cx.update_window(handle.into(), |_, window, cx| {
                    window.draw(cx).clear(cx);
                })
                .expect("frame");
            });
        };
        draw(&mut cx);

        let (at_bottom, offset, max_offset, bounds) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.transcript_at_bottom,
                    workspace.transcript_scroll.offset(),
                    workspace.transcript_scroll.max_offset(),
                    workspace.transcript_scroll.bounds(),
                )
            })
            .expect("scroll state");
        assert!(
            f32::from(max_offset.y) > 0.0,
            "the transcript has to overflow for this case"
        );
        assert!(at_bottom);
        assert_eq!(offset.y, -max_offset.y);

        // A wheel event over the rows scrolls up and unpins the follow.
        let position = bounds.center();
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.dispatch_event(
                    ScrollEvent {
                        position,
                        delta: ScrollDelta::Pixels(point(px(0.0), px(120.0))),
                        modifiers: Default::default(),
                        touch_phase: TouchPhase::Moved,
                        source: ScrollSource::Pointer,
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .expect("scroll frame");
        });
        draw(&mut cx);
        let (at_bottom, offset) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.transcript_at_bottom,
                    workspace.transcript_scroll.offset(),
                )
            })
            .expect("scroll state");
        assert!(!at_bottom, "scrolling up has to unpin the follow");
        let gap = f32::from(offset.y) + f32::from(max_offset.y);
        assert!(
            (gap - 120.0).abs() < 1.0,
            "the wheel delta has to reach the transcript, gap: {gap}"
        );
        let scrolled_offset = offset;

        // A row that arrives while the reader is up there must not yank them.
        handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.append_assistant_delta("text_delta", "a new reply");
                cx.notify();
            })
            .expect("append");
        draw(&mut cx);
        let (at_bottom, offset) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.transcript_at_bottom,
                    workspace.transcript_scroll.offset(),
                )
            })
            .expect("scroll state");
        assert!(!at_bottom);
        assert_eq!(
            offset.y, scrolled_offset.y,
            "an append must not move a scrolled reader"
        );

        // The jump control is the button drawn over the bottom of the rows;
        // clicking it re-pins and lands on the newest row.
        let bounds = handle
            .update(&mut cx, |workspace, _, _| {
                workspace.transcript_scroll.bounds()
            })
            .expect("scroll state");
        let click = point(bounds.center().x, bounds.bottom() - px(28.0));
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.pointer_down(click, MouseButton::Left, cx);
                window.pointer_up(click, MouseButton::Left, cx);
            })
            .expect("click frame");
        });
        draw(&mut cx);
        let (at_bottom, offset, max_offset) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.transcript_at_bottom,
                    workspace.transcript_scroll.offset(),
                    workspace.transcript_scroll.max_offset(),
                )
            })
            .expect("scroll state");
        assert!(at_bottom, "the jump control has to re-pin the follow");
        // The last row is scrolled into view; the scroll area's own bottom
        // padding stays below the fold, so the gap is at most that padding.
        let gap = f32::from(offset.y) + f32::from(max_offset.y);
        assert!(
            (0.0..=TRANSCRIPT_BOTTOM_THRESHOLD).contains(&gap),
            "jump left a gap of {gap}"
        );

        // Pinned again, the next streamed delta follows the tail.
        handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.append_assistant_delta("text_delta", " and more");
                cx.notify();
            })
            .expect("append");
        draw(&mut cx);
        let (at_bottom, offset, max_offset) = handle
            .update(&mut cx, |workspace, _, _| {
                (
                    workspace.transcript_at_bottom,
                    workspace.transcript_scroll.offset(),
                    workspace.transcript_scroll.max_offset(),
                )
            })
            .expect("scroll state");
        assert!(at_bottom);
        let gap = f32::from(offset.y) + f32::from(max_offset.y);
        assert!(
            (0.0..=TRANSCRIPT_BOTTOM_THRESHOLD).contains(&gap),
            "follow left a gap of {gap}"
        );
    }

    /// A re-read of a changed session file carries the rows the view minted
    /// itself: a queued follow-up and a reply still streaming survive an
    /// external append instead of being erased by the file's own copy.
    #[test]
    fn external_reload_keeps_queued_and_streaming_rows() {
        use std::io::Write as _;

        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let root = tempfile::TempDir::new().expect("test root").keep();
        let home = root.join("home");
        let bucket = home.join(".omp/agent/sessions/-omp-project");
        std::fs::create_dir_all(&bucket).expect("session bucket");
        let project = root.join("project");
        let at = "2026-04-01T01:00:00.000Z";
        let path =
            bucket.join("2026-04-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000091.jsonl");
        let title = json!({
            "type": "title",
            "v": 1,
            "title": "Live",
            "updatedAt": at,
            "pad": "",
        });
        let header = json!({
            "type": "session",
            "version": 3,
            "id": "Live",
            "timestamp": at,
            "cwd": project.display().to_string(),
        });
        let user = json!({
            "type": "message",
            "id": "u1",
            "parentId": null,
            "timestamp": at,
            "message": { "role": "user", "content": "hello" },
        });
        std::fs::write(&path, format!("{title}\n{header}\n{user}\n")).expect("session file");

        let record = omp_core::sessions::SessionRecord {
            id: "live".to_string(),
            harness: "omp".to_string(),
            file_path: path.display().to_string(),
            project_path: project.display().to_string(),
            title: "Live".to_string(),
            created_at: at.to_string(),
            updated_at: at.to_string(),
            last_user_message_at: None,
            status: "complete".to_string(),
            model: None,
            provider: None,
            thinking_level: None,
            depth: 0,
            parent_session: None,
            last_user_texts: Vec::new(),
            pinned: false,
            unread: false,
            preview: None,
            archived: false,
        };
        let handle = cx.add_window({
            let root = root.clone();
            move |window, cx| {
                Workspace::new(
                    window,
                    cx,
                    WorkspaceData {
                        geometry: UiGeometry::default(),
                        geometry_path: root.join("ui-geometry.json"),
                        home_dir: root.join("home"),
                        user_data_dir: root.join("user-data"),
                        omp_executable: root.join("missing-omp"),
                        settings: AppSettings::default(),
                        projects: Vec::new(),
                        sessions: vec![record],
                    },
                )
            }
        });

        handle
            .update(&mut cx, |workspace, window, cx| {
                workspace.select_session(0, cx);
                assert_eq!(workspace.transcript.len(), 1);
                // A draft, a queued follow-up and a streamed reply: the three
                // things an external write must not take away.
                workspace
                    .composer
                    .update(cx, |state, cx| state.set_value("keep me", window, cx));
                workspace.transcript.push(TranscriptMessage {
                    id: "queued-1".to_string(),
                    role: "user".to_string(),
                    timestamp: None,
                    agent_name: None,
                    parts: vec![TranscriptPart {
                        kind: "queued".to_string(),
                        text: Some("follow up".to_string()),
                        ..TranscriptPart::text("")
                    }],
                });
                workspace.transcript.push(TranscriptMessage {
                    id: "assistant-2".to_string(),
                    role: "assistant".to_string(),
                    timestamp: None,
                    agent_name: None,
                    parts: vec![TranscriptPart::text("partial reply")],
                });
                workspace.streaming_index = Some(2);
                workspace.running = true;
            })
            .expect("seed rows");

        let external = json!({
            "type": "message",
            "id": "u2",
            "parentId": "u1",
            "timestamp": at,
            "message": { "role": "user", "content": "written by another process" },
        });
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open session file");
        file.write_all(format!("{external}\n").as_bytes())
            .expect("append entry");
        drop(file);

        handle
            .update(&mut cx, |workspace, _, cx| {
                workspace.check_transcript_external_change(cx);
                let ids: Vec<&str> = workspace
                    .transcript
                    .iter()
                    .map(|message| message.id.as_str())
                    .collect();
                assert_eq!(ids, ["u1", "u2", "queued-1", "assistant-2"]);
                // The streamed reply keeps its slot, so the next delta grows it.
                assert_eq!(workspace.streaming_index, Some(3));
                assert_eq!(workspace.transcript_reloads, 1);
                assert!(workspace.transcript_at_bottom);
                assert_eq!(workspace.transcript_error(), None);
                assert_eq!(workspace.composer.read(cx).value().to_string(), "keep me");
            })
            .expect("reload");
    }

    /// A part with math draws as wrapped spans: a long message in a narrow row
    /// wraps over several lines instead of overflowing sideways. The probe that
    /// sized this also showed each math run in its own box — an inline chip on
    /// a text line, a display chip across the row.
    #[test]
    fn transcript_math_part_wraps_inside_its_row() {
        use gpui_kit::InteractiveElement as _;
        use gpui_kit::component::ActiveTheme as _;
        use gpui_kit::{AvailableSpace, ParentElement as _, Styled as _, div, point, px, size};

        use super::transcript_part_element;

        let mut cx = gpui_kit::TestAppContext::single();
        cx.update(gpui_kit::init);
        let window = cx.add_empty_window();
        let colors = window.update(|_, cx| cx.theme().colors);
        let part = TranscriptPart::text(
            "the area under the curve is $x^2$ and it grows without bound as the interval widens $$y$$ end of the message",
        );
        window.draw(
            point(px(0.0), px(0.0)),
            size(
                AvailableSpace::Definite(px(240.0)),
                AvailableSpace::Definite(px(600.0)),
            ),
            |_, _| {
                div()
                    .w(px(240.0))
                    .debug_selector(|| "math-part".to_string())
                    .child(transcript_part_element(&part, "assistant", colors))
            },
        );
        let bounds = window.debug_bounds("math-part").expect("part bounds");
        // One unwrapped line is about 25px, so a taller row proves the spans
        // wrapped inside the width instead of running past it.
        assert!(
            bounds.size.height > px(36.0),
            "math part did not wrap: {:?}",
            bounds.size.height
        );
        assert_eq!(bounds.size.width, px(240.0));
    }
}
