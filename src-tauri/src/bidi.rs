//! Firefox test window for the E2E runner, driven over WebDriver BiDi (Firefox
//! removed its CDP support in version 129). It offers the same actions as the
//! Chromium session in devtools.rs — open, eval, init script, screenshots,
//! trusted input, cookies, extra headers, viewport, console and network
//! evidence — so `browser_devtools` can dispatch on the picked browser's family.
//!
//! Message building and parsing are pure functions (unit-tested below); the
//! socket, the Firefox process and the session live in `BIDI`.

use crate::devtools::{InputEv, NetEntry};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};

type Result<T> = std::result::Result<T, String>;

const CLOSED: &str = "the Firefox test window was closed — open the page again";
const NO_SESSION: &str = "no devtools session — call browser_devtools with action \"open\" first";
pub const NO_VIDEO: &str = "Video recording needs a Chromium browser (Edge, Chrome…) — Firefox has no screencast over WebDriver BiDi. Pick a Chromium browser in E2E Testing to record a video.";

/* ------------------------------------------------------------ pure helpers */

/// A command frame: `{"id": 1, "method": "...", "params": {...}}`.
pub fn command(id: u64, method: &str, params: Value) -> Value {
    json!({ "id": id, "method": method, "params": params })
}

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Reply(u64, Result<Value>),
    Event(String, Value),
    Ignore,
}

/// Sorts a message from Firefox into a command reply or an event.
pub fn parse_incoming(text: &str) -> Incoming {
    let Ok(message) = serde_json::from_str::<Value>(text) else { return Incoming::Ignore };
    match message.get("type").and_then(Value::as_str) {
        Some("success") => match message.get("id").and_then(Value::as_u64) {
            Some(id) => Incoming::Reply(id, Ok(message.get("result").cloned().unwrap_or(Value::Null))),
            None => Incoming::Ignore,
        },
        Some("error") => match message.get("id").and_then(Value::as_u64) {
            Some(id) => {
                let code = message.get("error").and_then(Value::as_str).unwrap_or("error");
                let text = message.get("message").and_then(Value::as_str).unwrap_or("");
                Incoming::Reply(id, Err(if text.is_empty() { code.to_string() } else { format!("{code}: {text}") }))
            }
            None => Incoming::Ignore,
        },
        Some("event") => Incoming::Event(
            message.get("method").and_then(Value::as_str).unwrap_or("").to_string(),
            message.get("params").cloned().unwrap_or(Value::Null),
        ),
        _ => Incoming::Ignore,
    }
}

/// A BiDi RemoteValue as plain JSON — what CDP's `returnByValue` gives, so
/// `eval` answers the same in both browsers (NaN/Infinity → null, DOM nodes
/// and other handles → {}, functions and symbols → null).
pub fn remote_to_json(remote: &Value) -> Value {
    let value = remote.get("value");
    let list = || value.and_then(Value::as_array).cloned().unwrap_or_default();
    match remote.get("type").and_then(Value::as_str).unwrap_or("") {
        "string" | "boolean" | "date" => value.cloned().unwrap_or(Value::Null),
        "number" => match value {
            Some(Value::Number(n)) => Value::Number(n.clone()),
            Some(Value::String(s)) if s == "-0" => json!(0),
            _ => Value::Null,
        },
        "bigint" => value.and_then(Value::as_str).map(|s| Value::String(s.to_string())).unwrap_or(Value::Null),
        "array" | "set" | "nodelist" | "htmlcollection" => Value::Array(list().iter().map(remote_to_json).collect()),
        "object" | "map" => {
            let mut map = serde_json::Map::new();
            for pair in list() {
                let (Some(key), Some(inner)) = (pair.get(0), pair.get(1)) else { continue };
                let key = match key {
                    Value::String(s) => s.clone(),
                    other => match remote_to_json(other) {
                        Value::String(s) => s,
                        json => json.to_string(),
                    },
                };
                map.insert(key, remote_to_json(inner));
            }
            Value::Object(map)
        }
        "regexp" | "error" | "node" | "window" | "promise" | "weakmap" | "weakset" | "generator" | "proxy"
        | "typedarray" | "arraybuffer" => json!({}),
        _ => Value::Null,
    }
}

/// The value of a `script.evaluate` result, or the exception it threw as a
/// one-line message (e.g. "ReferenceError: x is not defined").
pub fn eval_outcome(result: &Value) -> Result<Value> {
    match result.get("type").and_then(Value::as_str) {
        Some("exception") => {
            let details = result.get("exceptionDetails").cloned().unwrap_or(Value::Null);
            let text = details.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
            Err(if text.is_empty() { "the script threw an exception".to_string() } else { text })
        }
        _ => Ok(remote_to_json(result.get("result").unwrap_or(&Value::Null))),
    }
}

/// `script.evaluate` params: script semantics (the completion value of the
/// last statement), promises awaited, nothing kept alive on the page.
pub fn evaluate_params(context: &str, expression: &str) -> Value {
    json!({
        "expression": expression,
        "target": { "context": context },
        "awaitPromise": true,
        "resultOwnership": "none",
        "userActivation": true,
    })
}

/// WebDriver key value for a key name ("Enter" → U+E007); single characters are themselves.
pub fn key_value(key: &str) -> Option<String> {
    let special = match key {
        "Enter" => '\u{E007}',
        "Tab" => '\u{E004}',
        "Escape" | "Esc" => '\u{E00C}',
        "Backspace" => '\u{E003}',
        "Delete" | "Del" => '\u{E017}',
        "ArrowLeft" => '\u{E012}',
        "ArrowUp" => '\u{E013}',
        "ArrowRight" => '\u{E014}',
        "ArrowDown" => '\u{E015}',
        "Home" => '\u{E011}',
        "End" => '\u{E010}',
        "PageUp" => '\u{E00E}',
        "PageDown" => '\u{E00F}',
        "Insert" => '\u{E016}',
        "Shift" => '\u{E008}',
        "Control" => '\u{E009}',
        "Alt" => '\u{E00A}',
        "Meta" => '\u{E03D}',
        "Space" => ' ',
        _ => {
            if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()).filter(|n| (1..=12).contains(n)) {
                return char::from_u32(0xE031 + n - 1).map(String::from);
            }
            let mut chars = key.chars();
            return match (chars.next(), chars.next()) {
                (Some(c), None) => Some(c.to_string()),
                _ => None,
            };
        }
    };
    Some(special.to_string())
}

/// CDP modifier bits (Alt 1, Ctrl 2, Meta 4, Shift 8) and their WebDriver keys.
const MODIFIERS: [(i64, char); 4] = [(1, '\u{E00A}'), (2, '\u{E009}'), (4, '\u{E03D}'), (8, '\u{E008}')];

