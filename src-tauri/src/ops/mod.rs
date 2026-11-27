//! High-level Git operations (revert, cherry-pick, merge) via the git CLI.
//! Uses the same hybrid approach as net.rs: the CLI is more reliable for
//! operations that need merge machinery, conflict detection, etc.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use crate::CommandNoWindow;

mod checkout_refs;
mod commit_edit;
pub use checkout_refs::{checkout_tag, list_checkout_refs, CheckoutRef};
mod conflicts;
mod pr_draft;
pub use pr_draft::{pr_draft_context, PrDraftContext};
mod pr_merge;
pub use pr_merge::{pr_merge_conflicts, pr_merge_resolved, PrMergeConflicts};
pub use conflicts::{conflict_abort, conflict_continue, conflict_resolve_file, conflict_state, conflict_versions, ConflictState, ConflictVersions};
pub use commit_edit::{commit_edit_state, continue_commit_edit, start_commit_edit, CommitEditState};

const TIMEOUT: Duration = Duration::from_secs(60);

type Result<T> = std::result::Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

fn run_git(repo_path: &Path, args: &[String]) -> Result<String> {
    let output = Command::new("git").no_window()
        .arg("-C")
        .arg(repo_path)
        .arg("-c")
        .arg("core.editor=true")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {} failed: {detail}", args.join(" ")));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn run_git_timed(repo_path: &Path, args: &[&str]) -> Result<String> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let path = repo_path.to_path_buf();
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let result = run_git(&path, &owned);
        let _ = tx.send(result);
    });
    match rx.recv_timeout(TIMEOUT) {
        Ok(result) => {
            let _ = handle.join();
            result
        }
        Err(_) => Err(format!(
            "git {} timed out after {} seconds",
            args.join(" "),
            TIMEOUT.as_secs()
        )),
    }
}

/// Reverts a commit: creates a new commit that undoes the target's changes.
/// Uses `git revert --no-edit` which handles merge commits too.
pub fn revert_commit(repo_path: &Path, oid: &str) -> Result<String> {
    run_git_timed(repo_path, &["revert", "--no-edit", oid])
}

/// Aborts a revert that stopped on conflicts, restoring the branch to where it was before the revert.
/// Falls back to a hard reset when git has no revert in progress to abort.
pub fn revert_abort(repo_path: &Path) -> Result<String> {
    match run_git_timed(repo_path, &["revert", "--abort"]) {
        Ok(result) => Ok(result),
        Err(_) => run_git_timed(repo_path, &["reset", "--hard", "HEAD"]),
    }
}

/// Cherry-picks a commit onto the current branch (stages the changes).
pub fn cherry_pick(repo_path: &Path, oid: &str) -> Result<String> {
    run_git_timed(repo_path, &["cherry-pick", "--no-commit", oid])
}

fn unique_commit_patches(
    repo_path: &Path,
    source_tip: git2::Oid,
    destination_tip: git2::Oid,
) -> Result<Vec<String>> {
    let output = crate::gitcli::run_git(
        repo_path,
        &["cherry", "--no-abbrev", &destination_tip.to_string(), &source_tip.to_string()],
    )?;
    // Git lists source-only commits with + and patch-equivalent commits with -.
    // Commits reachable from both branches are omitted.
    Ok(output
        .lines()
        .filter_map(|line| line.strip_prefix("+ "))
        .map(str::to_owned)
        .collect())
}

pub fn duplicate_commit_candidates(
    repo_path: &Path,
    source_branch: &str,
    destination_branch: &str,
) -> Result<Vec<String>> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let tip = |branch: &str| {
        repo.find_branch(branch, git2::BranchType::Local)
            .and_then(|branch| branch.get().peel_to_commit())
            .map(|commit| commit.id())
            .map_err(err)
    };
    unique_commit_patches(repo_path, tip(source_branch)?, tip(destination_branch)?)
}

/// The checks shared by every duplicate step: the commit is on the source branch, not yet on the
/// destination, and not a merge. Returns the destination tip and the commit.
fn duplicate_inputs<'r>(
    repo: &'r git2::Repository,
    repo_path: &Path,
    source_branch: &str,
    destination_branch: &str,
    oid: &str,
) -> Result<(git2::Commit<'r>, git2::Commit<'r>)> {
    use git2::{BranchType, Oid};

    if source_branch == destination_branch {
        return Err("Choose different source and destination branches.".into());
    }
    let source = repo.find_branch(source_branch, BranchType::Local).map_err(err)?;
    let destination = repo
        .find_branch(destination_branch, BranchType::Local)
        .map_err(err)?;
    let source_tip = source.get().peel_to_commit().map_err(err)?.id();
    let destination_tip = destination.get().peel_to_commit().map_err(err)?;
    let commit = repo.find_commit(Oid::from_str(oid).map_err(err)?).map_err(err)?;
    if source_tip != commit.id()
        && !repo.graph_descendant_of(source_tip, commit.id()).map_err(err)?
    {
        return Err(format!("Commit {oid} is not in {source_branch}."));
    }
    if destination_tip.id() == commit.id()
        || repo.graph_descendant_of(destination_tip.id(), commit.id()).map_err(err)?
    {
        return Err(format!("{destination_branch} already contains this commit."));
    }
    if commit.parent_count() > 1 {
        return Err("Merge commits require choosing a mainline parent.".into());
    }
    if !unique_commit_patches(repo_path, source_tip, destination_tip.id())?
        .contains(&commit.id().to_string())
    {
        return Err(format!("{destination_branch} already contains an equivalent change."));
    }
    Ok((destination_tip, commit))
}

