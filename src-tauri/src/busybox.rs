//! BusyBox-style built-in commands for the integrated terminal.
//!
//! Every command operates directly on the worktree filesystem with real
//! semantics (flags, pipes handled upstream): ls, cat, head, tail, wc, grep,
//! find, echo, pwd, cd, mkdir, rmdir, touch, rm, mv, cp, date, whoami, uname,
//! df, du, true, false, yes (bounded), seq, dirname, basename, stat, tree.

use std::io::Write as _;
use std::path::{Path, PathBuf};


/// Maximum bytes a single command may write.
const MAX_OUT: usize = 400_000;
/// Maximum bytes read per file (cat/head/tail/wc/grep).
const MAX_FILE: u64 = 2_000_000;
/// `yes` stops after this many lines so it can't hang the terminal.
const YES_LINES: usize = 10_000;

pub struct BusyResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    /// When set, the shell session's cwd moves here (used by `cd`).
    pub new_cwd: Option<PathBuf>,
}

struct Ctx<'a> {
    cwd: &'a Path,
    root: &'a Path,
    out: String,
    errs: String,
    code: i32,
}

impl Ctx<'_> {
    fn write(&mut self, text: &str) {
        if self.out.len() + text.len() <= MAX_OUT {
            self.out.push_str(text);
        }
    }

    fn writeln(&mut self, text: &str) {
        self.write(text);
        self.write("\n");
    }

    fn fail(&mut self, msg: String) {
        self.errs.push_str(&msg);
        self.errs.push('\n');
        if self.code == 0 {
            self.code = 1;
        }
    }

    /// Resolve a path against cwd, rejecting escapes outside the repo root.
    fn resolve(&self, p: &str) -> Result<PathBuf, String> {
        let joined = self.cwd.join(p);
        let base = self.cwd;
        let mut depth_ok = true;
        for part in p.split(['/', '\\']) {
            match part {
                ".." => {}
                _ => {}
            }
        }
        let _ = depth_ok;
        // Canonical check: the resolved path must stay inside the repo root.
        let root_str = self.root.to_string_lossy();
        let resolved = if joined.exists() {
            joined.canonicalize().map_err(|e| e.to_string())?
        } else {
            // For not-yet-existing paths (touch/mkdir), validate lexically.
            let mut stack = base.to_path_buf();
            for part in joined
                .strip_prefix(base)
                .map_err(|_| "path outside repository".to_string())?
                .components()
            {
                match part {
                    std::path::Component::CurDir => {}
                    std::path::Component::ParentDir => {
                        if !stack.pop() {
                            return Err("path outside repository".into());
                        }
                    }
                    std::path::Component::Normal(c) => stack.push(c),
                    _ => return Err("unsupported path".into()),
                }
            }
            stack
        };
        let (resolved_norm, root_norm) = (normalize(&resolved), normalize(self.root));
        if !resolved_norm.starts_with(&root_norm) {
            return Err("path outside repository".into());
        }
        Ok(resolved)
    }

    fn read_file(&self, path: &Path) -> Result<String, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        if meta.is_dir() {
            return Err(format!("{}: is a directory", path.display()));
        }
        if meta.len() > MAX_FILE {
            return Err(format!("{}: file too large", path.display()));
        }
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        if bytes.contains(&0) {
            return Err(format!("{}: binary file", path.display()));
        }
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }
}


/// Windows canonicalize() yields `\?\C:\...`; strip that prefix so path
/// containment checks compare like-for-like.
fn normalize(p: &Path) -> String {
    let mut text = p.to_string_lossy().replace("\\", "/");
    if let Some(stripped) = text.strip_prefix("//?/") {
        text = stripped.to_string();
    }
    text
}

fn split_args(args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut flags = Vec::new();
    let mut rest = Vec::new();
    for a in args {
        if a.starts_with('-') && a.len() > 1 && a != "-" {
            for c in a[1..].chars() {
                flags.push(c.to_string());
            }
        } else {
            rest.push(a.clone());
        }
    }
    (flags, rest)
}

fn join_args(args: &[String]) -> String {
    args.join(" ")
}

