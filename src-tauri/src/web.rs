//! Web tools for the agent tool-use loop — no API keys, no extra crates:
//!   web_search — DuckDuckGo Lite results fetched through curl (the same
//!     subprocess pattern as ai.rs; no CORS in the backend).
//!   browser_page — the rendered text of a URL, produced by headless
//!     Edge/Chrome (`--headless=new --dump-dom`), then stripped to text.
//!
//! Both power agent tools (`web_search`, `playwright`) announced to the
//! model in the agent tool-use loop.

use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use crate::CommandNoWindow;

const MAX_RESULTS: usize = 8;
const MAX_TEXT: usize = 16_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub query: String,
    pub hits: Vec<WebHit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPage {
    pub url: String,
    pub title: String,
    pub text: String,
}

type Result<T> = std::result::Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}


fn run_curl_output(url: &str, timeout_secs: u64) -> Result<String> {
    let mut cmd = Command::new("curl");
    cmd.no_window();
    cmd.args([
        "-s",
        "-L",
        "--max-time",
        &timeout_secs.to_string(),
        "-A",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Pigry/1.0",
        url,
    ]);
    cmd.no_window();
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("curl not available: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("curl failed ({}): {}", out.status, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Percent-encodes a query string for use in a URL.
fn urlencode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Decodes common named HTML entities plus numeric references.
fn decode_entities(text: &str) -> String {
    let named = [
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&apos;", "'"),
        ("&#x27;", "'"),
        ("&#39;", "'"),
        ("&nbsp;", "\u{a0}"),
        ("&mdash;", "\u{2014}"),
        ("&ndash;", "\u{2013}"),
        ("&hellip;", "\u{2026}"),
        ("&ldquo;", "\u{201c}"),
        ("&rdquo;", "\u{201d}"),
        ("&lsquo;", "\u{2018}"),
        ("&rsquo;", "\u{2019}"),
    ];
    let mut out = text.to_string();
    for (name, replacement) in named {
        out = out.replace(name, replacement);
    }
    // Numeric references: &#123; and &#x1F600; — walked over chars so
    // multi-byte characters around them are never split.
    let mut final_out = String::new();
    let chars: Vec<char> = out.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '&' && i + 2 < chars.len() && chars[i + 1] == '#' {
            if let Some(semi) = chars[i..].iter().position(|&c| c == ';') {
                let body: String = chars[i + 2..i + semi].iter().collect();
                let parsed = if let Some(hex) = body.strip_prefix('x').or_else(|| body.strip_prefix('X')) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    body.parse::<u32>().ok()
                };
                match parsed.and_then(char::from_u32) {
                    Some(ch) => {
                        final_out.push(ch);
                        i += semi + 1;
                        continue;
                    }
                    None => {}
                }
            }
        }
        final_out.push(chars[i]);
        i += 1;
    }
    final_out
}

/// Removes tags and collapses whitespace into readable text.
fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut last_was_space = true;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                // Block-level tags read better with a space.
                last_was_space = true;
            }
            c if !in_tag => {
                if c.is_whitespace() {
                    if !last_was_space {
                        out.push(' ');
                        last_was_space = true;
                    }
                } else {
                    out.push(c);
                    last_was_space = false;
                }
            }
            _ => {}
        }
    }
    decode_entities(&out.trim())
}

/// Extracts `<title>…</title>` text.
fn extract_title(html: &str) -> String {
    let start = html.find("<title").map(|i| i + html[i..].find('>').map(|o| o + 1).unwrap_or(0));
    let start = match start {
        Some(s) => s,
        None => return String::new(),
    };
    match html[start..].find("</title>") {
        Some(end) => decode_entities(&html[start..start + end]).trim().to_string(),
        None => String::new(),
    }
}

/// Drops scripts/styles/comments so their bodies never reach the text.
fn strip_invisible(html: &str) -> String {
    let openers = [
        ("<script", "</script>"),
        ("<style", "</style>"),
        ("<noscript", "</noscript>"),
        ("<!--", "-->"),
    ];
    let mut out = html.to_string();
    loop {
        let mut removed = false;
        for (open, close) in openers {
            let Some(pos) = find_ci(&out, open) else { continue };
            let Some(close_rel) = find_ci(&out[pos..], close) else {
                // Unterminated block — drop everything from the opener on.
                out.truncate(pos);
                removed = true;
                break;
            };
            let end = pos + close_rel + close.len();
            out.replace_range(pos..end, " ");
            removed = true;
            break;
        }
        if !removed {
            return out;
        }
    }
}