/// Commits `tree_id` on top of the destination tip with the original author and message, then
/// moves the destination branch (fast-forwarding the working tree when it is checked out).
fn land_duplicate(
    repo: &git2::Repository,
    repo_path: &Path,
    destination_branch: &str,
    destination_tip: &git2::Commit,
    commit: &git2::Commit,
    tree_id: git2::Oid,
) -> Result<String> {
    use crate::gitcli::run_git;
    use git2::{BranchType, RepositoryState};

    if tree_id == destination_tip.tree_id() {
        return Err(format!("This commit has no changes to apply to {destination_branch}."));
    }
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let message = commit.message_raw().ok_or("The original commit message is not UTF-8.")?;
    let committer = repo.signature().map_err(err)?;
    let new_oid = repo
        .commit(None, &commit.author(), &committer, message, &tree, &[destination_tip])
        .map_err(err)?
        .to_string();

    let destination_ref = format!("refs/heads/{destination_branch}");
    let current_destination = repo
        .find_branch(destination_branch, BranchType::Local)
        .map_err(err)?;
    if current_destination.get().target() != Some(destination_tip.id()) {
        return Err(format!("{destination_branch} changed during the copy. Try again."));
    }
    if current_destination.is_head() {
        if repo.state() != RepositoryState::Clean
            || !run_git(repo_path, &[
                "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
            ])?.is_empty()
        {
            return Err("Finish the current Git operation or commit or stash changes on the destination first.".into());
        }
        let head = repo.head().map_err(err)?;
        if head.name() != Some(destination_ref.as_str()) || head.target() != Some(destination_tip.id()) {
            return Err("The destination changed during the copy. Try again.".into());
        }
        // Let Git update the current branch, index, and working tree together.
        run_git(repo_path, &["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", &new_oid])?;
    } else {
        let worktree = run_git(repo_path, &["branch", "--list", "--format=%(worktreepath)", "--", destination_branch])?;
        if !worktree.is_empty() {
            return Err(format!("{destination_branch} is in use in another worktree. Open that worktree to duplicate the commit there."));
        }
        // Compare the old value under Git's ref lock so a concurrent update is preserved.
        run_git(repo_path, &[
            "update-ref", "-m", &format!("duplicate commit {}", commit.id()),
            &destination_ref, &new_oid, &destination_tip.id().to_string(),
        ])?;
    }
    Ok(new_oid)
}

/// Replay one commit on a local destination branch without switching branches.
pub fn duplicate_commit(
    repo_path: &Path,
    source_branch: &str,
    destination_branch: &str,
    oid: &str,
) -> Result<()> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let (destination_tip, commit) = duplicate_inputs(&repo, repo_path, source_branch, destination_branch, oid)?;
    // The cherry-pick index is in memory, so conflicts cannot affect either branch.
    let mut picked = repo
        .cherrypick_commit(&commit, &destination_tip, 0, None)
        .map_err(err)?;
    if picked.has_conflicts() {
        return Err(format!("This commit conflicts with changes in {destination_branch}."));
    }
    let tree_id = picked.write_tree_to(&repo).map_err(err)?;
    land_duplicate(&repo, repo_path, destination_branch, &destination_tip, &commit, tree_id)?;
    Ok(())
}

/// One file the duplicated commit conflicts on. "Ours" is the destination branch, "theirs" is the
/// commit being duplicated and "base" is that commit's parent.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateConflictFile {
    pub path: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    /// Both sides merged with diff3-style conflict markers; None when a side deleted the file or
    /// a version is binary.
    pub merged: Option<String>,
    pub binary: bool,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateConflicts {
    /// The destination tip the conflicts were computed against; resolving checks it is unchanged.
    pub destination_oid: String,
    pub commit_oid: String,
    pub commit_summary: String,
    /// Empty when the commit applies cleanly.
    pub files: Vec<DuplicateConflictFile>,
}

/// How the user resolved one conflicted file: `side` takes a whole version ("ours" or "theirs",
/// a missing version deletes the file); otherwise `content` is the new text and None deletes it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateResolution {
    pub path: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub side: Option<String>,
}

/// `git2::IndexEntry` is not `Clone`.
fn copy_entry(entry: &git2::IndexEntry) -> git2::IndexEntry {
    git2::IndexEntry {
        ctime: entry.ctime,
        mtime: entry.mtime,
        dev: entry.dev,
        ino: entry.ino,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        file_size: entry.file_size,
        id: entry.id,
        flags: entry.flags,
        flags_extended: entry.flags_extended,
        path: entry.path.clone(),
    }
}

fn conflict_path(conflict: &git2::IndexConflict) -> Option<String> {
    [&conflict.our, &conflict.their, &conflict.ancestor]
        .into_iter()
        .flatten()
        .next()
        .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
}

