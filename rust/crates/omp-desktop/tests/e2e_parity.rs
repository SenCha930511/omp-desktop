//! End-to-end parity scenarios for the Playwright retirement gate.
//!
//! Each case drives the real `Workspace` view in a headless window and asserts the
//! state the retired `tests/e2e/app.spec.ts` scenarios covered. They deliberately
//! differ from `tests/workspace.rs`, which already proves first-frame geometry, a
//! single transcript read, a real `omp` prompt, project grants, review staging,
//! settings persistence and extension discovery; here the coverage is catalog
//! ordering, the session menu's persisted mutations, schedule editing, the full
//! review stage/unstage cycle, composer drafts across views and the side-question
//! pane.
//!
//! The second half drives `Workspace::set_right_pane` and
//! `Workspace::debug_snapshot`: the public harness that reaches every right pane
//! and reads the state back as JSON, so a scenario never has to click a measured
//! position or spawn a shell or an agent.

use gpui_kit::AppContext as _;
use gpui_kit::ClipboardItem;
use gpui_kit::Context;
use gpui_kit::Focusable as _;
use gpui_kit::MouseButton;
use gpui_kit::TestAppContext;
use gpui_kit::point;
use gpui_kit::px;
use gpui_kit::size;
use gpui_kit::test::{TestEventExt as _, TestWindowExt as _};
use omp_core::geometry::{CENTER_MIN_WIDTH, UiGeometry};
use omp_core::settings::{AppSettings, ConversationDensity, MessageEnterAction, Theme};
use omp_core::state::{CURRENT_DESKTOP_STATE_FILENAME, NotificationRecord, Platform, StateStore};
use omp_core::turn_changes::{TurnBaseline, compute_turn_changes};
use omp_desktop::app::{
    AppView, CloseGuard, CloseIntent, Workspace, WorkspaceData, request_app_quit,
    should_confirm_close,
};
use omp_desktop::ime::{CompositionGuard, IME_POST_COMPOSITION_GUARD_MS};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn test_data(root: &Path) -> WorkspaceData {
    WorkspaceData {
        geometry: UiGeometry::default(),
        geometry_path: root.join("ui-geometry.json"),
        home_dir: root.join("home"),
        user_data_dir: root.join("user-data"),
        // The parity suite never runs a real `omp`: the path does not resolve, and
        // an un-granted project is rejected before any spawn is attempted.
        omp_executable: root.join("missing-omp"),
        settings: AppSettings::default(),
        projects: Vec::new(),
        sessions: Vec::new(),
    }
}

fn state_path(root: &Path) -> PathBuf {
    root.join("user-data").join(CURRENT_DESKTOP_STATE_FILENAME)
}

fn open_store(root: &Path) -> StateStore {
    StateStore::open(state_path(root), None, Platform::current()).expect("state store")
}

fn git(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git");
    assert!(status.success(), "git {args:?} failed");
}

fn seed_repo(root: &Path) -> PathBuf {
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("repo");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "OMP Test"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    #[cfg(windows)]
    {
        git(&repo, &["config", "core.autocrlf", "false"]);
        git(&repo, &["config", "core.safecrlf", "false"]);
    }
    std::fs::write(repo.join("a.txt"), "line1\n").expect("seed");
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-qm", "initial"]);
    repo
}

fn write_session(
    bucket: &Path,
    file_name: &str,
    title: &str,
    user_at: &str,
    user_text: &str,
    reply: &str,
    cwd: &Path,
) -> PathBuf {
    std::fs::create_dir_all(bucket).expect("session bucket");
    let path = bucket.join(file_name);
    let title_line = json!({
        "type": "title",
        "v": 1,
        "title": title,
        "updatedAt": user_at,
        "pad": "",
    });
    let header = json!({
        "type": "session",
        "version": 3,
        "id": title,
        "timestamp": user_at,
        "cwd": cwd.display().to_string(),
    });
    let user = json!({
        "type": "message",
        "id": "u1",
        "parentId": null,
        "timestamp": user_at,
        "message": { "role": "user", "content": user_text },
    });
    let assistant = json!({
        "type": "message",
        "id": "a1",
        "parentId": "u1",
        "timestamp": user_at,
        "message": { "role": "assistant", "content": [{ "type": "text", "text": reply }] },
    });
    std::fs::write(
        &path,
        format!("{title_line}\n{header}\n{user}\n{assistant}\n"),
    )
    .expect("session fixture");
    path
}

/// Two sessions whose user messages order them `Newer` then `Older`.
fn seed_two_sessions(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let project = root.join("project");
    let older = write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000001.jsonl",
        "Older",
        "2026-04-01T01:00:00.000Z",
        "older prompt",
        "older reply",
        &project,
    );
    let newer = write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-bbbb-7000-8000-000000000002.jsonl",
        "Newer",
        "2026-04-01T02:00:00.000Z",
        "newer prompt",
        "newer reply",
        &project,
    );
    (home, older, newer)
}

fn same_path(left: &str, right: &Path) -> bool {
    Path::new(left) == right
}

fn transcript_text(workspace: &Workspace) -> Vec<String> {
    workspace
        .transcript_messages()
        .iter()
        .flat_map(|message| message.parts.iter().filter_map(|part| part.text.clone()))
        .collect()
}

/// Clicks a window-local position, which is the only way to reach pane controls
/// that are not registered with gpui-kit's element registry.
fn click_at(cx: &mut TestAppContext, handle: gpui_kit::WindowHandle<Workspace>, x: f32, y: f32) {
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.pointer_down(point(px(x), px(y)), MouseButton::Left, cx);
            window.pointer_up(point(px(x), px(y)), MouseButton::Left, cx);
        })
        .expect("click frame");
    });
}

/// Clicks an element that opted into gpui-kit's registry with `.test_support()`,
/// so a control can be reached without a measured position.
fn click_element(
    cx: &mut TestAppContext,
    handle: gpui_kit::WindowHandle<Workspace>,
    id: &'static str,
) {
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.click(id, cx);
        })
        .expect("click element");
    });
}

#[gpui_kit::test]
fn reduce_motion_setting_controls_gpui_and_reacts_to_changes(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let mut data = test_data(root);
    data.settings.reduce_motion = true;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    cx.update(|cx| assert!(cx.reduce_motion()));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.update_setting(json!({ "reduceMotion": false }), cx);
            assert!(!workspace.settings().reduce_motion);
        })
        .expect("follow system motion");
    cx.update(|cx| {
        assert!(
            cx.reduce_motion(),
            "System preserves the last value until the test scheduler can supply an OS reading"
        );
    });
    handle
        .update(cx, |workspace, _, cx| {
            workspace.update_setting(json!({ "reduceMotion": true }), cx);
            workspace.update_setting(json!({ "reduceMotion": true }), cx);
        })
        .expect("reduce motion twice");
    cx.update(|cx| assert!(cx.reduce_motion()));
}

#[gpui_kit::test]
fn width_1000_keeps_the_right_pane_docked(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let data = test_data(root);
    let handle = cx.open_window(size(px(1000.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    let window: gpui_kit::AnyWindowHandle = handle.into();
    draw_frame(cx, window);
    handle
        .update(cx, |workspace, window, cx| {
            let layout = snapshot(workspace, cx);
            assert_eq!(layout["layout"]["rightPaneDocked"], json!(true));
            assert!(
                window.try_find("right-pane").is_some(),
                "the report docks the right pane above 980px"
            );
        })
        .expect("1000px window");
}

#[gpui_kit::test]
fn wide_sidebar_keeps_the_right_pane_available_as_a_drawer(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let mut data = test_data(root);
    data.geometry.sidebar_width = 480.0;
    let handle = cx.open_window(size(px(1000.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    let window: gpui_kit::AnyWindowHandle = handle.into();
    draw_frame(cx, window);
    handle
        .update(cx, |workspace, window, cx| {
            let layout = snapshot(workspace, cx);
            assert_eq!(layout["layout"]["rightPaneDocked"], json!(false));
            assert_eq!(layout["layout"]["overlay"], json!("rightPane"));
            assert!(window.try_find("right-pane").is_none());
        })
        .expect("constrained right pane");
    handle
        .update(cx, |workspace, _, cx| workspace.toggle_details(cx))
        .expect("open constrained drawer");
    draw_frame(cx, window);
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("right-pane").is_some());
            assert!(window.try_find("details-scrim").is_some());
            assert!(window.try_find("sidebar").is_some());
        })
        .expect("drawer above the wide sidebar");
}

#[gpui_kit::test]
fn closing_sidebar_docks_open_right_drawer_when_space_allows(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(900.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    let window: gpui_kit::AnyWindowHandle = handle.into();
    draw_frame(cx, window);
    handle
        .update(cx, |workspace, _, cx| workspace.toggle_details(cx))
        .expect("open right drawer");
    draw_frame(cx, window);
    handle
        .update(cx, |workspace, _, cx| workspace.toggle_sidebar(cx))
        .expect("close docked sidebar");
    draw_frame(cx, window);
    handle
        .update(cx, |workspace, window, cx| {
            let layout = snapshot(workspace, cx);
            assert_eq!(layout["layout"]["rightPaneDocked"], json!(true));
            assert_eq!(layout["detailsOpen"], json!(false));
            assert!(window.try_find("right-pane").is_some());
            assert!(window.try_find("details-scrim").is_none());
            assert!(window.try_find("sidebar").is_none());
        })
        .expect("right pane promotes to docked");
}

#[gpui_kit::test]
fn small_window_drawers_are_mutually_exclusive_and_dismiss_from_the_scrim(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let data = test_data(root);
    let handle = cx.open_window(size(px(700.0), px(760.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    let window: gpui_kit::AnyWindowHandle = handle.into();
    draw_frame(cx, window);
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("sidebar").is_none());
            assert!(window.try_find("right-pane").is_none());
        })
        .expect("small initial frame");
    handle
        .update(cx, |workspace, _, cx| workspace.toggle_details(cx))
        .expect("open right drawer");
    draw_frame(cx, window);
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("right-pane").is_some());
            assert!(window.try_find("details-scrim").is_some());
        })
        .expect("right drawer");
    handle
        .update(cx, |workspace, _, cx| workspace.toggle_sidebar(cx))
        .expect("open sidebar drawer");
    draw_frame(cx, window);
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("sidebar").is_some());
            assert!(window.try_find("sidebar-scrim").is_some());
            assert!(window.try_find("right-pane").is_none());
        })
        .expect("sidebar drawer");
    handle
        .update(cx, |workspace, _, cx| workspace.toggle_details(cx))
        .expect("swap back to right drawer");
    draw_frame(cx, window);
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("right-pane").is_some());
            assert!(window.try_find("sidebar").is_none());
        })
        .expect("right drawer again");
    cx.executor().advance_clock(Duration::from_millis(160));
    draw_frame(cx, window);
    cx.update(|cx| {
        cx.update_window(window, |_, window, cx| window.click("details-scrim", cx))
            .expect("dismiss scrim");
    });
    draw_frame(cx, window);
    handle
        .update(cx, |workspace, window, cx| {
            assert!(window.try_find("right-pane").is_none());
            assert_eq!(snapshot(workspace, cx)["detailsOpen"], json!(false));
        })
        .expect("all drawers dismissed");
    cx.simulate_window_resize(window, size(px(1000.0), px(760.0)));
    draw_frame(cx, window);
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("right-pane").is_some());
            assert!(window.try_find("sidebar").is_some());
        })
        .expect("docked after widening");
}

#[gpui_kit::test]
fn catalog_order_drives_session_selection(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, older, newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    let titles: Vec<&str> = catalog.iter().map(|record| record.title.as_str()).collect();
    assert_eq!(titles, ["Newer", "Older"]);
    assert!(same_path(&catalog[0].file_path, &newer));
    assert!(same_path(&catalog[1].file_path, &older));

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);
            workspace.select_session(1, cx);
            assert_eq!(transcript_text(workspace), ["older prompt", "older reply"]);
        })
        .expect("workspace window");
}

#[gpui_kit::test]
fn sidebar_groups_sessions_under_granted_and_inferred_projects(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = seed_project(root);
    let other = root.join("other-project");
    std::fs::create_dir_all(&other).expect("other project");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000011.jsonl",
        "Granted",
        "2026-04-01T01:00:00.000Z",
        "granted prompt",
        "granted reply",
        &project,
    );
    write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-bbbb-7000-8000-000000000012.jsonl",
        "Inferred",
        "2026-04-01T02:00:00.000Z",
        "inferred prompt",
        "inferred reply",
        &other,
    );

    let mut store = open_store(root);
    omp_core::projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    let projects = omp_core::projects::list_projects(&store);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    data.projects = projects;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            let state = snapshot(workspace, cx);
            let groups = state["sidebarGroups"].as_array().expect("sidebar groups");
            assert_eq!(groups.len(), 2);
            assert_eq!(groups[0]["name"], "project");
            assert_eq!(groups[0]["sessions"], json!([1]));
            assert_eq!(groups[1]["name"], "other-project");
            assert_eq!(groups[1]["sessions"], json!([0]));
        })
        .expect("workspace window");
}

#[gpui_kit::test]
fn settings_patches_round_trip_through_the_state_file(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            // Two partial patches: the second must merge, not replace, the first.
            workspace.update_setting(json!({ "theme": "dark" }), cx);
            assert_eq!(workspace.settings().theme, Theme::Dark);
            workspace.update_setting(json!({ "conversationDensity": "compact" }), cx);
            assert_eq!(
                workspace.settings().conversation_density,
                ConversationDensity::Compact
            );
            assert_eq!(workspace.settings().theme, Theme::Dark);
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(store.settings().theme, Theme::Dark);
    assert_eq!(
        store.settings().conversation_density,
        ConversationDensity::Compact
    );
}

#[gpui_kit::test]
fn pinning_a_session_persists_without_reordering_the_catalog(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 2);

    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(1, cx);
            workspace.session_menu_action("Pin", cx);
            // Pinning must not clear the open transcript.
            assert_eq!(transcript_text(workspace), ["older prompt", "older reply"]);
            // The refreshed catalog keeps the pinned session at the same index.
            workspace.select_session(1, cx);
            assert_eq!(transcript_text(workspace), ["older prompt", "older reply"]);
        })
        .expect("workspace window");

    let store = open_store(root);
    let records = omp_core::sessions::list_sessions(&store, &home, false, None);
    assert_eq!(records.len(), 2);
    let titles: Vec<&str> = records.iter().map(|record| record.title.as_str()).collect();
    assert_eq!(titles, ["Newer", "Older"]);
    assert!(records[1].pinned, "the pinned session is Older");
    assert!(!records[0].pinned);
    assert!(same_path(&records[1].file_path, &older));
}

#[gpui_kit::test]
fn archiving_a_session_persists_and_leaves_the_catalog(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(1, cx);
            workspace.session_menu_action("Archive", cx);
            // Archiving hides the session, so the catalog now starts with Newer.
            workspace.select_session(0, cx);
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);
        })
        .expect("workspace window");

    let store = open_store(root);
    let visible = omp_core::sessions::list_sessions(&store, &home, false, None);
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].title, "Newer");
    let all = omp_core::sessions::list_sessions(&store, &home, true, None);
    assert_eq!(all.len(), 2);
    let archived = all
        .iter()
        .find(|record| same_path(&record.file_path, &older))
        .expect("archived session record");
    assert!(archived.archived);
    assert!(older.exists(), "archiving keeps the JSONL file");
}

#[gpui_kit::test]
fn deleting_a_session_removes_the_file_and_clears_the_transcript(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let session = write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-cccc-7000-8000-000000000003.jsonl",
        "Doomed",
        "2026-04-01T00:00:01.000Z",
        "doomed prompt",
        "doomed reply",
        &root.join("project"),
    );

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(
                transcript_text(workspace),
                ["doomed prompt", "doomed reply"]
            );
            workspace.session_menu_action("Delete", cx);
            assert!(workspace.transcript_messages().is_empty());
            // Nothing is left to select, so the transcript stays empty.
            workspace.select_session(0, cx);
            assert!(workspace.transcript_messages().is_empty());
        })
        .expect("workspace window");

    assert!(!session.exists(), "the JSONL file is removed");
    let store = open_store(root);
    assert!(omp_core::sessions::list_sessions(&store, &home, true, None).is_empty());
}

#[gpui_kit::test]
fn schedules_pause_resume_and_delete_through_the_workspace(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project");

    let mut store = open_store(root);
    omp_core::projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    let project_id = omp_core::projects::list_projects(&store)
        .first()
        .expect("granted project")
        .id
        .clone();
    let schedule = omp_core::schedules::create(
        &mut store,
        &json!({
            "title": "Parity sweep",
            "prompt": "Summarize the day",
            "target": { "kind": "project", "projectId": project_id },
            "timing": { "kind": "once", "at": "2030-01-01T00:00:00.000Z" },
            "execution": { "model": "anthropic/claude", "thinking": "medium", "speed": "normal" },
        }),
        // Only "user" and "agent" records survive the state file's reload parser.
        "user",
    )
    .expect("create schedule");
    let schedule_id = schedule["id"].as_str().expect("schedule id").to_string();
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.refresh_schedules();
            assert_eq!(workspace.schedules().len(), 1);
            assert_eq!(workspace.schedules()[0]["status"], "active");

            workspace.set_schedule_status(&schedule_id, "paused", cx);
            assert_eq!(workspace.schedules()[0]["status"], "paused");

            workspace.set_schedule_status(&schedule_id, "active", cx);
            assert_eq!(workspace.schedules()[0]["status"], "active");

            workspace.delete_schedule(&schedule_id, cx);
            assert!(workspace.schedules().is_empty());
        })
        .expect("workspace window");

    let store = open_store(root);
    assert!(omp_core::schedules::list(&store).is_empty());
}

#[gpui_kit::test]
fn review_panel_snapshots_stages_and_unstages_a_real_repo(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&repo, cx);
            std::fs::write(repo.join("a.txt"), "line1\nline2\n").expect("edit");

            workspace.refresh_review();
            let snapshot = workspace.review_status().expect("review snapshot");
            assert!(snapshot.is_repo);
            assert_eq!(snapshot.branch.as_deref(), Some("main"));
            assert!(
                snapshot
                    .files
                    .iter()
                    .any(|file| file.path == "a.txt" && !file.staged)
            );

            workspace.stage_path("a.txt", true, cx);
            let staged = workspace.review_status().expect("staged snapshot");
            assert!(
                staged
                    .files
                    .iter()
                    .any(|file| file.path == "a.txt" && file.staged)
            );

            workspace.stage_path("a.txt", false, cx);
            let unstaged = workspace.review_status().expect("unstaged snapshot");
            assert!(
                unstaged
                    .files
                    .iter()
                    .any(|file| file.path == "a.txt" && !file.staged)
            );
        })
        .expect("workspace window");
}

#[gpui_kit::test]
fn plugin_catalog_discovers_project_skills(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let project = root.join("workspace");
    let skill_dir = project.join(".omp/skills/demo");
    std::fs::create_dir_all(&skill_dir).expect("skill dir");
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: Demo Skill\ndescription: Fixture\n---\nBody\n",
    )
    .expect("skill");
    std::fs::write(project.join(".omp/skills/loose.md"), "# Loose Skill\n").expect("loose skill");

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&project, cx);
            workspace.refresh_plugins();
            let catalog = workspace.plugin_catalog().expect("plugin catalog");
            assert!(catalog.warnings.is_empty(), "{:?}", catalog.warnings);
            let demo = catalog
                .skills
                .iter()
                .find(|skill| skill.name == "Demo Skill")
                .expect("frontmatter skill");
            assert_eq!(demo.kind, "skill");
            assert_eq!(demo.location, "project");
            assert_eq!(demo.description, "Fixture");
            let loose = catalog
                .skills
                .iter()
                .find(|skill| skill.name == "Loose Skill")
                .expect("heading skill");
            assert_eq!(loose.location, "project");
        })
        .expect("workspace window");
}

/// The Extensions page writes an MCP server's or package's state to the file
/// its row came from and reports what the refreshed catalog says.
///
/// The user and project rows go through the same `set_extension_enabled` the
/// row's button calls. A package row writes the plugin runtime lock the CLI
/// uses, so the refreshed catalog draws the new state and the page reports
/// success.
#[gpui_kit::test]
fn extension_rows_toggle_mcp_servers_and_packages(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let agent_dir = home.join(".omp/agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let user_mcp = agent_dir.join("mcp.json");
    std::fs::write(
        &user_mcp,
        json!({
            "mcpServers": {
                "docs": { "type": "stdio", "command": "docs-server" },
            }
        })
        .to_string(),
    )
    .expect("user mcp config");
    let package_dir = home.join(".omp/plugins/node_modules/demo-package");
    std::fs::create_dir_all(&package_dir).expect("package dir");
    std::fs::write(
        package_dir.join("package.json"),
        json!({ "name": "demo-package", "description": "Fixture package" }).to_string(),
    )
    .expect("package manifest");

    let project = root.join("workspace");
    std::fs::create_dir_all(project.join(".omp")).expect("project dir");
    let project_mcp = project.join(".omp/mcp.json");
    std::fs::write(
        &project_mcp,
        json!({
            "mcpServers": {
                "project-docs": { "type": "stdio", "command": "project-docs-server" },
            }
        })
        .to_string(),
    )
    .expect("project mcp config");

    let mut data = test_data(root);
    data.home_dir = home.clone();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            let read = |path: &Path| -> Value {
                serde_json::from_str(&std::fs::read_to_string(path).expect("read config"))
                    .expect("config json")
            };
            workspace.grant_project(&project, cx);
            workspace.refresh_plugins();
            let row = |workspace: &Workspace, name: &str| -> (bool, String) {
                let record = workspace
                    .plugin_catalog()
                    .expect("catalog")
                    .skills
                    .iter()
                    .find(|skill| skill.name == name)
                    .unwrap_or_else(|| panic!("{name} row"));
                (record.enabled, record.location.clone())
            };
            assert_eq!(row(workspace, "docs"), (true, "user".to_string()));
            assert_eq!(
                row(workspace, "project-docs"),
                (true, "project".to_string())
            );
            assert_eq!(row(workspace, "demo-package"), (true, "user".to_string()));

            // Disabling the user server writes `disabledServers` to the user
            // file and the refreshed row draws the new state.
            workspace.set_extension_enabled("docs", false, cx);
            let config = read(&user_mcp);
            assert_eq!(config["disabledServers"], json!(["docs"]));
            assert_eq!(config["enabledServers"], json!([]));
            assert_eq!(row(workspace, "docs"), (false, "user".to_string()));
            let snapshot = workspace.debug_snapshot(cx);
            assert_eq!(
                snapshot["extensionStatus"]["status"],
                json!("Extensions updated")
            );
            assert!(snapshot["extensionStatus"]["error"].is_null());
            assert_eq!(
                snapshot["extensionStatus"]["rows"],
                json!([
                    { "name": "project-docs", "kind": "mcp", "enabled": true, "scope": "project" },
                    { "name": "demo-package", "kind": "package", "enabled": true, "scope": "user" },
                    { "name": "docs", "kind": "mcp", "enabled": false, "scope": "user" },
                ])
            );

            // Enabling it again clears the disabled list and records the server
            // as explicitly enabled.
            workspace.set_extension_enabled("docs", true, cx);
            let config = read(&user_mcp);
            assert_eq!(config["disabledServers"], json!([]));
            assert_eq!(config["enabledServers"], json!(["docs"]));
            assert_eq!(row(workspace, "docs"), (true, "user".to_string()));
            assert_eq!(
                workspace.debug_snapshot(cx)["extensionStatus"]["status"],
                json!("Extensions updated")
            );

            // A project row writes the project's own file; the user file the
            // previous steps touched stays as they left it.
            workspace.set_extension_enabled("project-docs", false, cx);
            assert_eq!(
                read(&project_mcp)["disabledServers"],
                json!(["project-docs"])
            );
            assert_eq!(
                row(workspace, "project-docs"),
                (false, "project".to_string())
            );
            let user_config = read(&user_mcp);
            assert_eq!(user_config["disabledServers"], json!([]));
            assert_eq!(user_config["enabledServers"], json!(["docs"]));

            // A package row writes the plugin runtime lock the CLI uses, so
            // discovery reports the new state and the page reports success.
            workspace.set_extension_enabled("demo-package", false, cx);
            let lock = read(&home.join(".omp/plugins/omp-plugins.lock.json"));
            assert_eq!(lock["plugins"]["demo-package"]["enabled"], json!(false));
            assert_eq!(row(workspace, "demo-package"), (false, "user".to_string()));
            let snapshot = workspace.debug_snapshot(cx);
            assert_eq!(
                snapshot["extensionStatus"]["status"],
                json!("Extensions updated")
            );
            assert!(snapshot["extensionStatus"]["error"].is_null());
            assert_eq!(
                snapshot["extensionStatus"]["rows"],
                json!([
                    { "name": "project-docs", "kind": "mcp", "enabled": false, "scope": "project" },
                    { "name": "demo-package", "kind": "package", "enabled": false, "scope": "user" },
                    { "name": "docs", "kind": "mcp", "enabled": true, "scope": "user" },
                ])
            );

            workspace.set_extension_enabled("demo-package", true, cx);
            let lock = read(&home.join(".omp/plugins/omp-plugins.lock.json"));
            assert_eq!(lock["plugins"]["demo-package"]["enabled"], json!(true));
            assert_eq!(row(workspace, "demo-package"), (true, "user".to_string()));
            assert_eq!(
                workspace.debug_snapshot(cx)["extensionStatus"]["status"],
                json!("Extensions updated")
            );

            // A name the catalog does not carry is refused before any file is
            // touched.
            workspace.set_extension_enabled("missing-server", false, cx);
            let snapshot = workspace.debug_snapshot(cx);
            let error = snapshot["extensionStatus"]["error"]
                .as_str()
                .expect("unknown row banner");
            assert!(
                error.contains("missing-server is not in the catalog"),
                "{error}"
            );
            workspace.set_view(AppView::Plugins, cx);
        })
        .expect("workspace window");
    // Drawing the page builds every row, its toggle and the failure banner, so
    // a control that cannot render with this state fails the scenario.
    draw_frame(cx, handle.into());
}

