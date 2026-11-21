import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function installWorktree(page) {
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = new Map();
    window.__worktree = files;
    window.__binary = new Map();
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_file_tree') { const base = await invoke(cmd, args); return { ...base, entries: [...base.entries, ...files.keys()] }; }
      if (cmd === 'read_worktree_file' && files.has(args.path)) return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'json' };
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
      if (cmd === 'write_worktree_binary') { window.__binary.set(args.path, args.data); return null; }
      if (cmd === 'delete_worktree_file') { files.delete(args.path); return null; }
      return invoke(cmd, args);
    };
  });
}

async function setup(page, nav, template) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: nav, exact: true }).click();
  await page.getByRole('button', { name: template }).click();
}

test('Diagram right-click menu: add here, edit, duplicate, delete, undo', async ({ page }) => {
  await setup(page, 'Diagram', /Flowchart/);
  const nodes = () => page.locator('.dgm__svg [data-node]').count();
  await expect.poll(nodes).toBe(4);

  const box = await page.locator('.dgm__svg').boundingBox();
  await page.locator('.dgm__svg').click({ button: 'right', position: { x: box.width - 120, y: box.height - 80 } });
  const menu = page.getByRole('menu', { name: 'Diagram context menu' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Add decision here' }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(nodes).toBe(5);

  await page.locator('.dgm__svg [data-node]').filter({ hasText: 'Start' }).first().click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(nodes).toBe(6);

  await page.locator('.dgm__svg [data-node]').filter({ hasText: 'Start' }).first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect.poll(nodes).toBe(5);

  await page.locator('.dgm__svg').click({ button: 'right', position: { x: box.width - 40, y: 40 } });
  await menu.getByRole('menuitem', { name: 'Undo' }).click();
  await expect.poll(nodes).toBe(6);

  // Escape closes it
  await page.locator('.dgm__svg').click({ button: 'right', position: { x: box.width - 40, y: 40 } });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('Design right-click menu: add here, copy/paste, group, delete', async ({ page }) => {
  await setup(page, 'Design', /Mobile app/);
  const layers = () => page.locator('.dgn-layer__name').count();
  const before = await layers();
  const menu = page.getByRole('menu', { name: 'Design context menu' });

  const box = await page.locator('.dgn__svg').boundingBox();
  await page.locator('.dgn__svg').click({ button: 'right', position: { x: box.width - 60, y: box.height - 60 } });
  await menu.getByRole('menuitem', { name: 'Add rectangle here' }).click();
  await expect.poll(layers).toBe(before + 1);

  await page.locator('.dgn__svg [data-id]').nth(2).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Copy' }).click();
  await page.locator('.dgn__svg [data-id]').nth(2).click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Paste' })).toBeEnabled();
  await menu.getByRole('menuitem', { name: 'Paste' }).click();
  await expect.poll(layers).toBe(before + 2);

  await page.locator('.dgn__svg [data-id]').nth(2).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Group' }).click();
  await expect.poll(layers).toBe(before + 3);

  await page.locator('.dgn__svg [data-id]').nth(2).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect.poll(layers).toBeLessThan(before + 3);
});

test('Board right-click menu: add here, duplicate, undo', async ({ page }) => {
  await setup(page, 'Board', /Retrospective/);
  const items = () => page.locator('.brd__svg [data-id]').count();
  const start = await items();
  const menu = page.getByRole('menu', { name: 'Board context menu' });

  const box = await page.locator('.brd__svg').boundingBox();
  await page.locator('.brd__svg').click({ button: 'right', position: { x: box.width - 40, y: box.height - 40 } });
  await menu.getByRole('menuitem', { name: 'Add sticky note here' }).click();
  await expect.poll(items).toBe(start + 1);

  const sticky = page.locator('.brd__svg [data-id]').filter({ hasText: /\S/ }).first();
  await sticky.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(items).toBeGreaterThan(start + 1);

  await page.locator('.brd__svg').click({ button: 'right', position: { x: box.width - 40, y: 40 } });
  await expect(menu.getByRole('menuitem', { name: 'Embed diagram or design…' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Undo' }).click();
  await expect.poll(items).toBe(start + 1);
});
