//! Tauri command handlers — thin wrappers around `git_state` + `config`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::config::{self, AppConfig};
use crate::FileWatcherHolder;
use crate::git_state::{self, FileDiffContent, RepositoryState};
use crate::ops;
use crate::ai;
use crate::gh;
use crate::settings;
use crate::memory_vector;
use crate::gh_insights;
use crate::insights;
use crate::wiki;
use crate::ssh_workspace::SshWorkspace;

/// Shared app state guarded by a mutex. Git operations are fast (local
/// repositories) so we keep them synchronous inside async commands.
pub struct AppState {
    pub config: AppConfig,
    pub repo_path: Option<PathBuf>,
    pub(crate) ssh_workspace: Option<ActiveSshWorkspace>,
}

pub(crate) struct ActiveSshWorkspace {
    id: u32,
    pub connection: Arc<SshWorkspace>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    /// Working directory after the command (for the next prompt).
    pub cwd: String,
}

/// Run one command in the integrated terminal, inside the repository
/// (or the directory a previous `cd` moved to). `cls`/`clear` are handled
/// client-side; `cd` persists in the session.
#[tauri::command]
pub async fn terminal_run(
    state: State<'_, Mutex<AppState>>,
    command: String,
    cwd: Option<String>,
) -> Result<TerminalOutput, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }

    // The frontend tracks each terminal tab's cwd; fall back to the repo root.
    let current = cwd
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| repo_path.clone());

    // `cd` — resolve and hand the new directory back to the frontend.
    if trimmed == "cd" {
        let shown = current.to_string_lossy().to_string();
        return Ok(TerminalOutput {
            stdout: shown.clone(),
            stderr: String::new(),
            code: 0,
            cwd: shown,
        });
    }
    if let Some(rest) = trimmed.strip_prefix("cd ") {
        let target = PathBuf::from(rest.trim().trim_matches('"'));
        let resolved = if target.is_absolute() {
            target
        } else {
            current.join(target)
        };
        let resolved = resolved
            .canonicalize()
            .map_err(|e| format!("cd: {e}"))?;
        if !resolved.is_dir() {
            return Err(format!("cd: not a directory: {}", resolved.display()));
        }
        let shown = resolved.to_string_lossy().to_string();
        return Ok(TerminalOutput {
            stdout: shown.clone(),
            stderr: String::new(),
            code: 0,
            cwd: shown,
        });
    }

    // BusyBox-style built-ins first (ls, cat, grep, wc, find, …) — they run
    // directly on the worktree. Unknown commands fall through to the shell.
    let tokens: Vec<String> = trimmed
        .split_whitespace()
        .map(|t| t.to_string())
        .collect();
    if let Some(first) = tokens.first() {
        let rest = tokens[1..].to_vec();
        let cwd1 = current.clone();
        let repo1 = repo_path.clone();
        let first1 = first.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::busybox::run(&cwd1, &repo1, &first1, &rest)
        })
        .await
        .map_err(|e| e.to_string())?;
        if result.code != 127 {
            return Ok(TerminalOutput {
                stdout: result.stdout,
                stderr: result.stderr,
                code: result.code,
                cwd: current.to_string_lossy().to_string(),
            });
        }
        // Unknown to busybox → try the second batch (sort/uniq/cut/…).
        let rest2 = tokens[1..].to_vec();
        let cwd2 = current.clone();
        let repo2 = repo_path.clone();
        let first2 = first.clone();
        let extra = tauri::async_runtime::spawn_blocking(move || {
            crate::busybox_extra::run(&cwd2, &repo2, &first2, &rest2)
        })
        .await
        .map_err(|e| e.to_string())?;
        let Some(extra) = extra else {
            // Unknown to batch 2 → try the third batch (hashes/expr/tar).
            let rest3 = tokens[1..].to_vec();
            let cwd3 = current.clone();
            let repo3 = repo_path.clone();
            let first3 = first.clone();
            let third = tauri::async_runtime::spawn_blocking(move || {
                crate::busybox3::run(&cwd3, &repo3, &first3, &rest3)
            })
            .await
            .map_err(|e| e.to_string())?;
            let Some(third) = third else {
                // Unknown to all batches — fall through to the shell below.
                return Ok(TerminalOutput {
                    stdout: String::new(),
                    stderr: String::new(),
                    code: 127,
                    cwd: current.to_string_lossy().to_string(),
                });
            };
            return Ok(TerminalOutput {
                stdout: third.stdout,
                stderr: third.stderr,
                code: third.code,
                cwd: current.to_string_lossy().to_string(),
            });
        };
        if extra.code != 127 {
            return Ok(TerminalOutput {
                stdout: extra.stdout,
                stderr: extra.stderr,
                code: extra.code,
                cwd: current.to_string_lossy().to_string(),
            });
        }
    }

    // Run through the platform shell so pipes/redirection work.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", trimmed]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", trimmed]);
        c
    };
    cmd.current_dir(&current);

    let output = tauri::async_runtime::spawn_blocking(move || cmd.output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    const MAX: usize = 400_000;
    let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.len() > MAX {
        stdout.truncate(MAX);
        stdout.push_str("
… output truncated …");
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(TerminalOutput {
        stdout,
        stderr,
        code: output.status.code().unwrap_or(-1),
        cwd: current.to_string_lossy().to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatePayload {
    pub active_path: Option<String>,
    pub recent: Vec<String>,
    pub repository: Option<RepositoryState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub oid: String,
    pub state: AppStatePayload,
}

fn repo_path_str(state: &AppState) -> Result<&Path, String> {
    if state.ssh_workspace.is_some() {
        return Err("This feature currently requires a local workspace.".into());
    }
    state
        .repo_path
        .as_deref()
        .ok_or_else(|| "no repository open".to_string())
}

/// Auth-level gh commands (login status, accounts, device flow) work without
/// an open repository -- gh auth is machine-level, so they fall back to the
/// home directory as the gh subprocess working dir.
fn gh_auth_dir(state: &AppState) -> PathBuf {
    state.repo_path.clone().unwrap_or_else(|| {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    })
}

fn build_payload(state: &AppState) -> AppStatePayload {
    let repository = state.repo_path.as_deref().and_then(|path| {
        match git_state::build_state(path) {
            Ok(value) => Some(value),
            Err(e) => {
                eprintln!("[pigry] build_state failed for {}: {e}", path.display());
                None
            }
        }
    });
    AppStatePayload {
        active_path: state.repo_path.as_ref().map(|p| p.display().to_string()),
        recent: state.config.recent.clone(),
        repository,
    }
}

fn open_repo_sync(
    app: &tauri::AppHandle,
    state: &Mutex<AppState>,
    path: &str,
) -> Result<AppStatePayload, String> {
    let repo = git2::Repository::discover(path)
        .map_err(|e| format!("not a git repository: {}", e.message()))?;
    let root = repo.workdir().ok_or("Open a working repository, not a bare remote")?.to_path_buf();
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let previous_workspace = state.ssh_workspace.take();
    config::set_active(&mut state.config, &root.to_string_lossy());
    config::save(app, &state.config);
    state.repo_path = Some(root.clone());
    if let Some(holder) = app.try_state::<FileWatcherHolder>() {
        if let Ok(watcher) = holder.watcher.lock() { watcher.watch(&root.to_string_lossy()); }
    }
    let payload = build_payload(&state);
    drop(state);
    stop_ssh_workspace(previous_workspace);
    Ok(payload)
}

#[tauri::command]
pub async fn open_ssh_workspace(app: tauri::AppHandle, id: u32) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pending = crate::pty::pending_ssh_workspace(id).ok_or("The SSH session ended before the workspace opened.")?;
        let (connection, mut payload) = pending.open(|| crate::pty::pending_ssh_workspace(id).is_some())?;
        let state_holder = app.state::<Mutex<AppState>>();
        let mut state = state_holder.lock().map_err(|error| error.to_string())?;
        if crate::pty::pending_ssh_workspace(id).is_none() {
            return Err("The SSH connection closed before the workspace opened.".into());
        }
        complete_ssh_payload(&mut payload, &connection, &state.config.recent);
        let connection = Arc::new(connection);
        let previous_workspace = state.ssh_workspace.replace(ActiveSshWorkspace { id, connection: Arc::clone(&connection) });
        state.repo_path = None;
        if let Some(holder) = app.try_state::<FileWatcherHolder>() {
            if let Ok(watcher) = holder.watcher.lock() { watcher.stop(); }
        }
        drop(state);
        stop_ssh_workspace(previous_workspace);
        watch_ssh_workspace(app, id, Arc::downgrade(&connection));
        Ok(payload)
    }).await.map_err(|error| error.to_string())?
}

fn watch_ssh_workspace(app: tauri::AppHandle, id: u32, connection: std::sync::Weak<SshWorkspace>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let Some(connection) = connection.upgrade() else { return; };
        match connection.changed() {
            Ok(false) => {}
            Ok(true) => {
                let holder = app.state::<Mutex<AppState>>();
                if holder.lock().is_ok_and(|state| state.ssh_workspace.as_ref().is_some_and(|remote| remote.id == id)) {
                    let _ = app.emit("repo-changed", ());
                }
            }
            Err(_) => return,
        }
    });
}

