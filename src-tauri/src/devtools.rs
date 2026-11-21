//! Browser DevTools session for the agent tool-use loop — a persistent
//! external Edge/Chrome window driven over the Chrome DevTools Protocol
//! (chromiumoxide). The agent can open a URL, run JavaScript, read console
//! output, take screenshots and extract page text without re-launching.

use chromiumoxide::browser::BrowserConfig;
use chromiumoxide::page::ScreenshotParams;
use chromiumoxide::Browser;
use futures::StreamExt;
use std::collections::HashMap;
use std::path::Path;
use tokio::sync::Mutex;

use crate::web::browser_candidates;

type Result<T> = std::result::Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

struct DevSession {
    browser: Browser,
    page: chromiumoxide::Page,
    console: std::sync::Arc<Mutex<Vec<String>>>,
    network: std::sync::Arc<Mutex<Vec<NetEntry>>>,
    _profile: tempfile::TempDir,
}

/// One row of the DevTools Network tab — a request observed on the page,
/// enriched as response/finish/fail events arrive.
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct NetEntry {
    pub method: String,
    pub url: String,
    pub status: i64,
    pub r#type: String,
    pub size: f64,
    pub failed: bool,
    /// CDP resource type: Document, Xhr, Fetch, Script, Image, …
    #[serde(skip_serializing_if = "String::is_empty")]
    pub resource: String,
    /// Monotonic request start (seconds) — only used to compute `time_ms`.
    #[serde(skip)]
    pub started: f64,
    pub time_ms: f64,
    /// Request/response details kept as test evidence. Secrets are redacted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_headers: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_headers: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_body: Option<String>,
}

const SENSITIVE_KEYS: [&str; 12] = [
    "password", "passwd", "secret", "token", "apikey", "api_key", "api-key", "authorization",
    "cookie", "session", "credential", "csrf",
];
const MAX_BODY_CHARS: usize = 4000;

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SENSITIVE_KEYS.iter().any(|needle| lower.contains(needle))
}

/// Replaces the value of any secret-looking key (headers or JSON fields).
fn redact_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, inner) in map.iter_mut() {
                if is_sensitive_key(key) {
                    *inner = serde_json::Value::String("[redacted]".to_string());
                } else {
                    redact_value(inner);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(redact_value),
        _ => {}
    }
}

/// Redacts a body: JSON is parsed and secret fields masked; anything else is
/// only truncated. Always capped so evidence files stay small.
fn redact_body(raw: &str) -> String {
    let text = match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(mut json) => {
            redact_value(&mut json);
            serde_json::to_string(&json).unwrap_or_else(|_| raw.to_string())
        }
        Err(_) => raw.to_string(),
    };
    if text.chars().count() > MAX_BODY_CHARS {
        let cut: String = text.chars().take(MAX_BODY_CHARS).collect();
        format!("{cut}… (truncated)")
    } else {
        text
    }
}

fn redact_headers(headers: &serde_json::Value) -> serde_json::Value {
    let mut copy = headers.clone();
    redact_value(&mut copy);
    copy
}

static DEV: Mutex<Option<DevSession>> = Mutex::const_new(None);

async fn with_session<T>(f: impl FnOnce(&mut DevSession) -> Result<T>) -> Result<T> {
    let mut guard = DEV.lock().await;
    let session = guard.as_mut().ok_or_else(|| {
        "no devtools session — call browser_devtools with action \"open\" first".to_string()
    })?;
    f(session)
}

/// Clones the live page handle (chromiumoxide Page is a cheap clone that
/// shares the session) for async operations outside the lock.
async fn session_page() -> Result<chromiumoxide::Page> {
    let guard = DEV.lock().await;
    let session = guard.as_ref().ok_or_else(|| {
        "no devtools session — call browser_devtools with action \"open\" first".to_string()
    })?;
    Ok(session.page.clone())
}

static NO_WEB_SECURITY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the next browser launch keeps web security on (default) or turns it off.
pub fn set_web_security(enabled: bool) {
    NO_WEB_SECURITY.store(!enabled, std::sync::atomic::Ordering::SeqCst);
}

async fn launch_browser() -> Result<(Browser, chromiumoxide::Handler, tempfile::TempDir)> {
    let mut candidates: Vec<_> = browser_candidates()
        .into_iter()
        .filter(|path| Path::new(path).is_file())
        .map(Some)
        .collect();
    if candidates.is_empty() {
        candidates.push(None);
    }
    let mut failures = Vec::new();
    for executable in candidates {
        let profile = tempfile::Builder::new().prefix("pigry-browser-").tempdir()
            .map_err(|error| format!("Could not launch the external test browser: {error}"))?;
        let mut config = BrowserConfig::builder()
            .with_head()
            .viewport(None)
            .window_size(1280, 800)
            // A browser that can't start should fail in seconds, not the 20s
            // default per candidate.
            .launch_timeout(std::time::Duration::from_secs(8))
            .user_data_dir(profile.path())
            .respect_https_errors()
            .arg("--remote-debugging-address=127.0.0.1");
        if NO_WEB_SECURITY.load(std::sync::atomic::Ordering::SeqCst) {
            // chromeWebSecurity: false — cross-origin requests and iframes work like in Cypress.
            config = config.arg("--disable-web-security").arg("--disable-features=IsolateOrigins,site-per-process");
        }
        if let Some(path) = executable {
            config = config.chrome_executable(path);
        }
        match config.build() {
            Ok(config) => match Browser::launch(config).await {
                Ok((browser, handler)) => return Ok((browser, handler, profile)),
                Err(error) => failures.push(error.to_string()),
            },
            Err(error) => failures.push(error.to_string()),
        }
    }
    Err(format!("Could not launch the external test browser: {}", failures.join("; ")))
}

