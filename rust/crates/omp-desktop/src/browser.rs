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
//! The webview is created lazily, on the UI thread, the first time the pane is shown, and is
//! owned by the [`Workspace`], so it is dropped with the window.

use async_channel::Sender;
use gpui_kit::component::ActiveTheme as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_webview::WebView;
use omp_core::url_policy::parse_http_url;
use serde_json::Value;
use wry::WebViewBuilder;

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

/// What the page reported back after the Capture button armed the picker.
enum CaptureMessage {
    /// Result of the arming `evaluate_script`; empty when the page refused it.
    Armed(String),
    /// An IPC message posted by the picker.
    Posted(String),
}

/// Address bar, history controls and the native webview of the Browser pane.
pub struct BrowserPane {
    address: Entity<InputState>,
    _address_subscription: Subscription,
    webview: Option<Entity<WebView>>,
    error: Option<String>,
    navigate_requested: bool,
    /// Feeds the arming result and the posted annotation into the drain task.
    capture_sender: Sender<CaptureMessage>,
    /// The formatted annotation, waiting for the workspace to append it to the composer.
    annotation: Option<String>,
    /// True while the page is waiting for the click that picks an element.
    capture_armed: bool,
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
                    CaptureMessage::Armed(result) => {
                        let armed = !result.trim().is_empty();
                        let _ = this.update(cx, |workspace, cx| {
                            workspace.browser.capture_armed = armed;
                            if !armed {
                                workspace.browser.error =
                                    Some("The page did not accept the element picker.".to_string());
                            }
                            cx.notify();
                        });
                    }
                    CaptureMessage::Posted(message) => {
                        let Some(posted) = capture_from_message(&message) else {
                            continue;
                        };
                        let outcome = match posted {
                            PostedCapture::Cancelled => None,
                            PostedCapture::Annotation(raw) => Some(format_annotation(&raw)),
                        };
                        let _ = this.update(cx, |workspace, cx| {
                            workspace.browser.capture_armed = false;
                            if let Some(outcome) = outcome {
                                match outcome {
                                    Ok(annotation) => {
                                        workspace.browser.annotation = Some(annotation);
                                        workspace.browser.error = None;
                                    }
                                    Err(error) => workspace.browser.error = Some(error),
                                }
                            }
                            cx.notify();
                        });
                    }
                }
            }
        });
        Self {
            address,
            _address_subscription: address_subscription,
            webview: None,
            error: None,
            navigate_requested: false,
            capture_sender,
            annotation: None,
            capture_armed: false,
            _capture_task: capture_task,
        }
    }

    /// Create the webview if this is the first visit to the pane.
    ///
    /// `WebView::build` attaches the native view to the GPUI window, so it has to run on the
    /// UI thread while the window is alive.
    pub fn ensure(&mut self, window: &mut Window, cx: &mut Context<Workspace>) {
        if self.webview.is_some() {
            return;
        }
        let sender = self.capture_sender.clone();
        let builder = WebViewBuilder::new().with_url(BLANK_PAGE).with_ipc_handler(
            move |request: wry::http::Request<String>| {
                // Pages may post anything, so the drain task filters by the envelope kind.
                let _ = sender.try_send(CaptureMessage::Posted(request.into_body()));
            },
        );
        match WebView::build(builder, window, cx) {
            Ok(webview) => self.webview = Some(cx.new(|_| webview)),
            Err(error) => self.error = Some(format!("The native webview could not start: {error}")),
        }
    }

    /// Whether the pane still has to build its webview.
    pub fn needs_webview(&self) -> bool {
        self.webview.is_none() && self.error.is_none()
    }

    pub fn request_navigate(&mut self) {
        self.navigate_requested = true;
    }

    pub fn take_navigate_request(&mut self) -> bool {
        std::mem::take(&mut self.navigate_requested)
    }

    /// Arm the element picker in the page; the next click there inserts an annotation.
    pub fn start_capture(&mut self, cx: &mut Context<Workspace>) {
        self.capture_armed = false;
        let Some(webview) = &self.webview else {
            self.error = Some("Open a page before capturing an element.".to_string());
            cx.notify();
            return;
        };
        let sender = self.capture_sender.clone();
        let started = webview.update(cx, |webview, _| {
            webview
                .raw()
                .evaluate_script_with_callback(annotation_script(), move |result| {
                    let _ = sender.try_send(CaptureMessage::Armed(result));
                })
        });
        match started {
            Ok(()) => {
                self.capture_armed = true;
                self.error = None;
            }
            Err(error) => {
                self.error = Some(format!("Could not start the element capture: {error}"));
            }
        }
        cx.notify();
    }

    /// The annotation the page captured, once, for the workspace to append to the composer.
    pub fn take_annotation(&mut self) -> Option<String> {
        self.annotation.take()
    }

    /// Load the address bar's URL, reporting a rejected address above the page.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Workspace>) {
        self.navigate_requested = false;
        // Loading a page discards the picker, so the hint has to go with it.
        self.capture_armed = false;
        let address = self.address.read(cx).value().to_string();
        match normalize_address(&address) {
            Ok(url) => {
                self.error = None;
                self.ensure(window, cx);
                if let Some(webview) = &self.webview {
                    webview.update(cx, |webview, _| webview.load_url(&url));
                    // Show the address that actually loaded, not the shorthand that was typed.
                    let address = self.address.clone();
                    address.update(cx, |state, cx| state.set_value(url, window, cx));
                }
            }
            Err(message) => self.error = Some(message),
        }
        cx.notify();
    }

    /// Show or hide the native view with the pane. A webview that is not rendered keeps the
    /// bounds of its last frame, so leaving the pane has to hide it explicitly.
    pub fn set_visible(&self, visible: bool, cx: &mut Context<Workspace>) {
        let Some(webview) = &self.webview else {
            return;
        };
        webview.update(cx, |webview, _| {
            if webview.visible() != visible {
                if visible {
                    webview.show();
                } else {
                    webview.hide();
                }
            }
        });
    }

    fn back(&self, cx: &mut Context<Workspace>) {
        if let Some(webview) = &self.webview {
            webview.update(cx, |webview, _| {
                let _ = webview.back();
            });
        }
    }

    fn forward(&self, cx: &mut Context<Workspace>) {
        if let Some(webview) = &self.webview {
            webview.update(cx, |webview, _| {
                let _ = webview.forward();
            });
        }
    }

    fn reload(&self, cx: &mut Context<Workspace>) {
        if let Some(webview) = &self.webview {
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
        let webview = self.webview.clone();
        // A failure is reported on its own line; until the webview exists there is nothing
        // else to show, and once it does the native view covers this area.
        let preparing = webview.is_none() && self.error.is_none();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .h_full()
            .min_h(px(0.0))
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
            .when_some(self.error.clone(), |element, message| {
                element.child(div().text_xs().text_color(colors.danger).child(message))
            })
            .when(self.capture_armed, |element| {
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
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CAPTURE_KIND, PostedCapture, annotation_script, append_annotation, capture_from_message,
        format_annotation, normalize_address,
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
}
