//! BusyBox-compatible applets, third batch: md5sum, sha1sum, sha256sum, expr,
//! tar (create/list/extract), tac, rev, nl. Pure Rust — no external crates.

use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 8_000_000;

pub struct Result3 {
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
                return Err("path outside repository".into());
            }
            return Ok(resolved);
        }
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

    fn read_bytes(&self, path: &Path) -> Result<Vec<u8>, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        if meta.is_dir() {
            return Err(format!("{}: is a directory", path.display()));
        }
        if meta.len() > MAX_FILE {
            return Err(format!("{}: file too large", path.display()));
        }
        std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))
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

fn finish(mut ctx: Ctx) -> Result3 {
    Result3 {
        stdout: std::mem::take(&mut ctx.out),
        stderr: std::mem::take(&mut ctx.errs),
        code: ctx.code,
    }
}

// ----------------------------- hashes -----------------------------

const MD5_S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: [u32; 64] = [
    0xd76a_a478, 0xe8c7_b756, 0x2420_70db, 0xc1bd_ceee, 0xf57c_0faf, 0x4787_c62a, 0xa830_4613,
    0xfd46_9501, 0x6980_98d8, 0x8b44_f7af, 0xffff_5bb1, 0x895c_d7be, 0x6b90_1122, 0xfd98_7193,
    0xa679_438e, 0x49b4_0821, 0xf61e_2562, 0xc040_b340, 0x265e_5a51, 0xe9b6_c7aa, 0xd62f_105d,
    0x0244_1453, 0xd8a1_e681, 0xe7d3_fbc8, 0x21e1_cde6, 0xc337_07d6, 0xf4d5_0d87, 0x455a_14ed,
    0xa9e3_e905, 0xfcef_a3f8, 0x676f_02d9, 0x8d2a_4c8a, 0xfffa_3942, 0x8771_f681, 0x6d9d_6122,
    0xfde5_380c, 0xa4be_ea44, 0x4bde_cfa9, 0xf6bb_4b60, 0xbebf_bc70, 0x289b_7ec6, 0xeaa1_27fa,
    0xd4ef_3085, 0x0488_1d05, 0xd9d4_d039, 0xe6db_99e5, 0x1fa2_7cf8, 0xc4ac_5665, 0xf429_2244,
    0x432a_ff97, 0xab94_23a7, 0xfc93_a039, 0x655b_59c3, 0x8f0c_cc92, 0xffef_f47d, 0x8584_5dd1,
    0x6fa8_7e4f, 0xfe2c_e6e0, 0xa301_4314, 0x4e08_11a1, 0xf753_7e82, 0xbd3a_f235, 0x2ad7_d2bb,
    0xeb86_d391,
];

fn md5_hex(data: &[u8]) -> String {
    let mut msg = data.to_vec();
    let bitlen = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_le_bytes());

    let mut s: [u32; 4] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    for chunk in msg.chunks(64) {
        let mut m = [0u32; 16];
        for (i, w) in m.iter_mut().enumerate() {
            *w = u32::from_le_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        let (mut a, mut b, mut c, mut d) = (s[0], s[1], s[2], s[3]);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            let x = a
                .wrapping_add(f)
                .wrapping_add(MD5_K[i])
                .wrapping_add(m[g]);
            b = b.wrapping_add(x.rotate_left(MD5_S[i]));
            a = tmp;
        }
        s[0] = s[0].wrapping_add(a);
        s[1] = s[1].wrapping_add(b);
        s[2] = s[2].wrapping_add(c);
        s[3] = s[3].wrapping_add(d);
    }
    let mut out = String::new();
    for word in s {
        for byte in word.to_le_bytes() {
            out.push_str(&format!("{:02x}", byte));
        }
    }
    out
}

fn sha1_hex(data: &[u8]) -> String {
    let mut msg = data.to_vec();
    let bitlen = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_be_bytes());

    let mut h: [u32; 5] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476, 0xc3d2_e1f0];
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i / 20 {
                0 => ((b & c) | (!b & d), 0x5a82_7999),
                1 => (b ^ c ^ d, 0x6ed9_eba1),
                2 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                _ => (b ^ c ^ d, 0xca62_c1d6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = String::new();
    for word in h {
        out.push_str(&format!("{:08x}", word));
    }
    out
}

const SHA256_K: [u32; 64] = [
    0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4,
    0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe,
    0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f,
    0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da, 0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7,
    0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc,
    0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c3e0, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
    0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070, 0x19a4_c116,
    0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
    0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7,
    0xc671_78f2,
];

fn sha256_hex(data: &[u8]) -> String {
    let mut msg = data.to_vec();
    let bitlen = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_be_bytes());

    let mut h: [u32; 8] = [
        0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
        0x5be0_cd19,
    ];
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v[7] = v[6];
            v[6] = v[5];
            v[5] = v[4];
            v[4] = v[3].wrapping_add(t1);
            v[3] = v[2];
            v[2] = v[1];
            v[1] = v[0];
            v[0] = v[0].wrapping_add(t2);
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    let mut out = String::new();
    for word in h {
        out.push_str(&format!("{:08x}", word));
    }
    out
}

