import { expect, test } from '@playwright/test';
import { demoAppState, demoHistory } from '../../src/lib/demoWorkspace.ts';
import { installBackend, openFixture } from './backend.mjs';

test('edits a selected commit and continues the rebase with staged changes', async ({ page }) => {
  const commit = demoHistory.commits[3];
  await installBackend(page, { clean: true });
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Edit commit' }).click();
  const start = page.getByRole('button', { name: 'Start editing' });
  await expect(start).toBeDisabled();
  await page.getByRole('button', { name: new RegExp(`^${commit.shortOid} `) }).click();
  await expect(page.getByRole('region', { name: 'Commit details' })).toBeVisible();
  await start.click();

  const banner = page.getByRole('region', { name: 'Commit edit in progress' });
  await expect(banner).toContainText(`Editing ${commit.shortOid} on main`);
  await banner.getByRole('button', { name: 'Open Explorer' }).click();
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' // edit selected commit');
  const workingChanges = banner.getByRole('button', { name: 'Working changes' });
  await expect(workingChanges).toBeDisabled();
  await page.keyboard.press('Control+s');
  await expect(workingChanges).toBeEnabled();

  await workingChanges.click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(banner.getByRole('button', { name: 'Continue rebase' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Stage all', exact: true }).click();
  await banner.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Commit edit complete', { exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);

  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls.filter(({ cmd }) => cmd === 'get_branch_commits').at(-1).args)
    .toEqual({ refName: 'refs/heads/main', firstParent: true });
  const operations = calls.filter(({ cmd }) => ['start_commit_edit', 'write_worktree_file', 'stage_paths', 'continue_commit_edit'].includes(cmd));
  expect(operations.map(({ cmd }) => cmd)).toEqual(['start_commit_edit', 'write_worktree_file', 'stage_paths', 'continue_commit_edit']);
  expect(operations[0].args).toEqual({ branch: 'main', headOid: demoAppState.repository.headOid, oid: commit.oid });
  expect(operations[1].args.content).toContain('// edit selected commit');
  expect(operations[2].args).toEqual({ paths: [operations[1].args.path] });
});
