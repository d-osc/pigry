//! Tauri command handlers — thin wrappers around `git_state` + `config`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::config::{self, AppConfig};
use crate::FileWatcherHolder;
use crate::git_state::{self, FileDiffContent, RepositoryState};
use crate::ops;
use crate::settings;

/// Shared app state guarded by a mutex. Git operations are fast (local
/// repositories) so we keep them synchronous inside async commands.
pub struct AppState {
    pub config: AppConfig,
    pub repo_path: Option<PathBuf>,
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
    state
        .repo_path
        .as_deref()
        .ok_or_else(|| "no repository open".to_string())
}

fn build_payload(state: &AppState) -> AppStatePayload {
    let repository = state.repo_path.as_deref().and_then(|path| {
        match git_state::build_state(path) {
            Ok(value) => Some(value),
            Err(e) => {
                eprintln!("[orbit] build_state failed for {}: {e}", path.display());
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
    git2::Repository::discover(path)
        .map_err(|e| format!("not a git repository: {}", e.message()))?;
    let mut state = state.lock().map_err(|e| e.to_string())?;
    config::set_active(&mut state.config, path);
    config::save(app, &state.config);
    state.repo_path = Some(PathBuf::from(path));
    Ok(build_payload(&state))
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
    state.repo_path = None;
    state.config.active = None;
    config::save(&app, &state.config);
    Ok(build_payload(&state))
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
pub async fn get_file_history(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<Vec<git_state::FileCommitEntry>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::build_file_history(&repo_path, &path)
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
    crate::net::push(&repo_path, &branch, has_upstream)
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
) -> Result<git_state::FileDiffContent, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::read_commit_file_diff(&repo_path, &oid, &path)
}

#[tauri::command]
pub async fn create_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    name: String,
    checkout: bool,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::create_branch(&repo_path, &name, checkout)?;
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
) -> Result<Vec<git_state::BlameLine>, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    git_state::file_blame(&repo_path, &path)
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
pub async fn merge_branch(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    branch: String,
) -> Result<AppStatePayload, String> {
    let repo_path = {
        let state = state.lock().map_err(|e| e.to_string())?;
        repo_path_str(&state)?.to_path_buf()
    };
    ops::merge_branch(&repo_path, &branch)?;
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(build_payload(&state))
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
