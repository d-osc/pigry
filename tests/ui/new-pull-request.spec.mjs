import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

const COMPARISON = {
  baseOid: '1'.repeat(40), compareOid: '2'.repeat(40), baseOnly: 0, compareOnly: 2,
  files: [
    { path: 'src/components/command-menu.tsx', status: 'A', additions: 84, deletions: 0 },
    { path: 'src/lib/commands.ts', status: 'M', additions: 12, deletions: 3 },
  ],
};

async function setup(page, comparison = COMPARISON) {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page, { branchComparison: comparison });
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__created = [];
    bridge.invoke = async (cmd, args) => {
      if (cmd === 'get_branch_commits') {
        // main lacks the two newest commits, so those two are the pull request's commits
        const full = await invoke('get_commit_history', { includeRemotes: false });
        return args.refName === 'main' ? { ...full, commits: full.commits.slice(2) } : full;
      }
      if (cmd === 'gh_pr_create') { window.__created.push(args); return 'https://github.com/acme-inc/platform/pull/99'; }
      return invoke(cmd, args);
    };
  });
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Pull requests$/ }) }).click();
  await page.getByRole('button', { name: 'New pull request' }).first().click();
  await expect(page.getByRole('heading', { name: 'Open a pull request' })).toBeVisible();
}

test('Open a pull request compares two branches and fills in the title', async ({ page }) => {
  await setup(page);
  // main is checked out, so there is nothing to compare until another branch is chosen
  await expect(page.getByRole('combobox', { name: 'Base branch' })).toHaveValue('main');
  await expect(page.locator('.npr-compare__status')).toContainText('Choose two different branches');
  await expect(page.getByRole('button', { name: 'Create pull request' })).toBeDisabled();

  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('feat/command-menu');
  await expect(page.locator('.npr-compare__status')).toContainText('2 commits, 2 files changed');
  await expect(page.locator('.npr-compare__status')).toContainText('+96');
  await expect(page.getByRole('textbox', { name: 'Pull request title' })).toHaveValue('Feat/command menu');

  // commits and files
  await expect(page.getByRole('list', { name: 'Commits in this pull request' }).locator('li')).toHaveCount(2);
  await page.getByRole('tab', { name: /Files changed/ }).click();
  await expect(page.getByRole('list', { name: 'Files changed in this pull request' })).toContainText('src/lib/commands.ts');
  await expect(page.getByRole('button', { name: 'Create pull request' })).toBeEnabled();
});

test('write the description with the toolbar, preview it, pick draft and add reviewers, assignees and labels', async ({ page }) => {
  await setup(page);
  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('feat/command-menu');
  const title = page.getByRole('textbox', { name: 'Pull request title' });
  await title.fill('Add the command palette');

  const body = page.getByRole('textbox', { name: 'Pull request description' });
  await body.fill('Adds a palette');
  await body.evaluate((el) => { el.setSelectionRange(0, 4); });
  await page.getByRole('button', { name: 'Bold' }).click();
  await expect(body).toHaveValue('**Adds** a palette');
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.locator('.npr-preview strong')).toHaveText('Adds');
  await page.getByRole('tab', { name: 'Write' }).click();

  // a title the user typed is kept when the branch changes
  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('feat/graph-search');
  await expect(title).toHaveValue('Add the command palette');
  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('feat/command-menu');

  const reviewers = page.getByRole('region', { name: 'Reviewers' });
  await reviewers.getByRole('textbox', { name: 'Add to reviewers' }).fill('alex');
  await reviewers.getByRole('textbox', { name: 'Add to reviewers' }).press('Enter');
  await expect(reviewers).toContainText('alex');
  await page.getByRole('button', { name: 'Assign yourself' }).click();
  await page.getByRole('region', { name: 'Labels' }).getByRole('textbox').fill('bug');
  await page.getByRole('region', { name: 'Labels' }).getByRole('textbox').press('Enter');
  await reviewers.getByRole('button', { name: 'Remove alex from reviewers' }).click();
  await reviewers.getByRole('textbox', { name: 'Add to reviewers' }).fill('maya');
  await reviewers.getByRole('textbox', { name: 'Add to reviewers' }).press('Enter');

  // draft is chosen from the menu next to the button; choosing does not create anything yet
  await page.getByRole('button', { name: 'Choose how to create the pull request' }).click();
  await page.getByRole('menuitemradio', { name: /Create draft pull request/ }).click();
  expect(await page.evaluate(() => window.__created.length)).toBe(0);
  await page.getByRole('button', { name: 'Create draft pull request' }).click();

  await expect.poll(() => page.evaluate(() => window.__created.length)).toBe(1);
  const [call] = await page.evaluate(() => window.__created);
  expect(call).toMatchObject({
    title: 'Add the command palette', body: '**Adds** a palette', head: 'feat/command-menu', base: 'main',
    draft: true, reviewers: ['maya'], assignees: ['@me'], labels: ['bug'],
  });
  // back on the list of pull requests
  await expect(page.getByRole('heading', { name: 'Open a pull request' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Pull requests', exact: true })).toBeVisible();
});

test('a branch with nothing new cannot be opened as a pull request', async ({ page }) => {
  await setup(page, { ...COMPARISON, compareOnly: 0, files: [] });
  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('feat/command-menu');
  await expect(page.locator('.npr-compare__status')).toContainText('anything to compare');
  await page.getByRole('textbox', { name: 'Pull request title' }).fill('Something');
  await expect(page.getByRole('button', { name: 'Create pull request' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Open a pull request' })).toHaveCount(0);
});
