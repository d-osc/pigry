//! Playwright as the E2E runner's browser engine: the "Playwright Chromium /
//! Firefox / WebKit" entries of the browser picker. A small Node bridge
//! (scripts/pw-bridge.mjs, embedded here) drives Playwright from the open
//! repository; this module starts it with `node`, speaks one JSON request /
//! reply per line with it, and offers the same actions as the CDP (devtools.rs)
//! and WebDriver BiDi (bidi.rs) test windows — with video in every browser.

use crate::browser_detect::InstalledBrowser;
use crate::devtools::NetEntry;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

type Result<T> = std::result::Result<T, String>;

pub const BRIDGE: &str = include_str!("../../scripts/pw-bridge.mjs");
const CLOSED: &str = "the Playwright test window was closed — open the page again";
const NO_SESSION: &str = "no devtools session — call browser_devtools with action \"open\" first";

/* ------------------------------------------------------------ detection */

/// Playwright's browser builds in its cache folder (`ms-playwright`): one picker
/// entry per engine that can open a visible window. The headless-only Chromium
/// shell is not listed.
pub fn detect_in(cache: &Path) -> Vec<InstalledBrowser> {
    let Ok(entries) = std::fs::read_dir(cache) else { return Vec::new() };
    let mut newest: HashMap<&'static str, (u64, PathBuf)> = HashMap::new();
    for entry in entries.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((engine, revision)) = name.rsplit_once('-') else { continue };
        let Ok(revision) = revision.parse::<u64>() else { continue };
        let engine: &'static str = match engine {
            "chromium" => "chromium",
            "firefox" => "firefox",
            "webkit" => "webkit",
            _ => continue,
        };
        // a half-downloaded build has no marker file yet
        if !entry.path().join("INSTALLATION_COMPLETE").is_file() && !entry.path().join("DEPENDENCIES_VALIDATED").is_file() {
            continue;
        }
        if newest.get(engine).map(|(r, _)| revision > *r).unwrap_or(true) {
            newest.insert(engine, (revision, entry.path()));
        }
    }
    let mut found = Vec::new();
    for (engine, display) in [("chromium", "Playwright Chromium"), ("firefox", "Playwright Firefox"), ("webkit", "Playwright WebKit")] {
        let Some((_, dir)) = newest.get(engine) else { continue };
        let version = match engine {
            "firefox" => std::fs::read_to_string(dir.join("firefox").join("application.ini"))
                .map(|ini| crate::browser_detect::parse_application_ini(&ini))
                .unwrap_or_default(),
            "chromium" => chromium_version(dir),
            _ => String::new(),
        };
        found.push(InstalledBrowser {
            id: format!("pw-{engine}"),
            name: engine.to_string(),
            family: engine.to_string(),
            channel: "stable".to_string(),
            display_name: display.to_string(),
            version,
            path: dir.to_string_lossy().into_owned(),
            engine: "playwright".to_string(),
        });
    }
    found
}

/// The version of a Playwright Chromium build, from the `<version>.manifest` next to chrome.exe.
fn chromium_version(dir: &Path) -> String {
    for sub in ["chrome-win64", "chrome-win", "chrome-linux", "chrome-mac"] {
        let Ok(entries) = std::fs::read_dir(dir.join(sub)) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(version) = name.strip_suffix(".manifest") {
                if version.split('.').count() == 4 && version.split('.').all(|p| p.parse::<u64>().is_ok()) {
                    return version.to_string();
                }
            }
        }
    }
    String::new()
}

/// Where Playwright keeps its browsers on this machine (PLAYWRIGHT_BROWSERS_PATH wins).
pub fn cache_dir() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("PLAYWRIGHT_BROWSERS_PATH").filter(|v| !v.is_empty() && v != "0") {
        return Some(PathBuf::from(custom));
    }
    if cfg!(windows) {
        return std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("ms-playwright"));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(if cfg!(target_os = "macos") { home.join("Library").join("Caches").join("ms-playwright") } else { home.join(".cache").join("ms-playwright") })
}

pub fn detect() -> Vec<InstalledBrowser> {
    cache_dir().map(|dir| detect_in(&dir)).unwrap_or_default()
}

/* ------------------------------------------------------------ protocol */

