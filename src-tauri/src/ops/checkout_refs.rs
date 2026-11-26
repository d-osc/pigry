//! Branch / tag picker in the status bar: every local branch, remote branch and tag (most recent
//! first), and checking out a tag as a detached HEAD.

use std::path::Path;

use serde::Serialize;

use super::Result;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRef {
    /// "local", "remote" or "tag".
    pub kind: String,
    /// Short name: "main", "origin/feature/x", "v1.2.0".
    pub name: String,
    /// For remote branches: the remote ("origin") and the branch name without it ("feature/x").
    pub remote: Option<String>,
    pub branch: Option<String>,
    /// Abbreviated commit the ref points at (tags are peeled to their commit).
    pub short_oid: String,
    pub subject: String,
    pub time_seconds: i64,
    pub is_head: bool,
}

/// Every ref the picker can check out, newest commit first.
pub fn list_checkout_refs(repo_path: &Path) -> Result<Vec<CheckoutRef>> {
    let current = crate::gitcli::current_branch(repo_path).unwrap_or_default();
    let output = crate::gitcli::run_git(repo_path, &[
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)%00%(objectname:short)%00%(*objectname:short)%00%(committerdate:unix)%00%(*committerdate:unix)%00%(subject)%00%(*subject)",
        "refs/heads", "refs/remotes", "refs/tags",
    ])?;
    let mut refs = Vec::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split('\0').collect();
        if fields.len() < 7 {
            continue;
        }
        let refname = fields[0];
        // Annotated tags: use the commit they point at (the starred fields).
        let pick = |own: &str, peeled: &str| if peeled.is_empty() { own.to_string() } else { peeled.to_string() };
        let short_oid = pick(fields[1], fields[2]);
        let time_seconds = pick(fields[3], fields[4]).parse().unwrap_or(0);
        let subject = pick(fields[5], fields[6]);
        let (kind, name, remote, branch) = if let Some(name) = refname.strip_prefix("refs/heads/") {
            ("local", name.to_string(), None, None)
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            let Some((remote, branch)) = name.split_once('/') else { continue };
            if branch == "HEAD" {
                continue;
            }
            ("remote", name.to_string(), Some(remote.to_string()), Some(branch.to_string()))
        } else if let Some(name) = refname.strip_prefix("refs/tags/") {
            ("tag", name.to_string(), None, None)
        } else {
            continue;
        };
        refs.push(CheckoutRef {
            kind: kind.into(),
            is_head: kind == "local" && name == current,
            name,
            remote,
            branch,
            short_oid,
            subject,
            time_seconds,
        });
    }
    Ok(refs)
}

/// Checks out a tag as a detached HEAD. Git refuses when local changes would be overwritten.
pub fn checkout_tag(repo_path: &Path, name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(format!("'{name}' is not a tag name"));
    }
    let full = format!("refs/tags/{name}");
    crate::gitcli::run_git(repo_path, &["rev-parse", "--verify", "--quiet", &format!("{full}^{{commit}}")])
        .map_err(|_| format!("tag '{name}' not found"))?;
    crate::gitcli::run_git(repo_path, &["checkout", "--detach", &full]).map_err(|e| {
        if e.contains("would be overwritten") || e.contains("untracked working tree") {
            format!("cannot checkout '{name}': your local changes would be overwritten — commit or stash first")
        } else {
            e
        }
    })?;
    Ok(())
}
