import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function setup(page, { conflict = false } = {}) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await page.evaluate((conflict) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (cmd, args) => {
      if (conflict && cmd === 'revert_commit') {
        window.testBackend.calls.push({ cmd, args });
        throw 'error: could not revert 1a2b3c4... CONFLICT (content): Merge conflict in src/app.ts';
      }
      // the fixture's commit detail is always a merge commit, which cannot be reverted: show a plain commit instead
      if (cmd === 'get_commit_detail') return { ...(await invoke(cmd, args)), oid: args.oid, isMerge: false };
      if (conflict && cmd === 'merge_status') return { conflicted: ['src/app.ts'], inProgress: true };
      return invoke(cmd, args);
    };
  }, conflict);
  await page.locator('.nav-item').filter({ hasText: 'Revert commit' }).click();
  await expect(page.getByRole('heading', { name: 'Revert commit', exact: true })).toBeVisible();
}

const callsOf = (page, cmd) => page.evaluate((cmd) => window.testBackend.calls.filter((call) => call.cmd === cmd), cmd);

test('Revert commit: browse the current branch, open a commit and revert it', async ({ page }) => {
  await setup(page);
  // only the checked-out branch is listed: there is no branch picker like in Cherry Pick
  await expect(page.locator('.cherry__branch-select')).toHaveCount(0);
  const rows = page.locator('.cherry__row');
  await expect(rows.first()).toBeVisible();
  const summary = (await rows.first().locator('.cherry__row-summary').textContent()) ?? '';

  await rows.first().click();
  const revert = page.locator('.cherry__pick-btn');
  await expect(revert).toContainText(/^Revert [0-9a-f]{7}$/);
  await expect(revert).toBeVisible();
  await expect(page.locator('.cherry__detail')).toContainText(summary);
  await expect(page.locator('.cherry__files')).toBeVisible();

  await revert.click();
  await expect.poll(async () => (await callsOf(page, 'revert_commit')).length).toBe(1);
  const [call] = await callsOf(page, 'revert_commit');
  expect(call.args.oid).toMatch(/^[0-9a-f]{7,}/);
  await expect(page.locator('.cherry__conflict')).toHaveCount(0);
});

test('Revert commit: a conflicting revert lists the files and can be aborted', async ({ page }) => {
  await setup(page, { conflict: true });
  await page.locator('.cherry__row').first().click();
  await page.locator('.cherry__pick-btn').click();

  const panel = page.locator('.cherry__conflict');
  await expect(panel).toContainText('Revert conflicts');
  await expect(panel).toContainText('src/app.ts');

  await panel.getByRole('button', { name: 'Abort revert' }).click();
  await expect.poll(async () => (await callsOf(page, 'revert_abort')).length).toBe(1);
  await expect(panel).toHaveCount(0);
});

test('Cherry Pick still has its branch picker and its own wording', async ({ page }) => {
  await setup(page);
  await page.locator('.nav-item').filter({ hasText: 'Cherry Pick' }).click();
  await expect(page.getByRole('heading', { name: 'Cherry Pick', exact: true })).toBeVisible();
  await expect(page.locator('.cherry__branch-select')).toBeVisible();
  await page.locator('.cherry__row').first().click();
  await expect(page.locator('.cherry__pick-btn')).toContainText(/^Cherry-pick [0-9a-f]{7}$/);
});