/// Turns the runner's input events (the same JSON the CDP path takes) into
/// `input.performActions` sources: one mouse, one keyboard and one wheel
/// source whose action lists stay in step tick by tick. Modifier bits become
/// held modifier keys, delays become pauses, and everything held is released
/// at the end.
pub fn input_sources(events: &[InputEv]) -> Result<Vec<Value>> {
    let pause = || json!({ "type": "pause" });
    let mut pointer: Vec<Value> = Vec::new();
    let mut keys: Vec<Value> = Vec::new();
    let mut wheel: Vec<Value> = Vec::new();
    let mut push = |p: Option<Value>, k: Option<Value>, w: Option<Value>| {
        pointer.push(p.unwrap_or_else(pause));
        keys.push(k.unwrap_or_else(pause));
        wheel.push(w.unwrap_or_else(pause));
    };
    let key_action = |kind: &str, value: String| json!({ "type": kind, "value": value });
    let mut held: i64 = 0;
    let mut position: Option<(i64, i64)> = None;
    for ev in events {
        let want = ev.mods.unwrap_or(0) & 15;
        for (bit, key) in MODIFIERS {
            if want & bit != 0 && held & bit == 0 {
                push(None, Some(key_action("keyDown", key.to_string())), None);
            } else if want & bit == 0 && held & bit != 0 {
                push(None, Some(key_action("keyUp", key.to_string())), None);
            }
        }
        held = want;
        let (x, y) = (ev.x.round() as i64, ev.y.round() as i64);
        let move_to = |push: &mut dyn FnMut(Option<Value>, Option<Value>, Option<Value>)| {
            push(Some(json!({ "type": "pointerMove", "x": x, "y": y, "origin": "viewport" })), None, None);
        };
        match ev.t.as_str() {
            "move" => {
                move_to(&mut push);
                position = Some((x, y));
            }
            "down" | "up" => {
                let button = match ev.button.as_deref() {
                    Some("none") => None,
                    Some("middle") => Some(1),
                    Some("right") => Some(2),
                    _ => Some(0),
                };
                if position != Some((x, y)) {
                    move_to(&mut push);
                    position = Some((x, y));
                }
                if let Some(button) = button {
                    let kind = if ev.t == "down" { "pointerDown" } else { "pointerUp" };
                    push(Some(json!({ "type": kind, "button": button })), None, None);
                }
            }
            "wheel" => push(
                None,
                None,
                Some(json!({ "type": "scroll", "x": x, "y": y, "deltaX": ev.dx.round() as i64, "deltaY": ev.dy.round() as i64, "origin": "viewport" })),
            ),
            "keydown" | "keyup" => {
                let value = ev
                    .key
                    .as_deref()
                    .and_then(key_value)
                    .or_else(|| ev.text.as_deref().and_then(key_value))
                    .ok_or_else(|| format!("Firefox cannot press the key {:?}", ev.key.as_deref().unwrap_or("")))?;
                let kind = if ev.t == "keydown" { "keyDown" } else { "keyUp" };
                push(None, Some(key_action(kind, value)), None);
            }
            "text" => {
                for c in ev.text.as_deref().unwrap_or("").chars() {
                    push(None, Some(key_action("keyDown", c.to_string())), None);
                    push(None, Some(key_action("keyUp", c.to_string())), None);
                }
            }
            other => return Err(format!("unknown input event type: {other}")),
        }
        if ev.delay > 0 {
            push(Some(json!({ "type": "pause", "duration": ev.delay.min(5000) })), None, None);
        }
    }
    for (bit, key) in MODIFIERS {
        if held & bit != 0 {
            push(None, Some(key_action("keyUp", key.to_string())), None);
        }
    }
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![
        json!({ "type": "pointer", "id": "pigry-mouse", "parameters": { "pointerType": "mouse" }, "actions": pointer }),
        json!({ "type": "key", "id": "pigry-keys", "actions": keys }),
        json!({ "type": "wheel", "id": "pigry-wheel", "actions": wheel }),
    ])
}

/// `browsingContext.captureScreenshot` params from the runner's options:
/// `{"fullPage": true}` or `{"clip": {x, y, w, h}}` in page (document) coordinates.
pub fn screenshot_params(context: &str, opts: Option<&str>) -> Result<Value> {
    let mut params = json!({ "context": context, "origin": "viewport", "format": { "type": "image/png" } });
    if let Some(raw) = opts.map(str::trim).filter(|v| !v.is_empty()) {
        let value: Value = serde_json::from_str(raw).map_err(|e| format!("bad screenshot options: {e}"))?;
        if value.get("fullPage").and_then(Value::as_bool) == Some(true) {
            params["origin"] = json!("document");
        }
        if let Some(clip) = value.get("clip") {
            let n = |key: &str| clip.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            if n("w") >= 1.0 && n("h") >= 1.0 {
                params["origin"] = json!("document");
                params["clip"] = json!({ "type": "box", "x": n("x"), "y": n("y"), "width": n("w"), "height": n("h") });
            }
        }
    }
    Ok(params)
}

fn bytes_text(bytes: &Value) -> Option<String> {
    let value = bytes.get("value").and_then(Value::as_str)?;
    match bytes.get("type").and_then(Value::as_str) {
        Some("base64") => {
            use base64::Engine;
            let raw = base64::engine::general_purpose::STANDARD.decode(value).ok()?;
            Some(String::from_utf8_lossy(&raw).into_owned())
        }
        _ => Some(value.to_string()),
    }
}

/// A `storage.getCookies` cookie in the shape the CDP path returns.
pub fn cookie_out(cookie: &Value) -> Value {
    let text = |key: &str| cookie.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let same_site = cookie.get("sameSite").and_then(Value::as_str).map(|s| {
        let mut chars = s.chars();
        chars.next().map(|c| c.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
    });
    json!({
        "name": text("name"),
        "value": cookie.get("value").and_then(bytes_text).unwrap_or_default(),
        "domain": text("domain"),
        "path": text("path"),
        "httpOnly": cookie.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
        "secure": cookie.get("secure").and_then(Value::as_bool).unwrap_or(false),
        "expires": cookie.get("expiry").and_then(Value::as_f64).unwrap_or(-1.0),
        "sameSite": same_site,
    })
}

/// The host of an http(s) URL ("http://a.test:8080/x" → "a.test").
pub fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    let host = if host.starts_with('[') { host.split(']').next().map(|h| format!("{h}]"))? } else { host.split(':').next()?.to_string() };
    (!host.is_empty()).then_some(host)
}

/// `storage.setCookie` params from the runner's cookie JSON. Without a domain
/// (or a url to take it from) the cookie belongs to `page_host`.
pub fn set_cookie_params(json_text: &str, page_host: Option<&str>) -> Result<Value> {
    let v: Value = serde_json::from_str(json_text).map_err(|e| format!("bad cookie: {e}"))?;
    let name = v.get("name").and_then(Value::as_str).ok_or("cookie needs a name")?;
    let value = v.get("value").and_then(Value::as_str).unwrap_or("");
    let domain = v
        .get("domain")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| v.get("url").and_then(Value::as_str).and_then(url_host))
        .or_else(|| page_host.map(str::to_string))
        .filter(|d| !d.is_empty())
        .ok_or("the cookie needs a domain — open a page first")?;
    let mut cookie = json!({
        "name": name,
        "value": { "type": "string", "value": value },
        "domain": domain,
        "path": v.get("path").and_then(Value::as_str).unwrap_or("/"),
    });
    for key in ["httpOnly", "secure"] {
        if let Some(flag) = v.get(key).and_then(Value::as_bool) {
            cookie[key] = json!(flag);
        }
    }
    if let Some(expiry) = v.get("expires").or_else(|| v.get("expiry")).and_then(Value::as_f64).filter(|e| *e > 0.0) {
        cookie["expiry"] = json!(expiry.round() as u64);
    }
    if let Some(same_site) = v.get("sameSite").and_then(Value::as_str) {
        let lower = same_site.to_ascii_lowercase();
        if ["strict", "lax", "none"].contains(&lower.as_str()) {
            cookie["sameSite"] = json!(lower);
        }
    }
    Ok(json!({ "cookie": cookie }))
}

