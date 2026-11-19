use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{CoreError, Result};

pub const UI_GEOMETRY_FILENAME: &str = "ui-geometry.json";
pub const SIDEBAR_MIN_WIDTH: f64 = 200.0;
pub const SIDEBAR_MAX_WIDTH: f64 = 480.0;
pub const RIGHT_PANE_MIN_WIDTH: f64 = 280.0;
pub const RIGHT_PANE_MAX_WIDTH: f64 = 720.0;
pub const CENTER_MIN_WIDTH: f64 = 360.0;
pub const COMPACT_BREAKPOINT: f64 = 980.0;
pub const SMALL_BREAKPOINT: f64 = 720.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiGeometry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_bounds: Option<WindowBounds>,
    pub sidebar_open: bool,
    pub sidebar_width: f64,
    pub right_pane_open: bool,
    pub right_pane_width: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_restore: Option<String>,
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

impl Default for UiGeometry {
    fn default() -> Self {
        Self {
            window_bounds: None,
            sidebar_open: true,
            sidebar_width: 248.0,
            right_pane_open: true,
            right_pane_width: 360.0,
            compact_restore: None,
            unknown: BTreeMap::new(),
        }
    }
}

impl UiGeometry {
    pub fn from_value(value: &Value) -> Self {
        let defaults = Self::default();
        let Some(record) = value.as_object() else {
            return defaults;
        };
        let window_bounds = record.get("windowBounds").and_then(parse_bounds);
        let compact_restore = record
            .get("compactRestore")
            .and_then(Value::as_str)
            .filter(|value| *value == "sidebar" || *value == "rightPane")
            .map(str::to_string);
        let known = [
            "windowBounds",
            "sidebarOpen",
            "sidebarWidth",
            "rightPaneOpen",
            "rightPaneWidth",
            "compactRestore",
        ];
        Self {
            window_bounds,
            sidebar_open: record
                .get("sidebarOpen")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.sidebar_open),
            sidebar_width: clamp_sidebar(
                record
                    .get("sidebarWidth")
                    .and_then(Value::as_f64)
                    .unwrap_or(defaults.sidebar_width),
            ),
            right_pane_open: record
                .get("rightPaneOpen")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.right_pane_open),
            right_pane_width: clamp_right_pane(
                record
                    .get("rightPaneWidth")
                    .and_then(Value::as_f64)
                    .unwrap_or(defaults.right_pane_width),
            ),
            compact_restore,
            unknown: record
                .iter()
                .filter(|(key, _)| !known.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        }
    }

    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| Self::from_value(&value))
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| CoreError::io("Could not create the geometry directory", error))?;
        }
        let serialized = format!("{}\n", serde_json::to_string_pretty(self)?);
        fs::write(path, serialized)
            .map_err(|error| CoreError::io("Could not write ui-geometry.json", error))
    }

    pub fn resolve(&self, container_width: f64) -> ResolvedLayout {
        resolve_layout(container_width, self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollapsedPane {
    Sidebar,
    RightPane,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLayout {
    pub sidebar_docked: bool,
    pub sidebar_width: f64,
    pub right_pane_docked: bool,
    pub right_pane_width: f64,
    pub center_width: f64,
    pub overlay: Option<String>,
}

pub fn clamp_sidebar(width: f64) -> f64 {
    width.clamp(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
}

pub fn clamp_right_pane(width: f64) -> f64 {
    width.clamp(RIGHT_PANE_MIN_WIDTH, RIGHT_PANE_MAX_WIDTH)
}

fn parse_bounds(value: &Value) -> Option<WindowBounds> {
    let record = value.as_object()?;
    Some(WindowBounds {
        x: record.get("x")?.as_f64()?,
        y: record.get("y")?.as_f64()?,
        width: record.get("width")?.as_f64()?,
        height: record.get("height")?.as_f64()?,
        maximized: record
            .get("maximized")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Resolves docked panes and widths for the first frame. Bootstrap data may
/// fill lists later, but it must never move these geometry values.
pub fn resolve_layout(container_width: f64, geometry: &UiGeometry) -> ResolvedLayout {
    let container = container_width.max(0.0);
    let mut sidebar_open = geometry.sidebar_open;
    let mut right_open = geometry.right_pane_open;
    let mut overlay = None;

    if container <= SMALL_BREAKPOINT {
        if sidebar_open && right_open {
            overlay = Some("rightPane".to_string());
        } else if sidebar_open {
            overlay = Some("sidebar".to_string());
        } else if right_open {
            overlay = Some("rightPane".to_string());
        }
        sidebar_open = false;
        right_open = false;
    } else if container <= COMPACT_BREAKPOINT && sidebar_open && right_open {
        right_open = false;
        overlay = Some("rightPane".to_string());
    }

    let sidebar_width = if sidebar_open {
        clamp_sidebar(geometry.sidebar_width)
    } else {
        0.0
    };
    let available_for_center = (container - sidebar_width).max(0.0);
    let maximum_right = available_for_center - CENTER_MIN_WIDTH;
    if right_open && maximum_right < RIGHT_PANE_MIN_WIDTH {
        right_open = false;
        if overlay.is_none() {
            overlay = Some("rightPane".to_string());
        }
    }
    let right_width = if right_open {
        clamp_right_pane(geometry.right_pane_width).min(maximum_right)
    } else {
        0.0
    };
    let center_width = (container - sidebar_width - right_width).max(0.0);
    ResolvedLayout {
        sidebar_docked: sidebar_open,
        sidebar_width,
        right_pane_docked: right_open,
        right_pane_width: right_width,
        center_width,
        overlay,
    }
}

pub fn geometry_path(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join(UI_GEOMETRY_FILENAME)
}

pub fn geometry_snapshot(value: &UiGeometry) -> Map<String, Value> {
    match serde_json::to_value(value) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}
