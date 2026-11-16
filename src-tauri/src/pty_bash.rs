//! "Pigry Bash" — the busybox-style shell hosted by the integrated terminal.
//!
//! Spawned as `pigry.exe --pty-bash` under the terminal's ConPTY, so it runs
//! as a real child process inside a PTY (history/line editing come free from
//! the console host's cooked input mode). Each line dispatches through the
//! same busybox batches the one-shot `terminal_run` uses, with the platform
//! shell as the final fallback so pipes/redirection/git still work.

use std::io::Write;
use std::path::{Path, PathBuf};

const BANNER: &str = "Pigry Bash — busybox built-ins (ls, cat, grep, find, tar, …) with a \
cmd fallback for everything else. `help` lists commands, `exit` quits.";

/// REPL entry — returns the process exit code.
pub fn pty_bash_main() -> i32 {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    // Claim the console title before conhost names it after the exe.
    let _ = write!(out, "\x1b]0;Pigry Bash\x07");
    let _ = writeln!(out, "\x1b[36m{BANNER}\x1b[0m");
    let _ = out.flush();
    // The repository root is where the session started; it stays the `repo`
    // context for busybox commands while `cd` moves `cwd` around.
    let repo = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut cwd = repo.clone();
    let stdin = std::io::stdin();
    loop {
        let shown = cwd.to_string_lossy();
        let _ = write!(out, "\x1b[32m{shown}\x1b[0m \x1b[36m❯\x1b[0m ");
        let _ = out.flush();
        let mut line = String::new();
        if stdin.read_line(&mut line).unwrap_or(0) == 0 {
            break; // EOF — console closed
        }
        if !execute(&mut cwd, &repo, line.trim(), &mut out) {
            break;
        }
    }
    0
}

/// Run one command line. Returns `false` when the REPL should exit.
/// `cwd` persists across lines (cd). Output goes through `out`.
fn execute(cwd: &mut PathBuf, repo: &Path, line: &str, out: &mut impl Write) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }

    // Session controls handled before the busybox dispatch.
    match trimmed.to_ascii_lowercase().as_str() {
        "exit" | "quit" => return false,
        "cls" | "clear" => {
            let _ = write!(out, "\x1b[2J\x1b[H");
            let _ = out.flush();
            return true;
        }
        "help" => {
            let _ = writeln!(
                out,
                "built-ins: ls cat head tail wc grep find tree du df stat touch mkdir rmdir rm mv cp echo pwd \
cd date whoami hostname uname which env sleep seq sort uniq cut printf diff ln chmod test nl tac rev \
md5sum sha1sum sha256sum expr tar seq · shell fallback: git, npm, cargo, … · cls · exit"
            );
            return true;
        }
        _ => {}
    }

    // `cd` — same semantics as the one-shot terminal: canonicalize, must be
    // a directory, quoted paths supported. Bare `cd` goes home.
    if trimmed == "cd" || trimmed.starts_with("cd ") {
        let target = trimmed[2..].trim().trim_matches('"');
        let next = if target.is_empty() {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
                .unwrap_or_else(|| cwd.clone())
        } else {
            let path = PathBuf::from(target);
            if path.is_absolute() { path } else { cwd.join(path) }
        };
        match next.canonicalize() {
            Ok(dir) if dir.is_dir() => *cwd = humanize(dir),
            Ok(_) => {
                let _ = writeln!(out, "cd: not a directory: {target}");
                let _ = out.flush();
            }
            Err(e) => {
                let _ = writeln!(out, "cd: {e}");
                let _ = out.flush();
            }
        }
        return true;
    }

    let tokens: Vec<String> = trimmed.split_whitespace().map(str::to_string).collect();
    if let Some(first) = tokens.first() {
        let rest = &tokens[1..];

        // Batch 1: the core busybox (ls, cat, grep, …) — `cd` returns new_cwd.
        let result = crate::busybox::run(cwd, repo, first, rest);
        if result.code != 127 {
            emit(out, &result.stdout, &result.stderr, result.code);
            apply_cwd(cwd, result.new_cwd);
            return true;
        }

        // Batch 2: sort/uniq/cut/… (None = unknown).
        if let Some(extra) = crate::busybox_extra::run(cwd, repo, first, rest) {
            if extra.code != 127 {
                emit(out, &extra.stdout, &extra.stderr, extra.code);
                return true;
            }
        } else {
            // Batch 3: hashes/expr/tar (None = unknown).
            if let Some(third) = crate::busybox3::run(cwd, repo, first, rest) {
                emit(out, &third.stdout, &third.stderr, third.code);
                return true;
            }
        }
    }

    // Unknown everywhere — run through the platform shell with inherited
    // stdio so pipes, redirection and colors go straight to the PTY.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", trimmed]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", trimmed]);
        c
    };
    cmd.current_dir(cwd);
    match cmd.status() {
        Ok(status) => {
            if let Some(code) = status.code() {
                if code != 0 {
                    let _ = writeln!(out, "\x1b[2mexit code {code}\x1b[0m");
                    let _ = out.flush();
                }
            }
        }
        Err(e) => {
            let _ = writeln!(out, "pigry: {e}");
            let _ = out.flush();
        }
    }
    true
}

