/** Pure helpers of the E2E runner — settings, text/Markdown/JUnit reports, spec checks and run analytics.
 * No Tauri and no DOM: the app and the headless CLI (scripts/e2e-cli.mjs) both use them. */
import { DEFAULT_CONFIG, type E2eConfig, type Snapshot, type SpecResult } from './runner';

export function mergeConfig(raw: unknown): E2eConfig {
  const out: E2eConfig = { ...DEFAULT_CONFIG, env: {} };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  out.baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim().replace(/\/+$/, '') : '';
  out.viewportWidth = num(r.viewportWidth, DEFAULT_CONFIG.viewportWidth, 200, 4000);
  out.viewportHeight = num(r.viewportHeight, DEFAULT_CONFIG.viewportHeight, 200, 4000);
  out.defaultCommandTimeout = num(r.defaultCommandTimeout, DEFAULT_CONFIG.defaultCommandTimeout, 100, 120000);
  out.pageLoadTimeout = num(r.pageLoadTimeout, DEFAULT_CONFIG.pageLoadTimeout, 1000, 300000);
  out.responseTimeout = num(r.responseTimeout, DEFAULT_CONFIG.responseTimeout, 1000, 300000);
  out.retries = num(r.retries, 0, 0, 5);
  out.video = bool(r.video, false);
  out.screenshotOnRunFailure = bool(r.screenshotOnRunFailure, true);
  out.testIsolation = bool(r.testIsolation, true);
  out.snapshots = bool(r.snapshots, true);
  out.networkEvidence = bool(r.networkEvidence, true);
  out.realInput = bool(r.realInput, true);
  out.chromeWebSecurity = bool(r.chromeWebSecurity, true);
  out.includeShadowDom = bool(r.includeShadowDom, false);
  out.waitForAnimations = bool(r.waitForAnimations, true);
  out.animationDistanceThreshold = num(r.animationDistanceThreshold, DEFAULT_CONFIG.animationDistanceThreshold, 0, 500);
  out.scrollBehavior = r.scrollBehavior === 'top' || r.scrollBehavior === 'bottom' || r.scrollBehavior === 'nearest' ? r.scrollBehavior : 'center';
  out.supportFile = typeof r.supportFile === 'string' ? r.supportFile.trim().replace(/\\/g, '/') : DEFAULT_CONFIG.supportFile;
  out.pluginsFile = typeof r.pluginsFile === 'string' ? r.pluginsFile.trim().replace(/\\/g, '/') : DEFAULT_CONFIG.pluginsFile;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : typeof v === 'string' && v.trim() ? v.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean) : []);
  out.componentUrl = typeof r.componentUrl === 'string' ? r.componentUrl.trim().replace(/\/+$/, '') : '';
  out.componentFramework = r.componentFramework === 'react' || r.componentFramework === 'vue' ? r.componentFramework : 'custom';
  out.specPattern = list(r.specPattern);
  out.excludeSpecPattern = list(r.excludeSpecPattern);
  if (r.env && typeof r.env === 'object' && !Array.isArray(r.env)) out.env = { ...(r.env as Record<string, unknown>) };
  return out;
}


