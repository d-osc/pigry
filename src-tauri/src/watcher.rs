//! File watcher — watches the active repository's work directory recursively
//! and emits a `repo-changed` Tauri event when any file changes externally.
//!
//! Uses a watcher management thread with a simple debounce: file events
//! coalesce for 500 ms before the UI is notified.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tauri::Emitter;

enum WatcherCommand {
    /// Start watching a repository work directory.
    Watch(PathBuf),
    /// Stop watching (repo closed).
    Stop,
}

/// Handle for controlling the background watcher thread.
pub struct FileWatcher {
    tx: mpsc::Sender<WatcherCommand>,
}

/// Spawns the watcher thread and returns a handle.
pub fn spawn(app: tauri::AppHandle) -> FileWatcher {
    spawn_with_callback(move || { let _ = app.emit("repo-changed", ()); })
}

/// Events that only touch Pigry's own local cache (`.pigry/cache/`, e.g. the
/// SQLite memory index) are not repository changes and must not trigger a refresh.
fn only_cache(event: &notify::Result<notify::Event>) -> bool {
    match event {
        Ok(event) => !event.paths.is_empty() && event.paths.iter().all(|path| is_cache_path(path)),
        Err(_) => false,
    }
}

fn is_cache_path(path: &std::path::Path) -> bool {
    let parts: Vec<_> = path.components().map(|c| c.as_os_str()).collect();
    parts.windows(2).any(|w| w[0] == ".pigry" && w[1] == "cache")
}

fn spawn_with_callback(on_change: impl Fn() + Send + 'static) -> FileWatcher {
    let (tx, rx) = mpsc::channel::<WatcherCommand>();

    std::thread::spawn(move || {
        let (event_tx, event_rx) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(event_tx) {
            Ok(watcher) => watcher,
            Err(e) => {
                eprintln!("[pigry] file watcher unavailable: {e}");
                return;
            }
        };
        let mut current: Option<PathBuf> = None;

        loop {
            // Drain commands; dropping the handle also shuts down the watcher thread.
            loop {
                match rx.try_recv() {
                    Ok(WatcherCommand::Watch(path)) => {
                        if let Some(old) = current.take() { let _ = watcher.unwatch(&old); }
                        match watcher.watch(&path, RecursiveMode::Recursive) {
                            Ok(()) => current = Some(path),
                            Err(error) => eprintln!("[pigry] watch failed: {error}"),
                        }
                    }
                    Ok(WatcherCommand::Stop) => {
                        if let Some(old) = current.take() { let _ = watcher.unwatch(&old); }
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => return,
                }
            }

            // 2. Drain file events (non-blocking) — collect dirtiness.
            let mut dirty = false;
            while let Ok(event) = event_rx.try_recv() {
                if !only_cache(&event) {
                    dirty = true;
                }
            }

            // 3. Debounce and emit.
            if dirty {
                std::thread::sleep(Duration::from_millis(500));
                // Drain events that arrived during the debounce window.
                while let Ok(_) = event_rx.try_recv() {}
                on_change();
            }

            // 4. Brief sleep to avoid busy-waiting.
            std::thread::sleep(Duration::from_millis(200));
        }
    });

    FileWatcher { tx }
}

impl FileWatcher {
    /// Points the watcher at a repository work directory.
    pub fn watch(&self, path: &str) {
        let _ = self.tx.send(WatcherCommand::Watch(PathBuf::from(path)));
    }

    /// Stops watching (repo closed).
    pub fn stop(&self) {
        let _ = self.tx.send(WatcherCommand::Stop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    #[test]
    fn external_edits_emit_and_stopping_detaches_repository() {
        let path = std::env::temp_dir().join(format!("pigry-watcher-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        let count = Arc::new(AtomicUsize::new(0)); let calls = count.clone();
        let watcher = spawn_with_callback(move || { calls.fetch_add(1, Ordering::SeqCst); });
        watcher.watch(path.to_str().unwrap());
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(path.join("file.txt"), "external edit").unwrap();
        for _ in 0..30 { if count.load(Ordering::SeqCst) > 0 { break; } std::thread::sleep(Duration::from_millis(100)); }
        assert!(count.load(Ordering::SeqCst) > 0, "external edit should notify frontend");
        watcher.stop(); std::thread::sleep(Duration::from_millis(900));
        let before = count.load(Ordering::SeqCst);
        std::fs::write(path.join("file.txt"), "after stop").unwrap();
        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(count.load(Ordering::SeqCst), before);
        drop(watcher); std::thread::sleep(Duration::from_millis(300));
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn writes_to_the_local_cache_do_not_count_as_repository_changes() {
        assert!(is_cache_path(std::path::Path::new("C:/repo/.pigry/cache/memory.db")));
        assert!(is_cache_path(std::path::Path::new("/repo/.pigry/cache/memory.db-wal")));
        assert!(!is_cache_path(std::path::Path::new("/repo/.pigry/memory.json")));
        assert!(!is_cache_path(std::path::Path::new("/repo/src/cache/x.ts")));
        let event = |paths: &[&str]| Ok(notify::Event { paths: paths.iter().map(std::path::PathBuf::from).collect(), ..Default::default() });
        assert!(only_cache(&event(&["/repo/.pigry/cache/memory.db", "/repo/.pigry/cache/memory.db-journal"])));
        assert!(!only_cache(&event(&["/repo/.pigry/cache/memory.db", "/repo/.pigry/memory.json"])));
        assert!(!only_cache(&event(&[])));
    }
}
