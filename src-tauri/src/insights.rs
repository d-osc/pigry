//! Repository analytics computed from the local git history — commit counts,
//! contributors and line churn for the Insights screen. Delivery metrics
//! (PRs/issues) live in `gh::delivery_stats`; this module stays offline.

use git2::{DiffOptions, Sort};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// Per-commit diff scans stop here so a 90-day window on a huge repo cannot
/// stall the UI; the totals report how much was actually scanned.
const LINE_SCAN_CAP: usize = 2000;
const DAY: i64 = 86_400;
const BUCKET: i64 = DAY * 7;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsCommitEntry {
    pub oid: String,
    pub summary: String,
    pub author: String,
    pub time_seconds: i64,
    pub is_merge: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsContributor {
    pub name: String,
    pub commits: u64,
    pub additions: u64,
    pub deletions: u64,
}

/// One 7-day bucket; previous-period buckets only carry commit counts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsWeek {
    pub start_seconds: i64,
    pub end_seconds: i64,
    pub commits: u64,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsDay {
    /// UTC midnight of the day.
    pub day_seconds: i64,
    pub commits: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsData {
    pub head_branch: String,
    pub now_seconds: i64,
    pub period_days: u32,
    pub commits: u64,
    pub prev_commits: u64,
    pub contributors: u64,
    pub prev_contributors: u64,
    /// Line churn of the current period (merge commits excluded).
    pub additions: u64,
    pub deletions: u64,
    pub weekly: Vec<InsightsWeek>,
    pub prev_weekly: Vec<InsightsWeek>,
    /// Newest first.
    pub days: Vec<InsightsDay>,
    /// Ranked by commits, descending.
    pub people: Vec<InsightsContributor>,
    /// Newest-first sample of the period for the Activity tab.
    pub recent: Vec<InsightsCommitEntry>,
    pub line_commits_scanned: u64,
    pub line_commits_total: u64,
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Line churn of one commit against its first parent (root commit: empty tree).
fn commit_churn(repo: &git2::Repository, commit: &git2::Commit) -> Option<(u64, u64)> {
    let tree = commit.tree().ok()?;
    let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
    let mut opts = DiffOptions::new();
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        .ok()?;
    let stats = diff.stats().ok()?;
    Some((stats.insertions() as u64, stats.deletions() as u64))
}

/// Builds the insights payload for the last `days` days of HEAD history.
pub fn build_insights(repo_path: &Path, days: u32) -> Result<InsightsData, String> {
    let repo = git2::Repository::discover(repo_path).map_err(|e| e.to_string())?;
    let now = now_epoch();
    let period_secs = (days as i64).max(1) * DAY;
    let period_start = now - period_secs;
    let prev_start = period_start - period_secs;

    let head = match repo.head() {
        Ok(head) => head,
        Err(_) => {
            // Unborn branch / empty repository — an all-zero payload renders
            // the screen's "no commits in this period" state.
            return Ok(InsightsData {
                head_branch: String::new(),
                now_seconds: now,
                period_days: days,
                commits: 0,
                prev_commits: 0,
                contributors: 0,
                prev_contributors: 0,
                additions: 0,
                deletions: 0,
                weekly: Vec::new(),
                prev_weekly: Vec::new(),
                days: Vec::new(),
                people: Vec::new(),
                recent: Vec::new(),
                line_commits_scanned: 0,
                line_commits_total: 0,
            });
        }
    };
    let head_commit = head.peel_to_commit().map_err(|e| e.to_string())?;
    let head_branch = head.shorthand().unwrap_or("HEAD").to_string();

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;
    revwalk.push(head_commit.id()).map_err(|e| e.to_string())?;

    // Weekly buckets start at the period edge and step 7 days; the final
    // bucket is shorter when `days` is not a multiple of 7.
    let week_count = week_count_for(days);
    let make_buckets = |from: i64, until: i64| -> Vec<InsightsWeek> {
        (0..week_count)
            .map(|index| InsightsWeek {
                start_seconds: from + index * BUCKET,
                end_seconds: (from + (index + 1) * BUCKET).min(until),
                commits: 0,
                additions: 0,
                deletions: 0,
            })
            .collect()
    };
    let mut weekly = make_buckets(period_start, now);
    let mut prev_weekly = make_buckets(prev_start, period_start);

    let mut current_commits: u64 = 0;
    let mut prev_commits: u64 = 0;
    // author key → (display name, commits)
    let mut current_people: HashMap<String, (String, u64)> = HashMap::new();
    let mut prev_people: HashMap<String, u64> = HashMap::new();
    // author key → (display name, additions, deletions)
    let mut churn: HashMap<String, (String, u64, u64)> = HashMap::new();
    let mut day_counts: HashMap<i64, u64> = HashMap::new();
    let mut recent: Vec<InsightsCommitEntry> = Vec::new();
    let mut additions_total: u64 = 0;
    let mut deletions_total: u64 = 0;
    let mut line_commits_total: u64 = 0;
    let mut line_commits_scanned: u64 = 0;

    for oid in revwalk {
        let Ok(oid) = oid else { break };
        let Ok(commit) = repo.find_commit(oid) else { continue };
        let time = commit.time().seconds();
        if time < prev_start {
            break; // TIME-sorted walk — everything older is out of scope
        }

        let author = commit.author();
        let name = author.name().unwrap_or("Unknown").trim().to_string();
        let name = if name.is_empty() { "Unknown".to_string() } else { name };
        let key = name.to_lowercase();

        if time >= period_start {
            current_commits += 1;
            current_people
                .entry(key.clone())
                .or_insert_with(|| (name.clone(), 0))
                .1 += 1;

            *day_counts.entry(time - time.rem_euclid(DAY)).or_insert(0) += 1;

            let week_index =
                ((time - period_start) / BUCKET).clamp(0, week_count - 1) as usize;
            weekly[week_index].commits += 1;

            let is_merge = commit.parent_count() > 1;
            if recent.len() < 30 {
                recent.push(InsightsCommitEntry {
                    oid: oid.to_string(),
                    summary: commit.summary().unwrap_or("").to_string(),
                    author: name.clone(),
                    time_seconds: time,
                    is_merge,
                });
            }

            if !is_merge {
                line_commits_total += 1;
                if (line_commits_scanned as usize) < LINE_SCAN_CAP {
                    if let Some((added, removed)) = commit_churn(&repo, &commit) {
                        line_commits_scanned += 1;
                        additions_total += added;
                        deletions_total += removed;
                        weekly[week_index].additions += added;
                        weekly[week_index].deletions += removed;
                        let entry = churn
                            .entry(key.clone())
                            .or_insert_with(|| (name.clone(), 0, 0));
                        entry.1 += added;
                        entry.2 += removed;
                    }
                }
            }
        } else {
            prev_commits += 1;
            *prev_people.entry(key).or_insert(0) += 1;
            let week_index = ((time - prev_start) / BUCKET).clamp(0, week_count - 1) as usize;
            prev_weekly[week_index].commits += 1;
        }
    }

    let mut people: Vec<InsightsContributor> = current_people
        .into_iter()
        .map(|(key, (name, commits))| {
            let churn = churn.get(&key).cloned().unwrap_or_default();
            InsightsContributor {
                name,
                commits,
                additions: churn.1,
                deletions: churn.2,
            }
        })
        .collect();
    people.sort_by(|a, b| b.commits.cmp(&a.commits).then(a.name.cmp(&b.name)));

    let mut days_out: Vec<InsightsDay> = {
        let first_day = period_start - period_start.rem_euclid(DAY);
        let mut day = first_day;
        let mut out = Vec::new();
        while day <= now {
            out.push(InsightsDay {
                day_seconds: day,
                commits: *day_counts.get(&day).unwrap_or(&0),
            });
            day += DAY;
        }
        out
    };
    days_out.reverse(); // newest first

    Ok(InsightsData {
        head_branch,
        now_seconds: now,
        period_days: days,
        commits: current_commits,
        prev_commits,
        contributors: people.len() as u64,
        prev_contributors: prev_people.len() as u64,
        additions: additions_total,
        deletions: deletions_total,
        weekly,
        prev_weekly,
        days: days_out,
        people,
        recent,
        line_commits_scanned,
        line_commits_total,
    })
}

#[cfg(test)]
mod tests {
    use super::week_count_for;

    #[test]
    fn week_counts() {
        assert_eq!(week_count_for(7), 1);
        assert_eq!(week_count_for(28), 4);
        assert_eq!(week_count_for(90), 13); // 12 full weeks + 6 days
    }
}

/// `ceil(days / 7)` — exposed for the unit test above.
fn week_count_for(days: u32) -> i64 {
    ((days as i64).max(1) + 6) / 7
}
