import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function setup(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installBackend(page);
  await openFixture(page);
}

const nav = (page) => page.locator('.nav-sidebar');
const quick = (page) => nav(page).getByRole('navigation', { name: 'Quick access' });
const workspace = (page) => nav(page).locator('.nav-sidebar__workspace').first();
const extensions = (page) => nav(page).getByRole('navigation', { name: 'Extensions' });
/** The row of a menu inside a group, found by the menu's exact name. */
const row = (scope, name) => scope.locator('.nav-row').filter({ has: scope.page().getByRole('button', { name, exact: true }) });
const pinned = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('pigry:quick-access') ?? '[]'));
const quickNames = (page) => quick(page).locator('.nav-item__label').allInnerTexts();

test('Quick access sits above Workspace and explains how to pin when it is empty', async ({ page }) => {
  await setup(page);
  const headings = nav(page).locator('.nav-sidebar__heading');
  await expect(headings.nth(0)).toHaveText('Quick access');
  await expect(headings.nth(1)).toHaveText('Workspace');
  await expect(quick(page)).toContainText('Pin a menu from Workspace or Extensions');
  await expect(quick(page).locator('.nav-row')).toHaveCount(0);
});

test('menus from Workspace and Extensions are pinned with the pin button, opened from Quick access, and unpinned', async ({ page }) => {
  await setup(page);
  // Workspace menu
  const cherry = row(workspace(page), 'Cherry Pick');
  await cherry.hover();
  await cherry.getByRole('button', { name: 'Pin to Quick access' }).click();
  await expect(quick(page).getByRole('button', { name: 'Cherry Pick', exact: true })).toBeVisible();
  await expect(quick(page)).not.toContainText('Pin a menu from');
  await expect(cherry.getByRole('button', { name: 'Unpin from Quick access' })).toHaveAttribute('aria-pressed', 'true');

  // built-in extension menu and the Extension Store
  const drawing = row(extensions(page), 'Drawing');
  await drawing.hover();
  await drawing.getByRole('button', { name: 'Pin to Quick access' }).click();
  const store = row(extensions(page), 'Extension Store');
  await store.hover();
  await store.getByRole('button', { name: 'Pin to Quick access' }).click();
  await expect.poll(() => quickNames(page)).toEqual(['Cherry Pick', 'Drawing', 'Extension Store']);
  expect(await pinned(page)).toEqual(['cherry-pick', 'drawing', 'extensions']);

  // opening from Quick access goes to the menu
  await quick(page).getByRole('button', { name: 'Drawing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Drawing', exact: true }).first()).toBeVisible();
  await expect(quick(page).locator('.nav-item--active')).toHaveText('Drawing');

  // unpin from Quick access itself
  const inQuick = row(quick(page), 'Cherry Pick');
  await inQuick.hover();
  await inQuick.getByRole('button', { name: 'Unpin from Quick access' }).click();
  await expect.poll(() => quickNames(page)).toEqual(['Drawing', 'Extension Store']);
  await expect(cherry.getByRole('button', { name: 'Pin to Quick access' })).toHaveAttribute('aria-pressed', 'false');
});

test('right-click pins, reorders and unpins; the order is remembered after a reload', async ({ page }) => {
  await setup(page);
  for (const name of ['Explorer', 'Branches', 'Releases']) {
    await workspace(page).getByRole('button', { name, exact: true }).click({ button: 'right' });
    await page.getByRole('menu', { name: `${name} menu` }).getByRole('menuitem', { name: 'Pin to Quick access' }).click();
  }
  await expect.poll(() => quickNames(page)).toEqual(['Explorer', 'Branches', 'Releases']);

  await workspace(page).getByRole('button', { name: 'Explorer', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Explorer menu' }).getByRole('menuitem', { name: 'Unpin from Quick access' })).toBeVisible();
  await page.keyboard.press('Escape');

  await quick(page).getByRole('button', { name: 'Releases', exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Releases menu' });
  await expect(menu.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Move up' }).click();
  await expect.poll(() => quickNames(page)).toEqual(['Explorer', 'Releases', 'Branches']);

  await quick(page).getByRole('button', { name: 'Explorer', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Explorer menu' }).getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
  await page.getByRole('menu', { name: 'Explorer menu' }).getByRole('menuitem', { name: 'Unpin from Quick access' }).click();
  await expect.poll(() => quickNames(page)).toEqual(['Releases', 'Branches']);

  await page.reload();
  await page.locator('.home__recent-item').first().click();
  await expect.poll(() => quickNames(page)).toEqual(['Releases', 'Branches']);
});

test('dragging a pinned menu reorders Quick access', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { localStorage.setItem('pigry:quick-access', JSON.stringify(['explorer', 'branches', 'releases'])); window.dispatchEvent(new CustomEvent('pigry:quick-access-changed')); });
  await expect.poll(() => quickNames(page)).toEqual(['Explorer', 'Branches', 'Releases']);
  // HTML5 drag and drop, with the same events a real drag fires
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('nav[aria-label="Quick access"] .nav-row')];
    const [explorer, , releases] = rows;
    const data = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    fire(releases.querySelector('.nav-item'), 'dragstart');
    fire(explorer.querySelector('.nav-item'), 'dragenter');
    fire(explorer.querySelector('.nav-item'), 'dragover');
    fire(explorer.querySelector('.nav-item'), 'drop');
    fire(releases.querySelector('.nav-item'), 'dragend');
  });
  await expect.poll(() => quickNames(page)).toEqual(['Releases', 'Explorer', 'Branches']);
  expect(await pinned(page)).toEqual(['releases', 'explorer', 'branches']);
});

test('search filters Quick access, and a switched-off extension menu leaves it', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { localStorage.setItem('pigry:quick-access', JSON.stringify(['explorer', 'board', 'no-such-menu'])); window.dispatchEvent(new CustomEvent('pigry:quick-access-changed')); });
  await expect.poll(() => quickNames(page)).toEqual(['Explorer', 'Board']);

  await page.getByRole('textbox', { name: 'Search the workspace menu' }).fill('boa');
  await expect.poll(() => quickNames(page)).toEqual(['Board']);
  await page.getByRole('textbox', { name: 'Search the workspace menu' }).fill('zzzz');
  await expect(quick(page)).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search the workspace menu' }).fill('');

  await page.evaluate(async () => (await import('/src/lib/builtinExtensions.ts')).setMenuEnabled('board', false));
  await expect.poll(() => quickNames(page)).toEqual(['Explorer']);
  await page.evaluate(async () => (await import('/src/lib/builtinExtensions.ts')).setMenuEnabled('board', true));
  await expect.poll(() => quickNames(page)).toEqual(['Explorer', 'Board']);
});
