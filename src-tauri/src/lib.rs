mod commands;
mod config;
// Probe/debug tooling reaches into git_state directly.
pub mod git_state;
pub mod net;

use std::sync::Mutex;

use tauri::Manager;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = config::load(app.handle());
            let repo_path = config.active.clone().map(std::path::PathBuf::from);
            app.manage(Mutex::new(AppState { config, repo_path }));
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
            commands::get_file_tree,
            commands::read_worktree_file,
            commands::write_worktree_file,
            commands::get_file_history,
            commands::read_file_at_commit,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::get_commit_detail,
            commands::get_commit_file_diff,
            commands::get_file_hunks,
            commands::stage_hunk,
            commands::unstage_hunk,
            commands::discard_hunk,
            commands::create_branch,
            commands::checkout_branch,
            commands::delete_branch,
            commands::create_tag,
            commands::delete_tag,
            commands::stash_apply,
            commands::stash_pop,
            commands::stash_drop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_, _| {});
}
