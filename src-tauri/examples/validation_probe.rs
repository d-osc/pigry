//! Read-only validation of the same Rust functions used by desktop commands.
pub use pigry_lib::CommandNoWindow;
#[path = "../src/gh.rs"]
#[allow(dead_code)]
mod gh;

use std::{path::Path, time::Instant};

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).ok_or("expected github or large")?;
    let repo = Path::new(args.get(2).ok_or("expected repository path")?);
    if mode == "github" {
        let prs = gh::pr_list(repo)?;
        let workflows = gh::workflow_list(repo)?;
        let runs = gh::run_list(repo, 5)?;
        let pr_detail = if let Some(pr) = prs.first() { gh::pr_detail(repo, pr.number)?; true } else { false };
        let run_detail = if let Some(run) = runs.runs.first() { gh::run_view(repo, run.id)?; true } else { false };
        println!("{}", serde_json::json!({"prs": prs.len(), "workflows": workflows.len(), "runs": runs.runs.len(), "prDetail": pr_detail, "runDetail": run_detail}));
    } else if mode == "file-history" {
        let path = args.get(3).ok_or("expected file path")?;
        let start = Instant::now();
        let rows = pigry_lib::git_state::build_file_history(repo, path, None)?;
        println!("{}", serde_json::json!({"fileHistoryMs":start.elapsed().as_millis(),"rows":rows.len()}));
    } else if mode == "large" {
        let cycles = args.get(3).and_then(|x| x.parse::<usize>().ok()).unwrap_or(100);
        for cycle in 0..cycles {
            let start = Instant::now();
            let state = pigry_lib::git_state::build_state(repo)?;
            let state_ms = start.elapsed().as_millis();
            let start = Instant::now();
            let history = pigry_lib::git_state::build_commit_history(repo, true)?;
            let history_ms = start.elapsed().as_millis();
            let start = Instant::now();
            let tree = pigry_lib::git_state::list_tree(repo)?;
            println!("{}", serde_json::json!({"cycle": cycle, "stateMs": state_ms, "historyMs": history_ms, "treeMs": start.elapsed().as_millis(), "changes": state.files.len(), "commits": history.total, "historyRows": history.commits.len(), "files": tree.entries.len()}));
        }
    } else { return Err("unknown validation mode".into()); }
    Ok(())
}
