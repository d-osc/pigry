//! Pigry Bash host — a console-subsystem helper binary.
//!
//! The main `pigry.exe` is `windows_subsystem = "windows"` (GUI subsystem),
//! and ConPTY only wires stdio for console-subsystem children — a
//! GUI-subsystem child gets no console and no standard handles, so hosting
//! the REPL in the main binary deadlocks into instant EOF. This tiny helper
//! is built as a console binary, so it attaches the terminal's ConPTY just
//! like cmd.exe or powershell.exe and the REPL's stdio simply works.

fn main() {
    std::process::exit(pigry_lib::pty_bash::pty_bash_main());
}
