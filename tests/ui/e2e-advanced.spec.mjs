import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { defineBridge, errorOf, installE2eEnvironment, installTestBrowser, runSpecIn, statusOf } from './e2e-helpers.mjs';

async function setup(page) {
  await installBackend(page);
  await openFixture(page);
  const browser = await installTestBrowser(page);
  await installE2eEnvironment(page, {});
  return browser;
}

const passed = (r) => Object.values(statusOf(r)).every((s) => s === 'passed' || s === 'pending');
const dump = (r) => r.result.tests.map((t) => `${t.title.at(-1)}: ${t.status} ${t.error?.message ?? ''}`).join('\n');

test('trusted input: clicks, hover, typing, key presses and delays go through the browser', async ({ page }) => {
  const { state } = await setup(page);
  const r = await runSpecIn(page, `
describe('real input', () => {
  beforeEach(() => { cy.visit('/'); });
  it('clicks with real mouse events', () => {
    cy.get('#inc').click();
    cy.get('#trusted').should('have.text', 'true');
    cy.get('#count').should('have.text', '1');
    cy.get('#inc').dblclick();
    cy.get('#count').should('have.text', '3');
  });
  it('hovers (real :hover CSS)', () => {
    cy.get('.late-item').should('exist');
    cy.get('.user').should('have.length', 2);
    cy.get('.tip-text').should('not.be.visible');
    cy.get('#hover-box').realHover();
    cy.get('.tip-text').should('be.visible');
  });
  it('types real keys, special keys and delays', () => {
    cy.get('#kbd').type('ab{backspace}c', { delay: 5 });
    cy.get('#kbd').should('have.value', 'ac');
    cy.get('#keys').should('contain.text', 'Backspace');
    cy.get('#trusted').should('have.text', 'true');
    cy.get('#kbd').type('{selectall}{backspace}new').should('have.value', 'new');
    cy.get('#kbd').clear().should('have.value', '');
  });
  it('presses keys', () => {
    cy.get('#kbd').focus();
    cy.press(Cypress.Keyboard.Keys.TAB);
    cy.focused().should('not.have.id', 'kbd');
  });
  it('checks real checkboxes', () => {
    cy.visit('/login');
    cy.get('#remember').check().should('be.checked');
    cy.get('#remember').uncheck().should('not.be.checked');
  });
  it('waits for a moving element before clicking it', () => {
    cy.get('#mover').click();
    cy.get('#moved-clicks').should('have.text', '1');
  });
  it('clicks inside an iframe with the frame offset', () => {
    cy.iframe('#frame').find('#in-frame').click();
    cy.iframe('#frame').find('#frame-out').should('have.text', 'clicked in frame');
  });
});
`, {}, { real: true });
  expect(passed(r), dump(r)).toBe(true);
  expect(state.inputs.length).toBeGreaterThan(20);
});

test('without trusted input the same commands still work with dispatched events', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
describe('simulated input', () => {
  beforeEach(() => { cy.visit('/'); });
  it('clicks and types', () => {
    cy.get('#inc').click();
    cy.get('#trusted').should('have.text', 'false');
    cy.get('#kbd').type('hi', { delay: 5 }).should('have.value', 'hi');
    cy.get('#hover-box').hover();
    cy.press('Tab');
  });
  it('waits for animations', () => {
    cy.get('#mover').click();
    cy.get('#moved-clicks').should('have.text', '1');
  });
  it('reaches into an iframe', () => {
    cy.iframe('#frame').find('#in-frame').click();
    cy.iframe('#frame').find('#frame-out').should('have.text', 'clicked in frame');
  });
});
`);
  expect(passed(r), dump(r)).toBe(true);
});

test('shadow DOM: includeShadowDom option, config and .shadow()', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
describe('shadow', () => {
  beforeEach(() => { cy.visit('/'); });
  it('does not see into a shadow root by default', () => {
    cy.get('.shadow-btn', { timeout: 300 }).should('not.exist');
  });
  it('pierces with the option', () => {
    cy.get('.shadow-btn', { includeShadowDom: true }).click();
    cy.get('#shadow-out').should('have.text', 'shadow clicked');
  });
  it('pierces with .shadow()', () => {
    cy.get('#shadow-host').shadow().find('.shadow-btn').should('have.text', 'Inside shadow');
  });
  it('contains() pierces too', () => {
    cy.contains('Inside shadow', { includeShadowDom: true }).should('exist');
  });
});
`);
  expect(passed(r), dump(r)).toBe(true);
  const cfg = await runSpecIn(page, `describe('c', () => { it('finds it with the global setting', () => { cy.visit('/'); cy.get('.shadow-btn').should('be.visible'); }); });`, { includeShadowDom: true });
  expect(passed(cfg), dump(cfg)).toBe(true);
});