/// BiDi header list → `{name: value}`.
pub fn headers_object(list: &Value) -> Value {
    let mut map = serde_json::Map::new();
    for header in list.as_array().into_iter().flatten() {
        let Some(name) = header.get("name").and_then(Value::as_str) else { continue };
        let value = header.get("value").and_then(bytes_text).unwrap_or_default();
        map.insert(name.to_string(), Value::String(value));
    }
    Value::Object(map)
}

/// The request's own headers with the extra ones added (an extra header
/// replaces one of the same name), as a `network.continueRequest` header list.
pub fn merge_headers(original: &Value, extra: &[(String, String)]) -> Vec<Value> {
    let mut out: Vec<Value> = original
        .as_array()
        .into_iter()
        .flatten()
        .filter(|header| {
            let name = header.get("name").and_then(Value::as_str).unwrap_or("");
            !extra.iter().any(|(extra_name, _)| extra_name.eq_ignore_ascii_case(name))
        })
        .cloned()
        .collect();
    out.extend(extra.iter().map(|(name, value)| json!({ "name": name, "value": { "type": "string", "value": value } })));
    out
}

/// The CDP-style resource type of a `network.beforeRequestSent` event
/// (Document, Xhr, Fetch, Script, Stylesheet, Image, Font, Media, Other) — the
/// network evidence keeps API calls by it.
pub fn resource_kind(params: &Value) -> String {
    let request = params.get("request").cloned().unwrap_or(Value::Null);
    let initiator_type = request.get("initiatorType").and_then(Value::as_str).unwrap_or("");
    let destination = request.get("destination").and_then(Value::as_str).unwrap_or("");
    let navigation = params.get("navigation").map(|n| !n.is_null()).unwrap_or(false);
    let kind = match (initiator_type, destination) {
        ("xmlhttprequest", _) => "Xhr",
        ("fetch", _) | ("beacon", _) => "Fetch",
        (_, "document" | "iframe" | "frame") => "Document",
        (_, "script" | "worker" | "sharedworker" | "serviceworker") => "Script",
        (_, "style") => "Stylesheet",
        (_, "image") => "Image",
        (_, "font") => "Font",
        (_, "audio" | "video" | "track") => "Media",
        (_, "manifest") => "Manifest",
        (_, "") if navigation => "Document",
        (_, "") if params.pointer("/initiator/type").and_then(Value::as_str) == Some("script") => "Fetch",
        _ => "Other",
    };
    kind.to_string()
}

/// A console line in the CDP path's format (`[Log] "text" 42`); uncaught page
/// errors come in as `[Error] …`.
pub fn console_line(params: &Value) -> Option<String> {
    let kind = params.get("type").and_then(Value::as_str).unwrap_or("");
    let text = params.get("text").and_then(Value::as_str).unwrap_or("");
    if kind == "javascript" {
        return Some(format!("[Error] {text}"));
    }
    let level = match params.get("method").and_then(Value::as_str).unwrap_or("log") {
        "warn" => "Warning",
        "error" => "Error",
        "info" => "Info",
        "debug" => "Debug",
        "trace" => "Trace",
        "assert" => "Assert",
        "dir" => "Dir",
        "table" => "Table",
        _ => "Log",
    };
    let args: Vec<String> = params
        .get("args")
        .and_then(Value::as_array)
        .map(|args| args.iter().map(|arg| remote_to_json(arg).to_string()).collect())
        .unwrap_or_default();
    let body = if args.is_empty() { serde_json::to_string(text).unwrap_or_default() } else { args.join(" ") };
    Some(format!("[{level}] {body}"))
}

/// Preferences of the temporary test profile: no first-run pages, update
/// checks or session restore; with web security off, CORS checks and mixed
/// content blocking are turned off (Firefox has no switch for cross-origin
/// iframes, unlike Chromium's --disable-web-security).
pub fn user_prefs(web_security_off: bool) -> String {
    let mut prefs = vec![
        ("browser.shell.checkDefaultBrowser", "false"),
        ("browser.startup.homepage_override.mstone", "\"ignore\""),
        ("browser.startup.page", "0"),
        ("browser.aboutwelcome.enabled", "false"),
        ("startup.homepage_welcome_url", "\"about:blank\""),
        ("datareporting.policy.dataSubmissionEnabled", "false"),
        ("datareporting.policy.firstRunURL", "\"\""),
        ("trailhead.firstrun.didSeeAboutWelcome", "true"),
        ("browser.uitour.enabled", "false"),
        ("datareporting.healthreport.uploadEnabled", "false"),
        ("toolkit.telemetry.reportingpolicy.firstRun", "false"),
        ("app.update.disabledForTesting", "true"),
        ("app.update.auto", "false"),
        ("browser.tabs.warnOnClose", "false"),
        ("browser.warnOnQuit", "false"),
        ("browser.sessionstore.resume_from_crash", "false"),
        ("dom.disable_open_during_load", "false"),
        ("signon.rememberSignons", "false"),
        ("browser.translations.automaticallyPopup", "false"),
        ("remote.active-protocols", "1"),
    ];
    if web_security_off {
        prefs.push(("content.cors.disable", "true"));
        prefs.push(("security.mixed_content.block_active_content", "false"));
    }
    prefs.iter().map(|(name, value)| format!("user_pref(\"{name}\", {value});\n")).collect()
}

/* ------------------------------------------------------------- connection */

struct Inner {
    tx: mpsc::UnboundedSender<String>,
    next_id: AtomicU64,
    pending: std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>,
    console: std::sync::Mutex<Vec<String>>,
    network: Arc<Mutex<Vec<NetEntry>>>,
    net_index: std::sync::Mutex<HashMap<String, usize>>,
    /// Extra request headers (cy.visit headers / basic auth), added by the intercept.
    headers: std::sync::Mutex<Vec<(String, String)>>,
    /// Response bodies can be read (`network.addDataCollector`, Firefox 143+).
    collector: AtomicBool,
}

