//! Native system-tray icon for the desktop app.
//!
//! The icon is an `NSStatusItem` on macOS and a notification-area icon on Windows,
//! built with `tray-icon` on the GPUI main thread (GPUI owns the native
//! `NSApplication`/message loop, so the tray attaches to it rather than running one
//! of its own). Its menu offers **Open OMP Desktop** and **Quit**.
//!
//! # Linux
//!
//! `tray-icon`'s Linux backend uses the StatusNotifierItem/AppIndicator host and
//! loads libappindicator at runtime. A session without a tray host logs an error
//! and keeps running; the app does not depend on the tray to start.
//!
//! # Threading
//!
//! `muda` menu callbacks run on the platform's menu thread, outside GPUI's update
//! cycle, so they never touch GPUI state. They push a [`TrayCommand`] into a channel
//! that a GPUI task drains, and that task performs the window/quit calls.

use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use gpui_kit::{AnyWindowHandle, App, AsyncApp};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

/// The app icon, decoded at runtime — no separate tray asset is shipped.
const ICON_PNG: &[u8] = include_bytes!("../../../../assets/icon.png");

/// macOS renders the icon at 18pt, so build a 2x template image to stay crisp on
/// Retina displays (`tray-icon` scales it back down to an 18pt height).
#[cfg(target_os = "macos")]
const ICON_PIXELS: u32 = 36;
/// Windows and Linux draw 16px notification-area icons; 32px covers 200% scaling.
#[cfg(any(windows, target_os = "linux"))]
const ICON_PIXELS: u32 = 32;

const OPEN_MENU_ID: &str = "omp-desktop.tray.open";
const QUIT_MENU_ID: &str = "omp-desktop.tray.quit";
const TOOLTIP: &str = "OMP Desktop";

/// A tray action, forwarded from the menu callback into the GPUI task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayCommand {
    /// Show and focus the main window.
    OpenWindow,
    /// Exit the application.
    Quit,
}

/// A failed tray construction. The app keeps running without a tray.
#[derive(Debug)]
pub struct TrayError(String);

impl TrayError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for TrayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TrayError {}

/// Handle to a live tray icon.
pub struct Tray {
    sender: async_channel::Sender<TrayCommand>,
    handled: Arc<AtomicUsize>,
}

impl Tray {
    /// Queues a command exactly as the menu would. Returns `false` once the tray
    /// task has stopped (the app is quitting).
    pub fn send(&self, command: TrayCommand) -> bool {
        self.sender.try_send(command).is_ok()
    }

    /// Number of commands the GPUI task has processed. Used by the tray smoke test
    /// to prove the callback -> channel -> task path is live.
    pub fn handled_commands(&self) -> usize {
        self.handled.load(Ordering::Relaxed)
    }
}

/// Owns the status item for the lifetime of the `App`, so the icon is removed when
/// the app shuts down instead of leaving a stale status item behind. The icon is
/// never read — holding it is the point.
struct TrayIconHandle {
    _icon: TrayIcon,
}

impl gpui_kit::Global for TrayIconHandle {}

/// The menu callback needs a `Send + Sync` entry point into the app, and `muda`
/// installs exactly one global handler per process, so the channel end lives here.
static SENDER: Mutex<Option<async_channel::Sender<TrayCommand>>> = Mutex::new(None);

/// Builds the tray icon, installs the menu handler, and starts the task that turns
/// menu events into GPUI calls. Must run on the main thread, after the application
/// has started (so the platform's menu bar exists).
pub fn init(cx: &mut App, window: AnyWindowHandle) -> Result<Tray, TrayError> {
    #[cfg(target_os = "linux")]
    if !gtk::is_initialized_main_thread() {
        gtk::gdk::set_allowed_backends("x11");
        if gtk::init().is_err() {
            return Err(TrayError::new("GTK could not be initialized for the tray"));
        }
    }
    let menu = build_menu()?;
    let rgba = tray_icon_rgba(ICON_PNG, ICON_PIXELS)?;
    let icon = Icon::from_rgba(rgba, ICON_PIXELS, ICON_PIXELS)
        .map_err(|err| TrayError::new(format!("tray icon was rejected: {err}")))?;
    let tray_icon = TrayIconBuilder::new()
        .with_tooltip(TOOLTIP)
        .with_menu(Box::new(menu))
        .with_icon(icon)
        // macOS template images take the menu bar's tint (dark in light mode, light
        // in dark mode). Windows has no template concept; the glyph is pre-tinted
        // for its (dark by default) notification area instead.
        .with_icon_as_template(cfg!(target_os = "macos"))
        .build()
        .map_err(|err| TrayError::new(format!("the platform refused the tray icon: {err}")))?;

    let (sender, receiver) = async_channel::unbounded();
    // The builder can succeed while no status item reaches the menu bar (for example
    // in a session without one); report that instead of pretending a tray exists.
    #[cfg(target_os = "macos")]
    if tray_icon.ns_status_item().is_none() {
        return Err(TrayError::new("the menu bar refused the status item"));
    }

    install_menu_handler();
    *lock_sender() = Some(sender.clone());
    cx.set_global(TrayIconHandle { _icon: tray_icon });

    let handled = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&handled);
    cx.spawn(async move |cx: &mut AsyncApp| {
        while let Ok(command) = receiver.recv().await {
            counter.fetch_add(1, Ordering::Relaxed);
            match command {
                TrayCommand::OpenWindow => {
                    let _ = window.update(cx, |_, window, app| {
                        app.activate(true);
                        window.activate_window();
                    });
                }
                TrayCommand::Quit => {
                    cx.update(|app| app.quit());
                    break;
                }
            }
        }
    })
    .detach();

    Ok(Tray { sender, handled })
}