#[tauri::command]
pub async fn cancel_ssh_workspace_start(state: State<'_, Mutex<AppState>>, id: u32) -> Result<(), String> {
    let state = state.lock().map_err(|error| error.to_string())?;
    if state.ssh_workspace.as_ref().is_some_and(|remote| remote.id == id) {
        return Ok(()); // Ownership passed from Home to the workspace.
    }
    if crate::pty::pending_ssh_workspace(id).is_some() {
        crate::pty::pty_kill(id)?;
    }
    Ok(())
}

pub(crate) fn ssh_workspace_exited(app: &tauri::AppHandle, id: u32) {
    let state = app.state::<Mutex<AppState>>();
    if let Ok(mut state) = state.lock() {
        if !state.ssh_workspace.as_ref().is_some_and(|remote| remote.id == id) { return; }
        let remote = state.ssh_workspace.take();
        state.repo_path = None;
        if let Some(holder) = app.try_state::<FileWatcherHolder>() {
            if let Ok(watcher) = holder.watcher.lock() { watcher.stop(); }
        }
        drop(state);
        drop(remote);
        let _ = app.emit("repo-changed", ());
    }
}

fn complete_ssh_payload(payload: &mut serde_json::Value, connection: &SshWorkspace, recent: &[String]) {
    if let Some(state) = payload.as_object_mut() {
        state.insert("activePath".into(), serde_json::json!(connection.uri()));
        state.insert("recent".into(), serde_json::json!(recent));
        state.insert("sshWorkspace".into(), serde_json::json!(connection.info()));
    }
}

pub(crate) fn route_ssh_workspace(invoke: tauri::ipc::Invoke<tauri::Wry>) -> Option<tauri::ipc::Invoke<tauri::Wry>> {
    use tauri::ipc::InvokeBody;

    if !crate::remote_protocol::is_workspace_command(invoke.message.command()) {
        return Some(invoke);
    }
    let webview = invoke.message.webview();
    let state = webview.state::<Mutex<AppState>>();
    let Ok(state) = state.lock() else { return Some(invoke); };
    let Some(workspace) = &state.ssh_workspace else { return Some(invoke); };
    let connection = Arc::clone(&workspace.connection);
    let recent = state.config.recent.clone();
    drop(state);

    let InvokeBody::Json(params) = invoke.message.payload() else {
        invoke.resolver.reject("PIGRY Server requests require JSON.");
        return None;
    };
    let params = params.clone();
    let method = invoke.message.command().to_owned();
    tauri::async_runtime::spawn_blocking(move || match connection.call(&method, params) {
        Ok(mut result) => {
            if method == "commit" {
                complete_ssh_payload(&mut result["state"], &connection, &recent);
            } else if result.get("repository").is_some() {
                complete_ssh_payload(&mut result, &connection, &recent);
            }
            invoke.resolver.resolve(result);
        }
        Err(error) => invoke.resolver.reject(error),
    });
    None
}

fn stop_ssh_workspace(previous: Option<ActiveSshWorkspace>) {
    if let Some(remote) = previous {
        let _ = crate::pty::pty_kill(remote.id);
    }
}

