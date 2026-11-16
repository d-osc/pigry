//! Real PTY terminals for the integrated terminal panel (VS Code-style).
//!
//! Each terminal tab owns a ConPTY session (via `portable-pty`). A reader
//! thread per session streams output to the frontend through the
//! `pty-output` / `pty-exit` events; input flows back through `pty_write`.
//! Sessions live in a static registry so the commands stay thin.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::LazyLock;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, State};

use crate::commands::AppState;
use crate::CommandNoWindow;

/// One live terminal session: the ConPTY master, its input writer and the
/// spawned shell child process.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// id → session registry (browser.rs keeps webview bounds the same way).
static PTYS: LazyLock<std::sync::Mutex<HashMap<u32, PtySession>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

const EVENT_OUTPUT: &str = "pty-output";
const EVENT_EXIT: &str = "pty-exit";

#[derive(Serialize, Clone)]
struct PtyChunk {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: u32,
    code: Option<u32>,
}

/// A shell the terminal can be spawned with.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub exe: String,
    pub args: Vec<String>,
}

/// Returned by `pty_create` — the frontend keys everything by `id`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInfo {
    pub id: u32,
    pub label: String,
    pub shell_name: String,
}

/// Append `chunk` to `leftover`, return the longest decodable UTF-8 prefix.
/// Keeps partial multi-byte sequences in `leftover` so characters split
/// across reader chunks still render correctly.
fn push_utf8_chunk(leftover: &mut Vec<u8>, chunk: &[u8]) -> String {
    leftover.extend_from_slice(chunk);
    match std::str::from_utf8(leftover) {
        Ok(text) => {
            let out = text.to_string();
            leftover.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&leftover[..valid]).into_owned();
            leftover.drain(..valid);
            // A dangling sequence longer than any UTF-8 char can never be
            // completed — flush it as replacement chars instead of stalling.
            if leftover.len() > 4 {
                let tail = String::from_utf8_lossy(&leftover).into_owned();
                leftover.clear();
                return format!("{out}{tail}");
            }
            out
        }
    }
}

fn windows_shell_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("SystemRoot").map(|root| std::path::PathBuf::from(root).join("System32"))
}

fn probe(paths: &[std::path::PathBuf]) -> Option<String> {
    paths
        .iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Path of the `pigry-shell` helper binary — the console-subsystem host for
/// the Pigry Bash REPL. The main binary is `windows_subsystem = "windows"`
/// in release builds, and ConPTY hands GUI-subsystem children neither a
/// console nor stdio, so the REPL must run from this helper. The bundlers
/// install every cargo bin next to the main executable.
fn pigry_shell_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let mut candidates = Vec::new();
    #[cfg(windows)]
    candidates.push(dir.join("pigry-shell.exe"));
    candidates.push(dir.join("pigry-shell"));
    candidates.into_iter().find(|p| p.is_file())
}

