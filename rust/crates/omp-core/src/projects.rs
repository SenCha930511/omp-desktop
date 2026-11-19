use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::state::{FolderIdentity, PersistedProject, Platform, StateStore, now_iso};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub harness: String,
    pub name: String,
    pub path: String,
    pub folders: Vec<String>,
    pub primary_folder: String,
    pub pinned: bool,
    pub created_at: String,
    pub last_opened_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scripts: Option<crate::state::ProjectScripts>,
    pub session_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileListing {
    pub entries: Vec<ProjectFileEntry>,
    pub skipped: u64,
}

pub fn canonicalize(path: &Path) -> Result<PathBuf> {
    crate::paths::canonicalize(path).map_err(|error| {
        CoreError::invalid(format!(
            "{} is not an accessible directory: {error}",
            path.display()
        ))
    })
}

pub fn is_broad_project_root(path: &Path, home: &Path) -> bool {
    let canonical = |candidate: &Path| {
        crate::paths::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf())
    };
    let path = canonical(path);
    let home = canonical(home);
    path.parent().is_none() || path == home
}

pub fn capture_folder_identity(path: &Path) -> FolderIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(metadata) = fs::metadata(path) {
            let birthtime_ns = metadata
                .created()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos().to_string());
            return FolderIdentity {
                dev: metadata.dev().to_string(),
                ino: metadata.ino().to_string(),
                birthtime_ns,
                unknown: Default::default(),
            };
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    FolderIdentity {
        dev: String::new(),
        ino: String::new(),
        birthtime_ns: None,
        unknown: Default::default(),
    }
}

fn folder_identity_matches(stored: &FolderIdentity, current: &FolderIdentity) -> bool {
    stored.dev == current.dev
        && stored.ino == current.ino
        && stored.birthtime_ns == current.birthtime_ns
}

pub fn authorize_path(store: &StateStore, path: &Path, platform: Platform) -> Result<PathBuf> {
    let canonical = canonicalize(path)?;
    let state = store.state();
    let dismissed: BTreeSet<PathBuf> = state
        .dismissed_project_paths
        .iter()
        .map(|item| crate::paths::canonicalize(item).unwrap_or_else(|_| PathBuf::from(item)))
        .collect();
    for project in &state.projects {
        for folder in &project.folders {
            let Ok(root) = crate::paths::canonicalize(folder) else {
                continue;
            };
            if !path_within(&root, &canonical) {
                continue;
            }
            if dismissed.contains(&canonical) && !dismissed.contains(&root) {
                continue;
            }
            if let Some(identity) = project
                .folder_identities
                .as_ref()
                .and_then(|identities| identities.get(folder))
            {
                let current = capture_folder_identity(&root);
                if !folder_identity_matches(identity, &current) {
                    return Err(CoreError::invalid(format!(
                        "Project folder identity changed: {}",
                        root.display()
                    )));
                }
            }
            return Ok(canonical);
        }
    }
    let _ = platform;
    Err(CoreError::invalid(format!(
        "Path is not inside a granted project: {}",
        canonical.display()
    )))
}

pub fn path_within(root: &Path, path: &Path) -> bool {
    path == root || path.starts_with(root)
}

pub fn grant_project(
    store: &mut StateStore,
    home: &Path,
    platform: Platform,
    path_value: &str,
) -> Result<ProjectRecord> {
    let requested = Path::new(path_value);
    if !requested.is_absolute() {
        return Err(CoreError::invalid("Project path must be absolute"));
    }
    let canonical = canonicalize(requested)?;
    if !canonical.is_dir() {
        return Err(CoreError::invalid(format!(
            "{} is not a directory",
            canonical.display()
        )));
    }
    if is_broad_project_root(&canonical, home) {
        return Err(CoreError::invalid(
            "Broad filesystem roots cannot be added as projects",
        ));
    }
    let identity = capture_folder_identity(&canonical);
    let now = now_iso();
    let path_text = canonical.display().to_string();
    let project = store.update(|state| {
        state.dismissed_project_paths.retain(|item| {
            let item_path =
                crate::paths::canonicalize(item).unwrap_or_else(|_| PathBuf::from(item));
            item_path != canonical
        });
        if let Some(existing) = state.projects.iter_mut().find(|project| {
            Path::new(&project.path) == canonical
                || project
                    .folders
                    .iter()
                    .any(|folder| Path::new(folder) == canonical)
        }) {
            existing.last_opened_at = now.clone();
            existing
                .folder_identities
                .get_or_insert_with(Default::default)
                .insert(path_text.clone(), identity.clone());
            return Ok(existing.clone());
        }
        let created = PersistedProject {
            id: Uuid::new_v4().to_string(),
            harness: "omp".to_string(),
            name: canonical
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
                .unwrap_or_else(|| path_text.clone()),
            path: path_text.clone(),
            folders: vec![path_text.clone()],
            primary_folder: path_text.clone(),
            pinned: false,
            created_at: now.clone(),
            last_opened_at: now.clone(),
            folder_identities: Some(Default::default()),
            scripts: None,
            unknown: Default::default(),
        };
        let mut created = created;
        created
            .folder_identities
            .get_or_insert_with(Default::default)
            .insert(path_text.clone(), identity);
        state.projects.push(created.clone());
        Ok(created)
    })?;
    let _ = platform;
    Ok(to_record(&project, 0, None))
}

