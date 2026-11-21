import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { errorOf, installTestBrowser, runSpecIn, statusOf } from './e2e-helpers.mjs';

async function setup(page) {
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(() => { window.__worktree = new Map(); });
  return installTestBrowser(page);
}

test('runner: queries, actions and chained assertions with automatic retries', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
describe('home', () => {
  beforeEach(() => { cy.visit('/'); });

  it('reads the page', () => {
    cy.title().should('eq', 'Test App');
    cy.url().should('include', 'app.test');
    cy.get('h1').should('be.visible').and('have.text', 'Welcome home');
    cy.get('nav a').should('have.length', 2).first().should('have.attr', 'href', '/login');
    cy.contains('a', 'About').should('have.attr', 'href', '/about');
    cy.get('#inc').should('have.css', 'background-color', 'rgb(37, 99, 235)').and('have.class', 'primary');
    cy.get('[data-cy=inc]').should('exist');
    cy.get('.nope').should('not.exist');
    cy.get('#modal').should('not.be.visible');
  });

  it('clicks, retries and waits for late content', () => {
    cy.get('#inc').click().click().click();
    cy.get('#count').should('have.text', '3');
    cy.get('.late-item').should('contain.text', 'Loaded later');
    cy.get('.user').should('have.length', 2);
    cy.get('.user').first().should('have.text', 'Grace');
    cy.get('#open').click();
    cy.get('#modal').should('be.visible').within(() => {
      cy.contains('Modal body').should('be.visible');
      cy.get('#close').click();
    });
    cy.get('#modal').should('be.hidden');
  });

  it('types into inputs', () => {
    cy.get('#name').type('Ada Lovelace').should('have.value', 'Ada Lovelace');
    cy.get('#name').clear().type('Bob{enter}');
    cy.get('#name').should('have.value', 'Bob');
    cy.get('#greet').click();
    cy.get('#greeting').should('have.text', 'Hello, Bob');
    cy.get('#name').type('{selectall}{backspace}Zed').should('have.value', 'Zed');
  });

  it('works with aliases, then and each', () => {
    cy.get('.user').as('users');
    cy.get('@users').should('have.length', 2);
    cy.get('@users').each(($li, i) => { expect($li.text()).to.be.a('string'); expect(i).to.be.below(2); });
    cy.get('#count').then(($c) => { expect($c.text()).to.equal('0'); return 'done'; }).should('eq', 'done');
    cy.wrap({ a: { b: 5 } }).its('a.b').should('eq', 5);
    cy.get('#count').invoke('text').should('match', /^\\d$/);
  });
});
`);
  expect(r.result.error).toBeUndefined();
  expect(statusOf(r)).toEqual({ 'reads the page': 'passed', 'clicks, retries and waits for late content': 'passed', 'types into inputs': 'passed', 'works with aliases, then and each': 'passed' });
  expect(r.snapshots).toBeGreaterThan(5);
  const log = r.result.tests[1].log;
  expect(log.some((l) => l.name === 'click' && l.state === 'passed' && l.before !== undefined)).toBe(true);
  expect(log.some((l) => l.kind === 'assertion')).toBe(true);
});

test('runner: forms, checkboxes, selects, submit and the Enter key', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
describe('login', () => {
  beforeEach(() => { cy.visit('/login'); });
  it('shows an error for an empty form', () => {
    cy.contains('button', 'Sign in').click();
    cy.get('[role=alert]').should('be.visible').and('contain.text', 'required');
  });
  it('signs in', () => {
    cy.get('#email').type('ada@example.com');
    cy.get('#password').type('secret{enter}');
    cy.get('#welcome').should('have.text', 'Welcome ada@example.com');
    cy.getCookie('session').should('have.property', 'value', 'abc123');
    cy.window().its('localStorage.length').should('eq', 1);
  });
  it('checks and selects', () => {
    cy.get('#remember').check().should('be.checked');
    cy.get('#remember').uncheck().should('not.be.checked');
    cy.get('#lang').select('English').should('have.value', 'en');
    cy.get('#lang').select('th').should('have.value', 'th');
    cy.get('#lang').select(['es']);
    cy.get('#lang').should('have.value', 'es');
  });
  it('is isolated from the previous test', () => {
    cy.getCookies().should('have.length', 0);
    cy.window().its('localStorage.length').should('eq', 0);
  });
});
`);
  expect(r.result.error).toBeUndefined();
  expect(statusOf(r)).toEqual({ 'shows an error for an empty form': 'passed', 'signs in': 'passed', 'checks and selects': 'passed', 'is isolated from the previous test': 'passed' });
});

