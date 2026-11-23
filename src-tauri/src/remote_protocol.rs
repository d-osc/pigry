//! Private stdio protocol for the bundled desktop and Linux server.
use std::io::{self, BufRead, Read};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SERVER_READY: &str = "PIGRY_SERVER 1";
pub const MAX_FRAME: u64 = 64 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
pub struct Request {
    pub method: String,
    pub params: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum Reply {
    Success { result: Value },
    Failure { error: String },
}

pub fn read_frame(input: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    if input.take(MAX_FRAME + 1).read_until(b'\n', &mut line)? == 0 {
        return Ok(None);
    }
    if line.len() as u64 > MAX_FRAME || line.pop() != Some(b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Incomplete or oversized PIGRY message",
        ));
    }
    Ok(Some(line))
}

// Operations keep the same names and response shapes as their Tauri commands.
pub fn is_workspace_command(method: &str) -> bool {
    matches!(
        method,
        "get_app_state"
            | "refresh"
            | "get_file_tree"
            | "read_worktree_file"
            | "read_binary_file"
            | "read_pdf_text"
            | "write_worktree_file"
            | "delete_worktree_file"
            | "delete_worktree_folder"
            | "rename_worktree_file"
            | "rename_worktree_folder"
            | "search_code"
            | "get_file_history"
            | "read_file_at_commit"
            | "get_file_blame"
            | "get_line_changes"
            | "get_commit_oid_set"
            | "get_file_diff"
            | "get_file_hunks"
            | "stage_paths"
            | "unstage_paths"
            | "discard_file"
            | "stage_hunk"
            | "unstage_hunk"
            | "discard_hunk"
            | "stage_lines"
            | "compose_commit_message"
            | "staged_diff_preview"
            | "commit"
            | "get_commit_history"
            | "get_branch_commits"
            | "get_commit_detail"
            | "get_commit_file_diff"
            | "git_fetch"
            | "git_pull"
            | "git_push"
            | "push_preview"
            | "pull_preview"
            | "create_branch"
            | "rename_branch"
            | "checkout_branch"
            | "delete_branch"
            | "checkout_remote_branch"
            | "delete_remote_branch"
            | "create_tag"
            | "delete_tag"
            | "compare_branches"
            | "merge_branch"
            | "merge_preview"
            | "merge_abort"
            | "merge_file_versions"
            | "merge_status"
            | "stash_changes"
            | "stash_apply"
            | "stash_pop"
            | "stash_drop"
            | "stash_preview"
            | "cherry_pick"
            | "cherry_pick_abort"
            | "revert_commit"
            | "revert_abort"
            | "duplicate_commit"
            | "duplicate_commit_candidates"
            | "rebase_onto"
            | "interactive_rebase"
            | "abort_rebase"
            | "start_commit_edit"
            | "continue_commit_edit"
            | "get_repo_stats"
            | "get_insights"
            | "verify_commit_sig"
            | "get_user_info"
            | "set_user_info"
            | "list_remotes"
            | "add_remote"
            | "set_remote_url"
            | "remove_remote"
    )
}