/// Collects Network-panel rows for the session: requests create rows, and
/// response/finish/fail events enrich them (matched by request id).
async fn spawn_network_collector(
    page: &chromiumoxide::Page,
    network: std::sync::Arc<Mutex<Vec<NetEntry>>>,
) {
    use chromiumoxide::cdp::browser_protocol::network::{
        EventLoadingFailed, EventLoadingFinished, EventRequestWillBeSent, EventResponseReceived,
    };
    let index_map: std::sync::Arc<Mutex<HashMap<String, usize>>> =
        std::sync::Arc::new(Mutex::new(HashMap::new()));

    // Requests create rows.
    if let Ok(mut events) = page.event_listener::<EventRequestWillBeSent>().await {
        let net = network.clone();
        let idx = index_map.clone();
        tokio::spawn(async move {
            while let Some(ev) = events.next().await {
                let key = ev.request_id.inner().to_string();
                let mut guard = net.lock().await;
                let index = guard.len();
                let request_body = ev
                    .request
                    .post_data_entries
                    .as_ref()
                    .and_then(|entries| entries.first())
                    .and_then(|entry| entry.bytes.as_ref())
                    .and_then(|bytes| {
                        use base64::Engine;
                        let encoded: &str = bytes.as_ref();
                        base64::engine::general_purpose::STANDARD.decode(encoded).ok()
                    })
                    .and_then(|raw| String::from_utf8(raw).ok())
                    .map(|text| redact_body(&text));
                guard.push(NetEntry {
                    method: ev.request.method.clone(),
                    url: ev.request.url.clone(),
                    resource: ev.r#type.as_ref().map(|kind| format!("{kind:?}")).unwrap_or_default(),
                    started: *ev.timestamp.inner(),
                    request_headers: Some(redact_headers(ev.request.headers.inner())),
                    request_body,
                    ..Default::default()
                });
                drop(guard);
                idx.lock().await.insert(key, index);
            }
        });
    }
    // Responses fill in status + resource type.
    if let Ok(mut events) = page.event_listener::<EventResponseReceived>().await {
        let net = network.clone();
        let idx = index_map.clone();
        tokio::spawn(async move {
            while let Some(ev) = events.next().await {
                let key = ev.request_id.inner().to_string();
                let maybe_index = idx.lock().await.get(&key).copied();
                if let Some(index) = maybe_index {
                    let mut guard = net.lock().await;
                    if let Some(entry) = guard.get_mut(index) {
                        entry.status = ev.response.status;
                        entry.r#type = ev.response.mime_type.clone();
                        entry.response_headers = Some(redact_headers(ev.response.headers.inner()));
                    }
                }
            }
        });
    }
    // Finished loads fill in the transferred size, duration and — for API
    // calls (XHR / fetch) — the response body.
    if let Ok(mut events) = page.event_listener::<EventLoadingFinished>().await {
        let net = network.clone();
        let idx = index_map.clone();
        let page = page.clone();
        tokio::spawn(async move {
            use chromiumoxide::cdp::browser_protocol::network::GetResponseBodyParams;
            while let Some(ev) = events.next().await {
                let key = ev.request_id.inner().to_string();
                let maybe_index = idx.lock().await.get(&key).copied();
                let Some(index) = maybe_index else { continue };
                let wants_body = {
                    let mut guard = net.lock().await;
                    match guard.get_mut(index) {
                        Some(entry) => {
                            entry.size = ev.encoded_data_length;
                            entry.time_ms = ((*ev.timestamp.inner() - entry.started) * 1000.0).max(0.0);
                            matches!(entry.resource.as_str(), "Xhr" | "Fetch") && entry.size < 500_000.0
                        }
                        None => false,
                    }
                };
                if !wants_body {
                    continue;
                }
                let body = match page.execute(GetResponseBodyParams::new(ev.request_id.clone())).await {
                    Ok(response) if !response.result.base64_encoded => Some(redact_body(&response.result.body)),
                    Ok(_) => Some("(binary body not captured)".to_string()),
                    Err(_) => None,
                };
                if let Some(entry) = net.lock().await.get_mut(index) {
                    entry.response_body = body;
                }
            }
        });
    }
    // Failed loads are flagged (kept visible, like Chrome's Network tab).
    if let Ok(mut events) = page.event_listener::<EventLoadingFailed>().await {
        let net = network.clone();
        let idx = index_map.clone();
        tokio::spawn(async move {
            while let Some(ev) = events.next().await {
                let key = ev.request_id.inner().to_string();
                let maybe_index = idx.lock().await.get(&key).copied();
                if let Some(index) = maybe_index {
                    let mut guard = net.lock().await;
                    if let Some(entry) = guard.get_mut(index) {
                        entry.failed = true;
                    }
                }
            }
        });
    }
}

async fn spawn_console_collector(
    page: &chromiumoxide::Page,
) -> std::sync::Arc<Mutex<Vec<String>>> {
    let console: std::sync::Arc<Mutex<Vec<String>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
    let sink = console.clone();
    use chromiumoxide::cdp::js_protocol::runtime::EventConsoleApiCalled;
    if let Ok(mut events) = page.event_listener::<EventConsoleApiCalled>().await {
        tokio::spawn(async move {
            while let Some(event) = events.next().await {
                let text = event
                    .args
                    .iter()
                    .filter_map(|arg| arg.value.as_ref().map(|v| v.to_string()))
                    .collect::<Vec<_>>()
                    .join(" ");
                let level = format!("{:?}", event.r#type);
                let mut guard = sink.lock().await;
                if guard.len() > 200 {
                    guard.remove(0);
                }
                guard.push(format!("[{}] {}", level, text));
            }
        });
    }
    console
}

/// Opens a visible external browser at `url` with a dedicated test profile.
pub async fn devtools_open(repo_path: &Path, url: &str, wait_ms: u64) -> Result<String> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") && url != "about:blank" {
        return Err("url must start with http:// or https://".to_string());
    }
    let _ = std::fs::create_dir_all(repo_path.join(".pigry").join("devtools"));

    // Reuse the open test window when it is still alive: navigating the same
    // page keeps cookies / logins and skips a whole browser relaunch.
    let existing = DEV.lock().await.as_ref().map(|session| session.page.clone());
    if let Some(page) = existing {
        let alive = matches!(
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                page.evaluate_expression("1"),
            )
            .await,
            Ok(Ok(_))
        );
        if alive {
            return navigate_and_summarize(&page, &url, wait_ms).await;
        }
    }

    // Stale or missing session: drop it, then LAUNCH WITHOUT HOLDING the
    // session lock — eval/console calls during the launch fail fast ("no
    // devtools session") instead of blocking for the whole startup.
    devtools_close().await?;
    let (browser, mut handler, profile) = launch_browser().await?;
    // Drive the CDP event stream (console events, lifecycle) in the background.
    tokio::spawn(async move {
        while let Some(event) = handler.next().await {
            let _ = event;
        }
    });
    let page = browser.new_page("about:blank").await.map_err(err)?;
    page.activate().await.map_err(err)?;
    let console = spawn_console_collector(&page).await;
    let network = std::sync::Arc::new(Mutex::new(Vec::new()));
    spawn_network_collector(&page, network.clone()).await;

    // Register the session first so a slow page doesn't leave the browser
    // orphaned (and eval/screenshot work while the page is still loading).
    let session = DevSession {
        browser,
        page: page.clone(),
        console,
        network,
        _profile: profile,
    };
    *DEV.lock().await = Some(session);
    navigate_and_summarize(&page, &url, wait_ms).await
}

