import { test, expect } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('large folders keep a bounded DOM while scrolling, selecting and collapsing', async ({ page }) => {
  const entries = Array.from({ length: 20000 }, (_, i) => `large/file-${String(i).padStart(5, '0')}.txt`);
  await installBackend(page, { entries });
  await openFixture(page);
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  const tree = page.locator('.file-tree');
  expect(await tree.locator('.tree-row').count()).toBeLessThan(100);
  await tree.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const last = tree.locator('[title="large/file-19999.txt"]');
  await expect(last).toBeVisible();
  await last.click();
  await expect(last).toHaveClass(/tree-row--selected/);
  await expect(page.locator('.editor-pane .file-history__count')).toContainText('file-19999.txt');
  await tree.evaluate(element => { element.scrollTop = 0; });
  await tree.locator('[title="large"]').click();
  await expect(tree.locator('.tree-row')).toHaveCount(1);
  await tree.locator('[title="large"]').click();
  await expect(tree.locator('[title="large/file-19999.txt"]')).toBeVisible();
  expect(await tree.locator('.tree-row').count()).toBeLessThan(100);
});
