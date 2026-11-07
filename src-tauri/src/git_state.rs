//! Git operations via libgit2. All functions are synchronous and return
//! `Result<_, String>` so Tauri commands can surface errors to the UI.

use std::collections::BTreeMap;
use std::path::Path;

use git2::{
    build::CheckoutBuilder, BranchType, Delta, DiffOptions, ObjectType, Repository, Status,
    StatusOptions,
};
use serde::Serialize;

#[cfg(test)]
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
    pub additions: u32,
    pub deletions: u32,
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
    additions: u32,
    deletions: u32,
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
        let conflicted = flags.contains(Status::CONFLICTED);
        if conflicted {
            // Conflicts are out of scope for M2 — skip rather than misreport.
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
        branches.push(BranchInfo { name, is_head });
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
    let mut index = repo.index().map_err(err)?;
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

    let signature = repo.signature().map_err(err)?;
    let tree_oid = index.write_tree().map_err(err)?;
    let tree = repo.find_tree(tree_oid).map_err(err)?;
    let head = repo.head().ok().map(|h| h.peel_to_commit()).transpose().map_err(err)?;

    let oid = if amend {
        let head = head.ok_or("nothing to amend — HEAD not found")?;
        head.amend(Some("HEAD"), Some(&signature), Some(&signature), None, Some(&message), Some(&tree))
            .map_err(err)?
    } else {
        let parents: Vec<&git2::Commit> = head.as_ref().map(|c| vec![c]).unwrap_or_default();
        repo.commit(Some("HEAD"), &signature, &signature, &message, &tree, &parents)
            .map_err(err)?
    };

    Ok(oid.to_string())
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRow {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
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
    /// Branch labels pointing at this commit ("main", "origin/main").
    pub refs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitHistory {
    pub total: usize,
    pub truncated: bool,
    pub commits: Vec<CommitRow>,
}

pub fn build_commit_history(repo_path: &Path, include_remotes: bool) -> Result<CommitHistory> {
    let repo = Repository::discover(repo_path).map_err(err)?;

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
            author_initials: initials_for(&commit.author().name().unwrap_or("")),
            time_seconds: commit.time().seconds() as i64,
            lane: lane as u32,
            parent_lanes,
            active_before,
            active_after,
            is_head: head_oid == Some(oid),
            is_merge: parents.len() > 1,
            refs: labels,
        });
    }

    Ok(CommitHistory { total, truncated, commits })
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
    /// Paths with pending changes, for status dots on the tree.
    pub changed_paths: Vec<String>,
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
    let mut changed_paths = Vec::new();
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
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED,
        ) && !changed_paths.contains(&path)
        {
            changed_paths.push(path);
        }
    }

    paths.sort();
    changed_paths.sort();
    Ok(FileTree { entries: paths, changed_paths })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFileContent {
    pub content: String,
    pub binary: bool,
    pub too_large: bool,
    pub language: String,
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
    if bytes.len() > MAX_DIFF_BYTES {
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
pub fn build_file_history(repo_path: &Path, path: &str) -> Result<Vec<FileCommitEntry>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut revwalk = repo.revwalk().map_err(err)?;
    revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL).map_err(err)?;
    revwalk.push_head().map_err(err)?;

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
        let tree = commit.tree().map_err(err)?;

        let entry = match tree.get_path(Path::new(path)) {
            Ok(entry) => entry,
            Err(_) => continue, // path not present in this commit
        };
        // Only include commits where the blob differs from the first parent
        // (or the path is new relative to it).
        let changed = match commit.parent(0) {
            Ok(parent) => match parent.tree() {
                Ok(parent_tree) => match parent_tree.get_path(Path::new(path)) {
                    Ok(parent_entry) => parent_entry.id() != entry.id(),
                    Err(_) => true, // newly added in this commit
                },
                Err(_) => true,
            },
            Err(_) => true, // root commit
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
    let commit_oid = git2::Oid::from_str(oid).map_err(|e| format!("invalid commit id: {e}"))?;
    let commit = repo.find_commit(commit_oid).map_err(err)?;
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
    pub name: String,
    pub directory: String,
    /// M | A | D | R
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
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

    Ok(CommitDetail {
        oid: commit_oid.to_string(),
        short_oid: commit_oid.to_string()[..7].to_string(),
        summary,
        message,
        author_name: author.name().unwrap_or("Unknown").to_string(),
        author_initials: initials_for(author.name().unwrap_or("")),
        time_seconds: commit.time().seconds() as i64,
        is_merge: commit.parent_count() > 1,
        files,
    })
}

/// Blob-level diff of `path` as of commit `oid`: parent blob vs commit blob.
pub fn read_commit_file_diff(
    repo_path: &Path,
    oid: &str,
    path: &str,
) -> Result<FileDiffContent> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let commit_oid = resolve_commit_oid(&repo, oid)?;
    let commit = repo.find_commit(commit_oid).map_err(err)?;
    let tree = commit.tree().map_err(err)?;
    let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());

    let blob_at = |tree: Option<&git2::Tree>| -> Option<Vec<u8>> {
        let tree = tree?;
        let entry = tree.get_path(Path::new(path)).ok()?;
        repo.find_object(entry.id(), Some(ObjectType::Blob))
            .ok()?
            .peel_to_blob()
            .ok()
            .map(|blob| blob.content().to_vec())
    };

    let original = blob_at(parent_tree.as_ref());
    let modified = blob_at(Some(&tree));
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
pub fn create_branch(repo_path: &Path, name: &str, checkout: bool) -> Result<()> {
    validate_branch_name(name)?;
    let repo = Repository::discover(repo_path).map_err(err)?;
    let head = repo
        .head()
        .map_err(err)?
        .peel_to_commit()
        .map_err(err)?;
    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(format!("branch '{name}' already exists"));
    }
    repo.branch(name, &head, false).map_err(err)?;
    if checkout {
        checkout_branch(repo_path, name)?;
    }
    Ok(())
}