/// Navigates `page` to `url`, lets it settle for `wait_ms`, and returns the
/// "opened …" summary (title + the first part of the visible text).
async fn navigate_and_summarize(page: &chromiumoxide::Page, url: &str, wait_ms: u64) -> Result<String> {
    page.goto(url).await.map_err(err)?;
    let wait = wait_ms.clamp(0, 20_000);
    if wait > 0 {
        page.evaluate(format!("new Promise((resolve) => setTimeout(resolve, {wait}))"))
            .await
            .map_err(err)?;
    }
    let title = page
        .get_title()
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let text = page
        .evaluate_expression("document.body ? document.body.innerText.slice(0, 6000) : ''")
        .await
        .map(|result| result.into_value::<String>().unwrap_or_default())
        .unwrap_or_default();
    Ok(format!(
        "opened {url}\ntitle: {title}\n\n{}",
        text.chars().take(4000).collect::<String>()
    ))
}

/// Evaluates JavaScript on the open page, returning the result as text/JSON.
/// JS exceptions come back as a clean one-line error (the exception's
/// description, e.g. "ReferenceError: x is not defined") instead of a raw
/// debug dump.
pub async fn devtools_eval(js: &str) -> Result<String> {
    let page = session_page().await?;
    let eval = match page.evaluate_expression(js).await {
        Ok(eval) => eval,
        Err(chromiumoxide::error::CdpError::JavascriptException(details)) => {
            // JS threw — surface the exception's description (e.g.
            // "ReferenceError: consoel is not defined") as a clean error.
            let description = details
                .exception
                .as_ref()
                .and_then(|exception| exception.description.clone())
                .unwrap_or_else(|| details.text.clone());
            return Err(description);
        }
        Err(other) => return Err(format!("eval failed: {other}")),
    };
    let value: serde_json::Value = eval
        .into_value::<serde_json::Value>()
        .unwrap_or(serde_json::Value::Null);
    Ok(serde_json::to_string_pretty(&value).unwrap_or_else(|_| format!("{value:?}")))
}

/// Returns the console output collected so far (oldest first).
pub async fn devtools_console(limit: usize) -> Result<Vec<String>> {
    let page = session_page().await?;
    let _ = page;
    // Reach the console store through the session: lock the tokio mutex.
    let mut guard = DEV.lock().await;
    let session = guard.as_ref().ok_or_else(|| {
        "no devtools session — open one with action \"open\" first".to_string()
    })?;
    let guard = session.console.lock().await;
    let start = guard.len().saturating_sub(limit);
    Ok(guard[start..].to_vec())
}

/// Returns the Network-panel rows collected so far (JSON, oldest first).
pub async fn devtools_network(limit: usize) -> Result<String> {
    let mut guard = DEV.lock().await;
    let session = guard.as_ref().ok_or_else(|| {
        "no devtools session — call browser_devtools with action \"open\" first".to_string()
    })?;
    let network = session.network.lock().await;
    let start = network.len().saturating_sub(limit);
    Ok(serde_json::to_string(&network[start..]).unwrap_or_else(|_| "[]".to_string()))
}

/// Resolves a workspace-relative `save_as` destination for test evidence.
/// Only files with the given extension (`png`, `json`, `webm`) under the
/// repository's `.pigry/` folder are allowed, so a model-chosen path can never
/// write elsewhere in the workspace.
fn evidence_path(repo_path: &Path, save_as: &str, ext: &str) -> Result<std::path::PathBuf> {
    let rel = save_as.trim().replace('\\', "/");
    let safe = rel.starts_with(".pigry/")
        && rel.to_ascii_lowercase().ends_with(&format!(".{ext}"))
        && !rel.contains("..")
        && !rel.contains(':')
        && !rel.contains("//");
    if !safe {
        return Err(format!(
            "save_as must be a workspace-relative .{ext} path under .pigry/ (e.g. .pigry/reports/qa/evidence/TC-01-login.{ext})"
        ));
    }
    Ok(repo_path.join(rel))
}

/// Index into the network log where the next export starts — each export
/// covers the requests made since the previous one (i.e. since the last test case).
static NET_MARK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Saves the requests captured since the previous export as a JSON evidence
/// file (method, URL, status, timing, redacted headers, request/response
/// bodies for API calls) and returns a short readable summary. `api_only`
/// keeps just XHR / fetch calls.
pub async fn devtools_network_export(repo_path: &Path, save_as: &str, api_only: bool) -> Result<String> {
    use std::sync::atomic::Ordering;
    let path = evidence_path(repo_path, save_as, "json")?;
    let page = session_page().await?;
    let network = {
        let guard = DEV.lock().await;
        guard.as_ref().map(|session| session.network.clone()).ok_or_else(|| {
            "no devtools session — call browser_e2e goto first".to_string()
        })?
    };
    // Give in-flight API calls up to ~3s to get their response (and body)
    // recorded, so the evidence isn't exported half-filled.
    let from = NET_MARK.load(Ordering::SeqCst);
    for _ in 0..30 {
        let pending = network.lock().await.iter().skip(from).any(|entry| {
            matches!(entry.resource.as_str(), "Xhr" | "Fetch") && entry.status == 0 && !entry.failed
        });
        if !pending {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // Let response bodies of just-finished calls land.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    // The main document's response event is not always delivered; take its
    // status from the browser's own navigation timing instead.
    let nav_status = page
        .evaluate_expression("(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0")
        .await
        .ok()
        .and_then(|result| result.into_value::<i64>().ok())
        .unwrap_or(0);
    if nav_status > 0 {
        if let Some(entry) = network
            .lock()
            .await
            .iter_mut()
            .rev()
            .find(|entry| entry.resource == "Document" && entry.status == 0 && !entry.failed)
        {
            entry.status = nav_status;
        }
    }
    let (entries, total) = {
        let network = network.lock().await;
        let total = network.len();
        let from = from.min(total);
        (network[from..].to_vec(), total)
    };
    NET_MARK.store(total, Ordering::SeqCst);
    let selected: Vec<&NetEntry> = entries
        .iter()
        .filter(|entry| !api_only || matches!(entry.resource.as_str(), "Xhr" | "Fetch"))
        .collect();
    let document = serde_json::json!({
        "exportedAtMs": now_ms(),
        "filter": if api_only { "api (XHR/fetch)" } else { "all requests" },
        "note": "Secrets (authorization, cookies, tokens, passwords) are redacted; bodies are capped.",
        "count": selected.len(),
        "requests": selected,
    });
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&document).map_err(err)?).map_err(err)?;
    let mut lines = vec![format!(
        "saved {} {} to {}",
        selected.len(),
        if api_only { "API calls" } else { "requests" },
        save_as.trim()
    )];
    for entry in selected.iter().take(25) {
        let status = if entry.failed { "FAIL".to_string() } else { entry.status.to_string() };
        lines.push(format!("[{status}] {} {} ({:.0}ms)", entry.method, entry.url, entry.time_ms));
    }
    if selected.len() > 25 {
        lines.push(format!("… and {} more in the file", selected.len() - 25));
    }
    Ok(lines.join("\n"))
}

