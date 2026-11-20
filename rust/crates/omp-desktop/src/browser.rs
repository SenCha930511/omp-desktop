//! The Browser pane: a real native webview embedded in the right pane.
//!
//! Platform notes, from the `gpui-webview` README, which this pane has to honour:
//!
//! * macOS (WKWebView) and Linux X11 (WebKitGTK) host the native view in a window
//!   composition surface because this app builds GPUI Fast, so GPUI content still renders
//!   above the page.
//! * Windows (WebView2) has no composition support yet: the native view covers everything
//!   inside its bounds, popovers included. The pane therefore stays flat, and the workspace
//!   does not open its Overview or session popovers over it.
//! * Native Wayland is unsupported. `main` starts Linux on X11/XWayland.
//!
//! Each tab owns its own webview, created lazily on the UI thread, and the pane keeps only
//! the active tab's view on screen. All of them are owned by the [`Workspace`], so they are
//! dropped with the window.
//!
//! Every tab also gets an isolated profile under `<user data dir>/browser-tabs/<tab-id>`:
//! wry gives that directory to WebView2 and WebKitGTK, while macOS names a per-tab WKWebView
//! data store instead, because WKWebView has no data directory. Closing a tab removes the
//! directory best-effort, so one page's cookies and storage never reach another tab; a named
//! WKWebView store is not a directory, so the system keeps it.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use async_channel::Sender;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, ThemeColor};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_webview::WebView;
use omp_core::url_policy::parse_http_url;
use serde_json::Value;
#[cfg(target_os = "macos")]
use wry::WebViewBuilderExtDarwin as _;
use wry::{WebContext, WebViewBuilder};

use crate::app::Workspace;

/// The page shown until the address bar opens something.
const BLANK_PAGE: &str = "about:blank";

/// The `kind` an IPC message must carry to be read as an element annotation.
const CAPTURE_KIND: &str = "omp-element-annotation";

/// Longest page text kept in an annotation.
const MAX_ANNOTATION_TEXT: usize = 200;

/// Turn what the user typed into the URL to load.
///
/// A bare host (`example.com`, `localhost:8080/x`) gets `https://`; anything carrying a
/// scheme goes through [`parse_http_url`], which only accepts http/https without
/// credentials, so `file:`, `javascript:` and `https://user:pass@host` are refused.
pub fn normalize_address(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Enter a URL to open.".to_string());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    parse_http_url(&candidate, "Address")
        .map(|url| url.to_string())
        .map_err(|error| error.message)
}

/// JavaScript that arms the element picker for the Capture button.
///
/// wry's `evaluate_script` callback does not await promises on any platform, so the picker
/// cannot resolve the click inside the evaluated script. It arms a one-shot picker instead:
/// hovering outlines the element under the pointer, the next click posts the annotation
/// through `window.ipc`, and the snippet returns `'armed'` synchronously.
pub fn annotation_script() -> &'static str {
    r#"(() => {
  const KEY = '__ompElementAnnotation';
  const previous = window[KEY];
  if (previous && previous.cancel) previous.cancel();
  const restore = (element) => {
    if (!element) return;
    element.style.outline = element.__ompOutline || '';
    element.style.outlineOffset = element.__ompOutlineOffset || '';
    delete element.__ompOutline;
    delete element.__ompOutlineOffset;
  };
  let hovered = null;
  const highlight = (element) => {
    if (hovered === element) return;
    restore(hovered);
    hovered = element;
    if (!element) return;
    element.__ompOutline = element.style.outline;
    element.__ompOutlineOffset = element.style.outlineOffset;
    element.style.outline = '2px solid #4f9cf9';
    element.style.outlineOffset = '1px';
  };
  const cssEscape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value);
  const selectorFor = (element) => {
    if (element.id) return '#' + cssEscape(element.id);
    const testId = element.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
    const label = element.getAttribute('aria-label');
    if (label) return '[aria-label="' + label.replace(/"/g, '\\"') + '"]';
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 4) {
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const textFor = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const cleanup = () => {
    highlight(null);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    delete window[KEY];
  };
  const onMove = (event) => highlight(event.target instanceof Element ? event.target : null);
  const onClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const element = event.target instanceof Element ? event.target : null;
    const rect = element ? element.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const annotation = {
      selector: element ? selectorFor(element) : '',
      tag: element ? element.tagName.toLowerCase() : 'element',
      text: element ? textFor(element) : '',
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    cleanup();
    try {
      window.ipc.postMessage(JSON.stringify({ kind: 'omp-element-annotation', annotation: annotation }));
    } catch {}
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    cleanup();
    try {
      window.ipc.postMessage(JSON.stringify({ kind: 'omp-element-annotation', cancelled: true }));
    } catch {}
  };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window[KEY] = { cancel: cleanup };
  return 'armed';
})();"#
}