pub(crate) fn stop_active_ssh_workspace(app: &tauri::AppHandle) {
    let previous = app.state::<Mutex<AppState>>().lock().ok().and_then(|mut state| state.ssh_workspace.take());
    stop_ssh_workspace(previous);
}

#[tauri::command]
pub async fn get_app_state(
    state: State<'_, Mutex<AppState>>,
) -> Result<AppStatePayload, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn open_repository(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<AppStatePayload, String> {
    open_repo_sync(&app, &state, &path)
}

/// Opens the OS folder picker; None when the user cancels.
#[tauri::command]
pub async fn pick_repository(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<Option<AppStatePayload>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open repository")
        .blocking_pick_folder();
    let Some(path) = picked else {
        return Ok(None);
    };
    open_repo_sync(&app, &state, &path.to_string()).map(Some)
}

#[tauri::command]
pub async fn close_repository(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<AppStatePayload, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    if let Some(holder) = app.try_state::<FileWatcherHolder>() {
        holder.watcher.lock().map_err(|e| e.to_string())?.stop();
    }
    state.repo_path = None;
    let previous_workspace = state.ssh_workspace.take();
    if previous_workspace.is_none() {
        state.config.active = None;
        config::save(&app, &state.config);
    }
    let payload = build_payload(&state);
    drop(state);
    stop_ssh_workspace(previous_workspace);
    Ok(payload)
}

#[tauri::command]
pub async fn refresh(
    state: State<'_, Mutex<AppState>>,
) -> Result<AppStatePayload, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn stage_paths(
    state: State<'_, Mutex<AppState>>,
    paths: Vec<String>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::stage_paths(&repo_path, &paths)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn unstage_paths(
    state: State<'_, Mutex<AppState>>,
    paths: Vec<String>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::unstage_paths(&repo_path, &paths)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn discard_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::discard_file(&repo_path, &path)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn commit(
    state: State<'_, Mutex<AppState>>,
    title: String,
    body: String,
    amend: bool,
) -> Result<CommitOutcome, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let oid = git_state::commit(&repo_path, &title, &body, amend)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(CommitOutcome {
        oid,
        state: build_payload(&state),
    })
}

#[tauri::command]
pub async fn stash_changes(
    state: State<'_, Mutex<AppState>>,
    message: Option<String>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::stash(&repo_path, message.as_deref())?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, Mutex<AppState>>,
    path: String,
    staged: bool,
) -> Result<FileDiffContent, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::file_diff_at(&repo_path, &path, staged)
}

#[tauri::command]
pub async fn get_commit_history(
    state: State<'_, Mutex<AppState>>,
    include_remotes: bool,
) -> Result<git_state::CommitHistory, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::build_commit_history(&repo_path, include_remotes)
}

#[tauri::command]
pub async fn get_branch_commits(
    state: State<'_, Mutex<AppState>>,
    refName: String,
    first_parent: Option<bool>,
) -> Result<git_state::CommitHistory, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    if first_parent.unwrap_or(false) {
        git_state::build_ref_commits(&repo_path, &refName, true)
    } else {
        git_state::build_branch_commits(&repo_path, &refName)
    }
}

#[tauri::command]
pub async fn search_code(
    state: State<'_, Mutex<AppState>>,
    query: String,
) -> Result<Vec<git_state::CodeSearchHit>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::search_worktree_code(&repo_path, &query, 200)
}

#[tauri::command]
pub async fn gh_auth_status(
    state: State<'_, Mutex<AppState>>,
) -> Result<gh::GhAuthStatus, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::auth_status(&repo_path)
}

#[tauri::command]
pub async fn gh_pr_list(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhPullRequest>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_list(&repo_path)
}

#[tauri::command]
pub async fn gh_issue_list(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhIssue>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::issue_list(&repo_path)
}

#[tauri::command]
pub async fn gh_issue_view(
    state: State<'_, Mutex<AppState>>,
    number: u64,
) -> Result<gh::GhIssueDetail, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::issue_detail(&repo_path, number)
}

#[tauri::command]
pub async fn gh_issue_comment(
    state: State<'_, Mutex<AppState>>,
    number: u64,
    body: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::issue_comment(&repo_path, number, &body).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_issue_create(
    state: State<'_, Mutex<AppState>>,
    title: String,
    body: String,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::issue_create(&repo_path, &title, &body).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_issue_close(
    state: State<'_, Mutex<AppState>>,
    number: u64,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::issue_close(&repo_path, number).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_issue_reopen(
    state: State<'_, Mutex<AppState>>,
    number: u64,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::issue_reopen(&repo_path, number).inspect(|_| crate::gh_cache::invalidate())
}

/// Wiki clones live under the OS app-config dir — outside the watched
/// worktree so the file watcher never sees them.
fn wiki_cache_root(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("wiki-cache")
}

#[tauri::command]
pub async fn wiki_check(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<wiki::WikiStatus, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    wiki::check(&repo_path, &wiki_cache_root(&app))
}

#[tauri::command]
pub async fn wiki_sync(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let root = wiki_cache_root(&app);
    let status = wiki::check(&repo_path, &root)?;
    if !status.supported {
        return Err("this repository has no github.com origin".to_string());
    }
    if !status.has_wiki {
        return Err("the wiki does not exist on GitHub yet".to_string());
    }
    wiki::sync(&root, &status.url)
}

#[tauri::command]
pub async fn wiki_list(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<wiki::WikiPage>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let root = wiki_cache_root(&app);
    let url = wiki::url_for(&repo_path)?;
    wiki::list(&root, &url)
}

#[tauri::command]
pub async fn wiki_read(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    file: String,
) -> Result<wiki::WikiPageContent, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let url = wiki::url_for(&repo_path)?;
    wiki::read(&wiki_cache_root(&app), &url, &file)
}

#[tauri::command]
pub async fn wiki_page_history(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    file: String,
) -> Result<Vec<wiki::WikiCommit>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let url = wiki::url_for(&repo_path)?;
    wiki::history(&wiki_cache_root(&app), &url, &file)
}

#[tauri::command]
pub async fn wiki_save(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    file: String,
    content: String,
    message: String,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let url = wiki::url_for(&repo_path)?;
    wiki::save(&wiki_cache_root(&app), &url, &file, &content, &message)
}

#[tauri::command]
pub async fn wiki_create(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    file: String,
    content: String,
    message: String,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let root = wiki_cache_root(&app);
    let status = wiki::check(&repo_path, &root)?;
    if !status.supported || status.url.is_empty() {
        return Err("wiki requires a github.com origin".to_string());
    }
    wiki::create(&root, &status.url, &file, &content, &message)
}

#[tauri::command]
pub async fn gh_release_list(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhRelease>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::release_list(&repo_path)
}

#[tauri::command]
pub async fn gh_project_list(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhProject>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::project_list(&repo_path)
}

#[tauri::command]
pub async fn gh_project_item_list(
    state: State<'_, Mutex<AppState>>,
    project_number: u64,
) -> Result<Vec<gh::GhProjectItem>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::project_item_list(&repo_path, project_number)
}