#[derive(Clone)]
struct Client(Arc<Inner>);

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Client {
    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_within(method, params, std::time::Duration::from_secs(60)).await
    }

    async fn call_within(&self, method: &str, params: Value, limit: std::time::Duration) -> Result<Value> {
        let id = self.0.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply_tx, reply_rx) = oneshot::channel();
        lock(&self.0.pending).insert(id, reply_tx);
        if self.0.tx.send(command(id, method, params).to_string()).is_err() {
            lock(&self.0.pending).remove(&id);
            return Err(CLOSED.to_string());
        }
        match tokio::time::timeout(limit, reply_rx).await {
            Ok(Ok(reply)) => reply.map_err(|e| format!("{method} failed: {e}")),
            Ok(Err(_)) => Err(CLOSED.to_string()),
            Err(_) => {
                lock(&self.0.pending).remove(&id);
                Err(format!("Firefox did not answer {method} within {}s", limit.as_secs()))
            }
        }
    }

    /// Sends a command without waiting for its reply (used from the event loop).
    fn fire(&self, method: &str, params: Value) {
        let id = self.0.next_id.fetch_add(1, Ordering::SeqCst);
        let _ = self.0.tx.send(command(id, method, params).to_string());
    }

    async fn handle_event(&self, method: &str, params: Value) {
        match method {
            "log.entryAdded" => {
                if let Some(line) = console_line(&params) {
                    let mut console = lock(&self.0.console);
                    if console.len() > 200 {
                        console.remove(0);
                    }
                    console.push(line);
                }
            }
            "network.beforeRequestSent" => {
                let request = params.get("request").cloned().unwrap_or(Value::Null);
                let id = request.get("request").and_then(Value::as_str).unwrap_or("").to_string();
                if params.get("isBlocked").and_then(Value::as_bool) == Some(true) {
                    let extra = lock(&self.0.headers).clone();
                    let headers = merge_headers(request.get("headers").unwrap_or(&Value::Null), &extra);
                    self.fire("network.continueRequest", json!({ "request": id, "headers": headers }));
                }
                let key = format!("{id}/{}", params.get("redirectCount").and_then(Value::as_u64).unwrap_or(0));
                let entry = NetEntry {
                    method: request.get("method").and_then(Value::as_str).unwrap_or("GET").to_string(),
                    url: request.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
                    resource: resource_kind(&params),
                    started: params.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0,
                    request_headers: Some(crate::devtools::redact_headers(&headers_object(request.get("headers").unwrap_or(&Value::Null)))),
                    ..Default::default()
                };
                let mut network = self.0.network.lock().await;
                lock(&self.0.net_index).insert(key, network.len());
                network.push(entry);
            }
            "network.responseCompleted" | "network.fetchError" => {
                let request = params.get("request").cloned().unwrap_or(Value::Null);
                let id = request.get("request").and_then(Value::as_str).unwrap_or("").to_string();
                let key = format!("{id}/{}", params.get("redirectCount").and_then(Value::as_u64).unwrap_or(0));
                let Some(index) = lock(&self.0.net_index).get(&key).copied() else { return };
                let wants_body = {
                    let mut network = self.0.network.lock().await;
                    let Some(entry) = network.get_mut(index) else { return };
                    let ended = params.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0;
                    entry.time_ms = ((ended - entry.started) * 1000.0).max(0.0);
                    if method == "network.fetchError" {
                        entry.failed = true;
                        false
                    } else {
                        let response = params.get("response").cloned().unwrap_or(Value::Null);
                        entry.status = response.get("status").and_then(Value::as_i64).unwrap_or(0);
                        entry.r#type = response.get("mimeType").and_then(Value::as_str).unwrap_or("").to_string();
                        entry.size = response
                            .get("bytesReceived")
                            .and_then(Value::as_f64)
                            .or_else(|| response.pointer("/content/size").and_then(Value::as_f64))
                            .unwrap_or(0.0);
                        entry.response_headers = Some(crate::devtools::redact_headers(&headers_object(response.get("headers").unwrap_or(&Value::Null))));
                        matches!(entry.resource.as_str(), "Xhr" | "Fetch") && entry.size < 500_000.0
                    }
                };
                if wants_body && self.0.collector.load(Ordering::SeqCst) {
                    let client = self.clone();
                    tokio::spawn(async move {
                        let data = client
                            .call_within("network.getData", json!({ "dataType": "response", "request": id }), std::time::Duration::from_secs(5))
                            .await;
                        let body = data.ok().and_then(|data| data.get("bytes").and_then(bytes_text)).map(|text| crate::devtools::redact_body(&text));
                        if let Some(entry) = client.0.network.lock().await.get_mut(index) {
                            entry.response_body = body;
                        }
                    });
                }
            }
            _ => {}
        }
    }
}

/* ---------------------------------------------------------------- session */

struct Session {
    client: Client,
    context: String,
    child: tokio::process::Child,
    preload: Option<String>,
    intercept: Option<String>,
    _profile: tempfile::TempDir,
}

static BIDI: Mutex<Option<Session>> = Mutex::const_new(None);

/// Whether the open test window is a Firefox one.
pub async fn active() -> bool {
    BIDI.lock().await.is_some()
}

async fn handle() -> Result<(Client, String)> {
    let guard = BIDI.lock().await;
    let session = guard.as_ref().ok_or_else(|| NO_SESSION.to_string())?;
    Ok((session.client.clone(), session.context.clone()))
}

fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.local_addr().map(|addr| addr.port()).map_err(|e| e.to_string())
}

fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        use crate::CommandNoWindow;
        let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).no_window().status();
    }
    let _ = child.start_kill();
}

async fn connect(port: u16, child: &mut tokio::process::Child) -> Result<async_tungstenite::WebSocketStream<async_tungstenite::tokio::ConnectStream>> {
    use async_tungstenite::tungstenite::protocol::WebSocketConfig;
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(256 << 20);
    config.max_frame_size = Some(256 << 20);
    let url = format!("ws://127.0.0.1:{port}/session");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
    loop {
        match async_tungstenite::tokio::connect_async_with_config(url.as_str(), Some(config)).await {
            Ok((socket, _)) => return Ok(socket),
            Err(error) => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!("Firefox exited before it was ready ({status}) — is another Firefox using the same profile?"));
                }
                if std::time::Instant::now() > deadline {
                    return Err(format!("Firefox did not open its WebDriver BiDi port ({error})"));
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        }
    }
}

async fn launch(executable: &str, web_security_off: bool) -> Result<Session> {
    let fail = |e: String| format!("Could not launch Firefox as the test browser: {e}");
    let profile = tempfile::Builder::new().prefix("pigry-firefox-").tempdir().map_err(|e| fail(e.to_string()))?;
    std::fs::write(profile.path().join("user.js"), user_prefs(web_security_off)).map_err(|e| fail(e.to_string()))?;
    let port = free_port().map_err(fail)?;
    let mut command = tokio::process::Command::new(executable);
    command
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--profile")
        .arg(profile.path())
        .args(["--no-remote", "--new-instance"]);
    if cfg!(windows) {
        // keep the launcher process alive for the browser's lifetime so it can be stopped
        command.arg("--wait-for-browser");
    }
    command
        .arg("about:blank")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| fail(e.to_string()))?;
    let socket = match connect(port, &mut child).await {
        Ok(socket) => socket,
        Err(error) => {
            kill_tree(&mut child);
            return Err(fail(error));
        }
    };
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(async_tungstenite::tungstenite::Message::Text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let client = Client(Arc::new(Inner {
        tx,
        next_id: AtomicU64::new(1),
        pending: std::sync::Mutex::new(HashMap::new()),
        console: std::sync::Mutex::new(Vec::new()),
        network: Arc::new(Mutex::new(Vec::new())),
        net_index: std::sync::Mutex::new(HashMap::new()),
        headers: std::sync::Mutex::new(Vec::new()),
        collector: AtomicBool::new(false),
    }));
    let reader = client.clone();
    tokio::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
            let async_tungstenite::tungstenite::Message::Text(text) = message else { continue };
            match parse_incoming(&text) {
                Incoming::Reply(id, reply) => {
                    if let Some(waiter) = lock(&reader.0.pending).remove(&id) {
                        let _ = waiter.send(reply);
                    }
                }
                Incoming::Event(method, params) => reader.handle_event(&method, params).await,
                Incoming::Ignore => {}
            }
        }
        // the socket is gone: everyone still waiting gets "closed"
        lock(&reader.0.pending).clear();
    });

    let started = async {
        // Alerts and confirms are accepted (the page-side library stubs them anyway);
        // older Firefox only knows the string form of the prompt handler.
        let mut created = Err(String::new());
        for prompts in [json!({ "default": "accept" }), json!("accept"), Value::Null] {
            let mut always = json!({ "acceptInsecureCerts": false });
            if !prompts.is_null() {
                always["unhandledPromptBehavior"] = prompts;
            }
            created = client.call("session.new", json!({ "capabilities": { "alwaysMatch": always } })).await;
            if created.is_ok() {
                break;
            }
        }
        created?;
        client
            .call(
                "session.subscribe",
                json!({ "events": ["log.entryAdded", "network.beforeRequestSent", "network.responseCompleted", "network.fetchError"] }),
            )
            .await?;
        let tree = client.call("browsingContext.getTree", json!({ "maxDepth": 0 })).await?;
        let context = tree
            .pointer("/contexts/0/context")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Firefox has no open tab".to_string())?;
        Ok::<String, String>(context)
    }
    .await;
    let context = match started {
        Ok(context) => context,
        Err(error) => {
            kill_tree(&mut child);
            return Err(fail(error));
        }
    };
    // Best effort: response bodies for the network evidence (Firefox 143+) and a 1280×800 window.
    if client
        .call("network.addDataCollector", json!({ "dataTypes": ["response"], "maxEncodedDataSize": 5_000_000 }))
        .await
        .is_ok()
    {
        client.0.collector.store(true, Ordering::SeqCst);
    }
    if let Ok(windows) = client.call("browser.getClientWindows", json!({})).await {
        if let Some(window) = windows.pointer("/clientWindows/0/clientWindow").and_then(Value::as_str) {
            let _ = client
                .call("browser.setClientWindowState", json!({ "clientWindow": window, "state": "normal", "width": 1280, "height": 800 }))
                .await;
        }
    }
    let _ = client.call("browsingContext.activate", json!({ "context": context })).await;
    Ok(Session { client, context, child, preload: None, intercept: None, _profile: profile })
}

