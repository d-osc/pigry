#!/usr/bin/env node
/** Playwright engine for the in-app E2E runner (the "Playwright" browsers of the E2E Testing browser picker).
 *
 * src-tauri/src/pw_engine.rs embeds this file, starts it with `node` in the open repository and sends one JSON
 * request per line on stdin: {"id": 1, "action": "open", "url": "...", "js": "...", "waitMs": 0}. Every answer is one
 * JSON line on stdout: {"id": 1, "ok": true, "result": "..."} or {"id": 1, "ok": false, "error": "..."}.
 * The actions are the browser_devtools ones (open, eval, init_script, screenshot, input, cookies, set_cookie,
 * clear_cookies, headers, viewport, color_scheme, console, network, dom, record_start, record_stop, close), so the
 * runner behaves as with the CDP / WebDriver BiDi test window — plus WebKit, and video in every browser.
 *
 * Playwright itself comes from the repository (playwright, @playwright/test or playwright-core), else from the
 * global npm folder. Environment: PIGRY_PW_BROWSER (chromium | firefox | webkit), PIGRY_PW_WEB_SECURITY ("off"). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const BROWSER = process.env.PIGRY_PW_BROWSER || 'chromium';
const NO_WEB_SECURITY = process.env.PIGRY_PW_WEB_SECURITY === 'off';
const root = process.cwd();
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/* ---------------------------------------------------------------- Playwright */

async function loadPlaywright() {
  const bases = [path.join(root, 'package.json')];
  if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'pigry.js'));
  for (const dir of (process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)) bases.push(path.join(dir, 'pigry.js'));
  for (const base of bases) {
    const require = createRequire(base);
    for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
      let resolved;
      try { resolved = require.resolve(name); } catch { continue; }
      const mod = await import(pathToFileURL(resolved).href);
      const pw = mod[BROWSER] ? mod : mod.default;
      if (pw?.[BROWSER]) return pw;
    }
  }
  throw new Error('Playwright is not installed for this repository — run "npm i -D @playwright/test" and "npx playwright install" in it, or pick another browser');
}

/** "page.evaluate: ReferenceError: x is not defined\n    at …" → "ReferenceError: x is not defined". */
export function cleanError(error) {
  const text = String(error?.message ?? error);
  const first = text.split('\n').find((line) => line.trim()) ?? text;
  return first.replace(/^(page|frame|locator|browserContext|browserType|elementHandle|route|video)\.\w+: /, '').trim();
}

const RESOURCE = { document: 'Document', xhr: 'Xhr', fetch: 'Fetch', script: 'Script', stylesheet: 'Stylesheet', image: 'Image', font: 'Font', media: 'Media', manifest: 'Manifest', websocket: 'WebSocket' };
const LEVEL = { log: 'Log', warning: 'Warning', error: 'Error', info: 'Info', debug: 'Debug', trace: 'Trace', assert: 'Assert', dir: 'Dir', table: 'Table' };
const MODIFIERS = [[1, 'Alt'], [2, 'Control'], [4, 'Meta'], [8, 'Shift']];

let pw = null;
let browser = null;
let context = null;
let page = null;
const st = { init: '', headers: {}, viewport: { ...DEFAULT_VIEWPORT }, colorScheme: null, console: [], net: [], video: null, held: 0 };

