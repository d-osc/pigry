import { test, expect } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

// File history "Restore": take one file back to its content at a commit.
const PATH = 'src/app.ts';
const V3 = '3333333aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEL = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const V1 = '1111111ccccccccccccccccccccccccccccccccc';
const VERSIONS = { [V3]: 'CURRENT_VERSION();\n', [V1]: 'FIRST_VERSION();\n' };
const now = Math.floor(new Date('2026-11-26T00:00:00Z').getTime() / 1000);
const commit = (oid, summary, extra = {}) => ({
  oid, shortOid: oid.slice(0, 7), summary, authorName: 'Fixture Author', authorInitials: 'FA', timeSeconds: now, path: PATH, ...extra,
});
const HISTORY = [
  commit(V3, 'edit after the rename'),
  commit(DEL, 'delete the file for a while', { deleted: true }),
  commit(V1, 'first version under the old name', { path: 'lib/old-app.ts' }),
];

async function setup(page) {
  await installBackend(page, { entries: [PATH, 'README.md'], clean: true });
  // Wrap the fixture backend (installed by the previous init script) with the
  // commands this feature uses; everything else falls through.
  await page.addInitScript(({ path, history, versions }) => {
    const fixture = { files: { [path]: versions[history[0].oid] }, restored: [] };
    window.restoreFixture = fixture;
    const internals = window.__TAURI_INTERNALS__;
    const fallback = internals.invoke;
    const text = (content) => ({ content, binary: false, tooLarge: false, language: 'typescript' });
    internals.invoke = async (cmd, args = {}) => {
      switch (cmd) {
        case 'get_file_history': return history;
        case 'read_file_at_commit': return text(versions[args.oid] ?? '');
        case 'read_worktree_file': return text(fixture.files[args.path] ?? '');
        case 'write_worktree_file': fixture.files[args.path] = args.content; return null;
        case 'restore_file_from_commit':
          fixture.restored.push(args);
          fixture.files[args.path] = versions[args.oid];
          return { sourcePath: args.sourcePath ?? args.path, shortOid: args.oid.slice(0, 7), binary: false };
        case 'refresh': {
          const state = await fallback(cmd, args);
          if (fixture.restored.length) {
            state.repository.files = [{
              id: `${path}:unstaged`, path, name: 'app.ts', directory: 'src', status: 'M',
              additions: 1, deletions: 1, staged: false, untracked: false,
            }];
          }
          return state;
        }
        default: return fallback(cmd, args);
      }
    };
  }, { path: PATH, history: HISTORY, versions: VERSIONS });
  await openFixture(page);
  await page.locator(`[title="${PATH}"]`).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.file-history__count')).toContainText('app.ts · 3 commits');
}

const editorText = (page) => page.locator('.editor-pane__editor .monaco-editor .view-lines').first();
const restoreButton = (page, oid) => page.getByRole('button', { name: `Restore app.ts from ${oid.slice(0, 7)}` });

test('restores a clean file from a commit without asking, and toasts the commit', async ({ page }) => {
  await setup(page);
  await expect(editorText(page)).toContainText('CURRENT_VERSION();');

  // Every commit row has a Restore button; the deleting commit's is disabled.
  await expect(restoreButton(page, V3)).toBeEnabled();
  await expect(restoreButton(page, DEL)).toBeDisabled();
  await expect(page.locator(`.file-history__row[data-oid="${DEL}"] .file-history__tag`)).toHaveText('Deleted');
  await expect(page.locator(`.file-history__row[data-oid="${V1}"] .file-history__tag`)).toHaveText('old-app.ts');

  await restoreButton(page, V1).click();
  await expect(page.getByRole('alertdialog', { name: 'Confirm restore' })).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: 'Restored app.ts from commit 1111111 (was lib/old-app.ts)' })).toBeVisible();
  // The renamed commit reads the old path and writes the current one.
  expect(await page.evaluate(() => window.restoreFixture.restored)).toEqual([{ path: 'src/app.ts', oid: V1, sourcePath: 'lib/old-app.ts' }]);
  await expect(editorText(page)).toContainText('FIRST_VERSION();');
  await expect(page.locator('.editor-pane__dirty')).toHaveCount(0);
  // The restored file now counts as a working change.
  await expect(page.locator('.nav-item', { hasText: 'Working changes' }).first().locator('.nav-item__badge')).toHaveText('1');
});

test('asks before overwriting unsaved edits, and Cancel keeps them', async ({ page }) => {
  await setup(page);
  await editorText(page).click();
  await page.keyboard.press('Control+End');
  // insertText skips Monaco's suggest widget, which would eat keystrokes.
  await page.keyboard.insertText('UNSAVED_EDIT();');
  await expect(page.locator('.editor-pane__dirty')).toBeVisible();

  await restoreButton(page, V1).click();
  const confirm = page.getByRole('alertdialog', { name: 'Confirm restore' });
  await expect(confirm).toContainText('Restore app.ts to 1111111? This replaces your unsaved edits to this file.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(await page.evaluate(() => window.restoreFixture.restored)).toEqual([]);
  await expect(editorText(page)).toContainText('UNSAVED_EDIT();');

  // From the Compare header this time: select the commit, then restore it.
  await page.locator(`.file-history__row[data-oid="${V1}"] .file-history__pick`).click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.locator('.compare-panel__sha').first()).toHaveText('1111111');
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: 'Restored app.ts from commit 1111111' })).toBeVisible();
  await expect(editorText(page)).toContainText('FIRST_VERSION();');
  await expect(editorText(page)).not.toContainText('UNSAVED_EDIT();');
  await expect(page.locator('.editor-pane__dirty')).toHaveCount(0);

  // Now it is an uncommitted change: restoring again asks first.
  await restoreButton(page, V3).click();
  await expect(confirm).toContainText('This replaces your uncommitted changes to this file.');
  await confirm.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(editorText(page)).toContainText('CURRENT_VERSION();');
  expect(await page.evaluate(() => window.restoreFixture.restored.map(call => call.oid))).toEqual([V1, V3]);
});