/// Without a state store the Extensions page cannot authorize a write, so the
/// toggle fails visibly and the config file stays untouched.
#[gpui_kit::test]
fn extension_toggle_reports_an_unavailable_state_store(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let agent_dir = home.join(".omp/agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let user_mcp = agent_dir.join("mcp.json");
    std::fs::write(
        &user_mcp,
        json!({
            "mcpServers": {
                "docs": { "type": "stdio", "command": "docs-server" },
            }
        })
        .to_string(),
    )
    .expect("user mcp config");
    // `user-data` is a file, so the workspace's state store cannot open; the
    // Extensions page still discovers and draws rows, but has nothing to
    // authorize a project write with and no store to hand the core.
    std::fs::write(root.join("user-data"), "not a directory").expect("blocked user data");

    let mut data = test_data(root);
    data.home_dir = home.clone();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.refresh_plugins();
            workspace.set_extension_enabled("docs", false, cx);
            let snapshot = workspace.debug_snapshot(cx);
            let error = snapshot["extensionStatus"]["error"]
                .as_str()
                .expect("store failure banner");
            assert!(error.contains("state store is unavailable"), "{error}");
            assert!(snapshot["extensionStatus"]["status"].is_null());
            let config: Value =
                serde_json::from_str(&std::fs::read_to_string(&user_mcp).expect("read config"))
                    .expect("config json");
            assert!(
                config.get("disabledServers").is_none(),
                "a failed toggle must not write the config: {config}"
            );
        })
        .expect("workspace window");
}

/// The Extensions page installs a plugin from its source field, re-reads the
/// catalog and reports the outcome in the page's banner.
///
/// `plugins::install` shells out to `omp plugin install` and accepts only
/// `npm:` specs, which the parity suite cannot run: it never spawns a real
/// `omp`. The scenario therefore swaps the page's installer for a stand-in
/// that installs a temp local source. Everything the page owns stays real: the
/// field is typed into, `submit_plugin_install` reads it, the installer is
/// handed the app's own `CliContext`, and the catalog refresh and banner are
/// the production ones.
#[gpui_kit::test]
fn extensions_install_row_installs_a_source_and_reports_failures(cx: &mut TestAppContext) {
    use std::sync::{Arc, Mutex};

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let agent_dir = home.join(".omp/agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // The minimal source discovery accepts: a directory whose `package.json`
    // names the plugin.
    let source = root.join("plugin-source");
    std::fs::create_dir_all(&source).expect("source dir");
    std::fs::write(
        source.join("package.json"),
        json!({ "name": "demo-plugin", "description": "Fixture plugin" }).to_string(),
    )
    .expect("source manifest");

    let mut data = test_data(root);
    data.home_dir = home.clone();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));

    let calls: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    handle
        .update(cx, |workspace, _, cx| {
            let calls = calls.clone();
            let source_dir = source.clone();
            workspace.set_plugin_installer(move |context, submitted| {
                calls.lock().expect("install calls").push((
                    context.home_dir.display().to_string(),
                    submitted.to_string(),
                ));
                if submitted != source_dir.display().to_string() {
                    return Err(format!("could not read the plugin source at {submitted}"));
                }
                // Stand in for `omp plugin install`: the package lands in the
                // home's plugin root, which is what discovery reads.
                let package = context
                    .home_dir
                    .join(".omp/plugins/node_modules/demo-plugin");
                std::fs::create_dir_all(&package).expect("package dir");
                std::fs::copy(
                    source_dir.join("package.json"),
                    package.join("package.json"),
                )
                .expect("package manifest");
                Ok(json!({ "ok": true }))
            });
            workspace.refresh_plugins();
            workspace.set_view(AppView::Plugins, cx);
        })
        .expect("install seam");

    // Typing into the field the page draws is what the row's button reads.
    let field = handle
        .update(cx, |workspace, _, _| {
            workspace.plugin_source_entity().clone()
        })
        .expect("plugin source field");
    // `commit_text` renders a frame, so it is driven against the window alone
    // rather than from inside a root-view update.
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            let bounds = gpui_kit::Bounds::new(point(px(0.0), px(0.0)), size(px(0.0), px(0.0)));
            let mut input = gpui_kit::test::TestInput::new(
                gpui_kit::ElementInputHandler::new(bounds, field.clone()),
                window,
            );
            input.commit_text(&source.display().to_string(), cx);
        })
        .expect("type source");
    });

    handle
        .update(cx, |workspace, _, cx| {
            workspace.submit_plugin_install(cx);
            let snapshot = workspace.debug_snapshot(cx);
            assert_eq!(snapshot["pluginInstallStatus"]["installing"], json!(true));
            assert_eq!(
                snapshot["pluginInstallStatus"]["source"],
                json!(source.display().to_string())
            );
            // The previous banner is cleared before the harness is asked.
            assert!(snapshot["extensionStatus"]["status"].is_null());
            assert!(snapshot["extensionStatus"]["error"].is_null());
        })
        .expect("submit source");
    cx.run_until_parked();

    handle
        .update(cx, |workspace, _, cx| {
            let snapshot = workspace.debug_snapshot(cx);
            assert_eq!(
                snapshot["extensionStatus"]["status"],
                json!("Plugin installed")
            );
            assert!(snapshot["extensionStatus"]["error"].is_null());
            assert_eq!(snapshot["pluginInstallStatus"]["installing"], json!(false));
            let catalog = workspace.plugin_catalog().expect("catalog");
            let installed = catalog
                .skills
                .iter()
                .find(|skill| skill.name == "demo-plugin")
                .expect("installed plugin row");
            assert_eq!(installed.kind, "package");
            assert_eq!(installed.location, "user");
            assert!(installed.enabled);
            // The installer saw the app's own home directory and the exact
            // source the field carried.
            let calls = calls.lock().expect("install calls").clone();
            assert_eq!(
                calls,
                vec![(home.display().to_string(), source.display().to_string())]
            );
        })
        .expect("installed");

    // A source the installer refuses leaves the field as typed and states the
    // failure in the banner; the catalog keeps the plugin that did install.
    let missing = root.join("missing-plugin").display().to_string();
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            let field = field.clone();
            field.update(cx, |state, cx| state.select_all(window, cx));
            let bounds = gpui_kit::Bounds::new(point(px(0.0), px(0.0)), size(px(0.0), px(0.0)));
            let mut input = gpui_kit::test::TestInput::new(
                gpui_kit::ElementInputHandler::new(bounds, field),
                window,
            );
            input.commit_text(&missing, cx);
        })
        .expect("type missing source");
    });
    handle
        .update(cx, |workspace, _, cx| workspace.submit_plugin_install(cx))
        .expect("submit missing source");
    cx.run_until_parked();

    handle
        .update(cx, |workspace, _, cx| {
            let snapshot = workspace.debug_snapshot(cx);
            let error = snapshot["extensionStatus"]["error"]
                .as_str()
                .expect("install failure banner");
            assert_eq!(
                error,
                format!(
                    "OMP could not install the plugin: could not read the plugin source at {missing}"
                )
            );
            assert!(snapshot["extensionStatus"]["status"].is_null());
            assert_eq!(snapshot["pluginInstallStatus"]["source"], json!(missing));
            assert_eq!(snapshot["pluginInstallStatus"]["installing"], json!(false));
            assert!(
                workspace
                    .plugin_catalog()
                    .expect("catalog")
                    .skills
                    .iter()
                    .any(|skill| skill.name == "demo-plugin"),
                "the installed plugin stays in the refreshed catalog"
            );
        })
        .expect("failed install");

    // An empty field is inert: no installer call and no new banner.
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            let field = field.clone();
            field.update(cx, |state, cx| state.select_all(window, cx));
            let bounds = gpui_kit::Bounds::new(point(px(0.0), px(0.0)), size(px(0.0), px(0.0)));
            let mut input = gpui_kit::test::TestInput::new(
                gpui_kit::ElementInputHandler::new(bounds, field),
                window,
            );
            input.commit_text("", cx);
        })
        .expect("clear source");
    });
    handle
        .update(cx, |workspace, _, cx| {
            workspace.submit_plugin_install(cx);
            let snapshot = workspace.debug_snapshot(cx);
            assert_eq!(snapshot["pluginInstallStatus"]["source"], json!(""));
            assert_eq!(snapshot["pluginInstallStatus"]["installing"], json!(false));
            assert!(!snapshot["extensionStatus"]["error"].is_null());
            assert_eq!(calls.lock().expect("install calls").len(), 2);
        })
        .expect("empty source");

    // Drawing the page builds the install row, its field and its button, so a
    // control that cannot render with this state fails the scenario.
    draw_frame(cx, handle.into());
}

#[gpui_kit::test]
fn composer_draft_survives_a_view_switch(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, window, cx| {
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("unsent draft", window, cx));
            workspace.set_view(AppView::Settings, cx);
            workspace.set_view(AppView::Workspace, cx);
            assert_eq!(
                workspace.composer_entity().read(cx).value().to_string(),
                "unsent draft"
            );
        })
        .expect("workspace window");
}

/// The Side Question pane draws its own input and leaves the transcript alone.
///
/// The harness reaches panes through `set_right_pane`, but this case keeps
/// clicking the launcher row: gpui-kit only addresses elements that opt into
/// `.test_support()`, so it is clicked at its measured window-local position in
/// a 1280x800 window: the rows
/// sit at Summary 70, Review 109, Files 148, Browser 187, Side Question 224 and
/// Subagents 263, on roughly a 39px pitch. The Review row doubles as the control:
/// `select_session` only refreshes the review panel while that pane is open, so a
/// click on it is observable through `review_status`, and a launcher that no longer
/// matches these positions fails the test instead of passing silently.
#[gpui_kit::test]
fn side_question_pane_renders_without_touching_the_transcript(cx: &mut TestAppContext) {
    const PANE_X: f32 = 1100.0;
    const REVIEW_ROW_Y: f32 = 109.0;
    const SIDE_QUESTION_ROW_Y: f32 = 224.0;
    const BELOW_LAUNCHER_Y: f32 = 400.0;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-repo");
    write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-dddd-7000-8000-000000000004.jsonl",
        "Side Question",
        "2026-04-01T00:00:01.000Z",
        "main prompt",
        "main reply",
        &repo,
    );
    let mut store = open_store(root);
    omp_core::projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        repo.to_str().expect("repo path"),
    )
    .expect("grant");
    let projects = omp_core::projects::list_projects(&store);
    let sessions = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    let build = || {
        let mut data = test_data(root);
        data.home_dir = home.clone();
        data.projects = projects.clone();
        data.sessions = sessions.clone();
        data
    };

    // Control: the measured Review row really does open the Review pane.
    let control = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, build())
    });
    click_at(cx, control, PANE_X, REVIEW_ROW_Y);
    let review_open = control
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            workspace.review_status().is_some()
        })
        .expect("control window");
    assert!(review_open, "the Review launcher row did not open its pane");

    // Below the launcher there is no row, so the Review click still lands.
    let below = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, build())
    });
    click_at(cx, below, PANE_X, BELOW_LAUNCHER_Y);
    click_at(cx, below, PANE_X, REVIEW_ROW_Y);
    let review_after_below = below
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            workspace.review_status().is_some()
        })
        .expect("below-launcher window");
    assert!(
        review_after_below,
        "the launcher ends above y=400 in a 1280x800 window"
    );

    // Clicking the Side Question row consumes the launcher, so the following
    // Review click finds no row and the review panel stays closed.
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, build())
    });
    click_at(cx, handle, PANE_X, SIDE_QUESTION_ROW_Y);
    click_at(cx, handle, PANE_X, REVIEW_ROW_Y);
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert!(
                workspace.review_status().is_none(),
                "the Side Question row did not replace the launcher"
            );
            // The pane switch never touches the main transcript.
            assert_eq!(transcript_text(workspace), ["main prompt", "main reply"]);
            assert_eq!(workspace.transcript_messages().len(), 2);
        })
        .expect("side question window");
}

/// The workspace state the harness reads back, as JSON.
fn snapshot(workspace: &Workspace, cx: &mut Context<Workspace>) -> Value {
    workspace.debug_snapshot(cx)
}

/// A project with one directory and one file, so the Files pane has both kinds.
fn seed_project(root: &Path) -> PathBuf {
    let project = root.join("project");
    std::fs::create_dir_all(project.join("src")).expect("project");
    std::fs::write(project.join("README.md"), "# Parity\n").expect("readme");
    std::fs::write(project.join("src/lib.rs"), "pub fn parity() {}\n").expect("lib");
    project
}

/// The Files pane lists a granted project's entries, directories first.
#[gpui_kit::test]
fn files_pane_lists_a_granted_project(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let project = seed_project(root);

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&project, cx);
            workspace.set_right_pane("files", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "files");
            assert_eq!(state["files"]["error"], json!(null));
            assert_eq!(state["files"]["skipped"], json!(0));
            let entries = state["files"]["entries"].as_array().expect("entries");
            let paths: Vec<&str> = entries
                .iter()
                .filter_map(|entry| entry["path"].as_str())
                .collect();
            assert_eq!(paths, ["src", "src/lib.rs", "README.md"]);
            assert_eq!(entries[0]["kind"], "directory");
            assert_eq!(entries[1]["kind"], "file");
        })
        .expect("workspace window");
}

/// The Subagents pane opens with no agent runtime started.
#[gpui_kit::test]
fn subagents_pane_reports_an_empty_runtime_list(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("subagents", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "subagents");
            assert_eq!(state["subagents"], json!([]));
            assert!(
                state["transcript"]
                    .as_array()
                    .expect("transcript")
                    .is_empty()
            );
        })
        .expect("workspace window");
}

/// Live Voice opens on its idle phase while no runtime can carry the audio.
#[gpui_kit::test]
fn live_voice_pane_reports_the_unconfigured_phase(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("live-voice", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "live-voice");
            assert_eq!(state["liveVoice"]["runtime"], json!(false));
            assert_eq!(state["liveVoice"]["phase"], "idle");
            assert_eq!(state["liveVoice"]["active"], json!(false));
            assert_eq!(state["liveVoice"]["error"], json!(null));
        })
        .expect("workspace window");
}

/// The terminal panel opens stopped: no PTY, no shell and no error.
#[gpui_kit::test]
fn terminal_panel_opens_stopped_without_spawning_a_shell(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("terminal", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["terminal"]["open"], json!(true));
            assert_eq!(state["terminal"]["session"], json!(false));
            assert_eq!(state["terminal"]["running"], json!(false));
            assert_eq!(state["terminal"]["error"], json!(null));
            // The terminal is a panel of its own, not a right-pane page.
            assert_eq!(state["rightPane"], "launcher");
        })
        .expect("workspace window");
}

/// The Browser pane opens with nothing captured and no annotation error.
///
/// A headless window never loads a page, so the picker has no failure to report
/// and no annotation waiting for the composer: the pane reports that clean state
/// instead of leaving the last capture behind.
#[cfg(not(target_os = "linux"))]
#[gpui_kit::test]
fn browser_pane_opens_and_reports_the_annotation_state(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("browser", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "browser");
            assert_eq!(
                state["browser"]["annotation"],
                json!({ "error": null, "preview": null })
            );
            assert_eq!(state["composer"]["text"], "");
        })
        .expect("workspace window");
}

/// Settings navigation round-trips: the snapshot follows the view, and the
/// settings it reports are the ones the state file just took.
#[gpui_kit::test]
fn settings_navigation_round_trips_through_the_snapshot(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.update_setting(json!({ "theme": "dark" }), cx);
            workspace.update_setting(json!({ "conversationDensity": "compact" }), cx);

            workspace.set_view(AppView::Settings, cx);
            let settings = snapshot(workspace, cx);
            assert_eq!(settings["view"], "settings");
            assert_eq!(settings["settings"]["theme"], "dark");
            assert_eq!(settings["settings"]["density"], "compact");

            workspace.set_view(AppView::Workspace, cx);
            let workspace_view = snapshot(workspace, cx);
            assert_eq!(workspace_view["view"], "workspace");
            assert_eq!(workspace_view["settings"], settings["settings"]);
        })
        .expect("workspace window");
}

/// A 1280px window docks both panes and leaves the rest to the transcript.
#[gpui_kit::test]
fn layout_snapshot_reports_the_docked_widths(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    handle
        .update(cx, |workspace, _, cx| {
            let layout = &snapshot(workspace, cx)["layout"];
            assert_eq!(layout["sidebarDocked"], json!(true));
            assert_eq!(layout["sidebarWidth"].as_f64(), Some(248.0));
            assert_eq!(layout["rightPaneDocked"], json!(true));
            assert_eq!(layout["rightPaneWidth"].as_f64(), Some(571.0));
            assert_eq!(layout["centerWidth"].as_f64(), Some(461.0));
            assert_eq!(layout["overlay"], json!(null));
        })
        .expect("workspace window");
}

/// Below the render breakpoint the workspace is one pane: the right pane leaves
/// the row, the toolbar grows a Details toggle, and pressing it draws the same
/// pane over the transcript. A wide window keeps the docked pane and no toggle.
#[gpui_kit::test]
fn compact_layout_hides_the_right_pane_behind_a_details_toggle(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();

    // 900px: the sidebar docks, the right pane is collapsed behind Details.
    let compact = cx.open_window(size(px(900.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    compact
        .update(cx, |workspace, window, cx| {
            let state = snapshot(workspace, cx);
            assert_eq!(state["compactLayout"], json!(true));
            assert_eq!(state["detailsOpen"], json!(false));
            assert_eq!(state["layout"]["sidebarDocked"], json!(true));
            assert_eq!(state["layout"]["rightPaneDocked"], json!(false));
            assert!(
                window.try_find("right-pane").is_none(),
                "the compact layout drew the right pane instead of the toggle"
            );
        })
        .expect("compact window");

    // The toggle raises the pane as an overlay.
    compact
        .update(cx, |workspace, _window, cx| workspace.toggle_details(cx))
        .expect("toggle details");
    compact
        .update(cx, |workspace, window, cx| {
            assert_eq!(snapshot(workspace, cx)["detailsOpen"], json!(true));
            assert!(
                window.try_find("right-pane").is_some(),
                "the Details toggle did not draw the right pane"
            );
        })
        .expect("opened details");

    // A second press closes it, and a third reopens it: the control is a
    // toggle, not a one-way door.
    compact
        .update(cx, |workspace, _window, cx| workspace.toggle_details(cx))
        .expect("toggle details");
    compact
        .update(cx, |workspace, window, cx| {
            assert_eq!(snapshot(workspace, cx)["detailsOpen"], json!(false));
            assert!(window.try_find("right-pane").is_none());
        })
        .expect("closed details");
    compact
        .update(cx, |workspace, _window, cx| workspace.toggle_details(cx))
        .expect("toggle details");
    compact
        .update(cx, |workspace, window, cx| {
            assert_eq!(snapshot(workspace, cx)["detailsOpen"], json!(true));
            assert!(window.try_find("right-pane").is_some());
        })
        .expect("reopened details");

    // 1400px stays three-pane: the pane is in the row and there is no toggle.
    let wide = cx.open_window(size(px(1400.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    wide.update(cx, |workspace, window, cx| {
        let state = snapshot(workspace, cx);
        assert_eq!(state["compactLayout"], json!(false));
        assert_eq!(state["detailsOpen"], json!(false));
        assert_eq!(state["layout"]["rightPaneDocked"], json!(true));
        assert!(
            window.try_find("right-pane").is_some(),
            "the wide layout dropped the docked right pane"
        );
    })
    .expect("wide window");
}

/// A draft is part of the snapshot and outlives any pane switch.
#[gpui_kit::test]
fn composer_draft_is_visible_in_the_snapshot_and_survives_a_pane_switch(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, window, cx| {
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| {
                state.set_value("half-written prompt", window, cx);
            });
            assert_eq!(
                snapshot(workspace, cx)["composer"]["text"],
                "half-written prompt"
            );

            workspace.set_right_pane("subagents", cx);
            assert_eq!(
                snapshot(workspace, cx)["composer"]["text"],
                "half-written prompt"
            );
            workspace.set_right_pane("launcher", cx);
            assert_eq!(
                snapshot(workspace, cx)["composer"]["text"],
                "half-written prompt"
            );
        })
        .expect("workspace window");
}

/// The Review pane reports the granted repository's branch and a clean tree.
#[gpui_kit::test]
fn review_pane_reports_the_branch_of_a_granted_repo(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&repo, cx);
            workspace.set_right_pane("review", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "review");
            assert_eq!(state["review"]["error"], json!(null));
            assert_eq!(state["review"]["status"]["isRepo"], json!(true));
            assert_eq!(state["review"]["status"]["branch"], "main");
            assert_eq!(state["review"]["status"]["files"], json!([]));
        })
        .expect("workspace window");
}

/// The Schedules view opens on an empty state file with nothing to run.
#[gpui_kit::test]
fn schedules_pane_reports_an_empty_list(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_view(AppView::Schedules, cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["view"], "schedules");
            assert_eq!(state["schedules"], json!([]));
        })
        .expect("workspace window");
}

/// The composer's Enter action toggles and outlives the window.
///
/// The snapshot's `settings` object carries the theme and density, while the
/// Enter action is read from `settings()`; the round trip is therefore proven
/// through the getter and a store reopened over the same state file.
#[gpui_kit::test]
fn composer_enter_action_toggles_and_persists(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            assert_eq!(
                workspace.settings().message_enter_action,
                MessageEnterAction::Steer
            );

            workspace.update_setting(json!({ "messageEnterAction": "queue" }), cx);
            assert_eq!(
                workspace.settings().message_enter_action,
                MessageEnterAction::Queue
            );
            // The snapshot is still a settings view of the same state.
            assert_eq!(
                snapshot(workspace, cx)["settings"]["density"],
                "comfortable"
            );

            workspace.update_setting(json!({ "messageEnterAction": "steer" }), cx);
            assert_eq!(
                workspace.settings().message_enter_action,
                MessageEnterAction::Steer
            );

            workspace.update_setting(json!({ "messageEnterAction": "queue" }), cx);
            assert_eq!(
                workspace.settings().message_enter_action,
                MessageEnterAction::Queue
            );
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(
        store.settings().message_enter_action,
        MessageEnterAction::Queue
    );
}

