import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function setup(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installBackend(page);
  await openFixture(page);
}

const branchButton = (page) => page.locator('.status-bar').getByRole('button', { name: /^Checkout branch or tag/ });
const picker = (page) => page.getByRole('dialog', { name: 'Checkout branch or tag' });
const search = (page) => picker(page).getByRole('textbox', { name: 'Search branches and tags' });
const calls = (page, cmd) => page.evaluate((cmd) => window.testBackend.calls.filter((call) => call.cmd === cmd).map((call) => call.args), cmd);

test('the status bar branch opens a picker of local branches, remote branches and tags', async ({ page }) => {
  await setup(page);
  await expect(branchButton(page)).toHaveText('main');
  await branchButton(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
  for (const section of ['Branches', 'Remote branches', 'Tags']) {
    await expect(picker(page).getByText(section, { exact: true })).toBeVisible();
  }
  const current = picker(page).getByRole('button', { name: /^main .*current/ });
  await expect(current).toBeVisible();
  await expect(picker(page).getByRole('button', { name: /^origin\/release\/2\.0 / })).toBeVisible();
  // The full list comes from the backend, not the 20 tags in the app state.
  await expect(picker(page).getByRole('button', { name: /^v0\.1\.0 / })).toBeVisible();

  // Typing filters every section.
  await search(page).fill('graph');
  await expect(picker(page).getByRole('button', { name: /^feat\/graph-search Tip of/ })).toBeVisible();
  await expect(picker(page).getByRole('button', { name: /^origin\/feat\/graph-search / })).toBeVisible();
  await expect(picker(page).getByRole('button', { name: /^main / })).toHaveCount(0);
  await expect(picker(page).getByText('Tags', { exact: true })).toHaveCount(0);

  // Arrow keys move the highlight; Enter checks the local branch out.
  await search(page).press('ArrowDown');
  await search(page).press('Enter');
  await expect(picker(page)).toHaveCount(0);
  await expect(branchButton(page)).toHaveText('feat/graph-search');
  expect(await calls(page, 'checkout_branch')).toEqual([{ name: 'feat/graph-search' }]);

  // Escape closes without doing anything.
  await branchButton(page).click();
  await search(page).press('Escape');
  await expect(picker(page)).toHaveCount(0);
});

test('a remote branch becomes a tracking branch, a tag is checked out detached', async ({ page }) => {
  await setup(page);
  await branchButton(page).click();
  await search(page).fill('release');
  const remote = picker(page).getByRole('button', { name: /^origin\/release\/2\.0 / });
  await expect(remote).toContainText('creates a local tracking branch');
  await remote.click();
  await expect(branchButton(page)).toHaveText('release/2.0');
  expect(await calls(page, 'checkout_remote_branch')).toEqual([{ remote: 'origin', name: 'release/2.0' }]);

  await branchButton(page).click();
  await search(page).fill('origin/main');
  await expect(picker(page).getByRole('button', { name: /^origin\/main / })).toContainText('switches to local main');

  await search(page).fill('v0.18');
  await picker(page).getByRole('button', { name: /^v0\.18\.0 / }).click();
  await expect(branchButton(page)).toContainText('(detached)');
  expect(await calls(page, 'checkout_tag')).toEqual([{ name: 'v0.18.0' }]);
});

test('Create new branch: from a typed name, or by choosing the action and typing it', async ({ page }) => {
  await setup(page);
  await branchButton(page).click();
  await search(page).fill('feature/new-thing');
  await expect(picker(page).getByText('No branch or tag matches')).toBeVisible();
  await picker(page).getByRole('button', { name: 'Create new branch “feature/new-thing”' }).click();
  await expect(branchButton(page)).toHaveText('feature/new-thing');

  await branchButton(page).click();
  await picker(page).getByRole('button', { name: 'Create new branch…' }).click();
  const name = picker(page).getByRole('textbox', { name: 'New branch name' });
  await expect(name).toBeFocused();
  await name.fill('fix/typo');
  await name.press('Enter');
  await expect(branchButton(page)).toHaveText('fix/typo');
  expect(await calls(page, 'create_branch')).toEqual([
    { name: 'feature/new-thing', checkout: true, fromRef: null },
    { name: 'fix/typo', checkout: true, fromRef: null },
  ]);

  // Escape in the name step goes back to the list instead of closing.
  await branchButton(page).click();
  await picker(page).getByRole('button', { name: 'Create new branch…' }).click();
  await picker(page).getByRole('textbox', { name: 'New branch name' }).press('Escape');
  await expect(search(page)).toBeVisible();
});
