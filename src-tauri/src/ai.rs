//! AI chat proxy — forwards OpenAI-compatible chat completion requests to the
//! provider endpoint configured in Settings (z.ai GLM, OpenAI, Ollama, custom).
//! Uses curl so CORS can never block the webview, and streams the request body
//! through stdin (image attachments can be megabytes of base64).

use serde::Serialize;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
    cmd.creation_flags(CREATE_NO_WINDOW);
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
        "{}{}zcode{}v2{}credentials.json",
        home.trim_end_matches(sep),
        sep,
        sep,
        sep
    );
    let text = std::fs::read_to_string(&path)
        .map_err(|_| "credentials.json not found (ZCode not installed?)".to_string())?;
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
}

/// Detects installed desktop AI apps by their well-known data directories.
fn detect_desktop_apps() -> Vec<DesktopAppInfo> {
    let mut out: Vec<DesktopAppInfo> = Vec::new();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let roaming = std::env::var("APPDATA").unwrap_or_default();
    let push = |out: &mut Vec<DesktopAppInfo>, id: &str, name: &str, version: String, path: String| {
        out.push(DesktopAppInfo {
            id: id.to_string(),
            name: name.to_string(),
            version,
            path,
        });
    };
    // Claude Desktop (Anthropic)
    let claude_roaming = Path::new(&roaming).join("Claude");
    let claude_local = Path::new(&local).join("AnthropicClaude");
    if claude_roaming.is_dir() || claude_local.is_dir() {
        push(
            &mut out,
            "claude-desktop",
            "Claude Desktop",
            String::new(),
            claude_roaming.display().to_string(),
        );
    }
    // ChatGPT Desktop (OpenAI, MSIX)
    let chatgpt = Path::new(&local).join("OpenAI.ChatGPT-Desktop");
    if chatgpt.is_dir() {
        push(
            &mut out,
            "chatgpt-desktop",
            "ChatGPT Desktop",
            String::new(),
            chatgpt.display().to_string(),
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
        push(
            &mut out,
            "gemini-desktop",
            "Gemini Desktop",
            version,
            gemini.display().to_string(),
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
}

/// The CLI coding agents pigry knows how to detect — (binary, display name).
/// Config-model readers exist for claude/codex; the rest report no model.
const DETECTABLE_APPS: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("copilot", "GitHub Copilot"),
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
        .creation_flags(CREATE_NO_WINDOW)
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

pub fn cli_detect() -> CliDetectResult {
    let claude_version = cli_version("claude");
    let codex_version = cli_version("codex");
    let copilot_version = cli_version("copilot");
    let claude_model = if claude_version.is_empty() {
        String::new()
    } else {
        read_claude_model()
    };
    let codex_model = if codex_version.is_empty() {
        String::new()
    } else {
        read_codex_model()
    };
    // Generic scan — every detectable binary the machine has.
    let mut apps: Vec<CliAppInfo> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (binary, name) in DETECTABLE_APPS {
        let version = cli_version(binary);
        if version.is_empty() {
            continue;
        }
        // `cursor-agent` wins over `cursor` when both exist.
        if seen.iter().any(|b| b == *binary || (*binary == "cursor" && b == "cursor-agent")) {
            continue;
        }
        seen.push(binary.to_string());
        apps.push(CliAppInfo {
            binary: binary.to_string(),
            name: name.to_string(),
            version,
            model: read_app_model(binary),
            effort: read_app_effort(binary),
        });
    }
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
    }
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
    cmd.creation_flags(CREATE_NO_WINDOW);
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
