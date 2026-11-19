//! A PIGRY Server process runs inside one authenticated OpenSSH session.
use std::io::{BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use portable_pty::CommandBuilder;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::remote_protocol::{MAX_FRAME, Reply, Request, SERVER_READY, read_frame};
use crate::ssh_relay::TOKEN_ENV;

const START_TIMEOUT: Duration = Duration::from_secs(120);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone)]
pub(crate) struct SshEndpoint {
    pub host: String,
    pub username: Option<String>,
    pub port: Option<u16>,
}

impl SshEndpoint {
    fn login_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(username) = &self.username {
            args.extend(["-l".into(), username.clone()]);
        }
        if let Some(port) = self.port {
            args.extend(["-p".into(), port.to_string()]);
        }
        args
    }

    pub(crate) fn command(&self, remote_command: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("ssh");
        cmd.args(self.login_args());
        if remote_command.is_some() {
            cmd.arg("-tt");
        }
        cmd.args(["--", &self.host]);
        if let Some(command) = remote_command {
            cmd.arg(command);
        }
        cmd.env("TERM", "xterm-256color");
        cmd
    }
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) struct PendingWorkspace {
    pub endpoint: SshEndpoint,
    remote_path: String,
    assets: PathBuf,
    token: String,
    listener: Mutex<Option<TcpListener>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshWorkspaceInfo {
    pub host: String,
    pub path: String,
    pub port: Option<u16>,
}

pub(crate) struct SshWorkspace {
    pub endpoint: SshEndpoint,
    pub remote_path: String,
    client: Mutex<Option<BufReader<TcpStream>>>,
}

impl PendingWorkspace {
    pub(crate) fn start(
        endpoint: SshEndpoint,
        remote_path: String,
        console_host: PathBuf,
        assets: PathBuf,
    ) -> Result<(Self, CommandBuilder), String> {
        if !remote_path.starts_with('/') || remote_path.chars().any(char::is_control) {
            return Err("Enter an absolute server path beginning with /.".into());
        }
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|error| error.to_string())?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();

        let script = include_str!("pigry_server_bootstrap.sh").replace("\r\n", "\n");
        let command = format!("sh -c {}", shell_quote(&script));
        let mut cmd = CommandBuilder::new(console_host);
        cmd.args(["--ssh-workspace", &address.to_string()]);
        cmd.env(TOKEN_ENV, &token);
        cmd.args([
            "-T",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "PermitLocalCommand=no",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
        ]);
        cmd.args(endpoint.login_args());
        cmd.args(["--", &endpoint.host, &command]);
        Ok((
            Self {
                endpoint,
                remote_path,
                assets,
                token,
                listener: Mutex::new(Some(listener)),
            },
            cmd,
        ))
    }

    pub(crate) fn open(&self, alive: impl Fn() -> bool) -> Result<(SshWorkspace, Value), String> {
        let listener = self
            .listener
            .lock()
            .map_err(|error| error.to_string())?
            .take()
            .ok_or("This SSH workspace is already opening.")?;
        let deadline = Instant::now() + START_TIMEOUT;
        let stream = loop {
            if !alive() {
                return Err("The SSH session ended before PIGRY Server started.".into());
            }
            if Instant::now() >= deadline {
                return Err("Timed out connecting to PIGRY Server.".into());
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    // Winsock inherits the listener's nonblocking mode on accept.
                    stream
                        .set_nonblocking(false)
                        .map_err(|error| error.to_string())?;
                    stream
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .map_err(|error| error.to_string())?;
                    let mut actual = [0u8; 64];
                    if stream.read_exact(&mut actual).is_ok() && actual == self.token.as_bytes() {
                        break stream;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error.to_string()),
            }
        };
        drop(listener);
        stream
            .set_read_timeout(Some(START_TIMEOUT))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(REQUEST_TIMEOUT))
            .map_err(|error| error.to_string())?;
        let mut client = BufReader::new(stream);
        bootstrap(&mut client, &self.assets)?;
        client
            .get_ref()
            .set_read_timeout(Some(REQUEST_TIMEOUT))
            .map_err(|error| error.to_string())?;
        let snapshot = exchange(&mut client, "open", json!({ "path": self.remote_path }))??;
        let remote_path = snapshot["repository"]["localPath"]
            .as_str()
            .ok_or("PIGRY Server returned an invalid repository path.")?
            .to_owned();
        let workspace = SshWorkspace {
            endpoint: self.endpoint.clone(),
            remote_path,
            client: Mutex::new(Some(client)),
        };
        Ok((workspace, snapshot))
    }
}

