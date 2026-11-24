import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** A small in-memory worktree on top of the test backend, so copy, move and delete really change the tree. */
async function setup(page) {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const added = new Set();
    const removed = new Set();
    window.__ops = [];
    window.__copied = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.__copied = text; } }, configurable: true });
    const under = (path, base) => path === base || path.startsWith(`${base}/`);
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_file_tree') {
        const base = await invoke(cmd, args);
        const entries = [...base.entries.filter((entry) => ![...removed].some((gone) => under(entry, gone))), ...added];
        return { ...base, entries: [...new Set(entries)].sort() };
      }
      if (cmd === 'copy_worktree_path') {
        window.__ops.push({ cmd, ...args });
        const base = await invoke('get_file_tree', {});
        const all = [...base.entries, ...added];
        const sources = all.filter((entry) => under(entry, args.oldPath));
        for (const entry of sources) added.add(args.newPath + entry.slice(args.oldPath.length));
        return null;
      }
      if (cmd === 'rename_worktree_file' || cmd === 'rename_worktree_folder') {
        window.__ops.push({ cmd, ...args });
        const base = await invoke('get_file_tree', {});
        const all = [...base.entries, ...added];
        for (const entry of all.filter((item) => under(item, args.oldPath))) { removed.add(entry); added.delete(entry); added.add(args.newPath + entry.slice(args.oldPath.length)); }
        return null;
      }
      if (cmd === 'delete_worktree_file' || cmd === 'delete_worktree_folder') { window.__ops.push({ cmd, ...args }); removed.add(args.path); return null; }
      if (cmd === 'write_worktree_file') { window.__ops.push({ cmd, ...args }); added.add(args.path); return null; }
      if (cmd === 'reveal_worktree_path') { window.__ops.push({ cmd, ...args }); return null; }
      return invoke(cmd, args);
    };
  });
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Explorer$/ }) }).click();
  await expect(page.locator('.tree-row[data-path="README.md"]')).toBeVisible();
}

const row = (page, path) => page.locator(`.tree-row[data-path="${path}"]`);
const ops = (page, cmd) => page.evaluate((cmd) => window.__ops.filter((op) => op.cmd === cmd), cmd);
const menuItems = (menu) => menu.getByRole('menuitem');

test('a file has VS Code\'s menu: open, open to the side, reveal, cut, copy, paste, paths, rename, delete', async ({ page }) => {
  await setup(page);
  await row(page, 'README.md').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'README.md menu' });
  await expect(menu).toBeVisible();
  // the entries, in VS Code's order (the shortcut is part of each entry's text)
  const labels = (await menuItems(menu).allTextContents()).map((text) => text.replace(/(Enter|Ctrl|⌘|Shift\+Alt|⌥|F2|Delete$).*$/, '').trim());
  expect(labels.map((label) => label.replace(/^Reveal in .*/, 'Reveal'))).toEqual([
    'Open', 'Open to the Side', 'Reveal', 'Cut', 'Copy', 'Paste', 'Copy Path', 'Copy Relative Path', 'Rename…', 'Delete',
  ]);
  await expect(menuItems(menu).first()).toContainText('Enter');
  await expect(menu.getByRole('menuitem', { name: /^Paste/ })).toBeDisabled(); // nothing cut or copied yet
  await expect(menu.getByRole('menuitem', { name: /^Rename/ })).toContainText('F2');
  await expect(menu.getByRole('menuitem', { name: /^Delete/ })).toContainText('Delete');
  await expect(menu.getByRole('menuitem', { name: /^Cut/ })).toContainText('X');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('a folder offers New File, New Folder, terminal, Find in Folder and Paste; empty space has its own menu', async ({ page }) => {
  await setup(page);
  await row(page, 'src').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'src menu' });
  for (const name of ['New File', 'New Folder', 'Open in Integrated Terminal', 'Find in Folder…', 'Cut', 'Paste', 'Copy Path', 'Copy Relative Path', 'Rename…', 'Delete']) {
    await expect(menu.getByRole('menuitem', { name: new RegExp(`^${name}`) }), name).toBeVisible();
  }
  await expect(menu.getByRole('menuitem', { name: /^Copy(?! (Path|Relative))/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // right-click on empty space under the files, and on the repository row
  await page.locator('.file-tree').click({ button: 'right', position: { x: 60, y: await page.locator('.file-tree').evaluate((el) => el.clientHeight - 6) } });
  const blank = page.getByRole('menu', { name: 'Explorer menu' });
  await expect(blank).toBeVisible();
  await expect(blank.getByRole('menuitem', { name: /^New File/ })).toBeVisible();
  await expect(blank.getByRole('menuitem', { name: /^Collapse All/ })).toBeVisible();
  await expect(blank.getByRole('menuitem', { name: /^Rename/ })).toHaveCount(0);
  await expect(blank.getByRole('menuitem', { name: /^Delete/ })).toHaveCount(0);
  await expect(blank.getByRole('menuitem', { name: /^Cut/ })).toHaveCount(0);
});

test('Copy Path and Copy Relative Path, Reveal and Find in Folder', async ({ page }) => {
  await setup(page);
  await row(page, 'README.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Copy Relative Path/ }).click();
  expect(await page.evaluate(() => window.__copied)).toBe('README.md');
  await row(page, 'README.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Copy Path/ }).click();
  expect(await page.evaluate(() => window.__copied)).toBe('/fixtures/workspace/README.md');

  await row(page, 'README.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Reveal in/ }).click();
  expect((await ops(page, 'reveal_worktree_path'))[0].path).toBe('README.md');

  await row(page, 'src').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Find in Folder/ }).click();
  await expect(page.getByRole('textbox', { name: 'Files to include' })).toHaveValue('src/**');
});

test('Copy then Paste puts a copy in the folder, and pasting beside the original names it "copy"', async ({ page }) => {
  await setup(page);
  await row(page, 'README.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Copy(?! (Path|Relative))/ }).click();

  await row(page, 'src').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^Paste/ })).toBeEnabled();
  await page.getByRole('menuitem', { name: /^Paste/ }).click();
  await expect.poll(async () => (await ops(page, 'copy_worktree_path')).length).toBe(1);
  expect((await ops(page, 'copy_worktree_path'))[0]).toMatchObject({ oldPath: 'README.md', newPath: 'src/README.md' });
  await expect(row(page, 'src/README.md')).toBeVisible();

  // paste again from a file in the same folder: the name is taken, so it becomes "README copy.md"
  await row(page, 'package.json').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Paste/ }).click();
  await expect.poll(async () => (await ops(page, 'copy_worktree_path')).length).toBe(2);
  expect((await ops(page, 'copy_worktree_path'))[1]).toMatchObject({ oldPath: 'README.md', newPath: 'README copy.md' });
});