/// The theme lands in the state file and in the next window's snapshot.
#[gpui_kit::test]
fn theme_setting_round_trips_through_the_state_file_and_snapshot(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.update_setting(json!({ "theme": "light" }), cx);
            assert_eq!(workspace.settings().theme, Theme::Light);
            assert_eq!(snapshot(workspace, cx)["settings"]["theme"], "light");

            workspace.update_setting(json!({ "theme": "dark" }), cx);
            assert_eq!(workspace.settings().theme, Theme::Dark);
            assert_eq!(snapshot(workspace, cx)["settings"]["theme"], "dark");
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(store.settings().theme, Theme::Dark);

    // A window bootstrapped from the persisted settings starts dark.
    let mut data = test_data(root);
    data.settings = store.settings();
    drop(store);
    let reopened = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    reopened
        .update(cx, |workspace, _, cx| {
            assert_eq!(workspace.settings().theme, Theme::Dark);
            assert_eq!(snapshot(workspace, cx)["settings"]["theme"], "dark");
        })
        .expect("reopened window");
}

/// Density and text size persist together, in the snapshot and on disk.
#[gpui_kit::test]
fn conversation_density_and_text_size_persist(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.update_setting(
                json!({ "conversationDensity": "compact", "interfaceFontScale": 115 }),
                cx,
            );

            assert_eq!(
                workspace.settings().conversation_density,
                ConversationDensity::Compact
            );
            assert_eq!(workspace.settings().interface_font_scale, 115);
            assert_eq!(snapshot(workspace, cx)["settings"]["density"], "compact");
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(
        store.settings().conversation_density,
        ConversationDensity::Compact
    );
    assert_eq!(store.settings().interface_font_scale, 115);
}

/// A wide right pane yields to the center column instead of squeezing it below
/// its minimum: the pane is clamped so `centerWidth` lands exactly on the floor.
#[gpui_kit::test]
fn narrow_window_layout_keeps_the_center_at_its_minimum_width(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let geometry = UiGeometry {
        right_pane_width: 720.0,
        ..UiGeometry::default()
    };
    let mut data = test_data(root);
    data.geometry = geometry;
    let handle = cx.open_window(size(px(1000.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    handle
        .update(cx, |workspace, _, cx| {
            let layout = &snapshot(workspace, cx)["layout"];
            assert_eq!(layout["sidebarDocked"], json!(true));
            assert_eq!(layout["sidebarWidth"].as_f64(), Some(248.0));
            assert_eq!(layout["rightPaneDocked"], json!(true));
            // 1000 - 248 - 392 leaves the center exactly at its 360px floor.
            assert_eq!(layout["rightPaneWidth"].as_f64(), Some(392.0));
            assert_eq!(layout["centerWidth"].as_f64(), Some(CENTER_MIN_WIDTH));
            assert_eq!(layout["overlay"], json!(null));
            assert!(workspace.layout().center_width >= CENTER_MIN_WIDTH);
        })
        .expect("narrow window");
}

/// Settings, Workspace and Schedules navigation never clears the transcript.
#[gpui_kit::test]
fn settings_to_workspace_to_schedules_keeps_the_transcript(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, _older, _newer) = seed_two_sessions(root);
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);

            workspace.set_view(AppView::Settings, cx);
            assert_eq!(snapshot(workspace, cx)["view"], "settings");
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);

            workspace.set_view(AppView::Workspace, cx);
            assert_eq!(snapshot(workspace, cx)["view"], "workspace");
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);

            workspace.set_view(AppView::Schedules, cx);
            let state = snapshot(workspace, cx);
            assert_eq!(state["view"], "schedules");
            assert_eq!(state["schedules"], json!([]));
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);
            assert_eq!(workspace.transcript_messages().len(), 2);

            workspace.set_view(AppView::Workspace, cx);
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);
        })
        .expect("workspace window");
}

/// Switching right panes Review -> Files -> Launcher leaves the transcript be.
#[gpui_kit::test]
fn right_pane_review_to_files_to_launcher_keeps_the_transcript(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-repo");
    write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-eeee-7000-8000-000000000005.jsonl",
        "Pane Hop",
        "2026-04-01T00:00:01.000Z",
        "main prompt",
        "main reply",
        &repo,
    );
    let mut store = open_store(root);
    omp_core::projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        repo.to_str().expect("repo path"),
    )
    .expect("grant");
    let projects = omp_core::projects::list_projects(&store);
    let sessions = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    data.projects = projects;
    data.sessions = sessions;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(transcript_text(workspace), ["main prompt", "main reply"]);

            workspace.set_right_pane("review", cx);
            let review = snapshot(workspace, cx);
            assert_eq!(review["rightPane"], "review");
            assert_eq!(review["review"]["status"]["branch"], "main");
            assert_eq!(transcript_text(workspace), ["main prompt", "main reply"]);

            workspace.set_right_pane("files", cx);
            let files = snapshot(workspace, cx);
            assert_eq!(files["rightPane"], "files");
            assert_eq!(files["files"]["error"], json!(null));
            let paths: Vec<&str> = files["files"]["entries"]
                .as_array()
                .expect("entries")
                .iter()
                .filter_map(|entry| entry["path"].as_str())
                .collect();
            assert_eq!(paths, ["a.txt"]);
            assert_eq!(transcript_text(workspace), ["main prompt", "main reply"]);

            workspace.set_right_pane("launcher", cx);
            assert_eq!(snapshot(workspace, cx)["rightPane"], "launcher");
            assert_eq!(transcript_text(workspace), ["main prompt", "main reply"]);
            assert_eq!(workspace.transcript_messages().len(), 2);
        })
        .expect("workspace window");
}

/// Live Voice starts idle and stays runtime-free across pane switches.
#[gpui_kit::test]
fn live_voice_snapshot_starts_idle_without_a_runtime(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("live-voice", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "live-voice");
            assert_eq!(state["liveVoice"]["runtime"], json!(false));
            assert_eq!(state["liveVoice"]["phase"], "idle");
            assert_eq!(state["liveVoice"]["active"], json!(false));
            assert_eq!(state["liveVoice"]["muted"], json!(false));
            assert_eq!(state["liveVoice"]["error"], json!(null));

            workspace.set_right_pane("launcher", cx);
            assert_eq!(
                snapshot(workspace, cx)["liveVoice"]["runtime"],
                json!(false)
            );
        })
        .expect("workspace window");
}

/// The terminal panel opens and closes from its own header without a shell.
///
/// `set_right_pane("terminal")` opens the panel; its close button is registered
/// with gpui-kit, so the scenario clicks it by id instead of a measured toolbar
/// position.
#[gpui_kit::test]
fn terminal_panel_opens_and_closes_without_spawning_a_shell(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("terminal", cx);

            let opened = snapshot(workspace, cx);
            assert_eq!(opened["terminal"]["open"], json!(true));
            assert_eq!(opened["terminal"]["session"], json!(false));
            assert_eq!(opened["terminal"]["running"], json!(false));
            assert_eq!(opened["terminal"]["error"], json!(null));
        })
        .expect("workspace window");

    click_element(cx, handle, "terminal-close");

    handle
        .update(cx, |workspace, _, cx| {
            let closed = snapshot(workspace, cx);
            assert_eq!(closed["terminal"]["open"], json!(false));
            assert_eq!(closed["terminal"]["session"], json!(false));
            assert_eq!(closed["terminal"]["running"], json!(false));
            assert_eq!(closed["terminal"]["error"], json!(null));
            assert!(
                closed["transcript"]
                    .as_array()
                    .expect("transcript")
                    .is_empty()
            );
        })
        .expect("workspace window");
}

/// The Files pane names the missing project instead of listing anything.
#[gpui_kit::test]
fn files_pane_reports_an_error_without_a_project(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("files", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "files");
            assert_eq!(state["files"]["entries"], json!([]));
            assert_eq!(state["files"]["skipped"], json!(0));
            assert_eq!(
                state["files"]["error"],
                "Select a project to browse its files."
            );
        })
        .expect("workspace window");
}

/// Deleting the only schedule leaves the Schedules view reporting an empty list.
#[gpui_kit::test]
fn schedules_pane_reports_an_empty_list_after_delete(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project");

    let mut store = open_store(root);
    omp_core::projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    let project_id = omp_core::projects::list_projects(&store)
        .first()
        .expect("granted project")
        .id
        .clone();
    let schedule = omp_core::schedules::create(
        &mut store,
        &json!({
            "title": "Delete sweep",
            "prompt": "Clean up",
            "target": { "kind": "project", "projectId": project_id },
            "timing": { "kind": "once", "at": "2030-01-01T00:00:00.000Z" },
            "execution": { "model": "anthropic/claude", "thinking": "medium", "speed": "normal" },
        }),
        "user",
    )
    .expect("create schedule");
    let schedule_id = schedule["id"].as_str().expect("schedule id").to_string();
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_view(AppView::Schedules, cx);
            let populated = snapshot(workspace, cx);
            assert_eq!(populated["view"], "schedules");
            assert_eq!(
                populated["schedules"].as_array().expect("schedules").len(),
                1
            );
            assert_eq!(populated["schedules"][0]["id"], schedule_id.as_str());

            workspace.delete_schedule(&schedule_id, cx);
            let emptied = snapshot(workspace, cx);
            assert_eq!(emptied["view"], "schedules");
            assert_eq!(emptied["schedules"], json!([]));
        })
        .expect("workspace window");

    let store = open_store(root);
    assert!(omp_core::schedules::list(&store).is_empty());
}

/// The Review pane reports a clean tree, then a modified file as unstaged,
/// staged, unstaged again, and clean once the working tree is restored.
#[gpui_kit::test]
fn review_pane_stages_and_unstages_a_file_through_the_snapshot(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&repo, cx);
            workspace.set_right_pane("review", cx);

            let clean = snapshot(workspace, cx);
            assert_eq!(clean["rightPane"], "review");
            assert_eq!(clean["review"]["error"], json!(null));
            assert_eq!(clean["review"]["status"]["files"], json!([]));

            std::fs::write(repo.join("a.txt"), "line1\nline2\n").expect("edit");
            workspace.refresh_review();
            let dirty = snapshot(workspace, cx);
            assert!(
                dirty["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "a.txt" && file["staged"] == json!(false))
            );

            workspace.stage_path("a.txt", true, cx);
            let staged = snapshot(workspace, cx);
            assert!(
                staged["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "a.txt" && file["staged"] == json!(true))
            );
            assert!(
                workspace
                    .review_status()
                    .expect("staged status")
                    .files
                    .iter()
                    .any(|file| file.path == "a.txt" && file.staged)
            );

            workspace.stage_path("a.txt", false, cx);
            let unstaged = snapshot(workspace, cx);
            assert!(
                unstaged["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "a.txt" && file["staged"] == json!(false))
            );

            git(&repo, &["checkout", "--", "a.txt"]);
            workspace.refresh_review();
            let clean_again = snapshot(workspace, cx);
            assert_eq!(clean_again["review"]["status"]["files"], json!([]));
        })
        .expect("workspace window");
}

/// The Browser pane keeps reporting the empty annotation defaults after a
/// switch to another pane and back; no capture is ever left behind.
#[cfg(not(target_os = "linux"))]
#[gpui_kit::test]
fn browser_annotation_defaults_survive_a_pane_switch(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("browser", cx);
            let first = snapshot(workspace, cx);
            assert_eq!(first["rightPane"], "browser");
            assert_eq!(
                first["browser"]["annotation"],
                json!({ "error": null, "preview": null })
            );

            workspace.set_right_pane("files", cx);
            workspace.set_right_pane("browser", cx);
            let second = snapshot(workspace, cx);
            assert_eq!(second["rightPane"], "browser");
            assert_eq!(
                second["browser"]["annotation"],
                json!({ "error": null, "preview": null })
            );
            assert_eq!(second["composer"]["text"], "");
        })
        .expect("workspace window");
}

/// The updater Settings row starts on the unconfigured state of a build with
/// no feed key, and drawing the page twice leaves the row's state alone.
///
/// The label is private `updates` state and the row does not opt into gpui-kit
/// observation. `debug_snapshot` has no `updater` key yet; once it does, this
/// case should assert `updater.label`. Until then it asserts the public half:
/// the build really is unconfigured, the Settings view and its settings are
/// stable across frames, and the row renders without changing the snapshot.
#[gpui_kit::test]
fn settings_update_row_starts_unconfigured_and_stays_stable(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(1280.0), px(1200.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_view(AppView::Settings, cx)
        })
        .expect("settings view");

    let configured = option_env!("OMP_UPDATER_PUBKEY").is_some_and(|key| !key.trim().is_empty());
    assert!(
        !configured,
        "the parity build has no updater feed key, so the row starts unconfigured"
    );

    let before = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("settings snapshot");
    assert_eq!(before["view"], "settings");
    assert_eq!(before["settings"]["theme"], "system");

    for _ in 0..2 {
        cx.update(|cx| {
            cx.update_window(handle.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
            })
            .expect("draw settings frame");
        });
    }

    let after = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("settings snapshot");
    assert_eq!(after["view"], "settings");
    assert_eq!(after["settings"], before["settings"]);
}

/// A composing Enter never reaches the composer: the guard blocks the commit
/// while the preedit is marked and through the 50ms settle window, and the
/// marked text stays in the composer untouched.
#[gpui_kit::test]
fn ime_composition_guard_keeps_a_composing_key_out_of_the_composer(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    let composer = handle
        .update(cx, |workspace, _, _| workspace.composer_entity().clone())
        .expect("composer");

    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            use gpui_kit::test::{TestInput, TestWindowExt as _};

            window.render_frame(cx);
            let focus = composer.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
            let bounds = gpui_kit::Bounds::new(point(px(0.0), px(0.0)), size(px(0.0), px(0.0)));
            {
                let mut input = TestInput::new(
                    gpui_kit::ElementInputHandler::new(bounds, composer.clone()),
                    window,
                );
                input.compose_text(None, "にほん", Some(3..3), cx);
                assert_eq!(input.marked_text_range(cx), Some(0..3));
            }
            assert_eq!(composer.read(cx).value().to_string(), "にほん");

            let started = Instant::now();
            let mut guard = CompositionGuard::default();
            guard.composition_started();
            assert!(guard.is_composing());
            assert!(guard.blocks_commit_key(started));

            // The composing key must not reach the send/clear path: the marked
            // text is still the whole draft and nothing was submitted.
            window.press("enter", cx);
            assert_eq!(composer.read(cx).value().to_string(), "にほん");

            {
                let mut input = TestInput::new(
                    gpui_kit::ElementInputHandler::new(bounds, composer.clone()),
                    window,
                );
                input.unmark_text(cx);
                assert_eq!(input.marked_text_range(cx), None);
            }
            assert_eq!(composer.read(cx).value().to_string(), "にほん");

            let ended = Instant::now();
            guard.composition_ended(ended);
            assert!(!guard.is_composing());
            assert!(guard.blocks_commit_key(
                ended + Duration::from_millis(IME_POST_COMPOSITION_GUARD_MS - 1)
            ));
            assert!(
                !guard.blocks_commit_key(
                    ended + Duration::from_millis(IME_POST_COMPOSITION_GUARD_MS)
                )
            );
        })
        .expect("composer frame");
    });

    let state = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("composer snapshot");
    assert_eq!(state["composer"]["text"], "にほん");
    assert_eq!(state["transcript"], json!([]));
}

/// The turn diff is empty against a clean baseline and reports the seeded edit
/// once the working tree changes; both sides are the serialized snapshot the
/// workspace's turn card renders.
#[gpui_kit::test]
fn turn_diff_is_empty_before_a_turn_and_reports_a_seeded_change(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);
    let home = root.join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut store = open_store(root);
    omp_core::projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        repo.to_str().expect("repo path"),
    )
    .expect("grant");

    let cwd = repo.to_str().expect("repo path");
    let baseline = TurnBaseline::capture(omp_core::git::snapshot_files(
        &store,
        Platform::current(),
        cwd,
    ));
    assert!(baseline.is_empty(), "a clean repo has no baseline entries");
    let before = compute_turn_changes(
        &baseline,
        omp_core::git::snapshot_files(&store, Platform::current(), cwd),
    );
    assert!(before.is_empty());
    assert_eq!(
        serde_json::to_value(&before).expect("turn diff json"),
        json!({ "files": [], "additions": 0, "deletions": 0 })
    );

    std::fs::write(repo.join("a.txt"), "line1\nline2\n").expect("edit");
    let after = compute_turn_changes(
        &baseline,
        omp_core::git::snapshot_files(&store, Platform::current(), cwd),
    );
    assert!(!after.is_empty());
    let snapshot = serde_json::to_value(&after).expect("turn diff json");
    assert_eq!(snapshot["files"][0]["path"], "a.txt");
    assert_eq!(snapshot["files"][0]["additions"], 1);
    assert_eq!(snapshot["additions"], 1);
    assert_eq!(snapshot["deletions"], 0);
}

/// The session menu's Pin action toggles back off and never reorders the
/// catalog: `Older` keeps its index and the state file agrees at both ends.
#[gpui_kit::test]
fn session_menu_pin_toggles_off_without_reordering(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, _older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(1, cx);
            workspace.session_menu_action("Pin", cx);
            let pinned = snapshot(workspace, cx);
            assert_eq!(pinned["sessions"][0]["title"], "Newer");
            assert_eq!(pinned["sessions"][1]["title"], "Older");
            assert_eq!(pinned["sessions"][1]["pinned"], json!(true));
            assert_eq!(pinned["selectedSession"], json!(1));

            workspace.session_menu_action("Pin", cx);
            let unpinned = snapshot(workspace, cx);
            assert_eq!(unpinned["sessions"][0]["title"], "Newer");
            assert_eq!(unpinned["sessions"][1]["title"], "Older");
            assert_eq!(unpinned["sessions"][1]["pinned"], json!(false));
            assert_eq!(unpinned["sessions"][0]["pinned"], json!(false));
            assert_eq!(unpinned["selectedSession"], json!(1));
            assert_eq!(transcript_text(workspace), ["older prompt", "older reply"]);
        })
        .expect("workspace window");

    let store = open_store(root);
    let records = omp_core::sessions::list_sessions(&store, &home, false, None);
    let titles: Vec<&str> = records.iter().map(|record| record.title.as_str()).collect();
    assert_eq!(titles, ["Newer", "Older"]);
    assert!(records.iter().all(|record| !record.pinned));
}

/// Sending without a runtime keeps the draft and adds nothing to the
/// transcript; the no-runtime branch records the error in the composer banner
/// instead of consuming the prompt. `debug_snapshot` has no `runtimeError` key
/// yet; once it does, this case should assert the banner text here.
#[gpui_kit::test]
fn composer_send_without_a_runtime_keeps_the_draft(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, window, cx| {
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("unsent prompt", window, cx));

            workspace.send_prompt(window, cx);
            let kept = snapshot(workspace, cx);
            assert_eq!(kept["composer"]["text"], "unsent prompt");
            assert_eq!(kept["transcript"], json!([]));
            assert!(workspace.transcript_messages().is_empty());

            // An empty draft is a no-op on the same path.
            composer.update(cx, |state, cx| state.set_value("", window, cx));
            workspace.send_prompt(window, cx);
            assert_eq!(snapshot(workspace, cx)["composer"]["text"], "");
            assert!(workspace.transcript_messages().is_empty());
        })
        .expect("workspace window");
}

/// Leaving Settings with `set_view` returns to the workspace with the selected
/// session and its transcript intact.
#[gpui_kit::test]
fn settings_exit_returns_to_the_workspace_with_the_selected_session(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, _older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);

            workspace.set_view(AppView::Settings, cx);
            assert_eq!(snapshot(workspace, cx)["view"], "settings");
            assert_eq!(snapshot(workspace, cx)["selectedSession"], json!(0));

            workspace.set_view(AppView::Workspace, cx);
            let restored = snapshot(workspace, cx);
            assert_eq!(restored["view"], "workspace");
            assert_eq!(restored["selectedSession"], json!(0));
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);
        })
        .expect("workspace window");
}

/// A pane round-trip refreshes the Files listing to the same entries.
#[gpui_kit::test]
fn files_refresh_reports_the_same_entries_after_a_pane_round_trip(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let project = seed_project(root);

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&project, cx);
            workspace.set_right_pane("files", cx);
            let first = snapshot(workspace, cx);
            assert_eq!(first["rightPane"], "files");
            let entries = first["files"]["entries"].clone();
            assert_eq!(
                entries.as_array().expect("entries").len(),
                3,
                "directory first, then the two files"
            );

            workspace.set_right_pane("review", cx);
            workspace.set_right_pane("files", cx);
            workspace.refresh_files();
            let second = snapshot(workspace, cx);
            assert_eq!(second["rightPane"], "files");
            assert_eq!(second["files"]["entries"], entries);
            assert_eq!(second["files"]["error"], json!(null));
        })
        .expect("workspace window");
}

/// Pausing then resuming a schedule persists each state in turn.
#[gpui_kit::test]
fn schedules_pause_and_resume_persist_both_states(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project");

    let mut store = open_store(root);
    omp_core::projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    let project_id = omp_core::projects::list_projects(&store)
        .first()
        .expect("granted project")
        .id
        .clone();
    let schedule = omp_core::schedules::create(
        &mut store,
        &json!({
            "title": "Pause and resume",
            "prompt": "Report status",
            "target": { "kind": "project", "projectId": project_id },
            "timing": { "kind": "once", "at": "2030-01-01T00:00:00.000Z" },
            "execution": { "model": "anthropic/claude", "thinking": "medium", "speed": "normal" },
        }),
        "user",
    )
    .expect("create schedule");
    let schedule_id = schedule["id"].as_str().expect("schedule id").to_string();
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.refresh_schedules();
            assert_eq!(workspace.schedules()[0]["status"], "active");

            workspace.set_schedule_status(&schedule_id, "paused", cx);
            assert_eq!(workspace.schedules()[0]["status"], "paused");
            assert_eq!(snapshot(workspace, cx)["schedules"][0]["status"], "paused");
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(
        omp_core::schedules::list(&store)[0]["status"],
        "paused",
        "the paused state is on disk"
    );
    drop(store);

    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_schedule_status(&schedule_id, "active", cx);
            assert_eq!(workspace.schedules()[0]["status"], "active");
            assert_eq!(snapshot(workspace, cx)["schedules"][0]["status"], "active");
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(
        omp_core::schedules::list(&store)[0]["status"],
        "active",
        "the resumed state is on disk"
    );
}

/// Writes a session whose transcript is exactly `entries`, one JSON object per
/// line, after the title and header lines `read_transcript` skips over.
fn write_session_entries(
    bucket: &Path,
    file_name: &str,
    title: &str,
    at: &str,
    entries: &[Value],
    cwd: &Path,
) -> PathBuf {
    std::fs::create_dir_all(bucket).expect("session bucket");
    let path = bucket.join(file_name);
    let title_line = json!({
        "type": "title",
        "v": 1,
        "title": title,
        "updatedAt": at,
        "pad": "",
    });
    let header = json!({
        "type": "session",
        "version": 3,
        "id": title,
        "timestamp": at,
        "cwd": cwd.display().to_string(),
    });
    let mut body = format!("{title_line}\n{header}\n");
    for entry in entries {
        body.push_str(&entry.to_string());
        body.push('\n');
    }
    std::fs::write(&path, body).expect("session fixture");
    path
}