/* ---- test video (screencast → in-browser WebM encode) ---------------------
 * The test page is screencast over CDP; every frame is drawn onto a canvas in a
 * hidden helper tab of the same browser and encoded by MediaRecorder, so no
 * ffmpeg is needed. Frames are acknowledged only after they were drawn
 * (back-pressure), and the last frame is re-drawn every 100 ms so a static
 * page still yields a continuous video. */

struct Recorder {
    helper: chromiumoxide::Page,
    page: chromiumoxide::Page,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
    dest: std::path::PathBuf,
    save_as: String,
    started: std::time::Instant,
    frames: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

static REC: Mutex<Option<Recorder>> = Mutex::const_new(None);

const RECORDER_JS: &str = r#"(() => {
  const st = { img: null, chunks: [], sized: false };
  window.__rec = st;
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 800;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type));
  st.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
  st.rec.ondataavailable = (event) => { if (event.data && event.data.size) st.chunks.push(event.data); };
  st.rec.start(500);
  st.tick = () => {
    if (!st.img) return 0;
    ctx.drawImage(st.img, 0, 0, canvas.width, canvas.height);
    if (track.requestFrame) track.requestFrame();
    return 1;
  };
  st.frame = (b64) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (!st.sized) { canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; st.sized = true; }
      st.img = img; st.tick(); resolve(1);
    };
    img.onerror = () => resolve(0);
    img.src = 'data:image/jpeg;base64,' + b64;
  });
  st.stop = () => new Promise((resolve) => {
    st.rec.onstop = () => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(new Blob(st.chunks, { type: st.rec.mimeType }));
    };
    st.rec.stop();
  });
  return mime || 'none';
})()"#;

/// Starts recording the open test page to `save_as` (a `.webm` under .pigry/).
pub async fn devtools_record_start(repo_path: &Path, save_as: &str) -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::page::{
        EventScreencastFrame, ScreencastFrameAckParams, StartScreencastFormat, StartScreencastParams,
    };
    let dest = evidence_path(repo_path, save_as, "webm")?;
    let mut rec_guard = REC.lock().await;
    if rec_guard.is_some() {
        return Err("a recording is already running — call record_stop first".to_string());
    }
    let (page, helper) = {
        let guard = DEV.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            "no devtools session — call browser_e2e goto first, then record_start".to_string()
        })?;
        let helper = session.browser.new_page("about:blank").await.map_err(err)?;
        (session.page.clone(), helper)
    };
    let mime = helper
        .evaluate(RECORDER_JS)
        .await
        .map_err(|e| format!("could not start the video encoder: {e}"))?
        .into_value::<String>()
        .unwrap_or_default();
    if mime == "none" || mime.is_empty() {
        let _ = helper.close().await;
        return Err("this browser has no WebM encoder — video recording is unavailable".to_string());
    }
    // Keep the test page in front so the screencast keeps producing frames.
    let _ = page.activate().await;
    let mut frames_rx = page.event_listener::<EventScreencastFrame>().await.map_err(err)?;
    page.execute(StartScreencastParams {
        format: Some(StartScreencastFormat::Jpeg),
        quality: Some(60),
        max_width: Some(1280),
        max_height: Some(800),
        every_nth_frame: Some(1),
    })
    .await
    .map_err(|e| format!("could not start the screencast: {e}"))?;

    let frames = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let (task_page, task_helper, task_frames) = (page.clone(), helper.clone(), frames.clone());
    let task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
        let started = std::time::Instant::now();
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = tick.tick() => {
                    if started.elapsed() > std::time::Duration::from_secs(180) { break; }
                    let _ = task_helper.evaluate_expression("window.__rec.tick()").await;
                }
                event = frames_rx.next() => {
                    let Some(event) = event else { break };
                    let data: &str = event.data.as_ref();
                    if task_helper.evaluate_expression(format!("window.__rec.frame('{data}')")).await.is_ok() {
                        task_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    // Acknowledge only after drawing: natural back-pressure.
                    let _ = task_page.execute(ScreencastFrameAckParams::new(event.session_id)).await;
                }
            }
        }
    });
    *rec_guard = Some(Recorder {
        helper,
        page,
        stop: Some(stop_tx),
        task,
        dest,
        save_as: save_as.trim().to_string(),
        started: std::time::Instant::now(),
        frames,
    });
    Ok(format!("recording started → {}", save_as.trim()))
}

/// Stops the recording, writes the WebM file and returns a summary.
pub async fn devtools_record_stop() -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::page::StopScreencastParams;
    use base64::Engine;
    let mut recorder = REC
        .lock()
        .await
        .take()
        .ok_or_else(|| "no recording is running — call record_start first".to_string())?;
    if let Some(stop) = recorder.stop.take() {
        let _ = stop.send(());
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), &mut recorder.task).await;
    let _ = recorder.page.execute(StopScreencastParams::default()).await;
    let encoded = recorder
        .helper
        .evaluate("window.__rec.stop()")
        .await
        .map_err(|e| format!("could not finish the video: {e}"))?
        .into_value::<String>()
        .unwrap_or_default();
    let _ = recorder.helper.close().await;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).map_err(err)?;
    if bytes.is_empty() {
        return Err("the recording produced no video data".to_string());
    }
    if let Some(parent) = recorder.dest.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(&recorder.dest, &bytes).map_err(err)?;
    let seconds = recorder.started.elapsed().as_secs_f32();
    let frames = recorder.frames.load(std::sync::atomic::Ordering::Relaxed);
    Ok(format!(
        "video saved to {} ({:.1}s, {} frames, {} KB)",
        recorder.save_as,
        seconds,
        frames,
        bytes.len() / 1024
    ))
}

