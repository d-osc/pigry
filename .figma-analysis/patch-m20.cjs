const fs = require('fs');
let s = fs.readFileSync('src-tauri/src/ops/tests.rs', 'utf8');

// Replace all git_cli commit sequences with git2-based commits
const replacements = [
  // Revert test: initial commit
  {
    old: [
      '    // Create a commit with changes.',
      '    fs::write(dir.join("file.txt"), "original\\n").unwrap();',
      '    git_cli(&dir, &["add", "."]);',
      '    git_cli(&dir, &["commit", "-m", "add file"]);',
    ],
    neu: [
      '    // Create a commit with changes using git2.',
      '    fs::write(dir.join("file.txt"), "original\\n").unwrap();',
      '    let repo = Repository::open(&dir).unwrap();',
      '    let mut index = repo.index().unwrap();',
      '    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();',
      '    index.write().unwrap();',
      '    let tree_oid = index.write_tree().unwrap();',
      '    let tree = repo.find_tree(tree_oid).unwrap();',
      '    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();',
      '    repo.commit(Some("HEAD"), &sig, &sig, "add file", &tree, &[]).unwrap();',
      '    drop(repo);',
    ],
  },
  // Cherry-pick test: base commit
  {
    old: [
      '    fs::write(dir.join("base.txt"), "base\\n").unwrap();',
      '    git_cli(&dir, &["add", "."]);',
      '    git_cli(&dir, &["commit", "-m", "base"]);',
    ],
    neu: [
      '    fs::write(dir.join("base.txt"), "base\\n").unwrap();',
      '    let repo = Repository::open(&dir).unwrap();',
      '    let mut index = repo.index().unwrap();',
      '    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();',
      '    index.write().unwrap();',
      '    let tree_oid = index.write_tree().unwrap();',
      '    let tree = repo.find_tree(tree_oid).unwrap();',
      '    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();',
      '    repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[]).unwrap();',
      '    drop(repo);',
    ],
  },
  // Cherry-pick test: feature commit
  {
    old: [
      '    fs::write(dir.join("feature.txt"), "feature content\\n").unwrap();',
      '    git_cli(&dir, &["add", "."]);',
      '    git_cli(&dir, &["commit", "-m", "add feature file"]);',
    ],
    neu: [
      '    fs::write(dir.join("feature.txt"), "feature content\\n").unwrap();',
      '    let repo = Repository::open(&dir).unwrap();',
      '    let mut index = repo.index().unwrap();',
      '    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();',
      '    index.write().unwrap();',
      '    let tree_oid = index.write_tree().unwrap();',
      '    let tree = repo.find_tree(tree_oid).unwrap();',
      '    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();',
      '    repo.commit(Some("HEAD"), &sig, &sig, "add feature file", &tree, &[]).unwrap();',
      '    drop(repo);',
    ],
  },
  // Merge test: base commit
  {
    old: [
      '    fs::write(dir.join("a.txt"), "1\\n").unwrap();',
      '    git_cli(&dir, &["add", "."]);',
      '    git_cli(&dir, &["commit", "-m", "base"]);',
    ],
    neu: [
      '    fs::write(dir.join("a.txt"), "1\\n").unwrap();',
      '    let repo = Repository::open(&dir).unwrap();',
      '    let mut index = repo.index().unwrap();',
      '    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();',
      '    index.write().unwrap();',
      '    let tree_oid = index.write_tree().unwrap();',
      '    let tree = repo.find_tree(tree_oid).unwrap();',
      '    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();',
      '    repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[]).unwrap();',
      '    drop(repo);',
    ],
  },
  // Merge test: feature commit
  {
    old: [
      '    fs::write(dir.join("b.txt"), "feature\\n").unwrap();',
      '    git_cli(&dir, &["add", "."]);',
      '    git_cli(&dir, &["commit", "-m", "feature work"]);',
    ],
    neu: [
      '    fs::write(dir.join("b.txt"), "feature\\n").unwrap();',
      '    let repo = Repository::open(&dir).unwrap();',
      '    let mut index = repo.index().unwrap();',
      '    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();',
      '    index.write().unwrap();',
      '    let tree_oid = index.write_tree().unwrap();',
      '    let tree = repo.find_tree(tree_oid).unwrap();',
      '    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();',
      '    let head = repo.head().unwrap().peel_to_commit().unwrap();',
      '    repo.commit(Some("HEAD"), &sig, &sig, "feature work", &tree, &[&head]).unwrap();',
      '    drop(repo);',
    ],
  },
  // Clone test: initial commit + push
  {
    old: [
      '    fs::write(work.join("data.txt"), "hello\\n").unwrap();',
      '    git_cli(&work, &["add", "."]);',
      '    git_cli(&work, &["commit", "-m", "initial"]);',
    ],
    neu: [
      '    fs::write(work.join("data.txt"), "hello\\n").unwrap();',
      '    let repo = Repository::open(&work).unwrap();',
      '    let mut index = repo.index().unwrap();',
      '    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();',
      '    index.write().unwrap();',
      '    let tree_oid = index.write_tree().unwrap();',
      '    let tree = repo.find_tree(tree_oid).unwrap();',
      '    let sig = git2::Signature::now("Test User", "test@orbit.dev").unwrap();',
      '    repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();',
      '    drop(repo);',
    ],
  },
];

let count = 0;
for (const r of replacements) {
  const oldStr = r.old.join('\n');
  const neuStr = r.neu.join('\n');
  if (s.includes(oldStr)) {
    s = s.split(oldStr).join(neuStr);
    count++;
  }
}
fs.writeFileSync('src-tauri/src/ops/tests.rs', s);
console.log('replaced', count, 'of', replacements.length, 'blocks');
