# Security Review — Pigry Desktop (Tauri v2 + React)

- **Reviewer:** @white-hat (defensive review, source inspection only)
- **Scope:** working tree of this repository — Tauri backend (`src-tauri/`), React frontend (`src/`), remote server (`src-remote/`), Tauri config & capabilities, bundled site (`docs/site/`), CI workflows, tracked runtime artifacts (`.pigry/`). No live probing, no exploit construction, no scans run against live targets.
- **Alerts at review time:** code scanning — API unreachable from this session (`gh: no analysis found` / scope error); Dependabot — 0 alerts returned; secret scanning — **disabled** (gap, see WH-01).
- **Status:** all 6 findings **independently re-verified twice** against the working tree (HEAD `5f9c108`, branch `main`) — line numbers below are confirmed as of the second pass. Pass 2 additionally confirmed the seed keys are duplicated into tracked chat transcripts and located a second Bearer-in-argv site (see WH-01 / WH-06).
- **Secrets are redacted** in this report (prefix + length only).

## Summary

| ID | Severity | Confidence | Title |
|----|----------|------------|-------|
| WH-01 | **Critical** | High | Live API keys committed in source (and duplicated into tracked chat transcripts) |
| WH-02 | **High** | High | Webview CSP disabled (`csp: null`) |
| WH-03 | **High** | High | Provider API keys stored plaintext in localStorage |
| WH-04 | **Medium** | High | Unsanitized HTML in DOCX/XLSX preview (`dangerouslySetInnerHTML`) |
| WH-05 | **Medium** | High | ZCode credential bridge ships decrypt secret over IPC |
| WH-06 | **Low** | High | API key exposed in `curl` argv during AI requests (two sites) |

Chain risk: **WH-04 (or any XSS) → WH-02 (no CSP) → WH-03/WH-05 (keys readable/derivable in webview) → full credential theft + Tauri IPC access.** Fixing WH-02 + WH-03 + WH-05 breaks the chain even if a renderer bug slips through.

**Fix handoff for @coder:** see [`.pigry/reports/white-hat/security-fix-handoff-coder.md`](./security-fix-handoff-coder.md) — ordered, independently mergeable work items with acceptance criteria.

---

## Confirmed findings

### WH-01 — Live API keys committed in source · Critical · Confidence: High

- **Files:**
  - `src/lib/aiProviders.ts:18` and `:20` (`SEED_TEST_KEYS`)
  - `.pigry/chat/chat-mwa56rim.json` (tracked, modified) — pass-2 finding: the same literals are quoted inside a chat transcript that is itself under version control
- **Evidence (re-verified):** two complete bearer-format key literals sit in the committed source, redacted here:
  - `sk-sp-H.DIMED…` (93 chars) — Qwen Cloud seed key (`aiProviders.ts:18`)
  - `c466230f…` (38 chars, `id.secret` form) — z.ai/Zhipu test key (`aiProviders.ts:20`)
  - `dropTestProviders()` (line ~23) only *uses* them to drop seeded entries on load, but the plaintext literals are in the tree **and in git history**. Repository-wide search for both key prefixes confirms the only additional copies are the transcript(s) under `.pigry/chat/` and this report (redacted prefixes only).
- **Impact:** anyone with read access to the repo obtains working provider credentials → quota theft, billing abuse, account compromise. Editing the files later does not remove them from history; the transcript copies mean cleanup must cover `.pigry/` too.
- **Mitigation:**
  1. **Revoke/rotate both keys at the provider now** (owner action — cannot be done in code).
  2. Replace the plaintext literals in `aiProviders.ts` with **SHA-256 hashes** of the keys; `dropTestProviders()` compares hashes, so the cleanup logic survives without the secret. `sha2` is already a backend dependency — see the handoff doc for two implementation options.
  3. Scrub the key literals from `.pigry/chat/*.json` (delete or redact the transcripts) and add `.pigry/` to `.gitignore` so runtime artifacts stop entering git.
  4. Purge history (`git filter-repo` / BFG) or treat history as compromised and rotate.
  5. Enable GitHub **secret scanning + push protection** on the repo (currently disabled).
- **Safe verification:** after rotation, an authenticated provider call with the old key is rejected; `git log -S` finds no new commits carrying the literals; repo alert settings show secret scanning "enabled"; a fresh `git status` no longer lists `.pigry/chat/*.json` as tracked changes.

### WH-02 — Webview CSP disabled · High · Confidence: High