test('Cut then Paste moves the file into the folder', async ({ page }) => {
  await setup(page);
  await row(page, 'package.json').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Cut/ }).click();
  await row(page, 'src').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Paste/ }).click();
  await expect.poll(async () => (await ops(page, 'rename_worktree_file')).length).toBe(1);
  expect((await ops(page, 'rename_worktree_file'))[0]).toMatchObject({ oldPath: 'package.json', newPath: 'src/package.json' });
  await expect(row(page, 'package.json')).toHaveCount(0);
});

test('New File starts renaming right away, like VS Code', async ({ page }) => {
  await setup(page);
  await row(page, 'src').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^New File/ }).click();
  await expect.poll(async () => (await ops(page, 'write_worktree_file')).some((op) => op.path === 'src/untitled.txt')).toBe(true);
  const name = page.getByRole('textbox', { name: 'New name' });
  await expect(name).toBeVisible();
  await name.fill('notes.txt');
  await name.press('Enter');
  // the file is renamed, then opened in the editor
  await expect.poll(async () => (await ops(page, 'rename_worktree_file')).some((op) => op.newPath === 'src/notes.txt')).toBe(true);
  await expect(page.locator('.explorer-screen__editor-col')).toContainText('notes.txt');
});

test('keyboard shortcuts on a focused row: Ctrl+C / Ctrl+V, F2 and Delete', async ({ page }) => {
  await setup(page);
  await row(page, 'README.md').click();
  await page.keyboard.press('Control+c');
  await row(page, 'src').focus();
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await ops(page, 'copy_worktree_path')).length).toBe(1);
  expect((await ops(page, 'copy_worktree_path'))[0]).toMatchObject({ oldPath: 'README.md', newPath: 'src/README.md' });

  await row(page, 'package.json').focus();
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'New name' })).toBeVisible();
  await page.keyboard.press('Escape');

  await row(page, 'package.json').focus();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await ops(page, 'delete_worktree_file')).length).toBe(1);
  expect((await ops(page, 'delete_worktree_file'))[0].path).toBe('package.json');
});

test('Open to the Side puts the file in a second editor group', async ({ page }) => {
  await setup(page);
  await row(page, 'README.md').click();
  await expect(page.locator('.explorer-screen__editor-col')).toHaveCount(1);
  await row(page, 'package.json').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Open to the Side/ }).click();
  await expect(page.locator('.explorer-screen__editor-col')).toHaveCount(2);
});