/// A transcript with user, assistant text/thinking/tool parts and a tool
/// result keeps every role and every part in the order the file wrote them.
#[gpui_kit::test]
fn transcript_preserves_roles_and_part_order(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let project = root.join("project");
    let at = "2026-04-01T01:00:00.000Z";
    let session = write_session_entries(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-f111-7000-8000-000000000011.jsonl",
        "Rich",
        at,
        &[
            json!({
                "type": "message",
                "id": "u1",
                "parentId": null,
                "timestamp": at,
                "message": { "role": "user", "content": "summarize the file" },
            }),
            json!({
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": at,
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "look first" },
                        { "type": "text", "text": "reading it" },
                        {
                            "type": "toolCall",
                            "id": "call-1",
                            "name": "read",
                            "arguments": { "path": "a.txt" },
                        },
                    ],
                },
            }),
            json!({
                "type": "message",
                "id": "t1",
                "parentId": "a1",
                "timestamp": at,
                "message": {
                    "role": "toolResult",
                    "toolName": "read",
                    "isError": false,
                    "content": [ { "type": "text", "text": "line1" } ],
                },
            }),
        ],
        &project,
    );
    assert!(session.exists());

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            let state = snapshot(workspace, cx);
            let transcript = state["transcript"].as_array().expect("transcript");
            assert_eq!(transcript.len(), 3);

            let roles: Vec<&str> = transcript
                .iter()
                .filter_map(|message| message["role"].as_str())
                .collect();
            assert_eq!(roles, ["user", "assistant", "tool"]);

            let kinds: Vec<Vec<&str>> = transcript
                .iter()
                .map(|message| {
                    message["parts"]
                        .as_array()
                        .expect("parts")
                        .iter()
                        .filter_map(|part| part["kind"].as_str())
                        .collect()
                })
                .collect();
            assert_eq!(
                kinds,
                [
                    vec!["text"],
                    vec!["thinking", "text", "toolCall"],
                    vec!["toolResult"]
                ]
            );

            let texts: Vec<&str> = transcript
                .iter()
                .flat_map(|message| {
                    message["parts"]
                        .as_array()
                        .expect("parts")
                        .iter()
                        .filter_map(|part| part["text"].as_str())
                })
                .collect();
            assert_eq!(
                texts,
                ["summarize the file", "look first", "reading it", "line1"]
            );

            // The getter keeps the fields the snapshot does not project.
            let messages = workspace.transcript_messages();
            let call = &messages[1].parts[2];
            assert_eq!(call.name.as_deref(), Some("read"));
            assert_eq!(call.args, Some(json!({ "path": "a.txt" })));
            let result = &messages[2].parts[0];
            assert_eq!(result.name.as_deref(), Some("read"));
            assert_eq!(result.is_error, Some(false));
        })
        .expect("workspace window");
}

/// The toolbar's Copy transcript action writes the visible transcript to the
/// clipboard as one block per message; an empty transcript leaves whatever the
/// clipboard already held untouched.
#[gpui_kit::test]
fn copy_transcript_writes_the_visible_text_and_no_ops_when_empty(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let project = root.join("project");
    let at = "2026-04-01T01:00:00.000Z";
    write_session_entries(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-c111-7000-8000-000000000013.jsonl",
        "Copyable",
        at,
        &[
            json!({
                "type": "message",
                "id": "u1",
                "parentId": null,
                "timestamp": at,
                "message": { "role": "user", "content": "summarize the file" },
            }),
            json!({
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": at,
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "look first" },
                        { "type": "text", "text": "reading it" },
                    ],
                },
            }),
        ],
        &project,
    );

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    handle
        .update(cx, |workspace, _, cx| workspace.select_session(0, cx))
        .expect("workspace window");

    // The sentinel makes "nothing written" observable, not just "old text gone".
    cx.write_to_clipboard(ClipboardItem::new_string("untouched".to_string()));
    handle
        .update(cx, |workspace, _, cx| workspace.copy_transcript(cx))
        .expect("copy transcript");
    assert_eq!(
        cx.read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("You\nsummarize the file\n\nOMP\nlook first\nreading it")
    );

    // The toolbar draws the button over a live transcript; the copy above is
    // its handler, reached here without a measured click.
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("transcript frame");
    });

    // No session means no transcript: copying leaves the sentinel in place.
    let empty = tempfile::TempDir::new().expect("empty root");
    let empty_handle =
        cx.add_window(|window, cx| Workspace::new(window, cx, test_data(empty.path())));
    cx.write_to_clipboard(ClipboardItem::new_string("untouched".to_string()));
    empty_handle
        .update(cx, |workspace, _, cx| {
            assert!(workspace.transcript_messages().is_empty());
            workspace.copy_transcript(cx);
        })
        .expect("empty workspace window");
    assert_eq!(
        cx.read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("untouched")
    );
}

/// A message carrying `$x^2$` and `$$y$$` draws as its prose plus math spans,
/// and the frame builds with them: the snapshot counts the two math runs, and
/// the copied text is still the message as written, delimiters included.
#[gpui_kit::test]
fn transcript_math_segments_render_and_leave_the_copied_text_alone(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let project = root.join("project");
    let at = "2026-04-01T01:00:00.000Z";
    let prompt = "area is $x^2$ and $$y$$ wide";
    write_session_entries(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-d111-7000-8000-000000000014.jsonl",
        "Math",
        at,
        &[json!({
            "type": "message",
            "id": "u1",
            "parentId": null,
            "timestamp": at,
            "message": { "role": "user", "content": prompt },
        })],
        &project,
    );

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    handle
        .update(cx, |workspace, _, cx| workspace.select_session(0, cx))
        .expect("workspace window");

    // The part keeps its source text and reports the two math runs the
    // renderer splits out, so the styled spans are observable without pixels.
    handle
        .update(cx, |workspace, _, cx| {
            let state = snapshot(workspace, cx);
            let part = &state["transcript"][0]["parts"][0];
            assert_eq!(part["kind"], "text");
            assert_eq!(part["text"], prompt);
            assert_eq!(part["mathSegments"], json!(2));
        })
        .expect("math snapshot");

    // The frame really builds with the wrapped spans drawn.
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("math frame");
    });

    // Copying is unchanged: the split is a drawing detail, so the clipboard
    // keeps both delimiters and the raw math text.
    cx.write_to_clipboard(ClipboardItem::new_string("untouched".to_string()));
    handle
        .update(cx, |workspace, _, cx| workspace.copy_transcript(cx))
        .expect("copy transcript");
    let expected = format!("You\n{prompt}");
    assert_eq!(
        cx.read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some(expected.as_str())
    );
}

/// The transcript opens on its newest message, a scroll up unpins the follow
/// and draws the `Jump to latest` control, and the harness's re-pin lands back
/// on the tail. Frames are really drawn, so the scroll handle has the bounds
/// and range the workspace reads, and no agent is started.
#[gpui_kit::test]
fn transcript_follows_the_tail_and_the_jump_control_repins(cx: &mut TestAppContext) {
    use gpui_kit::{InputEvent as _, ScrollDelta, ScrollEvent, ScrollSource, TouchPhase};

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let project = root.join("project");
    let at = "2026-04-01T01:00:00.000Z";
    // Enough rows to overflow the 800px window's transcript.
    let entries: Vec<Value> = (0..40)
        .map(|index| {
            json!({
                "type": "message",
                "id": format!("u{index}"),
                "parentId": null,
                "timestamp": at,
                "message": {
                    "role": "user",
                    "content": format!("message {index} {}", "padding ".repeat(24)),
                },
            })
        })
        .collect();
    write_session_entries(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-f333-7000-8000-000000000013.jsonl",
        "Long",
        at,
        &entries,
        &project,
    );

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });

    // Selecting the session loads it pinned to its newest message.
    handle
        .update(cx, |workspace, _, cx| workspace.select_session(0, cx))
        .expect("select session");
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("transcript frame");
    });
    let state = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("transcript snapshot");
    assert_eq!(state["transcript"].as_array().map(Vec::len), Some(40));
    assert_eq!(state["transcriptAtBottom"], json!(true));

    // A wheel event over the rows scrolls up: the follow unpins and the jump
    // control is what the next frame draws.
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.dispatch_event(
                ScrollEvent {
                    position: point(px(600.0), px(400.0)),
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
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("scrolled frame");
    });
    let state = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("scrolled snapshot");
    assert_eq!(state["transcriptAtBottom"], json!(false));

    // The jump control's handler re-pins the view to the last row.
    handle
        .update(cx, |workspace, _, cx| {
            workspace.jump_to_transcript_latest(cx)
        })
        .expect("jump to latest");
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("jumped frame");
    });
    let state = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("jumped snapshot");
    assert_eq!(state["transcriptAtBottom"], json!(true));
    // The jump keeps the rows it scrolled past.
    assert_eq!(state["transcript"].as_array().map(Vec::len), Some(40));
}

/// A compaction record renders as a system message, and its token counts and
/// summary survive on the part the snapshot only projects by kind.
#[gpui_kit::test]
fn compaction_record_renders_as_a_system_message_with_token_counts(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let project = root.join("project");
    let at = "2026-04-01T01:00:00.000Z";
    write_session_entries(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-f222-7000-8000-000000000012.jsonl",
        "Compacted",
        at,
        &[
            json!({
                "type": "message",
                "id": "u1",
                "parentId": null,
                "timestamp": at,
                "message": { "role": "user", "content": "long prompt" },
            }),
            json!({
                "type": "compaction",
                "id": "c1",
                "timestamp": "2026-04-01T01:05:00.000Z",
                "tokensBefore": 120_000,
                "tokensAfter": 40_000,
                "summary": "earlier turns",
            }),
            json!({
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": "2026-04-01T01:06:00.000Z",
                "message": { "role": "assistant", "content": "carrying on" },
            }),
        ],
        &project,
    );

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            let state = snapshot(workspace, cx);
            let transcript = state["transcript"].as_array().expect("transcript");
            let roles: Vec<&str> = transcript
                .iter()
                .filter_map(|message| message["role"].as_str())
                .collect();
            assert_eq!(roles, ["user", "system", "assistant"]);
            assert_eq!(transcript[1]["parts"][0]["kind"], "compaction");
            // A compaction marker has no text body, only counts and a summary.
            assert_eq!(transcript[1]["parts"][0]["text"], json!(null));

            let messages = workspace.transcript_messages();
            let marker = &messages[1].parts[0];
            assert_eq!(marker.tokens_before, Some(120_000));
            assert_eq!(marker.tokens_after, Some(40_000));
            assert_eq!(marker.status.as_deref(), Some("done"));
            assert_eq!(marker.summary.as_deref(), Some("earlier turns"));
            // The compaction marker carries no text part of its own.
            assert_eq!(transcript_text(workspace), ["long prompt", "carrying on"]);
        })
        .expect("workspace window");
}

/// A long text part is carried whole: the snapshot and the getter both keep
/// every character, including the trailing marker.
#[gpui_kit::test]
fn long_text_part_is_not_truncated(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let project = root.join("project");
    let at = "2026-04-01T01:00:00.000Z";
    let long = format!("start\n{}\nend-of-long-text", "x".repeat(100_000));
    write_session_entries(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-f333-7000-8000-000000000013.jsonl",
        "Long",
        at,
        &[
            json!({
                "type": "message",
                "id": "u1",
                "parentId": null,
                "timestamp": at,
                "message": { "role": "user", "content": long },
            }),
            json!({
                "type": "message",
                "id": "a1",
                "parentId": "u1",
                "timestamp": at,
                "message": { "role": "assistant", "content": "short reply" },
            }),
        ],
        &project,
    );

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            let state = snapshot(workspace, cx);
            let text = state["transcript"][0]["parts"][0]["text"]
                .as_str()
                .expect("long text");
            assert_eq!(text.len(), long.len());
            assert!(text.starts_with("start\n"));
            assert!(text.ends_with("end-of-long-text"));
            assert!(text == long, "the long part was altered in the snapshot");

            let message = &workspace.transcript_messages()[0];
            assert_eq!(message.parts[0].text.as_deref(), Some(long.as_str()));
            assert_eq!(transcript_text(workspace)[1], "short reply");
        })
        .expect("workspace window");
}

/// Session records carry an `unread` flag, and it survives the catalog reload
/// the state file drives. `debug_snapshot` projects each session's title, pin
/// and archive state but has no `unread` key yet, so the flag is asserted
/// through the catalog and the record serialization that feeds the snapshot.
#[gpui_kit::test]
fn session_unread_flags_persist_across_a_catalog_reload(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, _older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 2);
    assert!(catalog.iter().all(|record| !record.unread));
    for record in &catalog {
        assert_eq!(
            serde_json::to_value(record).expect("record json")["unread"],
            json!(false),
            "the record serializes its unread flag"
        );
    }

    // A reopened store scans the same files and keeps the flag off.
    let reopened = open_store(root);
    let reloaded = omp_core::sessions::list_sessions(&reopened, &home, false, None);
    drop(reopened);
    let titles: Vec<&str> = reloaded
        .iter()
        .map(|record| record.title.as_str())
        .collect();
    assert_eq!(titles, ["Newer", "Older"]);
    assert!(reloaded.iter().all(|record| !record.unread));

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = reloaded;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            // The snapshot's session list is the same catalog: same titles and
            // no session reported as archived by the unread-free scan.
            let state = snapshot(workspace, cx);
            let sessions = state["sessions"].as_array().expect("sessions");
            let snapshot_titles: Vec<&str> = sessions
                .iter()
                .filter_map(|session| session["title"].as_str())
                .collect();
            assert_eq!(snapshot_titles, ["Newer", "Older"]);
            assert!(
                sessions
                    .iter()
                    .all(|session| session["archived"] == json!(false))
            );

            workspace.select_session(1, cx);
            assert_eq!(transcript_text(workspace), ["older prompt", "older reply"]);
            assert_eq!(snapshot(workspace, cx)["selectedSession"], json!(1));
        })
        .expect("workspace window");
}

/// Archiving the selected session hides it from the default catalog the
/// snapshot reports, while `include_archived` still returns the record.
#[gpui_kit::test]
fn archiving_hides_a_session_from_the_snapshot_catalog(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 2);

    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(1, cx);
            assert_eq!(transcript_text(workspace), ["older prompt", "older reply"]);

            workspace.session_menu_action("Archive", cx);
            let state = snapshot(workspace, cx);
            let sessions = state["sessions"].as_array().expect("sessions");
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0]["title"], "Newer");
            assert_eq!(sessions[0]["archived"], json!(false));

            workspace.select_session(0, cx);
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);
        })
        .expect("workspace window");

    let store = open_store(root);
    let visible = omp_core::sessions::list_sessions(&store, &home, false, None);
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].title, "Newer");
    let all = omp_core::sessions::list_sessions(&store, &home, true, None);
    assert_eq!(all.len(), 2);
    let archived = all
        .iter()
        .find(|record| same_path(&record.file_path, &older))
        .expect("archived session record");
    assert!(archived.archived);
    assert!(!archived.unread);
    assert!(older.exists(), "archiving keeps the JSONL file");
}

/// Appending a reply to the non-selected session leaves the catalog order, the
/// selection and the open transcript alone: ordering keys off the last user
/// message, which that reply does not touch.
#[gpui_kit::test]
fn catalog_order_is_stable_when_a_non_selected_session_updates(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 2);

    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);

            // The background session gets a reply while it is not selected.
            let reply = json!({
                "type": "message",
                "id": "a2",
                "parentId": "u1",
                "timestamp": "2026-04-01T05:00:00.000Z",
                "message": { "role": "assistant", "content": "late reply" },
            });
            let mut body = std::fs::read_to_string(&older).expect("older fixture");
            body.push_str(&format!("{reply}\n"));
            std::fs::write(&older, body).expect("append reply");

            // Pin re-lists the catalog from disk, so the refresh is observable.
            workspace.session_menu_action("Pin", cx);
            let refreshed = snapshot(workspace, cx);
            assert_eq!(refreshed["selectedSession"], json!(0));
            let sessions = refreshed["sessions"].as_array().expect("sessions");
            let titles: Vec<&str> = sessions
                .iter()
                .filter_map(|session| session["title"].as_str())
                .collect();
            assert_eq!(titles, ["Newer", "Older"]);
            assert_eq!(sessions[0]["pinned"], json!(true));
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);

            workspace.session_menu_action("Pin", cx);
            let unpinned = snapshot(workspace, cx);
            let titles: Vec<&str> = unpinned["sessions"]
                .as_array()
                .expect("sessions")
                .iter()
                .filter_map(|session| session["title"].as_str())
                .collect();
            assert_eq!(titles, ["Newer", "Older"]);

            // The appended reply is really there; only the ordering key held.
            workspace.select_session(1, cx);
            let texts = transcript_text(workspace);
            assert_eq!(texts.last().map(String::as_str), Some("late reply"));
        })
        .expect("workspace window");

    let store = open_store(root);
    let records = omp_core::sessions::list_sessions(&store, &home, false, None);
    let titles: Vec<&str> = records.iter().map(|record| record.title.as_str()).collect();
    assert_eq!(titles, ["Newer", "Older"]);
    assert_eq!(
        records[1].last_user_message_at.as_deref(),
        Some("2026-04-01T01:00:00.000Z")
    );
}

/// Whitespace in a draft is part of the draft: leading indentation, internal
/// tabs and trailing spaces all survive pane and view switches until it is
/// sent. The composer is single-line, so newlines are not part of the draft.
#[gpui_kit::test]
fn composer_draft_keeps_its_whitespace_until_send(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let draft = "  indented  two spaces\tand a tab  ";
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, window, cx| {
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value(draft, window, cx));
            assert_eq!(snapshot(workspace, cx)["composer"]["text"], draft);

            workspace.set_right_pane("files", cx);
            workspace.set_view(AppView::Settings, cx);
            workspace.set_view(AppView::Workspace, cx);
            workspace.set_right_pane("launcher", cx);

            assert_eq!(snapshot(workspace, cx)["composer"]["text"], draft);
            assert_eq!(composer.read(cx).value().to_string(), draft);
        })
        .expect("workspace window");
}

/// Sending with a session open but no runtime keeps the draft and appends
/// nothing: the existing transcript is byte-for-byte what it was.
#[gpui_kit::test]
fn composer_send_without_a_runtime_appends_nothing_to_an_open_transcript(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, _older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(0, cx);
            assert_eq!(workspace.transcript_messages().len(), 2);
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("queued prompt", window, cx));
            let before = snapshot(workspace, cx)["transcript"].clone();

            workspace.send_prompt(window, cx);
            let after = snapshot(workspace, cx);
            assert_eq!(after["composer"]["text"], "queued prompt");
            assert_eq!(after["transcript"], before);
            assert_eq!(after["liveVoice"]["runtime"], json!(false));
            assert_eq!(workspace.transcript_messages().len(), 2);
            assert!(
                !transcript_text(workspace)
                    .iter()
                    .any(|text| text == "queued prompt")
            );
        })
        .expect("workspace window");
}

/// Settings round-trip: the draft and the selected session come back exactly
/// as they were, with the same transcript behind them.
#[gpui_kit::test]
fn settings_round_trip_keeps_the_draft_and_the_selected_session(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, _older, _newer) = seed_two_sessions(root);

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(1, cx);
            assert_eq!(transcript_text(workspace), ["older prompt", "older reply"]);
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("  keep me  ", window, cx));

            workspace.set_view(AppView::Settings, cx);
            let settings = snapshot(workspace, cx);
            assert_eq!(settings["view"], "settings");
            assert_eq!(settings["selectedSession"], json!(1));
            assert_eq!(settings["composer"]["text"], "  keep me  ");

            workspace.set_view(AppView::Workspace, cx);
            let restored = snapshot(workspace, cx);
            assert_eq!(restored["view"], "workspace");
            assert_eq!(restored["selectedSession"], json!(1));
            assert_eq!(restored["composer"]["text"], "  keep me  ");
            assert_eq!(transcript_text(workspace), ["older prompt", "older reply"]);
        })
        .expect("workspace window");
}

/// After a real commit the Review pane reports a clean tree on the same branch.
#[gpui_kit::test]
fn review_pane_reports_a_clean_tree_after_a_commit(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&repo, cx);
            workspace.set_right_pane("review", cx);

            std::fs::write(repo.join("a.txt"), "line1\nline2\n").expect("edit");
            workspace.refresh_review();
            let dirty = snapshot(workspace, cx);
            assert!(
                dirty["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "a.txt")
            );

            workspace.stage_path("a.txt", true, cx);
            let staged = snapshot(workspace, cx);
            assert!(
                staged["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "a.txt" && file["staged"] == json!(true))
            );

            git(&repo, &["commit", "-qm", "parity change"]);
            workspace.refresh_review();
            let clean = snapshot(workspace, cx);
            assert_eq!(clean["rightPane"], "review");
            assert_eq!(clean["review"]["error"], json!(null));
            assert_eq!(clean["review"]["status"]["isRepo"], json!(true));
            assert_eq!(clean["review"]["status"]["branch"], "main");
            assert_eq!(clean["review"]["status"]["files"], json!([]));
            assert!(
                workspace
                    .review_status()
                    .expect("clean status")
                    .files
                    .is_empty()
            );
        })
        .expect("workspace window");
}

/// The Enter action is part of the persisted settings: a window built from a
/// reopened state file starts with the action the previous window saved, and a
/// second reload sees the change back.
#[gpui_kit::test]
fn enter_action_setting_survives_a_state_reload(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();

    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            assert_eq!(
                workspace.settings().message_enter_action,
                MessageEnterAction::Steer
            );
            workspace.update_setting(json!({ "messageEnterAction": "queue" }), cx);
            assert_eq!(
                workspace.settings().message_enter_action,
                MessageEnterAction::Queue
            );
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(
        store.settings().message_enter_action,
        MessageEnterAction::Queue
    );
    let mut data = test_data(root);
    data.settings = store.settings();
    drop(store);

    let reopened = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    reopened
        .update(cx, |workspace, _, cx| {
            assert_eq!(
                workspace.settings().message_enter_action,
                MessageEnterAction::Queue
            );
            workspace.update_setting(json!({ "messageEnterAction": "steer" }), cx);
            assert_eq!(
                workspace.settings().message_enter_action,
                MessageEnterAction::Steer
            );
        })
        .expect("reopened window");

    let store = open_store(root);
    assert_eq!(
        store.settings().message_enter_action,
        MessageEnterAction::Steer
    );
}

/// Theme and density travel together: both show in the snapshot, both land in
/// the state file, and a window bootstrapped from that file starts with them.
#[gpui_kit::test]
fn theme_and_density_land_in_the_snapshot_and_state_file(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();

    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.update_setting(
                json!({ "theme": "dark", "conversationDensity": "compact" }),
                cx,
            );

            let state = snapshot(workspace, cx);
            assert_eq!(state["settings"]["theme"], "dark");
            assert_eq!(state["settings"]["density"], "compact");
            assert_eq!(workspace.settings().theme, Theme::Dark);
            assert_eq!(
                workspace.settings().conversation_density,
                ConversationDensity::Compact
            );
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(store.settings().theme, Theme::Dark);
    assert_eq!(
        store.settings().conversation_density,
        ConversationDensity::Compact
    );
    let mut data = test_data(root);
    data.settings = store.settings();
    drop(store);

    let reopened = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    reopened
        .update(cx, |workspace, _, cx| {
            let state = snapshot(workspace, cx);
            assert_eq!(state["settings"]["theme"], "dark");
            assert_eq!(state["settings"]["density"], "compact");
            assert_eq!(workspace.settings().theme, Theme::Dark);
            assert_eq!(
                workspace.settings().conversation_density,
                ConversationDensity::Compact
            );
        })
        .expect("reopened window");
}

