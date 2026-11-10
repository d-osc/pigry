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
    let dir = std::env::temp_dir().join(format!("orbit-rebase-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
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
            let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let dir = std::env::temp_dir().join(format!("orbit-rebase-abort-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
    drop(config);

    // Two commits touching the SAME line of the same file: reordering them
    // forces a merge conflict mid-rebase.
    fs::write(dir.join("shared.txt"), "one\n").unwrap();
    let mut repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let dir = std::env::temp_dir().join(format!("orbit-ops-merge2-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
    let dir = std::env::temp_dir().join(format!("orbit-ops-preview-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
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
        let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
fn push_preview_lists_unpushed_commits_with_files() {
    let dir = std::env::temp_dir().join(format!("orbit-ops-pushprev-{}", std::process::id()));
    let remote_dir = std::env::temp_dir().join(format!("orbit-ops-pushprev-remote-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&remote_dir);
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&remote_dir).unwrap();
    Repository::init(&dir).unwrap();
    Repository::init_bare(&remote_dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
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
        let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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

    fs::remove_dir_all(&dir).unwrap();
    fs::remove_dir_all(&remote_dir).unwrap();
}

#[test]
fn stash_preview_lists_entry_files() {
    let dir = std::env::temp_dir().join(format!("orbit-ops-stashprev-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
    config.set_bool("core.autocrlf", false).unwrap();
    drop(config);

    fs::write(dir.join("a.txt"), "one\n").unwrap();
    let repo = Repository::open(&dir).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();
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
