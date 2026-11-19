use super::{err, has_conflicts, run_git_env, Result};
use git2::{Oid, Repository, RepositoryState};
use std::{fs, path::Path};

const EDIT_MARKER: &str = "pigry-edit-commit";

// Git appends the todo path as a separate argument. Match the selected full
// object ID and leave Git's generated labels, resets, and merges intact.
const SEQUENCE_EDITOR: &str = r#"sh -c '
    todo=$1
    temp="$todo.pigry-edit"
    found=
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "pick $PIGRY_EDIT_OID "*)
                printf "%s\n" "edit ${line#pick }"
                found=1
                ;;
            "merge -C $PIGRY_EDIT_OID "*)
                printf "%s\nbreak\n" "$line"
                found=1
                ;;
            *) printf "%s\n" "$line" ;;
        esac
    done < "$todo" > "$temp"
    if [ -z "$found" ]; then
        rm -f "$temp"
        exit 1
    fi
    mv -f "$temp" "$todo" &&
        printf "%s\n" "$PIGRY_EDIT_OID" > "${todo%/*}/pigry-edit-commit"
' --"#;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEditState {
    pub oid: String,
    pub branch: String,
    /// The sequence is stopped at the selected commit, ready to amend.
    pub editing: bool,
}

pub fn commit_edit_state(repo: &Repository) -> Option<CommitEditState> {
    let state_dir = repo.path().join("rebase-merge");
    let oid = fs::read_to_string(state_dir.join(EDIT_MARKER)).ok()?.trim().to_owned();
    let branch = fs::read_to_string(state_dir.join("head-name")).ok()?;
    let branch = branch.trim().strip_prefix("refs/heads/")?.to_owned();
    let done = fs::read_to_string(state_dir.join("done")).unwrap_or_default();
    let mut steps = done.lines().rev().filter(|line| !line.trim().is_empty());
    let editing = match steps.next() {
        Some(step) if step.trim() == "break" => {
            let mut merge = steps.next().unwrap_or_default().split_whitespace();
            merge.next() == Some("merge") && merge.next() == Some("-C") && merge.next() == Some(&oid)
        }
        Some(step) => {
            let mut words = step.split_whitespace();
            words.next() == Some("edit") && words.next() == Some(&oid)
        }
        None => false,
    };
    Some(CommitEditState { oid, branch, editing })
}

pub fn start_commit_edit(repo_path: &Path, branch: &str, head_oid: &str, oid: &str) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    if repo.state() != RepositoryState::Clean {
        return Err("Finish the Git operation in progress before editing a commit.".into());
    }
    let head = repo.head().map_err(err)?;
    let expected_ref = format!("refs/heads/{branch}");
    let expected_head = Oid::from_str(head_oid).map_err(err)?;
    if head.name() != Some(expected_ref.as_str()) || head.target() != Some(expected_head) {
        return Err("The checked-out branch changed. Select a commit again.".into());
    }
    let selected = Oid::from_str(oid).map_err(err)?;
    let mut history = repo.revwalk().map_err(err)?;
    history.simplify_first_parent().map_err(err)?;
    history.push(expected_head).map_err(err)?;
    let mut found = false;
    for commit in history {
        if commit.map_err(err)? == selected {
            found = true;
            break;
        }
    }
    if !found {
        return Err("Select a commit from the current branch's first-parent history.".into());
    }
    let status = crate::gitcli::run_git(repo_path, &[
        "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
    ])?;
    if !status.is_empty() {
        return Err("Commit or stash your working changes before editing an earlier commit.".into());
    }

    let commit = repo.find_commit(selected).map_err(err)?;
    let base = if commit.parent_count() == 0 { "--root".to_owned() } else {
        commit.parent_id(0).map_err(err)?.to_string()
    };
    let result = run_git_env(repo_path, &[
        "-c", "core.abbrev=no",
        "-c", "rebase.abbreviateCommands=false",
        "-c", "rebase.updateRefs=false",
        "rebase", "--interactive", "--rebase-merges", "--no-autosquash", "--no-autostash",
        "--no-fork-point", "--reapply-cherry-picks", "--empty=keep", &base,
    ], &[
        ("GIT_SEQUENCE_EDITOR", SEQUENCE_EDITOR),
        ("PIGRY_EDIT_OID", &selected.to_string()),
        ("GIT_EDITOR", "true"),
    ]);
    let edit_started = commit_edit_state(&repo).is_some();
    match result {
        Ok(_) if edit_started => Ok(()),
        // A native conflict can pause the sequence before it reaches the edit.
        Err(_) if edit_started && has_conflicts(repo_path)? => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err("Git did not pause at the selected commit.".into()),
    }
}

pub fn continue_commit_edit(repo_path: &Path) -> Result<()> {
    let repo = Repository::discover(repo_path).map_err(err)?;
    let edit = commit_edit_state(&repo).ok_or("No commit edit is in progress.")?;
    if has_conflicts(repo_path)? {
        return Err("Resolve and stage the conflicts before continuing.".into());
    }
    let unstaged = crate::gitcli::run_git(repo_path, &[
        "diff", "--name-only", "--no-ext-diff", "--ignore-submodules=none", "--",
    ])?;
    if !unstaged.is_empty() {
        return Err("Stage or discard your unstaged changes before continuing.".into());
    }
    if edit.editing {
        let staged = crate::gitcli::run_git(repo_path, &[
            "diff", "--cached", "--name-only", "--no-ext-diff", "--ignore-submodules=none", "--",
        ])?;
        if !staged.is_empty() {
            if !repo.head_detached().map_err(err)? {
                return Err("Git is no longer stopped at the selected commit.".into());
            }
            crate::gitcli::run_git(repo_path, &["commit", "--amend", "--no-edit"])?;
        }
    }
    match run_git_env(repo_path, &["rebase", "--continue"], &[("GIT_EDITOR", "true")]) {
        Ok(_) => Ok(()),
        Err(_) if has_conflicts(repo_path)? => Ok(()),
        Err(error) => Err(error),
    }
}
