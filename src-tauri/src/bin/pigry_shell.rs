//! Pigry Bash host — a console-subsystem helper binary.
//!
//! The main `pigry.exe` is `windows_subsystem = "windows"` (GUI subsystem),
//! and ConPTY only wires stdio for console-subsystem children — a
//! GUI-subsystem child gets no console and no standard handles, so hosting
//! the REPL in the main binary deadlocks into instant EOF. This tiny helper
//! is built as a console binary, so it attaches the terminal's ConPTY just
//! like cmd.exe or powershell.exe and the REPL's stdio simply works.

#[cfg(windows)]
#[path = "../windows_cli.rs"]
mod windows_cli;

fn main() {
    {
        let mut args = std::env::args_os().skip(1);
        let operation = args.next();
        if operation
            .as_deref()
            .is_some_and(|arg| arg == "--ssh-workspace")
        {
            if let Err(error) = pigry_lib::ssh_relay::run(args) {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }
        #[cfg(windows)]
        if let Some(operation) = operation
            .as_deref()
            .filter(|arg| *arg == "--register-cli" || *arg == "--unregister-cli")
        {
            let result = std::env::current_exe().and_then(|exe| {
                let directory = exe
                    .parent()
                    .ok_or_else(|| std::io::Error::other("Missing install directory"))?;
                windows_cli::register(directory, operation == "--register-cli")
            });
            if let Err(error) = result {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }
    }
    std::process::exit(pigry_lib::pty_bash::pty_bash_main());
}
