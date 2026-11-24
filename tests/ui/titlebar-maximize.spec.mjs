import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Double-clicking the empty part of the title bar maximizes / restores the window, like a native title bar. */
test('double-click on the header bar toggles maximize; buttons and single presses do not', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    bridge.metadata = bridge.metadata ?? { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } };
    const invoke = bridge.invoke;
    window.__win = [];
    bridge.invoke = async (cmd, args) => {
      if (String(cmd).startsWith('plugin:window|')) { window.__win.push(cmd); return null; }
      return invoke(cmd, args);
    };
  });
  const bar = page.locator('header.title-bar');
  const box = await bar.boundingBox();
  const empty = { x: box.x + box.width * 0.78, y: box.y + box.height / 2 }; // between the search box and the window buttons
  const count = (name) => page.evaluate((n) => window.__win.filter((c) => c === n).length, name);

  await page.mouse.dblclick(empty.x, empty.y);
  await expect.poll(() => count('plugin:window|toggle_maximize')).toBe(1);
  await page.mouse.dblclick(empty.x, empty.y);
  await expect.poll(() => count('plugin:window|toggle_maximize')).toBe(2); // restore

  await page.mouse.click(empty.x, empty.y);
  await expect.poll(() => count('plugin:window|start_dragging')).toBeGreaterThan(0);
  expect(await count('plugin:window|toggle_maximize')).toBe(2);

  await page.getByRole('button', { name: 'Go home' }).dblclick().catch(() => undefined);
  expect(await count('plugin:window|toggle_maximize')).toBe(2);
});
