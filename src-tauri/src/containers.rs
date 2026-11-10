//! Server containers — a tiny Docker-like process manager built on the OS
//! shell. Definitions live in the repo at `.pigry/containers.json`, logs in
//! `.pigry/containers/logs/`, and spawned children are tracked in-memory so
//! start/stop/status work without external tools.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ContainerDef {
    pub id: String,
    pub name: String,
    pub command: String,
    /// Working directory (defaults to the repository root).
    pub cwd: String,
    /// Extra environment variables, "KEY=value" per entry.
    #[serde(default)]
    pub env: Vec<String>,
    /// Where the definition came from: "manual" or "compose".
    #[serde(default)]
    pub source: String,
    /// Image name (compose imports — display only, runs locally).
    #[serde(default)]
    pub image: String,
    /// Target OS for this container (e.g. windows / linux).
    #[serde(default)]
    pub os: String,
    /// Hostname exposed to the container process (HOSTNAME env).
    #[serde(default)]
    pub hostname: String,
    /// Password (stored locally, never returned to the UI list).
    #[serde(default)]
    pub password: String,
    /// PID while running (persisted so status survives app restarts).
    pub pid: Option<u32>,
    /// Declared ports (display only).
    #[serde(default)]
    pub ports: Vec<String>,
    pub created_at: u64,
}

impl Default for ContainerDef {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            command: String::new(),
            cwd: String::new(),
            env: Vec::new(),
            source: "manual".to_string(),
            image: String::new(),
            os: String::new(),
            hostname: String::new(),
            password: String::new(),
            pid: None,
            ports: Vec::new(),
            created_at: 0,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cwd: String,
    pub env: Vec<String>,
    pub source: String,
    pub image: String,
    pub os: String,
    pub hostname: String,
    pub ports: Vec<String>,
    pub pid: Option<u32>,
    /// running / exited / stopped
    pub state: String,
    pub created_at: u64,
}

struct ChildEntry {
    child: std::process::Child,
}

fn children() -> &'static Mutex<HashMap<String, ChildEntry>> {
    static CHILDREN: OnceLock<Mutex<HashMap<String, ChildEntry>>> = OnceLock::new();
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn containers_dir(repo: &Path) -> PathBuf {
    repo.join(".pigry").join("containers")
}

#[derive(Deserialize)]
struct ComposeFileRaw {
    #[serde(default)]
    services: Option<BTreeMap<String, ComposeServiceRaw>>,
}