fn build_menu() -> Result<Menu, TrayError> {
    let menu = Menu::new();
    menu.append(&MenuItem::with_id(
        OPEN_MENU_ID,
        "Open OMP Desktop",
        true,
        None,
    ))
    .and_then(|()| menu.append(&PredefinedMenuItem::separator()))
    .and_then(|()| menu.append(&MenuItem::with_id(QUIT_MENU_ID, "Quit", true, None)))
    .map_err(|err| TrayError::new(format!("tray menu could not be built: {err}")))?;
    Ok(menu)
}

/// Installs the process-wide menu handler once. Later calls are no-ops (`muda` keeps
/// the first handler), which keeps repeated `init` calls in tests well-behaved.
fn install_menu_handler() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        MenuEvent::set_event_handler(Some(|event: MenuEvent| {
            let Some(command) = command_for(event.id().0.as_str()) else {
                return;
            };
            if let Some(sender) = lock_sender().as_ref() {
                // Unbounded, so this never blocks the platform's menu thread.
                let _ = sender.try_send(command);
            }
        }));
    });
}

fn lock_sender() -> std::sync::MutexGuard<'static, Option<async_channel::Sender<TrayCommand>>> {
    SENDER.lock().unwrap_or_else(|err| err.into_inner())
}

fn command_for(menu_id: &str) -> Option<TrayCommand> {
    match menu_id {
        OPEN_MENU_ID => Some(TrayCommand::OpenWindow),
        QUIT_MENU_ID => Some(TrayCommand::Quit),
        _ => None,
    }
}

/// Decodes the bundled app icon and turns it into a monochrome tray glyph.
///
/// The app icon is a dark glyph on an opaque white tile, so its alpha channel is the
/// tile, not the shape: "ink" comes from luminance instead. The result is cropped to
/// that ink and fitted to the slot, so the glyph keeps its proportions instead of
/// shrinking with the tile's padding.
fn tray_icon_rgba(png: &[u8], size: u32) -> Result<Vec<u8>, TrayError> {
    let decoded = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|err| TrayError::new(format!("tray icon PNG could not be decoded: {err}")))?
        .to_rgba8();
    let tint = glyph_tint();
    let mut ink = image::RgbaImage::from_pixel(
        decoded.width(),
        decoded.height(),
        image::Rgba([tint, tint, tint, 0]),
    );
    let (mut left, mut top, mut right, mut bottom) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for (x, y, pixel) in decoded.enumerate_pixels() {
        let [r, g, b, alpha] = pixel.0;
        let luma = (u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114) / 1000;
        let coverage = (u32::from(255 - luma as u8) * u32::from(alpha)) / 255;
        if coverage == 0 {
            continue;
        }
        ink.put_pixel(x, y, image::Rgba([tint, tint, tint, coverage as u8]));
        left = left.min(x);
        top = top.min(y);
        right = right.max(x);
        bottom = bottom.max(y);
    }
    if right < left || bottom < top {
        return Err(TrayError::new(
            "the app icon has no glyph to show in the tray",
        ));
    }
    let glyph =
        image::imageops::crop_imm(&ink, left, top, right - left + 1, bottom - top + 1).to_image();
    // Fit the glyph into the square slot without stretching it, then centre it.
    let longest = glyph.width().max(glyph.height());
    let scaled =
        |edge: u32| ((u64::from(edge) * u64::from(size)) / u64::from(longest)).max(1) as u32;
    let fitted = image::imageops::resize(
        &glyph,
        scaled(glyph.width()),
        scaled(glyph.height()),
        image::imageops::FilterType::Lanczos3,
    );
    let mut slot = image::RgbaImage::from_pixel(size, size, image::Rgba([tint, tint, tint, 0]));
    let offset = |outer: u32, inner: u32| outer.saturating_sub(inner) / 2;
    image::imageops::replace(
        &mut slot,
        &fitted,
        i64::from(offset(size, fitted.width())),
        i64::from(offset(size, fitted.height())),
    );
    Ok(slot.into_raw())
}

/// Black for the macOS template image (only its alpha is used), white for Windows so
/// the glyph reads on the dark notification area.
fn glyph_tint() -> u8 {
    if cfg!(target_os = "macos") { 0 } else { 255 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_ids_map_to_commands() {
        assert_eq!(command_for(OPEN_MENU_ID), Some(TrayCommand::OpenWindow));
        assert_eq!(command_for(QUIT_MENU_ID), Some(TrayCommand::Quit));
        assert_eq!(command_for("omp-desktop.tray.unknown"), None);
    }

    #[test]
    fn tray_icon_is_a_monochrome_glyph() {
        let size = 36;
        let rgba = tray_icon_rgba(ICON_PNG, size).expect("bundled icon decodes");
        assert_eq!(rgba.len(), (size * size * 4) as usize);

        let tint = glyph_tint();
        let mut solid = 0;
        let mut clear = 0;
        for pixel in rgba.as_chunks::<4>().0 {
            assert_eq!(&pixel[..3], &[tint, tint, tint]);
            match pixel[3] {
                0 => clear += 1,
                200..=255 => solid += 1,
                _ => {}
            }
        }
        // The glyph is cropped out of the icon and scaled to the slot, so most of the
        // buffer is ink — but the gaps inside it (between the bar and the mark) and
        // the padding around it stay transparent.
        assert!(
            solid * 4 > (size * size) as usize,
            "the glyph is too sparse"
        );
        assert!(clear > 0, "the glyph background was not cut out");
    }
}
