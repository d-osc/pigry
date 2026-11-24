import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

const CODEX = {
  agent: 'codex', root: '~/.codex', found: true, skipped: ['skill lint: 1 supporting file(s) next to SKILL.md are not imported'],
  files: [
    { path: '.codex/AGENTS.md', text: 'Always use tabs.' },
    { path: '.codex/skills/lint/SKILL.md', text: '---\nname: lint\ndescription: Lints code\n---\n# Lint\nRun the linter.' },
    { path: '.codex/config.toml', text: '[mcp_servers.tools]\ncommand = "node"\nargs = ["srv.js"]\n[mcp_servers.tools.env]\nMODE = "dev"\nGITHUB_TOKEN = "ghp_secret"\n' },
    { path: '.codex/auth.json', text: '{"token":"must-never-be-imported"}' },
  ],
};

/** An in-memory worktree plus a scripted `agent_import_read`. */
async function setup(page) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await page.evaluate((codex) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = new Map();
    window.__worktree = files;
    window.__codex = codex;
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'agent_import_read') {
        if (args.agent === 'codex') return window.__codex;
        return { agent: args.agent, root: '~/.x', found: false, files: [], skipped: [] };
      }
      if (cmd === 'get_file_tree') { const base = await invoke(cmd, args); return { ...base, entries: [...base.entries, ...files.keys()] }; }
      if (cmd === 'read_worktree_file' && files.has(args.path)) return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'markdown' };
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
      return invoke(cmd, args);
    };
  }, CODEX);
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Import agents', exact: true }).click();
  await expect(page.getByTestId('import-agents')).toBeVisible();
}

const card = (page, name) => page.getByRole('region', { name });

test('preview lists what would be imported, leaves secrets out, and never reads credentials', async ({ page }) => {
  await setup(page);
  await card(page, 'Codex').getByRole('button', { name: 'Preview' }).click();
  const items = card(page, 'Codex').getByLabel('Codex items');
  await expect(items.locator('li')).toHaveCount(3);
  await expect(items).toContainText('codex-lint');
  await expect(items).toContainText('tools');
  await expect(items.locator('.imp__status--new')).toHaveCount(3);
  await expect(card(page, 'Codex')).toContainText('GITHUB_TOKEN');
  await expect(card(page, 'Codex')).toContainText('switched off');
  await expect(card(page, 'Codex')).not.toContainText('ghp_secret');
  await expect(card(page, 'Codex')).not.toContainText('must-never-be-imported');
  await card(page, 'Claude Code').getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('claude-code-missing')).toBeVisible();
  // nothing was written by previewing
  expect(await page.evaluate(() => [...window.__worktree.keys()])).toEqual([]);
});

test('import writes the skill, the instructions block and a switched-off MCP server; importing again changes nothing', async ({ page }) => {
  await setup(page);
  await card(page, 'Codex').getByRole('button', { name: 'Preview' }).click();
  await card(page, 'Codex').getByRole('button', { name: /^Import 3/ }).click();
  await expect(card(page, 'Codex').getByLabel('Import report')).toContainText('3 imported');
  const written = await page.evaluate(() => Object.fromEntries(window.__worktree));
  expect(written['.pigry/skills/codex-lint.md']).toContain('description: Lints code');
  expect(written['.pigry/skills/codex-lint.md']).toContain('Run the linter.');
  expect(written['.pigry/instructions.md']).toContain('<!-- pigry-import:codex:instructions:.codex/AGENTS.md -->');
  expect(written['.pigry/instructions.md']).toContain('Always use tabs.');
  const mcp = await page.evaluate(() => JSON.parse(localStorage.getItem('pigry:mcp-servers')));
  expect(mcp).toHaveLength(1);
  expect(mcp[0]).toMatchObject({ name: 'tools', command: 'node', args: 'srv.js', env: 'MODE=dev', enabled: false });
  expect(JSON.stringify(mcp)).not.toContain('ghp_secret');
  // preview again: everything is already imported, nothing left to do
  await expect(card(page, 'Codex').locator('.imp__status--same')).toHaveCount(3);
  await expect(card(page, 'Codex').getByRole('button', { name: /^Import/ })).toBeDisabled();
});

test('a copy you edited is kept; a changed source refreshes untouched copies; "replace" overwrites', async ({ page }) => {
  await setup(page);
  await card(page, 'Codex').getByRole('button', { name: 'Preview' }).click();
  await card(page, 'Codex').getByRole('button', { name: /^Import 3/ }).click();
  await expect(card(page, 'Codex').locator('.imp__status--same')).toHaveCount(3);
  // the source changes (AGENTS.md) and the user edits the imported skill
  await page.evaluate(() => {
    window.__codex = { ...window.__codex, files: window.__codex.files.map((f) => (f.path.endsWith('AGENTS.md') ? { ...f, text: 'Always use spaces.' } : f.path.endsWith('SKILL.md') ? { ...f, text: f.text.replace('Run the linter.', 'Run the NEW linter.') } : f)) };
    window.__worktree.set('.pigry/skills/codex-lint.md', 'my own lint skill');
  });
  await card(page, 'Codex').getByRole('button', { name: 'Refresh preview' }).click();
  const items = card(page, 'Codex').getByLabel('Codex items');
  await expect(items.locator('li', { hasText: 'AGENTS.md' }).locator('.imp__status--update')).toBeVisible();
  await expect(items.locator('li', { hasText: 'codex-lint' }).locator('.imp__status--conflict')).toBeVisible();
  await card(page, 'Codex').getByRole('button', { name: /^Import 1/ }).click();
  await expect.poll(() => page.evaluate(() => window.__worktree.get('.pigry/instructions.md'))).toContain('Always use spaces.');
  expect(await page.evaluate(() => window.__worktree.get('.pigry/skills/codex-lint.md'))).toBe('my own lint skill');
  expect(await page.evaluate(() => window.__worktree.get('.pigry/instructions.md'))).not.toContain('Always use tabs.');
  // replace existing: now the skill is overwritten
  await page.getByLabel('Replace items that already exist and differ').check();
  await card(page, 'Codex').getByRole('button', { name: /^Import 1/ }).click();
  await expect.poll(() => page.evaluate(() => window.__worktree.get('.pigry/skills/codex-lint.md'))).toContain('Run the NEW linter.');
});

test('Sync re-imports only the agents whose files changed', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: 'Sync changed sources' })).toBeDisabled(); // nothing imported yet
  await card(page, 'Codex').getByRole('button', { name: 'Preview' }).click();
  await card(page, 'Codex').getByRole('button', { name: /^Import 3/ }).click();
  await expect(card(page, 'Codex').locator('.imp__status--same')).toHaveCount(3);
  await page.getByRole('button', { name: 'Sync changed sources' }).click();
  await expect(page.getByText('Everything imported is up to date.')).toBeVisible();
  await page.evaluate(() => { window.__codex = { ...window.__codex, files: window.__codex.files.map((f) => (f.path.endsWith('AGENTS.md') ? { ...f, text: 'Tabs forever.' } : f)) }; });
  await page.getByRole('button', { name: 'Sync changed sources' }).click();
  await expect.poll(() => page.evaluate(() => window.__worktree.get('.pigry/instructions.md'))).toContain('Tabs forever.');
});
