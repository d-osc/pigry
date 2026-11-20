import { expect, test } from '@playwright/test';
import { demoHistory } from '../../src/lib/demoWorkspace.ts';
import { installBackend, openFixture } from './backend.mjs';

test('Pull commit sorts, searches, and filters authors without loading the list again', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const incoming = [
    { oid: '1'.repeat(40), shortOid: '1111111', summary: 'Earlier change', authorName: 'Zoe', timeSeconds: now - 90 * day },
    { oid: '2'.repeat(40), shortOid: '2222222', summary: 'Later change', authorName: 'Ali', timeSeconds: now - day },
    { oid: '3'.repeat(40), shortOid: '3333333', summary: 'Earlier Zoe follow-up', authorName: 'Zoe Lee', timeSeconds: now - 15 * day },
  ].map(commit => ({ ...commit, body: '', parentOid: null, files: [] }));
  await installBackend(page, { incoming });
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Pull commit' }).click();
  await page.getByRole('button', { name: 'Fetch', exact: true }).click();
  const commits = page.getByRole('button', { name: /Earlier change|Later change|Earlier Zoe follow-up/ });
  await expect(commits.first()).toContainText('Later change');
  const loadCount = () => page.evaluate(() => window.testBackend.calls.filter(call => call.cmd === 'pull_preview').length);
  const loaded = await loadCount();
  const sort = page.getByRole('combobox', { name: 'Sort commits' });
  await sort.selectOption('oldest');
  await expect(commits.first()).toContainText('Earlier change');
  await sort.selectOption('account-asc');
  await expect(commits.first()).toContainText('Later change');
  await page.getByRole('searchbox', { name: 'Search commits' }).fill('zoe');
  await expect(commits).toHaveCount(2);
  await page.getByRole('button', { name: 'All authors', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Zoe', exact: true }).click();
  await expect(commits).toHaveCount(1);
  await expect(commits.first()).toContainText('Earlier change');
  await page.getByRole('button', { name: 'All time', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Last 30 days', exact: true }).click();
  await expect(commits).toHaveCount(0);
  await page.getByRole('button', { name: 'Zoe', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'All authors', exact: true }).click();
  await expect(commits).toHaveCount(1);
  await expect(commits.first()).toContainText('Earlier Zoe follow-up');
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'All time', exact: true }).click();
  await expect(commits).toHaveCount(2);
  expect(await loadCount()).toBe(loaded);
});

test('sorting and searching the rebase view preserve the replay plan', async ({ page }) => {
  const [first, second, baseCommit] = demoHistory.commits;
  await installBackend(page, { clean: true, branchHistory: { total: 1, truncated: false, commits: [baseCommit] } });
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Rebase Branch' }).click();
  const rows = page.locator('.rb__row');
  await expect(rows).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Sort commits' }).selectOption('oldest');
  await expect(rows.first()).toContainText(second.shortOid);
  await page.getByRole('button', { name: 'All authors', exact: true }).click();
  await page.getByRole('menuitemradio', { name: first.authorName, exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search commits' }).fill(first.shortOid);
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole('button', { name: 'pick', exact: true }).click();
  await expect(rows.first().getByRole('button', { name: 'squash', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start rebase with plan' }).click();
  const sent = await page.evaluate(() => window.testBackend.calls.find(call => call.cmd === 'interactive_rebase'));
  expect(sent.args.steps).toEqual([
    { oid: second.oid, action: 'pick' },
    { oid: first.oid, action: 'squash' },
  ]);
});