/// Format the annotation a page posted into one compact line for the composer.
///
/// `raw` is the `annotation` object of the IPC envelope tagged [`CAPTURE_KIND`], which the
/// picker installed by [`annotation_script`] posts on its click.
pub fn format_annotation(raw: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("The page sent an unreadable element annotation: {error}"))?;
    let selector = annotation_field(&value, "selector")
        .ok_or_else(|| "The page sent an element annotation without a selector.".to_string())?;
    let tag = annotation_field(&value, "tag").unwrap_or("element");
    let text: String = annotation_field(&value, "text")
        .unwrap_or_default()
        .chars()
        .take(MAX_ANNOTATION_TEXT)
        .collect();
    let rect = value.get("rect");
    let coordinate = |key: &str| {
        rect.and_then(|rect| rect.get(key))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    Ok(format!(
        "Element: {selector} ({tag}) \"{text}\" at {:.0},{:.0},{:.0},{:.0}",
        coordinate("x"),
        coordinate("y"),
        coordinate("width"),
        coordinate("height")
    ))
}

/// Append a captured annotation to the composer draft instead of replacing it.
pub fn append_annotation(draft: &str, annotation: &str) -> String {
    let draft = draft.trim_end();
    if draft.trim().is_empty() {
        annotation.to_string()
    } else {
        format!("{draft} {annotation}")
    }
}

fn annotation_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|field| !field.is_empty())
}

/// What the picker asked the pane to do, or `None` for any other message a page posts.
enum PostedCapture {
    /// The picker was dismissed with Escape; there is nothing to insert.
    Cancelled,
    /// The annotation object the picker captured on its click.
    Annotation(String),
}

fn capture_from_message(message: &str) -> Option<PostedCapture> {
    let value: Value = serde_json::from_str(message).ok()?;
    if value.get("kind").and_then(Value::as_str) != Some(CAPTURE_KIND) {
        return None;
    }
    if value.get("cancelled").and_then(Value::as_bool) == Some(true) {
        return Some(PostedCapture::Cancelled);
    }
    Some(PostedCapture::Annotation(
        value.get("annotation")?.to_string(),
    ))
}

/// What one tab's page reported back after the Capture button armed its picker.
///
/// Messages name the tab by id, not index: a tab closed or selected meanwhile must
/// not hand its annotation to the wrong page.
enum CaptureMessage {
    /// Result of the arming `evaluate_script`; empty when the page refused it.
    Armed { tab: u64, result: String },
    /// An IPC message posted by that tab's picker.
    Posted { tab: u64, message: String },
}

/// One page in the Browser pane.
///
/// Each tab owns its native webview, so switching tabs hides a loaded page instead of
/// reloading it, and closing a tab drops (and hides) its view. `id` names the tab in
/// IPC messages: indices shift when a tab closes, ids do not.
///
/// Each tab also owns an isolated profile directory: wry takes its user data folder (or
/// WebKit data manager) from the context the tab built its webview with, so one page's
/// cookies and storage never reach another tab.
pub struct BrowserTab {
    id: u64,
    webview: Option<Entity<WebView>>,
    /// The context the webview was built with; wry asks it to outlive its webview.
    web_context: Option<WebContext>,
    /// This tab's isolated profile, removed when the tab closes.
    data_dir: PathBuf,
    url: String,
    error: Option<String>,
    annotation: Option<String>,
}

impl BrowserTab {
    fn new(id: u64, url: &str, data_dir: PathBuf) -> Self {
        Self {
            id,
            webview: None,
            web_context: None,
            data_dir,
            url: url.to_string(),
            error: None,
            annotation: None,
        }
    }

    /// What the address bar shows for this tab: the blank page reads as an empty
    /// field, so the placeholder shows through.
    fn address(&self) -> String {
        if self.url == BLANK_PAGE {
            String::new()
        } else {
            self.url.clone()
        }
    }
}

/// The label a tab shows: the page's host, or "New tab" until one loads.
pub fn tab_label(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed == BLANK_PAGE {
        return "New tab".to_string();
    }
    parse_http_url(trimmed, "Tab")
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| trimmed.to_string())
}

/// The tab to select after `closing` leaves `len - 1` tabs, or `None` when the last
/// tab closed and the pane falls back to its blank state.
///
/// Closing the active tab selects the one that slides into its place, falling back to
/// the tab before it; closing an earlier tab shifts the active index down with it.
pub fn tab_after_close(active: usize, closing: usize, len: usize) -> Option<usize> {
    if len <= 1 {
        return None;
    }
    let remaining = len - 1;
    let next = if closing < active {
        active - 1
    } else if closing == active {
        active.min(remaining - 1)
    } else {
        active
    };
    Some(next.min(remaining - 1))
}

/// The subdirectory of the app's user data dir that holds one profile per tab.
const BROWSER_TABS_DIR: &str = "browser-tabs";

/// The directory one tab's profile lives in: `<root>/<tab-id>`.
///
/// A tab's cookies and storage stay in its own directory, so they never reach another
/// tab, and a tab that reuses the id later starts from a clean profile once the closed
/// tab's directory is gone.
pub fn tab_data_dir(root: &Path, id: u64) -> PathBuf {
    root.join(id.to_string())
}

