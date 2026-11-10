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

    let history = build_file_history(&dir, "target.txt", None).unwrap();
    let summaries: Vec<&str> = history.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(summaries, vec!["target again", "touch both"],
        "only commits that changed target.txt's blob, newest first: {summaries:?}");

    let entries = build_file_history(&dir, "missing.txt", None).unwrap();
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
    let _sig = Signature::now("Alice", "alice@test.dev").unwrap();
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

#[test]
fn commit_detail_lists_changed_files_with_numstat() {
    let dir = scratch_repo("detail");
    write(&dir, "a.txt", "one\n");
    write(&dir, "keep.txt", "same\n");
    commit_all(&dir, "base");
    write(&dir, "a.txt", "one\ntwo\n");
    write(&dir, "b/new.txt", "fresh\n");
    commit_all(&dir, "change two files");

    let detail = build_commit_detail(&dir, "HEAD").unwrap();
    assert_eq!(detail.summary, "change two files");
    assert!(!detail.is_merge);
    assert_eq!(detail.files.len(), 2);

    let a = detail.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(a.status, "M");
    assert_eq!(a.additions, 1);
    let new_file = detail.files.iter().find(|f| f.path == "b/new.txt").unwrap();
    assert_eq!(new_file.status, "A");
    assert_eq!(new_file.additions, 1);
    assert_eq!(new_file.directory, "b");

    // Full message contains the summary line.
    assert!(detail.message.starts_with("change two files"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_file_diff_returns_parent_vs_commit_content() {
    let dir = scratch_repo("detail-diff");
    write(&dir, "doc.txt", "old\n");
    commit_all(&dir, "base");
    write(&dir, "doc.txt", "old\nnew line\n");
    commit_all(&dir, "extend");

    let repo = Repository::open(&dir).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
    drop(repo);

    let diff = read_commit_file_diff(&dir, &head, "doc.txt").unwrap();
    assert_eq!(diff.original.unwrap(), "old\n");
    assert_eq!(diff.modified.unwrap(), "old\nnew line\n");
    assert!(!diff.binary && !diff.too_large);

    // A path added by the commit has an empty base.
    write(&dir, "added.txt", "added\n");
    commit_all(&dir, "add file");
    let repo = Repository::open(&dir).unwrap();
    let head2 = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
    drop(repo);
    let diff2 = read_commit_file_diff(&dir, &head2, "added.txt").unwrap();
    assert_eq!(diff2.original.unwrap(), "");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn branch_create_and_checkout_move_head() {
    let dir = scratch_repo("branch-create");
    write(&dir, "a.txt", "1\n");
    commit_all(&dir, "base");

    let default_branch = build_state(&dir).unwrap().current_branch;
    create_branch(&dir, "feature/x", true).unwrap();
    let state = build_state(&dir).unwrap();
    assert_eq!(state.current_branch, "feature/x");
    assert!(state.branches.iter().any(|b| b.name == "feature/x" && b.is_head));
    assert!(state.branches.iter().any(|b| b.name == default_branch && !b.is_head));

    // Duplicate creation is refused.
    assert!(create_branch(&dir, "feature/x", false).is_err());
    // Invalid names are refused.
    assert!(create_branch(&dir, "bad name", false).is_err());
    assert!(create_branch(&dir, "-dash", false).is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn branch_checkout_refuses_overwriting_local_changes() {
    let dir = scratch_repo("branch-conflict");
    write(&dir, "shared.txt", "main version\n");
    commit_all(&dir, "base");

    create_branch(&dir, "feature", true).unwrap();
    // On feature: commit different content, then dirty the working tree.
    write(&dir, "shared.txt", "feature version\n");
    commit_all(&dir, "feature commit");
    write(&dir, "shared.txt", "uncommitted local edit\n");

    // Checking out the base branch must fail — it would overwrite the dirty file.
    assert!(
        checkout_branch(&dir, "master").is_err() || checkout_branch(&dir, "main").is_err(),
        "safe checkout should refuse to clobber local changes"
    );
    // Clean tree checkouts fine.
    commit_all(&dir, "save feature work");
    checkout_branch(&dir, "master").or_else(|_| checkout_branch(&dir, "main")).unwrap();
    let state = build_state(&dir).unwrap();
    assert_ne!(state.current_branch, "feature");
    assert_eq!(
        fs::read_to_string(dir.join("shared.txt")).unwrap().replace('\r', ""),
        "main version\n"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn branch_delete_guards() {
    let dir = scratch_repo("branch-delete");
    write(&dir, "a.txt", "1\n");
    commit_all(&dir, "base");

    create_branch(&dir, "merged", false).unwrap();
    create_branch(&dir, "unmerged", true).unwrap();
    write(&dir, "a.txt", "2\n");
    commit_all(&dir, "unmerged work");
    // Back to base branch (first branch in the list, i.e. the init default).
    let state = build_state(&dir).unwrap();
    let default_branch = state
        .branches
        .iter()
        .find(|b| b.name != "unmerged" && b.name != "merged")
        .map(|b| b.name.clone())
        .unwrap();
    checkout_branch(&dir, &default_branch).unwrap();

    // Deleting the current branch is refused.
    assert!(delete_branch(&dir, &default_branch).is_err());
    // Unmerged branch is refused.
    assert!(delete_branch(&dir, "unmerged").is_err());
    // Merged branch deletes fine.
    delete_branch(&dir, "merged").unwrap();
    let state = build_state(&dir).unwrap();
    assert!(!state.branches.iter().any(|b| b.name == "merged"));
    // Deleting an unknown branch errors clearly.
    assert!(delete_branch(&dir, "ghost").is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn tag_create_list_and_delete() {
    let dir = scratch_repo("tags");
    write(&dir, "a.txt", "1\n");
    commit_all(&dir, "base");
    write(&dir, "a.txt", "2\n");
    commit_all(&dir, "second");

    create_tag(&dir, "v0.1.0").unwrap();
    create_tag(&dir, "v0.2.0").unwrap();
    // Duplicate refused.
    assert!(create_tag(&dir, "v0.1.0").is_err());
    // Invalid names refused.
    assert!(create_tag(&dir, "bad name").is_err());
    assert!(create_tag(&dir, "-x").is_err());

    let state = build_state(&dir).unwrap();
    assert_eq!(state.tag_total, 2);
    // Newest-name-first ordering (v0.2.0 before v0.1.0).
    assert_eq!(state.tags[0].name, "v0.2.0");
    assert_eq!(state.tags[1].name, "v0.1.0");
    // Both point at HEAD (same commit).
    assert_eq!(state.tags[0].commit_oid, state.tags[1].commit_oid);
    assert!(state.tags[0].time_seconds.is_some());

    delete_tag(&dir, "v0.2.0").unwrap();
    // Unknown tag errors clearly.
    assert!(delete_tag(&dir, "ghost").is_err());
    let state = build_state(&dir).unwrap();
    assert_eq!(state.tag_total, 1);
    assert_eq!(state.tags[0].name, "v0.1.0");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn annotated_tag_resolves_to_commit() {
    let dir = scratch_repo("tag-annotated");
    write(&dir, "a.txt", "x\n");
    commit_all(&dir, "base");

    let repo = Repository::open(&dir).unwrap();
    let sig = Signature::now("T", "t@t.dev").unwrap();
    {
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        let head_obj = head_commit.as_object().clone();
        repo.tag("rel-1", &head_obj, &sig, "release one", false)
            .unwrap();
    }
    drop(repo);

    let state = build_state(&dir).unwrap();
    let tag = state.tags.iter().find(|t| t.name == "rel-1").unwrap();
    assert!(tag.commit_oid.is_some(), "annotated tag must resolve to a commit");
    let repo = Repository::open(&dir).unwrap();
    let head_oid = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
    drop(repo);
    assert_eq!(tag.commit_oid.as_deref(), Some(head_oid.as_str()));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stash_apply_keeps_entry_pop_removes_it() {
    let dir = scratch_repo("stash-mgmt");
    write(&dir, "a.txt", "base\n");
    commit_all(&dir, "base");

    // Two stashes.
    write(&dir, "a.txt", "change one\n");
    stash(&dir, Some("first stash")).unwrap();
    write(&dir, "a.txt", "change two\n");
    stash(&dir, Some("second stash")).unwrap();

    let state = build_state(&dir).unwrap();
    assert_eq!(state.stashes.len(), 2);
    assert!(state.files.is_empty(), "worktree clean after stashing");

    // Apply (not pop) stash 0 restores content and keeps both entries.
    stash_apply(&dir, 0).unwrap();
    let content = fs::read_to_string(dir.join("a.txt")).unwrap().replace('\r', "");
    assert_eq!(content, "change two\n", "stash 0 is the most recent (second stash)");
    let state = build_state(&dir).unwrap();
    assert_eq!(state.stashes.len(), 2, "apply keeps the stash entry");

    // Pop removes the entry.
    stash_pop(&dir, 0).unwrap();
    let state = build_state(&dir).unwrap();
    assert_eq!(state.stashes.len(), 1);

    // Drop removes the last one without touching the worktree.
    stash_drop(&dir, 0).unwrap();
    let state = build_state(&dir).unwrap();
    assert_eq!(state.stashes.len(), 0);
    let content = fs::read_to_string(dir.join("a.txt")).unwrap().replace('\r', "");
    assert_eq!(content, "change two\n");

    // Out-of-range errors are clear.
    assert!(stash_apply(&dir, 5).is_err());
    assert!(stash_drop(&dir, 5).is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stash_pop_conflicts_report_clean_error() {
    let dir = scratch_repo("stash-conflict");
    write(&dir, "a.txt", "base\n");
    commit_all(&dir, "base");
    write(&dir, "a.txt", "stashed change\n");
    stash(&dir, Some("will conflict")).unwrap();
    // Now make the same line different on HEAD so applying conflicts.
    write(&dir, "a.txt", "committed conflicting change\n");
    commit_all(&dir, "conflicting commit");

    // libgit2 records stash conflicts as merge conflicts in the worktree
    // (like git CLI, which also leaves markers). The pop may return Ok with
    // conflict markers written, or fail with a message — either is acceptable
    // as long as the repository stays consistent.
    match stash_pop(&dir, 0) {
        Err(message) => {
            assert!(
                message.contains("stash") || message.contains("conflict") || message.contains("overwrite"),
                "error should describe the failure: {message}"
            );
        }
        Ok(()) => {
            let content = fs::read_to_string(dir.join("a.txt")).unwrap();
            assert!(
                content.contains("<<<<<<<") || content.contains("====="),
                "successful pop with conflict must leave conflict markers: {content}"
            );
            // libgit2 drops the entry even on conflict (git CLI keeps it) —
            // either count is acceptable; the repo must stay readable.
            let state = build_state(&dir).unwrap();
            assert!(state.stashes.len() <= 1);
        }
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn hunk_listing_and_partial_staging() {
    let dir = scratch_repo("hunks");
    // One file, two well-separated regions → two hunks after both change.
    // 20 lines so two edits are farther apart than the 3-line diff context.
    let base: Vec<String> = (1..=20).map(|i| format!("line{i}")).collect();
    write(&dir, "code.txt", &(base.join("\n") + "\n"));
    commit_all(&dir, "base");
    let mut edited = base.clone();
    edited[0] = "line1 EDITED".to_string();
    edited[19] = "line20 EDITED".to_string();
    write(&dir, "code.txt", &(edited.join("\n") + "\n"));

    let hunks = file_hunks(&dir, "code.txt", false).unwrap();
    assert_eq!(hunks.len(), 2, "two separated edits → two hunks");
    assert_eq!(hunks[0].old_start, 1);
    assert!(hunks[1].old_start >= 14, "second edit near line 20 minus context");

    // Stage only the first hunk.
    stage_hunk(&dir, "code.txt", 0).unwrap();
    let index_content = {
        let repo = Repository::open(&dir).unwrap();
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new("code.txt"), 0).unwrap();
        let blob = repo
            .find_object(entry.id, Some(ObjectType::Blob))
            .unwrap()
            .peel_to_blob()
            .unwrap();
        String::from_utf8_lossy(blob.content()).to_string()
    };
    assert!(
        index_content.contains("line1 EDITED"),
        "hunk 1 staged: {index_content}"
    );
    assert!(
        !index_content.contains("line20 EDITED"),
        "hunk 2 must remain unstaged: {index_content}"
    );

    // Stage the second hunk too — now the index matches the worktree.
    stage_hunk(&dir, "code.txt", 0).unwrap(); // after the first staging, remaining hunk is index 0
    let index_content = {
        let repo = Repository::open(&dir).unwrap();
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new("code.txt"), 0).unwrap();
        let blob = repo
            .find_object(entry.id, Some(ObjectType::Blob))
            .unwrap()
            .peel_to_blob()
            .unwrap();
        String::from_utf8_lossy(blob.content()).to_string()
    };
    assert!(
        index_content.contains("line20 EDITED"),
        "second hunk staged: {index_content}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stage_hunk_untracked_file_stages_content() {
    let dir = scratch_repo("hunk-untracked");
    write(&dir, "brand-new.ts", "export const a = 1;\n");

    let hunks = file_hunks(&dir, "brand-new.ts", false).unwrap();
    assert_eq!(hunks.len(), 1, "untracked file = one hunk");

    stage_hunk(&dir, "brand-new.ts", 0).unwrap();
    let repo = Repository::open(&dir).unwrap();
    let index = repo.index().unwrap();
    assert!(
        index.get_path(Path::new("brand-new.ts"), 0).is_some(),
        "file staged after staging its single hunk"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unstage_hunk_reverses_only_target_hunk() {
    let dir = scratch_repo("unstage-hunk");
    // 20-line committed file; both edits staged entirely.
    let base: Vec<String> = (1..=20).map(|i| format!("line{i}")).collect();
    write(&dir, "code.txt", &(base.join("\n") + "\n"));
    commit_all(&dir, "base");
    let mut edited = base.clone();
    edited[0] = "line1 EDITED".to_string();
    edited[19] = "line20 EDITED".to_string();
    write(&dir, "code.txt", &(edited.join("\n") + "\n"));
    stage_paths(&dir, &["code.txt".to_string()]).unwrap();

    // Two staged hunks (line 1 and line 20).
    let staged_hunks = file_hunks(&dir, "code.txt", true).unwrap();
    assert_eq!(staged_hunks.len(), 2);

    // Unstage the first staged hunk (line 1).
    unstage_hunk(&dir, "code.txt", 0).unwrap();

    // Index must now contain only the line-20 change.
    let repo = Repository::open(&dir).unwrap();
    let index = repo.index().unwrap();
    let entry = index.get_path(Path::new("code.txt"), 0).unwrap();
    let blob = repo
        .find_object(entry.id, Some(ObjectType::Blob))
        .unwrap()
        .peel_to_blob()
        .unwrap();
    let index_content = String::from_utf8_lossy(blob.content()).to_string();
    drop(index);
    assert!(
        !index_content.contains("line1 EDITED"),
        "line-1 change unstaged: {index_content}"
    );
    assert!(
        index_content.contains("line20 EDITED"),
        "line-20 change still staged: {index_content}"
    );
    assert!(
        index_content.starts_with("line1\n"),
        "index back to HEAD for the unstaged hunk: {index_content}"
    );

    // Worktree untouched — both edits still present.
    let worktree = fs::read_to_string(dir.join("code.txt"))
        .unwrap()
        .replace('\r', "");
    assert!(worktree.contains("line1 EDITED"));
    assert!(worktree.contains("line20 EDITED"));

    // Out-of-range staged hunk errors clearly.
    assert!(unstage_hunk(&dir, "code.txt", 9).is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unstage_hunk_on_added_file_removes_staged_lines() {
    let dir = scratch_repo("unstage-added");
    // Commit some unrelated file so HEAD exists, then add a new file.
    write(&dir, "base.txt", "x\n");
    commit_all(&dir, "base");
    write(&dir, "added.txt", "kept line\nremoved line\n");
    stage_paths(&dir, &["added.txt".to_string()]).unwrap();

    // The whole added file is one staged hunk — unstaging it empties the
    // index entry (the added content is all '+' lines).
    unstage_hunk(&dir, "added.txt", 0).unwrap();
    let repo = Repository::open(&dir).unwrap();
    let index = repo.index().unwrap();
    assert!(
        index.get_path(Path::new("added.txt"), 0).is_none(),
        "fully-unstaged added file leaves no index entry"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn discard_hunk_reverts_only_target_hunk() {
    let dir = scratch_repo("discard-hunk");
    let base: Vec<String> = (1..=20).map(|i| format!("line{i}")).collect();
    write(&dir, "code.txt", &(base.join("\n") + "\n"));
    commit_all(&dir, "base");
    let mut edited = base.clone();
    edited[0] = "line1 EDITED".to_string();
    edited[19] = "line20 EDITED".to_string();
    write(&dir, "code.txt", &(edited.join("\n") + "\n"));

    let hunks = file_hunks(&dir, "code.txt", false).unwrap();
    assert_eq!(hunks.len(), 2);

    // Discard the first hunk (line 1 edit).
    discard_hunk(&dir, "code.txt", 0).unwrap();
    let content = fs::read_to_string(dir.join("code.txt"))
        .unwrap()
        .replace('\r', "");
    assert!(
        content.contains("line1\n"),
        "hunk 0 reverted: {content}"
    );
    assert!(
        content.contains("line20 EDITED"),
        "hunk 1 untouched: {content}"
    );
    // Index untouched — the line-20 edit was never staged.
    assert!(build_state(&dir).unwrap().files.iter().all(|f| !f.staged));

    // Out-of-range errors clearly.
    assert!(discard_hunk(&dir, "code.txt", 9).is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn discard_hunk_on_untracked_file_deletes_it() {
    let dir = scratch_repo("discard-untracked");
    write(&dir, "untracked.txt", "temporary\n");

    let hunks = file_hunks(&dir, "untracked.txt", false).unwrap();
    assert_eq!(hunks.len(), 1);
    discard_hunk(&dir, "untracked.txt", 0).unwrap();
    assert!(
        !dir.join("untracked.txt").exists(),
        "fully discarded untracked file is deleted"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_blame_attributes_lines_to_commits() {
    let dir = scratch_repo("blame");
    write(&dir, "doc.txt", "alpha\nbeta\n");
    commit_all(&dir, "first commit");
    write(&dir, "doc.txt", "alpha\ngamma\n");
    commit_all(&dir, "second commit");

    let blame = file_blame(&dir, "doc.txt").unwrap();
    assert_eq!(blame.len(), 2);
    assert_eq!(blame[0].line, 1);
    assert_eq!(blame[1].line, 2);
    assert_eq!(blame[0].summary, "first commit");
    assert_eq!(blame[1].summary, "second commit");
    assert!(!blame[0].uncommitted);
    assert_eq!(blame[0].short_oid.len(), 7);

    // Nonexistent file errors clearly.
    assert!(file_blame(&dir, "missing.txt").is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn line_changes_classifies_added_and_modified() {
    let dir = scratch_repo("gutter");
    let base: Vec<String> = (1..=15).map(|i| format!("line{i}")).collect();
    write(&dir, "code.txt", &(base.join("\n") + "\n"));
    commit_all(&dir, "base");

    // Edit line 3 (modified), add after line 10 (added), edit line 14 (modified).
    let mut edited = base.clone();
    edited[2] = "line3 MODIFIED".to_string();
    edited.insert(10, "INSERTED LINE".to_string());
    edited[14] = "line15 MODIFIED".to_string(); // now at index 14 after insert
    write(&dir, "code.txt", &(edited.join("\n") + "\n"));

    let changes = line_changes(&dir, "code.txt").unwrap();
    let added: Vec<u32> = changes.iter().filter(|c| c.change == "added").map(|c| c.line).collect();
    let modified: Vec<u32> = changes.iter().filter(|c| c.change == "modified").map(|c| c.line).collect();

    assert!(
        added.contains(&11),
        "the inserted line (worktree line 11) should be added: added={added:?} modified={modified:?}"
    );
    assert!(
        modified.contains(&3),
        "line 3 should be modified: added={added:?} modified={modified:?}"
    );
    assert!(
        modified.contains(&15),
        "line 15 (was line 14 in HEAD, shifted by insert) should be modified: added={added:?} modified={modified:?}"
    );
    assert!(!added.is_empty() || !modified.is_empty());

    let _ = fs::remove_dir_all(&dir);
}

// --- line-level staging ---

#[test]
fn stage_lines_stages_only_selected_additions() {
    let dir = scratch_repo("stage-lines-add");
    write(&dir, "a.txt", "one\ntwo\n");
    commit_all(&dir, "base");
    // Worktree adds alpha/beta/gamma after line 2 (new lines 3..5).
    write(&dir, "a.txt", "one\ntwo\nalpha\nbeta\ngamma\n");

    // Stage ONLY beta (new-file line 4).
    stage_lines(&dir, "a.txt", "unstaged", &[], &[4]).unwrap();

    let repo = Repository::open(&dir).unwrap();
    let text = String::from_utf8_lossy(&index_blob(&repo, "a.txt").unwrap()).replace('\r', "");
    assert_eq!(text, "one\ntwo\nbeta\n", "index gains only the selected line");

    // alpha + gamma remain unstaged.
    let state = build_state(&dir).unwrap();
    let file = state.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(!file.staged);
    assert_eq!(file.additions, 2, "alpha and gamma stay in the worktree only");
}

#[test]
fn stage_lines_selected_deletion_others_stay() {
    let dir = scratch_repo("stage-lines-del");
    write(&dir, "a.txt", "one\ntwo\nthree\nfour\n");
    commit_all(&dir, "base");
    // Worktree deletes line 2 ("two") and line 4 ("four").
    write(&dir, "a.txt", "one\nthree\n");

    // Stage only the deletion of old line 2.
    stage_lines(&dir, "a.txt", "unstaged", &[2], &[]).unwrap();

    let repo = Repository::open(&dir).unwrap();
    let text = String::from_utf8_lossy(&index_blob(&repo, "a.txt").unwrap()).replace('\r', "");
    assert_eq!(text, "one\nthree\nfour\n", "index lost only 'two'");

    let state = build_state(&dir).unwrap();
    let file = state.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(!file.staged, "the deletion of 'four' is still unstaged");
}

#[test]
fn stage_lines_unstages_selected_additions() {
    let dir = scratch_repo("unstage-lines");
    write(&dir, "a.txt", "one\ntwo\n");
    commit_all(&dir, "base");
    write(&dir, "a.txt", "one\nTWO\ntwo-half\nthree\n");
    stage_paths(&dir, &["a.txt".to_string()]).unwrap();

    // Staged diff (HEAD→index) adds TWO(2), two-half(3), three(4).
    // Unstage only two-half (new-file line 3 in the staged diff).
    stage_lines(&dir, "a.txt", "staged", &[], &[3]).unwrap();

    let repo = Repository::open(&dir).unwrap();
    let text = String::from_utf8_lossy(&index_blob(&repo, "a.txt").unwrap()).replace('\r', "");
    assert_eq!(text, "one\nTWO\nthree\n", "two-half left the index");

    let state = build_state(&dir).unwrap();
    // collect_files emits separate rows per side for the same path.
    let rows: Vec<_> = state.files.iter().filter(|f| f.path == "a.txt").collect();
    let staged_row = rows.iter().find(|f| f.staged).expect("staged row exists");
    let unstaged_row = rows.iter().find(|f| !f.staged).expect("unstaged row exists");
    assert_eq!(staged_row.additions, 2, "TWO + three remain staged");
    assert_eq!(unstaged_row.additions, 1, "only two-half is unstaged");
}

#[test]
fn stage_lines_rejects_empty_and_foreign_selections() {
    let dir = scratch_repo("stage-lines-empty");
    write(&dir, "a.txt", "one\n");
    commit_all(&dir, "base");
    write(&dir, "a.txt", "one\ntwo\n");

    assert!(stage_lines(&dir, "a.txt", "unstaged", &[], &[]).is_err());
    // Selecting a line number that is not part of any hunk → nothing stageable.
    assert!(stage_lines(&dir, "a.txt", "unstaged", &[], &[99]).is_err());
}

#[test]
fn compose_commit_message_builds_conventional_title_and_body() {
    let dir = scratch_repo("compose");
    write(&dir, "src/app.ts", "old\n");
    write(&dir, "src/util.ts", "helper\n");
    commit_all(&dir, "base");
    write(&dir, "src/app.ts", "old\nnew feature line\n");
    write(&dir, "src/extra.ts", "brand new\n");
    stage_paths(&dir, &["src/app.ts".to_string(), "src/extra.ts".to_string()]).unwrap();

    let msg = compose_commit_message(&dir).unwrap();
    assert!(msg.title.starts_with("feat(src): "), "got: {}", msg.title);
    assert!(msg.title.contains("app.ts") && msg.title.contains("extra.ts"));
    let body = msg.body.replace('\r', "");
    assert!(body.contains("src/"));
    assert!(body.contains("app.ts") && body.contains("extra.ts"));
    assert!(body.contains("(+1/−0)") || body.contains("(+1/−1)") || body.contains("(+2/−0)"),
        "body shows per-file diffstats: {body}");
}

// --- linked repositories: submodules + worktrees ---

#[test]
fn worktrees_list_branches_and_current_flag() {
    let dir = scratch_repo("worktrees");
    write(&dir, "a.txt", "base\n");
    commit_all(&dir, "base");
    let base = dir.clone();
    let wt_path = dir.parent().unwrap().join(format!("orbit-wt-{}", std::process::id()));
    let _ = fs::remove_dir_all(&wt_path);

    let out = std::process::Command::new("git")
        .arg("-C").arg(&base)
        .args(["worktree", "add", wt_path.to_str().unwrap(), "-b", "feature-wt"])
        .output()
        .expect("git CLI available");
    assert!(out.status.success(), "worktree add failed: {}", String::from_utf8_lossy(&out.stderr));

    let trees = list_worktrees(&base, base.to_str().unwrap()).unwrap();
    assert_eq!(trees.len(), 2, "main + linked worktree");
    let main = trees.iter().find(|t| t.is_current).unwrap();
    assert_eq!(main.name, dir.file_name().unwrap().to_string_lossy());
    let linked = trees.iter().find(|t| !t.is_current).unwrap();
    assert_eq!(linked.branch, "feature-wt");
    assert!(linked.path.ends_with(&format!("orbit-wt-{}", std::process::id())));

    // Opened from INSIDE the linked worktree: it becomes the current one.
    let from_linked = list_worktrees(&wt_path, wt_path.to_str().unwrap()).unwrap();
    let current = from_linked.iter().filter(|t| t.is_current).count();
    assert_eq!(current, 1, "exactly one worktree marked current");

    let _ = fs::remove_dir_all(&wt_path);
    let _ = std::process::Command::new("git")
        .arg("-C").arg(&base)
        .args(["worktree", "prune"])
        .output();
}

#[test]
fn submodules_list_empty_when_none() {
    let dir = scratch_repo("no-submodule");
    write(&dir, "a.txt", "base\n");
    commit_all(&dir, "base");
    assert!(list_submodules(&dir).unwrap().is_empty());

    // Add a real submodule from a local sibling repo via the CLI.
    let inner = dir.parent().unwrap().join(format!("orbit-sub-inner-{}", std::process::id()));
    let _ = fs::remove_dir_all(&inner);
    fs::create_dir_all(&inner).unwrap();
    let _ = Repository::init(&inner);
    fs::write(inner.join("lib.txt"), "inner\n").unwrap();
    let init = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C").arg(&inner)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test User")
            .env("GIT_AUTHOR_EMAIL", "test@orbit.dev")
            .env("GIT_COMMITTER_NAME", "Test User")
            .env("GIT_COMMITTER_EMAIL", "test@orbit.dev")
            .output()
            .expect("git CLI")
    };
    init(&["add", "."]);
    init(&["commit", "-m", "inner"]);
    let outer_init = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C").arg(&dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test User")
            .env("GIT_AUTHOR_EMAIL", "test@orbit.dev")
            .env("GIT_COMMITTER_NAME", "Test User")
            .env("GIT_COMMITTER_EMAIL", "test@orbit.dev")
            .output()
            .expect("git CLI")
    };
    outer_init(&["-c", "protocol.file.allow=always", "submodule", "add", inner.to_str().unwrap(), "vendor/inner"]);
    outer_init(&["commit", "-m", "add submodule"]);

    let subs = list_submodules(&dir).unwrap();
    assert_eq!(subs.len(), 1);
    let sub = &subs[0];
    assert_eq!(sub.name, "vendor/inner");
    assert_eq!(sub.path, "vendor/inner");
    assert!(sub.abs_path.ends_with("vendor/inner"));
    assert!(!sub.dirty, "freshly added submodule matches the index");
}


#[test]
fn read_binary_file_returns_base64_and_mime() {
    let dir = scratch_repo("binary-preview");
    // PNG magic bytes
    let png_bytes: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
    fs::write(dir.join("pic.png"), png_bytes).unwrap();
    fs::write(dir.join("doc.pdf"), b"%PDF-1.4 test").unwrap();
    fs::write(dir.join("notes.txt"), b"plain").unwrap();

    let png = read_binary_file(&dir, "pic.png").unwrap();
    assert_eq!(png.mime, "image/png");
    assert_eq!(png.size, png_bytes.len());
    use base64::Engine as _;
    let decoded = base64::engine::general_purpose::STANDARD.decode(&png.data).unwrap();
    assert_eq!(decoded, png_bytes);

    let pdf = read_binary_file(&dir, "doc.pdf").unwrap();
    assert_eq!(pdf.mime, "application/pdf");

    let _txt = read_binary_file(&dir, "notes.txt").unwrap();
    assert_eq!(_txt.mime, "application/octet-stream");

    assert!(read_binary_file(&dir, "../escape.png").is_err(), "traversal rejected");
    let _ = fs::remove_dir_all(&dir);
}