/// Detect shells available on this machine, VS Code-style: the ones the
/// platform guarantees first, optional ones only when installed.
/// Pigry Bash (the busybox REPL, this binary with `--pty-bash`) leads the
/// list and is therefore the default profile.
pub fn detect_shells() -> Vec<ShellProfile> {
    let mut shells = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        // Prefer the console-subsystem helper; fall back to this binary
        // (debug builds are console-subsystem themselves).
        let host = pigry_shell_path().unwrap_or(exe);
        shells.push(ShellProfile {
            id: "pigry-bash".into(),
            name: "Pigry Bash".into(),
            exe: host.to_string_lossy().into_owned(),
            args: vec!["--pty-bash".into()],
        });
    }

    #[cfg(windows)]
    {
        let sys = windows_shell_dir();
        if let Some(powershell) = sys.as_ref().map(|s| s.join("WindowsPowerShell\\v1.0\\powershell.exe")) {
            if powershell.is_file() {
                shells.push(ShellProfile {
                    id: "powershell".into(),
                    name: "PowerShell".into(),
                    exe: powershell.to_string_lossy().into_owned(),
                    args: vec!["-NoLogo".into()],
                });
            }
        }
        if let Some(pwsh) = probe(&[
            std::path::PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_default())
                .join("PowerShell\\7\\pwsh.exe"),
            std::path::PathBuf::from("pwsh.exe"),
        ]) {
            shells.push(ShellProfile {
                id: "pwsh".into(),
                name: "PowerShell 7".into(),
                exe: pwsh,
                args: vec!["-NoLogo".into()],
            });
        }
        if let Some(cmd) = sys.as_ref().map(|s| s.join("cmd.exe")) {
            if cmd.is_file() {
                shells.push(ShellProfile {
                    id: "cmd".into(),
                    name: "Command Prompt".into(),
                    exe: cmd.to_string_lossy().into_owned(),
                    args: Vec::new(),
                });
            }
        }
        if let Some(bash) = probe(&[
            std::path::PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_default())
                .join("Git\\bin\\bash.exe"),
            std::path::PathBuf::from(std::env::var_os("ProgramFiles(x86)").unwrap_or_default())
                .join("Git\\bin\\bash.exe"),
            std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())
                .join("Programs\\Git\\bin\\bash.exe"),
        ]) {
            shells.push(ShellProfile {
                id: "gitbash".into(),
                name: "Git Bash".into(),
                exe: bash,
                args: vec!["--login".into(), "-i".into()],
            });
        }
        if let Some(bash) = probe(&[std::path::PathBuf::from("C:\\msys64\\usr\\bin\\bash.exe")]) {
            shells.push(ShellProfile {
                id: "msys2".into(),
                name: "MSYS2 Bash".into(),
                exe: bash,
                args: vec!["--login".into(), "-i".into()],
            });
        }
        if let Some(wsl) = sys.as_ref().map(|s| s.join("wsl.exe")) {
            if wsl.is_file() {
                shells.push(ShellProfile {
                    id: "wsl".into(),
                    name: "WSL".into(),
                    exe: wsl.to_string_lossy().into_owned(),
                    args: Vec::new(),
                });
            }
        }
    }

    #[cfg(not(windows))]
    {
        for (id, name, exe, args) in [
            ("bash", "bash", "/bin/bash", vec![]),
            ("zsh", "zsh", "/bin/zsh", vec![]),
            ("sh", "sh", "/bin/sh", vec![]),
        ] {
            if std::path::Path::new(exe).is_file() {
                shells.push(ShellProfile {
                    id: id.into(),
                    name: name.into(),
                    exe: exe.into(),
                    args: args,
                });
            }
        }
    }

    shells
}

fn resolve_cwd(cwd: &str) -> std::path::PathBuf {
    let path = std::path::PathBuf::from(cwd);
    if path.is_dir() {
        return path;
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// Tree-kill a ConPTY child: shell children (npm → node …) must all die.
/// Follows the `taskkill /T /F` pattern from `net.rs`, with a direct
/// `child.kill()` as fallback.
fn kill_child_tree(child: &mut Box<dyn Child + Send + Sync>) {
    if let Some(pid) = child.process_id() {
        let pid = pid.to_string();
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .no_window()
            .output();
    }
    let _ = child.kill();
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<ShellProfile> {
    detect_shells()
}

#[tauri::command]
pub fn pty_create(
    app: tauri::AppHandle,
    shell_id: Option<String>,
    cwd: String,
) -> Result<PtySessionInfo, String> {
    let shells = detect_shells();
    let profile = shell_id
        .as_deref()
        .and_then(|id| shells.iter().find(|s| s.id == id))
        .or_else(|| shells.first())
        .ok_or_else(|| "no shell available".to_string())?
        .clone();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&profile.exe);
    for arg in &profile.args {
        cmd.arg(arg);
    }
    cmd.cwd(resolve_cwd(&cwd));
    // ConPTY needs the default console env; just tag the session for shells
    // that want to know they are hosted.
    cmd.env("TERM_PROGRAM", "pigry");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {} failed: {e}", profile.exe))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    drop(pair.slave); // eof for the slave side; the master keeps the session

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    PTYS.lock().map_err(|e| e.to_string())?.insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );

    // Exit watcher: polls the child independently of the output pipe. The
    // ConPTY output stream does NOT reach EOF while the master is alive in
    // the registry, so exit detection must not depend on the reader.
    let app_exit = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let Ok(mut map) = PTYS.lock() else { return };
        match map.get_mut(&id) {
            Some(session) => match session.child.try_wait() {
                Ok(Some(status)) => {
                    let code = Some(status.exit_code());
                    map.remove(&id); // drops the master → ConPTY closes → reader EOFs
                    let _ = app_exit.emit(EVENT_EXIT, PtyExit { id, code });
                    return;
                }
                Ok(None) => continue,
                Err(_) => {
                    map.remove(&id);
                    let _ = app_exit.emit(EVENT_EXIT, PtyExit { id, code: None });
                    return;
                }
            },
            // Killed/closed from the frontend — it owns the announcement.
            None => return,
        }
    });

    // Output pump: read the master and forward chunks to the webview until
    // the ConPTY closes (the exit watcher drops the master on child exit).
    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = push_utf8_chunk(&mut leftover, &buf[..n]);
                    if !text.is_empty() {
                        let _ = app_out.emit(EVENT_OUTPUT, PtyChunk { id, data: text });
                    }
                }
                Err(_) => break,
            }
        }
        if !leftover.is_empty() {
            let _ = app_out.emit(
                EVENT_OUTPUT,
                PtyChunk {
                    id,
                    data: String::from_utf8_lossy(&leftover).into_owned(),
                },
            );
        }
    });

    Ok(PtySessionInfo {
        id,
        label: profile.name.clone(),
        shell_name: profile.name,
    })
}

