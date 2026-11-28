//! GitHub wiki support. A GitHub wiki is an ordinary git repository at
//! `<origin>.wiki.git`, so the whole feature rides on the git CLI (same hybrid
//! approach as net.rs — authentication flows through the user's credential
//! helper). The wiki clone is cached under the OS app-config dir, never inside
//! the watched worktree.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use crate::CommandNoWindow;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

type Result<T> = std::result::Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiStatus {
    /// True when origin points at github.com (wikis only exist there).
    pub supported: bool,
    /// True when the wiki repository exists on GitHub.
    pub has_wiki: bool,
    pub url: String,
    /// True when a local clone of the wiki already exists.
    pub cached: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    /// File name inside the wiki repo, e.g. "Getting-Started.md".
    pub file: String,
    /// Display title, e.g. "Getting Started".
    pub title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageContent {
    pub file: String,
    pub title: String,
    pub content: String,
    pub author: String,
    /// Last editor's email — for the byline's profile picture.
    pub author_email: String,
    pub updated_at: String,
    pub commit_message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiCommit {
    pub oid: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

fn run_git(dir: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git").no_window()
        .arg("-C")
        .arg(dir)
        .arg("-c")
        // Headless: GCM still supplies stored credentials, but never prompts.
        .arg("credential.interactive=false")
        .args(args)
        .no_window()
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
fn run_git_timed(dir: &Path, args: &[&str]) -> Result<String> {
    let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let dir = dir.to_path_buf();
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
        let result = run_git(&dir, &refs);
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

/// Reads the origin remote URL via libgit2 (handles worktrees and `.git` files).
fn origin_url(repo_path: &Path) -> Option<String> {
    let repo = git2::Repository::discover(repo_path).ok()?;
    let remote = repo.find_remote("origin").ok()?;
    remote.url().map(|s| s.to_string())
}

/// `https://github.com/owner/repo.git` → `https://github.com/owner/repo.wiki.git`.
/// Returns None for non-GitHub origins (wikis are a GitHub feature).
pub fn wiki_url(origin: &str) -> Option<String> {
    if !origin.contains("github.com") {
        return None;
    }
    let trimmed = origin.trim_end_matches('/');
    let base = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    if base.ends_with(".wiki") {
        return None;
    }
    Some(format!("{base}.wiki.git"))
}

/// Stable per-repository cache directory name: readable tail + URL hash.
fn cache_key(url: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    let tail: String = url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("{tail}-{hash:016x}")
}

fn cache_dir(cache_root: &Path, url: &str) -> PathBuf {
    cache_root.join(cache_key(url))
}

/// Resolves the wiki URL from the origin remote — local, no network.
pub fn url_for(repo_path: &Path) -> Result<String> {
    let origin = origin_url(repo_path).ok_or("no origin remote configured")?;
    wiki_url(&origin).ok_or_else(|| "wiki requires a github.com origin".to_string())
}

/// Probes the wiki: origin support, existence on GitHub, local cache state.
pub fn check(repo_path: &Path, cache_root: &Path) -> Result<WikiStatus> {
    let Some(origin) = origin_url(repo_path) else {
        return Ok(WikiStatus {
            supported: false,
            has_wiki: false,
            url: String::new(),
            cached: false,
        });
    };
    let Some(url) = wiki_url(&origin) else {
        return Ok(WikiStatus {
            supported: false,
            has_wiki: false,
            url: String::new(),
            cached: false,
        });
    };
    let cached = cache_dir(cache_root, &url).join(".git").exists();

    // `git ls-remote` succeeds only when the wiki repository exists.
    let probe = run_git_timed(repo_path, &["ls-remote", &url, "HEAD"]);
    let has_wiki = match probe {
        Ok(_) => true,
        Err(message) => {
            let lower = message.to_lowercase();
            if lower.contains("not found") || lower.contains("does not appear") {
                false
            } else {
                return Err(message);
            }
        }
    };
    Ok(WikiStatus {
        supported: true,
        has_wiki,
        url,
        cached,
    })
}

/// Clones the wiki into the cache, or fast-forwards an existing clone to the
/// remote HEAD (`reset --hard FETCH_HEAD` — branch-name agnostic).
pub fn sync(cache_root: &Path, url: &str) -> Result<()> {
    let dir = cache_dir(cache_root, url);
    if dir.join(".git").exists() {
        run_git_timed(&dir, &["fetch", "--prune", "origin"])?;
        run_git_timed(&dir, &["reset", "--hard", "FETCH_HEAD"])?;
        Ok(())
    } else {
        fs::create_dir_all(cache_root).map_err(|e| e.to_string())?;
        let dir_str = dir.to_string_lossy().to_string();
        run_git_timed(cache_root, &["clone", "--quiet", url, &dir_str])?;
        Ok(())
    }
}

fn wiki_dir(cache_root: &Path, url: &str) -> Result<PathBuf> {
    let dir = cache_dir(cache_root, url);
    if !dir.join(".git").exists() {
        return Err("wiki not cloned yet".to_string());
    }
    Ok(dir)
}

/// Rejects path traversal — page names arrive from the webview.
fn safe_file(file: &str) -> Result<()> {
    if file.is_empty()
        || file.contains('/')
        || file.contains('\\')
        || file.contains("..")
        || file.starts_with('.')
    {
        return Err(format!("invalid wiki page name: {file}"));
    }
    Ok(())
}

/// Lists wiki pages: every top-level `.md` file, Home first, then alphabetical.
pub fn list(cache_root: &Path, url: &str) -> Result<Vec<WikiPage>> {
    let dir = match wiki_dir(cache_root, url) {
        Ok(dir) => dir,
        // Not cloned yet — the UI treats an empty list as "sync first".
        Err(_) => return Ok(Vec::new()),
    };
    let mut pages: Vec<WikiPage> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        if !name.to_lowercase().ends_with(".md") || name.starts_with('.') {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let title = name
            .strip_suffix(".md")
            .unwrap_or(&name)
            .replace('-', " ");
        pages.push(WikiPage {
            file: name,
            title,
        });
    }
    pages.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    // Home is the wiki landing page — pin it to the top.
    pages.sort_by_key(|page| (page.file != "Home.md", page.file == "Home.md"));
    // `_Sidebar` / `_Footer` are GitHub chrome, not reading pages — push to the end.
    pages.sort_by_key(|page| page.file.starts_with('_'));
    Ok(pages)
}

/// Page content plus its latest commit metadata.
pub fn read(cache_root: &Path, url: &str, file: &str) -> Result<WikiPageContent> {
    safe_file(file)?;
    let dir = wiki_dir(cache_root, url)?;
    let path = dir.join(file);
    let content = fs::read_to_string(&path).map_err(|e| format!("cannot read {file}: {e}"))?;
    let title = file
        .strip_suffix(".md")
        .unwrap_or(file)
        .replace('-', " ")
        .to_string();
    let log = run_git(
        &dir,
        &[
            "log",
            "-1",
            "--format=%an%x09%ae%x09%aI%x09%s",
            "--",
            file,
        ],
    );
    let (author, author_email, updated_at, commit_message) = match log {
        Ok(line) if !line.is_empty() => {
            let mut parts = line.splitn(4, '\t');
            (
                parts.next().unwrap_or("").to_string(),
                parts.next().unwrap_or("").to_string(),
                parts.next().unwrap_or("").to_string(),
                parts.next().unwrap_or("").to_string(),
            )
        }
        _ => (String::new(), String::new(), String::new(), String::new()),
    };
    Ok(WikiPageContent {
        file: file.to_string(),
        title,
        content,
        author,
        author_email,
        updated_at,
        commit_message,
    })
}

/// Commit history of one page (latest 50).
pub fn history(cache_root: &Path, url: &str, file: &str) -> Result<Vec<WikiCommit>> {
    safe_file(file)?;
    let dir = wiki_dir(cache_root, url)?;
    let out = run_git(
        &dir,
        &[
            "log",
            "--max-count=50",
            "--format=%H%x09%an%x09%aI%x09%s",
            "--",
            file,
        ],
    )?;
    let commits = out
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.splitn(4, '\t');
            WikiCommit {
                oid: parts.next().unwrap_or("").to_string(),
                author: parts.next().unwrap_or("").to_string(),
                date: parts.next().unwrap_or("").to_string(),
                message: parts.next().unwrap_or("").to_string(),
            }
        })
        .collect();
    Ok(commits)
}

/// Commits `file` with new content and pushes. On a rejected non-fast-forward
/// it rebases onto origin once, then retries the push.
pub fn save(
    cache_root: &Path,
    url: &str,
    file: &str,
    content: &str,
    message: &str,
) -> Result<String> {
    safe_file(file)?;
    let dir = wiki_dir(cache_root, url)?;
    let path = dir.join(file);
    fs::write(&path, content).map_err(|e| format!("cannot write {file}: {e}"))?;

    let status = run_git(&dir, &["status", "--porcelain", "--", file])?;
    if status.is_empty() {
        return Ok("No changes to save".to_string());
    }
    run_git(&dir, &["add", "--", file])?;
    let commit = run_git(&dir, &["commit", "-m", message]);
    if let Err(err) = commit {
        if !err.contains("nothing to commit") {
            return Err(err);
        }
    }

    match run_git_timed(&dir, &["push", "origin"]) {
        Ok(output) => Ok(if output.is_empty() {
            "Pushed to wiki".to_string()
        } else {
            output
        }),
        Err(push_err) => {
            // Try to rebase on top of the remote, then push once more.
            let branch = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
                .unwrap_or_else(|_| "master".to_string());
            if run_git_timed(&dir, &["pull", "--rebase", "origin", &branch]).is_ok() {
                run_git_timed(&dir, &["push", "origin"])?;
                Ok("Pushed to wiki after rebase".to_string())
            } else {
                Err(format!(
                    "{push_err} — the edit is committed locally in the wiki cache"
                ))
            }
        }
    }
}

/// Creates the wiki itself on first use: init a repo in the cache, add the
/// origin, commit the first page and push — GitHub creates the wiki repository
/// on the first push.
pub fn create(
    cache_root: &Path,
    url: &str,
    file: &str,
    content: &str,
    message: &str,
) -> Result<String> {
    safe_file(file)?;
    let dir = cache_dir(cache_root, url);
    if dir.join(".git").exists() {
        return save(cache_root, url, file, content, message);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    run_git_timed(cache_root, &["init", "-b", "master", &dir.to_string_lossy()])?;
    run_git(&dir, &["remote", "add", "origin", url])?;
    fs::write(dir.join(file), content).map_err(|e| format!("cannot write {file}: {e}"))?;
    run_git(&dir, &["add", "--", file])?;
    run_git(&dir, &["commit", "-m", message])?;
    run_git_timed(&dir, &["push", "-u", "origin", "master"])?;
    Ok("Wiki created and pushed".to_string())
}
