#!/usr/bin/env node
/** Headless E2E runner — the Cypress-style specs of the E2E Testing menu, run from the command line or CI.
 *
 *   node scripts/e2e-cli.mjs --base-url http://localhost:5173
 *   node scripts/e2e-cli.mjs --spec login --browser firefox --parallel 4 --reporter junit --retries 1
 *
 * It bundles the same runner the app uses (src/lib/e2e) and drives Playwright browsers (chromium, firefox,
 * webkit) instead of the app's DevTools test window. Exit code: 0 all passed, 1 test failures, 2 setup errors. */
import { exec as execCb } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/* ------------------------------------------------------------------ arguments */

const HELP = `Usage: node scripts/e2e-cli.mjs [options]

  --specs-dir <dir>      where the specs live; *.cy.js and *.cy.ts are found recursively (default: .pigry/e2e/specs, cypress/e2e and e2e, whichever exist)
  --spec <text>          only specs whose path contains this text (repeatable, comma separated)
  --grep <text>          only tests whose title contains this text
  --base-url <url>       overrides baseUrl
  --config <file>        settings file (default .pigry/e2e/e2e.config.json); e2e.env.json next to it adds env values
  --env k=v,k2=v2        environment variables for Cypress.env()
  --browser <name>       chromium (default) | firefox | webkit
  --headed               show the browser window
  --parallel <n>         run n specs at the same time (default 1)
  --retries <n>          retry failed tests
  --video                record a video of every spec
  --viewport <WxH>       e.g. 1280x720
  --timeout <ms>         default command timeout
  --out <dir>            results, videos, screenshots and JUnit XML (default .pigry/e2e/cli)
  --reporter <list|json|junit|dot>   console output (junit.xml and results are always written) (default list)
  --shard <i/n>          run only the i-th of n slices of the specs (split a suite over CI machines; every slice writes its own report.html and junit.xml)
  --replay               keep DOM snapshots of the last commands of every failed test and embed them in report.html (Test Replay, works offline)
  --merge <dirs>         do not run anything: merge the results of several --out directories (comma separated, e.g. CI shards) into --out: junit.xml, summary.json, report.html
  --serve [port]         run the self-hosted dashboard (our Cypress Cloud): records runs, balances specs across machines, flaky tests, Test Replay (--dir, --host, --token, --projects)
  --projects <file>      dashboard with several projects: {"projects": {"web": {"recordKey": "...", "readKey": "..."}}} — a key opens only its own project's runs (the --token key sees all)
  --record <url>         upload every spec result to a dashboard (--ci-build-id, --group, --key, --balance)
  --project <name>       with the --token key: which project the run belongs to (project keys decide it themselves)
  --ci-build-id <id>     machines with the same id and --group belong to one recorded run (default: GITHUB_RUN_ID, CI_PIPELINE_ID or BUILD_NUMBER)
  --balance              with --record: pull specs from the dashboard one at a time, slowest first, so parallel machines finish together
  --component [react|vue|custom]   component testing: start a Vite dev server for this project and serve cy.mount({ module }) pages (sets baseUrl)
  --help
`;

function parseArgs(argv) {
  const o = { specs: [], parallel: 1, reporter: 'list', browser: 'chromium', env: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[i + 1]; if (v === undefined) throw new Error(`${a} needs a value`); i += 1; return v; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--specs-dir') o.specsDir = next();
    else if (a === '--spec') o.specs.push(...next().split(',').map((x) => x.trim()).filter(Boolean));
    else if (a === '--grep') o.grep = next();
    else if (a === '--base-url') o.baseUrl = next();
    else if (a === '--config') o.config = next();
    else if (a === '--env') next().split(',').forEach((pair) => { const [k, ...v] = pair.split('='); if (k) o.env[k.trim()] = v.join('=').trim(); });
    else if (a === '--browser') o.browser = next();
    else if (a === '--headed') o.headed = true;
    else if (a === '--parallel') o.parallel = Math.max(1, Number(next()) || 1);
    else if (a === '--retries') o.retries = Math.max(0, Number(next()) || 0);
    else if (a === '--video') o.video = true;
    else if (a === '--viewport') { const m = /^(\d+)x(\d+)$/.exec(next()); if (!m) throw new Error('--viewport must look like 1280x720'); o.viewport = [Number(m[1]), Number(m[2])]; }
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--out') o.out = next();
    else if (a === '--shard') o.shard = next();
    else if (a === '--serve') { const v = argv[i + 1]; o.serve = v && /^[0-9]+$/.test(v) ? (i += 1, v) : true; }
    else if (a === '--host') o.host = next();
    else if (a === '--token') o.token = next();
    else if (a === '--projects') o.projects = next();
    else if (a === '--dir') o.dir = next();
    else if (a === '--record') o.record = next();
    else if (a === '--ci-build-id') o.ciBuildId = next();
    else if (a === '--group') o.group = next();
    else if (a === '--project') o.project = next();
    else if (a === '--key') o.key = next();
    else if (a === '--balance') o.balance = true;
    else if (a === '--replay') o.replay = true;
    else if (a === '--merge') o.merge = next().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--component') { const v = argv[i + 1]; o.component = v && !v.startsWith('-') ? (i += 1, v) : 'custom'; }
    else if (a === '--reporter') o.reporter = next();
    else throw new Error(`unknown option ${a} (see --help)`);
  }
  return o;
}