test('runner: failures carry Cypress-style messages, a code frame and a screenshot', async ({ page }) => {
  const { state } = await setup(page);
  const r = await runSpecIn(page, `
describe('failing', () => {
  beforeEach(() => { cy.visit('/'); });
  it('missing element', () => {
    cy.get('.does-not-exist');
  });
  it('wrong text', () => {
    cy.get('h1').should('have.text', 'Something else');
  });
  it('covered element', () => {
    cy.get('#cover-on').click();
    cy.get('#inc').click();
  });
  it('hidden element', () => {
    cy.get('#modal span').click();
  });
  it('multiple elements', () => {
    cy.get('nav a').click();
  });
  it('page error', () => {
    cy.get('#boom').click();
    cy.wait(100);
  });
  it('bad api call', () => {
    cy.request({ url: '/missing', failOnStatusCode: true });
  });
});
`, { defaultCommandTimeout: 600 });
  expect(statusOf(r)).toEqual({ 'missing element': 'failed', 'wrong text': 'failed', 'covered element': 'failed', 'hidden element': 'failed', 'multiple elements': 'failed', 'page error': 'failed', 'bad api call': 'failed' });
  expect(errorOf(r, 'missing element')).toContain('Expected to find element: `.does-not-exist`, but never found it.');
  expect(errorOf(r, 'missing element')).toContain('Timed out retrying after 600ms');
  expect(errorOf(r, 'wrong text')).toContain("expected <h1> to have text 'Something else'");
  expect(errorOf(r, 'covered element')).toContain('being covered by another element');
  expect(errorOf(r, 'hidden element')).toContain('not visible');
  expect(errorOf(r, 'multiple elements')).toContain('can only be called on a single element');
  expect(errorOf(r, 'page error')).toContain('app exploded');
  expect(errorOf(r, 'bad api call')).toContain('404');
  const first = r.result.tests[0];
  expect(first.error.frame.lines.find((l) => l.hit).text).toContain("cy.get('.does-not-exist')");
  expect(first.error.line).toBe(5);
  expect(first.screenshots.some((s) => s.includes('failed'))).toBe(true);
  expect(state.shots.length).toBeGreaterThanOrEqual(7);
});

test('runner: intercept stubs, aliases, waits, request and spies on the network', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
describe('network', () => {
  it('stubs a response', () => {
    cy.intercept('GET', '**/api/users', { statusCode: 200, body: [{ id: 9, name: 'Stubbed Sam' }] }).as('users');
    cy.visit('/');
    cy.wait('@users').its('response.body.0.name').should('eq', 'Stubbed Sam');
    cy.get('.user').should('have.length', 1).and('have.text', 'Stubbed Sam');
  });
  it('simulates a server error', () => {
    cy.intercept('/api/users', { statusCode: 500, body: { message: 'boom' } }).as('users');
    cy.visit('/');
    cy.wait('@users').its('response.statusCode').should('eq', 500);
    cy.contains('Could not load users').should('be.visible');
  });
  it('spies without stubbing and reads the real response', () => {
    cy.intercept('GET', '/api/users').as('real');
    cy.visit('/');
    cy.wait('@real').then((i) => {
      expect(i.response.statusCode).to.eq(200);
      expect(i.response.body).to.have.length(2);
      expect(i.request.method).to.eq('GET');
    });
  });
  it('uses fixtures and handlers', () => {
    cy.writeFile('.pigry/e2e/fixtures/people.json', [{ id: 3, name: 'From Fixture' }]);
    cy.intercept('/api/users', { fixture: 'people.json' }).as('fx');
    cy.visit('/');
    cy.get('.user').should('have.text', 'From Fixture');
    cy.fixture('people').its('0.name').should('eq', 'From Fixture');
  });
  it('handler functions can reply', () => {
    cy.intercept('/api/users', (req) => { req.reply({ statusCode: 200, body: [{ id: 1, name: 'Handled ' + req.method }] }); }).as('h');
    cy.visit('/');
    cy.get('.user').should('have.text', 'Handled GET');
  });
  it('delays, counts and forces failures', () => {
    cy.intercept('/api/users', { forceNetworkError: true }).as('bad');
    cy.visit('/');
    cy.contains('Could not load users').should('be.visible');
    cy.get('@bad.all').should('have.length', 1);
  });
  it('requests an endpoint directly', () => {
    cy.visit('/');
    cy.request('/api/health').then((res) => { expect(res.status).to.eq(200); expect(res.body).to.deep.equal({ ok: true }); });
    cy.request('/api/health').its('body.ok').should('eq', true);
    cy.request({ url: '/nope', failOnStatusCode: false }).its('status').should('eq', 404);
  });
});
`);
  expect(r.result.error).toBeUndefined();
  expect(Object.values(statusOf(r))).toEqual(Array(7).fill('passed'));
});

test('runner: viewport, clock, dialogs, uncaught errors, hooks, only/skip and retries', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
const order = [];
describe('misc', () => {
  before(() => { order.push('before'); });
  beforeEach(() => { order.push('beforeEach'); cy.visit('/'); });
  afterEach(() => { order.push('afterEach'); });
  after(() => { order.push('after'); });

  it('uses viewport presets', () => {
    cy.viewport('iphone-6');
    cy.window().its('innerWidth').should('eq', 375);
    cy.viewport(900, 500);
    cy.window().its('innerHeight').should('eq', 500);
  });
  it('fakes time with cy.clock', () => {
    cy.clock();
    cy.get('#timer').click();
    cy.get('#clock-out').should('have.text', '');
    cy.tick(5000);
    cy.get('#clock-out').should('have.text', 'ticked');
  });
  it('handles confirm and alert', () => {
    cy.on('window:confirm', () => false);
    cy.get('#ask').click();
    cy.get('#answer').should('have.text', 'no');
    cy.on('window:alert', (msg) => { expect(msg).to.eq('hi there'); });
    cy.get('#shout').click();
  });
  it('ignores an uncaught exception on request', () => {
    Cypress.on('uncaught:exception', () => false);
    cy.get('#boom').click();
    cy.wait(80);
    cy.get('h1').should('be.visible');
  });
  it.skip('is skipped', () => { cy.get('nope'); });
  it('custom commands work', () => {
    Cypress.Commands.add('greet', (name) => { cy.get('#name').type(name); cy.get('#greet').click(); });
    cy.greet('Custom');
    cy.get('#greeting').should('contain.text', 'Custom');
  });
  it('session caches a login', () => {
    cy.session('ada', () => { cy.visit('/login'); cy.get('#email').type('ada@x.io'); cy.get('#password').type('pw{enter}'); cy.get('#welcome').should('exist'); });
    cy.visit('/login');
    cy.window().its('localStorage.user').should('eq', 'ada@x.io');
  });
  it('exec, readFile and writeFile', () => {
    cy.exec('echo hi').its('stdout').should('contain', 'echo hi');
    cy.writeFile('.pigry/e2e/fixtures/out.json', { a: 1 });
    cy.readFile('.pigry/e2e/fixtures/out.json').its('a').should('eq', 1);
    cy.log('done logging');
  });
});
let flaky = 0;
describe('retries', () => {
  it('passes on the second attempt', { retries: 2 }, () => {
    flaky += 1;
    cy.visit('/');
    cy.get('h1').should(() => { if (flaky < 2) throw new Error('flaky failure'); });
  });
});
`);
  expect(r.result.error).toBeUndefined();
  const s = statusOf(r);
  expect(s['uses viewport presets']).toBe('passed');
  expect(s['fakes time with cy.clock']).toBe('passed');
  expect(s['handles confirm and alert']).toBe('passed');
  expect(s['ignores an uncaught exception on request']).toBe('passed');
  expect(s['is skipped']).toBe('pending');
  expect(s['custom commands work']).toBe('passed');
  expect(s['session caches a login']).toBe('passed');
  expect(s['exec, readFile and writeFile']).toBe('passed');
  expect(s['passes on the second attempt']).toBe('passed');
  expect(r.result.tests.find((t) => t.title.at(-1) === 'passes on the second attempt').attempts).toBe(2);
  expect(r.result.pending).toBe(1);
});

