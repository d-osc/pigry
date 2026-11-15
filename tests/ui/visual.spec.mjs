import { test, expect } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

for (const theme of ['light', 'dark']) {
  test(`${theme}: selected commit and branch dialog keep their visual layout`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('pigry:theme', theme), theme);
    await installBackend(page);
    await openFixture(page);
    await page.locator('.nav-item').filter({ hasText: 'Commit graph' }).click();
    await page.locator('.commit-row--clickable').first().click();
    await expect(page.locator('.commit-detail')).toBeVisible();
    await page.getByRole('button', { name: 'New branch', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Repository opened', { exact: true })).toHaveCount(0);
    await expect(page.locator('.commit-history')).toHaveScreenshot(`commit-dialog-${theme}.png`, {
      animations: 'disabled',
      mask: [page.locator('.commit-row__time'), page.locator('.commit-detail__time')],
      maxDiffPixelRatio: 0.001,
    });
  });
}