#[tauri::command]
pub fn pty_write(id: u32, data: String) -> Result<(), String> {
    let mut map = PTYS.lock().map_err(|e| e.to_string())?;
    let session = map.get_mut(&id).ok_or("terminal session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))
}

#[tauri::command]
pub fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = PTYS.lock().map_err(|e| e.to_string())?;
    let session = map.get(&id).ok_or("terminal session not found")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

#[tauri::command]
pub fn pty_kill(id: u32) -> Result<(), String> {
    let mut map = PTYS.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = map.remove(&id) {
        kill_child_tree(&mut session.child);
    }
    Ok(())
}

/// Kill every live session — called once on app exit so no shell children
/// outlive the app (the first RunEvent handling in the app).
pub fn kill_all() {
    let Ok(mut map) = PTYS.lock() else { return };
    for (_, mut session) in map.drain() {
        kill_child_tree(&mut session.child);
    }
}

// --- agent tool: run_command ------------------------------------------------

/// Result of one agent command run through a private Pigry Bash session.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentShellOutput {
    pub output: String,
    pub code: i32,
    pub timed_out: bool,
}

/// Remove CSI/OSC escape sequences so the agent sees plain text.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI — swallow until the final byte.
            Some('[') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if ('A'..='Z').contains(&n) || ('a'..='z').contains(&n) {
                        break;
                    }
                }
            }
            // OSC — terminated by BEL or ESC \.
            Some(']') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The REPL prints `<cwd> ❯ ` whenever it is ready for the next line —
/// the second ❯ means the command has finished.
fn prompt_count(stripped: &str) -> usize {
    stripped.matches('\u{276f}').count()
}

/// The REPL prints a dim `exit code N` line for failed commands — the last
/// one wins; absent means success.
fn tail_exit_code(stripped: &str) -> i32 {
    stripped.lines().rev().find_map(|line| {
        line.trim()
            .strip_prefix("exit code ")
            .and_then(|rest| rest.trim().parse::<i32>().ok())
    })
    .unwrap_or(0)
}

/// Tidy the captured transcript for the model: plain text, \n line breaks,
/// trailing prompt gone.
fn clean_transcript(raw: &[u8]) -> String {
    let text = strip_ansi(&String::from_utf8_lossy(raw));
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    // Cut everything from the final prompt line — it is the ready-for-next-
    // command marker, not part of the answer.
    if let Some(pos) = text.rfind('\u{276f}') {
        let cut = text[..pos]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        return text[..cut].to_string();
    }
    text
}

const AGENT_SHELL_IDLE_CAP_MS: u64 = 90_000;

