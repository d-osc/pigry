//! HTTP client for the RESTful API menu (a Postman-style API client).
//!
//! Requests go out from the backend, not the webview, so CORS never blocks
//! them. Same no-extra-crates approach as `web.rs` / `ai.rs`: a `curl`
//! subprocess. The request body and headers are handed to curl through
//! temporary files (never the command line), the response headers, body and
//! timings come back through files and `--write-out`, so any bytes survive.
//!
//! Every request carries an id; `http_cancel(id)` kills the curl process. A
//! timeout is enforced twice: curl's `--max-time` and a wall-clock guard.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use crate::CommandNoWindow;

/// Bodies larger than this are cut (the response says so with `truncated`).
pub const MAX_BODY: usize = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 10 * 60_000;
/// The guard waits this much longer than curl's own --max-time before it kills the process.
const GUARD_MS: u64 = 3_000;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeader {
    pub key: String,
    pub value: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    /// Caller-chosen id, used by `http_cancel`.
    #[serde(default)]
    pub id: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HttpHeader>,
    /// Body as text (UTF-8)…
    #[serde(default)]
    pub body: Option<String>,
    /// …or as base64 bytes (binary files, multipart bodies). Wins over `body`.
    #[serde(default)]
    pub body_base64: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Follow 3xx redirects (default true).
    #[serde(default)]
    pub follow_redirects: Option<bool>,
    /// Check TLS certificates (default true).
    #[serde(default)]
    pub verify_tls: Option<bool>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHeader {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpTimings {
    pub dns_ms: f64,
    pub connect_ms: f64,
    pub tls_ms: f64,
    pub first_byte_ms: f64,
    pub total_ms: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub http_version: String,
    pub headers: Vec<ResponseHeader>,
    /// The body: UTF-8 text when `encoding` is "utf8", base64 when it is "base64".
    pub body: String,
    pub encoding: String,
    /// Wall-clock time of the request in milliseconds.
    pub time_ms: f64,
    pub timings: HttpTimings,
    /// Bytes of the body as received (after content decoding).
    pub body_size: usize,
    /// Bytes of the response header block.
    pub headers_size: usize,
    pub url: String,
    pub redirects: u32,
    pub truncated: bool,
}

type Result<T> = std::result::Result<T, String>;

fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stops the request with this id. Returns whether one was running.
pub fn cancel(id: &str) -> bool {
    match running().lock() {
        Ok(map) => match map.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        },
        Err(_) => false,
    }
}

const METHOD_CHARS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

fn check_request(req: &HttpRequest) -> Result<String> {
    let method = req.method.trim().to_uppercase();
    if method.is_empty() || method.len() > 24 || !method.chars().all(|c| METHOD_CHARS.contains(c)) {
        return Err(format!("invalid HTTP method \"{}\"", req.method));
    }
    let url = req.url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("only http:// and https:// URLs can be sent (got \"{url}\")"));
    }
    if url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("the URL contains spaces or control characters — encode them first".into());
    }
    for h in &req.headers {
        let key = h.key.trim();
        if key.is_empty() || key.chars().any(|c| c.is_control() || c == ':' || c.is_whitespace()) {
            return Err(format!("invalid header name \"{}\"", h.key));
        }
    }
    Ok(method)
}

/// The header file handed to curl with `-H @file`: one `Name: value` per line
/// (`Name;` sends an empty value). Line breaks in values are dropped.
pub fn header_file_text(headers: &[HttpHeader], has_body: bool) -> String {
    let mut out = String::new();
    let has = |name: &str| headers.iter().any(|h| h.key.trim().eq_ignore_ascii_case(name));
    for h in headers {
        let value: String = h.value.chars().filter(|c| *c != '\r' && *c != '\n').collect();
        let value = value.trim();
        if value.is_empty() {
            out.push_str(&format!("{};\n", h.key.trim()));
        } else {
            out.push_str(&format!("{}: {}\n", h.key.trim(), value));
        }
    }
    // curl would add `Content-Type: application/x-www-form-urlencoded` to any
    // body without one, and `Expect: 100-continue` to large ones: send neither.
    if has_body && !has("content-type") {
        out.push_str("Content-Type:\n");
    }
    if !has("expect") {
        out.push_str("Expect:\n");
    }
    if !has("user-agent") {
        out.push_str(&format!("User-Agent: PigryRuntime/{}\n", env!("CARGO_PKG_VERSION")));
    }
    if !has("accept") {
        out.push_str("Accept: */*\n");
    }
    out
}

