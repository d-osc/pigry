# Pigry

A desktop Git workspace built with Tauri, React and TypeScript. It includes a commit graph, staging/diff review, branch/merge/rebase tools, an editor, configurable AI providers and GitHub views through the GitHub CLI.

## Development

Requires Node.js 22.18+ or 24+, npm, the Rust toolchain, Git and the Tauri prerequisites for Windows. GitHub views additionally require the `gh` CLI and a signed-in account with access to the repository.

```sh
npm install
npm run tauri dev
```

`npm run dev` opens the browser demo. Local Git operations and GitHub data require the desktop runtime. Both light and dark themes are available in Settings → Appearance.

## Validation

```sh
npm test
npm run test:git
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

See [the validation report](docs/VALIDATION.md) for completed checks, measurements and remaining verification limits, including full-repository lint and GitHub account-specific scenarios.
