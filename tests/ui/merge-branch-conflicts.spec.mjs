import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

const APP = [
  'import { theme } from "./theme";',
  '<<<<<<< HEAD', 'const color = "red";', '=======', 'const color = "green";', '>>>>>>> feat/graph-search',
  'const size = 10;',
  '<<<<<<< HEAD', 'export const mode = "dark";', '=======', 'export const mode = "light";', '>>>>>>> feat/graph-search',
  '',
].join('\n');

/** A merge of feat/graph-search into main that stops on two conflicted files: src/app.ts (two conflicts) and
 * notes.md (deleted on main, changed on the incoming branch). */
async function installMergeConflicts(page) {
  await page.addInitScript(({ app }) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = { 'src/app.ts': app, 'notes.md': 'notes\nfrom the branch\n' };
    const versions = {
      'src/app.ts': { base: null, current: 'current app\n', incoming: 'incoming app\n', binary: false },
      'notes.md': { base: 'notes\n', current: null, incoming: 'notes\nfrom the branch\n', binary: false },
    };
    const sim = { inProgress: false, conflicted: new Set(), resolved: [], continued: false, aborted: false };
    window.__merge = sim;
    bridge.invoke = async (cmd, args = {}) => {
      switch (cmd) {
        case 'merge_preview': return { upToDate: false, commits: [], files: [] };
        case 'merge_status': return { inProgress: sim.inProgress, conflicted: [...sim.conflicted] };
        case 'merge_branch':
          sim.inProgress = true;
          sim.conflicted = new Set(Object.keys(files));
          throw 'CONFLICT: merge has unresolved conflicts';
        case 'conflict_state':
          return {
            operation: sim.inProgress ? 'merge' : null, branch: 'main', currentLabel: 'your branch (main)',
            incomingLabel: "Merge branch 'feat/graph-search' into main", incomingCommit: 'c4b82e6 feat: highlight', conflicted: [...sim.conflicted].sort(), step: null,
          };
        case 'conflict_versions': return versions[args.path];
        case 'read_worktree_file':
          if (files[args.path] !== undefined) return { path: args.path, content: files[args.path], binary: false, tooLarge: false, language: 'plaintext' };
          break;
        case 'conflict_resolve_file':
          sim.resolved.push(args);
          sim.conflicted.delete(args.path);
          return null;
        case 'conflict_continue':
          if (sim.conflicted.size) throw `${sim.conflicted.size} file(s) are still conflicted`;
          sim.continued = true; sim.inProgress = false;
          return invoke('refresh', {});
        case 'merge_abort':
          sim.aborted = true; sim.inProgress = false; sim.conflicted.clear();
          return invoke('refresh', {});
        default: break;
      }
      return invoke(cmd, args);
    };
  }, { app: APP });
}

async function startConflictedMerge(page) {
  await page.setViewportSize({ width: 1400, height: 950 });
  await installBackend(page);
  await installMergeConflicts(page);
  await openFixture(page);
  await page.locator('.nav-item').filter({ hasText: 'Merge branch' }).first().click();
  await page.locator('.merge-branch__branch').filter({ hasText: 'feat/graph-search' }).click();
  await page.getByRole('button', { name: 'Merge feat/graph-search into main' }).click();
  const editor = page.getByRole('region', { name: 'Merge conflicts' });
  await expect(editor).toBeVisible();
  return editor;
}

const merge = (page) => page.evaluate(() => ({ ...window.__merge, conflicted: [...window.__merge.conflicted] }));

test('a conflicted merge opens the conflict editor and Commit merge writes every resolution', async ({ page }) => {
  const editor = await startConflictedMerge(page);
  await expect(editor.getByText('Merging feat/graph-search into main needs your help')).toBeVisible();
  await expect(page.getByText(/CONFLICT: merge has unresolved conflicts/)).toHaveCount(0);
  await expect(page.getByText('Merge stopped on conflicts in 2 files — resolve them below.')).toBeVisible();
  await expect(editor.getByText('0 of 2 files resolved')).toBeVisible();
  const files = editor.getByRole('navigation', { name: 'Conflicted files' });
  await expect(files.getByRole('button')).toHaveCount(2);
  const commit = editor.getByRole('button', { name: 'Commit merge' });
  await expect(commit).toBeDisabled();

  // notes.md comes first: main deleted it, the incoming branch changed it.
  await expect(editor.getByText('main deleted this file, but feat/graph-search changes it')).toBeVisible();
  await expect(editor.getByLabel('Remaining version')).toContainText('from the branch');
  await editor.getByRole('button', { name: "Take feat/graph-search's version" }).click();
  await expect(files.getByRole('button', { name: /notes\.md.*Resolved/ })).toBeVisible();

  await editor.getByRole('button', { name: 'Next file' }).click();
  const first = editor.getByRole('region', { name: 'Conflict 1 of 2' });
  await expect(first.getByText('Current — main (your branch)')).toBeVisible();
  await expect(first.getByText('Incoming — feat/graph-search (being merged)')).toBeVisible();
  await first.getByRole('button', { name: 'Accept incoming' }).click();
  await editor.getByRole('region', { name: 'Conflict 2 of 2' }).getByRole('button', { name: 'Accept current' }).click();
  await expect(editor.getByText('All files resolved')).toBeVisible();
  await editor.getByRole('button', { name: 'Edit whole file' }).click();
  await expect(editor.getByRole('textbox', { name: 'Result for src/app.ts' }))
    .toHaveValue('import { theme } from "./theme";\nconst color = "green";\nconst size = 10;\nexport const mode = "dark";\n');

  // Nothing is written until Commit merge.
  expect((await merge(page)).resolved).toEqual([]);
  await commit.click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('Merged feat/graph-search into main — conflicts resolved.')).toBeVisible();
  const state = await merge(page);
  expect(state.resolved).toEqual([
    { path: 'notes.md', side: 'theirs', content: null },
    { path: 'src/app.ts', side: null, content: 'import { theme } from "./theme";\nconst color = "green";\nconst size = 10;\nexport const mode = "dark";\n' },
  ]);
  expect(state.continued).toBe(true);
  const calls = await page.evaluate(() => window.testBackend.calls.map(({ cmd }) => cmd));
  expect(calls).not.toContain('stage_paths');
  expect(calls).not.toContain('write_worktree_file');
});

test('aborting from the conflict editor runs merge --abort and closes it', async ({ page }) => {
  const editor = await startConflictedMerge(page);
  await editor.getByRole('button', { name: "Take feat/graph-search's version" }).click();
  await editor.getByRole('button', { name: 'Abort', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('main goes back to how it was before the merge');
  await editor.getByRole('button', { name: 'Abort merge' }).click();
  await expect(editor).toHaveCount(0);
  const state = await merge(page);
  expect(state.aborted).toBe(true);
  expect(state.resolved).toEqual([]);
  await expect(page.getByText('Merge aborted — repository restored.')).toBeVisible();
});
