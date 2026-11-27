//! Finds the browsers installed on this machine, for the E2E runner's browser
//! picker (like Cypress's browser list). Chromium-family browsers are driven
//! over the Chrome DevTools Protocol, Firefox over WebDriver BiDi (bidi.rs).

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBrowser {
    /// Stable id used to pick it: "edge", "chrome-beta", "brave", …
    pub id: String,
    /// Cypress-style name: "edge", "chrome", "chromium", "brave", "vivaldi".
    pub name: String,
    /// "chromium" or "firefox".
    pub family: String,
    /// "stable", "beta", "dev", "canary" or "nightly".
    pub channel: String,
    pub display_name: String,
    /// Version read from the install folder ("" when it can't be told).
    pub version: String,
    pub path: String,
    /// How it is driven: "cdp" (Chromium), "bidi" (Firefox over WebDriver BiDi)
    /// or "playwright" (Playwright's own browser builds, through the Node bridge).
    pub engine: String,
}

#[derive(Clone, Copy)]
enum Root {
    ProgramFiles,
    ProgramFilesX86,
    LocalAppData,
}

struct Known {
    id: &'static str,
    name: &'static str,
    family: &'static str,
    channel: &'static str,
    display: &'static str,
    exe: &'static str,
    roots: &'static [Root],
}

const ALL: &[Root] = &[Root::ProgramFiles, Root::ProgramFilesX86, Root::LocalAppData];
const LOCAL: &[Root] = &[Root::LocalAppData];

/// In the order "Auto" tries them (Edge first, as before the picker existed).
const KNOWN: &[Known] = &[
    Known { id: "edge", name: "edge", family: "chromium", channel: "stable", display: "Edge", exe: r"Microsoft\Edge\Application\msedge.exe", roots: ALL },
    Known { id: "chrome", name: "chrome", family: "chromium", channel: "stable", display: "Chrome", exe: r"Google\Chrome\Application\chrome.exe", roots: ALL },
    Known { id: "edge-beta", name: "edge", family: "chromium", channel: "beta", display: "Edge Beta", exe: r"Microsoft\Edge Beta\Application\msedge.exe", roots: ALL },
    Known { id: "edge-dev", name: "edge", family: "chromium", channel: "dev", display: "Edge Dev", exe: r"Microsoft\Edge Dev\Application\msedge.exe", roots: ALL },
    Known { id: "edge-canary", name: "edge", family: "chromium", channel: "canary", display: "Edge Canary", exe: r"Microsoft\Edge SxS\Application\msedge.exe", roots: LOCAL },
    Known { id: "chrome-beta", name: "chrome", family: "chromium", channel: "beta", display: "Chrome Beta", exe: r"Google\Chrome Beta\Application\chrome.exe", roots: ALL },
    Known { id: "chrome-dev", name: "chrome", family: "chromium", channel: "dev", display: "Chrome Dev", exe: r"Google\Chrome Dev\Application\chrome.exe", roots: ALL },
    Known { id: "chrome-canary", name: "chrome", family: "chromium", channel: "canary", display: "Chrome Canary", exe: r"Google\Chrome SxS\Application\chrome.exe", roots: LOCAL },
    Known { id: "chromium", name: "chromium", family: "chromium", channel: "stable", display: "Chromium", exe: r"Chromium\Application\chrome.exe", roots: ALL },
    Known { id: "brave", name: "brave", family: "chromium", channel: "stable", display: "Brave", exe: r"BraveSoftware\Brave-Browser\Application\brave.exe", roots: ALL },
    Known { id: "vivaldi", name: "vivaldi", family: "chromium", channel: "stable", display: "Vivaldi", exe: r"Vivaldi\Application\vivaldi.exe", roots: ALL },
    // Firefox Beta installs into "Mozilla Firefox" by default; its channel-prefs.js tells them apart.
    Known { id: "firefox", name: "firefox", family: "firefox", channel: "stable", display: "Firefox", exe: r"Mozilla Firefox\firefox.exe", roots: ALL },
    Known { id: "firefox-beta", name: "firefox", family: "firefox", channel: "beta", display: "Firefox Beta", exe: r"Firefox Beta\firefox.exe", roots: ALL },
    Known { id: "firefox-dev", name: "firefox", family: "firefox", channel: "dev", display: "Firefox Developer Edition", exe: r"Firefox Developer Edition\firefox.exe", roots: ALL },
    Known { id: "firefox-nightly", name: "firefox", family: "firefox", channel: "nightly", display: "Firefox Nightly", exe: r"Firefox Nightly\firefox.exe", roots: ALL },
];

/// Firefox's version from `application.ini` next to the executable
/// (`[App]` … `Version=133.0`).
fn firefox_version(exe: &Path) -> String {
    let Some(dir) = exe.parent() else { return String::new() };
    std::fs::read_to_string(dir.join("application.ini"))
        .map(|ini| parse_application_ini(&ini))
        .unwrap_or_default()
}

