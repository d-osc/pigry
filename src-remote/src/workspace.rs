use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{git_state, insights, net, ops, protocol::Request, settings};

type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct Workspace {
    root: Option<PathBuf>,
    watcher: Option<RecommendedWatcher>,
    changed: Arc<AtomicBool>,
}

impl Workspace {
    pub fn handle(&mut self, Request { method, params }: Request) -> Result<Value> {
        if method == "open" {
            let path: PathBuf = arg(&params, "path")?;
            if !path.is_absolute() {
                return Err("Enter an absolute server path beginning with /.".into());
            }
            let repo = git2::Repository::discover(&path).map_err(|error| {
                format!(
                    "No Git repository at {}: {}",
                    path.display(),
                    error.message()
                )
            })?;
            let root = repo.workdir().ok_or("Choose a Git working directory.")?;
            let watcher = watch(&repo, Arc::clone(&self.changed));
            let state = snapshot(root)?;
            self.root = Some(root.to_path_buf());
            self.watcher = watcher;
            return Ok(state);
        }
        if method == "workspace_changed" {
            return Ok(json!(self.changed.swap(false, Ordering::AcqRel)));
        }
        if !crate::protocol::is_workspace_command(&method) {
            return Err("This operation is unavailable on the PIGRY Server.".into());
        }
        let root = self.root.as_ref().ok_or("Open a server folder first.")?;
        run(root, &method, &params)
    }
}

fn watch(repo: &git2::Repository, changed: Arc<AtomicBool>) -> Option<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if event.is_err() || event.is_ok_and(|event| !matches!(event.kind, EventKind::Access(_))) {
            changed.store(true, Ordering::Release);
        }
    })
    .ok()?;
    let root = repo.workdir()?;
    watcher.watch(root, RecursiveMode::Recursive).ok()?;
    if !repo.path().starts_with(root) {
        let _ = watcher.watch(repo.path(), RecursiveMode::Recursive);
    }
    if !repo.commondir().starts_with(root) && repo.commondir() != repo.path() {
        let _ = watcher.watch(repo.commondir(), RecursiveMode::Recursive);
    }
    Some(watcher)
}

fn arg<T: DeserializeOwned>(params: &Value, name: &str) -> Result<T> {
    T::deserialize(&params[name]).map_err(|error| format!("Invalid {name}: {error}"))
}

fn value<T: Serialize>(result: T) -> Result<Value> {
    serde_json::to_value(result).map_err(|error| error.to_string())
}

fn snapshot(root: &Path) -> Result<Value> {
    let repository = git_state::build_state(root)?;
    Ok(json!({ "repository": repository }))
}

