import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { installE2eEnvironment, installTestBrowser } from './e2e-helpers.mjs';

const INSTALLED = [
  { id: 'edge', name: 'edge', family: 'chromium', channel: 'stable', displayName: 'Edge', version: '120.0.2210.61', path: 'C:\\Edge\\msedge.exe', engine: 'cdp' },
  { id: 'firefox', name: 'firefox', family: 'firefox', channel: 'stable', displayName: 'Firefox', version: '133.0.3', path: 'C:\\Mozilla Firefox\\firefox.exe', engine: 'bidi' },
  { id: 'pw-firefox', name: 'firefox', family: 'firefox', channel: 'stable', displayName: 'Playwright Firefox', version: '159.0', path: 'C:\\ms-playwright\\firefox-1572', engine: 'playwright' },
  { id: 'pw-webkit', name: 'webkit', family: 'webkit', channel: 'stable', displayName: 'Playwright WebKit', version: '', path: 'C:\\ms-playwright\\webkit-2388', engine: 'playwright' },
];

/** Passes only in WebKit. */
const SPEC_WEBKIT = `describe('Browser', () => {
  it('knows it runs in WebKit', () => {
    cy.visit('/');
    cy.wrap(Cypress.browser.name).should('eq', 'webkit');
    cy.wrap(Cypress.browser.family).should('eq', 'webkit');
    cy.wrap(Cypress.browser.displayName).should('eq', 'Playwright WebKit');
    cy.wrap(Cypress.isBrowser('webkit')).should('eq', true);
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
    '.pigry/e2e/specs/user/wk.cy.js': SPEC_WEBKIT,
  });
  await page.evaluate((installed) => { window.__installedBrowsers = installed; localStorage.removeItem('pigry.e2e.browser'); }, INSTALLED);
  await page.getByRole('button', { name: 'E2E Testing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'E2E Testing', exact: true })).toBeVisible();
}

const tool = (page, name, input) => page.evaluate(async ({ name, input }) => {
  const { E2E_TOOLS } = await import('/src/extensions/e2e/engine/e2eTools.ts');
  return E2E_TOOLS.find((t) => t.name === name).run(input);
}, { name, input });

test('Playwright builds are grouped in the Browser menu; a WebKit run reports WebKit and records its video', async ({ page }) => {
  await setup(page);
  const picker = page.getByRole('combobox', { name: 'Browser' });
  await expect(picker).toBeEnabled();
  await expect(picker.locator('option')).toHaveText(['Auto (Edge 120)', 'Edge 120', 'Firefox 133', 'Playwright Firefox 159', 'Playwright WebKit']);
  await expect(picker.locator('optgroup[label="Playwright"] option')).toHaveText(['Playwright Firefox 159', 'Playwright WebKit']);

  await picker.selectOption('pw-webkit');
  expect(await page.evaluate(() => window.__browserChoices)).toEqual(['pw-webkit']);
  // WebKit cannot turn web security off; video works with Playwright
  await page.getByRole('tab', { name: 'Settings' }).click();
  const settings = page.getByLabel('E2E settings');
  await expect(settings.getByRole('note')).toHaveCount(1);
  await expect(settings.getByRole('note')).toContainText('WebKit has no switch');

  await page.getByRole('tab', { name: 'Specs' }).click();
  const list = page.getByRole('complementary', { name: 'Specs, runs and settings' });
  await list.getByRole('button', { name: 'wk', exact: true }).click();
  await page.getByRole('button', { name: 'Run spec' }).click();
  const summary = page.getByRole('status', { name: 'Run summary' });
  await expect(summary.locator('.e2e-stat--pass')).toHaveText('1', { timeout: 30000 });
  await expect(summary.locator('.e2e-stat--fail')).toHaveText('0');
  await expect(summary.getByLabel('Browser')).toHaveText('Playwright WebKit');
  await expect(summary.getByRole('note')).toHaveCount(0);
  expect((await page.evaluate(() => window.__videos ?? [])).length).toBe(1);

  // Playwright Firefox records video too (unlike Firefox over WebDriver BiDi)
  await picker.selectOption('pw-firefox');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(settings.getByRole('note')).toHaveCount(1);
  await expect(settings.getByRole('note')).toContainText('CORS');
});

test('e2e_run picks a Playwright build by name', async ({ page }) => {
  await setup(page);
  const out = await tool(page, 'e2e_run', { name: 'wk', browser: 'webkit' });
  expect(out).toContain('PASS user/wk');
  expect(out).toContain('(Playwright WebKit)');
  expect(out).not.toContain('No video');
  expect(await page.evaluate(() => window.__browserChoices.at(-1))).toBe('pw-webkit');
  const ff = await tool(page, 'e2e_run', { name: 'wk', browser: 'pw-firefox' });
  expect(ff).toContain('FAIL user/wk');
  expect(ff).toContain('(Playwright Firefox 159)');
});