/// At 1100px a 720px right-pane preference is clamped to the space left after
/// the sidebar and the center's floor: 492px, leaving exactly 360px.
#[gpui_kit::test]
fn narrow_layout_clamps_the_right_pane_at_the_center_floor(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let geometry = UiGeometry {
        right_pane_width: 720.0,
        ..UiGeometry::default()
    };
    let mut data = test_data(root);
    data.geometry = geometry;
    let handle = cx.open_window(size(px(1100.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    handle
        .update(cx, |workspace, _, cx| {
            let state = snapshot(workspace, cx);
            let layout = &state["layout"];
            assert_eq!(layout["sidebarDocked"], json!(true));
            assert_eq!(layout["sidebarWidth"].as_f64(), Some(248.0));
            assert_eq!(layout["rightPaneDocked"], json!(true));
            // 1100 - 248 - 360 leaves 492px for the right pane; the 720px
            // preference is clamped rather than squeezing the center.
            assert_eq!(layout["rightPaneWidth"].as_f64(), Some(492.0));
            assert_eq!(layout["centerWidth"].as_f64(), Some(CENTER_MIN_WIDTH));
            assert_eq!(layout["overlay"], json!(null));

            let resolved = workspace.layout();
            assert_eq!(resolved.right_pane_width, 492.0);
            assert_eq!(resolved.center_width, CENTER_MIN_WIDTH);
            assert!(resolved.center_width >= CENTER_MIN_WIDTH);
        })
        .expect("narrow window");
}

/// At 1440px both panes dock at their configured widths and the transcript
/// takes the remainder.
#[gpui_kit::test]
fn wide_layout_reports_the_docked_widths(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(1440.0), px(900.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    handle
        .update(cx, |workspace, _, cx| {
            let state = snapshot(workspace, cx);
            let layout = &state["layout"];
            assert_eq!(layout["sidebarDocked"], json!(true));
            assert_eq!(layout["sidebarWidth"].as_f64(), Some(248.0));
            assert_eq!(layout["rightPaneDocked"], json!(true));
            assert_eq!(layout["rightPaneWidth"].as_f64(), Some(571.0));
            // 1440 - 248 - 571 leaves the center the rest of the window.
            assert_eq!(layout["centerWidth"].as_f64(), Some(621.0));
            assert_eq!(layout["overlay"], json!(null));

            let resolved = workspace.layout();
            assert!(resolved.sidebar_docked);
            assert!(resolved.right_pane_docked);
            assert_eq!(resolved.sidebar_width, 248.0);
            assert_eq!(resolved.right_pane_width, 571.0);
            assert_eq!(resolved.center_width, 621.0);
        })
        .expect("wide window");
}

/// The Browser pane starts with no tabs, prepares one blank tab when opened,
/// and keeps that tab active across a pane round trip.
#[cfg(not(target_os = "linux"))]
#[gpui_kit::test]
fn browser_pane_starts_empty_then_adds_one_blank_tab(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            let empty = snapshot(workspace, cx);
            assert_eq!(empty["rightPane"], "launcher");
            assert_eq!(empty["browser"]["tabs"], json!(0));
            assert_eq!(empty["browser"]["activeTab"], json!(0));
            assert_eq!(empty["browser"]["webviewPending"], json!(false));

            workspace.set_right_pane("browser", cx);
            let opened = snapshot(workspace, cx);
            assert_eq!(opened["rightPane"], "browser");
            assert_eq!(opened["browser"]["tabs"], json!(1));
            assert_eq!(opened["browser"]["activeTab"], json!(0));
            // No frame has been drawn, so the blank tab's webview is pending.
            assert_eq!(opened["browser"]["webviewPending"], json!(true));

            workspace.set_right_pane("files", cx);
            workspace.set_right_pane("browser", cx);
            let again = snapshot(workspace, cx);
            assert_eq!(again["rightPane"], "browser");
            // `prepare` only adds a tab to an empty pane, so the blank tab
            // survives the round trip instead of accumulating.
            assert_eq!(again["browser"]["tabs"], json!(1));
            assert_eq!(again["browser"]["activeTab"], json!(0));
        })
        .expect("workspace window");
}

/// The terminal panel opens with no tab and no shell: the snapshot's tab keys
/// stay at zero, nothing is running, and the transcript is untouched.
#[gpui_kit::test]
fn terminal_panel_reports_no_tabs_without_a_shell(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            let closed = snapshot(workspace, cx);
            assert_eq!(closed["terminal"]["open"], json!(false));
            assert_eq!(closed["terminal"]["tabs"], json!(0));
            assert_eq!(closed["terminal"]["activeTab"], json!(0));
            assert_eq!(closed["terminal"]["session"], json!(false));

            workspace.set_right_pane("terminal", cx);
            let opened = snapshot(workspace, cx);
            assert_eq!(opened["terminal"]["open"], json!(true));
            assert_eq!(opened["terminal"]["tabs"], json!(0));
            assert_eq!(opened["terminal"]["activeTab"], json!(0));
            assert_eq!(opened["terminal"]["session"], json!(false));
            assert_eq!(opened["terminal"]["running"], json!(false));
            assert_eq!(opened["terminal"]["error"], json!(null));
            assert!(
                opened["transcript"]
                    .as_array()
                    .expect("transcript")
                    .is_empty()
            );

            // Opening another pane leaves the panel's tab keys alone: no shell
            // was ever spawned, so there is still nothing to report.
            workspace.set_right_pane("files", cx);
            let after = snapshot(workspace, cx);
            assert_eq!(after["terminal"]["tabs"], json!(0));
            assert_eq!(after["terminal"]["activeTab"], json!(0));
        })
        .expect("workspace window");
}

/// The terminal's `Send selection` action quotes the screen's last output row
/// into the composer draft, leaves the terminal screen untouched and sends
/// nothing; an empty screen is a no-op that reports a status.
///
/// The panel is opened through the shell-less seam, so the scenario drives a
/// real `vt100` mirror without spawning a PTY.
#[gpui_kit::test]
fn terminal_selection_reaches_the_composer_without_changing_the_screen(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, window, cx| {
            // An empty screen first: the action reports and inserts nothing.
            workspace.open_terminal_screen(cx);
            workspace.send_terminal_selection(window, cx);
            let empty = snapshot(workspace, cx);
            assert_eq!(
                empty["terminal"]["status"],
                json!("No terminal output to send.")
            );
            assert_eq!(empty["terminal"]["selection"], json!(""));
            assert_eq!(empty["composer"]["text"], json!(""));
            assert_eq!(empty["terminal"]["session"], json!(true));
            assert_eq!(empty["terminal"]["running"], json!(false));

            // Feed output: the last visible row is what the action quotes.
            assert!(workspace.feed_terminal_output(b"$ npm run build\r\nok\r\n", cx));
            let before = snapshot(workspace, cx);
            assert_eq!(before["terminal"]["selection"], json!("ok"));
            assert_eq!(before["terminal"]["screen"], json!("$ npm run build\nok"));
            // New output cleared the empty-screen status.
            assert_eq!(before["terminal"]["status"], json!(null));

            workspace.send_terminal_selection(window, cx);
            let after = snapshot(workspace, cx);
            assert_eq!(after["composer"]["text"], json!("Terminal output: ok"));
            // Nothing was sent: the transcript is empty and no turn started.
            assert_eq!(after["running"], json!(false));
            assert!(
                after["transcript"]
                    .as_array()
                    .expect("transcript")
                    .is_empty()
            );
            // The send reads the screen; it never clears or edits it.
            assert_eq!(after["terminal"]["screen"], before["terminal"]["screen"]);
            assert_eq!(
                after["terminal"]["selection"],
                before["terminal"]["selection"]
            );
            assert_eq!(after["terminal"]["tabs"], before["terminal"]["tabs"]);
            assert_eq!(
                after["terminal"]["activeTab"],
                before["terminal"]["activeTab"]
            );
            assert_eq!(after["terminal"]["status"], json!(null));
        })
        .expect("workspace window");
}

/// Live Voice opens idle and stays idle while no runtime carries the audio:
/// the pane never fabricates a phase, level or transcript line on its own.
///
/// The pure event helper that would drive idle -> recording -> transcript ->
/// end is private to `app.rs`, so the integration harness can only assert the
/// reachable pane state.
#[gpui_kit::test]
fn live_voice_pane_stays_idle_without_a_runtime(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("live-voice", cx);
            let idle = snapshot(workspace, cx);
            assert_eq!(idle["rightPane"], "live-voice");
            assert_eq!(
                idle["liveVoice"],
                json!({
                    "runtime": false,
                    "phase": "idle",
                    "active": false,
                    "muted": false,
                    "error": null,
                })
            );

            workspace.set_right_pane("launcher", cx);
            workspace.set_right_pane("live-voice", cx);
            let again = snapshot(workspace, cx);
            assert_eq!(again["liveVoice"], idle["liveVoice"]);
            assert!(
                again["transcript"]
                    .as_array()
                    .expect("transcript")
                    .is_empty()
            );
        })
        .expect("workspace window");
}

/// Opening Live Voice resets the dictation capture state but never the
/// composer: a draft is still there, and no transcribed text is appended
/// without a terminal `dictation_end` frame.
///
/// The append helper (`append_dictation_text`) is private to `app.rs`, so the
/// integration harness asserts the composer half of the contract.
#[gpui_kit::test]
fn dictation_reset_preserves_the_composer_draft(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, window, cx| {
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| {
                state.set_value("keep this draft", window, cx);
            });

            workspace.set_right_pane("live-voice", cx);
            let state = snapshot(workspace, cx);
            assert_eq!(state["composer"]["text"], "keep this draft");
            assert!(
                state["transcript"]
                    .as_array()
                    .expect("transcript")
                    .is_empty()
            );

            workspace.set_right_pane("launcher", cx);
            workspace.set_right_pane("live-voice", cx);
            assert_eq!(
                snapshot(workspace, cx)["composer"]["text"],
                "keep this draft"
            );
        })
        .expect("workspace window");
}

/// A build with no updater feed key stays on the unconfigured path: entering
/// Settings twice never changes the page, and the parity build has no key.
///
/// `UpdateCheckState::label` and `state_for_result` are public inside the
/// private `updates` module, so the integration harness asserts the public
/// half: the build is unconfigured and the Settings snapshot is stable.
#[gpui_kit::test]
fn update_row_keeps_an_unconfigured_build_stable(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    assert!(
        !option_env!("OMP_UPDATER_PUBKEY").is_some_and(|key| !key.trim().is_empty()),
        "the parity build has no updater feed key"
    );

    let handle = cx.open_window(size(px(1280.0), px(1200.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    let first = handle
        .update(cx, |workspace, _, cx| {
            workspace.set_view(AppView::Settings, cx);
            snapshot(workspace, cx)
        })
        .expect("settings snapshot");
    assert_eq!(first["view"], "settings");
    assert_eq!(first["settings"]["theme"], "system");

    let second = handle
        .update(cx, |workspace, _, cx| {
            workspace.set_view(AppView::Workspace, cx);
            workspace.set_view(AppView::Settings, cx);
            snapshot(workspace, cx)
        })
        .expect("settings snapshot");
    assert_eq!(second["view"], "settings");
    assert_eq!(second["settings"], first["settings"]);
}

/// A newly added file is reported unstaged, becomes staged, returns to
/// unstaged after unstage, and the tree is clean once the file is removed.
#[gpui_kit::test]
fn review_pane_reports_a_staged_new_file_and_a_clean_tree(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&repo, cx);
            workspace.set_right_pane("review", cx);
            let clean = snapshot(workspace, cx);
            assert_eq!(clean["review"]["error"], json!(null));
            assert_eq!(clean["review"]["status"]["files"], json!([]));

            std::fs::write(repo.join("b.txt"), "brand new\n").expect("new file");
            workspace.refresh_review();
            let untracked = snapshot(workspace, cx);
            assert!(
                untracked["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "b.txt" && file["staged"] == json!(false))
            );

            workspace.stage_path("b.txt", true, cx);
            let staged = snapshot(workspace, cx);
            assert!(
                staged["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "b.txt" && file["staged"] == json!(true))
            );
            assert!(
                workspace
                    .review_status()
                    .expect("staged status")
                    .files
                    .iter()
                    .any(|file| file.path == "b.txt" && file.staged)
            );

            workspace.stage_path("b.txt", false, cx);
            let unstaged = snapshot(workspace, cx);
            assert!(
                unstaged["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "b.txt" && file["staged"] == json!(false))
            );

            std::fs::remove_file(repo.join("b.txt")).expect("remove new file");
            workspace.refresh_review();
            let clean_again = snapshot(workspace, cx);
            assert_eq!(clean_again["rightPane"], "review");
            assert_eq!(clean_again["review"]["error"], json!(null));
            assert_eq!(clean_again["review"]["status"]["files"], json!([]));
            assert!(
                workspace
                    .review_status()
                    .expect("clean status")
                    .files
                    .is_empty()
            );
        })
        .expect("workspace window");
}

/// The URL policy is the single gate for every address the app opens: the
/// Browser pane's address bar and home tab, and the Settings row that stores
/// the home, all funnel through `parse_http_url`. Credentials, non-http
/// schemes and hosts a URL parser cannot resolve are refused, while a plain
/// http/https address with a host is accepted — and the Settings path really
/// does drop a rejected address instead of persisting it.
#[gpui_kit::test]
fn url_policy_rejects_unsafe_addresses_and_accepts_http_urls(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);

    for (address, message) in [
        (
            "https://user:pass@example.com",
            "must not contain credentials",
        ),
        ("https://user@example.com", "must not contain credentials"),
        ("javascript:alert(1)", "must use http or https"),
        ("file:///etc/passwd", "must use http or https"),
        ("https://", "must be a valid URL"),
        ("https://exa mple.com", "must be a valid URL"),
    ] {
        let error = omp_core::url_policy::parse_http_url(address, "Address").expect_err(address);
        assert!(
            error.message.contains(message),
            "{address} reported {:?}",
            error.message
        );
        assert_eq!(error.code, "TypeError");
    }

    for address in [
        "https://example.com",
        "http://example.com/docs?q=1",
        "https://example.com:8443/x",
    ] {
        let parsed = omp_core::url_policy::parse_http_url(address, "Address")
            .unwrap_or_else(|error| panic!("{address}: {}", error.message));
        assert!(matches!(parsed.scheme(), "http" | "https"));
        assert!(parsed.host_str().is_some(), "{address} has no host");
    }

    // The Settings row stores the Browser home through the same gate, so a
    // rejected address leaves both the live settings and the state file alone.
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            let default_home = workspace.settings().browser_home.clone();
            workspace.update_setting(json!({ "browserHome": "javascript:alert(1)" }), cx);
            assert_eq!(workspace.settings().browser_home, default_home);
            workspace.update_setting(
                json!({ "browserHome": "https://user:pass@example.com" }),
                cx,
            );
            assert_eq!(workspace.settings().browser_home, default_home);
            workspace.update_setting(json!({ "browserHome": "https://example.com/docs" }), cx);
            assert_eq!(
                workspace.settings().browser_home,
                "https://example.com/docs"
            );
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(store.settings().browser_home, "https://example.com/docs");
}

/// Agent event normalization lives in `omp_core::agent::normalize_event`, which
/// is private: only `AgentManager::drain_events` reaches it, and that needs a
/// spawned `omp` runtime, which this suite never starts. The harness therefore
/// pins the public boundary the normalizer feeds: with no runtime the public
/// drain hands out no envelopes at all, and the workspace's live-voice state and
/// transcript stay exactly as they started, so neither a malformed nor a valid
/// `live_*`/`dictation_*` frame can reach a pane here. Once `normalize_event` is
/// public, this case should feed it the malformed frames (an unknown
/// `live_phase`, a negative `live_transcript` turn, a `dictation_state` without
/// a capture id) next to the valid ones and assert the drop/keep split directly.
#[gpui_kit::test]
fn agent_frame_normalization_never_reaches_the_panes_without_a_runtime(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);

    // The manager has no runtime to read frames from, so it normalizes nothing.
    let mut agents = omp_core::agent::AgentManager::default();
    assert!(agents.list().is_empty());
    assert!(agents.drain_events(None).is_empty());
    assert!(agents.drain_events(Some("omp-1")).is_empty());
    agents.stop_all();
    assert!(agents.drain_events(None).is_empty());

    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            let before = snapshot(workspace, cx);
            workspace.drain_agent_events();
            workspace.drain_agent_events();
            let after = snapshot(workspace, cx);

            assert_eq!(after["liveVoice"], before["liveVoice"]);
            assert_eq!(after["liveVoice"]["runtime"], json!(false));
            assert_eq!(after["liveVoice"]["phase"], "idle");
            assert_eq!(after["liveVoice"]["active"], json!(false));
            assert_eq!(after["liveVoice"]["muted"], json!(false));
            assert_eq!(after["liveVoice"]["error"], json!(null));
            // The fields the normalizer's `live_*` frames write, and no others.
            let mut keys: Vec<&str> = after["liveVoice"]
                .as_object()
                .expect("live voice state")
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert_eq!(keys, ["active", "error", "muted", "phase", "runtime"]);

            // No frame ever lands in the transcript or the composer.
            assert_eq!(after["transcript"], json!([]));
            assert_eq!(after["composer"]["text"], "");
            assert_eq!(after["subagents"], json!([]));
            assert_eq!(after["rightPane"], "launcher");
        })
        .expect("workspace window");
}

/// The launcher overview is the right pane a fresh window opens on, and every
/// pane name it can show round-trips through the funnel its rows use. The rows
/// do not opt into gpui-kit's element registry, so the Summary row is clicked at
/// its measured position to prove the row list really drives `set_right_pane`;
/// the remaining names — Live Voice and Activity included, which live on the
/// toolbar rather than in the row list — are then opened by name.
#[gpui_kit::test]
fn launcher_overview_reaches_every_right_pane_name(cx: &mut TestAppContext) {
    const PANE_X: f32 = 1100.0;
    const SUMMARY_ROW_Y: f32 = 70.0;
    const NAMES: [&str; 9] = [
        "summary",
        "review",
        "files",
        "browser",
        "side-question",
        "ask",
        "subagents",
        "live-voice",
        "activity",
    ];

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    handle
        .update(cx, |workspace, _, cx| {
            let launcher = snapshot(workspace, cx);
            assert_eq!(launcher["rightPane"], "launcher");
            assert_eq!(launcher["layout"]["rightPaneDocked"], json!(true));
        })
        .expect("launcher window");

    // The Summary row is the first launcher row: clicking it opens its pane.
    click_at(cx, handle, PANE_X, SUMMARY_ROW_Y);
    handle
        .update(cx, |workspace, _, cx| {
            assert_eq!(snapshot(workspace, cx)["rightPane"], "summary");
        })
        .expect("summary row");

    handle
        .update(cx, |workspace, _, cx| {
            for name in NAMES {
                if cfg!(target_os = "linux") && name == "browser" {
                    // The Linux headless harness cannot build a WebKitGTK webview.
                    continue;
                }
                workspace.set_right_pane(name, cx);
                let state = snapshot(workspace, cx);
                assert_eq!(state["rightPane"], name);
                assert_eq!(state["layout"]["rightPaneDocked"], json!(true));
                assert_eq!(state["transcript"], json!([]));
            }
            workspace.set_right_pane("launcher", cx);
            assert_eq!(snapshot(workspace, cx)["rightPane"], "launcher");
        })
        .expect("pane names");
}

/// The Ask pane is reached through the same funnel as every other pane, and a
/// fresh workspace has no dialog: the snapshot reports `askDialog: null` before
/// and after opening it, and neither the transcript nor the composer changes.
///
/// The request path itself (an `extension_ui_request` opening the pane, Submit
/// and Cancel responses) is unit-tested in `app.rs`: a normalized frame only
/// arrives through a spawned `omp` runtime, which this suite never starts.
#[gpui_kit::test]
fn ask_pane_opens_empty_without_a_request(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    handle
        .update(cx, |workspace, _, cx| {
            assert_eq!(snapshot(workspace, cx)["askDialog"], json!(null));
            workspace.set_right_pane("ask", cx);
            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "ask");
            assert_eq!(state["layout"]["rightPaneDocked"], json!(true));
            assert_eq!(state["askDialog"], json!(null));
            assert_eq!(state["transcript"], json!([]));
            assert_eq!(state["composer"]["text"], "");
        })
        .expect("ask pane window");
    // Drawing the empty pane exercises its placeholder branch.
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
        })
        .expect("draw ask frame");
    });
    handle
        .update(cx, |workspace, _, cx| {
            assert_eq!(snapshot(workspace, cx)["askDialog"], json!(null));
            assert_eq!(snapshot(workspace, cx)["transcript"], json!([]));
            workspace.set_right_pane("launcher", cx);
            assert_eq!(snapshot(workspace, cx)["rightPane"], "launcher");
        })
        .expect("ask pane round trip");
}

