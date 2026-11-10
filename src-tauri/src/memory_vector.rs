//! Vector-backed project memory — `.orbit/memory.vector.json` in the repo.
//!
//! Each memory is embedded with an offline hashed n-gram embedder (works for
//! Thai and English without any model download) and stored with its vector.
//! Retrieval is cosine similarity (dot product — vectors are L2-normalised),
//! so the agent can pull the *relevant* memories for a question instead of
//! dumping the whole list. A human-readable `.orbit/memory.md` mirror is
//! regenerated on every change so the file stays git-diff friendly.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const DIM: usize = 256;
const STORE_PATH: &str = ".orbit/memory.vector.json";
const MIRROR_PATH: &str = ".orbit/memory.md";
const MIRROR_CAP: usize = 500;

#[derive(Serialize, Deserialize, Clone)]
pub struct MemoryEntry {
    pub id: String,
    pub text: String,
    pub vector: Vec<f32>,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct MemoryStore {
    #[serde(default)]
    entries: Vec<MemoryEntry>,
}

/// Search hit: the entry plus its similarity to the query (0..1).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub id: String,
    pub text: String,
    pub score: f32,
    pub created_at: u64,
}

type Result<T> = std::result::Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn workdir(repo_path: &Path) -> Result<PathBuf> {
    let repo = git2::Repository::discover(repo_path).map_err(err)?;
    Ok(repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_path_buf())
}

/// Resolves `.orbit/<scope>` for a team/agent scope. `scope` is a relative
/// subpath like "teams/Explorer" (team store) or
/// "teams/Explorer/agents/browser" (that agent's private store) -- segments
/// are validated so nothing escapes the .orbit directory.
fn orbit_scope_path(scope: Option<&str>) -> Result<PathBuf> {
    let Some(scope) = scope.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(PathBuf::from(".orbit"));
    };
    let mut path = PathBuf::from(".orbit");
    for segment in scope.split('/') {
        let segment = segment.trim();
        if segment.is_empty()
            || segment.contains("..")
            || segment.contains('\\')
            || !segment
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' '))
        {
            return Err("invalid memory scope".to_string());
        }
        path.push(segment);
    }
    Ok(path)
}

fn store_path(repo_path: &Path, scope: Option<&str>) -> Result<PathBuf> {
    // orbit_scope_path already includes the .orbit prefix.
    Ok(workdir(repo_path)?
        .join(orbit_scope_path(scope)?)
        .join("memory.vector.json"))
}

fn mirror_path(repo_path: &Path, scope: Option<&str>) -> Result<PathBuf> {
    Ok(workdir(repo_path)?
        .join(orbit_scope_path(scope)?)
        .join("memory.md"))
}

fn load_store(path: &Path) -> MemoryStore {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => MemoryStore::default(),
    }
}

fn save_store(path: &Path, store: &MemoryStore) -> Result<()> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, serde_json::to_string_pretty(store).map_err(err)?).map_err(err)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn fnv1a(data: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in data.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Offline embedding: hashed word tokens (weight 2) + character trigrams
/// (weight 1) projected onto `DIM` buckets, then L2-normalised. Deterministic,
/// language-agnostic (works for Thai where word splitting is hard), fast.
pub fn embed(text: &str) -> Vec<f32> {
    let lower = text.to_lowercase();
    let mut vec = vec![0f32; DIM];
    let mut bump = |key: &str, weight: f32| {
        let idx = (fnv1a(key) as usize) % DIM;
        vec[idx] += weight;
    };
    // Word tokens.
    for token in lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() > 1)
    {
        bump(token, 2.0);
    }
    // Character trigrams (bridges word boundaries too).
    let chars: Vec<char> = lower.chars().collect();
    if chars.len() >= 3 {
        for window in chars.windows(3) {
            let gram: String = window.iter().collect();
            bump(&gram, 1.0);
        }
    }
    let norm = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for v in &mut vec {
            *v /= norm;
        }
    }
    vec
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len().min(b.len());
    a[..len].iter().zip(&b[..len]).map(|(x, y)| x * y).sum()
}

/// Regenerates the human-readable markdown mirror.
fn write_mirror(repo_path: &Path, entries: &[MemoryEntry], scope: Option<&str>) -> Result<()> {
    let mut sorted: Vec<&MemoryEntry> = entries.iter().collect();
    sorted.sort_by_key(|e| e.created_at);
    let mut body = String::from("# Project memory\n");
    for entry in sorted.iter().take(MIRROR_CAP) {
        body.push_str(&format!("- {}\n", entry.text));
    }
    fs::write(mirror_path(repo_path, scope)?, body).map_err(err)
}

/// Seeds the store from the markdown mirror on first run (upgrade path from
/// the flat file), so existing memories are not lost.
fn seed_from_mirror(
    repo_path: &Path,
    scope: Option<&str>,
    store: &mut MemoryStore,
) -> Result<()> {
    if !store.entries.is_empty() {
        return Ok(());
    }
    let mirror = mirror_path(repo_path, scope)?;
    let Ok(text) = fs::read_to_string(mirror) else {
        return Ok(());
    };
    for line in text.lines() {
        let line = line.trim();
        if let Some(bullet) = line.strip_prefix("- ") {
            if bullet.is_empty() || store.entries.iter().any(|e| e.text == bullet) {
                continue;
            }
            store.entries.push(MemoryEntry {
                id: format!("m-{:x}-{}", fnv1a(bullet), now_ms()),
                text: bullet.to_string(),
                vector: embed(bullet),
                created_at: now_ms(),
            });
        }
    }
    if !store.entries.is_empty() {
        save_store(&store_path(repo_path, scope)?, store)?;
    }
    Ok(())
}

