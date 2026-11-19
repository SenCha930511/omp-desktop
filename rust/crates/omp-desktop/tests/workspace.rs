use gpui_kit::AppContext as _;
use gpui_kit::TestAppContext;
use omp_core::geometry::UiGeometry;
use omp_core::settings::AppSettings;
use omp_desktop::app::{Workspace, WorkspaceData};

fn test_data(geometry: UiGeometry) -> WorkspaceData {
    WorkspaceData {
        geometry,
        geometry_path: std::env::temp_dir().join("omp-desktop-test-ui-geometry.json"),
        settings: AppSettings::default(),
        projects: Vec::new(),
        sessions: Vec::new(),
    }
}

#[gpui_kit::test]
fn renders_the_first_frame_from_persisted_geometry(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let geometry = UiGeometry {
        sidebar_width: 300.0,
        right_pane_width: 400.0,
        ..UiGeometry::default()
    };
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(geometry)));
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
        })
        .expect("draw frame");
    });
    let layout = handle
        .update(cx, |workspace, _, _| workspace.layout().clone())
        .expect("workspace window");
    assert_eq!(layout.sidebar_width, 300.0);
    assert_eq!(layout.right_pane_width, 400.0);
    assert!(layout.center_width >= 360.0);
}
