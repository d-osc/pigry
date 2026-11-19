import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('compares local and remote-tracking branches and expands file diffs', async ({ page }) => {
  const comparison = {
    baseOid: '1'.repeat(40),
    compareOid: '2'.repeat(40),
    baseOnly: 1,
    compareOnly: 2,
    files: [
      { path: 'edited.txt', status: 'M', additions: 1, deletions: 2 },
      { path: 'added.txt', status: 'A', additions: 1, deletions: 0 },
      { path: 'removed.txt', status: 'D', additions: 0, deletions: 1 },
    ],
  };
  await installBackend(page, { branchComparison: comparison });
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Compare branch' }).click();

  await expect(page.getByRole('combobox', { name: 'Base branch' })).toHaveValue('refs/heads/main');
  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('refs/remotes/origin/feat/graph-search');
  await expect(page.getByText('Base 1111111 · 1 unique commit')).toBeVisible();
  await expect(page.getByText('Compare 2222222 · 2 unique commits')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Files changed (3)' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Show more files/ })).toHaveCount(0);
  const edited = page.getByRole('button', { name: /edited\.txt/ });
  await expect(edited).toContainText('+1');
  await expect(edited).toContainText('−2');

  const diff = page.locator('.monaco-diff-editor');
  for (const file of comparison.files) {
    await page.getByRole('button', { name: new RegExp(file.path) }).click();
    await expect(diff).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
  await expect(diff).toHaveClass(/side-by-side/);
  await page.getByRole('button', { name: 'Unified' }).click();
  await expect(page.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true');
  await expect(diff).not.toHaveClass(/side-by-side/);
  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls.filter(({ cmd }) => cmd === 'compare_branches').at(-1).args).toEqual({
    baseRef: 'refs/heads/main',
    compareRef: 'refs/remotes/origin/feat/graph-search',
  });
  expect(calls.filter(({ cmd }) => cmd === 'read_file_at_commit').map(({ args }) => args)).toEqual([
    { path: 'edited.txt', oid: comparison.baseOid },
    { path: 'edited.txt', oid: comparison.compareOid },
    { path: 'added.txt', oid: comparison.compareOid },
    { path: 'removed.txt', oid: comparison.baseOid },
  ]);
});

test('shows changed files in batches without requesting the comparison again', async ({ page }) => {
  const comparison = {
    baseOid: '1'.repeat(40),
    compareOid: '2'.repeat(40),
    baseOnly: 0,
    compareOnly: 1,
    files: Array.from({ length: 85 }, (_, index) => ({
      path: `file-${index + 1}.txt`,
      status: 'A',
      additions: 1,
      deletions: 0,
    })),
  };
  await installBackend(page, { branchComparison: comparison });
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Compare branch' }).click();

  const rows = page.getByRole('region', { name: 'Branch comparison' }).getByRole('listitem');
  const showMore = page.getByRole('button', { name: /Show more files/ });
  const comparisonCalls = () => page.evaluate(() =>
    window.testBackend.calls.filter(({ cmd }) => cmd === 'compare_branches').length);

  await expect(rows).toHaveCount(40);
  const initialCalls = await comparisonCalls();
  await expect(showMore).toHaveText('Show more files (45 remaining)');
  await showMore.click();
  await expect(rows).toHaveCount(80);
  await expect(showMore).toHaveText('Show more files (5 remaining)');
  await showMore.click();
  await expect(rows).toHaveCount(85);
  await expect(showMore).toHaveCount(0);
  expect(await comparisonCalls()).toBe(initialCalls);

  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('refs/remotes/origin/main');
  await expect(rows).toHaveCount(40);
  await expect(showMore).toBeVisible();
});
