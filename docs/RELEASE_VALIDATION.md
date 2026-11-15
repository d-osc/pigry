# Windows release, GitHub and scale validation — 2026-11-15

This follow-up covers Windows x64. It does not certify macOS/Linux installers, signed automatic updates, every organization policy or day-long sessions.

## Automated UI regression

`npm run test:ui`: **13 passed**. The suite checks all 18 workspace pages in light and dark themes at 1024 × 768, keyboard palette controls, populated PR/Actions views, 401/403 SSO/404 errors and retry, fast artifact failure/recovery, staging → rejected commit → successful retry with the draft retained, repeated editor teardown and a 20,000-file folder. Two checked-in Windows screenshots cover a selected commit and an open branch dialog at 1600 × 1000.

Tests use a test-only IPC boundary for deterministic GitHub responses; no mock backend or test switch is added to the production app. Live backend checks are separate below. Playwright saves screenshots and traces on failure. The Windows check workflow now runs UI/visual tests and uploads failure artifacts; Node 24 is used for frontend tests. The workflow itself has not been dispatched remotely.

These tests found and fixed deferred loading/error-reset races in PR/issue details and Actions logs/artifacts, plus Monaco's diff-model disposal order during screen teardown. Both diff models are detached before disposal. Conflict, save and blame commands now use disposable editor actions; previously global command registrations retained entire detached Explorer DOM trees. A browser regression test opens/closes editors 15 times and enforces a detached-DOM growth budget.

`npm test`: **13 passed**. `npm run test:git`: **72 passed**, including the new large unchanged-tree history budget. Full lint requires zero warnings and passes. The release NSIS build includes TypeScript and the production frontend build.

## Live GitHub backend

See `github-validation.json`. `validation_probe` calls the same Rust functions used by desktop commands, through the installed `gh` CLI:

- Public repository: 1 PR, 2 workflows, 5 recent runs; PR and run details decoded successfully.
- A readable private repository: 1 PR and its detail decoded successfully; workflow/run lists were empty. Names and content are omitted from the report.
- A deliberately invalid process-local token returned HTTP 401; removing that override restored successful calls. Stored credentials/account selection were not changed.
- Organization SSO enforcement and denied-repository errors are deterministic UI fixtures, **not live changes to organization permissions**. No PR, review, comment or workflow was created or triggered.

## Large repository and repeated navigation

The disposable repository contains **10,000 commits, 20,000 tracked files and 400 working changes** (200 modified + 200 untracked files). The file tree returns 20,200 entries; history returns the existing cap of 500 rows while counting all 10,000 commits.

`release-large-soak.json` records the **installed optimized release**, with **291 complete navigation cycles** through Working changes → Commit graph → Branches → Explorer over **304 seconds** (1,164 page transitions). Each Explorer visit waits for the full file count and the editor to appear and rejects an unbounded file-tree DOM. The run recorded **zero JavaScript errors**. The original recent-repository configuration was restored byte-for-byte afterward.

The sampled application process tree (including WebView/helpers) peaked at **1,001.5 MiB working set**. The last sample used **997.0 MiB working set / 807.7 MiB private memory**, with **28.0 MiB renderer JS heap after collection**. DOM counts stayed between **953 and 1,008**. After the 35-second warm-up sample, maximum DOM growth was **0**, and maximum JS heap growth was **2.5 MiB**; the explicit 2,000-node / 20 MiB growth budgets passed. Native working/private memory continued warming during this short run, so this is not a claim that total RAM stays flat or that day-long sessions are leak-free.

Explorer now indexes sibling paths with a map and renders only a visible window for large expanded trees. The original release stress capture (`release-large-soak-before.json`) accumulated over 900,000 DOM nodes; heap retention traced them through Monaco's global command registry to detached Explorer editors. Those editor actions are now explicitly disposed. Earlier debug/Vite samples are retained as `native-large-soak-before.json`; they are historical observations, not a controlled release-memory comparison. `native-bundled-smoke.json` separately verifies a current bundled debug build.

`file-history-performance.json` records an observed debug file-history call on this fixture falling from **46,149 ms to 200 ms** after skipping unchanged parent trees. File-history work now runs on the blocking task pool, keeping the command runtime responsive. The existing 2,000-commit scan limit is retained; older per-file changes can fall outside that window. These individual timings are not a statistical release-speed benchmark.

`large-backend-performance.json` contains 20 repeated debug backend samples:

| Operation | Median | p95 |
|---|---:|---:|
| Repository state | 831 ms | 1,026 ms |
| Commit history | 158 ms | 188 ms |
| File tree | 114 ms | 134 ms |

## Release installer

The current **0.1.0 Windows x64 NSIS build passed**, and `installer-validation.json` confirms installation → upgrade → uninstall. The installed release opened Home, replaced the old payload, preserved its saved profile/theme and removed its executable/uninstall registration cleanly. The final production installer is `src-tauri/target/release/bundle/nsis/pigry_0.1.0_x64-setup.exe` (**9,752,868 bytes**); `release-artifact.json` records its SHA-256. Builds still emit existing Rust warnings; a successful build does not mean zero Rust warnings.

Installer fixtures use a distinct product/registry key and executable name (`Pigry Validation`, `pigry-validation.exe`), the actual optimized release payload, and a separate WebView profile. The old package version is a synthetic 0.0.9 packaging fixture; it is not a historical Pigry release. The test checks payload replacement, saved profile/theme preservation and uninstall cleanup. Packages are unsigned local validation artifacts; nothing is published.

## Reproduce

```powershell
npm ci
npx playwright install chromium
npm test
npm run lint
npm run test:ui
npm run tauri build -- --bundles nsis
cargo build --manifest-path src-tauri/Cargo.toml --example validation_probe
pwsh -NoProfile -File tools/validate-github.ps1
node tools/create-large-fixture.mjs
```

To test a bundled debug frontend and the generated fixture path:

```powershell
npm run tauri build -- --debug --no-bundle
pwsh -NoProfile -File tools/measure-large.ps1 -Repository <fixture-path>
node tools/native-soak.mjs src-tauri/target/debug/pigry.exe <fixture-path> 300 docs/native-bundled-soak.json
```

The soak script can run longer by increasing the duration. It uses a dedicated debug config/profile, an independently allocated CDP port, and closes only its own app normally so profile storage can flush. A forced process-tree exit is a fallback. Release Home checks use an isolated WebView profile without changing the normal repository configuration.

For a real release repository run, close other Pigry instances and use `pwsh -NoProfile -File tools/release-soak.ps1 -Executable <release-exe> -Repository <fixture-path> -Seconds 300`. The script backs up the normal recent-repository JSON, temporarily points it at the fixture, and restores the original bytes afterward; concurrent user changes are preserved rather than overwritten. WebView data is isolated in a separate temporary profile. The recorded final run restored the original configuration exactly.

For installer checks, package old/new release payloads under the validation product identity with `tauri bundle --config <override-file>`, then run `tools/installer-smoke.ps1` with `-Phase install`, `upgrade`, and `uninstall`, a shared `-FixtureRoot` beginning with `pigry-installer-`, and the matching `-Installer` for install/upgrade. The upgrade test requires different old/new binary hashes.