/// Below the compact breakpoint the right pane stops docking and becomes an
/// overlay, so the center column keeps its floor; below the small breakpoint
/// both panes overlay it. Opening a pane in that band never squeezes the center
/// below `CENTER_MIN_WIDTH`, and the snapshot reports both docked flags with the
/// overlay name.
#[gpui_kit::test]
fn compact_layout_snapshot_reports_the_overlay_and_keeps_the_center_minimum(
    cx: &mut TestAppContext,
) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();

    // 900px sits inside the compact band (720 < 900 <= 980): the sidebar docks,
    // the right pane overlays it.
    let compact = cx.open_window(size(px(900.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    compact
        .update(cx, |workspace, _, cx| {
            let state = snapshot(workspace, cx);
            let layout = &state["layout"];
            assert_eq!(state["rightPane"], "launcher");
            assert_eq!(layout["sidebarDocked"], json!(true));
            assert_eq!(layout["sidebarWidth"].as_f64(), Some(248.0));
            assert_eq!(layout["rightPaneDocked"], json!(false));
            assert_eq!(layout["rightPaneWidth"].as_f64(), Some(0.0));
            assert_eq!(layout["centerWidth"].as_f64(), Some(652.0));
            assert_eq!(layout["overlay"], "rightPane");
            assert!(workspace.layout().center_width >= CENTER_MIN_WIDTH);

            // Opening a pane keeps it overlaid instead of taking center width.
            workspace.set_right_pane("files", cx);
            let opened = snapshot(workspace, cx);
            assert_eq!(opened["rightPane"], "files");
            assert_eq!(opened["layout"]["rightPaneDocked"], json!(false));
            assert_eq!(opened["layout"]["rightPaneWidth"].as_f64(), Some(0.0));
            assert_eq!(opened["layout"]["overlay"], "rightPane");
            assert_eq!(opened["layout"]["centerWidth"].as_f64(), Some(652.0));
            assert!(workspace.layout().center_width >= CENTER_MIN_WIDTH);
        })
        .expect("compact window");

    // 640px is below the small breakpoint: neither pane docks, both overlay.
    let small = cx.open_window(size(px(640.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    small
        .update(cx, |workspace, _, cx| {
            let state = snapshot(workspace, cx);
            let layout = &state["layout"];
            assert_eq!(layout["sidebarDocked"], json!(false));
            assert_eq!(layout["sidebarWidth"].as_f64(), Some(0.0));
            assert_eq!(layout["rightPaneDocked"], json!(false));
            assert_eq!(layout["rightPaneWidth"].as_f64(), Some(0.0));
            assert_eq!(layout["centerWidth"].as_f64(), Some(640.0));
            assert_eq!(layout["overlay"], "rightPane");
            assert!(workspace.layout().center_width >= CENTER_MIN_WIDTH);
        })
        .expect("small window");
}

/// The Review pane reports a modified tracked file as an unstaged change, and
/// the public diff for that path carries the added line inside a hunk; reverting
/// the file clears both the snapshot and the diff.
#[gpui_kit::test]
fn review_snapshot_reports_a_tracked_file_diff_and_clears_after_revert(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let repo = seed_repo(root);
    let repo_path = repo.to_str().expect("repo path");

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    std::fs::create_dir_all(&data.home_dir).expect("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&repo, cx);
            workspace.set_right_pane("review", cx);

            let clean = snapshot(workspace, cx);
            assert_eq!(clean["review"]["error"], json!(null));
            assert_eq!(clean["review"]["status"]["files"], json!([]));

            std::fs::write(repo.join("a.txt"), "line1\nline2\n").expect("edit");
            workspace.refresh_review();
            let dirty = snapshot(workspace, cx);
            assert!(
                dirty["review"]["status"]["files"]
                    .as_array()
                    .expect("files")
                    .iter()
                    .any(|file| file["path"] == "a.txt" && file["staged"] == json!(false)),
                "review snapshot: {}",
                dirty["review"]
            );

            // The pane's diff for that entry: the hunk and the added line.
            let store = open_store(root);
            let diff = omp_core::git::diff(&store, Platform::current(), repo_path, "a.txt", false)
                .expect("diff");
            assert!(diff.text.contains("@@"), "diff: {}", diff.text);
            assert!(diff.text.contains("+line2"), "diff: {}", diff.text);
            drop(store);

            git(&repo, &["checkout", "--", "a.txt"]);
            workspace.refresh_review();
            let reverted = snapshot(workspace, cx);
            assert_eq!(reverted["rightPane"], "review");
            assert_eq!(reverted["review"]["error"], json!(null));
            assert_eq!(reverted["review"]["status"]["files"], json!([]));
            assert!(
                workspace
                    .review_status()
                    .expect("clean status")
                    .files
                    .is_empty()
            );

            let store = open_store(root);
            let cleared =
                omp_core::git::diff(&store, Platform::current(), repo_path, "a.txt", false)
                    .expect("diff after revert");
            assert_eq!(cleared.text, "");
        })
        .expect("workspace window");
}

/// The Activity pane reads the persisted notifications and clears them through
/// `store.update`, so the empty list is what a fresh store reads back.
#[gpui_kit::test]
fn activity_notifications_survive_a_reload_and_clear_all_persists(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();

    // Seeding goes through the same store the workspace opens, so the records
    // reach the app the way a previous run's state file would.
    {
        let mut store = open_store(root);
        store
            .update(|state| {
                state.notifications = vec![
                    NotificationRecord {
                        id: "build-finished".to_string(),
                        title: "Build finished".to_string(),
                        body: "The parity suite passed.".to_string(),
                        created_at: "2026-11-19T10:00:00.000Z".to_string(),
                        read: false,
                        unknown: Default::default(),
                    },
                    NotificationRecord {
                        id: "waiting".to_string(),
                        title: "Waiting for input".to_string(),
                        body: "Review the staged changes.".to_string(),
                        created_at: "2026-11-19T11:00:00.000Z".to_string(),
                        read: true,
                        unknown: Default::default(),
                    },
                ];
                Ok(())
            })
            .expect("seed notifications");
    }

    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_right_pane("activity", cx);

            let state = snapshot(workspace, cx);
            assert_eq!(state["rightPane"], "activity");
            let notifications = state["notifications"].as_array().expect("notifications");
            assert_eq!(notifications.len(), 2);
            assert_eq!(notifications[0]["title"], "Build finished");
            // Opening the pane acknowledged the list, so the record the seed
            // left unread is persisted as read and the badge is empty.
            assert_eq!(notifications[0]["read"], json!(true));
            assert_eq!(state["unreadNotifications"], json!(0));
            assert_eq!(notifications[0]["createdAt"], "2026-11-19T10:00:00.000Z");
            assert_eq!(notifications[1]["body"], "Review the staged changes.");
            assert_eq!(notifications[1]["read"], json!(true));

            workspace.clear_notifications(cx);
            let cleared = snapshot(workspace, cx);
            assert!(
                cleared["notifications"]
                    .as_array()
                    .expect("notifications")
                    .is_empty()
            );
        })
        .expect("workspace window");

    let store = open_store(root);
    assert!(store.state().notifications.is_empty());
}

/// The toolbar's unread badge counts persisted notifications, drops when the
/// Activity pane opens (which marks them read), and a finished turn appends a
/// fresh unread record. Both the read marks and the new record survive a
/// reload because they go through the state file.
#[gpui_kit::test]
fn unread_notification_badge_clears_on_open_and_a_finished_turn_raises_it(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();

    {
        let mut store = open_store(root);
        store
            .update(|state| {
                state.notifications = vec![
                    NotificationRecord {
                        id: "build-finished".to_string(),
                        title: "Build finished".to_string(),
                        body: "The parity suite passed.".to_string(),
                        created_at: "2026-11-19T10:00:00.000Z".to_string(),
                        read: false,
                        unknown: Default::default(),
                    },
                    NotificationRecord {
                        id: "already-read".to_string(),
                        title: "Already read".to_string(),
                        body: String::new(),
                        created_at: "2026-11-19T09:00:00.000Z".to_string(),
                        read: true,
                        unknown: Default::default(),
                    },
                ];
                Ok(())
            })
            .expect("seed notifications");
    }

    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            let closed = snapshot(workspace, cx);
            assert_eq!(closed["rightPane"], "launcher");
            assert_eq!(
                closed["unreadNotifications"],
                json!(1),
                "only the seeded unread record is counted"
            );
            assert_eq!(closed["attention"], json!(1));

            // A finished turn records its completion unread, so the badge grows
            // without the Activity pane ever being opened. This is the same
            // helper `agent_end` calls, so no agent runtime is spawned.
            workspace.record_completion_notification("Task complete", "The parity suite passed.");
            let recorded = snapshot(workspace, cx);
            assert_eq!(recorded["unreadNotifications"], json!(2));
            let notifications = recorded["notifications"].as_array().expect("notifications");
            assert_eq!(notifications.len(), 3);
            let newest = notifications.last().expect("newest notification");
            assert_eq!(newest["title"], "Task complete");
            assert_eq!(newest["body"], "The parity suite passed.");
            assert_eq!(newest["read"], json!(false));

            // Opening the pane acknowledges the list: every record is marked
            // read and the badge is gone.
            workspace.set_right_pane("activity", cx);
            let opened = snapshot(workspace, cx);
            assert_eq!(opened["rightPane"], "activity");
            assert_eq!(opened["unreadNotifications"], json!(0));
            assert_eq!(opened["attention"], json!(0));
            assert!(
                opened["notifications"]
                    .as_array()
                    .expect("notifications")
                    .iter()
                    .all(|notification| notification["read"] == json!(true))
            );
        })
        .expect("workspace window");

    handle
        .update(cx, |_, window, _| window.remove_window())
        .expect("close the first window");

    // The read marks and the completion record are on disk: a reload reads the
    // same three records, all read.
    let store = open_store(root);
    let persisted = &store.state().notifications;
    assert_eq!(persisted.len(), 3);
    assert!(persisted.iter().all(|notification| notification.read));
    assert_eq!(persisted[2].title, "Task complete");
    drop(store);

    // A fresh window reads the persisted list back: the badge stays cleared,
    // and only a later completion raises it again.
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            let reloaded = snapshot(workspace, cx);
            assert_eq!(reloaded["unreadNotifications"], json!(0));
            assert_eq!(
                reloaded["notifications"]
                    .as_array()
                    .expect("notifications")
                    .len(),
                3
            );
            workspace.record_completion_notification("Task complete", "Second run");
            assert_eq!(snapshot(workspace, cx)["unreadNotifications"], json!(1));
        })
        .expect("reloaded workspace window");
}

/// Seeds both attention sources: one unread and one read notification, plus an
/// unread session in the catalog. `list_sessions` does not set the flag yet, so
/// it is flipped here, the way a reload would once the catalog reports it.
fn seed_attention(root: &Path, home: &Path) -> Vec<omp_core::sessions::SessionRecord> {
    let mut store = open_store(root);
    store
        .update(|state| {
            state.notifications = vec![
                NotificationRecord {
                    id: "build-finished".to_string(),
                    title: "Build finished".to_string(),
                    body: "The parity suite passed.".to_string(),
                    created_at: "2026-11-20T09:00:00.000Z".to_string(),
                    read: false,
                    unknown: Default::default(),
                },
                NotificationRecord {
                    id: "already-read".to_string(),
                    title: "Already read".to_string(),
                    body: "Nothing to see.".to_string(),
                    created_at: "2026-11-20T08:00:00.000Z".to_string(),
                    read: true,
                    unknown: Default::default(),
                },
            ];
            Ok(())
        })
        .expect("seed notifications");
    let mut catalog = omp_core::sessions::list_sessions(&store, home, false, None);
    catalog[0].unread = true;
    catalog
}

/// Unpinned, the launcher stays where it belongs: the Schedules page stands
/// alone instead of sharing the window with the Overview, and the workspace
/// comes back to the transcript.
#[gpui_kit::test]
fn unpinned_overview_returns_to_the_transcript(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, _older, _newer) = seed_two_sessions(root);
    let catalog = seed_attention(root, &home);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);
            let launcher = snapshot(workspace, cx);
            assert_eq!(launcher["rightPane"], "launcher");
            assert_eq!(launcher["overviewPinned"], json!(false));
            assert_eq!(launcher["overviewVisible"], json!(true));
            assert_eq!(launcher["attention"], json!(2));
        })
        .expect("workspace window");

    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_view(AppView::Schedules, cx);
            let schedules = snapshot(workspace, cx);
            assert_eq!(schedules["view"], "schedules");
            // Nothing was pinned, so the launcher stays behind and the page
            // owns the window.
            assert_eq!(schedules["overviewPinned"], json!(false));
            assert_eq!(schedules["overviewVisible"], json!(false));
        })
        .expect("schedules view");

    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_view(AppView::Workspace, cx);
            let back = snapshot(workspace, cx);
            assert_eq!(back["view"], "workspace");
            // The switch returns to the transcript with the launcher back in
            // the pane it owns, never pinned to another view.
            assert_eq!(back["selectedSession"], json!(0));
            assert_eq!(back["rightPane"], "launcher");
            assert_eq!(back["overviewVisible"], json!(true));
            assert_eq!(transcript_text(workspace), ["newer prompt", "newer reply"]);
        })
        .expect("workspace return");
}

/// Removing a project through its row menu drops the grant and the project's
/// sessions from the sidebar while another project's open session survives, and
/// leaves the folders and the session files on disk alone.
#[gpui_kit::test]
fn removing_a_project_drops_the_grant_and_its_sessions(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let project = seed_project(root);
    // A second project keeps a session open while the first one goes away.
    let other = root.join("other-project");
    std::fs::create_dir_all(&other).expect("other project");
    std::fs::write(other.join("notes.md"), "# Other\n").expect("notes");
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let doomed_session = write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-dddd-7000-8000-000000000004.jsonl",
        "Doomed project session",
        "2026-04-01T05:00:00.000Z",
        "project prompt",
        "project reply",
        &project,
    );
    let kept_session = write_session(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-eeee-7000-8000-000000000005.jsonl",
        "Kept project session",
        "2026-04-01T04:00:00.000Z",
        "other prompt",
        "other reply",
        &other,
    );

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    // Newest first, so the doomed session is row 0 and the kept one row 1.
    assert_eq!(catalog.len(), 2);
    assert!(same_path(&catalog[0].file_path, &doomed_session));
    assert!(same_path(&catalog[1].file_path, &kept_session));

    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    let removed_id = handle
        .update(cx, |workspace, _, cx| {
            workspace.grant_project(&project, cx);
            workspace.grant_project(&other, cx);
            assert_eq!(workspace.projects().len(), 2);
            let id = workspace.projects()[0].id.clone();
            assert_eq!(snapshot(workspace, cx)["projects"][0]["name"], "project");

            // The other project's session is the one on screen.
            workspace.select_session(1, cx);
            assert_eq!(transcript_text(workspace), ["other prompt", "other reply"]);

            // The row's ellipsis opens the menu under it.
            workspace.toggle_project_menu(&id, cx);
            assert_eq!(snapshot(workspace, cx)["projectMenu"], json!(id));
            id
        })
        .expect("workspace window");

    // The open menu draws on the next frame, before its one row is used.
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
        })
        .expect("project menu frame");
    });

    handle
        .update(cx, |workspace, _, cx| {
            workspace.project_menu_action(&removed_id, "Remove project", cx);

            let state = snapshot(workspace, cx);
            // Only the removed project left, and the action closed its menu.
            let projects = state["projects"].as_array().expect("projects");
            assert_eq!(projects.len(), 1);
            assert_eq!(projects[0]["name"], "other-project");
            assert_eq!(state["projectMenu"], json!(null));
            // Its session left the catalog with it; the open session of the
            // other project stays, at the index the shorter catalog gives it.
            let sessions = state["sessions"].as_array().expect("sessions");
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0]["title"], "Kept project session");
            assert_eq!(state["selectedSession"], json!(0));
            assert_eq!(transcript_text(workspace), ["other prompt", "other reply"]);

            // Removing the project the open session belongs to clears it.
            let other_id = projects[0]["id"].as_str().expect("other id").to_string();
            workspace.project_menu_action(&other_id, "Remove project", cx);
            let state = snapshot(workspace, cx);
            assert_eq!(state["projects"], json!([]));
            assert_eq!(state["sessions"], json!([]));
            assert_eq!(state["selectedSession"], json!(null));
            assert!(workspace.transcript_messages().is_empty());
        })
        .expect("workspace window");

    // Only the grants went away: the folders and their saved sessions stay.
    assert!(project.exists(), "removing a project keeps the folder");
    assert!(other.exists(), "removing a project keeps the folder");
    assert!(
        doomed_session.exists(),
        "removing a project keeps its session files"
    );
    assert!(
        kept_session.exists(),
        "removing a project keeps its session files"
    );

    let store = open_store(root);
    assert!(omp_core::projects::list_projects(&store).is_empty());
    let dismissed: Vec<PathBuf> = store
        .state()
        .dismissed_project_paths
        .iter()
        .map(PathBuf::from)
        .collect();
    for folder in [&project, &other] {
        let canonical = omp_core::paths::canonicalize(folder).expect("canonical project");
        assert!(
            dismissed.contains(&canonical),
            "the removed folder is dismissed so a scan cannot re-add it"
        );
    }

    // A fresh window scans the same files, and the dismissed folders keep their
    // sessions out of the sidebar catalog.
    let rescanned = omp_core::sessions::list_sessions(&store, &home, false, None);
    assert_eq!(rescanned.len(), 2, "the JSONL files are still on disk");
    drop(store);
    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.sessions = rescanned;
    let reopened = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    reopened
        .update(cx, |workspace, _, cx| {
            assert_eq!(snapshot(workspace, cx)["sessions"], json!([]));
        })
        .expect("reopened workspace");
}

/// The toolbar's Capture workspace action renders the window into
/// `<user_data_dir>/captures` and reports the result. The test platform only
/// renders frames with a headless renderer configured, so a run without one
/// takes the error branch: the status row reports it and nothing is written.
#[gpui_kit::test]
fn capture_workspace_reports_the_saved_path_or_the_render_error(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, test_data(root))
    });
    // Rendering drives the root view, so a frame is drawn through the window
    // handle; `Workspace::update` cannot nest inside its own render.
    let window: gpui_kit::AnyWindowHandle = handle.into();

    // The toolbar is drawn before it is pressed. Pressing the button through a
    // measured position is the click test's job; the action is reached
    // directly here, exactly like `copy_transcript`.
    cx.update(|cx| {
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("toolbar frame");
    });

    let handle = window.downcast::<Workspace>().expect("workspace handle");

    let capture = handle
        .update(cx, |workspace, window, cx| {
            let before = snapshot(workspace, cx);
            assert_eq!(before["capture"]["path"], json!(null));
            assert_eq!(before["capture"]["error"], json!(null));
            workspace.capture_workspace(window, cx);
            snapshot(workspace, cx)["capture"].clone()
        })
        .expect("workspace window");

    let captures = root.join("user-data").join("captures");
    match &capture["error"] {
        Value::String(message) => {
            assert_eq!(capture["path"], json!(null), "a failure reports no path");
            assert!(
                message.starts_with("Capture failed:"),
                "unexpected capture error: {message}"
            );
            assert!(
                !captures.exists(),
                "a failed render leaves nothing behind: {}",
                captures.display()
            );
        }
        Value::Null => {
            let path = capture["path"].as_str().expect("saved path");
            let saved = PathBuf::from(path);
            assert!(saved.starts_with(&captures), "{path}");
            let png = std::fs::read(&saved).expect("capture file");
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "capture is a PNG");
            let frame = image::open(&saved).expect("decode capture");
            assert!(frame.width() > 0 && frame.height() > 0);
        }
        other => panic!("unexpected capture state: {other}"),
    }

    // The status row draws from the result, so the next frame must not panic
    // and must leave the transcript alone.
    cx.update(|cx| {
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("capture frame");
    });
    handle
        .update(cx, |workspace, _, _| {
            assert!(workspace.transcript_messages().is_empty());
        })
        .expect("workspace window");
}

#[cfg(unix)]
#[gpui_kit::test]
fn running_close_prompt_mounts_and_dismisses_animated_card(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let guard = CloseGuard::new();
    cx.update(|cx| cx.set_global(guard.clone()));
    let (home, _, _) = seed_two_sessions(root);
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project dir");
    let mut store = open_store(root);
    omp_core::projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant project");
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = install_fixture_omp(root);
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert!(workspace.agent_active());
            assert!(!workspace.request_close(CloseIntent::Window, cx));
            assert_eq!(snapshot(workspace, cx)["closePrompt"], json!("window"));
        })
        .expect("running close prompt");
    draw_frame(cx, handle.into());
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("close-confirmation").is_some());
            assert!(window.try_find("close-confirmation-card").is_some());
        })
        .expect("animated modal");
    handle
        .update(cx, |workspace, _, cx| workspace.cancel_close(cx))
        .expect("cancel close");
    draw_frame(cx, handle.into());
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("close-confirmation").is_none());
        })
        .expect("dismissed modal");
}

/// Closing with no agent run is immediate: the close is allowed, no overlay is
/// raised, and the guard stays idle. The pure helper is the rule both entry
/// points share.
#[gpui_kit::test]
fn closing_without_an_agent_run_is_immediate(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    assert!(!should_confirm_close(false));
    assert!(should_confirm_close(true));

    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    // `main` installs the guard before the window opens, so the close handler
    // and the view share one.
    let guard = CloseGuard::new();
    cx.update(|cx| cx.set_global(guard.clone()));
    let data = test_data(root);
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));

    let (allowed, prompt) = handle
        .update(cx, |workspace, _, cx| {
            let allowed = workspace.request_close(CloseIntent::Window, cx);
            (allowed, snapshot(workspace, cx)["closePrompt"].clone())
        })
        .expect("workspace window");
    assert!(allowed);
    assert_eq!(prompt, json!(null));
    assert!(!guard.agent_active());
    assert!(!guard.approved());
}

/// The tray's Quit takes the same route through the guard: with no agent run
/// the app quits at once instead of raising the confirmation.
#[gpui_kit::test]
fn tray_quit_without_an_agent_run_quits(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let guard = CloseGuard::new();
    cx.update(|cx| cx.set_global(guard.clone()));
    let data = test_data(root);
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));

    // The view is the source of truth while it is alive, and it has no runtime.
    assert!(cx.update(request_app_quit));
    let prompt = handle
        .update(cx, |workspace, _, cx| {
            snapshot(workspace, cx)["closePrompt"].clone()
        })
        .expect("workspace window");
    assert_eq!(prompt, json!(null));
}

/// Draws one frame of the workspace through its window handle.
///
/// Rendering drives the root view, so a frame is drawn here rather than inside
/// `Workspace::update`. A toolbar that cannot build with the state under test
/// fails the scenario instead of passing silently.
fn draw_frame(cx: &mut TestAppContext, window: gpui_kit::AnyWindowHandle) {
    cx.update(|cx| {
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("workspace frame");
    });
}

/// The toolbar's context dial follows the harness's `get_session_stats`
/// reading: it appears once a usable response arrives, keeps the last reading
/// when a response is malformed, and a session switch clears it so the dial
/// never reports the previous session's window.
///
/// No agent runs here: the reading is seeded through `apply_session_stats`,
/// which is the same path the `agent_end` refresh uses. The app does not opt
/// into gpui-kit's element queries, so the dial is proven by drawing the
/// toolbar with a reading in place and by reading the state it draws from out
/// of `debug_snapshot`.
#[gpui_kit::test]
fn context_usage_appears_with_a_reading_and_clears_on_a_session_switch(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let (home, _older, _newer) = seed_two_sessions(root);
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    let window: gpui_kit::AnyWindowHandle = handle.into();

    let handle = window.downcast::<Workspace>().expect("workspace handle");
    handle
        .update(cx, |workspace, _, cx| {
            // No response yet: the toolbar has no reading to draw.
            assert_eq!(snapshot(workspace, cx)["contextUsage"], json!(null));

            workspace.apply_session_stats(&json!({
                "success": true,
                "data": {
                    "contextUsage": {
                        "tokens": 123456,
                        "contextWindow": 200000,
                        "percent": 61.7,
                    }
                }
            }));
            assert_eq!(
                snapshot(workspace, cx)["contextUsage"],
                json!({ "tokens": 123456, "window": 200000, "percent": 61.7 })
            );

            // A zero window cannot be a reading; it leaves the last one alone.
            workspace.apply_session_stats(&json!({
                "success": true,
                "data": {
                    "contextUsage": { "tokens": 1, "contextWindow": 0, "percent": 1.0 }
                }
            }));
            assert_eq!(
                snapshot(workspace, cx)["contextUsage"],
                json!({ "tokens": 123456, "window": 200000, "percent": 61.7 })
            );
        })
        .expect("workspace window");

    // The toolbar builds with the dial in place.
    draw_frame(cx, window);

    // Switching sessions drops the reading: the new session has no window yet,
    // and the runtime here cannot start (the suite never runs a real `omp`).
    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["contextUsage"], json!(null));
        })
        .expect("workspace window");
    draw_frame(cx, window);
}

/// A send while a turn is running is a follow-up, not a prompt: the fixture
/// reports it on its own queue and the transcript shows a distinct queued row,
/// while an idle send still starts a normal prompt. The fixture only answers a
/// `follow_up` by queueing it and a `prompt` by echoing it, so the echo is the
/// proof that the idle path did not become a follow-up.
#[cfg(unix)]
#[gpui_kit::test]
fn composer_send_while_running_queues_a_follow_up(cx: &mut TestAppContext) {
    use omp_core::projects;
    use std::os::unix::fs::PermissionsExt;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    let bin = root.join("bin");
    for folder in [&home, &project, &bin, &root.join("user-data")] {
        std::fs::create_dir_all(folder).expect("dir");
    }
    let project = project.canonicalize().expect("project path");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
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

    let mut store = open_store(root);
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    drop(store);

    let bucket = home.join(".omp/agent/sessions/-omp-project");
    write_session(
        &bucket,
        "2026-04-02T00-00-00-000Z_019fdf24-dddd-7000-8000-000000000010.jsonl",
        "Follow-up",
        "2026-04-02T00:00:00.000Z",
        "first prompt",
        "first reply",
        &project,
    );
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = fixture;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["liveVoice"]["runtime"], json!(true));

            // The fixture's `[hold-busy]` prompt stays streaming, so the turn
            // is still running when the next send arrives.
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("[hold-busy]", window, cx));
            workspace.send_prompt(window, cx);
            let running = snapshot(workspace, cx);
            assert_eq!(running["running"], json!(true));
            assert_eq!(running["composer"]["text"], "");

            composer.update(cx, |state, cx| {
                state.set_value("second thought", window, cx)
            });
            workspace.send_prompt(window, cx);
            let queued = snapshot(workspace, cx);
            assert_eq!(queued["composer"]["text"], "");
            let transcript = queued["transcript"].as_array().expect("transcript");
            let last = transcript.last().expect("queued row");
            assert_eq!(last["role"], "user");
            assert_eq!(last["parts"][0]["kind"], "queued");
            assert_eq!(last["parts"][0]["text"], "second thought");
            // The optimistic row is the only trace of the text until the
            // harness starts the queued turn.
            assert_eq!(
                transcript
                    .iter()
                    .filter(|message| message["parts"][0]["text"] == "second thought")
                    .count(),
                1
            );

            // The fixture's `session_action_update` is the harness's own proof
            // that the text reached the follow-up queue.
            workspace.drain_agent_events();
            let drained = snapshot(workspace, cx);
            assert_eq!(drained["queuedFollowUps"], json!(["second thought"]));
            assert_eq!(drained["running"], json!(true));
        })
        .expect("workspace window");
    draw_frame(cx, handle.into());
    handle
        .update(cx, |_, window, _| {
            assert!(
                window.try_find("transcript-streaming-cue").is_some(),
                "a live turn needs visible streaming feedback"
            );
        })
        .expect("streaming cue");
    handle
        .update(cx, |workspace, _, cx| {
            workspace.update_setting(json!({ "reduceMotion": true }), cx);
        })
        .expect("reduced streaming cue");
    draw_frame(cx, handle.into());
    handle
        .update(cx, |_, window, _| {
            assert!(
                window.try_find("transcript-streaming-cue").is_some(),
                "Reduced Motion keeps a static activity cue"
            );
        })
        .expect("static streaming cue");

    // A fresh runtime for the same session is idle again.
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(0, cx);
            let idle = snapshot(workspace, cx);
            assert_eq!(idle["running"], json!(false));
            assert_eq!(idle["queuedFollowUps"], json!([]));

            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("idle hello", window, cx));
            workspace.send_prompt(window, cx);
            let sent = snapshot(workspace, cx);
            assert_eq!(sent["running"], json!(true));
            assert_eq!(sent["queuedFollowUps"], json!([]));
            let last = sent["transcript"]
                .as_array()
                .and_then(|transcript| transcript.last())
                .cloned()
                .expect("user row");
            assert_eq!(last["role"], "user");
            assert_eq!(last["parts"][0]["kind"], "text");
            assert_eq!(last["parts"][0]["text"], "idle hello");
        })
        .expect("workspace window");

    // The idle send was a prompt, so the fixture echoed it and ended the turn.
    let deadline = Instant::now() + Duration::from_secs(10);
    let echoed = loop {
        std::thread::sleep(Duration::from_millis(50));
        let done = handle
            .update(cx, |workspace, _, cx| {
                workspace.drain_agent_events();
                let texts = transcript_text(workspace);
                let done = snapshot(workspace, cx);
                texts
                    .iter()
                    .any(|text| text == "echo:idle hello")
                    .then_some(done)
            })
            .expect("workspace window");
        if let Some(done) = done {
            break done;
        }
        assert!(
            Instant::now() < deadline,
            "the fixture never echoed the idle prompt"
        );
    };
    assert_eq!(echoed["running"], json!(false));
    assert_eq!(echoed["streamFeedback"], json!("idle"));
    assert_eq!(echoed["queuedFollowUps"], json!([]));
    draw_frame(cx, handle.into());
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("transcript-streaming-cue").is_none());
        })
        .expect("idle after streaming");
}

