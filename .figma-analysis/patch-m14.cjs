const fs = require('fs');
let s = fs.readFileSync('src-tauri/src/git_state.rs', 'utf8');

// 1) Remove the OLD 2-arg file_hunks (its doc comment + full body).
const oldFnStart = '/// Lists the unstaged hunks for a file (index → workdir), including\n/// untracked files whose whole content is one hunk.\npub fn file_hunks(repo_path: &Path, path: &str) -> Result<Vec<HunkInfo>> {';
const startIdx = s.indexOf(oldFnStart);
if (startIdx === -1) { console.error('old file_hunks NOT FOUND'); process.exit(1); }
// Find the closing brace of this function: first "\n}\n" after startIdx.
const closeIdx = s.indexOf('\n}\n', startIdx);
if (closeIdx === -1) { console.error('closing brace NOT FOUND'); process.exit(1); }
const oldBlock = s.slice(startIdx, closeIdx + 3);
// Sanity: the old block must NOT contain "if staged".
if (oldBlock.includes('if staged')) { console.error('matched the NEW fn by mistake'); process.exit(1); }
s = s.replace(oldBlock, '');
console.log('old file_hunks removed');

// 2) New file_hunks needs mut diff for find_similar.
const mutTarget = '    let diff = if staged {';
if (!s.includes(mutTarget)) { console.error('new fn diff NOT FOUND'); process.exit(1); }
s = s.replace(mutTarget, '    let mut diff = if staged {');
console.log('mut fixed');

// 3) Replace the IndexEntry::default() fallback with explicit construction.
const oldEntry = `        None => {
            // The path has no index entry (added file fully emptied above is
            // handled; this branch covers partial unstage of an added file).
            let mut entry = git2::IndexEntry::default();
            entry.path = std::path::PathBuf::from(path);
            entry.mode = 0o100644;
            index
                .add_frombuffer(&entry, new_content.as_bytes())
                .map_err(|e| format!("failed to unstage hunk: {e}"))?;
        }`;
const neuEntry = `        None => {
            // The path has no index entry (added file fully emptied above is
            // handled; this branch covers partial unstage of an added file).
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o100644,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: git2::Oid::zero(),
                path: path.as_bytes().to_vec(),
                flags: 0,
                flags_extended: 0,
            };
            index
                .add_frombuffer(&entry, new_content.as_bytes())
                .map_err(|e| format!("failed to unstage hunk: {e}"))?;
        }`;
if (!s.includes(oldEntry)) { console.error('entry fallback NOT FOUND'); process.exit(1); }
s = s.replace(oldEntry, neuEntry);
console.log('IndexEntry construction fixed');

fs.writeFileSync('src-tauri/src/git_state.rs', s);
console.log('all fixed');
