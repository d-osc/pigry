import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('previews fetched commits, compares files and refreshes after pulling', async ({ page }) => {
  const commit = {
    oid: '2222222222222222222222222222222222222222',
    shortOid: '2222222',
    parentOid: '1111111111111111111111111111111111111111',
    summary: 'Incoming change',
    body: 'Incoming change',
    authorName: 'Test User',
    timeSeconds: 1_700_000_000,
    files: [
      { path: 'edited.txt', status: 'M', additions: 1, deletions: 1 },
      { path: 'added.txt', status: 'A', additions: 1, deletions: 0 },
      { path: 'deleted.txt', status: 'D', additions: 0, deletions: 1 },
    ],
  };
  await installBackend(page, { incoming: [commit] });
  await openFixture(page);
  const nav = page.locator('.nav-item').filter({ hasText: 'Pull commit' });
  await nav.click();
  await expect(page.getByText('No incoming commits', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Fetch', exact: true }).click();
  await expect(nav.locator('.nav-item__badge')).toHaveText('1');
  await page.getByRole('button', { name: /Incoming change/ }).click();

  for (const file of commit.files) {
    await page.getByRole('button', { name: new RegExp(file.path) }).click();
    await expect(page.getByRole('group', { name: 'Diff layout' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Unified' }).click();
  await expect(page.getByRole('button', { name: 'Unified' })).toHaveClass('is-active');
  const reads = await page.evaluate(() => window.testBackend.calls
    .filter(({ cmd }) => cmd === 'read_file_at_commit')
    .map(({ args }) => args));
  expect(reads).toEqual([
    { path: 'edited.txt', oid: commit.parentOid },
    { path: 'edited.txt', oid: commit.oid },
    { path: 'added.txt', oid: commit.oid },
    { path: 'deleted.txt', oid: commit.parentOid },
  ]);

  await page.getByRole('button', { name: 'Pull (fast-forward only)' }).click();
  await expect(page.getByText('No incoming commits', { exact: false })).toBeVisible();
  await expect(nav.locator('.nav-item__badge')).toHaveCount(0);
});