/// A real one-pixel PNG: its magic is what the composer trusts, and its bytes
/// round-trip through base64 into the fixture's log.
#[cfg(unix)]
const ONE_PIXEL_PNG: [u8; 70] = [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xFC, 0xCF, 0xC0, 0x50,
    0x0F, 0x00, 0x04, 0x85, 0x01, 0x80, 0x84, 0xA9, 0x8C, 0x21, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// The base64 `ImageContent.data` for `ONE_PIXEL_PNG`.
#[cfg(unix)]
const ONE_PIXEL_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/// An attached image rides with the accepted prompt and follow-up, clears
/// once the harness accepts it, and a rejected file never becomes a chip.
///
/// The conformance fixture logs every RPC command it receives, so the exact
/// base64 and mime the harness would see are read back from its own record
/// rather than from the app's state. The picker is the only path that needs a
/// native dialog; the harness attaches through `attach_image_from_path`, which
/// is where the picker's selection lands.
#[cfg(unix)]
#[gpui_kit::test]
fn composer_attachment_rides_with_prompt_and_follow_up(cx: &mut TestAppContext) {
    use omp_core::projects;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    let fixture = install_fixture_omp(root);
    for folder in [&home, &project, &root.join("user-data")] {
        std::fs::create_dir_all(folder).expect("dir");
    }
    let project = project.canonicalize().expect("project path");

    let mut store = open_store(root);
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    drop(store);

    let bucket = home.join(".omp/agent/sessions/-omp-project");
    write_session(
        &bucket,
        "2026-04-02T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000030.jsonl",
        "Attachments",
        "2026-04-02T00:00:00.000Z",
        "first prompt",
        "first reply",
        &project,
    );
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    // A real one-pixel PNG, so the magic check and the base64 round-trip are
    // exercised on real bytes rather than a stand-in.
    let png = root.join("dot.png");
    std::fs::write(&png, ONE_PIXEL_PNG).expect("png");

    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = fixture;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(900.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    let window: gpui_kit::AnyWindowHandle = handle.into();
    let handle = window.downcast::<Workspace>().expect("workspace handle");

    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["liveVoice"]["runtime"], json!(true));

            workspace.attach_image_from_path(&png, cx);
            let attached = snapshot(workspace, cx);
            assert_eq!(
                attached["composer"]["pendingImage"],
                json!({
                    "name": "dot.png",
                    "mime": "image/png",
                    "size": ONE_PIXEL_PNG.len(),
                    "dataLength": ONE_PIXEL_PNG_BASE64.len(),
                })
            );
            assert_eq!(attached["composer"]["imageError"], json!(null));
        })
        .expect("workspace window");

    draw_frame(cx, window);
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("composer-attachment").is_some());
        })
        .expect("animated attachment chip");

    handle
        .update(cx, |workspace, window, cx| {
            // The fixture's `[hold-busy]` prompt stays streaming, so the next
            // send is a follow-up and this one is a plain prompt.
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("[hold-busy]", window, cx));
            workspace.send_prompt(window, cx);
            let sent = snapshot(workspace, cx);
            assert_eq!(sent["running"], json!(true));
            // The harness accepted the prompt, so the chip is gone.
            assert_eq!(sent["composer"]["pendingImage"], json!(null));
        })
        .expect("workspace window");

    draw_frame(cx, window);
    handle
        .update(cx, |_, window, _| {
            assert!(window.try_find("composer-attachment").is_none());
        })
        .expect("attachment removed with accepted prompt");

    handle
        .update(cx, |workspace, window, cx| {
            // A follow-up carries its own image: the queued command is a
            // separate message, not a mutation of the running prompt.
            workspace.attach_image_from_path(&png, cx);
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("queued image", window, cx));
            workspace.send_prompt(window, cx);
            let queued = snapshot(workspace, cx);
            assert_eq!(queued["running"], json!(true));
            assert_eq!(queued["composer"]["pendingImage"], json!(null));
            let last = queued["transcript"]
                .as_array()
                .and_then(|transcript| transcript.last())
                .cloned()
                .expect("queued row");
            assert_eq!(last["role"], "user");
            assert_eq!(last["parts"][0]["kind"], "queued");
            assert_eq!(last["parts"][0]["text"], "queued image");
        })
        .expect("workspace window");

    handle
        .update(cx, |workspace, _, cx| {
            // An oversized file is refused from its metadata, before it is
            // read, and never becomes a chip.
            let oversized = root.join("big.png");
            std::fs::File::create(&oversized)
                .expect("big")
                .set_len(10 * 1024 * 1024 + 1)
                .expect("size");
            workspace.attach_image_from_path(&oversized, cx);
            let rejected = snapshot(workspace, cx);
            assert_eq!(rejected["composer"]["pendingImage"], json!(null));
            let error = rejected["composer"]["imageError"]
                .as_str()
                .expect("oversized error")
                .to_string();
            assert!(error.contains("11 MB"), "{error}");

            // A name the composer does not accept is refused even when its
            // bytes are a PNG, and a supported name with other bytes is
            // refused by the magic check.
            let text = root.join("note.txt");
            std::fs::write(&text, ONE_PIXEL_PNG).expect("text");
            workspace.attach_image_from_path(&text, cx);
            let unsupported = snapshot(workspace, cx);
            assert_eq!(unsupported["composer"]["pendingImage"], json!(null));
            let error = unsupported["composer"]["imageError"]
                .as_str()
                .expect("unsupported error")
                .to_string();
            assert!(error.contains("Unsupported"), "{error}");

            let mislabelled = root.join("fake.png");
            std::fs::write(&mislabelled, b"hello").expect("fake");
            workspace.attach_image_from_path(&mislabelled, cx);
            let mismatched = snapshot(workspace, cx);
            assert_eq!(mismatched["composer"]["pendingImage"], json!(null));
            let error = mismatched["composer"]["imageError"]
                .as_str()
                .expect("mismatched error")
                .to_string();
            assert!(error.contains("not a PNG"), "{error}");

            // The composer stays usable after a rejection: a valid image
            // attaches, and removing the chip clears the error with it.
            workspace.attach_image_from_path(&png, cx);
            let retried = snapshot(workspace, cx);
            assert_eq!(
                retried["composer"]["pendingImage"]["name"],
                json!("dot.png")
            );
            assert_eq!(retried["composer"]["imageError"], json!(null));
            workspace.clear_pending_image(cx);
            let cleared = snapshot(workspace, cx);
            assert_eq!(cleared["composer"]["pendingImage"], json!(null));
            assert_eq!(cleared["composer"]["imageError"], json!(null));
        })
        .expect("workspace window");

    // The fixture's log is the harness's own record of what arrived; the
    // writes are asynchronous, so wait for the queued command to land.
    let deadline = Instant::now() + Duration::from_secs(10);
    let commands = loop {
        let commands = fixture_commands(root);
        if commands
            .iter()
            .any(|command| command["type"] == "follow_up")
        {
            break commands;
        }
        assert!(
            Instant::now() < deadline,
            "the fixture never logged the follow-up"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let expected = json!([{
        "type": "image",
        "data": ONE_PIXEL_PNG_BASE64,
        "mimeType": "image/png",
    }]);
    let prompt = commands
        .iter()
        .find(|command| command["type"] == "prompt" && command["message"] == "[hold-busy]")
        .expect("prompt command");
    assert_eq!(prompt["images"], expected);
    let follow_up = commands
        .iter()
        .find(|command| command["type"] == "follow_up")
        .expect("follow-up command");
    assert_eq!(follow_up["message"], "queued image");
    assert_eq!(follow_up["images"], expected);
    // The attachment is per send: only those two commands carried one.
    assert_eq!(
        commands
            .iter()
            .filter(|command| command.get("images").is_some())
            .count(),
        2
    );
}

/// The composer's mention menu inserts a session's `@<path>` into the draft and
/// a send carries it; an empty catalog shows a status and leaves the draft
/// alone. The menu is bounded, so a large catalog still draws only its newest
/// rows.
#[cfg(unix)]
#[gpui_kit::test]
fn composer_mention_menu_inserts_a_session_and_sends_the_path(cx: &mut TestAppContext) {
    use omp_core::projects;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    let fixture = install_fixture_omp(root);
    for folder in [&home, &project, &root.join("user-data")] {
        std::fs::create_dir_all(folder).expect("dir");
    }
    let project = project.canonicalize().expect("project path");

    let mut store = open_store(root);
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    drop(store);

    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let older = write_session(
        &bucket,
        "2026-04-02T00-00-00-000Z_019fdf24-1111-7000-8000-000000000040.jsonl",
        "Mentioned",
        "2026-04-02T00:00:00.000Z",
        "older prompt",
        "older reply",
        &project,
    );
    write_session(
        &bucket,
        "2026-04-02T00-00-00-000Z_019fdf24-2222-7000-8000-000000000041.jsonl",
        "Recent",
        "2026-04-02T01:00:00.000Z",
        "recent prompt",
        "recent reply",
        &project,
    );
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 2);
    // The catalog's own path is what the mention carries, so the assertion
    // does not depend on how the fixture directory is spelled.
    let older_path = catalog[1].file_path.clone();
    assert!(same_path(&older_path, &older));

    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = fixture;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(900.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    let window: gpui_kit::AnyWindowHandle = handle.into();
    let handle = window.downcast::<Workspace>().expect("workspace handle");

    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["liveVoice"]["runtime"], json!(true));

            // Opening the menu lists both sessions and draws no status.
            workspace.toggle_mention_menu(cx);
            let opened = snapshot(workspace, cx);
            assert_eq!(opened["composer"]["mentionMenuOpen"], json!(true));
            assert_eq!(opened["composer"]["mentionCount"], json!(2));
            assert_eq!(opened["composer"]["mentionStatus"], json!(null));
        })
        .expect("workspace window");

    // The open popover builds: a menu that cannot render fails here instead of
    // passing on the snapshot alone.
    draw_frame(cx, window);

    handle
        .update(cx, |workspace, window, cx| {
            // A selection appends `@<path>` to the draft and closes the menu;
            // the draft and the session selection are both kept.
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("summarize", window, cx));
            workspace.select_mention(1, window, cx);
            let mentioned = snapshot(workspace, cx);
            assert_eq!(mentioned["composer"]["mentionMenuOpen"], json!(false));
            assert_eq!(
                mentioned["composer"]["text"],
                json!(format!("summarize @{older_path}"))
            );
            assert_eq!(mentioned["selectedSession"], json!(0));

            // Send: the harness receives the path as plain prompt text.
            workspace.send_prompt(window, cx);
            assert_eq!(snapshot(workspace, cx)["composer"]["text"], json!(""));
        })
        .expect("workspace window");

    // The fixture's own log is the proof the mention left the app intact.
    let deadline = Instant::now() + Duration::from_secs(10);
    let expected = format!("summarize @{older_path}");
    let prompt = loop {
        let commands = fixture_commands(root);
        if let Some(prompt) = commands
            .iter()
            .find(|command| command["type"] == "prompt")
            .cloned()
        {
            break prompt;
        }
        assert!(
            Instant::now() < deadline,
            "the fixture never logged the mentioned prompt"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(prompt["message"], json!(expected));

    // An empty catalog still answers: the status shows and the draft stays.
    let empty = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    let empty_window: gpui_kit::AnyWindowHandle = empty.into();
    let empty = empty_window
        .downcast::<Workspace>()
        .expect("empty workspace handle");
    empty
        .update(cx, |workspace, window, cx| {
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("keep me", window, cx));
            workspace.toggle_mention_menu(cx);
            let opened = snapshot(workspace, cx);
            assert_eq!(opened["composer"]["mentionMenuOpen"], json!(true));
            assert_eq!(opened["composer"]["mentionCount"], json!(0));
            assert_eq!(
                opened["composer"]["mentionStatus"],
                json!("No sessions to mention yet.")
            );
        })
        .expect("empty workspace window");

    // The empty status is what the open menu draws.
    draw_frame(cx, empty_window);

    empty
        .update(cx, |workspace, window, cx| {
            // A row the menu does not have leaves the draft alone.
            workspace.select_mention(0, window, cx);
            let still = snapshot(workspace, cx);
            assert_eq!(still["composer"]["text"], json!("keep me"));
            assert_eq!(still["composer"]["mentionCount"], json!(0));
            assert_eq!(
                still["composer"]["mentionStatus"],
                json!("No sessions to mention yet.")
            );
        })
        .expect("empty workspace window");

    // The menu is bounded: a ten-session catalog still draws the newest eight.
    let records: Vec<omp_core::sessions::SessionRecord> = (0..10)
        .map(|index| omp_core::sessions::SessionRecord {
            id: format!("bounded-{index}"),
            harness: "omp".to_string(),
            file_path: root
                .join(format!("bounded-{index}.jsonl"))
                .display()
                .to_string(),
            project_path: root.display().to_string(),
            title: format!("Bounded {index}"),
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
        })
        .collect();
    let mut data = test_data(root);
    data.sessions = records;
    let bounded = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    bounded
        .update(cx, |workspace, window, cx| {
            workspace.toggle_mention_menu(cx);
            let opened = snapshot(workspace, cx);
            assert_eq!(opened["composer"]["mentionCount"], json!(8));
            // The rows are the newest eight, so row zero is the first record.
            workspace.select_mention(0, window, cx);
            let selected = snapshot(workspace, cx);
            assert_eq!(
                selected["composer"]["text"],
                json!(format!("@{}", root.join("bounded-0.jsonl").display()))
            );
        })
        .expect("bounded workspace window");
}

/// A send the app cannot make leaves the attachment in place: the chip clears
/// only once the harness accepts the command, so a rejected send never costs
/// the user the file. No runtime runs here — the send is refused before it
/// leaves the app, through the same early return a rejected prompt takes.
#[cfg(unix)]
#[gpui_kit::test]
fn composer_attachment_survives_a_rejected_send(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    std::fs::create_dir_all(root.join("home")).expect("home");
    std::fs::create_dir_all(root.join("user-data")).expect("user-data");
    let png = root.join("dot.png");
    std::fs::write(&png, ONE_PIXEL_PNG).expect("png");

    let mut data = test_data(root);
    data.home_dir = root.join("home");
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.attach_image_from_path(&png, cx);
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| state.set_value("no runtime", window, cx));
            workspace.send_prompt(window, cx);
            let rejected = snapshot(workspace, cx);
            assert_eq!(
                rejected["composer"]["pendingImage"]["name"],
                json!("dot.png")
            );
            assert_eq!(rejected["running"], json!(false));
            // The draft survives with it, so the retry is one click.
            assert_eq!(rejected["composer"]["text"], "no runtime");
        })
        .expect("workspace window");
}

/// A stand-in `omp` for the model tests: the conformance fixture already
/// answers `models --json` with a catalog and logs every RPC command under the
/// state directory, so a selection can be proven to reach a live runtime.
#[cfg(unix)]
fn install_fixture_omp(root: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("bin");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
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
    fixture
}

/// A stand-in `omp` whose fork is cancelled: every command succeeds
/// generically (the handshake, `get_session_stats`), while `fork` answers
/// `{ cancelled: true }` the way the harness does when the user backs out.
/// The conformance fixture always forks, so this is the only way to prove a
/// cancelled fork moves nothing. Like the fixture, it logs every command under
/// the state directory.
#[cfg(unix)]
fn install_cancelling_fork_omp(root: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("bin");
    let script = bin.join("omp-cancelling-fork.mjs");
    std::fs::write(
        &script,
        r#"import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const stateDir = process.env.OMP_FIXTURE_STATE_DIR || ''
const log = (command) => {
  if (!stateDir) return
  mkdirSync(stateDir, { recursive: true })
  appendFileSync(join(stateDir, 'omp-commands.jsonl'), `${JSON.stringify(command)}\n`, 'utf8')
}
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })

createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) => {
  let command
  try {
    command = JSON.parse(line)
  } catch {
    return
  }
  log(command)
  const data = command.type === 'fork' ? { cancelled: true } : {}
  send({ id: command.id, type: 'response', command: command.type, success: true, data })
})
"#,
    )
    .expect("script");
    let omp = bin.join("omp-cancelling-fork");
    std::fs::write(
        &omp,
        format!(
            "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
            std::env::var("NODE").unwrap_or_else(|_| "node".to_string()),
            script.display()
        ),
    )
    .expect("omp");
    std::fs::set_permissions(&omp, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    omp
}

/// A catalog the Settings picker can list without spawning `omp`, and the
/// failing shape `load_catalog` reports (no models plus a warning).
fn model_catalog(
    models: &[(&str, &str, &str)],
    warning: Option<&str>,
) -> omp_core::models::ModelCatalog {
    omp_core::models::ModelCatalog {
        prime_version: "17.2.15".to_string(),
        refreshed_at: "2026-04-02T00:00:00.000Z".to_string(),
        models: models
            .iter()
            .map(|(provider, id, name)| omp_core::models::ModelDescriptor {
                key: format!("{provider}/{id}"),
                provider: provider.to_string(),
                id: id.to_string(),
                name: name.to_string(),
                reasoning: false,
                input: vec!["text".to_string()],
                context_window: 100_000,
                max_tokens: 8_192,
                available_thinking_levels: Vec::new(),
                fast_mode_supported: false,
                available: true,
            })
            .collect(),
        providers: Vec::new(),
        warning: warning.map(str::to_string),
        vision_delegation: None,
        presets: Vec::new(),
    }
}

/// The same catalog with its provider list filled in, so the Settings picker
/// has chips that carry a display name and the configured hint.
fn model_catalog_with_providers(
    models: &[(&str, &str, &str)],
    providers: &[(&str, &str, bool)],
) -> omp_core::models::ModelCatalog {
    let mut catalog = model_catalog(models, None);
    catalog.providers = providers
        .iter()
        .map(
            |(id, name, configured)| omp_core::models::ProviderDescriptor {
                id: id.to_string(),
                name: name.to_string(),
                auth_method: "oauth".to_string(),
                configured: *configured,
            },
        )
        .collect();
    catalog
}

/// The fixture's own record of the RPC commands it received.
#[cfg(unix)]
fn fixture_commands(root: &Path) -> Vec<Value> {
    let path = root
        .join("user-data")
        .join("fixture-state")
        .join("omp-commands.jsonl");
    let log = std::fs::read_to_string(path).unwrap_or_default();
    log.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// Selecting a model in Settings persists it, moves the composer footer, and
/// switches the live runtime; a catalog that cannot load is inline text that
/// leaves the selection usable.
#[cfg(unix)]
#[gpui_kit::test]
fn model_selection_persists_reaches_the_footer_and_the_runtime(cx: &mut TestAppContext) {
    use omp_core::projects;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    let fixture = install_fixture_omp(root);
    for folder in [&home, &project, &root.join("user-data")] {
        std::fs::create_dir_all(folder).expect("dir");
    }
    let project = project.canonicalize().expect("project path");

    let mut store = open_store(root);
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    drop(store);

    let bucket = home.join(".omp/agent/sessions/-omp-project");
    write_session(
        &bucket,
        "2026-04-02T00-00-00-000Z_019fdf24-eeee-7000-8000-000000000020.jsonl",
        "Models",
        "2026-04-02T00:00:00.000Z",
        "first prompt",
        "first reply",
        &project,
    );
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = fixture;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(900.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });
    let window: gpui_kit::AnyWindowHandle = handle.into();
    let handle = window.downcast::<Workspace>().expect("workspace handle");

    handle
        .update(cx, |workspace, _, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["liveVoice"]["runtime"], json!(true));

            // The catalog is cached, so opening Settings does not spawn
            // `omp models`; the picker lists what was injected.
            workspace.apply_model_catalog(model_catalog(
                &[
                    ("anthropic", "claude-fixture", "Claude Fixture"),
                    ("openai-codex", "gpt-5.4", "GPT-5.4 Fixture"),
                ],
                None,
            ));
            workspace.set_view(AppView::Settings, cx);

            let opened = snapshot(workspace, cx);
            assert_eq!(opened["view"], "settings");
            assert_eq!(
                opened["models"]["available"],
                json!(["anthropic/claude-fixture", "openai-codex/gpt-5.4"])
            );
            assert_eq!(opened["models"]["selected"], "");
            assert_eq!(opened["models"]["error"], json!(null));
            assert_eq!(opened["models"]["loading"], json!(false));
            assert_eq!(workspace.model_footer(), "Model: auto");

            workspace.select_model("openai-codex/gpt-5.4", cx);
            let selected = snapshot(workspace, cx);
            assert_eq!(selected["models"]["selected"], "openai-codex/gpt-5.4");
            assert_eq!(
                selected["settings"]["selectedModel"],
                "openai-codex/gpt-5.4"
            );
            // The fixture accepted the switch, so there is no status notice.
            assert_eq!(selected["models"]["status"], json!(null));
            assert_eq!(workspace.model_footer(), "Model: openai-codex/gpt-5.4");

            let commands = fixture_commands(root);
            let set_models: Vec<&Value> = commands
                .iter()
                .filter(|command| command["type"] == "set_model")
                .collect();
            assert_eq!(set_models.len(), 1, "one set_model reached the runtime");
            assert_eq!(set_models[0]["provider"], "openai-codex");
            assert_eq!(set_models[0]["modelId"], "gpt-5.4");

            // A catalog that cannot load is visible and does not disable the
            // selection: the persisted default is still applied and pushed.
            workspace.apply_model_catalog(model_catalog(&[], Some("OMP is not installed")));
            let failed = snapshot(workspace, cx);
            assert_eq!(failed["models"]["error"], "OMP is not installed");
            assert_eq!(failed["models"]["available"], json!([]));
            assert_eq!(
                failed["models"]["selected"], "openai-codex/gpt-5.4",
                "the current model survives a failed catalog"
            );

            workspace.select_model("anthropic/claude-fixture", cx);
            let switched = snapshot(workspace, cx);
            assert_eq!(switched["models"]["selected"], "anthropic/claude-fixture");
            assert_eq!(switched["models"]["status"], json!(null));
            assert_eq!(workspace.model_footer(), "Model: anthropic/claude-fixture");

            let commands = fixture_commands(root);
            let set_models: Vec<&Value> = commands
                .iter()
                .filter(|command| command["type"] == "set_model")
                .collect();
            assert_eq!(set_models.len(), 2, "the second switch also reached it");
            assert_eq!(set_models[1]["provider"], "anthropic");
            assert_eq!(set_models[1]["modelId"], "claude-fixture");
        })
        .expect("workspace window");

    // The Settings page draws the picker with the selection highlighted.
    draw_frame(cx, window);

    // The last choice is what the next window starts with.
    let store = open_store(root);
    assert_eq!(
        store.settings().last_selected_model(),
        "anthropic/claude-fixture"
    );
}

/// Without a runtime the selection is still persisted and shown in the footer;
/// a rejected key is not a selection at all.
#[gpui_kit::test]
fn model_selection_without_a_runtime_only_persists(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            // No catalog loaded yet: Settings shows the current model and the
            // load state instead of an empty page.
            workspace.set_view(AppView::Settings, cx);
            let loading = snapshot(workspace, cx);
            assert_eq!(loading["models"]["selected"], "");
            assert_eq!(loading["models"]["error"], json!(null));
            assert_eq!(loading["models"]["available"], json!([]));

            workspace.select_model("local/plain-model", cx);
            let selected = snapshot(workspace, cx);
            assert_eq!(selected["models"]["selected"], "local/plain-model");
            assert_eq!(selected["settings"]["selectedModel"], "local/plain-model");
            // No runtime is live, so nothing was rejected and nothing sent.
            assert_eq!(selected["models"]["status"], json!(null));
            assert_eq!(workspace.model_footer(), "Model: local/plain-model");

            // A key with no id (or no provider) is not a selection.
            workspace.select_model("local", cx);
            workspace.select_model("", cx);
            assert_eq!(
                snapshot(workspace, cx)["models"]["selected"],
                "local/plain-model"
            );
        })
        .expect("workspace window");

    let store = open_store(root);
    assert_eq!(store.settings().last_selected_model(), "local/plain-model");
}