/* ------------------------------------------------------------------ component testing dev server */

const MOUNT_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>component</title><style>body{margin:0;padding:8px;font-family:system-ui,sans-serif}</style></head><body><div id="root"></div></body></html>';
const ADAPTERS = {
  '/__pigry/react.js': "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nexport function mountReact(el, Comp, props) { createRoot(el).render(React.createElement(Comp, props)); }\n",
  '/__pigry/vue.js': "import { createApp } from 'vue';\nexport function mountVue(el, Comp, props) { createApp(Comp, props).mount(el); }\n",
};

/** Starts the project's own Vite (falls back to this repo's) with a plugin serving /__pigry/mount.html and the adapters. */
async function startComponentServer(framework) {
  const { createRequire } = await import('node:module');
  let vitePath;
  try { vitePath = createRequire(path.join(root, 'package.json')).resolve('vite'); } catch { vitePath = path.join(repo, 'node_modules/vite/dist/node/index.js'); }
  const vite = await import(pathToFileURL(vitePath).href);
  const plugin = {
    name: 'pigry-component',
    enforce: 'pre',
    resolveId(id) { return ADAPTERS[id] ? `\0pigry:${id}` : null; },
    load(id) { return id.startsWith('\0pigry:') ? ADAPTERS[id.slice(7)] : null; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/__pigry/mount.html') return next();
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml('/__pigry/mount.html', MOUNT_HTML));
      });
    },
  };
  const server = await vite.createServer({ root, logLevel: 'error', plugins: [plugin], optimizeDeps: { include: framework === 'react' ? ['react', 'react-dom/client'] : framework === 'vue' ? ['vue'] : [] }, server: { port: 0, host: '127.0.0.1', strictPort: false }, clearScreen: false });
  await server.listen();
  const addr = server.httpServer.address();
  return { url: `http://127.0.0.1:${addr.port}`, close: () => server.close() };
}

/* ------------------------------------------------------------------ the bundled runner */

async function loadRunner() {
  const outDir = path.join(repo, 'node_modules', '.cache', 'pigry-e2e');
  const outFile = path.join(outDir, 'e2e-runner.mjs');
  const sources = fs.readdirSync(path.join(repo, 'src/lib/e2e')).map((f) => path.join(repo, 'src/lib/e2e', f));
  const newest = Math.max(...sources.map((f) => fs.statSync(f).mtimeMs));
  if (!fs.existsSync(outFile) || fs.statSync(outFile).mtimeMs < newest) {
    const { build } = await import(pathToFileURL(path.join(repo, 'node_modules/vite/dist/node/index.js')).href);
    await build({
      configFile: false, root: repo, logLevel: 'error',
      build: { ssr: true, outDir, emptyOutDir: false, minify: false, rollupOptions: { input: path.join(repo, 'src/lib/e2e/cli-entry.ts'), output: { format: 'es', entryFileNames: 'e2e-runner.mjs' } } },
      ssr: { noExternal: true },
    });
  }
  return import(`${pathToFileURL(outFile).href}?v=${fs.statSync(outFile).mtimeMs}`);
}

/* ------------------------------------------------------------------ the Playwright driver */

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const abs = (p) => path.resolve(root, p);
const ensureDir = (file) => fs.mkdirSync(path.dirname(file), { recursive: true });