function wire(p) {
  p.on('console', (m) => {
    st.console.push(`[${LEVEL[m.type()] ?? 'Log'}] ${JSON.stringify(m.text())}`);
    if (st.console.length > 200) st.console.shift();
  });
  p.on('pageerror', (e) => st.console.push(`[Error] ${e.message}`));
  const rows = new WeakMap();
  p.on('request', (req) => {
    const row = { method: req.method(), url: req.url(), status: 0, type: '', size: 0, failed: false, resource: RESOURCE[req.resourceType()] ?? 'Other', time_ms: 0, request_headers: req.headers(), started: Date.now() };
    const body = req.postData();
    if (body) row.request_body = body;
    rows.set(req, row);
    st.net.push(row);
  });
  p.on('response', (res) => {
    const row = rows.get(res.request());
    if (!row) return;
    row.status = res.status();
    row.response_headers = res.headers();
    row.type = (row.response_headers['content-type'] ?? '').split(';')[0].trim();
  });
  p.on('requestfinished', async (req) => {
    const row = rows.get(req);
    if (!row) return;
    row.time_ms = Math.max(0, Date.now() - row.started);
    const sizes = await req.sizes().catch(() => null);
    if (sizes) row.size = sizes.responseBodySize + sizes.responseHeadersSize;
    if ((row.resource === 'Xhr' || row.resource === 'Fetch') && row.size < 500_000) {
      const res = await req.response().catch(() => null);
      const text = res ? await res.text().catch(() => null) : null;
      if (text != null) row.response_body = text;
    }
  });
  p.on('requestfailed', (req) => { const row = rows.get(req); if (row) { row.failed = true; row.time_ms = Math.max(0, Date.now() - row.started); } });
}

/** The init script runs before the page's own scripts: it is put at the top of every HTML document (what
 * Page.addScriptToEvaluateOnNewDocument does on the CDP path — Playwright cannot remove an addInitScript). */
async function injectInit(route) {
  const req = route.request();
  if (req.resourceType() !== 'document' || !st.init) return route.continue().catch(() => undefined);
  let resp;
  try { resp = await route.fetch(); } catch { return route.continue().catch(() => undefined); }
  const headers = { ...resp.headers() };
  if (!/html/i.test(headers['content-type'] ?? '')) return route.fulfill({ response: resp });
  const script = `<script>${st.init.split('</script>').join('<\\/script>')}</script>`;
  const html = await resp.text();
  const body = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + script) : script + html;
  for (const h of ['content-security-policy', 'content-security-policy-report-only', 'content-length', 'content-encoding']) delete headers[h];
  return route.fulfill({ response: resp, body, headers });
}

async function newContext(recordDir, storageState) {
  const ctx = await browser.newContext({
    viewport: st.viewport, storageState, ...(recordDir ? { recordVideo: { dir: recordDir, size: st.viewport } } : {}),
  });
  await ctx.route('**/*', injectInit);
  if (Object.keys(st.headers).length) await ctx.setExtraHTTPHeaders(st.headers);
  const p = await ctx.newPage();
  wire(p);
  if (st.colorScheme) await p.emulateMedia({ colorScheme: st.colorScheme });
  context = ctx;
  page = p;
}

