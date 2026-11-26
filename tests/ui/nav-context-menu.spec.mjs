import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function setup(page) {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page);
  await openFixture(page);
}

const nav = (page) => page.locator('.nav-sidebar');

test('right-clicking a workspace menu offers Open, Open guide and the side bar actions', async ({ page }) => {
  await setup(page);
  await nav(page).getByRole('button', { name: /Cherry Pick/ }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Cherry Pick menu' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
  for (const item of ['Open guide', 'Collapse side bar', 'Preferences']) {
    await expect(menu.getByRole('menuitem', { name: new RegExp(`^${item}`) })).toBeVisible();
  }

  // Open guide switches to that menu and shows its guide
  await menu.getByRole('menuitem', { name: /^Open guide/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Cherry Pick guide' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Cherry Pick', exact: true })).toBeVisible();

  // Open is disabled for the menu you are already on
  await nav(page).getByRole('button', { name: /Cherry Pick/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Open goes to another menu
  await nav(page).getByRole('button', { name: /Merge branch/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
  // (the screen itself needs data the bare test backend lacks, so check the menu that became active)
  await expect(nav(page).locator('.nav-item--active')).toContainText('Merge branch');
});

test('the side bar lists only menus — no branches, tags, stashes or worktrees', async ({ page }) => {
  await setup(page);
  await expect(nav(page).getByRole('button', { name: /Cherry Pick/ })).toBeVisible();
  for (const title of ['Local branches', 'Remotes', 'Tags', 'Stashes', 'Worktrees', 'Submodules']) {
    await expect(nav(page).getByText(title, { exact: true })).toHaveCount(0);
  }
  await expect(nav(page).locator('.nav-branch, .nav-stash, .nav-section')).toHaveCount(0);
});

test('the side bar background has a menu, and the search box keeps the native one', async ({ page }) => {
  await setup(page);
  await nav(page).locator('.nav-sidebar__footer').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Side bar menu' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Collapse side bar/ }).click();
  await expect(nav(page)).toHaveCount(0);
});

test('right-clicking the search box does not open the side bar menu', async ({ page }) => {
  await setup(page);
  await nav(page).getByRole('textbox', { name: 'Search the workspace menu' }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
});
