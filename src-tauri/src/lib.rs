mod ai;
mod browser;
mod busybox;
mod containers;
mod gh;
mod busybox3;
mod busybox_extra;
mod commands;
mod config;
mod memory_vector;
// Probe/debug tooling reaches into git_state directly.
pub mod git_state;
pub mod net;
pub mod ops;
pub mod settings;
mod gh_insights;
mod insights;
mod watcher;
mod wiki;

use std::sync::Mutex;

use tauri::Manager;

use commands::AppState;
use watcher::FileWatcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = config::load(app.handle());
            // The app always lands on the repository picker (Home screen) —
            // the last active repo stays in the config for the recent list
            // but is not auto-opened at startup.
            let repo_path = None;
            let _ = &config.active;
            app.manage(Mutex::new(AppState { config, repo_path }));

            // File watcher: watches the active repo and emits `repo-changed`.
            let handle = app.handle().clone();
            let file_watcher = watcher::spawn(handle);
            app.manage(FileWatcherHolder {
                watcher: Mutex::new(file_watcher),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::open_repository,
            commands::pick_repository,
            commands::close_repository,
            commands::refresh,
            commands::stage_paths,
            commands::unstage_paths,
            commands::discard_file,
            commands::commit,
            commands::stash_changes,
            commands::get_file_diff,
            commands::get_commit_history,
            commands::get_commit_detail,
            commands::get_commit_file_diff,
            commands::get_file_tree,
            commands::terminal_run,
            commands::gh_install,
            commands::gh_open_url,
            commands::gh_token_scopes,
            commands::gh_pr_checkout,
            commands::gh_pr_close,
            commands::gh_pr_comment,
            commands::gh_pr_create,
            commands::gh_pr_detail,
            commands::gh_pr_diff,
            commands::gh_pr_review,
            commands::gh_release_create,
            commands::gh_release_delete,
            commands::gh_release_edit,
            commands::gh_release_view,
            commands::gh_device_flow_poll,
            commands::gh_device_flow_start,
            commands::gh_account_list,
            commands::gh_login_with_token,
            commands::gh_logout,
            commands::gh_switch_account,
            commands::gh_auth_status,
            commands::gh_issue_list,
            commands::gh_issue_view,
            commands::gh_issue_comment,
            commands::gh_issue_create,
            commands::gh_issue_close,
            commands::gh_issue_reopen,
            commands::wiki_check,
            commands::wiki_sync,
            commands::wiki_list,
            commands::wiki_read,
            commands::wiki_page_history,
            commands::wiki_save,
            commands::wiki_create,
            commands::gh_pr_list,
            commands::gh_release_list,
            commands::gh_project_list,
            commands::gh_project_item_list,
            browser::browser_create,
            browser::browser_position,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_close,
            containers::container_list,
            containers::container_create,
            containers::container_start,
            containers::container_stop,
            containers::container_remove,
            containers::container_logs,
            containers::compose_services,
            containers::compose_service_run,
            containers::compose_service_start,
            commands::gh_code_scanning_alerts,
            commands::gh_code_alert_dismiss,
            commands::gh_dependabot_alerts,
            commands::gh_secret_scanning_alerts,
            commands::gh_branch_check_runs,
            commands::gh_workflow_list,
            commands::gh_run_list,
            commands::gh_run_view,
            commands::gh_run_logs,
            commands::gh_run_rerun,
            commands::gh_run_cancel,
            commands::gh_workflow_dispatch,
            commands::gh_run_artifacts,
            commands::gh_run_download_artifact,
            commands::get_insights,
            commands::gh_delivery_stats,
            commands::gh_traffic,
            commands::get_commit_oid_set,
            commands::zcode_credentials,
            commands::cli_agent_run,
            commands::cli_detect,
            commands::ai_chat,
            commands::search_code,
            commands::read_worktree_file,
            commands::read_binary_file,
            commands::open_path_external,
            commands::write_worktree_file,
            commands::delete_worktree_file,
            commands::rename_worktree_file,
            commands::delete_worktree_folder,
            commands::rename_worktree_folder,
            commands::get_file_history,
            commands::read_file_at_commit,
            commands::create_branch,
            commands::checkout_branch,
            commands::delete_branch,
            commands::create_tag,
            commands::delete_tag,
            commands::stash_apply,
            commands::stash_pop,
            commands::stash_drop,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::get_file_hunks,
            commands::stage_hunk,
            commands::unstage_hunk,
            commands::discard_hunk,
            commands::get_file_blame,
            commands::clone_repo,
            commands::rebase_onto,
            commands::get_repo_stats,
            commands::verify_commit_sig,
            commands::revert_commit,
            commands::cherry_pick,
            commands::merge_branch,
            commands::merge_abort,
            commands::merge_preview,
            commands::push_preview,
            commands::stash_preview,
            commands::cherry_pick_abort,
            commands::merge_status,
            commands::merge_file_versions,
            commands::get_line_changes,
            commands::get_user_info,
            commands::set_user_info,
            commands::list_remotes,
            commands::add_remote,
            commands::remove_remote,
            commands::set_remote_url,
            commands::interactive_rebase,
            commands::abort_rebase,
            commands::stage_lines,
            commands::compose_commit_message,
            commands::memory_list,
            commands::memory_add,
            commands::memory_remove,
            commands::memory_search,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_, _| {});
}

/// Holds the background file watcher handle.
pub struct FileWatcherHolder {
    pub watcher: Mutex<FileWatcher>,
}