/// The app's user data dir, resolved the way `main` resolves it.
///
/// The pane is built before `WorkspaceData` reaches the `Workspace`, so it cannot read the
/// directory `main` already picked. It repeats that resolution here, `--user-data-dir=`
/// override included, so both point at the same place.
fn user_data_dir() -> Option<PathBuf> {
    let arg_dir = std::env::args()
        .find_map(|arg| arg.strip_prefix("--user-data-dir=").map(PathBuf::from))
        .filter(|dir| !dir.as_os_str().is_empty());
    if let Some(dir) = arg_dir {
        return Some(dir);
    }
    #[cfg(target_os = "macos")]
    let dir = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support/OMP Desktop Rust Dev"));
    #[cfg(windows)]
    let dir =
        std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("OMP Desktop Rust Dev"));
    #[cfg(not(any(target_os = "macos", windows)))]
    let dir = std::env::var_os("XDG_DATA_HOME")
        .map(|dir| PathBuf::from(dir).join("omp-desktop-rust-dev"))
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join(".local/share/omp-desktop-rust-dev"))
        });
    dir
}

/// Where the pane keeps its per-tab profiles: under the app's user data dir, or in the
/// system temp dir when no user data dir can be named.
fn profiles_root() -> PathBuf {
    user_data_dir()
        .map(|dir| dir.join(BROWSER_TABS_DIR))
        .unwrap_or_else(|| std::env::temp_dir().join("omp-desktop-browser-tabs"))
}

/// WKWebView has no data directory, so a tab names a custom data store instead.
///
/// The first eight bytes tag the store as this app's; the rest is the tab id, so the store
/// is as stable as the tab's directory name.
#[cfg(target_os = "macos")]
fn tab_data_store_identifier(id: u64) -> [u8; 16] {
    let mut identifier = [0u8; 16];
    identifier[..8].copy_from_slice(b"omp-tab-");
    identifier[8..].copy_from_slice(&id.to_be_bytes());
    identifier
}

/// Address bar, tab bar, history controls and the native webviews of the Browser pane.
///
/// Only the active tab's webview is drawn; the others stay loaded but hidden.
pub struct BrowserPane {
    address: Entity<InputState>,
    _address_subscription: Subscription,
    tabs: Vec<BrowserTab>,
    /// Root of the per-tab profiles; resolved once, when the pane is built.
    profiles_root: PathBuf,
    active_tab: usize,
    /// The id the next tab takes; ids survive the index shifts of closing tabs.
    next_tab_id: u64,
    navigate_requested: bool,
    /// Feeds the arming result and the posted annotation into the drain task.
    capture_sender: Sender<CaptureMessage>,
    /// The tab whose element picker is armed, waiting for its click.
    capture_tab: Option<u64>,
    _capture_task: Task<()>,
}

