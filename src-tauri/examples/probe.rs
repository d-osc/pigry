//! Debug probe: run git_state::build_state against a real repository path
//! and print the result or the underlying error.
//! Usage: cargo run --example probe -- <repo-path>

fn main() {
    let path = std::env::args().nth(1).expect("pass a repository path");
    match orbit_lib::git_state::build_state(std::path::Path::new(&path)) {
        Ok(state) => {
            println!("OK  org={} name={} branch={}", state.organization, state.name, state.current_branch);
            println!("    files={} branches={} tags={} stashes={}",
                state.files.len(), state.branches.len(), state.tag_total, state.stashes.len());
            for file in &state.files {
                println!("    {} {} +{} -{}", if file.staged { "S" } else { "U" }, file.path, file.additions, file.deletions);
            }
        }
        Err(e) => println!("ERROR: {e}"),
    }
}
