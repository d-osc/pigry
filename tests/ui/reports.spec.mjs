import { expect, test } from '@playwright/test';
import { demoTree } from '../../src/lib/demoWorkspace.ts';
import { installBackend, openFixture } from './backend.mjs';

const QA = '.pigry/reports/qa/login-cases.md';
const HAT = '.pigry/reports/white-hat/security-review.md';
const FILES = {
  [QA]: '# Login test cases\n\nAll **12** cases ran against the staging build.\n\n## Failures\n\n- TC-07 wrong password message',
  [HAT]: '# Security review\n\nNo secrets found in the working tree.',
};

async function setup(page, entries) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page, { entries });
  await openFixture(page);
  await page.evaluate((files) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (cmd, args) => {
      const result = await invoke(cmd, args);
      if (cmd === 'read_worktree_file' && files[args.path] !== undefined) return { ...result, content: files[args.path] };
      return result;
    };
  }, FILES);
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
}

test('Reports menu lists what agents saved, per agent, and shows the report rendered', async ({ page }) => {
  await setup(page, [...demoTree.entries, QA, HAT, '.pigry/reports/qa/evidence/TC-01.png']);
  const list = page.locator('.wiki-pages');
  await expect(list.getByText('@qa', { exact: true })).toBeVisible();
  await expect(list.getByText('@white-hat', { exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'login-cases.md' })).toBeVisible();
  await expect(list.getByText('TC-01.png')).toHaveCount(0);

  // the first report opens by itself, rendered as Markdown
  await expect(page.getByRole('heading', { name: 'Login test cases', level: 1 })).toBeVisible();
  await expect(page.locator('.wiki-md')).toContainText('All 12 cases ran against the staging build.');
  await expect(page.locator('.wiki-toc')).toContainText('Failures');

  await list.getByRole('button', { name: 'security-review.md' }).click();
  await expect(page.getByRole('heading', { name: 'Security review', level: 1 })).toBeVisible();
  await expect(page.locator('.wiki-md')).toContainText('No secrets found');

  await page.getByRole('textbox', { name: 'Find a report' }).fill('login');
  await expect(list.getByRole('button', { name: 'security-review.md' })).toHaveCount(0);
  await expect(list.getByRole('button', { name: 'login-cases.md' })).toBeVisible();
});

test('Reports menu explains where reports come from when there are none', async ({ page }) => {
  await setup(page, demoTree.entries);
  await expect(page.getByText('No reports yet').first()).toBeVisible();
  await expect(page.locator('.reports-empty')).toContainText('.pigry/reports/');
});
