//! Pigry Bash host — a console-subsystem helper binary.
//!
//! The main `pigry.exe` is `windows_subsystem = "windows"` (GUI subsystem),
//! and ConPTY only wires stdio for console-subsystem children — a
//! GUI-subsystem child gets no console and no standard handles, so hosting
//! the REPL in the main binary deadlocks into instant EOF. This tiny helper
//! is built as a console binary, so it attaches the terminal's ConPTY just
//! like cmd.exe or powershell.exe and the REPL's stdio simply works.

fn main() {
    {
        let mut args = std::env::args_os().skip(1);
        if args.next().is_some_and(|arg| arg == "--ssh-workspace") {
            if let Err(error) = pigry_lib::ssh_relay::run(args) {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }
    }
    std::process::exit(pigry_lib::pty_bash::pty_bash_main());
}
