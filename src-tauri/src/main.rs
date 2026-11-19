// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(any(not(windows), debug_assertions))]
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
    // "Pigry Bash": the busybox shell the integrated terminal hosts inside
    // its ConPTY — same binary, REPL instead of the GUI. (Runs under a real
    // console in dev; the release GUI subsystem gets std handles wired by
    // the terminal's ConPTY spawn.)
    if std::env::args_os().skip(1).any(|arg| arg == "--pty-bash") {
        std::process::exit(pigry_lib::pty_bash::pty_bash_main());
    }
    pigry_lib::run()
}