test('cy.visit: headers, basic auth, status failures, onBeforeLoad, onLoad and POST', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
describe('visit options', () => {
  it('sends headers and clears them afterwards', () => {
    cy.visit('/echo-headers', { headers: { 'x-test': 'yes' } });
    cy.get('body').should('contain.text', '"x-test":"yes"');
    cy.visit('/echo-headers');
    cy.get('body').should('not.contain.text', 'x-test');
  });
  it('sends basic auth', () => {
    cy.visit('/auth', { auth: { username: 'u', password: 'p' } });
    cy.get('#auth').should('have.text', 'authorized Basic dTpw');
  });
  it('fails on a 401 unless told not to', () => {
    cy.visit('/auth', { failOnStatusCode: false });
    cy.get('#auth').should('have.text', 'denied');
  });
  it('fails on an error status', () => {
    cy.visit('/auth');
  });
  it('runs onBeforeLoad before the page scripts and onLoad after', () => {
    cy.visit('/', { onBeforeLoad: (win) => { win.__early = 'yes'; }, onLoad: (win) => { win.__loaded = win.document.title; } });
    cy.window().its('__early').should('eq', 'yes');
    cy.window().its('__loaded').should('eq', 'Test App');
  });
  it('posts a form', () => {
    cy.visit('/post-target', { method: 'POST', body: { a: '1', b: 'two' } });
    cy.get('#posted').should('have.text', 'POST a=1&b=two');
  });
});
`, {}, { real: true });
  const s = statusOf(r);
  expect(s['sends headers and clears them afterwards'], dump(r)).toBe('passed');
  expect(s['sends basic auth'], dump(r)).toBe('passed');
  expect(s['fails on a 401 unless told not to'], dump(r)).toBe('passed');
  expect(s['fails on an error status']).toBe('failed');
  expect(errorOf(r, 'fails on an error status')).toContain('cy.visit() failed trying to load');
  expect(errorOf(r, 'fails on an error status')).toContain('401');
  expect(s['runs onBeforeLoad before the page scripts and onLoad after'], dump(r)).toBe('passed');
  expect(s['posts a form'], dump(r)).toBe('passed');
  const noHeaders = await runSpecIn(page, `describe('h', () => { it('needs a capable browser', () => { cy.visit('/echo-headers', { headers: { a: 'b' } }); }); });`);
  expect(errorOf(noHeaders, 'needs a capable browser')).toContain('request headers');
});

test('cookies: httpOnly cookies are visible and can be set and cleared through the browser', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
describe('cookies', () => {
  it('reads an httpOnly cookie', () => {
    cy.visit('/set-cookie');
    cy.getCookie('sid').should('have.property', 'value', 'secret-token');
    cy.getCookie('sid').its('httpOnly').should('eq', true);
    cy.getCookies().should('have.length', 1);
    cy.window().its('document.cookie').should('eq', '');
  });
  it('sets and clears cookies', () => {
    cy.visit('/');
    cy.setCookie('flag', 'on');
    cy.getCookie('flag').its('value').should('eq', 'on');
    cy.clearCookie('flag');
    cy.getCookie('flag').should('eq', null);
    cy.setCookie('a', '1'); cy.setCookie('b', '2');
    cy.clearCookies();
    cy.getCookies().should('have.length', 0);
  });
  it('starts clean', () => {
    cy.getCookies().should('have.length', 0);
  });
});
`, {}, { real: true });
  expect(passed(r), dump(r)).toBe(true);
});

