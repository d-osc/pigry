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
fn revert_commit_creates_undo_commit() {
    let dir = std::env::temp_dir().join(format!("orbit-ops-revert-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
    drop(config);

    // Create a commit with changes.
    fs::write(dir.join("file.txt"), "original\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "add file"]);

    // Get the HEAD oid.
    let repo = Repository::open(&dir).unwrap();
    let target_oid = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
    drop(repo);

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
    let dir = std::env::temp_dir().join(format!("orbit-ops-cherry-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
    drop(config);

    // Base commit on main.
    fs::write(dir.join("base.txt"), "base\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "base"]);

    // Create feature branch with a commit.
    git_cli(&dir, &["checkout", "-b", "feature"]);
    fs::write(dir.join("feature.txt"), "feature content\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "add feature file"]);
    let repo = Repository::open(&dir).unwrap();
    let feature_oid = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
    drop(repo);

    // Back to main, cherry-pick the feature commit.
    git_cli(&dir, &["checkout", "master"]);
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
    let dir = std::env::temp_dir().join(format!("orbit-ops-merge-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
    drop(config);

    fs::write(dir.join("a.txt"), "1\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "base"]);

    git_cli(&dir, &["checkout", "-b", "feature"]);
    fs::write(dir.join("b.txt"), "feature\n").unwrap();
    git_cli(&dir, &["add", "."]);
    git_cli(&dir, &["commit", "-m", "feature work"]);

    git_cli(&dir, &["checkout", "master"]);
    crate::ops::merge_branch(&dir, "feature").unwrap();

    // Fast-forward merge: feature file should exist on master now.
    assert!(dir.join("b.txt").exists());
    let repo = Repository::open(&dir).unwrap();
    let branch = repo.find_branch("master", git2::BranchType::Local).unwrap();
    let oid = branch.get().target().unwrap();
    let commit = repo.find_commit(oid).unwrap();
    assert_eq!(commit.summary().unwrap_or_default(), "feature work");

    fs::remove_dir_all(&dir).unwrap();
}
