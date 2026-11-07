//! App configuration — remembers recently opened repositories.
//! Stored as JSON under the OS app-config dir: `<config>/orbit/config.json`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(default)]
    pub active: Option<String>,
}

const MAX_RECENT: usize = 10;

fn config_file(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    dir.join("config.json")
}

pub fn load(app: &tauri::AppHandle) -> AppConfig {
    let path = config_file(app);
    fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, config: &AppConfig) {
    let path = config_file(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, text);
    }
}

/// Mark `path` as active and push it to the top of the recent list.
pub fn set_active(config: &mut AppConfig, path: &str) {
    config.recent.retain(|entry| entry != path);
    config.recent.insert(0, path.to_string());
    config.recent.truncate(MAX_RECENT);
    config.active = Some(path.to_string());
}