impl BrowserPane {
    pub fn new(window: &mut Window, cx: &mut Context<Workspace>) -> Self {
        let address = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("https://example.com")
                .submit_on_enter(true)
        });
        let address_subscription =
            cx.subscribe(&address, |workspace, _, event: &InputEvent, cx| {
                if let InputEvent::PressEnter {
                    secondary: false, ..
                } = event
                {
                    workspace.browser.request_navigate();
                    cx.notify();
                }
            });
        // The picker's result arrives on a channel: the native callback fires on the webview's
        // own thread, so it only queues a message and the drain task below does the rest.
        let (capture_sender, capture_results) = async_channel::unbounded();
        let capture_task = cx.spawn(async move |this, cx| {
            while let Ok(message) = capture_results.recv().await {
                match message {
                    CaptureMessage::Armed { tab, result } => {
                        let _ = this.update(cx, |workspace, cx| {
                            if workspace.browser.apply_armed(tab, &result) {
                                cx.notify();
                            }
                        });
                    }
                    CaptureMessage::Posted { tab, message } => {
                        let _ = this.update(cx, |workspace, cx| {
                            if workspace.browser.apply_posted(tab, &message) {
                                cx.notify();
                            }
                        });
                    }
                }
            }
        });
        Self {
            address,
            _address_subscription: address_subscription,
            tabs: Vec::new(),
            profiles_root: profiles_root(),
            active_tab: 0,
            next_tab_id: 1,
            navigate_requested: false,
            capture_sender,
            capture_tab: None,
            _capture_task: capture_task,
        }
    }

    /// Give the pane a tab to open when it is first shown.
    ///
    /// The webview itself needs a window, so it is built later, from `render` or the
    /// tab's own click. Closing the last tab leaves the pane empty on purpose: only
    /// this, a click on `+`, or a navigation starts a new one.
    pub fn prepare(&mut self) {
        if self.tabs.is_empty() {
            self.push_tab();
        }
    }

    /// Create the active tab's webview if it does not have one yet.
    ///
    /// `WebView::build` attaches the native view to the GPUI window, so it has to run
    /// on the UI thread while the window is alive.
    pub fn ensure(&mut self, window: &mut Window, cx: &mut Context<Workspace>) {
        if self.tabs.is_empty() {
            self.push_tab();
        }
        let Some(tab) = self.tabs.get(self.active_tab) else {
            return;
        };
        if tab.webview.is_some() {
            return;
        }
        let id = tab.id;
        let data_dir = tab.data_dir.clone();
        let sender = self.capture_sender.clone();
        // The directory exists before the webview does, so a build that fails leaves
        // nothing behind and a tab that closes always has a profile to clean up.
        let _ = std::fs::create_dir_all(&data_dir);
        // WebKitGTK's WebContext creates a GTK application info object, so GTK must
        // already be initialized before the context is built. `WebView::build` would
        // initialize it later, which is too late for the context.
        #[cfg(target_os = "linux")]
        if let Err(error) = ensure_gtk_for_webview() {
            if let Some(tab) = self.tab_mut(id) {
                tab.error = Some(error);
            }
            return;
        }
        // wry reads the profile from the context: WebView2's user data folder and
        // WebKitGTK's data manager both come from it, so this tab's cookies and storage
        // stay in `data_dir` instead of the engine's default profile.
        let mut context = WebContext::new(Some(data_dir.clone()));
        let builder = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(BLANK_PAGE)
            .with_ipc_handler(move |request: wry::http::Request<String>| {
                // Pages may post anything, so the drain task filters by the envelope kind.
                let _ = sender.try_send(CaptureMessage::Posted {
                    tab: id,
                    message: request.into_body(),
                });
            });
        // WKWebView has no data directory, so on macOS the tab names a custom data store
        // instead. It is as stable as the tab's directory name.
        #[cfg(target_os = "macos")]
        let builder = builder.with_data_store_identifier(tab_data_store_identifier(id));
        match WebView::build(builder, window, cx) {
            Ok(webview) => {
                if let Some(tab) = self.tab_mut(id) {
                    tab.webview = Some(cx.new(|_| webview));
                    tab.web_context = Some(context);
                    tab.error = None;
                }
            }
            Err(error) => {
                if let Some(tab) = self.tab_mut(id) {
                    tab.error = Some(format!("The native webview could not start: {error}"));
                }
                let _ = std::fs::remove_dir_all(&data_dir);
            }
        }
    }

    /// Whether the pane still has to build its active tab's webview.
    ///
    /// An empty pane is not pending: it waits for `+` or a navigation, so leaving it
    /// blank does not send `render` into building a view every frame.
    pub fn needs_webview(&self) -> bool {
        self.tabs
            .get(self.active_tab)
            .is_some_and(|tab| tab.webview.is_none() && tab.error.is_none())
    }

    pub fn tab_count(&self) -> usize {
        self.tabs.len()
    }

    pub fn active_tab(&self) -> usize {
        self.active_tab
    }

    pub fn request_navigate(&mut self) {
        self.navigate_requested = true;
    }

    pub fn take_navigate_request(&mut self) -> bool {
        std::mem::take(&mut self.navigate_requested)
    }

    /// Add an about:blank tab, make it active and build its webview.
    pub fn new_tab(&mut self, window: &mut Window, cx: &mut Context<Workspace>) {
        self.push_tab();
        self.ensure(window, cx);
        self.sync_address(window, cx);
        cx.notify();
    }

    /// Make `index` the tab the pane draws, sends navigation to and captures from.
    pub fn select_tab(&mut self, index: usize, window: &mut Window, cx: &mut Context<Workspace>) {
        if index >= self.tabs.len() || index == self.active_tab {
            return;
        }
        self.active_tab = index;
        self.sync_address(window, cx);
        cx.notify();
    }

    /// Close one tab, selecting the nearest remaining one. Closing the last tab
    /// leaves the pane's blank state, where `+` or an address starts a new one.
    pub fn close_tab(&mut self, index: usize, window: &mut Window, cx: &mut Context<Workspace>) {
        let len = self.tabs.len();
        if index >= len {
            return;
        }
        let BrowserTab {
            id: closed,
            webview,
            web_context,
            data_dir,
            ..
        } = self.tabs.remove(index);
        if self.capture_tab == Some(closed) {
            self.capture_tab = None;
        }
        // The profile can only go once nothing holds it: drop the native view and its
        // context first. A directory an engine still has open (Windows keeps the WebView2
        // folder for a moment after the view goes) is left behind rather than reported.
        drop(webview);
        drop(web_context);
        let _ = std::fs::remove_dir_all(&data_dir);
        match tab_after_close(self.active_tab, index, len) {
            Some(next) => self.active_tab = next,
            None => self.active_tab = 0,
        }
        self.sync_address(window, cx);
        cx.notify();
    }

    fn push_tab(&mut self) {
        let id = self.next_tab_id;
        self.next_tab_id += 1;
        let data_dir = tab_data_dir(&self.profiles_root, id);
        self.tabs.push(BrowserTab::new(id, BLANK_PAGE, data_dir));
        self.active_tab = self.tabs.len() - 1;
    }

    fn tab_mut(&mut self, id: u64) -> Option<&mut BrowserTab> {
        self.tabs.iter_mut().find(|tab| tab.id == id)
    }

    /// Show the active tab's address, or clear the field for the blank page.
    fn sync_address(&self, window: &mut Window, cx: &mut Context<Workspace>) {
        let value = self
            .tabs
            .get(self.active_tab)
            .map(BrowserTab::address)
            .unwrap_or_default();
        let address = self.address.clone();
        address.update(cx, |state, cx| state.set_value(value, window, cx));
    }

    /// Arm the element picker in the active page; the next click there inserts an
    /// annotation. The result names the tab, so switching tabs mid-capture keeps it.
    pub fn start_capture(&mut self, cx: &mut Context<Workspace>) {
        self.capture_tab = None;
        let Some(tab) = self.tabs.get(self.active_tab) else {
            cx.notify();
            return;
        };
        let id = tab.id;
        let Some(webview) = tab.webview.clone() else {
            self.tabs[self.active_tab].error =
                Some("Open a page before capturing an element.".to_string());
            cx.notify();
            return;
        };
        let sender = self.capture_sender.clone();
        let started = webview.update(cx, |webview, _| {
            webview
                .raw()
                .evaluate_script_with_callback(annotation_script(), move |result| {
                    let _ = sender.try_send(CaptureMessage::Armed { tab: id, result });
                })
        });
        match started {
            Ok(()) => {
                self.capture_tab = Some(id);
                if let Some(tab) = self.tab_mut(id) {
                    tab.error = None;
                }
            }
            Err(error) => {
                if let Some(tab) = self.tab_mut(id) {
                    tab.error = Some(format!("Could not start the element capture: {error}"));
                }
            }
        }
        cx.notify();
    }

    /// The annotation the page captured, once, for the workspace to append to the
    /// composer. The active tab's capture is preferred, but one that finished after
    /// switching tabs is still delivered.
    pub fn take_annotation(&mut self) -> Option<String> {
        let active = self.active_tab;
        if let Some(tab) = self.tabs.get_mut(active)
            && let Some(annotation) = tab.annotation.take()
        {
            return Some(annotation);
        }
        self.tabs.iter_mut().find_map(|tab| tab.annotation.take())
    }

    /// The active tab's last annotation failure, for the workspace's debug snapshot.
    pub fn annotation_error(&self) -> Option<&str> {
        self.tabs
            .get(self.active_tab)
            .and_then(|tab| tab.error.as_deref())
    }

    /// The annotation waiting for the composer, for the workspace's debug snapshot.
    pub fn annotation_preview(&self) -> Option<&str> {
        self.tabs
            .get(self.active_tab)
            .and_then(|tab| tab.annotation.as_deref())
    }

    /// Apply an arming result; `true` when the pane's state changed.
    fn apply_armed(&mut self, id: u64, result: &str) -> bool {
        if !result.trim().is_empty() {
            // The picker armed: `start_capture` already recorded the waiting tab.
            return false;
        }
        if self.capture_tab == Some(id) {
            self.capture_tab = None;
        }
        if let Some(tab) = self.tab_mut(id) {
            tab.error = Some("The page did not accept the element picker.".to_string());
        }
        true
    }

    /// Apply an IPC message; `true` when the pane should repaint.
    fn apply_posted(&mut self, id: u64, message: &str) -> bool {
        let Some(posted) = capture_from_message(message) else {
            return false;
        };
        let outcome = match posted {
            PostedCapture::Cancelled => None,
            PostedCapture::Annotation(raw) => Some(format_annotation(&raw)),
        };
        if self.capture_tab == Some(id) {
            self.capture_tab = None;
        }
        let Some(tab) = self.tab_mut(id) else {
            return true;
        };
        match outcome {
            Some(Ok(annotation)) => {
                tab.annotation = Some(annotation);
                tab.error = None;
            }
            Some(Err(error)) => tab.error = Some(error),
            None => {}
        }
        true
    }

    /// Load the address bar's URL into the active tab, reporting a rejected address
    /// above the page. An empty pane opens its first tab first, so a rejected address
    /// still has somewhere to report itself.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Workspace>) {
        self.navigate_requested = false;
        let address = self.address.read(cx).value().to_string();
        match normalize_address(&address) {
            Ok(url) => {
                // Only the previous rejection is cleared here; a webview that fails
                // to start keeps its own message.
                if let Some(tab) = self.tabs.get_mut(self.active_tab) {
                    tab.error = None;
                }
                self.ensure(window, cx);
                let active = self.active_tab;
                let loaded = match self.tabs.get_mut(active) {
                    Some(tab) => match &tab.webview {
                        Some(webview) => {
                            webview.update(cx, |webview, _| webview.load_url(&url));
                            tab.url = url.clone();
                            if self.capture_tab == Some(tab.id) {
                                // Loading a page discards the picker, so the hint goes with it.
                                self.capture_tab = None;
                            }
                            true
                        }
                        None => false,
                    },
                    None => false,
                };
                if loaded {
                    // Show the address that actually loaded, not the shorthand that was typed.
                    let address = self.address.clone();
                    address.update(cx, |state, cx| state.set_value(url, window, cx));
                }
            }
            Err(message) => {
                self.prepare();
                if let Some(tab) = self.tabs.get_mut(self.active_tab) {
                    tab.error = Some(message);
                }
            }
        }
        cx.notify();
    }

    /// Show only the active tab's native view while the pane is on screen.
    ///
    /// A webview that is not rendered keeps the bounds of its last frame, and on
    /// Windows it covers everything in those bounds, so every inactive tab (and the
    /// whole pane when it leaves) has to be hidden explicitly.
    pub fn set_visible(&self, visible: bool, cx: &mut Context<Workspace>) {
        for (index, tab) in self.tabs.iter().enumerate() {
            let Some(webview) = &tab.webview else {
                continue;
            };
            let show = visible && index == self.active_tab;
            webview.update(cx, |webview, _| {
                if webview.visible() != show {
                    if show {
                        webview.show();
                    } else {
                        webview.hide();
                    }
                }
            });
        }
    }

    fn active_webview(&self) -> Option<Entity<WebView>> {
        self.tabs
            .get(self.active_tab)
            .and_then(|tab| tab.webview.clone())
    }

    fn back(&self, cx: &mut Context<Workspace>) {
        if let Some(webview) = self.active_webview() {
            webview.update(cx, |webview, _| {
                let _ = webview.back();
            });
        }
    }

    fn forward(&self, cx: &mut Context<Workspace>) {
        if let Some(webview) = self.active_webview() {
            webview.update(cx, |webview, _| {
                let _ = webview.forward();
            });
        }
    }

    fn reload(&self, cx: &mut Context<Workspace>) {
        if let Some(webview) = self.active_webview() {
            webview.update(cx, |webview, _| {
                let _ = webview.raw().reload();
            });
        }
    }

    fn nav_button(
        id: &'static str,
        label: &'static str,
        aria_label: &'static str,
        on_click: impl Fn(&mut Workspace, &mut Context<Workspace>) + 'static,
        cx: &mut Context<Workspace>,
    ) -> impl IntoElement {
        let colors = cx.theme().colors;
        div()
            .id(id)
            .aria_label(aria_label)
            .px_2()
            .py_0p5()
            .rounded(px(6.0))
            .border_1()
            .border_color(colors.border)
            .text_xs()
            .text_color(colors.foreground)
            .hover(|style| style.bg(colors.accent))
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| on_click(this, cx)))
    }

    pub fn content(&self, cx: &mut Context<Workspace>) -> impl IntoElement {
        let colors = cx.theme().colors;
        let tab = self.tabs.get(self.active_tab);
        let webview = tab.and_then(|tab| tab.webview.clone());
        let error = tab.and_then(|tab| tab.error.clone());
        let armed = tab.is_some_and(|tab| self.capture_tab == Some(tab.id));
        // A failure is reported on its own line; until the webview exists there is nothing
        // else to show, and once it does the native view covers this area.
        let preparing = tab.is_some() && webview.is_none() && error.is_none();
        let empty = self.tabs.is_empty();
        let labels: Vec<String> = self.tabs.iter().map(|tab| tab_label(&tab.url)).collect();
        let entity = cx.entity();
        let select = {
            let entity = entity.clone();
            move |index: usize, window: &mut Window, cx: &mut App| {
                entity.update(cx, |this, cx| this.browser.select_tab(index, window, cx));
            }
        };
        let close_tab = {
            let entity = entity.clone();
            move |index: usize, window: &mut Window, cx: &mut App| {
                entity.update(cx, |this, cx| this.browser.close_tab(index, window, cx));
            }
        };
        let new_tab = move |window: &mut Window, cx: &mut App| {
            entity.update(cx, |this, cx| this.browser.new_tab(window, cx));
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .h_full()
            .min_h(px(0.0))
            .child(browser_tab_bar(
                &labels,
                self.active_tab,
                colors,
                select,
                close_tab,
                new_tab,
            ))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(Self::nav_button(
                        "browser-back",
                        "‹",
                        "Back",
                        |workspace, cx| workspace.browser.back(cx),
                        cx,
                    ))
                    .child(Self::nav_button(
                        "browser-forward",
                        "›",
                        "Forward",
                        |workspace, cx| workspace.browser.forward(cx),
                        cx,
                    ))
                    .child(Self::nav_button(
                        "browser-reload",
                        "⟳",
                        "Reload",
                        |workspace, cx| workspace.browser.reload(cx),
                        cx,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .child(Input::new(&self.address)),
                    )
                    .child(Self::nav_button(
                        "browser-go",
                        "Go",
                        "Open the address",
                        |workspace, _| workspace.browser.request_navigate(),
                        cx,
                    ))
                    .child(Self::nav_button(
                        "browser-capture",
                        "Capture",
                        "Capture element",
                        |workspace, cx| workspace.browser.start_capture(cx),
                        cx,
                    )),
            )
            .when_some(error, |element, message| {
                element.child(div().text_xs().text_color(colors.danger).child(message))
            })
            .when(armed, |element| {
                element.child(
                    div()
                        .text_xs()
                        .text_color(colors.muted_foreground)
                        .child("Click an element in the page to annotate it."),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(colors.border)
                    .overflow_hidden()
                    .when_some(webview, |element, webview| element.child(webview))
                    .when(preparing, |element| {
                        element.child(
                            div()
                                .p_2()
                                .text_xs()
                                .text_color(colors.muted_foreground)
                                .child("Preparing the webview…"),
                        )
                    })
                    .when(empty, |element| {
                        element.child(
                            div()
                                .flex()
                                .flex_col()
                                .items_center()
                                .justify_center()
                                .gap_2()
                                .size_full()
                                .text_xs()
                                .text_color(colors.muted_foreground)
                                .child("No page open.")
                                .child(
                                    div()
                                        .id("browser-empty-new-tab")
                                        .aria_label("New browser tab")
                                        .px_2()
                                        .py_1()
                                        .rounded(px(6.0))
                                        .border_1()
                                        .border_color(colors.border)
                                        .text_color(colors.foreground)
                                        .hover(|style| style.bg(colors.accent))
                                        .child("New tab")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.browser.new_tab(window, cx);
                                        })),
                                ),
                        )
                    }),
            )
    }
}

