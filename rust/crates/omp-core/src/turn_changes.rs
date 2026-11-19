use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    pub staged: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnBaseline {
    files: BTreeMap<String, FileSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFileDelta {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChanges {
    pub files: Vec<TurnFileDelta>,
    pub additions: u64,
    pub deletions: u64,
}

impl TurnChanges {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

impl TurnBaseline {
    pub fn capture(files: impl IntoIterator<Item = FileSnapshot>) -> Self {
        Self {
            files: files
                .into_iter()
                .map(|file| (file.path.clone(), file))
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// Computes the files changed during one turn. A file that was already dirty
/// before the turn contributes only the growth beyond its baseline; a file
/// that was clean before contributes its full diff. Files untouched during the
/// turn never appear.
pub fn compute_turn_changes(
    baseline: &TurnBaseline,
    after: impl IntoIterator<Item = FileSnapshot>,
) -> TurnChanges {
    let after: Vec<FileSnapshot> = after.into_iter().collect();
    let after_paths: std::collections::BTreeSet<String> =
        after.iter().map(|file| file.path.clone()).collect();
    let mut files = Vec::new();
    let mut additions = 0u64;
    let mut deletions = 0u64;
    for file in after {
        let previous = baseline.files.get(&file.path);
        let is_new = previous.is_none();
        let (delta_additions, delta_deletions) = match previous {
            Some(previous) => (
                file.additions.saturating_sub(previous.additions),
                file.deletions.saturating_sub(previous.deletions),
            ),
            None => (file.additions, file.deletions),
        };
        if !is_new && delta_additions == 0 && delta_deletions == 0 {
            continue;
        }
        additions += delta_additions;
        deletions += delta_deletions;
        files.push(TurnFileDelta {
            path: file.path,
            additions: delta_additions,
            deletions: delta_deletions,
        });
    }
    for (path, previous) in &baseline.files {
        if after_paths.contains(path.as_str()) {
            continue;
        }
        let removed = previous.additions + previous.deletions;
        deletions += removed;
        files.push(TurnFileDelta {
            path: path.clone(),
            additions: 0,
            deletions: removed,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    TurnChanges {
        files,
        additions,
        deletions,
    }
}
