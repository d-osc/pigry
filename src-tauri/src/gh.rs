//! GitHub data through the `gh` CLI — auth, pull requests, issues, releases.
//! Local git operations stay on git2; `gh` only covers GitHub-flavored data.

use serde::Serialize;
use std::path::Path;
use std::os::windows::process::CommandExt;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAuthStatus {
    pub logged_in: bool,
    pub account: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPullRequest {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub branch: String,
    pub base_ref: String,
    pub author: String,
    pub updated_at: String,
    pub url: String,
    pub review: String,
    pub checks_total: u32,
    pub checks_ok: u32,
    pub comments: u32,
    pub labels: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhIssue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub updated_at: String,
    pub url: String,
    pub comments: u32,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub milestone: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRelease {
    pub tag_name: String,
    pub name: String,
    pub published_at: String,
    pub is_latest: bool,
    pub is_draft: bool,
    pub is_prerelease: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhIssueDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub state_reason: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub milestone: String,
    pub comments: Vec<GhComment>,
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Spawns gh via PATH when available; after a fresh install the parent
/// process PATH is stale, so fall back to the known install locations.
fn gh_command() -> Command {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(format!(r"{pf}\GitHub CLI\gh.exe"));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!(r"{la}\Programs\GitHub CLI\gh.exe"));
    }
    if let Ok(up) = std::env::var("USERPROFILE") {
        candidates.push(format!(r"{up}\scoop\shims\gh.exe"));
    }
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            let mut cmd = Command::new(candidate);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd;
        }
    }
    let mut cmd = Command::new("gh");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Installs the GitHub CLI: winget first, scoop as fallback. Returns the
