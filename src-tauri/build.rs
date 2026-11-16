fn main() {
    // The bundle resource `binaries/pigry-shell.exe` is produced by this same
    // cargo build (it's the console-subsystem REPL host), but tauri-build
    // validates resource paths before anything is compiled. Seed a placeholder
    // on fresh checkouts; the real helper overwrites it in the
    // beforeBundleCommand hook right before packaging.
    let placeholder = std::path::Path::new("binaries/pigry-shell.exe");
    if !placeholder.exists() {
        let _ = std::fs::create_dir_all(placeholder.parent().expect("parent dir"));
        let _ = std::fs::write(placeholder, []);
    }
    tauri_build::build()
}
