//! BusyBox-compatible applets, second batch: sort, uniq, cut, stat, realpath,
//! readlink, which, env, hostname, id, printf, diff, cmp, ln, chmod, test/[,
//! sleep, help.

use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 2_000_000;

pub struct ExtraResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
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
        if self.out.len() + text.len() <= 400_000 {
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

    fn resolve(&self, p: &str) -> Result<PathBuf, String> {
        let joined = self.cwd.join(p);
        let base = self.cwd;
        if joined.exists() {
            let resolved = joined.canonicalize().map_err(|e| e.to_string())?;
            if !normalize(&resolved).starts_with(&normalize(base)) {
            }
            return Ok(resolved);
        }
        // Lexical validation for not-yet-existing paths.
        let mut stack = base.to_path_buf();
        let rel = joined
            .strip_prefix(base)
            .map_err(|_| "path outside repository".to_string())?;
        for part in rel.components() {
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
        Ok(stack)
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

fn finish(mut ctx: Ctx) -> ExtraResult {
    ExtraResult {
        stdout: std::mem::take(&mut ctx.out),
        stderr: std::mem::take(&mut ctx.errs),
        code: ctx.code,
    }
}

pub fn run(cwd: &Path, root: &Path, name: &str, args: &[String]) -> Option<ExtraResult> {
    let mut ctx = Ctx {
        cwd,
        root,
        out: String::new(),
        errs: String::new(),
        code: 0,
    };
    match name {
        "help" => {
            ctx.writeln("Built-in commands:");
            ctx.writeln("  cat ls find grep wc head tail sort uniq cut stat touch mkdir rmdir rm");
            ctx.writeln("  mv cp echo pwd cd date whoami hostname id uname which env realpath readlink");
            ctx.writeln("  printf seq yes true false ln chmod diff cmp df du tree help cls clear");
            ctx.writeln("Everything else runs through the system shell.");
        }
        "sleep" => {
            let secs: f64 = args.first().and_then(|a| a.parse().ok()).unwrap_or(0.0);
            std::thread::sleep(std::time::Duration::from_millis((secs * 1000.0) as u64));
        }
        "sort" => {
            let (flags, rest) = split_args(args);
            let reverse = flags.iter().any(|f| f == "r");
            let numeric = flags.iter().any(|f| f == "n");
            if rest.is_empty() {
                ctx.fail("sort: missing file (stdin not supported)".into());
                return Some(finish(ctx));
            }
            for target in &rest {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("sort: {e}"));
                        continue;
                    }
                };
                let content = match ctx.read_file(&full) {
                    Ok(c) => c,
                    Err(e) => {
                        ctx.fail(e);
                        continue;
                    }
                };
                let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
                if numeric {
                    lines.sort_by(|a, b| {
                        let av = a.trim().parse::<f64>().unwrap_or(f64::NEG_INFINITY);
                        let bv = b.trim().parse::<f64>().unwrap_or(f64::NEG_INFINITY);
                        av.partial_cmp(&bv).unwrap_or(std::cmp::Ordering::Equal)
                    });
                } else {
                    lines.sort();
                }
                if flags.iter().any(|f| f == "u") {
                    lines.dedup();
                }
                if reverse {
                    lines.reverse();
                }
                for line in lines {
                    ctx.writeln(&line);
                }
            }
        }
        "uniq" => {
            if args.is_empty() {
                ctx.fail("uniq: missing file (stdin not supported)".into());
                return Some(finish(ctx));
            }
            let show_count = args.iter().any(|a| a == "-c");
            let files: Vec<&String> = args.iter().filter(|a| a.as_str() != "-c").collect();
            for target in files {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("uniq: {e}"));
                        continue;
                    }
                };
                let content = match ctx.read_file(&full) {
                    Ok(c) => c,
                    Err(e) => {
                        ctx.fail(e);
                        continue;
                    }
                };
                let mut prev: Option<String> = None;
                let mut count = 0usize;
                for line in content.lines() {
                    match &prev {
                        Some(p) if p == line => count += 1,
                        Some(p) => {
                            if show_count {
                                ctx.writeln(&format!("{:>7} {}", count, p));
                            } else {
                                ctx.writeln(p);
                            }
                            prev = Some(line.to_string());
                            count = 1;
                        }
                        None => {
                            prev = Some(line.to_string());
                            count = 1;
                        }
                    }
                }
                if let Some(p) = prev {
                    if show_count {
                        ctx.writeln(&format!("{:>7} {}", count, p));
                    } else {
                        ctx.writeln(&p);
                    }
                }
            }
        }
        "cut" => {
            let mut delim = "\t".to_string();
            let mut fields = String::new();
            let mut files = Vec::new();
            let mut i = 0;
            while i < args.len() {
                match args[i].as_str() {
                    "-d" => {
                        i += 1;
                        delim = args.get(i).cloned().unwrap_or_else(|| "\t".into());
                    }
                    "-f" => {
                        i += 1;
                        fields = args.get(i).cloned().unwrap_or_default();
                    }
                    other => files.push(other.to_string()),
                }
                i += 1;
            }
            if fields.is_empty() || files.is_empty() {
                ctx.fail("cut: usage: cut -d DELIM -f LIST FILE".into());
                return Some(finish(ctx));
            }
            let picks: Vec<usize> = fields
                .split(',')
                .filter_map(|f| f.trim().parse::<usize>().ok())
                .collect();
            for file in &files {
                let full = match ctx.resolve(file) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("cut: {e}"));
                        continue;
                    }
                };
                let content = match ctx.read_file(&full) {
                    Ok(c) => c,
                    Err(e) => {
                        ctx.fail(e);
                        continue;
                    }
                };
                for line in content.lines() {
                    let parts: Vec<&str> = line.split(delim.as_str()).collect();
                    let out: Vec<&str> = picks
                        .iter()
                        .filter_map(|f| parts.get(*f).or_else(|| parts.get((*f).max(1) - 1)))
                        .copied()
                        .collect();
                    ctx.writeln(&out.join(&delim));
                }
            }
        }
        "stat" => {
            for target in args {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("stat: {e}"));
                        continue;
                    }
                };
                match std::fs::metadata(&full) {
                    Ok(meta) => {
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let kind = if meta.is_dir() {
                            "directory".to_string()
                        } else {
                            format!("{} bytes", meta.len())
                        };
                        ctx.writeln(&format!("  File: {}", full.display()));
                        ctx.writeln(&format!("  Size: {}\tModified: {}", kind, fmt_time(mtime)));
                    }
                    Err(e) => ctx.fail(format!("stat: {}: {e}", target)),
                }
            }
        }
        "realpath" => {
            for target in args {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("realpath: {e}"));
                        continue;
                    }
                };
                match full.canonicalize() {
                    Ok(p) => ctx.writeln(&p.to_string_lossy()),
                    Err(e) => ctx.fail(format!("realpath: {}: {e}", target)),
                }
            }
        }
        "readlink" => {
            for target in args {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("readlink: {e}"));
                        continue;
                    }
                };
                match std::fs::symlink_metadata(&full) {
                    Ok(meta) if meta.is_symlink() => {
                        ctx.fail("readlink: cannot read link target on this platform".into());
                    }
                    Ok(_) => ctx.fail(format!("readlink: {}: not a symlink", target)),
                    Err(e) => ctx.fail(format!("readlink: {}: {e}", target)),
                }
            }
        }
        "which" => {
            let paths = std::env::var("PATH").unwrap_or_default();
            for target in args {
                let mut found = false;
                for dir in paths.split(';').chain(paths.split(':')) {
                    let dir = dir.trim();
                    if dir.is_empty() {
                        continue;
                    }
                    let candidate = Path::new(dir).join(target);
                    if candidate.is_file() {
                        ctx.writeln(&candidate.to_string_lossy());
                        found = true;
                        break;
                    }
                    let with_ext = Path::new(dir).join(format!("{}.exe", target));
                    if with_ext.is_file() {
                        ctx.writeln(&with_ext.to_string_lossy());
                        found = true;
                        break;
                    }
                }
                if !found {
                    ctx.fail(format!("which: {}: command not found", target));
                }
            }
        }
        "env" => {
            let mut vars: Vec<(String, String)> = std::env::vars().collect();
            vars.sort();
            for (k, v) in vars {
                ctx.writeln(&format!("{}={}", k, v));
            }
        }
        "hostname" => {
            let host = std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| "localhost".into());
            ctx.writeln(&host);
        }
        "id" => {
            let user = std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .unwrap_or_else(|_| "user".into());
            ctx.writeln(&format!("uid=1000({})", user));
        }
        "printf" => {
            if args.is_empty() {
                ctx.fail("printf: missing format".into());
                return Some(finish(ctx));
            }
            let format = &args[0];
            let mut out = String::new();
            let mut arg_i = 1usize;
            let mut chars = format.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('n') => out.push('\n'),
                        Some('t') => out.push('\t'),
                        Some(other) => {
                            out.push('\\');
                            out.push(other);
                        }
                        None => out.push('\\'),
                    }
                } else if c == '%' {
                    match chars.next() {
                        Some('s') | Some('d') => {
                            if arg_i < args.len() {
                                out.push_str(&args[arg_i]);
                                arg_i += 1;
                            }
                        }
                        Some('%') => out.push('%'),
                        Some(other) => {
                            out.push('%');
                            out.push(other);
                        }
                        None => out.push('%'),
                    }
                } else {
                    out.push(c);
                }
            }
            ctx.write(&out);
        }
        "diff" => loop {
            if args.len() < 2 {
                ctx.fail("diff: usage: diff FILE1 FILE2".into());
                return Some(finish(ctx));
            }
            let a_full = match ctx.resolve(&args[0]) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("diff: {e}"));
                    return Some(finish(ctx));
                }
            };
            let b_full = match ctx.resolve(&args[1]) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("diff: {e}"));
                    return Some(finish(ctx));
                }
            };
            let a_text = match ctx.read_file(&a_full) {
                Ok(t) => t,
                Err(e) => {
                    ctx.fail(e);
                    return Some(finish(ctx));
                }
            };
            let b_text = match ctx.read_file(&b_full) {
                Ok(t) => t,
                Err(e) => {
                    ctx.fail(e);
                    return Some(finish(ctx));
                }
            };
            if a_text == b_text {
                break;
            }
            let a: Vec<&str> = a_text.lines().collect();
            let b: Vec<&str> = b_text.lines().collect();
            ctx.writeln(&format!("--- {}", args[0]));
            ctx.writeln(&format!("+++ {}", args[1]));
            if a.len() * b.len() > 1_000_000 {
                ctx.writeln("files too large for built-in diff");
                break;
            }
            let n = a.len();
            let m = b.len();
            let mut dp = vec![vec![0usize; m + 1]; n + 1];
            for i in (0..n).rev() {
                for j in (0..m).rev() {
                    dp[i][j] = if a[i] == b[j] {
                        dp[i + 1][j + 1] + 1
                    } else {
                        dp[i + 1][j].max(dp[i][j + 1])
                    };
                }
            }
            let mut i = 0usize;
            let mut j = 0usize;
            while i < n && j < m {
                if a[i] == b[j] {
                    i += 1;
                    j += 1;
                } else if dp[i + 1][j] >= dp[i][j + 1] {
                    ctx.writeln(&format!("< {}", a[i]));
                    i += 1;
                } else {
                    ctx.writeln(&format!("> {}", b[j]));
                    j += 1;
                }
            }
            while i < n {
                ctx.writeln(&format!("< {}", a[i]));
                i += 1;
            }
            while j < m {
                ctx.writeln(&format!("> {}", b[j]));
                j += 1;
            }
            break;
        }
        "cmp" => {
            if args.len() < 2 {
                ctx.fail("cmp: usage: cmp FILE1 FILE2".into());
                return Some(finish(ctx));
            }
            let a_full = match ctx.resolve(&args[0]) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("cmp: {e}"));
                    return Some(finish(ctx));
                }
            };
            let b_full = match ctx.resolve(&args[1]) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("cmp: {e}"));
                    return Some(finish(ctx));
                }
            };
            let a = std::fs::read(&a_full).map_err(|e| format!("cmp: {e}"));
            let b = std::fs::read(&b_full).map_err(|e| format!("cmp: {e}"));
            match (a, b) {
                (Ok(a), Ok(b)) => {
                    if a == b {
                        // identical — no output
                    } else {
                        let pos = a
                            .iter()
                            .zip(b.iter())
                            .position(|(x, y)| x != y)
                            .unwrap_or_else(|| a.len().min(b.len()));
                        let line = a[..=pos.min(a.len() - 1)]
                            .iter()
                            .filter(|&&c| c == b'\n')
                            .count()
                            + 1;
                        ctx.writeln(&format!(
                            "{} {} differ: byte {}, line {}",
                            args[0],
                            args[1],
                            pos + 1,
                            line
                        ));
                        ctx.code = 1;
                    }
                }
                (_, Err(e)) => ctx.fail(e),
                (Err(e), _) => ctx.fail(e),
            }
        }
        "ln" => {
            let (flags, rest) = split_args(args);
            let symbolic = flags.iter().any(|f| f == "s");
            if rest.len() < 2 {
                ctx.fail("ln: usage: ln [-s] TARGET LINK".into());
                return Some(finish(ctx));
            }
            let src_full = match ctx.resolve(&rest[0]) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("ln: {e}"));
                    return Some(finish(ctx));
                }
            };
            let dst_full = match ctx.resolve(&rest[1]) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("ln: {e}"));
                    return Some(finish(ctx));
                }
            };
            let result = if symbolic {
                #[cfg(target_os = "windows")]
                {
                    Err("ln: symbolic links are not supported on this platform".to_string())
                }
                #[cfg(not(target_os = "windows"))]
                {
                    std::os::unix::fs::symlink(&src_full, &dst_full)
                        .map_err(|e| format!("ln: {e}"))
                }
            } else {
                std::fs::hard_link(&src_full, &dst_full).map_err(|e| format!("ln: {e}"))
            };
            if let Err(e) = result {
                ctx.fail(e);
            }
        }
        "chmod" => {
            let (flags, rest) = split_args(args);
            let remove_write = flags.iter().any(|f| f == "r");
            for target in &rest {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("chmod: {e}"));
                        continue;
                    }
                };
                match std::fs::metadata(&full).map(|m| m.permissions()) {
                    Ok(mut perms) => {
                        perms.set_readonly(remove_write);
                        if let Err(e) = std::fs::set_permissions(&full, perms) {
                            ctx.fail(format!("chmod: {}: {e}", target));
                        }
                    }
                    Err(e) => ctx.fail(format!("chmod: {}: {e}", target)),
                }
            }
        }
        "test" | "[" => {
            let ops: Vec<String> = if name == "[" {
                args.iter()
                    .take_while(|a| a.as_str() != "]")
                    .cloned()
                    .collect()
            } else {
                args.to_vec()
            };
            let ok = match ops.as_slice() {
                [flag, target] if flag == "-e" => {
                    ctx.resolve(target).map(|p| p.exists()).unwrap_or(false)
                }
                [flag, target] if flag == "-f" => {
                    ctx.resolve(target).map(|p| p.is_file()).unwrap_or(false)
                }
                [flag, target] if flag == "-d" => {
                    ctx.resolve(target).map(|p| p.is_dir()).unwrap_or(false)
                }
                [flag, target] if flag == "-z" => target.is_empty(),
                [flag, target] if flag == "-n" => !target.is_empty(),
                [a, op, b] if op == "=" => a == b,
                [a, op, b] if op == "!=" => a != b,
                _ => {
                    ctx.fail("test: unsupported expression".into());
                    return Some(finish(ctx));
                }
            };
            if !ok {
                ctx.code = 1;
            }
        }
        _ => return None,
    }
    Some(finish(ctx))
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

fn fmt_time(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (hh, mm) = (rem / 3600, (rem % 3600) / 60);
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
    format!(
        "{} {:02} {:02}:{:02}",
        MONTHS[(m - 1) as usize],
        d,
        hh,
        mm
    )
}