/// detected version on success.
pub fn install(repo_path: &Path) -> Result<String, String> {
    let winget = Command::new("winget")
        .args([
            "install",
            "-e",
            "--id",
            "GitHub.cli",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--silent",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .current_dir(repo_path)
        .output();
    if let Ok(out) = winget {
        if out.status.success() {
            return verify_gh();
        }
    }
    let scoop = Command::new("powershell")
        .args(["-NoProfile", "-Command", "scoop install gh"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    if let Ok(out) = scoop {
        if out.status.success() {
            return verify_gh();
        }
    }
    Err("could not install gh automatically — install it from https://cli.github.com".to_string())
}

fn verify_gh() -> Result<String, String> {
    let output = gh_command()
        .args(["--version"])
        .output()
        .map_err(|_| "installed but gh is still not reachable — restart the app".to_string())?;
    if !output.status.success() {
        return Err("installed but gh did not respond".to_string());
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("gh")
        .trim()
        .to_string();
    Ok(version)
}

fn run_gh(repo_path: &Path, args: &[&str]) -> Result<String, String> {
    let output = gh_command()
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn jstr(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn jarr_len(value: &serde_json::Value, key: &str) -> u32 {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u32)
        .unwrap_or(0)
}

fn jlabels(value: &serde_json::Value) -> Vec<String> {
    value
        .get("labels")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| jstr(item, "name"))
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// `gh auth status` — exit code 0 means logged in; the account name is parsed
/// from the human-readable output ("Logged in to github.com account NAME").
pub fn auth_status(repo_path: &Path) -> Result<GhAuthStatus, String> {
    let output = gh_command()
        .args(["auth", "status"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let logged_in = output.status.success() && text.to_lowercase().contains("logged in to");
    let account = text
        .lines()
        .find(|line| line.to_lowercase().contains("account"))
        .and_then(|line| line.split("account").nth(1))
        .map(|rest| {
            rest.split_whitespace()
                .next()
                .unwrap_or("")
                .trim_end_matches("(keyring)")
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    Ok(GhAuthStatus { logged_in, account })
}

pub fn pr_list(repo_path: &Path) -> Result<Vec<GhPullRequest>, String> {
    let out = run_gh(
        repo_path,
        &[
            "pr",
            "list",
            "--state",
            "all",
            "--limit",
            "50",
            "--json",
            "number,title,state,isDraft,headRefName,baseRefName,author,updatedAt,url,reviewDecision,statusCheckRollup,comments,labels",
        ],
    )?;
    let items: Vec<serde_json::Value> = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for item in items {
        let rollup = item.get("statusCheckRollup").and_then(|v| v.as_array());
        let (checks_total, checks_ok) = match rollup {
            Some(runs) => (
                runs.len() as u32,
                runs.iter()
                    .filter(|run| {
                        matches!(
                            run.get("conclusion").and_then(|c| c.as_str()),
                            Some("SUCCESS") | Some("SKIPPED") | Some("NEUTRAL")
                        )
                    })
                    .count() as u32,
            ),
            None => (0, 0),
        };
        result.push(GhPullRequest {
            number: item.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
            title: jstr(&item, "title"),
            state: jstr(&item, "state"),
            draft: item.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
            branch: jstr(&item, "headRefName"),
            base_ref: jstr(&item, "baseRefName"),
            author: item
                .get("author")
                .map(|a| jstr(a, "login"))
                .unwrap_or_default(),
            updated_at: jstr(&item, "updatedAt"),
            url: jstr(&item, "url"),
            review: jstr(&item, "reviewDecision"),
            checks_total,
            checks_ok,
            comments: jarr_len(&item, "comments"),
            labels: jlabels(&item),
        });
    }
    Ok(result)
}

pub fn issue_list(repo_path: &Path) -> Result<Vec<GhIssue>, String> {
    let out = run_gh(
        repo_path,
        &[
            "issue",
            "list",
            "--state",
            "all",
            "--limit",
            "50",
            "--json",
            "number,title,state,author,labels,assignees,milestone,updatedAt,url,comments",
        ],
    )?;
    let items: Vec<serde_json::Value> = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let result = items
        .iter()
        .map(|item| GhIssue {
            number: item.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
            title: jstr(item, "title"),
            state: jstr(item, "state"),
            author: item
                .get("author")
                .map(|a| jstr(a, "login"))
                .unwrap_or_default(),
            updated_at: jstr(item, "updatedAt"),
            url: jstr(item, "url"),
            comments: jarr_len(item, "comments"),
            labels: jlabels(item),
            assignees: item
                .get("assignees")
                .and_then(|v| v.as_array())
                .map(|users| {
                    users
                        .iter()
                        .map(|u| jstr(u, "login"))
                        .filter(|name| !name.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
            milestone: item
                .get("milestone")
                .map(|m| jstr(m, "title"))
                .unwrap_or_default(),
        })
        .collect();
    Ok(result)
}

/// Full issue detail via `gh issue view` — body, labels, assignees,
/// milestone and the comment thread.
pub fn issue_detail(repo_path: &Path, number: u64) -> Result<GhIssueDetail, String> {
    let out = run_gh(
        repo_path,
        &[
            "issue",
            "view",
            &number.to_string(),
            "--json",
            "number,title,body,state,stateReason,author,createdAt,updatedAt,url,labels,assignees,milestone,comments",
        ],
    )?;
    let item: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let comments = item
        .get("comments")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|comment| GhComment {
                    author: comment
                        .get("author")
                        .map(|a| jstr(a, "login"))
                        .unwrap_or_default(),
                    body: jstr(comment, "body"),
                    created_at: jstr(comment, "createdAt"),
                })
                .collect()
        })
        .unwrap_or_default();
    let assignees = item
        .get("assignees")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|a| jstr(a, "login"))
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();

    Ok(GhIssueDetail {
        number: item.get("number").and_then(|v| v.as_u64()).unwrap_or(number),
        title: jstr(&item, "title"),
        body: jstr(&item, "body"),
        state: jstr(&item, "state"),
        state_reason: jstr(&item, "stateReason"),
        author: item
            .get("author")
            .map(|a| jstr(a, "login"))
            .unwrap_or_default(),
        created_at: jstr(&item, "createdAt"),
        updated_at: jstr(&item, "updatedAt"),
        url: jstr(&item, "url"),
        labels: jlabels(&item),
        assignees,
        milestone: item
            .get("milestone")
            .map(|m| jstr(m, "title"))
            .unwrap_or_default(),
        comments,
    })
}

/// Posts an issue comment (body piped on stdin so newlines survive).
pub fn issue_comment(repo_path: &Path, number: u64, body: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = gh_command()
        .args(["issue", "comment", &number.to_string(), "--body-file", "-"])
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh not available: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|e| format!("failed to write comment: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh issue comment failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// Creates an issue (body piped on stdin); returns the new issue URL.
pub fn issue_create(repo_path: &Path, title: &str, body: &str) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = gh_command()
        .args(["issue", "create", "--title", title, "--body-file", "-"])
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh not available: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|e| format!("failed to write body: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh issue create failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(stdout
        .lines()
        .rev()
        .find(|line| line.contains("https://"))
        .unwrap_or("")
        .trim()
        .to_string())
}

/// Closes an issue (`gh issue close`).
pub fn issue_close(repo_path: &Path, number: u64) -> Result<(), String> {
    let output = gh_command()
        .args(["issue", "close", &number.to_string()])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// Reopens a previously closed issue (`gh issue reopen`).
pub fn issue_reopen(repo_path: &Path, number: u64) -> Result<(), String> {
    let output = gh_command()
        .args(["issue", "reopen", &number.to_string()])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

pub fn release_list(repo_path: &Path) -> Result<Vec<GhRelease>, String> {
    let out = run_gh(
        repo_path,
        &[
            "release",
            "list",
            "--limit",
            "30",
            "--json",
            "tagName,name,publishedAt,isDraft,isPrerelease,isLatest",
        ],
    )?;
    let items: Vec<serde_json::Value> = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let result = items
        .iter()
        .map(|item| GhRelease {
            tag_name: jstr(item, "tagName"),
            name: jstr(item, "name"),
            published_at: jstr(item, "publishedAt"),
            is_latest: item.get("isLatest").and_then(|v| v.as_bool()).unwrap_or(false),
            is_draft: item.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
            is_prerelease: item
                .get("isPrerelease")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        })
        .collect();
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAccount {
    pub name: String,
    pub active: bool,
    pub full_name: String,
    pub avatar_url: String,
    /// OAuth scopes granted to this account's token (from `gh auth status`).
    pub scopes: Vec<String>,
}

/// All accounts known to gh, parsed from `gh auth status` output:
/// "  ✓ Logged in to github.com account NAME (keyring)" followed by
/// "  - Active account: true|false".
/// Fetch profile fields for one login ("user" = active account) via gh api.
fn api_user(repo_path: &Path, login: Option<&str>) -> (String, String) {
    let target = match login {
        Some(name) => format!("users/{}", name),
        None => "user".to_string(),
    };
    let output = gh_command()
        .args(["api", &target, "--jq", "{name: .name, avatar_url: .avatar_url}"])
        .current_dir(repo_path)
        .output();
    let Ok(output) = output else { return (String::new(), String::new()) };
    if !output.status.success() {
        return (String::new(), String::new());
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    (
        value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        value
            .get("avatar_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    )
}

pub fn account_list(repo_path: &Path) -> Result<Vec<GhAccount>, String> {
    let output = gh_command()
        .args(["auth", "status"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut accounts: Vec<GhAccount> = Vec::new();
    for (name, active, scopes) in parse_auth_status(&text) {
        if accounts.len() < 5 {
            let (full_name, avatar_url) = api_user(repo_path, Some(&name));
            accounts.push(GhAccount {
                name,
                active,
                full_name,
                avatar_url,
                scopes,
            });
        } else {
            accounts.push(GhAccount {
                name,
                active,
                full_name: String::new(),
                avatar_url: String::new(),
                scopes,
            });
        }
    }
    Ok(accounts)
}

/// Parses `gh auth status` output into (name, active, scopes) blocks.
/// Account names keep their case (the match uses the lowercased copy, the
/// split uses the original line).
fn parse_auth_status(text: &str) -> Vec<(String, bool, Vec<String>)> {
    let mut blocks: Vec<(String, bool, Vec<String>)> = Vec::new();
    let mut name: Option<String> = None;
    let mut active = false;
    let mut scopes: Vec<String> = Vec::new();
    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains("logged in to") {
            if let Some(done) = name.take() {
                if !done.is_empty() {
                    blocks.push((done, active, std::mem::take(&mut scopes)));
                }
            }
            active = false;
            scopes.clear();
            if let Some(rest) = line.split("account ").nth(1) {
                let n = rest
                    .trim()
                    .trim_end_matches("(keyring)")
                    .trim()
                    .to_string();
                name = Some(n);
            }
        } else if lower.contains("active account") {
            active = lower.contains("true");
        } else if lower.contains("token scopes") {
            if let Some(rest) = line.split("scopes:").nth(1) {
                scopes = rest
                    .split(',')
                    .map(|item| {
                        item.trim()
                            .trim_matches('\'')
                            .trim_matches('\u{2019}')
                            .trim()
                            .to_string()
                    })
                    .filter(|item| !item.is_empty())
                    .collect();
            }
        }
    }
    if let Some(done) = name.take() {
        if !done.is_empty() {
            blocks.push((done, active, scopes));
        }
    }
    blocks
}

/// `gh auth switch --user NAME` — pick which account is active.
pub fn switch_account(repo_path: &Path, account: &str) -> Result<(), String> {
    let output = gh_command()
        .args(["auth", "switch", "--hostname", "github.com", "--user", account])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// `gh auth login --with-token` — pipe the token on stdin, then read status.
pub fn login_with_token(repo_path: &Path, token: &str) -> Result<GhAuthStatus, String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = gh_command()
        .args(["auth", "login", "--with-token"])
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh not available: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(token.as_bytes())
            .map_err(|e| format!("failed to write token: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh login failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    auth_status(repo_path)
}

/// `gh auth logout --user NAME` for the given account.
pub fn logout(repo_path: &Path, account: &str) -> Result<(), String> {
    let output = gh_command()
        .args(["auth", "logout", "--hostname", "github.com", "--user", account])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhScopes {
    pub scopes: Vec<String>,
}

/// Actual scopes granted to the current gh token — read from the
/// `X-OAuth-Scopes` response header of `gh api user -i`.
pub fn token_scopes(repo_path: &Path) -> Result<GhScopes, String> {
    let output = gh_command()
        .args(["api", "user", "-i"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        return Err(text.lines().next().unwrap_or("gh api failed").to_string());
    }
    let mut scopes: Vec<String> = Vec::new();
    for line in text.lines() {
        let lower = line.trim().to_lowercase();
        if let Some(rest) = lower.strip_prefix("x-oauth-scopes:") {
            scopes = rest
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            break;
        }
    }
    Ok(GhScopes { scopes })
}

/// Open a URL in the default browser (Windows shell).
pub fn open_url(url: &str) -> Result<(), String> {
    let output = Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("failed to open URL: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhReview {
    pub author: String,
    pub state: String,
    pub submitted_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPrFile {
    pub path: String,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPrCommit {
    pub oid: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCheck {
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub duration: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPrDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub base_ref: String,
    pub head_ref: String,
    pub updated_at: String,
    pub url: String,
    pub review_decision: String,
    pub mergeable: String,
    pub labels: Vec<String>,
    pub reviews: Vec<GhReview>,
    pub comments: Vec<GhComment>,
    pub files: Vec<GhPrFile>,
    pub commits: Vec<GhPrCommit>,
    pub checks: Vec<GhCheck>,
}

fn jnum_i64(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn fmt_duration(started_at: &str, completed_at: &str) -> String {
    match (chrono_parse(started_at), chrono_parse(completed_at)) {
        (Some(a), Some(b)) => {
            let secs = b.saturating_sub(a);
            if secs >= 60 {
                format!("{}m {}s", secs / 60, secs % 60)
            } else {
                format!("{secs}s")
            }
        }
        _ => String::new(),
    }
}

/// Minimal RFC3339 (`2026-11-08T14:24:53Z`) → epoch-seconds parser so run and
/// step durations render without pulling in a datetime crate.
fn chrono_parse(iso: &str) -> Option<u64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || (bytes[10] != b'T' && bytes[10] != b' ') {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { iso.get(from..to)?.parse::<i64>().ok() };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from civil date (Howard Hinnant's algorithm).
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86_400) + hour * 3_600 + minute * 60 + second).max(0) as u64)
}

/// Full pull request detail via `gh pr view`.
pub fn pr_detail(repo_path: &Path, number: u64) -> Result<GhPrDetail, String> {
    let num = number.to_string();
    let out = run_gh(
        repo_path,
        &[
            "pr",
            "view",
            &num,
            "--json",
            "number,title,body,state,isDraft,author,baseRefName,headRefName,updatedAt,url,reviewDecision,mergeable,labels,reviews,comments,files,commits,statusCheckRollup",
        ],
    )?;
    let item: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;

    let reviews = item
        .get("reviews")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|review| GhReview {
                    author: review
                        .get("author")
                        .map(|a| jstr(a, "login"))
                        .unwrap_or_default(),
                    state: jstr(review, "state"),
                    submitted_at: jstr(review, "submittedAt"),
                })
                .collect()
        })
        .unwrap_or_default();
    let comments = item
        .get("comments")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|comment| GhComment {
                    author: comment
                        .get("author")
                        .map(|a| jstr(a, "login"))
                        .unwrap_or_default(),
                    body: jstr(comment, "body"),
                    created_at: jstr(comment, "createdAt"),
                })
                .collect()
        })
        .unwrap_or_default();
    let files = item
        .get("files")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|file| GhPrFile {
                    path: jstr(file, "path"),
                    additions: jnum_i64(file, "additions"),
                    deletions: jnum_i64(file, "deletions"),
                })
                .collect()
        })
        .unwrap_or_default();
    let commits = item
        .get("commits")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|commit| GhPrCommit {
                    oid: jstr(commit, "oid"),
                    message: jstr(commit, "messageHeadline"),
                })
                .collect()
        })
        .unwrap_or_default();
    let checks = item
        .get("statusCheckRollup")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|check| {
                    let name = jstr(check, "name");
                    let name = if name.is_empty() { jstr(check, "context") } else { name };
                    GhCheck {
                        name,
                        status: jstr(check, "status"),
                        conclusion: jstr(check, "conclusion"),
                        duration: fmt_duration(&jstr(check, "startedAt"), &jstr(check, "completedAt")),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(GhPrDetail {
        number: item.get("number").and_then(|v| v.as_u64()).unwrap_or(number),
        title: jstr(&item, "title"),
        body: jstr(&item, "body"),
        state: jstr(&item, "state"),
        draft: item.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        author: item
            .get("author")
            .map(|a| jstr(a, "login"))
            .unwrap_or_default(),
        base_ref: jstr(&item, "baseRefName"),
        head_ref: jstr(&item, "headRefName"),
        updated_at: jstr(&item, "updatedAt"),
        url: jstr(&item, "url"),
        review_decision: jstr(&item, "reviewDecision"),
        mergeable: jstr(&item, "mergeable"),
        labels: jlabels(&item),
        reviews,
        comments,
        files,
        commits,
        checks,
    })
}

/// Unified diff of the pull request.
pub fn pr_diff(repo_path: &Path, number: u64) -> Result<String, String> {
    run_gh(repo_path, &["pr", "diff", &number.to_string()])
}

/// Posts a comment (body piped on stdin so newlines survive).
pub fn pr_comment(repo_path: &Path, number: u64, body: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = gh_command()
        .args(["pr", "comment", &number.to_string(), "--body-file", "-"])
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh not available: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|e| format!("failed to write comment: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh comment failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}


/// Submits a review: APPROVE / REQUEST_CHANGES / COMMENT, with optional body.
pub fn pr_review(
    repo_path: &Path,
    number: u64,
    event: &str,
    body: Option<&str>,
) -> Result<(), String> {
    let flag = match event {
        "APPROVE" => "--approve",
        "REQUEST_CHANGES" => "--request-changes",
        _ => "--comment",
    };
    let num = number.to_string();
    match body.filter(|b| !b.trim().is_empty()) {
        Some(text) => {
            use std::io::Write;
            use std::process::Stdio;

            let mut child = gh_command()
                .args(["pr", "review", &num, flag, "--body-file", "-"])
                .current_dir(repo_path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("gh not available: {e}"))?;
            if let Some(stdin) = child.stdin.as_mut() {
                stdin
                    .write_all(text.as_bytes())
                    .map_err(|e| format!("failed to write review: {e}"))?;
            }
            let output = child
                .wait_with_output()
                .map_err(|e| format!("gh review failed: {e}"))?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
        }
        None => {
            let output = gh_command()
                .args(["pr", "review", &num, flag])
                .current_dir(repo_path)
                .output()
                .map_err(|e| format!("gh not available: {e}"))?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
        }
    }
    Ok(())
}

/// Checks out the PR branch locally; returns the checked-out branch name.
pub fn pr_checkout(repo_path: &Path, number: u64) -> Result<String, String> {
    let num = number.to_string();
    let output = gh_command()
        .args(["pr", "checkout", &num])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let repo = git2::Repository::discover(repo_path).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;
    Ok(head.shorthand().unwrap_or("HEAD").to_string())
}

/// Creates a pull request; returns the new PR URL.
pub fn pr_create(
    repo_path: &Path,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = gh_command()
        .args([
            "pr",
            "create",
            "--title",
            title,
            "--body-file",
            "-",
            "--head",
            head,
            "--base",
            base,
        ])
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh not available: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|e| format!("failed to write body: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh pr create failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(stdout
        .lines()
        .rev()
        .find(|line| line.contains("https://"))
        .unwrap_or("")
        .trim()
        .to_string())
}

/// Closes a pull request.
pub fn pr_close(repo_path: &Path, number: u64) -> Result<(), String> {
    let output = gh_command()
        .args(["pr", "close", &number.to_string()])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAsset {
    pub name: String,
    pub size: u64,
    pub url: String,
    pub download_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhReleaseDetail {
    pub tag_name: String,
    pub name: String,
    pub body: String,
    pub published_at: String,
    pub created_at: String,
    pub is_latest: bool,
    pub is_draft: bool,
    pub is_prerelease: bool,
    pub author: String,
    pub url: String,
    pub assets: Vec<GhAsset>,
}

/// Full release detail via `gh release view`.
pub fn release_view(repo_path: &Path, tag: &str) -> Result<GhReleaseDetail, String> {
    let out = run_gh(
        repo_path,
        &[
            "release",
            "view",
            tag,
            "--json",
            "tagName,name,body,publishedAt,createdAt,isLatest,isDraft,isPrerelease,author,assets,url",
        ],
    )?;
    let item: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let assets = item
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|asset| GhAsset {
                    name: jstr(asset, "name"),
                    size: asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    url: jstr(asset, "url"),
                    download_count: asset
                        .get("downloadCount")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(GhReleaseDetail {
        tag_name: jstr(&item, "tagName"),
        name: jstr(&item, "name"),
        body: jstr(&item, "body"),
        published_at: jstr(&item, "publishedAt"),
        created_at: jstr(&item, "createdAt"),
        is_latest: item.get("isLatest").and_then(|v| v.as_bool()).unwrap_or(false),
        is_draft: item.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        is_prerelease: item
            .get("isPrerelease")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        author: item
            .get("author")
            .map(|a| jstr(a, "login"))
            .unwrap_or_default(),
        url: jstr(&item, "url"),
        assets,
    })
}

/// Creates a release (notes piped on stdin); returns the release URL.
pub fn release_create(
    repo_path: &Path,
    tag: &str,
    title: &str,
    notes: &str,
    target: Option<&str>,
    draft: bool,
    prerelease: bool,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut args: Vec<String> = vec![
        "release".to_string(),
        "create".to_string(),
        tag.to_string(),
        "--title".to_string(),
        title.to_string(),
        "--notes-file".to_string(),
        "-".to_string(),
    ];
    if let Some(target) = target.filter(|t| !t.trim().is_empty()) {
        args.push("--target".to_string());
        args.push(target.to_string());
    }
    if draft {
        args.push("--draft".to_string());
    }
    if prerelease {
        args.push("--prerelease".to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut child = gh_command()
        .args(&arg_refs)
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh not available: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(notes.as_bytes())
            .map_err(|e| format!("failed to write notes: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh release create failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(stdout
        .lines()
        .rev()
        .find(|line| line.contains("https://"))
        .unwrap_or("")
        .trim()
        .to_string())
}

/// Edits an existing release title + notes.
pub fn release_edit(repo_path: &Path, tag: &str, title: &str, notes: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = gh_command()
        .args(["release", "edit", tag, "--title", title, "--notes-file", "-"])
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh not available: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(notes.as_bytes())
            .map_err(|e| format!("failed to write notes: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh release edit failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// Deletes a release.
pub fn release_delete(repo_path: &Path, tag: &str) -> Result<(), String> {
    let output = gh_command()
        .args(["release", "delete", tag, "--yes"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhProject {
    pub number: u64,
    pub title: String,
    pub short_description: String,
    pub owner: String,
    pub closed: bool,
    pub updated_at: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhProjectIteration {
    pub title: String,
    pub start_date: String,
    pub end_date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhProjectItem {
    pub item_id: String,
    /// "issue" | "pr"
    pub kind: String,
    pub number: u64,
    pub title: String,
    pub repository: String,
    /// OPEN / CLOSED / MERGED (PRs)
    pub state: String,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    /// Value of the project's "Status" field ("" when unset).
    pub status: String,
    /// Iteration field value with planning dates, when set.
    pub iteration: Option<GhProjectIteration>,
    pub is_archived: bool,
    pub updated_at: String,
    pub url: String,
}

/// Text payload of a project field value — single-select options arrive under
/// `name`, iterations under `title`, text fields under `text`.
fn jfield_text(value: &serde_json::Value) -> String {
    for key in ["name", "title", "text"] {
        if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn jstring_array(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| {
                    if let Some(text) = entry.as_str() {
                        return Some(text.to_string());
                    }
                    if let Some(login) = entry.get("login").and_then(|v| v.as_str()) {
                        return Some(login.to_string());
                    }
                    None
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_project_item(item: &serde_json::Value) -> GhProjectItem {
    let mut status = String::new();
    let mut iteration: Option<GhProjectIteration> = None;
    if let Some(values) = item.get("fieldValues").and_then(|v| v.as_array()) {
        for value in values {
            let field_name = value
                .get("field")
                .map(|field| jstr(field, "name"))
                .unwrap_or_default();
            if field_name.eq_ignore_ascii_case("status") && status.is_empty() {
                status = jfield_text(value);
            }
            let start = jstr(value, "startDate");
            let end = jstr(value, "endDate");
            if !start.is_empty() && !end.is_empty() && iteration.is_none() {
                iteration = Some(GhProjectIteration {
                    title: jfield_text(value),
                    start_date: start,
                    end_date: end,
                });
            }
        }
    }
    let raw_kind = jstr(item, "type");
    let kind = if raw_kind.eq_ignore_ascii_case("pull_request") {
        "pr".to_string()
    } else {
        "issue".to_string()
    };
    GhProjectItem {
        item_id: jstr(item, "id"),
        kind,
        number: item.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
        title: jstr(item, "title"),
        repository: jstr(item, "repository"),
        state: jstr(item, "state"),
        assignees: jstring_array(item, "assignees"),
        labels: jlabels(item),
        status,
        iteration,
        is_archived: item
            .get("isArchived")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        updated_at: jstr(item, "updatedAt"),
        url: jstr(item, "url"),
    }
}

/// GitHub Projects (v2) owned by the repository's owner, via `gh project list`.
pub fn project_list(repo_path: &Path) -> Result<Vec<GhProject>, String> {
    let out = run_gh(
        repo_path,
        &["project", "list", "-L", "50", "--format", "json"],
    )?;
    let value: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let empty = Vec::new();
    let items = value
        .get("projects")
        .or(Some(&value))
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    Ok(items
        .iter()
        .map(|item| GhProject {
            number: item.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
            title: jstr(item, "title"),
            short_description: jstr(item, "shortDescription"),
            owner: item
                .get("owner")
                .map(|o| jstr(o, "login"))
                .unwrap_or_default(),
            closed: item.get("closed").and_then(|v| v.as_bool()).unwrap_or(false),
            updated_at: jstr(item, "updatedAt"),
            url: jstr(item, "url"),
        })
        .collect())
}

/// Items of one project, via `gh project item-list` — Status and Iteration
/// fields are parsed out of each item's `fieldValues`.
pub fn project_item_list(
    repo_path: &Path,
    project_number: u64,
) -> Result<Vec<GhProjectItem>, String> {
    let num = project_number.to_string();
    let out = run_gh(
        repo_path,
        &["project", "item-list", &num, "-L", "100", "--format", "json"],
    )?;
    let value: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let empty = Vec::new();
    let items = value
        .get("items")
        .or(Some(&value))
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    Ok(items.iter().map(parse_project_item).collect())
}

// ---- Actions (workflow runs) ----

fn jnum_u64(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhWorkflow {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhWorkflowRun {
    pub id: u64,
    pub number: u64,
    pub title: String,
    pub workflow_name: String,
    pub workflow_id: u64,
    pub event: String,
    pub branch: String,
    pub sha: String,
    pub status: String,
    pub conclusion: String,
    pub created_at: String,
    pub started_at: String,
    pub updated_at: String,
    pub url: String,
    pub attempt: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRunPage {
    pub runs: Vec<GhWorkflowRun>,
    /// Total runs on the repository (REST `total_count`); falls back to the
    /// fetched length when the API call is unavailable.
    pub total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRunStep {
    pub name: String,
    pub number: u64,
    pub status: String,
    pub conclusion: String,
    pub duration: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRunJob {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub duration: String,
    pub steps: Vec<GhRunStep>,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRunDetail {
    pub id: u64,
    pub number: u64,
    pub title: String,
    pub workflow_name: String,
    pub workflow_id: u64,
    pub event: String,
    pub branch: String,
    pub sha: String,
    pub status: String,
    pub conclusion: String,
    pub attempt: u64,
    pub created_at: String,
    pub started_at: String,
    pub updated_at: String,
    pub url: String,
    pub jobs: Vec<GhRunJob>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRunArtifact {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub expired: bool,
    pub expires_at: String,
    pub created_at: String,
}

/// `gh workflow list --all` — every workflow defined on the repository.
pub fn workflow_list(repo_path: &Path) -> Result<Vec<GhWorkflow>, String> {
    let out = run_gh(
        repo_path,
        &[
            "workflow",
            "list",
            "--all",
            "--limit",
            "100",
            "--json",
            "id,name,path,state",
        ],
    )?;
    // gh prints nothing (not `[]`) when the repository has no workflows.
    if out.trim().is_empty() {
        return Ok(Vec::new());
    }
    let items: Vec<serde_json::Value> = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    Ok(items
        .iter()
        .map(|item| GhWorkflow {
            id: jnum_u64(item, "id"),
            name: jstr(item, "name"),
            path: jstr(item, "path"),
            state: jstr(item, "state"),
        })
        .collect())
}

/// `gh api` against the current repository — the `:owner`/`:repo` placeholders
/// resolve from the git remote. Returns the jq-extracted field if numeric.
fn gh_api_u64(repo_path: &Path, endpoint: &str) -> Option<u64> {
    let output = gh_command()
        .args(["api", endpoint, "--jq", ".total_count"])
        .current_dir(repo_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .ok()
}

/// `gh run list` — recent workflow runs, plus the repository's total run count.
pub fn run_list(repo_path: &Path, limit: u32) -> Result<GhRunPage, String> {
    let limit_s = limit.to_string();
    let out = run_gh(
        repo_path,
        &[
            "run",
            "list",
            "--limit",
            &limit_s,
            "--json",
            "databaseId,displayTitle,workflowName,workflowDatabaseId,number,event,headBranch,headSha,status,conclusion,createdAt,startedAt,updatedAt,url,attempt",
        ],
    )?;
    // Older gh builds print nothing instead of `[]` on empty results.
    if out.trim().is_empty() {
        return Ok(GhRunPage { runs: Vec::new(), total: 0 });
    }
    let items: Vec<serde_json::Value> = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let runs: Vec<GhWorkflowRun> = items
        .iter()
        .map(|item| GhWorkflowRun {
            id: jnum_u64(item, "databaseId"),
            number: jnum_u64(item, "number"),
            title: jstr(item, "displayTitle"),
            workflow_name: jstr(item, "workflowName"),
            workflow_id: jnum_u64(item, "workflowDatabaseId"),
            event: jstr(item, "event"),
            branch: jstr(item, "headBranch"),
            sha: jstr(item, "headSha"),
            status: jstr(item, "status"),
            conclusion: jstr(item, "conclusion"),
            created_at: jstr(item, "createdAt"),
            started_at: jstr(item, "startedAt"),
            updated_at: jstr(item, "updatedAt"),
            url: jstr(item, "url"),
            attempt: jnum_u64(item, "attempt"),
        })
        .collect();
    let total = gh_api_u64(repo_path, "repos/:owner/:repo/actions/runs?per_page=1")
        .unwrap_or(runs.len() as u64);
    Ok(GhRunPage { runs, total })
}

/// `gh run view <id>` — run detail with jobs and their steps.
pub fn run_view(repo_path: &Path, run_id: u64) -> Result<GhRunDetail, String> {
    let id = run_id.to_string();
    let out = run_gh(
        repo_path,
        &[
            "run",
            "view",
            &id,
            "--json",
            "attempt,conclusion,createdAt,displayTitle,event,headBranch,headSha,jobs,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName",
        ],
    )?;
    let item: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let jobs = item
        .get("jobs")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|job| {
                    let steps = job
                        .get("steps")
                        .and_then(|v| v.as_array())
                        .map(|ss| {
                            ss.iter()
                                .map(|s| GhRunStep {
                                    name: jstr(s, "name"),
                                    number: jnum_u64(s, "number"),
                                    status: jstr(s, "status"),
                                    conclusion: jstr(s, "conclusion"),
                                    duration: fmt_duration(
                                        &jstr(s, "startedAt"),
                                        &jstr(s, "completedAt"),
                                    ),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    GhRunJob {
                        id: jnum_u64(job, "databaseId"),
                        name: jstr(job, "name"),
                        status: jstr(job, "status"),
                        conclusion: jstr(job, "conclusion"),
                        duration: fmt_duration(&jstr(job, "startedAt"), &jstr(job, "completedAt")),
                        steps,
                        url: jstr(job, "url"),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(GhRunDetail {
        id: jnum_u64(&item, "databaseId").max(run_id),
        number: jnum_u64(&item, "number"),
        title: jstr(&item, "displayTitle"),
        workflow_name: jstr(&item, "workflowName"),
        workflow_id: jnum_u64(&item, "workflowDatabaseId"),
        event: jstr(&item, "event"),
        branch: jstr(&item, "headBranch"),
        sha: jstr(&item, "headSha"),
        status: jstr(&item, "status"),
        conclusion: jstr(&item, "conclusion"),
        attempt: jnum_u64(&item, "attempt"),
        created_at: jstr(&item, "createdAt"),
        started_at: jstr(&item, "startedAt"),
        updated_at: jstr(&item, "updatedAt"),
        url: jstr(&item, "url"),
        jobs,
    })
}

/// Logs are tail-truncated past this many bytes to keep IPC payloads sane.
const LOG_MAX_BYTES: usize = 400_000;

/// Full log for a run, or for one of its jobs. gh emits
/// `<job>\t<step>\t<timestamp> <line>` per log line.
pub fn run_logs(repo_path: &Path, run_id: u64, job_id: Option<u64>) -> Result<String, String> {
    let id = run_id.to_string();
    let mut out = match job_id {
        Some(job) => {
            let job = job.to_string();
            run_gh(repo_path, &["run", "view", &id, "--job", &job, "--log"])?
        }
        None => run_gh(repo_path, &["run", "view", &id, "--log"])?,
    };
    if out.len() > LOG_MAX_BYTES {
        // Keep the newest lines whole — recent output is what matters.
        let mut kept: Vec<&str> = Vec::new();
        let mut total = 0;
        for line in out.lines().rev() {
            total += line.len() + 1;
            if total > LOG_MAX_BYTES {
                break;
            }
            kept.push(line);
        }
        kept.reverse();
        out = format!(
            "[log truncated — showing the last {} lines]\n{}",
            kept.len(),
            kept.join("\n")
        );
    }
    Ok(out)
}

/// `gh run rerun <id>` — the whole run, or only its failed jobs.
pub fn run_rerun(repo_path: &Path, run_id: u64, failed_only: bool) -> Result<(), String> {
    let id = run_id.to_string();
    let args: Vec<&str> = if failed_only {
        vec!["run", "rerun", &id, "--failed"]
    } else {
        vec!["run", "rerun", &id]
    };
    let output = gh_command()
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// `gh run cancel <id>` — abort a queued or in-progress run.
pub fn run_cancel(repo_path: &Path, run_id: u64) -> Result<(), String> {
    let id = run_id.to_string();
    let output = gh_command()
        .args(["run", "cancel", &id])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// `gh workflow run <path> --ref <ref>` — trigger a workflow_dispatch.
pub fn workflow_dispatch(
    repo_path: &Path,
    workflow_path: &str,
    ref_name: &str,
) -> Result<(), String> {
    let output = gh_command()
        .args(["workflow", "run", workflow_path, "--ref", ref_name])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// Artifacts uploaded by a run, via the REST API.
pub fn run_artifacts(repo_path: &Path, run_id: u64) -> Result<Vec<GhRunArtifact>, String> {
    let out = run_gh(
        repo_path,
        &[
            "api",
            &format!("repos/:owner/:repo/actions/runs/{run_id}/artifacts"),
            "--jq",
            ".artifacts",
        ],
    )?;
    if out.trim().is_empty() {
        return Ok(Vec::new());
    }
    let items: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let empty = Vec::new();
    let arr = items.as_array().unwrap_or(&empty);
    Ok(arr
        .iter()
        .map(|item| GhRunArtifact {
            id: jnum_u64(item, "id"),
            name: jstr(item, "name"),
            size: jnum_u64(item, "size_in_bytes"),
            expired: item.get("expired").and_then(|v| v.as_bool()).unwrap_or(false),
            expires_at: jstr(item, "expires_at"),
            created_at: jstr(item, "created_at"),
        })
        .collect())
}

/// `gh run download <run> --name <name>` into the OS temp folder; returns the
/// folder the artifact was unpacked into.
pub fn run_download_artifact(repo_path: &Path, run_id: u64, name: &str) -> Result<String, String> {
    let safe_name: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let dest = std::env::temp_dir().join(format!("orbit-artifacts/run-{run_id}/{safe_name}"));
    std::fs::create_dir_all(&dest).map_err(|e| format!("failed to create download folder: {e}"))?;
    let dest_s = dest.to_string_lossy().to_string();
    let output = gh_command()
        .args([
            "run",
            "download",
            &run_id.to_string(),
            "--name",
            name,
            "--dir",
            &dest_s,
        ])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(dest_s)
}

#[cfg(test)]
mod account_parse_tests {
    #[test]
    fn parses_scopes_per_account() {
        let text = concat!(
            "github.com\n",
            "  \u{2713} Logged in to github.com account n-devs (keyring)\n",
            "  - Active account: true\n",
            "  - Git operations protocol: https\n",
            "  - Token: gho_****\n",
            "  - Token scopes: 'admin:org', 'delete_repo', 'workflow'\n",
            "\n",
            "  \u{2713} Logged in to github.com account NatthP49 (keyring)\n",
            "  - Active account: false\n",
            "  - Token: gho_****\n",
            "  - Token scopes: 'repo', 'workflow'\n",
        );
        let parsed = super::parse_auth_status(text);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0, "n-devs", "account name keeps its case");
        assert!(parsed[0].1, "first account is active");
        assert!(parsed[0].2.contains(&"workflow".to_string()));
        assert!(parsed[0].2.contains(&"admin:org".to_string()));
        assert_eq!(parsed[1].0, "NatthP49");
        assert!(!parsed[1].1);
        assert_eq!(parsed[1].2.len(), 2);
    }

    #[test]
    fn tolerates_missing_scope_lines() {
        let text = "  \u{2713} Logged in to github.com account solo (keyring)\n  - Active account: true\n";
        let parsed = super::parse_auth_status(text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0, "solo");
        assert!(parsed[0].2.is_empty());
    }
}

#[cfg(test)]
mod actions_tests {
    use super::chrono_parse;

    #[test]
    fn parses_rfc3339_utc() {
        // 2026-11-08T14:24:53Z == 1794147893 epoch seconds.
        assert_eq!(chrono_parse("2026-11-08T14:24:53Z"), Some(1_794_147_893));
    }

    #[test]
    fn duration_formats() {
        assert_eq!(
            super::fmt_duration("2026-11-08T14:24:53Z", "2026-11-08T14:27:25Z"),
            "2m 32s"
        );
        assert_eq!(
            super::fmt_duration("2026-11-08T14:24:53Z", "2026-11-08T14:24:58Z"),
            "5s"
        );
        assert_eq!(super::fmt_duration("", "2026-11-08T14:27:25Z"), "");
    }
}

// ---------------------------------------------------------------------------
// Device flow — adds scopes to the gh OAuth token without a terminal.
// Uses the GitHub CLI's public OAuth client id (same flow `gh auth refresh`
// performs) via curl, then feeds the resulting token to `gh auth login`.
// ---------------------------------------------------------------------------

const GH_CLIENT_ID: &str = "178c6fc778ccc68e1d6a";

fn curl_form(url: &str, fields: &[String]) -> Result<String, String> {
    let mut args: Vec<String> = vec!["-s".to_string(), "-X".to_string(), "POST".to_string(), "-H".to_string(), "Accept: application/json".to_string()];
    for field in fields {
        args.push("--data".to_string());
        args.push(field.clone());
    }
    args.push(url.to_string());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = Command::new("curl")
        .args(&arg_refs)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("curl not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn urlencode_form_value(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace(':', "%3A")
        .replace('&', "%26")
        .replace('+', "%2B")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhDeviceStart {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
}

/// Step 1 — request a device code for the requested scopes.
pub fn device_flow_start(repo_path: &Path, scopes: &[String]) -> Result<GhDeviceStart, String> {
    if scopes.is_empty() {
        return Err("select at least one scope".to_string());
    }
    let scope_field = format!("scope={}", urlencode_form_value(&scopes.join(" ")));
    let client_field = format!("client_id={}", GH_CLIENT_ID);
    let body = curl_form(
        "https://github.com/login/device/code",
        &[client_field, scope_field],
    )?;
    let item: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if let Some(err) = item.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(GhDeviceStart {
        user_code: jstr(&item, "user_code"),
        verification_uri: jstr(&item, "verification_uri"),
        device_code: jstr(&item, "device_code"),
        interval: item.get("interval").and_then(|v| v.as_u64()).unwrap_or(5),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhDevicePoll {
    pub status: String,
    pub account: String,
    pub error: String,
}

/// Step 2 — poll while the user authorizes; on success the access token is
/// fed straight into `gh auth login --with-token` so gh gains the scopes.
pub fn device_flow_poll(repo_path: &Path, device_code: &str) -> Result<GhDevicePoll, String> {
    let client_field = format!("client_id={}", GH_CLIENT_ID);
    let device_field = format!("device_code={}", device_code);
    let grant_field = "grant_type=urn:ietf:params:oauth:grant-type:device_code".to_string();
    let body = curl_form(
        "https://github.com/login/oauth/access_token",
        &[client_field, device_field, grant_field],
    )?;
    let item: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    if let Some(err) = item.get("error").and_then(|v| v.as_str()) {
        let status = match err {
            "authorization_pending" | "slow_down" => "pending".to_string(),
            "expired_token" => "error".to_string(),
            other => format!("error: {}", other),
        };
        return Ok(GhDevicePoll { status, account: String::new(), error: err.to_string() });
    }

    let token = jstr(&item, "access_token");
    if token.is_empty() {
        return Ok(GhDevicePoll { status: "pending".to_string(), account: String::new(), error: String::new() });
    }

    login_with_token(repo_path, &token)?;
    let status = auth_status(repo_path)?;
    Ok(GhDevicePoll { status: "success".to_string(), account: status.account, error: String::new() })
}

// ---- Security and quality: code scanning, Dependabot, secret scanning,
// ---- branch check runs — all through `gh api` against the repository the
// ---- gh CLI resolves in the working directory.

/// "owner/name" of the repository the gh CLI resolves in `repo_path`.
fn repo_slug(repo_path: &Path) -> Result<(String, String), String> {
    let out = run_gh(repo_path, &["repo", "view", "--json", "owner,name"])?;
    let value: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let owner = value
        .get("owner")
        .map(|o| jstr(o, "login"))
        .unwrap_or_default();
    let name = jstr(&value, "name");
    if owner.is_empty() || name.is_empty() {
        return Err("could not resolve the GitHub repository — the working copy has no GitHub remote".to_string());
    }
    Ok((owner, name))
}

fn gh_api_value(repo_path: &Path, path: &str) -> Result<serde_json::Value, String> {
    let out = run_gh(repo_path, &["api", path])?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

/// Normalize GitHub severity spellings (moderate → medium, CRITICAL → critical).
fn sev_norm(raw: &str) -> String {
    let l = raw.to_lowercase();
    if l.contains("critical") {
        "critical".to_string()
    } else if l.contains("high") {
        "high".to_string()
    } else if l.contains("medium") || l.contains("moderate") {
        "medium".to_string()
    } else {
        "low".to_string()
    }
}

fn jstring_list(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| entry.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCodeAlert {
    pub number: u64,
    pub state: String,
    pub severity: String,
    pub rule_id: String,
    pub rule_description: String,
    pub rule_tags: Vec<String>,
    pub tool: String,
    pub path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub created_at: String,
    pub html_url: String,
}

/// Open code scanning alerts (Code scanning requires it to be enabled on the
/// repository and the token to hold the security_events scope).
pub fn code_scanning_alerts(repo_path: &Path) -> Result<Vec<GhCodeAlert>, String> {
    let (owner, name) = repo_slug(repo_path)?;
    let value = gh_api_value(
        repo_path,
        &format!("/repos/{owner}/{name}/code-scanning/alerts?state=open&per_page=50"),
    )?;
    let empty = Vec::new();
    let items = value.as_array().unwrap_or(&empty);
    Ok(items
        .iter()
        .map(|alert| {
            let rule = alert.get("rule");
            let location = alert
                .get("most_recent_instance")
                .and_then(|instance| instance.get("location"));
            GhCodeAlert {
                number: jnum_u64(alert, "number"),
                state: jstr(alert, "state"),
                severity: rule
                    .map(|r| sev_norm(&jstr(r, "security_severity_level")))
                    .unwrap_or_else(|| "low".to_string()),
                rule_id: rule.map(|r| jstr(r, "id")).unwrap_or_default(),
                rule_description: rule.map(|r| jstr(r, "description")).unwrap_or_default(),
                rule_tags: rule
                    .map(|r| jstring_list(r, "tags"))
                    .unwrap_or_default(),
                tool: alert.get("tool").map(|t| jstr(t, "name")).unwrap_or_default(),
                path: location
                    .map(|l| jstr(l, "path"))
                    .unwrap_or_default(),
                start_line: location
                    .map(|l| jnum_i64(l, "start_line"))
                    .unwrap_or(0),
                end_line: location.map(|l| jnum_i64(l, "end_line")).unwrap_or(0),
                created_at: jstr(alert, "created_at"),
                html_url: jstr(alert, "html_url"),
            }
        })
        .collect())
}

/// Dismisses a code scanning alert ("false_positive" / "used_in_tests" /
/// "won't_fix" / "no_bandwidth" / "not_applicable").
pub fn code_alert_dismiss(repo_path: &Path, number: u64, reason: &str) -> Result<(), String> {
    let (owner, name) = repo_slug(repo_path)?;
    let path = format!("/repos/{owner}/{name}/code-scanning/alerts/{number}");
    let reason_field = format!("reason={reason}");
    run_gh(
        repo_path,
        &[
            "api",
            "--method",
            "PATCH",
            &path,
            "-f",
            "state=dismissed",
            "-f",
            &reason_field,
        ],
    )?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhDependabotAlert {
    pub number: u64,
    pub state: String,
    pub severity: String,
    pub summary: String,
    pub package: String,
    pub ecosystem: String,
    pub scope: String,
    pub manifest_path: String,
    pub vulnerable_range: String,
    pub patched_version: String,
    pub created_at: String,
    pub html_url: String,
}

/// Open Dependabot alerts.
pub fn dependabot_alerts(repo_path: &Path) -> Result<Vec<GhDependabotAlert>, String> {
    let (owner, name) = repo_slug(repo_path)?;
    let value = gh_api_value(
        repo_path,
        &format!("/repos/{owner}/{name}/dependabot/alerts?state=open&per_page=50"),
    )?;
    let empty = Vec::new();
    let items = value.as_array().unwrap_or(&empty);
    Ok(items
        .iter()
        .map(|alert| {
            let dependency = alert.get("dependency");
            let package = dependency
                .and_then(|d| d.get("package"))
                .map(|p| jstr(p, "name"))
                .unwrap_or_default();
            let advisory = alert.get("security_advisory");
            let vulnerability = alert.get("security_vulnerability");
            GhDependabotAlert {
                number: jnum_u64(alert, "number"),
                state: jstr(alert, "state"),
                severity: advisory
                    .map(|a| sev_norm(&jstr(a, "severity")))
                    .unwrap_or_else(|| "low".to_string()),
                summary: advisory.map(|a| jstr(a, "summary")).unwrap_or_default(),
                package,
                ecosystem: dependency
                    .and_then(|d| d.get("package"))
                    .map(|p| jstr(p, "ecosystem"))
                    .unwrap_or_default(),
                scope: dependency
                    .map(|d| jstr(d, "scope"))
                    .unwrap_or_default(),
                manifest_path: dependency
                    .map(|d| jstr(d, "manifest_path"))
                    .unwrap_or_default(),
                vulnerable_range: vulnerability
                    .map(|v| jstr(v, "vulnerable_version_range"))
                    .unwrap_or_default(),
                patched_version: vulnerability
                    .and_then(|v| v.get("first_patched_version"))
                    .map(|p| jstr(p, "identifier"))
                    .unwrap_or_default(),
                created_at: jstr(alert, "created_at"),
                html_url: jstr(alert, "html_url"),
            }
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhSecretAlert {
    pub number: u64,
    pub state: String,
    pub secret_type: String,
    pub created_at: String,
    pub html_url: String,
}

/// Open secret scanning alerts (secret values are never returned here).
pub fn secret_scanning_alerts(repo_path: &Path) -> Result<Vec<GhSecretAlert>, String> {
    let (owner, name) = repo_slug(repo_path)?;
    let value = gh_api_value(
        repo_path,
        &format!("/repos/{owner}/{name}/secret-scanning/alerts?state=open&per_page=50"),
    )?;
    let empty = Vec::new();
    let items = value.as_array().unwrap_or(&empty);
    Ok(items
        .iter()
        .map(|alert| GhSecretAlert {
            number: jnum_u64(alert, "number"),
            state: jstr(alert, "state"),
            secret_type: jstr(alert, "secret_type_display_name"),
            created_at: jstr(alert, "created_at"),
            html_url: jstr(alert, "html_url"),
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCheckRun {
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub started_at: String,
    pub completed_at: String,
    pub details_url: String,
    pub app: String,
}

/// Check runs attached to a branch head on GitHub ("Quality checks").
pub fn branch_check_runs(repo_path: &Path, branch: &str) -> Result<Vec<GhCheckRun>, String> {
    if branch.is_empty() || branch.chars().any(|c| c.is_whitespace() || c == '?' || c == '#') {
        return Err(format!("invalid branch reference: {branch}"));
    }
    let (owner, name) = repo_slug(repo_path)?;
    let value = gh_api_value(
        repo_path,
        &format!("/repos/{owner}/{name}/commits/{branch}/check-runs?per_page=100"),
    )?;
    let empty = Vec::new();
    let items = value
        .get("check_runs")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    Ok(items
        .iter()
        .map(|run| GhCheckRun {
            name: jstr(run, "name"),
            status: jstr(run, "status"),
            conclusion: jstr(run, "conclusion"),
            started_at: jstr(run, "startedAt"),
            completed_at: jstr(run, "completedAt"),
            details_url: jstr(run, "details_url"),
            app: run.get("app").map(|a| jstr(a, "slug")).unwrap_or_default(),
        })
        .collect())
}
