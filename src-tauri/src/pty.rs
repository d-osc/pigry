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
use tauri::Emitter;

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

/// Detect shells available on this machine, VS Code-style: the ones the
/// platform guarantees first, optional ones only when installed.
/// Pigry Bash (the busybox REPL, this binary with `--pty-bash`) leads the
/// list and is therefore the default profile.
pub fn detect_shells() -> Vec<ShellProfile> {
    let mut shells = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        shells.push(ShellProfile {
            id: "pigry-bash".into(),
            name: "Pigry Bash".into(),
            exe: exe.to_string_lossy().into_owned(),
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
}
