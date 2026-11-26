//! Vector-backed memory — ONE store for the whole app.
//!
//! What is kept where:
//!   `.pigry/memory.json`       the memories themselves (id, text, scope, time):
//!                              small, diff-friendly, committed with the repo
//!   `.pigry/memory.md`         a human-readable mirror, grouped by scope
//!   `.pigry/cache/memory.db`   SQLite index of the embedding vectors: derived
//!                              data, rebuilt on demand, never committed (the
//!                              cache folder carries its own `.gitignore`)
//!
//! Older versions kept the vectors inside `.pigry/memory.vector.json`; that file
//! is migrated once (text to memory.json, vectors to the index) and removed.
//!
//! Every entry carries a `scope` tag saying who owns it:
//!   ""                       project-wide memory
//!   "team/<Team>"            shared team memory
//!   "agent/<Team>/<user>"    that agent's private memory
//! Memory list/add/remove/search take a scope tag and only touch entries
//! with it, so an agent always finds its own memories in the single store.
//!
//! Each memory is embedded with an offline hashed n-gram embedder (works for
//! Thai and English without any model download). Retrieval is cosine
//! similarity (dot product — vectors are L2-normalised). If the index cannot be
//! opened, vectors are simply computed on the fly.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const DIM: usize = 256;
const STORE_PATH: &str = ".pigry/memory.json";
/// Store format before the vectors moved to the SQLite index.
const LEGACY_VECTOR_PATH: &str = ".pigry/memory.vector.json";
const MIRROR_PATH: &str = ".pigry/memory.md";
/// Local, rebuildable data that must never be committed.
pub const CACHE_DIR: &str = ".pigry/cache";
const INDEX_FILE: &str = "memory.db";
const MIRROR_CAP: usize = 500;
/// Directory that used to hold per-scope stores before they were merged into
/// the single file — imported once, then ignored.
const LEGACY_TEAMS_DIR: &str = ".pigry/teams";

#[derive(Serialize, Deserialize, Clone)]
pub struct MemoryEntry {
    pub id: String,
    pub text: String,
    /// Only read from the legacy file; the vectors now live in the index.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vector: Vec<f32>,
    pub created_at: u64,
    /// Owner tag: "" = project, "team/<Team>", "agent/<Team>/<username>".
    #[serde(default)]
    pub scope: String,
}

#[derive(Serialize, Deserialize, Default)]
struct MemoryStore {
    #[serde(default)]
    entries: Vec<MemoryEntry>,
    /// Set after legacy per-scope files were merged in, so the import runs
    /// exactly once even if some scope ends up empty.
    #[serde(default)]
    legacy_imported: bool,
}

/// Search hit: the entry plus its similarity to the query (0..1).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub id: String,
    pub text: String,
    pub score: f32,
    pub created_at: u64,
    pub scope: String,
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

fn store_path(repo_path: &Path) -> Result<PathBuf> {
    Ok(workdir(repo_path)?.join(STORE_PATH))
}

fn mirror_path(repo_path: &Path) -> Result<PathBuf> {
    Ok(workdir(repo_path)?.join(MIRROR_PATH))
}

/// The effective scope tag for a request: None/empty = project-wide.
fn effective_scope(scope: Option<&str>) -> String {
    scope
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

fn read_store_file(path: &Path) -> Option<MemoryStore> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Loads the store, migrating the legacy `memory.vector.json` (text and vectors
/// in one committed file) on first use: text to memory.json, vectors to the index.
fn load_store(repo_path: &Path) -> Result<MemoryStore> {
    if let Some(store) = read_store_file(&store_path(repo_path)?) {
        return Ok(store);
    }
    let legacy = workdir(repo_path)?.join(LEGACY_VECTOR_PATH);
    let Some(mut store) = read_store_file(&legacy) else {
        return Ok(MemoryStore::default());
    };
    if let Ok(index) = open_index(repo_path) {
        for entry in &store.entries {
            if entry.vector.len() == DIM {
                let _ = put_vector(&index, entry, &entry.vector);
            }
        }
    }
    for entry in &mut store.entries {
        entry.vector.clear();
    }
    save_store(repo_path, &store)?;
    let _ = fs::remove_file(&legacy);
    Ok(store)
}

fn save_store(repo_path: &Path, store: &MemoryStore) -> Result<()> {
    let path = store_path(repo_path)?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut text = serde_json::to_string_pretty(store).map_err(err)?;
    text.push('\n');
    fs::write(path, text).map_err(err)
}

/* ---- SQLite vector index (.pigry/cache/memory.db) ---- */

/// Opens (creating if needed) the vector index. The cache folder gets a
/// `.gitignore` of `*`, so neither the database nor its -wal/-shm/-journal
/// side files ever show up as changes.
fn open_index(repo_path: &Path) -> Result<Connection> {
    let dir = workdir(repo_path)?.join(CACHE_DIR);
    fs::create_dir_all(&dir).map_err(err)?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = fs::write(&ignore, "# Pigry's local caches: rebuilt on demand, never committed.\n*\n");
    }
    let conn = Connection::open(dir.join(INDEX_FILE)).map_err(err)?;
    conn.busy_timeout(std::time::Duration::from_secs(3)).map_err(err)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vectors (
             id TEXT PRIMARY KEY,
             text_hash INTEGER NOT NULL,
             dim INTEGER NOT NULL,
             vector BLOB NOT NULL
         );",
    )
    .map_err(err)?;
    Ok(conn)
}