/// Case-insensitive ASCII find — byte positions stay valid.
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let bytes = hay.as_bytes();
    let n = needle.len();
    (0..=hay.len().saturating_sub(n)).find(|&i| {
        bytes[i..i + n]
            .iter()
            .zip(needle.as_bytes())
            .all(|(a, b)| a.to_ascii_lowercase() == b.to_ascii_lowercase())
    })
}

/// Finds the first attribute value for `attr=` right after `marker`.
fn attr_after(html: &str, marker: &str, attr: &str) -> Option<(String, usize)> {
    let pos = html.find(marker)?;
    let rest = &html[pos + marker.len()..];
    // attribute appears within the next 200 chars (inside the tag).
    let window = &rest[..rest.len().min(220)];
    let needle = format!("{attr}=\"");
    let offset = window.find(&needle)?;
    let value_start = offset + needle.len();
    let value_end = window[value_start..]
        .find('"')
        .map(|e| value_start + e)
        .unwrap_or(window.len());
    Some((decode_entities(&window[value_start..value_end]), pos + marker.len()))
}

/// Text between `start_marker`'s tag close and the next `</td>`.
fn td_text_after(html: &str, marker: &str) -> String {
    let Some(pos) = html.find(marker) else {
        return String::new();
    };
    let rest = &html[pos + marker.len()..];
    let open_end = rest.find('>').map(|o| o + 1).unwrap_or(0);
    let body = &rest[open_end..];
    let end = body.find("</td>").unwrap_or(body.len());
    strip_tags(&body[..end])
}

/// DuckDuckGo Lite search — walks the server-rendered result anchors.
/// No API key required.
pub fn web_search(query: &str) -> Result<WebSearchResult> {
    let query = query.trim();
    if query.is_empty() {
        return Err("search query is empty".to_string());
    }
    let url = format!(
        "https://lite.duckduckgo.com/lite/?q={}",
        urlencode(query)
    );
    let html = run_curl_output(&url, 30)?;
    let hits = parse_ddg_hits(&html);
    if hits.is_empty() {
        return Err("no results parsed — DuckDuckGo layout may have changed".to_string());
    }
    Ok(WebSearchResult {
        query: query.to_string(),
        hits: hits.into_iter().take(MAX_RESULTS).collect(),
    })
}

/// Parses DuckDuckGo Lite result anchors
/// (`<a ... href="URL" ... class='result-link'>Title</a>` + the snippet
/// `<td class="result-snippet">`) into hits.
fn parse_ddg_hits(html: &str) -> Vec<WebHit> {
    let mut hits: Vec<WebHit> = Vec::new();
    let mut cursor = 0usize;
    while hits.len() < MAX_RESULTS {
        // Next result anchor (case-insensitive `<a`).
        let Some(rel_a) = find_ci(&html[cursor..], "<a") else { break };
        let a_start = cursor + rel_a;
        // End of the opening tag.
        let Some(tag_close_rel) = find_ci(&html[a_start..], ">") else { break };
        let tag_close = a_start + tag_close_rel;
        let tag = html[a_start..tag_close].to_lowercase();
        // Only result links.
        let Some(href_rel) = tag.find("href=\"") else {
            cursor = tag_close + 1;
            continue;
        };
        let href_start = href_rel + 6;
        let href_end_rel = tag[href_start..].find('"').map(|e| href_start + e);
        let Some(href_end) = href_end_rel else {
            cursor = tag_close + 1;
            continue;
        };
        let is_result = tag.contains("result-link");
        let url = decode_entities(&tag[href_start..href_end]);
        // Anchor inner text.
        let Some(inner_close_rel) = find_ci(&html[tag_close..], "</a>") else { break };
        let inner_close = tag_close + inner_close_rel;
        let inner = &html[tag_close..inner_close];
        let title = decode_entities(&strip_tags(inner).trim());
        if is_result && !title.is_empty() && url.starts_with("http") {
            // Snippet: the following <td class="result-snippet"> cell.
            let after = &html[inner_close..(inner_close + 600).min(html.len())];
            let snippet = td_text_after(after, "result-snippet");
            hits.push(WebHit {
                title,
                url,
                snippet: snippet.chars().take(300).collect(),
            });
        }
        cursor = inner_close + 4;
    }
    hits
}

/// Candidate browser executables, in preference order (Edge ships with
/// Windows; Chrome when installed).
pub fn browser_candidates() -> [&'static str; 4] {
    [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]
}