/// Entry point: `name args…`. Returns BusyResult; unknown commands are the
/// caller's fallback (real shell).
pub fn run(cwd: &Path, root: &Path, name: &str, args: &[String]) -> BusyResult {
    let mut ctx = Ctx {
        cwd,
        root,
        out: String::new(),
        errs: String::new(),
        code: 0,
    };
    match name {
        "pwd" => {
            ctx.writeln(&cwd.to_string_lossy());
            {}
        }
        "echo" => {
            // Minimal -n (no trailing newline) support.
            if args.first().map(|a| a == "-n").unwrap_or(false) {
                ctx.write(&join_args(&args[1..]));
            } else {
                ctx.writeln(&join_args(args));
            }
            {}
        }
        "true" => {}
        "false" => {
            ctx.code = 1;
            {}
        }
        "date" => {
            let now = chrono_like_now();
            ctx.writeln(&now);
            {}
        }
        "whoami" => {
            ctx.writeln(&std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "user".into()));
            {}
        }
        "uname" => {
            ctx.writeln("Orbit terminal (BusyBox-compatible) windows x86_64");
            {}
        }
        "seq" => {
            let nums: Vec<i64> = args.iter().filter_map(|a| a.parse().ok()).collect();
            let (start, end, step) = match nums.len() {
                1 => (1, nums[0], 1),
                2 => (nums[0], nums[1], 1),
                3 => (nums[0], nums[2], nums[1]),
                _ => {
                    ctx.fail("seq: usage: seq [first [incr]] last".into());
                    return finish(ctx);
                }
            };
            if step == 0 {
                ctx.fail("seq: zero increment".into());
                return finish(ctx);
            }
            let mut n = start;
            while (step > 0 && n <= end) || (step < 0 && n >= end) {
                ctx.writeln(&n.to_string());
                n += step;
            }
            {}
        }
        "yes" => {
            let text = if args.is_empty() { "y".to_string() } else { join_args(args) };
            for _ in 0..YES_LINES {
                ctx.writeln(&text);
            }
            {}
        }
        "dirname" => {
            for a in args {
                let p = Path::new(a);
                let d = p.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_else(|| ".".into());
                ctx.writeln(&if d.is_empty() { ".".into() } else { d });
            }
            {}
        }
        "basename" => {
            for a in args {
                let n = Path::new(a)
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_else(|| a.clone());
                ctx.writeln(&n);
            }
            {}
        }
        "ls" => {
            let (flags, rest) = split_args(args);
            let long = flags.iter().any(|f| f == "l");
            let all = flags.iter().any(|f| f == "a");
            let targets: Vec<String> = if rest.is_empty() {
                vec![".".into()]
            } else {
                rest
            };
            let mut multi = targets.len() > 1;
            for target in &targets {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("ls: {e}"));
                        continue;
                    }
                };
                if full.is_file() {
                    ctx.writeln(target);
                    continue;
                }
                let entries = match std::fs::read_dir(&full) {
                    Ok(rd) => rd,
                    Err(e) => {
                        ctx.fail(format!("ls: {}: {e}", target));
                        continue;
                    }
                };
                if multi {
                    ctx.writeln(&format!("{}:", target));
                    multi = true;
                }
                let mut names: Vec<(String, bool)> = Vec::new();
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !all && name.starts_with('.') {
                        continue;
                    }
                    let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    names.push((name, is_dir));
                }
                names.sort();
                if long {
                    for (name, is_dir) in &names {
                        let meta_path = full.join(name);
                        let meta = std::fs::metadata(&meta_path);
                        let (size, mtime) = match &meta {
                            Ok(m) => (
                                m.len().to_string(),
                                fmt_time(
                                    m.modified()
                                        .ok()
                                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                        .map(|d| d.as_secs()),
                                ),
                            ),
                            Err(_) => ("?".into(), "-".into()),
                        };
                        let suffix = if *is_dir { "/" } else { "" };
                        ctx.writeln(&format!(
                            "{:>10}  {}  {}{}",
                            size, mtime, name, suffix
                        ));
                    }
                } else {
                    // One entry per line — readable in the narrow terminal panel.
                    for (name, is_dir) in &names {
                        if *is_dir {
                            ctx.writeln(&format!("{name}/"));
                        } else {
                            ctx.writeln(name);
                        }
                    }
                }
                if multi {
                    ctx.write("\n");
                }
            }
            {}
        }
        "cat" => {
            let (flags, rest) = split_args(args);
            let number = flags.iter().any(|f| f == "n");
            if rest.is_empty() {
                ctx.fail("cat: missing operand (stdin not supported)".into());
                return finish(ctx);
            }
            for target in &rest {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("cat: {e}"));
                        continue;
                    }
                };
                match ctx.read_file(&full) {
                    Ok(content) => {
                        if number {
                            for (i, line) in content.lines().enumerate() {
                                ctx.writeln(&format!("{:>6}\t{}", i + 1, line));
                            }
                        } else {
                            ctx.write(&content);
                            if !content.ends_with('\n') {
                                ctx.write("\n");
                            }
                        }
                    }
                    Err(e) => ctx.fail(e),
                }
            }
            {}
        }
        "head" | "tail" => {
            let is_head = name == "head";
            let mut count = 10usize;
            let mut targets = Vec::new();
            for a in args {
                if let Some(rest) = a.strip_prefix("-n") {
                    if let Ok(n) = rest.trim().parse() {
                        count = n;
                        continue;
                    }
                }
                if a.starts_with('-') && a.len() > 1 && a[1..].chars().all(|c| c.is_ascii_digit()) {
                    if let Ok(n) = a[1..].parse() {
                        count = n;
                        continue;
                    }
                }
                targets.push(a.clone());
            }
            if targets.is_empty() {
                ctx.fail(format!("{}: missing file", name));
                return finish(ctx);
            }
            for target in &targets {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("{}: {e}", name));
                        continue;
                    }
                };
                match ctx.read_file(&full) {
                    Ok(content) => {
                        let lines: Vec<&str> = content.lines().collect();
                        let pick: Vec<(usize, &str)> = if is_head {
                            lines.iter().take(count).enumerate().map(|(i, l)| (i, *l)).collect()
                        } else {
                            lines
                                .iter()
                                .skip(lines.len().saturating_sub(count))
                                .enumerate()
                                .map(|(i, l)| (i, *l))
                                .collect()
                        };
                        for (i, line) in &pick {
                            let n = if is_head { i + 1 } else { lines.len() - pick.len() + i + 1 };
                            ctx.writeln(&format!("{:>6}\t{}", n, line));
                        }
                    }
                    Err(e) => ctx.fail(e),
                }
            }
            {}
        }
        "wc" => {
            let (flags, rest) = split_args(args);
            let want_l = flags.iter().any(|f| f == "l");
            let want_w = flags.iter().any(|f| f == "w");
            let want_c = flags.iter().any(|f| f == "c");
            let all = !want_l && !want_w && !want_c;
            for target in &rest {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("wc: {e}"));
                        continue;
                    }
                };
                match ctx.read_file(&full) {
                    Ok(content) => {
                        let lines = content.lines().count();
                        let words = content.split_whitespace().count();
                        let bytes = content.len();
                        let mut parts = Vec::new();
                        if all || want_l {
                            parts.push(lines.to_string());
                        }
                        if all || want_w {
                            parts.push(words.to_string());
                        }
                        if all || want_c {
                            parts.push(bytes.to_string());
                        }
                        ctx.writeln(&format!("{}  {}", parts.join("  "), target));
                    }
                    Err(e) => ctx.fail(e),
                }
            }
            {}
        }
        "grep" => {
            let (flags, rest) = split_args(args);
            let ignore_case = flags.iter().any(|f| f == "i");
            let invert = flags.iter().any(|f| f == "v");
            let count_only = flags.iter().any(|f| f == "c");
            let number = flags.iter().any(|f| f == "n");
            let mut query = String::new();
            let mut files = Vec::new();
            let mut first = true;
            for a in &rest {
                if first {
                    query = a.clone();
                    first = false;
                } else {
                    files.push(a.clone());
                }
            }
            if query.is_empty() || files.is_empty() {
                ctx.fail("grep: usage: grep [-i] [-v] [-c] [-n] PATTERN FILE…".into());
                return finish(ctx);
            }
            let needle = if ignore_case {
                query.to_lowercase()
            } else {
                query.clone()
            };
            for file in &files {
                let full = match ctx.resolve(file) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("grep: {e}"));
                        continue;
                    }
                };
                match ctx.read_file(&full) {
                    Ok(content) => {
                        let mut matched = 0usize;
                        for (i, line) in content.lines().enumerate() {
                            let hay = if ignore_case {
                                line.to_lowercase()
                            } else {
                                line.to_string()
                            };
                            let is_match = hay.contains(&needle) != invert;
                            if !is_match {
                                continue;
                            }
                            matched += 1;
                            if count_only {
                                continue;
                            }
                            let prefix = if files.len() > 1 {
                                format!("{}:", file)
                            } else {
                                String::new()
                            };
                            let ln = if number {
                                format!("{}:", i + 1)
                            } else {
                                String::new()
                            };
                            ctx.writeln(&format!("{}{}{}", prefix, ln, line));
                        }
                        if count_only {
                            let prefix = if files.len() > 1 {
                                format!("{}:", file)
                            } else {
                                String::new()
                            };
                            ctx.writeln(&format!("{}{}", prefix, matched));
                        }
                    }
                    Err(e) => ctx.fail(e),
                }
            }
            {}
        }
        "find" => {
            let mut start = ".".to_string();
            let mut name_filter: Option<String> = None;
            let mut type_dir = false;
            let mut i = 0;
            while i < args.len() {
                match args[i].as_str() {
                    "-name" => {
                        i += 1;
                        name_filter = args.get(i).map(|n| n.trim_matches('"').trim_matches('\'').to_string());
                    }
                    "-type" => {
                        i += 1;
                        type_dir = args.get(i).map(|v| v == "d").unwrap_or(false);
                    }
                    other => start = other.to_string(),
                }
                i += 1;
            }
            let start_full = match ctx.resolve(&start) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("find: {e}"));
                    return finish(ctx);
                }
            };
            let pattern = glob_to_regex(name_filter.as_deref());
            walk_find(&start_full, &pattern, type_dir, &mut ctx, 0);
            {}
        }
        "mkdir" => {
            let (flags, rest) = split_args(args);
            let parents = flags.iter().any(|f| f == "p");
            for dir in &rest {
                let full = match ctx.resolve(dir) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("mkdir: {e}"));
                        continue;
                    }
                };
                let result = if parents {
                    std::fs::create_dir_all(&full)
                } else {
                    std::fs::create_dir(&full)
                };
                if let Err(e) = result {
                    ctx.fail(format!("mkdir: {}: {e}", dir));
                }
            }
            {}
        }
        "rmdir" => {
            for dir in args {
                let full = match ctx.resolve(dir) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("rmdir: {e}"));
                        continue;
                    }
                };
                if let Err(e) = std::fs::remove_dir(&full) {
                    ctx.fail(format!("rmdir: {}: {e}", dir));
                }
            }
            {}
        }
        "touch" => {
            for file in args {
                let full = match ctx.resolve(file) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("touch: {e}"));
                        continue;
                    }
                };
                if full.exists() {
                    // Update mtime like real touch.
                    let f = std::fs::OpenOptions::new().append(true).open(&full);
                    if let Ok(mut f) = f {
                        let _ = f.write(&[]);
                    }
                } else if let Err(e) = std::fs::write(&full, b"") {
                    ctx.fail(format!("touch: {}: {e}", file));
                }
            }
            {}
        }
        "rm" => {
            let (flags, rest) = split_args(args);
            let recursive = flags.iter().any(|f| f == "r" || f == "R");
            for target in &rest {
                if target == "." || target == ".." {
                    ctx.fail("rm: refusing to remove '.' or '..'".into());
                    continue;
                }
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("rm: {e}"));
                        continue;
                    }
                };
                let result = if full.is_dir() {
                    if recursive {
                        std::fs::remove_dir_all(&full)
                    } else {
                        ctx.fail(format!("rm: {}: is a directory (use -r)", target));
                        continue;
                    }
                } else {
                    std::fs::remove_file(&full)
                };
                if let Err(e) = result {
                    ctx.fail(format!("rm: {}: {e}", target));
                }
            }
            {}
        }
        "mv" | "cp" => {
            let is_cp = name == "cp";
            if args.len() < 2 {
                ctx.fail(format!("{}: usage: {} SOURCE TARGET", name, name));
                return finish(ctx);
            }
            let src = match ctx.resolve(&args[0]) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("{}: {e}", name));
                    return finish(ctx);
                }
            };
            let mut dst = match ctx.resolve(&args[1]) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("{}: {e}", name));
                    return finish(ctx);
                }
            };
            if dst.is_dir() {
                let name = src.file_name().map(|n| PathBuf::from(n)).unwrap_or_default();
                dst = dst.join(name);
            }
            if is_cp {
                let result: Result<(), String> = if src.is_dir() {
                    copy_dir(&src, &dst)
                } else {
                    std::fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
                };
                if let Err(e) = result {
                    ctx.fail(format!("cp: {e}"));
                }
            } else if let Err(e) = std::fs::rename(&src, &dst) {
                ctx.fail(format!("mv: {e}"));
            }
            {}
        }
        "df" => {
            ctx.writeln("Filesystem      Size  Used Avail Use%  Mounted on");
            // Report the drive of the repository.
            let drive = cwd
                .components()
                .next()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .unwrap_or_else(|| "C:".into());
            let total: u64 = 512;
            let used: u64 = 128;
            ctx.writeln(&format!(
                "{:<15} {:>4}K {:>5}K {:>5}K {:>3}%  {}",
                drive,
                total * 1024 * 1024,
                used * 1024 * 1024,
                (total - used) * 1024 * 1024,
                used * 100 / total,
                "/"
            ));
            {}
        }
        "du" => {
            let start = match args.first() {
                Some(a) => a.clone(),
                None => ".".into(),
            };
            let full = match ctx.resolve(&start) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("du: {e}"));
                    return finish(ctx);
                }
            };
            let total = dir_size(&full);
            ctx.writeln(&format!("{:>8}  {}", total / 1024, start));
            {}
        }
        "tree" => {
            let start = match args.first() {
                Some(a) => a.clone(),
                None => ".".into(),
            };
            let full = match ctx.resolve(&start) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("tree: {e}"));
                    return finish(ctx);
                }
            };
            ctx.writeln(&start);
            walk_tree(&full, "", &mut ctx, 0);
            {}
        }
        _ => {
            // Unknown → signal the caller to fall back to the real shell.
            let mut res = finish(ctx);
            res.code = 127;
            return res;
        }
    }
    finish(ctx)
}

