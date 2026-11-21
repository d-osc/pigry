import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { SPEC_FAIL, SPEC_PASS, installE2eEnvironment, installTestBrowser } from './e2e-helpers.mjs';

async function setup(page, seed = {}) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  const browser = await installTestBrowser(page);
  await installE2eEnvironment(page, {
    '.pigry/e2e/e2e.config.json': JSON.stringify({ baseUrl: 'http://app.test', defaultCommandTimeout: 1500, networkEvidence: true }),
    '.pigry/e2e/specs/user/home.cy.js': SPEC_PASS,
    '.pigry/e2e/specs/user/broken.cy.js': SPEC_FAIL,
    ...seed,
  });
  await page.getByRole('button', { name: 'E2E Testing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'E2E Testing', exact: true })).toBeVisible();
  return browser;
}

test('E2E menu: specs, editor, run with a live command log, time travel and results', async ({ page }) => {
  await setup(page);
  const list = page.getByRole('complementary', { name: 'Specs, runs and settings' });
  await expect(list.getByText('home', { exact: true })).toBeVisible();
  await expect(list.getByText('broken', { exact: true })).toBeVisible();

  await list.getByRole('button', { name: 'home', exact: true }).click();
  await expect(page.getByTestId('e2e-editor')).toBeVisible();
  await expect(page.locator('.e2e-bar__name')).toHaveText('user/home');

  await page.getByRole('button', { name: 'Run spec' }).click();
  const summary = page.getByRole('status', { name: 'Run summary' });
  await expect(summary.locator('.e2e-stat--pass')).toHaveText('2', { timeout: 30000 });
  await expect(summary.locator('.e2e-stat--fail')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible();

  // the reporter shows suites, tests and every command
  const reporter = page.getByLabel('Tests and commands');
  await expect(reporter.getByText('Home page', { exact: true })).toBeVisible();
  await reporter.getByRole('button', { name: /counts clicks/ }).click();
  await expect(reporter.locator('.e2e-cmd__name', { hasText: /^click$/ })).toHaveCount(2);
  await expect(reporter.locator('.e2e-cmd--assertion').first()).toContainText('have text');

  // time travel: pinning a click shows the page before it; "After" shows the new count
  await reporter.locator('.e2e-cmd', { hasText: 'click' }).first().click();
  const frame = page.frameLocator('iframe[title="Page snapshot"]');
  await expect(frame.locator('h1')).toHaveText('Welcome home');
  await page.getByRole('group', { name: 'Snapshot' }).getByRole('button', { name: 'Before' }).click();
  await expect(frame.locator('#count')).toHaveText('0');
  await page.getByRole('group', { name: 'Snapshot' }).getByRole('button', { name: 'After' }).click();
  await expect(frame.locator('#count')).toHaveText('1');
  await expect(frame.locator('[data-cy-target]')).toHaveCount(0);
  await page.getByRole('group', { name: 'Snapshot' }).getByRole('button', { name: 'Before' }).click();
  await expect(frame.locator('[data-cy-target]')).toHaveAttribute('id', 'inc');

  // results are stored for the runs tab and the agent tools
  const stored = await page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/e2e/results/user/home.json')));
  expect(stored.status).toBe('passed');
  expect(stored.tests.map((t) => t.status)).toEqual(['passed', 'passed']);
  expect(await page.evaluate(() => window.__network.length)).toBe(2);
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.getByRole('button', { name: /user\/home/ })).toContainText('2✓');
});

test('E2E menu: a failing spec shows the error, code frame, screenshot and marks the editor', async ({ page }) => {
  await setup(page);
  const list = page.getByRole('complementary', { name: 'Specs, runs and settings' });
  await list.getByRole('button', { name: 'broken', exact: true }).click();
  await page.getByRole('button', { name: 'Run spec' }).click();
  const summary = page.getByRole('status', { name: 'Run summary' });
  await expect(summary.locator('.e2e-stat--fail')).toHaveText('1', { timeout: 30000 });
  await expect(summary.locator('.e2e-stat--pass')).toHaveText('1');

  const error = page.getByRole('alert').filter({ hasText: 'never found it' });
  await expect(error).toContainText('Timed out retrying after 1500ms');
  await expect(error).toContainText('#nope');
  const frame = page.getByLabel('Code frame');
  await expect(frame.locator('.e2e-frame__line--hit')).toContainText("cy.get('#nope')");
  await expect(page.locator('.e2e-evidence__item')).toHaveCount(1);
  expect(await page.evaluate(() => window.__shots.some((s) => s.includes('failed')))).toBe(true);

  // the failing line opens in the editor
  await frame.locator('.e2e-frame__line--hit').click();
  await expect(page.getByTestId('e2e-editor')).toBeVisible();
});

test('E2E menu: settings are saved to the workspace', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const base = page.getByLabel('Base URL');
  await expect(base).toHaveValue('http://app.test');
  await base.fill('http://localhost:5173/');
  await base.blur();
  await page.getByLabel('Command timeout (ms)').fill('2500');
  await page.getByLabel('Command timeout (ms)').blur();
  await page.getByLabel('Record video').check();
  await page.getByLabel('Retries').fill('2');
  await page.getByLabel('Retries').blur();
  await page.getByLabel('Viewport preset').selectOption('iphone-x');
  await page.getByLabel('Environment variables').fill('{"user": "ada"}');
  await page.getByLabel('Environment variables').blur();
  await expect.poll(async () => page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/e2e/e2e.config.json')))).toMatchObject({
    baseUrl: 'http://localhost:5173', defaultCommandTimeout: 2500, video: true, retries: 2, viewportWidth: 375, viewportHeight: 812, env: { user: 'ada' },
  });
  await page.getByLabel('Environment variables').fill('{oops');
  await page.getByLabel('Environment variables').blur();
  await expect(page.getByRole('alert').filter({ hasText: 'Not valid JSON' })).toBeVisible();
});

