//! Git operations via libgit2. All functions are synchronous and return
//! `Result<_, String>` so Tauri commands can surface errors to the UI.

use std::collections::BTreeMap;
use std::path::Path;

use git2::{
    build::CheckoutBuilder, BranchType, Delta, DiffFormat, DiffOptions, ObjectType, Repository,
    Status, StatusOptions,
};
use serde::Serialize;
use crate::CommandNoWindow;

#[cfg(test)]
#[path = "git_state/tests.rs"]
mod tests;

const MAX_DIFF_BYTES: usize = 1_000_000;
const MAX_TAGS_SHOWN: usize = 20;

type Result<T> = std::result::Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Payload types (camelCase to match the frontend `src/types/repository.ts`)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub initials: String,
    pub name: String,
    pub email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamInfo {
    pub name: String,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub oid: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGroup {
    pub remote: String,
    pub branches: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Stable row id: `<path>:staged|unstaged`
    pub id: String,
    pub path: String,
    pub name: String,
    pub directory: String,
    /// M | A | D | R
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub staged: bool,
    pub untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryState {
    pub organization: String,
    pub name: String,
    /// Some("Local") when the repository has no remote; None otherwise.
    pub visibility: Option<String>,
    pub local_path: String,
    pub current_branch: String,
    pub upstream: Option<UpstreamInfo>,
    pub account: AccountInfo,
    pub files: Vec<ChangedFile>,
    pub branches: Vec<BranchInfo>,
    pub remotes: Vec<RemoteGroup>,
    pub tags: Vec<TagInfo>,
    pub tag_total: usize,
    pub stashes: Vec<StashInfo>,
    /// Current HEAD commit oid; None on an unborn branch.
    pub head_oid: Option<String>,
    /// True while an interactive/regular rebase is mid-flight.
    pub rebase_in_progress: bool,
    pub commit_edit: Option<crate::ops::CommitEditState>,
    /// Registered git submodules.
    pub submodules: Vec<SubmoduleInfo>,
    /// Linked worktrees (main worktree included).
    pub worktrees: Vec<WorktreeInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffContent {
    pub original: Option<String>,
    pub modified: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    pub language: String,
}

#[derive(Default)]
struct LineCounts {
    additions: usize,
    deletions: usize,
}

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

pub fn build_state(path: &Path) -> Result<RepositoryState> {
    let mut repo = Repository::discover(path).map_err(err)?;

    let (files, untracked_paths) = collect_files(&repo)?;
    let head_tree = head_tree(&repo);
    let staged_counts = diff_counts(&repo, DiffSide::Staged, &head_tree);
    let unstaged_counts = diff_counts(&repo, DiffSide::Unstaged, &head_tree);
    // Tree borrows `repo`; release it before the mutable stash scan below.
    drop(head_tree);

    // Attach diffstat numbers to their rows.
    let mut rows: Vec<ChangedFile> = Vec::new();
    for mut file in files {
        let counts = if file.staged {
            staged_counts.get(&file.path)
        } else {
            unstaged_counts.get(&file.path)
        };
        if let Some(counts) = counts {
            file.additions = counts.additions;
            file.deletions = counts.deletions;
        }
        rows.push(file);
    }
    let _ = untracked_paths; // untracked rows are built inside collect_files

    let (organization, name, visibility) = repo_identity(&repo)?;
    let current_branch = current_branch(&repo)?;
    let upstream = upstream_info(&repo, &current_branch)?;
    let account = account_info(&repo)?;
    let branches = local_branches(&repo)?;
    let remotes = remote_branches(&repo)?;
    let (tags, tag_total) = tags(&repo)?;
    let stashes = stash_list(&mut repo)?;
    let local_path = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    let rebase_in_progress = {
        let git_dir = repo.path();
        git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists()
    };
    let commit_edit = crate::ops::commit_edit_state(&repo);
    let head_oid = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .map(|commit| commit.id().to_string());
    let submodules = list_submodules(path).unwrap_or_default();
    let worktrees = list_worktrees(path, &local_path).unwrap_or_default();

    Ok(RepositoryState {
        organization,
        name,
        visibility,
        local_path,
        current_branch,
        upstream,
        account,
        files: rows,
        branches,
        remotes,
        tags,
        tag_total,
        stashes,
        head_oid,
        rebase_in_progress,
        commit_edit,
        submodules,
        worktrees,
    })
}

/// Build one ChangedFile row per (path, staged-flag) pair — a path with both
/// staged and unstaged edits intentionally produces two rows.
fn collect_files(repo: &Repository) -> Result<(Vec<ChangedFile>, Vec<String>)> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .exclude_submodules(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(err)?;
    let mut rows = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let Some(path) = entry.path().map(str::to_string) else {
            continue;
        };
        let flags = entry.status();
        if flags.contains(Status::CONFLICTED) {
            // Conflicted: show with status C for manual resolution.
            let (name, directory) = split_path(&path);
            rows.push(ChangedFile {
                id: format!("{}:conflicted", path),
                path: path.clone(),
                name,
                directory,
                status: "C".to_string(),
                additions: 0,
                deletions: 0,
                staged: false,
                untracked: false,
            });
            continue;
        }

        let staged_flags = Status::INDEX_NEW
            | Status::INDEX_MODIFIED
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE;
        let unstaged_flags = Status::WT_MODIFIED
            | Status::WT_DELETED
            | Status::WT_RENAMED
            | Status::WT_TYPECHANGE;

        let new_file = |staged: bool| {
            let (name, directory) = split_path(&path);
            ChangedFile {
                id: format!("{}:{}", path, if staged { "staged" } else { "unstaged" }),
                path: path.clone(),
                name,
                directory,
                status: status_letter(flags, staged).to_string(),
                additions: 0,
                deletions: 0,
                staged,
                untracked: !staged && flags.contains(Status::WT_NEW),
            }
        };

        if flags.intersects(staged_flags) {
            rows.push(new_file(true));
        }
        if flags.intersects(unstaged_flags) || flags.contains(Status::WT_NEW) {
            let row = new_file(false);
            if row.untracked {
                untracked.push(path.clone());
            }
            rows.push(row);
        }
    }

    rows.sort_by(|a, b| a.path.cmp(&b.path).then(a.staged.cmp(&b.staged)));
    Ok((rows, untracked))
}

fn status_letter(flags: Status, staged: bool) -> char {
    let check = |mask: Status| flags.intersects(mask);
    if staged {
        if check(Status::INDEX_RENAMED) {
            'R'
        } else if check(Status::INDEX_NEW) {
            'A'
        } else if check(Status::INDEX_DELETED) {
            'D'
        } else {
            'M'
        }
    } else if check(Status::WT_RENAMED) {
        'R'
    } else if check(Status::WT_NEW) {
        'A'
    } else if check(Status::WT_DELETED) {
        'D'
    } else {
        'M'
    }
}

fn split_path(path: &str) -> (String, String) {
    match path.rfind(['/', '\\']) {
        Some(idx) => (path[idx + 1..].to_string(), path[..idx].to_string()),
        None => (path.to_string(), String::new()),
    }
}

enum DiffSide {
    Staged,
    Unstaged,
}

/// Per-file addition/deletion counts computed from libgit2 diffs.
fn diff_counts(
    repo: &Repository,
    side: DiffSide,
    head_tree: &Option<git2::Tree<'_>>,
) -> BTreeMap<String, LineCounts> {
    let diff = match side {
        DiffSide::Staged => {
            let index = match repo.index() {
                Ok(index) => index,
                Err(_) => return BTreeMap::new(),
            };
            repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        }
        DiffSide::Unstaged => {
            let mut opts = DiffOptions::new();
            opts.include_untracked(true)
                .show_untracked_content(true)
                .recurse_untracked_dirs(true);
            repo.diff_index_to_workdir(None, Some(&mut opts))
        }
    };
    let mut diff = match diff {
        Ok(diff) => diff,
        Err(_) => return BTreeMap::new(),
    };
    // Detect renames so counts land on the current path.
    let _ = diff.find_similar(None);

    let mut counts = BTreeMap::new();
    for idx in 0..diff.deltas().len() {
        let Ok(Some(patch)) = git2::Patch::from_diff(&diff, idx) else {
            // Binary or undiffable — record zeros so the row still shows.
            if let Some(delta) = diff.get_delta(idx) {
                if let Some(path) = delta.new_file().path() {
                    counts.insert(
                        path.to_string_lossy().to_string(),
                        LineCounts::default(),
                    );
                }
            }
            continue;
        };
        let mut file_counts = LineCounts::default();
        for h in 0..patch.num_hunks() {
            let Ok((_, hunk_len)) = patch.hunk(h) else {
                continue;
            };
            for l in 0..hunk_len {
                let Ok(line) = patch.line_in_hunk(h, l) else {
                    continue;
                };
                match line.origin() {
                    '+' => file_counts.additions += 1,
                    '-' => file_counts.deletions += 1,
                    _ => {}
                }
            }
        }
        if let Some(delta) = diff.get_delta(idx) {
            let key = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string());
            if let Some(key) = key {
                counts.insert(key, file_counts);
            }
        }
    }
    counts
}

// ---------------------------------------------------------------------------
// Identity / refs
// ---------------------------------------------------------------------------

fn repo_identity(repo: &Repository) -> Result<(String, String, Option<String>)> {
    let origin = repo.find_remote("origin").ok();
    let url = origin
        .as_ref()
        .and_then(|remote| remote.url().map(str::to_string));

    if let Some(url) = url {
        // git@host:org/name.git | https://host/org/name.git | ssh://git@host/org/name
        let tail = url
            .trim_start_matches("git@")
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("ssh://git@");
        let tail = tail.split('/').collect::<Vec<_>>();
        if tail.len() >= 2 {
            let org = tail[tail.len() - 2].to_string();
            let name = tail[tail.len() - 1]
                .trim_end_matches(".git")
                .to_string();
            if !org.is_empty() && !name.is_empty() {
                return Ok((org, name, None));
            }
        }
    }

    // No usable remote: derive from the folder name, mark as Local.
    let dir = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    let name = dir
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("repository")
        .to_string();
    let organization = dir
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .nth(1)
        .unwrap_or("")
        .to_string();
    Ok((organization, name, Some("Local".to_string())))
}

fn current_branch(repo: &Repository) -> Result<String> {
    if let Ok(head) = repo.head() {
        if let Some(shorthand) = head.shorthand() {
            return Ok(shorthand.to_string());
        }
    }
    // Unborn branch: HEAD is a symbolic ref to refs/heads/<name>.
    repo.find_reference("HEAD")
        .ok()
        .and_then(|head| head.symbolic_target().map(str::to_string))
        .map(|target| target.trim_start_matches("refs/heads/").to_string())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "detached HEAD".to_string())
}

fn upstream_info(repo: &Repository, branch_name: &str) -> Result<Option<UpstreamInfo>> {
    let branch = match repo.find_branch(branch_name, BranchType::Local) {
        Ok(branch) => branch,
        Err(_) => return Ok(None),
    };
    let upstream = match branch.upstream() {
        Ok(upstream) => upstream,
        Err(_) => return Ok(None),
    };
    let name = upstream
        .name()
        .ok()
        .flatten()
        .unwrap_or("upstream")
        .to_string();
    let local_oid = match branch.get().target() {
        Some(oid) => oid,
        None => return Ok(None),
    };
    let upstream_oid = match upstream.get().target() {
        Some(oid) => oid,
        None => return Ok(None),
    };
    let (ahead, behind) = repo.graph_ahead_behind(local_oid, upstream_oid).map_err(err)?;
    Ok(Some(UpstreamInfo { name, ahead, behind }))
}

fn account_info(repo: &Repository) -> Result<AccountInfo> {
    // Missing user.name/user.email must not break the whole state — the
    // commit action surfaces a clear error instead.
    let signature = repo.signature().ok();
    let name = signature
        .as_ref()
        .and_then(|s| s.name())
        .unwrap_or("Unknown")
        .to_string();
    let email = signature
        .as_ref()
        .and_then(|s| s.email())
        .unwrap_or("not configured")
        .to_string();
    Ok(AccountInfo {
        initials: initials_for(&name),
        name,
        email,
    })
}

fn local_branches(repo: &Repository) -> Result<Vec<BranchInfo>> {
    let mut branches = Vec::new();
    for entry in repo.branches(Some(BranchType::Local)).map_err(err)? {
        let (branch, _) = entry.map_err(err)?;
        let name = branch.name().ok().flatten().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let is_head = branch.is_head();
        let oid = branch.get().target().map(|id| id.to_string());
        branches.push(BranchInfo { name, is_head, oid });
    }
    branches.sort_by(|a, b| b.is_head.cmp(&a.is_head).then(a.name.cmp(&b.name)));
    Ok(branches)
}

fn remote_branches(repo: &Repository) -> Result<Vec<RemoteGroup>> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut shorthands = Vec::new();
    for reference in repo.references().map_err(err)? {
        let Ok(reference) = reference else {
            continue;
        };
        if !reference.is_remote() {
            continue;
        }
        if let Some(shorthand) = reference.shorthand() {
            shorthands.push(shorthand.to_string());
        }
    }
    shorthands.sort();
    for shorthand in shorthands {
        // "origin/main" -> remote "origin", branch "main"
        if let Some((remote, branch)) = shorthand.split_once('/') {
            groups
                .entry(remote.to_string())
                .or_default()
                .push(branch.to_string());
        }
    }
    Ok(groups
        .into_iter()
        .map(|(remote, branches)| RemoteGroup { remote, branches })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    /// Commit the tag resolves to; None when dangling.
    pub commit_oid: Option<String>,
    pub time_seconds: Option<i64>,
}