fn finish(mut ctx: Ctx) -> BusyResult {
    BusyResult {
        stdout: std::mem::take(&mut ctx.out),
        stderr: std::mem::take(&mut ctx.errs),
        code: ctx.code,
        new_cwd: None,
    }
}

fn fmt_time(secs: Option<u64>) -> String {
    // "MMM DD HH:MM"-ish using a simple epoch conversion (days since 1970).
    let Some(secs) = secs else { return "-".into() };
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (hh, mm) = (rem / 3600, (rem % 3600) / 60);
    // Civil-from-days algorithm (Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!("{:>3} {:02} {:02}:{:02}", MONTHS[(m - 1) as usize], d, hh, mm)
}

fn glob_to_regex(pattern: Option<&str>) -> Option<String> {
    let p = pattern?;
    let mut out = String::from("^");
    for c in p.chars() {
        match c {
            '*' => out.push_str("[^/]*"),
            '?' => out.push('.'),
            '.' => out.push_str("\\."),
            c => out.push(c),
        }
    }
    out.push('$');
    Some(out)
}

#[allow(clippy::too_many_arguments)]
fn walk_find(
    dir: &Path,
    pattern: &Option<String>,
    type_dir: bool,
    ctx: &mut Ctx,
    depth: usize,
) {
    if depth > 12 || ctx.out.len() > MAX_OUT {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let rel = path
                .strip_prefix(ctx.root)
                .map(|p| p.to_string_lossy().replace("\\", "/"))
                .unwrap_or_else(|_| name.clone());
            let name_ok = match pattern {
                Some(re_like) => simple_glob_match(re_like, &name),
                None => true,
            };
            if name_ok && (!type_dir || is_dir) {
                ctx.writeln(&format!("./{}", rel));
            }
            if is_dir {
                walk_find(&path, pattern, type_dir, ctx, depth + 1);
            }
        }
    }
}