/// Every conflicted file of an in-memory merge index, with all three versions and a diff3-style
/// marked-up merge labelled with the two sides.
fn read_conflicts(
    repo: &git2::Repository,
    index: &git2::Index,
    our_label: &str,
    their_label: &str,
) -> Result<Vec<DuplicateConflictFile>> {
    let mut files = Vec::new();
    for conflict in index.conflicts().map_err(err)?.flatten() {
        let Some(path) = conflict_path(&conflict) else { continue };
        let mut binary = false;
        let mut read = |entry: &Option<git2::IndexEntry>| -> Result<Option<String>> {
            let Some(entry) = entry else { return Ok(None) };
            let blob = repo.find_blob(entry.id).map_err(err)?;
            if blob.is_binary() {
                binary = true;
                return Ok(None);
            }
            Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
        };
        let base = read(&conflict.ancestor)?;
        let ours = read(&conflict.our)?;
        let theirs = read(&conflict.their)?;
        let merged = match (&conflict.our, &conflict.their) {
            (Some(our), Some(their)) if !binary => {
                // Files added on both sides have no ancestor: merge against an empty file.
                let ancestor = match &conflict.ancestor {
                    Some(entry) => copy_entry(entry),
                    None => git2::IndexEntry { id: repo.blob(b"").map_err(err)?, ..copy_entry(our) },
                };
                let mut options = git2::MergeFileOptions::new();
                options
                    .ancestor_label("base")
                    .our_label(our_label)
                    .their_label(their_label)
                    .style_diff3(true);
                let result = repo
                    .merge_file_from_index(&ancestor, our, their, Some(&mut options))
                    .map_err(err)?;
                Some(String::from_utf8_lossy(result.content()).into_owned())
            }
            _ => None,
        };
        files.push(DuplicateConflictFile { path, base, ours, theirs, merged, binary });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Replaces every conflicted file of an in-memory merge index with the user's resolution. Fails when a
/// resolution names a file that is not conflicted or a conflicted file has none.
fn apply_resolutions(
    repo: &git2::Repository,
    index: &mut git2::Index,
    resolutions: &[DuplicateResolution],
) -> Result<()> {
    let conflicts: Vec<git2::IndexConflict> = index.conflicts().map_err(err)?.collect::<std::result::Result<_, _>>().map_err(err)?;
    for resolution in resolutions {
        if !conflicts.iter().any(|c| conflict_path(c).as_deref() == Some(resolution.path.as_str())) {
            return Err(format!("{} is not one of the conflicted files.", resolution.path));
        }
    }
    for conflict in &conflicts {
        let Some(path) = conflict_path(conflict) else { continue };
        let resolution = resolutions
            .iter()
            .find(|r| r.path == path)
            .ok_or_else(|| format!("{path} is still conflicted. Resolve every file first."))?;
        let template = conflict.our.as_ref().or(conflict.their.as_ref()).or(conflict.ancestor.as_ref())
            .map(copy_entry)
            .ok_or_else(|| format!("{path} has no index entry."))?;
        let entry = match resolution.side.as_deref() {
            Some("ours") => conflict.our.as_ref().map(copy_entry),
            Some("theirs") => conflict.their.as_ref().map(copy_entry),
            Some(other) => return Err(format!("Unknown side \"{other}\" for {path}.")),
            None => match &resolution.content {
                Some(text) => {
                    if text.lines().any(|line| line.starts_with("<<<<<<<") || line.starts_with(">>>>>>>")) {
                        return Err(format!("{path} still has conflict markers."));
                    }
                    let mode = conflict.our.as_ref().or(conflict.their.as_ref()).map(|e| e.mode).unwrap_or(0o100644);
                    Some(git2::IndexEntry { id: repo.blob(text.as_bytes()).map_err(err)?, mode, file_size: text.len() as u32, ..template })
                }
                None => None,
            },
        };
        index.conflict_remove(Path::new(&path)).map_err(err)?;
        if let Some(mut entry) = entry {
            entry.flags &= !0x3000; // stage bits: a resolved entry is stage 0
            entry.path = path.clone().into_bytes();
            index.add(&entry).map_err(err)?;
        }
    }
    Ok(())
}

/// Replays the commit in memory and lists the files it conflicts on, with all three versions and a
/// marked-up merge of each. Nothing is written to either branch or the working tree.
pub fn duplicate_commit_conflicts(
    repo_path: &Path,
    source_branch: &str,
    destination_branch: &str,
    oid: &str,
) -> Result<DuplicateConflicts> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let (destination_tip, commit) = duplicate_inputs(&repo, repo_path, source_branch, destination_branch, oid)?;
    let picked = repo
        .cherrypick_commit(&commit, &destination_tip, 0, None)
        .map_err(err)?;
    let short = commit.as_object().short_id().ok()
        .and_then(|b| b.as_str().map(str::to_string))
        .unwrap_or_else(|| commit.id().to_string()[..7].to_string());
    let summary = commit.summary().unwrap_or("").to_string();
    let files = if picked.has_conflicts() {
        read_conflicts(&repo, &picked, destination_branch, &format!("{short} ({summary})"))?
    } else {
        Vec::new()
    };
    Ok(DuplicateConflicts {
        destination_oid: destination_tip.id().to_string(),
        commit_oid: commit.id().to_string(),
        commit_summary: summary,
        files,
    })
}

/// Finishes a conflicted duplicate with the user's resolutions: replays the commit in memory again,
/// replaces every conflicted file with its resolution and commits the result on the destination.
/// Fails without touching anything when the destination moved since the conflicts were shown or a
/// conflicted file has no resolution.
pub fn duplicate_commit_resolved(
    repo_path: &Path,
    source_branch: &str,
    destination_branch: &str,
    oid: &str,
    expected_destination: &str,
    resolutions: &[DuplicateResolution],
) -> Result<String> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let (destination_tip, commit) = duplicate_inputs(&repo, repo_path, source_branch, destination_branch, oid)?;
    if destination_tip.id().to_string() != expected_destination {
        return Err(format!("{destination_branch} changed while you were resolving the conflicts. Open the conflicts again to see the new changes."));
    }
    let mut picked = repo
        .cherrypick_commit(&commit, &destination_tip, 0, None)
        .map_err(err)?;
    apply_resolutions(&repo, &mut picked, resolutions)?;
    if picked.has_conflicts() {
        return Err("Some files are still conflicted. Resolve every file first.".into());
    }
    let tree_id = picked.write_tree_to(&repo).map_err(err)?;
    land_duplicate(&repo, repo_path, destination_branch, &destination_tip, &commit, tree_id)
}