const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Compact text for the agent: counts, each failing test with its error and code frame, and where the evidence is. */
export function resultSummary(r: SpecResult, maxChars = 6000): string {
  if (r.status === 'error') return `ERROR ${r.spec}: ${r.error}`;
  const lines: string[] = [`${r.status === 'passed' ? 'PASS' : 'FAIL'} ${r.spec} — ${r.passed} passed, ${r.failed} failed, ${r.pending} pending in ${secs(r.ms)}`];
  for (const t of r.tests) {
    const mark = t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '-';
    lines.push(`${mark} ${t.title.join(' › ')} (${secs(t.ms)}${t.attempts > 1 ? `, ${t.attempts} attempts` : ''})`);
    if (t.status === 'failed' && t.error) {
      lines.push(`    ${t.error.name}: ${t.error.message.split('\n').slice(0, 6).join('\n    ')}`);
      if (t.error.frame) lines.push(...t.error.frame.lines.map((l) => `    ${l.hit ? '>' : ' '} ${String(l.n).padStart(3)} | ${l.text}`));
      const failedCmd = t.log.filter((l) => l.kind !== 'assertion' || l.state === 'failed').slice(-4).map((l) => `${l.name} ${l.message}`.trim());
      if (failedCmd.length) lines.push(`    last commands: ${failedCmd.join(' → ').slice(0, 300)}`);
      if (t.console) lines.push(`    console: ${t.console.split('\n').slice(-4).join(' | ').slice(0, 300)}`);
    }
    for (const s of t.screenshots) lines.push(`    screenshot: ${s}`);
    if (t.networkFile) lines.push(`    network: ${t.networkFile}`);
  }
  if (r.video) lines.push(`video: ${r.video}`);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated — read ${'.pigry/e2e/results/'}${r.spec}.json for everything)` : text;
}

/** "a/b/c.png" seen from folder "a/x" → "../b/c.png". */
export function relativeFrom(fromDir: string, target: string): string {
  const from = fromDir.split('/').filter(Boolean), to = target.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i += 1;
  return [...Array(from.length - i).fill('..'), ...to.slice(i)].join('/');
}

export function resultToMarkdown(r: SpecResult, reportDir?: string): string {
  const link = (p: string) => (reportDir ? relativeFrom(reportDir, p) : p);
  const out: string[] = [`# E2E report — ${r.spec}`, '', `- Result: **${r.status.toUpperCase()}** — ${r.passed} passed, ${r.failed} failed, ${r.pending} pending`, `- Duration: ${secs(r.ms)}`, `- Base URL: ${r.config.baseUrl || '(none)'} · viewport ${r.config.viewportWidth}×${r.config.viewportHeight}`, `- Run: ${new Date(r.startedAt).toISOString()}`];
  if (r.video) out.push(`- Video: [${r.video.split('/').pop()}](${link(r.video)})`);
  out.push('', '## Tests', '');
  for (const t of r.tests) {
    out.push(`### ${t.status === 'passed' ? '✅' : t.status === 'failed' ? '❌' : '⏭️'} ${t.title.join(' › ')}`, '', `Status: ${t.status} · ${secs(t.ms)}${t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}`, '');
    const steps = t.log.filter((l) => l.kind !== 'log' && l.level <= 1);
    if (steps.length) { out.push('| # | Step | Result |', '|---|------|--------|'); steps.forEach((l, i) => out.push(`| ${i + 1} | \`${l.name}\` ${l.message.replace(/\|/g, '\\|').slice(0, 80)} | ${l.state === 'passed' ? '✅' : l.state === 'failed' ? '❌' : '…'} |`)); out.push(''); }
    if (t.error) out.push('```text', `${t.error.name}: ${t.error.message}`, ...(t.error.frame ? t.error.frame.lines.map((l) => `${l.hit ? '>' : ' '} ${l.n} | ${l.text}`) : []), '```', '');
    for (const s of t.screenshots) out.push(`![${s.split('/').pop()}](${link(s)})`, '');
    if (t.networkFile) out.push(`API evidence: [${t.networkFile.split('/').pop()}](${link(t.networkFile)})`, '');
  }
  return out.join('\n');
}


/* ---- checking spec source before it is saved ---- */

export interface SpecCheck { errors: string[]; warnings: string[] }

