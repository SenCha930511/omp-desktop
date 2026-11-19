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

use gpui_kit::AppContext as _;
use gpui_kit::MouseButton;
use gpui_kit::TestAppContext;
use gpui_kit::point;
use gpui_kit::px;
use gpui_kit::size;
use gpui_kit::test::TestEventExt as _;
use omp_core::geometry::UiGeometry;
use omp_core::settings::{AppSettings, ConversationDensity, Theme};
use omp_core::state::{CURRENT_DESKTOP_STATE_FILENAME, Platform, StateStore};
use omp_desktop::app::{AppView, Workspace, WorkspaceData};
use serde_json::json;
use std::path::{Path, PathBuf};

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
    assert_eq!(catalog[0].file_path, newer.display().to_string());
    assert_eq!(catalog[1].file_path, older.display().to_string());

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
    assert_eq!(records[1].file_path, older.display().to_string());
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
        .find(|record| record.file_path == older.display().to_string())
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
/// The pane selector is not part of the public `Workspace` API, and gpui-kit only
/// addresses elements that opt into `.test_support()`, so the launcher row is
/// clicked at its measured window-local position in a 1280x800 window: the rows
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
    const BELOW_LAUNCHER_Y: f32 = 300.0;

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
        "the launcher ends above y=300 in a 1280x800 window"
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
