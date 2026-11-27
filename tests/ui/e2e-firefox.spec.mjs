import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { installE2eEnvironment, installTestBrowser } from './e2e-helpers.mjs';

const INSTALLED = [
  { id: 'edge', name: 'edge', family: 'chromium', channel: 'stable', displayName: 'Edge', version: '120.0.2210.61', path: 'C:\\Edge\\msedge.exe' },
  { id: 'firefox', name: 'firefox', family: 'firefox', channel: 'stable', displayName: 'Firefox', version: '133.0.3', path: 'C:\\Mozilla Firefox\\firefox.exe' },
  { id: 'firefox-dev', name: 'firefox', family: 'firefox', channel: 'dev', displayName: 'Firefox Developer Edition', version: '134.0b9', path: 'C:\\Firefox Developer Edition\\firefox.exe' },
];

/** Passes only when Cypress.browser / Cypress.isBrowser describe the stable Firefox. */
const SPEC_FIREFOX = `describe('Browser', () => {
  it('knows it runs in Firefox', () => {
    cy.visit('/');
    cy.wrap(Cypress.browser.name).should('eq', 'firefox');
    cy.wrap(Cypress.browser.family).should('eq', 'firefox');
    cy.wrap(Cypress.browser.majorVersion).should('eq', 133);
    cy.wrap(Cypress.isBrowser('firefox')).should('eq', true);
    cy.wrap(Cypress.isBrowser({ family: 'firefox' })).should('eq', true);
    cy.wrap(Cypress.isBrowser('chrome')).should('eq', false);
    cy.wrap(Cypress.isBrowser(['!firefox'])).should('eq', false);
    cy.get('h1').should('be.visible');
  });
});
`;

async function setup(page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installTestBrowser(page);
  await installE2eEnvironment(page, {
    '.pigry/e2e/e2e.config.json': JSON.stringify({ baseUrl: 'http://app.test', defaultCommandTimeout: 1500, video: true }),
    '.pigry/e2e/specs/user/ff.cy.js': SPEC_FIREFOX,
  });
  await page.evaluate((installed) => { window.__installedBrowsers = installed; localStorage.removeItem('pigry.e2e.browser'); }, INSTALLED);
  await page.getByRole('button', { name: 'E2E Testing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'E2E Testing', exact: true })).toBeVisible();
}

const tool = (page, name, input) => page.evaluate(async ({ name, input }) => {
  const { E2E_TOOLS } = await import('/src/extensions/e2e/engine/e2eTools.ts');
  return E2E_TOOLS.find((t) => t.name === name).run(input);
}, { name, input });

test('Firefox is in the Browser menu; a run in it reports Firefox and skips the video with a note', async ({ page }) => {
  await setup(page);
  const picker = page.getByRole('combobox', { name: 'Browser' });
  await expect(picker).toBeEnabled();
  await expect(picker.locator('option')).toHaveText(['Auto (Edge 120)', 'Edge 120', 'Firefox 133', 'Firefox Developer Edition 134']);

  // Chromium-only settings say nothing while a Chromium browser is picked …
  await page.getByRole('tab', { name: 'Settings' }).click();
  const settings = page.getByLabel('E2E settings');
  await expect(settings.getByRole('note')).toHaveCount(0);
  // … and say so once Firefox is picked
  await picker.selectOption('firefox');
  expect(await page.evaluate(() => window.__browserChoices)).toEqual(['firefox']);
  await expect(settings.getByRole('note')).toHaveCount(2);
  await expect(settings.getByRole('note').first()).toContainText('Chromium only');
  await expect(settings.getByRole('note').filter({ hasText: 'video' })).toContainText('Firefox runs skip the video');
  await expect(settings.getByRole('note').filter({ hasText: 'CORS' })).toBeVisible();

  await page.getByRole('tab', { name: 'Specs' }).click();
  const list = page.getByRole('complementary', { name: 'Specs, runs and settings' });
  await list.getByRole('button', { name: 'ff', exact: true }).click();
  await page.getByRole('button', { name: 'Run spec' }).click();
  const summary = page.getByRole('status', { name: 'Run summary' });
  await expect(summary.locator('.e2e-stat--pass')).toHaveText('1', { timeout: 30000 });
  await expect(summary.locator('.e2e-stat--fail')).toHaveText('0');
  await expect(summary.getByLabel('Browser')).toHaveText('Firefox 133');
  await expect(summary.getByRole('note')).toContainText('No video');
  // the video setting is on, but a Firefox run never starts a recording
  expect(await page.evaluate(() => window.__videos ?? [])).toEqual([]);
  const stored = await page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/e2e/results/user/ff.json')));
  expect(stored.browser).toBe('Firefox 133');
  expect(stored.notes?.[0] ?? '').toContain('No video');

  // back on a Chromium browser the notes go away
  await picker.selectOption('edge');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(settings.getByRole('note')).toHaveCount(0);
});

test('e2e_run runs in Firefox by name and says the video was skipped', async ({ page }) => {
  await setup(page);
  const out = await tool(page, 'e2e_run', { name: 'ff', browser: 'firefox' });
  expect(out).toContain('PASS user/ff');
  expect(out).toContain('(Firefox 133)');
  expect(out).toContain('note: No video');
  expect(await page.evaluate(() => window.__browserChoices.at(-1))).toBe('firefox');
  expect(await page.evaluate(() => window.__videos ?? [])).toEqual([]);

  // a Developer Edition run reports its own channel
  const dev = await tool(page, 'e2e_run', { name: 'ff', browser: 'firefox-dev' });
  expect(dev).toContain('FAIL user/ff');
  expect(dev).toContain('(Firefox Developer Edition 134)');
});