fn text_key(entry: &MemoryEntry) -> i64 {
    i64::from(fnv1a(&entry.text))
}

fn put_vector(conn: &Connection, entry: &MemoryEntry, vector: &[f32]) -> Result<()> {
    let blob: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
    conn.execute(
        "INSERT INTO vectors (id, text_hash, dim, vector) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET text_hash = excluded.text_hash, dim = excluded.dim, vector = excluded.vector",
        params![entry.id, text_key(entry), vector.len() as i64, blob],
    )
    .map_err(err)?;
    Ok(())
}

fn get_vector(conn: &Connection, entry: &MemoryEntry) -> Option<Vec<f32>> {
    let row: Option<(i64, i64, Vec<u8>)> = conn
        .query_row(
            "SELECT text_hash, dim, vector FROM vectors WHERE id = ?1",
            params![entry.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()?;
    let (hash, dim, blob) = row?;
    // A memory whose text was edited by hand in memory.json gets re-embedded.
    if hash != text_key(entry) || dim as usize != DIM || blob.len() != DIM * 4 {
        return None;
    }
    Some(
        blob.chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect(),
    )
}

/// The vector for an entry: from the index when it is current, otherwise
/// embedded now (and stored when the index is available).
fn vector_for(index: Option<&Connection>, entry: &MemoryEntry) -> Vec<f32> {
    if let Some(conn) = index {
        if let Some(vector) = get_vector(conn, entry) {
            return vector;
        }
        let vector = embed(&entry.text);
        let _ = put_vector(conn, entry, &vector);
        return vector;
    }
    embed(&entry.text)
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

/// Human-readable mirror heading for a scope tag.
fn scope_heading(scope: &str) -> String {
    if scope.is_empty() {
        return "## Project memory".to_string();
    }
    if let Some(team) = scope.strip_prefix("team/") {
        return format!("## Team memory — {team}");
    }
    if let Some(rest) = scope.strip_prefix("agent/") {
        if let Some((team, user)) = rest.split_once('/') {
            return format!("## Agent memory — @{user} (team {team})");
        }
    }
    format!("## {scope}")
}

/// Regenerates the human-readable markdown mirror, grouped by scope.
fn write_mirror(repo_path: &Path, entries: &[MemoryEntry]) -> Result<()> {
    let mut sorted: Vec<&MemoryEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then(a.created_at.cmp(&b.created_at))
    });
    let mut body = String::from(
        "# Memory\n\nScopes: project / team:<Team> / agent:<Team>:<username>\n",
    );
    let mut current = String::from("__start__");
    for entry in sorted.iter().take(MIRROR_CAP) {
        if entry.scope != current {
            current = entry.scope.clone();
            body.push_str(&format!("\n{}\n", scope_heading(&current)));
        }
        body.push_str(&format!("- {}\n", entry.text));
    }
    fs::write(mirror_path(repo_path)?, body).map_err(err)
}

/// Seeds the project tier from the markdown mirror on first run (upgrade path
/// from the flat file), so existing memories are not lost.
fn seed_from_mirror(repo_path: &Path, store: &mut MemoryStore) -> Result<()> {
    if !store.entries.is_empty() {
        return Ok(());
    }
    let mirror = mirror_path(repo_path)?;
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
                vector: Vec::new(),
                created_at: now_ms(),
                scope: String::new(),
            });
        }
    }
    if !store.entries.is_empty() {
        save_store(repo_path, store)?;
    }
    Ok(())
}

