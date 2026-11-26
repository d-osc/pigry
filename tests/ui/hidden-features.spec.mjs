import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { CLI_PROVIDERS_ENABLED, IMPORT_AGENTS_ENABLED } from '../../src/lib/featureFlags.ts';

/** Provider CLI and Settings → Import agents are switched off for now: nothing of them shows and no CLI is scanned. */
test.skip(CLI_PROVIDERS_ENABLED || IMPORT_AGENTS_ENABLED, 'only meaningful while both features are switched off');

test('Settings has no Import agents section and AI Provider shows no Provider CLI', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__cliScans = 0;
    bridge.invoke = async (cmd, args) => {
      if (cmd === 'cli_detect') window.__cliScans += 1;
      return invoke(cmd, args);
    };
  });
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const menu = page.locator('.app-settings__menu-item');
  await expect(menu.filter({ hasText: 'AI Provider' })).toBeVisible();
  await expect(menu.filter({ hasText: 'Import agents' })).toHaveCount(0);

  await menu.filter({ hasText: 'AI Provider' }).click();
  await expect(page.getByRole('heading', { name: 'AI Provider', level: 2 })).toBeVisible();
  await expect(page.getByText('Provider CLI')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rescan CLIs' })).toHaveCount(0);
  await expect(page.getByTestId('cli-empty')).toHaveCount(0);

  // searching for an import keyword does not bring the section back
  await page.getByPlaceholder(/Search/i).first().fill('antigravity');
  await expect(page.getByRole('heading', { name: 'Import from other agents' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__cliScans)).toBe(0);
});