test('cy.screenshot options, cy.mount, cy.origin, cy.task, support file, pause and throttling', async ({ page }) => {
  await setup(page);
  const shots = await runSpecIn(page, `
describe('screenshots', () => {
  beforeEach(() => { cy.visit('/'); });
  it('takes element, clip, full page and blacked-out screenshots', () => {
    cy.get('h1').screenshot('heading', { padding: 4 });
    cy.screenshot('full', { capture: 'fullPage' });
    cy.screenshot('clip', { clip: { x: 0, y: 0, width: 200, height: 100 } });
    cy.screenshot('hidden-name', { blackout: ['#name'] });
    cy.get('h1').should('be.visible');
  });
});
`);
  expect(passed(shots), dump(shots)).toBe(true);
  const opts = shots.shotOpts.map((x) => x.o);
  expect(opts.find((o) => o?.clip && o.clip.w > 100 && o.clip.x >= 0)).toBeTruthy();
  expect(opts.some((o) => o?.fullPage === true)).toBe(true);
  expect(opts.some((o) => o?.clip && o.clip.w === 200 && o.clip.h === 100)).toBe(true);

  const misc = await runSpecIn(page, `
Cypress.tasks({ double: (n) => n * 2, nothing: () => undefined });
describe('misc', () => {
  it('mounts a component', () => {
    cy.mount('<button class="x">Hi</button>', { styles: '.x{color:red}' });
    cy.get('.x').should('have.text', 'Hi').and('have.css', 'color', 'rgb(255, 0, 0)');
    cy.mount(() => '<p id="p">from function</p>');
    cy.get('#p').should('have.text', 'from function');
  });
  it('runs cy.origin callbacks with arguments', () => {
    cy.visit('/');
    cy.origin('http://app.test', ['Ada'], (name) => { cy.get('#name').type(name); });
    cy.get('#name').should('have.value', 'Ada');
  });
  it('runs tasks', () => {
    cy.task('double', 21).should('eq', 42);
  });
  it('fails on a task without a result', () => { cy.task('nothing'); });
  it('fails on an unknown task', () => { cy.task('nope'); });
  it('throttles responses', () => {
    cy.intercept('/api/users', { body: [{ id: 1, name: 'Slow' }], throttleKbps: 1 }).as('slow');
    cy.visit('/');
    cy.wait('@slow').its('response.statusCode').should('eq', 200);
    cy.get('.user').should('have.text', 'Slow');
  });
  it('writes files inside the workspace but not outside', () => {
    cy.writeFile('tmp/out.txt', 'hello');
    cy.readFile('tmp/out.txt').should('eq', 'hello');
  });
  it('refuses to write outside the workspace', () => { cy.writeFile('../escape.txt', 'x'); });
  it('Cypress.Keyboard and Screenshot defaults exist', () => {
    expect(Cypress.Keyboard.Keys.ENTER).to.eq('Enter');
    Cypress.Screenshot.defaults({ padding: 3 });
  });
  it('queries more of the tree', () => {
    cy.visit('/');
    cy.get('#inc').parentsUntil('html').should('have.length.above', 0);
    cy.get('nav a').first().nextUntil('script').should('exist');
  });
});
`);
  const s = statusOf(misc);
  for (const t of ['mounts a component', 'runs cy.origin callbacks with arguments', 'runs tasks', 'throttles responses', 'writes files inside the workspace but not outside', 'Cypress.Keyboard and Screenshot defaults exist', 'queries more of the tree']) expect(s[t], dump(misc)).toBe('passed');
  expect(errorOf(misc, 'fails on a task without a result')).toContain('returned undefined');
  expect(errorOf(misc, 'fails on an unknown task')).toContain("task 'nope' was not handled");
  expect(errorOf(misc, 'refuses to write outside the workspace')).toContain('inside the workspace');

  const support = await runSpecIn(page, `
describe('with support file', () => {
  it('uses the custom command and the global hook', () => {
    cy.get('h1').should('have.text', 'Welcome home');
    cy.typeName('Grace');
    cy.get('#greeting').should('have.text', 'Hello, Grace');
  });
});
`, {}, { support: `
Cypress.Commands.add('typeName', (name) => { cy.get('#name').type(name); cy.get('#greet').click(); });
beforeEach(() => { cy.visit('/'); });
` });
  expect(passed(support), dump(support)).toBe(true);

  const pause = await runSpecIn(page, `
describe('pause', () => {
  it('stops and steps', () => {
    cy.visit('/');
    cy.pause();
    cy.get('h1').should('be.visible');
    cy.get('#inc').click();
    cy.get('#count').should('have.text', '1');
  });
});
`, {}, { pause: true });
  expect(passed(pause), dump(pause)).toBe(true);
  expect(pause.pauses[0]).toBe('pause');
  expect(pause.pauses.length).toBeGreaterThanOrEqual(3);
  expect(pause.pauses.slice(1)[0]).toMatch(/^(get|should)/);
});

