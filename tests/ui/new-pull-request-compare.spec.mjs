import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

const COMPARISON = {
  baseOid: '1'.repeat(40), compareOid: '2'.repeat(40), baseOnly: 1, compareOnly: 2,
  files: [
    { path: 'src/components/command-menu.tsx', status: 'A', additions: 84, deletions: 0 },
    { path: 'src/lib/commands.ts', status: 'M', additions: 12, deletions: 3 },
  ],
};

const CONFLICTS = {
  baseOid: COMPARISON.baseOid,
  compareOid: COMPARISON.compareOid,
  files: [{
    path: 'src/lib/commands.ts',
    base: "const color = 'red';\n",
    ours: "const color = 'blue';\n",
    theirs: "const color = 'green';\n",
    merged: "<<<<<<< feat/command-menu\nconst color = 'blue';\n||||||| base\nconst color = 'red';\n=======\nconst color = 'green';\n>>>>>>> main\n",
    binary: false,
  }],
};

/** `conflicts` = what merging the base into the compare branch would conflict on (until it is resolved). */
async function setup(page, { conflicts = null } = {}) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installBackend(page, { branchComparison: COMPARISON });
  await openFixture(page);
  await page.evaluate((conflicts) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__conflicts = conflicts;
    window.__resolved = [];
    bridge.invoke = async (cmd, args) => {
      if (cmd === 'get_branch_commits') {
        const full = await invoke('get_commit_history', { includeRemotes: false });
        return args.refName === 'main' ? { ...full, commits: full.commits.slice(2) } : full;
      }
      if (cmd === 'pr_merge_conflicts') {
        window.testBackend.calls.push({ cmd, args });
        return window.__conflicts ?? { ...conflicts, baseOid: '1'.repeat(40), compareOid: '2'.repeat(40), files: [] };
      }
      if (cmd === 'pr_merge_resolved') {
        window.__resolved.push(args);
        window.__conflicts = null;
        return invoke('refresh', {});
      }
      return invoke(cmd, args);
    };
  }, conflicts);
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Pull requests$/ }) }).click();
  await page.getByRole('button', { name: 'New pull request' }).first().click();
  await expect(page.getByRole('heading', { name: 'Open a pull request' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('feat/command-menu');
  await expect(page.locator('.npr-compare__status')).toContainText('2 commits');
}

test('a commit opens its details and files, and a file opens the commit compare view', async ({ page }) => {
  await setup(page);
  const commits = page.getByRole('list', { name: 'Commits in this pull request' });
  const row = commits.getByRole('button').first();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const oid = await page.evaluate(() => window.testBackend.calls.filter(({ cmd }) => cmd === 'get_commit_detail').at(-1).args.oid);
  const files = commits.getByRole('list', { name: /^Files changed in / });
  await expect(files.getByRole('button')).not.toHaveCount(0);
  await expect(commits.getByTitle('Commit SHA')).toHaveText(oid);

  const file = files.getByRole('button').first();
  const path = (await file.getAttribute('title')).replace(/^Compare /, '');
  await file.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.testBackend.calls.filter(({ cmd }) => cmd === 'get_commit_file_diff').at(-1)?.args))
    .toMatchObject({ oid, path });
  await expect(dialog.locator('.pr-diff-dialog__file, .pr-diff-dialog__files button, li').filter({ hasText: path.split('/').pop() }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close compare view' }).click();
  await expect(dialog).toHaveCount(0);

  // Clicking the open commit again closes it.
  await row.click();
  await expect(files).toHaveCount(0);
});

test('a changed file opens the compare view of the two branch tips', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: /Files changed/ }).click();
  await page.getByRole('list', { name: 'Files changed in this pull request' }).getByRole('button', { name: /src\/lib\/commands\.ts/ }).click();
  const dialog = page.getByRole('dialog', { name: 'main ← feat/command-menu' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.testBackend.calls
    .filter(({ cmd, args }) => cmd === 'read_file_at_commit' && args.path === 'src/lib/commands.ts')
    .map(({ args }) => args.oid).sort()))
    .toEqual(['1'.repeat(40), '2'.repeat(40)]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('conflicts with the base open the conflict editor; resolving them commits the merge on the compare branch', async ({ page }) => {
  await setup(page, { conflicts: CONFLICTS });
  const editor = page.getByRole('region', { name: 'Pull request conflicts' });
  await expect(editor).toBeVisible();
  await expect(editor.getByText('feat/command-menu has conflicts with main')).toBeVisible();
  // The rest of the form waits until the editor is closed.
  await expect(page.getByRole('textbox', { name: 'Pull request title' })).toHaveCount(0);

  // Abort keeps both branches and leaves a banner to come back.
  await editor.getByRole('button', { name: 'Abort', exact: true }).click();
  await editor.getByRole('button', { name: 'Abort merge' }).click();
  await expect(editor).toHaveCount(0);
  const banner = page.getByRole('group', { name: 'Merge conflicts' });
  await expect(banner).toContainText('Can’t automatically merge');
  await expect(banner).toContainText('1 file conflicts with main');
  await expect(page.getByRole('textbox', { name: 'Pull request title' })).toBeVisible();
  expect(await page.evaluate(() => window.__resolved.length)).toBe(0);

  await banner.getByRole('button', { name: 'Resolve conflicts' }).click();
  await expect(editor).toBeVisible();
  const complete = editor.getByRole('button', { name: 'Commit merge' });
  await expect(complete).toBeDisabled();
  await editor.getByRole('region', { name: 'Conflict 1 of 1' }).getByRole('button', { name: 'Accept incoming' }).click();
  await expect(editor.getByText('All files resolved')).toBeVisible();
  await complete.click();

  await expect.poll(() => page.evaluate(() => window.__resolved.length)).toBe(1);
  const [call] = await page.evaluate(() => window.__resolved);
  expect(call).toMatchObject({
    compareBranch: 'feat/command-menu', baseOid: '1'.repeat(40), compareOid: '2'.repeat(40),
    resolutions: [{ path: 'src/lib/commands.ts', content: "const color = 'green';\n" }],
  });
  expect(call.baseRef).toMatch(/^refs\/(heads|remotes\/[^/]+)\/main$/);
  // The branches are compared again: no conflicts left, the form is back.
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Merge conflicts' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Pull request title' })).toBeVisible();
  await expect(page.locator('.npr-compare__status')).toContainText('Able to compare');
});
