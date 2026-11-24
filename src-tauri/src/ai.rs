//! AI chat proxy — forwards OpenAI-compatible chat completion requests to the
//! provider endpoint configured in Settings (z.ai GLM, OpenAI, Ollama, custom).
//! Uses curl so CORS can never block the webview, and streams the request body
//! through stdin (image attachments can be megabytes of base64).

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use crate::CommandNoWindow;


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResult {
    pub ok: bool,
    pub status: u16,
    pub body: String,
    pub error: String,
}

/// POST `body_json` to `url`; returns the raw response body. `auth_mode`
/// picks the credential headers: `"bearer"` (default) sends
/// `Authorization: Bearer <key>`, `"anthropic"` sends
/// `x-api-key` + `anthropic-version` (the Anthropic /v1/messages scheme).
pub fn ai_chat(url: &str, api_key: &str, body_json: &str, auth_mode: Option<&str>) -> Result<AiChatResult, String> {
    if url.is_empty() {
        return Err("provider endpoint URL is empty".to_string());
    }
    let mut cmd = Command::new("curl");
    cmd.args([
        "-s",
        "-X",
        "POST",
        "--max-time",
        "180",
        "-H",
        "Content-Type: application/json",
    ]);
    if !api_key.is_empty() {
        if auth_mode == Some("anthropic") {
            cmd.args([
                "-H",
                &format!("x-api-key: {api_key}"),
                "-H",
                "anthropic-version: 2023-06-01",
            ]);
        } else {
            cmd.args(["-H", &format!("Authorization: Bearer {api_key}")]);
        }
    }
    cmd.arg(url);
    cmd.args(["--data-binary", "@-"]);
    cmd.no_window();
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("curl not available: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body_json.as_bytes())
            .map_err(|e| format!("failed to write request body: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("ai request failed: {e}"))?;

    let body = String::from_utf8_lossy(&output.stdout).to_string();
    let status = output.status.code().unwrap_or(0) as u16;
    if body.is_empty() && !output.stderr.is_empty() {
        return Ok(AiChatResult {
            ok: false,
            status,
            body: String::new(),
            error: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(AiChatResult { ok: true, status, body, error: String::new() })
}

// ---------------------------------------------------------------------------
// ZCode (desktop) credential bridge — reads the encrypted api-key entries from
// ~/.zcode/v2/credentials.json and returns the raw parts for the frontend to
// decrypt with WebCrypto (key = sha256 of the machine-derived secret).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZcodeEntry {
    pub key: String,
    pub iv: String,
    pub tag: String,
    pub ct: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZcodeCreds {
    pub secret: String,
    pub entries: Vec<ZcodeEntry>,
    pub exe_found: bool,
}

pub fn zcode_creds() -> Result<ZcodeCreds, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE missing".to_string())?;
    let sep = std::path::MAIN_SEPARATOR;
    let path = format!(
        "{}{}.zcode{}v2{}credentials.json",
        home.trim_end_matches(sep),
        sep,
        sep,
        sep
    );
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!("credentials.json not found at {path} ({e})")
    })?;
    let map: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let map = map.as_object().ok_or("credentials.json: not an object")?;

    let username = std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string());
    let secret = format!(
        "zcode-credential-fallback:win32:{}:{}",
        home.trim_end_matches(std::path::MAIN_SEPARATOR),
        username
    );

    let mut entries = Vec::new();
    for (key, value) in map {
        if !key.contains(":api-key") {
            continue;
        }
        let raw = value.as_str().unwrap_or("");
        let Some(rest) = raw.strip_prefix("enc:v1:") else { continue };
        let parts: Vec<&str> = rest.split('.').collect();
        if parts.len() != 3 {
            continue;
        }
        entries.push(ZcodeEntry {
            key: key.to_string(),
            iv: parts[0].to_string(),
            tag: parts[1].to_string(),
            ct: parts[2].to_string(),
        });
    }

    let exe_found = std::path::Path::new(r"C:\Program Files\ZCode\ZCode.exe").exists();
    Ok(ZcodeCreds { secret, entries, exe_found })
}

// ---------------------------------------------------------------------------
// CLI coding agents — Claude Code & Codex (installed CLIs, own subscriptions).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZcodeProviderTemplate {
    /// Template id (unique per provider).
    pub template_id: String,
    /// Display name (en-US).
    pub name: String,
    /// Credential type: "zhipu-coding-plan-api-key" or "api-key".
    pub access_type: String,
    /// Wire protocol: "anthropic-messages" | "openai-chat-completions" | "openai-responses".
    pub api_type: String,
    pub base_url: String,
    /// Models the template declares (builtinModelIds).
    pub models: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatgptProviderInfo {
    /// Provider id on the frontend.
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// Models read from Codex's own config.toml.
    pub models: Vec<String>,
}

/// Reads the GLM catalog from ~/.codex/models.json (model_catalog_json).
fn read_codex_models_json() -> Vec<String> {
    let Some(path) = home_file(".codex/models.json") else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("slug").and_then(|s| s.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Codex's builtin recommended set — the "Default" list its own picker
/// shows (slugs per Codex's naming convention).
fn codex_recommended_models() -> Vec<String> {
    vec![
        "gpt-6.1-sol".into(),
        "gpt-6-astra".into(),
        "gpt-6.1-terra".into(),
        "gpt-6-sol".into(),
        "gpt-6-luna".into(),
        "gpt-5.6-sol".into(),
        "gpt-5.6-terra".into(),
        "gpt-5.6-luna".into(),
    ]
}

/// Reads every `model = "..."` entry from Codex's config.toml.
fn read_codex_config_models() -> Vec<String> {
    let Some(path) = home_file(".codex/config.toml") else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut models: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        if trimmed[..eq].trim() != "model" {
            continue;
        }
        let value = trimmed[eq + 1..]
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if !value.is_empty() && !models.iter().any(|x| x == &value) {
            models.push(value);
        }
    }
    models
}

/// Reads the model catalog Codex caches from the server
/// (~/.codex/models_cache.json) — picker-visible models only.
fn read_codex_cache_models() -> Vec<String> {
    let Some(path) = home_file(".codex/models_cache.json") else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("visibility").and_then(|x| x.as_str()) == Some("list"))
                .filter_map(|m| m.get("slug").and_then(|s| s.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Providers derived from the ChatGPT/Codex ecosystem's own config.
fn detect_chatgpt_providers() -> Vec<ChatgptProviderInfo> {
    // Union: the server-cached picker catalog + GLM catalog (models.json)
    // + Codex's recommended GPT set, config default first.
    let mut models = read_codex_cache_models();
    for m in read_codex_models_json() {
        if !models.iter().any(|x| x == &m) {
            models.push(m);
        }
    }
    for m in codex_recommended_models() {
        if !models.iter().any(|x| x == &m) {
            models.push(m);
        }
    }
    let default = read_codex_config_models();
    if let Some(first) = default.first() {
        if !models.iter().any(|x| x == first) {
            models.insert(0, first.clone());
        }
    }
    vec![ChatgptProviderInfo {
        id: "chatgpt-openai-api".to_string(),
        name: "OpenAI API".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        models,
    }]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectResult {
    pub claude: bool,
    pub codex: bool,
    pub copilot: bool,
    pub claude_version: String,
    pub codex_version: String,
    pub copilot_version: String,
    /// Default model read from each app's own config, if any.
    pub claude_model: String,
    pub codex_model: String,
    /// Every detected CLI coding agent — the generic scan result.
    pub apps: Vec<CliAppInfo>,
    /// Detected desktop AI apps (no local API — inventory + config location).
    pub desktop: Vec<DesktopAppInfo>,
    /// All provider templates shipped in ZCode desktop's own config.
    pub zcode_providers: Vec<ZcodeProviderTemplate>,
    /// Providers derived from Claude's own data (account model catalog).
    pub claude_providers: Vec<ClaudeProviderInfo>,
    /// Providers derived from the ChatGPT/Codex ecosystem's own config.
    pub chatgpt_providers: Vec<ChatgptProviderInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProviderInfo {
    /// Provider id on the frontend.
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// Model ids from Claude's own account cache/config.
    pub models: Vec<String>,
}

/// Reads Claude's real model catalog — every versioned claude model id
/// found in ~/.claude.json (history/caches reference the ids the account
/// actually uses: claude-opus-4-8, claude-fable-5-1, claude-sonnet-5-5...).
/// App/internal ids without a version number are excluded.
fn read_claude_catalog() -> Vec<String> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if home.is_empty() {
        return Vec::new();
    }
    let path = Path::new(&home).join(".claude.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    const EXCLUDED: &[&str] = &[
        "claude-code",
        "claude-desktop",
        "claude-md-management",
        "claude-mythos",
        "claude-code-desktop",
        "claude-code-setup",
    ];
    let bytes = text.as_bytes();
    let mut models: Vec<String> = Vec::new();
    let mut idx = 0usize;
    while let Some(pos) = text[idx..].find("claude-") {
        let start = idx + pos;
        let mut end = start + "claude-".len();
        while end < bytes.len() {
            let b = bytes[end] as char;
            if b.is_ascii_lowercase() || b.is_ascii_digit() || b == '-' {
                end += 1;
            } else {
                break;
            }
        }
        let id = text[start..end].trim_end_matches('-').to_string();
        idx = end;
        if id.len() <= "claude-".len() || EXCLUDED.contains(&id.as_str()) {
            continue;
        }
        // claude-3.x generation — discontinued, not in the current picker.
        if id.starts_with("claude-3") {
            continue;
        }
        // versioned model ids contain at least one digit (claude-opus-4-8);
        // internal names (claude-teams...) don't.
        if !id.chars().any(|c| c.is_ascii_digit()) {
            continue;
        }
        if !models.iter().any(|x| x == &id) {
            models.push(id);
        }
    }
    models
}

/// Providers derived from Claude's own data.
fn detect_claude_providers() -> Vec<ClaudeProviderInfo> {
    vec![ClaudeProviderInfo {
        id: "claude-anthropic-api".to_string(),
        name: "Anthropic API".to_string(),
        base_url: "https://api.anthropic.com".to_string(),
        models: read_claude_catalog(),
    }]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppInfo {
    /// Provider id on the frontend (e.g. "gemini-desktop").
    pub id: String,
    /// Display name.
    pub name: String,
    pub version: String,
    /// Config/install location on disk.
    pub path: String,
    /// How to launch the app: "exe" runs launch_target directly.
    pub launch_kind: String,
    pub launch_target: String,
}

/// Finds the first top-level *.exe in a directory (Claude Desktop layout).
fn first_exe_in(dir: &Path) -> Option<String> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().map(|x| x.eq_ignore_ascii_case("exe")).unwrap_or(false))
        .map(|p| p.display().to_string())
}

/// Resolves how a detected desktop app is launched.
fn resolve_desktop_launch(id: &str, data_dir: &Path) -> (String, String) {
    match id {
        "gemini-desktop" => {
            let exe = data_dir.join("Gemini.exe");
            if exe.is_file() {
                return ("exe".to_string(), exe.display().to_string());
            }
            if let Some(found) = first_exe_in(data_dir) {
                return ("exe".to_string(), found);
            }
            (String::new(), String::new())
        }
        "claude-desktop" => {
            let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
            let install = Path::new(&local).join("AnthropicClaude");
            if install.is_dir() {
                if let Some(found) = first_exe_in(&install) {
                    return ("exe".to_string(), found);
                }
            }
            if let Some(found) = first_exe_in(data_dir) {
                return ("exe".to_string(), found);
            }
            (String::new(), String::new())
        }
        // MSIX (ChatGPT Desktop) — launched by app name through Start Apps.
        _ => ("msix".to_string(), "ChatGPT".to_string()),
    }
}

/// Launches a detected app: an exe directly, a CLI in a new interactive
/// terminal, or an MSIX app through its Start entry.
pub fn launch_app(kind: &str, target: &str) -> Result<String, String> {
    match kind {
        "exe" => {
            if !Path::new(target).is_file() {
                return Err(format!("app not found: {target}"));
            }
            Command::new("cmd")
                .args(["/C", "start", "", target])
                .no_window()
                .spawn()
                .map_err(|e| format!("launch failed: {e}"))?;
            Ok(format!("launched {target}"))
        }
        "cli" => {
            // The CLIs are TUI/interactive — open a fresh console running them.
            Command::new("cmd")
                .args(["/C", "start", "pigry", "cmd", "/K", target])
                .no_window()
                .spawn()
                .map_err(|e| format!("launch failed: {e}"))?;
            Ok(format!("opened {target} in a new terminal"))
        }
        "msix" => {
            // Resolve the Start-Apps entry id, then launch through the shell.
            let script = format!(
                "(Get-StartApps | Where-Object {{ $_.Name -like '*{target}*' }} | Select-Object -First 1).AppID"
            );
            let out = Command::new("powershell")
                .args(["-NoProfile", "-Command", &script])
                .no_window()
                .output()
                .map_err(|e| format!("launch failed: {e}"))?;
            let app_id = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if app_id.is_empty() {
                return Err(format!("no Start entry named {target}"));
            }
            Command::new("cmd")
                .args(["/C", "start", &format!("shell:AppsFolder\\{app_id}")])
                .no_window()
                .spawn()
                .map_err(|e| format!("launch failed: {e}"))?;
            Ok(format!("launched {target}"))
        }
        other => Err(format!("unknown launch kind: {other}")),
    }
}

/// Fetches the z.ai coding-plan subscription/quota report with the
/// provider's own API key (GET on the usage monitor endpoint). The TLS
/// connection to api.z.ai renegotiates flakily on Windows — retry up to 3
/// times and pin HTTP/1.1.
/// Claude Code has no usage API — its own JSONL session logs carry
/// per-message token usage, which this command aggregates instead.
pub fn claude_usage() -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE missing".to_string())?;
    let projects = Path::new(&home).join(".claude").join("projects");
    if !projects.is_dir() {
        return Err("no Claude Code usage data (~/.claude/projects not found)".to_string());
    }

    #[derive(Default)]
    struct ModelAgg {
        input: u64,
        output: u64,
        cache_read: u64,
        cache_creation: u64,
        requests: u64,
    }
    let mut per_model: std::collections::BTreeMap<String, ModelAgg> = std::collections::BTreeMap::new();
    let mut sessions = 0usize;
    let mut last_day = String::new();

    fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.is_dir() {
                    walk(&p, files);
                } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                    files.push(p);
                }
            }
        }
    }
    let mut jsonl_files: Vec<PathBuf> = Vec::new();
    walk(&projects, &mut jsonl_files);
    jsonl_files.sort();
    sessions = jsonl_files.len();

    use std::io::BufRead;
    for file in &jsonl_files {
        if let Ok(reader) = std::fs::File::open(file) {
            let reader = std::io::BufReader::new(reader);
            for line in reader.lines().filter_map(|l| l.ok()) {
                // cheap pre-filter before JSON parsing
                if !line.contains("\"usage\"") || !line.contains("\"model\"") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let message = match v.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                let usage = match message.get("usage") {
                    Some(u) => u,
                    None => continue,
                };
                let model = message
                    .get("model")
                    .and_then(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string();
                if model.is_empty() || model == "<synthetic>" {
                    continue;
                }
                let num = |key: &str| usage.get(key).and_then(|n| n.as_u64()).unwrap_or(0);
                let agg = per_model.entry(model).or_default();
                agg.input += num("input_tokens");
                agg.output += num("output_tokens");
                agg.cache_read += num("cache_read_input_tokens");
                agg.cache_creation += num("cache_creation_input_tokens");
                agg.requests += 1;
                if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
                    if ts.len() >= 10 {
                        last_day = ts[..10].to_string();
                    }
                }
            }
        }
    }

    let models: Vec<serde_json::Value> = per_model
        .into_iter()
        .map(|(model, a)| {
            serde_json::json!({
                "model": model,
                "inputTokens": a.input,
                "outputTokens": a.output,
                "cacheReadTokens": a.cache_read,
                "cacheCreationTokens": a.cache_creation,
                "requests": a.requests,
            })
        })
        .collect();
    let report = serde_json::json!({
        "kind": "claude-usage",
        "sessions": sessions,
        "lastDay": last_day,
        "models": models,
    });
    Ok(serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string()))
}