/// Screenshots the open page and returns the file path. Without `save_as` it
/// goes to .pigry/devtools/; with it, to that workspace-relative path (used
/// for test evidence that a report links to).
pub async fn devtools_screenshot(repo_path: &Path, save_as: Option<&str>, opts: Option<&str>) -> Result<String> {
    let path = match save_as.map(str::trim).filter(|value| !value.is_empty()) {
        Some(dest) => {
            let path = evidence_path(repo_path, dest, "png")?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(err)?;
            }
            path
        }
        None => {
            let dir = repo_path.join(".pigry").join("devtools");
            let _ = std::fs::create_dir_all(&dir);
            dir.join(format!("shot-{}.png", now_ms()))
        }
    };
    let page = session_page().await?;
    // opts: {"fullPage": true} or {"clip": {"x":..,"y":..,"w":..,"h":..}} (page coordinates, CSS px)
    let mut builder = ScreenshotParams::builder();
    if let Some(raw) = opts.map(str::trim).filter(|v| !v.is_empty()) {
        let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("bad screenshot options: {e}"))?;
        if value.get("fullPage").and_then(|v| v.as_bool()) == Some(true) {
            builder = builder.full_page(true);
        }
        if let Some(clip) = value.get("clip") {
            let n = |key: &str| clip.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
            if n("w") >= 1.0 && n("h") >= 1.0 {
                builder = builder
                    .clip(chromiumoxide::cdp::browser_protocol::page::Viewport {
                        x: n("x"),
                        y: n("y"),
                        width: n("w"),
                        height: n("h"),
                        scale: 1.0,
                    })
                    .capture_beyond_viewport(true);
            }
        }
    }
    page.save_screenshot(builder.build(), path.as_path())
        .await
        .map_err(err)?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(serde::Deserialize, Default)]
struct InputEv {
    t: String,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    button: Option<String>,
    clicks: Option<i64>,
    mods: Option<i64>,
    key: Option<String>,
    code: Option<String>,
    text: Option<String>,
    vk: Option<i64>,
    #[serde(default)]
    dx: f64,
    #[serde(default)]
    dy: f64,
    #[serde(default)]
    delay: u64,
}

/// Dispatches trusted input (mouse, wheel, keyboard, text) through the Input domain — real hover, :hover
/// CSS, focus, drag, typing with delays and key presses, like a user at the keyboard.
pub async fn devtools_input(events_json: &str) -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::input::{
        DispatchKeyEventParams, DispatchKeyEventType, DispatchMouseEventParams, DispatchMouseEventType, InsertTextParams,
        MouseButton,
    };
    let events: Vec<InputEv> = serde_json::from_str(events_json).map_err(|e| format!("bad input events: {e}"))?;
    if events.len() > 4000 {
        return Err("too many input events in one call (max 4000)".to_string());
    }
    let page = session_page().await?;
    for ev in &events {
        match ev.t.as_str() {
            "move" | "down" | "up" | "wheel" => {
                let ty = match ev.t.as_str() {
                    "down" => DispatchMouseEventType::MousePressed,
                    "up" => DispatchMouseEventType::MouseReleased,
                    "wheel" => DispatchMouseEventType::MouseWheel,
                    _ => DispatchMouseEventType::MouseMoved,
                };
                let button = match ev.button.as_deref() {
                    Some("right") => MouseButton::Right,
                    Some("middle") => MouseButton::Middle,
                    Some("none") => MouseButton::None,
                    _ => MouseButton::Left,
                };
                let mut b = DispatchMouseEventParams::builder()
                    .r#type(ty)
                    .x(ev.x)
                    .y(ev.y)
                    .modifiers(ev.mods.unwrap_or(0))
                    .button(button)
                    .click_count(ev.clicks.unwrap_or(1));
                if ev.t == "wheel" {
                    b = b.delta_x(ev.dx).delta_y(ev.dy);
                }
                page.execute(b.build().map_err(err)?).await.map_err(err)?;
            }
            "keydown" | "keyup" => {
                let printable = ev.text.as_deref().map(|t| !t.is_empty()).unwrap_or(false);
                let ty = if ev.t == "keyup" {
                    DispatchKeyEventType::KeyUp
                } else if printable {
                    DispatchKeyEventType::KeyDown
                } else {
                    DispatchKeyEventType::RawKeyDown
                };
                let mut b = DispatchKeyEventParams::builder().r#type(ty).modifiers(ev.mods.unwrap_or(0));
                if let Some(key) = &ev.key {
                    b = b.key(key.clone());
                }
                if let Some(code) = &ev.code {
                    b = b.code(code.clone());
                }
                if let Some(vk) = ev.vk {
                    b = b.windows_virtual_key_code(vk);
                }
                if printable && ev.t != "keyup" {
                    if let Some(text) = &ev.text {
                        b = b.text(text.clone());
                    }
                }
                page.execute(b.build().map_err(err)?).await.map_err(err)?;
            }
            "text" => {
                if let Some(text) = &ev.text {
                    page.execute(InsertTextParams::new(text.clone())).await.map_err(err)?;
                }
            }
            other => return Err(format!("unknown input event type: {other}")),
        }
        if ev.delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(ev.delay.min(5000))).await;
        }
    }
    Ok(format!("{} input events dispatched", events.len()))
}

/// All cookies of the page (httpOnly ones included), as JSON.
pub async fn devtools_cookies() -> Result<String> {
    let page = session_page().await?;
    let cookies = page.get_cookies().await.map_err(err)?;
    let out: Vec<serde_json::Value> = cookies
        .iter()
        .map(|c| {
            serde_json::json!({
                "name": c.name, "value": c.value, "domain": c.domain, "path": c.path,
                "httpOnly": c.http_only, "secure": c.secure, "expires": c.expires,
                "sameSite": c.same_site.as_ref().map(|s| format!("{s:?}")),
            })
        })
        .collect();
    serde_json::to_string(&out).map_err(err)
}