test('TypeScript specs, JUnit XML, flaky detection and analytics', async ({ page }) => {
  await setup(page);
  // the first import of Monaco can make the dev server re-optimise and reload the page — warm it up
  for (let i = 0; i < 3; i += 1) {
    const ok = await page.evaluate(() => import('/src/extensions/e2e/engine/transpile.ts').then((m) => m.transpileTs('const a: number = 1;')).then(() => true, () => false)).catch(() => false);
    if (ok) break;
    await page.waitForLoadState('load');
    await page.waitForTimeout(1500);
    if (i < 2) { await openFixture(page); await defineBridge(page); await installE2eEnvironment(page, {}); }
  }
  const r = await runSpecIn(page, `
interface User { name: string }
const wanted: string = 'Welcome home';
let tries: number = 0;
describe('typed', () => {
  it('compiles', () => {
    const u: User = { name: 'x' };
    cy.visit('/');
    cy.get('h1').should('have.text', wanted as string);
    expect(u.name).to.eq('x');
  });
  it('is flaky', { retries: 2 }, () => {
    tries += 1;
    cy.visit('/');
    cy.get('h1').should(() => { if (tries < 2) throw new Error('first try fails'); });
  });
  it('fails for the report', () => {
    cy.visit('/');
    cy.get('#nope', { timeout: 300 });
  });
});
`, {}, { ts: true });
  expect(r.result.error ?? '').toBe('');
  expect(statusOf(r)).toEqual({ compiles: 'passed', 'is flaky': 'passed', 'fails for the report': 'failed' });
  expect(r.result.tests[1].flaky).toBe(true);
  expect(r.result.tests[1].attempts).toBe(2);

  const out = await page.evaluate(async (result) => {
    const { resultToJUnit, analyticsOf } = await import('/src/extensions/e2e/engine/spec.ts');
    const xml = resultToJUnit(result);
    const stats = { 'user/t': { 'a › slow': { runs: 4, passes: 4, fails: 0, flaky: 0, totalMs: 8000, lastMs: 2000, lastStatus: 'passed', lastAt: 1 }, 'a › flaky': { runs: 5, passes: 4, fails: 1, flaky: 2, totalMs: 500, lastMs: 100, lastStatus: 'passed', lastAt: 2 }, 'a › broken': { runs: 3, passes: 0, fails: 3, flaky: 0, totalMs: 300, lastMs: 100, lastStatus: 'failed', lastAt: 3 } } };
    return { xml, analytics: analyticsOf(stats) };
  }, r.result);
  expect(out.xml).toContain('<testsuite name="user/t" tests="3" failures="1"');
  expect(out.xml).toContain('<testcase name="typed › compiles"');
  expect(out.xml).toContain('<failure message="Timed out retrying after 300ms');
  expect(out.analytics.slowest[0].test).toBe('a › slow');
  expect(out.analytics.slowest[0].avgMs).toBe(2000);
  expect(out.analytics.flaky.map((f) => f.test)).toContain('a › flaky');
  expect(out.analytics.failing[0].test).toBe('a › broken');
  expect(out.analytics.failing[0].failRate).toBe(100);
});