async fn navigate_and_summarize(client: &Client, context: &str, url: &str, wait_ms: u64) -> Result<String> {
    client
        .call_within("browsingContext.navigate", json!({ "context": context, "url": url, "wait": "complete" }), std::time::Duration::from_secs(90))
        .await?;
    let wait = wait_ms.clamp(0, 20_000);
    if wait > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
    }
    let read = |expression: &str| {
        let params = evaluate_params(context, expression);
        async move {
            client
                .call("script.evaluate", params)
                .await
                .ok()
                .and_then(|result| eval_outcome(&result).ok())
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default()
        }
    };
    let title = read("document.title").await;
    let text = read("document.body ? document.body.innerText.slice(0, 6000) : ''").await;
    Ok(format!("opened {url}\ntitle: {title}\n\n{}", text.chars().take(4000).collect::<String>()))
}

/// Navigates the open Firefox window when it is still alive; `None` when there is none.
pub async fn reuse(url: &str, wait_ms: u64) -> Option<Result<String>> {
    let (client, context) = handle().await.ok()?;
    let alive = matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), client.call("script.evaluate", evaluate_params(&context, "1"))).await,
        Ok(Ok(_))
    );
    if !alive {
        return None;
    }
    Some(navigate_and_summarize(&client, &context, url, wait_ms).await)
}

/// Launches Firefox with a fresh profile and opens `url`.
pub async fn open(executable: &str, url: &str, wait_ms: u64, web_security_off: bool) -> Result<String> {
    close().await;
    let session = launch(executable, web_security_off).await?;
    let (client, context) = (session.client.clone(), session.context.clone());
    *BIDI.lock().await = Some(session);
    navigate_and_summarize(&client, &context, url, wait_ms).await
}

pub async fn eval(js: &str) -> Result<String> {
    let (client, context) = handle().await?;
    let result = client.call("script.evaluate", evaluate_params(&context, js)).await.map_err(|e| format!("eval failed: {e}"))?;
    let value = eval_outcome(&result)?;
    Ok(serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()))
}

pub async fn init_script(js: &str) -> Result<String> {
    let (client, _) = handle().await?;
    let old = BIDI.lock().await.as_mut().and_then(|session| session.preload.take());
    if let Some(id) = old {
        let _ = client.call("script.removePreloadScript", json!({ "script": id })).await;
    }
    if js.trim().is_empty() {
        return Ok("init script cleared".to_string());
    }
    let result = client
        .call("script.addPreloadScript", json!({ "functionDeclaration": format!("() => {{\n{js}\n}}") }))
        .await?;
    let id = result.get("script").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(session) = BIDI.lock().await.as_mut() {
        session.preload = Some(id);
    }
    Ok(format!("init script registered ({} bytes)", js.len()))
}

pub async fn screenshot(path: &Path, opts: Option<&str>) -> Result<String> {
    use base64::Engine;
    let (client, context) = handle().await?;
    let result = client.call("browsingContext.captureScreenshot", screenshot_params(&context, opts)?).await?;
    let data = result.get("data").and_then(Value::as_str).ok_or("Firefox returned no screenshot")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

pub async fn input(events: &[InputEv]) -> Result<String> {
    let (client, context) = handle().await?;
    let sources = input_sources(events)?;
    if !sources.is_empty() {
        client.call("input.performActions", json!({ "context": context, "actions": sources })).await?;
    }
    Ok(format!("{} input events dispatched", events.len()))
}

async fn all_cookies(client: &Client) -> Result<Vec<Value>> {
    let result = client.call("storage.getCookies", json!({})).await?;
    Ok(result.get("cookies").and_then(Value::as_array).cloned().unwrap_or_default())
}

pub async fn cookies() -> Result<String> {
    let (client, _) = handle().await?;
    let out: Vec<Value> = all_cookies(&client).await?.iter().map(cookie_out).collect();
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

pub async fn set_cookie(json_text: &str) -> Result<String> {
    let (client, context) = handle().await?;
    let host = client
        .call("script.evaluate", evaluate_params(&context, "location.hostname"))
        .await
        .ok()
        .and_then(|result| eval_outcome(&result).ok())
        .and_then(|value| value.as_str().map(str::to_string));
    let params = set_cookie_params(json_text, host.as_deref())?;
    let name = params.pointer("/cookie/name").and_then(Value::as_str).unwrap_or("").to_string();
    client.call("storage.setCookie", params).await?;
    Ok(format!("cookie {name} set"))
}

pub async fn clear_cookies(name: Option<&str>) -> Result<String> {
    let (client, _) = handle().await?;
    match name.map(str::trim).filter(|n| !n.is_empty()) {
        None => {
            client.call("storage.deleteCookies", json!({})).await?;
            Ok("all cookies cleared".to_string())
        }
        Some(n) => {
            let count = all_cookies(&client).await?.iter().filter(|c| c.get("name").and_then(Value::as_str) == Some(n)).count();
            client.call("storage.deleteCookies", json!({ "filter": { "name": n } })).await?;
            Ok(format!("{count} cookie(s) named {n} deleted"))
        }
    }
}

/// Extra headers for every request (`{}` clears them): an intercept holds each
/// request until it is continued with the headers added.
pub async fn headers(json_text: &str) -> Result<String> {
    let (client, _) = handle().await?;
    let v: Value = serde_json::from_str(if json_text.trim().is_empty() { "{}" } else { json_text }).map_err(|e| format!("bad headers: {e}"))?;
    let extra: Vec<(String, String)> = v
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(name, value)| (name.clone(), value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())))
                .collect()
        })
        .unwrap_or_default();
    *lock(&client.0.headers) = extra.clone();
    let intercept = BIDI.lock().await.as_ref().and_then(|session| session.intercept.clone());
    match (extra.is_empty(), intercept) {
        (false, None) => {
            let result = client.call("network.addIntercept", json!({ "phases": ["beforeRequestSent"] })).await?;
            let id = result.get("intercept").and_then(Value::as_str).unwrap_or("").to_string();
            if let Some(session) = BIDI.lock().await.as_mut() {
                session.intercept = Some(id);
            }
        }
        (true, Some(id)) => {
            let _ = client.call("network.removeIntercept", json!({ "intercept": id })).await;
            if let Some(session) = BIDI.lock().await.as_mut() {
                session.intercept = None;
            }
        }
        _ => {}
    }
    Ok("headers set".to_string())
}

