//! Raw material for an AI-written pull request description: the commits the
//! compare branch adds, each changed file's patch against the merge base (the
//! diff GitHub shows on the pull request) and the repository's pull request
//! template. Read-only: nothing touches the index or the working tree.

use std::path::Path;

use serde::Serialize;

use super::{err, Result};

const MAX_COMMITS: usize = 200;
/// Whole-diff cap so a huge branch never floods the IPC bridge; the frontend
/// trims further to the model's budget.
const MAX_TOTAL_PATCH_BYTES: usize = 400_000;
const MAX_FILE_PATCH_BYTES: usize = 40_000;
const MAX_TEMPLATE_BYTES: usize = 20_000;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrDraftCommit {
    pub short_oid: String,
    /// The full commit message (summary and body).
    pub message: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrDraftFile {
    pub path: String,
    pub previous_path: Option<String>,
    /// A, M, D, R or T.
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    /// Unified patch of this file; empty for binary files or past the total cap.
    pub patch: String,
    /// True when `patch` was cut short (or left out) by the caps above.
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrDraftTemplate {
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrDraftContext {
    pub merge_base_oid: Option<String>,
    /// Oldest first; merge commits are left out.
    pub commits: Vec<PrDraftCommit>,
    pub files: Vec<PrDraftFile>,
    pub template: Option<PrDraftTemplate>,
}

fn cut(text: &mut String, max: usize) -> bool {
    if text.len() <= max {
        return false;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    // End on a whole line so the model never sees half a hunk line.
    if let Some(newline) = text[..end].rfind('\n') {
        end = newline + 1;
    }
    text.truncate(end);
    true
}

/// GitHub's template locations: the root, `.github/` and `docs/`, any case, plus
/// the first file of a `PULL_REQUEST_TEMPLATE/` folder in those places.
fn find_template(repo: &git2::Repository, root: &git2::Tree) -> Option<PrDraftTemplate> {
    let read = |entry: &git2::TreeEntry, path: String| -> Option<PrDraftTemplate> {
        let blob = entry.to_object(repo).ok()?.peel_to_blob().ok()?;
        if blob.is_binary() {
            return None;
        }
        let mut content = String::from_utf8_lossy(blob.content()).into_owned();
        cut(&mut content, MAX_TEMPLATE_BYTES);
        (!content.trim().is_empty()).then_some(PrDraftTemplate { path, content })
    };
    let subtree = |dir: &str| -> Option<git2::Tree> {
        if dir.is_empty() {
            return Some(root.clone());
        }
        root.iter()
            .find(|entry| entry.name().is_some_and(|name| name.eq_ignore_ascii_case(dir)))?
            .to_object(repo)
            .ok()?
            .peel_to_tree()
            .ok()
    };
    for dir in [".github", "", "docs"] {
        let Some(tree) = subtree(dir) else { continue };
        let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        for entry in tree.iter() {
            let Some(name) = entry.name() else { continue };
            let lower = name.to_ascii_lowercase();
            if matches!(lower.as_str(), "pull_request_template.md" | "pull_request_template.txt" | "pull_request_template") {
                if let Some(found) = read(&entry, format!("{prefix}{name}")) {
                    return Some(found);
                }
            }
        }
        let folder = tree.iter().find(|entry| {
            entry.name().is_some_and(|name| name.eq_ignore_ascii_case("pull_request_template"))
                && entry.kind() == Some(git2::ObjectType::Tree)
        });
        if let Some(folder) = folder {
            let folder_name = folder.name().unwrap_or("PULL_REQUEST_TEMPLATE").to_string();
            if let Some(inner) = folder.to_object(repo).ok().and_then(|object| object.peel_to_tree().ok()) {
                let mut names: Vec<_> = inner
                    .iter()
                    .filter(|entry| entry.name().is_some_and(|name| name.to_ascii_lowercase().ends_with(".md")))
                    .collect();
                names.sort_by(|a, b| a.name().cmp(&b.name()));
                for entry in names {
                    let path = format!("{prefix}{folder_name}/{}", entry.name().unwrap_or_default());
                    if let Some(found) = read(&entry, path) {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

/// Everything the pull request from `compare_ref` into `base_ref` would contain.
pub fn pr_draft_context(repo_path: &Path, base_ref: &str, compare_ref: &str) -> Result<PrDraftContext> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    let resolve = |name: &str| {
        if !name.starts_with("refs/heads/") && !name.starts_with("refs/remotes/") {
            return Err(format!("Invalid branch reference: {name}"));
        }
        repo.find_reference(name)
            .and_then(|reference| reference.peel_to_commit())
            .map_err(|error| format!("Could not resolve {name}: {}", error.message()))
    };
    let base = resolve(base_ref)?;
    let compare = resolve(compare_ref)?;
    let merge_base = repo.merge_base(base.id(), compare.id()).ok();
    let from = match merge_base {
        Some(oid) => repo.find_commit(oid).map_err(err)?,
        None => base.clone(),
    };

    let mut commits = Vec::new();
    let mut walk = repo.revwalk().map_err(err)?;
    walk.push(compare.id()).map_err(err)?;
    walk.hide(base.id()).map_err(err)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE).map_err(err)?;
    for oid in walk.flatten() {
        let Ok(commit) = repo.find_commit(oid) else { continue };
        if commit.parent_count() > 1 {
            continue;
        }
        let short_oid = commit
            .as_object()
            .short_id()
            .ok()
            .and_then(|buf| buf.as_str().map(str::to_string))
            .unwrap_or_else(|| oid.to_string()[..7].to_string());
        commits.push(PrDraftCommit {
            short_oid,
            message: String::from_utf8_lossy(commit.message_bytes()).trim().to_string(),
        });
    }
    if commits.len() > MAX_COMMITS {
        // Keep the newest ones: they describe where the branch ended up.
        commits.drain(..commits.len() - MAX_COMMITS);
    }

    let mut options = git2::DiffOptions::new();
    options.include_typechange(true);
    let mut diff = repo
        .diff_tree_to_tree(
            Some(&from.tree().map_err(err)?),
            Some(&compare.tree().map_err(err)?),
            Some(&mut options),
        )
        .map_err(err)?;
    let mut find = git2::DiffFindOptions::new();
    find.renames(true);
    let _ = diff.find_similar(Some(&mut find));

    let mut files = Vec::new();
    let mut total = 0usize;
    for index in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(index) else { continue };
        let path_of = |file: git2::DiffFile| file.path().map(|p| p.to_string_lossy().replace('\\', "/"));
        let path = path_of(delta.new_file()).or_else(|| path_of(delta.old_file())).unwrap_or_default();
        let old_path = path_of(delta.old_file());
        let status = match delta.status() {
            git2::Delta::Added => "A",
            git2::Delta::Deleted => "D",
            git2::Delta::Renamed => "R",
            git2::Delta::Typechange => "T",
            _ => "M",
        };
        let mut binary = delta.flags().is_binary();
        let (mut additions, mut deletions, mut patch) = (0, 0, String::new());
        match git2::Patch::from_diff(&diff, index).map_err(err)? {
            Some(mut found) => {
                let (_, adds, dels) = found.line_stats().map_err(err)?;
                additions = adds;
                deletions = dels;
                binary = binary || found.delta().flags().is_binary();
                if !binary {
                    patch = String::from_utf8_lossy(&found.to_buf().map_err(err)?).into_owned();
                }
            }
            None => binary = true,
        }
        let mut truncated = cut(&mut patch, MAX_FILE_PATCH_BYTES);
        if total >= MAX_TOTAL_PATCH_BYTES && !patch.is_empty() {
            patch.clear();
            truncated = true;
        } else if cut(&mut patch, MAX_TOTAL_PATCH_BYTES - total) {
            truncated = true;
        }
        total += patch.len();
        files.push(PrDraftFile {
            previous_path: old_path.filter(|old| status == "R" && *old != path),
            path,
            status: status.to_string(),
            additions,
            deletions,
            binary,
            patch,
            truncated,
        });
    }

    let template = compare.tree().ok().and_then(|tree| find_template(&repo, &tree));
    Ok(PrDraftContext {
        merge_base_oid: merge_base.map(|oid| oid.to_string()),
        commits,
        files,
        template,
    })
}
