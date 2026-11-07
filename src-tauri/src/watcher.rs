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
    let (tx, rx) = mpsc::channel::<WatcherCommand>();

    std::thread::spawn(move || {
        let (event_tx, event_rx) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(event_tx) {
            Ok(watcher) => watcher,
            Err(e) => {
                eprintln!("[orbit] file watcher unavailable: {e}");
                return;
            }
        };
        let mut current: Option<PathBuf> = None;

        loop {
            // 1. Drain watcher commands (non-blocking).
            while let Ok(cmd) = rx.try_recv() {
                match cmd {
                    WatcherCommand::Watch(path) => {
                        // Unwatch the old path first.
                        if let Some(old) = current.take() {
                            let _ = watcher.unwatch(&old);
                        }
                        current = Some(path.clone());
                        match watcher.watch(&path, RecursiveMode::Recursive) {
                            Ok(()) => {
                                println!("[orbit] watching {}", path.display());
                            }
                            Err(e) => {
                                eprintln!("[orbit] watch failed: {e}");
                            }
                        }
                    }
                    WatcherCommand::Stop => {
                        if let Some(old) = current.take() {
                            let _ = watcher.unwatch(&old);
                        }
                    }
                }
            }

            // 2. Drain file events (non-blocking) — collect dirtiness.
            let mut dirty = false;
            while let Ok(_event) = event_rx.try_recv() {
                dirty = true;
            }

            // 3. Debounce and emit.
            if dirty {
                std::thread::sleep(Duration::from_millis(500));
                // Drain events that arrived during the debounce window.
                while let Ok(_) = event_rx.try_recv() {}
                let _ = app.emit("repo-changed", ());
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
