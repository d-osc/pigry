//! Floating in-app browser — native child webviews positioned inside the
//! main window. Uses Tauri multiwebview (behind the `unstable` feature) so
//! external sites render in a real browser engine, not an iframe.

use tauri::{webview::Color, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, WebviewUrl, WebviewBuilder};

fn label_for(id: &str) -> String {
    format!("browser-{id}")
}

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
                .background_color(Color(255, 255, 255, 255)),
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
    let webview = webview_by_id(&app, &id)?;
    webview.set_bounds(rect(x, y, width, height)).map_err(|e| e.to_string())?;
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