/// Sets a cookie ({name, value, domain?, path?, httpOnly?, secure?, expires?}); without a domain it belongs to the current page.
pub async fn devtools_set_cookie(json: &str) -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::network::CookieParam;
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("bad cookie: {e}"))?;
    let name = v.get("name").and_then(|x| x.as_str()).ok_or("cookie needs a name")?;
    let value = v.get("value").and_then(|x| x.as_str()).unwrap_or("");
    let page = session_page().await?;
    let mut cookie = CookieParam::new(name.to_string(), value.to_string());
    cookie.path = Some(v.get("path").and_then(|x| x.as_str()).unwrap_or("/").to_string());
    if let Some(domain) = v.get("domain").and_then(|x| x.as_str()) {
        cookie.domain = Some(domain.to_string());
    } else if let Ok(Some(url)) = page.url().await {
        cookie.url = Some(url);
    }
    cookie.http_only = v.get("httpOnly").and_then(|x| x.as_bool());
    cookie.secure = v.get("secure").and_then(|x| x.as_bool());
    page.set_cookie(cookie).await.map_err(err)?;
    Ok(format!("cookie {name} set"))
}

/// Deletes the cookie called `name`, or every cookie of the browser when `name` is empty.
pub async fn devtools_clear_cookies(name: Option<&str>) -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::network::{ClearBrowserCookiesParams, DeleteCookiesParams};
    let page = session_page().await?;
    match name.map(str::trim).filter(|n| !n.is_empty()) {
        None => {
            page.execute(ClearBrowserCookiesParams::default()).await.map_err(err)?;
            Ok("all cookies cleared".to_string())
        }
        Some(n) => {
            let cookies = page.get_cookies().await.map_err(err)?;
            let mut count = 0;
            for c in cookies.iter().filter(|c| c.name == n) {
                let mut d = DeleteCookiesParams::new(c.name.clone());
                d.domain = Some(c.domain.clone());
                d.path = Some(c.path.clone());
                page.execute(d).await.map_err(err)?;
                count += 1;
            }
            Ok(format!("{count} cookie(s) named {n} deleted"))
        }
    }
}

/// Extra HTTP headers sent with every request of the page (`{}` clears them) — cy.visit headers / basic auth.
pub async fn devtools_headers(json: &str) -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::network::{Headers, SetExtraHttpHeadersParams};
    let v: serde_json::Value = serde_json::from_str(if json.trim().is_empty() { "{}" } else { json }).map_err(|e| format!("bad headers: {e}"))?;
    let page = session_page().await?;
    page.execute(SetExtraHttpHeadersParams::new(Headers::new(v))).await.map_err(err)?;
    Ok("headers set".to_string())
}

/// Emulates a viewport (responsive CSS testing). `width == 0` clears the
/// override and returns the window to its real size.
pub async fn devtools_viewport(width: i64, height: i64, mobile: bool) -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::emulation::{
        ClearDeviceMetricsOverrideParams, SetDeviceMetricsOverrideParams,
    };
    let page = session_page().await?;
    if width <= 0 {
        page.execute(ClearDeviceMetricsOverrideParams::default()).await.map_err(err)?;
        return Ok("viewport restored to the real window size".to_string());
    }
    if !(200..=4000).contains(&width) || !(200..=4000).contains(&height) {
        return Err("viewport width/height must be between 200 and 4000".to_string());
    }
    page.execute(SetDeviceMetricsOverrideParams::new(width, height, 1.0, mobile))
        .await
        .map_err(err)?;
    Ok(format!("viewport set to {width}x{height}{}", if mobile { " (mobile emulation)" } else { "" }))
}

/// Emulates `prefers-color-scheme` (light / dark) so both themes can be tested;
/// anything else clears the override.
pub async fn devtools_color_scheme(scheme: &str) -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::emulation::{MediaFeature, SetEmulatedMediaParams};
    let page = session_page().await?;
    let scheme = scheme.trim().to_ascii_lowercase();
    let value = if scheme == "light" || scheme == "dark" { scheme.as_str() } else { "" };
    page.execute(SetEmulatedMediaParams {
        media: None,
        features: Some(vec![MediaFeature::new("prefers-color-scheme", value)]),
    })
    .await
    .map_err(err)?;
    Ok(if value.is_empty() {
        "color scheme emulation cleared".to_string()
    } else {
        format!("emulating prefers-color-scheme: {value}")
    })
}

/// Full HTML of the open page (capped).
pub async fn devtools_dom(limit: usize) -> Result<String> {
    let page = session_page().await?;
    let html = page.content().await.map_err(|e| format!("dom failed: {e}"))?;
    Ok(html.chars().take(limit).collect())
}

static INIT_SCRIPT: Mutex<Option<chromiumoxide::cdp::browser_protocol::page::ScriptIdentifier>> =
    Mutex::const_new(None);

/// Registers JavaScript that runs in every new document BEFORE the page's own
/// scripts (replacing the previous one; an empty string just removes it). The
/// E2E runner uses it so its helpers and `cy.intercept` stubs are active from
/// the first request of every navigation.
pub async fn devtools_init_script(js: &str) -> Result<String> {
    use chromiumoxide::cdp::browser_protocol::page::RemoveScriptToEvaluateOnNewDocumentParams;
    let page = session_page().await?;
    let mut slot = INIT_SCRIPT.lock().await;
    if let Some(id) = slot.take() {
        let _ = page.execute(RemoveScriptToEvaluateOnNewDocumentParams::new(id)).await;
    }
    if js.trim().is_empty() {
        return Ok("init script cleared".to_string());
    }
    let result = page.evaluate_on_new_document(js.to_string()).await.map_err(err)?;
    *slot = Some(result);
    Ok(format!("init script registered ({} bytes)", js.len()))
}

