//! Network Git operations (fetch / pull / push) via the git CLI.
//!
//! Local operations use libgit2 (git_state), but network operations shell out
//! to `git` so authentication flows through the user's credential helper
//! (Git Credential Manager on Windows, ssh-agent, etc.) — the same hybrid
//! approach GitHub Desktop uses.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::io::Read;
use std::time::{Duration, Instant};

/// Generous wall-clock limit: pushing a large pack (hundreds of commits with
/// binaries) on a slow upload legitimately takes minutes.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetResult {
    pub summary: String,
}

type Result<T> = std::result::Result<T, String>;

fn run_git_with_timeout(repo_path: &PathBuf, args: &[&str], timeout: Duration) -> Result<String> {
    let mut child = Command::new("git").arg("-C").arg(repo_path).args(args)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("failed to start git: {e}. Is git installed and on PATH?"))?;
    // Drain both pipes concurrently: a large push must not block on a full pipe.
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || { let mut data = Vec::new(); stdout.read_to_end(&mut data).map(|_| data) });
    let err = std::thread::spawn(move || { let mut data = Vec::new(); stderr.read_to_end(&mut data).map(|_| data) });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                // Do not leave a timed-out Git process running after telling the UI it failed.
                #[cfg(windows)]
                { let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).output(); }
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git {} timed out after {} seconds; check the remote and authentication before retrying", args.join(" "), timeout.as_secs()));
            }
            Err(error) => {
                let _ = child.kill(); let _ = child.wait();
                return Err(format!("could not wait for git: {error}"));
            }
        }
    };
    let stdout = out.join().map_err(|_| "git stdout reader failed".to_string())?.map_err(|e| e.to_string())?;
    let stderr = err.join().map_err(|_| "git stderr reader failed".to_string())?.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
    if !status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), if stderr.is_empty() { stdout } else { stderr }));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn run_git_timed(repo_path: &PathBuf, args: &[&str]) -> Result<String> {
    run_git_with_timeout(repo_path, args, NETWORK_TIMEOUT)
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

#[cfg(test)]
#[path = "net/tests.rs"]
mod tests;
