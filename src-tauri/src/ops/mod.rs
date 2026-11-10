//! High-level Git operations (revert, cherry-pick, merge) via the git CLI.
//! Uses the same hybrid approach as net.rs: the CLI is more reliable for
//! operations that need merge machinery, conflict detection, etc.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);

type Result<T> = std::result::Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

fn run_git(repo_path: &Path, args: &[String]) -> Result<String> {
    let output = Command::new("git")
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

/// Cherry-picks a commit onto the current branch (stages the changes).
pub fn cherry_pick(repo_path: &Path, oid: &str) -> Result<String> {
    run_git_timed(repo_path, &["cherry-pick", "--no-commit", oid])
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
    /// Files this commit itself changes (numstat against its parent).
    pub files: Vec<MergePreviewCommitFile>,
}

#[derive(serde::Serialize)]
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
    let mut diff = repo.diff_tree_to_tree(old, Some(new), None).map_err(err)?;
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
        let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
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
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let head = repo.head().map_err(err)?.resolve().map_err(err)?;
    let head_oid = head.target().ok_or_else(|| String::from("HEAD not found"))?;
    let branch = head.shorthand().unwrap_or_default().to_string();

    let mut upstream_name: Option<String> = None;
    let mut upstream_oid: Option<git2::Oid> = None;
    if let Some(short) = head.shorthand() {
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
        walk.push(head_oid).map_err(err)?;
        walk.hide(up).map_err(err)?;
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
        "orbit-rebase-todo-{}-{}.txt",
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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
