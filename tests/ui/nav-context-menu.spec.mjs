import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function setup(page) {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page);
  await openFixture(page);
}

const nav = (page) => page.locator('.nav-sidebar');
const calls = (page, cmd) => page.evaluate((cmd) => window.testBackend.calls.filter((call) => call.cmd === cmd), cmd);

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

test('branches have Checkout, Copy name and Delete; the current branch cannot be checked out or deleted', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.__copied = text; } }, configurable: true }); });

  await nav(page).locator('.nav-branch', { hasText: 'main' }).first().click({ button: 'right' });
  const mainMenu = page.getByRole('menu', { name: 'Branch main menu' });
  await expect(mainMenu.getByRole('menuitem', { name: 'Checkout' })).toBeDisabled();
  await expect(mainMenu.getByRole('menuitem', { name: 'Delete branch' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await nav(page).locator('.nav-branch', { hasText: 'feat/graph-search' }).first().click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Branch feat/graph-search menu' });
  await menu.getByRole('menuitem', { name: 'Copy branch name' }).click();
  expect(await page.evaluate(() => window.__copied)).toBe('feat/graph-search');

  await nav(page).locator('.nav-branch', { hasText: 'feat/graph-search' }).first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Checkout' }).click();
  await expect.poll(async () => (await calls(page, 'checkout_branch')).length).toBe(1);
  expect((await calls(page, 'checkout_branch'))[0].args.name).toBe('feat/graph-search');
});

test('the side bar background has a menu, and the search box keeps the native one', async ({ page }) => {
  await setup(page);
  await nav(page).locator('.nav-sidebar__footer .repo-health').click({ button: 'right' });
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