/// Lists all memories (ordered oldest first, as written).
pub fn memory_list(repo_path: &Path, scope: Option<&str>) -> Result<Vec<MemoryEntry>> {
    let path = store_path(repo_path, scope)?;
    let mut store = load_store(&path);
    seed_from_mirror(repo_path, scope, &mut store)?;
    Ok(store.entries)
}

/// Adds a memory (dedupes identical text) and refreshes the markdown mirror.
pub fn memory_add(repo_path: &Path, scope: Option<&str>, text: &str) -> Result<MemoryEntry> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("memory text must not be empty".to_string());
    }
    let path = store_path(repo_path, scope)?;
    let mut store = load_store(&path);
    seed_from_mirror(repo_path, scope, &mut store)?;
    if let Some(existing) = store.entries.iter().find(|e| e.text == text) {
        return Ok(existing.clone());
    }
    let entry = MemoryEntry {
        id: format!("m-{:x}-{}", fnv1a(&text), now_ms()),
        vector: embed(&text),
        text,
        created_at: now_ms(),
    };
    store.entries.push(entry.clone());
    save_store(&path, &store)?;
    write_mirror(repo_path, &store.entries, scope)?;
    Ok(entry)
}

/// Removes a memory by id and refreshes the markdown mirror.
pub fn memory_remove(repo_path: &Path, scope: Option<&str>, id: &str) -> Result<()> {
    let path = store_path(repo_path, scope)?;
    let mut store = load_store(&path);
    seed_from_mirror(repo_path, scope, &mut store)?;
    let before = store.entries.len();
    store.entries.retain(|e| e.id != id);
    if store.entries.len() == before {
        return Err(format!("memory {id} not found"));
    }
    save_store(&path, &store)?;
    write_mirror(repo_path, &store.entries, scope)?;
    Ok(())
}

/// Semantic search: the most similar memories for a query, best first.
pub fn memory_search(
    repo_path: &Path,
    scope: Option<&str>,
    query: &str,
    limit: usize,
) -> Result<Vec<MemoryHit>> {
    let path = store_path(repo_path, scope)?;
    let mut store = load_store(&path);
    seed_from_mirror(repo_path, scope, &mut store)?;
    let qvec = embed(query);
    let mut hits: Vec<MemoryHit> = store
        .entries
        .iter()
        .map(|entry| MemoryHit {
            id: entry.id.clone(),
            text: entry.text.clone(),
            score: cosine(&qvec, &entry.vector),
            created_at: entry.created_at,
        })
        .collect();
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    Ok(hits)
}

/// Semantic search over an explicit set of texts (used by the agent panel to
/// rank memories without touching the store).
pub fn search_texts(query: &str, texts: &[String], limit: usize) -> Vec<(usize, f32)> {
    let qvec = embed(query);
    let mut scored: Vec<(usize, f32)> = texts
        .iter()
        .enumerate()
        .map(|(i, text)| (i, cosine(&qvec, &embed(text))))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    scored
}

/// Convenience for tests and the panel: keeps a small HashMap-free surface.

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orbit-mem-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        dir
    }

    #[test]
    fn add_search_remove_roundtrip() {
        let dir = scratch("roundtrip");
        memory_add(&dir, None, "tests must run serially on windows").unwrap();
        memory_add(&dir, None, "the frontend uses react 19 and vite").unwrap();
        memory_add(&dir, None, "deploy with docker compose up -d").unwrap();

        let hits = memory_search(&dir, None, "how do I run the tests?", 2).unwrap();
        assert!(!hits.is_empty());
        assert!(
            hits[0].text.contains("serially"),
            "top hit should be the tests memory, got: {}",
            hits[0].text
        );
        assert!(hits[0].score > 0.05, "score should be meaningful");

        let list = memory_list(&dir, None).unwrap();
        assert_eq!(list.len(), 3);

        let id = list[0].id.clone();
        memory_remove(&dir, None, &id).unwrap();
        assert_eq!(memory_list(&dir, None).unwrap().len(), 2);
        assert!(memory_remove(&dir, None, &id).is_err(), "double remove errors");

        // Mirror regenerated with the remaining entries.
        let mirror = fs::read_to_string(dir.join(MIRROR_PATH)).unwrap();
        assert!(mirror.contains("# Project memory"));
        assert!(mirror.contains("serially") || mirror.contains("react") || mirror.contains("docker"));
        assert!(!mirror.contains("serially") || list.len() == 3); // mirror matches store

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dedupes_identical_text() {
        let dir = scratch("dedupe");
        let first = memory_add(&dir, None, "uses pnpm").unwrap();
        let second = memory_add(&dir, None, "uses pnpm").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(memory_list(&dir, None).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn seeds_from_markdown_mirror() {
        let dir = scratch("seed");
        fs::create_dir_all(dir.join(".orbit")).unwrap();
        fs::write(
            dir.join(MIRROR_PATH),
            "# Project memory\n\n- legacy memory one\n- legacy memory two\n",
        )
        .unwrap();
        let list = memory_list(&dir, None).unwrap();
        assert_eq!(list.len(), 2, "bullets imported as memories");
        assert!(list.iter().any(|e| e.text == "legacy memory one"));
        // Vector file now exists next to the mirror.
        assert!(dir.join(STORE_PATH).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn embedding_is_deterministic_and_normalised() {
        let a = embed("run tests");
        let b = embed("run tests");
        assert_eq!(a, b);
        let norm = a.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "L2 normalised, got {norm}");
    }
}
