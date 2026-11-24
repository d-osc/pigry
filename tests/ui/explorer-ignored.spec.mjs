import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Git-ignored files and folders are listed in the Explorer tree but drawn faded, like VS Code. */
test('ignored files and folders are shown faded in the Explorer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_file_tree') { const base = await invoke(cmd, args); return { ...base, ignored: ['node_modules/', 'debug.log'] }; }
      return invoke(cmd, args);
    };
  });
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Explorer$/ }) }).click();
  const folder = page.locator('.tree-row[data-path="node_modules"]');
  const file = page.locator('.tree-row[data-path="debug.log"]');
  await expect(folder).toBeVisible();
  await expect(file).toBeVisible();
  await expect(folder).toHaveClass(/tree-row--ignored/);
  await expect(file).toHaveClass(/tree-row--ignored/);
  expect(Number(await folder.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.7);
  await expect(folder).toHaveAttribute('title', /ignored by git/);
  await expect(page.locator('.tree-row[data-path="README.md"]')).not.toHaveClass(/tree-row--ignored/);
});