async function launch() {
  pw = await loadPlaywright();
  const type = pw[BROWSER];
  const options = { headless: process.env.PIGRY_PW_HEADLESS === '1' };
  if (BROWSER === 'chromium' && NO_WEB_SECURITY) options.args = ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'];
  if (BROWSER === 'firefox' && NO_WEB_SECURITY) options.firefoxUserPrefs = { 'content.cors.disable': true, 'security.mixed_content.block_active_content': false };
  try { browser = await type.launch(options); } catch (error) {
    const text = cleanError(error);
    throw new Error(/Executable doesn't exist|npx playwright install/i.test(String(error?.message)) ? `Playwright's ${BROWSER} is not installed — run "npx playwright install ${BROWSER}"` : text);
  }
  await newContext();
}

/** Moves to a new context (to start or stop a video), keeping cookies, storage and the open page. */
async function replaceContext(recordDir) {
  const storage = await context.storageState().catch(() => undefined);
  const url = page.url();
  const old = context;
  const oldPage = page;
  await newContext(recordDir, storage);
  if (/^https?:/.test(url)) await page.goto(url, { waitUntil: 'load' }).catch(() => undefined);
  return { old, oldPage };
}

/* ---------------------------------------------------------------- actions */

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const json = (value) => JSON.stringify(value === undefined ? null : value, null, 2);

async function pressHeld(want) {
  for (const [bit, key] of MODIFIERS) {
    if (want & bit && !(st.held & bit)) await page.keyboard.down(key);
    else if (!(want & bit) && st.held & bit) await page.keyboard.up(key);
  }
  st.held = want;
}

const KEY_ALIASES = { Esc: 'Escape', Del: 'Delete', Space: ' ' };
const keyOf = (e) => KEY_ALIASES[e.key] ?? e.key ?? e.text ?? '';
const buttonOf = (b) => (b === 'right' ? 'right' : b === 'middle' ? 'middle' : 'left');

async function input(events) {
  try {
    for (const e of events) {
      await pressHeld((e.mods ?? 0) & 15);
      if (e.t === 'move') await page.mouse.move(e.x ?? 0, e.y ?? 0);
      else if (e.t === 'down' || e.t === 'up') {
        if (e.button !== 'none') {
          await page.mouse.move(e.x ?? 0, e.y ?? 0);
          await page.mouse[e.t]({ button: buttonOf(e.button), clickCount: e.clicks ?? 1 });
        }
      } else if (e.t === 'wheel') { await page.mouse.move(e.x ?? 0, e.y ?? 0); await page.mouse.wheel(e.dx ?? 0, e.dy ?? 0); }
      else if (e.t === 'keydown') await page.keyboard.down(keyOf(e));
      else if (e.t === 'keyup') await page.keyboard.up(keyOf(e));
      else if (e.t === 'text') await page.keyboard.insertText(e.text ?? '');
      else throw new Error(`unknown input event type: ${e.t}`);
      if (e.delay) await sleep(Math.min(e.delay, 5000));
    }
  } finally {
    await pressHeld(0).catch(() => undefined);
  }
  return `${events.length} input events dispatched`;
}

async function summary(url, waitMs) {
  if (waitMs > 0) await sleep(Math.min(waitMs, 20_000));
  const title = await page.title().catch(() => '');
  const text = await page.evaluate("document.body ? document.body.innerText.slice(0, 6000) : ''").catch(() => '');
  return `opened ${url}\ntitle: ${title}\n\n${String(text).slice(0, 4000)}`;
}

const ACTIONS = {
  async open({ url, waitMs }) {
    if (!browser) await launch();
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    return summary(url, waitMs ?? 0);
  },
  async eval({ js }) { return json(await page.evaluate(js)); },
  async init_script({ js }) {
    st.init = js ?? '';
    return st.init.trim() ? `init script registered (${st.init.length} bytes)` : 'init script cleared';
  },
  async screenshot({ url, js }) {
    const opts = js ? JSON.parse(js) : {};
    fs.mkdirSync(path.dirname(url), { recursive: true });
    const clip = opts.clip && opts.clip.w >= 1 && opts.clip.h >= 1 ? { x: opts.clip.x, y: opts.clip.y, width: opts.clip.w, height: opts.clip.h } : undefined;
    await page.screenshot({ path: url, ...(clip ? { fullPage: true, clip } : opts.fullPage ? { fullPage: true } : {}) });
    return url;
  },
  async input({ js }) { return input(JSON.parse(js || '[]')); },
  async cookies() {
    const all = await context.cookies();
    return JSON.stringify(all.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, expires: c.expires, sameSite: c.sameSite })));
  },
  async set_cookie({ js }) {
    const c = JSON.parse(js || '{}');
    if (!c.name) throw new Error('cookie needs a name');
    const base = { name: c.name, value: String(c.value ?? ''), httpOnly: !!c.httpOnly, secure: !!c.secure, ...(c.expires > 0 ? { expires: c.expires } : {}) };
    const here = page.url();
    const url = c.url ?? (/^https?:/.test(here) ? here : null);
    if (!c.domain && !url) throw new Error('the cookie needs a domain — open a page first');
    await context.addCookies([c.domain ? { ...base, domain: c.domain, path: c.path ?? '/' } : { ...base, url }]);
    return `cookie ${c.name} set`;
  },
  async clear_cookies({ js }) {
    const name = (js ?? '').trim();
    if (!name) { await context.clearCookies(); return 'all cookies cleared'; }
    const count = (await context.cookies()).filter((c) => c.name === name).length;
    await context.clearCookies({ name });
    return `${count} cookie(s) named ${name} deleted`;
  },
  async headers({ js }) {
    const value = JSON.parse(js?.trim() ? js : '{}');
    st.headers = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    await context.setExtraHTTPHeaders(st.headers);
    return 'headers set';
  },
  async viewport({ js }) {
    const [w, h, mobile] = String(js ?? '').split(',').map((s) => s.trim());
    const width = Number(w) || 0, height = Number(h) || 800;
    if (width <= 0) { st.viewport = { ...DEFAULT_VIEWPORT }; await page.setViewportSize(st.viewport); return 'viewport restored to the real window size'; }
    if (width < 200 || width > 4000 || height < 200 || height > 4000) throw new Error('viewport width/height must be between 200 and 4000');
    st.viewport = { width, height };
    await page.setViewportSize(st.viewport);
    return `viewport set to ${width}x${height}${mobile === 'true' ? ' (Playwright can only switch mobile emulation for a new context — only the size changed)' : ''}`;
  },
  async color_scheme({ js }) {
    const scheme = String(js ?? '').trim().toLowerCase();
    st.colorScheme = scheme === 'light' || scheme === 'dark' ? scheme : null;
    await page.emulateMedia({ colorScheme: st.colorScheme });
    return st.colorScheme ? `emulating prefers-color-scheme: ${st.colorScheme}` : 'color scheme emulation cleared';
  },
  async console() { return JSON.stringify(st.console); },
  /** Every request so far (the export in devtools.rs picks those after its mark); waits up to 3 s for API calls in flight. */
  async network() {
    for (let i = 0; i < 30 && st.net.some((r) => (r.resource === 'Xhr' || r.resource === 'Fetch') && r.status === 0 && !r.failed); i++) await sleep(100);
    await sleep(300);
    return JSON.stringify(st.net.map((row) => { const copy = { ...row }; delete copy.started; return copy; }));
  },
  async dom() { return page.content(); },
  async record_start({ url, js }) {
    if (st.video) throw new Error('a recording is already running — call record_stop first');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigry-pw-video-'));
    const { old } = await replaceContext(dir);
    await old.close().catch(() => undefined);
    st.video = { dest: url, label: js || url, dir, started: Date.now() };
    return `recording started → ${st.video.label}`;
  },
  async record_stop() {
    if (!st.video) throw new Error('no recording is running — call record_start first');
    const { dest, label, dir, started } = st.video;
    st.video = null;
    const video = page.video();
    const { old } = await replaceContext(undefined);
    await old.close().catch(() => undefined);
    if (!video) throw new Error('the recording produced no video data');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await video.saveAs(dest);
    fs.rmSync(dir, { recursive: true, force: true });
    const kb = Math.round(fs.statSync(dest).size / 1024);
    return `video saved to ${label} (${((Date.now() - started) / 1000).toFixed(1)}s, ${kb} KB)`;
  },
  async close() {
    await browser?.close().catch(() => undefined);
    browser = null;
    setTimeout(() => process.exit(0), 50);
    return 'devtools session closed';
  },
};

/* ---------------------------------------------------------------- protocol */

const reply = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

export async function handle(request) {
  const run = ACTIONS[request.action];
  if (!run) return { id: request.id, ok: false, error: `unknown devtools action: ${request.action}` };
  if (!page && request.action !== 'open' && request.action !== 'close' && request.action !== 'init_script') {
    return { id: request.id, ok: false, error: 'no devtools session — call browser_devtools with action "open" first' };
  }
  try { return { id: request.id, ok: true, result: String(await run(request)) }; } catch (error) { return { id: request.id, ok: false, error: cleanError(error) }; }
}

// PIGRY_PW_BRIDGE_TEST=1 lets the unit tests import the helpers without starting the protocol loop
if (process.env.PIGRY_PW_BRIDGE_TEST !== '1') {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    void handle(request).then(reply);
  });
  // the app went away: close the browser with it
  lines.on('close', () => { void (browser?.close() ?? Promise.resolve()).finally(() => process.exit(0)); });
}
