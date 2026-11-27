//! Integration tests for ops.rs — revert, cherry-pick, merge.

use std::fs;
use std::path::PathBuf;

use git2::Repository;

// Helper: run git CLI in dir.
fn git_cli(dir: &PathBuf, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C").arg(dir)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("git CLI available");
    assert!(out.status.success(), "git {:?} failed: {}", args,
        String::from_utf8_lossy(&out.stderr));
}

#[test]
fn compare_branches_reports_divergence_and_tip_to_tip_file_changes() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-compare-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    git_cli(&dir, &["init", "-b", "main"]);
    git_cli(&dir, &["config", "user.name", "Test User"]);
    git_cli(&dir, &["config", "user.email", "test@pigry.dev"]);
    fs::write(dir.join("common.txt"), "common\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Common history"]);
    git_cli(&dir, &["branch", "feature/work"]);
    fs::write(dir.join("base.txt"), "base\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Base change"]);
    git_cli(&dir, &["checkout", "feature/work"]);
    fs::write(dir.join("feature.txt"), "feature\nfeature line two\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Feature change"]);
    git_cli(&dir, &["update-ref", "refs/remotes/origin/feature/work", "HEAD"]);
    fs::write(dir.join("uncommitted.txt"), "working tree only\n").unwrap();

    let comparison = super::compare_branches(&dir, "refs/heads/main", "refs/remotes/origin/feature/work").unwrap();
    assert_eq!((comparison.base_only, comparison.compare_only), (1, 1));
    assert_ne!(comparison.base_oid, comparison.compare_oid);
    let files: Vec<_> = comparison
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.status.as_str(), file.additions, file.deletions))
        .collect();
    assert_eq!(files, [("base.txt", "D", 0, 1), ("feature.txt", "A", 2, 0)]);
    assert!(super::compare_branches(&dir, "HEAD", "refs/heads/main").is_err());
    assert!(dir.join("uncommitted.txt").is_file());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn pr_draft_context_reads_commits_patches_from_the_merge_base_and_the_template() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-pr-draft-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join(".github")).unwrap();
    git_cli(&dir, &["init", "-b", "main"]);
    git_cli(&dir, &["config", "user.name", "Test User"]);
    git_cli(&dir, &["config", "user.email", "test@pigry.dev"]);
    fs::write(dir.join("common.txt"), "one
two
").unwrap();
    fs::write(dir.join(".github/PULL_REQUEST_TEMPLATE.md"), "## What

## Why
").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Common history"]);
    git_cli(&dir, &["branch", "feature/work"]);
    // A later change on main is not part of the pull request.
    fs::write(dir.join("base-only.txt"), "base
").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Base change"]);
    git_cli(&dir, &["checkout", "feature/work"]);
    fs::write(dir.join("common.txt"), "one
TWO
three
").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "fix: shout the second line", "-m", "Body explains why."]);
    fs::write(dir.join("logo.bin"), [0u8, 159, 146, 150, 0, 1]).unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "feat: add a logo"]);

    let context = super::pr_draft_context(&dir, "refs/heads/main", "refs/heads/feature/work").unwrap();
    let messages: Vec<_> = context.commits.iter().map(|commit| commit.message.as_str()).collect();
    assert_eq!(messages, ["fix: shout the second line

Body explains why.", "feat: add a logo"]);
    let paths: Vec<_> = context.files.iter().map(|file| (file.path.as_str(), file.status.as_str())).collect();
    assert_eq!(paths, [("common.txt", "M"), ("logo.bin", "A")]);
    let text = &context.files[0];
    assert_eq!((text.additions, text.deletions, text.binary, text.truncated), (2, 1, false, false));
    assert!(text.patch.contains("+TWO
") && text.patch.contains("-two
"), "{}", text.patch);
    assert!(context.files[1].binary && context.files[1].patch.is_empty());
    let template = context.template.expect("template found");
    assert_eq!(template.path, ".github/PULL_REQUEST_TEMPLATE.md");
    assert!(template.content.starts_with("## What"));
    assert!(super::pr_draft_context(&dir, "HEAD", "refs/heads/main").is_err());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn pr_merge_conflicts_are_resolved_by_merging_the_base_into_the_compare_branch() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-pr-merge-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    git_cli(&dir, &["init", "-b", "main"]);
    git_cli(&dir, &["config", "user.name", "Test User"]);
    git_cli(&dir, &["config", "user.email", "test@pigry.dev"]);
    fs::write(dir.join("shared.txt"), "one\ntwo\nthree\n").unwrap();
    fs::write(dir.join("other.txt"), "other\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Common history"]);
    git_cli(&dir, &["branch", "feature/work"]);
    fs::write(dir.join("shared.txt"), "one\nTWO from main\nthree\n").unwrap();
    fs::write(dir.join("main-only.txt"), "main\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Main change"]);
    git_cli(&dir, &["checkout", "feature/work"]);
    fs::write(dir.join("shared.txt"), "one\ntwo from feature\nthree\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Feature change"]);
    // main is checked out: the compare branch is moved with update-ref, the working tree is untouched.
    git_cli(&dir, &["checkout", "main"]);

    let shown = super::pr_merge_conflicts(&dir, "refs/heads/main", "feature/work").unwrap();
    assert_eq!(shown.files.len(), 1);
    let file = &shown.files[0];
    assert_eq!(file.path, "shared.txt");
    assert_eq!(file.ours.as_deref(), Some("one\ntwo from feature\nthree\n"));
    assert_eq!(file.theirs.as_deref(), Some("one\nTWO from main\nthree\n"));
    let merged = file.merged.clone().unwrap();
    assert!(merged.contains("<<<<<<< feature/work") && merged.contains(">>>>>>> main"), "{merged}");

    let resolution = |content: &str| vec![super::DuplicateResolution { path: "shared.txt".into(), content: Some(content.into()), side: None }];
    let stale = super::pr_merge_resolved(&dir, "refs/heads/main", "feature/work", &shown.compare_oid, &shown.compare_oid, &resolution("x\n"));
    assert!(stale.unwrap_err().contains("changed while you were resolving"));
    let marked = super::pr_merge_resolved(&dir, "refs/heads/main", "feature/work", &shown.base_oid, &shown.compare_oid, &resolution(&merged));
    assert!(marked.unwrap_err().contains("conflict markers"));

    let merge = super::pr_merge_resolved(
        &dir, "refs/heads/main", "feature/work", &shown.base_oid, &shown.compare_oid,
        &resolution("one\nTWO from both\nthree\n"),
    ).unwrap();
    let repo = Repository::open(&dir).unwrap();
    let tip = repo.find_branch("feature/work", git2::BranchType::Local).unwrap().get().peel_to_commit().unwrap();
    assert_eq!(tip.id().to_string(), merge);
    assert_eq!(tip.parent_count(), 2);
    assert_eq!(tip.parent_id(0).unwrap().to_string(), shown.compare_oid);
    assert_eq!(tip.parent_id(1).unwrap().to_string(), shown.base_oid);
    assert_eq!(tip.summary(), Some("Merge branch 'main' into feature/work"));
    let tree = tip.tree().unwrap();
    let blob = |path: &str| {
        let object = tree.get_path(std::path::Path::new(path)).unwrap().to_object(&repo).unwrap();
        String::from_utf8(object.peel_to_blob().unwrap().content().to_vec()).unwrap()
    };
    assert_eq!(blob("shared.txt"), "one\nTWO from both\nthree\n");
    assert_eq!(blob("main-only.txt"), "main\n");
    // Now the base merges cleanly, and the working tree on main was not touched.
    assert!(super::pr_merge_conflicts(&dir, "refs/heads/main", "feature/work").unwrap().files.is_empty());
    assert_eq!(fs::read_to_string(dir.join("shared.txt")).unwrap().replace("\r\n", "\n"), "one\nTWO from main\nthree\n");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn pr_merge_resolved_fast_forwards_the_checked_out_compare_branch() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-pr-merge-head-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    git_cli(&dir, &["init", "-b", "main"]);
    git_cli(&dir, &["config", "user.name", "Test User"]);
    git_cli(&dir, &["config", "user.email", "test@pigry.dev"]);
    fs::write(dir.join("a.txt"), "base\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Common"]);
    git_cli(&dir, &["checkout", "-b", "fix/x"]);
    fs::write(dir.join("a.txt"), "fix\n").unwrap();
    git_cli(&dir, &["commit", "-am", "Fix"]);
    git_cli(&dir, &["checkout", "main"]);
    fs::write(dir.join("a.txt"), "main\n").unwrap();
    git_cli(&dir, &["commit", "-am", "Main"]);
    git_cli(&dir, &["checkout", "fix/x"]);
    fs::write(dir.join("untracked.txt"), "keep me\n").unwrap();

    let shown = super::pr_merge_conflicts(&dir, "refs/heads/main", "fix/x").unwrap();
    let pick = vec![super::DuplicateResolution { path: "a.txt".into(), content: None, side: Some("theirs".into()) }];
    super::pr_merge_resolved(&dir, "refs/heads/main", "fix/x", &shown.base_oid, &shown.compare_oid, &pick).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap().replace("\r\n", "\n"), "main\n");
    assert_eq!(fs::read_to_string(dir.join("untracked.txt")).unwrap(), "keep me\n");
    let repo = Repository::open(&dir).unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 2);
    let mut options = git2::StatusOptions::new();
    options.include_untracked(false);
    assert!(repo.statuses(Some(&mut options)).unwrap().is_empty());
    fs::remove_dir_all(&dir).unwrap();
}

