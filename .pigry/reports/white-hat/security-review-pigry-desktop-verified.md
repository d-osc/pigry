# Security Review — Pigry Desktop (verified pass)

- **Reviewer:** @white-hat (defensive security review; source inspection only — no scans, no payloads, no live targets)
- **Scope:** authorized repository working tree — `src-tauri/` (Tauri v2 Rust backend), `src/` (React webview), `src-remote/`, Tauri config & capabilities, CI workflows, bundled site, tracked runtime artifacts (`.pigry/`).
- **Basis:** independent re-verification of the earlier review (`.pigry/reports/white-hat/security-review-pigry-desktop.md`, untracked) against the current tree (branch `main`, HEAD `5f9c108`). Every finding below was re-confirmed by direct file read / repository-wide search this pass.
- **GitHub alerts at review time:** Dependabot — 0 alerts; code scanning — not readable (HTTP 404, missing `admin:repo_hook` scope); secret scanning — **disabled on this repository** (gap, see WH-01).
- **Secrets are redacted** (prefix + length only).

## Summary

| ID | Severity | Confidence | Title |
|----|----------|------------|-------|
| WH-01 | **Critical** | High | Provider API keys committed in plaintext in source |
| WH-02 | **High** | High | Webview CSP disabled (`app.security.csp: null`) |
| WH-03 | **High** | High | Provider API keys persisted plaintext in localStorage (two keys) |
| WH-04 | **Medium** | High | Unsanitized library HTML → `dangerouslySetInnerHTML` (docx/xlsx preview) |
| WH-05 | **Medium** | High | ZCode decrypt secret + ciphertexts shipped over IPC to the webview |
| WH-06 | **Low** | High | Auth header visible in `curl` process argv (two call sites) |

**Chain risk:** WH-04 (XSS from an untrusted repo file) → WH-02 (no CSP) → WH-03/WH-05 (keys readable/derivable in the webview) → full provider-credential theft plus Tauri IPC reach from renderer JS. Fixing WH-02 + WH-03 + WH-05 breaks the chain even if a renderer bug slips through.

---

## Confirmed findings

### WH-01 — Provider API keys committed in plaintext · Critical · Confidence: High

- **File:** `src/lib/aiProviders.ts:17-20` — the `SEED_TEST_KEYS` array.
- **Evidence (verified this pass):**
  - Key 1: `sk-sp-H.DIMED…` (93 chars, `sk-sp-` bearer format) — Qwen Cloud seed key, line 18.
  - Key 2: `c466230f…` (38 chars, `id.secret` form) — z.ai/Zhipu test key, line 20.
  - `dropTestProviders()` (lines 23-30) only *compares* these literals; the plaintext values themselves sit in the tracked tree **and in git history**.
  - **Blast-radius correction vs the earlier report:** searching the repository for mid-key substrings (`vYbS.MEQCIEy…`, `kN4JqIlzCGV9…`) returns exactly **one** hit each — `aiProviders.ts` only. The copies in `.pigry/chat/*.json` and `.pigry/memory*.md` contain only the **redacted prefix** (`sk-sp-H.DIMED…`, 12 chars, non-usable). Full-key cleanup therefore targets one file (+ history).
- **Impact:** anyone with repo read access obtains working provider credentials → quota theft, billing abuse, account takeover. Deleting the lines later does not remove them from history.
- **Mitigation:**
  1. **Revoke/rotate both keys at their providers now** (owner action; code cannot do this).
  2. Replace the literals with SHA-256 hex digests of the keys; `dropTestProviders()` compares `sha256(entry.apiKey)` against the digest list. Do **not** paste digests computed from a third-party snippet — compute locally (see handoff).
  3. Purge history (`git filter-repo` / BFG) or treat history as compromised and rotate.
  4. Add `.pigry/` to `.gitignore` so runtime artifacts (chat transcripts, memory) stop entering git, and enable GitHub **secret scanning + push protection** (currently disabled).
- **Safe verification:** after rotation, an authenticated call with the old key is rejected by the provider; `git log -S` (mid-key substring) returns no commits carrying the literal after purge; repo settings show secret scanning enabled; stored seeded providers are still dropped on load.

### WH-02 — Webview CSP disabled · High · Confidence: High

