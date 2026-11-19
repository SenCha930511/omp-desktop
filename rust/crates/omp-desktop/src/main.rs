#![recursion_limit = "512"]

use std::path::{Path, PathBuf};

use gpui_kit::*;
use omp_core::geometry::{UiGeometry, geometry_path};
use omp_core::projects;
use omp_core::sessions;
use omp_core::settings::AppSettings;
use omp_core::state::{
    CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, Platform, StateStore,
};
use omp_desktop::app::{Workspace, WorkspaceData};

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let user_data_dir = parse_arg(&args, "--user-data-dir=")
        .map(PathBuf::from)
        .unwrap_or_else(default_user_data_dir);
    let smoke_path = parse_arg(&args, "--packaged-smoke=").map(PathBuf::from);
    let dump_layout_path = parse_arg(&args, "--dump-layout=").map(PathBuf::from);
    let data = load_workspace_data(&user_data_dir);
    let geometry_for_dump = data.geometry.clone();
    let options = window_options(&data.geometry);
    let version = env!("CARGO_PKG_VERSION").to_string();

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let handle = gpui_kit::open_window(options, cx, move |window, cx| {
            if let Some(path) = smoke_path.clone() {
                window.on_next_frame(move |_, cx| {
                    let _ = omp_desktop::packaged_smoke::write_marker(&path, SMOKE_URL, &version);
                    cx.quit();
                });
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
        let _ = handle;
    });
}