/// The provider chips narrow the Settings model list without touching the
/// persisted selection: a chip lists only its own models while the current
/// model stays selected, choosing one of them persists it, `All` brings every
/// provider back, and a catalog load opens on the current model's provider.
#[gpui_kit::test]
fn model_provider_filter_narrows_the_picker_and_keeps_the_selection(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let catalog = || {
        model_catalog_with_providers(
            &[
                ("alpha", "a1", "Alpha One"),
                ("alpha", "a2", "Alpha Two"),
                ("beta", "b1", "Beta One"),
                ("beta", "b2", "Beta Two"),
            ],
            &[("alpha", "Alpha", true), ("beta", "Beta", false)],
        )
    };
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, test_data(root)));
    handle
        .update(cx, |workspace, _, cx| {
            // Caching the catalog first keeps `set_view` from spawning the
            // harness: the parity suite never runs a real `omp`.
            workspace.apply_model_catalog(catalog());
            workspace.set_view(AppView::Settings, cx);

            let opened = snapshot(workspace, cx);
            assert_eq!(opened["models"]["providerFilter"], json!(null));
            assert_eq!(
                opened["models"]["providers"],
                json!([
                    { "id": "alpha", "name": "Alpha", "configured": true },
                    { "id": "beta", "name": "Beta", "configured": false },
                ]),
                "the chips name the providers and their configured state"
            );
            assert_eq!(
                opened["models"]["available"],
                json!(["alpha/a1", "alpha/a2", "beta/b1", "beta/b2"]),
                "All is the default when no model is selected"
            );

            workspace.select_model("alpha/a1", cx);
            assert_eq!(workspace.model_footer(), "Model: alpha/a1");

            // A chip lists only its own models. The current model is another
            // provider's, so it stays selected but leaves the list; the
            // current-model row is what still shows it.
            workspace.select_provider_filter(Some("beta"), cx);
            let filtered = snapshot(workspace, cx);
            assert_eq!(filtered["models"]["providerFilter"], "beta");
            assert_eq!(
                filtered["models"]["available"],
                json!(["beta/b1", "beta/b2"])
            );
            assert_eq!(filtered["models"]["selected"], "alpha/a1");
            assert_eq!(filtered["settings"]["selectedModel"], "alpha/a1");

            // Selecting within the chip persists the new choice and keeps the
            // chip active.
            workspace.select_model("beta/b1", cx);
            let switched = snapshot(workspace, cx);
            assert_eq!(switched["models"]["providerFilter"], "beta");
            assert_eq!(
                switched["models"]["available"],
                json!(["beta/b1", "beta/b2"])
            );
            assert_eq!(switched["models"]["selected"], "beta/b1");
            assert_eq!(switched["settings"]["selectedModel"], "beta/b1");
            assert_eq!(workspace.model_footer(), "Model: beta/b1");

            workspace.select_provider_filter(None, cx);
            let all = snapshot(workspace, cx);
            assert_eq!(all["models"]["providerFilter"], json!(null));
            assert_eq!(
                all["models"]["available"],
                json!(["alpha/a1", "alpha/a2", "beta/b1", "beta/b2"]),
                "All lists every provider again"
            );
            assert_eq!(all["models"]["selected"], "beta/b1");

            // A reload opens on the current model's provider.
            workspace.apply_model_catalog(catalog());
            let reloaded = snapshot(workspace, cx);
            assert_eq!(reloaded["models"]["providerFilter"], "beta");
            assert_eq!(
                reloaded["models"]["available"],
                json!(["beta/b1", "beta/b2"])
            );
            assert_eq!(reloaded["models"]["selected"], "beta/b1");
        })
        .expect("workspace window");

    // Drawing proves the chip row builds with the catalog's providers.
    draw_frame(cx, handle.into());

    let store = open_store(root);
    assert_eq!(store.settings().last_selected_model(), "beta/b1");
}

/// Opening Settings is what loads the catalog, and the load is cached: the
/// picker fills from the harness on the frame after the click, and a second
/// visit reuses the list instead of spawning `omp models` again.
#[cfg(unix)]
#[gpui_kit::test]
fn settings_loads_the_model_catalog_once_and_caches_it(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    std::fs::create_dir_all(&home).expect("home");
    std::fs::create_dir_all(root.join("user-data")).expect("user data");
    let fixture = install_fixture_omp(root);

    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = fixture;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));

    handle
        .update(cx, |workspace, _, cx| {
            // The view opens with the current model and a load in flight; the
            // harness is never spawned on the click itself.
            workspace.set_view(AppView::Settings, cx);
            let opening = snapshot(workspace, cx);
            assert_eq!(opening["view"], "settings");
            assert_eq!(opening["models"]["loading"], json!(true));
            assert_eq!(opening["models"]["available"], json!([]));
        })
        .expect("settings view");

    cx.run_until_parked();

    handle
        .update(cx, |workspace, _, cx| {
            let loaded = snapshot(workspace, cx);
            assert_eq!(loaded["models"]["loading"], json!(false));
            assert_eq!(loaded["models"]["error"], json!(null));
            assert_eq!(
                loaded["models"]["available"],
                json!([
                    "anthropic/claude-fixture",
                    "openai-codex/gpt-5.4",
                    "local/plain-model",
                ]),
                "the picker lists the harness catalog, minus its malformed entry"
            );
        })
        .expect("loaded settings");

    // Leaving and reopening Settings keeps the cached list: no second load.
    handle
        .update(cx, |workspace, _, cx| {
            workspace.set_view(AppView::Workspace, cx);
            workspace.set_view(AppView::Settings, cx);
            let reopened = snapshot(workspace, cx);
            assert_eq!(reopened["models"]["loading"], json!(false));
            assert_eq!(
                reopened["models"]["available"],
                json!([
                    "anthropic/claude-fixture",
                    "openai-codex/gpt-5.4",
                    "local/plain-model",
                ])
            );
        })
        .expect("reopened settings");
}

/// Forking through the session menu sends exactly one `fork` to the live
/// harness and reports it in the composer banner. The fixture answers without
/// writing a file, so the catalog cannot grow and the selection, transcript and
/// draft stay put; a file written out of band is the fork the refresh then
/// finds and selects.
#[cfg(unix)]
#[gpui_kit::test]
fn session_menu_fork_sends_one_command_and_follows_the_refresh(cx: &mut TestAppContext) {
    use omp_core::projects;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    let fixture = install_fixture_omp(root);
    for folder in [&home, &project, &root.join("user-data")] {
        std::fs::create_dir_all(folder).expect("dir");
    }
    let project = project.canonicalize().expect("project path");

    let mut store = open_store(root);
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    drop(store);

    let bucket = home.join(".omp/agent/sessions/-omp-project");
    write_session(
        &bucket,
        "2026-04-03T00-00-00-000Z_019fdf24-ffff-7000-8000-000000000030.jsonl",
        "Forked",
        "2026-04-03T00:00:00.000Z",
        "fork prompt",
        "fork reply",
        &project,
    );
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home.clone();
    data.omp_executable = fixture;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["liveVoice"]["runtime"], json!(true));

            // The menu draws the same list the snapshot reports, so the action
            // is proven present without measuring the popover.
            let menu = snapshot(workspace, cx)["sessionMenu"].clone();
            assert_eq!(
                menu["actions"],
                json!([
                    "Rename",
                    "Pin",
                    "Archive",
                    "Delete",
                    "Fork session",
                    "Remote Control",
                ])
            );

            // A draft is the composer's, not the session's: a fork keeps it.
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| {
                state.set_value("draft after fork", window, cx);
            });

            workspace.session_menu_action("Fork session", cx);
            let forked = snapshot(workspace, cx);
            assert_eq!(forked["forkStatus"], "Forked session");
            // The fixture wrote no file, so the catalog did not change and the
            // current session keeps its transcript and its selection.
            assert_eq!(forked["selectedSession"], json!(0));
            assert_eq!(forked["sessions"].as_array().map(Vec::len), Some(1));
            assert_eq!(transcript_text(workspace), ["fork prompt", "fork reply"]);
            assert_eq!(forked["composer"]["text"], "draft after fork");

            let commands = fixture_commands(root);
            let forks: Vec<&Value> = commands
                .iter()
                .filter(|command| command["type"] == "fork")
                .collect();
            assert_eq!(forks.len(), 1, "one fork reached the runtime");
            assert_eq!(
                forks[0].get("entryId"),
                None,
                "a whole-session fork sends no entryId"
            );

            // A fork the harness does write: the refresh finds the new file,
            // selects it as the newest row and reads its transcript.
            let fork_file = write_session(
                &bucket,
                "2026-04-04T00-00-00-000Z_019fdf24-ffff-7000-8000-000000000031.jsonl",
                "Fork",
                "2026-04-04T00:00:00.000Z",
                "continued in the fork",
                "fork continuation",
                &project,
            );
            assert!(fork_file.exists(), "the out-of-band fork file");

            workspace.session_menu_action("Fork session", cx);
            let continued = snapshot(workspace, cx);
            assert_eq!(continued["forkStatus"], "Forked session");
            assert_eq!(continued["sessions"][0]["title"], "Fork");
            assert_eq!(continued["sessions"].as_array().map(Vec::len), Some(2));
            assert_eq!(continued["selectedSession"], json!(0));
            assert_eq!(
                transcript_text(workspace),
                ["continued in the fork", "fork continuation"]
            );
            assert_eq!(continued["composer"]["text"], "draft after fork");

            let commands = fixture_commands(root);
            let forks: Vec<&Value> = commands
                .iter()
                .filter(|command| command["type"] == "fork")
                .collect();
            assert_eq!(forks.len(), 2, "each action sent its own fork");
        })
        .expect("workspace window");
}

/// A cancelled fork is the user's own "no": the command went out exactly once
/// and nothing else moved — no notice, no catalog refresh that drops the
/// transcript, no selection change.
#[cfg(unix)]
#[gpui_kit::test]
fn cancelled_fork_changes_nothing(cx: &mut TestAppContext) {
    use omp_core::projects;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    let fake = install_cancelling_fork_omp(root);
    for folder in [&home, &project, &root.join("user-data")] {
        std::fs::create_dir_all(folder).expect("dir");
    }
    let project = project.canonicalize().expect("project path");

    let mut store = open_store(root);
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    drop(store);

    let bucket = home.join(".omp/agent/sessions/-omp-project");
    write_session(
        &bucket,
        "2026-04-05T00-00-00-000Z_019fdf24-ffff-7000-8000-000000000040.jsonl",
        "Cancelled",
        "2026-04-05T00:00:00.000Z",
        "cancel prompt",
        "cancel reply",
        &project,
    );
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = fake;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["liveVoice"]["runtime"], json!(true));
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| {
                state.set_value("draft across a cancel", window, cx);
            });
            let before = snapshot(workspace, cx);

            workspace.session_menu_action("Fork session", cx);
            let after = snapshot(workspace, cx);
            assert_eq!(after["forkStatus"], json!(null), "a cancel claims nothing");
            assert_eq!(after["selectedSession"], before["selectedSession"]);
            assert_eq!(after["sessions"], before["sessions"]);
            assert_eq!(after["transcript"], before["transcript"]);
            assert_eq!(after["composer"]["text"], "draft across a cancel");
            assert_eq!(
                transcript_text(workspace),
                ["cancel prompt", "cancel reply"]
            );

            let commands = fixture_commands(root);
            let forks: Vec<&Value> = commands
                .iter()
                .filter(|command| command["type"] == "fork")
                .collect();
            assert_eq!(forks.len(), 1, "the fork was sent exactly once");
        })
        .expect("workspace window");
}

/// A transcript row can be forked from: the action sends one `fork` carrying
/// that message's id, so the harness continues the new session at the row
/// instead of the end of the session, and the whole-session shape is never
/// sent. Rows the view minted itself have no harness entry, so asking to fork
/// one reaches the runtime with nothing.
#[cfg(unix)]
#[gpui_kit::test]
fn message_fork_sends_the_entry_id_and_keeps_the_session_fork(cx: &mut TestAppContext) {
    use omp_core::projects;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    let fixture = install_fixture_omp(root);
    for folder in [&home, &project, &root.join("user-data")] {
        std::fs::create_dir_all(folder).expect("dir");
    }
    let project = project.canonicalize().expect("project path");

    let mut store = open_store(root);
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    drop(store);

    // `write_session` seeds the harness ids `u1` and `a1`, which is what a
    // real session file carries on its message rows.
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    write_session(
        &bucket,
        "2026-04-06T00-00-00-000Z_019fdf24-ffff-7000-8000-000000000050.jsonl",
        "Entry fork",
        "2026-04-06T00:00:00.000Z",
        "fork from this prompt",
        "fork from this reply",
        &project,
    );
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = fixture;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["liveVoice"]["runtime"], json!(true));
            let ids: Vec<String> = workspace
                .transcript_messages()
                .iter()
                .map(|message| message.id.clone())
                .collect();
            assert_eq!(ids, ["u1", "a1"], "the rows carry the harness ids");

            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| {
                state.set_value("draft across an entry fork", window, cx);
            });

            workspace.fork_from_message("u1", cx);
            let forked = snapshot(workspace, cx);
            assert_eq!(forked["forkStatus"], "Forked session");
            // The fixture wrote no file, so the fork changes nothing else.
            assert_eq!(forked["selectedSession"], json!(0));
            assert_eq!(forked["sessions"].as_array().map(Vec::len), Some(1));
            assert_eq!(
                transcript_text(workspace),
                ["fork from this prompt", "fork from this reply"]
            );
            assert_eq!(forked["composer"]["text"], "draft across an entry fork");

            let forks = |root: &Path| -> Vec<Value> {
                fixture_commands(root)
                    .into_iter()
                    .filter(|command| command["type"] == "fork")
                    .collect()
            };
            let sent = forks(root);
            assert_eq!(sent.len(), 1, "one fork reached the runtime");
            assert_eq!(
                sent[0]["entryId"],
                json!("u1"),
                "an entry fork names the message it continues from"
            );

            // A row the view minted itself has no entry: the action refuses it
            // before the runtime hears anything.
            workspace.fork_from_message("queued-7", cx);
            workspace.fork_from_message("", cx);
            assert_eq!(forks(root).len(), 1, "no fork left for a local row");
        })
        .expect("workspace window");
}

/// A cancelled entry fork is the same silent no-op as a cancelled session
/// fork: the command went out once with its `entryId`, and no notice, refresh
/// or selection follows it.
#[cfg(unix)]
#[gpui_kit::test]
fn cancelled_message_fork_changes_nothing(cx: &mut TestAppContext) {
    use omp_core::projects;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let project = root.join("project");
    let fake = install_cancelling_fork_omp(root);
    for folder in [&home, &project, &root.join("user-data")] {
        std::fs::create_dir_all(folder).expect("dir");
    }
    let project = project.canonicalize().expect("project path");

    let mut store = open_store(root);
    projects::grant_project(
        &mut store,
        &home,
        Platform::current(),
        project.to_str().expect("project path"),
    )
    .expect("grant");
    drop(store);

    let bucket = home.join(".omp/agent/sessions/-omp-project");
    write_session(
        &bucket,
        "2026-04-07T00-00-00-000Z_019fdf24-ffff-7000-8000-000000000060.jsonl",
        "Cancelled entry",
        "2026-04-07T00:00:00.000Z",
        "entry cancel prompt",
        "entry cancel reply",
        &project,
    );
    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);

    let mut data = test_data(root);
    data.home_dir = home;
    data.omp_executable = fake;
    data.sessions = catalog;
    let handle = cx.add_window(|window, cx| Workspace::new(window, cx, data));
    handle
        .update(cx, |workspace, window, cx| {
            workspace.select_session(0, cx);
            assert_eq!(snapshot(workspace, cx)["liveVoice"]["runtime"], json!(true));
            let composer = workspace.composer_entity().clone();
            composer.update(cx, |state, cx| {
                state.set_value("draft across an entry cancel", window, cx);
            });
            let before = snapshot(workspace, cx);

            workspace.fork_from_message("a1", cx);
            let after = snapshot(workspace, cx);
            assert_eq!(after["forkStatus"], json!(null), "a cancel claims nothing");
            assert_eq!(after["selectedSession"], before["selectedSession"]);
            assert_eq!(after["sessions"], before["sessions"]);
            assert_eq!(after["transcript"], before["transcript"]);
            assert_eq!(after["composer"]["text"], "draft across an entry cancel");
            assert_eq!(
                transcript_text(workspace),
                ["entry cancel prompt", "entry cancel reply"]
            );

            let forks: Vec<Value> = fixture_commands(root)
                .into_iter()
                .filter(|command| command["type"] == "fork")
                .collect();
            assert_eq!(forks.len(), 1, "the entry fork was sent exactly once");
            assert_eq!(forks[0]["entryId"], json!("a1"));
        })
        .expect("workspace window");
}

/// The Electron harness appends to the session JSONL from its own process, so
/// the view polls the selected file: a valid append shows up on the next tick
/// of its timer without a manual reload, a reader who scrolled up keeps their
/// place, and an unreadable write is reported only once it persists and then
/// recovers.
#[gpui_kit::test]
fn external_session_writes_reload_on_the_next_check(cx: &mut TestAppContext) {
    use gpui_kit::{InputEvent as _, ScrollDelta, ScrollEvent, ScrollSource, TouchPhase};
    use std::io::Write as _;

    cx.update(gpui_kit::init);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let root = dir.path();
    let home = root.join("home");
    let bucket = home.join(".omp/agent/sessions/-omp-project");
    let project = root.join("project");
    let at = "2026-04-01T01:00:00.000Z";
    // Enough rows to overflow the transcript, so the follow state is real.
    let entries: Vec<Value> = (0..40)
        .map(|index| {
            json!({
                "type": "message",
                "id": format!("u{index}"),
                "parentId": null,
                "timestamp": at,
                "message": {
                    "role": "user",
                    "content": format!("message {index} {}", "padding ".repeat(24)),
                },
            })
        })
        .collect();
    let path = write_session_entries(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-f444-7000-8000-000000000014.jsonl",
        "Live",
        at,
        &entries,
        &project,
    );

    let store = open_store(root);
    let catalog = omp_core::sessions::list_sessions(&store, &home, false, None);
    drop(store);
    assert_eq!(catalog.len(), 1);

    let mut data = test_data(root);
    data.home_dir = home;
    data.sessions = catalog;
    let handle = cx.open_window(size(px(1280.0), px(800.0)), |window, cx| {
        Workspace::new(window, cx, data)
    });

    // Nothing is selected, so a check has no file to watch and reads nothing.
    handle
        .update(cx, |workspace, _, cx| {
            workspace.check_transcript_external_change(cx);
            let state = snapshot(workspace, cx);
            assert_eq!(state["transcriptReloads"], json!(0));
            assert!(workspace.transcript_messages().is_empty());
        })
        .expect("unselected check");

    // Selecting the session reads it and pins the view to its newest row.
    handle
        .update(cx, |workspace, _, cx| workspace.select_session(0, cx))
        .expect("select session");
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("transcript frame");
    });
    let state = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("selected snapshot");
    assert_eq!(state["transcript"].as_array().map(Vec::len), Some(40));
    assert_eq!(state["transcriptAtBottom"], json!(true));
    assert_eq!(state["transcriptReloads"], json!(0));
    assert!(
        state["transcriptMtime"].is_number(),
        "the watched file reports its modified time"
    );

    // A valid append from another process lands on the next check, and the
    // pinned view follows it.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open session file");
    file.write_all(
        format!(
            "{}\n",
            json!({
                "type": "message",
                "id": "u-ext-1",
                "parentId": null,
                "timestamp": at,
                "message": { "role": "user", "content": "written by another process" },
            })
        )
        .as_bytes(),
    )
    .expect("append entry");
    drop(file);
    // The periodic watcher is what picks it up: no check is called by hand.
    cx.executor().advance_clock(Duration::from_secs(3));
    cx.run_until_parked();
    let state = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("reloaded snapshot");
    assert_eq!(state["transcript"].as_array().map(Vec::len), Some(41));
    assert_eq!(state["transcriptReloads"], json!(1));
    assert_eq!(state["transcriptAtBottom"], json!(true));
    assert_eq!(
        state["transcript"][40]["parts"][0]["text"],
        json!("written by another process")
    );

    // A reader who scrolled up keeps their place across the next append.
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.dispatch_event(
                ScrollEvent {
                    position: point(px(600.0), px(400.0)),
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
    cx.update(|cx| {
        cx.update_window(handle.into(), |_, window, cx| {
            window.render_frame(cx);
        })
        .expect("scrolled frame");
    });
    let state = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("scrolled snapshot");
    assert_eq!(state["transcriptAtBottom"], json!(false));

    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open session file");
    file.write_all(
        format!(
            "{}\n",
            json!({
                "type": "message",
                "id": "u-ext-2",
                "parentId": null,
                "timestamp": at,
                "message": { "role": "user", "content": "second external message" },
            })
        )
        .as_bytes(),
    )
    .expect("append entry");
    drop(file);
    let state = handle
        .update(cx, |workspace, _, cx| {
            workspace.check_transcript_external_change(cx);
            snapshot(workspace, cx)
        })
        .expect("unpinned snapshot");
    assert_eq!(state["transcript"].as_array().map(Vec::len), Some(42));
    assert_eq!(state["transcriptReloads"], json!(2));
    assert_eq!(state["transcriptAtBottom"], json!(false));
    assert_eq!(
        state["transcript"][41]["parts"][0]["text"],
        json!("second external message")
    );

    // A write that is not valid UTF-8 cannot be read. One failed check is a
    // file still being written and is not reported; the same state twice is a
    // failure the pane names, and the rows already on screen stay.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open session file");
    file.write_all(&[0xff, 0xfe]).expect("invalid bytes");
    drop(file);
    let (first, second) = handle
        .update(cx, |workspace, _, cx| {
            workspace.check_transcript_external_change(cx);
            let first = workspace.transcript_error().map(str::to_string);
            workspace.check_transcript_external_change(cx);
            (first, workspace.transcript_error().map(str::to_string))
        })
        .expect("failed checks");
    assert_eq!(first, None, "one unreadable write is not reported");
    let error = second.expect("a persistent read failure is reported");
    assert!(
        error.contains("Could not read the session file"),
        "error: {error}"
    );
    let state = handle
        .update(cx, |workspace, _, cx| snapshot(workspace, cx))
        .expect("failed snapshot");
    assert_eq!(state["transcript"].as_array().map(Vec::len), Some(42));
    assert_eq!(state["transcriptReloads"], json!(2));

    // Rewriting the file with valid entries recovers the view, still unpinned.
    let mut recovered: Vec<Value> = entries.clone();
    for (id, text) in [
        ("u-ext-1", "written by another process"),
        ("u-ext-2", "second external message"),
    ] {
        recovered.push(json!({
            "type": "message",
            "id": id,
            "parentId": null,
            "timestamp": at,
            "message": { "role": "user", "content": text },
        }));
    }
    write_session_entries(
        &bucket,
        "2026-04-01T00-00-00-000Z_019fdf24-f444-7000-8000-000000000014.jsonl",
        "Live",
        at,
        &recovered,
        &project,
    );
    let state = handle
        .update(cx, |workspace, _, cx| {
            workspace.check_transcript_external_change(cx);
            snapshot(workspace, cx)
        })
        .expect("recovered snapshot");
    assert_eq!(state["transcript"].as_array().map(Vec::len), Some(42));
    assert_eq!(state["transcriptReloads"], json!(3));
    assert_eq!(state["transcriptAtBottom"], json!(false));
    assert_eq!(
        handle
            .update(cx, |workspace, _, _| {
                workspace.transcript_error().map(str::to_string)
            })
            .expect("recovered error"),
        None
    );
}
