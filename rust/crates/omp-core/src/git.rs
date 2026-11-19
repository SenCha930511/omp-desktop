use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::projects::{self, authorize_path};
use crate::settings::CheckoutStrategy;
use crate::state::{Platform, StateStore};
use crate::turn_changes::FileSnapshot;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub files: Vec<GitFileStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutcome {
    pub ok: bool,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutEntry {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutCatalog {
    pub strategy: String,
    pub active_name: String,
    pub checkouts: Vec<CheckoutEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutOutcome {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<ProcessOutcome> {
    let hooks_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let output = Command::new("git")
        .args([
            "--no-pager",
            "-c",
            &format!("core.hooksPath={hooks_path}"),
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.external=",
            "-c",
            "core.pager=cat",
            "-c",
            "protocol.ext.allow=never",
        ])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|error| CoreError::io("Could not run git", error))?;
    Ok(ProcessOutcome {
        ok: output.status.success(),
        output: format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        reason: (!output.status.success())
            .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
    })
}

pub fn authorize(store: &StateStore, platform: Platform, cwd: &str) -> Result<PathBuf> {
    projects::authorize_path(store, Path::new(cwd), platform)
}

pub fn status(store: &StateStore, platform: Platform, cwd: &str) -> GitStatus {
    let Ok(cwd) = authorize(store, platform, cwd) else {
        return GitStatus {
            is_repo: false,
            branch: None,
            files: Vec::new(),
            error: Some("Repository is not inside a granted project".to_string()),
        };
    };
    let outcome = match run_git(&cwd, &["status", "--porcelain=v1", "-b"]) {
        Ok(outcome) if outcome.ok => outcome,
        Ok(outcome) => {
            return GitStatus {
                is_repo: false,
                branch: None,
                files: Vec::new(),
                error: Some(outcome.output),
            };
        }
        Err(error) => {
            return GitStatus {
                is_repo: false,
                branch: None,
                files: Vec::new(),
                error: Some(error.message),
            };
        }
    };
    let mut branch = None;
    let mut files = Vec::new();
    for line in outcome.output.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            branch = header
                .split("...")
                .next()
                .map(|value| value.trim().to_string());
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let index = line.as_bytes()[0] as char;
        let worktree = line.as_bytes()[1] as char;
        let path = line[3..]
            .split(" -> ")
            .last()
            .unwrap_or(&line[3..])
            .trim()
            .to_string();
        if index == '?' && worktree == '?' {
            files.push(GitFileStatus {
                path,
                staged: false,
            });
        } else {
            if index != ' ' {
                files.push(GitFileStatus {
                    path: path.clone(),
                    staged: true,
                });
            }
            if worktree != ' ' {
                files.push(GitFileStatus {
                    path,
                    staged: false,
                });
            }
        }
    }
    GitStatus {
        is_repo: true,
        branch,
        files,
        error: None,
    }
}

/// Baseline input for the turn-only diff card (`TurnBaseline`).
pub fn snapshot_files(store: &StateStore, platform: Platform, cwd: &str) -> Vec<FileSnapshot> {
    let Ok(cwd) = authorize(store, platform, cwd) else {
        return Vec::new();
    };
    let mut files: std::collections::BTreeMap<String, FileSnapshot> =
        std::collections::BTreeMap::new();
    for (args, staged) in [
        (&["diff", "--no-ext-diff", "--numstat"][..], false),
        (
            &["diff", "--cached", "--no-ext-diff", "--numstat"][..],
            true,
        ),
    ] {
        let Ok(outcome) = run_git(&cwd, args) else {
            continue;
        };
        if !outcome.ok {
            continue;
        }
        for line in outcome.output.lines() {
            let mut parts = line.splitn(3, '\t');
            let (Some(additions), Some(deletions), Some(path)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let additions = additions.parse::<u64>().unwrap_or(0);
            let deletions = deletions.parse::<u64>().unwrap_or(0);
            let entry = files
                .entry(path.to_string())
                .or_insert_with(|| FileSnapshot {
                    path: path.to_string(),
                    additions: 0,
                    deletions: 0,
                    staged,
                });
            entry.additions += additions;
            entry.deletions += deletions;
            entry.staged = entry.staged || staged;
        }
    }
    if let Ok(outcome) = run_git(&cwd, &["ls-files", "--others", "--exclude-standard"]) {
        for path in outcome
            .output
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let additions = std::fs::read_to_string(cwd.join(path))
                .map(|text| text.lines().count() as u64)
                .unwrap_or(0);
            files.entry(path.to_string()).or_insert(FileSnapshot {
                path: path.to_string(),
                additions,
                deletions: 0,
                staged: false,
            });
        }
    }
    files.into_values().collect()
}

pub fn diff(
    store: &StateStore,
    platform: Platform,
    cwd: &str,
    path: &str,
    staged: bool,
) -> Result<GitDiff> {
    let cwd = authorize(store, platform, cwd)?;
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    let outcome = run_git(&cwd, &args)?;
    if !outcome.ok {
        return Err(CoreError::new(
            "Error",
            outcome.reason.unwrap_or(outcome.output),
        ));
    }
    Ok(GitDiff {
        text: outcome.output,
    })
}

pub fn stage(store: &StateStore, platform: Platform, cwd: &str, paths: &[String]) -> Result<bool> {
    let cwd = authorize(store, platform, cwd)?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    Ok(run_git(&cwd, &args)?.ok)
}

pub fn unstage(
    store: &StateStore,
    platform: Platform,
    cwd: &str,
    paths: &[String],
) -> Result<bool> {
    let cwd = authorize(store, platform, cwd)?;
    let mut args = vec!["reset", "-q", "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    Ok(run_git(&cwd, &args)?.ok)
}

pub fn restore(
    store: &StateStore,
    platform: Platform,
    cwd: &str,
    paths: &[String],
) -> Result<bool> {
    let cwd = authorize(store, platform, cwd)?;
    let mut args = vec!["restore", "--"];
    args.extend(paths.iter().map(String::as_str));
    Ok(run_git(&cwd, &args)?.ok)
}

pub fn commit(
    store: &StateStore,
    platform: Platform,
    cwd: &str,
    message: &str,
) -> Result<ProcessOutcome> {
    let cwd = authorize(store, platform, cwd)?;
    run_git(&cwd, &["commit", "-m", message])
}

fn project_root(store: &StateStore, project_id: &str) -> Result<PathBuf> {
    let project = store
        .state()
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .ok_or_else(|| CoreError::invalid("Unknown project id"))?;
    authorize_path(
        store,
        Path::new(&project.primary_folder),
        Platform::current(),
    )
}

pub fn checkout_catalog(store: &StateStore, project_id: &str) -> Result<CheckoutCatalog> {
    let root = project_root(store, project_id)?;
    let strategy = store.state().settings.checkout_strategy;
    let branch = current_branch(&root);
    let mut checkouts = Vec::new();
    match strategy {
        CheckoutStrategy::Branch => {
            if let Ok(outcome) = run_git(&root, &["branch", "--format=%(refname:short)"]) {
                for name in outcome
                    .output
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                {
                    checkouts.push(CheckoutEntry {
                        name: name.trim().to_string(),
                        branch: Some(name.trim().to_string()),
                        path: None,
                    });
                }
            }
        }
        CheckoutStrategy::Worktree => {
            if let Ok(outcome) = run_git(&root, &["worktree", "list", "--porcelain"]) {
                let mut path: Option<String> = None;
                let mut branch_name: Option<String> = None;
                for line in outcome.output.lines().chain(std::iter::once("")) {
                    if let Some(value) = line.strip_prefix("worktree ") {
                        path = Some(value.to_string());
                    } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                        branch_name = Some(value.to_string());
                    } else if line.is_empty()
                        && let Some(path) = path.take()
                    {
                        let name = branch_name.clone().unwrap_or_else(|| path.clone());
                        checkouts.push(CheckoutEntry {
                            name,
                            branch: branch_name.take(),
                            path: Some(path),
                        });
                    }
                }
            }
        }
    }
    Ok(CheckoutCatalog {
        strategy: match strategy {
            CheckoutStrategy::Branch => "branch".to_string(),
            CheckoutStrategy::Worktree => "worktree".to_string(),
        },
        active_name: branch.unwrap_or_default(),
        checkouts,
    })
}

fn current_branch(root: &Path) -> Option<String> {
    run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .and_then(|outcome| {
            if outcome.ok {
                Some(outcome.output.trim().to_string())
                    .filter(|branch| !branch.is_empty() && branch != "HEAD")
            } else {
                None
            }
        })
}

fn refused(code: &str, message: impl Into<String>) -> CheckoutOutcome {
    CheckoutOutcome {
        kind: "refused".to_string(),
        code: Some(code.to_string()),
        message: Some(message.into()),
        path: None,
    }
}

#[cfg(windows)]
fn normalized_path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(not(windows))]
fn normalized_path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn applied(path: Option<String>) -> CheckoutOutcome {
    CheckoutOutcome {
        kind: "applied".to_string(),
        code: None,
        message: None,
        path,
    }
}

/// Deterministic sibling of the project root for a worktree checkout.
fn worktree_path(root: &Path, branch: &str) -> Result<PathBuf> {
    let parent = root
        .parent()
        .ok_or_else(|| CoreError::invalid("Project root has no parent directory"))?;
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("worktree");
    Ok(parent.join(format!("{name}-{}", branch.replace('/', "-"))))
}

pub fn execute_checkout(
    store: &StateStore,
    project_id: &str,
    action: &Value,
) -> Result<CheckoutOutcome> {
    let root = project_root(store, project_id)?;
    let strategy = store.state().settings.checkout_strategy;
    let operation = action
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("switch");
    let branch = action
        .get("branch")
        .and_then(Value::as_str)
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| CoreError::invalid("Checkout action requires a branch"))?;
    if !matches!(operation, "create" | "switch") {
        return Err(CoreError::invalid(format!(
            "Unsupported checkout operation: {operation}"
        )));
    }
    match strategy {
        CheckoutStrategy::Worktree if operation == "create" => {
            let path = worktree_path(&root, branch)?;
            if path.exists() {
                return Ok(refused(
                    "worktree-exists",
                    format!("Worktree path already exists: {}", path.display()),
                ));
            }
            let path_text = normalized_path_text(&path);
            let outcome = run_git(&root, &["worktree", "add", "-b", branch, &path_text])?;
            if !outcome.ok {
                return Ok(refused(
                    "git-failed",
                    outcome.reason.unwrap_or(outcome.output),
                ));
            }
            Ok(applied(Some(path_text)))
        }
        CheckoutStrategy::Worktree => {
            let catalog = checkout_catalog(store, project_id)?;
            let path = catalog
                .checkouts
                .into_iter()
                .find(|entry| entry.branch.as_deref() == Some(branch))
                .and_then(|entry| entry.path);
            match path {
                Some(path) => Ok(applied(Some(path))),
                None => Ok(refused(
                    "unknown-worktree",
                    format!("No worktree checks out {branch}"),
                )),
            }
        }
        CheckoutStrategy::Branch => {
            let status = status(store, Platform::current(), &root.display().to_string());
            if !status.files.is_empty() {
                return Ok(refused(
                    "dirty-worktree",
                    "The worktree has uncommitted changes",
                ));
            }
            let outcome = match operation {
                "create" => run_git(&root, &["switch", "-c", branch])?,
                _ => run_git(&root, &["switch", branch])?,
            };
            if !outcome.ok {
                return Ok(refused(
                    "git-failed",
                    outcome.reason.unwrap_or(outcome.output),
                ));
            }
            Ok(applied(None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Fixture {
        _temp: tempfile::TempDir,
        store: StateStore,
        project_id: String,
        root: PathBuf,
    }

    fn git(cwd: &Path, args: &[&str]) -> ProcessOutcome {
        let outcome = run_git(cwd, args).expect("git");
        assert!(outcome.ok, "git {args:?} failed: {}", outcome.output);
        outcome
    }

    fn fixture(strategy: &str) -> Fixture {
        let temp = tempfile::TempDir::new().expect("temp");
        let root = temp.path().join("repo");
        fs::create_dir_all(&root).expect("repo dir");
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "user.name", "Test User"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        fs::write(root.join("README.md"), "hello\n").expect("readme");
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let root = crate::paths::canonicalize(&root).expect("canonical");
        let mut store = StateStore::open(
            temp.path().join("state").join("omp-desktop-state-v4.json"),
            None,
            Platform::current(),
        )
        .expect("store");
        let project = projects::grant_project(
            &mut store,
            temp.path(),
            Platform::current(),
            &root.display().to_string(),
        )
        .expect("grant");
        store
            .update_settings(&json!({ "checkoutStrategy": strategy }))
            .expect("strategy");
        Fixture {
            _temp: temp,
            store,
            project_id: project.id,
            root,
        }
    }

    fn expected_worktree(fixture: &Fixture, branch: &str) -> PathBuf {
        fixture
            .root
            .parent()
            .expect("parent")
            .join(format!("repo-{}", branch.replace('/', "-")))
    }

    #[test]
    fn worktree_create_adds_sibling_checkout() {
        let fixture = fixture("worktree");
        let outcome = execute_checkout(
            &fixture.store,
            &fixture.project_id,
            &json!({ "operation": "create", "branch": "feature/one" }),
        )
        .expect("create");
        assert_eq!(outcome.kind, "applied");
        let path = expected_worktree(&fixture, "feature/one");
        let path_text = normalized_path_text(&path);
        assert_eq!(outcome.path.as_deref(), Some(path_text.as_str()));
        assert!(path.is_dir());
        let catalog = checkout_catalog(&fixture.store, &fixture.project_id).expect("catalog");
        assert_eq!(catalog.strategy, "worktree");
        assert!(catalog.checkouts.iter().any(|entry| {
            entry.branch.as_deref() == Some("feature/one")
                && entry.path.as_deref() == Some(path_text.as_str())
        }));
    }

    #[test]
    fn worktree_switch_returns_catalog_path_without_touching_root() {
        let fixture = fixture("worktree");
        execute_checkout(
            &fixture.store,
            &fixture.project_id,
            &json!({ "operation": "create", "branch": "feature/one" }),
        )
        .expect("create");
        let outcome = execute_checkout(
            &fixture.store,
            &fixture.project_id,
            &json!({ "operation": "switch", "branch": "feature/one" }),
        )
        .expect("switch");
        assert_eq!(outcome.kind, "applied");
        assert_eq!(
            outcome.path.as_deref(),
            Some(normalized_path_text(&expected_worktree(&fixture, "feature/one")).as_str())
        );
        assert_eq!(current_branch(&fixture.root).as_deref(), Some("main"));
    }

    #[test]
    fn worktree_switch_refuses_unknown_branch() {
        let fixture = fixture("worktree");
        let outcome = execute_checkout(
            &fixture.store,
            &fixture.project_id,
            &json!({ "operation": "switch", "branch": "missing" }),
        )
        .expect("switch");
        assert_eq!(outcome.kind, "refused");
        assert_eq!(outcome.code.as_deref(), Some("unknown-worktree"));
        assert!(outcome.path.is_none());
    }

    #[test]
    fn worktree_create_refuses_existing_path() {
        let fixture = fixture("worktree");
        fs::create_dir_all(expected_worktree(&fixture, "feature/one")).expect("existing");
        let outcome = execute_checkout(
            &fixture.store,
            &fixture.project_id,
            &json!({ "operation": "create", "branch": "feature/one" }),
        )
        .expect("create");
        assert_eq!(outcome.kind, "refused");
        assert_eq!(outcome.code.as_deref(), Some("worktree-exists"));
    }

    #[test]
    fn branch_strategy_switches_in_place_and_refuses_dirty_tree() {
        let fixture = fixture("branch");
        let outcome = execute_checkout(
            &fixture.store,
            &fixture.project_id,
            &json!({ "operation": "create", "branch": "topic" }),
        )
        .expect("create");
        assert_eq!(outcome.kind, "applied");
        assert!(outcome.path.is_none());
        assert_eq!(current_branch(&fixture.root).as_deref(), Some("topic"));
        fs::write(fixture.root.join("README.md"), "dirty\n").expect("dirty");
        let outcome = execute_checkout(
            &fixture.store,
            &fixture.project_id,
            &json!({ "operation": "switch", "branch": "main" }),
        )
        .expect("switch");
        assert_eq!(outcome.kind, "refused");
        assert_eq!(outcome.code.as_deref(), Some("dirty-worktree"));
    }

    #[test]
    fn outcome_serializes_path_only_when_present() {
        let value = serde_json::to_value(applied(Some("/tmp/wt".to_string()))).expect("json");
        assert_eq!(value["path"], json!("/tmp/wt"));
        let value = serde_json::to_value(refused("worktree-exists", "exists")).expect("json");
        assert!(value.get("path").is_none());
    }
}
