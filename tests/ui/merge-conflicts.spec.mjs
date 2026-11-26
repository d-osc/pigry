import { expect, test } from '@playwright/test';
import { installBackend } from './backend.mjs';

const APP = ['import { theme } from "./theme";', '<<<<<<< HEAD', 'const color = "red";', '=======', 'const color = "green";', '>>>>>>> feature/green', 'const size = 10;', '<<<<<<< HEAD', 'export default color;', '=======', 'export default color;', '>>>>>>> feature/green', ''].join('\n');
const STYLES = ['body {', '<<<<<<< HEAD', '  margin: 0;', '||||||| base', '  margin: 4px;', '=======', '  margin: 4px;', '  padding: 8px;', '>>>>>>> feature/green', '}', ''].join('\n');

/** A repository that stopped in the middle of an operation with two conflicted files. */
async function installConflicts(page, operation = 'merge') {
  await page.addInitScript(({ files, operation }) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const sim = { files: new Map(Object.entries(files)), conflicted: new Set(Object.keys(files)), staged: new Set(), operation, writes: [], continued: false, aborted: false };
    window.__conflicts = sim;
    const patch = (payload) => {
      if (!payload?.repository) return payload;
      const rows = [...sim.conflicted].map((path) => ({ id: `${path}:conflicted`, path, name: path.split('/').pop(), directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', status: 'C', additions: 0, deletions: 0, staged: false, untracked: false }));
      const staged = [...sim.staged].map((path) => ({ id: `${path}:staged`, path, name: path.split('/').pop(), directory: '', status: 'M', additions: 1, deletions: 1, staged: true, untracked: false }));
      return { ...payload, repository: { ...payload.repository, files: [...rows, ...staged] } };
    };
    const state = () => ({
      operation: sim.operation, branch: 'main', currentLabel: 'your branch (main)', incomingLabel: "Merge branch 'feature/green'", incomingCommit: 'a1b2c3d Make it green',
      conflicted: [...sim.conflicted].sort(), step: sim.operation === 'rebase' ? [2, 5] : null,
    });
    bridge.invoke = async (cmd, args = {}) => {
      switch (cmd) {
        case 'conflict_state': return state();
        case 'conflict_versions':
          if (!sim.conflicted.has(args.path)) throw `${args.path} is not conflicted`;
          return { base: 'BASE\n', current: `CURRENT VERSION OF ${args.path}\n`, incoming: `INCOMING VERSION OF ${args.path}\n`, binary: false };
        case 'read_worktree_file':
          if (sim.files.has(args.path)) return { path: args.path, content: sim.files.get(args.path), binary: false, tooLarge: false, language: 'plaintext' };
          break;
        case 'write_worktree_file':
          if (sim.files.has(args.path)) { sim.files.set(args.path, args.content); sim.writes.push(args.path); return null; }
          break;
        case 'stage_paths': {
          for (const p of args.paths) { sim.conflicted.delete(p); sim.staged.add(p); }
          return patch(await invoke('refresh', {}));
        }
        case 'conflict_continue':
          if (sim.conflicted.size) throw `${sim.conflicted.size} file(s) are still conflicted`;
          sim.continued = true; sim.operation = null; sim.staged.clear();
          return patch(await invoke('refresh', {}));
        case 'conflict_abort':
          sim.aborted = true; sim.operation = null; sim.conflicted.clear(); sim.staged.clear();
          return patch(await invoke('refresh', {}));
        default: break;
      }
      const result = await invoke(cmd, args);
      return ['get_app_state', 'open_repository', 'pick_repository', 'refresh'].includes(cmd) ? patch(result) : result;
    };
  }, { files: { 'src/app.ts': APP, 'src/styles.css': STYLES }, operation });
}

async function setup(page, operation) {
  await page.setViewportSize({ width: 1600, height: 950 });
  await installBackend(page);
  await installConflicts(page, operation);
  await page.goto('/');
  await page.locator('.home__recent-item').first().click();
}

const nav = (page) => page.locator('.nav-sidebar');
const open = async (page) => {
  await nav(page).getByRole('button', { name: /^Merge conflicts/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Merge conflicts', exact: true })).toBeVisible();
};
const sim = (page) => page.evaluate(() => ({ ...window.__conflicts, files: Object.fromEntries(window.__conflicts.files), conflicted: [...window.__conflicts.conflicted], staged: [...window.__conflicts.staged] }));
const card = (page, n) => page.getByRole('region', { name: new RegExp(`^Conflict ${n} of`) });

test('the menu sits in Workspace with a badge for conflicted files and explains the operation', async ({ page }) => {
  await setup(page);
  const item = nav(page).locator('.nav-sidebar__workspace').first().getByRole('button', { name: /^Merge conflicts/ });
  await expect(item).toBeVisible();
  await expect(item.locator('.nav-item__badge')).toHaveText('2');
  await open(page);
  const banner = page.getByRole('region', { name: 'Operation in progress' });
  await expect(banner).toContainText('Merging into main');
  await expect(banner).toContainText("Merge branch 'feature/green'");
  await expect(banner).toContainText('2 of 2 files left');
  await expect(banner.getByRole('button', { name: 'Commit merge' })).toBeDisabled();
  const files = page.getByRole('navigation', { name: 'Conflicted files' });
  await expect(files.getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('complementary', { name: 'How conflicts work' })).toContainText('<<<<<<< HEAD');
});

test('each conflict is a card with both sides; choices rebuild the file and Save & mark resolved stages it', async ({ page }) => {
  await setup(page);
  await open(page);
  await page.getByRole('navigation', { name: 'Conflicted files' }).getByRole('button', { name: /app\.ts/ }).click();
  await expect(page.getByLabel('Conflicts resolved in this file')).toHaveText('0 of 2 resolved');
  const first = card(page, 1);
  await expect(first).toContainText('Current — your branch');
  await expect(first).toContainText('const color = "red";');
  await expect(first).toContainText('Incoming — their change');
  await expect(first).toContainText('const color = "green";');
  await expect(first).toContainText('import { theme }'); // context line
  // the second block is the same on both sides: a suggestion is offered
  await expect(card(page, 2)).toContainText('Both sides made the same change');
  const save = page.getByRole('button', { name: /Save & mark resolved/ });
  await expect(save).toBeDisabled();

  await first.getByRole('button', { name: 'Accept incoming' }).click();
  await expect(first).toContainText('Incoming'); // result chip
  await page.getByRole('button', { name: /Apply 1 safe suggestion/ }).click();
  await expect(page.getByLabel('Conflicts resolved in this file')).toHaveText('2 of 2 resolved');

  await page.getByRole('button', { name: 'Preview result' }).click();
  await expect(page.getByLabel('Result preview')).toContainText('const color = "green";');
  await expect(page.getByLabel('Result preview')).not.toContainText('<<<<<<<');
  await page.getByRole('button', { name: 'Preview result' }).click();

  await save.click();
  await expect.poll(async () => (await sim(page)).staged).toEqual(['src/app.ts']);
  const s = await sim(page);
  expect(s.files['src/app.ts']).toBe('import { theme } from "./theme";\nconst color = "green";\nconst size = 10;\nexport default color;\n');
  await expect(page.getByRole('region', { name: 'Operation in progress' })).toContainText('1 of 2 files left');
  await expect(nav(page).getByRole('button', { name: /^Merge conflicts/ }).first().locator('.nav-item__badge')).toHaveText('1');
  await expect(page.getByRole('navigation', { name: 'Conflicted files' })).toContainText('Resolved');
});

test('keep both, edit by hand, the common ancestor, undo and keyboard choices', async ({ page }) => {
  await setup(page);
  await open(page);
  await page.getByRole('navigation', { name: 'Conflicted files' }).getByRole('button', { name: /styles\.css/ }).click();
  const c = card(page, 1);
  await c.getByRole('button', { name: /Common ancestor/ }).click();
  await expect(c).toContainText('margin: 4px;');
  await c.getByRole('button', { name: 'More ways to keep both' }).click();
  await c.getByRole('menuitem', { name: 'Both — incoming first' }).click();
  await expect(c).toContainText('Both (incoming first)');
  await c.getByRole('button', { name: 'Change' }).click();
  await c.getByRole('button', { name: 'Edit', exact: true }).click();
  await c.getByLabel('Edited result for conflict 1').fill('  margin: 0;\n  padding: 8px;');
  await c.getByRole('button', { name: 'Use this text' }).click();
  await expect(c).toContainText('Edited');
  await c.getByRole('button', { name: 'Change' }).click();
  // keys: 1 = current
  await c.click({ position: { x: 20, y: 10 } });
  await page.keyboard.press('1');
  await expect(c.locator('.mc-chip--ok')).toHaveText('Current');
  await page.getByRole('button', { name: /Save & mark resolved/ }).click();
  await expect.poll(async () => (await sim(page)).files['src/styles.css']).toBe('body {\n  margin: 0;\n}\n');
});

test('when every file is resolved the operation can be finished; abort asks first', async ({ page }) => {
  await setup(page);
  await open(page);
  // whole-file choice resolves the first file straight away
  await page.getByRole('button', { name: 'keep incoming version' }).click();
  await expect(page.getByRole('region', { name: 'Operation in progress' })).toContainText('1 of 2 files left');
  await page.getByRole('button', { name: 'keep current version' }).click();
  await expect(page.getByRole('region', { name: 'Operation in progress' })).toContainText('All files resolved');
  const s = await sim(page);
  expect(s.files['src/app.ts']).toBe('INCOMING VERSION OF src/app.ts\n');
  expect(s.files['src/styles.css']).toBe('CURRENT VERSION OF src/styles.css\n');
  await page.getByRole('button', { name: 'Commit merge' }).click();
  await expect.poll(async () => (await sim(page)).continued).toBe(true);
  await expect(page.getByRole('heading', { name: 'No conflicts' })).toBeVisible();
});

test('abort is confirmed before the operation is thrown away', async ({ page }) => {
  await setup(page, 'rebase');
  await open(page);
  const banner = page.getByRole('region', { name: 'Operation in progress' });
  await expect(banner).toContainText('Rebasing main — step 2 of 5');
  await expect(banner).toContainText('"Current" is the new base');
  await expect(card(page, 1)).toContainText('Current — the new base');
  await expect(card(page, 1)).toContainText('Incoming — your commit');
  await banner.getByRole('button', { name: 'Abort rebase' }).click();
  await expect(banner.getByRole('alert')).toContainText('Abort the rebase?');
  await banner.getByRole('button', { name: 'Keep going' }).click();
  expect((await sim(page)).aborted).toBe(false);
  await banner.getByRole('button', { name: 'Abort rebase' }).click();
  await banner.getByRole('alert').getByRole('button', { name: 'Abort rebase' }).click();
  await expect.poll(async () => (await sim(page)).aborted).toBe(true);
  await expect(page.getByRole('heading', { name: 'No conflicts' })).toBeVisible();
});

test('the agent tools list, read and resolve conflicts', async ({ page }) => {
  await setup(page);
  const out = await page.evaluate(async () => {
    const { WORKSPACE_AGENT_TOOLS } = await import('/src/lib/workspaceAgentTools.ts');
    const run = (name, input) => WORKSPACE_AGENT_TOOLS.find((t) => t.name === name).run(input);
    const list = JSON.parse(await run('conflict_list', {}));
    const read = JSON.parse(await run('conflict_read', { path: 'src/app.ts' }));
    let bad = '';
    try { await run('conflict_resolve', { path: 'src/app.ts', resolutions: [{ conflict: 9, take: 'current' }] }); } catch (e) { bad = String(e); }
    const partial = JSON.parse(await run('conflict_resolve', { path: 'src/app.ts', resolutions: [{ conflict: 1, take: 'incoming' }], stage: true }));
    const done = JSON.parse(await run('conflict_resolve', { path: 'src/app.ts', resolutions: [{ conflict: 1, take: 'custom', text: 'const color = "teal";' }], stage: true }));
    return { list, read, bad, partial, done, file: window.__conflicts.files.get('src/app.ts'), staged: [...window.__conflicts.staged] };
  });
  expect(out.list.operation).toBe('merge');
  expect(out.list.conflicted).toEqual(['src/app.ts', 'src/styles.css']);
  expect(out.read.conflicts).toHaveLength(2);
  expect(out.read.conflicts[0].current).toBe('const color = "red";');
  expect(out.read.conflicts[1].suggestion.take).toBe('current');
  expect(out.bad).toContain('conflict 9 does not exist');
  expect(out.partial.left).toBe(1);
  expect(out.partial.staged).toBe(false);
  expect(out.done.staged).toBe(true);
  expect(out.file).toContain('const color = "teal";');
  expect(out.file).not.toContain('<<<<<<<');
  expect(out.staged).toEqual(['src/app.ts']);
});

test('without conflicts the menu explains when it is used', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installBackend(page, { clean: true });
  await page.goto('/');
  await page.locator('.home__recent-item').first().click();
  await open(page);
  await expect(page.getByRole('heading', { name: 'No conflicts' })).toBeVisible();
  await expect(page.getByText(/Conflicts appear when a merge, rebase/)).toBeVisible();
  await expect(nav(page).getByRole('button', { name: /^Merge conflicts/ }).first().locator('.nav-item__badge')).toHaveCount(0);
});
