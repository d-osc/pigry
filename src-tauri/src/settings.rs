//! Repository settings: user identity and remote management.
//! Identity is written to the repo-local config only (never global).

use std::path::Path;

use git2::{Config, Repository};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUserInfo {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub url: String,
}

fn open(repo_path: &Path) -> Result<Repository, String> {
    Repository::open(repo_path).map_err(|e| e.message().to_string())
}

/// The repo-local `.git/config`, opened for writing.
fn local_config(repo: &Repository) -> Result<Config, String> {
    let path = repo
        .path()
        .join("config");
    Config::open(&path).map_err(|e| e.message().to_string())
}

/// Effective user identity: local override first, then global/system config.
pub fn get_user_info(repo_path: &Path) -> Result<GitUserInfo, String> {
    let repo = open(repo_path)?;
    let config = repo.config().map_err(|e| e.message().to_string())?;
    Ok(GitUserInfo {
        name: config.get_string("user.name").ok(),
        email: config.get_string("user.email").ok(),
    })
}

/// Persists identity in the local config so commits made from pigry are
/// attributed to this account without changing the machine-wide setting.
pub fn set_user_info(repo_path: &Path, name: &str, email: &str) -> Result<(), String> {
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() || email.is_empty() {
        return Err("name and email must not be empty".to_string());
    }
    if !email.contains('@') {
        return Err("email does not look valid".to_string());
    }
    let repo = open(repo_path)?;
    let mut config = local_config(&repo)?;
    config
        .set_str("user.name", name)
        .map_err(|e| e.message().to_string())?;
    config
        .set_str("user.email", email)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

/// All configured remotes in fetch order.
pub fn list_remotes(repo_path: &Path) -> Result<Vec<RemoteEntry>, String> {
    let repo = open(repo_path)?;
    let names = repo.remotes().map_err(|e| e.message().to_string())?;
    let mut out = Vec::new();
    for name in names.iter().flatten() {
        let remote = repo
            .find_remote(name)
            .map_err(|e| e.message().to_string())?;
        out.push(RemoteEntry {
            name: name.to_string(),
            url: remote.url().unwrap_or("").to_string(),
        });
    }
    Ok(out)
}

/// Registers a new remote. Git rejects duplicate or invalid names.
pub fn add_remote(repo_path: &Path, name: &str, url: &str) -> Result<(), String> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() || url.is_empty() {
        return Err("remote name and URL must not be empty".to_string());
    }
    let repo = open(repo_path)?;
    repo.remote(name, url)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn remove_remote(repo_path: &Path, name: &str) -> Result<(), String> {
    let repo = open(repo_path)?;
    repo.remote_delete(name)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn set_remote_url(repo_path: &Path, name: &str, url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("remote URL must not be empty".to_string());
    }
    let repo = open(repo_path)?;
    repo.remote_set_url(name, url)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests;
