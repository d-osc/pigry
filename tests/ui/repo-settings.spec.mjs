import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Records set_user_info calls; `fail` makes the next save fail. */
async function mockIdentity(page) {
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__identity = { saved: [], fail: false };
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_user_info') return { name: 'Old Name', email: 'old@example.com' };
      if (cmd === 'set_user_info') {
        if (window.__identity.fail) throw new Error('could not write config');
        window.__identity.saved.push({ name: args.name, email: args.email });
        return invoke('refresh', {});
      }
      return invoke(cmd, args);
    };
  });
}

async function openSettings(page) {
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Repository settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder('Your display name')).toHaveValue('Old Name');
  return dialog;
}

test.beforeEach(async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await mockIdentity(page);
});

test('Enter in the identity form saves it and closes the dialog', async ({ page }) => {
  const dialog = await openSettings(page);
  await dialog.getByPlaceholder('Your display name').fill('  New Name ');
  await dialog.getByPlaceholder('you@example.com').fill('new@example.com');
  await dialog.getByPlaceholder('you@example.com').press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__identity.saved)).toEqual([{ name: 'New Name', email: 'new@example.com' }]);
});

test('the Save identity button saves and closes the dialog', async ({ page }) => {
  const dialog = await openSettings(page);
  await dialog.getByPlaceholder('Your display name').fill('Button Name');
  await dialog.getByRole('button', { name: 'Save identity' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.__identity.saved)).toEqual([{ name: 'Button Name', email: 'old@example.com' }]);
});

test('a failed save keeps the dialog open so the values are not lost', async ({ page }) => {
  await page.evaluate(() => { window.__identity.fail = true; });
  const dialog = await openSettings(page);
  await dialog.getByPlaceholder('Your display name').fill('Kept Name');
  await dialog.getByPlaceholder('Your display name').press('Enter');
  await expect(page.getByText(/could not write config/)).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder('Your display name')).toHaveValue('Kept Name');
  await expect(dialog.getByRole('button', { name: 'Save identity' })).toBeEnabled();
});