/// One-time import of the legacy per-scope stores
/// (`.pigry/teams/<team>/memory.vector.json` and
/// `.pigry/teams/<team>/agents/<user>/memory.vector.json`) into the single
/// store, tagging every imported entry with its owner scope.
fn import_legacy_scopes(repo_path: &Path, store: &mut MemoryStore) -> Result<()> {
    if store.legacy_imported {
        return Ok(());
    }
    let teams_root = workdir(repo_path)?.join(LEGACY_TEAMS_DIR);
    let entries = match fs::read_dir(&teams_root) {
        Ok(entries) => entries,
        Err(_) => {
            store.legacy_imported = true;
            return Ok(());
        }
    };
    let mut imported = 0usize;
    for team_dir in entries.flatten() {
        let team_name = team_dir.file_name().to_string_lossy().to_string();
        let team_path = team_dir.path();
        // Team-shared store.
        let team_store = team_path.join("memory.vector.json");
        if team_store.is_file() {
            imported +=
                import_store_file(repo_path, store, &team_store, &format!("team/{team_name}"))?;
        }
        // Per-agent stores.
        let agents_dir = team_path.join("agents");
        if let Ok(agent_dirs) = fs::read_dir(&agents_dir) {
            for agent_dir in agent_dirs.flatten() {
                let user = agent_dir.file_name().to_string_lossy().to_string();
                let agent_store = agent_dir.path().join("memory.vector.json");
                if agent_store.is_file() {
                    imported += import_store_file(
                        repo_path,
                        store,
                        &agent_store,
                        &format!("agent/{team_name}/{user}"),
                    )?;
                }
            }
        }
    }
    store.legacy_imported = true;
    if imported > 0 {
        save_store(repo_path, store)?;
    }
    Ok(())
}

/// Imports entries from one legacy store file under `scope` (deduped by text
/// within that scope). Returns how many entries were imported.
fn import_store_file(
    repo_path: &Path,
    store: &mut MemoryStore,
    path: &Path,
    scope: &str,
) -> Result<usize> {
    let legacy = read_store_file(path).unwrap_or_default();
    let mut imported = 0usize;
    for entry in legacy.entries {
        let exists = store
            .entries
            .iter()
            .any(|e| e.scope == scope && e.text == entry.text);
        if exists {
            continue;
        }
        store.entries.push(MemoryEntry {
            id: format!(
                "m-{:x}-{}",
                fnv1a(&format!("{scope}:{}", entry.text)),
                now_ms()
            ),
            text: entry.text,
            vector: Vec::new(),
            created_at: entry.created_at,
            scope: scope.to_string(),
        });
        imported += 1;
    }
    if imported > 0 {
        save_store(repo_path, store)?;
    }
    Ok(imported)
}

/// Lists memories for a scope (ordered oldest first, as written).
pub fn memory_list(repo_path: &Path, scope: Option<&str>) -> Result<Vec<MemoryEntry>> {
    let mut store = load_store(repo_path)?;
    seed_from_mirror(repo_path, &mut store)?;
    import_legacy_scopes(repo_path, &mut store)?;
    let tag = effective_scope(scope);
    Ok(store
        .entries
        .into_iter()
        .filter(|entry| entry.scope == tag)
        .collect())
}

/// Adds a memory to a scope (dedupes identical text within it) and refreshes
/// the markdown mirror.
pub fn memory_add(repo_path: &Path, scope: Option<&str>, text: &str) -> Result<MemoryEntry> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("memory text must not be empty".to_string());
    }
    let tag = effective_scope(scope);
    let mut store = load_store(repo_path)?;
    seed_from_mirror(repo_path, &mut store)?;
    import_legacy_scopes(repo_path, &mut store)?;
    if let Some(existing) = store.entries.iter().find(|e| e.scope == tag && e.text == text) {
        return Ok(existing.clone());
    }
    let entry = MemoryEntry {
        id: format!("m-{:x}-{}", fnv1a(&text), now_ms()),
        vector: Vec::new(),
        text,
        created_at: now_ms(),
        scope: tag,
    };
    store.entries.push(entry.clone());
    save_store(repo_path, &store)?;
    write_mirror(repo_path, &store.entries)?;
    if let Ok(index) = open_index(repo_path) {
        let _ = put_vector(&index, &entry, &embed(&entry.text));
    }
    Ok(entry)
}