/// Fetches the z.ai coding-plan subscription/quota report with the
/// provider's own API key (GET on the usage monitor endpoint). The TLS
/// connection to api.z.ai renegotiates flakily on Windows — retry up to 3
/// times and pin HTTP/1.1.
pub fn zcode_plan_subscription(api_key: &str) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("no API key available for this provider".to_string());
    }
    let mut last_err = String::new();
    for attempt in 0..3 {
        let mut cmd = Command::new("curl");
        cmd.args([
            "-s",
            "--http1.1",
            "--max-time",
            "30",
            "-H",
            &format!("Authorization: Bearer {api_key}"),
            "-H",
            "Accept: application/json",
            "https://api.z.ai/api/monitor/usage/quota/limit",
        ]);
        cmd.no_window();
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let body = match cmd
            .spawn()
            .map_err(|e| format!("curl not available: {e}"))?
            .wait_with_output()
            .map_err(|e| format!("plan request failed: {e}"))
        {
            Ok(output) => String::from_utf8_lossy(&output.stdout).to_string(),
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        if !body.trim().is_empty() {
            return Ok(body);
        }
        last_err = format!("empty response (attempt {} of 3)", attempt + 1);
        std::thread::sleep(std::time::Duration::from_millis(700));
    }
    Err(format!("empty response from the z.ai plan API — {last_err}"))
}