/// Aborts an in-progress cherry-pick, restoring the branch state.
/// Conflicted picks made with --no-commit leave no sequencer state
/// (modern git skips CHERRY_PICK_HEAD), so abort is a hard reset to HEAD.
pub fn cherry_pick_abort(repo_path: &Path) -> Result<String> {
    match run_git_timed(repo_path, &["cherry-pick", "--abort"]) {
        Ok(result) => Ok(result),
        Err(_) => run_git_timed(repo_path, &["reset", "--hard", "HEAD"]),
    }
}

/// Merges a branch into the current branch. Prefers fast-forward.
/// Merges a branch into the checked-out branch.
/// strategy: "ff" (fast-forward only — fails when diverged), "no-ff" (always a merge commit),
/// or "squash" (stages the result — commit to finish).
pub fn merge_branch(repo_path: &Path, branch: &str, strategy: &str) -> Result<String> {
    let args = match strategy {
        "no-ff" => vec!["merge", branch, "--no-edit", "--no-ff"],
        "squash" => vec!["merge", branch, "--squash"],
        _ => vec!["merge", branch, "--no-edit", "--ff-only"],
    };
    match run_git_timed(repo_path, &args) {
        Ok(output) => Ok(output),
        Err(e) if e.contains("CONFLICT") => {
            Err("CONFLICT: merge has unresolved conflicts".into())
        }
        Err(e) => Err(e),
    }
}

/// Aborts an in-progress merge (git merge --abort).
pub fn merge_abort(repo_path: &Path) -> Result<String> {
    run_git_timed(repo_path, &["merge", "--abort"])
}

/// Merge state for the conflict UI — in-progress flag + conflicted paths.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStatus {
    pub in_progress: bool,
    pub conflicted: Vec<String>,
}

/// Preview of what a branch merge would bring in — commits + files.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub body: String,
    pub author_name: String,
    pub time_seconds: i64,
    /// First parent (None for root commits) — the compare base in the UI.
    pub parent_oid: Option<String>,
    /// Files this commit itself changes (numstat against its parent).
    pub files: Vec<MergePreviewCommitFile>,
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewCommitFile {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
}

/// Source commit that touched a file in the merge range.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewFileCommit {
    pub short_oid: String,
    pub summary: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewFile {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    /// Commits from the source branch that touched this file (oldest first).
    pub commits: Vec<MergePreviewFileCommit>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// True when the source is already contained in HEAD.
    pub up_to_date: bool,
    pub commits: Vec<MergePreviewCommit>,
    pub files: Vec<MergePreviewFile>,
}

/// Per-file line stats of a tree-to-tree diff, in diff order.
fn tree_diff_stats(
    repo: &git2::Repository,
    old: Option<&git2::Tree>,
    new: &git2::Tree,
) -> Result<Vec<(String, char, usize, usize)>> {
    let diff = repo.diff_tree_to_tree(old, Some(new), None).map_err(err)?;
    diff_file_stats(&diff)
}

