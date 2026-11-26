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

const conflictCommit = demoHistory.commits.find(row => row.refs.includes('feat/graph-search'));
const theirs = `${conflictCommit.shortOid} (${conflictCommit.summary})`;
const conflictFiles = [
  { path: 'README.md', base: 'intro\n', ours: null, theirs: 'intro\nmore\n', merged: null, binary: false },
  {
    path: 'src/app.ts',
    base: "const a = 1;\nconst color = 'blue';\nmiddle\nexport const size = 5;\nend\n",
    ours: "const a = 1;\nconst color = 'red';\nmiddle\nexport const size = 10;\nend\n",
    theirs: "const a = 1;\nconst color = 'green';\nmiddle\nexport const size = 20;\nend\n",
    merged: [
      'const a = 1;',
      '<<<<<<< fix/lane-rendering', "const color = 'red';", '||||||| base', "const color = 'blue';", '=======', "const color = 'green';", `>>>>>>> ${theirs}`,
      'middle',
      '<<<<<<< fix/lane-rendering', 'export const size = 10;', '||||||| base', 'export const size = 5;', '=======', 'export const size = 20;', `>>>>>>> ${theirs}`,
      'end', '',
    ].join('\n'),
    binary: false,
  },
];

async function openConflictedDuplicate(page) {
  await installBackend(page, { duplicateConflicts: { [conflictCommit.oid]: conflictFiles } });
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Duplicate commit' }).click();
  await page.getByRole('combobox', { name: 'Source branch' }).selectOption('feat/graph-search');
  await page.getByRole('combobox', { name: 'Destination branch' }).selectOption('fix/lane-rendering');
  await page.getByRole('searchbox', { name: 'Search commits' }).fill(conflictCommit.shortOid);
  await page.getByRole('button', { name: new RegExp(`^${conflictCommit.shortOid} `) }).click();
  await page.getByRole('button', { name: `Duplicate ${conflictCommit.shortOid}` }).click();
  const editor = page.getByRole('region', { name: 'Duplicate conflicts' });
  await expect(editor).toBeVisible();
  return editor;
}

test('resolves a conflicting duplicate per conflict, by hand and by whole file, then completes it', async ({ page }) => {
  const editor = await openConflictedDuplicate(page);
  await expect(page.getByText('This commit conflicts with changes in')).toHaveCount(0);
  await expect(editor.getByText(`Duplicating ${conflictCommit.shortOid} onto fix/lane-rendering needs your help`)).toBeVisible();
  const files = editor.getByRole('navigation', { name: 'Conflicted files' });
  await expect(files.getByRole('button')).toHaveCount(2);
  await expect(editor.getByText('0 of 2 files resolved')).toBeVisible();
  const complete = editor.getByRole('button', { name: 'Complete duplicate' });
  await expect(complete).toBeDisabled();

  // README.md: the destination deleted it, the commit changes it.
  await expect(editor.getByText('fix/lane-rendering deleted this file')).toBeVisible();
  await expect(editor.getByLabel('Remaining version')).toContainText('intro\nmore');
  await editor.getByRole('button', { name: `Take ${conflictCommit.shortOid}'s version` }).click();
  await expect(editor.getByLabel('Chosen version')).toContainText('more');
  await expect(files.getByRole('button', { name: /README\.md.*Resolved/ })).toBeVisible();

  // src/app.ts: one conflict per side, then a hand edit of the whole result.
  await editor.getByRole('button', { name: 'Next file' }).click();
  const first = editor.getByRole('region', { name: 'Conflict 1 of 2' });
  const second = editor.getByRole('region', { name: 'Conflict 2 of 2' });
  await expect(first.getByText('Current — fix/lane-rendering (destination)')).toBeVisible();
  await expect(first.getByText(`Incoming — ${conflictCommit.shortOid} (this commit)`)).toBeVisible();
  await expect(first).toContainText("const color = 'red';");
  await expect(first).toContainText("const color = 'green';");
  await first.getByRole('button', { name: 'Accept incoming' }).click();
  await expect(first).toContainText('Result');
  await expect(editor.getByLabel('Conflicts resolved in this file')).toHaveText('1 of 2 resolved');
  await expect(complete).toBeDisabled();
  await second.getByRole('button', { name: 'Accept both' }).click();
  await expect(editor.getByText('All files resolved')).toBeVisible();

  await editor.getByRole('button', { name: 'Edit whole file' }).click();
  const result = editor.getByRole('textbox', { name: 'Result for src/app.ts' });
  await expect(result).toHaveValue("const a = 1;\nconst color = 'green';\nmiddle\nexport const size = 10;\nexport const size = 20;\nend\n");
  await result.fill("const a = 1;\nconst color = 'green';\n<<<<<<< oops\nmiddle\n>>>>>>> oops\n");
  await expect(complete).toBeDisabled();
  const edited = "const a = 1;\nconst color = 'green';\nmiddle\nexport const size = 20;\nend\n";
  await result.fill(edited);
  await expect(complete).toBeEnabled();
  await editor.getByRole('button', { name: 'Conflicts', exact: true }).click();
  await expect(editor.getByText('You edited the result by hand')).toBeVisible();

  await complete.click();
  await expect(page.getByText(`Duplicated ${conflictCommit.oid.slice(0, 7)} onto fix/lane-rendering with 2 resolved files`)).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('button', { name: new RegExp(`^${conflictCommit.shortOid} .*Already in destination`) })).toBeVisible();
  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls.filter(({ cmd }) => cmd === 'duplicate_commit_resolved').map(({ args }) => args)).toEqual([{
    sourceBranch: 'feat/graph-search',
    destinationBranch: 'fix/lane-rendering',
    oid: conflictCommit.oid,
    destinationOid: expect.any(String),
    resolutions: [{ path: 'README.md', side: 'theirs' }, { path: 'src/app.ts', content: edited }],
  }]);
  expect(calls.some(({ cmd }) => cmd === 'duplicate_commit')).toBe(false);
});

test('aborting a conflicting duplicate leaves the destination untouched', async ({ page }) => {
  const editor = await openConflictedDuplicate(page);
  await editor.getByRole('button', { name: 'Next file' }).click();
  await editor.getByRole('region', { name: 'Conflict 1 of 2' }).getByRole('button', { name: 'Accept current' }).click();
  await editor.getByRole('button', { name: 'Abort', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('fix/lane-rendering stays as it is');
  await editor.getByRole('button', { name: 'Keep going' }).click();
  await expect(editor.getByLabel('Conflicts resolved in this file')).toHaveText('1 of 2 resolved');
  await editor.getByRole('button', { name: 'Abort', exact: true }).click();
  await editor.getByRole('button', { name: 'Abort duplicate' }).click();
  await expect(editor).toHaveCount(0);
  const row = page.getByRole('button', { name: new RegExp(`^${conflictCommit.shortOid} `) });
  await expect(row.getByTitle('Can duplicate to the selected branch')).toBeVisible();
  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls.some(({ cmd }) => cmd === 'duplicate_commit_resolved' || cmd === 'duplicate_commit')).toBe(false);

  // Opening it again starts fresh.
  await page.getByRole('button', { name: `Duplicate ${conflictCommit.shortOid}` }).click();
  await expect(editor.getByText('0 of 2 files resolved')).toBeVisible();
});
