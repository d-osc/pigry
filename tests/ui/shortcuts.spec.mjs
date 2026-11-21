import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function installWorktree(page) {
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = new Map();
    window.__worktree = files;
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_file_tree') { const base = await invoke(cmd, args); return { ...base, entries: [...base.entries, ...files.keys()] }; }
      if (cmd === 'read_worktree_file' && files.has(args.path)) return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'json' };
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
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

const zoomOf = async (locator) => Number((await locator.innerText()).replace('%', ''));

test('Diagram shortcuts: help, add shapes, tab, zoom, undo', async ({ page }) => {
  await setup(page, 'Diagram', /Flowchart/);
  const svg = page.locator('.dgm__svg');
  const nodes = () => page.locator('.dgm__svg [data-node]').count();
  await expect.poll(nodes).toBe(4);
  await svg.focus();

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toContainText('Add decision');
  await expect(help).toContainText('Auto layout');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);

  await svg.focus();
  await page.keyboard.press('2');
  await expect.poll(nodes).toBe(5);
  await page.keyboard.press('Escape');
  await svg.focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(nodes).toBe(4);

  const zoom = page.locator('.dgm__zoom');
  const before = await zoomOf(zoom);
  await page.keyboard.press('=');
  await expect.poll(() => zoomOf(zoom)).toBeGreaterThan(before);
  await page.keyboard.press('Shift+Digit0');
  await expect.poll(() => zoomOf(zoom)).toBe(100);

  await page.keyboard.press('Tab');
  await expect(page.locator('.ai-composer__sel-chip--layer')).toHaveCount(1);
  await page.keyboard.press('c');
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(help).toBeVisible();
});

test('Design shortcuts: help, tab, cut and paste, zoom, lock', async ({ page }) => {
  await setup(page, 'Design', /Mobile app/);
  const svg = page.locator('.dgn__svg');
  const layers = () => page.locator('.dgn-layer__name').count();
  const total = await layers();
  await svg.focus();

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toContainText('Bring to front');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);

  await svg.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('.dgn-layer--on')).toHaveCount(1);
  await page.keyboard.press('Control+x');
  await expect.poll(layers).toBeLessThan(total);
  await page.keyboard.press('Control+v');
  await expect.poll(layers).toBe(total);

  const zoom = page.locator('.dgn__zoom');
  const before = await zoomOf(zoom);
  await page.keyboard.press('-');
  await expect.poll(() => zoomOf(zoom)).toBeLessThan(before);
  await page.keyboard.press('Shift+Digit1');
  await page.keyboard.press('Shift+Digit2');

  await page.keyboard.press('Control+Shift+l');
  await expect(page.locator('.dgn-layer--on').first()).toBeVisible();
  await page.keyboard.press('Control+Shift+h');
  await expect(page.locator('.dgn-layer--hidden')).toHaveCount(1);
  await page.keyboard.press('Control+Shift+h');
  await expect(page.locator('.dgn-layer--hidden')).toHaveCount(0);
});

test('Board shortcuts: help, tab, cut and paste, ungroup, add code, zoom', async ({ page }) => {
  await setup(page, 'Board', /Retrospective/);
  const svg = page.locator('.brd__svg');
  const items = () => page.locator('.brd__svg [data-id]').count();
  const total = await items();
  await svg.focus();

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toContainText('Add code');
  await expect(help).toContainText('Zoom to the selection');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);

  await svg.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('.brd-row--on')).toHaveCount(1);
  await page.keyboard.press('Control+x');
  await expect.poll(items).toBe(total - 1);
  await page.keyboard.press('Control+v');
  await expect.poll(items).toBeGreaterThanOrEqual(total);

  const zoom = page.locator('.brd__zoom');
  const before = await zoomOf(zoom);
  await page.keyboard.press('=');
  await expect.poll(() => zoomOf(zoom)).toBeGreaterThan(before);
  await page.keyboard.press('Shift+Digit0');
  await expect.poll(() => zoomOf(zoom)).toBe(100);

  await page.keyboard.press('k');
  await expect(page.getByRole('dialog', { name: 'Add code' })).toBeVisible();
  await page.keyboard.press('k');
  await expect(page.getByRole('dialog', { name: 'Add code' })).toHaveCount(0);

  await page.keyboard.press('Control+Shift+l');
  await page.keyboard.press('Control+Shift+l');
  await page.keyboard.press('Control+]');
  await page.keyboard.press('Control+[');
  await expect(svg).toBeVisible();
});