fn diff_file_stats(diff: &git2::Diff) -> Result<Vec<(String, char, usize, usize)>> {
    let mut adds: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut dels: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut order: Vec<(String, char)> = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or(delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let letter = match delta.status() {
                git2::Delta::Added => 'A',
                git2::Delta::Deleted => 'D',
                git2::Delta::Renamed => 'R',
                _ => 'M',
            };
            order.push((path.clone(), letter));
            true
        },
        None,
        None,
        Some(&mut |delta, _, line| {
            let path = delta
                .new_file()
                .path()
                .or(delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            match line.origin() {
                '+' => { adds.entry(path.clone()).and_modify(|v| *v += 1).or_insert(1); },
                '-' => { dels.entry(path.clone()).and_modify(|v| *v += 1).or_insert(1); },
                _ => {}
            }
            true
        }),
    ).map_err(err)?;
    Ok(order
        .into_iter()
        .map(|(path, letter)| {
            (
                path.clone(),
                letter,
                adds.remove(&path).unwrap_or(0),
                dels.remove(&path).unwrap_or(0),
            )
        })
        .collect())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchComparison {
    pub base_oid: String,
    pub compare_oid: String,
    pub base_only: usize,
    pub compare_only: usize,
    pub files: Vec<MergePreviewCommitFile>,
}

/// Compare the tips of two branches without touching the index or working tree.
pub fn compare_branches(repo_path: &Path, base_ref: &str, compare_ref: &str) -> Result<BranchComparison> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let resolve = |name: &str| {
        if !name.starts_with("refs/heads/") && !name.starts_with("refs/remotes/") {
            return Err(format!("Invalid branch reference: {name}"));
        }
        repo.find_reference(name)
            .and_then(|reference| reference.peel_to_commit())
            .map_err(|error| format!("Could not resolve {name}: {}", error.message()))
    };
    let base = resolve(base_ref)?;
    let compare = resolve(compare_ref)?;
    let (base_only, compare_only) = repo.graph_ahead_behind(base.id(), compare.id()).map_err(err)?;
    let base_tree = base.tree().map_err(err)?;
    let compare_tree = compare.tree().map_err(err)?;
    let mut options = git2::DiffOptions::new();
    options.include_typechange(true);
    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&compare_tree), Some(&mut options))
        .map_err(err)?;
    let files = diff_file_stats(&diff)?
        .into_iter()
        .map(|(path, status, additions, deletions)| MergePreviewCommitFile {
            path,
            status: status.to_string(),
            additions,
            deletions,
        })
        .collect();

    Ok(BranchComparison {
        base_oid: base.id().to_string(),
        compare_oid: compare.id().to_string(),
        base_only,
        compare_only,
        files,
    })
}

/// Computes what merging 'branch' into HEAD would bring in.
pub fn merge_preview(repo_path: &Path, branch: &str) -> Result<MergePreview> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let head = repo.head().map_err(err)?.resolve().map_err(err)?;
    let head_oid = head.target().ok_or_else(|| String::from("HEAD not found"))?;
    let source = repo.revparse_single(branch).map_err(|e| format!("unknown branch {branch}: {e}"))?;
    let source_commit = source.peel_to_commit().map_err(err)?;
    let base = repo.merge_base(head_oid, source.id()).map_err(err)?;
    let up_to_date = base == source.id();

    // Commits unique to the source branch (oldest first), each with the
    // files it itself changes and a map of file -> touching commits.
    let mut commits: Vec<MergePreviewCommit> = Vec::new();
    let mut walk = repo.revwalk().map_err(err)?;
    walk.push(source.id()).map_err(err)?;
    walk.hide(base).map_err(err)?;
    walk.set_sorting(git2::Sort::REVERSE | git2::Sort::TOPOLOGICAL).map_err(err)?;
    let mut file_commits: std::collections::HashMap<String, Vec<MergePreviewFileCommit>> =
        std::collections::HashMap::new();
    for oid in walk.flatten() {
        let Ok(commit) = repo.find_commit(oid) else { continue };
        let short_oid = commit
            .as_object()
            .short_id()
            .map(|buf| buf.as_str().map(|str| str.to_string()).unwrap_or_default())
            .unwrap_or_default();
        let summary = commit.summary().unwrap_or_default().to_string();
        // Files of this commit vs its first parent (whole tree for roots).
        let parent = commit.parent(0).ok();
        let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
        let tree = commit.tree().map_err(err)?;
        let files = tree_diff_stats(&repo, parent_tree.as_ref(), &tree)?
            .into_iter()
            .map(|(path, letter, additions, deletions)| {
                file_commits.entry(path.clone()).or_default().push(MergePreviewFileCommit {
                    short_oid: short_oid.clone(),
                    summary: summary.clone(),
                });
                MergePreviewCommitFile {
                    path,
                    status: letter.to_string(),
                    additions,
                    deletions,
                }
            })
            .collect();
        commits.push(MergePreviewCommit {
            oid: commit.id().to_string(),
            short_oid,
            body: commit.message().unwrap_or_default().trim_end().to_string(),
            summary,
            author_name: commit
                .author()
                .name()
                .unwrap_or_default()
                .to_string(),
            time_seconds: commit.time().seconds(),
            parent_oid: parent.as_ref().map(|p| p.id().to_string()),
            files,
        });
    }

    // Files: diff merge-base tree vs source tip tree with per-file line stats.
    let base_tree = repo.find_commit(base).map_err(err)?.tree().map_err(err)?;
    let source_tree = source_commit.tree().map_err(err)?;
    let files = tree_diff_stats(&repo, Some(&base_tree), &source_tree)?
        .into_iter()
        .map(|(path, letter, additions, deletions)| MergePreviewFile {
            commits: file_commits.remove(&path).unwrap_or_default(),
            path,
            status: letter.to_string(),
            additions,
            deletions,
        })
        .collect();

    Ok(MergePreview { up_to_date, commits, files })
}