fn duplicate_commit_fixture(name: &str) -> (PathBuf, String, String) {
    let dir = std::env::temp_dir().join(format!("pigry-duplicate-{name}-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    git_cli(&dir, &["init", "-b", "destination"]);
    git_cli(&dir, &["config", "user.name", "Test User"]);
    git_cli(&dir, &["config", "user.email", "test@pigry.dev"]);
    git_cli(&dir, &["config", "commit.gpgsign", "false"]);
    fs::write(dir.join("shared.txt"), "original\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Common history"]);
    git_cli(&dir, &["branch", "feature/source"]);
    fs::write(dir.join("destination.txt"), "destination work\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Destination work"]);
    let destination_tip = crate::gitcli::run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    git_cli(&dir, &["checkout", "feature/source"]);
    fs::write(dir.join("earlier.txt"), "keep on source\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Earlier source work"]);
    fs::write(dir.join("shared.txt"), "copy this change\n").unwrap();
    git_cli(&dir, &["add", "shared.txt"]);
    git_cli(&dir, &["commit", "--author=Original Author <author@example.com>", "-m", "Copy just this commit"]);
    let source_tip = crate::gitcli::run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    (dir, source_tip, destination_tip)
}

#[test]
fn duplicate_commit_preserves_the_source_branch_and_local_work() {
    use crate::gitcli::run_git;
    let (dir, source_tip, destination_tip) = duplicate_commit_fixture("inactive");
    fs::write(dir.join("staged.txt"), "staged WIP\n").unwrap();
    git_cli(&dir, &["add", "staged.txt"]);
    fs::write(dir.join("shared.txt"), "unstaged WIP\n").unwrap();
    fs::write(dir.join("untracked.txt"), "untracked WIP\n").unwrap();
    let status_before = run_git(&dir, &["status", "--porcelain=v1"]).unwrap();

    let common = run_git(&dir, &["rev-parse", "feature/source~2"]).unwrap();
    let candidates = super::duplicate_commit_candidates(&dir, "feature/source", "destination").unwrap();
    assert!(!candidates.contains(&common));
    assert!(candidates.contains(&source_tip));
    let existing = super::duplicate_commit(&dir, "feature/source", "destination", &common);
    assert!(existing.unwrap_err().contains("already contains this commit"));

    super::duplicate_commit(&dir, "feature/source", "destination", &source_tip).unwrap();

    assert_eq!(run_git(&dir, &["symbolic-ref", "--short", "HEAD"]).unwrap(), "feature/source");
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).unwrap(), source_tip);
    assert_eq!(run_git(&dir, &["status", "--porcelain=v1"]).unwrap(), status_before);
    assert_eq!(fs::read_to_string(dir.join("shared.txt")).unwrap(), "unstaged WIP\n");
    assert_eq!(run_git(&dir, &["rev-parse", "destination^"]).unwrap(), destination_tip);
    assert_eq!(run_git(&dir, &["show", "destination:shared.txt"]).unwrap(), "copy this change");
    assert_eq!(run_git(&dir, &["show", "destination:destination.txt"]).unwrap(), "destination work");
    assert!(run_git(&dir, &["show", "destination:earlier.txt"]).is_err());
    assert_eq!(run_git(&dir, &["log", "-1", "--format=%an: %s", "destination"]).unwrap(), "Original Author: Copy just this commit");
    let replay = super::duplicate_commit(&dir, "feature/source", "destination", &source_tip);
    assert!(replay.unwrap_err().contains("already contains an equivalent change"));
    let candidates = super::duplicate_commit_candidates(&dir, "feature/source", "destination").unwrap();
    assert!(!candidates.contains(&source_tip));

    git_cli(&dir, &["branch", "linked-destination", &destination_tip]);
    git_cli(&dir, &["worktree", "add", "linked", "linked-destination"]);
    let linked = super::duplicate_commit(&dir, "feature/source", "linked-destination", &source_tip);
    assert!(linked.unwrap_err().contains("in use in another worktree"));
    assert_eq!(run_git(&dir, &["rev-parse", "linked-destination"]).unwrap(), destination_tip);
    git_cli(&dir, &["worktree", "remove", "linked"]);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn duplicate_commit_handles_a_checked_out_destination_and_conflicts() {
    use crate::gitcli::run_git;
    let (dir, source_tip, destination_tip) = duplicate_commit_fixture("active");
    git_cli(&dir, &["checkout", "destination"]);
    fs::write(dir.join("shared.txt"), "dirty destination\n").unwrap();
    let dirty = super::duplicate_commit(&dir, "feature/source", "destination", &source_tip);
    assert!(dirty.unwrap_err().contains("commit or stash"));
    assert_eq!(run_git(&dir, &["rev-parse", "destination"]).unwrap(), destination_tip);
    assert_eq!(fs::read_to_string(dir.join("shared.txt")).unwrap(), "dirty destination\n");

    git_cli(&dir, &["checkout", "-b", "conflict"]);
    git_cli(&dir, &["add", "shared.txt"]);
    git_cli(&dir, &["commit", "-m", "Conflicting work"]);
    let conflict_tip = run_git(&dir, &["rev-parse", "conflict"]).unwrap();
    let conflict = super::duplicate_commit(&dir, "feature/source", "conflict", &source_tip);
    assert!(conflict.unwrap_err().contains("conflicts with changes"));
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).unwrap(), conflict_tip);
    assert!(run_git(&dir, &["status", "--porcelain=v1"]).unwrap().is_empty());

    git_cli(&dir, &["checkout", "destination"]);
    super::duplicate_commit(&dir, "feature/source", "destination", &source_tip).unwrap();
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD^"]).unwrap(), destination_tip);
    assert_eq!(fs::read_to_string(dir.join("shared.txt")).unwrap().trim(), "copy this change");
    assert!(run_git(&dir, &["status", "--porcelain=v1"]).unwrap().is_empty());
    git_cli(&dir, &["revert", "--no-edit", "HEAD"]);
    let replay = super::duplicate_commit(&dir, "feature/source", "destination", &source_tip);
    assert!(replay.unwrap_err().contains("already contains an equivalent change"));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn duplicate_commit_conflicts_can_be_resolved_or_abandoned() {
    use crate::gitcli::run_git;
    use super::DuplicateResolution;
    let resolve = |path: &str, content: Option<&str>, side: Option<&str>| DuplicateResolution {
        path: path.into(),
        content: content.map(str::to_string),
        side: side.map(str::to_string),
    };
    let (dir, source_tip, destination_tip) = duplicate_commit_fixture("resolve");
    git_cli(&dir, &["branch", "conflict", &destination_tip]);
    git_cli(&dir, &["checkout", "conflict"]);
    fs::write(dir.join("shared.txt"), "destination edit\n").unwrap();
    git_cli(&dir, &["commit", "-am", "Conflicting work"]);
    let conflict_tip = run_git(&dir, &["rev-parse", "conflict"]).unwrap();
    git_cli(&dir, &["checkout", "feature/source"]);

    // A clean duplicate has nothing to resolve.
    let clean = super::duplicate_commit_conflicts(&dir, "feature/source", "destination", &source_tip).unwrap();
    assert!(clean.files.is_empty());

    // Showing the conflicts writes nothing: the destination, HEAD and working tree stay as they were.
    let shown = super::duplicate_commit_conflicts(&dir, "feature/source", "conflict", &source_tip).unwrap();
    assert_eq!(shown.destination_oid, conflict_tip);
    assert_eq!(shown.commit_oid, source_tip);
    assert_eq!(shown.commit_summary, "Copy just this commit");
    assert_eq!(shown.files.len(), 1);
    let file = &shown.files[0];
    assert_eq!(file.path, "shared.txt");
    assert_eq!(file.base.as_deref().map(str::trim), Some("original"));
    assert_eq!(file.ours.as_deref().map(str::trim), Some("destination edit"));
    assert_eq!(file.theirs.as_deref().map(str::trim), Some("copy this change"));
    let merged = file.merged.as_deref().unwrap();
    assert!(merged.contains("<<<<<<< conflict"), "{merged}");
    assert!(merged.contains("||||||| base"), "{merged}");
    assert!(merged.contains(">>>>>>> "), "{merged}");
    assert!(!file.binary);
    assert_eq!(run_git(&dir, &["rev-parse", "conflict"]).unwrap(), conflict_tip);
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).unwrap(), source_tip);
    assert!(run_git(&dir, &["status", "--porcelain=v1"]).unwrap().is_empty());

    // Every refusal leaves the destination untouched (aborting is simply not finishing).
    let missing = super::duplicate_commit_resolved(&dir, "feature/source", "conflict", &source_tip, &conflict_tip, &[]);
    assert!(missing.unwrap_err().contains("still conflicted"));
    let marked = super::duplicate_commit_resolved(&dir, "feature/source", "conflict", &source_tip, &conflict_tip,
        &[resolve("shared.txt", Some(merged), None)]);
    assert!(marked.unwrap_err().contains("conflict markers"));
    let stranger = super::duplicate_commit_resolved(&dir, "feature/source", "conflict", &source_tip, &conflict_tip,
        &[resolve("shared.txt", Some("x\n"), None), resolve("other.txt", Some("x\n"), None)]);
    assert!(stranger.unwrap_err().contains("not one of the conflicted files"));
    let stale = super::duplicate_commit_resolved(&dir, "feature/source", "conflict", &source_tip, &destination_tip,
        &[resolve("shared.txt", Some("x\n"), None)]);
    assert!(stale.unwrap_err().contains("changed while you were resolving"));
    assert_eq!(run_git(&dir, &["rev-parse", "conflict"]).unwrap(), conflict_tip);
    assert!(run_git(&dir, &["status", "--porcelain=v1"]).unwrap().is_empty());

    // A hand-edited result lands on the inactive destination as one commit with the original author.
    let new_oid = super::duplicate_commit_resolved(&dir, "feature/source", "conflict", &source_tip, &conflict_tip,
        &[resolve("shared.txt", Some("destination edit\ncopy this change\n"), None)]).unwrap();
    assert_eq!(run_git(&dir, &["rev-parse", "conflict"]).unwrap(), new_oid);
    assert_eq!(run_git(&dir, &["rev-parse", "conflict^"]).unwrap(), conflict_tip);
    assert_eq!(run_git(&dir, &["show", "conflict:shared.txt"]).unwrap(), "destination edit\ncopy this change");
    assert_eq!(run_git(&dir, &["log", "-1", "--format=%an: %s", "conflict"]).unwrap(), "Original Author: Copy just this commit");
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).unwrap(), source_tip);
    assert!(run_git(&dir, &["status", "--porcelain=v1"]).unwrap().is_empty());
    assert_eq!(run_git(&dir, &["rev-parse", "feature/source"]).unwrap(), source_tip);

    // A checked-out destination where the destination deleted the file: keep the commit's version
    // and the working tree follows the branch.
    git_cli(&dir, &["checkout", "-b", "deleted", &destination_tip]);
    git_cli(&dir, &["rm", "-q", "shared.txt"]);
    git_cli(&dir, &["commit", "-m", "Delete shared"]);
    let deleted_tip = run_git(&dir, &["rev-parse", "deleted"]).unwrap();
    let shown = super::duplicate_commit_conflicts(&dir, "feature/source", "deleted", &source_tip).unwrap();
    assert_eq!(shown.files.len(), 1);
    assert_eq!((shown.files[0].ours.as_deref(), shown.files[0].merged.as_deref()), (None, None));
    assert_eq!(shown.files[0].theirs.as_deref().map(str::trim), Some("copy this change"));
    let kept_deleted = super::duplicate_commit_resolved(&dir, "feature/source", "deleted", &source_tip, &deleted_tip,
        &[resolve("shared.txt", None, Some("ours"))]);
    assert!(kept_deleted.unwrap_err().contains("no changes to apply"));
    super::duplicate_commit_resolved(&dir, "feature/source", "deleted", &source_tip, &deleted_tip,
        &[resolve("shared.txt", None, Some("theirs"))]).unwrap();
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD^"]).unwrap(), deleted_tip);
    assert_eq!(fs::read_to_string(dir.join("shared.txt")).unwrap().trim(), "copy this change");
    assert!(run_git(&dir, &["status", "--porcelain=v1"]).unwrap().is_empty());
    fs::remove_dir_all(&dir).unwrap();
}

