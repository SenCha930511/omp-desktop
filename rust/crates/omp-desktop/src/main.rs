#![recursion_limit = "512"]

// The system tray is a native NSStatusItem (macOS), notification-area icon
// (Windows), or AppIndicator (Linux). A session without a tray host keeps running;
// see `src/tray.rs`.
mod tray;

use std::path::{Path, PathBuf};

use gpui_kit::*;
use omp_core::geometry::{UiGeometry, geometry_path};
use omp_core::projects;
use omp_core::sessions;
use omp_core::settings::AppSettings;
use omp_core::state::{
    CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, Platform, StateStore,
};
use omp_desktop::app::{CloseGuard, CloseIntent, Workspace, WorkspaceData};

const APP_ID: &str = "com.omp.desktop.rust.dev";
const SMOKE_URL: &str = "omp-desktop://app/index.html";

fn default_user_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Application Support/OMP Desktop Rust Dev");
        }
    }
    #[cfg(windows)]
    {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            return PathBuf::from(app_data).join("OMP Desktop Rust Dev");
        }
    }
    if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(data).join("omp-desktop-rust-dev");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local/share/omp-desktop-rust-dev");
    }
    PathBuf::from(".omp-desktop-rust-dev")
}

fn parse_arg(args: &[String], prefix: &str) -> Option<String> {
    args.iter()
        .find_map(|arg| arg.strip_prefix(prefix).map(str::to_string))
}