impl SshWorkspace {
    pub(crate) fn info(&self) -> SshWorkspaceInfo {
        SshWorkspaceInfo {
            host: self.endpoint.host.clone(),
            path: self.remote_path.clone(),
            port: self.endpoint.port,
        }
    }

    pub(crate) fn uri(&self) -> String {
        let endpoint = &self.endpoint;
        let host = if endpoint.host.contains(':') {
            format!("[{}]", endpoint.host)
        } else {
            endpoint.host.clone()
        };
        let port = endpoint
            .port
            .map(|port| format!(":{port}"))
            .unwrap_or_default();
        let user = endpoint
            .username
            .as_ref()
            .map(|name| format!("{name}@"))
            .unwrap_or_default();
        format!("ssh://{user}{host}{port}{}", self.remote_path)
    }

    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut slot = self.client.lock().map_err(|error| error.to_string())?;
        call_locked(&mut slot, method, params)
    }

    pub(crate) fn changed(&self) -> Result<bool, String> {
        let Ok(mut slot) = self.client.try_lock() else {
            return Ok(false);
        };
        Ok(call_locked(&mut slot, "workspace_changed", Value::Null)?
            .as_bool()
            .unwrap_or(false))
    }
}

fn call_locked(
    slot: &mut Option<BufReader<TcpStream>>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let client = slot.as_mut().ok_or("The PIGRY Server connection closed.")?;
    match exchange(client, method, params) {
        Ok(result) => result,
        Err(error) => {
            slot.take(); // Never reuse a stream after losing its message boundary.
            Err(error)
        }
    }
}

fn bootstrap(client: &mut BufReader<TcpStream>, assets: &Path) -> Result<(), String> {
    fn response(client: &mut BufReader<TcpStream>) -> Result<String, String> {
        let bytes = read_frame(client)
            .map_err(|error| format!("PIGRY Server startup failed: {error}"))?
            .ok_or("PIGRY Server setup ended. Check the SSH connection output.")?;
        String::from_utf8(bytes).map_err(|_| "Unexpected output from the SSH server.".into())
    }

    // Some SSH shells print a greeting on stdout before running their command.
    let mut hello = response(client)?;
    for _ in 0..20 {
        if hello.starts_with("PIGRY_BOOTSTRAP ") {
            break;
        }
        hello = response(client)?;
    }
    let platform: Vec<_> = hello.split_ascii_whitespace().collect();
    let architecture = match platform.as_slice() {
        ["PIGRY_BOOTSTRAP", "1", "Linux", "x86_64"] => "x86_64",
        ["PIGRY_BOOTSTRAP", "1", "Linux", "aarch64" | "arm64"] => "aarch64",
        ["PIGRY_BOOTSTRAP", "1", os, arch] => {
            return Err(format!("PIGRY Server does not support {os} {arch}."));
        }
        _ => return Err("Unexpected SSH server startup output.".into()),
    };
    let asset = assets.join(format!("pigry-server-linux-{architecture}"));
    let binary = std::fs::read(asset).map_err(|error| {
        format!("The PIGRY Server bundle for Linux {architecture} is unavailable: {error}")
    })?;
    let checksum = format!("{:x}", Sha256::digest(&binary));
    writeln!(client.get_mut(), "{checksum} {}", binary.len()).map_err(|error| error.to_string())?;
    match response(client)?.as_str() {
        "PIGRY_UPLOAD" => client
            .get_mut()
            .write_all(&binary)
            .map_err(|error| error.to_string())?,
        "PIGRY_CACHED" => {}
        _ => return Err("PIGRY Server rejected the installation request.".into()),
    }
    if response(client)? != SERVER_READY {
        return Err("PIGRY Server reported an incompatible protocol version.".into());
    }
    Ok(())
}

fn exchange(
    client: &mut BufReader<TcpStream>,
    method: &str,
    params: Value,
) -> Result<Result<Value, String>, String> {
    let mut request = serde_json::to_vec(&Request {
        method: method.into(),
        params,
    })
    .map_err(|error| error.to_string())?;
    if request.len() as u64 >= MAX_FRAME {
        return Ok(Err("The PIGRY Server request is too large.".into()));
    }
    request.push(b'\n');
    client
        .get_mut()
        .write_all(&request)
        .map_err(|error| format!("Cannot send request to PIGRY Server: {error}"))?;
    let payload = read_frame(client)
        .map_err(|error| format!("Cannot read response from PIGRY Server: {error}"))?
        .ok_or("The PIGRY Server connection closed.")?;
    let reply = serde_json::from_slice(&payload)
        .map_err(|error| format!("Invalid PIGRY Server response: {error}"))?;
    Ok(match reply {
        Reply::Success { result } => Ok(result),
        Reply::Failure { error } => Err(error),
    })
}
