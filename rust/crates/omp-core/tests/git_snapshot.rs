use std::fs;
use std::process::Command;

use omp_core::git;
use omp_core::projects;
use omp_core::state::{CURRENT_DESKTOP_STATE_FILENAME, Platform, StateStore};
use omp_core::turn_changes::{TurnBaseline, compute_turn_changes};
use tempfile::TempDir;

fn run_git(repo: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git");
    assert!(status.success(), "git {args:?} failed");
}

#[test]
fn turn_baseline_uses_real_git_numstat() {
    let temp = TempDir::new().expect("temp");
    let home = temp.path().join("home");
    let user_data = temp.path().join("user-data");
    let repo = temp.path().join("repo");
    fs::create_dir_all(&home).expect("home");
    fs::create_dir_all(&user_data).expect("user data");
    fs::create_dir_all(&repo).expect("repo");
    run_git(&repo, &["init", "-q", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "OMP Test"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    fs::write(repo.join("a.txt"), "line1\n").expect("seed");
    run_git(&repo, &["add", "a.txt"]);
    run_git(&repo, &["commit", "-qm", "initial"]);

    let mut store = StateStore::open(
        user_data.join(CURRENT_DESKTOP_STATE_FILENAME),
        None,
        Platform::Linux,
    )
    .expect("store");
    projects::grant_project(&mut store, &home, Platform::Linux, repo.to_str().unwrap())
        .expect("grant");

    fs::write(repo.join("a.txt"), "line1\nline2\n").expect("edit");
    let baseline_files = git::snapshot_files(&store, Platform::Linux, repo.to_str().unwrap());
    assert_eq!(baseline_files.len(), 1);
    assert_eq!(baseline_files[0].path, "a.txt");
    assert_eq!(baseline_files[0].additions, 1);
    let baseline = TurnBaseline::capture(baseline_files);

    fs::write(repo.join("a.txt"), "line1\nline2\nline3\n").expect("edit again");
    let after = git::snapshot_files(&store, Platform::Linux, repo.to_str().unwrap());
    let changes = compute_turn_changes(&baseline, after);
    assert_eq!(changes.files.len(), 1);
    assert_eq!(changes.files[0].path, "a.txt");
    assert_eq!(changes.files[0].additions, 1);
    assert_eq!(changes.additions, 1);
}

#[test]
fn remove_untracked_only_deletes_the_named_repository_file() {
    let temp = TempDir::new().expect("temp");
    let home = temp.path().join("home");
    let user_data = temp.path().join("user-data");
    let repo = temp.path().join("repo");
    fs::create_dir_all(&home).expect("home");
    fs::create_dir_all(&user_data).expect("user data");
    fs::create_dir_all(&repo).expect("repo");
    run_git(&repo, &["init", "-q", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "OMP Test"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    fs::write(repo.join("tracked.txt"), "committed\n").expect("seed");
    run_git(&repo, &["add", "tracked.txt"]);
    run_git(&repo, &["commit", "-qm", "initial"]);

    let mut store = StateStore::open(
        user_data.join(CURRENT_DESKTOP_STATE_FILENAME),
        None,
        Platform::Linux,
    )
    .expect("store");
    projects::grant_project(&mut store, &home, Platform::Linux, repo.to_str().unwrap())
        .expect("grant");

    fs::write(repo.join("tracked.txt"), "keep dirty edits\n").expect("dirty");
    let created = repo.join("nested/new.txt");
    fs::create_dir_all(created.parent().expect("nested dir")).expect("nested");
    fs::write(&created, "created this turn\n").expect("new file");
    let removed = git::remove_untracked(
        &store,
        Platform::Linux,
        repo.to_str().unwrap(),
        "nested/new.txt",
    )
    .expect("remove untracked");
    assert!(removed);
    assert!(!created.exists());
    assert_eq!(
        fs::read_to_string(repo.join("tracked.txt")).expect("dirty content"),
        "keep dirty edits\n"
    );

    let outside = temp.path().join("outside.txt");
    fs::write(&outside, "untouched\n").expect("outside file");
    assert!(
        git::remove_untracked(
            &store,
            Platform::Linux,
            repo.to_str().unwrap(),
            "../outside.txt"
        )
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(outside).expect("outside content"),
        "untouched\n"
    );
}