/// Detects installed desktop AI apps by their well-known data directories.
fn detect_desktop_apps() -> Vec<DesktopAppInfo> {
    let mut out: Vec<DesktopAppInfo> = Vec::new();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let roaming = std::env::var("APPDATA").unwrap_or_default();
    let push = |out: &mut Vec<DesktopAppInfo>, info: DesktopAppInfo| {
        out.push(info);
    };
    // Claude Desktop (Anthropic)
    let claude_roaming = Path::new(&roaming).join("Claude");
    let claude_local = Path::new(&local).join("AnthropicClaude");
    if claude_roaming.is_dir() || claude_local.is_dir() {
        let (launch_kind, launch_target) =
            resolve_desktop_launch("claude-desktop", &claude_local);
        push(
            &mut out,
            DesktopAppInfo {
                id: "claude-desktop".to_string(),
                name: "Claude Desktop".to_string(),
                version: String::new(),
                path: claude_roaming.display().to_string(),
                launch_kind,
                launch_target,
            },
        );
    }
    // ChatGPT Desktop (OpenAI, MSIX)
    let chatgpt = Path::new(&local).join("OpenAI.ChatGPT-Desktop");
    if chatgpt.is_dir() {
        let (launch_kind, launch_target) =
            resolve_desktop_launch("chatgpt-desktop", &chatgpt);
        push(
            &mut out,
            DesktopAppInfo {
                id: "chatgpt-desktop".to_string(),
                name: "ChatGPT Desktop".to_string(),
                version: String::new(),
                path: chatgpt.display().to_string(),
                launch_kind,
                launch_target,
            },
        );
    }
    // Gemini Desktop (Google) — version from the app-<ver> data dir.
    let gemini = Path::new(&local).join("Google").join("Gemini");
    if gemini.is_dir() {
        let version = std::fs::read_dir(&gemini)
            .ok()
            .and_then(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.starts_with("app-"))
                    .max()
            })
            .and_then(|n| n.strip_prefix("app-").map(|s| s.to_string()))
            .unwrap_or_default();
        let (launch_kind, launch_target) = resolve_desktop_launch("gemini-desktop", &gemini);
        push(
            &mut out,
            DesktopAppInfo {
                id: "gemini-desktop".to_string(),
                name: "Gemini Desktop".to_string(),
                version,
                path: gemini.display().to_string(),
                launch_kind,
                launch_target,
            },
        );
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAppInfo {
    /// Binary to run (also the provider `type` on the frontend).
    pub binary: String,
    /// Display name for the provider.
    pub name: String,
    pub version: String,
    /// Default model read from the app's own config, if any.
    pub model: String,
    /// Default reasoning effort read from the app's own config, if any.
    pub effort: String,
    /// Whether chat turns can actually run through this CLI right now
    /// (login gates / missing prompt modes make some unusable).
    pub usable: bool,
    /// Models read from the app's own config, if any.
    pub models: Vec<String>,
    /// How to launch the interactive app: kind "cli" runs launch_target
    /// (the binary) in a fresh console.
    pub launch_kind: String,
    pub launch_target: String,
}