fn edit_commit_fixture(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pigry-edit-{name}-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    git_cli(&dir, &["init", "-b", "main"]);
    git_cli(&dir, &["config", "user.name", "Test User"]);
    git_cli(&dir, &["config", "user.email", "test@pigry.dev"]);
    git_cli(&dir, &["config", "commit.gpgsign", "false"]);
    fs::write(dir.join("base.txt"), "base\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Base"]);
    dir
}

#[test]
fn edit_commit_amends_only_the_selected_commit_and_replays_later_work() {
    use crate::gitcli::run_git;
    let dir = edit_commit_fixture("replay");
    fs::write(dir.join("feature.txt"), "first version\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Original feature"]);
    let selected = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    fs::write(dir.join("later.txt"), "later work\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Later work"]);
    let tip = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    git_cli(&dir, &["branch", "unchanged-tip"]);
    git_cli(&dir, &["config", "rebase.updateRefs", "true"]);
    fs::write(dir.join("base.txt"), "uncommitted\n").unwrap();
    let dirty = super::start_commit_edit(&dir, "main", &tip, &selected).unwrap_err();
    assert!(dirty.contains("Commit or stash"));
    assert_eq!(fs::read_to_string(dir.join("base.txt")).unwrap(), "uncommitted\n");
    git_cli(&dir, &["restore", "base.txt"]);

    super::start_commit_edit(&dir, "main", &tip, &selected).unwrap();
    let repo = Repository::open(&dir).unwrap();
    let edit = crate::git_state::build_state(&dir).unwrap().commit_edit.unwrap();
    assert!(edit.editing);
    assert_eq!(edit.oid, selected);
    assert_eq!(edit.branch, "main");
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).unwrap(), selected);
    fs::write(dir.join("feature.txt"), "edited version\n").unwrap();
    let unstaged = super::continue_commit_edit(&dir).unwrap_err();
    assert!(unstaged.contains("unstaged changes"));
    git_cli(&dir, &["add", "feature.txt"]);
    super::continue_commit_edit(&dir).unwrap();
    assert!(super::commit_edit_state(&repo).is_none());
    assert_eq!(run_git(&dir, &["symbolic-ref", "--short", "HEAD"]).unwrap(), "main");
    assert_eq!(run_git(&dir, &["show", "HEAD^:feature.txt"]).unwrap(), "edited version");
    assert_eq!(run_git(&dir, &["log", "-2", "--format=%s"]).unwrap().lines().collect::<Vec<_>>(), ["Later work", "Original feature"]);
    assert_eq!(run_git(&dir, &["show", "HEAD:later.txt"]).unwrap(), "later work");
    assert_eq!(run_git(&dir, &["rev-parse", "unchanged-tip"]).unwrap(), tip);
    drop(repo);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn edit_commit_merge_preserves_parents_and_root_edit_can_be_aborted() {
    use crate::gitcli::run_git;
    let dir = edit_commit_fixture("merge-root");
    let root = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    git_cli(&dir, &["checkout", "-b", "side"]);
    fs::write(dir.join("side.txt"), "side\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Side"]);
    git_cli(&dir, &["checkout", "main"]);
    git_cli(&dir, &["merge", "--no-ff", "--no-edit", "side"]);
    let merge = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    let parents = run_git(&dir, &["show", "-s", "--format=%P", "HEAD"]).unwrap();
    super::start_commit_edit(&dir, "main", &merge, &merge).unwrap();
    let repo = Repository::open(&dir).unwrap();
    assert!(super::commit_edit_state(&repo).unwrap().editing);
    fs::write(dir.join("side.txt"), "edited merge file\n").unwrap();
    git_cli(&dir, &["add", "side.txt"]);
    super::continue_commit_edit(&dir).unwrap();
    assert_eq!(run_git(&dir, &["show", "-s", "--format=%P", "HEAD"]).unwrap(), parents);
    let amended_merge = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    assert_ne!(amended_merge, merge);

    super::start_commit_edit(&dir, "main", &amended_merge, &root).unwrap();
    assert!(super::commit_edit_state(&repo).unwrap().editing);
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).unwrap(), root);
    super::abort_rebase(&dir).unwrap();
    assert!(super::commit_edit_state(&repo).is_none());
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).unwrap(), amended_merge);
    drop(repo);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn edit_commit_replay_conflicts_can_be_staged_and_continued() {
    use crate::gitcli::run_git;
    let dir = edit_commit_fixture("conflict");
    let selected = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    fs::write(dir.join("base.txt"), "later change\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "Later change"]);
    let tip = run_git(&dir, &["rev-parse", "HEAD"]).unwrap();
    super::start_commit_edit(&dir, "main", &tip, &selected).unwrap();
    fs::write(dir.join("base.txt"), "edited root\n").unwrap();
    git_cli(&dir, &["add", "base.txt"]);
    super::continue_commit_edit(&dir).unwrap();
    let repo = Repository::open(&dir).unwrap();
    assert!(!super::commit_edit_state(&repo).unwrap().editing);
    assert!(super::has_conflicts(&dir).unwrap());
    assert!(super::continue_commit_edit(&dir).unwrap_err().contains("Resolve and stage"));
    fs::write(dir.join("base.txt"), "conflict resolved\n").unwrap();
    git_cli(&dir, &["add", "base.txt"]);
    super::continue_commit_edit(&dir).unwrap();
    assert_eq!(run_git(&dir, &["show", "HEAD^:base.txt"]).unwrap(), "edited root");
    assert_eq!(run_git(&dir, &["show", "HEAD:base.txt"]).unwrap(), "conflict resolved");
    assert!(super::commit_edit_state(&repo).is_none());
    drop(repo);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn revert_abort_restores_the_branch_after_a_conflicting_revert() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-revert-abort-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    drop(config);

    // Three commits rewriting the same line: reverting the middle one conflicts with the last.
    let commit_file = |content: &str, message: &str| {
        fs::write(dir.join("file.txt"), content).unwrap();
        let repo = Repository::open(&dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
        let parents: Vec<git2::Commit> = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).into_iter().collect();
        let refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &refs).unwrap().to_string()
    };
    commit_file("one\n", "first");
    let middle = commit_file("two\n", "second");
    let last = commit_file("three\n", "third");

    assert!(crate::ops::revert_commit(&dir, &middle).is_err(), "reverting the middle commit must conflict");
    crate::ops::revert_abort(&dir).unwrap();

    let repo = Repository::open(&dir).unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id().to_string(), last, "HEAD is unchanged");
    assert_eq!(fs::read_to_string(dir.join("file.txt")).unwrap().lines().collect::<Vec<_>>(), vec!["three"]);
    assert!(repo.state() == git2::RepositoryState::Clean, "no revert left in progress");

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn revert_commit_creates_undo_commit() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-revert-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    drop(config);

    // Create a commit with changes using git2.
    fs::write(dir.join("file.txt"), "original\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "add file", &tree, &[]).unwrap();

    // Get the HEAD oid.
    let repo = Repository::open(&dir).unwrap();
    let target_oid = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();

    // Revert it.
    crate::ops::revert_commit(&dir, &target_oid).unwrap();

    // The file should be gone (reverted).
    assert!(
        !dir.join("file.txt").exists(),
        "revert should remove the file"
    );
    // The commit message should mention revert.
    let repo = Repository::open(&dir).unwrap();
    let msg = repo.head().unwrap().peel_to_commit().unwrap().message().unwrap_or_default().to_string();
    assert!(msg.contains("Revert"), "revert commit message: {msg}");

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn cherry_pick_applies_commit_changes() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-cherry-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    drop(config);

    // Base commit on main.
    fs::write(dir.join("base.txt"), "base\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[]).unwrap();

    // Create feature branch with a commit.
    git_cli(&dir, &["checkout", "-b", "feature"]);
    fs::write(dir.join("feature.txt"), "feature content\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "add feature file", &tree, &[&parent]).unwrap();
    let feature_oid = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();

    // Back to the initial branch, cherry-pick the feature commit.
    let initial_branch = {
        let repo = Repository::open(&dir).unwrap();
        let head = repo.find_reference("refs/heads/main")
            .or_else(|_| repo.find_reference("refs/heads/master")).unwrap();
        head.shorthand().unwrap().to_string()
    };
    git_cli(&dir, &["checkout", &initial_branch]);
    crate::ops::cherry_pick(&dir, &feature_oid).unwrap();

    // The changes should be staged (but not committed — --no-commit).
    let index_content = {
        let repo = Repository::open(&dir).unwrap();
        let index = repo.index().unwrap();
        let entry = index.get_path(std::path::Path::new("feature.txt"), 0).unwrap();
        let blob = repo
            .find_object(entry.id, Some(git2::ObjectType::Blob))
            .unwrap()
            .peel_to_blob()
            .unwrap();
        String::from_utf8_lossy(blob.content()).to_string()
    };
    assert_eq!(index_content, "feature content\n");

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn merge_branch_fast_forward() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-merge-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    drop(config);

    fs::write(dir.join("a.txt"), "1\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[]).unwrap();
    let base_branch = repo.head().unwrap().shorthand().unwrap().to_string();

    git_cli(&dir, &["checkout", "-b", "feature"]);
    fs::write(dir.join("b.txt"), "feature\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "feature work", &tree, &[&head]).unwrap();
    let feature_tip = repo.head().unwrap().peel_to_commit().unwrap().id();

    // Back to base branch, then merge feature (fast-forward).
    git_cli(&dir, &["checkout", &base_branch]);
    crate::ops::merge_branch(&dir, "feature", "ff").unwrap();

    // Fast-forward merge: feature file should exist on the base branch now.
    assert!(dir.join("b.txt").exists());
    let repo = Repository::open(&dir).unwrap();
    let branch = repo.find_branch(&base_branch, git2::BranchType::Local).unwrap();
    let oid = branch.get().target().unwrap();
    let commit = repo.find_commit(oid).unwrap();
    assert_eq!(commit.summary().unwrap_or_default(), "feature work");

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn clone_repo_copies_repository() {
    let base = std::env::temp_dir().join(format!("pigry-clone-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let origin = base.join("origin.git");
    let work = base.join("work");

    Repository::init_bare(&origin).unwrap();
    Repository::init(&work).unwrap();
    let repo = Repository::open(&work).unwrap();
    repo.remote("origin", origin.to_str().unwrap()).unwrap();
    fs::write(work.join("data.txt"), "hello\n").unwrap();
    let repo = Repository::open(&work).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();
    crate::ops::merge_branch(&work, "master", "ff").unwrap(); // no-op, just exercises
    git_cli(&work, &["push", "--set-upstream", "origin", "master"]);

    let cloned = base.join("cloned");
    crate::ops::clone_repo(origin.to_str().unwrap(), cloned.to_str().unwrap()).unwrap();
    assert!(cloned.join(".git").exists());
    assert_eq!(
        fs::read_to_string(cloned.join("data.txt")).unwrap().replace('\r', ""),
        "hello\n"
    );

    let _ = fs::remove_dir_all(&base);
}

// --- interactive rebase ---

use crate::ops::{abort_rebase, interactive_rebase, rebase_in_progress, RebaseStep};

/// Scratch repo with 3 commits on a feature branch; returns (dir, [oid1..oid3]).
fn rebase_scratch(name: &str) -> (PathBuf, Vec<String>) {
    let dir = std::env::temp_dir().join(format!("pigry-rebase-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    drop(config);

    let oids: Vec<String> = ["one", "two", "three"]
        .iter()
        .map(|msg| {
            fs::write(dir.join(format!("{msg}.txt")), format!("{msg} content\n")).unwrap();
            let mut repo = Repository::open(&dir).unwrap();
            let mut index = repo.index().unwrap();
            index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
            index.write().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
            let parent = repo.head().ok().map(|h| h.peel_to_commit().unwrap());
            let parents: Vec<&git2::Commit> = parent.as_ref().map(|c| vec![c]).unwrap_or_default();
            let oid = repo
                .commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
                .unwrap();
            oid.to_string()
        })
        .collect();
    (dir, oids)
}

fn head_oids(dir: &PathBuf, count: usize) -> Vec<String> {
    let out = std::process::Command::new("git")
        .arg("-C").arg(dir)
        .args(["rev-list", "--reverse", &format!("-{}", count), "HEAD"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn interactive_rebase_drops_middle_commit() {
    let (dir, oids) = rebase_scratch("drop");
    // Base is oids[0]; the plan covers only the two commits above it.
    let plan = vec![
        RebaseStep { oid: oids[2].clone(), action: "pick".into() },
        RebaseStep { oid: oids[1].clone(), action: "drop".into() },
    ];
    interactive_rebase(&dir, &oids[0], &plan).unwrap();

    let after = head_oids(&dir, 3);
    assert_eq!(after.len(), 2, "one commit dropped");
    assert_eq!(after[0], oids[0], "base commit unchanged (not rewritten)");
    // Rebase rewrites oid2 (new parent), so assert the subject instead.
    let tip = std::process::Command::new("git")
        .arg("-C").arg(&dir)
        .args(["log", "--format=%s", "-1", "HEAD"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&tip.stdout).trim(), "three");
    assert!(!dir.join("two.txt").exists(), "dropped commit's file is gone");
    assert!(dir.join("one.txt").exists() && dir.join("three.txt").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn interactive_rebase_squashes_two_into_one() {
    let (dir, oids) = rebase_scratch("squash");
    // Display order (newest first): oid2 squashes into oid1, oid0 is the base.
    let plan = vec![
        RebaseStep { oid: oids[2].clone(), action: "squash".into() },
        RebaseStep { oid: oids[1].clone(), action: "pick".into() },
    ];
    interactive_rebase(&dir, &oids[0], &plan).unwrap();

    let after = head_oids(&dir, 3);
    assert_eq!(after.len(), 2, "three commits squashed into two");
    assert_eq!(after[0], oids[0], "first commit untouched");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn interactive_rebase_reorders_commits() {
    let (dir, oids) = rebase_scratch("reorder");
    // Swapping the two commits above base oids[0]: "two" ends up newest.
    let plan = vec![
        RebaseStep { oid: oids[1].clone(), action: "pick".into() },
        RebaseStep { oid: oids[2].clone(), action: "pick".into() },
    ];
    interactive_rebase(&dir, &oids[0], &plan).unwrap();

    // All three still exist; the tip's parent is now the reordered chain.
    let out = std::process::Command::new("git")
        .arg("-C").arg(&dir)
        .args(["log", "--format=%s", "HEAD~1..HEAD"])
        .output()
        .unwrap();
    let tip_subject = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(tip_subject, "two", "oid[1] becomes the new tip after reorder");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn interactive_rebase_validates_plan() {
    let (dir, oids) = rebase_scratch("validate");
    let base = head_oids(&dir, 3)[0].clone();

    // Incomplete plan is rejected.
    let plan = vec![RebaseStep { oid: oids[2].clone(), action: "pick".into() }];
    assert!(interactive_rebase(&dir, &base, &plan)
        .unwrap_err()
        .contains("exactly"));

    // Unknown action rejected.
    let plan = vec![
        RebaseStep { oid: oids[2].clone(), action: "fixup".into() },
        RebaseStep { oid: oids[1].clone(), action: "pick".into() },
        RebaseStep { oid: oids[0].clone(), action: "pick".into() },
    ];
    assert!(interactive_rebase(&dir, &base, &plan).is_err());

    // Squashing the OLDEST selected commit is rejected (it would fold into base).
    let plan = vec![
        RebaseStep { oid: oids[2].clone(), action: "pick".into() },
        RebaseStep { oid: oids[1].clone(), action: "squash".into() },
    ];
    assert!(interactive_rebase(&dir, &base, &plan)
        .unwrap_err()
        .contains("oldest selected commit cannot be squashed"));

    // Empty plan rejected.
    assert!(interactive_rebase(&dir, &base, &[]).is_err());
    assert!(!rebase_in_progress(&dir), "validation failures leave no rebase behind");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn rebase_conflict_then_abort_restores_original_tip() {
    let dir = std::env::temp_dir().join(format!("pigry-rebase-abort-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    drop(config);

    // Two commits touching the SAME line of the same file: reordering them
    // forces a merge conflict mid-rebase.
    fs::write(dir.join("shared.txt"), "one\n").unwrap();
    let mut repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    let base_oid = repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[]).unwrap();

    let make_commit = |msg: &str, content: &str| {
        fs::write(dir.join("shared.txt"), content).unwrap();
        let mut repo = Repository::open(&dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &[&parent]).unwrap()
    };
    let c1 = make_commit("edit1", "from edit1\n");
    let c2 = make_commit("edit2", "from edit2\n");
    drop(sig);

    assert!(!rebase_in_progress(&dir));
    // Swap the two conflicting commits (todo becomes c2 then c1).
    let plan = vec![
        RebaseStep { oid: c1.to_string(), action: "pick".into() },
        RebaseStep { oid: c2.to_string(), action: "pick".into() },
    ];
    let result = interactive_rebase(&dir, &base_oid.to_string(), &plan);
    assert!(result.is_err(), "conflicting reorder must fail");
    assert!(rebase_in_progress(&dir), "failed rebase leaves the repo mid-rebase");

    abort_rebase(&dir).unwrap();
    assert!(!rebase_in_progress(&dir), "abort restores the pre-rebase state");
    // Original tip intact: HEAD == c2.
    let repo = Repository::open(&dir).unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), c2);
    assert_eq!(
        fs::read_to_string(dir.join("shared.txt")).unwrap().replace('\r', ""),
        "from edit2\n"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn merge_branch_strategies_conflicts_and_abort() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-merge2-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    // Mixed git-CLI checkouts and git2 commits need stable line endings.
    config.set_bool("core.autocrlf", false).unwrap();
    drop(config);

    fs::write(dir.join("shared.txt"), "line1\nline2\nline3\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[]).unwrap();
    let main_branch = repo.head().unwrap().shorthand().unwrap().to_string();

    git_cli(&dir, &["checkout", "-b", "feature"]);
    fs::write(dir.join("shared.txt"), "feature-line1\nline2\nline3\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "feature edit", &tree, &[&head]).unwrap();
    git_cli(&dir, &["checkout", &main_branch]);
    fs::write(dir.join("shared.txt"), "line1\nline2\nmain-line3\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "main edit", &tree, &[&head]).unwrap();

    // 1. ff is not possible when branches diverged.
    assert!(crate::ops::merge_branch(&dir, "feature", "ff").is_err());

    // 2. no-ff merges with a merge commit.
    crate::ops::merge_branch(&dir, "feature", "no-ff").unwrap();
    let merged = fs::read_to_string(dir.join("shared.txt")).unwrap().replace("\r", "");
    assert!(merged.contains("feature-line1"), "no-ff carries the branch edit");
    let status = crate::ops::merge_status(&dir).unwrap();
    assert!(!status.in_progress, "no-ff finished without conflicts");

    // 3. diverge again -> conflict -> normalize + abort.
    git_cli(&dir, &["checkout", "feature"]);
    fs::write(dir.join("shared.txt"), "conflict-feature\nline2\nmain-line3\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "feature rewrite", &tree, &[&head]).unwrap();
    git_cli(&dir, &["checkout", &main_branch]);
    fs::write(dir.join("shared.txt"), "conflict-main\nline2\nmain-line3\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "conflict main", &tree, &[&head]).unwrap();

    let result = crate::ops::merge_branch(&dir, "feature", "no-ff");
    let err = match result { Err(e) => e, Ok(_) => panic!("expected conflict") };
    assert!(err.starts_with("CONFLICT"), "conflict error normalized: {err}");
    let status = crate::ops::merge_status(&dir).unwrap();
    assert!(status.in_progress);
    assert!(status.conflicted.iter().any(|f| f.contains("shared.txt")), "conflicted file listed: {:?}", status.conflicted);
    crate::ops::merge_abort(&dir).unwrap();
    let status = crate::ops::merge_status(&dir).unwrap();
    assert!(!status.in_progress, "abort cleared the merge");
    let content = fs::read_to_string(dir.join("shared.txt")).unwrap().replace("\r", "");
    assert!(content.contains("conflict-main"), "abort restored the working file");

    // 4. squash: a branch off main with a clean tail commit stages
    //    the addition without creating a merge commit.
    git_cli(&dir, &["checkout", "-b", "tail-branch"]);
    fs::write(dir.join("shared.txt"), "conflict-main\nline2\nmain-line3\nfeature-tail\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "feature tail", &tree, &[&head]).unwrap();
    git_cli(&dir, &["checkout", &main_branch]);
    crate::ops::merge_branch(&dir, "tail-branch", "squash").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.summary().unwrap_or_default(), "conflict main", "squash does not auto-commit");
    let content = fs::read_to_string(dir.join("shared.txt")).unwrap().replace("\r", "");
    assert!(content.contains("feature-tail"), "squash staged the tail");

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn merge_preview_details_commits_and_files() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-preview-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    config.set_bool("core.autocrlf", false).unwrap();
    drop(config);

    let commit_files = |dir: &PathBuf, message: &str, edits: &[(&str, &str)]| {
        let repo = Repository::open(dir).unwrap();
        for (path, content) in edits {
            fs::write(dir.join(path), content).unwrap();
        }
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
        let parent = repo.head().ok().map(|head| head.peel_to_commit().unwrap());
        let parents: Vec<&git2::Commit> = parent.as_ref().map(|c| vec![c]).unwrap_or_default();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap();
    };

    fs::write(dir.join("a.txt"), "one\n").unwrap();
    commit_files(&dir, "base", &[]);
    git_cli(&dir, &["checkout", "-b", "feature"]);
    commit_files(&dir, "edit a.txt", &[("a.txt", "one\ntwo\n")]);
    commit_files(
        &dir,
        "add b.txt\n\nbody line",
        &[("b.txt", "b1\nb2\n")],
    );
    let default_branch = Repository::open(&dir)
        .unwrap()
        .find_branch("master", git2::BranchType::Local)
        .map(|_| "master")
        .unwrap_or("main")
        .to_string();
    git_cli(&dir, &["checkout", &default_branch]);

    let preview = crate::ops::merge_preview(&dir, "feature").unwrap();
    assert!(!preview.up_to_date, "source is ahead");
    assert_eq!(preview.commits.len(), 2, "two source commits, oldest first");

    let first = &preview.commits[0];
    assert_eq!(first.summary, "edit a.txt");
    assert_eq!(first.files.len(), 1);
    assert_eq!(first.files[0].path, "a.txt");
    assert_eq!((first.files[0].additions, first.files[0].deletions), (1, 0));

    let second = &preview.commits[1];
    assert_eq!(second.summary, "add b.txt");
    assert!(second.body.contains("body line"), "full message body present");
    assert_eq!(second.files.len(), 1);
    assert_eq!(second.files[0].path, "b.txt");
    assert_eq!(second.files[0].status, "A");
    assert_eq!((second.files[0].additions, second.files[0].deletions), (2, 0));

    // Whole-range file list attributes each file to its source commit.
    let a_file = preview.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(a_file.commits.len(), 1);
    assert_eq!(a_file.commits[0].short_oid, first.short_oid);
    assert_eq!(a_file.commits[0].summary, "edit a.txt");
    let b_file = preview.files.iter().find(|f| f.path == "b.txt").unwrap();
    assert_eq!(b_file.commits[0].short_oid, second.short_oid);

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn sync_previews_list_commits_with_files_in_both_directions() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-pushprev-{}", std::process::id()));
    let remote_dir = std::env::temp_dir().join(format!("pigry-ops-pushprev-remote-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&remote_dir);
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&remote_dir).unwrap();
    Repository::init(&dir).unwrap();
    Repository::init_bare(&remote_dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    config.set_bool("core.autocrlf", false).unwrap();
    drop(config);
    let repo = Repository::open(&dir).unwrap();
    repo.set_head("refs/heads/main").unwrap();
    git_cli(&dir, &["remote", "add", "origin", remote_dir.to_string_lossy().as_ref()]);

    let commit_files = |dir: &PathBuf, message: &str, edits: &[(&str, &str)]| {
        let repo = Repository::open(dir).unwrap();
        for (path, content) in edits {
            fs::write(dir.join(path), content).unwrap();
        }
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
        let parent = repo.head().ok().map(|head| head.peel_to_commit().unwrap());
        let parents: Vec<&git2::Commit> = parent.as_ref().map(|c| vec![c]).unwrap_or_default();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap();
    };

    // Base commit pushed to the bare remote.
    commit_files(&dir, "base", &[("a.txt", "one\n")]);
    git_cli(&dir, &["push", "-u", "origin", "main"]);

    // No upstream yet on a fresh local branch.
    git_cli(&dir, &["checkout", "-b", "local-only"]);
    let preview = crate::ops::push_preview(&dir).unwrap();
    assert_eq!(preview.upstream, None, "branch without upstream");
    assert_eq!(preview.ahead, 0);
    assert!(crate::ops::pull_preview(&dir).unwrap().is_empty());
    git_cli(&dir, &["checkout", "main"]);

    // One local commit ahead — the preview lists it with its files.
    commit_files(&dir, "add b.txt\n\nbody detail", &[("b.txt", "b1\nb2\n")]);
    let preview = crate::ops::push_preview(&dir).unwrap();
    assert_eq!(preview.branch, "main");
    assert_eq!(preview.upstream.as_deref(), Some("origin/main"));
    assert_eq!(preview.ahead, 1);
    let commit = &preview.commits[0];
    assert_eq!(commit.summary, "add b.txt");
    assert!(commit.body.contains("body detail"));
    assert_eq!(commit.files.len(), 1);
    assert_eq!(commit.files[0].path, "b.txt");
    assert_eq!(commit.files[0].status, "A");
    assert_eq!((commit.files[0].additions, commit.files[0].deletions), (2, 0));
    let repo = Repository::open(&dir).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(
        commit.parent_oid.as_deref(),
        Some(head.parent(0).unwrap().id().to_string().as_str()),
        "parent oid is the compare base"
    );

    // After pushing, nothing is ahead.
    git_cli(&dir, &["push", "origin", "main"]);
    let preview = crate::ops::push_preview(&dir).unwrap();
    assert_eq!(preview.ahead, 0, "all pushed");
    assert!(crate::ops::pull_preview(&dir).unwrap().is_empty());

    git_cli(&dir, &["checkout", "local-only"]);
    git_cli(&dir, &["branch", "--set-upstream-to=origin/main"]);
    commit_files(&dir, "local edit", &[("a.txt", "local\n")]);
    let incoming = crate::ops::pull_preview(&dir).unwrap();
    assert_eq!(incoming.len(), 1, "exclude local-only commits on divergence");
    assert_eq!(incoming[0].oid, commit.oid);
    assert_eq!(incoming[0].parent_oid, commit.parent_oid);
    assert_eq!(incoming[0].files[0].path, "b.txt");
    let content = crate::git_state::read_file_at_commit(&dir, "b.txt", &incoming[0].oid).unwrap();
    assert_eq!(content.content, "b1\nb2\n");

    fs::remove_dir_all(&dir).unwrap();
    fs::remove_dir_all(&remote_dir).unwrap();
}

#[test]
fn stash_preview_lists_entry_files() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-stashprev-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    config.set_bool("core.autocrlf", false).unwrap();
    drop(config);

    fs::write(dir.join("a.txt"), "one\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[]).unwrap();

    // Stash one change on top.
    fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
    fs::write(dir.join("b.txt"), "b1\n").unwrap();
    crate::git_state::stash(&dir, Some("wip experiment")).unwrap();

    let preview = crate::ops::stash_preview(&dir, 0).unwrap();
    assert!(preview.message.contains("wip experiment"), "git prefixes 'On <branch>: '");
    assert_eq!(preview.files.len(), 2, "modified + added file");
    let a = preview.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(a.status, "M");
    assert_eq!((a.additions, a.deletions), (1, 0));
    let b = preview.files.iter().find(|f| f.path == "b.txt").unwrap();
    assert_eq!(b.status, "A");

    // Out-of-range previews report a clear error.
    let missing = crate::ops::stash_preview(&dir, 5);
    assert!(missing.is_err());
    assert!(missing.unwrap_err().contains("does not exist"));

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn cherry_pick_conflict_then_abort_restores_branch() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-cherryabort-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    config.set_bool("core.autocrlf", false).unwrap();
    drop(config);

    let commit_files = |dir: &PathBuf, message: &str, content: &str| {
        fs::write(dir.join("a.txt"), content).unwrap();
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
        let parent = repo.head().ok().map(|head| head.peel_to_commit().unwrap());
        let parents: Vec<&git2::Commit> = parent.as_ref().map(|c| vec![c]).unwrap_or_default();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap();
    };

    commit_files(&dir, "base", "one\n");
    let base_branch = Repository::open(&dir)
        .unwrap()
        .head()
        .unwrap()
        .shorthand()
        .unwrap_or("master")
        .to_string();
    git_cli(&dir, &["checkout", "-b", "feature"]);
    commit_files(&dir, "feature edit", "one\nfeature\n");
    let feature_tip = Repository::open(&dir)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id()
        .to_string();
    git_cli(&dir, &["checkout", &base_branch]);
    commit_files(&dir, "main edit", "one\nmain\n");

    // Picking the feature commit onto main conflicts on a.txt.
    let result = crate::ops::cherry_pick(&dir, &feature_tip);
    let error = result.unwrap_err();
    assert!(
        error.contains("CONFLICT") || error.contains("could not apply"),
        "conflict reported: {error}"
    );

    // Abort restores the pre-pick state.
    crate::ops::cherry_pick_abort(&dir).unwrap();
    let content = fs::read_to_string(dir.join("a.txt")).unwrap().replace('\r', "");
    assert_eq!(content, "one\nmain\n", "branch content restored");
    let repo = Repository::open(&dir).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.summary().unwrap_or_default(), "main edit");

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn branch_commits_list_one_ref_only() {
    let dir = std::env::temp_dir().join(format!("pigry-ops-branchcommits-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@pigry.dev").unwrap();
    config.set_bool("core.autocrlf", false).unwrap();
    drop(config);

    let commit_files = |dir: &PathBuf, message: &str, content: &str| {
        fs::write(dir.join("a.txt"), content).unwrap();
        let repo = Repository::open(dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test User", "test@pigry.dev").unwrap();
        let parent = repo.head().ok().map(|head| head.peel_to_commit().unwrap());
        let parents: Vec<&git2::Commit> = parent.as_ref().map(|c| vec![c]).unwrap_or_default();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap();
    };

    commit_files(&dir, "base", "one\n");
    let base_branch = Repository::open(&dir)
        .unwrap()
        .head()
        .unwrap()
        .shorthand()
        .unwrap_or("master")
        .to_string();
    git_cli(&dir, &["checkout", "-b", "feature"]);
    commit_files(&dir, "feature work", "one\nfeature\n");
    git_cli(&dir, &["checkout", &base_branch]);
    commit_files(&dir, "main work", "one\nmain\n");

    // The feature ref lists the feature tip first and never the main-only
    // commit; the base ref lists both.
    let feature = crate::git_state::build_branch_commits(&dir, "feature").unwrap();
    assert_eq!(feature.total, 2);
    assert_eq!(feature.commits[0].summary, "feature work");
    assert!(!feature.commits.iter().any(|row| row.summary == "main work"));

    let base = crate::git_state::build_branch_commits(&dir, &base_branch).unwrap();
    assert_eq!(base.total, 2);
    assert_eq!(base.commits[0].summary, "main work");

    // Unknown ref reports a clear error.
    let missing = crate::git_state::build_branch_commits(&dir, "nope");
    assert!(missing.unwrap_err().contains("unknown ref"));

    fs::remove_dir_all(&dir).unwrap();
}

fn conflict_fixture(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pigry-conflicts-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    git_cli(&dir, &["init", "-b", "main"]);
    git_cli(&dir, &["config", "user.name", "Test User"]);
    git_cli(&dir, &["config", "user.email", "test@pigry.dev"]);
    git_cli(&dir, &["config", "core.autocrlf", "false"]);
    fs::write(dir.join("app.txt"), "title = Pigry\ncolor = blue\nsize = 10\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "base"]);
    git_cli(&dir, &["checkout", "-b", "feature"]);
    fs::write(dir.join("app.txt"), "title = Pigry\ncolor = green\nsize = 10\n").unwrap();
    git_cli(&dir, &["commit", "-am", "Make it green"]);
    git_cli(&dir, &["checkout", "main"]);
    fs::write(dir.join("app.txt"), "title = Pigry\ncolor = red\nsize = 10\n").unwrap();
    git_cli(&dir, &["commit", "-am", "Make it red"]);
    dir
}

#[test]
fn checkout_refs_lists_local_remote_and_tags_and_checks_out_a_tag_detached() {
    use crate::gitcli::run_git;
    let dir = conflict_fixture("refs");
    git_cli(&dir, &["tag", "v1.0", "main~1"]);
    git_cli(&dir, &["tag", "-a", "v2.0", "-m", "Release two", "main"]);
    git_cli(&dir, &["update-ref", "refs/remotes/origin/feature", "feature"]);
    git_cli(&dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature"]);
    let main_short = run_git(&dir, &["rev-parse", "--short", "main"]).unwrap();

    let refs = crate::ops::list_checkout_refs(&dir).unwrap();
    let find = |kind: &str, name: &str| refs.iter().find(|r| r.kind == kind && r.name == name).cloned();
    let main = find("local", "main").expect("main");
    assert!(main.is_head);
    assert_eq!(main.short_oid, main_short);
    assert_eq!(main.subject, "Make it red");
    assert!(!find("local", "feature").unwrap().is_head);
    let remote = find("remote", "origin/feature").expect("remote branch");
    assert_eq!((remote.remote.as_deref(), remote.branch.as_deref()), (Some("origin"), Some("feature")));
    assert!(refs.iter().all(|r| !r.name.ends_with("/HEAD")), "origin/HEAD is skipped");
    // Annotated tags are peeled to their commit.
    let v2 = find("tag", "v2.0").expect("annotated tag");
    assert_eq!((v2.short_oid.as_str(), v2.subject.as_str()), (main_short.as_str(), "Make it red"));
    assert_eq!(find("tag", "v1.0").unwrap().subject, "base");

    assert!(crate::ops::checkout_tag(&dir, "nope").unwrap_err().contains("not found"));
    assert!(crate::ops::checkout_tag(&dir, "--orphan").is_err());
    fs::write(dir.join("app.txt"), "dirty\n").unwrap();
    assert!(crate::ops::checkout_tag(&dir, "v1.0").unwrap_err().contains("commit or stash"));
    git_cli(&dir, &["checkout", "--", "app.txt"]);
    crate::ops::checkout_tag(&dir, "v1.0").unwrap();
    assert_eq!(run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), "HEAD");
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).unwrap(), run_git(&dir, &["rev-parse", "v1.0^{commit}"]).unwrap());
    assert!(crate::ops::list_checkout_refs(&dir).unwrap().iter().all(|r| !r.is_head));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn conflict_resolve_file_writes_takes_a_side_or_deletes_then_the_merge_commits() {
    use crate::gitcli::run_git;
    let dir = conflict_fixture("resolve-file");
    // From a shared commit with notes.txt: "incoming" makes the app green and grows the notes,
    // main makes the app yellow and deletes the notes.
    fs::write(dir.join("notes.txt"), "notes\n").unwrap();
    git_cli(&dir, &["add", "notes.txt"]);
    git_cli(&dir, &["commit", "-m", "Add notes"]);
    git_cli(&dir, &["checkout", "-b", "incoming"]);
    fs::write(dir.join("app.txt"), "title = Pigry\ncolor = green\nsize = 10\n").unwrap();
    fs::write(dir.join("notes.txt"), "notes\nmore from incoming\n").unwrap();
    git_cli(&dir, &["commit", "-am", "Green and more notes"]);
    git_cli(&dir, &["checkout", "main"]);
    fs::write(dir.join("app.txt"), "title = Pigry\ncolor = yellow\nsize = 10\n").unwrap();
    git_cli(&dir, &["rm", "-q", "notes.txt"]);
    git_cli(&dir, &["commit", "-am", "Yellow, drop notes"]);
    let main_tip = run_git(&dir, &["rev-parse", "main"]).unwrap();

    let _ = crate::ops::merge_branch(&dir, "incoming", "no-ff");
    let state = crate::ops::conflict_state(&dir).unwrap();
    assert_eq!(state.conflicted, vec!["app.txt".to_string(), "notes.txt".to_string()]);

    // Refusals change nothing.
    assert!(crate::ops::conflict_resolve_file(&dir, "../outside.txt", None, Some("x")).is_err());
    assert!(crate::ops::conflict_resolve_file(&dir, "title.txt", None, Some("x")).unwrap_err().contains("not conflicted"));
    let marked = crate::ops::conflict_resolve_file(&dir, "app.txt", None, Some("<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\n"));
    assert!(marked.unwrap_err().contains("conflict markers"));
    assert!(crate::ops::conflict_resolve_file(&dir, "app.txt", Some("both"), None).is_err());
    assert_eq!(crate::ops::conflict_state(&dir).unwrap().conflicted.len(), 2);

    // Hand-written text for one file, "keep it deleted" (ours) for the other.
    crate::ops::conflict_resolve_file(&dir, "app.txt", None, Some("title = Pigry\ncolor = purple\nsize = 10\n")).unwrap();
    assert_eq!(crate::ops::conflict_state(&dir).unwrap().conflicted, vec!["notes.txt".to_string()]);
    crate::ops::conflict_resolve_file(&dir, "notes.txt", Some("ours"), None).unwrap();
    assert!(crate::ops::conflict_state(&dir).unwrap().conflicted.is_empty());
    assert!(!dir.join("notes.txt").exists());
    crate::ops::conflict_continue(&dir).unwrap();
    assert_eq!(run_git(&dir, &["rev-parse", "HEAD^1"]).unwrap(), main_tip);
    assert_eq!(run_git(&dir, &["show", "HEAD:app.txt"]).unwrap(), "title = Pigry\ncolor = purple\nsize = 10");
    assert!(run_git(&dir, &["show", "HEAD:notes.txt"]).is_err());
    assert!(run_git(&dir, &["status", "--porcelain=v1"]).unwrap().is_empty());

    // Taking the incoming side whole restores the file the current branch deleted.
    git_cli(&dir, &["reset", "-q", "--hard", &main_tip]);
    let _ = crate::ops::merge_branch(&dir, "incoming", "no-ff");
    crate::ops::conflict_resolve_file(&dir, "notes.txt", Some("theirs"), None).unwrap();
    crate::ops::conflict_resolve_file(&dir, "app.txt", Some("theirs"), None).unwrap();
    crate::ops::conflict_continue(&dir).unwrap();
    assert_eq!(fs::read_to_string(dir.join("notes.txt")).unwrap(), "notes\nmore from incoming\n");
    assert!(fs::read_to_string(dir.join("app.txt")).unwrap().contains("color = green"));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn conflict_state_versions_continue_and_abort_for_a_merge() {
    let dir = conflict_fixture("merge");
    let clean = crate::ops::conflict_state(&dir).unwrap();
    assert_eq!(clean.operation, None);
    assert!(clean.conflicted.is_empty());
    assert!(crate::ops::conflict_continue(&dir).is_err(), "nothing to continue");
    assert!(crate::ops::conflict_abort(&dir).is_err(), "nothing to abort");

    assert!(crate::ops::merge_branch(&dir, "feature", "no-ff").is_err() || crate::ops::merge_status(&dir).unwrap().in_progress);
    let state = crate::ops::conflict_state(&dir).unwrap();
    assert_eq!(state.operation.as_deref(), Some("merge"));
    assert_eq!(state.branch.as_deref(), Some("main"));
    assert_eq!(state.conflicted, vec!["app.txt".to_string()]);
    assert!(state.incoming_label.contains("feature"), "{}", state.incoming_label);
    assert!(state.incoming_commit.as_deref().unwrap_or("").contains("Make it green"));

    let versions = crate::ops::conflict_versions(&dir, "app.txt").unwrap();
    assert!(versions.base.as_deref().unwrap().contains("color = blue"));
    assert!(versions.current.as_deref().unwrap().contains("color = red"));
    assert!(versions.incoming.as_deref().unwrap().contains("color = green"));
    assert!(!versions.binary);
    assert!(crate::ops::conflict_versions(&dir, "nope.txt").is_err());

    // still conflicted: continue refuses and says why
    let refused = crate::ops::conflict_continue(&dir).unwrap_err();
    assert!(refused.contains("app.txt"), "{refused}");

    // abort puts main back
    crate::ops::conflict_abort(&dir).unwrap();
    assert_eq!(crate::ops::conflict_state(&dir).unwrap().operation, None);
    assert!(fs::read_to_string(dir.join("app.txt")).unwrap().contains("color = red"));

    // conflict again, resolve, stage, continue -> merge commit
    let _ = crate::ops::merge_branch(&dir, "feature", "no-ff");
    fs::write(dir.join("app.txt"), "title = Pigry\ncolor = purple\nsize = 10\n").unwrap();
    git_cli(&dir, &["add", "app.txt"]);
    crate::ops::conflict_continue(&dir).unwrap();
    assert_eq!(crate::ops::conflict_state(&dir).unwrap().operation, None);
    let repo = Repository::open(&dir).unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 2, "a merge commit was made");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn conflict_state_names_a_cherry_pick_and_finishes_it() {
    let dir = conflict_fixture("pick");
    let feature = Repository::open(&dir).unwrap().revparse_single("feature").unwrap().id().to_string();
    // Pigry's own pick uses --no-commit: no CHERRY_PICK_HEAD, so it reads as plain conflicts to commit.
    let _ = crate::ops::cherry_pick(&dir, &feature);
    let plain = crate::ops::conflict_state(&dir).unwrap();
    assert_eq!(plain.operation, None);
    assert_eq!(plain.conflicted, vec!["app.txt".to_string()]);
    assert!(crate::ops::conflict_continue(&dir).unwrap_err().contains("app.txt"));
    git_cli(&dir, &["reset", "--hard", "HEAD"]);
    // A pick started from a terminal keeps sequencer state.
    let out = std::process::Command::new("git").arg("-C").arg(&dir).args(["cherry-pick", &feature]).output().unwrap();
    assert!(!out.status.success(), "the pick conflicts");
    let state = crate::ops::conflict_state(&dir).unwrap();
    assert_eq!(state.operation.as_deref(), Some("cherry-pick"));
    assert!(state.incoming_commit.as_deref().unwrap_or("").contains("Make it green"));
    fs::write(dir.join("app.txt"), "title = Pigry\ncolor = green\nsize = 10\n").unwrap();
    git_cli(&dir, &["add", "app.txt"]);
    crate::ops::conflict_continue(&dir).unwrap();
    assert_eq!(crate::ops::conflict_state(&dir).unwrap().operation, None);
    let repo = Repository::open(&dir).unwrap();
    assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().summary(), Some("Make it green"));
    fs::remove_dir_all(&dir).ok();
}