test('E2E menu: new spec from a template, selector playground and the Studio recorder', async ({ page }) => {
  const { pageB } = await setup(page);
  await page.getByRole('button', { name: 'New spec' }).click();
  await page.getByRole('radio', { name: 'Form & login' }).click();
  await page.getByLabel('New spec name').fill('Checkout flow');
  await page.getByLabel('New spec name').press('Enter');
  await expect(page.locator('.e2e-bar__name')).toHaveText('user/checkout-flow');
  expect(await page.evaluate(() => window.__worktree.get('.pigry/e2e/specs/user/checkout-flow.cy.js'))).toContain("describe('Sign in form'");

  // selector playground: open the app, count matches, get a stable suggestion
  await page.getByRole('button', { name: 'Playground' }).click();
  const tool = page.getByRole('complementary', { name: 'Selector playground' });
  await tool.getByLabel('Page URL').fill('http://app.test/');
  await tool.getByRole('button', { name: 'Open' }).click();
  await tool.getByLabel('CSS selector').fill('button.primary');
  await expect(tool.getByRole('status')).toContainText('1 element matches');
  await expect(tool.getByLabel('Suggested command')).toHaveText("cy.get('[data-cy=\"inc\"]')");
  await tool.getByLabel('CSS selector').fill('li.user');
  await expect(tool.getByRole('status')).toContainText('2 elements match');
  await tool.getByLabel('CSS selector').fill('nav a:contains("About")');
  await expect(tool.getByRole('status')).toContainText('1 element matches');
  await tool.getByLabel('CSS selector').fill('.nothing-here');
  await expect(tool.getByRole('status')).toContainText('0 elements match');
  // the picker returns what is clicked in the test browser
  await tool.getByLabel('CSS selector').fill('');
  await tool.getByRole('button', { name: 'Pick' }).click();
  await expect(tool.getByText('Click an element in the test browser window…')).toBeVisible();
  await pageB.click('#greet');
  await expect(tool.getByLabel('Suggested command')).toHaveText("cy.get('#greet')");

  // Studio: record clicks and typing, then insert the commands into the spec
  await page.getByRole('button', { name: 'Studio' }).click();
  const studio = page.getByRole('complementary', { name: 'Studio' });
  await studio.getByLabel('Start URL').fill('http://app.test/');
  await studio.getByRole('button', { name: 'Record' }).click();
  await expect(studio.getByText('Click, type, check and select')).toBeVisible();
  await pageB.click('#inc');
  await pageB.fill('#name', 'Ada');
  await pageB.press('#name', 'Enter');
  await pageB.click('#open');
  const code = studio.getByLabel('Recorded commands');
  await expect(code).toContainText("cy.visit('/');", { timeout: 15000 });
  await expect(code).toContainText("cy.get('[data-cy=\"inc\"]').click();");
  await expect(code).toContainText("cy.get('#name').clear().type('Ada{enter}');");
  await expect(code).toContainText("cy.get('#open').click();");
  await studio.getByRole('button', { name: 'Stop' }).click();
  await studio.getByRole('button', { name: 'Insert into spec' }).click();
  await expect.poll(async () => page.evaluate(() => window.__worktree.get('.pigry/e2e/specs/user/checkout-flow.cy.js')), { timeout: 10000 }).toContain("cy.get('#open').click();");
});