#[tauri::command]
pub async fn gh_code_scanning_alerts(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhCodeAlert>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::code_scanning_alerts(&repo_path)
}

#[tauri::command]
pub async fn gh_code_alert_dismiss(
    state: State<'_, Mutex<AppState>>,
    number: u64,
    reason: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::code_alert_dismiss(&repo_path, number, &reason).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_dependabot_alerts(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhDependabotAlert>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::dependabot_alerts(&repo_path)
}

#[tauri::command]
pub async fn gh_secret_scanning_alerts(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhSecretAlert>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::secret_scanning_alerts(&repo_path)
}

#[tauri::command]
pub async fn gh_branch_check_runs(
    state: State<'_, Mutex<AppState>>,
    branch: String,
) -> Result<Vec<gh::GhCheckRun>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::branch_check_runs(&repo_path, &branch)
}

#[tauri::command]
pub async fn gh_account_list(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhAccount>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::account_list(&repo_path)
}

#[tauri::command]
pub async fn gh_switch_account(
    state: State<'_, Mutex<AppState>>,
    account: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::switch_account(&repo_path, &account).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_login_with_token(
    state: State<'_, Mutex<AppState>>,
    token: String,
) -> Result<gh::GhAuthStatus, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::login_with_token(&repo_path, &token).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_logout(
    state: State<'_, Mutex<AppState>>,
    account: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::logout(&repo_path, &account).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn get_commit_oid_set(
    state: State<'_, Mutex<AppState>>,
    ref_name: Option<String>,
    path: Option<String>,
    exclude: Option<String>,
) -> Result<Vec<String>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::commit_oid_set(
        &repo_path,
        ref_name.as_deref(),
        path.as_deref(),
        exclude.as_deref(),
        3000,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gh_release_view(
    state: State<'_, Mutex<AppState>>,
    tag: String,
) -> Result<gh::GhReleaseDetail, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::release_view(&repo_path, &tag)
}

#[tauri::command]
pub async fn gh_release_create(
    state: State<'_, Mutex<AppState>>,
    tag: String,
    title: String,
    notes: String,
    target: Option<String>,
    draft: bool,
    prerelease: bool,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::release_create(
        &repo_path,
        &tag,
        &title,
        &notes,
        target.as_deref(),
        draft,
        prerelease,
    ).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_release_edit(
    state: State<'_, Mutex<AppState>>,
    tag: String,
    title: String,
    notes: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::release_edit(&repo_path, &tag, &title, &notes).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_release_delete(
    state: State<'_, Mutex<AppState>>,
    tag: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::release_delete(&repo_path, &tag).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_install(
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::install(&repo_path)
}

#[tauri::command]
pub fn gh_invalidate_cache() {
    crate::gh_cache::invalidate();
}

#[tauri::command]
pub async fn gh_pr_detail(
    state: State<'_, Mutex<AppState>>,
    number: u64,
) -> Result<gh::GhPrDetail, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_detail(&repo_path, number)
}

#[tauri::command]
pub async fn gh_pr_items_page(
    state: State<'_, Mutex<AppState>>,
    number: u32,
    kind: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || gh::pr_items_page(&repo_path, number, &kind, cursor))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gh_pr_diff(
    state: State<'_, Mutex<AppState>>,
    number: u64,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_diff(&repo_path, number)
}

#[tauri::command]
pub async fn gh_pr_file_patches(
    state: State<'_, Mutex<AppState>>,
    number: u64,
) -> Result<Vec<gh::GhPrFilePatch>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || gh::pr_file_patches(&repo_path, number))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn gh_pr_commit_diff(
    state: State<'_, Mutex<AppState>>,
    oid: String,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_commit_diff(&repo_path, &oid)
}

#[tauri::command]
pub async fn gh_pr_comment(
    state: State<'_, Mutex<AppState>>,
    number: u64,
    body: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_comment(&repo_path, number, &body).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_pr_review(
    state: State<'_, Mutex<AppState>>,
    number: u64,
    event: String,
    body: Option<String>,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_review(&repo_path, number, &event, body.as_deref()).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_pr_checkout(
    state: State<'_, Mutex<AppState>>,
    number: u64,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_checkout(&repo_path, number)
}

#[tauri::command]
pub async fn gh_pr_create(
    state: State<'_, Mutex<AppState>>,
    title: String,
    body: String,
    head: String,
    base: String,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_create(&repo_path, &title, &body, &head, &base).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_pr_close(
    state: State<'_, Mutex<AppState>>,
    number: u64,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::pr_close(&repo_path, number).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_device_flow_start(
    state: State<'_, Mutex<AppState>>,
    scopes: Vec<String>,
) -> Result<gh::GhDeviceStart, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::device_flow_start(&repo_path, &scopes)
}

#[tauri::command]
pub async fn gh_device_flow_poll(
    state: State<'_, Mutex<AppState>>,
    device_code: String,
) -> Result<gh::GhDevicePoll, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::device_flow_poll(&repo_path, &device_code)
}

#[tauri::command]
pub async fn gh_token_scopes(
    state: State<'_, Mutex<AppState>>,
) -> Result<gh::GhScopes, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        gh_auth_dir(&state)
    };
    gh::token_scopes(&repo_path)
}

#[tauri::command]
pub async fn gh_open_url(url: String) -> Result<(), String> {
    gh::open_url(&url)
}

#[tauri::command]
pub async fn gh_workflow_list(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::GhWorkflow>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::workflow_list(&repo_path)
}

#[tauri::command]
pub async fn gh_run_list(
    state: State<'_, Mutex<AppState>>,
    limit: Option<u32>,
) -> Result<gh::GhRunPage, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::run_list(&repo_path, limit.unwrap_or(50))
}

#[tauri::command]
pub async fn gh_run_view(
    state: State<'_, Mutex<AppState>>,
    run_id: u64,
) -> Result<gh::GhRunDetail, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::run_view(&repo_path, run_id)
}

#[tauri::command]
pub async fn gh_run_logs(
    state: State<'_, Mutex<AppState>>,
    run_id: u64,
    job_id: Option<u64>,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::run_logs(&repo_path, run_id, job_id)
}

#[tauri::command]
pub async fn gh_run_rerun(
    state: State<'_, Mutex<AppState>>,
    run_id: u64,
    failed_only: bool,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::run_rerun(&repo_path, run_id, failed_only).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_run_cancel(
    state: State<'_, Mutex<AppState>>,
    run_id: u64,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::run_cancel(&repo_path, run_id).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_workflow_dispatch(
    state: State<'_, Mutex<AppState>>,
    workflow_path: String,
    ref_name: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::workflow_dispatch(&repo_path, &workflow_path, &ref_name).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn gh_run_artifacts(
    state: State<'_, Mutex<AppState>>,
    run_id: u64,
) -> Result<Vec<gh::GhRunArtifact>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::run_artifacts(&repo_path, run_id)
}

#[tauri::command]
pub async fn gh_run_download_artifact(
    state: State<'_, Mutex<AppState>>,
    run_id: u64,
    name: String,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::run_download_artifact(&repo_path, run_id, &name)
}

#[tauri::command]
pub async fn get_file_tree(
    state: State<'_, Mutex<AppState>>,
) -> Result<git_state::FileTree, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::list_tree(&repo_path)
}

#[tauri::command]
pub async fn read_worktree_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<git_state::WorktreeFileContent, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::read_worktree_file(&repo_path, &path)
}

#[tauri::command]
pub async fn read_binary_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<git_state::BinaryFileContent, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::read_binary_file(&repo_path, &path)
}