test('runner: commands returned from callbacks and custom commands are followed', async ({ page }) => {
  await setup(page);
  const r = await runSpecIn(page, `
Cypress.Commands.add('heading', () => cy.get('h1'));
Cypress.Commands.add('pageTitle', () => cy.title());
describe('chainables', () => {
  beforeEach(() => { cy.visit('/'); });
  it('uses a custom command that returns a chain', () => {
    cy.heading().should('have.text', 'Welcome home');
    cy.pageTitle().should('eq', 'Test App');
  });
  it('follows chains returned from then()', () => {
    cy.wrap(1).then((n) => cy.wrap(n + 1)).should('eq', 2);
    cy.get('#inc').then(() => cy.get('#count')).should('have.text', '0');
    cy.wrap('x').then((v) => { cy.get('h1').should('exist'); return v + 'y'; }).should('eq', 'xy');
  });
});
`);
  expect(Object.values(statusOf(r))).toEqual(['passed', 'passed']);
});

test('runner: .only, spec syntax errors and stop requests', async ({ page }) => {
  await setup(page);
  const only = await runSpecIn(page, `
describe('a', () => {
  it('one', () => { cy.visit('/'); });
  it.only('two', () => { cy.visit('/about'); cy.get('.blurb').should('have.text', 'We test things.'); });
  it('three', () => { cy.visit('/'); });
});`);
  expect(statusOf(only)).toEqual({ one: 'pending', two: 'passed', three: 'pending' });
  const bad = await runSpecIn(page, 'describe("x", () => { it("y", () => { cy.visit( ); });');
  expect(bad.result.status).toBe('error');
  expect(bad.result.error).toContain('could not be loaded');
  const unknown = await runSpecIn(page, 'describe("x", () => { it("y", () => { cy.doesNotExist(); }); });');
  expect(errorOf(unknown, 'y')).toContain('cy.doesNotExist is not a function');
});