/// Parses ZCode desktop's own provider catalog — every templateRule in
/// zcode-builtin.json becomes a pigry provider in the "ZCode Providers" group.
fn read_zcode_providers() -> Vec<ZcodeProviderTemplate> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    if local.is_empty() {
        return Vec::new();
    }
    let config = Path::new(&local)
        .join("Programs")
        .join("ZCode")
        .join("resources")
        .join("config")
        .join("provider")
        .join("zcode-builtin.json");
    let Ok(text) = std::fs::read_to_string(config) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let rules = v
        .get("config")
        .and_then(|c| c.get("providerConfigRules"))
        .and_then(|r| r.get("templateRules"))
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    // ALL templates → the ZCode Providers catalog.
    let mut providers: Vec<ZcodeProviderTemplate> = Vec::new();
    for rule in &rules {
        let template_id = rule
            .get("templateId")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string();
        if template_id.is_empty() {
            continue;
        }
        let config = rule.get("config");
        let models: Vec<String> = config
            .and_then(|c| c.get("builtinModelIds"))
            .and_then(|m| m.as_array())
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        providers.push(ZcodeProviderTemplate {
            template_id,
            name: rule
                .get("templateNameMap")
                .and_then(|n| n.get("en-US"))
                .and_then(|n| n.as_str())
                .unwrap_or("ZCode provider")
                .to_string(),
            access_type: config
                .and_then(|c| c.get("access"))
                .and_then(|a| a.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string(),
            api_type: config
                .and_then(|c| c.get("api"))
                .and_then(|a| a.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string(),
            base_url: config
                .and_then(|c| c.get("api"))
                .and_then(|a| a.get("baseUrl"))
                .and_then(|b| b.as_str())
                .unwrap_or_default()
                .to_string(),
            models,
        });
    }
    providers
}

/// Reads ZCode desktop's own provider config — the authoritative
/// builtinModelIds per provider template (e.g. the coding plan's GLM set).
fn read_zcode_models() -> Vec<String> {
    read_zcode_providers()
        .iter()
        .find(|p| p.access_type == "zhipu-coding-plan-api-key")
        .map(|p| p.models.clone())
        .unwrap_or_default()
}

/// The CLI coding agents pigry knows how to detect — (binary, display name).
/// Config-model readers exist for claude/codex; the rest report no model.
const DETECTABLE_APPS: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("copilot", "GitHub Copilot"),
    ("agy", "Antigravity"),
    ("gemini", "Gemini"),
    ("zcode", "ZCode"),
    ("autoclaw", "AutoClaw"),
    ("workbuddy", "WorkBuddy"),
    ("traework", "TraeWork"),
    ("conebuddy", "ConeBuddy"),
    ("traecode", "TraeCode"),
    ("opencode", "OpenCode"),
    ("cursor-agent", "Cursor"),
    ("cursor", "Cursor"),
    ("openclaw", "OpenClaw"),
];

/// Reads the configured default model for a detected app (per-app config
/// files; unknown apps report none).
fn read_app_model(binary: &str) -> String {
    match binary {
        "claude" => read_claude_model(),
        "codex" => read_codex_model(),
        "gemini" => read_gemini_model(),
        _ => String::new(),
    }
}

/// Reads the configured default reasoning effort (codex's config.toml).
fn read_app_effort(binary: &str) -> String {
    if binary == "codex" {
        if let Some(path) = home_file(".codex/config.toml") {
            if let Ok(text) = std::fs::read_to_string(path) {
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("model_reasoning_effort") && trimmed.contains('=') {
                        let value = trimmed[trimmed.find('=').unwrap() + 1..]
                            .trim()
                            .trim_matches('"')
                            .trim_matches('\'')
                            .trim()
                            .to_string();
                        if !value.is_empty() {
                            return value;
                        }
                    }
                }
            }
        }
    }
    String::new()
}

/// True when a login-status command printed `needle` on either stdout or stderr (CLIs differ in which one they use).
pub fn login_state_says(stdout: &[u8], stderr: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(stdout).contains(needle) || String::from_utf8_lossy(stderr).contains(needle)
}

