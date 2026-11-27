
/// `CREATE_NO_WINDOW` for spawned processes on Windows — a no-op on other
/// operating systems, where the flag is not needed.
#[cfg(windows)]
mod command_no_window {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    pub trait CommandNoWindow {
        fn no_window(&mut self) -> &mut Self;
    }
    impl CommandNoWindow for Command {
        fn no_window(&mut self) -> &mut Self {
            self.creation_flags(0x0800_0000);
            self
        }
    }
    impl CommandNoWindow for &mut Command {
        fn no_window(&mut self) -> &mut Self {
            self.creation_flags(0x0800_0000);
            self
        }
    }
}
#[cfg(not(windows))]
mod command_no_window {
    use std::process::Command;
    pub trait CommandNoWindow {
        fn no_window(&mut self) -> &mut Self;
    }
    impl CommandNoWindow for Command {
        fn no_window(&mut self) -> &mut Self { self }
    }
    impl CommandNoWindow for &mut Command {
        fn no_window(&mut self) -> &mut Self { self }
    }
}
pub use command_no_window::CommandNoWindow;

mod agent_import;
mod ai;
mod browser;
mod browser_detect;
mod bidi;
mod pw_engine;
mod busybox;
mod gh;
mod gh_cache;
mod busybox3;
mod busybox_extra;
mod commands;
mod config;
mod memory_vector;
mod devtools;
mod web;
mod http_client;
// Probe/debug tooling reaches into git_state directly.
pub mod git_state;
pub mod gitcli;
pub mod net;
pub mod ops;
pub mod settings;
mod gh_insights;
mod insights;
mod pty;
mod remote_protocol;
pub mod ssh_relay;
mod ssh_workspace;
pub mod pty_bash;
mod watcher;
mod wiki;
mod launch;

use std::sync::Mutex;

use tauri::{Manager, Wry, ipc::Invoke};

use commands::AppState;
use watcher::FileWatcher;

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn with_ssh_routing(
    local: impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    move |invoke| match commands::route_ssh_workspace(invoke) {
        Some(invoke) => local(invoke),
        None => true,
    }
}

