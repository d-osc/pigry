use super::*;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pigry-network-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap(); Self(path)
    }
}
impl Drop for Sandbox { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn git(path: &PathBuf, args: &[&str]) -> String { run_git_timed(path,args).unwrap() }
fn setup() -> (Sandbox, PathBuf, PathBuf) {
    let sandbox = Sandbox::new();
    let remote = sandbox.0.join("remote.git"); let local = sandbox.0.join("local");
    fs::create_dir(&remote).unwrap(); fs::create_dir(&local).unwrap();
    git(&remote, &["init", "--bare"]); git(&local, &["init", "-b", "main"]);
    git(&local, &["config", "user.name", "Pigry Test"]); git(&local, &["config", "user.email", "test@example.invalid"]);
    git(&local, &["remote", "add", "origin", remote.to_str().unwrap()]);
    commit(&local, "initial"); (sandbox, remote, local)
}
fn commit(path: &PathBuf, text: &str) {
    fs::write(path.join("file.txt"), text).unwrap(); git(path, &["add", "file.txt"]); git(path, &["commit", "-m", text]);
}
#[test]
fn publish_push_fetch_and_fast_forward_pull() {
    let (_sandbox, remote, local) = setup();
    push(&local, "main", false).unwrap();
    assert_eq!(git(&local, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/main");
    let other = local.parent().unwrap().join("other"); fs::create_dir(&other).unwrap();
    git(&other, &["clone", "--branch", "main", remote.to_str().unwrap(), "."]);
    git(&other, &["config", "user.name", "Other"]); git(&other, &["config", "user.email", "other@example.invalid"]);
    commit(&other, "remote update"); push(&other, "main", true).unwrap();
    fetch(&local).unwrap(); pull(&local).unwrap(); assert_eq!(fs::read_to_string(local.join("file.txt")).unwrap(), "remote update");
    commit(&local, "local update"); push(&local, "main", true).unwrap();
}
#[test]
fn divergent_pull_preserves_head_and_worktree() {
    let (_sandbox, remote, local) = setup(); push(&local, "main", false).unwrap();
    let other = local.parent().unwrap().join("other"); fs::create_dir(&other).unwrap();
    git(&other, &["clone", "--branch", "main", remote.to_str().unwrap(), "."]);
    git(&other, &["config", "user.name", "Other"]); git(&other, &["config", "user.email", "other@example.invalid"]);
    commit(&other, "remote"); push(&other, "main", true).unwrap(); commit(&local, "local");
    let head = git(&local, &["rev-parse", "HEAD"]);
    assert!(pull(&local).is_err()); assert_eq!(git(&local, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read_to_string(local.join("file.txt")).unwrap(), "local");
    assert!(push(&local, "main", true).is_err());
}
#[test]
fn denied_push_reports_error_and_can_recover() {
    let (_sandbox, remote, local) = setup();
    fs::write(remote.join("hooks/pre-receive"), "#!/bin/sh\necho 'permission denied: test server rejects credentials' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; fs::set_permissions(remote.join("hooks/pre-receive"), fs::Permissions::from_mode(0o755)).unwrap(); }
    let error = push(&local, "main", false).err().unwrap(); assert!(error.contains("permission denied"), "{error}");
    fs::remove_file(remote.join("hooks/pre-receive")).unwrap(); push(&local, "main", false).unwrap();
}
#[test]
fn missing_remote_is_actionable() {
    let (_sandbox, _remote, local) = setup(); git(&local, &["remote", "remove", "origin"]);
    assert!(push(&local, "main", false).err().unwrap().contains("origin"));
}
#[test]
fn timeout_returns_without_waiting_for_hung_git() {
    let (_sandbox, _remote, local) = setup();
    let started = Instant::now();
    let error = run_git_with_timeout(&local, &["-c", "alias.pigry-wait=!sleep 5", "pigry-wait"], Duration::from_millis(100)).err().unwrap();
    assert!(error.contains("timed out")); assert!(started.elapsed() < Duration::from_secs(4));
}
