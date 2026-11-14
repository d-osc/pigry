//! Floating in-app browser — native child webviews positioned inside the
//! main window. Uses Tauri multiwebview (behind the `unstable` feature) so
//! external sites render in a real browser engine, not an iframe.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{webview::Color, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, WebviewUrl, WebviewBuilder};

fn label_for(id: &str) -> String {
    format!("browser-{id}")
}

/// Last known bounds of every panel webview. The main window's Moved event
/// re-applies them — WebView2 controllers track an interactive window drag
/// late, so the webviews visibly trail behind the moving window without
/// this nudge.
static WEBVIEW_BOUNDS: LazyLock<Mutex<HashMap<String, Rect>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember_bounds(label: &str, bounds: Rect) {
    WEBVIEW_BOUNDS
        .lock()
        .expect("browser bounds poisoned")
        .insert(label.to_string(), bounds);
}

/// Re-applies the stored bounds to every panel webview (throttled by the
/// caller) — called while the main window is being dragged.
pub fn reposition_all(app: &tauri::AppHandle) {
    let map = WEBVIEW_BOUNDS.lock().expect("browser bounds poisoned").clone();
    for (label, bounds) in map {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.set_bounds(bounds);
        }
    }
}

/// In-page context menu for panel webviews — the menu is built INSIDE the
/// page (same native layer as the site, so nothing can paint over it).
/// Reload / Copy page URL run in-page; Open in new tab / Inspect need the
/// host panel, so they drop `§act:<name>[:data]` markers into the URL
/// fragment channel — the floating panel polls `browser_url` and executes.
const CTX_MENU_INIT: &str = r#"
(function () {
  if (window.__pigryCtxMenu) return;
  window.__pigryCtxMenu = true;
  var menu = null;
  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onDoc(e) { if (menu && !menu.contains(e.target)) closeMenu(); }
  function onKey(e) { if (e.key === 'Escape') closeMenu(); }
  function emit(action, extra) {
    try {
      var h = '%C2%A7act:' + action + (extra ? ':' + extra : '');
      history.replaceState(null, '', '#' + h);
    } catch (err) {}
  }
  function item(label, glyph, fn) {
    var b = document.createElement('div');
    b.style.cssText = 'display:flex;align-items:center;gap:9px;padding:7px 14px;font:12px/1.4 system-ui,sans-serif;color:#e8eaf0;cursor:pointer;white-space:nowrap;user-select:none;';
    b.textContent = glyph + '  ' + label;
    b.addEventListener('mouseenter', function () { b.style.background = 'rgba(255,255,255,0.09)'; });
    b.addEventListener('mouseleave', function () { b.style.background = 'none'; });
    b.addEventListener('click', function (ev) { ev.stopPropagation(); closeMenu(); fn(); });
    return b;
  }
  window.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    closeMenu();
    menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;z-index:2147483647;min-width:200px;padding:4px;background:#1c2028;border:1px solid #3a3f4b;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.55);left:' + e.clientX + 'px;top:' + e.clientY + 'px;user-select:none;';
    menu.appendChild(item('Reload', '\u27F3', function () { location.reload(); }));
    menu.appendChild(item('Copy page URL', '\u29C9', function () { try { navigator.clipboard.writeText(location.href); } catch (err) {} }));
    menu.appendChild(item('Open in new tab', '\uFF0B', function () { emit('newtab', encodeURIComponent(location.href)); }));
    var sep = document.createElement('div');
    sep.style.cssText = 'height:1px;margin:4px 6px;background:#3a3f4b;';
    menu.appendChild(sep);
    menu.appendChild(item('Inspect', '</>', function () { emit('inspect'); }));
    document.body.appendChild(menu);
    var r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) menu.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
    if (r.bottom > window.innerHeight - 4) menu.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
    setTimeout(function () {
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    setTimeout(closeMenu, 15000);
  }, true);
})();
"#;

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width, height)),
    }
}