test('E2E menu: run all, watch mode and re-running a stored run', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Run all' }).click();
  await expect.poll(async () => page.evaluate(() => [...window.__worktree.keys()].filter((k) => /^\.pigry\/e2e\/results\/[^/]+\/[^/]+\.json$/.test(k) && !k.endsWith('.replay.json')).length), { timeout: 60000 }).toBe(2);
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible();
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.getByRole('button', { name: /user\/broken/ })).toBeVisible();
  await page.getByRole('button', { name: /user\/home/ }).click();
  await expect(page.getByText('Stored results keep the command log and evidence files')).toBeVisible();
  await page.getByRole('tab', { name: 'Runs' }).click();
  await page.getByRole('button', { name: /user\/broken/ }).click();
  await expect(page.getByLabel('Tests and commands')).toContainText('finds the missing button');
  // a failed run keeps its DOM snapshots (local Test Replay): time travel still works afterwards
  await page.getByLabel('Tests and commands').locator('.e2e-cmd', { hasText: 'visit' }).first().click();
  await expect(page.frameLocator('iframe[title="Page snapshot"]').locator('h1')).toHaveText('Welcome home');
  expect(await page.evaluate(() => window.__worktree.has('.pigry/e2e/results/user/broken.replay.json'))).toBe(true);
  expect(await page.evaluate(() => window.__worktree.has('.pigry/e2e/results/user/home.replay.json'))).toBe(false);
});

test('E2E menu: pause and step through commands, flaky marks, reports, TypeScript specs, analytics and new settings', async ({ page }) => {
  await setup(page, {
    '.pigry/e2e/specs/user/paused.cy.js': `describe('Paused', () => {
  it('stops in the middle', () => {
    cy.visit('/');
    cy.pause();
    cy.get('h1').should('have.text', 'Welcome home');
  });
});
`,
    '.pigry/e2e/specs/user/unstable.cy.js': `let tries = 0;
describe('Unstable', () => {
  it('passes on the second try', { retries: 2 }, () => {
    tries += 1;
    cy.visit('/');
    cy.get('h1').should(() => { if (tries < 2) throw new Error('first try fails'); });
  });
});
`,
  });
  const list = page.getByRole('complementary', { name: 'Specs, runs and settings' });
  const summary = page.getByRole('status', { name: 'Run summary' });

  // cy.pause() waits for Resume; Step stops before every command
  await list.getByRole('button', { name: 'paused', exact: true }).click();
  await page.getByRole('button', { name: 'Run spec' }).click();
  const paused = page.getByRole('status', { name: 'Paused' });
  await expect(paused).toBeVisible({ timeout: 20000 });
  await expect(paused).toContainText('Paused');
  await paused.getByRole('button', { name: 'Resume' }).click();
  await expect(summary.locator('.e2e-stat--pass')).toHaveText('1', { timeout: 20000 });
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(paused).toContainText('visit', { timeout: 20000 });
  await paused.getByRole('button', { name: 'Next command' }).click();
  await expect(paused).toContainText('pause', { timeout: 20000 });
  await paused.getByRole('button', { name: 'Next command' }).click();
  await expect(paused).toContainText('get');
  await paused.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 20000 });

  // flaky tests are marked, the report and JUnit files are written
  await list.getByRole('button', { name: 'unstable', exact: true }).click();
  await page.getByRole('button', { name: 'Run spec' }).click();
  await expect(page.getByLabel('Tests and commands').getByText('flaky', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByLabel('Tests and commands').getByText('attempt 2')).toBeVisible();
  await page.getByRole('button', { name: 'Report' }).click();
  await expect.poll(async () => page.evaluate(() => window.__worktree.get('.pigry/reports/user/e2e-user-unstable.md') ?? '')).toContain('# E2E report — user/unstable');
  const junit = await page.evaluate(() => window.__worktree.get('.pigry/e2e/results/user/unstable.junit.xml'));
  expect(junit).toContain('<testcase name="Unstable › passes on the second try"');
  await expect(page.getByRole('button', { name: 'JUnit' })).toBeVisible();

  // analytics from the stored runs
  await list.getByRole('button', { name: 'broken', exact: true }).click().catch(() => undefined);
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.getByLabel('Analytics')).toContainText('Flaky');
  await expect(page.getByLabel('Analytics')).toContainText('passes on the second try');
  await expect(page.getByLabel('Analytics')).toContainText('Slowest');

  // a TypeScript spec from the new-spec form
  await page.getByRole('tab', { name: 'Specs' }).click();
  await page.getByRole('button', { name: 'New spec' }).click();
  await page.getByRole('radio', { name: 'TypeScript' }).click();
  await page.getByLabel('New spec name').fill('typed check');
  await page.getByLabel('New spec name').press('Enter');
  await expect(page.locator('.e2e-bar__name')).toHaveText('user/typed-check');
  expect(await page.evaluate(() => [...window.__worktree.keys()].includes('.pigry/e2e/specs/user/typed-check.cy.ts'))).toBe(true);
  await expect(list.locator('.e2e-ts')).toHaveCount(1);
  await page.getByRole('button', { name: 'Run spec' }).click();
  await expect(summary.locator('.e2e-stat--pass')).toHaveText('1', { timeout: 40000 });

  // new settings
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Pierce shadow DOM').check();
  await page.getByLabel('Trusted input').uncheck();
  await page.getByLabel('Web security').uncheck();
  await page.getByLabel('Support file').fill('.pigry/e2e/support/custom.js');
  await page.getByLabel('Support file').blur();
  await expect.poll(async () => page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/e2e/e2e.config.json')))).toMatchObject({
    includeShadowDom: true, realInput: false, chromeWebSecurity: false, supportFile: '.pigry/e2e/support/custom.js',
  });
});