fn tags(repo: &Repository) -> Result<(Vec<TagInfo>, usize)> {
    let mut infos = Vec::new();
    for reference in repo.references().map_err(err)? {
        let Ok(reference) = reference else {
            continue;
        };
        let Some(full) = reference.name() else {
            continue;
        };
        let Some(name) = full.strip_prefix("refs/tags/") else {
            continue;
        };
        // Resolve to the commit the tag (annotated or lightweight) points at.
        let target = reference.peel_to_commit().ok();
        infos.push(TagInfo {
            name: name.to_string(),
            commit_oid: target.as_ref().map(|c| c.id().to_string()),
            time_seconds: target.map(|c| c.time().seconds() as i64),
        });
    }
    infos.sort_by(|a, b| b.name.cmp(&a.name));
    let total = infos.len();
    if infos.len() > MAX_TAGS_SHOWN {
        infos.truncate(MAX_TAGS_SHOWN);
    }
    Ok((infos, total))
}

fn stash_list(repo: &mut Repository) -> Result<Vec<StashInfo>> {
    let mut stashes = Vec::new();
    repo.stash_foreach(|index, message, _oid| {
        stashes.push(StashInfo {
            index,
            message: message.to_string(),
        });
        true
    })
    .map_err(err)?;
    Ok(stashes)
}

// ---------------------------------------------------------------------------
// File diff content
// ---------------------------------------------------------------------------

pub fn file_diff_at(repo_path: &Path, path: &str, staged: bool) -> Result<FileDiffContent> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    file_diff_in(&repo, path, staged)
}

fn file_diff_in(repo: &Repository, path: &str, staged: bool) -> Result<FileDiffContent> {
    let original = if staged {
        head_blob(repo, path)
    } else {
        index_blob(repo, path)
    };
    let modified = if staged {
        index_blob(repo, path)
    } else {
        worktree_bytes(repo, path)
    };

    let language = language_for(path);

    let too_large = original.as_ref().is_some_and(|b| b.len() > MAX_DIFF_BYTES)
        || modified.as_ref().is_some_and(|b| b.len() > MAX_DIFF_BYTES);
    if too_large {
        return Ok(FileDiffContent {
            original: None,
            modified: None,
            binary: false,
            too_large: true,
            language,
        });
    }

    let binary = original.as_ref().is_some_and(|b| is_binary(b))
        || modified.as_ref().is_some_and(|b| is_binary(b));
    if binary {
        return Ok(FileDiffContent {
            original: None,
            modified: None,
            binary: true,
            too_large: false,
            language,
        });
    }

    Ok(FileDiffContent {
        original: Some(decode(original.as_deref())),
        modified: Some(decode(modified.as_deref())),
        binary: false,
        too_large: false,
        language,
    })
}

fn head_tree(repo: &Repository) -> Option<git2::Tree<'_>> {
    let head = repo.head().ok()?;
    let commit = head.peel_to_commit().ok()?;
    commit.tree().ok()
}

fn head_blob(repo: &Repository, path: &str) -> Option<Vec<u8>> {
    let tree = head_tree(repo)?;
    let entry = tree.get_path(Path::new(path)).ok()?;
    let blob = entry.to_object(repo).ok()?.peel_to_blob().ok()?;
    Some(blob.content().to_vec())
}

fn index_blob(repo: &Repository, path: &str) -> Option<Vec<u8>> {
    let index = repo.index().ok()?;
    let entry = index.get_path(Path::new(path), 0)?;
    let blob = repo
        .find_object(entry.id, Some(ObjectType::Blob))
        .ok()?
        .peel_to_blob()
        .ok()?;
    Some(blob.content().to_vec())
}

fn worktree_bytes(repo: &Repository, path: &str) -> Option<Vec<u8>> {
    std::fs::read(repo.workdir()?.join(path)).ok()
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8000)].contains(&0)
}

fn decode(bytes: Option<&[u8]>) -> String {
    bytes.map(String::from_utf8_lossy).unwrap_or_default().into_owned()
}

fn language_for(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "ts" => "typescript",
        "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "json" => "json",
        "css" | "scss" | "less" => "css",
        "html" => "html",
        "md" | "markdown" => "markdown",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "toml" => "ini",
        "yml" | "yaml" => "yaml",
        "sh" | "bash" => "shell",
        _ => "plaintext",
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

pub fn stage_paths(repo_path: &Path, paths: &[String]) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut index = repo.index().map_err(err)?;
    for path in paths {
        let workdir_path = repo.workdir().ok_or("bare repository")?.join(path);
        if workdir_path.is_file() {
            index.add_path(Path::new(path)).map_err(err)?;
        } else {
            // Deleted in the worktree — record the removal.
            index.remove_path(Path::new(path)).map_err(err)?;
        }
    }
    index.write().map_err(err)?;
    Ok(())
}

pub fn unstage_paths(repo_path: &Path, paths: &[String]) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    // reset_default wants the committish whose content seeds the index.
    let target = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .map(|commit| commit.as_object().clone());
    let path_refs: Vec<&str> = paths.iter().map(String::as_str).collect();
    repo.reset_default(target.as_ref(), path_refs.iter().copied())
        .map_err(err)?;
    Ok(())
}

/// Discard unstaged worktree changes. Untracked files are deleted.
pub fn discard_file(repo_path: &Path, path: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let workdir_path = repo.workdir().ok_or("bare repository")?.join(path);

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).pathspec(path);
    let statuses = repo.statuses(Some(&mut opts)).map_err(err)?;
    let flags = statuses
        .iter()
        .next()
        .map(|entry| entry.status())
        .unwrap_or(Status::empty());

    if flags.contains(Status::WT_NEW) {
        std::fs::remove_file(&workdir_path)
            .map_err(|e| format!("failed to delete untracked file: {e}"))?;
        return Ok(());
    }
    if !flags.intersects(
        Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_TYPECHANGE,
    ) {
        return Ok(()); // nothing to discard
    }

    let mut index = repo.index().map_err(err)?;
    let mut builder = CheckoutBuilder::new();
    builder.path(path).force().update_index(false);
    repo.checkout_index(Some(&mut index), Some(&mut builder))
        .map_err(|e| format!("failed to restore file: {e}"))?;
    Ok(())
}

pub fn commit(repo_path: &Path, title: &str, body: &str, amend: bool) -> Result<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("commit title is required".to_string());
    }
    let message = if body.trim().is_empty() {
        title.to_string()
    } else {
        format!("{title}\n\n{}", body.trim())
    };

    let repo = Repository::discover(repo_path).map_err(err)?;
    let staged = repo
        .statuses(None)
        .map_err(err)?
        .iter()
        .any(|entry| {
            entry.status().intersects(
                Status::INDEX_NEW
                    | Status::INDEX_MODIFIED
                    | Status::INDEX_DELETED
                    | Status::INDEX_RENAMED
                    | Status::INDEX_TYPECHANGE,
            )
        });
    if !staged && !amend {
        return Err("no staged files to commit".to_string());
    }

    if amend && repo.head().is_err() {
        return Err("nothing to amend — HEAD not found".to_string());
    }
    // Honor repository hooks, signing settings and merge parents exactly as Git does.
    drop(repo);
    let mut args = vec!["commit", "-m", message.as_str()];
    if amend { args.push("--amend"); }
    crate::gitcli::run_git(repo_path, &args)?;
    crate::gitcli::run_git(repo_path, &["rev-parse", "HEAD"])

}

pub fn stash(repo_path: &Path, message: Option<&str>) -> Result<()> {
    let mut repo = Repository::discover(repo_path).map_err(err)?;
    let mut signature = repo.signature().map_err(err)?;
    let flags = git2::StashFlags::INCLUDE_UNTRACKED | git2::StashFlags::KEEP_INDEX;
    repo.stash_save(&mut signature, message.unwrap_or("WIP"), Some(flags))
        .map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commit history + lane graph
// ---------------------------------------------------------------------------

const MAX_HISTORY_ROWS: usize = 500;
const MAX_REF_LABELS: usize = 3;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitRow {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    /// Author email — matches GitHub avatar lookups on the graph screen.
    pub author_email: String,
    pub author_initials: String,
    pub time_seconds: i64,
    /// Lane index this commit sits on.
    pub lane: u32,
    /// Lane indices of its parents (length 1 for normal, 2+ for merges).
    pub parent_lanes: Vec<u32>,
    /// Active lanes entering this row (top edge) — for drawing.
    pub active_before: Vec<u32>,
    /// Active lanes leaving this row (bottom edge).
    pub active_after: Vec<u32>,
    pub is_head: bool,
    pub is_merge: bool,
    /// True when the commit is reachable from a remote branch (on the cloud);
    /// false when it only exists locally.
    pub pushed: bool,
    /// Branch labels pointing at this commit ("main", "origin/main").
    pub refs: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitHistory {
    pub total: usize,
    pub truncated: bool,
    pub commits: Vec<CommitRow>,
}

/// Oids reachable from a ref (or HEAD), optionally limited to changes that
/// touch `path` — the commit graph's branch & path filters use this set.
pub fn commit_oid_set(
    repo_path: &Path,
    ref_name: Option<&str>,
    path: Option<&str>,
    exclude: Option<&str>,
    max: usize,
) -> Result<Vec<String>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut revwalk = repo.revwalk().map_err(err)?;
    revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL).map_err(err)?;
    match ref_name {
        Some(name) => {
            let candidates = [
                format!("refs/heads/{}", name),
                format!("refs/remotes/origin/{}", name),
                name.to_string(),
            ];
            let mut pushed = false;
            for candidate in &candidates {
                if revwalk.push_ref(candidate).is_ok() {
                    pushed = true;
                    break;
                }
            }
            if !pushed {
                return Err(format!("unknown ref: {}", name).into());
            }
        }
        None => {
            let head = repo.head().map_err(err)?;
            revwalk.push(head.peel_to_commit().map_err(err)?.id()).map_err(err)?;
        }
    }
    // Range support: hide everything reachable from the excluded ref
    // (e.g. the previous release tag) so only newer commits remain.
    if let Some(exclude) = exclude.map(str::trim).filter(|p| !p.is_empty()) {
        let candidates = [
            format!("refs/tags/{}", exclude),
            format!("refs/heads/{}", exclude),
            format!("refs/remotes/origin/{}", exclude),
            exclude.to_string(),
        ];
        for candidate in &candidates {
            let peeled = repo.revparse_single(candidate).ok().and_then(|obj| obj.peel_to_commit().ok());
            if let Some(commit) = peeled {
                if revwalk.hide(commit.id()).is_ok() {
                    break;
                }
            }
        }
    }
    let path = path.map(str::trim).filter(|p| !p.is_empty());
    if let Some(path) = path {
        // git2 has no revwalk path filter — check each commit's diff.
        let mut out: Vec<String> = Vec::new();
        let mut walked = 0usize;
        for oid in revwalk {
            let oid = oid.map_err(err)?;
            walked += 1;
            if walked > 20000 {
                break;
            }
            let commit = repo.find_commit(oid).map_err(err)?;
            let touches = if commit.parent_count() == 0 {
                let mut diff = repo
                    .diff_tree_to_tree(None, Some(&commit.tree().map_err(err)?), None)
                    .map_err(err)?;
                diff_touches_path(&mut diff, path)?
            } else {
                let parent = commit.parent(0).map_err(err)?;
                let mut diff = repo
                    .diff_tree_to_tree(
                        parent.tree().ok().as_ref(),
                        commit.tree().ok().as_ref(),
                        None,
                    )
                    .map_err(err)?;
                diff_touches_path(&mut diff, path)?
            };
            if touches {
                out.push(oid.to_string());
                if out.len() >= max {
                    break;
                }
            }
        }
        return Ok(out);
    }
    let mut out = Vec::new();
    for oid in revwalk {
        out.push(oid.map_err(err)?.to_string());
        if out.len() >= max {
            break;
        }
    }
    Ok(out)
}

/// True when the diff touches  (file or anything under that directory).
fn diff_touches_path(diff: &mut git2::Diff, path: &str) -> Result<bool> {
    let mut touches = false;
    let path_owned = path.to_string();
    diff.foreach(
        &mut |delta, _| {
            let check = |p: Option<&str>| -> bool {
                p.map(|p| p.starts_with(path_owned.as_str()) || path_owned.starts_with(p))
                    .unwrap_or(false)
            };
            if check(delta.old_file().path().and_then(|p| p.to_str()))
                || check(delta.new_file().path().and_then(|p| p.to_str()))
            {
                touches = true;
                return false; // matched — stop walking deltas
            }
            true
        },
        None,
        None,
        None,
    )
    .map_err(err)?;
    Ok(touches)
}

/// Recent commits of one branch/ref (newest first) — a plain list, no
/// graph lanes. Powers the Branches screen's commit pane.
pub fn build_branch_commits(repo_path: &Path, ref_name: &str) -> Result<CommitHistory> {
    build_ref_commits(repo_path, ref_name, false)
}

