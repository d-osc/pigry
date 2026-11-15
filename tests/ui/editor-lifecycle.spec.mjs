import { test, expect } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('repeated editor teardown releases detached workspace DOM', async ({ page }) => {
  test.setTimeout(90_000);
  await installBackend(page);
  await openFixture(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  const leaveEditor = async () => {
    await expect(page.locator('.monaco-editor').first()).toBeVisible();
    await page.getByRole('button', { name: 'Go home', exact: true }).click();
    await expect(page.locator('.home__card')).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await leaveEditor();
  await cdp.send('HeapProfiler.collectGarbage');
  const baseline = await cdp.send('Memory.getDOMCounters');
  for (let i = 0; i < 15; i++) {
    await page.locator('.home__recent-item').first().click();
    await leaveEditor();
  }
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await cdp.send('Memory.getDOMCounters');
  expect(after.nodes - baseline.nodes).toBeLessThan(2000);
  expect(errors).toEqual([]);
});