async function createDriver(pw, opts, cfg, specKey) {
  const type = pw[opts.browser];
  if (!type) throw new Error(`unknown browser "${opts.browser}" (chromium, firefox or webkit)`);
  const args = opts.browser === 'chromium' && cfg.chromeWebSecurity === false ? ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'] : [];
  const browser = await type.launch({ headless: !opts.headed, args });
  const videoDir = path.join(root, 'node_modules', '.cache', 'pigry-e2e', 'video', specKey.replace(/[^\w-]+/g, '_'));
  const context = await browser.newContext({
    viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight }, ignoreHTTPSErrors: true,
    ...(cfg.video ? { recordVideo: { dir: videoDir, size: { width: cfg.viewportWidth, height: cfg.viewportHeight } } } : {}),
  });
  const page = await context.newPage();
  const state = { init: '', consoleLines: [], net: [], videoPath: null };
  page.on('console', (m) => { state.consoleLines.push(`[${m.type()}] ${m.text()}`); if (state.consoleLines.length > 200) state.consoleLines.shift(); });
  page.on('pageerror', (e) => state.consoleLines.push(`[pageerror] ${e.message}`));
  page.on('requestfinished', async (req) => {
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    const res = await req.response().catch(() => null);
    const t = req.timing();
    state.net.push({ method: req.method(), url: req.url(), status: res ? res.status() : 0, type: req.resourceType(), timeMs: t && t.responseEnd > 0 ? Math.round(t.responseEnd) : 0 });
  });
  // the page library and cy.intercept stubs must be active before the app's own scripts (what Page.addScriptToEvaluateOnNewDocument does in the app)
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (req.resourceType() !== 'document' || !state.init) return route.continue();
    let resp;
    try { resp = await route.fetch(); } catch { return route.continue().catch(() => undefined); }
    const ct = resp.headers()['content-type'] ?? '';
    if (!/html/i.test(ct)) return route.fulfill({ response: resp });
    const script = `<script>${state.init.split('</script>').join('<\\/script>')}</script>`;
    const body = (await resp.text()).replace(/<head[^>]*>/i, (m) => m + script);
    const headers = { ...resp.headers() };
    delete headers['content-security-policy']; delete headers['content-length']; delete headers['content-security-policy-report-only'];
    return route.fulfill({ response: resp, body, headers });
  });

  const driver = {
    open: async (url) => { await page.goto(url, { waitUntil: url === 'about:blank' ? 'load' : 'load' }); },
    eval: async (js) => { const v = await page.evaluate(js); return JSON.stringify(v === undefined ? null : v, null, 2); },
    initScript: async (js) => { state.init = js; },
    screenshot: async (rel, o) => {
      const file = abs(rel); ensureDir(file);
      await page.screenshot({ path: file, ...(o?.clip ? { fullPage: true, clip: { x: o.clip.x, y: o.clip.y, width: o.clip.w, height: o.clip.h } } : o?.fullPage ? { fullPage: true } : {}) });
    },
    viewport: async (w, h) => { await page.setViewportSize({ width: w, height: h }); },
    recordStart: async (rel) => { state.videoPath = rel; },
    recordStop: async () => {
      if (!state.videoPath) return;
      const video = page.video(); await page.close();
      if (video) { const file = abs(state.videoPath); ensureDir(file); await video.saveAs(file); }
    },
    networkExport: async (rel) => { const file = abs(rel); ensureDir(file); fs.writeFileSync(file, JSON.stringify(state.net, null, 2)); state.net = []; },
    console: async () => state.consoleLines.slice(-40).join('\n'),
    readFile: async (p) => { try { return fs.readFileSync(abs(p), 'utf8'); } catch { return null; } },
    writeFile: async (p, content) => { const file = abs(p); ensureDir(file); fs.writeFileSync(file, content); },
    exec: (command, timeoutSecs) => new Promise((resolve) => {
      execCb(command, { cwd: root, timeout: (timeoutSecs ?? 120) * 1000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}` }));
    }),
    close: async () => { await browser.close().catch(() => undefined); },
    input: async (events) => {
      for (const e of events) {
        if (e.t === 'move') await page.mouse.move(e.x, e.y);
        else if (e.t === 'down') await page.mouse.down({ button: e.button === 'right' ? 'right' : 'left', clickCount: e.clicks ?? 1 });
        else if (e.t === 'up') await page.mouse.up({ button: e.button === 'right' ? 'right' : 'left', clickCount: e.clicks ?? 1 });
        else if (e.t === 'wheel') await page.mouse.wheel(e.dx ?? 0, e.dy ?? 0);
        else if (e.t === 'keydown') await page.keyboard.down(e.key);
        else if (e.t === 'keyup') await page.keyboard.up(e.key);
        else if (e.t === 'text') await page.keyboard.insertText(e.text);
        if (e.delay) await new Promise((r) => setTimeout(r, e.delay));
      }
    },
    cookies: async () => (await context.cookies()).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, expires: c.expires })),
    setCookie: async (c) => { const url = page.url(); await context.addCookies([c.domain ? { name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/', httpOnly: !!c.httpOnly, secure: !!c.secure } : { name: c.name, value: c.value, url: /^https?:/.test(url) ? url : 'http://localhost/', httpOnly: !!c.httpOnly, secure: !!c.secure }]); },
    clearCookies: async (name) => { if (name) await context.clearCookies({ name }); else await context.clearCookies(); },
    setHeaders: async (h) => { await page.setExtraHTTPHeaders(h); },
  };
  return driver;
}

/* ------------------------------------------------------------------ main */

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.cy\.(js|ts)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function readResults(dir) {
  const out = [];
  const walkDir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walkDir(f); else if (e.name.endsWith('.json') && !e.name.endsWith('.replay.json')) { const r = readJson(f); if (r && typeof r.spec === 'string' && Array.isArray(r.tests)) out.push(r); } } };
  if (fs.existsSync(dir)) walkDir(dir);
  return out;
}

function writeReports(runner, opts, outRel, results, extra) {
  const suites = results.map((r) => runner.resultToJUnit(r).replace(/^<\?xml[^>]*\?>\s*<testsuites[^>]*>\s*/, '').replace(/\s*<\/testsuites>\s*$/, ''));
  const total = results.reduce((n, r) => n + r.tests.length, 0), failures = results.reduce((n, r) => n + r.failed, 0), skipped = results.reduce((n, r) => n + r.pending, 0);
  const NL = String.fromCharCode(10);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>${NL}<testsuites name="pigry-e2e" tests="${total}" failures="${failures}" skipped="${skipped}" time="${(extra.durationMs / 1000).toFixed(3)}">${NL}${suites.join(NL)}${NL}</testsuites>${NL}`;
  const junit = abs(`${outRel}/junit.xml`); ensureDir(junit); fs.writeFileSync(junit, xml);
  // run history (trend and flake detection across runs)
  const historyFile = abs(`${outRel}/history.json`);
  const history = readJson(historyFile) ?? [];
  history.push(runner.runPointOf(results, extra.startedAt, extra.durationMs));
  fs.writeFileSync(historyFile, JSON.stringify(history.slice(-50)));
  fs.writeFileSync(abs(`${outRel}/report.html`), runner.runToHtml(results, { durationMs: extra.durationMs, browser: extra.browser, shard: extra.shard, replays: extra.replays, history: history.slice(-50) }));
  const summary = { report: `${outRel}/report.html`, specs: results.length, tests: total, passed: results.reduce((n, r) => n + r.passed, 0), failed: failures, pending: skipped, durationMs: extra.durationMs, junit: `${outRel}/junit.xml`, failedSpecs: results.filter((r) => r.status !== 'passed').map((r) => r.spec) };
  fs.writeFileSync(abs(`${outRel}/summary.json`), JSON.stringify(summary, null, 2));
  return { summary, xml };
}

const slashes = (p) => p.split(String.fromCharCode(92)).join('/');

/** Our stand-in for a cloud dashboard: merge the outputs of CI shards into one report. */
function mergeRuns(runner, opts) {
  const outRel = slashes(opts.out ?? '.pigry/e2e/cli');
  const lists = opts.merge.map((d) => readResults(path.join(abs(d), 'results')));
  const results = runner.mergeResults(lists);
  if (!results.length) { console.error(`no results found in ${opts.merge.join(', ')}`); return 2; }
  const replays = {};
  for (const d of opts.merge) {
    for (const r of results) {
      const f = path.join(abs(d), 'results', `${r.spec}.replay.json`);
      const rp = fs.existsSync(f) ? readJson(f) : null;
      if (rp) replays[r.spec] = rp;
    }
  }
  for (const r of results) {
    const f = abs(`${outRel}/results/${r.spec}.json`); ensureDir(f); fs.writeFileSync(f, JSON.stringify(r));
    if (replays[r.spec]) fs.writeFileSync(abs(`${outRel}/results/${r.spec}.replay.json`), JSON.stringify(replays[r.spec]));
  }
  const { summary, xml } = writeReports(runner, opts, outRel, results, { durationMs: results.reduce((n, r) => n + r.ms, 0), startedAt: Date.now(), browser: opts.browser, replays });
  if (opts.reporter === 'json') console.log(JSON.stringify({ summary }, null, 2));
  else if (opts.reporter === 'junit') console.log(xml);
  else console.log(`merged ${opts.merge.length} runs: ${summary.passed} passed, ${summary.failed} failed — ${summary.report}`);
  return summary.failed > 0 || results.some((r) => r.status === 'error') ? 1 : 0;
}

/* ------------------------------------------------------------------ self-hosted dashboard (our Cypress Cloud)
 *
 *   node scripts/e2e-cli.mjs --serve 4000 [--token secret] [--dir .pigry/e2e/dashboard] [--host 127.0.0.1]
 *   node scripts/e2e-cli.mjs --record http://host:4000 --ci-build-id $BUILD [--group chrome] [--balance] [--key secret]
 *
 * --record uploads every spec result (with its Test Replay) to the dashboard; with --balance several machines that share a
 * --ci-build-id pull specs from the server one by one (slowest first, from earlier runs) instead of using a fixed split. */

const SAFE_NAME = /^[\w./ @()-]+$/;
const safeName = (n) => typeof n === 'string' && n.length > 0 && n.length < 200 && SAFE_NAME.test(n) && !n.split('/').includes('..') && !n.startsWith('/');

function serveDashboard(runner, opts) {
  const dir = abs(opts.dir ?? '.pigry/e2e/dashboard');
  const runsDir = path.join(dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const runs = new Map();
  const projectsFile = opts.projects ? readJson(abs(opts.projects)) : null;
  if (opts.projects && !projectsFile?.projects) { console.error(`${opts.projects} must look like {"projects": {"name": {"recordKey": "...", "readKey": "..."}}}`); return Promise.resolve(2); }
  /** Who is asking: { project, write } — project '*' is the admin token (sees every project); null = refused. */
  const authOf = (req, url) => {
    const key = (req.headers.authorization ?? '').replace(/^Bearer /, '') || url.searchParams.get('key') || '';
    if (opts.token && key === opts.token) return { project: '*', write: true };
    for (const [name, k] of Object.entries(projectsFile?.projects ?? {})) {
      if (k.recordKey && key === k.recordKey) return { project: name, write: true };
      if (k.readKey && key === k.readKey) return { project: name, write: false };
    }
    return null;
  };
  const visible = (run, who) => who.project === '*' || (run.project ?? '') === who.project;
  for (const id of fs.readdirSync(runsDir)) { const meta = readJson(path.join(runsDir, id, 'run.json')); if (meta) runs.set(id, meta); }
  const save = (run) => { fs.mkdirSync(path.join(runsDir, run.id), { recursive: true }); fs.writeFileSync(path.join(runsDir, run.id, 'run.json'), JSON.stringify(run)); };
  const resultsOf = (run) => readResults(path.join(runsDir, run.id, 'results'));
  const replayOf = (run, spec) => readJson(path.join(runsDir, run.id, 'results', `${spec}.replay.json`));
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const summaryOf = (run) => {
    const rs = resultsOf(run);
    return { id: run.id, buildId: run.buildId, project: run.project ?? '', group: run.group, browser: run.browser, commit: run.commit, createdAt: run.createdAt, finishedAt: run.finishedAt ?? null, specs: run.specs.length, done: rs.length,
      passed: rs.reduce((n, r) => n + r.passed, 0), failed: rs.reduce((n, r) => n + r.failed, 0), pending: rs.reduce((n, r) => n + r.pending, 0), flaky: rs.reduce((n, r) => n + r.tests.filter((t) => t.flaky).length, 0),
      status: !run.finishedAt ? 'running' : rs.some((r) => r.status !== 'passed') ? 'failed' : 'passed' };
  };
  const finalize = (run) => {
    if (run.finishedAt) return;
    run.finishedAt = Date.now(); save(run);
    const rs = resultsOf(run);
    fs.writeFileSync(path.join(runsDir, run.id, 'junit.xml'), junitOf(runner, rs));
  };
  const lastMs = () => {
    const ms = new Map();
    for (const run of [...runs.values()].sort((a, b) => a.createdAt - b.createdAt)) for (const r of resultsOf(run)) ms.set(r.spec, r.ms);
    return ms;
  };
  const pointsOf = (who) => [...runs.values()].filter((r) => r.finishedAt && visible(r, who)).sort((a, b) => a.createdAt - b.createdAt).map((r) => runner.runPointOf(resultsOf(r), r.createdAt, (r.finishedAt ?? r.createdAt) - r.createdAt));

  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 40_000_000) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON')); } });
  });

  const indexHtml = (who, q) => {
    const list = [...runs.values()].filter((r) => visible(r, who)).sort((a, b) => b.createdAt - a.createdAt).map(summaryOf);
    const flaky = new Map();
    for (const run of runs.values()) for (const r of visible(run, who) ? resultsOf(run) : []) for (const t of r.tests) {
      if (t.status === 'pending') continue;
      const k = `${r.spec} › ${t.title.join(' › ')}`; const u = flaky.get(k) ?? { runs: 0, fails: 0, retried: 0 };
      u.runs += 1; if (t.status === 'failed') u.fails += 1; if (t.flaky) u.retried += 1; flaky.set(k, u);
    }
    const unstable = [...flaky.entries()].filter(([, u]) => (u.fails > 0 && u.fails < u.runs) || u.retried > 0).sort((a, b) => (b[1].fails + b[1].retried) / b[1].runs - (a[1].fails + a[1].retried) / a[1].runs).slice(0, 15);
    return `<!doctype html><html><head><meta charset="utf-8"><title>Pigry E2E dashboard</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#1f2430;background:#fafafa}table{border-collapse:collapse;background:#fff;width:100%;margin:8px 0 20px}td,th{border:1px solid #e3e5ea;padding:4px 8px;text-align:left}.passed{color:#1a7f37}.failed{color:#cf222e}.running{color:#9a6700}@media (prefers-color-scheme:dark){body{background:#14161a;color:#dde1e7}table{background:#1b1e24}td,th{border-color:#2c313a}a{color:#7ab7ff}}</style></head><body><h1>Pigry E2E dashboard</h1>`
      + `<h2>Runs</h2><table><tr><th>Build</th><th>Project</th><th>Group</th><th>Browser</th><th>Status</th><th>Specs</th><th>Passed</th><th>Failed</th><th>Flaky</th><th>Started</th></tr>${list.map((r) => `<tr><td><a href="/runs/${esc(r.id)}${q}">${esc(r.buildId)}</a></td><td>${esc(r.project)}</td><td>${esc(r.group)}</td><td>${esc(r.browser)}</td><td class="${r.status}">${r.status}</td><td>${r.done}/${r.specs}</td><td>${r.passed}</td><td>${r.failed}</td><td>${r.flaky}</td><td>${esc(new Date(r.createdAt).toISOString().replace('T', ' ').slice(0, 19))}</td></tr>`).join('') || '<tr><td colspan="10">No runs recorded yet.</td></tr>'}</table>`
      + (unstable.length ? `<h2>Flaky tests</h2><table><tr><th>Test</th><th>Failed</th><th>Needed retries</th><th>Runs</th></tr>${unstable.map(([k, u]) => `<tr><td>${esc(k)}</td><td>${u.fails}</td><td>${u.retried}</td><td>${u.runs}</td></tr>`).join('')}</table>` : '')
      + '</body></html>';
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      const secured = Boolean(projectsFile);
      const openMode = !opts.token && !projectsFile;
      const who = authOf(req, url) ?? (openMode ? { project: '*', write: true } : secured ? null : { project: '*', write: false });
      const q = url.searchParams.get('key') ? `?key=${encodeURIComponent(url.searchParams.get('key'))}` : '';
      if (!who && (secured || req.method !== 'GET')) return send(res, 401, { error: 'missing or wrong key' });
      if (req.method === 'GET' && parts.length === 0) return send(res, 200, indexHtml(who, q), 'text/html');
      if (req.method === 'GET' && parts[0] === 'runs' && parts[1]) {
        const run = runs.get(parts[1]); if (!run || !visible(run, who)) return send(res, 404, { error: 'unknown run' });
        const replays = {}; const rs = resultsOf(run);
        for (const r of rs) { const rp = replayOf(run, r.spec); if (rp) replays[r.spec] = rp; }
        return send(res, 200, runner.runToHtml(rs, { title: `Run ${run.buildId}${run.group ? ` · ${run.group}` : ''}`, browser: run.browser, durationMs: (run.finishedAt ?? Date.now()) - run.createdAt, replays, history: pointsOf(who) }), 'text/html');
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs') {
        if (!parts[2]) return send(res, 200, [...runs.values()].filter((r) => visible(r, who)).sort((a, b) => b.createdAt - a.createdAt).map(summaryOf));
        const run = runs.get(parts[2]); if (!run || !visible(run, who)) return send(res, 404, { error: 'unknown run' });
        if (parts[3] === 'junit') return send(res, 200, fs.existsSync(path.join(runsDir, run.id, 'junit.xml')) ? fs.readFileSync(path.join(runsDir, run.id, 'junit.xml'), 'utf8') : junitOf(runner, resultsOf(run)), 'application/xml');
        return send(res, 200, { ...summaryOf(run), results: resultsOf(run).map((r) => ({ spec: r.spec, status: r.status, passed: r.passed, failed: r.failed, pending: r.pending, ms: r.ms, machine: run.claimed[r.spec] ?? null })) });
      }
      if (req.method === 'POST' && parts[0] === 'api') {
        if (!who.write) return send(res, 401, { error: 'this key cannot record (read-only or missing record key)' });
        const body = await readBody(req);
        if (parts[1] === 'runs' && !parts[2]) {
          const specs = Array.isArray(body.specs) ? body.specs.filter(safeName) : [];
          if (!specs.length) return send(res, 400, { error: 'specs must be a list of spec names' });
          const buildId = String(body.buildId ?? '').slice(0, 120) || `build-${Date.now()}`;
          const group = String(body.group ?? '').slice(0, 80);
          const project = who.project === '*' ? String(body.project ?? '').slice(0, 60) : who.project;
          let run = [...runs.values()].find((r) => r.buildId === buildId && r.group === group && (r.project ?? '') === project && !r.finishedAt);
          if (!run) {
            run = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, buildId, project, group, browser: String(body.browser ?? '').slice(0, 40), commit: String(body.commit ?? '').slice(0, 80), createdAt: Date.now(), finishedAt: null, specs, claimed: {} };
            runs.set(run.id, run); save(run);
          }
          return send(res, 200, { id: run.id, specs: run.specs.length });
        }
        const run = runs.get(parts[2] ?? '');
        if (!run || !visible(run, who)) return send(res, 404, { error: 'unknown run' });
        if (parts[3] === 'claim') {
          const done = new Set(resultsOf(run).map((r) => r.spec));
          const ms = lastMs();
          const open = run.specs.filter((s) => !run.claimed[s] && !done.has(s)).sort((a, b) => (ms.get(b) ?? Infinity) - (ms.get(a) ?? Infinity));
          if (!open.length) return send(res, 200, { done: true });
          run.claimed[open[0]] = String(body.machine ?? 'machine').slice(0, 60); save(run);
          return send(res, 200, { spec: open[0], remaining: open.length - 1 });
        }
        if (parts[3] === 'results') {
          const r = body.result;
          if (!r || !safeName(r.spec) || !Array.isArray(r.tests)) return send(res, 400, { error: 'invalid result' });
          const base = path.join(runsDir, run.id, 'results', ...r.spec.split('/'));
          fs.mkdirSync(path.dirname(base), { recursive: true });
          fs.writeFileSync(`${base}.json`, JSON.stringify(r));
          if (body.replay) fs.writeFileSync(`${base}.replay.json`, JSON.stringify(body.replay));
          if (!run.specs.includes(r.spec)) { run.specs.push(r.spec); save(run); }
          if (resultsOf(run).length >= run.specs.length) finalize(run);
          return send(res, 200, { ok: true, finished: Boolean(run.finishedAt) });
        }
        if (parts[3] === 'finish') { finalize(run); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 400, { error: e.message }); }
  });
  const port = opts.serve === true ? 4000 : Number(opts.serve) || 0;
  return new Promise((resolve) => {
    server.on('error', (e) => { console.error(`dashboard could not start: ${e.message}`); resolve(2); });
    server.listen(port, opts.host ?? '127.0.0.1', () => {
      console.log(`dashboard http://${opts.host ?? '127.0.0.1'}:${server.address().port}  (data: ${path.relative(root, dir) || '.'})`);
      // runs until the process is stopped
    });
  });
}

