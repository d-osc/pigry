//! Browser DevTools session for the agent tool-use loop — a persistent
//! headless Edge/Chrome page driven over the Chrome DevTools Protocol
//! (chromiumoxide). The agent can open a URL, run JavaScript, read console
//! output, take screenshots and extract page text without re-launching.

use chromiumoxide::browser::BrowserConfig;
use chromiumoxide::handler::viewport::Viewport;
use chromiumoxide::page::ScreenshotParams;
use chromiumoxide::Browser;
use futures::StreamExt;
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
    let mut guard = DEV.lock().await;
    *guard = None; // drop any previous session

    let (browser, mut handler) = launch_browser().await?;
    // Drive the CDP event stream (console events, lifecycle) in the background.
    tokio::spawn(async move {
        while let Some(event) = handler.next().await {
            let _ = event;
        }
    });
    let page = browser.new_page("about:blank").await.map_err(err)?;
    let console = spawn_console_collector(&page).await;

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
    };
    *guard = Some(session);
    Ok(format!(
        "opened {url}\ntitle: {title}\n\n{}",
        text.chars().take(4000).collect::<String>()
    ))
}

/// Evaluates JavaScript on the open page, returning the result as text/JSON.
pub async fn devtools_eval(js: &str) -> Result<String> {
    let page = session_page().await?;
    let eval = page.evaluate_expression(js).await.map_err(|e| format!("eval failed: {e}"))?;
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