/// The `Version=` of the `[App]` section of an application.ini.
pub fn parse_application_ini(ini: &str) -> String {
    let mut in_app = false;
    for line in ini.lines().map(str::trim) {
        if line.starts_with('[') {
            in_app = line.eq_ignore_ascii_case("[App]");
        } else if in_app {
            if let Some(value) = line.strip_prefix("Version=") {
                return value.trim().to_string();
            }
        }
    }
    String::new()
}

/// The update channel in `defaults/pref/channel-prefs.js` ("release", "beta",
/// "aurora" for Developer Edition, "nightly"); "" when the file is missing.
fn firefox_channel(exe: &Path) -> String {
    let Some(dir) = exe.parent() else { return String::new() };
    std::fs::read_to_string(dir.join("defaults").join("pref").join("channel-prefs.js"))
        .map(|text| parse_channel_prefs(&text))
        .unwrap_or_default()
}

/// Reads `pref("app.update.channel", "beta");` out of channel-prefs.js.
pub fn parse_channel_prefs(text: &str) -> String {
    text.lines()
        .filter_map(|line| line.split("\"app.update.channel\"").nth(1))
        .find_map(|after| after.split('"').nth(1).map(|value| value.trim().to_string()))
        .unwrap_or_default()
}

/// The newest "1.2.3.4"-style folder next to the executable — Chromium browsers
/// keep their versioned files there.
fn version_beside(exe: &Path) -> String {
    let Some(dir) = exe.parent() else { return String::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return String::new() };
    entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| {
            let parts: Option<Vec<u64>> = name.split('.').map(|part| part.parse::<u64>().ok()).collect();
            parts.filter(|parts| parts.len() >= 2).map(|parts| (parts, name))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, name)| name)
        .unwrap_or_default()
}

/// Looks for the known browsers under the given install roots (each `None` is skipped).
pub fn detect_in(program_files: Option<&Path>, program_files_x86: Option<&Path>, local_app_data: Option<&Path>) -> Vec<InstalledBrowser> {
    let mut found = Vec::new();
    for known in KNOWN {
        let hit = known.roots.iter().find_map(|root| {
            let base = match root {
                Root::ProgramFiles => program_files,
                Root::ProgramFilesX86 => program_files_x86,
                Root::LocalAppData => local_app_data,
            }?;
            let path: PathBuf = known.exe.split('\\').fold(base.to_path_buf(), |acc, part| acc.join(part));
            path.is_file().then_some(path)
        });
        let Some(path) = hit else { continue };
        let mut browser = InstalledBrowser {
            id: known.id.to_string(),
            name: known.name.to_string(),
            family: known.family.to_string(),
            channel: known.channel.to_string(),
            display_name: known.display.to_string(),
            version: String::new(),
            path: path.to_string_lossy().into_owned(),
            engine: if known.family == "firefox" { "bidi" } else { "cdp" }.to_string(),
        };
        if known.family == "firefox" {
            browser.version = firefox_version(&path);
            // a Beta installed into the default "Mozilla Firefox" folder
            if known.id == "firefox" && firefox_channel(&path) == "beta" {
                browser.id = "firefox-beta".to_string();
                browser.channel = "beta".to_string();
                browser.display_name = "Firefox Beta".to_string();
            }
        } else {
            browser.version = version_beside(&path);
        }
        if !found.iter().any(|other: &InstalledBrowser| other.id == browser.id) {
            found.push(browser);
        }
    }
    found
}

/// The browsers installed on this machine, in "Auto" order, then Playwright's own builds.
pub fn detect_browsers() -> Vec<InstalledBrowser> {
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let program_files = env("ProgramFiles").or_else(|| cfg!(windows).then(|| PathBuf::from(r"C:\Program Files")));
    let program_files_x86 = env("ProgramFiles(x86)").or_else(|| cfg!(windows).then(|| PathBuf::from(r"C:\Program Files (x86)")));
    let local_app_data = env("LOCALAPPDATA");
    let mut found = detect_in(program_files.as_deref(), program_files_x86.as_deref(), local_app_data.as_deref());
    found.extend(crate::pw_engine::detect());
    found
}