pub fn build_ref_commits(repo_path: &Path, ref_name: &str, first_parent: bool) -> Result<CommitHistory> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let tip = repo
        .revparse_single(ref_name)
        .map_err(|e| format!("unknown ref {ref_name}: {}", e.message()))?
        .peel_to_commit()
        .map_err(err)?;
    let pushed_set = remote_pushed_oids(&repo);
    let mut revwalk = repo.revwalk().map_err(err)?;
    if first_parent {
        revwalk.simplify_first_parent().map_err(err)?;
    }
    revwalk.push(tip.id()).map_err(err)?;
    revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL).map_err(err)?;
    let mut commits: Vec<CommitRow> = Vec::new();
    let mut truncated = false;
    let mut total = 0usize;
    for oid in revwalk {
        let oid = oid.map_err(err)?;
        total += 1;
        if commits.len() >= MAX_HISTORY_ROWS {
            truncated = true;
            continue;
        }
        let commit = repo.find_commit(oid).map_err(err)?;
        commits.push(CommitRow {
            oid: commit.id().to_string(),
            short_oid: commit
                .as_object()
                .short_id()
                .map(|buf| buf.as_str().map(|str| str.to_string()).unwrap_or_default())
                .unwrap_or_default(),
            summary: commit.summary().unwrap_or_default().to_string(),
            author_name: commit.author().name().unwrap_or_default().to_string(),
            author_email: commit.author().email().unwrap_or_default().to_string(),
            author_initials: initials_for(&commit.author().name().unwrap_or("")),
            time_seconds: commit.time().seconds(),
            lane: 0,
            parent_lanes: Vec::new(),
            active_before: Vec::new(),
            active_after: Vec::new(),
            is_head: false,
            is_merge: commit.parent_count() > 1,
            pushed: pushed_set.contains(&oid),
            refs: Vec::new(),
        });
    }
    Ok(CommitHistory { total, truncated, commits })
}

pub fn build_commit_history(repo_path: &Path, include_remotes: bool) -> Result<CommitHistory> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let pushed_set = remote_pushed_oids(&repo);

    // Ref labels per commit (local + optional remote).
    let mut ref_labels: BTreeMap<git2::Oid, Vec<String>> = BTreeMap::new();
    let mut head_oid: Option<git2::Oid> = None;
    if let Ok(head) = repo.head() {
        if let Ok(commit) = head.peel_to_commit() {
            head_oid = Some(commit.id());
        }
    }
    collect_ref_labels(&repo, "refs/heads/", "", &mut ref_labels);
    if include_remotes {
        collect_ref_labels(&repo, "refs/remotes/", "", &mut ref_labels);
    }

    // Walk from HEAD + every requested ref tip.
    let mut revwalk = repo.revwalk().map_err(err)?;
    revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL).map_err(err)?;
    let mut pushed = false;
    if let Some(oid) = head_oid {
        revwalk.push(oid).map_err(err)?;
        pushed = true;
    }
    for (oid, _) in &ref_labels {
        // Local labels always push; remote labels only when requested
        // (collect_ref_labels already filtered them).
        if revwalk.push(*oid).is_ok() {
            pushed = true;
        }
    }
    if !pushed {
        // Unborn repository — nothing to show.
        return Ok(CommitHistory { total: 0, truncated: false, commits: Vec::new() });
    }

    let mut commits = Vec::new();
    let mut truncated = false;
    let mut total = 0usize;
    // lane -> the commit oid that lane is currently waiting for.
    let mut lanes: Vec<Option<git2::Oid>> = Vec::new();

    for oid in revwalk {
        let oid = oid.map_err(err)?;
        total += 1;
        if commits.len() >= MAX_HISTORY_ROWS {
            truncated = true;
            continue; // keep counting for `total`
        }
        let commit = repo.find_commit(oid).map_err(err)?;
        let summary = commit.summary().unwrap_or_default().to_string();

        let active_before: Vec<u32> = lanes
            .iter()
            .enumerate()
            .filter_map(|(idx, slot)| slot.map(|_| idx as u32))
            .collect();

        // Find lanes waiting for this commit (collapse duplicates on merges).
        let positions: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter_map(|(idx, slot)| (*slot == Some(oid)).then_some(idx))
            .collect();
        let lane = match positions.first() {
            Some(&idx) => idx,
            None => {
                // New tip: first free lane, or append one.
                let idx = lanes.iter().position(|slot| slot.is_none()).unwrap_or(lanes.len());
                if idx == lanes.len() {
                    lanes.push(None);
                }
                idx
            }
        };
        for &extra in positions.iter().skip(1) {
            lanes[extra] = None; // merge collapsed this lane into `lane`
        }

        let parents: Vec<git2::Oid> = commit.parent_ids().collect();
        let mut parent_lanes = Vec::with_capacity(parents.len());
        if parents.is_empty() {
            lanes[lane] = None;
        } else {
            lanes[lane] = Some(parents[0]);
            parent_lanes.push(lane as u32);
            for &parent in parents.iter().skip(1) {
                // Reuse a free lane, otherwise append.
                let idx = lanes
                    .iter()
                    .position(|slot| slot.is_none())
                    .unwrap_or(lanes.len());
                if idx == lanes.len() {
                    lanes.push(None);
                }
                lanes[idx] = Some(parent);
                parent_lanes.push(idx as u32);
            }
        }

        let active_after: Vec<u32> = lanes
            .iter()
            .enumerate()
            .filter_map(|(idx, slot)| slot.map(|_| idx as u32))
            .collect();

        let author = commit.author();
        let author_name = author.name().unwrap_or("Unknown").to_string();

        let mut labels = ref_labels.get(&oid).cloned().unwrap_or_default();
        // HEAD ref itself is implicit; trim overflow.
        if labels.len() > MAX_REF_LABELS {
            labels.truncate(MAX_REF_LABELS);
        }

        commits.push(CommitRow {
            oid: oid.to_string(),
            short_oid: oid.to_string()[..7].to_string(),
            summary,
            author_name,
            author_email: author.email().unwrap_or_default().to_string(),
            author_initials: initials_for(&commit.author().name().unwrap_or("")),
            time_seconds: commit.time().seconds() as i64,
            lane: lane as u32,
            parent_lanes,
            active_before,
            active_after,
            is_head: head_oid == Some(oid),
            is_merge: parents.len() > 1,
            pushed: pushed_set.contains(&oid),
            refs: labels,
        });
    }

    Ok(CommitHistory { total, truncated, commits })
}

/// Oids reachable from any remote branch (refs/remotes/**) — commits in
/// this set already live on the cloud; everything else is local-only.
fn remote_pushed_oids(repo: &Repository) -> std::collections::HashSet<git2::Oid> {
    let mut set = std::collections::HashSet::new();
    let Ok(mut revwalk) = repo.revwalk() else {
        return set;
    };
    let Ok(refs) = repo.references_glob("refs/remotes/*") else {
        return set;
    };
    let mut any = false;
    for reference in refs.flatten() {
        if reference.name().is_some_and(|n| n.ends_with("/HEAD")) {
            continue;
        }
        if let Some(oid) = reference.target() {
            if revwalk.push(oid).is_ok() {
                any = true;
            }
        }
    }
    if !any {
        return set;
    }
    let _ = revwalk.set_sorting(git2::Sort::TIME);
    let mut steps = 0usize;
    for oid in revwalk.flatten() {
        set.insert(oid);
        steps += 1;
        if steps >= 100_000 {
            break; // safety cap for huge histories
        }
    }
    set
}

fn collect_ref_labels(
    repo: &Repository,
    prefix: &str,
    _unused: &str,
    labels: &mut BTreeMap<git2::Oid, Vec<String>>,
) {
    let Ok(mut refs) = repo.references() else {
        return;
    };
    while let Some(Ok(reference)) = refs.next() {
        let Some(name) = reference.name() else { continue };
        let Some(short) = name.strip_prefix(prefix) else { continue };
        if short.ends_with("/HEAD") {
            continue;
        }
        let Some(target) = reference.target() else { continue };
        labels.entry(target).or_default().push(short.to_string());
    }
}

pub(crate) fn initials_for(name: &str) -> String {
    let initials: String = name
        .split_whitespace()
        .filter(|part| part.chars().next().map_or(false, |c| c.is_alphabetic()))
        .filter_map(|part| part.chars().next())
        .take(2)
        .flat_map(char::to_uppercase)
        .collect();
    if initials.is_empty() { "?".to_string() } else { initials }
}

// ---------------------------------------------------------------------------
// Explorer: worktree tree + file read/write
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTree {
    /// All visible file paths (tracked + untracked, ignored excluded).
    pub entries: Vec<String>,
    /// Per-file pending-change status (M/A/U/D/R/C) for the tree chips.
    pub changed: Vec<TreeChangedFile>,
    /// Paths touched by commits that have not been pushed yet
    /// (only when the branch has an upstream).
    pub unpushed_paths: Vec<String>,
    /// Git-ignored files and folders for the faded rows of the tree. An ignored folder is listed once with a trailing `/`
    /// (its contents are not walked: node_modules would be huge), so the tree shows it dimmed and unexpanded, like VS Code.
    pub ignored: Vec<String>,
}

/// One changed file with a combined index+worktree status letter.
#[derive(Serialize, Clone)]
pub struct TreeChangedFile {
    pub path: String,
    pub status: String,
}

/// Top-most ignored paths (folders end with `/`), capped so a huge repo cannot flood the tree.
fn list_ignored(repo: &Repository) -> Vec<String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(false).include_ignored(true).recurse_ignored_dirs(false);
    let Ok(statuses) = repo.statuses(Some(&mut opts)) else { return Vec::new() };
    let mut out: Vec<String> = statuses
        .iter()
        .filter(|e| e.status().contains(Status::IGNORED))
        .filter_map(|e| e.path().map(str::to_string))
        .take(3000)
        .collect();
    out.sort();
    out
}

pub fn list_tree(repo_path: &Path) -> Result<FileTree> {
    let repo = Repository::discover(repo_path).map_err(err)?;

    let mut paths: Vec<String> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    // Tracked files from the index.
    let index = repo.index().map_err(err)?;
    for entry in index.iter() {
        let path = String::from_utf8_lossy(&entry.path).to_string();
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }

    // Untracked files (ignored excluded via default status behavior).
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(err)?;
    let mut changed: Vec<TreeChangedFile> = Vec::new();
    for entry in statuses.iter() {
        let Some(path) = entry.path().map(str::to_string) else {
            continue;
        };
        let flags = entry.status();
        if flags.contains(Status::WT_NEW) {
            if seen.insert(path.clone()) {
                paths.push(path.clone());
            }
        }
        if flags.intersects(
            Status::CONFLICTED
                | Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED,
        ) {
            let status = if flags.contains(Status::CONFLICTED) {
                "C"
            } else if flags.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
                "D"
            } else if flags.contains(Status::INDEX_NEW) {
                "A"
            } else if flags.contains(Status::WT_NEW) {
                "U"
            } else if flags.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
                "R"
            } else {
                "M"
            };
            changed.push(TreeChangedFile { path: path.clone(), status: status.to_string() });
        }
    }

    paths.sort();
    changed.sort_by(|a, b| a.path.cmp(&b.path));

    // Paths touched by commits ahead of the upstream (unpushed). Only
    // computed when the branch tracks something — otherwise every file
    // would be marked in a repo without a remote.
    let mut unpushed_paths: Vec<String> = Vec::new();
    if let Ok(head) = repo.head() {
        if let Some(branch) = head
            .shorthand()
            .and_then(|name| repo.find_branch(name, git2::BranchType::Local).ok())
        {
            if let Ok(upstream) = branch.upstream() {
                let upstream_oid = upstream.get().target();
                if let Some(upstream_oid) = upstream_oid {
                    let mut seen_up: std::collections::BTreeSet<String> =
                        std::collections::BTreeSet::new();
                    if let Some(head_oid) = head.target() {
                        if let Ok(base_oid) = repo.merge_base(head_oid, upstream_oid) {
                            let mut walk = repo.revwalk().map_err(err)?;
                            walk.set_sorting(git2::Sort::REVERSE | git2::Sort::TOPOLOGICAL).map_err(err)?;
                            walk.push(head_oid).map_err(err)?;
                            walk.hide(base_oid).map_err(err)?;
                        for oid in walk.flatten() {
                            let Ok(commit) = repo.find_commit(oid) else { continue };
                            let Ok(tree) = commit.tree() else { continue };
                            let parent_tree = commit
                                .parent(0)
                                .and_then(|parent| parent.tree())
                                .ok();
                            let mut collect = |delta: git2::DiffDelta| {
                                if let Some(p) = delta.new_file().path().or(delta.old_file().path()) {
                                    if seen_up.insert(p.to_string_lossy().to_string()) {
                                        unpushed_paths.push(p.to_string_lossy().to_string());
                                    }
                                }
                            };
                            if let Some(parent_tree) = parent_tree {
                                let diff = repo
                                    .diff_tree_to_tree(Some(&parent_tree), Some(&tree), None)
                                    .map_err(err)?;
                                diff.deltas().for_each(&mut collect);
                            } else {
                                let diff = repo.diff_tree_to_workdir_with_index(Some(&tree), None).map_err(err)?;
                                diff.deltas().for_each(&mut collect);
                            }
                        }
                    }
                }
            }
        }
    }
    }

    Ok(FileTree { entries: paths, changed, unpushed_paths, ignored: list_ignored(&repo) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFileContent {
    pub content: String,
    pub binary: bool,
    pub too_large: bool,
    pub language: String,
}

/// Binary file for preview viewers — base64 payload + detected mime type.
#[derive(Serialize, Debug)]
pub struct BinaryFileContent {
    pub data: String,
    pub mime: String,
    pub size: usize,
}

const MAX_BINARY_BYTES: usize = 20_000_000;
/// Largest text file the worktree reader returns (generated drawings, games and videos are big JSON files).
const MAX_WORKTREE_TEXT_BYTES: usize = 20_000_000;

/// Mime type by extension for the preview viewers (defaults to octet-stream).
fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Extracts the text of a text-based PDF (not scanned pages). Powers the
/// agent's read_pdf tool.
pub fn read_pdf_text(repo_path: &Path, path: &str, limit: usize) -> Result<String> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, path, true)?;
    let bytes = std::fs::read(&full).map_err(|e| format!("failed to read {path}: {e}"))?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("failed to extract pdf text from {path}: {e} (scanned/image PDFs have no text layer)"))?;
    Ok(text.chars().take(limit).collect())
}

