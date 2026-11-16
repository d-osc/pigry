//! ConPTY spawn harness — verifies that a Pigry binary actually receives
//! working stdio inside a pseudoconsole.
//!
//! Regression context: release builds are `windows_subsystem = "windows"`
//! (GUI subsystem), and ConPTY hands GUI-subsystem children a console but
//! no standard handles, so `--pty-bash` used to hit instant EOF and exit 0.
//!
//! Usage: `cargo run --example pty_check -- <exe> [args…]`
//! Spawns the command under a real ConPTY, types `help` then `exit`,
//! and prints everything the child emitted plus its exit code.
//!
//! The reader runs on its own thread because the ConPTY master stream never
//! EOFs while the master is alive — reading it on the polling thread would
//! deadlock exactly like a missed exit-watcher does.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn main() {
    let mut args = std::env::args().skip(1);
    let exe = args.next().expect("usage: pty_check <exe> [args…]");
    let rest: Vec<String> = args.collect();

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 200,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty failed");

    let mut cmd = portable_pty::CommandBuilder::new(&exe);
    for arg in &rest {
        cmd.arg(arg);
    }
    cmd.env("TERM_PROGRAM", "pigry");
    let mut child = pair.slave.spawn_command(cmd).expect("spawn failed");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("clone reader");

    // Output pump — blocks on read, so it lives on its own thread.
    let output: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let output = Arc::clone(&output);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => output.lock().expect("output lock").extend_from_slice(&chunk[..n]),
                }
            }
        });
    }

    // Drive the session like a user: `help`, then `exit`.
    std::thread::sleep(Duration::from_millis(1500));
    {
        let mut writer = pair.master.take_writer().expect("take writer");
        use std::io::Write;
        let _ = writer.write_all(b"help\r\n");
        let _ = writer.flush();
        std::thread::sleep(Duration::from_millis(700));
        let _ = writer.write_all(b"exit\r\n");
        let _ = writer.flush();
    }

    eprintln!("[pty_check] polling for child exit…");
    let started = Instant::now();
    let exit_code: Option<String> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.exit_code().to_string()),
            Ok(None) => {}
            Err(_) => break Some("error".to_string()),
        }
        if started.elapsed() > Duration::from_secs(12) {
            let _ = child.kill();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    eprintln!("[pty_check] child exited: {exit_code:?} — closing master");

    // Dropping the master closes the ConPTY; give the pump a moment to drain
    // the remaining output. It is detached instead of joined because the
    // master stream does not reliably EOF once the client is gone.
    drop(pair.master);
    std::thread::sleep(Duration::from_millis(400));
    let captured = output.lock().expect("output lock").clone();
    let text = String::from_utf8_lossy(&captured);
    println!("=== OUTPUT ({} bytes) ===", text.len());
    println!("{text}");
    match exit_code {
        Some(code) => println!("=== EXIT: {code} ==="),
        None => println!("=== CHILD DID NOT EXIT (killed after timeout) ==="),
    }
    if !text.contains("Pigry Bash") || !text.contains("built-ins") {
        println!("=== FAIL: expected banner + help output ===");
        std::process::exit(1);
    }
    println!("=== PASS ===");
}