/** Syntax check plus the mistakes that most often make specs fail in this runner. */
export function checkSpecSource(source: string, opts: { typescript?: boolean } = {}): SpecCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!opts.typescript) {
    try {
      new Function('"use strict";\n' + source);
    } catch (e) { errors.push(`syntax error: ${(e as Error).message}`); }
  }
  if (/^\s*(import|export)\s/m.test(source)) errors.push('specs are plain scripts — remove import/export (cy, Cypress, expect, assert and _ are already global)');
  if (/\brequire\s*\(/.test(source)) errors.push('require() is not available in specs');
  if (!/\b(it|specify)\s*(\.\w+)?\s*\(/.test(source)) warnings.push('no it(...) test found — nothing would run');
  if (/\bawait\s+cy\./.test(source)) warnings.push('"await cy.…" does not work — Cypress commands are queued; chain with .then() instead');
  if (/\bcy\.origin\s*\(/.test(source)) warnings.push('cy.origin() is not supported here');
  if (/\bcy\.task\s*\(/.test(source)) warnings.push('cy.task() is not supported here (no Node process) — use cy.exec() or cy.request()');
  if (/\bcy\.visit\(\s*['"`]\//.test(source) === false && !/cy\.visit\(/.test(source)) warnings.push('the spec never calls cy.visit()');
  if (!opts.typescript && /:\s*(string|number|boolean|any)\b|\bas\s+(string|any)\b|\binterface\s+\w+/.test(source)) warnings.push('this looks like TypeScript — specs must be plain JavaScript');
  return { errors, warnings };
}



/* ---- JUnit XML (CI dashboards, GitHub Actions test reports, Jenkins …) ---- */

const xml = (v: string): string => v.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export function resultToJUnit(r: SpecResult): string {
  const time = (ms: number) => (ms / 1000).toFixed(3);
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="${xml(r.spec)}" tests="${r.tests.length}" failures="${r.failed}" skipped="${r.pending}" time="${time(r.ms)}">`,
    `  <testsuite name="${xml(r.spec)}" tests="${r.tests.length}" failures="${r.failed}" errors="${r.status === 'error' ? 1 : 0}" skipped="${r.pending}" time="${time(r.ms)}" timestamp="${new Date(r.startedAt).toISOString()}">`];
  if (r.status === 'error') out.push(`    <testcase name="load spec" classname="${xml(r.spec)}"><error message="${xml(r.error ?? 'spec error')}"/></testcase>`);
  for (const t of r.tests) {
    const name = xml(t.title.join(' › ')), cls = xml(t.title.slice(0, -1).join('.') || r.spec);
    out.push(`    <testcase name="${name}" classname="${cls}" time="${time(t.ms)}">`);
    if (t.status === 'failed') {
      out.push(`      <failure message="${xml((t.error?.message ?? 'failed').split('\n')[0])}" type="${xml(t.error?.name ?? 'Error')}">${xml(`${t.error?.message ?? ''}${t.error?.frame ? `\n${t.error.frame.lines.map((l) => `${l.hit ? '>' : ' '} ${l.n} | ${l.text}`).join('\n')}` : ''}`)}</failure>`);
      if (t.screenshots.length) out.push(`      <system-out>${xml(t.screenshots.map((s) => `[[ATTACHMENT|${s}]]`).join('\n'))}</system-out>`);
    } else if (t.status === 'pending' || t.status === 'skipped') out.push('      <skipped/>');
    out.push('    </testcase>');
  }
  out.push('  </testsuite>', '</testsuites>');
  return out.join('\n');
}

/* ---- statistics over runs: pass rate, speed and flaky tests (a local stand-in for a dashboard's analytics) ---- */

export interface TestStat { runs: number; passes: number; fails: number; flaky: number; totalMs: number; lastMs: number; lastStatus: string; lastAt: number }
export type StatsFile = Record<string, Record<string, TestStat>>;



export interface Analytics {
  slowest: Array<{ spec: string; test: string; avgMs: number; runs: number }>;
  flaky: Array<{ spec: string; test: string; rate: number; runs: number }>;
  failing: Array<{ spec: string; test: string; failRate: number; runs: number }>;
}

/** The slowest, flakiest and most-failing tests across the stored runs. */
export function analyticsOf(stats: StatsFile, limit = 8): Analytics {
  const rows = Object.entries(stats).flatMap(([spec, tests]) => Object.entries(tests).map(([test, s]) => ({ spec, test, ...s })));
  return {
    slowest: rows.filter((r) => r.runs > 0).map((r) => ({ spec: r.spec, test: r.test, avgMs: Math.round(r.totalMs / r.runs), runs: r.runs })).sort((a, b) => b.avgMs - a.avgMs).slice(0, limit),
    flaky: rows.filter((r) => r.flaky > 0 || (r.passes > 0 && r.fails > 0)).map((r) => ({ spec: r.spec, test: r.test, rate: Math.round(((r.flaky + Math.min(r.passes, r.fails)) / r.runs) * 100), runs: r.runs })).sort((a, b) => b.rate - a.rate).slice(0, limit),
    failing: rows.filter((r) => r.fails > 0).map((r) => ({ spec: r.spec, test: r.test, failRate: Math.round((r.fails / r.runs) * 100), runs: r.runs })).sort((a, b) => b.failRate - a.failRate).slice(0, limit),
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A self-contained HTML dashboard of a run (our stand-in for Cypress Cloud's run page): totals, slowest and flaky tests, per-spec details. */
export interface RunPoint { at: number; passed: number; failed: number; flaky: number; ms: number; tests: Record<string, 'passed' | 'failed' | 'pending'> }

/** One run's point for the trend table (spec > test -> status). */
export function runPointOf(results: SpecResult[], at: number, ms: number): RunPoint {
  const tests: RunPoint['tests'] = {};
  let passed = 0, failed = 0, flaky = 0;
  for (const r of results) for (const t of r.tests) {
    tests[`${r.spec} › ${t.title.join(' › ')}`] = t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'pending';
    if (t.status === 'passed') passed += 1; else if (t.status === 'failed') failed += 1;
    if (t.flaky) flaky += 1;
  }
  return { at, passed, failed, flaky, ms, tests };
}

/** Merges the results of several runs (e.g. CI shards): later entries win for the same spec. */
export function mergeResults(lists: SpecResult[][]): SpecResult[] {
  const bySpec = new Map<string, SpecResult>();
  for (const list of lists) for (const r of list) bySpec.set(r.spec, r);
  return [...bySpec.values()].sort((a, b) => a.spec.localeCompare(b.spec));
}

export function runToHtml(results: SpecResult[], meta: { title?: string; durationMs?: number; browser?: string; shard?: string; replays?: Record<string, ReplayFile>; history?: RunPoint[] } = {}): string {
  const tests = results.flatMap((r) => r.tests.map((t) => ({ spec: r.spec, t })));
  const count = (s: string) => tests.filter((x) => x.t.status === s).length;
  const passed = count('passed'), failed = count('failed'), pending = tests.length - passed - failed;
  const flaky = tests.filter((x) => x.t.flaky);
  const slow = [...tests].sort((a, b) => b.t.ms - a.t.ms).slice(0, 5);
  const row = (x: { spec: string; t: SpecResult['tests'][number] }) => `<tr class="${x.t.status}"><td>${esc(x.spec)}</td><td>${esc(x.t.title.join(' › '))}</td><td>${esc(x.t.status)}${x.t.flaky ? ' <b>flaky</b>' : ''}</td><td>${(x.t.ms / 1000).toFixed(2)}s</td><td>${x.t.attempts}</td></tr>`;
  const details = results.map((r) => `<details ${r.status === 'passed' ? '' : 'open'}><summary class="${r.status}">${esc(r.spec)} — ${r.passed} passed, ${r.failed} failed, ${r.pending} pending (${(r.ms / 1000).toFixed(1)}s)</summary>${r.error ? `<pre>${esc(r.error)}</pre>` : ''}${r.tests.map((t) => `<div class="t ${t.status}"><b>${esc(t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '-')} ${esc(t.title.join(' › '))}</b> <span>${(t.ms / 1000).toFixed(2)}s</span>${t.error ? `<pre>${esc(t.error.message)}${t.error.frame ? '\n\n' + esc(t.error.frame.lines.map((l: { hit?: boolean; n: number; text: string }) => `${l.hit ? '>' : ' '} ${String(l.n).padStart(3)} | ${l.text}`).join('\n')) : ''}</pre>` : ''}${t.screenshots.map((s) => `<a href="${esc(s)}">${esc(s.split('/').pop())}</a>`).join(' ')}${replayBlock(r.spec, t, meta.replays)}${t.log.length ? `<details><summary>${t.log.length} commands</summary><ol>${t.log.map((l) => `<li class="${esc((l as { state?: string }).state ?? '')}">${esc((l as { name?: string }).name ?? '')} <code>${esc((l as { message?: string }).message ?? '')}</code></li>`).join('')}</ol></details>` : ''}</div>`).join('')}</details>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title ?? 'Pigry E2E run')}</title><style>
body{font:14px system-ui,sans-serif;margin:24px;color:#1f2430;background:#fafafa}h1{margin:0 0 4px}.cards{display:flex;gap:12px;margin:16px 0;flex-wrap:wrap}.card{background:#fff;border:1px solid #e3e5ea;border-radius:8px;padding:10px 16px}.card b{font-size:22px;display:block}
.passed{color:#1a7f37}.failed{color:#cf222e}.pending{color:#9a6700}table{border-collapse:collapse;background:#fff;width:100%;margin:8px 0 20px}td,th{border:1px solid #e3e5ea;padding:4px 8px;text-align:left}tr.failed{background:#fff0f0}
details{background:#fff;border:1px solid #e3e5ea;border-radius:6px;margin:6px 0;padding:6px 10px}summary{cursor:pointer;font-weight:600}.t{padding:4px 0;border-top:1px solid #eee}.t span{color:#888}pre{background:#f3f4f6;padding:8px;overflow:auto;border-radius:4px}ol{margin:4px 0;color:#555;font-size:12px}li.failed{color:#cf222e}
.replay{margin:6px 0}.replay__cmds{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}.replay__cmds button{font:12px system-ui;padding:2px 8px;border:1px solid #c9ccd3;border-radius:4px;background:#fff;cursor:pointer}.replay__cmds button.on{background:#4a90e2;color:#fff}.replay__cmds button.failed{border-color:#cf222e}.replay__box{border:1px solid #e3e5ea;overflow:hidden;background:#fff;min-height:40px}.replay__box iframe{border:0;background:#fff}
@media (prefers-color-scheme:dark){body{background:#14161a;color:#dde1e7}.card,table,details{background:#1b1e24;border-color:#2c313a}td,th{border-color:#2c313a}pre{background:#0f1114}tr.failed{background:#2a1517}}
</style></head><body><h1>${esc(meta.title ?? 'Pigry E2E run')}</h1><div>${meta.browser ? `${esc(meta.browser)} · ` : ''}${meta.shard ? `shard ${esc(meta.shard)} · ` : ''}${meta.durationMs !== undefined ? `${(meta.durationMs / 1000).toFixed(1)}s · ` : ''}${results.length} specs</div>
<div class="cards"><div class="card passed"><b>${passed}</b>passed</div><div class="card failed"><b>${failed}</b>failed</div><div class="card pending"><b>${pending}</b>pending</div><div class="card"><b>${flaky.length}</b>flaky</div></div>
${flaky.length ? `<h2>Flaky tests</h2><table><tr><th>Spec</th><th>Test</th><th>Status</th><th>Time</th><th>Attempts</th></tr>${flaky.map(row).join('')}</table>` : ''}
<h2>Slowest tests</h2><table><tr><th>Spec</th><th>Test</th><th>Status</th><th>Time</th><th>Attempts</th></tr>${slow.map(row).join('')}</table>
${trendHtml(meta.history ?? [])}
<h2>Specs</h2>${details}${replayScript(meta.replays ?? {})}</body></html>`;
}


function replayBlock(spec: string, t: SpecResult['tests'][number], replays?: Record<string, ReplayFile>): string {
  const map = replays?.[spec]?.map[t.key];
  if (!map) return '';
  const cmds = t.log.filter((l) => map[l.id]);
  if (!cmds.length) return '';
  return `<div class="replay" data-spec="${esc(spec)}" data-test="${esc(t.key)}"><div class="replay__cmds">${cmds.map((l) => `<button type="button" class="${l.state === 'failed' ? 'failed' : ''}" data-cmd="${l.id}">${esc(l.name)} <code>${esc(l.message.slice(0, 60))}</code></button>`).join('')}</div><div class="replay__box"><iframe title="Page snapshot" sandbox=""></iframe></div></div>`;
}

function trendHtml(history: RunPoint[]): string {
  if (history.length < 2) return '';
  const last = history.slice(-10).reverse();
  const unstable = new Map<string, { runs: number; fails: number }>();
  for (const h of history) for (const [k, st] of Object.entries(h.tests)) {
    if (st === 'pending') continue;
    const u = unstable.get(k) ?? { runs: 0, fails: 0 };
    u.runs += 1; if (st === 'failed') u.fails += 1;
    unstable.set(k, u);
  }
  const flipping = [...unstable.entries()].filter(([, u]) => u.fails > 0 && u.fails < u.runs).sort((a, b) => b[1].fails / b[1].runs - a[1].fails / a[1].runs).slice(0, 8);
  return `<h2>Run history</h2><table><tr><th>When</th><th>Passed</th><th>Failed</th><th>Flaky</th><th>Time</th></tr>${last.map((h) => `<tr class="${h.failed ? 'failed' : ''}"><td>${esc(new Date(h.at).toISOString().replace('T', ' ').slice(0, 19))}</td><td>${h.passed}</td><td>${h.failed}</td><td>${h.flaky}</td><td>${(h.ms / 1000).toFixed(1)}s</td></tr>`).join('')}</table>`
    + (flipping.length ? `<h2>Unstable across runs</h2><table><tr><th>Test</th><th>Failed in</th></tr>${flipping.map(([k, u]) => `<tr><td>${esc(k)}</td><td>${u.fails} of ${u.runs} runs (${Math.round((u.fails / u.runs) * 100)}%)</td></tr>`).join('')}</table>` : '');
}

/** Test Replay in the HTML report: time travel through the last commands of every failed test, offline (snapshots are embedded). */
function replayScript(replays: Record<string, ReplayFile>): string {
  if (!Object.keys(replays).length) return '';
  // "<" is written as a JSON escape so the data can never close the script tag
  const data = JSON.stringify(replays).split('<').join(String.fromCharCode(92) + 'u003c');
  const code = REPLAY_JS;
  return `<script type="application/json" id="replay-data">${data}</script><script>${code}</script>`;
}

const REPLAY_JS = [
  'var D = JSON.parse(document.getElementById("replay-data").textContent);',
  'function frame(snap, box) {',
  '  var f = box.querySelector("iframe"); var origin = ""; try { origin = new URL(snap.url).origin; } catch (e) {}',
  '  var inject = "<meta http-equiv=Content-Security-Policy content=script-src-none>" + (origin ? "<base href=" + origin + "/>" : "") + "<style>[data-cy-target]{outline:3px solid #4a90e2 !important}</style>";',
  '  var html = /<head[^>]*>/i.test(snap.html) ? snap.html.replace(/<head[^>]*>/i, function (m) { return m + inject; }) : inject + snap.html;',
  '  var scale = Math.min(1, (box.clientWidth - 8) / snap.w);',
  '  f.style.width = snap.w + "px"; f.style.height = snap.h + "px"; f.style.transform = "scale(" + scale + ")"; f.style.transformOrigin = "0 0";',
  '  box.style.height = Math.round(snap.h * scale) + "px"; f.srcdoc = html;',
  '}',
  'document.querySelectorAll(".replay").forEach(function (el) {',
  '  var rep = D[el.getAttribute("data-spec")]; var map = rep && rep.map[el.getAttribute("data-test")]; if (!map) return;',
  '  var box = el.querySelector(".replay__box");',
  '  el.querySelectorAll("button[data-cmd]").forEach(function (b) {',
  '    b.addEventListener("click", function () {',
  '      var m = map[b.getAttribute("data-cmd")]; var i = m && (m.after !== undefined ? m.after : m.before); if (i === undefined) return;',
  '      el.querySelectorAll("button[data-cmd]").forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on"); frame(rep.snapshots[i], box);',
  '    });',
  '  });',
  '  var last = el.querySelectorAll("button[data-cmd]"); if (last.length) last[last.length - 1].click();',
  '});',
].join(String.fromCharCode(10));

/** `--shard 2/4`: the i-th of n slices of the spec list (round-robin so slices stay balanced). */
export function shardOf<T>(items: T[], shard: string): T[] {
  const m = /^(\d+)\/(\d+)$/.exec(shard.trim());
  if (!m) throw new Error('--shard must look like 2/4');
  const i = Number(m[1]), n = Number(m[2]);
  if (n < 1 || i < 1 || i > n) throw new Error('--shard must look like 2/4');
  return items.filter((_, idx) => idx % n === i - 1);
}

/** Test Replay (local): the DOM snapshots behind the last commands of every failed test, kept so the time travel still works after the run. */
export interface ReplayFile { snapshots: Snapshot[]; map: Record<string, Record<number, { before?: number; after?: number }>> }

const REPLAY_LAST_COMMANDS = 14;
const REPLAY_MAX_BYTES = 4_000_000;

export function buildReplay(result: SpecResult, snapshots: Snapshot[]): ReplayFile | null {
  const out: ReplayFile = { snapshots: [], map: {} };
  const index = new Map<number, number>();
  let bytes = 0;
  const take = (i: number | undefined): number | undefined => {
    if (i === undefined || !snapshots[i]) return undefined;
    const known = index.get(i);
    if (known !== undefined) return known;
    const size = snapshots[i].html.length;
    if (size > 250_000 || bytes + size > REPLAY_MAX_BYTES) return undefined;
    bytes += size; out.snapshots.push(snapshots[i]); index.set(i, out.snapshots.length - 1);
    return out.snapshots.length - 1;
  };
  for (const t of result.tests) {
    if (t.status !== 'failed') continue;
    const entries = t.log.filter((l) => l.before !== undefined || l.after !== undefined).slice(-REPLAY_LAST_COMMANDS);
    const m: ReplayFile['map'][string] = {};
    for (const l of entries) { const b = take(l.before), a = take(l.after); if (b !== undefined || a !== undefined) m[l.id] = { before: b, after: a }; }
    if (Object.keys(m).length) out.map[t.key] = m;
  }
  return out.snapshots.length ? out : null;
}