/// One request line for the bridge.
pub fn request_line(id: u64, action: &str, url: Option<&str>, js: Option<&str>, wait_ms: Option<u64>) -> String {
    let mut request = json!({ "id": id, "action": action });
    if let Some(url) = url {
        request["url"] = json!(url);
    }
    if let Some(js) = js {
        request["js"] = json!(js);
    }
    if let Some(wait) = wait_ms {
        request["waitMs"] = json!(wait);
    }
    request.to_string()
}

/// A reply line from the bridge: `(id, result or error)`; `None` for anything else.
pub fn parse_reply(line: &str) -> Option<(u64, Result<String>)> {
    let reply: Value = serde_json::from_str(line.trim()).ok()?;
    let id = reply.get("id")?.as_u64()?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Some((id, Ok(reply.get("result").and_then(Value::as_str).unwrap_or("").to_string())))
    } else {
        Some((id, Err(reply.get("error").and_then(Value::as_str).unwrap_or("the Playwright bridge failed").to_string())))
    }
}

/// The bridge's request rows as Network-panel entries, secrets redacted like the CDP collector does.
pub fn net_entries(rows_json: &str) -> Vec<NetEntry> {
    let rows: Vec<Value> = serde_json::from_str(rows_json).unwrap_or_default();
    rows.iter()
        .map(|row| {
            let text = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or("").to_string();
            let number = |key: &str| row.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            NetEntry {
                method: text("method"),
                url: text("url"),
                status: row.get("status").and_then(Value::as_i64).unwrap_or(0),
                r#type: text("type"),
                size: number("size"),
                failed: row.get("failed").and_then(Value::as_bool).unwrap_or(false),
                resource: text("resource"),
                started: 0.0,
                time_ms: number("time_ms"),
                request_headers: row.get("request_headers").map(crate::devtools::redact_headers),
                request_body: row.get("request_body").and_then(Value::as_str).map(crate::devtools::redact_body),
                response_headers: row.get("response_headers").map(crate::devtools::redact_headers),
                response_body: row.get("response_body").and_then(Value::as_str).map(crate::devtools::redact_body),
            }
        })
        .collect()
}

/// Writes the embedded bridge next to other temp files (once per version of it) and returns its path.
fn bridge_file() -> Result<PathBuf> {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(BRIDGE.as_bytes());
    let tag: String = hash.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let path = std::env::temp_dir().join(format!("pigry-pw-bridge-{tag}.mjs"));
    if std::fs::read_to_string(&path).map(|text| text != BRIDGE).unwrap_or(true) {
        std::fs::write(&path, BRIDGE).map_err(|e| format!("could not write the Playwright bridge: {e}"))?;
    }
    Ok(path)
}

/* ------------------------------------------------------------ session */

struct Session {
    tx: mpsc::UnboundedSender<String>,
    next_id: Arc<AtomicU64>,
    pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<String>>>>>,
    child: tokio::process::Child,
    network: Arc<Mutex<Vec<NetEntry>>>,
    stderr: Arc<std::sync::Mutex<Vec<String>>>,
}

static PW: Mutex<Option<Session>> = Mutex::const_new(None);

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub async fn active() -> bool {
    PW.lock().await.is_some()
}

#[derive(Clone)]
struct Handle {
    tx: mpsc::UnboundedSender<String>,
    next_id: Arc<AtomicU64>,
    pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<String>>>>>,
    stderr: Arc<std::sync::Mutex<Vec<String>>>,
}

async fn handle() -> Result<Handle> {
    let guard = PW.lock().await;
    let s = guard.as_ref().ok_or_else(|| NO_SESSION.to_string())?;
    Ok(Handle { tx: s.tx.clone(), next_id: s.next_id.clone(), pending: s.pending.clone(), stderr: s.stderr.clone() })
}

impl Handle {
    async fn call(&self, action: &str, url: Option<&str>, js: Option<&str>, wait_ms: Option<u64>, limit_secs: u64) -> Result<String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply_tx, reply_rx) = oneshot::channel();
        lock(&self.pending).insert(id, reply_tx);
        if self.tx.send(request_line(id, action, url, js, wait_ms)).is_err() {
            lock(&self.pending).remove(&id);
            return Err(CLOSED.to_string());
        }
        match tokio::time::timeout(std::time::Duration::from_secs(limit_secs), reply_rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => {
                // the bridge exited: its last stderr lines usually say why (no Playwright, no browser…)
                let tail = lock(&self.stderr).iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" ");
                Err(if tail.is_empty() { CLOSED.to_string() } else { format!("{CLOSED} ({tail})") })
            }
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(format!("Playwright did not answer {action} within {limit_secs}s"))
            }
        }
    }
}