/// Run one command line through a throwaway Pigry Bash session (the same
/// busybox + shell-fallback stack the integrated terminal hosts) and return
/// its captured output. One shot: the session dies with the command.
#[tauri::command]
pub async fn agent_shell_run(
    state: State<'_, std::sync::Mutex<AppState>>,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<AgentShellOutput, String> {
    let repo_path = {
        let app = state.lock().map_err(|e| e.to_string())?;
        app.repo_path
            .as_deref()
            .ok_or_else(|| "no repository open".to_string())?
            .to_path_buf()
    };
    let timeout_ms = timeout_secs.unwrap_or(120).clamp(5, 600) * 1000;
    let command = command.replace(['\r', '\n'], " ");
    if command.trim().is_empty() {
        return Err("empty command".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        agent_shell_blocking(&repo_path, &command, timeout_ms)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn agent_shell_blocking(cwd: &std::path::Path, command: &str, timeout_ms: u64) -> Result<AgentShellOutput, String> {
    // Same host rule as the terminal profiles: the console-subsystem helper
    // when present, else this binary (debug builds).
    let exe = pigry_shell_path()
        .or_else(|| std::env::current_exe().ok())
        .ok_or_else(|| "current_exe failed".to_string())?;
    let pty_system = native_pty_system();
    // Wide rows keep long lines unwrapped for cleaner model output.
    let pair = pty_system
        .openpty(PtySize { rows: 50, cols: 200, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;
    let mut cmd = CommandBuilder::new(&exe);
    cmd.arg("--pty-bash");
    cmd.cwd(resolve_cwd(&cwd.to_string_lossy()));
    cmd.env("TERM_PROGRAM", "pigry");
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn pigry-bash failed: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    drop(pair.slave);

    writer
        .write_all(command.as_bytes())
        .and_then(|_| writer.write_all(b"\r\n"))
        .and_then(|_| writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))?;

    // The master reader blocks, so pump it from a thread and poll here —
    // total-timeout and idle checks need to run while nothing arrives.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let started = std::time::Instant::now();
    let mut last_output = started;
    let mut raw: Vec<u8> = Vec::new();
    let mut timed_out = false;
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(chunk) => {
                raw.extend_from_slice(&chunk);
                last_output = std::time::Instant::now();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            // Console closed — child is gone, collect what we have.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        let prompts = prompt_count(&strip_ansi(&String::from_utf8_lossy(&raw)));
        if prompts >= 2 {
            break;
        }
        if started.elapsed() >= std::time::Duration::from_millis(timeout_ms) {
            timed_out = true;
            break;
        }
        if last_output.elapsed() >= std::time::Duration::from_millis(AGENT_SHELL_IDLE_CAP_MS) {
            break;
        }
    }
    // Brief drain so trailing bytes riding the channel make it in.
    while let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(150)) {
        raw.extend_from_slice(&chunk);
    }
    kill_child_tree(&mut child);

    let mut output = clean_transcript(&raw);
    if output.len() > 24_000 {
        output = format!("[output truncated]\n{}", &output[output.len() - 24_000..]);
    }
    let code = tail_exit_code(&output);
    Ok(AgentShellOutput { output, code, timed_out })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_chunk_splits_keep_characters_whole() {
        // "ไทย" is three bytes per char — split every byte apart and the
        // recomposed output must still be the same string.
        let text = "ไทย git status ✅";
        let bytes = text.as_bytes();
        let mut leftover = Vec::new();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&push_utf8_chunk(&mut leftover, &[*b]));
        }
        assert!(leftover.is_empty());
        assert_eq!(out, text);
    }

    #[test]
    fn utf8_dangling_junk_flushes_instead_of_stalling() {
        let mut leftover = Vec::new();
        // Four stray invalid bytes (0xff is never valid anywhere) — still
        // within one max char length, so they wait for a possible successor.
        assert!(push_utf8_chunk(&mut leftover, &[0xff, 0xff, 0xff, 0xff]).is_empty());
        assert_eq!(leftover.len(), 4);
        // More than 4 unmatched bytes can never complete: flush as
        // replacement chars and keep the trailing 'a'.
        let out = push_utf8_chunk(&mut leftover, &[0xff, b'a']);
        assert!(out.ends_with('a'));
        assert!(leftover.is_empty());
    }

    #[test]
    fn detect_shells_lists_unique_ids() {
        let shells = detect_shells();
        assert!(!shells.is_empty(), "at least one shell must exist");
        let mut ids: Vec<&str> = shells.iter().map(|s| s.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), shells.len());
    }

    #[test]
    fn strip_ansi_removes_csi_and_osc_sequences() {
        // The OSC payload (window title) is swallowed along with the sequence.
        let text = "\x1b[32mgreen\x1b[0m \x1b]0;title\x07plain \x1b[2Kline \x1b[1;31mred\x1b[m end";
        assert_eq!(strip_ansi(text), "green plain line red end");
    }

    #[test]
    fn prompt_count_and_exit_code_read_the_transcript() {
        let transcript = "banner\nrepo \u{276f} echo hi\nhi\nrepo \u{276f}";
        assert_eq!(prompt_count(&strip_ansi(transcript)), 2);
        let failed = "repo \u{276f} boom\nexit code 2\nrepo \u{276f}";
        assert_eq!(tail_exit_code(&strip_ansi(failed)), 2);
        assert_eq!(tail_exit_code("all good\n"), 0);
    }

    #[test]
    fn clean_transcript_drops_trailing_prompt() {
        let raw = format!("banner\nrepo \u{276f} echo hi\nhi\nrepo \u{276f} ").into_bytes();
        let text = clean_transcript(&raw);
        // Command echo and output stay; only the trailing ready-prompt goes.
        assert!(text.contains("echo hi"));
        assert!(text.ends_with("hi\n"));
        assert!(!text.ends_with('\u{276f}'));
    }
}
