use std::fs;
use std::os::unix::fs::symlink;

use omp_core::plugins;
use omp_core::projects;
use omp_core::state::{CURRENT_DESKTOP_STATE_FILENAME, Platform, StateStore};
use serde_json::json;
use tempfile::TempDir;

fn store_for(temp: &TempDir, project: &std::path::Path) -> (StateStore, std::path::PathBuf) {
    let home = temp.path().join("home");
    let user_data = temp.path().join("user-data");
    fs::create_dir_all(&home).expect("home");
    let mut store = StateStore::open(
        user_data.join(CURRENT_DESKTOP_STATE_FILENAME),
        None,
        Platform::Linux,
    )
    .expect("store");
    projects::grant_project(
        &mut store,
        &home,
        Platform::Linux,
        project.to_str().unwrap(),
    )
    .expect("grant");
    (store, home.join(".omp").join("agent"))
}

#[test]
fn refuses_to_write_through_a_symlinked_project_config_directory() {
    let temp = TempDir::new().expect("temp");
    let project = temp.path().join("project");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&project).expect("project");
    fs::create_dir_all(&outside).expect("outside");
    symlink(&outside, project.join(".omp")).expect("symlink");
    let (store, agent_dir) = store_for(&temp, &project);
    let result = plugins::connect_mcp(
        &agent_dir,
        &store,
        Platform::Linux,
        &json!({ "name": "escape", "scope": "project", "projectPath": project, "type": "stdio", "command": "npx" }),
    );
    assert!(result.is_err(), "result: {result:?}");
    assert!(!outside.join("mcp.json").exists());
}

#[test]
fn refuses_to_overwrite_malformed_mcp_state() {
    let temp = TempDir::new().expect("temp");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).expect("project");
    let (store, agent_dir) = store_for(&temp, &project);
    fs::create_dir_all(&agent_dir).expect("agent");
    fs::write(agent_dir.join("mcp.json"), "{broken").expect("malformed");
    let result = plugins::set_mcp_enabled(
        &agent_dir,
        &store,
        Platform::Linux,
        &json!({ "name": "local", "scope": "user", "enabled": true }),
    );
    assert!(result.is_err());
    assert_eq!(
        fs::read_to_string(agent_dir.join("mcp.json")).expect("read"),
        "{broken"
    );
}

#[test]
fn create_mode_rejects_an_existing_server() {
    let temp = TempDir::new().expect("temp");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).expect("project");
    let (store, agent_dir) = store_for(&temp, &project);
    plugins::connect_mcp(
        &agent_dir,
        &store,
        Platform::Linux,
        &json!({ "name": "local", "scope": "user", "type": "stdio", "command": "npx" }),
    )
    .expect("first create");
    let result = plugins::connect_mcp(
        &agent_dir,
        &store,
        Platform::Linux,
        &json!({ "name": "local", "scope": "user", "type": "stdio", "command": "npx" }),
    );
    assert!(result.is_err());
}

#[test]
fn rejects_lookalike_loopback_mcp_hosts() {
    let temp = TempDir::new().expect("temp");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).expect("project");
    let (store, agent_dir) = store_for(&temp, &project);
    let result = plugins::connect_mcp(
        &agent_dir,
        &store,
        Platform::Linux,
        &json!({
            "name": "lookalike",
            "scope": "user",
            "type": "http",
            "url": "http://127.0.0.1.evil.example/mcp",
            "allowInsecureHttp": true
        }),
    );
    assert!(result.is_err());
}