/// curl arguments, without the program name.
pub fn curl_args(method: &str, req: &HttpRequest, files: &CurlFiles, timeout_ms: u64, has_body: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-s".into(),
        "-S".into(),
        "--compressed".into(),
        "--max-time".into(),
        format!("{:.3}", timeout_ms as f64 / 1000.0),
        "-H".into(),
        format!("@{}", files.headers),
        "-D".into(),
        files.head_out.clone(),
        "-o".into(),
        files.body_out.clone(),
        "-w".into(),
        WRITE_OUT.into(),
    ];
    if req.follow_redirects.unwrap_or(true) {
        args.push("-L".into());
        args.push("--max-redirs".into());
        args.push("20".into());
    }
    if !req.verify_tls.unwrap_or(true) {
        args.push("-k".into());
    }
    if method == "HEAD" {
        args.push("-I".into());
    } else {
        if has_body {
            args.push("--data-binary".into());
            args.push(format!("@{}", files.body_in));
        }
        // curl picks GET (or POST with a body) by itself, and only then switches
        // to GET on a 303; every other method is forced.
        if !(method == "GET" && !has_body) && !(method == "POST" && has_body) {
            args.push("-X".into());
            args.push(method.to_string());
        }
    }
    args.push("--url".into());
    args.push(req.url.trim().to_string());
    args
}

const WRITE_OUT: &str = "%{http_code}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}|%{num_redirects}|%{url_effective}";

pub struct CurlFiles {
    pub headers: String,
    pub body_in: String,
    pub head_out: String,
    pub body_out: String,
}

/// The status line and headers of the last response in a `-D` dump (redirects
/// and `100 Continue` answers come first, each as its own block).
pub fn parse_header_dump(text: &str) -> (u16, String, String, Vec<ResponseHeader>, usize) {
    let normalized = text.replace("\r\n", "\n");
    let mut blocks: Vec<&str> = normalized.split("\n\n").map(|b| b.trim_matches('\n')).filter(|b| b.starts_with("HTTP/")).collect();
    let Some(last) = blocks.pop() else { return (0, String::new(), String::new(), Vec::new(), 0) };
    let mut lines = last.lines();
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("").trim_start_matches("HTTP/").to_string();
    let status = parts.next().and_then(|s| s.trim().parse::<u16>().ok()).unwrap_or(0);
    let reason = parts.next().unwrap_or("").trim().to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push(ResponseHeader { key: k.trim().to_string(), value: v.trim().to_string() });
        }
    }
    let size = last.len() + 4;
    (status, if reason.is_empty() { reason_phrase(status).to_string() } else { reason }, version, headers, size)
}

/// HTTP/2 status lines carry no reason phrase; show the usual one.
pub fn reason_phrase(status: u16) -> &'static str {
    match status {
        100 => "Continue", 101 => "Switching Protocols", 200 => "OK", 201 => "Created", 202 => "Accepted", 203 => "Non-Authoritative Information",
        204 => "No Content", 205 => "Reset Content", 206 => "Partial Content", 207 => "Multi-Status", 300 => "Multiple Choices", 301 => "Moved Permanently",
        302 => "Found", 303 => "See Other", 304 => "Not Modified", 307 => "Temporary Redirect", 308 => "Permanent Redirect", 400 => "Bad Request",
        401 => "Unauthorized", 402 => "Payment Required", 403 => "Forbidden", 404 => "Not Found", 405 => "Method Not Allowed", 406 => "Not Acceptable",
        407 => "Proxy Authentication Required", 408 => "Request Timeout", 409 => "Conflict", 410 => "Gone", 411 => "Length Required", 412 => "Precondition Failed",
        413 => "Payload Too Large", 414 => "URI Too Long", 415 => "Unsupported Media Type", 416 => "Range Not Satisfiable", 417 => "Expectation Failed",
        418 => "I'm a teapot", 422 => "Unprocessable Content", 423 => "Locked", 425 => "Too Early", 426 => "Upgrade Required", 428 => "Precondition Required",
        429 => "Too Many Requests", 431 => "Request Header Fields Too Large", 451 => "Unavailable For Legal Reasons", 500 => "Internal Server Error",
        501 => "Not Implemented", 502 => "Bad Gateway", 503 => "Service Unavailable", 504 => "Gateway Timeout", 505 => "HTTP Version Not Supported",
        _ => "",
    }
}

