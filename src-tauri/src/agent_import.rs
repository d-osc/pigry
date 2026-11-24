//! Reads what other coding agents keep in the user's home folder (instructions, skills, MCP servers, settings) so the app can offer to
//! import it. Only an allowlist of files is read — never credentials (`.credentials.json`, `auth.json`, `mcp_oauth_tokens.json`, keyrings).
//! Parsing and conversion happen in the frontend; this module only reads.

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ImportFile {
    /// Path relative to the home folder, with forward slashes.
    pub path: String,
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportRead {
    pub agent: String,
    /// The agent's main folder, for display (`~/.claude`).
    pub root: String,
    /// True when the agent's folder exists at all.
    pub found: bool,
    pub files: Vec<ImportFile>,
    /// Things that were seen but deliberately not read (too big, supporting files of a skill, slash commands…).
    pub skipped: Vec<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok().map(PathBuf::from)
}

struct Reader<'a> {
    home: &'a Path,
    files: Vec<ImportFile>,
    skipped: Vec<String>,
    total: usize,
}

impl Reader<'_> {
    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(self.home).unwrap_or(p).to_string_lossy().replace('\\', "/")
    }

    fn file(&mut self, rel: &str) {
        let path = self.home.join(rel);
        let Ok(meta) = std::fs::metadata(&path) else { return };
        if !meta.is_file() {
            return;
        }
        if meta.len() > MAX_FILE_BYTES || self.total + meta.len() as usize > MAX_TOTAL_BYTES {
            self.skipped.push(format!("{rel} is too large to import"));
            return;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { return };
        self.total += text.len();
        self.files.push(ImportFile { path: rel.to_string(), text });
    }

    /// Direct `*.md` children of a folder.
    fn markdown_in(&mut self, rel_dir: &str) {
        let Ok(entries) = std::fs::read_dir(self.home.join(rel_dir)) else { return };
        let mut names: Vec<String> = entries.flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.to_lowercase().ends_with(".md")).collect();
        names.sort();
        for name in names {
            self.file(&format!("{rel_dir}/{name}"));
        }
    }

    /// Skill folders: `<dir>/<name>/SKILL.md`. Other files in the folder are not imported (a skill becomes one markdown file).
    fn skills_in(&mut self, rel_dir: &str) {
        let Ok(entries) = std::fs::read_dir(self.home.join(rel_dir)) else { return };
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with('.') {
                continue; // .system and friends are the agent's own built-ins
            }
            let skill = dir.join("SKILL.md");
            if !skill.is_file() {
                continue;
            }
            let extra = std::fs::read_dir(&dir).map(|d| d.flatten().filter(|e| e.file_name() != "SKILL.md").count()).unwrap_or(0);
            if extra > 0 {
                self.skipped.push(format!("skill {name}: {extra} supporting file(s)/folder(s) next to SKILL.md are not imported"));
            }
            let rel = self.rel(&skill);
            self.file(&rel);
        }
    }

    fn names_in(&mut self, rel_dir: &str, what: &str) {
        let Ok(entries) = std::fs::read_dir(self.home.join(rel_dir)) else { return };
        let n = entries.flatten().count();
        if n > 0 {
            self.skipped.push(format!("{n} {what} in {rel_dir} are not imported"));
        }
    }
}