#[derive(Deserialize, Default)]
struct ComposeServiceRaw {
    #[serde(default)]
    command: serde_yaml::Value,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    environment: serde_yaml::Value,
    #[serde(default)]
    ports: serde_yaml::Value,
    #[serde(default)]
    build: serde_yaml::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComposeServiceInfo {
    pub name: String,
    /// The service's own command (string form) — empty when image/build-only.
    pub command: String,
    pub image: String,
    pub working_dir: String,
    pub env: Vec<String>,
    pub ports: Vec<String>,
    /// True when the service has a runnable local command.
    pub local_runnable: bool,
}

/// Locates a compose file in the repo root (naming variants in priority order).
fn find_compose_file(repo: &Path) -> Option<PathBuf> {
    for name in [
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yaml",
        "compose.yml",
    ] {
        let path = repo.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn yaml_command_string(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::String(text) => text.clone(),
        serde_yaml::Value::Sequence(items) => items
            .iter()
            .filter_map(|item| match item {
                serde_yaml::Value::String(text) => Some(text.clone()),
                serde_yaml::Value::Number(number) => Some(number.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn yaml_scalar_string(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::String(text) => text.clone(),
        serde_yaml::Value::Number(number) => number.to_string(),
        serde_yaml::Value::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

fn yaml_env_list(value: &serde_yaml::Value) -> Vec<String> {
    match value {
        serde_yaml::Value::Mapping(map) => map
            .iter()
            .map(|(key, val)| format!("{}={}", yaml_scalar_string(key), yaml_scalar_string(val)))
            .collect(),
        serde_yaml::Value::Sequence(items) => items
            .iter()
            .filter_map(|item| {
                let text = yaml_scalar_string(item);
                if text.contains('=') {
                    Some(text)
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn yaml_ports_list(value: &serde_yaml::Value) -> Vec<String> {
    match value {
        serde_yaml::Value::Sequence(items) => items
            .iter()
            .map(|item| match item {
                serde_yaml::Value::String(text) => text.clone(),
                serde_yaml::Value::Mapping(map) => {
                    let mut target = String::new();
                    let mut published = String::new();
                    for (key, val) in map {
                        let key_text = yaml_scalar_string(key);
                        let val_text = yaml_scalar_string(val);
                        if key_text == "target" {
                            target = val_text;
                        } else if key_text == "published" {
                            published = val_text;
                        }
                    }
                    if !target.is_empty() && !published.is_empty() {
                        format!("{published}:{target}")
                    } else if !target.is_empty() {
                        target
                    } else {
                        String::new()
                    }
                }
                _ => String::new(),
            })
            .filter(|text| !text.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Reads `docker-compose.yml` / `compose.yaml` and lists its services so they
/// can be imported as managed containers.
#[tauri::command]
pub async fn compose_services(repo_path: String) -> Result<Vec<ComposeServiceInfo>, String> {
    let repo = Path::new(&repo_path);
    let Some(path) = find_compose_file(repo) else {
        return Ok(Vec::new());
    };
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: ComposeFileRaw = serde_yaml::from_str(&raw).map_err(|e| format!("compose parse: {e}"))?;
    let mut out = Vec::new();
    if let Some(services) = file.services {
        for (name, def) in services {
            let command = yaml_command_string(&def.command);
            out.push(ComposeServiceInfo {
                name,
                local_runnable: !command.is_empty(),
                command,
                image: def.image.clone().unwrap_or_default(),
                working_dir: def.working_dir.clone().unwrap_or_default(),
                env: yaml_env_list(&def.environment),
                ports: yaml_ports_list(&def.ports),
            });
        }
    }
    Ok(out)
}

/// Registers a compose service as a managed container (local process).
#[tauri::command]
pub async fn compose_service_run(
    repo_path: String,
    name: String,
    command: String,
    working_dir: String,
    env: Option<Vec<String>>,
    ports: Option<Vec<String>>,
    image: Option<String>,
) -> Result<ContainerInfo, String> {
    if command.trim().is_empty() {
        return Err(format!(
            "service '{name}' has no runnable command (image/build only)"
        ));
    }
    let repo = Path::new(&repo_path);
    let mut defs = read_defs(repo);
    let id = format!("ctr-{}", name.trim());
    // Replace an existing definition with the same id (re-import refreshes it).
    defs.retain(|d| d.id != id);
    defs.push(ContainerDef {
        id: id.clone(),
        name: name.trim().to_string(),
        command: command.trim().to_string(),
        cwd: if working_dir.trim().is_empty() {
            repo_path.clone()
        } else {
            let joined = repo.join(working_dir.trim());
            joined
                .canonicalize()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| joined.to_string_lossy().to_string())
        },
        env: env.unwrap_or_default(),
        source: "compose".to_string(),
        image: image.unwrap_or_default(),
        os: String::new(),
        hostname: String::new(),
        password: String::new(),
        pid: None,
        ports: ports.unwrap_or_default(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    write_defs(repo, &defs)?;
    Ok(to_info(repo, defs.last().unwrap()))
}

/// Starts a compose service locally (register + spawn in one call).
#[tauri::command]
pub async fn compose_service_start(
    app: tauri::AppHandle,
    repo_path: String,
    name: String,
    command: String,
    working_dir: String,
    env: Option<Vec<String>>,
    ports: Option<Vec<String>>,
    image: Option<String>,
) -> Result<ContainerInfo, String> {
    compose_service_run(
        repo_path.clone(),
        name.clone(),
        command.clone(),
        working_dir,
        env,
        ports,
        image,
    )
    .await?;
    container_start_inner(&app, &repo_path, &format!("ctr-{}", name.trim()))?;
    let defs = read_defs(Path::new(&repo_path));
    let Some(def) = defs.iter().find(|d| d.id == format!("ctr-{}", name.trim())) else {
        return Err("container missing after start".to_string());
    };
    Ok(to_info(Path::new(&repo_path), def))
}

fn container_start_inner(app: &tauri::AppHandle, repo_path: &str, id: &str) -> Result<(), String> {
    let repo = Path::new(repo_path);
    let mut defs = read_defs(repo);
    let Some(def) = defs.iter_mut().find(|d| d.id == id) else {
        return Err(format!("container '{id}' not found"));
    };
    let dir = containers_dir(repo);
    std::fs::create_dir_all(dir.join("logs")).map_err(|e| e.to_string())?;
    let log_path = dir.join("logs").join(format!("{id}.log"));
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("cannot open log: {e}"))?;
    let cwd = if def.cwd.trim().is_empty() {
        repo_path.to_string()
    } else {
        def.cwd.clone()
    };
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", &def.command])
        .current_dir(&cwd)
        .stdout(OpenOptions::new().append(true).open(&log_path).map_err(|e| e.to_string())?)
        .stderr(log_file.try_clone().map_err(|e| e.to_string())?);
    for entry in &def.env {
        if let Some((key, value)) = entry.split_once('=') {
            cmd.env(key.trim(), value.trim());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    def.pid = Some(child.id());
    children().lock().unwrap().insert(id.to_string(), ChildEntry { child });
    write_defs(repo, &defs)?;
    let _ = app;
    Ok(())
}

fn store_path(repo: &Path) -> PathBuf {
    containers_dir(repo).join("containers.json")
}

fn read_defs(repo: &Path) -> Vec<ContainerDef> {
    let path = store_path(repo);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_defs(repo: &Path, defs: &[ContainerDef]) -> Result<(), String> {
    let path = store_path(repo);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(defs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .creation_flags(0x0800_0000)
            .output();
        match output {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                text.contains(&format!("\"{pid}\""))
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

fn state_of(repo: &Path, def: &ContainerDef) -> String {
    {
        let mut children = children().lock().unwrap();
        if let Some(entry) = children.get_mut(&def.id) {
            return match entry.child.try_wait() {
                Ok(None) => "running".to_string(),
                _ => "exited".to_string(),
            };
        }
    }
    match def.pid {
        Some(pid) if pid_alive(pid) => "running".to_string(),
        Some(_) => "exited".to_string(),
        None => "stopped".to_string(),
    }
}

fn to_info(repo: &Path, def: &ContainerDef) -> ContainerInfo {
    ContainerInfo {
        id: def.id.clone(),
        name: def.name.clone(),
        command: def.command.clone(),
        cwd: def.cwd.clone(),
        env: def.env.clone(),
        source: def.source.clone(),
        image: def.image.clone(),
        os: def.os.clone(),
        hostname: def.hostname.clone(),
        ports: def.ports.clone(),
        pid: def.pid,
        state: state_of(repo, def),
        created_at: def.created_at,
    }
}

/// Lists every container definition with live state.
#[tauri::command]
pub async fn container_list(repo_path: String) -> Result<Vec<ContainerInfo>, String> {
    let repo = Path::new(&repo_path);
    Ok(read_defs(repo)
        .iter()
        .map(|def| to_info(repo, def))
        .collect())
}

/// Creates a container definition (not started yet).
#[tauri::command]
pub async fn container_create(
    repo_path: String,
    name: String,
    command: String,
    cwd: String,
    env: Option<Vec<String>>,
    image: Option<String>,
    source: Option<String>,
    os: Option<String>,
    hostname: Option<String>,
    password: Option<String>,
) -> Result<ContainerInfo, String> {
    if name.trim().is_empty() || command.trim().is_empty() {
        return Err("name and command are required".to_string());
    }
    let repo = Path::new(&repo_path);
    let mut defs = read_defs(repo);
    let def = ContainerDef {
        id: format!("ctr-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)),
        name: name.trim().to_string(),
        command: command.trim().to_string(),
        cwd: if cwd.trim().is_empty() { repo_path.clone() } else { cwd.trim().to_string() },
        env: env.unwrap_or_default(),
        source: source.unwrap_or_else(|| "manual".to_string()),
        image: image.unwrap_or_default(),
        os: os.unwrap_or_default(),
        hostname: hostname.unwrap_or_default(),
        password: password.unwrap_or_default(),
        pid: None,
        ports: Vec::new(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let info = to_info(repo, &def);
    defs.push(def);
    write_defs(repo, &defs)?;
    Ok(info)
}

/// Starts a container: spawns the command via the shell, output → log file.
#[tauri::command]
pub async fn container_start(repo_path: String, id: String) -> Result<ContainerInfo, String> {
    let repo = Path::new(&repo_path);
    let mut defs = read_defs(repo);

    let existing = defs.iter().find(|d| d.id == id).map(|d| to_info(repo, d));
    let Some(info) = existing else {
        return Err(format!("container '{id}' not found"));
    };
    if info.state == "running" {
        return Ok(info);
    }

    let dir = containers_dir(repo);
    std::fs::create_dir_all(dir.join("logs")).map_err(|e| e.to_string())?;
    let log_path = dir.join("logs").join(format!("{id}.log"));
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("cannot open log: {e}"))?;

    let spawned = {
        let Some(def) = defs.iter_mut().find(|d| d.id == id) else {
            return Err(format!("container '{id}' not found"));
        };
        let cwd = if def.cwd.trim().is_empty() {
            repo_path.clone()
        } else {
            def.cwd.clone()
        };

        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", &def.command])
            .current_dir(&cwd)
            .stdout(OpenOptions::new().append(true).open(&log_path).map_err(|e| e.to_string())?)
            .stderr(log_file.try_clone().map_err(|e| e.to_string())?);
        for entry in &def.env {
            if let Some((key, value)) = entry.split_once('=') {
                cmd.env(key.trim(), value.trim());
            }
        }
        if !def.hostname.is_empty() {
            cmd.env("HOSTNAME", &def.hostname);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
        let pid = child.id();
        def.pid = Some(pid);
        children().lock().unwrap().insert(
            id.clone(),
            ChildEntry { child },
        );
        pid
    };
    write_defs(repo, &defs)?;

    let Some(def) = defs.iter().find(|d| d.id == id) else {
        return Err(format!("container '{id}' not found"));
    };
    Ok(ContainerInfo {
        id: def.id.clone(),
        name: def.name.clone(),
        command: def.command.clone(),
        cwd: def.cwd.clone(),
        env: def.env.clone(),
        source: def.source.clone(),
        image: def.image.clone(),
        ports: def.ports.clone(),
        os: def.os.clone(),
        hostname: def.hostname.clone(),
        pid: Some(spawned),
        state: "running".to_string(),
        created_at: def.created_at,
    })
}

/// Stops a container (kills the process tree).
#[tauri::command]
pub async fn container_stop(repo_path: String, id: String) -> Result<ContainerInfo, String> {
    let repo = Path::new(&repo_path);
    let mut defs = read_defs(repo);

    let stopped = {
        let Some(def) = defs.iter_mut().find(|d| d.id == id) else {
            return Err(format!("container '{id}' not found"));
        };

        // This session's child — direct kill, then reap.
        if let Some(entry) = children().lock().unwrap().remove(&id) {
            let mut child = entry.child;
            let _ = child.kill();
            let _ = child.wait();
        } else if let Some(pid) = def.pid {
            // Started in a previous app session — kill by PID (tree).
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000)
                    .output();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
            }
        }
        def.pid = None;
        ContainerInfo {
            id: def.id.clone(),
            name: def.name.clone(),
            command: def.command.clone(),
            cwd: def.cwd.clone(),
            env: def.env.clone(),
            source: def.source.clone(),
            image: def.image.clone(),
            os: def.os.clone(),
            hostname: def.hostname.clone(),
            ports: def.ports.clone(),
            pid: None,
            state: "stopped".to_string(),
            created_at: def.created_at,
        }
    };
    write_defs(repo, &defs)?;
    Ok(stopped)
}

/// Removes a container definition (stops it first if running).
#[tauri::command]
pub async fn container_remove(repo_path: String, id: String) -> Result<(), String> {
    let repo = Path::new(&repo_path);
    let _ = container_stop_blocking(repo, &id);
    let defs: Vec<ContainerDef> = read_defs(repo).into_iter().filter(|d| d.id != id).collect();
    write_defs(repo, &defs)?;
    let _ = std::fs::remove_file(containers_dir(repo).join("logs").join(format!("{id}.log")));
    Ok(())
}

fn container_stop_blocking(repo: &Path, id: &str) -> Result<(), String> {
    // Same behavior as container_stop without the async wrapper.
    let mut defs = read_defs(repo);
    if let Some(def) = defs.iter_mut().find(|d| d.id == id) {
        if let Some(entry) = children().lock().unwrap().remove(id) {
            let mut child = entry.child;
            let _ = child.kill();
            let _ = child.wait();
        } else if let Some(pid) = def.pid {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000)
                    .output();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("kill").arg(pid.to_string()).output();
            }
            def.pid = None;
        }
        write_defs(repo, &defs)?;
    }
    Ok(())
}

/// Returns the tail of a container's log file.
#[tauri::command]
pub async fn container_logs(repo_path: String, id: String) -> Result<String, String> {
    let repo = Path::new(&repo_path);
    let path = containers_dir(repo).join("logs").join(format!("{id}.log"));
    if !path.exists() {
        return Ok(String::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Last ~8 KB keeps the panel light.
    let len = raw.len();
    if len > 8192 {
        let mut start = len - 8192;
        while start > 0 && !raw.is_char_boundary(start) {
            start -= 1;
        }
        return Ok(raw[start..].to_string());
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_compose_services() {
        let yaml = r#"
services:
  web:
    image: nginx:alpine
    command: nginx -g "daemon off;"
  db:
    image: postgres:16
"#;
        let file: ComposeFileRaw = serde_yaml::from_str(yaml).unwrap();
        let services = file.services.unwrap();
        assert_eq!(services.len(), 2);
        let web = services.get("web").unwrap();
        assert_eq!(yaml_command_string(&web.command), r#"nginx -g "daemon off;""#);
        assert_eq!(web.image.as_deref(), Some("nginx:alpine"));
        let db = services.get("db").unwrap();
        assert_eq!(db.image.as_deref(), Some("postgres:16"));
    }

    #[test]
    fn normalizes_sequence_command() {
        let yaml = "services:\n  api:\n    command: [\"node\", \"server.js\"]";
        let file: ComposeFileRaw = serde_yaml::from_str(yaml).unwrap();
        let services = file.services.unwrap();
        let api = services.get("api").unwrap();
        assert_eq!(yaml_command_string(&api.command), "node server.js");
    }
}
