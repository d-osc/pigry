//! GitHub-side insights data through the `gh` CLI — PR/issue delivery metrics
//! for a time window and repository traffic. Kept separate from `gh.rs` so
//! the Insights screen's backend stays independent of the rest of the gh
//! surface. Local git statistics live in `insights.rs`.

use serde::Serialize;
use std::path::Path;
use crate::gh::run_gh;

const DAY: i64 = 86_400;

fn jstr(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Minimal RFC3339 (`2026-11-08T14:24:53Z`) → epoch-seconds parser.
fn rfc3339_epoch(iso: &str) -> Option<i64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || (bytes[10] != b'T' && bytes[10] != b' ') {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { iso.get(from..to)?.parse::<i64>().ok() };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from civil date (Howard Hinnant's algorithm).
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * DAY + hour * 3_600 + minute * 60 + second)
}

/// Median of a non-empty slice, averaging the two middles for even lengths.
fn median(values: &mut Vec<u64>) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        Some(values[mid])
    } else {
        Some((values[mid - 1] + values[mid]) / 2)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhDeliveryStats {
    pub available: bool,
    pub pr_opened: u64,
    pub pr_merged: u64,
    pub pr_closed_unmerged: u64,
    pub pr_open_now: u64,
    pub pr_merged_prev: u64,
    pub issue_opened: u64,
    pub issue_closed: u64,
    pub issue_open_now: u64,
    /// Median seconds from PR creation to merge, current / previous period.
    pub median_merge_seconds: Option<u64>,
    pub median_merge_seconds_prev: Option<u64>,
}

/// Delivery metrics (PRs opened/merged, issues opened/closed, median time to
/// merge) for the current and previous `days` window, via `gh pr/issue list`.
/// Errors when gh is unavailable — the screen falls back to dashes.
pub fn delivery_stats(repo_path: &Path, days: u32) -> Result<GhDeliveryStats, String> {
    let pr_out = run_gh(
        repo_path,
        &[
            "pr",
            "list",
            "--state",
            "all",
            "--limit",
            "300",
            "--json",
            "createdAt,mergedAt,closedAt,state",
        ],
    )?;
    let issue_out = run_gh(
        repo_path,
        &[
            "issue",
            "list",
            "--state",
            "all",
            "--limit",
            "300",
            "--json",
            "createdAt,closedAt,state",
        ],
    )?;

    let now = now_epoch();
    let period_secs = (days as i64).max(1) * DAY;
    let period_start = now - period_secs;

    let mut stats = GhDeliveryStats {
        available: true,
        pr_opened: 0,
        pr_merged: 0,
        pr_closed_unmerged: 0,
        pr_open_now: 0,
        pr_merged_prev: 0,
        issue_opened: 0,
        issue_closed: 0,
        issue_open_now: 0,
        median_merge_seconds: None,
        median_merge_seconds_prev: None,
    };

    if !pr_out.trim().is_empty() {
        let items: Vec<serde_json::Value> =
            serde_json::from_str(&pr_out).map_err(|e| e.to_string())?;
        let mut merge_durations: Vec<u64> = Vec::new();
        let mut merge_durations_prev: Vec<u64> = Vec::new();
        for item in items.iter() {
            let created = rfc3339_epoch(&jstr(item, "createdAt"));
            let merged = rfc3339_epoch(&jstr(item, "mergedAt"));
            let closed = rfc3339_epoch(&jstr(item, "closedAt"));
            let state = jstr(item, "state");
            match merged {
                Some(merged_at) => {
                    if merged_at >= period_start {
                        stats.pr_merged += 1;
                        if let Some(created_at) = created {
                            merge_durations.push((merged_at - created_at).max(0) as u64);
                        }
                    } else if merged_at >= period_start - period_secs {
                        stats.pr_merged_prev += 1;
                        if let Some(created_at) = created {
                            merge_durations_prev.push((merged_at - created_at).max(0) as u64);
                        }
                    }
                }
                None => {
                    if state == "OPEN" || closed.is_none() {
                        stats.pr_open_now += 1;
                    } else if let Some(closed_at) = closed {
                        if closed_at >= period_start {
                            stats.pr_closed_unmerged += 1;
                        }
                    }
                }
            }
            if let Some(created_at) = created {
                if created_at >= period_start {
                    stats.pr_opened += 1;
                }
            }
        }
        stats.median_merge_seconds = median(&mut merge_durations);
        stats.median_merge_seconds_prev = median(&mut merge_durations_prev);
    }

    if !issue_out.trim().is_empty() {
        let items: Vec<serde_json::Value> =
            serde_json::from_str(&issue_out).map_err(|e| e.to_string())?;
        for item in items.iter() {
            let created = rfc3339_epoch(&jstr(item, "createdAt"));
            let closed = rfc3339_epoch(&jstr(item, "closedAt"));
            let state = jstr(item, "state");
            if let Some(created_at) = created {
                if created_at >= period_start {
                    stats.issue_opened += 1;
                }
            }
            if state == "OPEN" || closed.is_none() {
                stats.issue_open_now += 1;
            } else if let Some(closed_at) = closed {
                if closed_at >= period_start {
                    stats.issue_closed += 1;
                }
            }
        }
    }

    Ok(stats)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhTrafficDay {
    /// RFC3339 timestamp of the day bucket.
    pub timestamp: String,
    pub count: u64,
    pub uniques: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhTrafficTotals {
    pub count: u64,
    pub uniques: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhTraffic {
    pub views: GhTrafficTotals,
    pub views_daily: Vec<GhTrafficDay>,
    pub clones: GhTrafficTotals,
    pub clones_daily: Vec<GhTrafficDay>,
}

/// Traffic payload nests totals and the daily list under the same key
/// (`views: { count, uniques, views: [...] }`).
fn parse_traffic_side(out: &str, key: &str) -> Result<(GhTrafficTotals, Vec<GhTrafficDay>), String> {
    if out.trim().is_empty() {
        return Ok((GhTrafficTotals { count: 0, uniques: 0 }, Vec::new()));
    }
    let value: serde_json::Value = serde_json::from_str(out).map_err(|e| e.to_string())?;
    let node = value
        .get(key)
        .ok_or_else(|| format!("missing {key} in traffic payload"))?;
    let totals = GhTrafficTotals {
        count: node
            .get("count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        uniques: node
            .get("uniques")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    };
    let daily = node
        .get(key)
        .and_then(|entries| entries.as_array())
        .map(|entries| {
            entries
                .iter()
                .map(|entry| GhTrafficDay {
                    timestamp: jstr(entry, "timestamp"),
                    count: entry.get("count").and_then(|v| v.as_u64()).unwrap_or(0),
                    uniques: entry.get("uniques").and_then(|v| v.as_u64()).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((totals, daily))
}

/// Repository traffic (views + clones, last 14 days) via the REST API.
/// Requires push access — errors surface in the Traffic tab as a notice.
pub fn traffic(repo_path: &Path) -> Result<GhTraffic, String> {
    let views_out = run_gh(
        repo_path,
        &["api", "repos/:owner/:repo/traffic/views", "--jq", "."],
    )?;
    let clones_out = run_gh(
        repo_path,
        &["api", "repos/:owner/:repo/traffic/clones", "--jq", "."],
    )?;
    let (views, views_daily) = parse_traffic_side(&views_out, "views")?;
    let (clones, clones_daily) = parse_traffic_side(&clones_out, "clones")?;
    Ok(GhTraffic {
        views,
        views_daily,
        clones,
        clones_daily,
    })
}

#[cfg(test)]
mod tests {
    use super::{median, rfc3339_epoch};

    #[test]
    fn parses_rfc3339_utc() {
        assert_eq!(rfc3339_epoch("2026-11-08T14:24:53Z"), Some(1_794_147_893));
        assert_eq!(rfc3339_epoch(""), None);
        assert_eq!(rfc3339_epoch("garbage"), None);
    }

    #[test]
    fn medians() {
        assert_eq!(median(&mut vec![5]), Some(5));
        assert_eq!(median(&mut vec![3, 1, 2]), Some(2));
        assert_eq!(median(&mut vec![4, 1, 3, 2]), Some(2));
        assert_eq!(median(&mut Vec::new()), None);
    }
}
