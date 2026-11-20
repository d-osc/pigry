# Pigry

A desktop Git workspace built with Tauri, React and TypeScript. It includes a commit graph, staging/diff review, branch/merge/rebase tools, an editor, configurable AI providers and GitHub views through the GitHub CLI.

## Development

Requires Node.js 22.18+ or 24+, npm, the Rust toolchain, Git and the Tauri prerequisites for your OS. GitHub views additionally require the `gh` CLI and a signed-in account with access to the repository.

```sh
npm install
npm run tauri dev
```

`npm run dev` opens the browser demo. Local Git operations and GitHub data require the desktop runtime. Both light and dark themes are available in Settings → Appearance.

## Remote SSH workspace

Choose **Server** on Home or run **Connect to SSH host…** from the command palette. Enter an SSH config alias or `user@host`, connect, and select a Git folder on the server. Pigry uses OpenSSH settings and authentication. Password authentication can prompt again when the workspace or a remote terminal starts.

Pigry installs the bundled Rust server under `~/.local/share/pigry/server` (or `$XDG_DATA_HOME/pigry/server`) and reuses the installed binary while its checksum matches. The server runs inside the SSH connection as the signed-in user. It supports Linux x86-64 and ARM64 with Git and standard shell tools. Editing files, viewing diffs and running Git use the server's working tree and Git configuration. Windows filesystem drivers are unnecessary.

Release builds bundle both Linux architectures. To enable Remote SSH in a development build, build the companion on Linux or WSL. Run this from the repository root with the musl toolchain installed. Use the target server's architecture.

```sh
arch="$(uname -m)"
target="$arch-unknown-linux-musl"
rustup target add "$target"
host="$(rustc -vV | sed -n 's/^host: //p')"
linker="$(rustc --print sysroot)/lib/rustlib/$host/bin/rust-lld"
CC=musl-gcc RUSTFLAGS="-C linker=$linker -C linker-flavor=ld.lld -C target-feature=+crt-static" \
  cargo build --locked --release --manifest-path src-remote/Cargo.toml --target "$target"
cp "src-remote/target/$target/release/pigry-server" "src-tauri/remote-bin/pigry-server-linux-$arch"
```

## Install and open from a terminal

**Windows** uses the per-user `-setup.exe` installer for x64 and ARM64. Setup registers `pigry` in your user PATH. Start a new terminal after setup to pick up the change. Existing system-wide MSI installations can be removed separately through Windows Installed apps with the access required by that installation.

**macOS** uses the Universal DMG on macOS 13.3 or later, on Apple Silicon and Intel. Move Pigry to Applications, open it, then run **Install pigry command in PATH…** from the Command Palette. This installs the launcher at `~/.local/bin/pigry`. If that directory is missing from your PATH, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and start a new terminal.

```sh
pigry .
pigry ./project
pigry "./My Project"
```

Pigry opens the Git working tree containing the supplied folder in a new window. Paths with spaces and Unicode characters work when quoted. Opening a folder outside a Git repository leaves the repository picker open and shows an error.

Windows setup also registers **Open with Pigry** for folders and the background of open folders in Explorer. On Windows 11, use **Show more options**. Uninstall removes the Explorer entries and the PATH entry added by setup.

## Validation

```sh
npm test
npm run test:git
npm run test:ui
npm run lint
npm run build
```

`test:git` uses PowerShell 7 to run the Git state, operations, network, settings and watcher Rust suites. Tests use temporary repositories and local bare remotes.

For native startup and memory samples:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --bin pigry
# Keep npm run dev running in another terminal:
npm run test:desktop
```

The desktop smoke script uses an isolated debug config and WebView profile, measures three Home loads, and stops only app process trees that it started. Temporary repositories remain available for inspection. Release builds ignore the debug-only `PIGRY_TEST_CONFIG_DIR` setting.

For Explorer integration, run `pwsh -NoProfile -File tools/test-context-menu.ps1` with Tauri's NSIS toolchain installed. It compiles and executes the installer hooks against isolated test registry keys and checks uninstall cleanup. With a freshly built debug binary and the dev server running, `node tools/test-folder-launch.mjs` checks normal startup, a nested repository folder with spaces/Thai characters, and a non-repository folder in isolated profiles.

UI tests use Playwright Chromium (`npx playwright install chromium` once). They cover both themes, navigation, keyboard controls, populated GitHub views, access failures/retry, commit-draft recovery and Windows visual snapshots. GitHub failure scenarios use a test-only IPC fixture; live read-only backend checks are separate.

See [the validation report](docs/VALIDATION.md) and [release and scale validation](docs/RELEASE_VALIDATION.md) for measurements, reproduction commands and remaining verification limits.