#[tauri::command]
fn validation_ready() {
    #[cfg(debug_assertions)]
    if let (Some(started), Some(dir)) = (STARTED.get(), std::env::var_os("PIGRY_TEST_CONFIG_DIR")) {
        let file = std::path::PathBuf::from(dir).join("startup.json");
        if !file.exists() {
            let _ = std::fs::write(file, format!("{{\"homeReadyMs\":{}}}\n", started.elapsed().as_millis()));
        }
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = STARTED.set(std::time::Instant::now());
    // Dev builds only: expose WebView2's Chrome DevTools Protocol on a local
    // port so the agent's E2E tooling can attach to the panel pages
    // (network capture, live screenshots, PDF, file upload). Release builds
    // never set this — no debugging surface ships to users.
    #[cfg(debug_assertions)]
    unsafe {
        if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9222");
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = config::load(app.handle());
            // The app always lands on the repository picker (Home screen) —
            // the last active repo stays in the config for the recent list
            // but is not auto-opened at startup.
            let repo_path = None;
            let _ = &config.active;
            app.manage(Mutex::new(AppState { config, repo_path, ssh_workspace: None }));
            app.manage(launch::LaunchFolder(launch::parse_folder(std::env::args_os().skip(1))));

            // File watcher: watches the active repo and emits `repo-changed`.
            let handle = app.handle().clone();
            let file_watcher = watcher::spawn(handle);
            app.manage(FileWatcherHolder {
                watcher: Mutex::new(file_watcher),
            });

            // Interactive window drag: WebView2 child webviews track a moving
            // window late, so they visibly trail behind. Re-apply their stored
            // bounds on every Moved event (throttled to ~30 fps).
            let handle = app.handle().clone();
            let main_window = app.get_window("main").ok_or("main window not found")?;
            let last_move = std::sync::Mutex::new(std::time::Instant::now()
                - std::time::Duration::from_secs(1));
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::Moved(_) = event {
                    let mut last = last_move.lock().expect("drag throttle poisoned");
                    if last.elapsed() >= std::time::Duration::from_millis(33) {
                        *last = std::time::Instant::now();
                        browser::reposition_all(&handle);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(with_ssh_routing(tauri::generate_handler![
            commands::get_app_state,
            launch::get_launch_folder,
            launch::install_launch_command,
            validation_ready,
            commands::open_repository,
            commands::open_ssh_workspace,
            commands::cancel_ssh_workspace_start,
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
            pty::pty_list_shells,
            pty::agent_shell_run,
            pty::pty_create,
            pty::pty_create_ssh,
            pty::pty_start_ssh_workspace,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            commands::gh_install,
            commands::gh_open_url,
            commands::gh_token_scopes,
            commands::gh_pr_checkout,
            commands::gh_pr_close,
            commands::gh_pr_comment,
            commands::gh_pr_create,
            commands::gh_pr_detail,
            commands::gh_invalidate_cache,
            commands::gh_pr_items_page,
            commands::gh_pr_diff,
            commands::gh_pr_file_patches,
            commands::gh_pr_commit_diff,
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
            browser::browser_eval,
            browser::browser_url,
            commands::browser_cdp,
            browser::browser_prune,
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
            commands::commit_avatars,
            commands::cli_agent_run,
            commands::cli_chat,
            commands::agent_import_read,
            commands::cli_detect,
            commands::launch_app,
            commands::claude_usage,
            commands::zcode_plan_subscription,
            commands::ai_chat,
            commands::search_code,
            commands::read_worktree_file,
            commands::read_binary_file,
            commands::open_path_external,
            commands::write_worktree_file,
            commands::write_worktree_binary,
            commands::write_worktree_binary_chunk,
            commands::read_binary_chunk,
            commands::delete_worktree_file,
            commands::rename_worktree_file,
            commands::copy_worktree_path,
            commands::reveal_worktree_path,
            commands::delete_worktree_folder,
            commands::rename_worktree_folder,
            commands::get_file_history,
            commands::read_file_at_commit,
            commands::restore_file_from_commit,
            commands::create_branch,
            commands::checkout_branch,
            commands::delete_branch,
            commands::rename_branch,
            commands::checkout_remote_branch,
            commands::list_checkout_refs,
            commands::checkout_tag,
            commands::delete_remote_branch,
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
            commands::revert_abort,
            commands::cherry_pick,
            commands::duplicate_commit,
            commands::duplicate_commit_candidates,
            commands::duplicate_commit_conflicts,
            commands::duplicate_commit_resolved,
            commands::merge_branch,
            commands::merge_abort,
            commands::merge_preview,
            commands::compare_branches,
            commands::pr_draft_context,
            commands::pr_merge_conflicts,
            commands::pr_merge_resolved,
            commands::push_preview,
            commands::pull_preview,
            commands::stash_preview,
            commands::cherry_pick_abort,
            commands::get_branch_commits,
            commands::merge_status,
            commands::conflict_state,
            commands::conflict_versions,
            commands::conflict_resolve_file,
            commands::conflict_continue,
            commands::conflict_abort,
            commands::merge_file_versions,
            commands::get_line_changes,
            commands::get_user_info,
            commands::set_user_info,
            commands::list_remotes,
            commands::add_remote,
            commands::remove_remote,
            commands::set_remote_url,
            commands::interactive_rebase,
            commands::start_commit_edit,
            commands::continue_commit_edit,
            commands::abort_rebase,
            commands::stage_lines,
            commands::compose_commit_message,
            commands::staged_diff_preview,
            commands::git_cli_status,
            commands::memory_list,
            commands::memory_add,
            commands::memory_remove,
            commands::memory_search,
            commands::web_search,
            http_client::http_send,
            http_client::http_cancel,
            http_client::api_yaml_to_json,
            commands::browser_devtools,
            browser_detect::e2e_browsers,
            commands::browser,
            commands::read_pdf_text,
            commands::browser_page,
        ]))
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Terminal PTY children must not outlive the app — the exit event is
    // the one place the run loop lets us clean them up.
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            commands::stop_active_ssh_workspace(app);
            pty::kill_all();
        }
    });
}

/// Holds the background file watcher handle.
pub struct FileWatcherHolder {
    pub watcher: Mutex<FileWatcher>,
}