/// Sends one devtools action to the open Playwright window.
pub async fn call(action: &str, url: Option<&str>, js: Option<&str>) -> Result<String> {
    handle().await?.call(action, url, js, None, 120).await
}

async fn start(repo_path: &Path, browser: &str, web_security_off: bool) -> Result<Session> {
    let script = bridge_file()?;
    let mut command = tokio::process::Command::new("node");
    command
        .arg(&script)
        .current_dir(repo_path)
        .env("PIGRY_PW_BROWSER", browser)
        .env("PIGRY_PW_WEB_SECURITY", if web_security_off { "off" } else { "on" })
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Node.js is needed for the Playwright browsers — install it from nodejs.org (and Playwright in the repository), or pick another browser".to_string()
        } else {
            format!("could not start the Playwright bridge: {e}")
        }
    })?;
    let mut stdin = child.stdin.take().ok_or("no stdin for the Playwright bridge")?;
    let stdout = child.stdout.take().ok_or("no stdout for the Playwright bridge")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr for the Playwright bridge")?;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });
    let pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<String>>>>> = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let reader_pending = pending.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some((id, reply)) = parse_reply(&line) {
                if let Some(waiter) = lock(&reader_pending).remove(&id) {
                    let _ = waiter.send(reply);
                }
            }
        }
        lock(&reader_pending).clear();
    });
    let stderr: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = stderr.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr_pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut tail = lock(&sink);
            if tail.len() > 20 {
                tail.remove(0);
            }
            tail.push(line);
        }
    });
    Ok(Session { tx, next_id: Arc::new(AtomicU64::new(1)), pending, child, network: Arc::new(Mutex::new(Vec::new())), stderr })
}

/// Opens `url` in the open Playwright window when it is still alive; `None` without one.
pub async fn reuse(url: &str, wait_ms: u64) -> Option<Result<String>> {
    let alive = {
        let mut guard = PW.lock().await;
        let session = guard.as_mut()?;
        matches!(session.child.try_wait(), Ok(None))
    };
    if !alive {
        close().await;
        return None;
    }
    let handle = handle().await.ok()?;
    Some(handle.call("open", Some(url), None, Some(wait_ms), 120).await)
}

/// Starts Playwright's `browser` ("chromium", "firefox", "webkit") in the repository and opens `url`.
pub async fn open(repo_path: &Path, browser: &str, url: &str, wait_ms: u64, web_security_off: bool) -> Result<String> {
    close().await;
    let session = start(repo_path, browser, web_security_off).await?;
    *PW.lock().await = Some(session);
    let result = handle().await?.call("open", Some(url), None, Some(wait_ms), 180).await;
    if result.is_err() {
        // a bridge that could not launch is of no use: let the next open try again
        close().await;
    }
    result
}

/// The request rows of the Playwright window, refreshed from the bridge (the export in devtools.rs reads them).
pub async fn network_store() -> Option<Arc<Mutex<Vec<NetEntry>>>> {
    let store = PW.lock().await.as_ref().map(|s| s.network.clone())?;
    if let Ok(rows) = call("network", None, None).await {
        *store.lock().await = net_entries(&rows);
    }
    Some(store)
}

pub async fn console(limit: usize) -> Result<Vec<String>> {
    let lines: Vec<String> = serde_json::from_str(&call("console", None, None).await?).unwrap_or_default();
    let start = lines.len().saturating_sub(limit);
    Ok(lines[start..].to_vec())
}

