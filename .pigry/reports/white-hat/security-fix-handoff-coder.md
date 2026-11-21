# Security Fix Handoff — for @coder

From: @white-hat · Basis: [`security-review-pigry-desktop.md`](./security-review-pigry-desktop.md) (all findings re-verified against HEAD `5f9c108` / `main`)

Work items are ordered by risk and are **independently mergeable** — one PR each is fine. Acceptance criteria are phrased as safe verification (expected protective behavior), never as exploit reproduction.

> **Project rule:** run `cargo test -- --test-threads=1` from `src-tauri/` before every commit. Frontend: `npm test` (node) and `npm run test:ui` (Playwright) where noted.

---

## ⚠️ Owner actions first (not fixable in code) — WH-01

1. **Rotate/revoke** the two leaked keys (`sk-sp-H.DIMED…` 93 chars; `c466230f…` 38 chars) at their providers.
2. Enable GitHub **secret scanning + push protection**.
3. Decide on history purge (`git filter-repo`/BFG) or accept rotation-only.

Flag these in the PR/issue; code changes below stop the bleeding but do not un-leak history.

---

## Task 1 — WH-01 (code part): remove plaintext seed keys · Critical

**File:** `src/lib/aiProviders.ts:14-20`

Replace the two literal keys in `SEED_TEST_KEYS` with their **SHA-256 hex digests**. `dropTestProviders()` must compare `sha256(entry.apiKey)` against the digest list instead of `SEED_TEST_KEYS.includes(entry.apiKey)`.

Two implementation options (pick one):

- **A (no new JS deps):** new Rust command, e.g. `drop_seed_providers(entries) -> filtered`, in `ai.rs`/`commands.rs` — `sha2` is already a backend dependency. Call it from the load path (it may be async; keep the synchronous `loadProviders()` shape by filtering on first async touch, or migrate carefully).
- **B (frontend-only):** small pure-JS SHA-256 (~40 lines, MIT-licensed reference implementations exist) inside `aiProviders.ts`. Avoid `crypto.subtle` here — `loadProviders()` is synchronous and used widely; forcing it async is an invasive refactor.

Keep the `entry.id !== 'zai-test'` condition as-is; only the qwen-cloud comparison changes.

**Acceptance:** `grep -r "sk-sp-" src/` and `grep -r "c466230f" src/` return nothing; a stored provider still holding the old seeded key is still dropped on load (unit-test with the *digest*, not the key); all existing `tests/` pass.

---

## Task 2 — WH-04: sanitize Office previews · Medium

**Files:** `src/screens/explorer/FileViewers.tsx:146` (docx), `:182` (xlsx)

1. `npm i dompurify` (v3 ships its own types). Note: existing `rehype-sanitize` only covers react-markdown pipelines — it cannot sanitize these raw HTML strings.
2. Sanize before injecting:
   - `DOMPurify.sanitize(mammothResult.value, { ALLOWED_TAGS: [...tables, p, span, strong, em, ul, ol, li, a, img...], ALLOWED_ATTR: ['colspan','rowspan','href','src','alt'] })`
   - Add a DOMPurify `afterSanitizeAttributes` hook forcing `a.target=_blank`, `a.rel=noreferrer noopener`, and stripping `img.src` unless it starts with `data:`.
   - Same for `XLSX.utils.sheet_to_html(...)` output.
3. Add a regression fixture (e.g. `dev-demo/` sibling or a test-only generated file) whose markup contains script/event-handler/remote-image payloads; a test must assert they do not survive sanitization.

**Acceptance:** sanitized output contains no `<script`, no `on*=` attributes, no non-`data:` img src; `npm test` + a UI spec opening the fixture passes; preview still renders `dev-demo/sample.docx` / `sample.xlsx` correctly.

---

## Task 3 — WH-02: enable webview CSP · High

**File:** `src-tauri/tauri.conf.json` (`app.security.csp: null`)

1. Set `app.security.csp` to:
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'`
2. Add `app.security.devCsp` that additionally allows `ws://localhost:1420` + `http://localhost:1420` for Vite HMR in dev only.
3. AI provider traffic goes through Rust `ai_chat` (curl), not webview fetch — do **not** widen `connect-src` for providers.
4. Check `tauri.windows.conf.json` / `tauri.macos.conf.json` don't override `security`.
5. Verify the PDF blob iframe (`frame-src 'self' blob:` covers it) and the embedded browser/webview surface still function; loosen only the minimum directive if a legitimate flow breaks, and document why.

