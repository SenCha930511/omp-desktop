use gpui_kit::AppContext as _;
use gpui_kit::TestAppContext;
use omp_core::geometry::UiGeometry;
use omp_core::settings::AppSettings;
use omp_desktop::app::{Workspace, WorkspaceData};

fn test_data(geometry: UiGeometry) -> WorkspaceData {
    let root = tempfile::TempDir::new().expect("test root").keep();
    WorkspaceData {
        geometry,
        geometry_path: root.join("ui-geometry.json"),
        home_dir: root.clone(),
        user_data_dir: root,
        omp_executable: std::path::PathBuf::from("omp"),
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

#[gpui_kit::test]
fn selecting_a_session_reads_its_real_transcript(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let home = dir.path().join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    std::fs::create_dir_all(&bucket).expect("bucket");
    let session_path =
        bucket.join("2026-04-01T00-00-00-000Z_019fdf24-bbbb-7000-8000-000000000002.jsonl");
    let title = serde_json::json!({ "type": "title", "v": 1, "title": "Fixture", "updatedAt": "2026-04-01T00:00:00.000Z", "pad": "" });
    let header = serde_json::json!({ "type": "session", "version": 3, "id": "s-1", "timestamp": "2026-04-01T00:00:00.000Z", "cwd": "/tmp/project" });
    let user = serde_json::json!({ "type": "message", "id": "u1", "parentId": null, "timestamp": "2026-04-01T00:00:01.000Z", "message": { "role": "user", "content": "Hello" } });
    let assistant = serde_json::json!({ "type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-04-01T00:00:02.000Z", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Hi there" }] } });
    std::fs::write(
        &session_path,
        format!("{}\n{}\n{}\n{}\n", title, header, user, assistant),
    )
    .expect("session fixture");

    let record = omp_core::sessions::SessionRecord {
        id: "s-1".to_string(),
        harness: "omp".to_string(),
        file_path: session_path.display().to_string(),
        project_path: "/tmp/project".to_string(),
        title: "Fixture".to_string(),
        created_at: "2026-04-01T00:00:00.000Z".to_string(),
        updated_at: "2026-04-01T00:00:02.000Z".to_string(),
        last_user_message_at: Some("2026-04-01T00:00:01.000Z".to_string()),
        status: "complete".to_string(),
        model: None,
        provider: None,
        thinking_level: None,
        depth: 0,
        parent_session: None,
        last_user_texts: vec!["Hello".to_string()],
        pinned: false,
        unread: false,
        preview: Some("Hi there".to_string()),
        archived: false,
    };
    let mut data = test_data(UiGeometry::default());
    data.home_dir = home;
    data.sessions = vec![record];
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
        })
        .expect("draw frame");
    });
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(workspace.transcript_messages().len(), 2);
            assert_eq!(workspace.transcript_messages()[0].role, "user");
            assert_eq!(workspace.transcript_messages()[1].role, "assistant");
        })
        .expect("workspace window");
}

#[cfg(unix)]
#[gpui_kit::test]
fn sends_a_prompt_through_the_real_omp_fixture(cx: &mut TestAppContext) {
    use omp_core::projects;
    use omp_core::state::{CURRENT_DESKTOP_STATE_FILENAME, Platform, StateStore};
    use std::os::unix::fs::PermissionsExt;

    cx.update(gpui_kit::init);
    let root = tempfile::TempDir::new().expect("test root");
    let home = root.path().join("home");
    let user_data = root.path().join("user-data");
    let project = root.path().join("project");
    let bin = root.path().join("bin");
    for dir in [&home, &user_data, &project, &bin] {
        std::fs::create_dir_all(dir).expect("dir");
    }
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root");
    let fixture_script = repo.join("tests/conformance/fixtures/omp-fixture.mjs");
    let fixture = bin.join("omp-fixture");
    std::fs::write(
        &fixture,
        format!(
            "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
            std::env::var("NODE").unwrap_or_else(|_| "node".to_string()),
            fixture_script.display()
        ),
    )
    .expect("fixture");
    std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let mut store = StateStore::open(
        user_data.join(CURRENT_DESKTOP_STATE_FILENAME),
        None,
        Platform::current(),
    )
    .expect("state store");
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().unwrap(),
    )
    .expect("grant");
    drop(store);

    let bucket = home.join(".omp/agent/sessions/-omp-project");
    std::fs::create_dir_all(&bucket).expect("bucket");
    let session_path =
        bucket.join("2026-04-02T00-00-00-000Z_019fdf24-dddd-7000-8000-000000000010.jsonl");
    let title = serde_json::json!({ "type": "title", "v": 1, "title": "RPC Fixture", "updatedAt": "2026-04-02T00:00:00.000Z", "pad": "" });
    let header = serde_json::json!({ "type": "session", "version": 3, "id": "s-1", "timestamp": "2026-04-02T00:00:00.000Z", "cwd": project.canonicalize().unwrap() });
    std::fs::write(&session_path, format!("{}\n{}\n", title, header)).expect("session");

    let record = omp_core::sessions::SessionRecord {
        id: "s-1".to_string(),
        harness: "omp".to_string(),
        file_path: session_path.display().to_string(),
        project_path: project.canonicalize().unwrap().display().to_string(),
        title: "RPC Fixture".to_string(),
        created_at: "2026-04-02T00:00:00.000Z".to_string(),
        updated_at: "2026-04-02T00:00:00.000Z".to_string(),
        last_user_message_at: None,
        status: "idle".to_string(),
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
    let mut data = test_data(UiGeometry::default());
    data.home_dir = home;
    data.user_data_dir = user_data;
    data.omp_executable = fixture;
    data.sessions = vec![record];
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(0, cx);
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("hello", window, cx));
            workspace.send_prompt(window, cx);
        })
        .expect("workspace window");
    std::thread::sleep(std::time::Duration::from_millis(500));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.drain_agent_events();
            let texts: Vec<String> = workspace
                .transcript_messages()
                .iter()
                .flat_map(|message| message.parts.iter().filter_map(|part| part.text.clone()))
                .collect();
            assert!(
                texts.iter().any(|text| text.contains("echo:hello")),
                "transcript: {texts:?}"
            );
            cx.notify();
        })
        .expect("workspace window");
}

#[gpui_kit::test]
fn grants_a_project_into_the_persisted_store(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let root = tempfile::TempDir::new().expect("test root");
    let project = root.path().join("workspace");
    std::fs::create_dir_all(&project).expect("project");
    let mut data = test_data(UiGeometry::default());
    data.home_dir = root.path().to_path_buf();
    data.user_data_dir = root.path().join("user-data");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&project, cx);
            assert_eq!(workspace.projects().len(), 1);
        })
        .expect("workspace window");
}
