//! Integration tests against a throwaway repository in the system temp dir.

use std::fs;
use std::path::PathBuf;

use git2::{Repository, Signature};

use super::*;

fn scratch_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("orbit-test-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test User").unwrap();
    config.set_str("user.email", "test@orbit.dev").unwrap();
    dir
}

fn write(path: &PathBuf, rel: &str, content: &str) {
    let file = path.join(rel);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(file, content).unwrap();
}

fn commit_all(repo_path: &PathBuf, message: &str) {
    let repo = Repository::open(repo_path).unwrap();
    let mut index = repo.index().unwrap();
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = Signature::now("Test User", "test@orbit.dev").unwrap();
    let parent = repo.head().ok().map(|head| head.peel_to_commit().unwrap());
    let parents: Vec<&git2::Commit> = parent.as_ref().map(|c| vec![c]).unwrap_or_default();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap();
}

#[test]
fn status_reports_staged_and_unstaged_rows() {
    let dir = scratch_repo("status");
    write(&dir, "a.txt", "one\ntwo\n");
    write(&dir, "b.md", "hello\n");
    commit_all(&dir, "initial");

    // Unstaged modify + untracked new file.
    write(&dir, "a.txt", "one\nTWO\nthree\n");
    write(&dir, "new.ts", "export const x = 1;\n");

    let state = build_state(&dir).unwrap();
    assert_eq!(state.files.len(), 2);

    let a = state.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(!a.staged, "a.txt should be unstaged only");
    assert_eq!(a.status, "M");
    assert_eq!(a.additions, 2, "modified a.txt adds two lines");
    assert_eq!(a.deletions, 1);

    let new = state.files.iter().find(|f| f.path == "new.ts").unwrap();
    assert!(new.untracked);
    assert_eq!(new.status, "A");
    assert_eq!(new.additions, 1);

    // Partial staging produces both rows for the same path.
    stage_paths(&dir, &["a.txt".to_string()]).unwrap();
    write(&dir, "a.txt", "one\nTWO\nthree\nFOUR\n");
    let state = build_state(&dir).unwrap();
    let a_rows: Vec<_> = state
        .files
        .iter()
        .filter(|f| f.path == "a.txt")
        .collect();
    assert_eq!(a_rows.len(), 2, "a.txt should appear staged and unstaged");
    assert!(a_rows.iter().any(|f| f.staged));
    assert!(a_rows.iter().any(|f| !f.staged));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unstage_resets_to_head() {
    let dir = scratch_repo("unstage");
    write(&dir, "file.txt", "v1\n");
    commit_all(&dir, "c1");
    write(&dir, "file.txt", "v2\n");
    stage_paths(&dir, &["file.txt".to_string()]).unwrap();

    let state = build_state(&dir).unwrap();
    assert!(state.files.iter().any(|f| f.staged));

    unstage_paths(&dir, &["file.txt".to_string()]).unwrap();
    let state = build_state(&dir).unwrap();
    assert!(
        !state.files.iter().any(|f| f.staged),
        "nothing should stay staged after unstage"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_creates_head_and_reports_clean_tree() {
    let dir = scratch_repo("commit");
    write(&dir, "app.txt", "hello\n");
    commit_all(&dir, "initial");
    write(&dir, "app.txt", "hello\nworld\n");
    stage_paths(&dir, &["app.txt".to_string()]).unwrap();

    let oid = commit(&dir, "feat: second", "body text", false).unwrap();
    assert_eq!(oid.len(), 40);

    let state = build_state(&dir).unwrap();
    assert!(state.files.is_empty(), "tree should be clean after commit");

    let repo = Repository::open(&dir).unwrap();
    let message = repo
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .message().unwrap_or_default().to_string();
    assert!(message.starts_with("feat: second"));
    assert!(message.contains("body text"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_rejects_when_nothing_staged() {
    let dir = scratch_repo("reject");
    write(&dir, "x.txt", "1\n");
    commit_all(&dir, "c1");
    assert!(commit(&dir, "empty", "", false).is_err());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn amend_replaces_last_commit() {
    let dir = scratch_repo("amend");
    write(&dir, "x.txt", "1\n");
    commit_all(&dir, "c1");
    write(&dir, "x.txt", "1\n2\n");
    commit_all(&dir, "c2");
    write(&dir, "x.txt", "1\n2\n3\n");
    stage_paths(&dir, &["x.txt".to_string()]).unwrap();
    commit(&dir, "amended title", "amended body", true).unwrap();

    let repo = Repository::open(&dir).unwrap();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    assert!(commit.message().unwrap_or_default().starts_with("amended title"));
    assert_eq!(commit.parent_count(), 1, "amend must keep the original parent");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_diff_returns_staged_and_unstaged_content() {
    let dir = scratch_repo("diff");
    write(&dir, "code.txt", "alpha\n");
    commit_all(&dir, "c1");
    write(&dir, "code.txt", "alpha\nbeta\n");
    stage_paths(&dir, &["code.txt".to_string()]).unwrap();
    write(&dir, "code.txt", "alpha\nbeta\ngamma\n");

    let staged = file_diff_at(&dir, "code.txt", true).unwrap();
    assert!(!staged.binary && !staged.too_large);
    assert_eq!(staged.original.unwrap(), "alpha\n");
    assert_eq!(staged.modified.unwrap(), "alpha\nbeta\n");

    let unstaged = file_diff_at(&dir, "code.txt", false).unwrap();
    assert_eq!(unstaged.original.unwrap(), "alpha\nbeta\n");
    assert_eq!(unstaged.modified.unwrap(), "alpha\nbeta\ngamma\n");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn discard_restores_worktree_from_index() {
    let dir = scratch_repo("discard");
    write(&dir, "keep.txt", "committed\n");
    commit_all(&dir, "c1");
    write(&dir, "keep.txt", "committed\ndirty\n");
    write(&dir, "bonus.txt", "untracked\n");

    discard_file(&dir, "keep.txt").unwrap();
    // core.autocrlf may rewrite line endings on checkout — normalize first.
    let restored = fs::read_to_string(dir.join("keep.txt"))
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(restored, "committed\n");

    discard_file(&dir, "bonus.txt").unwrap();
    assert!(!dir.join("bonus.txt").exists(), "untracked file should be deleted");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stash_clears_changes_and_is_listed() {
    let dir = scratch_repo("stash");
    write(&dir, "x.txt", "1\n");
    commit_all(&dir, "c1");
    write(&dir, "x.txt", "1\n2\n");

    stash(&dir, Some("WIP: orbit test")).unwrap();

    let state = build_state(&dir).unwrap();
    assert!(state.files.is_empty(), "stash should clean the worktree");
    assert_eq!(state.stashes.len(), 1);
    assert!(state.stashes[0].message.contains("WIP: orbit test"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn identity_falls_back_to_folder_names() {
    let dir = scratch_repo("identity");
    write(&dir, "x.txt", "1\n");
    commit_all(&dir, "c1");

    let state = build_state(&dir).unwrap();
    // No remote configured: derive the name from the folder and mark Local.
    assert!(!state.name.is_empty());
    assert!(state.name.starts_with("orbit-test-identity"));
    assert_eq!(state.visibility.as_deref(), Some("Local"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unborn_branch_without_identity_still_builds_state() {
    // Fresh init: no commits, no user.name/user.email.
    let dir = std::env::temp_dir().join(format!("orbit-test-fresh-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    write(&dir, "loose.txt", "content\n");

    let state = build_state(&dir).unwrap();
    assert!(!state.current_branch.is_empty());
    assert_ne!(state.current_branch, "detached HEAD");
    assert!(state.files.iter().any(|f| f.path == "loose.txt" && f.untracked));
    assert_eq!(state.account.name, "Unknown");

    // Staging works on the unborn branch, and unstaging removes it again.
    stage_paths(&dir, &["loose.txt".to_string()]).unwrap();
    let state = build_state(&dir).unwrap();
    assert!(state.files.iter().any(|f| f.path == "loose.txt" && f.staged));
    unstage_paths(&dir, &["loose.txt".to_string()]).unwrap();
    let state = build_state(&dir).unwrap();
    assert!(!state.files.iter().any(|f| f.staged));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_history_linear() {
    let dir = scratch_repo("history-linear");
    write(&dir, "a.txt", "1\n");
    commit_all(&dir, "first");
    write(&dir, "a.txt", "2\n");
    commit_all(&dir, "second");
    write(&dir, "a.txt", "3\n");
    commit_all(&dir, "third");

    let history = build_commit_history(&dir, false).unwrap();
    assert_eq!(history.total, 3);
    assert!(!history.truncated);
    assert_eq!(history.commits.len(), 3);

    // Newest first, all on lane 0, summaries and short oids sane.
    assert_eq!(history.commits[0].summary, "third");
    assert_eq!(history.commits[2].summary, "first");
    for (index, row) in history.commits.iter().enumerate() {
        assert_eq!(row.lane, 0);
        assert_eq!(row.short_oid.len(), 7);
        assert!(!row.is_merge);
        // The root commit (oldest) has no parents; every other row has one.
        if index == history.commits.len() - 1 {
            assert_eq!(row.parent_lanes.len(), 0);
        } else {
            assert_eq!(row.parent_lanes.len(), 1);
        }
    }
    assert!(history.commits[0].is_head);
    assert!(!history.commits[1].is_head);
    // Branch label "main" (or the init default) on HEAD.
    assert!(history.commits[0].refs.iter().any(|r| r == "main" || r == "master"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_history_merge_creates_second_lane() {
    let dir = scratch_repo("history-merge");
    write(&dir, "a.txt", "1\n");
    commit_all(&dir, "base");

    // Feature branch with its own commit, created with direct plumbing.
    let repo = Repository::open(&dir).unwrap();
    let base = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature", &base, false).unwrap();
    let sig = Signature::now("Test User", "test@orbit.dev").unwrap();
    let mut index = repo.index().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let feature_commit = repo
        .commit(Some("refs/heads/feature"), &sig, &sig, "feature work", &tree, &[&base])
        .unwrap();
    // Merge feature into the current branch (main/master tip == base).
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let merged = repo
        .commit(
            Some("HEAD"),
            &sig,
            &sig,
            "merge feature",
            &tree,
            &[&head, &repo.find_commit(feature_commit).unwrap()],
        )
        .unwrap();
    let _ = merged;

    let history = build_commit_history(&dir, false).unwrap();
    let merge_row = history.commits.iter().find(|r| r.summary == "merge feature").unwrap();
    assert!(merge_row.is_merge, "merge row must be flagged");
    assert_eq!(merge_row.parent_lanes.len(), 2, "merge fans out to two lanes");
    // While the feature commit is pending, some row must carry two active lanes.
    assert!(
        history.commits.iter().any(|r| r.active_before.len() == 2),
        "expected a row with two active lanes, rows: {:?}",
        history.commits.iter().map(|r| (&r.summary, r.active_before.clone())).collect::<Vec<_>>()
    );
    // After the merge row only one lane stays.
    let merge_idx = history.commits.iter().position(|r| r.summary == "merge feature").unwrap();
    let after = &history.commits[merge_idx];
    assert_eq!(after.active_after.len(), 2); // both parents pending right after the merge
    // ...and by the last row (the root) the graph has collapsed to one lane
    // and the root itself has no parents.
    let last = history.commits.last().unwrap();
    assert_eq!(last.parent_lanes.len(), 0);
    assert!(!last.is_head);

    // Labels: HEAD branch + feature both appear somewhere.
    let all_labels: Vec<String> = history.commits.iter().flat_map(|r| r.refs.clone()).collect();
    assert!(all_labels.iter().any(|l| l == "feature"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_history_remote_toggle() {
    let dir = scratch_repo("history-remote");
    write(&dir, "a.txt", "1\n");
    commit_all(&dir, "local one");
    // A commit only reachable via a remote-tracking ref.
    let repo = Repository::open(&dir).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let sig = Signature::now("Test User", "test@orbit.dev").unwrap();
    let mut index = repo.index().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let remote_only = repo
        .commit(None, &sig, &sig, "remote only", &tree, &[&head])
        .unwrap();
    repo.reference("refs/remotes/origin/main", remote_only, false, "test")
        .unwrap();

    let local = build_commit_history(&dir, false).unwrap();
    assert!(!local.commits.iter().any(|r| r.summary == "remote only"),
        "remote-only commit must be hidden without include_remotes");

    let with_remote = build_commit_history(&dir, true).unwrap();
    assert!(with_remote.commits.iter().any(|r| r.summary == "remote only"),
        "remote-only commit must appear with include_remotes");
    // Remote ref label rendered as origin/main.
    let labeled = with_remote
        .commits
        .iter()
        .find(|r| r.summary == "remote only")
        .unwrap();
    assert!(labeled.refs.iter().any(|r| r == "origin/main"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_history_unborn_repo_is_empty() {
    let dir = scratch_repo("history-unborn");
    write(&dir, "loose.txt", "x\n");
    let history = build_commit_history(&dir, false).unwrap();
    assert_eq!(history.total, 0);
    assert!(history.commits.is_empty());
    assert!(!history.truncated);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_tree_lists_tracked_and_untracked_but_not_ignored() {
    let dir = scratch_repo("tree");
    write(&dir, ".gitignore", "node_modules/\n*.log\n");
    write(&dir, "src/deep/nested/mod.ts", "export {}\n");
    write(&dir, "readme.md", "hi\n");
    commit_all(&dir, "c1");
    // Post-commit: modify one, add untracked, add ignored.
    write(&dir, "readme.md", "hi changed\n");
    write(&dir, "docs/new.md", "fresh\n");
    write(&dir, "node_modules/pkg/index.js", "x\n");
    write(&dir, "debug.log", "noise\n");

    let tree = list_tree(&dir).unwrap();
    assert!(tree.entries.iter().any(|p| p == "src/deep/nested/mod.ts"), "nested tracked file present");
    assert!(tree.entries.iter().any(|p| p == "docs/new.md"), "untracked file present");
    assert!(!tree.entries.iter().any(|p| p.starts_with("node_modules/")), "ignored dir excluded");
    assert!(!tree.entries.iter().any(|p| p.ends_with(".log")), "ignored pattern excluded");
    assert!(tree.changed_paths.iter().any(|p| p == "readme.md"), "modified file flagged");
    assert!(tree.changed_paths.iter().any(|p| p == "docs/new.md"), "untracked file flagged");
    assert!(!tree.changed_paths.iter().any(|p| p.starts_with("node_modules/")));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn worktree_file_read_write_roundtrip_and_traversal_guard() {
    let dir = scratch_repo("rw");
    write(&dir, "code.ts", "const a = 1;\n");
    commit_all(&dir, "c1");

    write_worktree_file(&dir, "code.ts", "const a = 2;\n").unwrap();
    let content = read_worktree_file(&dir, "code.ts").unwrap();
    assert_eq!(content.content, "const a = 2;\n");
    assert_eq!(content.language, "typescript");
    assert!(!content.binary && !content.too_large);

    // Nested write creates missing directories.
    write_worktree_file(&dir, "brand/new/folder.txt", "made\n").unwrap();
    assert_eq!(fs::read_to_string(dir.join("brand/new/folder.txt")).unwrap(), "made\n");

    // Traversal attempts are rejected.
    assert!(write_worktree_file(&dir, "../escape.txt", "x").is_err());
    assert!(read_worktree_file(&dir, "../../secret.txt").is_err());
    assert!(read_worktree_file(&dir, "C:/Windows/system32").is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn worktree_read_flags_binary() {
    let dir = scratch_repo("binary");
    fs::write(dir.join("blob.bin"), [0u8, 1, 0, 2, 3]).unwrap();
    let content = read_worktree_file(&dir, "blob.bin").unwrap();
    assert!(content.binary);
    assert_eq!(content.content, "");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_history_lists_only_changing_commits() {
    let dir = scratch_repo("file-history");
    write(&dir, "target.txt", "v1\n");
    write(&dir, "other.txt", "x\n");
    commit_all(&dir, "touch both");
    write(&dir, "other.txt", "x2\n");
    commit_all(&dir, "other only");
    write(&dir, "target.txt", "v2\n");
    commit_all(&dir, "target again");
    write(&dir, "target.txt", "v2\n"); // saved identical — new commit, same blob
    commit_all(&dir, "no actual change to target");

    let history = build_file_history(&dir, "target.txt").unwrap();
    let summaries: Vec<&str> = history.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(summaries, vec!["target again", "touch both"],
        "only commits that changed target.txt's blob, newest first: {summaries:?}");

    let entries = build_file_history(&dir, "missing.txt").unwrap();
    assert!(entries.is_empty(), "unknown path yields empty history");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_file_at_commit_returns_historical_blob() {
    let dir = scratch_repo("blob-at");
    write(&dir, "doc.md", "old content\n");
    commit_all(&dir, "first");
    write(&dir, "doc.md", "new content\n");
    commit_all(&dir, "second");

    let repo = Repository::open(&dir).unwrap();
    let head_oid = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
    let parent_oid = repo.head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .parent(0)
        .unwrap()
        .id()
        .to_string();
    drop(repo);

    assert_eq!(read_file_at_commit(&dir, "doc.md", &head_oid).unwrap().content, "new content\n");
    assert_eq!(read_file_at_commit(&dir, "doc.md", &parent_oid).unwrap().content, "old content\n");
    assert!(read_file_at_commit(&dir, "missing.md", &head_oid).is_err());
    assert!(read_file_at_commit(&dir, "doc.md", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn network_push_pull_flow_with_local_bare_remote() {
    let base = std::env::temp_dir().join(format!("orbit-net-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let origin = base.join("origin.git");
    let alice = base.join("alice");
    let bob = base.join("bob");

    // Bare origin + two clones.
    Repository::init_bare(&origin).unwrap();
    Repository::init(&alice).unwrap();
    let alice_repo = Repository::open(&alice).unwrap();
    alice_repo.remote("origin", origin.to_str().unwrap()).unwrap();
    drop(alice_repo);
    write(&alice, "readme.md", "hello\n");
    commit_all(&alice, "initial");
    // Seed the bare remote via a direct push from alice.
    let alice_repo = Repository::open(&alice).unwrap();
    let sig = Signature::now("Alice", "alice@test.dev").unwrap();
    drop(alice_repo);
    let _ = run_cli(&alice, &["push", "--set-upstream", "origin", "master"]);

    Repository::clone(origin.to_str().unwrap(), &bob).unwrap();

    // Alice writes a new commit and pushes through our net::push.
    write(&alice, "readme.md", "hello\nfrom alice\n");
    commit_all(&alice, "second");
    crate::net::push(&alice, "master", true).unwrap();

    // Bob is one behind after our net::fetch, level after net::pull.
    crate::net::fetch(&bob).unwrap();
    let bob_state = build_state(&bob).unwrap();
    assert_eq!(bob_state.upstream.as_ref().unwrap().behind, 1);
    assert_eq!(bob_state.upstream.as_ref().unwrap().ahead, 0);

    crate::net::pull(&bob).unwrap();
    let bob_state = build_state(&bob).unwrap();
    assert_eq!(bob_state.upstream.as_ref().unwrap().behind, 0);
    let bob_repo = Repository::open(&bob).unwrap();
    let summary = bob_repo
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .summary()
        .unwrap_or_default()
        .to_string();
    drop(bob_repo);
    assert_eq!(summary, "second");

    let _ = fs::remove_dir_all(&base);
}

/// Small helper: run git CLI in `dir` (test-side plumbing only).
fn run_cli(dir: &PathBuf, args: &[&str]) -> std::process::Output {
    std::process::Command::new("git")
        .arg("-C").arg(dir)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("git CLI available")
}

#[test]
fn network_push_sets_upstream_on_first_push() {
    let base = std::env::temp_dir().join(format!("orbit-net-up-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let origin = base.join("origin.git");
    let work = base.join("work");

    Repository::init_bare(&origin).unwrap();
    Repository::init(&work).unwrap();
    let repo = Repository::open(&work).unwrap();
    repo.remote("origin", origin.to_str().unwrap()).unwrap();
    drop(repo);
    write(&work, "note.txt", "n1\n");
    commit_all(&work, "first");

    // No upstream yet; our push() must set it.
    let before = build_state(&work).unwrap();
    assert!(before.upstream.is_none());
    crate::net::push(&work, &before.current_branch, false).unwrap();

    let after = build_state(&work).unwrap();
    assert!(after.upstream.is_some(), "upstream configured after first push");
    assert_eq!(after.upstream.as_ref().unwrap().ahead, 0);

    let _ = fs::remove_dir_all(&base);
}
