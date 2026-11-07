//! Tests for settings.rs — identity + remote management on scratch repos.

use std::fs;
use std::path::PathBuf;

use git2::Repository;

use super::*;

fn scratch_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("orbit-settings-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    dir
}

#[test]
fn user_info_roundtrip_writes_local_config() {
    let dir = scratch_repo("identity");
    set_user_info(&dir, "Orbit Dev", "dev@orbit.app").unwrap();
    let info = get_user_info(&dir).unwrap();
    assert_eq!(info.name.as_deref(), Some("Orbit Dev"));
    assert_eq!(info.email.as_deref(), Some("dev@orbit.app"));

    // The local config file itself carries the values.
    let raw = fs::read_to_string(dir.join(".git").join("config")).unwrap();
    assert!(raw.contains("dev@orbit.app"));
}

#[test]
fn set_user_info_trims_and_rejects_bad_input() {
    let dir = scratch_repo("identity-bad");
    // Trimmed values persist.
    set_user_info(&dir, "  Padded  ", " p@x.io ").unwrap();
    let info = get_user_info(&dir).unwrap();
    assert_eq!(info.name.as_deref(), Some("Padded"));

    assert!(set_user_info(&dir, "", "a@b.io").is_err());
    assert!(set_user_info(&dir, "n", "").is_err());
    assert!(set_user_info(&dir, "n", "not-an-email").is_err());
}

#[test]
fn remote_add_set_url_remove_roundtrip() {
    let dir = scratch_repo("remotes");
    assert!(list_remotes(&dir).unwrap().is_empty());

    add_remote(&dir, "origin", "https://example.com/a.git").unwrap();
    add_remote(&dir, "upstream", "https://example.com/b.git").unwrap();

    let remotes = list_remotes(&dir).unwrap();
    let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
    assert_eq!(origin.url, "https://example.com/a.git");

    set_remote_url(&dir, "origin", "https://example.com/new.git").unwrap();
    let remotes = list_remotes(&dir).unwrap();
    let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
    assert_eq!(origin.url, "https://example.com/new.git");

    remove_remote(&dir, "upstream").unwrap();
    let remotes = list_remotes(&dir).unwrap();
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");

    // Duplicate names and unknown remotes fail with git's message.
    assert!(add_remote(&dir, "origin", "https://example.com/x.git").is_err());
    assert!(remove_remote(&dir, "ghost").is_err());
    assert!(add_remote(&dir, "", "https://example.com/x.git").is_err());
    assert!(set_remote_url(&dir, "origin", "").is_err());
}
