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
pub fn merge_branch(repo_path: &Path, branch: &str) -> Result<String> {
    run_git_timed(repo_path, &["merge", branch, "--no-edit", "--ff"])
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
    let todo_path = std::env::temp_dir().join(format!("orbit-rebase-todo-{}.txt", std::process::id()));
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
