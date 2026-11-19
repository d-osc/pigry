import { test, expect } from '@playwright/test';

const pages = ['Explorer', 'Copilot', 'Working changes', 'Push Commits', 'Pull commit', 'Merge branch',
  'Stashes Code', 'Cherry Pick', 'Rebase Branch', 'Pull requests', 'Commit graph',
  'Branches', 'Releases', 'Actions', 'Security and quality', 'Issues', 'Projects', 'Wiki', 'Insights'];

for (const theme of ['light', 'dark']) {
  test(`${theme}: every workspace page renders at minimum width`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('pigry:theme', theme), theme);
    await page.goto('/');
    for (const name of pages) {
      const nav = page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: new RegExp(`^${name}$`, 'i') }) });
      await nav.click();
      await expect(nav).toHaveClass(/nav-item--active/);
      await expect(page.locator('.screen-loading')).toHaveCount(0);
      await expect(page.locator('.error-boundary')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

test('command palette can navigate with the keyboard and close', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.command-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.command-palette')).toHaveCount(0);
});
