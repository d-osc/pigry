import { expect, test } from '@playwright/test';
import { demoHistory } from '../../src/lib/demoWorkspace.ts';
import { installBackend, openFixture } from './backend.mjs';

test('copies a selected commit from its source branch to the chosen destination', async ({ page }) => {
  const commit = demoHistory.commits.find(row => row.refs.includes('feat/graph-search'));
  await installBackend(page);
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Duplicate commit' }).click();
  const source = page.getByRole('combobox', { name: 'Source branch' });
  const destination = page.getByRole('combobox', { name: 'Destination branch' });
  await expect(source).toHaveValue('main');
  await expect(destination).toHaveValue('');
  await source.selectOption('feat/graph-search');
  await page.getByRole('searchbox', { name: 'Search commits' }).fill(commit.shortOid);
  const row = page.getByRole('button', { name: new RegExp(`^${commit.shortOid} `) });
  const eligible = row.getByTitle('Can duplicate to the selected branch');
  await row.click();
  const copy = page.getByRole('button', { name: `Duplicate ${commit.shortOid}` });
  await expect(copy).toBeDisabled();
  await expect(eligible).toHaveCount(0);
  await destination.selectOption('fix/lane-rendering');
  await expect(eligible).toBeVisible();
  await copy.click();
  await expect(page.getByText(`Duplicated ${commit.oid.slice(0, 7)} onto fix/lane-rendering`)).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`^${commit.shortOid} .*Already in destination`) })).toBeVisible();
  await expect(copy).toBeDisabled();
  await expect(eligible).toHaveCount(0);

  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls.filter(({ cmd }) => cmd === 'get_branch_commits').at(-1).args)
    .toEqual({ refName: 'refs/heads/feat/graph-search' });
  expect(calls.filter(({ cmd }) => cmd === 'duplicate_commit').map(({ args }) => args)).toEqual([
    { sourceBranch: 'feat/graph-search', destinationBranch: 'fix/lane-rendering', oid: commit.oid },
  ]);
  expect(calls.some(({ cmd }) => cmd === 'checkout_branch')).toBe(false);
});

test('sorts commits by date, blocks existing commits and expands per-file code comparisons', async ({ page }) => {
  const [latest, present, older] = demoHistory.commits.slice(1, 4);
  await installBackend(page, {
    branchHistory: { ...demoHistory, total: 3, commits: [older, present, latest] },
    duplicateMatches: { 'fix/lane-rendering': [present.oid] },
  });
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Duplicate commit' }).click();
  const commits = page.getByRole('region', { name: 'Source commits' });
  await expect(commits.getByRole('listitem').first()).toContainText(latest.shortOid);
  await expect(commits.getByRole('listitem').last()).toContainText(older.shortOid);

  const destination = page.getByRole('combobox', { name: 'Destination branch' });
  await destination.selectOption('fix/lane-rendering');
  const presentRow = commits.getByRole('button', { name: new RegExp(`^${present.shortOid} `) });
  const eligible = presentRow.getByTitle('Can duplicate to the selected branch');
  await expect(presentRow).toContainText('Already in destination');
  await expect(eligible).toHaveCount(0);
  await presentRow.click();
  const copy = commits.getByRole('button', { name: `Duplicate ${present.shortOid}` });
  await expect(copy).toBeDisabled();

  const details = page.getByRole('region', { name: 'Commit details' });
  await expect(details.getByText(present.oid)).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Files changed (4)' })).toBeVisible();
  const file = details.getByRole('button', { name: /src\/lib\/keyboard\.ts/ });
  await expect(file).toContainText('+24');
  await expect(file).toContainText('−4');
  await file.click();
  const editor = details.locator('.monaco-diff-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveClass(/side-by-side/);
  await details.getByRole('button', { name: 'Unified' }).click();
  await expect(editor).not.toHaveClass(/side-by-side/);

  await destination.selectOption('feat/command-menu');
  await expect(copy).toBeEnabled();
  await expect(eligible).toBeVisible();
  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls.filter(({ cmd }) => cmd === 'get_commit_file_diff').map(({ args }) => args))
    .toEqual([{ oid: present.oid, path: 'src/lib/keyboard.ts' }]);
  expect(calls.some(({ cmd }) => cmd === 'duplicate_commit')).toBe(false);
});