/// Cheap usability probe per CLI — chat turns must actually be able to run.
/// claude gates on login; zcode is TUI-only (no non-interactive prompt mode);
/// codex exposes a login status check; unknown CLIs are assumed usable.
fn cli_usable(binary: &str) -> bool {
    match binary {
        "claude" => {
            // `claude auth status` answers in well under a second (`config get model` took ~7 s) and prints JSON with "loggedIn".
            if let Ok(o) = Command::new("cmd").args(["/C", "claude", "auth", "status"]).no_window().output() {
                let text = String::from_utf8_lossy(&o.stdout).to_string();
                if text.contains("\"loggedIn\": true") || text.contains("\"loggedIn\":true") {
                    return true;
                }
                if text.contains("\"loggedIn\": false") || text.contains("\"loggedIn\":false") {
                    return false;
                }
            }
            let out = Command::new("cmd")
                .args(["/C", "claude", "config", "get", "model"])
                .no_window()
                .output();
            match out {
                Ok(o) => !login_state_says(&o.stdout, &o.stderr, "Not logged in"),
                Err(_) => false,
            }
        }
        "codex" => {
            let out = Command::new("cmd")
                .args(["/C", "codex", "login", "status"])
                .no_window()
                .output();
            // codex prints "Logged in using ChatGPT" on STDERR, so both streams are read.
            match out {
                Ok(o) => login_state_says(&o.stdout, &o.stderr, "Logged in"),
                Err(_) => false,
            }
        }
        "zcode" => false,
        _ => true,
    }
}

/// Reads the configured default model from Gemini CLI's settings.json
/// (`"model": "…"` or `"model": { "name": "…" }`).
fn read_gemini_model() -> String {
    let Some(path) = home_file(".gemini/settings.json") else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    parse_gemini_model(&text)
}

/// Parses the model field out of Gemini CLI settings content.
fn parse_gemini_model(text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| {
            let model = v.get("model")?;
            model
                .as_str()
                .map(|s| s.trim().to_string())
                .or_else(|| {
                    model
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.trim().to_string())
                })
        })
        .unwrap_or_default()
}

fn cli_version(exe: &str) -> String {
    let output = Command::new("cmd")
        .args(["/C", exe, "--version"])
        .no_window()
        .output();
    match output {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}

/// A file under the user's home directory (e.g. .claude/settings.json).
fn home_file(rel: &str) -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let path = Path::new(&home).join(rel);
    path.is_file().then_some(path)
}

/// Reads the configured default model from Claude Code's config:
/// settings.json first, then the global ~/.claude.json.
fn read_claude_model() -> String {
    if let Some(path) = home_file(".claude/settings.json") {
        if let Ok(text) = std::fs::read_to_string(path) {
            let model = parse_claude_model(&text);
            if !model.is_empty() {
                return model;
            }
        }
    }
    if let Some(path) = home_file(".claude.json") {
        if let Ok(text) = std::fs::read_to_string(path) {
            return parse_claude_model(&text);
        }
    }
    String::new()
}

