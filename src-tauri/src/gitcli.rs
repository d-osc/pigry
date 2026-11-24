//! External git CLI bridge — local operations shell out to the user's own
//! `git` so behavior matches the command line exactly (same merges, same
//! hooks, same config, same credential helpers). Network operations go
//! through net.rs, which wraps this runner with a timeout.

use std::path::Path;
use std::process::{Command, Stdio};
use crate::CommandNoWindow;

type Result<T> = std::result::Result<T, String>;

/// The git CLI's own version line — Err when git isn't installed or not on
/// PATH. The frontend surfaces this as an install notice.
pub fn git_version() -> Result<String> {
    let output = Command::new("git").no_window()
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git is not installed or not on PATH: {e}"))?;
    if !output.status.success() {
        return Err("git --version failed".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Current branch shorthand ("main", "" on an unborn branch).
pub fn current_branch(repo_path: &Path) -> Result<String> {
    let output = Command::new("git").no_window()
        .arg("-C")
        .arg(repo_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start git: {e}. Is git installed and on PATH?"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Runs one git command in the repository and returns its output (stdout, or
/// stderr when stdout is empty — git writes progress there).
pub fn run_git(repo_path: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git").no_window()
        .arg("-C")
        .arg(repo_path)
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
