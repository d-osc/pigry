import { expect, test } from '@playwright/test';
import { installBackend } from './backend.mjs';

test('home offers Local and Server and closes SSH on return to Local', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  const local = page.getByRole('button', { name: 'Local', exact: true });
  const server = page.getByRole('button', { name: 'Server', exact: true });
  await expect(local).toHaveAttribute('aria-pressed', 'true');
  await server.click();
  await page.getByLabel('Host', { exact: true }).fill('dev.example.com');
  await page.getByLabel('Username (optional)').fill('dev');
  await page.getByLabel('Port (optional)').fill('2222');
  await page.getByRole('button', { name: 'Connect over SSH' }).click();
  await expect(page.getByRole('region', { name: 'SSH terminal' }).locator('.xterm')).toBeVisible();
  await local.click();
  await expect(page.getByRole('region', { name: 'SSH terminal' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.testBackend.calls
    .filter(({ cmd }) => cmd === 'pty_create_ssh' || cmd === 'pty_kill')))
    .toEqual([
      { cmd: 'pty_create_ssh', args: { host: 'dev.example.com', username: 'dev', port: 2222 } },
      { cmd: 'pty_kill', args: { id: 271 } },
    ]);
  await expect(page.getByRole('button', { name: /Open repository/ })).toBeVisible();
});
