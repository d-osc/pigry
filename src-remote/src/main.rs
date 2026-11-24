// Shared with the desktop app (src-tauri/src/lib.rs): the modules included below spawn processes through this trait.

/// `CREATE_NO_WINDOW` for spawned processes on Windows — a no-op on other
/// operating systems, where the flag is not needed.
#[cfg(windows)]
mod command_no_window {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    pub trait CommandNoWindow {
        fn no_window(&mut self) -> &mut Self;
    }
    impl CommandNoWindow for Command {
        fn no_window(&mut self) -> &mut Self {
            self.creation_flags(0x0800_0000);
            self
        }
    }
    impl CommandNoWindow for &mut Command {
        fn no_window(&mut self) -> &mut Self {
            self.creation_flags(0x0800_0000);
            self
        }
    }
}
#[cfg(not(windows))]
mod command_no_window {
    use std::process::Command;
    pub trait CommandNoWindow {
        fn no_window(&mut self) -> &mut Self;
    }
    impl CommandNoWindow for Command {
        fn no_window(&mut self) -> &mut Self { self }
    }
    impl CommandNoWindow for &mut Command {
        fn no_window(&mut self) -> &mut Self { self }
    }
}
pub use command_no_window::CommandNoWindow;

#[allow(dead_code)]
#[path = "../../src-tauri/src/git_state.rs"]
mod git_state;
#[allow(dead_code)]
#[path = "../../src-tauri/src/gitcli.rs"]
mod gitcli;
#[path = "../../src-tauri/src/insights.rs"]
mod insights;
#[allow(dead_code)]
#[path = "../../src-tauri/src/net.rs"]
mod net;
#[allow(dead_code)]
#[path = "../../src-tauri/src/ops/mod.rs"]
mod ops;
#[path = "../../src-tauri/src/remote_protocol.rs"]
mod protocol;
#[path = "../../src-tauri/src/settings.rs"]
mod settings;
mod workspace;

use std::io::{self, BufReader, Write};

use protocol::{Reply, Request, SERVER_READY, read_frame};
use workspace::Workspace;

fn main() -> io::Result<()> {
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = io::stdout().lock();
    let mut workspace = Workspace::default();
    writeln!(output, "{SERVER_READY}")?;
    output.flush()?;
    while let Some(frame) = read_frame(&mut input)? {
        let result = serde_json::from_slice::<Request>(&frame)
            .map_err(|error| error.to_string())
            .and_then(|request| workspace.handle(request));
        let reply = match result {
            Ok(result) => Reply::Success { result },
            Err(error) => Reply::Failure { error },
        };
        serde_json::to_writer(&mut output, &reply)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