test('E2E menu: specs that already live in the repository (cypress/e2e) run with their support file, fixtures and env', async ({ page }) => {
  await setup(page, {
    'cypress/e2e/auth/login.cy.js': `describe('Repo login', () => {
  it('uses the repository support file, fixture and env', () => {
    cy.visit('/');
    cy.shout();
    cy.fixture('people').its('0.name').should('eq', 'Ada from cypress/fixtures');
    cy.wrap(Cypress.env('token')).should('eq', 'from-cypress-env');
  });
});
`,
    'cypress/support/e2e.js': "Cypress.Commands.add('shout', () => { cy.get('h1').should('have.text', 'Welcome home'); });",
    'cypress/fixtures/people.json': JSON.stringify([{ name: 'Ada from cypress/fixtures' }]),
    'cypress.env.json': JSON.stringify({ token: 'from-cypress-env' }),
  });
  const list = page.getByRole('complementary', { name: 'Specs, runs and settings' });
  await expect(list.getByText('repo', { exact: true })).toBeVisible();
  await list.getByRole('button', { name: 'auth-login', exact: true }).click();
  await expect(page.locator('.e2e-bar__name')).toHaveText('repo/auth-login');
  await page.getByRole('button', { name: 'Run spec' }).click();
  await expect(page.getByRole('status', { name: 'Run summary' }).locator('.e2e-stat--pass')).toHaveText('1', { timeout: 30000 });
  await expect(list.getByText('people.json')).toBeVisible();
});

test('E2E menu: type errors of a .cy.ts spec are shown as warnings (checked against the Cypress typings)', async ({ page }) => {
  await setup(page, {
    '.pigry/e2e/specs/user/types.cy.ts': `const n: number = 'not a number';
describe('Types', () => {
  it('has a type error', () => {
    cy.visit('/');
    cy.get('h1').shouldd('exist');
  });
});
`,
  });
  const list = page.getByRole('complementary', { name: 'Specs, runs and settings' });
  await list.getByRole('button', { name: /types/ }).first().click();
  const problems = page.getByRole('list', { name: 'Spec problems' });
  await expect(problems).toContainText("TS line 1: Type 'string' is not assignable to type 'number'", { timeout: 40000 });
  await expect(problems).toContainText("shouldd");
});
