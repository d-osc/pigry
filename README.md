# Pigry

A desktop Git workspace built with Tauri, React and TypeScript. It includes a commit graph, staging/diff review, branch/merge/rebase tools, an editor, configurable AI providers and GitHub views through the GitHub CLI.

## Development

Requires Node.js 22.18+ or 24+, npm, the Rust toolchain, Git and the Tauri prerequisites for Windows. GitHub views additionally require the `gh` CLI and a signed-in account with access to the repository.

```sh
npm install
npm run tauri dev
```

`npm run dev` opens the browser demo. Local Git operations and GitHub data require the desktop runtime. Both light and dark themes are available in Settings → Appearance.

## Open a folder from Windows Explorer

The Windows EXE (NSIS) and MSI installers register **Open with Pigry** for folders and the background of an open folder. On Windows 11 this classic shell entry is available under **Show more options**. Uninstalling removes the entries.

The menu launches `pigry --open-folder PATH` in a new window and opens the Git repository containing that folder. Paths with spaces, Unicode characters and network shares are supported. A folder without a Git repository shows an error in the repository picker; Pigry does not initialize or change it automatically. Launching Pigry normally still opens the repository picker.

Explorer integration is included in Windows installers starting with v0.3.1.

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