/// Preview of the local commits waiting to be pushed upstream.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreviewCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub body: String,
    pub author_name: String,
    pub time_seconds: i64,
    /// First parent (None for root commits) — the compare base in the UI.
    pub parent_oid: Option<String>,
    pub files: Vec<MergePreviewCommitFile>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreview {
    pub branch: String,
    /// Upstream ref like "origin/main" (None when the branch has none yet).
    pub upstream: Option<String>,
    pub ahead: usize,
    pub commits: Vec<PushPreviewCommit>,
}

/// Lists the local commits ahead of the upstream, each with its files.
pub fn push_preview(repo_path: &Path) -> Result<PushPreview> {
    sync_preview(repo_path, false)
}

/// Lists commits reachable from the current upstream but absent from HEAD.
pub fn pull_preview(repo_path: &Path) -> Result<Vec<PushPreviewCommit>> {
    Ok(sync_preview(repo_path, true)?.commits)
}

fn sync_preview(repo_path: &Path, incoming: bool) -> Result<PushPreview> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let head = match repo.head() {
        Ok(head) => head.resolve().map_err(err)?,
        Err(error) if incoming && error.code() == git2::ErrorCode::UnbornBranch => {
            return Ok(PushPreview { branch: String::new(), upstream: None, ahead: 0, commits: Vec::new() });
        }
        Err(error) => return Err(err(error)),
    };
    let head_oid = head.target().ok_or_else(|| String::from("HEAD not found"))?;
    let branch = head.shorthand().unwrap_or_default().to_string();

    let mut upstream_name: Option<String> = None;
    let mut upstream_oid: Option<git2::Oid> = None;
    if let Some(short) = head.shorthand().filter(|_| head.is_branch()) {
        if let Ok(local) = repo.find_branch(short, git2::BranchType::Local) {
            if let Ok(upstream) = local.upstream() {
                upstream_name = Some(
                    upstream
                        .name()
                        .map(|n| n.unwrap_or_default().to_string())
                        .unwrap_or_default(),
                );
                upstream_oid = upstream.get().target();
            }
        }
    }

    let mut commits: Vec<PushPreviewCommit> = Vec::new();
    if let Some(up) = upstream_oid {
        let mut walk = repo.revwalk().map_err(err)?;
        let (tip, base) = if incoming { (up, head_oid) } else { (head_oid, up) };
        walk.push(tip).map_err(err)?;
        walk.hide(base).map_err(err)?;
        walk.set_sorting(git2::Sort::REVERSE | git2::Sort::TOPOLOGICAL).map_err(err)?;
        for oid in walk.flatten() {
            let Ok(commit) = repo.find_commit(oid) else { continue };
            let parent = commit.parent(0).ok();
            let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
            let tree = commit.tree().map_err(err)?;
            let files = tree_diff_stats(&repo, parent_tree.as_ref(), &tree)?
                .into_iter()
                .map(|(path, letter, additions, deletions)| MergePreviewCommitFile {
                    path,
                    status: letter.to_string(),
                    additions,
                    deletions,
                })
                .collect();
            commits.push(PushPreviewCommit {
                oid: commit.id().to_string(),
                short_oid: commit
                    .as_object()
                    .short_id()
                    .map(|buf| buf.as_str().map(|str| str.to_string()).unwrap_or_default())
                    .unwrap_or_default(),
                summary: commit.summary().unwrap_or_default().to_string(),
                body: commit.message().unwrap_or_default().trim_end().to_string(),
                author_name: commit.author().name().unwrap_or_default().to_string(),
                time_seconds: commit.time().seconds(),
                parent_oid: parent.map(|p| p.id().to_string()),
                files,
            });
        }
    }

    let ahead = commits.len();
    Ok(PushPreview { branch, upstream: upstream_name, ahead, commits })
}

/// Contents of one stash entry — the files it changes vs its base.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StashPreview {
    pub index: usize,
    pub oid: String,
    /// The base commit the stash applies onto (compare base in the UI).
    pub parent_oid: Option<String>,
    pub message: String,
    pub files: Vec<MergePreviewCommitFile>,
}

/// Lists the files one stash entry changes (diff vs its first parent).
pub fn stash_preview(repo_path: &Path, index: usize) -> Result<StashPreview> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let commit = repo
        .revparse_single(&format!("stash@{{{}}}", index))
        .map_err(|e| format!("stash #{} does not exist: {}", index, e))?
        .peel_to_commit()
        .map_err(err)?;
    let parent = commit.parent(0).ok();
    let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
    let tree = commit.tree().map_err(err)?;
    let mut files: Vec<MergePreviewCommitFile> = tree_diff_stats(&repo, parent_tree.as_ref(), &tree)?
        .into_iter()
        .map(|(path, letter, additions, deletions)| MergePreviewCommitFile {
            path,
            status: letter.to_string(),
            additions,
            deletions,
        })
        .collect();
    // Untracked files ride in the stash's third parent (git's stash model),
    // not in the stash tree itself — surface them as additions.
    if commit.parent_count() > 2 {
        if let Ok(untracked) = commit.parent(2) {
            let untracked_tree = untracked.tree().map_err(err)?;
            for (path, letter, additions, deletions) in
                tree_diff_stats(&repo, None, &untracked_tree)?
            {
                files.push(MergePreviewCommitFile {
                    path,
                    status: letter.to_string(),
                    additions,
                    deletions,
                });
            }
        }
    }
    Ok(StashPreview {
        index,
        oid: commit.id().to_string(),
        parent_oid: parent.as_ref().map(|p| p.id().to_string()),
        message: commit.summary().unwrap_or_default().to_string(),
        files,
    })
}