/// Closes the devtools session (browser process included).
pub async fn devtools_close() -> Result<String> {
    INIT_SCRIPT.lock().await.take();
    if let Some(recorder) = REC.lock().await.take() {
        // The browser is going away — the recording can't be finished.
        recorder.task.abort();
    }
    NET_MARK.store(0, std::sync::atomic::Ordering::SeqCst);
    let mut guard = DEV.lock().await;
    match guard.take() {
        Some(mut session) => {
            let _ = session.browser.close().await;
            let _ = session.browser.wait().await;
            Ok("devtools session closed".to_string())
        }
        None => Ok("no devtools session was open".to_string()),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ---- CDP attach (dev builds) + headless fallbacks for the panel ----
 * WebView2 does NOT expose the panel's child webviews over the remote
 * debugging port (verified live: /json/list lists only the main window), so
 * cookies stay session-agnostic over CDP (Network.getCookies scopes its
 * answer through `urls`), while screenshot/pdf for the panel fall back to a
 * fresh headless render of the same URL, and network capture / file upload
 * on the panel page are not reachable. */

static ATTACHED: Mutex<Option<Browser>> = Mutex::const_new(None);

#[cfg(debug_assertions)]
fn cdp_off() -> bool {
    false
}

#[cfg(not(debug_assertions))]
fn cdp_off() -> bool {
    true
}

/// Ensures the CDP attach happened, then hands the browser handle back
/// (borrowed — it lives in `guard` across the whole call).
async fn attached(guard: &mut Option<Browser>) -> Result<&Browser> {
    if cdp_off() {
        return Err(
            "CDP tools are only available in dev builds (run `npm run tauri dev`) — the remote debugging port is never exposed in production".to_string(),
        );
    }
    if guard.is_none() {
        let (browser, mut handler) = Browser::connect("http://127.0.0.1:9222")
            .await
            .map_err(|e| {
                format!(
                    "CDP attach to 127.0.0.1:9222 failed ({e}) — the app's debug port isn't up yet; restart `npm run tauri dev`"
                )
            })?;
        tokio::spawn(async move {
            while let Some(event) = handler.next().await {
                let _ = event;
            }
        });
        *guard = Some(browser);
    }
    Ok(guard.as_ref().expect("attached just now"))
}

async fn page_url(page: &chromiumoxide::Page) -> String {
    page.evaluate_expression("location.href")
        .await
        .ok()
        .and_then(|r| r.into_value::<String>().ok())
        .unwrap_or_default()
}

/// Any open page — enough for session-agnostic commands (Network.getCookies
/// scopes its answer through the `urls` parameter).
async fn any_page(guard: &mut Option<Browser>) -> Result<chromiumoxide::Page> {
    let browser = attached(guard).await?;
    let pages = browser.pages().await.map_err(err)?;
    pages
        .first()
        .cloned()
        .ok_or_else(|| "no CDP pages".to_string())
}

/// Strict: the panel page target by url prefix. Usually None — WebView2
/// doesn't expose child webviews over the debugging port (verified live:
/// /json/list only lists the main window); kept for the day that changes.
async fn find_page_exact(
    guard: &mut Option<Browser>,
    url_prefix: &str,
) -> Result<Option<chromiumoxide::Page>> {
    let browser = attached(guard).await?;
    let pages = browser.pages().await.map_err(err)?;
    let norm = url_prefix
        .split('#')
        .next()
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    for page in &pages {
        let u = page_url(page).await;
        let stripped = u.split('#').next().unwrap_or("").trim_end_matches('/').to_string();
        if stripped == norm || stripped.starts_with(&norm) {
            return Ok(Some(page.clone()));
        }
    }
    Ok(None)
}

/// Lists the CDP-attachable pages (url | title per line).
pub async fn cdp_targets() -> Result<Vec<String>> {
    let mut guard = ATTACHED.lock().await;
    let browser = attached(&mut guard).await?;
    let pages = browser.pages().await.map_err(err)?;
    let mut out = Vec::new();
    for page in &pages {
        let url = page_url(page).await;
        let title = page.get_title().await.ok().flatten().unwrap_or_default();
        out.push(format!("{url} | {title}"));
    }
    Ok(out)
}

/// Screenshot for the agent: live capture over CDP when the panel page is
/// exposed as a target, otherwise a fresh headless render of the same URL.
pub async fn cdp_screenshot(url_prefix: &str) -> Result<String> {
    let mut guard = ATTACHED.lock().await;
    let path = std::env::temp_dir().join(format!("pigry-e2e-shot-{}.png", now_ms()));
    if let Some(page) = find_page_exact(&mut guard, url_prefix).await? {
        page.save_screenshot(ScreenshotParams::builder().build(), path.as_path())
            .await
            .map_err(err)?;
        return Ok(format!("{} (live capture)", path.display()));
    }
    drop(guard);
    crate::web::browser_screenshot_file(url_prefix, &path, 1500)?;
    Ok(format!(
        "{} (fresh headless render of the URL — the panel's live login state is not included)",
        path.display()
    ))
}

/// PDF for the agent: live print over CDP when the panel page is exposed,
/// otherwise a fresh headless print of the same URL.
pub async fn cdp_pdf(url_prefix: &str) -> Result<String> {
    let mut guard = ATTACHED.lock().await;
    let path = std::env::temp_dir().join(format!("pigry-e2e-{}.pdf", now_ms()));
    if let Some(page) = find_page_exact(&mut guard, url_prefix).await? {
        let bytes = page
            .pdf(chromiumoxide::cdp::browser_protocol::page::PrintToPdfParams::builder().build())
            .await
            .map_err(err)?;
        std::fs::write(&path, bytes).map_err(err)?;
        return Ok(format!("{} (live capture)", path.display()));
    }
    drop(guard);
    crate::web::browser_pdf_file(url_prefix, &path)?;
    Ok(format!(
        "{} (fresh headless render of the URL — the panel's live login state is not included)",
        path.display()
    ))
}

/// Cross-domain cookie operations over CDP — beyond the reach of
/// document.cookie. op: list | get | set | delete | clear.
pub async fn cdp_cookies(
    url_prefix: &str,
    op: &str,
    name: &str,
    value: &str,
    max: usize,
) -> Result<String> {
    let mut guard = ATTACHED.lock().await;
    let page = any_page(&mut guard).await?;
    let gets = page
        .execute(
            chromiumoxide::cdp::browser_protocol::network::GetCookiesParams::builder()
                .urls(vec![url_prefix.to_string()])
                .build(),
        )
        .await
        .map_err(err)?;
    let cookies = gets.result.cookies;
    let expire_cookie = |c: &chromiumoxide::cdp::browser_protocol::network::Cookie| {
        chromiumoxide::cdp::browser_protocol::network::SetCookieParams::builder()
            .name(c.name.clone())
            .value(String::new())
            .domain(c.domain.clone())
            .path(c.path.clone())
            .expires(chromiumoxide::cdp::browser_protocol::network::TimeSinceEpoch::new(-1.0))
            .build()
            .map_err(err)
    };
    match op {
        "set" => {
            if name.is_empty() {
                return Err("cookies set needs a name (key)".to_string());
            }
            let params = chromiumoxide::cdp::browser_protocol::network::SetCookieParams::builder()
                .name(name.to_string())
                .value(value.to_string())
                .url(url_prefix.to_string())
                .build()
                .map_err(err)?;
            page.execute(params).await.map_err(err)?;
            Ok(format!("cookie '{name}' set"))
        }
        "delete" => {
            if name.is_empty() {
                return Err("cookies delete needs a name (key)".to_string());
            }
            let mut n = 0;
            for c in &cookies {
                if c.name == name {
                    page.execute(expire_cookie(c)?).await.map_err(err)?;
                    n += 1;
                }
            }
            Ok(format!("deleted {n} cookie(s) named '{name}'"))
        }
        "clear" => {
            let mut n = 0;
            for c in &cookies {
                page.execute(expire_cookie(c)?).await.map_err(err)?;
                n += 1;
            }
            Ok(format!("cleared {n} cookies"))
        }
        "get" => {
            if name.is_empty() {
                return Err("cookies get needs a name (key)".to_string());
            }
            match cookies.iter().find(|c| c.name == name) {
                Some(c) => Ok(c.value.clone()),
                None => Ok("(not found)".to_string()),
            }
        }
        _ => {
            let lines: Vec<String> = cookies
                .iter()
                .map(|c| format!("{}={} (domain {})", c.name, c.value, c.domain))
                .collect();
            let joined = lines.join("\n");
            Ok(if joined.chars().count() > max {
                joined.chars().take(max).collect()
            } else {
                joined
            })
        }
    }
}

/// Panel child webviews are not exposed over CDP — file upload needs
/// DOM.setFileInputFiles on that exact target, so it's not reachable yet.
pub async fn cdp_upload(_url_prefix: &str, _selector: &str, _paths: Vec<String>) -> Result<String> {
    Err(
        "file upload into the panel page isn't supported yet — WebView2 doesn't expose the panel webview over the debugging port, and plain JS cannot set file inputs".to_string(),
    )
}

/// Network-idle wait needs the panel page's own CDP session — not reachable.
pub async fn cdp_network_idle(_url_prefix: &str, _idle_ms: u64, _timeout_ms: u64) -> Result<String> {
    Err(
        "network-idle wait isn't supported for panel pages — WebView2 doesn't expose the panel webview over the debugging port. Use wait_for text/selector instead.".to_string(),
    )
}

#[cfg(test)]
mod evidence_path_tests {
    use super::evidence_path;
    use std::path::Path;

    #[test]
    fn accepts_png_under_pigry_only() {
        let repo = Path::new("repo");
        assert!(evidence_path(repo, ".pigry/reports/qa/evidence/TC-01-login.png", "png").is_ok());
        assert!(evidence_path(repo, r".pigry\reports\qa\a.PNG", "png").is_ok());
        assert!(evidence_path(repo, ".pigry/reports/qa/evidence/TC-01-network.json", "json").is_ok());
        assert!(evidence_path(repo, ".pigry/reports/qa/evidence/TC-01.webm", "webm").is_ok());
        assert!(evidence_path(repo, ".pigry/a.png", "json").is_err());
        for bad in ["src/a.png", ".pigry/../src/a.png", ".pigry/a.txt", "/etc/a.png", "C:/x/a.png", ".pigry//a.png", ""] {
            assert!(evidence_path(repo, bad, "png").is_err(), "should reject {bad}");
        }
    }
}

/// Needs a real Chrome/Edge: `cargo test --lib devtools_real_browser -- --ignored --nocapture`.
#[cfg(test)]
mod real_browser_tests {
    use super::*;
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
                    } else {
                        (
                            "text/html",
                            "Set-Cookie: sid=abc; HttpOnly; Path=/\r\n".to_string(),
                            "<!doctype html><title>t</title><input id=i><button id=b onclick=\"document.title='clicked '+event.isTrusted\" style=\"position:absolute;left:100px;top:100px;width:80px;height:40px\">go</button><p id=p>hello</p>".to_string(),
                        )
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
    async fn devtools_real_browser_input_cookies_headers_screenshot() {
        let base = serve();
        let dir = tempfile::tempdir().unwrap();
        devtools_open(dir.path(), "about:blank", 0).await.unwrap();
        devtools_init_script("window.__initRan = 42;").await.unwrap();
        devtools_open(dir.path(), &format!("{base}/"), 300).await.unwrap();
        assert_eq!(devtools_eval("window.__initRan").await.unwrap().trim(), "42", "init script runs before the page");

        // trusted mouse click on the button
        devtools_input(r#"[{"t":"move","x":120,"y":120},{"t":"down","x":120,"y":120,"button":"left","clicks":1},{"t":"up","x":120,"y":120,"button":"left","clicks":1}]"#).await.unwrap();
        assert!(devtools_eval("document.title").await.unwrap().contains("clicked true"));

        // keyboard text goes to the focused input
        devtools_eval("document.getElementById('i').focus()").await.unwrap();
        devtools_input(r#"[{"t":"text","text":"abc"}]"#).await.unwrap();
        assert!(devtools_eval("document.getElementById('i').value").await.unwrap().contains("abc"));

        // httpOnly cookie is visible through CDP and can be cleared
        let cookies = devtools_cookies().await.unwrap();
        assert!(cookies.contains("sid"), "cookies: {cookies}");
        devtools_set_cookie(&format!(r#"{{"name":"manual","value":"1","url":"{base}/"}}"#)).await.unwrap();
        assert!(devtools_cookies().await.unwrap().contains("manual"));
        devtools_clear_cookies(Some("manual")).await.unwrap();
        assert!(!devtools_cookies().await.unwrap().contains("manual"));

        // extra request headers reach the server
        devtools_headers(r#"{"x-pigry":"yes"}"#).await.unwrap();
        let echoed = devtools_eval(&format!("fetch('{base}/echo').then(r => r.text())")).await.unwrap();
        assert!(echoed.to_lowercase().contains("x-pigry: yes"), "echo: {echoed}");

        // clip and full-page screenshots
        devtools_screenshot(dir.path(), Some(".pigry/reports/t/clip.png"), Some(r#"{"clip":{"x":90,"y":90,"w":120,"h":70}}"#)).await.unwrap();
        devtools_screenshot(dir.path(), Some(".pigry/reports/t/full.png"), Some(r#"{"fullPage":true}"#)).await.unwrap();
        assert!(std::fs::metadata(dir.path().join(".pigry/reports/t/clip.png")).unwrap().len() > 100);
        assert!(std::fs::metadata(dir.path().join(".pigry/reports/t/full.png")).unwrap().len() > 100);
        devtools_close().await.unwrap();
    }
}