/// Opens `url` in headless Edge/Chrome and returns the rendered page text.
/// `--virtual-time-budget` lets JS-heavy pages settle before the DOM dump.
pub fn browser_page(url: &str, wait_ms: u64) -> Result<BrowserPage> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("url must start with http:// or https://".to_string());
    }
    let browser = browser_candidates()
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file())
        .ok_or_else(|| "no Edge/Chrome found — install Microsoft Edge or Google Chrome".to_string())?;
    let wait = wait_ms.clamp(0, 20_000);
    let mut cmd = Command::new(browser);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--mute-audio",
        &format!("--virtual-time-budget={wait}"),
        "--dump-dom",
        url,
    ]);
    cmd.no_window();
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("browser failed to launch: {e}"))?;
    if out.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "browser produced no DOM ({}): {}",
            out.status,
            stderr.trim().chars().take(200).collect::<String>()
        ));
    }
    let html = String::from_utf8_lossy(&out.stdout).to_string();
    let title = extract_title(&html);
    let text = strip_tags(&strip_invisible(&html));
    Ok(BrowserPage {
        url: url.to_string(),
        title,
        text: text.chars().take(MAX_TEXT).collect(),
    })
}

/// Headless screenshot of `url` saved to `path` — a fresh render of the URL
/// (the panel's live state isn't captured; WebView2 doesn't expose its child
/// webviews over the debugging port).
pub fn browser_screenshot_file(url: &str, path: &Path, wait_ms: u64) -> Result<()> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("url must start with http:// or https://".to_string());
    }
    let browser = browser_candidates()
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file())
        .ok_or_else(|| "no Edge/Chrome found — install Microsoft Edge or Google Chrome".to_string())?;
    let wait = wait_ms.clamp(0, 20_000);
    let mut cmd = Command::new(browser);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--mute-audio",
        &format!("--virtual-time-budget={wait}"),
        &format!("--screenshot={}", path.display()),
        "--window-size=1280,900",
        url,
    ]);
    cmd.no_window();
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(err)?;
    if !path.exists() {
        return Err(format!(
            "browser produced no screenshot ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim().chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

/// Headless print-to-PDF of `url` saved to `path` — a fresh render of the URL.
pub fn browser_pdf_file(url: &str, path: &Path) -> Result<()> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("url must start with http:// or https://".to_string());
    }
    let browser = browser_candidates()
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file())
        .ok_or_else(|| "no Edge/Chrome found — install Microsoft Edge or Google Chrome".to_string())?;
    let mut cmd = Command::new(browser);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        &format!("--print-to-pdf={}", path.display()),
        "--no-pdf-header-footer",
        url,
    ]);
    cmd.no_window();
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(err)?;
    if !path.exists() {
        return Err(format!(
            "browser produced no PDF ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim().chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DDG_FIXTURE: &str = r#"<html><body>
    <table><tr>
    <td>1.</td>
    <td><a rel="nofollow" href="https://example.com/docs" class='result-link'>Example &amp; Docs</a></td>
    </tr><tr>
    <td class="result-snippet">The &lt;b&gt;official&lt;/b&gt; docs &amp;mdash; very useful</td>
    </tr><tr>
    <td>2.</td>
    <td><a rel="nofollow" href="https://broken.example" class='result-link'>No snippet here</a></td>
    </tr></table></body></html>"#;

    #[test]
    fn parses_ddg_results_and_entities() {
        let hits = parse_ddg_hits(DDG_FIXTURE);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://example.com/docs");
        assert_eq!(hits[0].title, "Example & Docs");
        assert!(hits[0].snippet.contains("official"), "entities decoded");
        assert!(!hits[0].snippet.contains('&'), "no raw entities left");
        assert_eq!(hits[1].title, "No snippet here");
    }

    #[test]
    fn strips_scripts_styles_and_tags() {
        let html = "<html><head><title>My Page</title><style>body{color:red}</style></head>\
                    <body><script>evil()</script><h1>Hi</h1><p>real &amp; text</p><noscript>no js</noscript></body></html>";
        let clean = strip_tags(&strip_invisible(html));
        assert!(clean.contains("Hi"), "heading text kept: {clean}");
        assert!(clean.contains("real & text"));
        assert!(!clean.contains("evil"), "scripts dropped");
        assert!(!clean.contains("color:red"), "styles dropped");
        assert!(!clean.contains("no js"), "noscript dropped");
        assert_eq!(extract_title(html), "My Page");
    }

    #[test]
    fn urlencodes_queries() {
        assert_eq!(urlencode("rust lang"), "rust%20lang");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode("ภาษาไทย").starts_with('%'), true);
    }
}