fn parse_url(url: &str) -> Result<tauri::Url, String> {
    let trimmed = url.trim();
    let filled = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    filled
        .parse::<tauri::Url>()
        .map_err(|e| format!("invalid url: {e}"))
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::Window, String> {
    app.get_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

fn webview_by_id(app: &tauri::AppHandle, id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&label_for(id))
        .ok_or_else(|| format!("browser webview '{id}' not found"))
}

/// Creates (or re-shows/re-bounds) a child webview bound to the given bounds.
#[tauri::command]
pub async fn browser_create(
    app: tauri::AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = label_for(&id);
    let label_for_builder = label.clone();
    let bounds = rect(x, y, width, height);
    remember_bounds(&label, bounds);
    if let Some(existing) = app.get_webview(&label) {
        existing.set_bounds(bounds).map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = main_window(&app)?;
    let parsed = parse_url(&url)?;
    let webview = window
        .add_child(
            WebviewBuilder::new(label_for_builder, WebviewUrl::External(parsed))
                // Opaque background — WebView2's first composition can come
                // out black otherwise.
                //
                // NOTE: do NOT set additional_browser_args here — WebView2
                // requires every controller sharing a user-data folder to use
                // the same environment options as the main window (different
                // args → HRESULT 0x8007139F "not in the correct state").
                .background_color(Color(255, 255, 255, 255))
                // Runs on every page load in this webview — relays
                // right-clicks to the host panel (see CTX_MENU_INIT).
                .initialization_script(CTX_MENU_INIT),
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    webview.set_bounds(bounds).map_err(|e| e.to_string())?;
    let _ = webview.set_focus();

    // Windows/WebView2: the first composition can stay black until the
    // controller is nudged — re-apply bounds + focus shortly after spawn.
    {
        let app = app.clone();
        let bounds = bounds;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if let Some(webview) = app.get_webview(&label) {
                let _ = webview.set_bounds(bounds);
                let _ = webview.set_focus();
            }
        });
    }
    Ok(())
}

/// Moves/resizes a child webview (called during drag/resize/maximize).
#[tauri::command]
pub async fn browser_position(
    app: tauri::AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = label_for(&id);
    let bounds = rect(x, y, width, height);
    remember_bounds(&label, bounds);
    let webview = webview_by_id(&app, &id)?;
    webview.set_bounds(bounds).map_err(|e| e.to_string())?;
    Ok(())
}

/// Shows/hides a child webview (tab switch, minimize).
#[tauri::command]
pub async fn browser_set_visible(
    app: tauri::AppHandle,
    id: String,
    visible: bool,
) -> Result<(), String> {
    let webview = webview_by_id(&app, &id)?;
    if visible {
        webview.show().map_err(|e| e.to_string())?;
    } else {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Navigates a child webview to a new URL.
#[tauri::command]
pub async fn browser_navigate(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    let webview = webview_by_id(&app, &id)?;
    let parsed = parse_url(&url)?;
    webview.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

/// Destroys a child webview (tab or window closed).
#[tauri::command]
pub async fn browser_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label_for(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Evaluates JavaScript in a child webview — fire-and-forget (Tauri's eval
/// carries no return value). The agent's tool uses this to drive the page
/// the panel currently shows (fill inputs, click, submit forms).
#[tauri::command]
pub async fn browser_eval(app: tauri::AppHandle, id: String, js: String) -> Result<(), String> {
    let webview = webview_by_id(&app, &id)?;
    webview.eval(&js).map_err(|e| e.to_string())
}

/// Current URL of a child webview — lets the E2E tool assert navigation and
/// read back results (the page writes them into the URL fragment).
#[tauri::command]
pub async fn browser_url(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let webview = webview_by_id(&app, &id)?;
    Ok(webview.url().map_err(|e| e.to_string())?.to_string())
}

/// Destroys every `browser-*` child webview whose id is NOT in `keep`.
/// A fresh page session (dev hot reload, F5) starts with empty tab state —
/// webviews left over from the previous page load are orphans nobody will
/// close or re-position, floating at stale bounds above all HTML UI.
#[tauri::command]
pub async fn browser_prune(app: tauri::AppHandle, keep: Vec<String>) -> Result<(), String> {
    let keep: Vec<String> = keep.iter().map(|id| label_for(id)).collect();
    let stale: Vec<tauri::Webview> = app
        .webviews()
        .into_iter()
        .filter(|(label, _)| label.starts_with("browser-") && !keep.contains(label))
        .map(|(_, webview)| webview)
        .collect();
    for webview in stale {
        let _ = webview.close();
    }
    Ok(())
}