/// Closes the Playwright window and its bridge; false when none was open.
pub async fn close() -> bool {
    let Some(mut session) = PW.lock().await.take() else { return false };
    let handle = Handle { tx: session.tx.clone(), next_id: session.next_id.clone(), pending: session.pending.clone(), stderr: session.stderr.clone() };
    let _ = handle.call("close", None, None, None, 10).await;
    if tokio::time::timeout(std::time::Duration::from_secs(5), session.child.wait()).await.is_err() {
        let _ = session.child.start_kill();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), session.child.wait()).await;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(root: &Path, name: &str, done: bool) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        if done {
            std::fs::write(dir.join("INSTALLATION_COMPLETE"), b"").unwrap();
        }
        dir
    }

    #[test]
    fn lists_the_newest_complete_build_of_each_engine() {
        let cache = tempfile::tempdir().unwrap();
        build(cache.path(), "chromium_headless_shell-1255", true);
        build(cache.path(), "ffmpeg-1013", true);
        let ff_old = build(cache.path(), "firefox-1500", true);
        std::fs::create_dir_all(ff_old.join("firefox")).unwrap();
        std::fs::write(ff_old.join("firefox").join("application.ini"), "[App]\nVersion=150.0\n").unwrap();
        let ff = build(cache.path(), "firefox-1572", true);
        std::fs::create_dir_all(ff.join("firefox")).unwrap();
        std::fs::write(ff.join("firefox").join("application.ini"), "[App]\nVersion=159.0\n").unwrap();
        build(cache.path(), "webkit-2388", true);
        build(cache.path(), "webkit-2400", false);
        let found = detect_in(cache.path());
        let ids: Vec<&str> = found.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["pw-firefox", "pw-webkit"], "no headless-only Chromium; ffmpeg is not a browser");
        assert_eq!(found[0].version, "159.0", "the newest Firefox build");
        assert_eq!((found[0].family.as_str(), found[0].name.as_str(), found[0].engine.as_str()), ("firefox", "firefox", "playwright"));
        assert!(found[1].path.ends_with("webkit-2388"), "an unfinished download is skipped");
        assert_eq!(found[1].display_name, "Playwright WebKit");
        assert!(detect_in(&cache.path().join("missing")).is_empty());
    }

    #[test]
    fn a_full_chromium_build_is_listed_with_its_version() {
        let cache = tempfile::tempdir().unwrap();
        let dir = build(cache.path(), "chromium-1148", true);
        std::fs::create_dir_all(dir.join("chrome-win")).unwrap();
        std::fs::write(dir.join("chrome-win").join("131.0.6778.33.manifest"), b"").unwrap();
        let found = detect_in(cache.path());
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].id.as_str(), found[0].version.as_str()), ("pw-chromium", "131.0.6778.33"));
    }

    #[test]
    fn request_and_reply_lines() {
        let line = request_line(3, "open", Some("http://a.test/"), None, Some(0));
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({ "id": 3, "action": "open", "url": "http://a.test/", "waitMs": 0 }));
        assert!(!line.contains('\n'));
        let multi = request_line(4, "eval", None, Some("a\nb"), None);
        assert!(!multi.contains('\n'), "a script with newlines stays on one line");
        assert_eq!(parse_reply(r#"{"id":3,"ok":true,"result":"opened"}"#), Some((3, Ok("opened".to_string()))));
        assert_eq!(parse_reply(r#"{"id":4,"ok":false,"error":"ReferenceError: x"}"#), Some((4, Err("ReferenceError: x".to_string()))));
        assert_eq!(parse_reply("(node:1) warning"), None);
    }

    #[test]
    fn network_rows_are_redacted_entries() {
        let rows = r#"[{"method":"POST","url":"http://a.test/api","status":201,"type":"application/json","size":42,"failed":false,"resource":"Fetch","time_ms":12,
            "request_headers":{"authorization":"Bearer x","accept":"*/*"},"request_body":"{\"password\":\"p\",\"user\":\"u\"}","response_body":"{\"token\":\"t\"}"}]"#;
        let entries = net_entries(rows);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!((e.method.as_str(), e.status, e.resource.as_str(), e.time_ms), ("POST", 201, "Fetch", 12.0));
        assert_eq!(e.request_headers.as_ref().unwrap()["authorization"], json!("[redacted]"));
        assert_eq!(e.request_headers.as_ref().unwrap()["accept"], json!("*/*"));
        assert!(e.request_body.as_ref().unwrap().contains("\"user\":\"u\"") && !e.request_body.as_ref().unwrap().contains("\"p\""));
        assert!(!e.response_body.as_ref().unwrap().contains("\"t\""));
        assert!(net_entries("not json").is_empty());
    }

    #[test]
    fn the_bridge_is_embedded() {
        assert!(BRIDGE.contains("PIGRY_PW_BROWSER"));
        let path = bridge_file().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), BRIDGE);
    }
}