- **File:** `src-tauri/tauri.conf.json` → `app.security.csp` is `null` (the `"security": { "csp": null }` block).
- **Evidence:** no Content-Security-Policy is applied to the main webview — an explicit opt-out of Tauri's core hardening layer.
- **Impact:** injected script (see WH-04) can load remote resources, exfiltrate localStorage (WH-03), and reach IPC unrestricted.
- **Mitigation:** set a restrictive `app.security.csp`, e.g.
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'`
  Notes: IPC origin differs per platform (`ipc:` vs `http://ipc.localhost`) — confirm against Tauri v2 docs; AI traffic goes through Rust `ai_chat` (curl), not webview fetch, so `connect-src` stays closed; keep a permissive `devCsp` for Vite HMR (`ws://localhost:1420`) instead of weakening release; verify `tauri.windows.conf.json` / `tauri.macos.conf.json` do not override `security`.
- **Safe verification:** app boots; AI chat, markdown/pdf/docx previews still work; devtools console shows CSP active and blocks inline script from the WH-04 regression fixture.

### WH-03 — Provider API keys plaintext in localStorage (×2) · High · Confidence: High

- **File:** `src/lib/aiProviders.ts` — `LIST_KEY`/`ACTIVE_KEY` (lines 11-12), `saveProviders()` (≈ line 322, serializes full list incl. every `apiKey`), `writeLegacyMirror()` (≈ lines 135-152, additionally mirrors `apiKey` into legacy key `pigry:ai-provider`), `setActiveProvider()` also calls the mirror.
- **Impact:** unencrypted at rest in the WebView2 profile directory; double persistence widens exposure; any script in the webview reads them (chains WH-02/WH-04); included in profile backups/sync.
- **Mitigation:** move keys into the OS credential store behind Rust commands (`keyring` crate); persist provider metadata only in localStorage; delete the legacy mirror's `apiKey` field (or the whole mirror); resolve the key server-side so `ai_chat` takes a provider id.
- **Safe verification:** devtools → Application → localStorage shows no `apiKey` value under either key; AI chat still authenticates end-to-end; a migration unit test covers old-shape → keyring.

### WH-04 — Unsanitized HTML injected via `dangerouslySetInnerHTML` · Medium · Confidence: High

- **Files:** `src/screens/explorer/FileViewers.tsx:146` (mammoth `convertToHtml` output for `.docx`) and `:182` (SheetJS `sheet_to_html` output for `.xlsx`).
- **Evidence:** both library outputs are fed straight into `dangerouslySetInnerHTML`. The inline comment "mammoth output is generated from the file itself" wrongly assumes trusted input — a `.docx`/`.xlsx` inside a cloned untrusted repo controls that markup (`<script>`, `on*=` handlers, remote images). The repo's `rehype-sanitize` dependency only covers react-markdown pipelines and cannot sanitize these raw strings.
- **Impact:** XSS in the desktop app triggered by opening a crafted file from an untrusted repository → with WH-02/WH-03, credential theft.
- **Mitigation:** sanitize with DOMPurify (allowlist: tables, `p`, `span`, `strong`, `em`, lists, `a`, `img` with `data:` src only; hook forces `a.target=_blank rel="noreferrer noopener"`) or render in a `sandbox`ed iframe; add a regression fixture asserting injected markup renders inert.
- **Safe verification:** unit/e2e test on the fixture asserts no `<script`, no `on*=` attributes, no non-`data:` img src survive; preview of `dev-demo/sample.docx` / `sample.xlsx` still renders.
- **Counter-example (keep):** `src/lib/markdown.tsx` builds React nodes and never emits raw HTML — verified again this pass.

### WH-05 — ZCode decrypt secret shipped over IPC · Medium · Confidence: High

- **Files:** `src-tauri/src/ai.rs:71-137` (`ZcodeCreds` with a `secret` field + `zcode_creds()` at line 105; also `#[derive]` structs `ZcodeEntry` carrying `iv`/`tag`/`ct`), exposed via `src-tauri/src/commands.rs:1485`; consumed by `src/lib/zcode.ts:26-57` where the webview derives key = SHA-256(secret) with WebCrypto and decrypts the third-party app's API key.
- **Evidence:** the secret is deterministic and reconstructible (`zcode-credential-fallback:win32:<USERPROFILE>:<USERNAME>`) and crosses IPC together with every ciphertext entry; the decrypted key then flows into localStorage (chains WH-03).
- **Impact:** any script running in the webview (chain WH-02/WH-04) can invoke the command and recover ZCode's z.ai coding-plan key in plaintext.
- **Mitigation:** do the AES-GCM decryption in Rust (`sha2` already a dependency; add `aes-gcm`; entries are unpadded base64url — normalize `-`→`+` or use `URL_SAFE_NO_PAD`); return only a provider entry (no `secret`, no `iv`/`tag`/`ct`), ideally handing the key straight to the WH-03 keyring.
- **Safe verification:** the command's serialized response contains no `secret`/`iv`/`tag`/`ct` fields (unit-test the serde shape); ZCode detection still yields a usable provider on a machine with ZCode installed.

