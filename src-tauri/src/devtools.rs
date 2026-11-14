//! Browser DevTools session for the agent tool-use loop — a persistent
//! headless Edge/Chrome page driven over the Chrome DevTools Protocol
//! (chromiumoxide). The agent can open a URL, run JavaScript, read console
//! output, take screenshots and extract page text without re-launching.

use chromiumoxide::browser::BrowserConfig;
use chromiumoxide::handler::viewport::Viewport;
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
}

/// One row of the DevTools Network tab — a request observed on the page,
/// enriched as response/finish/fail events arrive.
#[derive(serde::Serialize, Clone, Debug)]
pub struct NetEntry {
    pub method: String,
    pub url: String,
    pub status: i64,
    pub r#type: String,
    pub size: f64,
    pub failed: bool,
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

async fn launch_browser() -> Result<(Browser, chromiumoxide::Handler)> {
    // Prefer the detected Edge/Chrome (same lookup as the playwright tool);
    // fall back to chromiumoxide's own detection.
    let mut config = match browser_candidates()
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file())
    {
        Some(path) => BrowserConfig::builder().chrome_executable(path),
        None => BrowserConfig::builder(),
    };
    config = config.new_headless_mode().window_size(1280, 800);
    let config = config.build().map_err(err)?;
    Browser::launch(config).await.map_err(err)
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
                guard.push(NetEntry {
                    method: ev.request.method.clone(),
                    url: ev.request.url.clone(),
                    status: 0,
                    r#type: String::new(),
                    size: 0.0,
                    failed: false,
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
                    }
                }
            }
        });
    }
    // Finished loads fill in the transferred size.
    if let Ok(mut events) = page.event_listener::<EventLoadingFinished>().await {
        let net = network.clone();
        let idx = index_map.clone();
        tokio::spawn(async move {
            while let Some(ev) = events.next().await {
                let key = ev.request_id.inner().to_string();
                let maybe_index = idx.lock().await.get(&key).copied();
                if let Some(index) = maybe_index {
                    let mut guard = net.lock().await;
                    if let Some(entry) = guard.get_mut(index) {
                        entry.size = ev.encoded_data_length;
                    }
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

/// Opens (or reopens) the persistent headless page at `url`.
pub async fn devtools_open(repo_path: &Path, url: &str, wait_ms: u64) -> Result<String> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("url must start with http:// or https://".to_string());
    }
    // Drop any previous session, then LAUNCH WITHOUT HOLDING the session
    // lock — eval/console calls during the launch fail fast ("no devtools
    // session") instead of blocking for the whole startup.
    {
        let mut guard = DEV.lock().await;
        *guard = None;
    }

    let (browser, mut handler) = launch_browser().await?;
    // Drive the CDP event stream (console events, lifecycle) in the background.
    tokio::spawn(async move {
        while let Some(event) = handler.next().await {
            let _ = event;
        }
    });
    let page = browser.new_page("about:blank").await.map_err(err)?;
    let console = spawn_console_collector(&page).await;
    let network = std::sync::Arc::new(Mutex::new(Vec::new()));
    spawn_network_collector(&page, network.clone()).await;

    page.goto(&url).await.map_err(err)?;
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

    let screenshot_dir = repo_path.join(".pigry").join("devtools");
    let _ = std::fs::create_dir_all(&screenshot_dir);

    let session = DevSession {
        browser,
        page,
        console,
        network,
    };
    let mut guard = DEV.lock().await;
    *guard = Some(session);
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

/// Screenshots the open page into .pigry/devtools/ and returns the file path.
pub async fn devtools_screenshot(repo_path: &Path) -> Result<String> {
    let dir = repo_path.join(".pigry").join("devtools");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("shot-{}.png", now_ms()));
    let page = session_page().await?;
    page.save_screenshot(ScreenshotParams::builder().build(), path.as_path())
        .await
        .map_err(err)?;
    Ok(path.to_string_lossy().to_string())
}

/// Full HTML of the open page (capped).
pub async fn devtools_dom(limit: usize) -> Result<String> {
    let page = session_page().await?;
    let html = page.content().await.map_err(|e| format!("dom failed: {e}"))?;
    Ok(html.chars().take(limit).collect())
}

/// Closes the devtools session (browser process included).
pub async fn devtools_close() -> Result<String> {
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