fn resolve_omp_executable(settings: &omp_core::settings::AppSettings) -> PathBuf {
    let configured = settings.omp_runtime_path();
    if !configured.is_empty() {
        return PathBuf::from(configured);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join("omp");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("omp")
}

fn load_workspace_data(user_data_dir: &Path) -> WorkspaceData {
    let home = omp_core::paths::home_dir();
    let state_path = user_data_dir.join(CURRENT_DESKTOP_STATE_FILENAME);
    let legacy_path = user_data_dir.join(LEGACY_DESKTOP_STATE_FILENAME);
    let geometry_path = geometry_path(user_data_dir);
    let geometry = UiGeometry::load(&geometry_path);
    let mut settings = AppSettings::default();
    let mut project_records = Vec::new();
    let mut session_records = Vec::new();
    if let Ok(store) = StateStore::open(state_path, Some(legacy_path), Platform::current()) {
        settings = store.settings();
        project_records = projects::list_projects(&store);
        session_records = sessions::list_sessions(&store, &home, false, None);
    }
    WorkspaceData {
        geometry,
        geometry_path,
        home_dir: home,
        user_data_dir: user_data_dir.to_path_buf(),
        omp_executable: resolve_omp_executable(&settings),
        settings,
        projects: project_records,
        sessions: session_records,
    }
}

fn window_options(geometry: &UiGeometry) -> WindowOptions {
    let bounds = geometry
        .window_bounds
        .unwrap_or(omp_core::geometry::WindowBounds {
            x: 120.0,
            y: 120.0,
            width: 1440.0,
            height: 900.0,
            maximized: false,
        });
    let window_bounds = if bounds.maximized {
        WindowBounds::Maximized(Bounds {
            origin: point(px(bounds.x as f32), px(bounds.y as f32)),
            size: size(px(bounds.width as f32), px(bounds.height as f32)),
        })
    } else {
        WindowBounds::Windowed(Bounds {
            origin: point(px(bounds.x as f32), px(bounds.y as f32)),
            size: size(px(bounds.width as f32), px(bounds.height as f32)),
        })
    };
    WindowOptions {
        window_bounds: Some(window_bounds),
        titlebar: Some(TitlebarOptions {
            title: Some("OMP Desktop".into()),
            appears_transparent: false,
            traffic_light_position: None,
        }),
        window_min_size: Some(size(px(720.0), px(520.0))),
        app_id: Some(APP_ID.to_string()),
        ..Default::default()
    }
}

fn arm_smoke_marker(window: &mut Window, path: PathBuf, version: String, frames: u8) {
    window.on_next_frame(move |window, cx| {
        if frames > 1 {
            arm_smoke_marker(window, path.clone(), version.clone(), frames - 1);
            return;
        }
        if omp_desktop::packaged_smoke::write_marker(&path, SMOKE_URL, &version).is_ok() {
            cx.quit();
        }
    });
}

/// The tray smoke writes a marker once the icon exists and the menu command path has
/// run, then quits — it must never leave the process behind.
fn arm_tray_smoke_marker(window: &mut Window, path: PathBuf, tray: tray::Tray, frames: u8) {
    window.on_next_frame(move |window, cx| {
        if frames > 1 {
            arm_tray_smoke_marker(window, path, tray, frames - 1);
            return;
        }
        let payload = serde_json::json!({
            "trayInstalled": true,
            "trayCommandsHandled": tray.handled_commands(),
        });
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, format!("{}\n", payload));
        cx.quit();
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let user_data_dir = parse_arg(&args, "--user-data-dir=")
        .map(PathBuf::from)
        .unwrap_or_else(default_user_data_dir);
    let smoke_path = parse_arg(&args, "--packaged-smoke=").map(PathBuf::from);
    // `--tray-smoke=<path>`: writes a marker after the tray is up and the menu command
    // path has run, then quits.
    let tray_smoke_path = parse_arg(&args, "--tray-smoke=").map(PathBuf::from);
    let dump_layout_path = parse_arg(&args, "--dump-layout=").map(PathBuf::from);
    let data = load_workspace_data(&user_data_dir);
    let geometry_for_dump = data.geometry.clone();
    let options = window_options(&data.geometry);
    let version = env!("CARGO_PKG_VERSION").to_string();

    // WebKitGTK needs an X11 window, so the Browser pane's webview requires X11/XWayland;
    // `WebView::build` returns an error on a native Wayland window.
    #[cfg(target_os = "linux")]
    let application = gpui_kit::platform::linux(gpui_kit::WindowingModes::X11);
    #[cfg(not(target_os = "linux"))]
    let application = gpui_kit::application();
    application.run(move |cx| {
        gpui_kit::init(cx);
        // The close guard is shared by the window's close handler, the tray's
        // Quit command and the view that draws the confirmation.
        let close_guard = CloseGuard::new();
        cx.set_global(close_guard.clone());
        let handle = gpui_kit::open_window(options, cx, move |window, cx| {
            if let Some(path) = smoke_path.clone() {
                // The native smoke test must prove the window painted; the
                // Electron version proved an authorized IPC round trip.
                arm_smoke_marker(window, path, version, 3);
            }
            if let Some(path) = dump_layout_path.clone() {
                let geometry = geometry_for_dump.clone();
                window.on_next_frame(move |window, cx| {
                    let width = f32::from(window.bounds().size.width) as f64;
                    let layout = geometry.resolve(width);
                    let payload = serde_json::json!({
                        "windowWidth": width,
                        "layout": layout,
                    });
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&path, format!("{}\n", payload));
                    cx.quit();
                });
            }
            cx.new(|cx| Workspace::new(window, cx, data))
        });
        // Keep the window handle and the view: the tray's "Open OMP Desktop"
        // command raises this window (a failed open is reported instead of
        // silently dropped), and the close handler asks the view whether a
        // close has to confirm first.
        let opened = match &handle {
            Ok((window, workspace)) => Some((*window, workspace.downgrade())),
            Err(err) => {
                eprintln!("omp-desktop: could not open the main window: {err:?}");
                None
            }
        };
        if let Some((window, workspace)) = opened {
            // The handler stays non-blocking: with no agent run the view says
            // yes and the window closes at once; with one it parks the question
            // in the confirmation overlay and the close is refused for now.
            let guard = close_guard.clone();
            let _ = window.update(cx, |_, window, cx| {
                window.on_window_should_close(cx, move |_window, app| {
                    if guard.approved() {
                        return true;
                    }
                    let Some(workspace) = workspace.upgrade() else {
                        return true;
                    };
                    workspace.update(app, |this, cx| this.request_close(CloseIntent::Window, cx))
                });
            });
            match tray::init(cx, window) {
                Ok(tray) => {
                    if let Some(path) = tray_smoke_path {
                        // Drive the same channel the menu callback uses, so the smoke
                        // covers forwarding, not just construction.
                        tray.send(tray::TrayCommand::OpenWindow);
                        // Only a window can arm a frame callback, and the tray holds the
                        // same handle the app opened.
                        let _ = window.update(cx, |_, window, _| {
                            arm_tray_smoke_marker(window, path, tray, 3);
                        });
                    }
                }
                // A tray is a convenience: without one the app still runs.
                Err(err) => eprintln!("omp-desktop: system tray unavailable: {err}"),
            }
        }
    });
}