/// Reads a binary file (images, pdfs, office docs) as base64 for the
/// preview viewers. Same traversal guard as the text reader.
pub fn read_binary_file(repo_path: &Path, path: &str) -> Result<BinaryFileContent> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, path, true)?;
    let bytes = std::fs::read(&full).map_err(|e| format!("failed to read {path}: {e}"))?;
    if bytes.len() > MAX_BINARY_BYTES {
        return Err(format!(
            "file too large: {path} (over {} MB)",
            MAX_BINARY_BYTES / 1_000_000
        ));
    }
    use base64::Engine as _;
    Ok(BinaryFileContent {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: mime_for(path).to_string(),
        size: bytes.len(),
    })
}

/// Opens a worktree file with the OS default application (shell assoc).
pub fn open_path_external(repo_path: &Path, path: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, path, true)?;
    std::process::Command::new("cmd").no_window()
        .args(["/C", "start", "", &full.to_string_lossy()])
        .spawn()
        .map_err(|e| format!("failed to open {path}: {e}"))?;
    Ok(())
}

/// Reject absolute paths and traversal outside the worktree. When the file
/// may not exist yet (writing), only the parent directory is canonicalized.
fn safe_worktree_path(repo: &Repository, path: &str, must_exist: bool) -> Result<std::path::PathBuf> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains("..")
        || path.contains(':')
    {
        return Err(format!("invalid file path: {path}"));
    }
    let workdir = repo.workdir().ok_or("bare repository")?;
    let joined = workdir.join(path);
    let root = workdir.canonicalize().map_err(err)?;
    let target = if must_exist {
        joined.canonicalize()
            .map_err(|e| format!("file not found: {e}"))?
    } else {
        match joined.parent().and_then(|parent| parent.canonicalize().ok()) {
            Some(parent) if parent.starts_with(&root) => {}
            // Parent missing is fine — the writer creates it.
            _ => {}
        }
        joined.clone()
    };
    if must_exist && !target.starts_with(&root) {
        return Err(format!("path escapes the repository: {path}"));
    }
    Ok(joined)
}

pub fn read_worktree_file(repo_path: &Path, path: &str) -> Result<WorktreeFileContent> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, path, true)?;
    let bytes = std::fs::read(&full).map_err(|e| format!("failed to read {path}: {e}"))?;

    let language = language_for(path);
    if bytes.len() > MAX_WORKTREE_TEXT_BYTES {
        return Ok(WorktreeFileContent { content: String::new(), binary: false, too_large: true, language });
    }
    if is_binary(&bytes) {
        return Ok(WorktreeFileContent { content: String::new(), binary: true, too_large: false, language });
    }
    Ok(WorktreeFileContent {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        binary: false,
        too_large: false,
        language,
    })
}

pub fn write_worktree_file(repo_path: &Path, path: &str, content: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, path, false)?;
    if let Some(parent) = full.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&full, content).map_err(|e| format!("failed to write {path}: {e}"))?;
    Ok(())
}

/// Writes a binary file (base64 payload) — only under `.pigry/` and only for
/// image/video evidence and exports, so a tool can never drop arbitrary
/// binaries elsewhere in the workspace.
pub fn write_worktree_binary(repo_path: &Path, path: &str, data_base64: &str) -> Result<()> {
    let rel = path.trim().replace('\\', "/");
    let ext_ok = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".webm"]
        .iter()
        .any(|ext| rel.to_ascii_lowercase().ends_with(ext));
    if !rel.starts_with(".pigry/") || !ext_ok || rel.contains("..") || rel.contains(':') {
        return Err("binary files can only be written under .pigry/ as .png/.jpg/.webp/.gif/.webm".to_string());
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("invalid base64 data: {e}"))?;
    if bytes.len() > MAX_BINARY_BYTES {
        return Err(format!("file too large (over {} MB)", MAX_BINARY_BYTES / 1_000_000));
    }
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, &rel, false)?;
    if let Some(parent) = full.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&full, bytes).map_err(|e| format!("failed to write {rel}: {e}"))?;
    Ok(())
}

/// Audio files (imported or recorded sound, exported mixes) may live under `.pigry/audio/` and are far larger than images.
const MAX_AUDIO_BYTES: u64 = 500_000_000;
/// Largest piece the chunked reader and writer move in one call.
const MAX_CHUNK_BYTES: usize = 12_000_000;
const AUDIO_EXTS: [&str; 9] = [".wav", ".mp3", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".webm"];

/// Writes one piece of a large binary (append = false starts the file over). Images follow the usual `.pigry/` rules and
/// 20 MB limit; audio under `.pigry/audio/` may reach 500 MB, which is why it is sent in pieces instead of one base64 string.
pub fn write_worktree_binary_chunk(repo_path: &Path, path: &str, data_base64: &str, append: bool) -> Result<u64> {
    let rel = path.trim().replace('\\', "/");
    let lower = rel.to_ascii_lowercase();
    if !rel.starts_with(".pigry/") || rel.contains("..") || rel.contains(':') {
        return Err("binary files can only be written under .pigry/".to_string());
    }
    let audio = lower.starts_with(".pigry/audio/") && AUDIO_EXTS.iter().any(|ext| lower.ends_with(ext));
    let image = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".webm"].iter().any(|ext| lower.ends_with(ext));
    if !audio && !image {
        return Err("binary files can only be written under .pigry/ as .png/.jpg/.webp/.gif/.webm, or audio under .pigry/audio/".to_string());
    }
    let limit = if audio { MAX_AUDIO_BYTES } else { MAX_BINARY_BYTES as u64 };
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("invalid base64 data: {e}"))?;
    if bytes.len() > MAX_CHUNK_BYTES.max(MAX_BINARY_BYTES) {
        return Err("chunk too large".to_string());
    }
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, &rel, false)?;
    if let Some(parent) = full.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    use std::io::Write as _;
    let existing = if append { std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0) } else { 0 };
    let total = existing + bytes.len() as u64;
    if total > limit {
        return Err(format!("file too large (over {} MB)", limit / 1_000_000));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&full)
        .map_err(|e| format!("failed to write {rel}: {e}"))?;
    file.write_all(&bytes).map_err(|e| format!("failed to write {rel}: {e}"))?;
    Ok(total)
}

#[derive(serde::Serialize)]
pub struct BinaryChunk {
    pub data: String,
    pub size: u64,
}

/// Reads `length` bytes (at most 12 MB) of a binary file from `offset` as base64, plus the whole file size, so large audio can be loaded in pieces.
pub fn read_binary_chunk(repo_path: &Path, path: &str, offset: u64, length: usize) -> Result<BinaryChunk> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, path, true)?;
    let mut file = std::fs::File::open(&full).map_err(|e| format!("failed to read {path}: {e}"))?;
    let size = file.metadata().map_err(|e| format!("failed to read {path}: {e}"))?.len();
    if size > MAX_AUDIO_BYTES {
        return Err(format!("file too large: {path} (over {} MB)", MAX_AUDIO_BYTES / 1_000_000));
    }
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("failed to read {path}: {e}"))?;
    let want = length.min(MAX_CHUNK_BYTES).min(size.saturating_sub(offset) as usize);
    let mut buf = vec![0u8; want];
    file.read_exact(&mut buf).map_err(|e| format!("failed to read {path}: {e}"))?;
    use base64::Engine as _;
    Ok(BinaryChunk { data: base64::engine::general_purpose::STANDARD.encode(&buf), size })
}

/// Remove a file from the worktree (the deletion shows up in git status).
pub fn delete_worktree_file(repo_path: &Path, path: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, path, false)?;
    if !full.is_file() {
        return Err(format!("{path} is not a file"));
    }
    std::fs::remove_file(&full).map_err(|e| format!("failed to delete {path}: {e}"))?;
    Ok(())
}

/// Remove a folder (and everything inside it) from the worktree.
pub fn delete_worktree_folder(repo_path: &Path, path: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let full = safe_worktree_path(&repo, path, true)?;
    if !full.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    std::fs::remove_dir_all(&full).map_err(|e| format!("failed to delete {path}: {e}"))?;
    Ok(())
}

/// Move a worktree folder to a new path inside the repository.
pub fn rename_worktree_folder(repo_path: &Path, old_path: &str, new_path: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let from = safe_worktree_path(&repo, old_path, true)?;
    let to = safe_worktree_path(&repo, new_path, true)?;
    if !from.is_dir() {
        return Err(format!("{old_path} is not a folder"));
    }
    if to.exists() {
        return Err(format!("{new_path} already exists"));
    }
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(&from, &to).map_err(|e| format!("failed to rename {old_path}: {e}"))?;
    Ok(())
}

/// Copies a file or a folder (recursively, without any .git inside it) to a new path inside the repository.
/// Never overwrites: the target must not exist, and a folder cannot be copied into itself.
pub fn copy_worktree_path(repo_path: &Path, old_path: &str, new_path: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let from = safe_worktree_path(&repo, old_path, true)?;
    let to = safe_worktree_path(&repo, new_path, false)?;
    if to.exists() {
        return Err(format!("{new_path} already exists"));
    }
    if from.is_dir() {
        let into_itself = to.starts_with(&from);
        if into_itself {
            return Err(format!("cannot copy {old_path} into itself"));
        }
        copy_dir_all(&from, &to).map_err(|e| format!("failed to copy {old_path}: {e}"))?;
    } else {
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::copy(&from, &to).map_err(|e| format!("failed to copy {old_path}: {e}"))?;
    }
    Ok(())
}

fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Shows a file or folder in the operating system's file manager (selected, where the OS can do that).
/// An empty path means the repository folder itself.
pub fn reveal_worktree_path(repo_path: &Path, path: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let workdir = repo.workdir().ok_or("bare repository")?.to_path_buf();
    let full = if path.is_empty() { workdir.clone() } else { safe_worktree_path(&repo, path, true)? };
    let shown = full.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    #[cfg(target_os = "windows")]
    let spawned = {
        let mut command = std::process::Command::new("explorer.exe");
        command.no_window();
        if full.is_dir() { command.arg(&shown) } else { command.arg(format!("/select,{shown}")) };
        command.spawn()
    };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").args(["-R", &shown]).spawn();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let spawned = {
        let folder = if full.is_dir() { full.clone() } else { full.parent().map(Path::to_path_buf).unwrap_or(workdir) };
        std::process::Command::new("xdg-open").arg(folder).spawn()
    };
    spawned.map(|_| ()).map_err(|e| format!("failed to show {path} in the file manager: {e}"))
}

/// Move a worktree file to a new path inside the repository.
pub fn rename_worktree_file(repo_path: &Path, old_path: &str, new_path: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let from = safe_worktree_path(&repo, old_path, false)?;
    let to = safe_worktree_path(&repo, new_path, false)?;
    if !from.is_file() {
        return Err(format!("{old_path} is not a file"));
    }
    if to.exists() {
        return Err(format!("{new_path} already exists"));
    }
    if let Some(parent) = to.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(&from, &to).map_err(|e| format!("failed to rename {old_path}: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Explorer: per-file history + blob at commit
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommitEntry {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    pub author_initials: String,
    pub time_seconds: i64,
}

/// Commits that changed `path`, newest first (like `git log -- <path>`,
/// without rename following).
pub fn build_file_history(
    repo_path: &Path,
    path: &str,
    ref_name: Option<&str>,
) -> Result<Vec<FileCommitEntry>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut revwalk = repo.revwalk().map_err(err)?;
    revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL).map_err(err)?;
    match ref_name.filter(|r| !r.trim().is_empty()) {
        Some(name) => {
            // Walk from the requested ref (PR head branch, tag, …) instead of HEAD.
            let candidates = [
                format!("refs/heads/{}", name),
                format!("refs/remotes/origin/{}", name),
                name.to_string(),
            ];
            let mut pushed = false;
            for candidate in &candidates {
                if revwalk.push_ref(candidate).is_ok() {
                    pushed = true;
                    break;
                }
            }
            if !pushed {
                revwalk.push_head().map_err(err)?;
            }
        }
        None => {
            revwalk.push_head().map_err(err)?;
        }
    }

    const MAX_WALKED: usize = 2000;
    const MAX_RESULTS: usize = 50;

    let mut entries = Vec::new();
    let mut walked = 0usize;
    for oid in revwalk {
        if walked >= MAX_WALKED || entries.len() >= MAX_RESULTS {
            break;
        }
        walked += 1;
        let oid = oid.map_err(err)?;
        let commit = repo.find_commit(oid).map_err(err)?;
        let parent = commit.parent(0).ok();
        // Avoid decoding a large tree twice for commits whose tree is unchanged.
        // Repeated empty commits otherwise make per-file history very expensive.
        if parent.as_ref().is_some_and(|parent| parent.tree_id() == commit.tree_id()) {
            continue;
        }
        let tree = commit.tree().map_err(err)?;

        let entry = match tree.get_path(Path::new(path)) {
            Ok(entry) => entry,
            Err(_) => continue, // path not present in this commit
        };
        // Only include commits where the blob differs from the first parent
        // (or the path is new relative to it).
        let changed = match parent {
            Some(parent) => match parent.tree() {
                Ok(parent_tree) => match parent_tree.get_path(Path::new(path)) {
                    Ok(parent_entry) => parent_entry.id() != entry.id(),
                    Err(_) => true, // newly added in this commit
                },
                Err(_) => true,
            },
            None => true, // root commit
        };
        if !changed {
            continue;
        }

        let author = commit.author();
        entries.push(FileCommitEntry {
            oid: oid.to_string(),
            short_oid: oid.to_string()[..7].to_string(),
            summary: commit.summary().unwrap_or_default().to_string(),
            author_name: author.name().unwrap_or("Unknown").to_string(),
            author_initials: initials_for(author.name().unwrap_or("")),
            time_seconds: commit.time().seconds() as i64,
        });
    }
    Ok(entries)
}

/// Blob content of `path` as stored in commit `oid`.
pub fn read_file_at_commit(
    repo_path: &Path,
    path: &str,
    oid: &str,
) -> Result<WorktreeFileContent> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    // Commit detail callers pass SHORT parent ids (7 chars), so resolve via
    // revparse instead of requiring a full 40-char object id.
    let commit = repo
        .revparse_single(oid)
        .map_err(|e| format!("invalid commit id {oid}: {}", e.message()))?
        .peel_to_commit()
        .map_err(err)?;
    let tree = commit.tree().map_err(err)?;
    let entry = tree
        .get_path(Path::new(path))
        .map_err(|_| format!("{path} not present in commit {oid}"))?;
    let blob = repo
        .find_object(entry.id(), Some(ObjectType::Blob))
        .map_err(err)?
        .peel_to_blob()
        .map_err(err)?;
    let bytes = blob.content();

    let language = language_for(path);
    if bytes.len() > MAX_DIFF_BYTES {
        return Ok(WorktreeFileContent { content: String::new(), binary: false, too_large: true, language });
    }
    if is_binary(bytes) {
        return Ok(WorktreeFileContent { content: String::new(), binary: true, too_large: false, language });
    }
    Ok(WorktreeFileContent {
        content: String::from_utf8_lossy(bytes).into_owned(),
        binary: false,
        too_large: false,
        language,
    })
}

