import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Opens a branch / tag picker, searches it and clicks the option with exactly that name. */
async function pickRef(page, label, query, name) {
  await page.locator('.compare-branch__controls').getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('combobox', { name: `Search ${label.toLowerCase()}` }).fill(query);
  await page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) }).click();
}

const lastCall = (page, command) => page.evaluate(cmd =>
  window.testBackend.calls.filter(call => call.cmd === cmd).at(-1)?.args, command);

test('compares local and remote-tracking branches with files on the left and the diff on the right', async ({ page }) => {
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

  await expect(page.locator('.compare-branch__controls').getByRole('button', { name: 'Base branch', exact: true })).toHaveAttribute('data-value', 'refs/heads/main');
  await pickRef(page, 'Compare branch', 'graph', 'origin/feat/graph-search');
  await expect(page.locator('.compare-branch__controls').getByRole('button', { name: 'Compare branch', exact: true }))
    .toHaveAttribute('data-value', 'refs/remotes/origin/feat/graph-search');
  await expect(page.getByText('Base 1111111 · 1 unique commit')).toBeVisible();
  await expect(page.getByText('Compare 2222222 · 2 unique commits')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Files changed (3)' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Show more files/ })).toHaveCount(0);

  const fileList = page.getByRole('complementary', { name: 'Changed files' });
  const edited = fileList.getByRole('button', { name: /edited\.txt/ });
  await expect(edited).toContainText('M');
  await expect(edited).toContainText('+1');
  await expect(edited).toContainText('−2');

  // The first file opens straight away in the editor pane on the right.
  const diff = page.locator('.compare-branch__workbench .monaco-diff-editor');
  const activeName = page.locator('.compare-branch__workbench .diff-pane__comparison');
  await expect(edited).toHaveAttribute('aria-current', 'true');
  await expect(activeName).toHaveText('edited.txt');
  await expect(diff).toBeVisible();
  const listBox = await fileList.boundingBox();
  const diffBox = await diff.boundingBox();
  expect(diffBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
  expect(diffBox.height).toBeGreaterThan(200);

  for (const file of comparison.files) {
    const row = fileList.getByRole('button', { name: new RegExp(file.path) });
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(activeName).toHaveText(file.path);
    await expect(diff).toBeVisible();
    await expect(page.locator('.compare-branch__workbench .diffstat'))
      .toHaveText(`+${file.additions}−${file.deletions}`);
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(diff.getByText('before', { exact: true }).first()).toBeVisible();

  await expect(page.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
  await expect(diff).toHaveClass(/side-by-side/);
  await page.getByRole('button', { name: 'Unified' }).click();
  await expect(page.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true');
  await expect(diff).not.toHaveClass(/side-by-side/);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The divider between the panes resizes the file list.
  const handle = page.getByRole('separator', { name: 'Resize file list' });
  const before = (await fileList.boundingBox()).width;
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + handleBox.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await fileList.boundingBox()).width).toBeGreaterThan(before + 40);

  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls.filter(({ cmd }) => cmd === 'compare_branches').at(-1).args).toEqual({
    baseRef: 'refs/heads/main',
    compareRef: 'refs/remotes/origin/feat/graph-search',
  });
  // Only the reads for the comparison on screen (the first branch pair also opened its first file).
  const lastComparison = calls.findLastIndex(({ cmd }) => cmd === 'compare_branches');
  expect(calls.slice(lastComparison).filter(({ cmd }) => cmd === 'read_file_at_commit').map(({ args }) => args)).toEqual([
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

  await pickRef(page, 'Compare branch', 'origin/main', 'origin/main');
  await expect(rows).toHaveCount(40);
  await expect(showMore).toBeVisible();
});

test('searches branches and tags, picks a tag on either side by mouse or keyboard, and shows when nothing matches', async ({ page }) => {
  const comparison = {
    baseOid: '1'.repeat(40),
    compareOid: '2'.repeat(40),
    baseOnly: 3,
    compareOnly: 1,
    files: [{ path: 'edited.txt', status: 'M', additions: 1, deletions: 1 }],
  };
  await installBackend(page, { branchComparison: comparison });
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Compare branch' }).click();

  const controls = page.locator('.compare-branch__controls');
  const base = controls.getByRole('button', { name: 'Base branch', exact: true });
  const compare = controls.getByRole('button', { name: 'Compare branch', exact: true });
  await expect(base).toHaveAttribute('data-value', 'refs/heads/main');
  await expect(compare).toHaveAttribute('data-value', 'refs/heads/feat/command-menu');
  await expect(page.getByRole('heading', { name: 'Files changed (1)' })).toBeVisible();

  // Local branches, remote branches and tags in groups, including refs only the full list knows about.
  await base.click();
  const list = page.getByRole('listbox', { name: 'Base branch' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('group')).toHaveCount(3);
  await expect(list.getByRole('group', { name: 'Local branches' }).getByRole('option')).toHaveCount(4);
  await expect(list.getByRole('group', { name: 'Remote branches' }).getByRole('option', { name: /origin\/release\/2\.0/ })).toBeVisible();
  const tags = list.getByRole('group', { name: 'Tags' }).getByRole('option');
  await expect(tags).toHaveCount(3);
  await expect(tags.first()).toContainText('v0.18.0');
  const main = list.getByRole('option', { name: /^main/ });
  await expect(main).toHaveAttribute('aria-selected', 'true');
  await expect(main).toContainText('current');

  // Typing filters every group at once; picking a tag makes it the base.
  const search = page.getByRole('combobox', { name: 'Search base branch' });
  await expect(search).toBeFocused();
  await search.fill('v0.18');
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('group')).toHaveCount(1);
  await list.getByRole('option', { name: /v0\.18\.0/ }).click();
  await expect(list).toHaveCount(0);
  await expect(base).toHaveAttribute('data-value', 'refs/tags/v0.18.0');
  await expect(base).toHaveText('v0.18.0');
  await expect.poll(() => lastCall(page, 'compare_branches'))
    .toEqual({ baseRef: 'refs/tags/v0.18.0', compareRef: 'refs/heads/feat/command-menu' });

  // Keyboard: an arrow opens the picker on the current value, arrows move (and wrap), Enter picks.
  await compare.focus();
  await page.keyboard.press('ArrowDown');
  const compareSearch = page.getByRole('combobox', { name: 'Search compare branch' });
  const compareList = page.getByRole('listbox', { name: 'Compare branch' });
  const highlighted = compareList.locator('[data-active="true"]');
  await expect(compareSearch).toBeFocused();
  await expect(highlighted).toContainText('feat/command-menu');
  await page.keyboard.type('v0.');
  await expect(compareList.getByRole('option')).toHaveCount(3);
  await expect(highlighted).toContainText('v0.18.0');
  await page.keyboard.press('ArrowUp');
  await expect(highlighted).toContainText('v0.1.0');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(highlighted).toContainText('v0.17.2');
  await expect(compareSearch).toHaveAttribute('aria-activedescendant', await highlighted.getAttribute('id'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(compareList).toHaveCount(0);
  await expect(compare).toBeFocused();
  await expect(compare).toHaveAttribute('data-value', 'refs/tags/v0.1.0');
  await expect.poll(() => lastCall(page, 'compare_branches'))
    .toEqual({ baseRef: 'refs/tags/v0.18.0', compareRef: 'refs/tags/v0.1.0' });
  await expect(page.getByText('Base 1111111 · 3 unique commits')).toBeVisible();
  await expect(page.locator('.compare-branch__workbench .diff-pane__comparison')).toHaveText('edited.txt');

  // The file history follows the compare tag.
  await page.locator('.compare-branch__workbench').getByRole('button', { name: 'History', exact: true }).click();
  await expect.poll(() => lastCall(page, 'get_file_history')).toEqual({ path: 'edited.txt', refName: 'refs/tags/v0.1.0' });

  // Nothing matches: an empty state; Enter does nothing and Esc closes without a change.
  await compare.press('Enter');
  await compareSearch.fill('no-such-ref');
  await expect(compareList.getByRole('option')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'No branch or tag matches “no-such-ref”.' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(compareSearch).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(compareList).toHaveCount(0);
  await expect(compare).toBeFocused();
  await expect(compare).toHaveAttribute('data-value', 'refs/tags/v0.1.0');

  // Typing on the closed picker starts a search; a click elsewhere closes it without a change.
  await page.keyboard.type('release');
  await expect(compareSearch).toHaveValue('release');
  await expect(compareList.getByRole('option')).toHaveCount(1);
  await page.locator('.compare-branch__title').click();
  await expect(compareList).toHaveCount(0);
  await expect(compare).toHaveAttribute('data-value', 'refs/tags/v0.1.0');

  // The same ref on both sides is not compared.
  await pickRef(page, 'Base branch', 'v0.1.0', 'v0.1.0');
  await expect(page.getByText('Choose two different branches or tags to compare.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Refresh comparison/ })).toBeDisabled();
});