/// Checks out a local branch. Uses a safe checkout: it refuses (with an
/// error) when uncommitted working-tree changes would be overwritten.
pub fn checkout_branch(repo_path: &Path, name: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let branch = repo.find_branch(name, BranchType::Local).map_err(|_| {
        format!("branch '{name}' not found")
    })?;
    let refname = branch
        .get()
        .name()
        .ok_or("invalid branch reference")?
        .to_string();
    let tree = branch.get().peel_to_tree().map_err(err)?;

    let mut builder = CheckoutBuilder::new();
    builder.safe();
    repo.checkout_tree(tree.as_object(), Some(&mut builder))
        .map_err(|e| {
            format!(
                "cannot checkout '{name}': your local changes would be overwritten — commit or stash first ({})",
                e.message()
            )
        })?;
    repo.set_head(&refname).map_err(err)?;
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

/// Deletes a merged local branch. Refuses the current branch and branches
/// with commits not reachable from HEAD.
pub fn delete_branch(repo_path: &Path, name: &str) -> Result<()> {
    let mut repo = Repository::discover(repo_path).map_err(err)?;
    let current = current_branch(&repo)?;
    if current == name {
        return Err("cannot delete the branch you are currently on".to_string());
    }
    let mut branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|_| format!("branch '{name}' not found"))?;
    let tip = branch.get().target().ok_or("branch has no commits")?;
    let head_oid = repo
        .head()
        .map_err(err)?
        .peel_to_commit()
        .map_err(err)?
        .id();
    if !is_ancestor(&repo, tip, head_oid)? {
        return Err(format!(
            "branch '{name}' has unmerged commits — merge it into {current} first"
        ));
    }
    branch.delete().map_err(err)?;
    Ok(())
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
        "orbit: create tag",
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
// Blame annotations — per-line commit attribution
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based line number in the worktree file.
    pub line: u32,
    pub short_oid: String,
    pub author_name: String,
    pub author_initials: String,
    pub time_seconds: i64,
    pub summary: String,
    /// True when the line has uncommitted worktree changes.
    pub uncommitted: bool,
}

/// Per-line blame for a file in the working directory. Uncommitted lines
/// carry `uncommitted: true` with placeholder identity.
pub fn file_blame(repo_path: &Path, path: &str) -> Result<Vec<BlameLine>> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let mut opts = git2::BlameOptions::new();
    opts.track_copies_same_file(true);
    let blame = repo
        .blame_file(Path::new(path), Some(&mut opts))
        .map_err(|e| format!("blame failed for {path}: {e}"))?;

    let mut lines = Vec::new();
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
                    author_name: "Uncommitted".to_string(),
                    author_initials: "—".to_string(),
                    time_seconds: 0,
                    summary: String::new(),
                    uncommitted: true,
                });
            }
            continue;
        }

        let commit = repo.find_commit(commit_id).map_err(err)?;
        let author = commit.author();
        let author_name = author.name().unwrap_or("Unknown").to_string();
        let summary = commit.summary().unwrap_or_default().to_string();
        let short_oid = commit_id.to_string()[..7].to_string();
        let time_seconds = commit.time().seconds() as i64;
        let initials = initials_for(&author_name);

        for offset in 0..count {
            lines.push(BlameLine {
                line: start + offset,
                short_oid: short_oid.clone(),
                author_name: author_name.clone(),
                author_initials: initials.clone(),
                time_seconds,
                summary: summary.clone(),
                uncommitted: false,
            });
        }
    }
    lines.sort_by_key(|line| line.line);
    Ok(lines)
}
