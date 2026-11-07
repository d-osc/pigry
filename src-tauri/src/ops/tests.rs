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

    // Create a commit with changes using git2.
    fs::write(dir.join("file.txt"), "original\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let dir = std::env::temp_dir().join(format!("orbit-ops-merge-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
    drop(config);

    fs::write(dir.join("a.txt"), "1\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "feature work", &tree, &[&head]).unwrap();
    let feature_tip = repo.head().unwrap().peel_to_commit().unwrap().id();

    // Back to base branch, then merge feature (fast-forward).
    git_cli(&dir, &["checkout", &base_branch]);
    crate::ops::merge_branch(&dir, "feature").unwrap();

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
    let base = std::env::temp_dir().join(format!("orbit-clone-{}", std::process::id()));
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();
    crate::ops::merge_branch(&work, "master").unwrap(); // no-op, just exercises
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