### WH-06 — Auth header visible in `curl` argv · Low · Confidence: High

- **Files:** `src-tauri/src/ai.rs:45-52` (`x-api-key: {api_key}` and `Authorization: Bearer {api_key}` in `cmd.args`, in `ai_chat()`) **and** a second site at `ai.rs:631` (same Bearer argv pattern).
- **Impact:** the credential is visible in local process listings (Task Manager / WMI / `ps`) for the duration of each AI request — relevant on shared or monitored machines.
- **Mitigation:** write the header line(s) to a short-lived temp file (0600, user temp dir) and pass `curl -H @<file>` (curl ≥ 7.55); delete on **all** exit paths (drop guard). Fix **both** sites — locate with `grep -n "Authorization: Bearer" src-tauri/src/ai.rs` (currently 2 matches).
- **Safe verification:** while a long request is in flight, the spawned curl's command line contains no `Authorization:`/`x-api-key:` value.

---

## Items needing review (not confirmed vulnerabilities)

1. **Code scanning / Dependabot not readable this session** (404 + missing `admin:repo_hook` scope; Dependabot returned 0 alerts). Recommend enabling code scanning and re-running the alert check; dependency CVE cross-check of `package-lock.json` / `Cargo.lock` is still outstanding.
2. **Secret scanning disabled** — enable alongside WH-01 rotation; push protection prevents recurrence.
3. **Updater key custody** — `scripts/build-updater-json.mjs` + `.github/workflows/release.yml`: confirm the updater **private** key exists only as a CI secret (the `pubkey` in `tauri.conf.json` is public and correct).
4. **Pending uncommitted diff** on `src/screens/explorer/AiAgentPanel.tsx` (+180/−47) and `src/app/AppShell.tsx` — visible portions showed no security-relevant change; whoever commits should re-check the remainder.
5. **`.pigry/` runtime artifacts tracked in git** — transcripts/memory now only carry redacted prefixes, but user-pasted tokens could appear in future transcripts; gitignore the directory (ties into WH-01).

## Verified positive controls (no action)

- `src-tauri/capabilities/default.json` — minimal permission set; no shell/fs plugins exposed to the webview.
- Updater: HTTPS endpoint + signing pubkey present; artifacts opted in.
- `gh.rs` — argv-array invocation only; credentials delegated to the `gh` CLI's own store.
- SSH workspace relay — loopback listener, 32-byte random handshake token, shell-quoted bootstrap, `ClearAllForwardings=yes`.
- `web.rs` / `devtools.rs` — URL scheme restricted to `http(s)` before spawning browsers; CDP attach compiled out of release builds.
- `src-remote` — stdin/stdout only, no network listener.
- `docs/auth-validation.json`, `docs/github-validation.json` — booleans/scopes only, no live tokens (re-checked by the earlier pass; no `ghp_`/`github_pat_` literals repository-wide).
- `markdown.tsx` — text-only React rendering, external links get `rel="noreferrer"`.

## Scope & limits

- Source inspection of the authorized repository only; no dynamic testing, no exploit construction, no live probing.
- GitHub alert APIs partially unavailable (see above); all findings above are source-verified independently.
- The long tail of `src-tauri/src/ai.rs` was surveyed via targeted search plus partial reads; both Bearer sites were confirmed by exact-match search.

**Fix handoff for @coder:** `.pigry/reports/white-hat/handoff-coder-security-fixes.md` (ordered, independently mergeable tasks with acceptance criteria).
**Prior detailed reports:** `.pigry/reports/white-hat/security-review-pigry-desktop.md`, `.pigry/reports/white-hat/security-fix-handoff-coder.md` (untracked working-tree copies; WH-01 evidence refined by this pass).