/// A tab bar click that names the tab it came from.
type TabClick = dyn Fn(usize, &mut Window, &mut App);
/// The tab bar's `+` click, which names no tab.
type NewTabClick = dyn Fn(&mut Window, &mut App);

/// Draws the Browser pane's tab bar: one tab per page, then a `+` button.
///
/// Labels and callbacks are all it reads, so a test can render it without a
/// webview: selecting, closing and opening tabs are the caller's jobs.
#[cfg(target_os = "linux")]
fn ensure_gtk_for_webview() -> Result<(), String> {
    if gtk::is_initialized_main_thread() {
        return Ok(());
    }
    gtk::gdk::set_allowed_backends("x11");
    gtk::init().map_err(|error| format!("GTK could not be initialized for the browser: {error}"))
}

fn browser_tab_bar(
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
        .id("browser-tabs")
        .flex()
        .items_center()
        .gap_1()
        .pb_1()
        .children(labels.iter().enumerate().map(|(index, label)| {
            let is_active = index == active;
            let select = Rc::clone(&on_select);
            let close = Rc::clone(&on_close);
            div()
                .id(("browser-tab", index))
                .aria_label("Browser tab")
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
                        .id(("browser-tab-close", index))
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
                .id("browser-new-tab")
                .aria_label("New browser tab")
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[cfg(target_os = "macos")]
    use super::tab_data_store_identifier;
    use super::{
        BLANK_PAGE, BrowserTab, CAPTURE_KIND, PostedCapture, annotation_script, append_annotation,
        browser_tab_bar, capture_from_message, format_annotation, normalize_address,
        tab_after_close, tab_data_dir, tab_label,
    };

    #[test]
    fn keeps_http_and_https_addresses() {
        assert_eq!(
            normalize_address("https://example.com/a?b=1").expect("valid"),
            "https://example.com/a?b=1"
        );
        assert_eq!(
            normalize_address("  http://localhost:8080/  ").expect("valid"),
            "http://localhost:8080/"
        );
    }

    #[test]
    fn adds_https_to_a_bare_host() {
        assert_eq!(
            normalize_address("example.com").expect("valid"),
            "https://example.com/"
        );
        assert_eq!(
            normalize_address("example.com:8443/x").expect("valid"),
            "https://example.com:8443/x"
        );
    }

    #[test]
    fn rejects_empty_non_http_and_credentialed_addresses() {
        assert!(normalize_address("   ").is_err());
        assert!(normalize_address("file:///etc/passwd").is_err());
        assert!(normalize_address("javascript:alert(1)").is_err());
        assert!(normalize_address("https://user:pass@example.com").is_err());
    }

    #[test]
    fn formats_the_posted_annotation() {
        let raw = r##"{
            "selector": "#save",
            "tag": "button",
            "text": "Save  changes",
            "rect": {"x": 12.4, "y": 40, "width": 88, "height": 32}
        }"##;
        assert_eq!(
            format_annotation(raw).expect("formatted"),
            r#"Element: #save (button) "Save  changes" at 12,40,88,32"#
        );
    }

    #[test]
    fn formats_an_annotation_without_text_or_rect() {
        assert_eq!(
            format_annotation(r#"{"selector": "img.logo", "tag": "img"}"#).expect("formatted"),
            r#"Element: img.logo (img) "" at 0,0,0,0"#
        );
    }

    #[test]
    fn truncates_long_page_text() {
        let text = "x".repeat(300);
        let raw = format!(r##"{{"selector": "#row", "tag": "div", "text": "{text}"}}"##);
        let formatted = format_annotation(&raw).expect("formatted");
        assert!(formatted.contains(&format!("\"{}\"", "x".repeat(200))));
        assert!(!formatted.contains(&"x".repeat(201)));
    }

    #[test]
    fn rejects_annotations_without_a_selector_or_json() {
        assert!(format_annotation(r#"{"tag": "div"}"#).is_err());
        assert!(format_annotation(r#"{"selector": "   ", "tag": "div"}"#).is_err());
        assert!(format_annotation("not json").is_err());
    }

    #[test]
    fn reads_only_annotation_envelopes() {
        let message = r##"{"kind": "omp-element-annotation", "annotation": {"selector": "#a"}}"##;
        assert!(matches!(
            capture_from_message(message),
            Some(PostedCapture::Annotation(raw)) if raw == r##"{"selector":"#a"}"##
        ));
        let cancelled = r#"{"kind": "omp-element-annotation", "cancelled": true}"#;
        assert!(matches!(
            capture_from_message(cancelled),
            Some(PostedCapture::Cancelled)
        ));
        assert!(capture_from_message(r#"{"kind": "something-else"}"#).is_none());
        assert!(capture_from_message("not json").is_none());
    }

    #[test]
    fn the_capture_script_arms_the_picker_and_posts_through_ipc() {
        let script = annotation_script();
        assert!(script.contains("window.ipc.postMessage"));
        // The picker and the parser have to agree on the envelope kind.
        assert!(script.contains(CAPTURE_KIND));
        assert!(script.contains("data-testid"));
        assert!(script.contains("aria-label"));
        // Escape has to tell the pane, or the picking hint would stay on screen.
        assert!(script.contains("cancelled: true"));
        // The script must not return a promise: wry's callback never awaits one.
        assert!(script.contains("return 'armed';"));
    }

    #[test]
    fn appends_to_an_existing_draft() {
        let annotation = r#"Element: #save (button) "Save" at 12,40,88,32"#;
        assert_eq!(append_annotation("", annotation), annotation);
        assert_eq!(append_annotation("   ", annotation), annotation);
        assert_eq!(
            append_annotation("Why is this broken?", annotation),
            format!("Why is this broken? {annotation}")
        );
        assert_eq!(
            append_annotation("trailing  ", annotation),
            format!("trailing {annotation}")
        );
    }

    #[test]
    fn closing_a_tab_selects_its_neighbour() {
        // The active middle tab gives way to the one that slides into place.
        assert_eq!(tab_after_close(1, 1, 3), Some(1));
        // Closing the active last tab falls back to the one before it.
        assert_eq!(tab_after_close(2, 2, 3), Some(1));
        // Closing an earlier tab shifts the active index down with it.
        assert_eq!(tab_after_close(2, 0, 3), Some(1));
        // Closing a later tab leaves the active index alone.
        assert_eq!(tab_after_close(0, 2, 3), Some(0));
        assert_eq!(tab_after_close(0, 1, 2), Some(0));
        // The last tab leaves the pane blank.
        assert_eq!(tab_after_close(0, 0, 1), None);
        assert_eq!(tab_after_close(0, 0, 0), None);
    }

    /// Each tab's profile is its own directory under the pane's root, and asking for the
    /// path touches nothing: the directory is created when the webview is built.
    #[test]
    fn tab_data_dirs_are_distinct_and_under_the_root() {
        let root = std::env::temp_dir().join(format!("omp-tab-dirs-{}", std::process::id()));
        assert_eq!(tab_data_dir(&root, 1), root.join("1"));
        assert_eq!(tab_data_dir(&root, 1), tab_data_dir(&root, 1));
        assert_ne!(tab_data_dir(&root, 1), tab_data_dir(&root, 2));
        // A tab id is one path component, not a nested path.
        assert_eq!(tab_data_dir(&root, 9).parent(), Some(root.as_path()));
        // Pure: nothing was created on disk.
        assert!(!root.exists());
    }

    /// WKWebView stores are named, not directories, so each tab has to name its own.
    #[cfg(target_os = "macos")]
    #[test]
    fn tab_data_store_identifiers_are_distinct_per_tab() {
        assert_ne!(tab_data_store_identifier(1), tab_data_store_identifier(2));
        assert_eq!(tab_data_store_identifier(1), tab_data_store_identifier(1));
        assert_eq!(&tab_data_store_identifier(7)[..8], b"omp-tab-");
    }

    #[test]
    fn a_new_tab_is_blank_until_a_page_loads() {
        let tab = BrowserTab::new(7, BLANK_PAGE, tab_data_dir(Path::new("profiles"), 7));
        assert_eq!(tab.id, 7);
        assert!(tab.webview.is_none());
        assert!(tab.web_context.is_none());
        assert_eq!(tab.data_dir, Path::new("profiles").join("7"));
        assert!(tab.error.is_none());
        assert!(tab.annotation.is_none());
        // The blank page reads as an empty address field.
        assert_eq!(tab.address(), "");
        assert_eq!(tab_label(&tab.url), "New tab");
    }

    #[test]
    fn tab_labels_name_the_page_host() {
        assert_eq!(tab_label("https://example.com/a?b=1"), "example.com");
        assert_eq!(tab_label("  http://localhost:8080/  "), "localhost");
        assert_eq!(tab_label(""), "New tab");
        assert_eq!(tab_label(BLANK_PAGE), "New tab");
        // Not a page this pane can load, so the label keeps what it has.
        assert_eq!(tab_label("not a url"), "not a url");
    }

    /// The tab bar draws with no tabs (just `+`) and with one tab, without a
    /// webview: it only reads labels and callbacks.
    #[test]
    fn browser_tab_bar_renders_with_zero_and_one_tab() {
        use gpui_kit::AppContext as _;
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
                browser_tab_bar(
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
        for labels in [Vec::new(), vec!["example.com".to_string()]] {
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
}