test('Cypress events, test:before:run and the environment file', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
const seen = [];
Cypress.on('test:before:run', (t) => seen.push('before:' + t.title));
Cypress.on('test:after:run', (t) => seen.push('after:' + t.title + ':' + t.status));
describe('events', () => {
  it('first', () => { cy.visit('/'); });
  it('second', () => { cy.wrap(seen).its('length').should('be.gte', 2); });
});
`);
  expect(passed(r), dump(r)).toBe(true);
});

test('spec modules: relative require/import, JSON, TypeScript helpers and the plugins file', async ({ page }) => {
  await setup(page);
  for (let i = 0; i < 3; i += 1) {
    const ok = await page.evaluate(() => import('/src/extensions/e2e/engine/transpile.ts').then((m) => m.transpileTs('export const a: number = 1;')).then(() => true, () => false)).catch(() => false);
    if (ok) break;
    await page.waitForLoadState('load'); await page.waitForTimeout(1500);
    await openFixture(page); await defineBridge(page);
  }
  await installE2eEnvironment(page, {
    '.pigry/e2e/specs/user/pages/login.js': "module.exports = { open: function () { return cy.visit('/login'); }, selector: '#email' };",
    '.pigry/e2e/specs/user/data/users.json': JSON.stringify({ ada: 'ada@example.com' }),
    '.pigry/e2e/specs/user/helpers.ts': ["export const greeting: string = 'Hello';", 'export function shout(s: string): string { return s.toUpperCase(); }', 'export default function twice(n: number): number { return n * 2; }', ''].join(String.fromCharCode(10)),
    '.pigry/e2e/support/plugins.js': "module.exports = (on, config) => { on('task', { double: (n) => n * 2, hello: () => 'from plugin' }); config.env.fromPlugin = 'yes'; return config; };",
  });
  const files = (extra) => ({ esm: true, specPath: '.pigry/e2e/specs/user/mods.cy.js', ...extra });
  const r = await runSpecIn(page, `
import twice, { greeting, shout } from './helpers';
const login = require('./pages/login');
const users = require('./data/users.json');
describe('modules', () => {
  it('uses imported helpers, page objects and JSON', () => {
    expect(twice(4)).to.eq(8);
    expect(shout(greeting)).to.eq('HELLO');
    login.open();
    cy.get(login.selector).type(users.ada).should('have.value', 'ada@example.com');
  });
  it('uses lodash from the shims', () => {
    const _ = require('lodash');
    expect(_.sum([1, 2, 3])).to.eq(6);
  });
  it('explains packages it cannot load', () => { require('left-pad'); });
  it('reports a missing relative module', () => { require('./nope'); });
});
`, {}, files({ plugins: "module.exports = (on, config) => { on('task', { double: (n) => n * 2 }); config.env.fromPlugin = 'yes'; return config; };", pluginsPath: '.pigry/e2e/support/plugins.js' }));
  const s = statusOf(r);
  expect(r.result.error ?? '', dump(r)).toBe('');
  expect(s['uses imported helpers, page objects and JSON'], dump(r)).toBe('passed');
  expect(s['uses lodash from the shims'], dump(r)).toBe('passed');
  expect(s['explains packages it cannot load']).toBe('failed');
  expect(errorOf(r, 'explains packages it cannot load')).toContain("Cannot find module 'left-pad'");
  expect(errorOf(r, 'explains packages it cannot load')).toContain('npm run e2e');

  const missing = await runSpecIn(page, "const x = require('./gone'); describe('a', () => { it('b', () => {}); });", {}, files({}));
  expect(missing.result.status).toBe('error');
  expect(missing.result.error).toContain("Cannot find module './gone'");

  const plug = await runSpecIn(page, `
describe('plugins', () => {
  it('runs tasks and config from setupNodeEvents', () => {
    cy.task('double', 21).should('eq', 42);
    expect(Cypress.env('fromPlugin')).to.eq('yes');
  });
});
`, {}, { plugins: "module.exports = (on, config) => { on('task', { double: (n) => n * 2 }); config.env.fromPlugin = 'yes'; return config; };" });
  expect(passed(plug), dump(plug)).toBe(true);
  const broken = await runSpecIn(page, "describe('a', () => { it('b', () => {}); });", {}, { plugins: "module.exports = () => { throw new Error('plugin exploded'); };" });
  expect(broken.result.error).toContain('setupNodeEvents failed: plugin exploded');
});
