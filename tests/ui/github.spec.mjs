import { test, expect } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
const errors = new WeakMap();

test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page).push(error.message));
  await installBackend(page);
  await openFixture(page);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator('.error-boundary')).toHaveCount(0);
});

test('populated private PR and workflow details render', async ({ page }) => {
  await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).click();
  await page.getByText('Private repository pull request', { exact: true }).first().click();
  await expect(page.getByText('Reviewable private PR body')).toBeVisible();
  await page.locator('.nav-item').filter({ hasText: 'Actions' }).click();
  // GitHub's layout: the runs are listed first, a run opens on its own page
  await expect(page.getByRole('complementary', { name: 'Workflows' }).getByRole('button', { name: 'CI' })).toBeVisible();
  await page.getByText('Successful CI run', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /Successful CI run/ })).toBeVisible();
  await page.getByRole('button', { name: 'All logs' }).click();
  await expect(page.getByText('CI completed successfully')).toBeVisible();
});

test('PR summary renders Markdown and expandable release notes', async ({ page }) => {
  await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).click();
  const summary = page.locator('.pr-summary');
  await expect(summary.locator('strong')).toHaveText('Bumps');
  await expect(summary.getByRole('link', { name: 'example/action' }))
    .toHaveAttribute('href', 'https://github.com/example/action');
  await expect(summary.getByRole('link', { name: 'Unsafe link' })).toHaveCount(0);
  await expect(summary.locator('code')).toBeHidden();
  await summary.getByText('Release notes', { exact: true }).click();
  await expect(summary.locator('li code')).toHaveText('action');
  await expect(summary.locator('li code')).toBeVisible();
});

test('full PR diff falls back to file patches when GitHub rejects the combined diff', async ({ page }) => {
  await page.evaluate(() => { window.testBackend.failures.gh_pr_diff = 'HTTP 406: PullRequest.diff too_large'; });
  await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).click();
  await page.getByRole('button', { name: /^Files changed/ }).click();
  await page.getByRole('button', { name: /View full diff/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Full diff · #42' });
  await expect(dialog.getByText('new feature', { exact: true }).first()).toBeVisible();
  await dialog.getByRole('button', { name: /notes.txt/ }).click();
  await expect(dialog.getByText('No text diff available for this file.')).toBeVisible();
});

test('PR commit opens its changed files and code compare', async ({ page }) => {
  await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).click();
  await page.getByRole('button', { name: /^Commits/ }).click();
  const commit = page.getByRole('button', { name: /Update feature files/ });
  await expect(commit).toContainText('fixture-author');
  await expect(commit.locator('time')).toHaveAttribute('datetime', '2026-11-15T00:00:00Z');
  await expect(commit.locator('.pr-commit__avatar img')).toHaveCount(1);
  await commit.click();
  await expect(page.getByText('Document the feature changes.')).toBeVisible();
  await expect(commit).toHaveAttribute('aria-expanded', 'true');
  const inline = page.locator('.pr-file__compare');
  await expect(inline.getByText('new feature', { exact: true }).first()).toBeVisible();
  await expectDiffLayouts(inline);
  await expect(page.getByRole('button', { name: /^feature\.txt/ })).toContainText('+1 −1');
  const notes = page.getByRole('button', { name: /^notes\.txt/ });
  await expect(notes).toContainText('+1 −0');
  await notes.click();
  await expect(inline.getByText('release notes', { exact: true }).first()).toBeVisible();
  await commit.click();
  await expect(inline).toHaveCount(0);
  expect(await page.evaluate(() => window.testBackend.calls.find(({ cmd }) => cmd === 'gh_pr_commit_diff')?.args))
    .toEqual({ oid: '1234567890123456789012345678901234567890' });
});

test('PR files expand an inline diff and share it with full compare', async ({ page }) => {
  await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).click();
  await page.getByRole('button', { name: /^Files changed/ }).click();
  const feature = page.getByRole('button', { name: /^feature.txt/ });
  const notes = page.getByRole('button', { name: /^notes.txt/ });
  const inline = page.locator('.pr-file__compare');

  await feature.click();
  await expect(feature).toHaveAttribute('aria-expanded', 'true');
  await expect(inline.getByText('new feature', { exact: true }).first()).toBeVisible();
  await expectDiffLayouts(inline);
  await notes.click();
  await expect(feature).toHaveAttribute('aria-expanded', 'false');
  await expect(inline.getByText('release notes', { exact: true }).first()).toBeVisible();
  await notes.press('Space');
  await expect(inline).toHaveCount(0);

  await page.getByRole('button', { name: /View full diff/ }).click();
  await expect(page.getByRole('dialog', { name: 'Full diff · #42' })).toBeVisible();
  expect(await page.evaluate(() => window.testBackend.calls.filter(({ cmd }) => cmd === 'gh_pr_diff')))
    .toEqual([{ cmd: 'gh_pr_diff', args: { number: 42 } }]);
});

async function expectDiffLayouts(inline) {
  const editor = inline.locator('.monaco-diff-editor');
  await inline.getByRole('button', { name: 'Split' }).click();
  await expect(editor).toHaveClass(/side-by-side/);
  await inline.getByRole('button', { name: 'Unified' }).click();
  await expect(editor).not.toHaveClass(/side-by-side/);
}

for (const message of ['HTTP 401: Bad credentials', 'HTTP 403: Resource protected by organization SAML enforcement. Authorize SSO.', 'HTTP 404: Not Found. Check repository access.']) {
  test(`GitHub failure is visible and retry recovers: ${message.slice(0, 8)}`, async ({ page }) => {
    await page.evaluate(message => { window.testBackend.failures.gh_pr_list = message; }, message);
    await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).click();
    await expect(page.getByText(message, { exact: false }).first()).toBeVisible();
    await page.evaluate(() => { delete window.testBackend.failures.gh_pr_list; });
    await page.getByRole('button', { name: /try again|retry/i }).first().click();
    await expect(page.getByText('Private repository pull request', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(message, { exact: false })).toHaveCount(0);
  });
}

test('workflow artifact error survives a fast response and retry succeeds', async ({ page }) => {
  await page.evaluate(() => { window.testBackend.failures.gh_run_artifacts = 'Artifact access denied'; });
  await page.locator('.nav-item').filter({ hasText: 'Actions' }).click();
  await page.getByText('Successful CI run', { exact: true }).first().click();
  await expect(page.getByText('Artifact access denied')).toBeVisible();
  await page.evaluate(() => { delete window.testBackend.failures.gh_run_artifacts; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('This run did not upload any artifacts.')).toBeVisible();
});

test('staging and a rejected commit preserve the draft until a successful retry', async ({ page }) => {
  await page.locator('.nav-item').filter({ hasText: 'Working changes' }).click();
  await page.getByRole('button', { name: 'Stage all', exact: true }).click();
  const message = page.getByRole('textbox', { name: 'Commit message' });
  const draft = 'Validation commit\n\nKeep this description after failure.';
  await message.fill(draft);
  await page.evaluate(() => { window.testBackend.commitFails = true; });
  await page.getByRole('button', { name: /Commit 1 staged file/ }).click();
  await expect(page.getByText('Pre-commit hook rejected the commit').first()).toBeVisible();
  await expect(message).toHaveValue(draft);
  await page.evaluate(() => { window.testBackend.commitFails = false; });
  await page.getByRole('button', { name: /Commit 1 staged file/ }).click();
  await expect(page.getByText('Everything is committed. Edit files to see them here.')).toBeVisible();
  await expect(message).toHaveCount(0);
});