/// Whether a body should be shown as text: a textual content type, or bytes that are valid UTF-8 without NULs.
pub fn is_text_body(content_type: &str, bytes: &[u8]) -> bool {
    let ct = content_type.to_ascii_lowercase();
    let textual = ct.starts_with("text/") || ["json", "xml", "javascript", "x-www-form-urlencoded", "yaml", "graphql", "csv", "html", "svg"].iter().any(|t| ct.contains(t));
    let binary = ["image/", "audio/", "video/", "font/", "application/octet-stream", "application/pdf", "application/zip", "application/gzip"].iter().any(|t| ct.starts_with(t)) && !ct.contains("svg");
    match std::str::from_utf8(bytes) {
        Ok(text) => textual || (!binary && !text.contains('\0')),
        Err(_) => false,
    }
}

fn friendly_error(code: Option<i32>, stderr: &str, timeout_ms: u64) -> String {
    let detail = stderr.trim().trim_start_matches("curl: ").to_string();
    let what = match code {
        Some(3) => "The URL is malformed".to_string(),
        Some(5) => "Could not resolve the proxy".to_string(),
        Some(6) => "Could not resolve the host — check the URL and your connection".to_string(),
        Some(7) => "Could not connect to the server — is it running and is the port right?".to_string(),
        Some(28) => format!("The request timed out after {timeout_ms} ms"),
        Some(35) | Some(53) | Some(54) | Some(58) | Some(59) | Some(66) => "The TLS (SSL) handshake failed".to_string(),
        Some(47) => "Too many redirects".to_string(),
        Some(51) | Some(60) | Some(77) | Some(83) => "The server's TLS certificate could not be verified — turn off certificate checks in the request settings if you trust it".to_string(),
        Some(52) => "The server returned an empty reply".to_string(),
        Some(55) => "Sending the request failed".to_string(),
        Some(56) => "Receiving the response failed (the connection was reset)".to_string(),
        Some(c) => format!("curl failed with exit code {c}"),
        None => "curl stopped unexpectedly".to_string(),
    };
    if detail.is_empty() { what } else { format!("{what} ({detail})") }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = std::fs::File::create(path).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

/// Sends one request and waits for the answer (blocking; run it off the async runtime).
pub fn send(req: &HttpRequest) -> Result<HttpResponse> {
    let method = check_request(req)?;
    let timeout_ms = req.timeout_ms.filter(|t| *t > 0).unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);
    let body: Option<Vec<u8>> = match (&req.body_base64, &req.body) {
        (Some(b64), _) => Some(base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| format!("the body is not valid base64: {e}"))?),
        (None, Some(text)) => Some(text.as_bytes().to_vec()),
        (None, None) => None,
    };
    let has_body = body.as_ref().is_some_and(|b| !b.is_empty()) && method != "HEAD";

    let dir = tempfile::Builder::new().prefix("pigry-http-").tempdir().map_err(|e| e.to_string())?;
    let p = |name: &str| dir.path().join(name);
    let files = CurlFiles {
        headers: p("req-headers.txt").to_string_lossy().to_string(),
        body_in: p("req-body.bin").to_string_lossy().to_string(),
        head_out: p("res-headers.txt").to_string_lossy().to_string(),
        body_out: p("res-body.bin").to_string_lossy().to_string(),
    };
    write_file(&p("req-headers.txt"), header_file_text(&req.headers, has_body).as_bytes())?;
    if has_body {
        write_file(&p("req-body.bin"), body.as_deref().unwrap_or_default())?;
    }
    let out_path = p("write-out.txt");
    let err_path = p("stderr.txt");
    let stdout = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
    let stderr = std::fs::File::create(&err_path).map_err(|e| e.to_string())?;

    let mut cmd = Command::new("curl");
    cmd.no_window();
    cmd.args(curl_args(&method, req, &files, timeout_ms, has_body));
    cmd.stdin(Stdio::null()).stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));

    let flag = Arc::new(AtomicBool::new(false));
    let id = if req.id.trim().is_empty() { None } else { Some(req.id.clone()) };
    if let Some(id) = &id {
        if let Ok(mut map) = running().lock() {
            map.insert(id.clone(), Arc::clone(&flag));
        }
    }
    struct Unregister(Option<String>);
    impl Drop for Unregister {
        fn drop(&mut self) {
            if let Some(id) = &self.0 {
                if let Ok(mut map) = running().lock() {
                    map.remove(id);
                }
            }
        }
    }
    let _unregister = Unregister(id);

    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("curl is not available: {e}"))?;
    let deadline = Duration::from_millis(timeout_ms + GUARD_MS);
    let status = loop {
        if flag.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Request cancelled".into());
        }
        if started.elapsed() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("The request timed out after {timeout_ms} ms"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    if !status.success() {
        let stderr = std::fs::read_to_string(&err_path).unwrap_or_default();
        return Err(friendly_error(status.code(), &stderr, timeout_ms));
    }

    let head = std::fs::read(&files.head_out).unwrap_or_default();
    let (status_code, status_text, http_version, headers, headers_size) = parse_header_dump(&String::from_utf8_lossy(&head));
    let write_out = std::fs::read_to_string(&out_path).unwrap_or_default();
    let (timings, redirects, effective) = parse_write_out(&write_out, elapsed_ms);
    // `-I` writes the headers into the output file too: a HEAD answer has no body.
    let mut bytes = if method == "HEAD" { Vec::new() } else { std::fs::read(&files.body_out).unwrap_or_default() };
    let body_size = bytes.len();
    let truncated = bytes.len() > MAX_BODY;
    if truncated {
        bytes.truncate(MAX_BODY);
    }
    let content_type = headers.iter().rev().find(|h| h.key.eq_ignore_ascii_case("content-type")).map(|h| h.value.clone()).unwrap_or_default();
    let (body, encoding) = if is_text_body(&content_type, &bytes) {
        (String::from_utf8(bytes).unwrap_or_default(), "utf8")
    } else {
        (base64::engine::general_purpose::STANDARD.encode(&bytes), "base64")
    };
    Ok(HttpResponse {
        status: status_code,
        status_text,
        http_version,
        headers,
        body,
        encoding: encoding.into(),
        time_ms: if timings.total_ms > 0.0 { timings.total_ms } else { elapsed_ms },
        timings,
        body_size,
        headers_size,
        url: if effective.is_empty() { req.url.trim().to_string() } else { effective },
        redirects,
        truncated,
    })
}