/// Ours/HEAD, incoming/source-tip and workdir contents of one file
/// (None when the side does not have the file — add/delete merges).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeFileVersions {
    pub ours: Option<String>,
    pub incoming: Option<String>,
    pub workdir: Option<String>,
}

fn blob_content_at(repo: &git2::Repository, commit: &git2::Commit, path: &str) -> Option<String> {
    let tree = commit.tree().ok()?;
    let entry = tree.get_path(std::path::Path::new(path)).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    Some(String::from_utf8_lossy(blob.content()).to_string())
}

pub fn merge_file_versions(repo_path: &Path, path: &str, branch: &str) -> Result<MergeFileVersions> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let head = repo.head().map_err(err)?.resolve().map_err(err)?;
    let head_commit = head.peel_to_commit().map_err(err)?;
    let source = repo.revparse_single(branch).map_err(|e| format!("unknown branch {branch}: {e}"))?;
    let source_commit = source.peel_to_commit().map_err(err)?;
    let ours = blob_content_at(&repo, &head_commit, path);
    let incoming = blob_content_at(&repo, &source_commit, path);
    let full = repo.workdir().ok_or("bare repository")?.join(path);
    let workdir = std::fs::read(&full).ok().map(|bytes| String::from_utf8_lossy(&bytes).to_string());
    Ok(MergeFileVersions { ours, incoming, workdir })
}
pub fn merge_status(repo_path: &Path) -> Result<MergeStatus> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let in_progress = repo.path().join("MERGE_HEAD").exists();
    let mut conflicted: Vec<String> = Vec::new();
    if in_progress {
        let mut index = repo.index().map_err(|e| e.to_string())?;
        for conflict in index.conflicts().map_err(|e| e.to_string())? {
            if let Ok(conflict) = conflict {
                let entry = conflict.our.or(conflict.their).or(conflict.ancestor);
                if let Some(entry) = entry {
                    let path = String::from_utf8_lossy(&entry.path).to_string();
                    if !conflicted.contains(&path) {
                        conflicted.push(path);
                    }
                }
            }
        }
    }
    Ok(MergeStatus { in_progress, conflicted })
}

#[cfg(test)]
mod tests;

/// Clones a repository from a URL to a local directory.
pub fn clone_repo(url: &str, target: &str) -> Result<String> {
    run_git_timed(Path::new("."), &["clone", url, target])
}

/// Rebases the current branch onto another branch.
pub fn rebase_onto(repo_path: &Path, base: &str) -> Result<String> {
    run_git_timed(repo_path, &["rebase", base])
}

/// One step of an interactive rebase plan, as chosen in the UI.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub oid: String,
    /// "pick" | "squash" | "drop"
    pub action: String,
}

/// True while a rebase is mid-flight (`.git/rebase-merge|rebase-apply` present).
pub fn rebase_in_progress(repo_path: &Path) -> bool {
    let repo = match git2::Repository::discover(repo_path) {
        Ok(repo) => repo,
        Err(_) => return false,
    };
    let git_dir = repo.path();
    git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists()
}

