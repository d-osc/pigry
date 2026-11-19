import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('large pull requests load additional files and commits with a cursor', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (cmd, args) => {
      const result = await invoke(cmd, args);
      const file = (n) => ({ path: `file-${n}.txt`, additions: 1, deletions: 0 });
      const commit = (n) => ({
        oid: String(n).padStart(40, '0'),
        message: `Commit ${n}`,
        date: n === 1 ? undefined : n === 2 ? 'unknown' :
          new Date(Date.UTC(2026, 8, 7, 0, 0, n === 102 ? 99 : n, n === 102 ? 500 : 0)).toISOString(),
      });
      if (cmd === 'gh_pr_detail') {
        return {
          ...result,
          files: Array.from({ length: 100 }, (_, i) => file(i + 1)),
          commits: Array.from({ length: 100 }, (_, i) => commit(i + 1)),
        };
      }
      if (cmd === 'gh_pr_items_page') {
        const n = args.cursor === null ? 101 : 102;
        return { items: [args.kind === 'files' ? file(n) : commit(n)], nextCursor: args.cursor === null ? 'next' : null };
      }
      return result;
    };
  });
  await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).click();
  for (const [tab, kind, pattern] of [
    [/^Files changed/, 'files', /^file-102\.txt/],
    [/^Commits/, 'commits', /^Commit 102/],
  ]) {
    await page.getByRole('button', { name: tab }).click();
    const commits = page.locator('.pr-commit__row .pr-file__path');
    if (kind === 'commits') {
      await expect(commits.first()).toHaveText('Commit 100');
    }
    const more = page.getByRole('button', { name: `Show more ${kind}` });
    await more.click();
    await more.click();
    await expect(page.getByRole('button', { name: pattern })).toBeVisible();
    await expect(more).toHaveCount(0);
    if (kind === 'commits') {
      await expect(commits.nth(0)).toHaveText('Commit 101');
      await expect(commits.nth(1)).toHaveText('Commit 100');
      await expect(commits.nth(2)).toHaveText('Commit 102');
      await expect(commits.nth(100)).toHaveText('Commit 1');
      await expect(commits.nth(101)).toHaveText('Commit 2');
    }
  }
  const pages = await page.evaluate(() => window.testBackend.calls
    .filter(({ cmd }) => cmd === 'gh_pr_items_page').map(({ args }) => args));
  expect(pages).toEqual([
    { number: 42, kind: 'files', cursor: null },
    { number: 42, kind: 'files', cursor: 'next' },
    { number: 42, kind: 'commits', cursor: null },
    { number: 42, kind: 'commits', cursor: 'next' },
  ]);
});