/// Needs Node, Playwright in this repository and its browsers:
/// `cargo test --lib pw_real_browser -- --ignored --nocapture` (set PIGRY_PW_TEST_BROWSER=firefox|webkit|chromium).
#[cfg(test)]
mod real_browser_tests {
    use std::io::{Read, Write};

    fn serve() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    let n = s.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let (ctype, extra, body) = if req.starts_with("GET /echo ") {
                        let h = req.lines().find(|l| l.to_lowercase().starts_with("x-pigry:")).unwrap_or("none").to_string();
                        ("text/plain", String::new(), h)
                    } else if req.starts_with("GET /api ") {
                        ("application/json", String::new(), "{\"ok\":true,\"token\":\"secret\"}".to_string())
                    } else {
                        ("text/html", "Set-Cookie: sid=abc; HttpOnly; Path=/\r\n".to_string(), "<!doctype html><html><head><title>t</title></head><body><input id=i><button id=b onclick=\"document.title='clicked '+event.isTrusted\" style=\"position:absolute;left:100px;top:100px;width:80px;height:40px\">go</button></body></html>".to_string())
                    };
                    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = s.write_all(resp.as_bytes());
                });
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    #[ignore]
    async fn pw_real_browser_through_the_devtools_actions() {
        use crate::devtools::*;
        let engine = std::env::var("PIGRY_PW_TEST_BROWSER").unwrap_or_else(|_| "webkit".to_string());
        let Some(picked) = super::detect().into_iter().find(|b| b.name == engine) else {
            eprintln!("Playwright {engine} is not installed — skipped");
            return;
        };
        // run the bridge in this repository, where @playwright/test is installed
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        set_browser(&picked.id);
        let base = serve();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("PIGRY_PW_HEADLESS", "1") };
        super::open(&repo, &engine, "about:blank", 0, false).await.unwrap();
        devtools_init_script("window.__initRan = 42;").await.unwrap();
        let opened = devtools_open(&repo, &format!("{base}/"), 100).await.unwrap();
        assert!(opened.contains("title: t"), "{opened}");
        assert_eq!(devtools_eval("window.__initRan").await.unwrap().trim(), "42");
        assert!(devtools_eval("consoel.log(1)").await.is_err());
        devtools_input(r#"[{"t":"move","x":120,"y":120},{"t":"down","x":120,"y":120,"button":"left","clicks":1},{"t":"up","x":120,"y":120,"button":"left","clicks":1}]"#).await.unwrap();
        assert!(devtools_eval("document.title").await.unwrap().contains("clicked true"));
        assert!(devtools_cookies().await.unwrap().contains("\"sid\""));
        devtools_headers(r#"{"x-pigry":"yes"}"#).await.unwrap();
        let echoed = devtools_eval(&format!("fetch('{base}/echo').then(r => r.text())")).await.unwrap();
        assert!(echoed.to_lowercase().contains("x-pigry: yes"), "echo: {echoed}");
        devtools_eval(&format!("fetch('{base}/api').then(r => r.json())")).await.unwrap();
        let summary = devtools_network_export(dir.path(), ".pigry/t/net.json", true).await.unwrap();
        assert!(summary.contains("/api"), "{summary}");
        assert!(!std::fs::read_to_string(dir.path().join(".pigry/t/net.json")).unwrap().contains("\"secret\""));
        devtools_screenshot(dir.path(), Some(".pigry/t/shot.png"), Some(r#"{"fullPage":true}"#)).await.unwrap();
        assert!(std::fs::metadata(dir.path().join(".pigry/t/shot.png")).unwrap().len() > 100);
        devtools_record_start(dir.path(), ".pigry/t/v.webm").await.unwrap();
        devtools_eval("document.body.style.background = 'red'").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let saved = devtools_record_stop().await.unwrap();
        assert!(saved.contains("video saved to .pigry/t/v.webm"), "{saved}");
        assert!(std::fs::metadata(dir.path().join(".pigry/t/v.webm")).unwrap().len() > 1000);
        devtools_close().await.unwrap();
        assert!(!super::active().await);
        set_browser("");
    }
}