#[tauri::command]
pub fn e2e_browsers() -> Vec<InstalledBrowser> {
    detect_browsers()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(root: &Path, exe: &str, versions: &[&str]) {
        let path: PathBuf = exe.split('\\').fold(root.to_path_buf(), |acc, part| acc.join(part));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"").unwrap();
        for version in versions {
            std::fs::create_dir_all(path.parent().unwrap().join(version)).unwrap();
        }
    }

    #[test]
    fn finds_installed_browsers_in_auto_order_with_their_versions() {
        let pf = tempfile::tempdir().unwrap();
        let pf86 = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        install(pf.path(), r"Google\Chrome\Application\chrome.exe", &["119.0.6045.200", "120.0.6099.71", "SetupMetrics"]);
        install(pf86.path(), r"Microsoft\Edge\Application\msedge.exe", &["120.0.2210.61"]);
        install(local.path(), r"Google\Chrome SxS\Application\chrome.exe", &[]);
        install(pf.path(), r"BraveSoftware\Brave-Browser\Application\brave.exe", &["1.61.104"]);

        let found = detect_in(Some(pf.path()), Some(pf86.path()), Some(local.path()));
        let ids: Vec<&str> = found.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["edge", "chrome", "chrome-canary", "brave"]);
        assert_eq!(found[0].version, "120.0.2210.61");
        assert_eq!(found[1].version, "120.0.6099.71", "the newest version folder wins, other folders are ignored");
        assert_eq!(found[2].version, "");
        assert_eq!(found[2].channel, "canary");
        assert!(found.iter().all(|b| b.family == "chromium" && b.engine == "cdp"));
        assert!(found[1].path.ends_with("chrome.exe"));
    }

    #[test]
    fn a_browser_installed_in_two_places_is_listed_once_and_missing_roots_are_skipped() {
        let pf = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        install(pf.path(), r"Google\Chrome\Application\chrome.exe", &[]);
        install(local.path(), r"Google\Chrome\Application\chrome.exe", &[]);
        let found = detect_in(Some(pf.path()), None, Some(local.path()));
        assert_eq!(found.len(), 1);
        assert!(found[0].path.starts_with(&*pf.path().to_string_lossy()));
        assert!(detect_in(None, None, None).is_empty());
    }

    fn firefox(root: &Path, folder: &str, version: &str, channel: Option<&str>) {
        let dir = root.join(folder);
        std::fs::create_dir_all(dir.join("defaults").join("pref")).unwrap();
        std::fs::write(dir.join("firefox.exe"), b"").unwrap();
        std::fs::write(dir.join("application.ini"), format!("[App]\r\nVendor=Mozilla\r\nName=Firefox\r\nVersion={version}\r\nBuildID=20241125\r\n\r\n[Gecko]\r\nVersion=0.0\r\n")).unwrap();
        if let Some(channel) = channel {
            std::fs::write(dir.join("defaults").join("pref").join("channel-prefs.js"), format!("// comment\npref(\"app.update.channel\", \"{channel}\");\n")).unwrap();
        }
    }

    #[test]
    fn finds_firefox_channels_after_the_chromium_browsers_with_their_versions() {
        let pf = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        install(pf.path(), r"Microsoft\Edge\Application\msedge.exe", &["120.0.2210.61"]);
        firefox(pf.path(), "Mozilla Firefox", "133.0.3", Some("release"));
        firefox(pf.path(), "Firefox Developer Edition", "134.0b9", Some("aurora"));
        firefox(local.path(), "Firefox Nightly", "135.0a1", None);

        let found = detect_in(Some(pf.path()), None, Some(local.path()));
        let ids: Vec<&str> = found.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["edge", "firefox", "firefox-dev", "firefox-nightly"], "Auto still starts with a Chromium browser");
        let stable = &found[1];
        assert_eq!((stable.name.as_str(), stable.family.as_str(), stable.channel.as_str()), ("firefox", "firefox", "stable"));
        assert_eq!(stable.version, "133.0.3", "the version comes from application.ini, not the [Gecko] section");
        assert_eq!(stable.display_name, "Firefox");
        assert!(stable.path.ends_with("firefox.exe"));
        assert_eq!((found[2].channel.as_str(), found[2].version.as_str()), ("dev", "134.0b9"));
        assert_eq!(found[2].display_name, "Firefox Developer Edition");
        assert_eq!((found[3].channel.as_str(), found[3].family.as_str()), ("nightly", "firefox"));
        assert_eq!(found[0].family, "chromium");
        assert!(found[1..].iter().all(|b| b.engine == "bidi"));
    }

    #[test]
    fn a_beta_in_the_default_firefox_folder_is_listed_as_firefox_beta() {
        let pf = tempfile::tempdir().unwrap();
        firefox(pf.path(), "Mozilla Firefox", "134.0", Some("beta"));
        let found = detect_in(Some(pf.path()), None, None);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].id.as_str(), found[0].channel.as_str(), found[0].display_name.as_str()), ("firefox-beta", "beta", "Firefox Beta"));
        // a second Beta in its own folder is not listed twice
        firefox(pf.path(), "Firefox Beta", "134.0", None);
        assert_eq!(detect_in(Some(pf.path()), None, None).len(), 1);
    }

    #[test]
    fn parses_application_ini_and_channel_prefs() {
        assert_eq!(parse_application_ini("[App]\nVersion=128.5.1esr\n"), "128.5.1esr");
        assert_eq!(parse_application_ini("[Gecko]\nVersion=1\n[App]\nName=Firefox\n"), "");
        assert_eq!(parse_application_ini(""), "");
        assert_eq!(parse_channel_prefs("pref(\"app.update.channel\", \"nightly\");"), "nightly");
        assert_eq!(parse_channel_prefs("pref( \"app.update.channel\" , \"beta\" );"), "beta");
        assert_eq!(parse_channel_prefs("// nothing"), "");
    }
}