// ---------------------------------------------------------------------------
// Commit detail: metadata + changed files + per-file diff at a commit
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    pub name: String,
    pub directory: String,
    /// M | A | D | R
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    /// Full message body (summary + paragraphs).
    pub message: String,
    pub author_name: String,
    pub author_initials: String,
    pub time_seconds: i64,
    pub is_merge: bool,
    /// Short oids of the parent commits (first parent first).
    pub parents: Vec<String>,
    pub files: Vec<CommitFileEntry>,
}

/// Per-file status + numstat for a commit, computed against its first parent.
pub fn build_commit_detail(repo_path: &Path, oid: &str) -> Result<CommitDetail> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let commit_oid = resolve_commit_oid(&repo, oid)?;
    let commit = repo.find_commit(commit_oid).map_err(err)?;

    let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let tree = commit.tree().map_err(err)?;

    let mut opts = DiffOptions::new();
    let mut diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(err)?;
    let _ = diff.find_similar(None);

    let mut files = Vec::new();
    for idx in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(idx) else { continue };
        let status = match delta.status() {
            Delta::Added => "A",
            Delta::Deleted => "D",
            Delta::Renamed => "R",
            _ => "M",
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let (name, directory) = split_path(&path);

        let mut additions = 0;
        let mut deletions = 0;
        if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, idx) {
            for h in 0..patch.num_hunks() {
                let Ok((_, hunk_len)) = patch.hunk(h) else { continue };
                for l in 0..hunk_len {
                    let Ok(line) = patch.line_in_hunk(h, l) else { continue };
                    match line.origin() {
                        '+' => additions += 1,
                        '-' => deletions += 1,
                        _ => {}
                    }
                }
            }
        }
        files.push(CommitFileEntry {
            path,
            previous_path: if status == "R" {
                delta.old_file().path().map(|path| path.to_string_lossy().into_owned())
            } else {
                None
            },
            name,
            directory,
            status: status.to_string(),
            additions,
            deletions,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let author = commit.author();
    let summary = commit.summary().unwrap_or_default().to_string();
    let message = commit.message().unwrap_or_default().trim_end().to_string();
    let parents = commit
        .parent_ids()
        .map(|id| id.to_string()[..7].to_string())
        .collect::<Vec<_>>();

    Ok(CommitDetail {
        oid: commit_oid.to_string(),
        short_oid: commit_oid.to_string()[..7].to_string(),
        summary,
        message,
        author_name: author.name().unwrap_or("Unknown").to_string(),
        author_initials: initials_for(author.name().unwrap_or("")),
        time_seconds: commit.time().seconds() as i64,
        is_merge: commit.parent_count() > 1,
        parents,
        files,
    })
}

/// Blob-level diff of `path` as of commit `oid`: parent blob vs commit blob.
pub fn read_commit_file_diff(
    repo_path: &Path,
    oid: &str,
    path: &str,
    previous_path: Option<&str>,
) -> Result<FileDiffContent> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let commit_oid = resolve_commit_oid(&repo, oid)?;
    let commit = repo.find_commit(commit_oid).map_err(err)?;
    let tree = commit.tree().map_err(err)?;
    let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());

    let blob_at = |tree: Option<&git2::Tree>, path: &str| -> Option<Vec<u8>> {
        let tree = tree?;
        let entry = tree.get_path(Path::new(path)).ok()?;
        repo.find_object(entry.id(), Some(ObjectType::Blob))
            .ok()?
            .peel_to_blob()
            .ok()
            .map(|blob| blob.content().to_vec())
    };

    let original = blob_at(parent_tree.as_ref(), previous_path.unwrap_or(path));
    let modified = blob_at(Some(&tree), path);
    let language = language_for(path);

    let too_large = original.as_ref().is_some_and(|b| b.len() > MAX_DIFF_BYTES)
        || modified.as_ref().is_some_and(|b| b.len() > MAX_DIFF_BYTES);
    if too_large {
        return Ok(FileDiffContent { original: None, modified: None, binary: false, too_large: true, language });
    }
    let binary = original.as_ref().is_some_and(|b| is_binary(b))
        || modified.as_ref().is_some_and(|b| is_binary(b));
    if binary {
        return Ok(FileDiffContent { original: None, modified: None, binary: true, too_large: false, language });
    }
    Ok(FileDiffContent {
        original: Some(decode(original.as_deref())),
        modified: Some(decode(modified.as_deref())),
        binary: false,
        too_large: false,
        language,
    })
}

/// Accepts a full/shorthand hex OID or the symbolic name HEAD.
fn resolve_commit_oid(repo: &Repository, oid: &str) -> Result<git2::Oid> {
    if oid.eq_ignore_ascii_case("HEAD") {
        return repo
            .head()
            .map_err(err)?
            .peel_to_commit()
            .map(|commit| commit.id())
            .map_err(err);
    }
    git2::Oid::from_str(oid).map_err(|e| format!("invalid commit id: {e}"))
}

// ---------------------------------------------------------------------------
// Branch operations: create / checkout / delete
// ---------------------------------------------------------------------------

/// Validates a user-supplied branch name the way git refs do.
fn validate_branch_name(name: &str) -> Result<()> {
    let invalid = name.is_empty()
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.contains("..")
        || name.contains("..\\")
        || name.contains(' ')
        || name.contains("..")
        || name.ends_with(".lock")
        || name.chars().any(|c| c.is_control() || "?*[]:\\".contains(c));
    if invalid {
        return Err(format!("invalid branch name: '{name}'"));
    }
    Ok(())
}

/// Creates a branch at HEAD; optionally checks it out afterwards.
/// Runs through the external git CLI (branch ops migrated off libgit2).
pub fn create_branch(repo_path: &Path, name: &str, checkout: bool) -> Result<()> {
    validate_branch_name(name)?;
    crate::gitcli::run_git(repo_path, &["branch", name]).map_err(|e| {
        if e.contains("already exists") {
            format!("branch '{name}' already exists")
        } else {
            e
        }
    })?;
    if checkout {
        checkout_branch(repo_path, name)?;
    }
    Ok(())
}

/// Checks out a local branch. The external git CLI is natively safe: it
/// refuses (with an error) when uncommitted working-tree changes would be
/// overwritten.
pub fn checkout_branch(repo_path: &Path, name: &str) -> Result<()> {
    crate::gitcli::run_git(repo_path, &["checkout", name]).map_err(|e| {
        if e.contains("did not match") || e.contains("not found") {
            format!("branch '{name}' not found")
        } else if e.contains("would be overwritten") || e.contains("untracked working tree") {
            format!("cannot checkout '{name}': your local changes would be overwritten — commit or stash first")
        } else {
            e
        }
    })?;
    Ok(())
}

/// True when `ancestor_oid` is reachable from `head_oid` (bounded walk).
fn is_ancestor(repo: &Repository, ancestor_oid: git2::Oid, head_oid: git2::Oid) -> Result<bool> {
    if ancestor_oid == head_oid {
        return Ok(true);
    }
    let mut revwalk = repo.revwalk().map_err(err)?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL).map_err(err)?;
    revwalk.push(head_oid).map_err(err)?;
    let mut visited = 0usize;
    for oid in revwalk {
        let oid = oid.map_err(err)?;
        if oid == ancestor_oid {
            return Ok(true);
        }
        visited += 1;
        if visited >= 5000 {
            break; // safety valve for very long histories
        }
    }
    Ok(false)
}

/// Deletes a merged local branch. `git branch -d` natively refuses the
/// current branch and branches with unmerged commits.
pub fn delete_branch(repo_path: &Path, name: &str) -> Result<()> {
    let current = crate::gitcli::current_branch(repo_path)?;
    if current == name {
        return Err("cannot delete the branch you are currently on".to_string());
    }
    crate::gitcli::run_git(repo_path, &["branch", "-d", name]).map_err(|e| {
        if e.contains("not found") || e.contains("did not match") {
            format!("branch '{name}' not found")
        } else if e.contains("not fully merged") {
            format!("branch '{name}' has unmerged commits — merge it into {current} first")
        } else {
            e
        }
    })?;
    Ok(())
}

/// Creates a branch at an arbitrary ref (branch name, `origin/x`, tag or
/// short oid); optionally checks it out afterwards.
pub fn create_branch_from(
    repo_path: &Path,
    name: &str,
    from_ref: &str,
    checkout: bool,
) -> Result<()> {
    validate_branch_name(name)?;
    crate::gitcli::run_git(repo_path, &["branch", name, from_ref]).map_err(|e| {
        if e.contains("already exists") {
            format!("branch '{name}' already exists")
        } else if e.contains("not a valid") || e.contains("unknown revision") {
            format!("cannot resolve '{from_ref}' — branch, tag or commit not found")
        } else {
            e
        }
    })?;
    if checkout {
        checkout_branch(repo_path, name)?;
    }
    Ok(())
}

/// Renames a local branch. `git branch -m` refuses the rename when the new
/// name collides; the current branch is refused here (HEAD would need to
/// move with it in this UI's flow).
pub fn rename_branch(repo_path: &Path, old_name: &str, new_name: &str) -> Result<()> {
    validate_branch_name(new_name)?;
    let current = crate::gitcli::current_branch(repo_path)?;
    if current == old_name {
        return Err("cannot rename the branch you are currently on".to_string());
    }
    crate::gitcli::run_git(repo_path, &["branch", "-m", old_name, new_name]).map_err(|e| {
        if e.contains("not found") {
            format!("branch '{old_name}' not found")
        } else if e.contains("already exists") {
            format!("branch '{new_name}' already exists")
        } else {
            e
        }
    })?;
    Ok(())
}

