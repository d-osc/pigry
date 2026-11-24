import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { GH_MOCKS } from './help-fixtures.mjs';

async function setup(page, overrides = {}) {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(({ mocks }) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__reruns = [];
    bridge.invoke = async (cmd, args) => {
      if (cmd === 'gh_run_rerun') { window.__reruns.push(args); return null; }
      if (cmd in mocks) return structuredClone(mocks[cmd]);
      return invoke(cmd, args);
    };
  }, { mocks: { ...GH_MOCKS, ...overrides } });
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Actions$/ }) }).click();
  await expect(page.getByRole('heading', { name: 'All workflows' })).toBeVisible();
}

const rail = (page) => page.getByRole('complementary', { name: 'Workflows' });
const rows = (page) => page.locator('.actions-row');

test('Actions lists the workflows on the left and the runs on the right, like GitHub', async ({ page }) => {
  await setup(page);
  await expect(rail(page).getByRole('button', { name: 'All workflows' })).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['CI', 'Release', 'CodeQL', 'Nightly']) await expect(rail(page).getByRole('button', { name: name, exact: true })).toBeVisible();
  await expect(rail(page).getByRole('button', { name: 'Nightly' })).toHaveClass(/actions-rail__item--off/); // disabled workflow is dimmed

  await expect(page.getByText('7 workflow runs')).toBeVisible();
  await expect(rows(page)).toHaveCount(7);
  const first = rows(page).first();
  await expect(first).toContainText('fix: preserve scroll position on refresh');
  await expect(first).toContainText('CI #7: Commit e7d38b4');
  await expect(first).toContainText('main');
  await expect(rows(page).nth(1).locator('.actions-status--failed')).toBeVisible();
  await expect(rows(page).nth(2).locator('.actions-status--running')).toBeVisible();
  await expect(rows(page).nth(1)).toContainText('Pull request a8f2c91');
  await expect(rows(page).nth(5)).toContainText('Manually run');
});

test('picking a workflow, the filters and the search narrow the list', async ({ page }) => {
  await setup(page);
  await rail(page).getByRole('button', { name: 'Release', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Release', exact: true })).toBeVisible();
  await expect(page.getByText('.github/workflows/release.yml')).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'View workflow file' })).toBeVisible();

  await rail(page).getByRole('button', { name: 'All workflows' }).click();
  await expect(rows(page)).toHaveCount(7);

  await page.getByRole('button', { name: 'Filter by status' }).click();
  await page.getByRole('menuitem', { name: 'Failed' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByText('1 workflow run', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filter by status' }).click();
  await page.getByRole('menuitem', { name: 'All statuses' }).click();

  await page.getByRole('textbox', { name: 'Search runs' }).fill('dependencies');
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Search runs' }).fill('zzz-nothing');
  await expect(page.getByText('No runs match the current filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(page)).toHaveCount(7);
});

test('a run opens on its own page with Summary, jobs, steps and logs', async ({ page }) => {
  await setup(page);
  await rows(page).first().click();
  await expect(page.getByRole('heading', { name: /fix: preserve scroll position on refresh/ })).toBeVisible();

  const summary = page.locator('.actions-summary');
  await expect(summary).toContainText('Triggered via push');
  await expect(summary).toContainText('Success');
  await expect(summary).toContainText('Total duration');
  await expect(summary.locator('.actions-summary__cell').nth(3)).toContainText('2'); // artifacts
  await expect(page.locator('.actions-jobcard')).toHaveCount(3);
  await expect(page.getByText('coverage-report')).toBeVisible();

  // a job: its steps and its log
  const nav = page.getByRole('navigation', { name: 'Run navigation' });
  await nav.getByRole('button', { name: 'test' }).click();
  await expect(page.getByRole('region', { name: 'Steps' })).toContainText('npm test');
  await expect(page.getByText('Tests  95 passed')).toBeVisible();

  await nav.getByRole('button', { name: 'All logs' }).click();
  await expect(page.locator('.actions-console__title')).toContainText('All jobs');
  await nav.getByRole('button', { name: 'Summary' }).click();
  await expect(summary).toBeVisible();

  // a finished run that passed offers Re-run all jobs only
  await page.getByRole('button', { name: 'Re-run jobs' }).click();
  await expect(page.getByRole('menuitem', { name: 'Re-run all jobs' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Re-run failed jobs' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Re-run all jobs' }).click();
  await expect.poll(() => page.evaluate(() => window.__reruns.length)).toBe(1);

  // back to the list
  await page.getByRole('button', { name: 'All workflows', exact: true }).first().click();
  await expect(rows(page)).toHaveCount(7);
});

test('a failed run offers Re-run failed jobs', async ({ page }) => {
  await setup(page, {
    gh_run_view: {
      ...GH_MOCKS.gh_run_view, status: 'completed', conclusion: 'failure',
      jobs: [{ id: 71, name: 'test', status: 'completed', conclusion: 'failure', duration: '1m', url: '', steps: [{ name: 'npm test', number: 1, status: 'completed', conclusion: 'failure', duration: '58s' }] }],
    },
  });
  await rows(page).nth(1).click();
  await expect(page.locator('.actions-detail__banner')).toContainText('1 job failed');
  await page.getByRole('button', { name: 'Re-run jobs' }).click();
  await page.getByRole('menuitem', { name: 'Re-run failed jobs' }).click();
  await expect.poll(() => page.evaluate(() => window.__reruns.map((r) => r.failedOnly ?? r.failed_only))).toEqual([true]);
});
