# Pigry validation — 2026-11-15

For the subsequent release/installer, live GitHub, large repository and automated UI checks, see [RELEASE_VALIDATION.md](RELEASE_VALIDATION.md).

## Completed changes

- Deferred screen JavaScript and Word/Excel parsers until needed. All screen CSS loads in a stable order to prevent navigation-dependent styling regressions.
- Reset screen state when repository/branch changes; isolate render failures and deferred-module failures with retry/reload boundaries.
- Reject superseded async detail/file/list responses in Git views and GitHub lists. Ignore obsolete watcher refreshes during repository operations and clean up event listeners reliably.
- Preserve commit drafts when a commit fails; do not report a failed merge as successful. Commit through the Git CLI so repository hooks, signing configuration, and merge parents are honored.
- Preserve unsaved editor buffers on external refresh. Saving records the written snapshot, so typing during an in-flight save remains dirty.
- Show errors and retry controls for push previews, file history, base comparisons, worktree diffs, commit details/diffs, branch lists, workflow artifacts and Explorer tree loads.
- Attach/detach the native file watcher on repository open/close. Stop its thread when the handle is dropped.
- Stop timed-out Git processes instead of leaving Git running after a timeout; drain stdout/stderr concurrently.
- Replace remaining fixed dark colors in Markdown, dialogs, warnings and controls with light/dark tokens.

## Automated verification

- `npm test`: **13 passed** (request ordering/unmount, dirty-buffer preservation/save snapshots, publish eligibility, sort persistence, error text, scoped-state resets, editor-action cleanup, large file trees and bounded-heap AI-panel lint).
- `npm run test:git`: **72 passed**: Git state 48, operations 15, network 5, settings 3, watcher 1, including the large unchanged-tree file-history regression budget.
- Tests use disposable repositories and local bare remotes. They cover publishing/upstream creation, push/fetch/pull, divergent history, rejected pushes and recovery, missing remotes, timeout, hook rejection preserving HEAD/index, conflicts/abort, partial staging, stash and local settings.
- `npm run build`: passed, including TypeScript. Deferred Monaco chunks remain large; this change reduces startup loading rather than eliminating Monaco's total size.
- Full `npm run lint`: **passed with zero errors and zero warnings**, with `NODE_OPTIONS=--max-old-space-size=1024`, in **23.58 seconds**. All configured rules remain enabled. Project-context gathering, turn execution and memory summarization now run through helpers outside the large AI panel's render analysis; the previous run exhausted approximately 4 GB. A regression test also lints that panel with a 768 MiB heap limit and a 40-second timeout.
- Corrected effect dependencies, moved editor-ref updates to the layout effect, and reset request-scoped results/errors without synchronous state updates inside effects.
- The earlier all-tests Rust invocation stalled in the unrelated AI CLI-detection suite; it was stopped. The subsequent complete Git-specific suite above passed, including the new file-history regression. That unrelated AI suite is not certified by the Git-specific run.

## Native Tauri verification

Built the current debug executable and launched it with a disposable test config/profile and a local repository. No user repository was changed by smoke actions.

- Opened the repository through Home and published `main` from the Push Commits screen to a local bare remote; verified `origin/main` upstream and the up-to-date UI.
- Added an external file while the app was running; it appeared automatically in Working changes without Refresh.
- Used a failing pre-commit hook; verified the error and that the full commit message remained in the form.
- Removed the failing test hook and retried through the same form; verified the commit message in Git history, the empty commit form, and the remaining unstaged file.

The CLI rejection hook test and native retry specifically reproduce the failure that previously cleared the commit draft. Real GitHub credential revocation was not performed. A read-only GitHub `/user` request rejected a process-local deliberately invalid token, then succeeded after restoring the existing credentials. No stored credentials were modified.

## Themes and window sizes

Navigated all **18 workspace pages in both themes at 1024 x 768**: 36 checks. No render boundaries fired, no document-level horizontal overflow, and no browser console errors were observed. Captured and reviewed light/dark screenshot contact sheets. Browser checks use demo data or the documented desktop-required/empty states; they do not certify every populated GitHub account, organization permission, or workflow state. Native worktree/diff, error, retry and publish states were also inspected.

## Performance

Production main JavaScript before: **5,650,368 bytes**. After: see `performance-results.json` (about **492 KB**, **91.3% reduction**, around **143 KB gzip**). Deferred chunks load when their screens/features are opened; these figures are not total application download size or a claim of a 91% runtime speedup.

Three native debug launches measured time from Rust `run()` entry until Home was rendered: **1490 / 1576 / 1296 ms**. First launch used a fresh WebView profile; subsequent launches reused it. This includes Vite/development overhead and is not a release benchmark. No pre-change native startup measurement was collected, so no startup speedup is claimed.

At Home readiness, the complete sampled process tree (Tauri + descendant WebView2/helpers) used **579.8–590.8 MiB working set**, **325.9–336.3 MiB private memory**, across 14 processes. A separate open-repository/first-publish debug sample was 617.6 MiB working set / 379.3 MiB private memory across 8 processes. These workloads differ; no RAM reduction is claimed. See `native-home-performance.json` and `native-runtime-sample.json`.

## Reproduce

1. `npm test`
2. `npm run test:git` (PowerShell 7, Rust toolchain, Git installed).
3. `npm run build`
4. `npm run lint` (zero warnings required).
5. `cargo build --manifest-path src-tauri/Cargo.toml --bin pigry`
6. Start `npm run dev`, then `npm run test:desktop` in another terminal. It creates a disposable repository/profile, records three native Home startup/memory samples, and stops only its own app process trees. Temporary fixtures remain available for inspection. Debug-only `PIGRY_TEST_CONFIG_DIR` isolation is ignored by release builds.

No release was published, repository changes were pushed to GitHub, or issues/comments created. Stored credentials were not changed.