- **File:** `src-tauri/tauri.conf.json` → `app.security.csp: null` (re-verified)
- **Evidence:** `"security": { "csp": null }` — no Content-Security-Policy is applied to the main webview.
- **Impact:** any injected script (see WH-04) may load remote resources, exfiltrate localStorage contents (WH-03), and reach IPC without restriction. Tauri's own guidance treats a null CSP as an explicit opt-out of a core hardening layer.
- **Mitigation:** set a restrictive CSP, e.g.
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'`
  Notes for implementation:
  - IPC origin differs per OS (`http://ipc.localhost` on Windows, `ipc:` scheme elsewhere) — confirm against Tauri v2 docs.
  - AI provider calls go through Rust `ai_chat` (curl), **not** webview `fetch`, so `connect-src` can stay closed.
  - In dev, Vite HMR needs a websocket — set a separate permissive `app.security.devCsp` (allow `ws://localhost:1420`) instead of weakening the release CSP.
  - Run the full e2e suite (`npm run test:ui`) after the change.
- **Safe verification:** app boots, AI chat/PR/wiki screens still work, and devtools console shows the CSP active with inline scripts from file previews blocked.

### WH-03 — Provider API keys in plaintext localStorage · High · Confidence: High

- **File:** `src/lib/aiProviders.ts` — `LIST_KEY`/`ACTIVE_KEY` (lines 11-12), `migrate()` (line ~66), `writeLegacyMirror()` (line ~135, mirrors `apiKey` into legacy key `pigry:ai-provider`), `saveProviders()` (line ~322) (re-verified)
- **Evidence:** the full provider list including each `apiKey` is JSON-serialized to `localStorage` **and** mirrored to a second legacy key — double plaintext persistence in the WebView2 profile directory on disk.
- **Impact:** unencrypted at rest; readable by any script in the webview (chain WH-02/WH-04); included in profile backups/sync.
- **Mitigation:** store keys in the OS credential store behind Rust commands (add the `keyring` crate — note: unlike `gh.rs`, which delegates to the `gh` CLI's own store, provider keys have no external CLI to lean on); keep only provider metadata in localStorage; delete the legacy mirror that duplicates the key; have `ai_chat` accept a provider id and resolve the key in the backend.
- **Safe verification:** devtools → Application → localStorage shows no `apiKey` values; AI chat still authenticates.

### WH-04 — Unsanitized HTML in DOCX/XLSX preview · Medium · Confidence: High

- **File:** `src/screens/explorer/FileViewers.tsx:146` (mammoth `convertToHtml` output) and `:182` (SheetJS `sheet_to_html` output), both fed straight to `dangerouslySetInnerHTML` (re-verified)
- **Evidence:** mammoth intentionally passes through document-supplied HTML; the inline comment ("mammoth output is generated from the file itself") wrongly assumes trusted input. A `.docx`/`.xlsx` inside a cloned untrusted repo can therefore inject markup (`<script>`, event-handler attributes, remote images) into the app webview. Note: the repo's `rehype-sanitize` dependency only covers react-markdown pipelines — it does not sanitize these raw HTML strings.
- **Impact:** XSS in the desktop app triggered simply by opening a crafted file from an untrusted repo → with WH-02/WH-03, credential theft.
- **Mitigation:** sanitize library output with DOMPurify (new dependency; allowlist: tables, spans, img with `data:` src only, links forced to `target=_blank rel=noreferrer`) before injecting, or render inside a `sandbox`ed iframe. Add a regression fixture whose markup must render inert.
- **Safe verification:** unit/e2e test (fixture alongside `dev-demo/sample.docx`) asserts injected script markup does not execute; with WH-02 in place, console reports the block.
- **Counter-example (good):** `src/lib/markdown.tsx` builds React nodes and never emits raw HTML — verified again this review; keep that pattern.

### WH-05 — ZCode credential bridge exposes decrypt secret over IPC · Medium · Confidence: High

- **File:** `src-tauri/src/ai.rs` — `ZcodeCreds.secret` field + `zcode_creds()` (~lines 82-135, re-verified: returns `secret` + encrypted entries); `src/lib/zcode.ts:26-57` (`detectZcodeGlm` derives AES-GCM key = SHA-256(secret) in the webview and decrypts the third-party app's API key).
- **Evidence:** the machine-derived secret is deterministic and reconstructible (`zcode-credential-fallback:win32:<home>:<username>`), and it plus every ciphertext entry crosses the IPC boundary into the webview. The decrypted key then flows into localStorage (chains WH-03).
- **Impact:** any script running in the webview (chain WH-02/WH-04) can invoke the `zcode_credentials` command and recover ZCode's z.ai coding-plan key in plaintext.
- **Mitigation:** perform the AES-GCM decryption in Rust (`sha2` already a dependency; add `aes-gcm`; entries are unpadded base64url — the JS layer currently normalizes `-`→`+`); return only the resulting provider entry (or hand the key straight to the WH-03 keyring); never ship `secret` across IPC.
- **Safe verification:** IPC response schema contains no `secret` field; ZCode detection still produces a usable provider.

### WH-06 — API key visible in `curl` argv · Low · Confidence: High

- **Files:** `src-tauri/src/ai.rs:49` — `cmd.args(["-H", &format!("Authorization: Bearer {api_key}")])` (plus the `x-api-key` variant, lines ~40-48) **and a second occurrence at `ai.rs:631`** (same `format!("Authorization: Bearer {api_key}")` argv pattern — located during the pass-2 search; the earlier report listed only the first site).
- **Impact:** the bearer token is visible in local process listings (Task Manager/WMI/Process Explorer) for the duration of each AI request — relevant on shared or monitored machines.
- **Mitigation:** pass the header via a short-lived temp file (`curl -H @file`, supported since curl 7.55) with user-only permissions (0600), deleted immediately after spawn on all paths (drop guard). **Fix every site** — locate them with `grep -n "Authorization: Bearer" src-tauri/src/ai.rs` (currently 2 matches).
- **Safe verification:** during a long-running request, inspecting each spawned curl process's command line shows no `Authorization` value.

---

## Items needing review (not confirmed vulnerabilities)

1. **`.pigry/chat/*.json` tracked in git** — partially resolved into WH-01: at least one transcript (`chat-mwa56rim.json`, tracked) demonstrably carries the seed-key literals. Beyond scrubbing (WH-01), recommend gitignoring `.pigry/` entirely and re-checking remaining transcripts for user-pasted tokens before any public release.
2. **Pending working-tree diff on `src/screens/explorer/AiAgentPanel.tsx`** (+102/−32) — reviewed portions showed no security-relevant change; whoever commits it should re-check the parts not inspected here.
3. ~~Validation artifacts~~ **Resolved (pass 2):** `docs/auth-validation.json` and `docs/github-validation.json` inspected — booleans/scopes only, **no live tokens**. Likewise, repository-wide search found no `ghp_`/`github_pat_` literals (only a UI placeholder in `AppSettingsScreen.tsx:822`). No action.
4. **Updater key handling** — `scripts/build-updater-json.mjs` + `.github/workflows/release.yml`: confirm the updater **private** key only ever exists as a CI secret and never in the tree (public key in `tauri.conf.json` is correct and expected).
5. **`tauri.windows.conf.json` / `tauri.macos.conf.json`** — verify any per-platform overrides don't re-widen security settings once WH-02's CSP lands.

## Verified positive controls (no action)

- `src-tauri/capabilities/default.json` — minimal permission set (re-verified); no shell/fs plugins exposed to the webview.
- Updater: HTTPS endpoint + signing `pubkey` present; artifacts opted in.
- `gh.rs` — argv-array invocation only; credentials delegated to `gh`'s keyring.
- SSH workspace relay — loopback listener, 32-byte random handshake token, shell-quoted bootstrap, `ClearAllForwardings=yes`.
- `web.rs` / `devtools.rs` — URL scheme restricted to `http(s)` before spawning browsers; CDP attach (`127.0.0.1:9222`) is compiled out of release builds (`cdp_off()`).
- `src-remote` server — stdin/stdout only, no network listener.
- `markdown.tsx` — text-only React rendering, no raw HTML, external links get `rel="noreferrer"` (re-verified this pass).
- `docs/auth-validation.json`, `docs/github-validation.json` — token-free (pass 2).

## Scope & limits

- Source inspection of the authorized repository only; no dynamic testing, no live targets probed, no payloads generated.
- GitHub alert APIs could not be fully read this session (code scanning 404 / missing `admin:repo_hook` scope); Dependabot returned 0 alerts. Findings above are all source-verified.
- Dependency CVE matching (`package-lock.json`, `Cargo.lock`) not exhaustively cross-checked this pass — recommend a follow-up Dependabot review once alerts are readable.
- The long tail of `src-tauri/src/ai.rs` (past the truncation point of this session's file reader) was surveyed via targeted search rather than full read; the second Bearer site (WH-06) was found this way.

**Report:** `.pigry/reports/white-hat/security-review-pigry-desktop.md`
**Handoff:** `.pigry/reports/white-hat/security-fix-handoff-coder.md`