/// "Downloads" a cloud branch: creates a local branch from
/// `refs/remotes/<remote>/<name>` (with upstream tracking) and checks it out.
/// If a local branch with that name already exists, just checks it out.
pub fn checkout_remote_branch(repo_path: &Path, remote: &str, name: &str) -> Result<()> {
    let track = format!("{remote}/{name}");
    let local_exists = crate::gitcli::run_git(repo_path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok();
    if local_exists {
        // Already downloaded — switch to the local one.
        return checkout_branch(repo_path, name);
    }
    // `git checkout` creates a tracking branch straight from the remote tip.
    let created = crate::gitcli::run_git(repo_path, &["checkout", "-b", name, "--track", &track]);
    if created.is_ok() {
        return Ok(());
    }
    let err = created.unwrap_err();
    if err.contains("not found") || err.contains("did not match") || err.contains("invalid reference") {
        return Err(format!("remote branch '{remote}/{name}' not found — fetch first"));
    }
    Err(err)
}

/// Deletes a branch on the remote (cloud) via `git push --delete` so auth
/// flows through the user's credential helper like every network op.
pub fn delete_remote_branch(
    repo_path: &Path,
    remote: &str,
    name: &str,
) -> std::result::Result<crate::net::NetResult, String> {
    if name.is_empty() {
        return Err("branch name is empty".to_string());
    }
    crate::net::push_delete_remote(&repo_path.to_path_buf(), remote, name)
}

// ---------------------------------------------------------------------------
// Tag operations: create / delete
// ---------------------------------------------------------------------------

/// Creates a lightweight tag at HEAD (or an explicit oid).
pub fn create_tag(repo_path: &Path, name: &str) -> Result<()> {
    validate_tag_name(name)?;
    let repo = Repository::discover(repo_path).map_err(err)?;
    if repo
        .find_reference(&format!("refs/tags/{name}"))
        .is_ok()
    {
        return Err(format!("tag '{name}' already exists"));
    }
    let target = repo
        .head()
        .map_err(err)?
        .peel_to_commit()
        .map_err(err)?;
    repo.reference(
        &format!("refs/tags/{name}"),
        target.id(),
        false,
        "pigry: create tag",
    )
    .map_err(err)?;
    Ok(())
}

/// Deletes a tag by name. Unknown tags produce a clear error.
pub fn delete_tag(repo_path: &Path, name: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut reference = repo
        .find_reference(&format!("refs/tags/{name}"))
        .map_err(|_| format!("tag '{name}' not found"))?;
    reference.delete().map_err(err)?;;
    Ok(())
}

fn validate_tag_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.contains("..")
        || name.contains(' ')
        || name.ends_with(".lock")
        || name.chars().any(|c| c.is_control() || "?*[]:\\".contains(c))
    {
        return Err(format!("invalid tag name: '{name}'"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Stash management: apply / pop / drop by index
// ---------------------------------------------------------------------------

fn stash_action(repo_path: &Path, index: usize, pop: bool) -> Result<()> {
    let mut repo = Repository::discover(repo_path).map_err(err)?;
    let count = std::cell::Cell::new(0usize);
    repo.stash_foreach(|_, _, _| {
        count.set(count.get() + 1);
        true
    })
    .map_err(err)?;
    let count = count.get();
    if index >= count {
        return Err(format!("stash #{index} does not exist"));
    }
    let mut opts = git2::StashApplyOptions::new();
    opts.reinstantiate_index();
    if pop {
        repo.stash_pop(index, Some(&mut opts))
            .map_err(|e| format!("stash pop failed: {}", e.message()))
    } else {
        repo.stash_apply(index, Some(&mut opts))
            .map_err(|e| format!("stash apply failed: {}", e.message()))
    }
}

/// Applies stash `index` to the working tree, keeping the stash entry.
pub fn stash_apply(repo_path: &Path, index: usize) -> Result<()> {
    stash_action(repo_path, index, false)
}

/// Applies stash `index` and removes it from the stash list.
pub fn stash_pop(repo_path: &Path, index: usize) -> Result<()> {
    stash_action(repo_path, index, true)
}

/// Removes stash `index` from the list without applying it.
pub fn stash_drop(repo_path: &Path, index: usize) -> Result<()> {
    let mut repo = Repository::discover(repo_path).map_err(err)?;
    let count = std::cell::Cell::new(0usize);
    repo.stash_foreach(|_, _, _| {
        count.set(count.get() + 1);
        true
    })
    .map_err(err)?;
    let count = count.get();
    if index >= count {
        return Err(format!("stash #{index} does not exist"));
    }
    repo.stash_drop(index).map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Hunk-level staging
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkInfo {
    /// Position of this hunk within the file's unstaged diff (0-based).
    pub index: usize,
    /// "@@ -a,b +c,d @@" numbers.
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Trailing function context from the hunk header (may be empty).
    pub context: String,
    /// Single-line preview of the first changed line, for the UI.
    pub preview: String,
}


fn parse_hunk_header(header: &[u8]) -> (u32, u32, u32, u32, String) {
    let text = String::from_utf8_lossy(header);
    // Expected form: @@ -a[,b] +c[,d] @@ [context]
    let mut old_start = 1u32;
    let mut old_lines = 1u32;
    let mut new_start = 1u32;
    let mut new_lines = 1u32;
    let mut context = String::new();
    let parts: Vec<&str> = text.splitn(3, " @@").collect();
    if parts.len() >= 2 {
        let ranges = parts[0].trim_start_matches("@@");
        for (position, range) in ranges.split_whitespace().take(2).enumerate() {
            let range = range.trim_start_matches('-').trim_start_matches('+');
            let mut segs = range.split(',');
            let start: u32 = segs.next().and_then(|v| v.parse().ok()).unwrap_or(1);
            let lines: u32 = segs.next().and_then(|v| v.parse().ok()).unwrap_or(1);
            if position == 0 {
                old_start = start;
                old_lines = lines;
            } else {
                new_start = start;
                new_lines = lines;
            }
        }
        if let Some(trailing) = parts.get(2) {
            context = trailing.trim_start_matches("@@").trim().to_string();
        }
    }
    (old_start, old_lines, new_start, new_lines, context)
}

/// Stages only hunk `hunk_index` of `path` by applying that hunk's line
/// operations onto the index blob and writing the result back.
pub fn stage_hunk(repo_path: &Path, path: &str, hunk_index: usize) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(path)
        .include_untracked(true)
        .show_untracked_content(true)
        .recurse_untracked_dirs(true);
    let mut diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(err)?;
    diff.find_similar(None).map_err(err)?;
    let patch = git2::Patch::from_diff(&diff, 0)
        .map_err(|e| format!("no diff for {path}: {e}"))?
        .ok_or_else(|| format!("no diff for {path}"))?;
    if hunk_index >= patch.num_hunks() {
        return Err(format!("hunk #{hunk_index} does not exist for {path}"));
    }
    let (hunk, line_count) = patch.hunk(hunk_index).map_err(err)?;

    // Old content: index blob (empty for untracked files).
    let old_bytes = index_blob(&repo, path).unwrap_or_default();
    let old_text = String::from_utf8_lossy(&old_bytes);
    let had_trailing_newline = old_text.ends_with('\n');
    let mut old_lines: Vec<String> = if old_text.is_empty() {
        Vec::new()
    } else {
        let mut segs: Vec<String> =
            old_text.split('\n').map(|line| line.to_string()).collect();
        // Drop the phantom trailing element a final newline produces.
        if had_trailing_newline {
            segs.pop();
        }
        segs
    };
    let header = hunk.header();
    let (old_start, old_lines_count, _, _, _) = parse_hunk_header(header);
    // 1-based old_start → 0-based slice end.
    let prefix_end = (old_start as usize).saturating_sub(1).min(old_lines.len());
    let suffix_start = (prefix_end + old_lines_count as usize).min(old_lines.len());

    let mut parts: Vec<String> = Vec::new();
    parts.extend(old_lines[..prefix_end].iter().cloned());
    for l in 0..line_count {
        let line = patch.line_in_hunk(hunk_index, l).map_err(err)?;
        let content = String::from_utf8_lossy(line.content());
        match line.origin() {
            ' ' => parts.push(content.trim_end_matches('\n').to_string()),
            '+' => parts.push(content.trim_end_matches('\n').to_string()),
            '-' => {} // removed — skip
            _ => {}
        }
    }
    parts.extend(old_lines[suffix_start..].iter().cloned());
    let mut new_content = parts.join("\n");
    if had_trailing_newline && !new_content.ends_with("\n") {
        new_content.push('\n');
    }

    let mut index = repo.index().map_err(err)?;
    match index.get_path(Path::new(path), 0) {
        Some(entry) => {
            // Tracked: rewrite the entry blob with the patched content.
            index
                .add_frombuffer(&entry, new_content.as_bytes())
                .map_err(|e| format!("failed to stage hunk: {e}"))?;
        }
        None => {
            // Untracked: the whole file is one hunk — stage it directly.
            index
                .add_path(Path::new(path))
                .map_err(|e| format!("failed to stage file: {e}"))?;
        }
    }
    index.write().map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Unstage hunk — reverse-apply one staged hunk back into the worktree side
// ---------------------------------------------------------------------------

/// Lists hunks of a file's diff. `staged=false` → index→workdir (unstaged
/// changes); `staged=true` → HEAD→index (staged changes).
pub fn file_hunks(repo_path: &Path, path: &str, staged: bool) -> Result<Vec<HunkInfo>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(path)
        .include_untracked(true)
        .show_untracked_content(true)
        .recurse_untracked_dirs(true);

    let mut diff = if staged {
        let head_tree = repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(err)?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(err)?
    };
    let _ = diff.find_similar(None);

    let mut hunks = Vec::new();
    for idx in 0..diff.deltas().len() {
        let Ok(Some(patch)) = git2::Patch::from_diff(&diff, idx) else {
            continue;
        };
        for h in 0..patch.num_hunks() {
            let Ok((hunk, _line_count)) = patch.hunk(h) else {
                continue;
            };
            let (old_start, old_lines, new_start, new_lines, context) =
                parse_hunk_header(hunk.header());
            let mut preview = String::new();
            for l in 0.._line_count {
                let Ok(line) = patch.line_in_hunk(h, l) else { continue };
                if line.origin() == '+' || line.origin() == '-' {
                    let text = String::from_utf8_lossy(line.content()).trim().to_string();
                    if !text.is_empty() {
                        preview = format!("{}{}", line.origin(), text);
                        break;
                    }
                }
            }
            hunks.push(HunkInfo {
                index: h,
                old_start,
                old_lines,
                new_start,
                new_lines,
                context: context.trim().to_string(),
                preview,
            });
        }
    }
    Ok(hunks)
}

/// One emitted patch line of a line-level stage operation.
struct PatchLine {
    /// '+', '-' or ' '.
    origin: char,
    old_no: Option<u32>,
    new_no: Option<u32>,
    content: String,
}

/// Builds a minimal unified-diff hunk from the selected lines of one hunk.
///
/// Forward mode (`reverse = false`, stage): the patch applies to the index,
/// whose content equals the diff's old side.
/// - context lines are kept,
/// - selected additions are emitted as `+`, unselected additions omitted,
/// - selected deletions emitted as `-`, unselected deletions become context.
///
/// Reverse mode (`reverse = true`, unstage): the patch removes the selected
/// changes from the index, whose content equals the diff's NEW side — roles
/// swap: selected additions become `-`, selected deletions become `+`,
/// unselected additions become context, unselected deletions are omitted.
///
/// `base_start` is the hunk start in the apply-target file (old_start for
/// forward, new_start for reverse); `shift` is the cumulative delta of
/// previously emitted hunks. Returns None when no change line is selected.
fn build_selected_hunk(
    lines: &[PatchLine],
    selected_old: &[u32],
    selected_new: &[u32],
    base_start: u32,
    shift: i64,
    reverse: bool,
) -> Option<(String, i64)> {
    let old_sel = |no: Option<u32>| no.map(|n| selected_old.contains(&n)).unwrap_or(false);
    let new_sel = |no: Option<u32>| no.map(|n| selected_new.contains(&n)).unwrap_or(false);

    let mut emitted: Vec<(char, String)> = Vec::new();
    let mut any_change = false;
    for line in lines {
        let content = line.content.clone();
        match (reverse, line.origin) {
            (false, '+') if new_sel(line.new_no) => {
                emitted.push(('+', content));
                any_change = true;
            }
            (false, '-') if old_sel(line.old_no) => {
                emitted.push(('-', content));
                any_change = true;
            }
            (false, '-') => emitted.push((' ', content)),
            (false, ' ') => emitted.push((' ', content)),
            (true, '+') if new_sel(line.new_no) => {
                emitted.push(('-', content));
                any_change = true;
            }
            (true, '-') if old_sel(line.old_no) => {
                emitted.push(('+', content));
                any_change = true;
            }
            (true, '+') => emitted.push((' ', content)),
            (true, ' ') => emitted.push((' ', content)),
            _ => {}
        }
    }
    if !any_change {
        return None;
    }

    let old_count = emitted.iter().filter(|(o, _)| *o != '+').count() as u32;
    let new_count = emitted.iter().filter(|(o, _)| *o != '-').count() as u32;
    let mut body = format!(
        "@@ -{base_start},{old_count} +{},{} @@\n",
        base_start as i64 + shift,
        new_count
    );
    for (origin, content) in &emitted {
        let mut l = format!("{origin}{content}");
        if !l.ends_with('\n') {
            // Final line without a newline: mark it explicitly.
            l.push_str("\n\\ No newline at end of file\n");
        }
        body.push_str(&l);
    }
    Some((body, new_count as i64 - old_count as i64))
}

/// Stages (side = "unstaged") or un-stages (side = "staged") individual lines
/// of `path` by building a minimal patch and applying it to the index.
/// `selected_old` / `selected_new` are the old-file / new-file line numbers
/// highlighted in the diff viewer (either may be empty).
pub fn stage_lines(
    repo_path: &Path,
    path: &str,
    side: &str,
    selected_old: &[u32],
    selected_new: &[u32],
) -> Result<()> {
    if selected_old.is_empty() && selected_new.is_empty() {
        return Err("no lines selected".to_string());
    }
    let repo = Repository::discover(repo_path).map_err(err)?;
    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());

    let mut opts = DiffOptions::new();
    opts.pathspec(path)
        .include_untracked(true)
        .show_untracked_content(true)
        .recurse_untracked_dirs(true);
    let reverse = side == "staged";
    let mut diff = if reverse {
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(err)?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(err)?
    };

    let mut body = String::new();
    let mut shift: i64 = 0;
    for idx in 0..diff.deltas().len() {
        let Ok(Some(patch)) = git2::Patch::from_diff(&diff, idx) else {
            continue;
        };
        for h in 0..patch.num_hunks() {
            let (hunk, line_count) = patch.hunk(h).map_err(err)?;
            let (old_start, _, new_start, _, _) = parse_hunk_header(hunk.header());
            // The apply target's content equals this side of the diff.
            let base_start = if reverse { new_start } else { old_start };
            let mut lines: Vec<PatchLine> = Vec::new();
            for l in 0..line_count {
                let line = patch.line_in_hunk(h, l).map_err(err)?;
                let origin = line.origin();
                if origin == '\\' {
                    // EOF marker: attach to the previously emitted line.
                    if let Some(last) = lines.last_mut() {
                        let c = last.content.trim_end_matches('\n').to_string();
                        last.content = format!("{c}\n\\ No newline at end of file\n");
                    }
                    continue;
                }
                lines.push(PatchLine {
                    origin,
                    old_no: line.old_lineno(),
                    new_no: line.new_lineno(),
                    content: String::from_utf8_lossy(line.content()).to_string(),
                });
            }
            if let Some((hunk_body, delta)) =
                build_selected_hunk(&lines, selected_old, selected_new, base_start, shift, reverse)
            {
                body.push_str(&hunk_body);
                shift += delta;
            }
        }
    }
    if body.is_empty() {
        return Err("no stageable lines in the selection".to_string());
    }

    let text = format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n{body}");
    let parsed = git2::Diff::from_buffer(text.as_bytes()).map_err(err)?;
    repo.apply(&parsed, git2::ApplyLocation::Index, None)
        .map_err(err)?;
    Ok(())
}

/// A commit message composed from the staged diff.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedCommitMessage {
    pub title: String,
    pub body: String,
}

/// Composes a conventional-style commit message from the staged changes:
/// the type comes from the touched paths (docs/tests/CI/additions), the
/// subject lists the changed files, and the body groups the diffstats.
/// Fully deterministic — no AI service involved.
pub fn compose_commit_message(repo_path: &Path) -> Result<ComposedCommitMessage> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, None)
        .map_err(err)?;
    let _ = diff.find_similar(None);

    struct FileChange {
        path: String,
        status: char,
        additions: usize,
        deletions: usize,
        is_new: bool,
    }
    let mut files: Vec<FileChange> = Vec::new();
    let mut total_add = 0usize;
    let mut total_del = 0usize;
    for idx in 0..diff.deltas().len() {
        let delta = diff.get_delta(idx).ok_or_else(|| "missing delta".to_string())?;
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let status = match delta.status() {
            git2::Delta::Added => 'A',
            git2::Delta::Deleted => 'D',
            _ => 'M',
        };
        let (additions, deletions) = match git2::Patch::from_diff(&diff, idx) {
            Ok(Some(patch)) => {
                // (context, additions, deletions)
                let (_, added, removed) = patch.line_stats().map_err(err)?;
                (added, removed)
            }
            _ => (0, 0),
        };
        total_add += additions;
        total_del += deletions;
        files.push(FileChange {
            is_new: status == 'A',
            status,
            additions,
            deletions,
            path,
        });
    }
    if files.is_empty() {
        return Err("nothing staged to compose a message from".to_string());
    }

    let is_docs = files.iter().all(|f| {
        f.path.ends_with(".md") || f.path.starts_with("docs/") || f.path.starts_with("doc/")
    });
    let is_tests = files.iter().all(|f| {
        let p = f.path.to_lowercase();
        p.starts_with("tests/") || p.ends_with("_test.rs") || p.contains(".test.") || p.contains(".spec.")
    });
    let is_ci = files
        .iter()
        .all(|f| f.path.starts_with(".github/") || f.path.contains("ci") || f.path.contains("workflow"));
    let has_new = files.iter().any(|f| f.is_new);
    let only_deletions = files.iter().all(|f| f.status == 'D');
    let deletion_dominant = total_del > total_add * 2 && !has_new;

    let (kind, verb) = if only_deletions {
        ("chore", "remove")
    } else if is_docs {
        ("docs", "update")
    } else if is_tests {
        ("test", "cover")
    } else if is_ci {
        ("ci", "update")
    } else if deletion_dominant {
        ("refactor", "rework")
    } else if has_new {
        ("feat", "add")
    } else {
        ("chore", "update")
    };

    // Scope: the deepest directory prefix shared by every file.
    let dir_of = |p: &str| match p.rfind('/') {
        Some(i) => p[..i].to_string(),
        None => String::new(),
    };
    let scope = {
        let first = dir_of(&files[0].path);
        let common = files
            .iter()
            .all(|f| dir_of(&f.path) == first);
        if common && !first.is_empty() {
            first.rsplit('/').next().unwrap_or(&first).to_string()
        } else {
            String::new()
        }
    };

    let basename = |p: &str| {
        p.rsplit('/').next().unwrap_or(p).to_string()
    };
    let mut names: Vec<String> = Vec::new();
    for f in files.iter().take(3) {
        names.push(basename(&f.path));
    }
    let more = files.len().saturating_sub(3);
    let mut subject = format!("{} {}", verb, names.join(", "));
    if more > 0 {
        subject.push_str(&format!(" (+{more} more)"));
    }
    let mut title = if scope.is_empty() {
        format!("{kind}: {subject}")
    } else {
        format!("{kind}({scope}): {subject}")
    };
    if title.chars().count() > 72 {
        let cut: String = title.chars().take(69).collect();
        title = format!("{cut}...");
    }

    // Body: one bullet per file, grouped by directory.
    let mut body = String::new();
    let mut last_dir = String::new();
    let shown = files.len().min(12);
    for f in &files[..shown] {
        let dir = dir_of(&f.path);
        if dir != last_dir {
            if !last_dir.is_empty() {
                body.push('\n');
            }
            body.push_str(&format!("{dir}/\n"));
            last_dir = dir;
        }
        body.push_str(&format!(
            "- {} (+{}/−{})\n",
            basename(&f.path),
            f.additions,
            f.deletions
        ));
    }
    if files.len() > shown {
        body.push_str(&format!("… and {} more\n", files.len() - shown));
    }
    let body = body.trim_end().to_string();
    let _ = total_add;
    let _ = total_del;

    Ok(ComposedCommitMessage { title, body })
}