/// Interactive rebase: applies the UI's plan (pick/squash/drop rows, possibly
/// reordered) to the commits between `base` and HEAD. The plan arrives
/// top-to-bottom as displayed (newest first); the todo list git expects is the
/// reverse. Feeds it to `git rebase -i` through GIT_SEQUENCE_EDITOR so the
/// operation stays non-interactive.
pub fn interactive_rebase(repo_path: &Path, base: &str, steps: &[RebaseStep]) -> Result<String> {
    if steps.is_empty() {
        return Err("nothing to do: no commits selected".to_string());
    }
    for step in steps {
        match step.action.as_str() {
            "pick" | "squash" | "drop" => {}
            other => return Err(format!("unknown rebase action \"{other}\"")),
        }
    }
    // The todo list is oldest-first (the reverse of the displayed plan); a
    // squash as its first line would fold into `base`, which is impossible.
    if steps.last().map(|s| s.action.as_str()) == Some("squash") {
        return Err("the oldest selected commit cannot be squashed (nothing to fold into)".to_string());
    }

    // The plan must cover exactly the commits between base and HEAD.
    let rev_list = run_git_timed(repo_path, &["rev-list", "--reverse", &format!("{base}..HEAD")])?;
    let mut expected: Vec<&str> = rev_list.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut planned: Vec<&str> = steps.iter().map(|s| s.oid.trim()).collect();
    expected.sort_unstable();
    planned.sort_unstable();
    if planned != expected {
        return Err(format!(
            "rebase plan must cover exactly the {} commits between {base} and HEAD",
            expected.len()
        ));
    }

    // Write the todo file (oldest first) to a temp path.
    let todo_body: String = steps
        .iter()
        .rev()
        .map(|s| format!("{} {}\n", s.action, s.oid.trim()))
        .collect();
    // Unique per call: parallel tests in one process share a pid, and a
    // shared todo path would race (one test feeding another its plan).
    static TODO_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let todo_path = std::env::temp_dir().join(format!(
        "pigry-rebase-todo-{}-{}.txt",
        std::process::id(),
        TODO_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    std::fs::write(&todo_path, todo_body).map_err(err)?;

    // GIT_SEQUENCE_EDITOR is executed through sh (even on Windows); it receives
    // the todo file path as its last argument, so `cp <ours>` overwrites it.
    // Forward slashes keep the Windows temp path shell-safe. GIT_EDITOR=true
    // accepts the squashed commit message without opening an editor.
    let editor = format!("cp {}", todo_path.display().to_string().replace('\\', "/"));
    let result = run_git_env(
        repo_path,
        &["rebase", "-i", base],
        &[
            ("GIT_SEQUENCE_EDITOR", editor.as_str()),
            ("GIT_EDITOR", "true"),
        ],
    );
    let _ = std::fs::remove_file(&todo_path);
    result
}

/// Aborts an in-progress rebase and restores the branch to its original tip.
pub fn abort_rebase(repo_path: &Path) -> Result<String> {
    run_git_timed(repo_path, &["rebase", "--abort"])
}

fn run_git_env(repo_path: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String> {
    let output = Command::new("git").no_window()
        .arg("-C")
        .arg(repo_path)
        .arg("-c")
        .arg("core.editor=true")
        .args(args)
        .envs(envs.iter().copied())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {} failed: {detail}", args.join(" ")));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// Checks if the repository has unresolved merge conflicts.
pub fn has_conflicts(repo_path: &Path) -> Result<bool> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let index = repo.index().map_err(|e| e.to_string())?;
    Ok(index.has_conflicts())
}

/// Verifies a commit's GPG signature using git CLI.
/// Returns "good", "bad", "unsigned", or an error.
pub fn verify_commit(repo_path: &Path, oid: &str) -> Result<String> {
    let output = Command::new("git").no_window()
        .arg("-C")
        .arg(repo_path)
        .args(["verify-commit", oid])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to verify: {e}"))?;
    if output.status.success() {
        Ok("good".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no signature") || stderr.contains("has no signature") {
            Ok("unsigned".to_string())
        } else {
            Ok("bad".to_string())
        }
    }
}

/// Repository statistics for the dashboard.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStats {
    pub total_commits: usize,
    pub contributors: Vec<Contributor>,
    pub languages: Vec<LanguageCount>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    pub name: String,
    pub initials: String,
    pub commits: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCount {
    pub language: String,
    pub files: usize,
}

pub fn repo_stats(repo_path: &Path) -> std::result::Result<RepoStats, String> {
    let repo = git2::Repository::discover(repo_path).map_err(|e| e.to_string())?;
    
    // Total commits + contributors from revwalk
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;
    let mut total_commits = 0usize;
    let mut contributors: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for oid in revwalk {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let author = commit.author();
        let name = author.name().unwrap_or("Unknown").to_string();
        *contributors.entry(name).or_insert(0) += 1;
        total_commits += 1;
        if total_commits >= 5000 { break; } // safety valve
    }
    let mut contributor_list: Vec<Contributor> = contributors
        .into_iter()
        .map(|(name, commits)| Contributor {
            initials: crate::git_state::initials_for(&name),
            name,
            commits,
        })
        .collect();
    contributor_list.sort_by(|a, b| b.commits.cmp(&a.commits));

    // Language counts from file extensions in the tree.
    let head = repo.head().ok();
    let mut languages: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    if let Some(tree) = head.and_then(|h| h.peel_to_tree().ok()) {
        tree.walk(git2::TreeWalkMode::PreOrder, |_, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                let name = entry.name().unwrap_or("");
                let ext = std::path::Path::new(name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                let lang = match ext {
                    "rs" => "Rust",
                    "ts" | "tsx" => "TypeScript",
                    "js" | "jsx" => "JavaScript",
                    "css" | "scss" => "CSS",
                    "html" => "HTML",
                    "json" => "JSON",
                    "md" => "Markdown",
                    "toml" => "TOML",
                    "yaml" | "yml" => "YAML",
                    "py" => "Python",
                    "go" => "Go",
                    _ => return git2::TreeWalkResult::Ok,
                };
                *languages.entry(lang.to_string()).or_insert(0) += 1;
            }
            git2::TreeWalkResult::Ok
        })
        .map_err(|e| e.to_string())?;
    }
    let mut language_list: Vec<LanguageCount> = languages
        .into_iter()
        .map(|(language, files)| LanguageCount { language, files })
        .collect();
    language_list.sort_by(|a, b| b.files.cmp(&a.files));

    Ok(RepoStats {
        total_commits,
        contributors: contributor_list,
        languages: language_list,
    })
}