#[tauri::command]
pub async fn open_path_external(state: State<'_, Mutex<AppState>>, path: String) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::open_path_external(&repo_path, &path)
}

#[tauri::command]
pub async fn write_worktree_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
    content: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::write_worktree_file(&repo_path, &path, &content)
}

#[tauri::command]
pub async fn write_worktree_binary(
    state: State<'_, Mutex<AppState>>,
    path: String,
    data: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::write_worktree_binary(&repo_path, &path, &data)
}

#[tauri::command]
pub async fn delete_worktree_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::delete_worktree_file(&repo_path, &path)
}

#[tauri::command]
pub async fn delete_worktree_folder(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::delete_worktree_folder(&repo_path, &path)
}

#[tauri::command]
pub async fn rename_worktree_folder(
    state: State<'_, Mutex<AppState>>,
    oldPath: String,
    newPath: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::rename_worktree_folder(&repo_path, &oldPath, &newPath)
}

#[tauri::command]
pub async fn rename_worktree_file(
    state: State<'_, Mutex<AppState>>,
    oldPath: String,
    newPath: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::rename_worktree_file(&repo_path, &oldPath, &newPath)
}

#[tauri::command]
pub async fn cli_detect() -> Result<ai::CliDetectResult, String> {
    Ok(ai::cli_detect())
}

#[tauri::command]
pub async fn cli_agent_run(
    state: State<'_, Mutex<AppState>>,
    cli: String,
    prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    let cwd = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ai::cli_agent_run(&cli, &prompt, &cwd.to_string_lossy().as_ref(), model.as_deref())
}

#[tauri::command]
pub async fn launch_app(
    kind: String,
    target: String,
) -> Result<String, String> {
    ai::launch_app(&kind, &target)
}

#[tauri::command]
pub async fn zcode_plan_subscription(
    api_key: String,
) -> Result<String, String> {
    ai::zcode_plan_subscription(&api_key)
}

#[tauri::command]
pub async fn claude_usage(
) -> Result<String, String> {
    ai::claude_usage()
}

#[tauri::command]
pub async fn zcode_credentials(
) -> Result<ai::ZcodeCreds, String> {
    ai::zcode_creds()
}

#[tauri::command]
pub async fn commit_avatars(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<gh::CommitAuthorAvatar>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh::commit_avatars(&repo_path)
}

#[tauri::command]
pub async fn ai_chat(
    url: String,
    api_key: String,
    body: String,
    auth: Option<String>,
) -> Result<ai::AiChatResult, String> {
    ai::ai_chat(&url, &api_key, &body, auth.as_deref()).map_err(|e| e)
}

#[tauri::command]
pub async fn get_file_history(
    state: State<'_, Mutex<AppState>>,
    path: String,
    ref_name: Option<String>,
) -> Result<Vec<git_state::FileCommitEntry>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || {
        git_state::build_file_history(&repo_path, &path, ref_name.as_deref())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_file_at_commit(
    state: State<'_, Mutex<AppState>>,
    path: String,
    oid: String,
) -> Result<git_state::WorktreeFileContent, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::read_file_at_commit(&repo_path, &path, &oid)
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, Mutex<AppState>>) -> Result<crate::net::NetResult, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    crate::net::fetch(&repo_path)
}

#[tauri::command]
pub async fn git_pull(state: State<'_, Mutex<AppState>>) -> Result<crate::net::NetResult, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    crate::net::pull(&repo_path)
}

#[tauri::command]
pub async fn git_push(state: State<'_, Mutex<AppState>>) -> Result<crate::net::NetResult, String> {
    let (repo_path, branch, has_upstream) = {
        let state = state.lock().map_err(|e| e.to_string())?;
        let path = repo_path_str(&state)?.to_path_buf();
        let repo_state = git_state::build_state(&path).map_err(|e| e)?;
        let branch = repo_state.current_branch.clone();
        (path, branch, repo_state.upstream.is_some())
    };
    crate::net::push(&repo_path, &branch, has_upstream).inspect(|_| crate::gh_cache::invalidate())
}