/// Unified diff of the staged changes, truncated to `max_chars` — the raw
/// material for AI commit-message generation.
pub fn staged_diff_preview(repo_path: &Path, max_chars: usize) -> Result<String> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, None)
        .map_err(err)?;
    let _ = diff.find_similar(None);
    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        if out.len() < max_chars {
            out.push_str(&String::from_utf8_lossy(line.content()));
        }
        true
    })
    .map_err(err)?;
    if out.len() > max_chars {
        out.truncate(max_chars);
        out.push_str("\n… (diff truncated)");
    }
    if out.trim().is_empty() {
        return Err("nothing staged".to_string());
    }
    Ok(out)
}

/// A registered git submodule of the open repository.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub name: String,
    /// Path relative to the repository root (slash-normalized).
    pub path: String,
    /// Absolute path of the submodule worktree, for opening it as a workspace.
    pub abs_path: String,
    pub url: String,
    /// True when the submodule's checked-out commit differs from the recorded one.
    pub dirty: bool,
}

/// All submodules registered in `.gitmodules`.
pub fn list_submodules(repo_path: &Path) -> Result<Vec<SubmoduleInfo>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let workdir = repo.workdir().unwrap_or_else(|| repo.path());
    let mut out = Vec::new();
    for sub in repo.submodules().map_err(err)? {
        let name = sub.name().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let rel = sub.path().to_string_lossy().replace('\\', "/");
        let dirty = match (sub.workdir_id(), sub.index_id()) {
            (Some(w), Some(i)) => w != i,
            // Initialized in the index but not checked out yet.
            (Some(_), None) => true,
            _ => false,
        };
        out.push(SubmoduleInfo {
            name,
            abs_path: workdir.join(&rel).to_string_lossy().replace('\\', "/"),
            path: rel,
            url: sub.url().unwrap_or("").to_string(),
            dirty,
        });
    }
    Ok(out)
}

/// A linked worktree of the open repository.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    pub branch: String,
    /// True when this worktree is the currently open workspace.
    pub is_current: bool,
}

fn normalize_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// All linked worktrees, with the branch each one has checked out. The
/// current worktree (whatever path the repo was opened from) is listed first;
/// git2's `worktrees()` only covers linked entries, so the current one is
/// added here and duplicates are dropped.
pub fn list_worktrees(repo_path: &Path, active_path: &str) -> Result<Vec<WorktreeInfo>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let active = normalize_path(active_path);
    let mut out = Vec::new();

    // The current worktree: HEAD read through the opened repo.
    let current_path = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let current_branch = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(str::to_string))
        .unwrap_or_else(|| "detached".to_string());
    let current_name = current_path
        .rsplit('/')
        .next()
        .unwrap_or(&current_path)
        .to_string();
    out.push(WorktreeInfo {
        name: current_name,
        is_current: normalize_path(&current_path) == active,
        path: current_path.clone(),
        branch: current_branch,
    });

    for name in repo.worktrees().map_err(err)?.iter().flatten() {
        let wt = repo.find_worktree(name).map_err(err)?;
        let path = wt
            .path()
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string();
        if normalize_path(&path) == normalize_path(&current_path) {
            continue; // the current worktree is already listed above
        }
        let branch = {
            let wt_repo = Repository::open(wt.path());
            let head = wt_repo.as_ref().ok().and_then(|r| r.head().ok());
            head.and_then(|h| h.shorthand().map(str::to_string))
                .unwrap_or_else(|| "detached".to_string())
        };
        out.push(WorktreeInfo {
            name: name.to_string(),
            is_current: normalize_path(&path) == active,
            path,
            branch,
        });
    }
    Ok(out)
}

/// Un-stages hunk `hunk_index` of `path`: reverse-applies the staged hunk
/// onto the index so those lines return to their HEAD state in the index,
/// while other hunks of the file stay staged.
pub fn unstage_hunk(repo_path: &Path, path: &str, hunk_index: usize) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());

    let mut opts = DiffOptions::new();
    opts.pathspec(path).include_untracked(true);
    let mut diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
        .map_err(err)?;
    let _ = diff.find_similar(None);
    let patch = git2::Patch::from_diff(&diff, 0)
        .map_err(|e| format!("no staged diff for {path}: {e}"))?
        .ok_or_else(|| format!("no staged diff for {path}"))?;
    if hunk_index >= patch.num_hunks() {
        return Err(format!("hunk #{hunk_index} does not exist for {path}"));
    }
    let (hunk, line_count) = patch.hunk(hunk_index).map_err(err)?;
    let (new_start, new_lines, _, _, _) = parse_hunk_header(hunk.header());

    // Current index content for the path (empty when the file was added).
    let index_bytes = index_blob(&repo, path).unwrap_or_default();
    let index_text = String::from_utf8_lossy(&index_bytes);
    let had_trailing_newline = index_text.ends_with('\n');
    let mut index_lines: Vec<String> = if index_text.is_empty() {
        Vec::new()
    } else {
        let mut segs: Vec<String> =
            index_text.split('\n').map(|line| line.to_string()).collect();
        if had_trailing_newline {
            segs.pop(); // phantom trailing element
        }
        segs
    };

    let prefix_end = (new_start as usize).saturating_sub(1).min(index_lines.len());
    let suffix_start = (prefix_end + new_lines as usize).min(index_lines.len());

    // Rebuild the hunk's span: context lines stay, '+' lines are removed
    // (they were the staged additions), '-' lines return (HEAD content).
    let mut parts: Vec<String> = Vec::new();
    parts.extend(index_lines[..prefix_end].iter().cloned());
    let mut span_has_content = false;
    for l in 0..line_count {
        let line = patch.line_in_hunk(hunk_index, l).map_err(err)?;
        let content = String::from_utf8_lossy(line.content());
        let trimmed = content.trim_end_matches('\n').to_string();
        match line.origin() {
            ' ' => {
                parts.push(trimmed);
                span_has_content = true;
            }
            '-' => {
                parts.push(trimmed);
                span_has_content = true;
            }
            '+' => {} // staged addition — remove it
            _ => {}
        }
    }
    parts.extend(index_lines[suffix_start..].iter().cloned());

    let mut index = repo.index().map_err(err)?;
    if parts.is_empty() || (!span_has_content && parts.len() == prefix_end + (index_lines.len() - suffix_start)) {
        // Nothing left in the file after unstaging this hunk — drop the entry.
        if index.get_path(Path::new(path), 0).is_some() {
            index
                .remove_path(Path::new(path))
                .map_err(|e| format!("failed to remove emptied entry: {e}"))?;
            index.write().map_err(err)?;
            return Ok(());
        }
    }

    let mut new_content = parts.join("\n");
    if had_trailing_newline && !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    match index.get_path(Path::new(path), 0) {
        Some(entry) => {
            index
                .add_frombuffer(&entry, new_content.as_bytes())
                .map_err(|e| format!("failed to unstage hunk: {e}"))?;
        }
        None => {
            // The path has no index entry (added file fully emptied above is
            // handled; this branch covers partial unstage of an added file).
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o100644,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: git2::Oid::zero(),
                path: path.as_bytes().to_vec(),
                flags: 0,
                flags_extended: 0,
            };
            index
                .add_frombuffer(&entry, new_content.as_bytes())
                .map_err(|e| format!("failed to unstage hunk: {e}"))?;
        }
    }
    index.write().map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Discard hunk — revert one unstaged hunk in the worktree to match the index
// ---------------------------------------------------------------------------

/// Reverts hunk `hunk_index` of `path`'s unstaged diff in the worktree:
/// '+' lines (worktree additions) are removed, '-' lines (index content)
/// are restored, context is kept. Untracked files are deleted when their
/// whole content is discarded.
pub fn discard_hunk(repo_path: &Path, path: &str, hunk_index: usize) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(path)
        .include_untracked(true)
        .show_untracked_content(true)
        .recurse_untracked_dirs(true);
    let mut diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(err)?;
    let _ = diff.find_similar(None);
    let patch = git2::Patch::from_diff(&diff, 0)
        .map_err(|e| format!("no unstaged diff for {path}: {e}"))?
        .ok_or_else(|| format!("no unstaged diff for {path}"))?;
    if hunk_index >= patch.num_hunks() {
        return Err(format!("hunk #{hunk_index} does not exist for {path}"));
    }
    let (hunk, line_count) = patch.hunk(hunk_index).map_err(err)?;
    let (_, _, new_start, new_lines, _) = parse_hunk_header(hunk.header());

    // Worktree content (empty for deleted or untracked files).
    let workdir_path = repo.workdir().ok_or("bare repository")?.join(path);
    let wt_bytes = std::fs::read(&workdir_path).unwrap_or_default();
    let wt_text = String::from_utf8_lossy(&wt_bytes);
    let had_trailing_newline = wt_text.ends_with('\n');
    let mut wt_lines: Vec<String> = if wt_text.is_empty() {
        Vec::new()
    } else {
        let mut segs: Vec<String> =
            wt_text.split('\n').map(|line| line.to_string()).collect();
        if had_trailing_newline {
            segs.pop(); // phantom trailing element
        }
        segs
    };

    let prefix_end = (new_start as usize).saturating_sub(1).min(wt_lines.len());
    let suffix_start = (prefix_end + new_lines as usize).min(wt_lines.len());

    let mut parts: Vec<String> = Vec::new();
    parts.extend(wt_lines[..prefix_end].iter().cloned());
    let mut last_hunk_line_had_nl = false;
    for l in 0..line_count {
        let line = patch.line_in_hunk(hunk_index, l).map_err(err)?;
        let content = String::from_utf8_lossy(line.content());
        last_hunk_line_had_nl = content.ends_with('\n');
        let trimmed = content.trim_end_matches('\n').to_string();
        match line.origin() {
            ' ' => parts.push(trimmed),   // context stays
            '+' => {}                     // worktree addition — reverted
            '-' => parts.push(trimmed),   // index content restored
            _ => {}
        }
    }
    parts.extend(wt_lines[suffix_start..].iter().cloned());

    // libgit2 mmaps workdir files while diffing; the mapping keeps the file
    // write-locked on Windows (os error 1224), so release every handle
    // before touching the filesystem.
    drop(patch);
    drop(diff);
    drop(repo);

    if parts.is_empty() {
        // Nothing remains — delete the file (untracked or fully reverted).
        std::fs::remove_file(&workdir_path).map_err(|e| format!("failed to discard: {e}"))?;
        return Ok(());
    }

    let mut new_content = parts.join("\n");
    let restore_nl = had_trailing_newline || last_hunk_line_had_nl;
    if restore_nl && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    std::fs::write(&workdir_path, new_content)
        .map_err(|e| format!("failed to write {path}: {e}"))?;
    Ok(())
}


