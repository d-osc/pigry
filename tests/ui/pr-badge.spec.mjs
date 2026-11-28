import { test, expect } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

// The side bar's "Pull requests" badge shows the real number of open PRs
// (gh), follows reloads of the Pull requests list, and is hidden when there
// are none or gh can't answer. It used to be a fixed "3" from the mock-up.

async function setup(page, count) {
  await installBackend(page);
  await page.addInitScript((count) => {
    window.openPrs = { count };
    const internals = window.__TAURI_INTERNALS__;
    const fallback = internals.invoke;
    internals.invoke = async (cmd, args = {}) => {
      if (cmd !== 'gh_open_pr_count') return fallback(cmd, args);
      window.testBackend.calls.push({ cmd, args });
      if (window.openPrs.count === null) throw 'gh: not logged in';
      return window.openPrs.count;
    };
  }, count);
  await openFixture(page);
}

const prBadge = (page) =>
  page.locator('.nav-item').filter({ hasText: 'Pull requests' }).first().locator('.nav-item__badge');

test('the badge shows the open pull request count and follows list reloads', async ({ page }) => {
  await setup(page, 2);
  await expect(prBadge(page)).toHaveText('2');
  await expect(prBadge(page)).toHaveAttribute('aria-label', '2 open pull requests');

  await page.evaluate(() => { window.openPrs.count = 5; });
  await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).first().click();
  await expect(prBadge(page)).toHaveText('5');

  await page.evaluate(() => { window.openPrs.count = 1; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(prBadge(page)).toHaveText('1');
  await expect(prBadge(page)).toHaveAttribute('aria-label', '1 open pull request');
});

test('no badge when nothing is open', async ({ page }) => {
  await setup(page, 0);
  await expect.poll(() => page.evaluate(() => window.testBackend.calls.filter(({ cmd }) => cmd === 'gh_open_pr_count').length)).toBeGreaterThan(0);
  await expect(prBadge(page)).toHaveCount(0);
});

test('no badge when gh cannot count', async ({ page }) => {
  await setup(page, null);
  await expect.poll(() => page.evaluate(() => window.testBackend.calls.filter(({ cmd }) => cmd === 'gh_open_pr_count').length)).toBeGreaterThan(0);
  await expect(prBadge(page)).toHaveCount(0);
});