pub async fn viewport(width: i64, height: i64, mobile: bool) -> Result<String> {
    let (client, context) = handle().await?;
    if width <= 0 {
        client.call("browsingContext.setViewport", json!({ "context": context, "viewport": null })).await?;
        return Ok("viewport restored to the real window size".to_string());
    }
    if !(200..=4000).contains(&width) || !(200..=4000).contains(&height) {
        return Err("viewport width/height must be between 200 and 4000".to_string());
    }
    client
        .call("browsingContext.setViewport", json!({ "context": context, "viewport": { "width": width, "height": height } }))
        .await?;
    Ok(format!("viewport set to {width}x{height}{}", if mobile { " (Firefox has no mobile emulation — only the size changed)" } else { "" }))
}

pub async fn console(limit: usize) -> Result<Vec<String>> {
    let (client, _) = handle().await?;
    let console = lock(&client.0.console);
    let start = console.len().saturating_sub(limit);
    Ok(console[start..].to_vec())
}

/// The network rows of the Firefox session (the export in devtools.rs reads them).
pub async fn network_store() -> Option<Arc<Mutex<Vec<NetEntry>>>> {
    BIDI.lock().await.as_ref().map(|session| session.client.0.network.clone())
}

pub async fn dom(limit: usize) -> Result<String> {
    let html = eval("(document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '') + document.documentElement.outerHTML").await?;
    let text = serde_json::from_str::<String>(&html).unwrap_or(html);
    Ok(text.chars().take(limit).collect())
}

