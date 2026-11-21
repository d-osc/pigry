import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { APP_HTML } from './ui/e2e-helpers.mjs';

const USERS = JSON.stringify([{ id: 1, name: 'Grace' }, { id: 2, name: 'Alan' }]);

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/users') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(USERS); return; }
    const html = APP_HTML[url.pathname];
    if (!html) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve('scripts/e2e-cli.mjs'), ...args], { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('headless CLI runs specs in Playwright, writes JUnit, results and evidence, and sets the exit code', { timeout: 240000 }, async () => {
  const { server, url } = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigry-e2e-cli-'));
  try {
    const specs = path.join(dir, '.pigry/e2e/specs/ci');
    fs.mkdirSync(specs, { recursive: true });
    fs.mkdirSync(path.join(dir, '.pigry/e2e/support'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pigry/e2e/support/e2e.js'), "Cypress.Commands.add('heading', () => cy.get('h1'));\n");
    fs.writeFileSync(path.join(specs, 'home.cy.js'), `describe('home', () => {
  beforeEach(() => { cy.visit('/'); });
  it('shows the heading', () => { cy.heading().should('have.text', 'Welcome home'); });
  it('stubs the API', () => {
    cy.intercept('/api/users', { body: [{ id: 9, name: 'Stubbed' }] }).as('u');
    cy.visit('/');
    cy.wait('@u');
    cy.get('.user').should('have.text', 'Stubbed');
  });
  it('clicks with trusted input', () => {
    cy.get('#inc').click();
    cy.get('#trusted').should('have.text', 'true');
  });
});
`);
    fs.writeFileSync(path.join(specs, 'typed.cy.ts'), `const expected: string = 'About us';
describe('typed', () => {
  it('compiles types away', () => {
    cy.visit('/about');
    cy.get('h1').should('have.text', expected as string);
  });
});
`);
    fs.writeFileSync(path.join(specs, 'broken.cy.js'), `describe('broken', () => {
  it('cannot find the thing', () => { cy.visit('/'); cy.get('#nope'); });
});
`);
    fs.writeFileSync(path.join(dir, '.pigry/e2e/e2e.config.json'), JSON.stringify({ defaultCommandTimeout: 1500, retries: 0 }));

    const run = await runCli(['--base-url', url, '--reporter', 'json', '--parallel', '2'], dir);
    assert.equal(run.code, 1, `exit code (stderr: ${run.stderr.slice(0, 400)})`);
    const out = JSON.parse(run.stdout);
    assert.equal(out.summary.specs, 3);
    assert.equal(out.summary.passed, 4);
    assert.equal(out.summary.failed, 1);
    assert.deepEqual(out.summary.failedSpecs, ['ci/broken']);
    const byName = Object.fromEntries(out.results.map((r) => [r.spec, r]));
    assert.equal(byName['ci/home'].status, 'passed');
    assert.equal(byName['ci/typed'].status, 'passed');
    assert.match(byName['ci/broken'].tests[0].error, /Expected to find element: `#nope`/);

    const xml = fs.readFileSync(path.join(dir, '.pigry/e2e/cli/junit.xml'), 'utf8');
    assert.match(xml, /<testsuites name="pigry-e2e" tests="5" failures="1"/);
    assert.match(xml, /<testcase name="home › shows the heading"/);
    assert.match(xml, /<failure message="Timed out retrying after 1500ms/);
    const shots = fs.readdirSync(path.join(dir, '.pigry/e2e/cli/evidence/ci/broken'));
    assert.ok(shots.some((f) => f.endsWith('--failed.png')), `failure screenshot in ${shots}`);
    assert.ok(shots.some((f) => f.endsWith('--api.json')), 'network evidence per test');
    assert.ok(fs.existsSync(path.join(dir, '.pigry/e2e/cli/results/ci/home.json')));

    const html = fs.readFileSync(path.join(dir, '.pigry/e2e/cli/report.html'), 'utf8');
    assert.match(html, /<h1>Pigry E2E run<\/h1>/);
    assert.match(html, /Expected to find element/);
    assert.match(out.summary.report, /report\.html$/);

    // sharding splits the sorted spec list round-robin
    const shard = await runCli(['--base-url', url, '--shard', '2/2', '--reporter', 'json'], dir);
    const sharded = JSON.parse(shard.stdout);
    assert.deepEqual(sharded.results.map((r) => r.spec), ['ci/home']);
    const bad = await runCli(['--base-url', url, '--shard', '3/2'], dir);
    assert.equal(bad.code, 2);

    // Test Replay in the report, shard outputs merged into one report, and the run history
    const a1 = await runCli(['--base-url', url, '--spec', 'broken', '--replay', '--out', 'shards/a', '--reporter', 'json'], dir);
    assert.equal(a1.code, 1, a1.stdout + a1.stderr);
    const a2 = await runCli(['--base-url', url, '--spec', 'home', '--out', 'shards/b', '--reporter', 'json'], dir);
    assert.equal(a2.code, 0, a2.stdout + a2.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'shards/a/results/ci/broken.replay.json')), 'replay file of the failed spec');
    const replayHtml = fs.readFileSync(path.join(dir, 'shards/a/report.html'), 'utf8');
    assert.match(replayHtml, /id="replay-data"/);
    assert.match(replayHtml, /class="replay"/);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      await page.goto(`file:///${path.join(dir, 'shards/a/report.html').split(String.fromCharCode(92)).join('/')}`);
      await page.waitForFunction(() => { const f = document.querySelector('.replay iframe'); return f && f.srcdoc && f.srcdoc.includes('<h1'); }, null, { timeout: 10000 });
      assert.ok(await page.locator('.replay__cmds button.on').count() >= 1, 'a command is selected');
    } finally { await browser.close(); }
    const merged = await runCli(['--merge', 'shards/a,shards/b', '--out', 'merged', '--reporter', 'json'], dir);
    assert.equal(merged.code, 1, merged.stdout + merged.stderr);
    const mergedSummary = JSON.parse(merged.stdout).summary;
    assert.equal(mergedSummary.specs, 2);
    assert.equal(mergedSummary.failed, 1);
    const mergedHtml = fs.readFileSync(path.join(dir, 'merged/report.html'), 'utf8');
    assert.match(mergedHtml, /id="replay-data"/);
    assert.match(mergedHtml, /ci\/home/);
    await runCli(['--base-url', url, '--spec', 'home', '--out', 'shards/b', '--reporter', 'json'], dir);
    const trend = fs.readFileSync(path.join(dir, 'shards/b/report.html'), 'utf8');
    assert.match(trend, /<h2>Run history<\/h2>/);

    // grep and spec filters, list reporter and a passing run exit with 0
    const ok = await runCli(['--base-url', url, '--spec', 'home', '--grep', 'heading', '--reporter', 'list'], dir);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /PASS {2}ci\/home/);
    assert.match(ok.stdout, /✓ home › shows the heading/);
    assert.match(ok.stdout, /1 passed, 0 failed, 2 pending/);

    const none = await runCli(['--base-url', url, '--spec', 'does-not-exist'], dir);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no specs found/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('headless CLI reads cypress.config.js: baseUrl, specPattern, setupNodeEvents with real Node, imports and TypeScript helpers', { timeout: 240000 }, async () => {
  const { server, url } = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigry-e2e-cfg-'));
  try {
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello from node');
    fs.writeFileSync(path.join(dir, 'cypress.config.js'), `const { defineConfig } = require('cypress');
module.exports = defineConfig({
  e2e: {
    baseUrl: ${JSON.stringify(url)},
    specPattern: 'tests/**/*.spec.js',
    defaultCommandTimeout: 1500,
    env: { who: 'config' },
    setupNodeEvents(on, config) {
      on('task', { readNote: () => require('fs').readFileSync('note.txt', 'utf8'), join: (parts) => require('path').join(...parts) });
      return config;
    },
  },
});
`);
    fs.writeFileSync(path.join(dir, 'tests/helpers.ts'), "export const upper = (s: string): string => s.toUpperCase();\n");
    fs.writeFileSync(path.join(dir, 'tests/note.spec.js'), `import { upper } from './helpers';
describe('config file', () => {
  it('runs node tasks from setupNodeEvents', () => {
    cy.task('readNote').should('eq', 'hello from node');
    cy.task('join', ['a', 'b']).should('match', /a.b/);
  });
  it('uses env from the config, imports and baseUrl', () => {
    expect(Cypress.env('who')).to.eq('config');
    expect(upper('ok')).to.eq('OK');
    cy.visit('/about');
    cy.get('h1').should('have.text', 'About us');
  });
});
`);
    const run = await runCli(['--reporter', 'json'], dir);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.summary.specs, 1);
    assert.equal(out.summary.passed, 2);
    assert.equal(out.results[0].spec, 'tests/note.spec');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('headless CLI --component starts a Vite dev server and mounts React components with cy.mount({ module })', { timeout: 240000 }, async () => {
  const cache = path.resolve('node_modules/.cache');
  fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, 'pigry-e2e-cmp-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"cmp","type":"module"}');
    fs.writeFileSync(path.join(dir, 'src/Counter.js'), `import React, { useState } from 'react';
export default function Counter({ start = 0, label = 'Count' }) {
  const [n, setN] = useState(start);
  return React.createElement('button', { id: 'c', onClick: () => setN(n + 1) }, label + ': ' + n);
}
export const Greeting = ({ name }) => React.createElement('h2', null, 'Hello ' + name);
`);
    fs.writeFileSync(path.join(dir, 'src/plain.js'), "export function mount(el, props) { el.innerHTML = '<p class=\"plain\">plain ' + props.v + '</p>'; }\nexport default {};\n");
    fs.writeFileSync(path.join(dir, 'tests/counter.cy.js'), `describe('components', () => {
  it('mounts a default export with props and reacts to clicks', () => {
    cy.mount({ module: '/src/Counter.js', props: { start: 2, label: 'Clicks' } });
    cy.get('#c').should('have.text', 'Clicks: 2').click().should('have.text', 'Clicks: 3');
  });
  it('mounts a named export', () => {
    cy.mount({ module: '/src/Counter.js', export: 'Greeting', props: { name: 'Ada' } });
    cy.get('h2').should('have.text', 'Hello Ada');
  });
  it('mounts with its own mount()', () => {
    cy.mount({ module: '/src/plain.js', framework: 'custom', props: { v: 7 } });
    cy.get('.plain').should('have.text', 'plain 7');
  });
});
`);
    const run = await runCli(['--component', 'react', '--specs-dir', 'tests', '--reporter', 'json', '--timeout', '8000'], dir);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.summary.passed, 3);
    assert.equal(out.summary.failed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const browserName of ['firefox', 'webkit']) {
  test(`headless CLI runs specs in ${browserName}`, { timeout: 240000 }, async () => {
    const { server, url } = await serve();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pigry-e2e-${browserName}-`));
    try {
      const specs = path.join(dir, '.pigry/e2e/specs/x');
      fs.mkdirSync(specs, { recursive: true });
      fs.writeFileSync(path.join(specs, 'basic.cy.js'), `describe('basic', () => {
  it('visits, asserts and clicks', () => {
    cy.visit('/');
    cy.get('h1').should('have.text', 'Welcome home');
    cy.get('#inc').click();
    cy.get('#trusted').should('have.text', 'true');
  });
  it('stubs the network', () => {
    cy.intercept('/api/users', { body: [{ id: 9, name: 'Stubbed' }] }).as('u');
    cy.visit('/');
    cy.wait('@u');
    cy.get('.user').should('have.text', 'Stubbed');
  });
  it('types into inputs and sets cookies', () => {
    cy.visit('/');
    cy.setCookie('k', 'v');
    cy.getCookie('k').should('have.property', 'value', 'v');
  });
});
`);
      const run = await runCli(['--base-url', url, '--browser', browserName, '--reporter', 'json', '--timeout', '6000'], dir);
      assert.equal(run.code, 0, run.stdout.slice(0, 3000) + run.stderr.slice(0, 1500));
      const out = JSON.parse(run.stdout);
      assert.equal(out.summary.passed, 3);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('self-hosted dashboard: --record uploads runs, --balance shares specs between machines, flaky tests and Test Replay are served', { timeout: 240000 }, async () => {
  const { server, url } = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigry-e2e-dash-'));
  const dash = spawn(process.execPath, [path.resolve('scripts/e2e-cli.mjs'), '--serve', '0', '--token', 's3cret', '--dir', path.join(dir, 'dashboard')], { cwd: dir });
  try {
    const dashUrl = await new Promise((resolve, reject) => {
      let out = '';
      dash.stdout.on('data', (d) => { out += d; const m = /dashboard (http:\/\/[^\s]+)/.exec(out); if (m) resolve(m[1]); });
      dash.on('close', () => reject(new Error(`dashboard exited: ${out}`)));
      setTimeout(() => reject(new Error('dashboard did not start')), 60000);
    });
    const specs = path.join(dir, '.pigry/e2e/specs/ci');
    fs.mkdirSync(specs, { recursive: true });
    for (const name of ['one', 'two', 'three', 'four']) {
      fs.writeFileSync(path.join(specs, `${name}.cy.js`), `describe('${name}', () => { it('works', () => { cy.visit('/about'); cy.get('h1').should('have.text', 'About us'); }); });\n`);
    }
    fs.writeFileSync(path.join(specs, 'broken.cy.js'), "describe('broken', () => { it('fails', () => { cy.visit('/'); cy.get('#nope'); }); });\n");
    fs.writeFileSync(path.join(dir, '.pigry/e2e/e2e.config.json'), JSON.stringify({ defaultCommandTimeout: 1200, retries: 0 }));

    // a wrong key is refused
    const denied = await runCli(['--base-url', url, '--record', dashUrl, '--key', 'nope', '--ci-build-id', 'b0', '--reporter', 'json'], dir);
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /401|record key/);

    // two machines share one build and pull specs from the dashboard
    const common = ['--base-url', url, '--record', dashUrl, '--key', 's3cret', '--ci-build-id', 'b1', '--balance', '--replay', '--reporter', 'json', '--out', 'out'];
    const [m1, m2] = await Promise.all([runCli(common, dir), runCli(common, dir)]);
    const ran = [m1, m2].flatMap((m) => JSON.parse(m.stdout).results.map((r) => r.spec));
    assert.deepEqual([...ran].sort(), ['ci/broken', 'ci/four', 'ci/one', 'ci/three', 'ci/two'], 'every spec ran exactly once across both machines');

    const list = await (await fetch(`${dashUrl}/api/runs`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].buildId, 'b1');
    assert.equal(list[0].specs, 5);
    assert.equal(list[0].done, 5);
    assert.equal(list[0].status, 'failed');
    assert.equal(list[0].failed, 1);
    const detail = await (await fetch(`${dashUrl}/api/runs/${list[0].id}`)).json();
    assert.equal(detail.results.length, 5);
    assert.ok(detail.results.every((r) => r.machine), 'each spec records which machine ran it');

    const page = await (await fetch(`${dashUrl}/runs/${list[0].id}`)).text();
    assert.match(page, /Run b1/);
    assert.match(page, /ci\/broken/);
    assert.match(page, /id="replay-data"/);
    const junit = await (await fetch(`${dashUrl}/api/runs/${list[0].id}/junit`)).text();
    assert.match(junit, /<testsuites name="pigry-e2e" tests="5" failures="1"/);
    const home = await (await fetch(dashUrl)).text();
    assert.match(home, /Pigry E2E dashboard/);
    assert.match(home, />b1</);

    // a second build builds history: the dashboard now lists two runs and the unstable-test section appears once a test flips
    fs.writeFileSync(path.join(specs, 'broken.cy.js'), "describe('broken', () => { it('fails', () => { cy.visit('/about'); cy.get('h1'); }); });\n");
    const again = await runCli(['--base-url', url, '--record', dashUrl, '--key', 's3cret', '--ci-build-id', 'b2', '--reporter', 'json', '--out', 'out2'], dir);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    const list2 = await (await fetch(`${dashUrl}/api/runs`)).json();
    assert.equal(list2.length, 2);
    const home2 = await (await fetch(dashUrl)).text();
    assert.match(home2, /Flaky tests/);
    assert.match(home2, /ci\/broken/);
  } finally {
    await new Promise((resolve) => { dash.once('close', resolve); dash.kill(); });
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('dashboard projects: each key sees and records only its own project', { timeout: 240000 }, async () => {
  const { server, url } = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigry-e2e-proj-'));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects: { web: { recordKey: 'web-w', readKey: 'web-r' }, api: { recordKey: 'api-w', readKey: 'api-r' } } }));
  const dash = spawn(process.execPath, [path.resolve('scripts/e2e-cli.mjs'), '--serve', '0', '--projects', 'projects.json', '--token', 'admin', '--dir', 'dashboard'], { cwd: dir });
  try {
    const dashUrl = await new Promise((resolve, reject) => {
      let out = '';
      dash.stdout.on('data', (d) => { out += d; const m = /dashboard (http:\/\/[^\s]+)/.exec(out); if (m) resolve(m[1]); });
      dash.on('close', () => reject(new Error(`dashboard exited: ${out}`)));
      setTimeout(() => reject(new Error('dashboard did not start')), 60000);
    });
    const specs = path.join(dir, '.pigry/e2e/specs/p');
    fs.mkdirSync(specs, { recursive: true });
    fs.writeFileSync(path.join(specs, 'about.cy.js'), "describe('about', () => { it('works', () => { cy.visit('/about'); cy.get('h1').should('have.text', 'About us'); }); });\n");
    const rec = (key, build) => runCli(['--base-url', url, '--record', dashUrl, '--key', key, '--ci-build-id', build, '--reporter', 'json', '--out', `out-${build}`], dir);

    assert.equal((await rec('web-r', 'x')).code, 2, 'a read key cannot record');
    assert.equal((await rec('web-w', 'web-1')).code, 0);
    assert.equal((await rec('api-w', 'api-1')).code, 0);

    const get = (p, key) => fetch(`${dashUrl}${p}${key ? `${p.includes('?') ? '&' : '?'}key=${key}` : ''}`);
    assert.equal((await get('/api/runs')).status, 401, 'no key is refused when projects are configured');
    const web = await (await get('/api/runs', 'web-r')).json();
    assert.deepEqual(web.map((r) => [r.project, r.buildId]), [['web', 'web-1']]);
    const api = await (await get('/api/runs', 'api-w')).json();
    assert.deepEqual(api.map((r) => [r.project, r.buildId]), [['api', 'api-1']]);
    assert.equal((await get(`/api/runs/${api[0].id}`, 'web-r')).status, 404, 'another project\'s run is invisible');
    assert.equal((await get(`/runs/${web[0].id}`, 'web-r')).status, 200);
    const all = await (await get('/api/runs', 'admin')).json();
    assert.equal(all.length, 2);
    const html = await (await get('/', 'web-r')).text();
    assert.match(html, /web-1/);
    assert.doesNotMatch(html, /api-1/);
    assert.match(html, /\/runs\/[^"]+\?key=web-r/);
  } finally {
    await new Promise((resolve) => { dash.once('close', resolve); dash.kill(); });
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('dashboard accounts: sign-up, sign-in, organizations with roles and project record keys', { timeout: 240000 }, async () => {
  const { server, url } = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigry-e2e-acc-'));
  const startDash = (extra) => {
    const child = spawn(process.execPath, [path.resolve('scripts/e2e-cli.mjs'), '--serve', '0', '--accounts', ...extra, '--dir', 'dashboard'], { cwd: dir });
    const ready = new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; const m = /dashboard (http:\/\/[^\s]+)/.exec(out); if (m) resolve(m[1]); });
      child.on('close', () => reject(new Error(`dashboard exited: ${out}`)));
      setTimeout(() => reject(new Error('dashboard did not start')), 60000);
    });
    return { child, ready };
  };
  const stop = (child) => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode) { resolve(); return; } child.once('close', resolve); child.kill(); });
  const first = startDash([]);
  let second = null;
  try {
    const dashUrl = await first.ready;
    const call = async (base, method, p, body, cookie) => {
      const res = await fetch(`${base}${p}`, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, json, text, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], headers: res.headers };
    };
    const c = (method, p, body, cookie) => call(dashUrl, method, p, body, cookie);

    // nothing is visible without signing in
    const anon = await c('GET', '/');
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/login');
    assert.equal((await c('GET', '/api/runs')).status, 401);
    assert.match((await c('GET', '/login')).text, /Create account/);

    // the first account bootstraps the dashboard; later sign-ups are closed
    assert.equal((await c('POST', '/auth/signup', { email: 'ada@example.com', password: 'short' })).status, 400);
    const ada = await c('POST', '/auth/signup', { email: 'ada@example.com', password: 'correct horse battery', name: 'Ada' });
    assert.equal(ada.status, 200);
    assert.match(ada.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await c('POST', '/auth/signup', { email: 'bob@example.com', password: 'another long password' })).status, 403);
    assert.equal((await c('POST', '/auth/login', { email: 'ada@example.com', password: 'wrong password!!' })).status, 401);

    const me = (await c('GET', '/api/me', null, ada.cookie)).json;
    assert.equal(me.email, 'ada@example.com');
    assert.equal(me.orgs.length, 1);
    assert.equal(me.orgs[0].role, 'owner');

    // an owner creates a project and gets a record key once; runs recorded with it belong to the organization
    const project = (await c('POST', `/api/orgs/${me.orgs[0].id}/projects`, { name: 'web' }, ada.cookie)).json;
    assert.match(project.recordKey, /^pgk_[0-9a-f]{48}$/);
    const specs = path.join(dir, '.pigry/e2e/specs/a');
    fs.mkdirSync(specs, { recursive: true });
    fs.writeFileSync(path.join(specs, 'about.cy.js'), "describe('about', () => { it('works', () => { cy.visit('/about'); cy.get('h1').should('have.text', 'About us'); }); });\n");
    const rec = await runCli(['--base-url', url, '--record', dashUrl, '--key', project.recordKey, '--ci-build-id', 'a1', '--reporter', 'json', '--out', 'out'], dir);
    assert.equal(rec.code, 0, rec.stdout + rec.stderr);
    assert.deepEqual((await c('GET', '/api/runs', null, ada.cookie)).json.map((r) => r.buildId), ['a1']);
    assert.equal((await c('POST', '/api/runs', { specs: ['x'] }, ada.cookie)).status, 401, 'a signed-in user cannot record without a record key');
    assert.match((await c('GET', '/', null, ada.cookie)).text, /ada@example\.com/);

    // logging out ends the session
    await c('POST', '/auth/logout', {}, ada.cookie);
    assert.equal((await c('GET', '/api/me', null, ada.cookie)).status, 401);

    // accounts persist across restarts; with open sign-up a second user is outside the organization until an owner adds them
    await stop(first.child);
    second = startDash(['--open-signup']);
    const url2 = await second.ready;
    const c2 = (method, p, body, cookie) => call(url2, method, p, body, cookie);
    const adaLogin = await c2('POST', '/auth/login', { email: 'ada@example.com', password: 'correct horse battery' });
    assert.equal(adaLogin.status, 200);
    const bob = await c2('POST', '/auth/signup', { email: 'bob@example.com', password: 'another long password', name: 'Bob' });
    assert.equal(bob.status, 200);
    assert.deepEqual((await c2('GET', '/api/runs', null, bob.cookie)).json, [], 'a user outside the organization sees no runs');
    const orgId = (await c2('GET', '/api/me', null, adaLogin.cookie)).json.orgs[0].id;
    assert.equal((await c2('POST', `/api/orgs/${orgId}/members`, { email: 'bob@example.com', role: 'viewer' }, bob.cookie)).status, 404, 'a non-member cannot add people');
    assert.equal((await c2('POST', `/api/orgs/${orgId}/members`, { email: 'bob@example.com', role: 'viewer' }, adaLogin.cookie)).status, 200);
    assert.equal((await c2('GET', '/api/runs', null, bob.cookie)).json.length, 1, 'the viewer now sees the organization runs');
    assert.equal((await c2('POST', `/api/orgs/${orgId}/projects`, { name: 'x' }, bob.cookie)).status, 403, 'a viewer cannot create projects');
    assert.equal((await c2('POST', `/api/orgs/${orgId}/members`, { email: 'ada@example.com', role: 'viewer' }, adaLogin.cookie)).status, 400, 'the last owner cannot be demoted');
  } finally {
    await stop(first.child).catch(() => undefined);
    if (second) await stop(second.child).catch(() => undefined);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('dashboard accounts: invitations, password reset tokens and sessions that survive a restart', { timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigry-e2e-inv-'));
  const startDash = () => {
    const child = spawn(process.execPath, [path.resolve('scripts/e2e-cli.mjs'), '--serve', '0', '--accounts', '--dir', 'dashboard'], { cwd: dir });
    const ready = new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; const m = /dashboard (http:\/\/[^\s]+)/.exec(out); if (m) resolve(m[1]); });
      child.on('close', () => reject(new Error(`dashboard exited: ${out}`)));
      setTimeout(() => reject(new Error('dashboard did not start')), 60000);
    });
    return { child, ready };
  };
  const stop = (child) => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode) { resolve(); return; } child.once('close', resolve); child.kill(); });
  let d = startDash();
  try {
    let base = await d.ready;
    const call = async (method, p, body, cookie) => {
      const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
    };
    const ada = await call('POST', '/auth/signup', { email: 'ada@example.com', password: 'correct horse battery', name: 'Ada' });
    const orgId = (await call('GET', '/api/me', null, ada.cookie)).json.orgs[0].id;

    // sign-up is closed, but an owner's invitation (for that email only, usable once) opens it
    const inv = await call('POST', `/api/orgs/${orgId}/invites`, { email: 'bob@example.com', role: 'member' }, ada.cookie);
    assert.equal(inv.status, 200);
    assert.match(inv.json.token, /^pgi_[0-9a-f]{48}$/);
    assert.equal((await call('POST', '/auth/signup', { email: 'eve@example.com', password: 'a perfectly fine password', invite: inv.json.token })).status, 400, 'another email cannot use the invitation');
    assert.equal((await call('POST', '/auth/signup', { email: 'eve@example.com', password: 'a perfectly fine password' })).status, 403);
    const bob = await call('POST', '/auth/signup', { email: 'bob@example.com', password: 'bobs long password', name: 'Bob', invite: inv.json.token });
    assert.equal(bob.status, 200);
    const bobMe = (await call('GET', '/api/me', null, bob.cookie)).json;
    assert.equal(bobMe.orgs.length, 1, 'the invited user joins the organization instead of getting their own');
    assert.equal(bobMe.orgs[0].role, 'member');
    assert.equal((await call('POST', '/auth/signup', { email: 'bob2@example.com', password: 'bobs long password', invite: inv.json.token })).status, 400, 'an invitation works once');

    // an owner hands out a password reset token; the old password and the old session stop working
    assert.equal((await call('POST', `/api/orgs/${orgId}/reset`, { email: 'bob@example.com' }, bob.cookie)).status, 403, 'members cannot reset passwords');
    const reset = await call('POST', `/api/orgs/${orgId}/reset`, { email: 'bob@example.com' }, ada.cookie);
    assert.match(reset.json.token, /^pgr_/);

    // sessions survive a restart
    await stop(d.child);
    d = startDash();
    base = await d.ready;
    assert.equal((await call('GET', '/api/me', null, ada.cookie)).status, 200, 'the session is still valid after a restart');

    assert.equal((await call('POST', '/auth/reset', { token: 'pgr_nope', password: 'a brand new password' })).status, 400);
    assert.equal((await call('POST', '/auth/reset', { token: reset.json.token, password: 'a brand new password' })).status, 200);
    assert.equal((await call('POST', '/auth/reset', { token: reset.json.token, password: 'another new password' })).status, 400, 'a reset token works once');
    assert.equal((await call('GET', '/api/me', null, bob.cookie)).status, 401, 'the old session was ended');
    assert.equal((await call('POST', '/auth/login', { email: 'bob@example.com', password: 'bobs long password' })).status, 401);
    assert.equal((await call('POST', '/auth/login', { email: 'bob@example.com', password: 'a brand new password' })).status, 200);
  } finally {
    await stop(d.child).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