/// `%{http_code}|dns|connect|tls|ttfb|total|redirects|url` (seconds) → timings in ms.
pub fn parse_write_out(text: &str, fallback_ms: f64) -> (HttpTimings, u32, String) {
    let parts: Vec<&str> = text.trim().splitn(8, '|').collect();
    let num = |i: usize| parts.get(i).and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok()).unwrap_or(0.0) * 1000.0;
    if parts.len() < 6 {
        return (HttpTimings { total_ms: fallback_ms, ..Default::default() }, 0, String::new());
    }
    let timings = HttpTimings { dns_ms: num(1), connect_ms: num(2), tls_ms: num(3), first_byte_ms: num(4), total_ms: num(5) };
    let redirects = parts.get(6).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    (timings, redirects, parts.get(7).map(|s| s.trim().to_string()).unwrap_or_default())
}

/// YAML (an OpenAPI file) → JSON, for the importer.
pub fn yaml_to_json(text: &str) -> Result<serde_json::Value> {
    let value: serde_yaml::Value = serde_yaml::from_str(text).map_err(|e| format!("not valid YAML: {e}"))?;
    serde_json::to_value(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn http_send(request: HttpRequest) -> Result<HttpResponse> {
    tauri::async_runtime::spawn_blocking(move || send(&request)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn http_cancel(id: String) -> Result<bool> {
    Ok(cancel(&id))
}

#[tauri::command]
pub async fn api_yaml_to_json(text: String) -> Result<serde_json::Value> {
    yaml_to_json(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::net::{TcpListener, TcpStream};

    /// A tiny HTTP/1.1 server on 127.0.0.1 for the tests: one thread per connection.
    fn serve(handler: fn(&str, &str, &[(String, String)], &[u8], &mut TcpStream)) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() { return; }
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let mut headers = Vec::new();
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).is_err() || h.trim().is_empty() { break; }
                        if let Some((k, v)) = h.split_once(':') { headers.push((k.trim().to_lowercase(), v.trim().to_string())); }
                    }
                    let len = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(0);
                    let mut body = vec![0u8; len];
                    let _ = reader.read_exact(&mut body);
                    handler(&method, &path, &headers, &body, &mut stream);
                });
            }
        });
        format!("http://{addr}")
    }

    fn reply(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) {
        let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        for (k, v) in headers { head.push_str(&format!("{k}: {v}\r\n")); }
        head.push_str("\r\n");
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body);
        let _ = stream.flush();
    }

    fn echo(method: &str, path: &str, headers: &[(String, String)], body: &[u8], stream: &mut TcpStream) {
        match path {
            "/redirect" => reply(stream, "302 Found", &[("Location", "/final")], b""),
            "/final" => reply(stream, "200 OK", &[("Content-Type", "text/plain")], format!("final {method}").as_bytes()),
            "/missing" => reply(stream, "404 Not Found", &[("Content-Type", "application/json")], b"{\"error\":\"nope\"}"),
            "/png" => reply(stream, "200 OK", &[("Content-Type", "image/png")], &[0x89, b'P', b'N', b'G', 0, 1, 2, 255]),
            "/cookies" => {
                let head = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: a=1; Path=/\r\nSet-Cookie: b=2; HttpOnly\r\nConnection: close\r\n\r\nok";
                let _ = stream.write_all(head.as_bytes());
            }
            "/slow" => {
                std::thread::sleep(Duration::from_millis(4000));
                reply(stream, "200 OK", &[], b"late");
            }
            _ => {
                let value = serde_json::json!({
                    "method": method,
                    "path": path,
                    "headers": headers.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>(),
                    "body": String::from_utf8_lossy(body),
                    "bodyLen": body.len(),
                });
                reply(stream, "200 OK", &[("Content-Type", "application/json"), ("X-Echo", "yes")], value.to_string().as_bytes());
            }
        }
    }

    fn request(method: &str, url: String) -> HttpRequest {
        HttpRequest { id: String::new(), method: method.into(), url, timeout_ms: Some(8000), ..Default::default() }
    }

    fn json(res: &HttpResponse) -> serde_json::Value {
        serde_json::from_str(&res.body).expect("json body")
    }

    #[test]
    fn get_sends_headers_and_reads_status_headers_and_body() {
        let base = serve(echo);
        let mut req = request("GET", format!("{base}/items?q=1"));
        req.headers = vec![HttpHeader { key: "X-Token".into(), value: "abc 123".into() }, HttpHeader { key: "Accept".into(), value: "application/json".into() }];
        let res = send(&req).expect("send");
        assert_eq!(res.status, 200);
        assert_eq!(res.status_text, "OK");
        assert_eq!(res.encoding, "utf8");
        assert!(res.headers.iter().any(|h| h.key == "X-Echo" && h.value == "yes"));
        let body = json(&res);
        assert_eq!(body["method"], "GET");
        assert_eq!(body["path"], "/items?q=1");
        let sent: Vec<String> = body["headers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert!(sent.contains(&"x-token: abc 123".to_string()));
        assert!(sent.contains(&"accept: application/json".to_string()));
        assert!(sent.iter().any(|h| h.starts_with("user-agent: PigryRuntime/")));
        assert_eq!(res.body_size, res.body.len());
        assert!(res.time_ms > 0.0);
    }

    #[test]
    fn methods_and_bodies_go_out_unchanged() {
        let base = serve(echo);
        for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            let mut req = request(method, format!("{base}/things"));
            req.headers = vec![HttpHeader { key: "Content-Type".into(), value: "application/json".into() }];
            req.body = Some("{\"name\":\"ไทย ✓\",\"n\":1}".into());
            let res = send(&req).expect("send");
            let body = json(&res);
            assert_eq!(body["method"], method);
            assert_eq!(body["body"], "{\"name\":\"ไทย ✓\",\"n\":1}");
            let sent = body["headers"].to_string();
            assert!(sent.contains("content-type: application/json"));
            assert!(!sent.contains("x-www-form-urlencoded"), "curl must not add its own content type");
            assert!(!sent.contains("100-continue"));
        }
        // a body without a content type is sent without one
        let mut req = request("POST", format!("{base}/raw"));
        req.body = Some("plain".into());
        let body = json(&send(&req).unwrap());
        assert!(!body["headers"].to_string().contains("content-type"));
    }

    #[test]
    fn binary_request_and_response_bodies_are_base64() {
        let base = serve(echo);
        let mut req = request("POST", format!("{base}/upload"));
        req.headers = vec![HttpHeader { key: "Content-Type".into(), value: "application/octet-stream".into() }];
        req.body_base64 = Some(base64::engine::general_purpose::STANDARD.encode([0u8, 1, 2, 3, 254, 255]));
        let body = json(&send(&req).unwrap());
        assert_eq!(body["bodyLen"], 6);

        let res = send(&request("GET", format!("{base}/png"))).unwrap();
        assert_eq!(res.encoding, "base64");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(&res.body).unwrap(), vec![0x89, b'P', b'N', b'G', 0, 1, 2, 255]);
        assert_eq!(res.body_size, 8);
    }

    #[test]
    fn error_statuses_are_responses_not_errors() {
        let base = serve(echo);
        let res = send(&request("GET", format!("{base}/missing"))).unwrap();
        assert_eq!(res.status, 404);
        assert_eq!(res.status_text, "Not Found");
        assert_eq!(json(&res)["error"], "nope");
    }

    #[test]
    fn redirects_are_followed_unless_turned_off() {
        let base = serve(echo);
        let res = send(&request("GET", format!("{base}/redirect"))).unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.body, "final GET");
        assert_eq!(res.redirects, 1);
        assert!(res.url.ends_with("/final"));

        let mut req = request("GET", format!("{base}/redirect"));
        req.follow_redirects = Some(false);
        let res = send(&req).unwrap();
        assert_eq!(res.status, 302);
        assert!(res.headers.iter().any(|h| h.key == "Location" && h.value == "/final"));
    }

    #[test]
    fn repeated_headers_such_as_set_cookie_are_kept() {
        let base = serve(echo);
        let res = send(&request("GET", format!("{base}/cookies"))).unwrap();
        let cookies: Vec<&str> = res.headers.iter().filter(|h| h.key.eq_ignore_ascii_case("set-cookie")).map(|h| h.value.as_str()).collect();
        assert_eq!(cookies, vec!["a=1; Path=/", "b=2; HttpOnly"]);
    }

    #[test]
    fn head_requests_return_headers_only() {
        let base = serve(echo);
        let res = send(&request("HEAD", format!("{base}/final"))).unwrap();
        assert_eq!(res.status, 200);
        assert!(res.body.is_empty());
    }

    #[test]
    fn a_slow_server_times_out() {
        let base = serve(echo);
        let mut req = request("GET", format!("{base}/slow"));
        req.timeout_ms = Some(500);
        let started = Instant::now();
        let err = send(&req).unwrap_err();
        assert!(err.contains("timed out after 500 ms"), "{err}");
        assert!(started.elapsed() < Duration::from_millis(3500));
    }

    #[test]
    fn a_request_can_be_cancelled() {
        let base = serve(echo);
        let mut req = request("GET", format!("{base}/slow"));
        req.id = "cancel-me".into();
        let handle = std::thread::spawn(move || send(&req));
        let started = Instant::now();
        while !cancel("cancel-me") {
            assert!(started.elapsed() < Duration::from_secs(3), "request never started");
            std::thread::sleep(Duration::from_millis(10));
        }
        let err = handle.join().unwrap().unwrap_err();
        assert_eq!(err, "Request cancelled");
        assert!(started.elapsed() < Duration::from_millis(2500));
        assert!(!cancel("cancel-me"), "finished requests are unregistered");
    }

    #[test]
    fn bad_input_is_refused_before_anything_is_sent() {
        assert!(send(&request("GET", "ftp://example.com".into())).unwrap_err().contains("http://"));
        assert!(send(&request("GE T", "http://127.0.0.1".into())).unwrap_err().contains("method"));
        assert!(send(&request("GET", "http://127.0.0.1/a b".into())).unwrap_err().contains("spaces"));
        let mut req = request("GET", "http://127.0.0.1".into());
        req.headers = vec![HttpHeader { key: "Bad Name".into(), value: "x".into() }];
        assert!(send(&req).unwrap_err().contains("header name"));
        let mut req = request("POST", "http://127.0.0.1".into());
        req.body_base64 = Some("***".into());
        assert!(send(&req).unwrap_err().contains("base64"));
    }

    #[test]
    fn a_closed_port_is_a_connection_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let err = send(&request("GET", format!("http://127.0.0.1:{port}/"))).unwrap_err();
        assert!(err.contains("Could not connect"), "{err}");
    }

    #[test]
    fn header_dump_takes_the_last_response() {
        let dump = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 301 Moved Permanently\r\nLocation: /b\r\n\r\nHTTP/2 200\r\ncontent-type: text/plain\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n\r\n";
        let (status, text, version, headers, size) = parse_header_dump(dump);
        assert_eq!((status, text.as_str(), version.as_str()), (200, "OK", "2"));
        assert_eq!(headers.len(), 3);
        assert_eq!(headers[2], ResponseHeader { key: "set-cookie".into(), value: "b=2".into() });
        assert!(size > 0);
        assert_eq!(parse_header_dump("").0, 0);
    }

    #[test]
    fn header_file_drops_line_breaks_and_adds_defaults() {
        let text = header_file_text(&[HttpHeader { key: "X-A".into(), value: "1\r\nInjected: yes".into() }, HttpHeader { key: "X-Empty".into(), value: "".into() }], true);
        assert!(text.contains("X-A: 1Injected: yes\n"));
        assert!(text.contains("X-Empty;\n"));
        assert!(text.contains("Content-Type:\n"));
        assert!(text.contains("Expect:\n"));
        let custom = header_file_text(&[HttpHeader { key: "user-agent".into(), value: "me".into() }, HttpHeader { key: "Content-Type".into(), value: "text/plain".into() }], true);
        assert!(!custom.contains("PigryRuntime"));
        assert!(!custom.contains("Content-Type:\n"));
    }

    #[test]
    fn write_out_and_text_detection() {
        let (t, redirects, url) = parse_write_out("200|0.001|0.002|0.000|0.010|0.012|2|http://x/y", 99.0);
        assert_eq!(redirects, 2);
        assert_eq!(url, "http://x/y");
        assert!((t.total_ms - 12.0).abs() < 0.001);
        assert_eq!(parse_write_out("garbage", 5.0).0.total_ms, 5.0);
        assert!(is_text_body("application/vnd.api+json", b"{}"));
        assert!(is_text_body("", b"hello"));
        assert!(!is_text_body("image/png", b"PNG"));
        assert!(is_text_body("image/svg+xml", b"<svg/>"));
        assert!(!is_text_body("", &[0xff, 0xfe, 0x00]));
    }

    #[test]
    fn yaml_becomes_json() {
        let v = yaml_to_json("openapi: 3.0.0\ninfo:\n  title: Pets\npaths:\n  /pets:\n    get:\n      summary: List\n").unwrap();
        assert_eq!(v["info"]["title"], "Pets");
        assert_eq!(v["paths"]["/pets"]["get"]["summary"], "List");
        assert!(yaml_to_json("a: [").is_err());
    }
}
