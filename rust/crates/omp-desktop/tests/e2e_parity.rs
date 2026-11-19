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
use gpui_kit::Context;
use gpui_kit::Focusable as _;
use gpui_kit::MouseButton;
use gpui_kit::TestAppContext;
use gpui_kit::point;
use gpui_kit::px;
use gpui_kit::size;
use gpui_kit::test::TestEventExt as _;
use omp_core::geometry::{CENTER_MIN_WIDTH, UiGeometry};
use omp_core::settings::{AppSettings, ConversationDensity, MessageEnterAction, Theme};
use omp_core::state::{CURRENT_DESKTOP_STATE_FILENAME, Platform, StateStore};
use omp_core::turn_changes::{TurnBaseline, compute_turn_changes};
use omp_desktop::app::{AppView, Workspace, WorkspaceData};
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
            assert_eq!(layout["rightPaneWidth"].as_f64(), Some(360.0));
            assert_eq!(layout["centerWidth"].as_f64(), Some(672.0));
            assert_eq!(layout["overlay"], json!(null));
        })
        .expect("workspace window");
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

/// The terminal panel opens and closes from the toolbar without a shell.
///
/// `set_right_pane("terminal")` opens the panel; the only close control is the
/// toolbar's terminal icon, which is not registered with gpui-kit, so it is
/// clicked at its measured window-local position in a 1280x800 window. The
/// center column starts after the 248px sidebar and ends 12px before the right
/// pane; five 28px icons sit on an 8px gap, so `terminal-panel` (second from the
/// left) centres on x=786, y=22.
#[gpui_kit::test]
fn terminal_panel_opens_and_closes_without_spawning_a_shell(cx: &mut TestAppContext) {
    const TERMINAL_ICON_X: f32 = 786.0;
    const TOOLBAR_Y: f32 = 22.0;

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

    click_at(cx, handle, TERMINAL_ICON_X, TOOLBAR_Y);

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
            assert_eq!(layout["rightPaneWidth"].as_f64(), Some(360.0));
            // 1440 - 248 - 360 leaves the center the rest of the window.
            assert_eq!(layout["centerWidth"].as_f64(), Some(832.0));
            assert_eq!(layout["overlay"], json!(null));

            let resolved = workspace.layout();
            assert!(resolved.sidebar_docked);
            assert!(resolved.right_pane_docked);
            assert_eq!(resolved.sidebar_width, 248.0);
            assert_eq!(resolved.right_pane_width, 360.0);
            assert_eq!(resolved.center_width, 832.0);
        })
        .expect("wide window");
}

/// The Browser pane starts with no tabs, prepares one blank tab when opened,
/// and keeps that tab active across a pane round trip.
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
