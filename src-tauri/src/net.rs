//! Network Git operations (fetch / pull / push) via the git CLI.
//!
//! Local operations use libgit2 (git_state), but network operations shell out
//! to `git` so authentication flows through the user's credential helper
//! (Git Credential Manager on Windows, ssh-agent, etc.) — the same hybrid
//! approach GitHub Desktop uses.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetResult {
    pub summary: String,
}

type Result<T> = std::result::Result<T, String>;

fn run_git(repo_path: &PathBuf, args: &[String]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("-c")
        // Headless: GCM still supplies stored credentials, but never prompts.
        .arg("credential.interactive=false")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start git: {e}. Is git installed and on PATH?"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("git {} failed: {detail}", args.join(" ")));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// Runs a git command on a worker thread with a wall-clock timeout so a
/// hung network call cannot block the UI forever.
fn run_git_timed(repo_path: &PathBuf, args: &[&str]) -> Result<String> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let path = repo_path.clone();
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let result = run_git(&path, &owned);
        let _ = tx.send(result);
    });
    match rx.recv_timeout(NETWORK_TIMEOUT) {
        Ok(result) => {
            let _ = handle.join();
            result
        }
        Err(_) => Err(format!(
            "git {} timed out after {} seconds",
            args.join(" "),
            NETWORK_TIMEOUT.as_secs()
        )),
    }
}

pub fn fetch(repo_path: &PathBuf) -> Result<NetResult> {
    let output = run_git_timed(repo_path, &["fetch", "--prune"])?;
    Ok(NetResult {
        summary: if output.is_empty() {
            "Already up to date.".to_string()
        } else {
            output
        },
    })
}

/// Fast-forward pull; refuses to create merge commits.
pub fn pull(repo_path: &PathBuf) -> Result<NetResult> {
    let output = run_git_timed(repo_path, &["pull", "--ff-only"])?;
    Ok(NetResult {
        summary: if output.is_empty() {
            "Already up to date.".to_string()
        } else {
            output
        },
    })
}

/// Pushes the current branch; sets upstream on the first push.
pub fn push(repo_path: &PathBuf, branch: &str, has_upstream: bool) -> Result<NetResult> {
    let args: Vec<&str> = if has_upstream {
        vec!["push"]
    } else {
        vec!["push", "--set-upstream", "origin", branch]
    };
    let output = run_git_timed(repo_path, &args)?;
    Ok(NetResult { summary: output })
}

/// Deletes a branch on the remote (`git push <remote> --delete <name>`).
pub fn push_delete_remote(repo_path: &PathBuf, remote: &str, name: &str) -> Result<NetResult> {
    let output = run_git_timed(repo_path, &["push", remote, "--delete", name])?;
    Ok(NetResult { summary: output })
}
