//! Merge conflicts menu: what operation stopped with conflicts, the three index versions of a
//! conflicted file (common ancestor, current, incoming), and finishing or aborting that operation.

use std::path::Path;

use serde::Serialize;

use super::{err, run_git_env, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictState {
    /// "merge", "rebase", "cherry-pick", "revert", or null when no operation is in progress
    /// (conflicts can still exist, e.g. after `git stash pop`).
    pub operation: Option<String>,
    /// The branch the work lands on (during a rebase: the branch being rebased).
    pub branch: Option<String>,
    /// What "current" (ours, HEAD) means for this operation, in words.
    pub current_label: String,
    /// What "incoming" (theirs) means for this operation, in words.
    pub incoming_label: String,
    /// Short id and subject of the incoming commit, when there is one.
    pub incoming_commit: Option<String>,
    /// Files the index still lists as conflicted.
    pub conflicted: Vec<String>,
    /// Rebase progress like (3, 7) — step 3 of 7.
    pub step: Option<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersions {
    pub base: Option<String>,
    pub current: Option<String>,
    pub incoming: Option<String>,
    /// True when one of the versions is binary (shown as unavailable).
    pub binary: bool,
}

fn read_trim(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn commit_line(repo: &git2::Repository, oid: &str) -> Option<String> {
    let oid = git2::Oid::from_str(oid.trim()).ok()?;
    let commit = repo.find_commit(oid).ok()?;
    let short = commit.as_object().short_id().ok().and_then(|b| b.as_str().map(str::to_string)).unwrap_or_else(|| oid.to_string()[..7].to_string());
    Some(format!("{} {}", short, commit.summary().unwrap_or("")).trim().to_string())
}

fn conflicted_paths(repo: &git2::Repository) -> Result<Vec<String>> {
    let index = repo.index().map_err(err)?;
    let mut out: Vec<String> = Vec::new();
    for conflict in index.conflicts().map_err(err)?.flatten() {
        if let Some(entry) = conflict.our.or(conflict.their).or(conflict.ancestor) {
            let path = String::from_utf8_lossy(&entry.path).to_string();
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

pub fn conflict_state(repo_path: &Path) -> Result<ConflictState> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let git_dir = repo.path().to_path_buf();
    let head_branch = repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().map(str::to_string));
    let conflicted = conflicted_paths(&repo)?;

    let rebase_dir = if git_dir.join("rebase-merge").exists() {
        Some(git_dir.join("rebase-merge"))
    } else if git_dir.join("rebase-apply").exists() {
        Some(git_dir.join("rebase-apply"))
    } else {
        None
    };

    if let Some(merge_head) = read_trim(&git_dir.join("MERGE_HEAD")) {
        let first = merge_head.lines().next().unwrap_or("").to_string();
        let message = read_trim(&git_dir.join("MERGE_MSG")).and_then(|m| m.lines().next().map(str::to_string));
        let branch = head_branch.clone();
        return Ok(ConflictState {
            operation: Some("merge".into()),
            current_label: format!("your branch{}", branch.as_deref().map(|b| format!(" ({b})")).unwrap_or_default()),
            incoming_label: message.unwrap_or_else(|| "the branch being merged in".into()),
            incoming_commit: commit_line(&repo, &first),
            branch,
            conflicted,
            step: None,
        });
    }
    if let Some(dir) = rebase_dir {
        let branch = read_trim(&dir.join("head-name")).map(|h| h.trim_start_matches("refs/heads/").to_string());
        let onto = read_trim(&dir.join("onto")).and_then(|o| commit_line(&repo, &o));
        let stopped = read_trim(&git_dir.join("REBASE_HEAD")).or_else(|| read_trim(&dir.join("stopped-sha")));
        let num = read_trim(&dir.join("msgnum")).or_else(|| read_trim(&dir.join("next"))).and_then(|n| n.parse().ok());
        let end = read_trim(&dir.join("end")).or_else(|| read_trim(&dir.join("last"))).and_then(|n| n.parse().ok());
        return Ok(ConflictState {
            operation: Some("rebase".into()),
            current_label: format!("the new base{} plus your commits replayed so far", onto.as_deref().map(|o| format!(" ({o})")).unwrap_or_default()),
            incoming_label: format!("your commit being replayed{}", branch.as_deref().map(|b| format!(" from {b}")).unwrap_or_default()),
            incoming_commit: stopped.and_then(|s| commit_line(&repo, &s)),
            branch,
            conflicted,
            step: num.zip(end),
        });
    }
    if let Some(pick) = read_trim(&git_dir.join("CHERRY_PICK_HEAD")) {
        return Ok(ConflictState {
            operation: Some("cherry-pick".into()),
            current_label: format!("your branch{}", head_branch.as_deref().map(|b| format!(" ({b})")).unwrap_or_default()),
            incoming_label: "the commit being cherry-picked".into(),
            incoming_commit: commit_line(&repo, &pick),
            branch: head_branch,
            conflicted,
            step: None,
        });
    }
    if let Some(revert) = read_trim(&git_dir.join("REVERT_HEAD")) {
        return Ok(ConflictState {
            operation: Some("revert".into()),
            current_label: format!("your branch{}", head_branch.as_deref().map(|b| format!(" ({b})")).unwrap_or_default()),
            incoming_label: "the undo of the commit being reverted".into(),
            incoming_commit: commit_line(&repo, &revert),
            branch: head_branch,
            conflicted,
            step: None,
        });
    }
    Ok(ConflictState {
        operation: None,
        current_label: format!("your branch{}", head_branch.as_deref().map(|b| format!(" ({b})")).unwrap_or_default()),
        incoming_label: "the incoming change (for example a stash you applied)".into(),
        incoming_commit: None,
        branch: head_branch,
        conflicted,
        step: None,
    })
}

pub fn conflict_versions(repo_path: &Path, path: &str) -> Result<ConflictVersions> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let index = repo.index().map_err(err)?;
    let wanted = path.replace('\\', "/");
    let mut versions = ConflictVersions { base: None, current: None, incoming: None, binary: false };
    for conflict in index.conflicts().map_err(err)?.flatten() {
        let matches = [&conflict.our, &conflict.their, &conflict.ancestor]
            .iter()
            .any(|e| e.as_ref().is_some_and(|e| String::from_utf8_lossy(&e.path) == wanted));
        if !matches {
            continue;
        }
        let mut read = |entry: &Option<git2::IndexEntry>| -> Option<String> {
            let entry = entry.as_ref()?;
            let blob = repo.find_blob(entry.id).ok()?;
            if blob.is_binary() {
                versions.binary = true;
                return None;
            }
            Some(String::from_utf8_lossy(blob.content()).into_owned())
        };
        let base = read(&conflict.ancestor);
        let current = read(&conflict.our);
        let incoming = read(&conflict.their);
        versions.base = base;
        versions.current = current;
        versions.incoming = incoming;
        return Ok(versions);
    }
    Err(format!("{path} is not conflicted"))
}

/// Finishes the operation that stopped with conflicts, once every conflicted file is staged.
pub fn conflict_continue(repo_path: &Path) -> Result<String> {
    let state = conflict_state(repo_path)?;
    if !state.conflicted.is_empty() {
        return Err(format!(
            "{} file(s) are still conflicted — resolve and stage them first: {}",
            state.conflicted.len(),
            state.conflicted.join(", ")
        ));
    }
    let env = [("GIT_EDITOR", "true")];
    match state.operation.as_deref() {
        Some("merge") => run_git_env(repo_path, &["commit", "--no-edit"], &env),
        Some("rebase") => run_git_env(repo_path, &["rebase", "--continue"], &env),
        Some("cherry-pick") => run_git_env(repo_path, &["cherry-pick", "--continue"], &env),
        Some("revert") => run_git_env(repo_path, &["revert", "--continue"], &env),
        _ => Err("No merge, rebase, cherry-pick or revert is in progress — commit the resolved files in Working changes.".into()),
    }
}

/// Abandons the operation and puts the branch back as it was before it started.
pub fn conflict_abort(repo_path: &Path) -> Result<String> {
    let state = conflict_state(repo_path)?;
    let env = [("GIT_EDITOR", "true")];
    match state.operation.as_deref() {
        Some("merge") => run_git_env(repo_path, &["merge", "--abort"], &env),
        Some("rebase") => run_git_env(repo_path, &["rebase", "--abort"], &env),
        Some("cherry-pick") => run_git_env(repo_path, &["cherry-pick", "--abort"], &env),
        Some("revert") => run_git_env(repo_path, &["revert", "--abort"], &env),
        _ => Err("No merge, rebase, cherry-pick or revert is in progress, so there is nothing to abort.".into()),
    }
}

/// Resolves one conflicted file in the working tree and stages it: `side` takes the current
/// ("ours") or incoming ("theirs") version whole — deleting the file when that side deleted it —
/// otherwise `content` becomes the file, and None deletes it.
pub fn conflict_resolve_file(repo_path: &Path, path: &str, side: Option<&str>, content: Option<&str>) -> Result<()> {
    use std::path::Component;
    use crate::gitcli::run_git;

    let relative = Path::new(path);
    if path.is_empty() || !relative.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("{path} is not a path inside the repository."));
    }
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let workdir = repo.workdir().ok_or("This repository has no working tree.")?.to_path_buf();
    let wanted = path.replace('\\', "/");
    if !conflicted_paths(&repo)?.contains(&wanted) {
        return Err(format!("{path} is not conflicted."));
    }
    let delete = |repo_path: &Path| -> Result<()> {
        run_git(repo_path, &["rm", "-q", "--cached", "--ignore-unmatch", "--", &wanted])?;
        let file = workdir.join(relative);
        if file.exists() {
            std::fs::remove_file(&file).map_err(err)?;
        }
        Ok(())
    };
    match (side, content) {
        (Some(side @ ("ours" | "theirs")), _) => {
            let index = repo.index().map_err(err)?;
            let stage = if side == "ours" { 2 } else { 3 };
            if index.get_path(Path::new(&wanted), stage).is_some() {
                run_git(repo_path, &["checkout", &format!("--{side}"), "--", &wanted])?;
                run_git(repo_path, &["add", "--", &wanted])?;
            } else {
                delete(repo_path)?;
            }
        }
        (Some(other), _) => return Err(format!("Unknown side \"{other}\".")),
        (None, Some(text)) => {
            if text.lines().any(|line| line.starts_with("<<<<<<<") || line.starts_with(">>>>>>>")) {
                return Err(format!("{path} still has conflict markers."));
            }
            let file = workdir.join(relative);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent).map_err(err)?;
            }
            std::fs::write(&file, text).map_err(err)?;
            run_git(repo_path, &["add", "--", &wanted])?;
        }
        (None, None) => delete(repo_path)?,
    }
    Ok(())
}