fn run(root: &PathBuf, method: &str, params: &Value) -> Result<Value> {
    macro_rules! param {
        ($name:literal) => {
            arg(params, $name)?
        };
    }
    macro_rules! string {
        ($name:literal) => {
            &arg::<String>(params, $name)?
        };
    }
    macro_rules! optional {
        ($name:literal) => {
            arg::<Option<String>>(params, $name)?.as_deref()
        };
    }
    macro_rules! list {
        ($ty:ty, $name:literal) => {
            &arg::<Vec<$ty>>(params, $name)?
        };
    }

    // File/Git mutations returning workspace state take a fresh snapshot after success.
    match method {
        "stage_paths" => git_state::stage_paths(root, list!(String, "paths"))?,
        "unstage_paths" => git_state::unstage_paths(root, list!(String, "paths"))?,
        "discard_file" => git_state::discard_file(root, string!("path"))?,
        "stage_hunk" => git_state::stage_hunk(root, string!("path"), param!("hunkIndex"))?,
        "unstage_hunk" => git_state::unstage_hunk(root, string!("path"), param!("hunkIndex"))?,
        "discard_hunk" => git_state::discard_hunk(root, string!("path"), param!("hunkIndex"))?,
        "stage_lines" => git_state::stage_lines(
            root,
            string!("path"),
            string!("side"),
            list!(u32, "selectedOld"),
            list!(u32, "selectedNew"),
        )?,
        "stash_changes" => git_state::stash(root, optional!("message"))?,
        "stash_apply" => git_state::stash_apply(root, param!("index"))?,
        "stash_pop" => git_state::stash_pop(root, param!("index"))?,
        "stash_drop" => git_state::stash_drop(root, param!("index"))?,
        "create_branch" => match optional!("fromRef") {
            Some(from) => {
                git_state::create_branch_from(root, string!("name"), from, param!("checkout"))?
            }
            None => git_state::create_branch(root, string!("name"), param!("checkout"))?,
        },
        "rename_branch" => git_state::rename_branch(root, string!("oldName"), string!("newName"))?,
        "checkout_branch" => git_state::checkout_branch(root, string!("name"))?,
        "delete_branch" => git_state::delete_branch(root, string!("name"))?,
        "checkout_remote_branch" => {
            git_state::checkout_remote_branch(root, string!("remote"), string!("name"))?
        }
        "delete_remote_branch" => {
            git_state::delete_remote_branch(root, string!("remote"), string!("name"))?;
        }
        "create_tag" => git_state::create_tag(root, string!("name"))?,
        "delete_tag" => git_state::delete_tag(root, string!("name"))?,
        "revert_commit" => {
            ops::revert_commit(root, string!("oid"))?;
        }
        "cherry_pick" => {
            ops::cherry_pick(root, string!("oid"))?;
        }
        "cherry_pick_abort" => {
            ops::cherry_pick_abort(root)?;
        }
        "duplicate_commit" => {
            ops::duplicate_commit(
                root,
                string!("sourceBranch"),
                string!("destinationBranch"),
                string!("oid"),
            )?;
        }
        "merge_branch" => {
            ops::merge_branch(
                root,
                string!("branch"),
                optional!("strategy").unwrap_or("ff"),
            )?;
            if ops::has_conflicts(root).unwrap_or(false) {
                return Err(
                    "CONFLICT: merge has unresolved conflicts — resolve them in Working changes"
                        .into(),
                );
            }
        }
        "merge_abort" => {
            ops::merge_abort(root)?;
        }
        "rebase_onto" => {
            ops::rebase_onto(root, string!("base"))?;
        }
        "interactive_rebase" => {
            ops::interactive_rebase(root, string!("base"), list!(ops::RebaseStep, "steps"))?;
        }
        "abort_rebase" => {
            ops::abort_rebase(root)?;
        }
        "start_commit_edit" => {
            ops::start_commit_edit(root, string!("branch"), string!("headOid"), string!("oid"))?
        }
        "continue_commit_edit" => ops::continue_commit_edit(root)?,
        "set_user_info" => settings::set_user_info(root, string!("name"), string!("email"))?,
        "add_remote" => settings::add_remote(root, string!("name"), string!("url"))?,
        "remove_remote" => settings::remove_remote(root, string!("name"))?,
        "set_remote_url" => settings::set_remote_url(root, string!("name"), string!("url"))?,
        "get_app_state" | "refresh" => {}
        _ => {
            return match method {
                "get_file_tree" => value(git_state::list_tree(root)?),
                "read_worktree_file" => {
                    value(git_state::read_worktree_file(root, string!("path"))?)
                }
                "read_binary_file" => value(git_state::read_binary_file(root, string!("path"))?),
                "read_pdf_text" => value(git_state::read_pdf_text(
                    root,
                    string!("path"),
                    arg::<Option<usize>>(params, "limit")?.unwrap_or(12_000),
                )?),
                "write_worktree_file" => value(git_state::write_worktree_file(
                    root,
                    string!("path"),
                    string!("content"),
                )?),
                "delete_worktree_file" => {
                    value(git_state::delete_worktree_file(root, string!("path"))?)
                }
                "delete_worktree_folder" => {
                    value(git_state::delete_worktree_folder(root, string!("path"))?)
                }
                "rename_worktree_file" => value(git_state::rename_worktree_file(
                    root,
                    string!("oldPath"),
                    string!("newPath"),
                )?),
                "rename_worktree_folder" => value(git_state::rename_worktree_folder(
                    root,
                    string!("oldPath"),
                    string!("newPath"),
                )?),
                "search_code" => value(git_state::search_worktree_code(
                    root,
                    string!("query"),
                    200,
                )?),
                "get_file_history" => value(git_state::build_file_history(
                    root,
                    string!("path"),
                    optional!("refName"),
                )?),
                "read_file_at_commit" => value(git_state::read_file_at_commit(
                    root,
                    string!("path"),
                    string!("oid"),
                )?),
                "get_file_blame" => {
                    match optional!("refName").filter(|name| !name.trim().is_empty()) {
                        Some(name) => value(git_state::blame_at(root, string!("path"), name)?),
                        None => value(git_state::file_blame(root, string!("path"))?),
                    }
                }
                "get_line_changes" => value(git_state::line_changes(root, string!("path"))?),
                "get_commit_oid_set" => value(git_state::commit_oid_set(
                    root,
                    optional!("refName"),
                    optional!("path"),
                    optional!("exclude"),
                    3000,
                )?),
                "get_file_diff" => value(git_state::file_diff_at(
                    root,
                    string!("path"),
                    param!("staged"),
                )?),
                "get_file_hunks" => value(git_state::file_hunks(
                    root,
                    string!("path"),
                    param!("staged"),
                )?),
                "compose_commit_message" => value(git_state::compose_commit_message(root)?),
                "staged_diff_preview" => {
                    let limit = arg::<Option<f64>>(params, "maxChars")?
                        .map(|n| n as usize)
                        .unwrap_or(16_000)
                        .clamp(200, 60_000);
                    value(git_state::staged_diff_preview(root, limit)?)
                }
                "commit" => {
                    let oid = git_state::commit(
                        root,
                        string!("title"),
                        string!("body"),
                        param!("amend"),
                    )?;
                    Ok(json!({ "oid": oid, "state": snapshot(root)? }))
                }
                "get_commit_history" => value(git_state::build_commit_history(
                    root,
                    param!("includeRemotes"),
                )?),
                "get_branch_commits" => value(git_state::build_ref_commits(
                    root,
                    string!("refName"),
                    arg::<Option<bool>>(params, "firstParent")?.unwrap_or(false),
                )?),
                "get_commit_detail" => value(git_state::build_commit_detail(root, string!("oid"))?),
                "get_commit_file_diff" => value(git_state::read_commit_file_diff(
                    root,
                    string!("oid"),
                    string!("path"),
                    optional!("previousPath"),
                )?),
                "git_fetch" => value(net::fetch(root)?),
                "git_pull" => value(net::pull(root)?),
                "git_push" => {
                    let state = git_state::build_state(root)?;
                    value(net::push(
                        root,
                        &state.current_branch,
                        state.upstream.is_some(),
                    )?)
                }
                "push_preview" => value(ops::push_preview(root)?),
                "pull_preview" => value(ops::pull_preview(root)?),
                "compare_branches" => value(ops::compare_branches(
                    root,
                    string!("baseRef"),
                    string!("compareRef"),
                )?),
                "merge_preview" => value(ops::merge_preview(root, string!("branch"))?),
                "merge_file_versions" => value(ops::merge_file_versions(
                    root,
                    string!("path"),
                    string!("branch"),
                )?),
                "merge_status" => value(ops::merge_status(root)?),
                "stash_preview" => value(ops::stash_preview(root, param!("index"))?),
                "duplicate_commit_candidates" => value(ops::duplicate_commit_candidates(
                    root,
                    string!("sourceBranch"),
                    string!("destinationBranch"),
                )?),
                "get_repo_stats" => value(ops::repo_stats(root)?),
                "get_insights" => value(insights::build_insights(
                    root,
                    arg::<Option<u32>>(params, "days")?.unwrap_or(28),
                )?),
                "verify_commit_sig" => value(ops::verify_commit(root, string!("oid"))?),
                "get_user_info" => value(settings::get_user_info(root)?),
                "list_remotes" => value(settings::list_remotes(root)?),
                _ => Err("This operation is unavailable on the PIGRY Server.".into()),
            };
        }
    }
    snapshot(root)
}
