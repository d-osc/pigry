//! A pull request's conflicts, resolved the way GitHub's "Resolve conflicts" does: the base branch
//! is merged into the compare branch in memory, the user resolves each conflicted file, and the merge
//! is committed on the compare branch. Nothing is written until the user completes it.

use std::path::Path;

use serde::Serialize;

use super::{apply_resolutions, err, read_conflicts, DuplicateConflictFile, DuplicateResolution, Result};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrMergeConflicts {
    /// The tips the conflicts were computed against; resolving checks both are unchanged.
    pub base_oid: String,
    pub compare_oid: String,
    /// Empty when the base merges into the compare branch cleanly. "Ours" is the compare branch,
    /// "theirs" the base.
    pub files: Vec<DuplicateConflictFile>,
}

/// "refs/remotes/origin/main" → "origin/main", "refs/heads/main" → "main".
fn base_label(base_ref: &str) -> &str {
    base_ref
        .strip_prefix("refs/heads/")
        .or_else(|| base_ref.strip_prefix("refs/remotes/"))
        .unwrap_or(base_ref)
}

fn inputs<'r>(
    repo: &'r git2::Repository,
    base_ref: &str,
    compare_branch: &str,
) -> Result<(git2::Commit<'r>, git2::Commit<'r>)> {
    if !base_ref.starts_with("refs/heads/") && !base_ref.starts_with("refs/remotes/") {
        return Err(format!("Invalid branch reference: {base_ref}"));
    }
    let base = repo
        .find_reference(base_ref)
        .and_then(|reference| reference.peel_to_commit())
        .map_err(|error| format!("Could not resolve {base_ref}: {}", error.message()))?;
    let compare = repo
        .find_branch(compare_branch, git2::BranchType::Local)
        .and_then(|branch| branch.get().peel_to_commit())
        .map_err(|error| format!("Could not resolve {compare_branch}: {}", error.message()))?;
    Ok((base, compare))
}

/// Merges the base into the compare branch in memory and lists the conflicted files. Writes nothing.
pub fn pr_merge_conflicts(repo_path: &Path, base_ref: &str, compare_branch: &str) -> Result<PrMergeConflicts> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let (base, compare) = inputs(&repo, base_ref, compare_branch)?;
    let index = repo.merge_commits(&compare, &base, None).map_err(err)?;
    let files = if index.has_conflicts() {
        read_conflicts(&repo, &index, compare_branch, base_label(base_ref))?
    } else {
        Vec::new()
    };
    Ok(PrMergeConflicts {
        base_oid: base.id().to_string(),
        compare_oid: compare.id().to_string(),
        files,
    })
}

/// Commits the merge of the base into the compare branch with every conflicted file resolved, and
/// moves the compare branch to it (fast-forwarding the working tree when it is checked out). Fails
/// without touching anything when either branch moved since the conflicts were shown.
pub fn pr_merge_resolved(
    repo_path: &Path,
    base_ref: &str,
    compare_branch: &str,
    expected_base: &str,
    expected_compare: &str,
    resolutions: &[DuplicateResolution],
) -> Result<String> {
    use crate::gitcli::run_git;

    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let (base, compare) = inputs(&repo, base_ref, compare_branch)?;
    let label = base_label(base_ref);
    if base.id().to_string() != expected_base || compare.id().to_string() != expected_compare {
        return Err(format!(
            "{label} or {compare_branch} changed while you were resolving the conflicts. Open the conflicts again to see the new changes."
        ));
    }
    let mut index = repo.merge_commits(&compare, &base, None).map_err(err)?;
    if !index.has_conflicts() {
        return Err(format!("{label} now merges into {compare_branch} without conflicts."));
    }
    apply_resolutions(&repo, &mut index, resolutions)?;
    if index.has_conflicts() {
        return Err("Some files are still conflicted. Resolve every file first.".into());
    }
    let tree = repo.find_tree(index.write_tree_to(&repo).map_err(err)?).map_err(err)?;
    let message = if base_ref.starts_with("refs/remotes/") {
        format!("Merge remote-tracking branch '{label}' into {compare_branch}")
    } else {
        format!("Merge branch '{label}' into {compare_branch}")
    };
    let signature = repo.signature().map_err(err)?;
    let new_oid = repo
        .commit(None, &signature, &signature, &message, &tree, &[&compare, &base])
        .map_err(err)?
        .to_string();

    let branch = repo
        .find_branch(compare_branch, git2::BranchType::Local)
        .map_err(err)?;
    if branch.get().target() != Some(compare.id()) {
        return Err(format!("{compare_branch} changed while committing the merge. Try again."));
    }
    let branch_ref = format!("refs/heads/{compare_branch}");
    if branch.is_head() {
        if repo.state() != git2::RepositoryState::Clean
            || !run_git(repo_path, &["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=none"])?.is_empty()
        {
            return Err(format!("Finish the current Git operation or commit or stash your changes on {compare_branch} first."));
        }
        // Let Git update the branch, index and working tree together; it refuses to overwrite untracked files.
        run_git(repo_path, &["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", &new_oid])?;
    } else {
        let worktree = run_git(repo_path, &["branch", "--list", "--format=%(worktreepath)", "--", compare_branch])?;
        if !worktree.is_empty() {
            return Err(format!("{compare_branch} is in use in another worktree. Open that worktree to resolve the conflicts there."));
        }
        // Compare the old value under Git's ref lock so a concurrent update is preserved.
        run_git(repo_path, &[
            "update-ref", "-m", &format!("merge {label}: resolve pull request conflicts"),
            &branch_ref, &new_oid, &compare.id().to_string(),
        ])?;
    }
    Ok(new_oid)
}
