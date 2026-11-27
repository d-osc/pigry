import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { SPEC_PASS, installE2eEnvironment, installTestBrowser } from './e2e-helpers.mjs';

const INSTALLED = [
  { id: 'edge', name: 'edge', family: 'chromium', channel: 'stable', displayName: 'Edge', version: '120.0.2210.61', path: 'C:\\Edge\\msedge.exe' },
  { id: 'chrome', name: 'chrome', family: 'chromium', channel: 'stable', displayName: 'Chrome', version: '120.0.6099.71', path: 'C:\\Chrome\\chrome.exe' },
  { id: 'chrome-canary', name: 'chrome', family: 'chromium', channel: 'canary', displayName: 'Chrome Canary', version: '122.0.6200.0', path: 'C:\\Canary\\chrome.exe' },
];

/** Passes only when Cypress.browser describes the browser picked for the run. */
const SPEC_BROWSER = `describe('Browser', () => {
  it('knows which browser it runs in', () => {
    cy.visit('/');
    cy.wrap(Cypress.browser.name).should('eq', 'chrome');
    cy.wrap(Cypress.browser.channel).should('eq', 'canary');
    cy.wrap(Cypress.browser.majorVersion).should('eq', 122);
    cy.wrap(Cypress.browser.family).should('eq', 'chromium');
  });
});
`;

async function setup(page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installTestBrowser(page);
  await installE2eEnvironment(page, {
    '.pigry/e2e/e2e.config.json': JSON.stringify({ baseUrl: 'http://app.test', defaultCommandTimeout: 1500 }),
    '.pigry/e2e/specs/user/home.cy.js': SPEC_PASS,
    '.pigry/e2e/specs/user/which.cy.js': SPEC_BROWSER,
  });
  await page.evaluate((installed) => { window.__installedBrowsers = installed; localStorage.removeItem('pigry.e2e.browser'); }, INSTALLED);
  await page.getByRole('button', { name: 'E2E Testing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'E2E Testing', exact: true })).toBeVisible();
}

const tool = (page, name, input) => page.evaluate(async ({ name, input }) => {
  const { E2E_TOOLS } = await import('/src/extensions/e2e/engine/e2eTools.ts');
  return E2E_TOOLS.find((t) => t.name === name).run(input);
}, { name, input });

test('the Browser menu lists installed browsers; the pick is used, kept and shown with the run', async ({ page }) => {
  await setup(page);
  const picker = page.getByRole('combobox', { name: 'Browser' });
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveValue('');
  await expect(picker.locator('option')).toHaveText(['Auto (Edge 120)', 'Edge 120', 'Chrome 120', 'Chrome Canary 122']);

  await picker.selectOption('chrome-canary');
  expect(await page.evaluate(() => localStorage.getItem('pigry.e2e.browser'))).toBe('chrome-canary');
  // picking tells the backend straight away, so the open test window switches too
  expect(await page.evaluate(() => window.__browserChoices)).toEqual(['chrome-canary']);

  // the run uses the pick: Cypress.browser describes it and the run bar names it
  const list = page.getByRole('complementary', { name: 'Specs, runs and settings' });
  await list.getByRole('button', { name: 'which', exact: true }).click();
  await page.getByRole('button', { name: 'Run spec' }).click();
  const summary = page.getByRole('status', { name: 'Run summary' });
  await expect(summary.locator('.e2e-stat--pass')).toHaveText('1', { timeout: 30000 });
  await expect(summary.locator('.e2e-stat--fail')).toHaveText('0');
  await expect(summary.getByLabel('Browser')).toHaveText('Chrome Canary 122');
  await expect(picker).toBeEnabled();
  expect(await page.evaluate(() => window.__browserChoices.at(-1))).toBe('chrome-canary');
  const stored = await page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/e2e/results/user/which.json')));
  expect(stored.browser).toBe('Chrome Canary 122');

  // back to Auto: the backend gets "" and runs in the first installed browser (Edge)
  await picker.selectOption('');
  expect(await page.evaluate(() => localStorage.getItem('pigry.e2e.browser'))).toBeNull();
  await list.getByRole('button', { name: 'home', exact: true }).click();
  await page.getByRole('button', { name: 'Run spec' }).click();
  await expect(summary.locator('.e2e-stat--pass')).toHaveText('2', { timeout: 30000 });
  await expect(summary.getByLabel('Browser')).toHaveText('Edge 120');
  expect(await page.evaluate(() => window.__browserChoices.at(-1))).toBe('');
});

test('e2e_run takes a browser for one run and refuses one that is not installed', async ({ page }) => {
  await setup(page);
  const ok = await tool(page, 'e2e_run', { name: 'which', browser: 'Chrome Canary' });
  expect(ok).toContain('PASS user/which');
  expect(ok).toContain('(Chrome Canary 122)');
  expect(await page.evaluate(() => window.__browserChoices.at(-1))).toBe('chrome-canary');
  // a one-off browser does not change what the user picked
  expect(await page.evaluate(() => localStorage.getItem('pigry.e2e.browser'))).toBeNull();

  const refused = await tool(page, 'e2e_run', { name: 'home', browser: 'firefox' });
  expect(refused).toContain('"firefox" is not installed');
  expect(refused).toContain('edge, chrome, chrome-canary');
});

test('a saved pick that is no longer installed is flagged in the Browser menu', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installTestBrowser(page);
  await installE2eEnvironment(page, { '.pigry/e2e/specs/user/home.cy.js': SPEC_PASS });
  await page.evaluate((installed) => { window.__installedBrowsers = installed; localStorage.setItem('pigry.e2e.browser', 'brave'); }, INSTALLED);
  await page.getByRole('button', { name: 'E2E Testing', exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Browser' });
  await expect(picker).toHaveValue('brave');
  await expect(picker.locator('option:checked')).toHaveText('brave (not installed)');
  await expect(page.locator('.e2e-browser--missing')).toBeVisible();
});
