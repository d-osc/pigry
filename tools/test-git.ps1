$ErrorActionPreference = 'Stop'
foreach ($suite in @('git_state::tests','ops::tests','net::tests','settings::tests','watcher::tests')) {
    & cargo test --manifest-path (Join-Path $PSScriptRoot '../src-tauri/Cargo.toml') --lib $suite -- --test-threads=1
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
