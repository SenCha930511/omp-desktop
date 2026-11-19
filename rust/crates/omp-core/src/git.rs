use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::projects;
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
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<ProcessOutcome> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
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

/// Captures per-file line counts for the current worktree and index. This is
/// the baseline input for the turn-only diff card.
pub fn snapshot_files(store: &StateStore, platform: Platform, cwd: &str) -> Vec<FileSnapshot> {
    let Ok(cwd) = authorize(store, platform, cwd) else {
        return Vec::new();
    };
    let mut files: std::collections::BTreeMap<String, FileSnapshot> =
        std::collections::BTreeMap::new();
    for (args, staged) in [
        (&["diff", "--numstat"][..], false),
        (&["diff", "--cached", "--numstat"][..], true),
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
    let mut args = vec!["diff", "--no-color"];
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
    Ok(PathBuf::from(&project.primary_folder))
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

pub fn execute_checkout(
    store: &StateStore,
    project_id: &str,
    action: &Value,
) -> Result<CheckoutOutcome> {
    let root = project_root(store, project_id)?;
    let operation = action
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("switch");
    let branch = action
        .get("branch")
        .and_then(Value::as_str)
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| CoreError::invalid("Checkout action requires a branch"))?;
    let status = status(store, Platform::current(), &root.display().to_string());
    if !status.files.is_empty() {
        return Ok(CheckoutOutcome {
            kind: "refused".to_string(),
            code: Some("dirty-worktree".to_string()),
            message: Some("The worktree has uncommitted changes".to_string()),
        });
    }
    let outcome = match operation {
        "create" => run_git(&root, &["switch", "-c", branch])?,
        "switch" => run_git(&root, &["switch", branch])?,
        other => {
            return Err(CoreError::invalid(format!(
                "Unsupported checkout operation: {other}"
            )));
        }
    };
    if !outcome.ok {
        return Ok(CheckoutOutcome {
            kind: "refused".to_string(),
            code: Some("git-failed".to_string()),
            message: outcome.reason.or(Some(outcome.output)),
        });
    }
    Ok(CheckoutOutcome {
        kind: "applied".to_string(),
        code: None,
        message: None,
    })
}
