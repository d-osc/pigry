//! High-level Git operations (revert, cherry-pick, merge) via the git CLI.
//! Uses the same hybrid approach as net.rs: the CLI is more reliable for
//! operations that need merge machinery, conflict detection, etc.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);

type Result<T> = std::result::Result<T, String>;

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