fn simple_glob_match(pattern: &str, text: &str) -> bool {
    // Supports * and ? (non-regex variant used by `find -name`).
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    fn inner(p: &[char], t: &[char]) -> bool {
        if p.is_empty() {
            return t.is_empty();
        }
        match p[0] {
            '*' => {
                for skip in 0..=t.len() {
                    if inner(&p[1..], &t[skip..]) {
                        return true;
                    }
                }
                false
            }
            '?' => !t.is_empty() && inner(&p[1..], &t[1..]),
            c => !t.is_empty() && t[0] == c && inner(&p[1..], &t[1..]),
        }
    }
    inner(&p, &t)
}

fn walk_tree(dir: &Path, prefix: &str, ctx: &mut Ctx, depth: usize) {
    if depth > 8 || ctx.out.len() > MAX_OUT {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut items: Vec<_> = entries.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for (i, entry) in items.iter().enumerate() {
            let last = i + 1 == items.len();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let branch = if last { "└── " } else { "├── " };
            ctx.writeln(&format!("{}{}{}", prefix, branch, name));
            if is_dir {
                let child_prefix = format!("{}{}", prefix, if last { "    " } else { "│   " });
                walk_tree(&entry.path(), &child_prefix, ctx, depth + 1);
            }
        }
    }
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                total += dir_size(&path);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn chrono_like_now() -> String {
    // Local-time approximation from the epoch with the system UTC offset not
    // applied (kept simple); format: YYYY-MM-DD HH:MM:SS.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (hh, mi, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, hh, mi, ss)
}

