import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('sidebar search filters menu items, Enter opens the first match', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  const nav = page.locator('.nav-sidebar');
  const search = nav.getByRole('textbox', { name: 'Search the workspace menu' });
  await expect(nav.getByRole('button', { name: /Cherry Pick/ })).toBeVisible();

  await search.fill('cherry');
  await expect(nav.getByRole('button', { name: /Cherry Pick/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /Merge branch/ })).toHaveCount(0);
  await expect(nav.getByText('Local branches')).toHaveCount(0);

  // Branches, tags and stashes are not listed in the side bar, so they never match.
  await search.fill('graph-search');
  await expect(nav.getByText(/No match for/)).toBeVisible();

  await search.fill('zzz-no-such-thing');
  await expect(nav.getByText(/No match for/)).toBeVisible();

  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(nav.getByRole('button', { name: /Merge branch/ })).toBeVisible();

  await search.fill('compare');
  await search.press('Enter');
  await expect(nav.locator('.nav-item--active')).toContainText('Compare branch');
});