/// Closes the Firefox window (and its process); a no-op without one.
pub async fn close() -> bool {
    let Some(mut session) = BIDI.lock().await.take() else { return false };
    let _ = session.client.call_within("browser.close", json!({}), std::time::Duration::from_secs(3)).await;
    if tokio::time::timeout(std::time::Duration::from_secs(5), session.child.wait()).await.is_err() {
        kill_tree(&mut session.child);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), session.child.wait()).await;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(json: &str) -> Vec<InputEv> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn builds_commands_and_sorts_replies_from_events() {
        assert_eq!(command(7, "script.evaluate", json!({ "a": 1 })), json!({ "id": 7, "method": "script.evaluate", "params": { "a": 1 } }));
        assert_eq!(parse_incoming(r#"{"type":"success","id":3,"result":{"x":1}}"#), Incoming::Reply(3, Ok(json!({ "x": 1 }))));
        assert_eq!(
            parse_incoming(r#"{"type":"error","id":4,"error":"no such frame","message":"Browsing context gone","stacktrace":""}"#),
            Incoming::Reply(4, Err("no such frame: Browsing context gone".to_string()))
        );
        assert_eq!(parse_incoming(r#"{"type":"error","id":null,"error":"invalid argument"}"#), Incoming::Ignore);
        assert_eq!(
            parse_incoming(r#"{"type":"event","method":"log.entryAdded","params":{"text":"hi"}}"#),
            Incoming::Event("log.entryAdded".to_string(), json!({ "text": "hi" }))
        );
        assert_eq!(parse_incoming("not json"), Incoming::Ignore);
    }

    #[test]
    fn remote_values_become_plain_json_like_cdp_return_by_value() {
        let remote = json!({ "type": "object", "value": [
            ["n", { "type": "number", "value": 42 }],
            ["s", { "type": "string", "value": "hi" }],
            ["nan", { "type": "number", "value": "NaN" }],
            ["neg0", { "type": "number", "value": "-0" }],
            ["u", { "type": "undefined" }],
            ["list", { "type": "array", "value": [{ "type": "boolean", "value": true }, { "type": "null" }] }],
            ["el", { "type": "node", "sharedId": "x" }],
            ["big", { "type": "bigint", "value": "12345678901234567890" }],
            ["m", { "type": "map", "value": [[{ "type": "number", "value": 1 }, { "type": "string", "value": "one" }]] }],
            ["f", { "type": "function" }],
        ] });
        assert_eq!(
            remote_to_json(&remote),
            json!({ "n": 42, "s": "hi", "nan": null, "neg0": 0, "u": null, "list": [true, null], "el": {}, "big": "12345678901234567890", "m": { "1": "one" }, "f": null })
        );
    }

    #[test]
    fn evaluate_results_and_exceptions() {
        assert_eq!(eval_outcome(&json!({ "type": "success", "result": { "type": "string", "value": "ok" }, "realm": "r" })), Ok(json!("ok")));
        assert_eq!(
            eval_outcome(&json!({ "type": "exception", "exceptionDetails": { "text": "ReferenceError: consoel is not defined", "lineNumber": 0 } })),
            Err("ReferenceError: consoel is not defined".to_string())
        );
        let params = evaluate_params("ctx-1", "1 + 1");
        assert_eq!(params["target"], json!({ "context": "ctx-1" }));
        assert_eq!(params["awaitPromise"], json!(true));
        assert_eq!(params["resultOwnership"], json!("none"));
    }

    #[test]
    fn a_click_with_shift_holds_the_modifier_and_keeps_sources_in_step() {
        let sources = input_sources(&ev(r#"[
            {"t":"move","x":120.4,"y":119.6,"button":"none","mods":8},
            {"t":"down","x":120.4,"y":119.6,"button":"left","clicks":1,"mods":8},
            {"t":"up","x":120.4,"y":119.6,"button":"left","clicks":1,"mods":8}
        ]"#))
        .unwrap();
        assert_eq!(sources.len(), 3);
        let actions = |i: usize| sources[i]["actions"].as_array().unwrap().clone();
        let (pointer, keys, wheel) = (actions(0), actions(1), actions(2));
        assert_eq!(pointer.len(), keys.len());
        assert_eq!(pointer.len(), wheel.len());
        assert_eq!(sources[0]["parameters"]["pointerType"], json!("mouse"));
        // tick 0: Shift down; 1: move (rounded); 2: down; 3: up; 4: Shift up
        assert_eq!(keys[0], json!({ "type": "keyDown", "value": "\u{E008}" }));
        assert_eq!(pointer[1], json!({ "type": "pointerMove", "x": 120, "y": 120, "origin": "viewport" }));
        assert_eq!(pointer[2], json!({ "type": "pointerDown", "button": 0 }));
        assert_eq!(pointer[3], json!({ "type": "pointerUp", "button": 0 }));
        assert_eq!(keys[4], json!({ "type": "keyUp", "value": "\u{E008}" }));
        assert_eq!(pointer.len(), 5);
        assert!(wheel.iter().all(|a| a["type"] == "pause"));
    }

    #[test]
    fn right_click_without_a_move_moves_first_and_wheel_scrolls() {
        let sources = input_sources(&ev(r#"[
            {"t":"down","x":10,"y":20,"button":"right"},
            {"t":"up","x":10,"y":20,"button":"right"},
            {"t":"wheel","x":10,"y":20,"dx":0,"dy":300.2}
        ]"#))
        .unwrap();
        let pointer = sources[0]["actions"].as_array().unwrap();
        assert_eq!(pointer[0]["type"], json!("pointerMove"));
        assert_eq!(pointer[1], json!({ "type": "pointerDown", "button": 2 }));
        assert_eq!(pointer[2], json!({ "type": "pointerUp", "button": 2 }), "no second move at the same spot");
        assert_eq!(sources[2]["actions"][3], json!({ "type": "scroll", "x": 10, "y": 20, "deltaX": 0, "deltaY": 300, "origin": "viewport" }));
    }

    #[test]
    fn typing_keys_text_and_delays() {
        let sources = input_sources(&ev(r#"[
            {"t":"keydown","key":"a","code":"KeyA","text":"a","vk":65,"delay":30},
            {"t":"keyup","key":"a","code":"KeyA"},
            {"t":"keydown","key":"Enter","code":"Enter","vk":13,"text":"\r"},
            {"t":"keyup","key":"Enter","code":"Enter","vk":13},
            {"t":"text","text":"éü"}
        ]"#))
        .unwrap();
        let keys = sources[1]["actions"].as_array().unwrap();
        let pointer = sources[0]["actions"].as_array().unwrap();
        assert_eq!(keys[0], json!({ "type": "keyDown", "value": "a" }));
        assert_eq!(pointer[1], json!({ "type": "pause", "duration": 30 }), "the delay is a pause after the key");
        assert_eq!(keys[2], json!({ "type": "keyUp", "value": "a" }));
        assert_eq!(keys[3], json!({ "type": "keyDown", "value": "\u{E007}" }));
        assert_eq!(keys[5], json!({ "type": "keyDown", "value": "é" }));
        assert_eq!(keys[8], json!({ "type": "keyUp", "value": "ü" }));
        assert!(input_sources(&ev(r#"[{"t":"keydown","key":"Unidentified"}]"#)).is_err());
        assert!(input_sources(&ev(r#"[{"t":"bogus"}]"#)).is_err());
        assert!(input_sources(&[]).unwrap().is_empty());
        assert_eq!(key_value("F5").as_deref(), Some("\u{E035}"));
        assert_eq!(key_value(" ").as_deref(), Some(" "));
    }

    #[test]
    fn ctrl_held_across_keys_is_pressed_once() {
        let sources = input_sources(&ev(r#"[
            {"t":"keydown","key":"a","text":"a","mods":2},{"t":"keyup","key":"a","mods":2},
            {"t":"keydown","key":"c","text":"c","mods":2},{"t":"keyup","key":"c","mods":2}
        ]"#))
        .unwrap();
        let keys: Vec<Value> = sources[1]["actions"].as_array().unwrap().clone();
        let ctrl_downs = keys.iter().filter(|a| a == &&json!({ "type": "keyDown", "value": "\u{E009}" })).count();
        assert_eq!(ctrl_downs, 1);
        assert_eq!(keys.last().unwrap(), &json!({ "type": "keyUp", "value": "\u{E009}" }));
    }

    #[test]
    fn screenshot_options_map_to_origin_and_clip() {
        let plain = screenshot_params("c", None).unwrap();
        assert_eq!(plain["origin"], json!("viewport"));
        assert!(plain.get("clip").is_none());
        assert_eq!(screenshot_params("c", Some(r#"{"fullPage":true}"#)).unwrap()["origin"], json!("document"));
        let clip = screenshot_params("c", Some(r#"{"clip":{"x":90,"y":90,"w":120,"h":70}}"#)).unwrap();
        assert_eq!(clip["clip"], json!({ "type": "box", "x": 90.0, "y": 90.0, "width": 120.0, "height": 70.0 }));
        assert_eq!(clip["origin"], json!("document"));
        assert!(screenshot_params("c", Some("{bad")).is_err());
    }

    #[test]
    fn cookies_in_and_out() {
        let out = cookie_out(&json!({ "name": "sid", "value": { "type": "string", "value": "abc" }, "domain": "127.0.0.1", "path": "/", "size": 6, "httpOnly": true, "secure": false, "sameSite": "lax" }));
        assert_eq!(out, json!({ "name": "sid", "value": "abc", "domain": "127.0.0.1", "path": "/", "httpOnly": true, "secure": false, "expires": -1.0, "sameSite": "Lax" }));
        let b64 = cookie_out(&json!({ "name": "b", "value": { "type": "base64", "value": "aGk=" }, "expiry": 1900000000 }));
        assert_eq!(b64["value"], json!("hi"));
        assert_eq!(b64["expires"], json!(1900000000.0));

        let params = set_cookie_params(r#"{"name":"manual","value":"1","httpOnly":true,"expires":1900000000.4}"#, Some("app.test")).unwrap();
        assert_eq!(params, json!({ "cookie": { "name": "manual", "value": { "type": "string", "value": "1" }, "domain": "app.test", "path": "/", "httpOnly": true, "expiry": 1900000000u64 } }));
        let from_url = set_cookie_params(r#"{"name":"x","value":"","url":"http://127.0.0.1:5555/"}"#, Some("other")).unwrap();
        assert_eq!(from_url["cookie"]["domain"], json!("127.0.0.1"));
        assert!(set_cookie_params(r#"{"value":"1"}"#, Some("a")).is_err());
        assert!(set_cookie_params(r#"{"name":"x"}"#, None).is_err());
        assert_eq!(url_host("https://user@a.test:8080/x?y"), Some("a.test".to_string()));
        assert_eq!(url_host("http://[::1]:80/"), Some("[::1]".to_string()));
        assert_eq!(url_host("about:blank"), None);
    }

    #[test]
    fn extra_headers_replace_same_named_ones() {
        let original = json!([
            { "name": "Accept", "value": { "type": "string", "value": "*/*" } },
            { "name": "X-Pigry", "value": { "type": "string", "value": "old" } },
        ]);
        let merged = merge_headers(&original, &[("x-pigry".to_string(), "yes".to_string()), ("Authorization".to_string(), "Basic abc".to_string())]);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0]["name"], json!("Accept"));
        assert_eq!(merged[1], json!({ "name": "x-pigry", "value": { "type": "string", "value": "yes" } }));
        assert_eq!(headers_object(&original), json!({ "Accept": "*/*", "X-Pigry": "old" }));
    }

    #[test]
    fn network_events_get_cdp_resource_types() {
        let kind = |params: Value| resource_kind(&params);
        assert_eq!(kind(json!({ "navigation": "n1", "request": { "destination": "document", "initiatorType": null } })), "Document");
        assert_eq!(kind(json!({ "navigation": "n1", "request": {} })), "Document");
        assert_eq!(kind(json!({ "navigation": null, "request": { "destination": "", "initiatorType": "fetch" } })), "Fetch");
        assert_eq!(kind(json!({ "navigation": null, "request": { "destination": "", "initiatorType": "xmlhttprequest" } })), "Xhr");
        assert_eq!(kind(json!({ "navigation": null, "request": { "destination": "script", "initiatorType": "script" } })), "Script");
        assert_eq!(kind(json!({ "navigation": null, "request": { "destination": "image" } })), "Image");
        assert_eq!(kind(json!({ "navigation": null, "request": {}, "initiator": { "type": "script" } })), "Fetch");
        assert_eq!(kind(json!({ "navigation": null, "request": {} })), "Other");
    }

    #[test]
    fn console_lines_match_the_cdp_format() {
        let line = console_line(&json!({ "type": "console", "method": "warn", "level": "warn", "text": "careful 3", "args": [{ "type": "string", "value": "careful" }, { "type": "number", "value": 3 }] }));
        assert_eq!(line.as_deref(), Some("[Warning] \"careful\" 3"));
        assert_eq!(console_line(&json!({ "type": "console", "method": "log", "text": "plain" })).as_deref(), Some("[Log] \"plain\""));
        assert_eq!(console_line(&json!({ "type": "javascript", "level": "error", "text": "TypeError: x is null" })).as_deref(), Some("[Error] TypeError: x is null"));
    }

    #[test]
    fn profile_prefs_turn_off_cors_only_without_web_security() {
        let on = user_prefs(false);
        assert!(on.contains("user_pref(\"browser.shell.checkDefaultBrowser\", false);\n"));
        assert!(on.contains("user_pref(\"browser.startup.homepage_override.mstone\", \"ignore\");"));
        assert!(!on.contains("content.cors.disable"));
        assert!(user_prefs(true).contains("user_pref(\"content.cors.disable\", true);"));
    }
}

/// Needs an installed Firefox: `cargo test --lib bidi_real_firefox -- --ignored --nocapture`.
#[cfg(test)]
mod real_firefox_tests {
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
                        (
                            "text/html",
                            "Set-Cookie: sid=abc; HttpOnly; Path=/\r\n".to_string(),
                            "<!doctype html><title>t</title><input id=i><button id=b onclick=\"document.title='clicked '+event.isTrusted\" style=\"position:absolute;left:100px;top:100px;width:80px;height:40px\">go</button><p id=p>hello</p><div style=\"height:3000px\"></div>".to_string(),
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
    async fn bidi_real_firefox_open_eval_input_cookies_headers_screenshot_network() {
        use crate::devtools::*;
        // an installed Firefox, else PIGRY_TEST_FIREFOX=<firefox.exe>, else Playwright's Firefox build
        let installed = crate::browser_detect::detect_browsers().into_iter().find(|b| b.engine == "bidi").map(|b| b.path);
        let playwright = crate::pw_engine::detect()
            .into_iter()
            .find(|b| b.name == "firefox")
            .map(|b| std::path::Path::new(&b.path).join("firefox").join(if cfg!(windows) { "firefox.exe" } else { "firefox" }).to_string_lossy().into_owned());
        let Some(exe) = installed.or_else(|| std::env::var("PIGRY_TEST_FIREFOX").ok()).or(playwright) else {
            eprintln!("no Firefox installed — skipped");
            return;
        };
        eprintln!("Firefox: {exe}");
        let base = serve();
        let dir = tempfile::tempdir().unwrap();
        super::open(&exe, "about:blank", 0, false).await.unwrap();
        assert!(super::active().await, "the Firefox family goes through WebDriver BiDi");
        devtools_init_script("window.__initRan = 42;").await.unwrap();
        let opened = devtools_open(dir.path(), &format!("{base}/"), 300).await.unwrap();
        assert!(opened.contains("title: t"), "{opened}");
        assert_eq!(devtools_eval("window.__initRan").await.unwrap().trim(), "42", "init script runs before the page");
        assert_eq!(devtools_eval("({a: [1, 'x', null]})").await.unwrap().replace([' ', '\n'], ""), r#"{"a":[1,"x",null]}"#);
        assert!(devtools_eval("consoel.log(1)").await.unwrap_err().contains("consoel is not defined"));
        assert_eq!(devtools_eval("new Promise(r => setTimeout(() => r('later'), 50))").await.unwrap().trim(), "\"later\"");

        devtools_input(r#"[{"t":"move","x":120,"y":120},{"t":"down","x":120,"y":120,"button":"left","clicks":1},{"t":"up","x":120,"y":120,"button":"left","clicks":1}]"#).await.unwrap();
        assert!(devtools_eval("document.title").await.unwrap().contains("clicked true"), "a trusted click");
        devtools_eval("document.getElementById('i').focus()").await.unwrap();
        devtools_input(r#"[{"t":"keydown","key":"a","text":"a"},{"t":"keyup","key":"a"},{"t":"text","text":"bé"},{"t":"keydown","key":"Backspace"},{"t":"keyup","key":"Backspace"}]"#).await.unwrap();
        assert_eq!(devtools_eval("document.getElementById('i').value").await.unwrap().trim(), "\"ab\"");
        devtools_input(r#"[{"t":"wheel","x":200,"y":200,"dx":0,"dy":400}]"#).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(devtools_eval("window.scrollY").await.unwrap().trim().parse::<f64>().unwrap() > 0.0, "the wheel scrolled");

        let cookies = devtools_cookies().await.unwrap();
        assert!(cookies.contains("\"sid\"") && cookies.contains("\"httpOnly\":true"), "cookies: {cookies}");
        devtools_set_cookie(r#"{"name":"manual","value":"1"}"#).await.unwrap();
        assert!(devtools_cookies().await.unwrap().contains("manual"));
        devtools_clear_cookies(Some("manual")).await.unwrap();
        assert!(!devtools_cookies().await.unwrap().contains("manual"));

        devtools_headers(r#"{"x-pigry":"yes"}"#).await.unwrap();
        let echoed = devtools_eval(&format!("fetch('{base}/echo').then(r => r.text())")).await.unwrap();
        assert!(echoed.to_lowercase().contains("x-pigry: yes"), "echo: {echoed}");
        devtools_headers("{}").await.unwrap();

        devtools_viewport(800, 600, false).await.unwrap();
        assert_eq!(devtools_eval("innerWidth").await.unwrap().trim(), "800");
        devtools_viewport(0, 0, false).await.unwrap();

        devtools_screenshot(dir.path(), Some(".pigry/reports/t/clip.png"), Some(r#"{"clip":{"x":90,"y":90,"w":120,"h":70}}"#)).await.unwrap();
        devtools_screenshot(dir.path(), Some(".pigry/reports/t/full.png"), Some(r#"{"fullPage":true}"#)).await.unwrap();
        assert!(std::fs::metadata(dir.path().join(".pigry/reports/t/clip.png")).unwrap().len() > 100);
        assert!(std::fs::metadata(dir.path().join(".pigry/reports/t/full.png")).unwrap().len() > 100);

        devtools_eval("console.warn('careful', 3); 1").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let console = devtools_console(20).await.unwrap().join("\n");
        assert!(console.contains("[Warning] \"careful\" 3"), "console: {console}");

        devtools_eval(&format!("fetch('{base}/api').then(r => r.json())")).await.unwrap();
        let summary = devtools_network_export(dir.path(), ".pigry/reports/t/net.json", true).await.unwrap();
        assert!(summary.contains("[200] GET") && summary.contains("/api"), "{summary}");
        let saved = std::fs::read_to_string(dir.path().join(".pigry/reports/t/net.json")).unwrap();
        assert!(!saved.contains("\"secret\""), "the token is redacted");

        assert!(devtools_record_start(dir.path(), ".pigry/reports/t/v.webm").await.unwrap_err().contains("Chromium"));
        devtools_close().await.unwrap();
        assert!(!super::active().await);
    }
}
