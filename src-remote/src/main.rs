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
