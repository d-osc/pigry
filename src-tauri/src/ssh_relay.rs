//! Console helper preserves OpenSSH password and host-key prompts in the PTY.
//! Only the private loopback socket carries the SSH command's stdio.
use std::{ffi::OsString, io, process::Stdio};
use tokio::{io::AsyncWriteExt, net::TcpStream, process::Command};

pub(crate) const TOKEN_ENV: &str = "PIGRY_SSH_RELAY_TOKEN";

pub fn run(mut args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let address = args
        .next()
        .and_then(|arg| arg.into_string().ok())
        .ok_or("Missing SSH relay address.")?;
    let address: std::net::SocketAddr =
        address.parse().map_err(|_| "Invalid SSH relay address.")?;
    if !address.ip().is_loopback() {
        return Err("The SSH relay requires a loopback address.".into());
    }
    let token = std::env::var(TOKEN_ENV).map_err(|_| "Missing SSH relay token.")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime
        .block_on(relay(address, token, args))
        .map_err(|error| error.to_string())
}

async fn relay(
    address: std::net::SocketAddr,
    token: String,
    args: impl Iterator<Item = OsString>,
) -> io::Result<()> {
    let mut socket = TcpStream::connect(address).await?;
    socket.write_all(token.as_bytes()).await?;
    let mut ssh = Command::new("ssh")
        .args(args)
        .env_remove(TOKEN_ENV)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut from_server = ssh.stdout.take().expect("piped SSH stdout");
    let mut to_server = ssh.stdin.take().expect("piped SSH stdin");
    let (mut from_app, mut to_app) = socket.into_split();
    tokio::select! {
        result = tokio::io::copy(&mut from_app, &mut to_server) => { result?; }
        result = tokio::io::copy(&mut from_server, &mut to_app) => {
            result?;
            let status = ssh.wait().await?;
            if !status.success() {
                return Err(io::Error::other(format!("SSH session exited with {status}")));
            }
        }
    }
    Ok(())
}