/// Parses `"model": "…"` out of Claude Code settings content.
fn parse_claude_model(text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| {
            v.get("model")
                .and_then(|m| m.as_str())
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default()
}

/// Reads the configured default model from Codex's config.toml (`model = "…"`).
fn read_codex_model() -> String {
    let Some(path) = home_file(".codex/config.toml") else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    parse_codex_model(&text)
}

/// Parses `model = "…"` out of Codex config.toml content.
fn parse_codex_model(text: &str) -> String {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("model") && trimmed.contains('=') {
            let value = trimmed[trimmed.find('=').unwrap() + 1..]
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim()
                .to_string();
            if !value.is_empty() {
                return value;
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn parses_claude_settings_model() {
        assert_eq!(
            parse_claude_model(r#"{"model":"opus","env":{} }"#),
            "opus"
        );
        assert_eq!(parse_claude_model(r#"{"other":1}"#), "");
        assert_eq!(parse_claude_model("not json"), "");
    }

    #[test]
    fn parses_codex_config_model() {
        assert_eq!(parse_codex_model("model = \"gpt-5.1-codex\"\n"), "gpt-5.1-codex");
        assert_eq!(parse_codex_model("model = 'o4-mini'\n"), "o4-mini");
        assert_eq!(parse_codex_model("[profile]\nmodel=\"x\"\n"), "x");
        assert_eq!(parse_codex_model("no model here\n"), "");
    }

    #[test]
    fn parses_gemini_settings_model() {
        assert_eq!(parse_gemini_model(r#"{"model":"gemini-2.5-pro"}"#), "gemini-2.5-pro");
        assert_eq!(
            parse_gemini_model(r#"{"model":{"name":"gemini-2.5-flash"}}"#),
            "gemini-2.5-flash"
        );
        assert_eq!(parse_gemini_model(r#"{"other":1}"#), "");
    }

    #[test]
    fn cli_detect_reports_without_panicking() {
        // IO-bound smoke test — on dev machines claude/codex exist; on CI they
        // may not. Only assert internal consistency.
        let det = cli_detect();
        assert_eq!(det.claude, !det.claude_version.is_empty());
        assert_eq!(det.codex, !det.codex_version.is_empty());
        assert_eq!(det.copilot, !det.copilot_version.is_empty());
        if !det.claude {
            assert!(det.claude_model.is_empty());
        }
        if !det.codex {
            assert!(det.codex_model.is_empty());
        }
    }
}

/// Everything the scan needs to know about one binary (None when it is not installed). Runs on its own thread: several of the
/// probes (version, login status, model list) take seconds, and a sequential scan of fourteen binaries took over 15 s.
fn app_info(binary: &str, name: &str) -> Option<CliAppInfo> {
    let version = cli_version(binary);
    if version.is_empty() {
        return None;
    }
    // zcode's models come from ZCode desktop's own provider config.
    let models = if binary == "zcode" {
        read_zcode_models()
    } else if binary == "agy" {
        read_agy_models()
    } else {
        let default = read_app_model(binary);
        if default.is_empty() { Vec::new() } else { vec![default] }
    };
    Some(CliAppInfo {
        binary: binary.to_string(),
        name: name.to_string(),
        version,
        model: read_app_model(binary),
        effort: read_app_effort(binary),
        usable: cli_usable(binary),
        models,
        launch_kind: "cli".to_string(),
        launch_target: binary.to_string(),
    })
}

pub fn cli_detect() -> CliDetectResult {
    // Probe every detectable binary at the same time.
    let found: Vec<Option<CliAppInfo>> = std::thread::scope(|scope| {
        let handles: Vec<_> = DETECTABLE_APPS.iter().map(|(binary, name)| scope.spawn(move || app_info(binary, name))).collect();
        handles.into_iter().map(|h| h.join().ok().flatten()).collect()
    });
    let mut apps: Vec<CliAppInfo> = Vec::new();
    for app in found.into_iter().flatten() {
        // `cursor-agent` wins over `cursor` when both exist.
        if apps.iter().any(|a| a.binary == app.binary || (app.binary == "cursor" && a.binary == "cursor-agent")) {
            continue;
        }
        apps.push(app);
    }
    let version_of = |binary: &str| apps.iter().find(|a| a.binary == binary).map(|a| a.version.clone()).unwrap_or_default();
    let claude_version = version_of("claude");
    let codex_version = version_of("codex");
    let copilot_version = version_of("copilot");
    let claude_model = if claude_version.is_empty() { String::new() } else { read_claude_model() };
    let codex_model = if codex_version.is_empty() { String::new() } else { read_codex_model() };
    CliDetectResult {
        claude: !claude_version.is_empty(),
        codex: !codex_version.is_empty(),
        copilot: !copilot_version.is_empty(),
        claude_version,
        codex_version,
        copilot_version,
        claude_model,
        codex_model,
        apps,
        desktop: detect_desktop_apps(),
        zcode_providers: read_zcode_providers(),
        claude_providers: detect_claude_providers(),
        chatgpt_providers: detect_chatgpt_providers(),
    }
}

/// One chat turn through the Claude Code CLI used as a plain model: every built-in tool is switched off (Pigry runs its own tools and
/// guards), nothing is saved as a session, and the user message arrives as a stream-json line on STDIN so it can carry images.
/// Returns {"text", "isError", "inputTokens", "outputTokens"} as JSON. Runs in the temp folder so no project CLAUDE.md leaks in.
/// At most this many CLI chat processes run at once (each one is a whole Node/Rust process, roughly 250 MB; several agents can ask at the same time).
const MAX_CLI_PROCESSES: usize = 4;
static CLI_SLOTS: (std::sync::Mutex<usize>, std::sync::Condvar) = (std::sync::Mutex::new(0), std::sync::Condvar::new());

/// A place in the queue of running CLI processes; released on drop.
struct CliSlot;
impl CliSlot {
    fn acquire() -> CliSlot {
        let (lock, cv) = &CLI_SLOTS;
        let mut running = lock.lock().unwrap_or_else(|e| e.into_inner());
        while *running >= MAX_CLI_PROCESSES {
            running = cv.wait(running).unwrap_or_else(|e| e.into_inner());
        }
        *running += 1;
        CliSlot
    }
}
impl Drop for CliSlot {
    fn drop(&mut self) {
        let (lock, cv) = &CLI_SLOTS;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        cv.notify_one();
    }
}

/// Environment for the Claude Code child, as Hermes Agent's subscription provider does it: the user's subscription login is the only
/// credential (API-key variables are removed so a key in the environment cannot silently switch billing), and everything that would
/// make a model call do more than answer is off — telemetry, auto-update, memory and CLAUDE.md files.
fn harden_claude_env(cmd: &mut Command) {
    for var in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY"] {
        cmd.env_remove(var);
    }
    for (k, v) in [
        ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
        ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ("DISABLE_TELEMETRY", "1"),
        ("DISABLE_ERROR_REPORTING", "1"),
        ("DISABLE_AUTOUPDATER", "1"),
    ] {
        cmd.env(k, v);
    }
}

pub fn cli_chat(cli: &str, model: Option<&str>, effort: Option<&str>, message_json: &str) -> Result<String, String> {
    let _slot = CliSlot::acquire();
    if cli == "codex" {
        return codex_chat(model, effort, message_json);
    }
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg(cli);
    match cli {
        "claude" => {
            // --setting-sources "" ignores the user's settings, hooks and plugins; --max-turns 1 because every tool is switched off.
            cmd.args(["-p", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--max-turns", "1", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
            harden_claude_env(&mut cmd);
        }
        // Antigravity: stream-json in and out; "-p=" (empty) selects print mode while the prompt comes from STDIN. Headless runs
        // soft-deny every tool action that needs approval, so the agent cannot change files on its own.
        "agy" => {
            cmd.args(["--input-format", "stream-json", "--output-format", "stream-json", "-p="]);
        }
        other => return Err(format!("{other} has no chat mode")),
    }
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        cmd.args(["--model", m]);
    }
    if let Some(e) = effort.filter(|e| ["low", "medium", "high", "xhigh", "max"].contains(e)) {
        cmd.args(["--effort", e]);
    }
    cmd.no_window();
    cmd.current_dir(std::env::temp_dir());
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("{cli} not available: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(message_json.trim().as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|e| format!("{cli}: failed to write the message: {e}"))?;
    }
    let output = child.wait_with_output().map_err(|e| format!("{cli} failed while running: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let parsed = if cli == "agy" { parse_agy_chat_output(&stdout) } else { parse_cli_chat_output(&stdout) };
    parsed.ok_or_else(|| {
        let detail = if stderr.trim().is_empty() { stdout.chars().take(400).collect::<String>() } else { stderr.trim().to_string() };
        format!("{cli} returned no answer: {detail}")
    })
}

/// One chat turn through Codex used as a plain model: read-only sandbox, nothing saved as a session, run in the temp folder (so it
/// cannot see or change the repository — Pigry's own tools do that, under Pigry's guards). `message_json` is
/// {"prompt": "...", "images": [{"mediaType": "image/png", "data": "<base64>"}]}; images are handed over with `-i`.
/// The final answer is read from a `-o` file (the JSONL events on stdout are only used for token counts).
pub fn codex_chat(model: Option<&str>, effort: Option<&str>, message_json: &str) -> Result<String, String> {
    use base64::Engine as _;
    let v: serde_json::Value = serde_json::from_str(message_json).map_err(|e| format!("codex: bad request: {e}"))?;
    let prompt = v.get("prompt").and_then(|p| p.as_str()).unwrap_or("").to_string();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("pigry-codex-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("codex: cannot create a temp folder: {e}"))?;
    let out_file = dir.join("answer.txt");
    let mut image_files: Vec<PathBuf> = Vec::new();
    for (i, img) in v.get("images").and_then(|x| x.as_array()).into_iter().flatten().enumerate() {
        let data = img.get("data").and_then(|d| d.as_str()).unwrap_or("");
        let ext = match img.get("mediaType").and_then(|m| m.as_str()).unwrap_or("image/png") {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "png",
        };
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
            let path = dir.join(format!("image{i}.{ext}"));
            if std::fs::write(&path, bytes).is_ok() {
                image_files.push(path);
            }
        }
    }
    let result = (|| {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("codex").args(["exec", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "--json", "-o"]).arg(&out_file);
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            cmd.args(["-m", m]);
        }
        if let Some(e) = effort.filter(|e| ["minimal", "low", "medium", "high", "xhigh"].contains(e)) {
            cmd.arg("-c").arg(format!("model_reasoning_effort={e}"));
        }
        for img in &image_files {
            cmd.arg("-i").arg(img);
        }
        cmd.arg("-");
        cmd.no_window();
        cmd.current_dir(&dir);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("codex not available: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes()).map_err(|e| format!("codex: failed to write the prompt: {e}"))?;
        }
        let output = child.wait_with_output().map_err(|e| format!("codex failed while running: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let text = std::fs::read_to_string(&out_file).unwrap_or_default();
        let (input_tokens, output_tokens) = codex_usage(&stdout);
        if text.trim().is_empty() {
            let reason = codex_error_line(&stderr, &stdout).unwrap_or_else(|| format!("codex returned no answer (exit {})", output.status.code().unwrap_or(-1)));
            return Ok(serde_json::json!({ "text": reason, "isError": true, "inputTokens": 0, "outputTokens": 0 }).to_string());
        }
        Ok(serde_json::json!({ "text": text.trim(), "isError": false, "inputTokens": input_tokens, "outputTokens": output_tokens }).to_string())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// Token counts from Codex's JSONL events (`turn.completed` carries a `usage` object); (0, 0) when absent.
pub fn codex_usage(stdout: &str) -> (u64, u64) {
    for line in stdout.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        let usage = v.get("usage").or_else(|| v.get("msg").and_then(|m| m.get("usage")));
        if let Some(u) = usage {
            let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            return (n("input_tokens"), n("output_tokens"));
        }
    }
    (0, 0)
}

/// The first useful error line (`ERROR: …`) from Codex's noisy output — for example the usage-limit message.
pub fn codex_error_line(stderr: &str, stdout: &str) -> Option<String> {
    let from_json = stdout.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok()).find_map(|v| {
        let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if t.contains("error") || t == "turn.failed" {
            v.get("message").or_else(|| v.get("error").and_then(|e| e.get("message"))).and_then(|m| m.as_str()).map(str::to_string)
        } else {
            None
        }
    });
    from_json.or_else(|| stderr.lines().find_map(|l| l.trim().strip_prefix("ERROR:").map(|r| r.trim().to_string())).filter(|m| !m.is_empty()))
}

/// Antigravity's final {"event":"result","result":{status,response,error,usage}} line, reduced like the Claude one.
pub fn parse_agy_chat_output(stdout: &str) -> Option<String> {
    for line in stdout.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        if v.get("event").and_then(|t| t.as_str()) != Some("result") {
            continue;
        }
        let r = v.get("result")?;
        let ok = r.get("status").and_then(|s| s.as_str()) == Some("SUCCESS");
        let usage = r.get("usage");
        let num = |k: &str| usage.and_then(|u| u.get(k)).and_then(|n| n.as_u64()).unwrap_or(0);
        let text = if ok {
            r.get("response").and_then(|t| t.as_str()).unwrap_or("").to_string()
        } else {
            r.get("error").and_then(|t| t.as_str()).unwrap_or("Antigravity reported an error (log in once by running \"agy\" in a terminal)").to_string()
        };
        return Some(
            serde_json::json!({
                "text": text,
                "isError": !ok,
                "inputTokens": num("input_tokens") + num("cache_read_tokens"),
                "outputTokens": num("output_tokens"),
            })
            .to_string(),
        );
    }
    None
}

/// Model ids of Antigravity (`agy models`: one "<id>\t<label>" per line after a "Fetching…" line).
fn read_agy_models() -> Vec<String> {
    let Ok(out) = Command::new("cmd").args(["/C", "agy", "models"]).no_window().output() else { return Vec::new() };
    parse_agy_models(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_agy_models(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.split('\t').next().map(|id| id.trim().to_string()))
        .filter(|id| !id.is_empty() && !id.contains(' ') && !id.ends_with("..."))
        .collect()
}

/// Finds the final {"type":"result"} line of a stream-json run and reduces it to what the chat needs.
pub fn parse_cli_chat_output(stdout: &str) -> Option<String> {
    for line in stdout.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("result") {
            continue;
        }
        let usage = v.get("usage");
        let num = |k: &str| usage.and_then(|u| u.get(k)).and_then(|n| n.as_u64()).unwrap_or(0);
        let input = num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
        return Some(
            serde_json::json!({
                "text": v.get("result").and_then(|r| r.as_str()).unwrap_or(""),
                "isError": v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false),
                "inputTokens": input,
                "outputTokens": num("output_tokens"),
            })
            .to_string(),
        );
    }
    None
}

/// Runs a prompt through an installed CLI coding agent (blocking; these take
/// up to a few minutes — the frontend shows a Thinking state while waiting).
/// claude/codex read the prompt from STDIN so multi-line chat text survives
/// cmd's argv quoting; copilot/gemini take it as a (newline-flattened) argument.
/// A chosen model is forwarded to CLIs with a documented model flag.
pub fn cli_agent_run(cli: &str, prompt: &str, cwd: &str, model: Option<&str>) -> Result<String, String> {
    // npm-installed CLIs are .cmd shims — spawn through cmd /C so PATH resolution works.
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg(cli);
    let mut prompt_via_stdin = true;
    match cli {
        "claude" => {
            cmd.args(["-p", "--output-format", "text"]);
            if let Some(m) = model.filter(|m| !m.is_empty()) {
                cmd.args(["--model", m]);
            }
        }
        "codex" => {
            cmd.args(["exec"]);
            if let Some(m) = model.filter(|m| !m.is_empty()) {
                cmd.args(["-m", m]);
            }
            cmd.arg("-");
        }
        "copilot" => {
            prompt_via_stdin = false;
            let flat = prompt.replace(['\r', '\n'], " ");
            cmd.args(["-p", &flat]);
        }
        "gemini" => {
            prompt_via_stdin = false;
            let flat = prompt.replace(['\r', '\n'], " ");
            cmd.args(["-p", &flat]);
        }
        // Generic CLI coding agent — flattened prompt as the sole argument
        // (no model flag: unknown CLIs may not support one).
        other => {
            prompt_via_stdin = false;
            let flat = prompt.replace(['\r', '\n'], " ");
            cmd.args([&flat]);
        }
    }
    cmd.no_window();
    cmd.current_dir(Path::new(cwd));
    if prompt_via_stdin {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{cli} not available: {e}"))?;
    if prompt_via_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| format!("{cli}: failed to write prompt: {e}"))?;
        }
        // dropping stdin closes the pipe — the CLI sees EOF and runs
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("{cli} failed while running: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        return Err(format!("{cli} failed: {}", stderr.trim()));
    }
    Ok(stdout.trim().to_string())
}

#[cfg(test)]
mod claude_scan_tests {
    use super::*;

    #[test]
    fn claude_providers_detection_smoke() {
        let det = cli_detect();
        println!(
            "claude_providers = {} entries; models = {:?}",
            det.claude_providers.len(),
            det.claude_providers
                .first()
                .map(|p| p.models.clone())
                .unwrap_or_default()
        );
        // The anthropic-api catalog entry is unconditional.
        assert_eq!(det.claude_providers.len(), 1);
        assert_eq!(det.claude_providers[0].id, "claude-anthropic-api");
    }
}

#[cfg(test)]
mod cli_detect_full_tests {
    use super::*;

    #[test]
    fn cli_detect_returns_claude_catalog() {
        let det = cli_detect();
        assert!(
            det.claude_providers.len() >= 1,
            "claude providers missing from cli_detect"
        );
        assert_eq!(det.claude_providers[0].id, "claude-anthropic-api");
    }
}

#[cfg(test)]
mod cli_chat_tests {
    use super::parse_cli_chat_output;

    #[test]
    fn the_result_line_of_a_stream_json_run_becomes_text_and_token_counts() {
        let out = "{\"type\":\"system\",\"subtype\":\"init\"}\n{\"type\":\"assistant\",\"message\":{}}\n{\"type\":\"result\",\"is_error\":false,\"result\":\"hello\",\"usage\":{\"input_tokens\":2,\"cache_read_input_tokens\":10,\"cache_creation_input_tokens\":3,\"output_tokens\":7}}\n";
        let v: serde_json::Value = serde_json::from_str(&parse_cli_chat_output(out).unwrap()).unwrap();
        assert_eq!(v["text"], "hello");
        assert_eq!(v["inputTokens"], 15);
        assert_eq!(v["outputTokens"], 7);
        assert_eq!(v["isError"], false);
        assert!(parse_cli_chat_output("not json\n{\"type\":\"assistant\"}").is_none());
    }
}

#[cfg(test)]
mod agy_tests {
    use super::{parse_agy_chat_output, parse_agy_models};

    #[test]
    fn agy_result_event_becomes_text_and_tokens() {
        let ok = "{\"event\":\"init\",\"init\":{}}\n{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"pong\\n\",\"usage\":{\"input_tokens\":10,\"cache_read_tokens\":5,\"output_tokens\":3}}}\n";
        let v: serde_json::Value = serde_json::from_str(&parse_agy_chat_output(ok).unwrap()).unwrap();
        assert_eq!(v["text"], "pong\n");
        assert_eq!(v["isError"], false);
        assert_eq!(v["inputTokens"], 15);
        let bad = "{\"event\":\"result\",\"result\":{\"status\":\"ERROR\",\"error\":\"authentication required\"}}";
        let v: serde_json::Value = serde_json::from_str(&parse_agy_chat_output(bad).unwrap()).unwrap();
        assert_eq!(v["isError"], true);
        assert_eq!(v["text"], "authentication required");
        assert!(parse_agy_chat_output("no events here").is_none());
    }

    #[test]
    fn agy_models_listing_is_parsed() {
        let ids = parse_agy_models("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
        assert_eq!(ids, vec!["gemini-3.8-flash-high", "claude-sonnet-4-6"]);
    }
}

#[cfg(test)]
mod login_state_tests {
    use super::login_state_says;

    #[test]
    fn login_text_is_found_on_stdout_or_stderr() {
        assert!(login_state_says(b"", b"Logged in using ChatGPT
", "Logged in"), "codex writes to stderr");
        assert!(login_state_says(b"Logged in as x", b"", "Logged in"));
        assert!(!login_state_says(b"", b"Not signed in", "Logged in"));
        assert!(login_state_says(b"", b"Not logged in", "Not logged in"));
    }
}

#[cfg(test)]
mod codex_chat_tests {
    use super::{codex_error_line, codex_usage};

    #[test]
    fn usage_is_read_from_the_jsonl_events() {
        let out = "{\"type\":\"thread.started\"}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":120,\"cached_input_tokens\":50,\"output_tokens\":9}}\n";
        assert_eq!(codex_usage(out), (120, 9));
        assert_eq!(codex_usage("not json"), (0, 0));
    }

    #[test]
    fn the_useful_error_line_is_picked_out_of_the_noise() {
        let stderr = "OpenAI Codex v0.163.0\n--------\n2026 ERROR rmcp::transport::worker: worker quit\nERROR: You've hit your usage limit. Try again later.\nERROR: You've hit your usage limit. Try again later.\n";
        assert_eq!(codex_error_line(stderr, "").as_deref(), Some("You've hit your usage limit. Try again later."));
        let stdout = "{\"type\":\"turn.failed\",\"error\":{\"message\":\"boom\"}}\n";
        assert_eq!(codex_error_line("", stdout).as_deref(), Some("boom"));
        assert_eq!(codex_error_line("just logs\n", ""), None);
    }
}

#[cfg(test)]
mod cli_slot_tests {
    use super::{CliSlot, CLI_SLOTS, MAX_CLI_PROCESSES};

    #[test]
    fn slots_are_limited_and_released_on_drop() {
        let held: Vec<CliSlot> = (0..MAX_CLI_PROCESSES).map(|_| CliSlot::acquire()).collect();
        assert_eq!(*CLI_SLOTS.0.lock().unwrap(), MAX_CLI_PROCESSES);
        let waiter = std::thread::spawn(|| { let _s = CliSlot::acquire(); });
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!waiter.is_finished(), "a fifth process waits for a free slot");
        drop(held);
        waiter.join().unwrap();
        assert_eq!(*CLI_SLOTS.0.lock().unwrap(), 0);
    }
}
