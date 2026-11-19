use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 48;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
type Response = Arc<Mutex<Option<(Instant, String)>>>;

#[derive(Clone, Eq, Hash, PartialEq)]
struct Key {
    repo: PathBuf,
    scope: u64,
    args: Vec<String>,
}

static CACHE: LazyLock<Mutex<HashMap<Key, Response>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn invalidate() {
    CACHE.lock().unwrap_or_else(|error| error.into_inner()).clear();
}

fn scope(repo: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    for key in ["GH_HOST", "GH_REPO", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] {
        std::env::var_os(key).hash(&mut hasher);
    }
    let config_dir = std::env::var_os("GH_CONFIG_DIR").map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME").map(|path| PathBuf::from(path).join("gh")))
        .or_else(|| {
            if cfg!(windows) {
                std::env::var_os("APPDATA").map(|path| PathBuf::from(path).join("GitHub CLI"))
            } else {
                None
            }
        })
        .or_else(|| std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".config/gh")));
    if let Some(path) = config_dir {
        std::fs::read(path.join("hosts.yml")).ok().hash(&mut hasher);
    }
    if let Ok(repository) = git2::Repository::discover(repo) {
        std::fs::read(repository.commondir().join("config")).ok().hash(&mut hasher);
        repository.head().ok().and_then(|head| head.name().map(str::to_owned)).hash(&mut hasher);
    }
    hasher.finish()
}

pub(crate) fn read(
    repo: &Path, args: &[&str], ttl: Duration,
    fetch: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    let key = Key {
        repo: repo.to_path_buf(),
        scope: scope(repo),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    };
    let response = {
        let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
        if cache.len() >= MAX_ENTRIES && !cache.contains_key(&key) {
            let oldest = cache.iter().filter_map(|(key, slot)| {
                let entry = slot.try_lock().ok()?;
                Some((key, entry.as_ref().map(|(time, _)| *time)))
            }).min_by_key(|(_, time)| *time).map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                cache.remove(&oldest);
            }
        }
        if cache.len() >= MAX_ENTRIES && !cache.contains_key(&key) {
            drop(cache);
            return fetch();
        }
        cache.entry(key).or_default().clone()
    };
    // Single flight for the same repository, credentials and request.
    let mut entry = response.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((checked_at, payload)) = entry.as_ref() {
        if checked_at.elapsed() < ttl {
            return Ok(payload.clone());
        }
    }
    let updated = fetch()?;
    if updated.len() <= MAX_RESPONSE_BYTES {
        if let Some((checked_at, payload)) = entry.as_mut() {
            *checked_at = Instant::now();
            if *payload != updated {
                *payload = updated.clone();
            }
        } else {
            *entry = Some((Instant::now(), updated.clone()));
        }
    } else {
        *entry = None;
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_failures_and_revalidates_expired_or_invalidated_entries() {
        let repo = Path::new("pigry-cache-test-repository");
        let args = ["pr", "view", "cache-test"];
        let fresh = Duration::from_secs(60);

        assert!(read(repo, &args, fresh, || Err("offline".into())).is_err());
        assert_eq!(read(repo, &args, fresh, || Ok("first".into())).unwrap(), "first");
        assert_eq!(read(repo, &args, fresh, || panic!("expected cache hit")).unwrap(), "first");
        assert_eq!(read(repo, &args, Duration::ZERO, || Ok("changed".into())).unwrap(), "changed");
        assert_eq!(read(repo, &args, fresh, || panic!("expected updated cache hit")).unwrap(), "changed");

        invalidate();
        assert_eq!(read(repo, &args, fresh, || Ok("after refresh".into())).unwrap(), "after refresh");
    }
}