/// Reads the importable files of one agent from `home`. Agents: `claude-code`, `codex`, `antigravity`.
pub fn read_agent_files_from(home: &Path, agent: &str) -> Result<ImportRead, String> {
    let (root, root_rel): (&str, &str) = match agent {
        "claude-code" => ("~/.claude", ".claude"),
        "codex" => ("~/.codex", ".codex"),
        "antigravity" => ("~/.gemini", ".gemini"),
        other => return Err(format!("unknown agent: {other}")),
    };
    let mut r = Reader { home, files: Vec::new(), skipped: Vec::new(), total: 0 };
    match agent {
        "claude-code" => {
            r.file(".claude/CLAUDE.md");
            r.file(".claude/settings.json");
            r.file(".claude.json");
            r.skills_in(".claude/skills");
            r.names_in(".claude/commands", "slash command(s)");
        }
        "codex" => {
            r.file(".codex/AGENTS.md");
            r.file(".codex/config.toml");
            r.markdown_in(".codex/memories");
            r.skills_in(".codex/skills");
        }
        _ => {
            for f in [".gemini/AGENTS.md", ".gemini/GEMINI.md", ".gemini/config/AGENTS.md", ".gemini/config/GEMINI.md", ".gemini/config/mcp_config.json", ".gemini/antigravity-cli/settings.json"] {
                r.file(f);
            }
            r.markdown_in(".gemini/config/rules");
            for d in [".gemini/config/skills", ".gemini/antigravity-cli/skills", ".gemini/skills"] {
                r.skills_in(d);
            }
            r.names_in(".gemini/config/agents", "custom agent(s)");
        }
    }
    let found = home.join(root_rel).is_dir() || (agent == "claude-code" && home.join(".claude.json").is_file());
    Ok(ImportRead { agent: agent.to_string(), root: root.to_string(), found, files: r.files, skipped: r.skipped })
}

pub fn read_agent_files(agent: &str) -> Result<ImportRead, String> {
    let home = home_dir().ok_or_else(|| "cannot find the home folder".to_string())?;
    read_agent_files_from(&home, agent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pigry-import-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn write(home: &Path, rel: &str, text: &str) {
        let p = home.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn claude_files_are_read_and_credentials_are_not() {
        let home = scratch("claude");
        write(&home, ".claude/CLAUDE.md", "be nice");
        write(&home, ".claude/.credentials.json", "{\"token\":\"secret\"}");
        write(&home, ".claude/settings.json", "{}");
        write(&home, ".claude/skills/review/SKILL.md", "---\nname: review\n---\nbody");
        write(&home, ".claude/skills/review/helper.py", "print(1)");
        write(&home, ".claude/skills/.system/SKILL.md", "builtin");
        write(&home, ".claude/commands/deploy.md", "x");
        let r = read_agent_files_from(&home, "claude-code").unwrap();
        let paths: Vec<&str> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec![".claude/CLAUDE.md", ".claude/settings.json", ".claude/skills/review/SKILL.md"]);
        assert!(!r.files.iter().any(|f| f.text.contains("secret")), "credentials are never read");
        assert!(r.found);
        assert!(r.skipped.iter().any(|s| s.contains("supporting file")));
        assert!(r.skipped.iter().any(|s| s.contains("slash command")));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_and_antigravity_sources() {
        let home = scratch("others");
        write(&home, ".codex/AGENTS.md", "rules");
        write(&home, ".codex/config.toml", "[mcp_servers.x]\ncommand = \"node\"\n");
        write(&home, ".codex/auth.json", "{\"tokens\":\"secret\"}");
        write(&home, ".codex/memories/a.md", "memo");
        write(&home, ".gemini/GEMINI.md", "g");
        write(&home, ".gemini/config/mcp_config.json", "{\"mcpServers\":{}}");
        write(&home, ".gemini/config/rules/style.md", "---\ntrigger: always_on\n---\nuse tabs");
        write(&home, ".gemini/config/skills/lint/SKILL.md", "---\ndescription: d\n---\nb");
        let codex = read_agent_files_from(&home, "codex").unwrap();
        assert_eq!(codex.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec![".codex/AGENTS.md", ".codex/config.toml", ".codex/memories/a.md"]);
        assert!(!codex.files.iter().any(|f| f.text.contains("secret")));
        let agy = read_agent_files_from(&home, "antigravity").unwrap();
        let paths: Vec<&str> = agy.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&".gemini/GEMINI.md") && paths.contains(&".gemini/config/mcp_config.json") && paths.contains(&".gemini/config/rules/style.md") && paths.contains(&".gemini/config/skills/lint/SKILL.md"));
        assert!(read_agent_files_from(&home, "nope").is_err());
        let empty = scratch("empty");
        assert!(!read_agent_files_from(&empty, "codex").unwrap().found);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&empty);
    }
}