pub fn list_projects(store: &StateStore) -> Vec<ProjectRecord> {
    store
        .state()
        .projects
        .iter()
        .map(|project| to_record(project, 0, None))
        .collect()
}

pub fn remove_project(store: &mut StateStore, id: &str) -> Result<bool> {
    let state = store.state().clone();
    let Some(project) = state.projects.iter().find(|project| project.id == id) else {
        return Ok(false);
    };
    let roots: Vec<String> = project.folders.clone();
    let removed = store.update(|state| {
        let index = state.projects.iter().position(|project| project.id == id);
        let Some(index) = index else { return Ok(false) };
        state.projects.remove(index);
        let mut dismissed: BTreeSet<String> =
            state.dismissed_project_paths.iter().cloned().collect();
        for root in roots {
            dismissed.insert(root);
        }
        state.dismissed_project_paths = dismissed.into_iter().collect();
        Ok(true)
    })?;
    Ok(removed)
}

fn to_record(
    project: &PersistedProject,
    session_count: u64,
    git_branch: Option<String>,
) -> ProjectRecord {
    ProjectRecord {
        id: project.id.clone(),
        harness: project.harness.clone(),
        name: project.name.clone(),
        path: project.path.clone(),
        folders: project.folders.clone(),
        primary_folder: project.primary_folder.clone(),
        pinned: project.pinned,
        created_at: project.created_at.clone(),
        last_opened_at: project.last_opened_at.clone(),
        scripts: project.scripts.clone(),
        session_count,
        git_branch,
        inferred: None,
        read_only: None,
    }
}

pub fn list_files(
    store: &StateStore,
    platform: Platform,
    root_value: &str,
) -> Result<ProjectFileListing> {
    let root = authorize_path(store, Path::new(root_value), platform)?;
    let mut entries = Vec::new();
    let mut skipped = 0u64;
    const MAX_ENTRIES: usize = 5_000;
    const IGNORED: [&str; 12] = [
        ".git",
        "node_modules",
        "vendor",
        "out",
        "dist",
        "build",
        "release",
        "coverage",
        ".next",
        ".venv",
        "__pycache__",
        "target",
    ];
    walk_directory(
        &root,
        &root,
        &mut entries,
        &mut skipped,
        MAX_ENTRIES,
        &IGNORED,
    );
    Ok(ProjectFileListing { entries, skipped })
}

fn walk_directory(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<ProjectFileEntry>,
    skipped: &mut u64,
    max_entries: usize,
    ignored: &[&str],
) {
    if entries.len() >= max_entries {
        return;
    }
    let Ok(read_dir) = fs::read_dir(directory) else {
        *skipped += 1;
        return;
    };
    let mut children: Vec<_> = read_dir.filter_map(|item| item.ok()).collect();
    children.sort_by(|left, right| {
        let left_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let right_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });
    for child in children {
        if entries.len() >= max_entries {
            break;
        }
        let Ok(file_type) = child.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = child.file_name().to_string_lossy().to_string();
        if file_type.is_dir() && ignored.contains(&name.as_str()) {
            continue;
        }
        if !file_type.is_dir() && !file_type.is_file() {
            continue;
        }
        let absolute = directory.join(&name);
        let Ok(relative) = absolute.strip_prefix(root) else {
            continue;
        };
        let path = relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(part) => Some(part.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        entries.push(ProjectFileEntry {
            path,
            kind: if file_type.is_dir() {
                "directory".to_string()
            } else {
                "file".to_string()
            },
        });
        if file_type.is_dir() {
            walk_directory(root, &absolute, entries, skipped, max_entries, ignored);
        }
    }
}

pub fn require_granted_cwd(
    store: &StateStore,
    platform: Platform,
    value: Option<&Value>,
) -> Result<PathBuf> {
    let path = value
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| CoreError::invalid("cwd must be a non-empty string"))?;
    authorize_path(store, Path::new(path), platform)
}