#[tauri::command]
pub async fn get_commit_detail(
    state: State<'_, Mutex<AppState>>,
    oid: String,
) -> Result<git_state::CommitDetail, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::build_commit_detail(&repo_path, &oid)
}

#[tauri::command]
pub async fn get_commit_file_diff(
    state: State<'_, Mutex<AppState>>,
    oid: String,
    path: String,
    previous_path: Option<String>,
) -> Result<git_state::FileDiffContent, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::read_commit_file_diff(&repo_path, &oid, &path, previous_path.as_deref())
}

#[tauri::command]
pub async fn create_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    name: String,
    checkout: bool,
    from_ref: Option<String>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    match from_ref.as_deref() {
        Some(from) => git_state::create_branch_from(&repo_path, &name, from, checkout)?,
        None => git_state::create_branch(&repo_path, &name, checkout)?,
    }
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn rename_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    old_name: String,
    new_name: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::rename_branch(&repo_path, &old_name, &new_name)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn checkout_remote_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    remote: String,
    name: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::checkout_remote_branch(&repo_path, &remote, &name)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn delete_remote_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    remote: String,
    name: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::delete_remote_branch(&repo_path, &remote, &name)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn checkout_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    name: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::checkout_branch(&repo_path, &name)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn delete_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    name: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::delete_branch(&repo_path, &name)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn create_tag(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    name: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::create_tag(&repo_path, &name)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn delete_tag(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    name: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::delete_tag(&repo_path, &name)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn stash_apply(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    index: usize,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::stash_apply(&repo_path, index)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn stash_pop(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    index: usize,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::stash_pop(&repo_path, index)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn stash_drop(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    index: usize,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::stash_drop(&repo_path, index)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn get_file_hunks(
    state: State<'_, Mutex<AppState>>,
    path: String,
    staged: bool,
) -> Result<Vec<git_state::HunkInfo>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::file_hunks(&repo_path, &path, staged)
}

#[tauri::command]
pub async fn unstage_hunk(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    path: String,
    hunk_index: usize,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::unstage_hunk(&repo_path, &path, hunk_index)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn stage_hunk(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    path: String,
    hunk_index: usize,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::stage_hunk(&repo_path, &path, hunk_index)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn discard_hunk(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    path: String,
    hunk_index: usize,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::discard_hunk(&repo_path, &path, hunk_index)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn get_file_blame(
    state: State<'_, Mutex<AppState>>,
    path: String,
    ref_name: Option<String>,
) -> Result<Vec<git_state::BlameLine>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    if let Some(name) = ref_name.as_deref().filter(|r| !r.trim().is_empty()) {
        git_state::blame_at(&repo_path, &path, name).map_err(|e| e)
    } else {
        git_state::file_blame(&repo_path, &path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_line_changes(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<Vec<git_state::LineChange>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::line_changes(&repo_path, &path)
}


#[tauri::command]
pub async fn revert_commit(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    oid: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::revert_commit(&repo_path, &oid)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn revert_abort(
    state: State<'_, Mutex<AppState>>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::revert_abort(&repo_path)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn cherry_pick(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    oid: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::cherry_pick(&repo_path, &oid)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn duplicate_commit_candidates(
    state: State<'_, Mutex<AppState>>,
    source_branch: String,
    destination_branch: String,
) -> Result<Vec<String>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || {
        ops::duplicate_commit_candidates(&repo_path, &source_branch, &destination_branch)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn duplicate_commit(
    state: State<'_, Mutex<AppState>>,
    source_branch: String,
    destination_branch: String,
    oid: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || {
        ops::duplicate_commit(&repo_path, &source_branch, &destination_branch, &oid)
    })
    .await
    .map_err(|error| error.to_string())??;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn merge_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    branch: String,
    strategy: Option<String>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::merge_branch(&repo_path, &branch, strategy.as_deref().unwrap_or("ff"))?;
    if ops::has_conflicts(&repo_path).unwrap_or(false) {
        return Err("CONFLICT: merge has unresolved conflicts — resolve them in Working changes".into());
    }
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn merge_preview(
    state: State<'_, Mutex<AppState>>,
    branch: String,
) -> Result<ops::MergePreview, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::merge_preview(&repo_path, &branch)
}

#[tauri::command]
pub async fn compare_branches(
    state: State<'_, Mutex<AppState>>,
    base_ref: String,
    compare_ref: String,
) -> Result<ops::BranchComparison, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || ops::compare_branches(&repo_path, &base_ref, &compare_ref))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn push_preview(
    state: State<'_, Mutex<AppState>>,
) -> Result<ops::PushPreview, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::push_preview(&repo_path)
}

#[tauri::command]
pub async fn pull_preview(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<ops::PushPreviewCommit>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::pull_preview(&repo_path)
}

#[tauri::command]
pub async fn cherry_pick_abort(
    state: State<'_, Mutex<AppState>>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::cherry_pick_abort(&repo_path)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn browser_devtools(
    _app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    action: String,
    url: Option<String>,
    js: Option<String>,
    waitMs: Option<u64>,
) -> Result<String, String> {
    // The DevTools session is repo-agnostic — the browser can inspect any
    // site with no repository open. Only `screenshot` writes into the repo's
    // .pigry/devtools directory, so that one action requires a repo.
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.repo_path.as_deref().map(std::path::PathBuf::from)
    };
    match action.as_str() {
        "open" => {
            let url = url.ok_or("action \"open\" requires url")?;
            let wait = waitMs.unwrap_or(1200);
            crate::devtools::devtools_open(
                repo_path.as_deref().unwrap_or(std::path::Path::new(".")),
                &url,
                wait,
            )
            .await
        }
        "eval" => {
            let js = js.ok_or("action \"eval\" requires js")?;
            crate::devtools::devtools_eval(&js).await
        }
        "console" => {
            let limit = waitMs.unwrap_or(50) as usize;
            let lines = crate::devtools::devtools_console(limit).await?;
            Ok(if lines.is_empty() {
                "(console empty)".to_string()
            } else {
                lines.join("
")
            })
        }
        "screenshot" => {
            let repo_path = repo_path.ok_or_else(|| {
                "open a repository first — screenshots save under .pigry/devtools".to_string()
            })?;
            // For "screenshot" the `url` field carries the optional `save_as` path.
            crate::devtools::devtools_screenshot(&repo_path, url.as_deref(), js.as_deref()).await
        }
        // Test evidence. `url` carries the workspace-relative save_as path;
        // for network_export `js` is the filter ("api" keeps XHR/fetch only).
        "network_export" => {
            let repo_path = repo_path.ok_or("open a repository first — evidence saves under .pigry/")?;
            let save_as = url.ok_or("network_export requires a save_as path")?;
            let api_only = js.as_deref().map(|value| value != "all").unwrap_or(true);
            crate::devtools::devtools_network_export(&repo_path, &save_as, api_only).await
        }
        "record_start" => {
            let repo_path = repo_path.ok_or("open a repository first — evidence saves under .pigry/")?;
            let save_as = url.ok_or("record_start requires a save_as path")?;
            crate::devtools::devtools_record_start(&repo_path, &save_as).await
        }
        "record_stop" => crate::devtools::devtools_record_stop().await,
        "init_script" => crate::devtools::devtools_init_script(js.as_deref().unwrap_or("")).await,
        // Trusted input, cookies (httpOnly too), extra headers and the web-security switch for the E2E runner.
        "input" => crate::devtools::devtools_input(js.as_deref().unwrap_or("[]")).await,
        "cookies" => crate::devtools::devtools_cookies().await,
        "set_cookie" => crate::devtools::devtools_set_cookie(js.as_deref().unwrap_or("{}")).await,
        "clear_cookies" => crate::devtools::devtools_clear_cookies(js.as_deref()).await,
        "headers" => crate::devtools::devtools_headers(js.as_deref().unwrap_or("{}")).await,
        "websecurity" => {
            crate::devtools::set_web_security(js.as_deref() != Some("off"));
            Ok("web security setting applies to the next browser launch".to_string())
        }
        // CSS / responsive testing. `js` carries "width,height[,mobile]" (width 0
        // clears) for viewport, or "light" / "dark" / "" for color_scheme.
        "viewport" => {
            let spec = js.unwrap_or_default();
            let mut parts = spec.split(',').map(str::trim);
            let width = parts.next().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            let height = parts.next().and_then(|v| v.parse::<i64>().ok()).unwrap_or(800);
            let mobile = parts.next().map(|v| v == "true" || v == "mobile").unwrap_or(false);
            crate::devtools::devtools_viewport(width, height, mobile).await
        }
        "color_scheme" => crate::devtools::devtools_color_scheme(js.as_deref().unwrap_or("")).await,
        "dom" => {
            let limit = waitMs.unwrap_or(16_000) as usize;
            crate::devtools::devtools_dom(limit).await
        }
        "network" => {
            let limit = waitMs.unwrap_or(500) as usize;
            crate::devtools::devtools_network(limit).await
        }
        "close" => crate::devtools::devtools_close().await,
        other => Err(format!("unknown devtools action: {other}")),
    }
}

/// CDP against the app's own WebView2 pages — dev builds only (lib.rs enables
/// the remote debugging port under debug_assertions). Actions: "targets",
/// "network", "screenshot", "pdf", "upload".
#[tauri::command]
pub async fn browser_cdp(
    action: String,
    url_prefix: Option<String>,
    contains: Option<String>,
    selector: Option<String>,
    paths: Option<Vec<String>>,
    max: Option<u32>,
    value: Option<String>,
    wait_ms: Option<u64>,
    op: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    match action.as_str() {
        "targets" => {
            let lines = crate::devtools::cdp_targets().await?;
            Ok(if lines.is_empty() {
                "(no CDP pages)".to_string()
            } else {
                lines.join("\n")
            })
        }
        "network_idle" => {
            crate::devtools::cdp_network_idle(
                url_prefix.as_deref().unwrap_or(""),
                max.unwrap_or(500) as u64,
                wait_ms.unwrap_or(10_000),
            )
            .await
        }
        "cookies" => {
            crate::devtools::cdp_cookies(
                url_prefix.as_deref().unwrap_or(""),
                op.as_deref().unwrap_or("list"),
                name.as_deref().unwrap_or(""),
                value.as_deref().unwrap_or(""),
                max.unwrap_or(3000) as usize,
            )
            .await
        }
        "screenshot" => crate::devtools::cdp_screenshot(url_prefix.as_deref().unwrap_or("")).await,
        "pdf" => crate::devtools::cdp_pdf(url_prefix.as_deref().unwrap_or("")).await,
        "upload" => {
            let selector = selector.ok_or("upload requires selector")?;
            let paths = paths.ok_or("upload requires paths")?;
            crate::devtools::cdp_upload(url_prefix.as_deref().unwrap_or(""), &selector, paths).await
        }
        other => Err(format!("unknown cdp action: {other}")),
    }
}

/// Opens a URL in the user's default browser window (visible, not headless).
#[tauri::command]
pub async fn read_pdf_text(
    state: State<'_, Mutex<AppState>>,
    path: String,
    limit: Option<usize>,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::read_pdf_text(&repo_path, &path, limit.unwrap_or(12_000))
}

#[tauri::command]
pub async fn browser(
    url: String,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("url must start with http:// or https://".to_string());
    }
    if let Err(primary) = tauri_plugin_opener::open_url(url.clone(), None::<&str>) {
        // Fallback: let the Windows shell hand the URL to the default
        // browser (rundll32 keeps `&` in query strings intact, unlike cmd start).
        let status = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .status()
            .map_err(|e| format!("failed to open browser: {primary}; fallback: {e}"))?;
        if !status.success() {
            return Err(format!("failed to open browser: {primary}"));
        }
    }
    Ok(format!("opened {url} in the default browser"))
}

#[tauri::command]
pub async fn web_search(
    query: String,
) -> Result<crate::web::WebSearchResult, String> {
    crate::web::web_search(&query)
}

#[tauri::command]
pub async fn browser_page(
    url: String,
    waitMs: Option<u64>,
) -> Result<crate::web::BrowserPage, String> {
    crate::web::browser_page(&url, waitMs.unwrap_or(1200))
}

#[tauri::command]
pub async fn stash_preview(
    state: State<'_, Mutex<AppState>>,
    index: usize,
) -> Result<ops::StashPreview, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::stash_preview(&repo_path, index)
}

#[tauri::command]
pub async fn merge_abort(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::merge_abort(&repo_path)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn merge_file_versions(
    state: State<'_, Mutex<AppState>>,
    path: String,
    branch: String,
) -> Result<ops::MergeFileVersions, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::merge_file_versions(&repo_path, &path, &branch)
}

#[tauri::command]
pub async fn merge_status(
    state: State<'_, Mutex<AppState>>,
) -> Result<ops::MergeStatus, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::merge_status(&repo_path)
}


#[tauri::command]
pub async fn clone_repo(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    url: String,
    target: String,
) -> Result<AppStatePayload, String> {
    ops::clone_repo(&url, &target)?;
    // Open the cloned repository.
    let payload = open_repo_sync(&app, &state, &target)?;
    Ok(payload)
}

#[tauri::command]
pub async fn rebase_onto(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    base: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::rebase_onto(&repo_path, &base)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}


#[tauri::command]
pub async fn get_repo_stats(
    state: State<'_, Mutex<AppState>>,
) -> Result<ops::RepoStats, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::repo_stats(&repo_path)
}

#[tauri::command]
pub async fn verify_commit_sig(
    state: State<'_, Mutex<AppState>>,
    oid: String,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::verify_commit(&repo_path, &oid)
}

#[tauri::command]
pub async fn get_user_info(
    state: State<'_, Mutex<AppState>>,
) -> Result<settings::GitUserInfo, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    settings::get_user_info(&repo_path)
}

#[tauri::command]
pub async fn set_user_info(
    state: State<'_, Mutex<AppState>>,
    name: String,
    email: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    settings::set_user_info(&repo_path, &name, &email)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn list_remotes(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<settings::RemoteEntry>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    settings::list_remotes(&repo_path)
}

#[tauri::command]
pub async fn add_remote(
    state: State<'_, Mutex<AppState>>,
    name: String,
    url: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    settings::add_remote(&repo_path, &name, &url)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn remove_remote(
    state: State<'_, Mutex<AppState>>,
    name: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    settings::remove_remote(&repo_path, &name)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn set_remote_url(
    state: State<'_, Mutex<AppState>>,
    name: String,
    url: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    settings::set_remote_url(&repo_path, &name, &url)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn interactive_rebase(
    state: State<'_, Mutex<AppState>>,
    base: String,
    steps: Vec<ops::RebaseStep>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::interactive_rebase(&repo_path, &base, &steps)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn start_commit_edit(
    state: State<'_, Mutex<AppState>>,
    branch: String,
    head_oid: String,
    oid: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || {
        ops::start_commit_edit(&repo_path, &branch, &head_oid, &oid)
    })
    .await
    .map_err(|error| error.to_string())??;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn continue_commit_edit(
    state: State<'_, Mutex<AppState>>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || ops::continue_commit_edit(&repo_path))
        .await
        .map_err(|error| error.to_string())??;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn abort_rebase(
    state: State<'_, Mutex<AppState>>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::abort_rebase(&repo_path)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn stage_lines(
    state: State<'_, Mutex<AppState>>,
    path: String,
    side: String,
    selected_old: Vec<u32>,
    selected_new: Vec<u32>,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::stage_lines(&repo_path, &path, &side, &selected_old, &selected_new)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
}

#[tauri::command]
pub async fn compose_commit_message(
    state: State<'_, Mutex<AppState>>,
) -> Result<git_state::ComposedCommitMessage, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::compose_commit_message(&repo_path)
}

#[tauri::command]
pub async fn staged_diff_preview(
    state: State<'_, Mutex<AppState>>,
    max_chars: Option<f64>,
) -> Result<String, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    let max = max_chars.map(|n| n as usize).unwrap_or(16_000).clamp(200, 60_000);
    git_state::staged_diff_preview(&repo_path, max)
}

/// External git CLI presence — the frontend shows an install notice when it
/// is missing (local operations shell out to the user's own git).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCliStatus {
    pub found: bool,
    pub version: String,
}

#[tauri::command]
pub async fn git_cli_status() -> Result<GitCliStatus, String> {
    match crate::gitcli::git_version() {
        Ok(version) => Ok(GitCliStatus { found: true, version }),
        Err(_) => Ok(GitCliStatus {
            found: false,
            version: String::new(),
        }),
    }
}

/// `scope` selects the memory store inside .pigry -- "teams/<team>" is the
/// team-wide store, "teams/<team>/agents/<username>" an agent's private one;
/// omitted = the project-wide store (.pigry/memory.vector.json).
#[tauri::command]
pub async fn memory_list(
    state: State<'_, Mutex<AppState>>,
    scope: Option<String>,
) -> Result<Vec<memory_vector::MemoryEntry>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    memory_vector::memory_list(&repo_path, scope.as_deref())
}

#[tauri::command]
pub async fn memory_add(
    state: State<'_, Mutex<AppState>>,
    scope: Option<String>,
    text: String,
) -> Result<memory_vector::MemoryEntry, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    memory_vector::memory_add(&repo_path, scope.as_deref(), &text)
}

#[tauri::command]
pub async fn memory_remove(
    state: State<'_, Mutex<AppState>>,
    scope: Option<String>,
    id: String,
) -> Result<(), String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    memory_vector::memory_remove(&repo_path, scope.as_deref(), &id)
}

#[tauri::command]
pub async fn memory_search(
    state: State<'_, Mutex<AppState>>,
    scope: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<memory_vector::MemoryHit>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    memory_vector::memory_search(&repo_path, scope.as_deref(), &query, limit.unwrap_or(5))
}

#[tauri::command]
pub async fn get_insights(
    state: State<'_, Mutex<AppState>>,
    days: Option<u32>,
) -> Result<insights::InsightsData, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    insights::build_insights(&repo_path, days.unwrap_or(28))
}

#[tauri::command]
pub async fn gh_delivery_stats(
    state: State<'_, Mutex<AppState>>,
    days: Option<u32>,
) -> Result<gh_insights::GhDeliveryStats, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh_insights::delivery_stats(&repo_path, days.unwrap_or(28))
}

#[tauri::command]
pub async fn gh_traffic(
    state: State<'_, Mutex<AppState>>,
) -> Result<gh_insights::GhTraffic, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    gh_insights::traffic(&repo_path)
}
