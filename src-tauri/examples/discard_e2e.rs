//! Discard-hunk E2E at the API level: exercises the exact same
//! git_state::discard_hunk the UI button invokes, against the scratch file
//! with two hunks, verifying with git diff afterwards.

fn main() {
    let repo = "C:\\Users\\ondev\\Projects\\pigry";
    let path = "scratch-hunks.txt";

    // Show the two hunks the UI would list.
    let hunks = pigry_lib::git_state::file_hunks(std::path::Path::new(repo), path, false)
        .expect("file_hunks failed");
    println!("hunks: {}", hunks.len());
    for h in &hunks {
        println!(
            "  #{} @@ -{},{} +{},{} @@ {} preview={}",
            h.index, h.old_start, h.old_lines, h.new_start, h.new_lines, h.context, h.preview
        );
    }

    // Discard hunk 0 (the line-1 edit) — same as clicking its button.
    pigry_lib::git_state::discard_hunk(std::path::Path::new(repo), path, 0)
        .expect("discard_hunk failed");
    println!("discarded hunk 0");

    // Verify: git diff must now show only the line-20 edit.
    let out = std::process::Command::new("git")
        .arg("-C").arg(repo)
        .args(["diff", "--", path])
        .output()
        .expect("git diff failed");
    let diff = String::from_utf8_lossy(&out.stdout);
    let has_line1_edit = diff.contains("edited line 1");
    let has_line20_edit = diff.contains("edited line 20");
    println!("after discard: line1 edit still in diff = {}", has_line1_edit);
    println!("after discard: line20 edit still in diff = {}", has_line20_edit);
    if has_line1_edit {
        println!("FAIL: hunk 0 was not discarded");
        std::process::exit(1);
    }
    if !has_line20_edit {
        println!("FAIL: hunk 1 should remain");
        std::process::exit(1);
    }
    println!("OK: hunk 0 discarded, hunk 1 intact");
}