/// Print busybox output the way a shell would: stdout, then stderr, then a
/// dim exit-code line when the command failed.
fn emit(out: &mut impl Write, stdout: &str, stderr: &str, code: i32) {
    if !stdout.is_empty() {
        let _ = write!(out, "{stdout}");
        if !stdout.ends_with('\n') {
            let _ = writeln!(out);
        }
    }
    if !stderr.is_empty() {
        let _ = write!(out, "\x1b[31m{stderr}\x1b[0m");
        if !stderr.ends_with('\n') {
            let _ = writeln!(out);
        }
    }
    if code != 0 {
        let _ = writeln!(out, "\x1b[2mexit code {code}\x1b[0m");
    }
    let _ = out.flush();
}

fn apply_cwd(cwd: &mut PathBuf, new_cwd: Option<PathBuf>) {
    if let Some(next) = new_cwd {
        *cwd = next;
    }
}

/// Windows canonicalize returns verbatim `\\?\C:\…` paths — strip the
/// prefix so prompts and pwd print what a human expects.
fn humanize(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(unc) => PathBuf::from(format!(r"\\{unc}")),
        None => match text.strip_prefix(r"\\?\") {
            Some(flat) => PathBuf::from(flat),
            None => path,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pigry-bash-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn echo_runs_through_busybox_and_cd_persists() {
        let repo = scratch();
        let mut cwd = repo.clone();
        let mut out: Vec<u8> = Vec::new();
        assert!(execute(&mut cwd, &repo, "echo hello-bash", &mut out));
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("hello-bash"), "got: {text}");

        // cd moves the session cwd for later lines.
        let mut out: Vec<u8> = Vec::new();
        let src = repo.join("src");
        let _ = std::fs::create_dir_all(&src);
        assert!(execute(&mut cwd, &repo, "cd src", &mut out));
        assert_eq!(cwd.file_name().unwrap().to_string_lossy(), "src");
    }

    #[test]
    fn cls_and_exit_and_empty_are_session_controls() {
        let repo = scratch();
        let mut cwd = repo.clone();
        let mut out: Vec<u8> = Vec::new();
        assert!(execute(&mut cwd, &repo, "  ", &mut out));
        assert!(execute(&mut cwd, &repo, "cls", &mut out));
        assert_eq!(String::from_utf8_lossy(&out), "\x1b[2J\x1b[H");
        assert!(!execute(&mut cwd, &repo, "exit", &mut out));
        assert!(!execute(&mut cwd, &repo, "quit", &mut out));
    }

    #[test]
    fn help_lists_commands() {
        let repo = scratch();
        let mut cwd = repo.clone();
        let mut out: Vec<u8> = Vec::new();
        assert!(execute(&mut cwd, &repo, "help", &mut out));
        assert!(String::from_utf8_lossy(&out).contains("built-ins"));
    }

    #[test]
    fn humanize_strips_verbatim_prefixes() {
        assert_eq!(
            humanize(PathBuf::from(r"\\?\C:\Users\ondev\Projects")),
            PathBuf::from(r"C:\Users\ondev\Projects")
        );
        assert_eq!(
            humanize(PathBuf::from(r"\\?\UNC\server\share\doc")),
            PathBuf::from(r"\\server\share\doc")
        );
        assert_eq!(
            humanize(PathBuf::from(r"C:\plain\path")),
            PathBuf::from(r"C:\plain\path")
        );
    }
}