// ----------------------------- expr -----------------------------

#[derive(Debug, Clone)]
enum Tok {
    Num(i64),
    Op(String),
}

fn tokenize_expr(s: &str) -> Vec<Tok> {
    let mut tokens = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        if c.is_ascii_digit() {
            let mut num = c.to_string();
            while let Some(&n) = chars.peek() {
                if n.is_ascii_digit() {
                    num.push(n);
                    chars.next();
                } else {
                    break;
                }
            }
            tokens.push(Tok::Num(num.parse().unwrap_or(0)));
        } else if "+-*/%()<>=!&|".contains(c) {
            let mut op = c.to_string();
            if (c == '=' || c == '!' || c == '<' || c == '>' || c == '&' || c == '|')
                && chars.peek() == Some(&c)
            {
                chars.next();
                op.push(c);
            }
            tokens.push(Tok::Op(op));
        }
    }
    tokens
}

struct ExprParser<'a> {
    tokens: &'a [Tok],
    pos: usize,
}

impl ExprParser<'_> {
    fn peek_op(&self) -> Option<&str> {
        self.tokens.get(self.pos).map(|t| match t {
            Tok::Op(o) => o.as_str(),
            Tok::Num(_) => "",
        })
    }

    fn eval(&mut self) -> Result<i64, String> {
        self.cmp_level()
    }

    fn cmp_level(&mut self) -> Result<i64, String> {
        let mut left = self.add_level()?;
        while let Some(op) = self.peek_op() {
            let kind = op.to_string();
            if matches!(kind.as_str(), "=" | "!=" | "<" | "<=" | ">" | ">=") {
                self.pos += 1;
                let right = self.add_level()?;
                left = i64::from(match kind.as_str() {
                    "=" => left == right,
                    "!=" => left != right,
                    "<" => left < right,
                    "<=" => left <= right,
                    ">" => left > right,
                    _ => left >= right,
                });
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn add_level(&mut self) -> Result<i64, String> {
        let mut left = self.mul_level()?;
        loop {
            let op = match self.peek_op() {
                Some("+") => "+".to_string(),
                Some("-") => "-".to_string(),
                _ => break,
            };
            self.pos += 1;
            let right = self.mul_level()?;
            left = match op.as_str() {
                "+" => left.wrapping_add(right),
                _ => left.wrapping_sub(right),
            };
        }
        Ok(left)
    }

    fn mul_level(&mut self) -> Result<i64, String> {
        let mut left = self.unary()?;
        loop {
            let op = match self.peek_op() {
                Some("*") => "*".to_string(),
                Some("/") => "/".to_string(),
                Some("%") => "%".to_string(),
                _ => break,
            };
            self.pos += 1;
            let right = self.unary()?;
            if right == 0 {
                return Err("division by zero".into());
            }
            left = match op.as_str() {
                "*" => left.wrapping_mul(right),
                "/" => left / right,
                _ => left % right,
            };
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<i64, String> {
        if let Some(Tok::Op(op)) = self.tokens.get(self.pos) {
            if op == "-" {
                self.pos += 1;
                return Ok(-self.unary()?);
            }
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<i64, String> {
        match self.tokens.get(self.pos) {
            Some(Tok::Num(n)) => {
                let v = *n;
                self.pos += 1;
                Ok(v)
            }
            Some(Tok::Op(o)) if o == "(" => {
                self.pos += 1;
                let v = self.eval()?;
                if let Some(Tok::Op(o)) = self.tokens.get(self.pos) {
                    if o == ")" {
                        self.pos += 1;
                    }
                }
                Ok(v)
            }
            _ => Err("syntax error".into()),
        }
    }
}

// ----------------------------- tar -----------------------------

fn octal_field(value: u64, buf: &mut [u8]) {
    let text = format!("{:0width$o}\0", value, width = buf.len() - 1);
    buf.copy_from_slice(text.as_bytes());
}

fn tar_header(name: &str, size: u64, mtime: u64, is_dir: bool) -> [u8; 512] {
    let mut header = [0u8; 512];
    let truncated_name: String = name.chars().take(99).collect();
    header[..truncated_name.len()].copy_from_slice(truncated_name.as_bytes());
    octal_field(0o644, &mut header[100..108]);
    octal_field(0, &mut header[108..116]);
    octal_field(0, &mut header[116..124]);
    octal_field(size, &mut header[124..136]);
    octal_field(mtime, &mut header[136..148]);
    header[148..156].copy_from_slice(b"        ");
    header[156] = if is_dir { b'5' } else { b'0' };
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u32 = header.iter().map(|b| *b as u32).sum();
    let chk = format!("{:06o}\0 ", checksum);
    header[148..156].copy_from_slice(chk.as_bytes());
    header
}

fn collect_tar_entries(path: &Path, prefix: &str, out: &mut Vec<(String, PathBuf, bool, u64)>) {
    if let Ok(meta) = std::fs::metadata(path) {
        let name = if prefix.is_empty() {
            path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        } else {
            format!("{}/{}", prefix, path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default())
        };
        let is_dir = meta.is_dir();
        out.push((format!("{}/", name), path.to_path_buf(), is_dir, 0));
        if is_dir {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    collect_tar_entries(&entry.path(), &name, out);
                }
            }
        } else {
            let size = meta.len();
            if let Some(last) = out.last_mut() {
                last.3 = size;
            }
        }
    }
}

// ----------------------------- dispatch -----------------------------

pub fn run(cwd: &Path, root: &Path, name: &str, args: &[String]) -> Option<Result3> {
    let mut ctx = Ctx {
        cwd,
        root,
        out: String::new(),
        errs: String::new(),
        code: 0,
    };
    match name {
        "md5sum" | "sha1sum" | "sha256sum" => {
            let digest = |data: &[u8]| -> String {
                match name {
                    "sha1sum" => sha1_hex(data),
                    "sha256sum" => sha256_hex(data),
                    _ => md5_hex(data),
                }
            };
            let files: Vec<&String> = args.iter().filter(|a| !a.contains('=')).collect();
            if files.is_empty() {
                ctx.fail(format!("{}: missing file", name));
                return Some(finish(ctx));
            }
            for target in files {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("{}: {e}", name));
                        continue;
                    }
                };
                match ctx.read_bytes(&full) {
                    Ok(data) => {
                        ctx.writeln(&format!("{}  {}", digest(&data), target));
                    }
                    Err(e) => ctx.fail(e),
                }
            }
        }
        "expr" => {
            if args.is_empty() {
                ctx.fail("expr: missing expression".into());
                return Some(finish(ctx));
            }
            let joined = args.join(" ");
            let tokens = tokenize_expr(&joined);
            let mut parser = ExprParser { tokens: &tokens, pos: 0 };
            match parser.eval() {
                Ok(v) => ctx.writeln(&v.to_string()),
                Err(e) => ctx.fail(format!("expr: {e}")),
            }
        }
        "tar" => {
            let mode = args.first().map(|a| a.as_str()).unwrap_or("");
            let archive = args.get(1).cloned();
            let targets: Vec<String> = args[2.min(args.len())..].to_vec();
            let archive = match archive {
                Some(a) => a,
                None => {
                    ctx.fail("tar: usage: tar -c|-t|-x -f ARCHIVE [PATH…]".into());
                    return Some(finish(ctx));
                }
            };
            if !mode.contains('f') {
                ctx.fail("tar: -f ARCHIVE is required".into());
                return Some(finish(ctx));
            }
            let archive_full = match ctx.resolve(&archive) {
                Ok(p) => p,
                Err(e) => {
                    ctx.fail(format!("tar: {e}"));
                    return Some(finish(ctx));
                }
            };
            if mode.contains('c') {
                // Create.
                let mut entries: Vec<(String, PathBuf, bool, u64)> = Vec::new();
                let sources = if targets.is_empty() { vec![".".to_string()] } else { targets };
                for source in &sources {
                    let full = match ctx.resolve(source) {
                        Ok(p) => p,
                        Err(e) => {
                            ctx.fail(format!("tar: {e}"));
                            return Some(finish(ctx));
                        }
                    };
                    collect_tar_entries(&full, "", &mut entries);
                }
                let mut blob: Vec<u8> = Vec::new();
                let mtime = 0u64; // header mtime omitted for determinism
                for (name, path, is_dir, size) in &entries {
                    let display = name.trim_start_matches("./").to_string();
                    let header = tar_header(&display, *size, mtime, *is_dir);
                    blob.extend_from_slice(&header);
                    if !is_dir {
                        match std::fs::read(path) {
                            Ok(data) => {
                                blob.extend_from_slice(&data);
                                let pad = (512 - (data.len() % 512)) % 512;
                                blob.extend(std::iter::repeat(0u8).take(pad));
                            }
                            Err(e) => {
                                ctx.fail(format!("tar: {}: {e}", display));
                            }
                        }
                    }
                }
                blob.extend_from_slice(&[0u8; 1024]);
                if let Err(e) = std::fs::write(&archive_full, &blob) {
                    ctx.fail(format!("tar: {}: {e}", archive));
                } else {
                    ctx.writeln(&format!("created {} ({} entries)", archive, entries.len()));
                }
            } else if mode.contains('t') {
                // List.
                let data = match std::fs::read(&archive_full) {
                    Ok(d) => d,
                    Err(e) => {
                        ctx.fail(format!("tar: {}: {e}", archive));
                        return Some(finish(ctx));
                    }
                };
                let mut offset = 0usize;
                while offset + 512 <= data.len() {
                    let header = &data[offset..offset + 512];
                    if header.iter().all(|b| *b == 0) {
                        break;
                    }
                    let name_bytes = &header[..100];
                    let name = String::from_utf8_lossy(name_bytes)
                        .trim_end_matches('\0')
                        .to_string();
                    if !name.is_empty() {
                        ctx.writeln(name.trim_end_matches('/'));
                    }
                    let size_str = String::from_utf8_lossy(&header[124..136]);
                    let size = usize::from_str_radix(size_str.trim_end_matches('\0').trim(), 8)
                        .unwrap_or(0);
                    offset += 512 + ((size + 511) / 512) * 512;
                }
            } else if mode.contains('x') {
                // Extract.
                let data = match std::fs::read(&archive_full) {
                    Ok(d) => d,
                    Err(e) => {
                        ctx.fail(format!("tar: {}: {e}", archive));
                        return Some(finish(ctx));
                    }
                };
                let mut offset = 0usize;
                let mut extracted = 0usize;
                while offset + 512 <= data.len() {
                    let header = &data[offset..offset + 512];
                    if header.iter().all(|b| *b == 0) {
                        break;
                    }
                    let raw_name = String::from_utf8_lossy(&header[..100])
                        .trim_end_matches('\0')
                        .to_string();
                    let clean = raw_name.trim_start_matches("./").trim_end_matches('/');
                    if clean.is_empty() || clean.contains("..") || clean.starts_with('/') {
                        offset += 512 + ((header_size(header) + 511) / 512) * 512;
                        continue;
                    }
                    let size = header_size(header);
                    let is_dir = header[156] == b'5';
                    let body_start = offset + 512;
                    let body_end = (body_start + size).min(data.len());
                    let target = match ctx.resolve(clean) {
                        Ok(p) => p,
                        Err(_) => {
                            offset += 512 + ((size + 511) / 512) * 512;
                            continue;
                        }
                    };
                    if is_dir {
                        let _ = std::fs::create_dir_all(&target);
                    } else {
                        if let Some(parent) = target.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if body_end > body_start {
                            let _ = std::fs::write(&target, &data[body_start..body_end]);
                        } else {
                            let _ = std::fs::write(&target, b"");
                        }
                    }
                    extracted += 1;
                    offset = body_start + ((size + 511) / 512) * 512;
                }
                ctx.writeln(&format!("extracted {} entries", extracted));
            } else {
                ctx.fail("tar: specify -c, -t or -x".into());
            }
        }
        "tac" => {
            for target in args {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("tac: {e}"));
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
                for line in content.lines().rev() {
                    ctx.writeln(line);
                }
            }
        }
        "rev" => {
            for target in args {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("rev: {e}"));
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
                    let reversed: String = line.chars().rev().collect();
                    ctx.writeln(&reversed);
                }
            }
        }
        "nl" => {
            for target in args {
                let full = match ctx.resolve(target) {
                    Ok(p) => p,
                    Err(e) => {
                        ctx.fail(format!("nl: {e}"));
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
                for (i, line) in content.lines().enumerate() {
                    ctx.writeln(&format!("{:>6}\t{}", i + 1, line));
                }
            }
        }
        _ => return None,
    }
    Some(finish(ctx))
}

fn header_size(header: &[u8]) -> usize {
    let size_str = String::from_utf8_lossy(&header[124..136]);
    usize::from_str_radix(size_str.trim_end_matches('\0').trim(), 8).unwrap_or(0)
}

