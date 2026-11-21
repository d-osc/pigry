# Security Fix Handoff — for @coder

From: @white-hat · Basis: [verified review](./security-review-pigry-desktop-verified.md) (all findings re-confirmed against `main` @ `5f9c108`)

Tasks are ordered by risk and **independently mergeable** (one PR each is fine). Acceptance criteria are phrased as expected protective behavior — never as exploit reproduction.

> **Project rule:** run `cargo test -- --test-threads=1` from `src-tauri/` before every commit. Frontend: `npm test` and, where noted, `npm run test:ui`.

---

## ⚠️ Owner actions first (not fixable in code) — WH-01

1. **Rotate/revoke** both leaked keys (`sk-sp-H.DIMED…` 93 chars; `c466230f…` 38 chars) at their providers.
2. Enable GitHub **secret scanning + push protection** (currently disabled).
3. Decide on history purge (`git filter-repo`/BFG) vs rotation-only.

Code changes below stop the bleeding; they cannot un-leak history.

---

## Task 1 — WH-01 (code part): remove plaintext seed keys · Critical

**File:** `src/lib/aiProviders.ts:17-20`

1. Delete both literal keys from `SEED_TEST_KEYS`. Compute their SHA-256 hex digests **locally** (e.g. `echo -n '<key>' | sha256sum` — `-n` matters; do not trust pre-computed values) and store the two digests instead.
2. Change `dropTestProviders()` to compare `sha256(entry.apiKey)` against the digest list. Keep `entry.id !== 'zai-test'` as-is; only the qwen-cloud comparison changes.
3. Implementation options for hashing in the frontend: **(A)** new Rust command (e.g. `drop_seed_providers`) — `sha2` is already a backend dependency; or **(B)** small pure-JS SHA-256 inside `aiProviders.ts`. Avoid forcing `loadProviders()` async (`crypto.subtle`); it is synchronous and widely used.
4. Add `.pigry/` to `.gitignore` (runtime artifacts; also listed under owner actions).

**Acceptance:** repository-wide search for each key's mid-string substring returns zero hits; a stored provider still holding a seeded key is still dropped on load (unit-test with the digest, not the key); existing `tests/` pass.

---

## Task 2 — WH-04: sanitize Office previews · Medium

**Files:** `src/screens/explorer/FileViewers.tsx:146` (docx), `:182` (xlsx)

1. `npm i dompurify` (v3 ships types). `rehype-sanitize` does **not** cover these raw HTML strings — it is markdown-pipeline only.
2. Sanitize both injection points: allowlist tags (tables, `p`, `span`, `strong`, `em`, `ul`, `ol`, `li`, `a`, `img`), attributes (`colspan`, `rowspan`, `href`, `src`, `alt`). Add an `afterSanitizeAttributes` hook forcing `a.target="_blank"`, `a.rel="noreferrer noopener"`, and stripping `img.src` unless it starts with `data:`.
3. Add a regression fixture whose markup contains script / event-handler / remote-image content; a test must assert it does not survive sanitization.

**Acceptance:** sanitized output contains no `<script`, no `on*=` attributes, no non-`data:` img src; `npm test` + a UI spec opening the fixture pass; `dev-demo/sample.docx` / `sample.xlsx` still render.

---

## Task 3 — WH-02: enable webview CSP · High

**File:** `src-tauri/tauri.conf.json` (`app.security.csp: null`)

1. Set `app.security.csp` to:
   `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'`
2. Add `app.security.devCsp` allowing `ws://localhost:1420` + `http://localhost:1420` for Vite HMR (dev only).
3. AI provider traffic runs through Rust `ai_chat` (curl) — do **not** widen `connect-src` for providers.
4. Check `tauri.windows.conf.json` / `tauri.macos.conf.json` don't re-widen `security`.
5. The PDF blob iframe needs `frame-src 'self' blob:` (included). If a legitimate flow breaks, loosen only the minimum directive and document why.

**Acceptance:** `npm run build` + `npm run test:ui` pass; manual smoke: app boots, AI chat works, md/pdf/docx previews render, devtools shows the CSP blocking the Task-2 fixture's inline script.

---

## Task 4 — WH-05: decrypt ZCode credentials in Rust · Medium

**Files:** `src-tauri/src/ai.rs:71-137` (`ZcodeCreds`, `zcode_creds()`), `src-tauri/src/commands.rs:1485`, `src/lib/zcode.ts:26-57`

1. Add `aes-gcm = "0.10"` to `src-tauri/Cargo.toml` (`sha2`, `base64` already present).
2. In Rust: derive `key = Sha256(secret)` keeping `secret` local to the function; decrypt each `enc:v1:iv.tag.ct` entry (entries are **unpadded base64url** — the JS layer currently normalizes `-`→`+`; use `URL_SAFE_NO_PAD` and be tolerant of both).
3. Change the IPC surface: return only `{ name, type, model, baseUrl, account, exeFound }`; **remove `secret`, `iv`, `tag`, `ct` from the response entirely**. Ideally write the decrypted key straight into the Task-5 keyring instead of returning it to the webview (chain Tasks 4+5 if convenient).
4. `detectZcodeGlm()` in `zcode.ts` becomes a thin call; drop the WebCrypto decryption path.

**Acceptance:** serialized response has no `secret`/`iv`/`tag`/`ct` fields (unit-test the serde shape); ZCode detection still yields a usable provider; `cargo test -- --test-threads=1` from `src-tauri/` passes.

---

## Task 5 — WH-03: OS keyring for provider keys · High (larger task)

**Files:** `src/lib/aiProviders.ts` (lines 11-12, ≈135-152, ≈322-338), new Rust commands, the `ai_chat` call path

1. Add the `keyring` crate; commands `provider_key_set(id, key)`, `provider_key_get(id)`, `provider_key_delete(id)` scoped per provider id (service = app identifier).
2. localStorage keeps metadata only — persist `apiKey: ''` (or `hasKey: true`); **remove the `apiKey` field from `writeLegacyMirror()`** (it currently duplicates the key into `pigry:ai-provider`) or drop the whole mirror.
3. One-time migration: on load, move existing plaintext keys into the keyring and clear them from storage.
4. `aiChat()` passes a provider id; Rust resolves the key from the keyring. ZCode's decrypted key (Task 4) writes straight to the keyring.

**Acceptance:** devtools → Application → localStorage shows no `apiKey` under either key; AI chat authenticates end-to-end; migration unit test covers old-shape → keyring.

---

## Task 6 — WH-06: keep auth header out of curl argv · Low

**Files:** `src-tauri/src/ai.rs:45-52` and `ai.rs:631` (both sites)

Write the header line(s) (`Authorization: Bearer …` / `x-api-key: …` / `anthropic-version`) to a temp file with 0600 perms in the user temp dir, pass `curl -H @<path>` (curl ≥ 7.55), and delete the file on **all** exit paths (a drop guard, including on error).

**Acceptance:** `cargo test -- --test-threads=1` passes; while a long request is in flight the spawned curl's command line contains no `Authorization:`/`x-api-key:` value (Task Manager / `wmic process`).

---

## Suggested order

1 → 2 → 3 → 4 → 5 → 6 (4 and 5 pair well). Don't batch Task 3 (CSP) with unrelated edits so e2e regressions stay attributable.

## Open items @coder cannot close alone

- Key rotation, secret-scanning enablement, history purge (owner).
- Code-scanning / Dependabot alerts were unreadable from this session — re-check after enabling.