// ---------------------------------------------------------------------------
// Full-text code search across the worktree (VS Code-style)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchHit {
    pub path: String,
    /// 1-based line number of the match.
    pub line: u32,
    /// 1-based column of the match.
    pub column: u32,
    /// The matched line's text, trimmed for display.
    pub text: String,
}

/// Case-insensitive substring search over every text file in the worktree.
/// Binary and oversized files are skipped; results are capped.
pub fn search_worktree_code(
    repo_path: &Path,
    query: &str,
    max_hits: usize,
) -> Result<Vec<CodeSearchHit>> {
    let query = query.to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let tree = list_tree(repo_path)?;
    let workdir = {
        let repo = Repository::discover(repo_path).map_err(err)?;
        repo.workdir().ok_or("bare repository")?.to_path_buf()
    };

    let mut hits = Vec::new();
    const MAX_FILE_BYTES: u64 = 1_000_000;
    const MAX_LINE_LEN: usize = 300;
    for path in &tree.entries {
        if hits.len() >= max_hits {
            break;
        }
        let full = workdir.join(path);
        let Ok(meta) = std::fs::metadata(&full) else { continue };
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&full) else { continue };
        if bytes.contains(&0) {
            continue; // binary
        }
        let content = String::from_utf8_lossy(&bytes);
        let mut per_file = 0usize;
        for (index, line) in content.lines().enumerate() {
            if hits.len() >= max_hits || per_file >= 10 {
                break;
            }
            let lower = line.to_lowercase();
            if let Some(at) = lower.find(&query) {
                let display = line.trim();
                let display = if display.len() > MAX_LINE_LEN {
                    // UTF-8-safe truncation: never split a multi-byte char.
                    let mut end = MAX_LINE_LEN;
                    while end > 0 && !display.is_char_boundary(end) {
                        end -= 1;
                    }
                    format!("{}…", &display[..end])
                } else {
                    display.to_string()
                };
                let leading = line.len() - line.trim_start().len();
                hits.push(CodeSearchHit {
                    path: path.clone(),
                    line: index as u32 + 1,
                    column: (leading + at) as u32 + 1,
                    text: display,
                });
                per_file += 1;
            }
        }
    }
    Ok(hits)
}

// ---------------------------------------------------------------------------
// Blame annotations — per-line commit attribution
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based line number in the worktree file.
    pub line: u32,
    pub short_oid: String,
    /// Full commit oid, for jump-to-commit from the blame popup.
    pub oid: String,
    pub author_name: String,
    pub author_email: String,
    pub author_initials: String,
    pub time_seconds: i64,
    pub summary: String,
    /// Full commit message (summary + body).
    pub message: String,
    /// True when the line has uncommitted worktree changes.
    pub uncommitted: bool,
    /// Stats of the blamed commit vs its parent (worktree blame only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insertions: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<i64>,
}

/// Insertions/deletions/files of a commit's diff against its first parent
/// (empty tree for root commits).
fn commit_stats(repo: &Repository, commit_id: git2::Oid) -> Result<(u32, i64, i64)> {
    let commit = repo.find_commit(commit_id).map_err(err)?;
    let tree = commit.tree().map_err(err)?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(err)?;
    let stats = diff.stats().map_err(err)?;
    Ok((
        stats.files_changed() as u32,
        stats.insertions() as i64,
        stats.deletions() as i64,
    ))
}

/// Per-line blame of `path` as it exists at `ref_name` — no checkout needed.
/// Uses `git blame --porcelain <ref> -- <path>` and parses the porcelain stream.
pub fn blame_at(repo_path: &Path, path: &str, ref_name: &str) -> Result<Vec<BlameLine>> {
    use std::process::Command;

    let output = Command::new("git").no_window()
        .args(["blame", "--porcelain", ref_name, "--", path])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();

    let mut out: Vec<BlameLine> = Vec::new();
    let mut oid = String::new();
    let mut author_name = String::new();
    let mut author_email = String::new();
    let mut time_seconds: i64 = 0;
    let mut summary = String::new();
    let mut hunk_start: u64 = 0;
    let mut in_hunk_index: u64 = 0;
    // Porcelain prints the commit metadata only for a commit's first hunk,
    // so remember it per oid and restore it when the commit reappears.
    let mut metas: std::collections::HashMap<String, (String, String, i64, String)> =
        std::collections::HashMap::new();

    for line in text.lines() {
        if line.starts_with('\t') {
            // Content line: the first line of a hunk sits at `hunk_start`
            // itself, so use the index before advancing it.
            let line_no = (hunk_start + in_hunk_index) as u32;
            in_hunk_index += 1;
            let initials: String = author_name.chars().take(2).collect::<String>().to_uppercase();
            metas.insert(
                oid.clone(),
                (
                    author_name.clone(),
                    author_email.clone(),
                    time_seconds,
                    summary.clone(),
                ),
            );
            out.push(BlameLine {
                line: line_no,
                short_oid: oid.chars().take(7).collect(),
                oid: oid.clone(),
                author_name: author_name.clone(),
                author_email: author_email.clone(),
                author_initials: initials,
                time_seconds,
                summary: summary.clone(),
                message: summary.clone(),
                uncommitted: false,
                files_changed: None,
                insertions: None,
                deletions: None,
            });
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() >= 3
            && tokens[0].len() >= 8
            && tokens[0].chars().all(|c| c.is_ascii_hexdigit())
            && tokens[1].chars().all(|c| c.is_ascii_hexdigit())
            && tokens[2].chars().all(|c| c.is_ascii_hexdigit())
        {
            oid = tokens[0].to_string();
            hunk_start = tokens[2].parse::<u64>().unwrap_or(0);
            in_hunk_index = 0;
            match metas.get(&oid) {
                Some((name, email, time, sum)) => {
                    author_name = name.clone();
                    author_email = email.clone();
                    time_seconds = *time;
                    summary = sum.clone();
                }
                None => {
                    author_name.clear();
                    author_email.clear();
                    summary.clear();
                    time_seconds = 0;
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("author ") {
            author_name = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("author-mail ") {
            author_email = rest.trim_start_matches('<').trim_end_matches('>').to_string();
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            time_seconds = rest.parse::<i64>().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("summary ") {
            summary = rest.to_string();
        }
    }
    Ok(out)
}

pub fn file_blame(repo_path: &Path, path: &str) -> Result<Vec<BlameLine>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut opts = git2::BlameOptions::new();
    opts.track_copies_same_file(true);
    let blame = repo
        .blame_file(Path::new(path), Some(&mut opts))
        .map_err(|e| format!("blame failed for {path}: {e}"))?;

    let mut lines = Vec::new();
    // Commit stats computed once per commit — blame hunks share commits.
    let mut stats_cache: std::collections::HashMap<git2::Oid, (u32, i64, i64)> =
        std::collections::HashMap::new();
    for i in 0..blame.len() {
        let Some(hunk) = blame.get_index(i) else { continue; };
        let start = hunk.final_start_line() as u32;
        let count = hunk.lines_in_hunk() as u32;
        let commit_id = hunk.final_commit_id();

        if commit_id.is_zero() {
            // Uncommitted worktree changes.
            for offset in 0..count {
                lines.push(BlameLine {
                    line: start + offset,
                    short_oid: "———".to_string(),
                    oid: String::new(),
                    author_name: "Uncommitted".to_string(),
                    author_email: String::new(),
                    author_initials: "—".to_string(),
                    time_seconds: 0,
                    summary: String::new(),
                    message: String::new(),
                    uncommitted: true,
                    files_changed: None,
                    insertions: None,
                    deletions: None,
                });
            }
            continue;
        }

        let commit = repo.find_commit(commit_id).map_err(err)?;
        let author = commit.author();
        let author_name = author.name().unwrap_or("Unknown").to_string();
        let author_email = author.email().unwrap_or("").to_string();
        let summary = commit.summary().unwrap_or_default().to_string();
        let message = commit.message().unwrap_or_default().trim_end().to_string();
        let short_oid = commit_id.to_string()[..7].to_string();
        let time_seconds = commit.time().seconds() as i64;
        let initials = initials_for(&author_name);
        let (files_changed, insertions, deletions) = match stats_cache.get(&commit_id) {
            Some(stats) => *stats,
            None => {
                let stats = commit_stats(&repo, commit_id).unwrap_or((0, 0, 0));
                stats_cache.insert(commit_id, stats);
                stats
            }
        };

        for offset in 0..count {
            lines.push(BlameLine {
                line: start + offset,
                short_oid: short_oid.clone(),
                oid: commit_id.to_string(),
                author_name: author_name.clone(),
                author_email: author_email.clone(),
                author_initials: initials.clone(),
                time_seconds,
                summary: summary.clone(),
                message: message.clone(),
                uncommitted: false,
                files_changed: Some(files_changed),
                insertions: Some(insertions),
                deletions: Some(deletions),
            });
        }
    }
    lines.sort_by_key(|line| line.line);
    Ok(lines)
}

// ---------------------------------------------------------------------------
// Diff gutter — per-line change status vs HEAD for the editor margin
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineChange {
    /// 1-based line number in the worktree file.
    pub line: u32,
    /// "added" (new line) or "modified" (existing line with changed content).
    pub change: String,
}

/// Per-line change status of a file vs HEAD, for editor gutter decorations.
/// Deletions are not reported (they have no position in the current file).
pub fn line_changes(repo_path: &Path, path: &str) -> Result<Vec<LineChange>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.pathspec(path);
    let mut diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
        .map_err(err)?;
    let _ = diff.find_similar(None);

    let mut changes = Vec::new();
    for idx in 0..diff.deltas().len() {
        let Ok(Some(patch)) = git2::Patch::from_diff(&diff, idx) else {
            continue;
        };
        for h in 0..patch.num_hunks() {
            let Ok((hunk, line_count)) = patch.hunk(h) else { continue };
            let (_, _, new_start, _, _) = parse_hunk_header(hunk.header());

            let mut new_line = new_start;
            let mut del_count = 0usize;
            let mut pending_adds: Vec<u32> = Vec::new();

            let flush = |pending: &mut Vec<u32>, dels: usize, out: &mut Vec<LineChange>| {
                let kind = if dels > 0 { "modified" } else { "added" };
                for pos in pending.drain(..) {
                    out.push(LineChange {
                        line: pos,
                        change: kind.to_string(),
                    });
                }
            };

            for l in 0..line_count {
                let line = patch.line_in_hunk(h, l).map_err(err)?;
                match line.origin() {
                    '+' => {
                        pending_adds.push(new_line);
                        new_line += 1;
                    }
                    '-' => {
                        del_count += 1;
                    }
                    ' ' => {
                        flush(&mut pending_adds, del_count, &mut changes);
                        del_count = 0;
                        new_line += 1;
                    }
                    _ => {}
                }
            }
            flush(&mut pending_adds, del_count, &mut changes);
        }
    }
    changes.sort_by_key(|c| c.line);
    Ok(changes)
}

#[cfg(test)]
mod binary_write_tests {
    use super::write_worktree_binary;
    use std::path::Path;

    #[test]
    fn binary_writes_are_limited_to_pigry_images() {
        let repo = Path::new(".");
        for bad in ["src/a.png", ".pigry/../a.png", ".pigry/a.exe", ".pigry/a.txt", "C:/x.png", "/etc/a.png", ""] {
            assert!(write_worktree_binary(repo, bad, "AA==").is_err(), "should reject {bad}");
        }
        let err = write_worktree_binary(repo, ".pigry/a.png", "not base64!!").unwrap_err();
        assert!(err.contains("base64"), "bad payloads are rejected before touching the disk: {err}");
    }

    #[test]
    fn chunked_writes_allow_audio_only_under_pigry_audio() {
        use super::write_worktree_binary_chunk;
        let repo = Path::new(".");
        for bad in ["src/a.wav", ".pigry/a.wav", ".pigry/audio/../a.wav", ".pigry/audio/a.exe", ".pigry/audio/a.txt", "C:/x.wav", ""] {
            assert!(write_worktree_binary_chunk(repo, bad, "AA==", false).is_err(), "should reject {bad}");
        }
        let err = write_worktree_binary_chunk(repo, ".pigry/audio/media/a.wav", "not base64!!", false).unwrap_err();
        assert!(err.contains("base64"), "{err}");
    }
}