/// Removes a memory by id (the id is globally unique across scopes) and
/// refreshes the markdown mirror.
pub fn memory_remove(repo_path: &Path, scope: Option<&str>, id: &str) -> Result<()> {
    let mut store = load_store(repo_path)?;
    seed_from_mirror(repo_path, &mut store)?;
    import_legacy_scopes(repo_path, &mut store)?;
    let before = store.entries.len();
    store.entries.retain(|e| e.id != id);
    if store.entries.len() == before {
        return Err(format!("memory {id} not found"));
    }
    save_store(repo_path, &store)?;
    write_mirror(repo_path, &store.entries)?;
    if let Ok(index) = open_index(repo_path) {
        let _ = index.execute("DELETE FROM vectors WHERE id = ?1", params![id]);
    }
    Ok(())
}

/// Semantic search: the most similar memories for a query within a scope,
/// best first.
pub fn memory_search(
    repo_path: &Path,
    scope: Option<&str>,
    query: &str,
    limit: usize,
) -> Result<Vec<MemoryHit>> {
    let tag = effective_scope(scope);
    let mut store = load_store(repo_path)?;
    seed_from_mirror(repo_path, &mut store)?;
    import_legacy_scopes(repo_path, &mut store)?;
    let qvec = embed(query);
    let index = open_index(repo_path).ok();
    let mut hits: Vec<MemoryHit> = store
        .entries
        .iter()
        .filter(|entry| entry.scope == tag)
        .map(|entry| MemoryHit {
            id: entry.id.clone(),
            text: entry.text.clone(),
            score: cosine(&qvec, &vector_for(index.as_ref(), entry)),
            created_at: entry.created_at,
            scope: entry.scope.clone(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pigry-mem-{}-{}", name, std::process::id()));
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
        assert!(list.iter().all(|e| e.scope.is_empty()), "project tier");

        let id = list[0].id.clone();
        memory_remove(&dir, None, &id).unwrap();
        assert_eq!(memory_list(&dir, None).unwrap().len(), 2);
        assert!(memory_remove(&dir, None, &id).is_err(), "double remove errors");

        // One file, one mirror — grouped by scope.
        assert!(dir.join(STORE_PATH).exists());
        // The committed file holds text only; the vectors live in the ignored SQLite index.
        let stored = fs::read_to_string(dir.join(STORE_PATH)).unwrap();
        assert!(!stored.contains("vector"), "no vectors in memory.json");
        assert!(dir.join(CACHE_DIR).join(INDEX_FILE).exists());
        let repo = git2::Repository::open(&dir).unwrap();
        assert!(repo.status_should_ignore(Path::new(".pigry/cache/memory.db")).unwrap());
        assert!(repo.status_should_ignore(Path::new(".pigry/cache/memory.db-wal")).unwrap());
        assert!(!repo.status_should_ignore(Path::new(".pigry/memory.json")).unwrap());
        let mirror = fs::read_to_string(dir.join(MIRROR_PATH)).unwrap();
        assert!(mirror.contains("# Memory"));
        assert!(mirror.contains("## Project memory"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_and_team_scopes_share_one_file_but_stay_isolated() {
        let dir = scratch("scopes");
        memory_add(&dir, None, "project level fact").unwrap();
        memory_add(&dir, Some("team/Explorer"), "explorer team fact").unwrap();
        memory_add(
            &dir,
            Some("agent/Explorer/branches"),
            "branches agent private note",
        )
        .unwrap();

        // All three live in the single store file.
        let all = load_store(&dir).unwrap();
        assert_eq!(all.entries.len(), 3);

        // Each scope only sees its own entries.
        let project = memory_list(&dir, None).unwrap();
        assert_eq!(project.len(), 1);
        assert_eq!(project[0].text, "project level fact");

        let team = memory_list(&dir, Some("team/Explorer")).unwrap();
        assert_eq!(team.len(), 1);
        assert_eq!(team[0].text, "explorer team fact");

        let agent = memory_list(&dir, Some("agent/Explorer/branches")).unwrap();
        assert_eq!(agent.len(), 1);
        assert_eq!(agent[0].text, "branches agent private note");

        // Another agent does NOT see the branches agent's memory.
        let other = memory_list(&dir, Some("agent/Explorer/explorer")).unwrap();
        assert!(other.is_empty(), "agent scopes are isolated");

        // Search is scoped too.
        let hits = memory_search(&dir, Some("agent/Explorer/branches"), "private note", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].scope, "agent/Explorer/branches");

        // Mirror groups every scope.
        let mirror = fs::read_to_string(dir.join(MIRROR_PATH)).unwrap();
        assert!(mirror.contains("## Agent memory — @branches (team Explorer)"));
        assert!(mirror.contains("## Team memory — Explorer"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dedupes_identical_text_within_scope() {
        let dir = scratch("dedupe");
        let first = memory_add(&dir, None, "uses pnpm").unwrap();
        let second = memory_add(&dir, None, "uses pnpm").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(memory_list(&dir, None).unwrap().len(), 1);
        // Same text in another scope is a separate memory.
        memory_add(&dir, Some("team/Explorer"), "uses pnpm").unwrap();
        assert_eq!(memory_list(&dir, Some("team/Explorer")).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn seeds_from_markdown_mirror() {
        let dir = scratch("seed");
        fs::create_dir_all(dir.join(".pigry")).unwrap();
        fs::write(
            dir.join(MIRROR_PATH),
            "# Memory\n\n## Project memory\n\n- legacy memory one\n- legacy memory two\n",
        )
        .unwrap();
        let list = memory_list(&dir, None).unwrap();
        assert_eq!(list.len(), 2, "bullets imported as project memories");
        assert!(list.iter().any(|e| e.text == "legacy memory one"));
        assert!(dir.join(STORE_PATH).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_legacy_per_scope_stores_once() {
        let dir = scratch("legacy");
        // Legacy layout: separate files per team and per agent.
        let teams = dir.join(".pigry").join("teams");
        fs::create_dir_all(teams.join("Explorer").join("agents").join("branches")).unwrap();
        fs::write(
            teams.join("Explorer").join("memory.vector.json"),
            serde_json::to_string(&MemoryStore {
                entries: vec![MemoryEntry {
                    id: "old-1".into(),
                    text: "old team memory".into(),
                    vector: embed("old team memory"),
                    created_at: 1,
                    scope: String::new(),
                }],
                legacy_imported: false,
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(
            teams
                .join("Explorer")
                .join("agents")
                .join("branches")
                .join("memory.vector.json"),
            serde_json::to_string(&MemoryStore {
                entries: vec![MemoryEntry {
                    id: "old-2".into(),
                    text: "old agent memory".into(),
                    vector: embed("old agent memory"),
                    created_at: 1,
                    scope: String::new(),
                }],
                legacy_imported: false,
            })
            .unwrap(),
        )
        .unwrap();

        let list = memory_list(&dir, Some("team/Explorer")).unwrap();
        assert_eq!(list.len(), 1, "legacy team memory imported");
        assert_eq!(list[0].text, "old team memory");

        let agent = memory_list(&dir, Some("agent/Explorer/branches")).unwrap();
        assert_eq!(agent.len(), 1, "legacy agent memory imported");
        assert_eq!(agent[0].text, "old agent memory");

        // Second load does not duplicate (flagged as imported).
        let again = memory_list(&dir, Some("team/Explorer")).unwrap();
        assert_eq!(again.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_the_legacy_vector_file_into_json_and_the_index() {
        let dir = scratch("migrate");
        fs::create_dir_all(dir.join(".pigry")).unwrap();
        let legacy = MemoryStore {
            entries: vec![
                MemoryEntry { id: "m-1".into(), text: "tests must run serially".into(), vector: embed("tests must run serially"), created_at: 1, scope: String::new() },
                MemoryEntry { id: "m-2".into(), text: "team fact".into(), vector: embed("team fact"), created_at: 2, scope: "team/Explorer".into() },
            ],
            legacy_imported: true,
        };
        fs::write(dir.join(LEGACY_VECTOR_PATH), serde_json::to_string(&legacy).unwrap()).unwrap();

        let list = memory_list(&dir, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "m-1", "ids survive the migration");
        assert!(!dir.join(LEGACY_VECTOR_PATH).exists(), "legacy file removed");
        let stored = fs::read_to_string(dir.join(STORE_PATH)).unwrap();
        assert!(stored.contains("team fact") && !stored.contains("vector"));
        let index = open_index(&dir).unwrap();
        assert_eq!(get_vector(&index, &list[0]).unwrap(), embed("tests must run serially"));
        drop(index);

        // Deleting the cache only costs a rebuild.
        fs::remove_dir_all(dir.join(CACHE_DIR)).unwrap();
        let hits = memory_search(&dir, None, "run the tests", 1).unwrap();
        assert_eq!(hits[0].id, "m-1");
        assert!(dir.join(CACHE_DIR).join(INDEX_FILE).exists(), "index rebuilt");

        // A memory edited by hand in memory.json is re-embedded, not served a stale vector.
        let edited = stored.replace("tests must run serially", "deploy with docker");
        fs::write(dir.join(STORE_PATH), edited).unwrap();
        let hits = memory_search(&dir, None, "docker deploy", 1).unwrap();
        assert_eq!(hits[0].text, "deploy with docker");
        assert!(hits[0].score > 0.3, "fresh vector, got {}", hits[0].score);
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