**Acceptance:** `npm run build` + `npm run test:ui` pass; manual smoke: app boots, AI chat works, .md/.pdf/.docx previews render, devtools shows CSP violations *blocking* the Task-2 fixture's inline script.

---

## Task 4 — WH-05: decrypt ZCode credentials in Rust · Medium

**Files:** `src-tauri/src/ai.rs` (`ZcodeCreds`, `zcode_creds()`), `src/lib/zcode.ts:26-57`, plus `commands.rs`/`tauriClient.ts` wiring.

1. Add `aes-gcm = "0.10"` to `src-tauri/Cargo.toml` (`sha2`, `base64` already present).
2. In Rust: derive `key = Sha256(secret)` where `secret` stays **inside** the function; decrypt each `enc:v1:iv.tag.ct` entry (entries are **unpadded base64url** — the current JS normalizes `-`→`+`; use `URL_SAFE_NO_PAD` and verify format tolerance).
3. Replace the IPC surface: new command returns only `{ name, type, model, baseUrl, account }` (+ `exeFound`); **remove the `secret` field and ciphertext entries from the response entirely**. Ideally hand the decrypted key straight to the Task-5 keyring instead of returning it to the webview — chain Tasks 4+5 if convenient.
4. `detectZcodeGlm()` in `zcode.ts` becomes a thin call returning the provider entry; drop the WebCrypto decryption path.

**Acceptance:** the command's serialized response has no `secret`/`iv`/`tag`/`ct` fields (unit-test the serde shape); ZCode detection on a machine with ZCode installed still yields a usable provider; `cargo test -- --test-threads=1` from `src-tauri/` passes.

---

## Task 5 — WH-03: OS keyring for provider keys · High (larger task)

**Files:** `src/lib/aiProviders.ts` (lines 11-12, ~66, ~135-152, ~322-338), new Rust commands, `ai_chat` call path.

1. Add `keyring` crate; commands `provider_key_set(id, key)`, `provider_key_get(id)`, `provider_key_delete(id)` scoped per provider id (service = app identifier).
2. localStorage keeps metadata only — persist `apiKey: ''` (or a `hasKey: true` flag) in `LIST_KEY`; **remove `writeLegacyMirror()`'s `apiKey` field or the whole mirror** (line 138 currently duplicates the key into `pigry:ai-provider`).
3. One-time migration: on load, move any existing plaintext keys into the keyring and clear them from storage.
4. `ai_chat` (frontend `aiChat()`) should pass a provider id; Rust resolves the key from the keyring. ZCode's decrypted key (Task 4) writes straight to the keyring.

**Acceptance:** devtools → Application → localStorage shows no `apiKey` values under either key; AI chat still authenticates end-to-end (e2e spec with a dummy local provider if feasible); migration test covers the old-shape → keyring path.

---

## Task 6 — WH-06: keep auth header out of curl argv · Low

**File:** `src-tauri/src/ai.rs:36-52`

Write the header line(s) (`Authorization: Bearer …` / `x-api-key: …`) to a temp file with 0600 perms in the user temp dir, pass `curl -H @<path>` (curl ≥ 7.55), and delete the file on **all** exit paths (a drop guard, including on error).

**Acceptance:** `cargo test` passes; during a long-running request the spawned curl's command line contains no `Authorization:`/`x-api-key:` value (observable via Task Manager / `wmic process` on Windows).

---

## Suggested order

1 → 2 → 3 → 4 → 5 → 6 (4 and 5 pair well together). Each is independently mergeable; don't batch the CSP change with unrelated edits so e2e regressions are attributable.

## What I could not verify (for @coder / owner awareness)

- GitHub code-scanning/Dependabot alerts (API returned 404 / missing `admin:repo_hook` scope this session).
- Whether `docs/auth-validation.json` / `docs/github-validation.json` contain live tokens — please eyeball before the next release tag.
- The un-inspected remainder of the pending `AiAgentPanel.tsx` diff (visible portions looked like formatting churn).