function junitOf(runner, results) {
  const NL = String.fromCharCode(10);
  const suites = results.map((r) => runner.resultToJUnit(r).replace(/^<\?xml[^>]*\?>\s*<testsuites[^>]*>\s*/, '').replace(/\s*<\/testsuites>\s*$/, ''));
  const total = results.reduce((n, r) => n + r.tests.length, 0), failures = results.reduce((n, r) => n + r.failed, 0), skipped = results.reduce((n, r) => n + r.pending, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>${NL}<testsuites name="pigry-e2e" tests="${total}" failures="${failures}" skipped="${skipped}">${NL}${suites.join(NL)}${NL}</testsuites>${NL}`;
}

/** Client side of --record. */
function recorder(opts, specKeys) {
  const base = opts.record.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) };
  const post = async (p, body) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`dashboard ${res.status}: ${json.error ?? 'request failed'}`);
    return json;
  };
  const machine = `${os.hostname()}-${process.pid}`;
  let runId = null;
  return {
    async start() { runId = (await post('/api/runs', { buildId: opts.ciBuildId, group: opts.group, browser: opts.browser, project: opts.project, commit: process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA ?? '', specs: specKeys })).id; return runId; },
    claim: async () => (await post(`/api/runs/${runId}/claim`, { machine })).spec ?? null,
    upload: async (result, replay) => { await post(`/api/runs/${runId}/results`, { result, replay }); },
    link: () => `${base}/runs/${runId}`,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  let runner;
  try { runner = await loadRunner(); } catch (e) { console.error(`could not build the runner: ${e.stack ?? e}`); return 2; }
  if (opts.serve !== undefined) return serveDashboard(runner, opts);
  if (opts.merge) return mergeRuns(runner, opts);
  if (opts.record && !opts.ciBuildId) opts.ciBuildId = process.env.GITHUB_RUN_ID ?? process.env.CI_PIPELINE_ID ?? process.env.BUILD_NUMBER ?? `local-${Date.now()}`;
  if (opts.record) opts.key = opts.key ?? process.env.PIGRY_RECORD_KEY;
  const pw = await import('@playwright/test');

  const ts = await import('typescript');
  const transpile = async (src) => ts.default.transpileModule(src, { compilerOptions: { target: ts.default.ScriptTarget.ES2020, module: ts.default.ModuleKind.CommonJS } }).outputText;
  const { createRequire } = await import('node:module');
  const nodeRequire = createRequire(path.join(root, 'package.json'));
  const fileHost = { readFile: async (p) => { try { return fs.readFileSync(abs(p), 'utf8'); } catch { return null; } }, transpile, nodeRequire };
  let cypressFile = null;
  for (const name of runner.CYPRESS_CONFIG_FILES) {
    if (!fs.existsSync(abs(name))) continue;
    try { cypressFile = await runner.loadCypressConfig(fileHost, name, fs.readFileSync(abs(name), 'utf8')); break; } catch (e) { console.error(`could not read ${name}: ${e.message}`); }
  }
  const configFile = abs(opts.config ?? '.pigry/e2e/e2e.config.json');
  const raw = { ...(cypressFile?.settings ?? {}), specPattern: cypressFile?.specPattern, excludeSpecPattern: cypressFile?.excludeSpecPattern, ...(readJson(configFile) ?? {}) };
  const envFile = { ...(readJson(abs('cypress.env.json')) ?? {}), ...(readJson(path.join(path.dirname(configFile), 'e2e.env.json')) ?? {}) };
  let componentServer = null;
  if (opts.component) {
    try { componentServer = await startComponentServer(opts.component); console.error(`component dev server on ${componentServer.url}`); } catch (e) { console.error(`could not start the component dev server: ${e.message}`); return 2; }
  }
  const cfg = runner.mergeConfig({
    ...raw, env: { ...(raw.env ?? {}), ...envFile, ...opts.env },
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(componentServer ? { baseUrl: opts.baseUrl ?? componentServer.url, componentUrl: componentServer.url, componentFramework: opts.component } : {}),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}), ...(opts.video ? { video: true } : {}),
    ...(opts.viewport ? { viewportWidth: opts.viewport[0], viewportHeight: opts.viewport[1] } : {}), ...(opts.timeout ? { defaultCommandTimeout: opts.timeout } : {}),
    snapshots: Boolean(opts.replay),
  });
  if (!cfg.baseUrl) console.error('note: no baseUrl set — relative cy.visit() calls will fail (use --base-url)');

  const roots = opts.specsDir ? [abs(opts.specsDir)] : ['.pigry/e2e/specs', 'cypress/e2e', 'e2e'].map(abs).filter((d) => fs.existsSync(d));
  const relRoot = (f) => slashes(path.relative(root, f));
  const keyOf = (f) => {
    const dir = roots.find((d) => f.startsWith(d + path.sep));
    if (!dir) return relRoot(f).replace(/[.](cy[.])?(js|jsx|ts|tsx)$/, '');
    return slashes(path.relative(dir, f)).replace(/[.]cy[.](js|ts)$/, '');
  };
  let files = roots.flatMap(walk);
  if (cfg.specPattern.length) {
    const include = cfg.specPattern.map(runner.globToRegex);
    const exclude = cfg.excludeSpecPattern.map(runner.globToRegex);
    const all = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', '.git', '.pigry'].includes(e.name) ? [] : all(path.join(dir, e.name))) : [path.join(dir, e.name)]));
    for (const f of all(root)) { const rel = relRoot(f); if (include.some((re) => re.test(rel)) && !exclude.some((re) => re.test(rel)) && !files.includes(f)) files.push(f); }
  }
  files = files.filter((f) => !cfg.excludeSpecPattern.map(runner.globToRegex).some((re) => re.test(relRoot(f))));
  if (opts.specs.length) files = files.filter((f) => opts.specs.some((s) => keyOf(f).includes(s)));
  files.sort();
  if (opts.shard) { try { files = runner.shardOf(files, opts.shard); } catch (e) { console.error(e.message); return 2; } }
  if (!files.length) { console.error(`no specs found in ${roots.map((d) => path.relative(root, d) || '.').join(', ') || '.pigry/e2e/specs'}${opts.specs.length ? ` matching ${opts.specs.join(', ')}` : ''}`); return 2; }

  const outRel = slashes(opts.out ?? '.pigry/e2e/cli');
  let support = '';
  const supportFile = [cfg.supportFile, 'cypress/support/e2e.js'].find((f) => f && fs.existsSync(abs(f)));
  if (supportFile) support = fs.readFileSync(abs(supportFile), 'utf8');
  const pluginsFile = [cfg.pluginsFile].find((f) => f && fs.existsSync(abs(f)));
  const plugins = pluginsFile ? fs.readFileSync(abs(pluginsFile), 'utf8') : '';

  const results = [];
  const replays = {};
  const started = Date.now();
  const quiet = opts.reporter === 'json' || opts.reporter === 'junit';
  const log = (...a) => { if (!quiet) console.log(...a); };
  log(`Running ${files.length} spec${files.length === 1 ? '' : 's'} in ${opts.browser}${opts.headed ? ' (headed)' : ''}${opts.parallel > 1 ? ` · ${opts.parallel} at a time` : ''}\n`);

  const byKey = new Map(files.map((f) => [keyOf(f), f]));
  let rec = null;
  if (opts.record) {
    rec = recorder(opts, [...byKey.keys()]);
    try { await rec.start(); log(`recording to ${rec.link()}\n`); } catch (e) { console.error(`could not record: ${e.message}`); return 2; }
  }
  const queue = [...files];
  const nextFile = async () => {
    if (rec && opts.balance) {
      for (;;) {
        const key = await rec.claim();
        if (!key) return undefined;
        if (byKey.has(key)) return byKey.get(key);
        console.error(`dashboard asked for ${key}, which this checkout does not have — skipped`);
      }
    }
    return queue.shift();
  };
  const runOne = async (file) => {
    const rel = keyOf(file);
    const driver = await createDriver(pw, opts, cfg, rel);
    const lines = [];
    const sink = [];
    try {
      const result = await runner.runSpec({
        driver, config: cfg, spec: rel, snapshotSink: opts.replay ? sink : undefined, source: fs.readFileSync(file, 'utf8'), support, supportPath: supportFile, setupNodeEvents: cypressFile?.setupNodeEvents, plugins, pluginsPath: pluginsFile, specPath: relRoot(file), nodeRequire, typescript: /[.]tsx?$/.test(file), transpile, grep: opts.grep,
        evidenceDir: `${outRel}/evidence/${rel}`,
        onEvent: (e) => {
          if (e.type === 'test:end') {
            const t = e.result;
            const mark = t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '-';
            if (opts.reporter === 'dot') process.stdout.write(t.status === 'passed' ? '.' : t.status === 'failed' ? 'F' : ',');
            else lines.push(`  ${mark} ${t.title.join(' › ')} (${(t.ms / 1000).toFixed(1)}s${t.attempts > 1 ? `, ${t.attempts} attempts` : ''})${t.flaky ? ' [flaky]' : ''}`);
          }
        },
      });
      results.push(result);
      if (opts.replay) {
        const rp = runner.buildReplay(result, sink);
        if (rp) { const f = abs(`${outRel}/results/${rel}.replay.json`); ensureDir(f); fs.writeFileSync(f, JSON.stringify(rp)); replays[rel] = rp; }
      }
      const resFile = abs(`${outRel}/results/${rel}.json`); ensureDir(resFile); fs.writeFileSync(resFile, JSON.stringify(result));
      if (rec) { try { await rec.upload(result, replays[rel]); } catch (e) { console.error(`upload of ${rel} failed: ${e.message}`); } }
      if (opts.reporter === 'list') {
        log(`${result.status === 'passed' ? 'PASS' : 'FAIL'}  ${rel}  (${result.passed} passed, ${result.failed} failed, ${result.pending} pending, ${(result.ms / 1000).toFixed(1)}s)`);
        for (const l of lines) log(l);
        for (const t of result.tests.filter((x) => x.status === 'failed')) {
          log(`\n    ${t.title.join(' › ')}\n      ${(t.error?.message ?? '').split('\n').join('\n      ')}`);
          if (t.error?.frame) log(t.error.frame.lines.map((l) => `      ${l.hit ? '>' : ' '} ${String(l.n).padStart(3)} | ${l.text}`).join('\n'));
          for (const s of t.screenshots) log(`      screenshot: ${s}`);
        }
        log('');
      }
    } catch (e) {
      results.push({ spec: rel, status: 'error', startedAt: Date.now(), ms: 0, tests: [], passed: 0, failed: 0, pending: 0, error: e.message, config: cfg });
      console.error(`ERROR ${rel}: ${e.message}`);
      if (rec) { try { await rec.upload(results[results.length - 1], undefined); } catch (err) { console.error(`upload of ${rel} failed: ${err.message}`); } }
    } finally { await driver.close(); }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel, files.length) }, async () => { for (let f = await nextFile(); f; f = await nextFile()) await runOne(f); }));
  if (opts.reporter === 'dot') console.log('');

  // reports
  results.sort((a, b) => a.spec.localeCompare(b.spec));
  const { summary, xml } = writeReports(runner, opts, outRel, results, { durationMs: Date.now() - started, startedAt: started, browser: opts.browser, shard: opts.shard, replays });
  if (opts.reporter === 'json') console.log(JSON.stringify({ summary, results: results.map((r) => ({ spec: r.spec, status: r.status, passed: r.passed, failed: r.failed, pending: r.pending, error: r.error, tests: r.tests.map((t) => ({ title: t.title.join(' › '), status: t.status, ms: t.ms, flaky: t.flaky, error: t.error?.message })) })) }, null, 2));
  else if (opts.reporter === 'junit') console.log(xml);
  else log(`${summary.failed ? '✗' : '✓'} ${summary.passed} passed, ${summary.failed} failed, ${summary.pending} pending in ${(summary.durationMs / 1000).toFixed(1)}s — JUnit: ${summary.junit} · report: ${summary.report}`);
  return results.some((r) => r.status === 'error') ? 2 : summary.failed > 0 ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e.message ?? e); process.exit(2); });
