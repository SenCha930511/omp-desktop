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

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_webview::WebView;
use omp_core::url_policy::parse_http_url;
use wry::WebViewBuilder;

use crate::app::Workspace;

/// The page shown until the address bar opens something.
const BLANK_PAGE: &str = "about:blank";

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

/// Address bar, history controls and the native webview of the Browser pane.
pub struct BrowserPane {
    address: Entity<InputState>,
    _address_subscription: Subscription,
    webview: Option<Entity<WebView>>,
    error: Option<String>,
    navigate_requested: bool,
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
        Self {
            address,
            _address_subscription: address_subscription,
            webview: None,
            error: None,
            navigate_requested: false,
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
        match WebView::build(WebViewBuilder::new().with_url(BLANK_PAGE), window, cx) {
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

    /// Load the address bar's URL, reporting a rejected address above the page.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Workspace>) {
        self.navigate_requested = false;
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
                    )),
            )
            .when_some(self.error.clone(), |element, message| {
                element.child(div().text_xs().text_color(colors.danger).child(message))
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
    use super::normalize_address;

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
}
