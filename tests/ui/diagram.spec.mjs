import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so diagram files persist. */
async function installWorktree(page) {
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = new Map();
    window.__worktree = files;
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_file_tree') {
        const base = await invoke(cmd, args);
        return { ...base, entries: [...base.entries, ...files.keys()] };
      }
      if (cmd === 'read_worktree_file' && files.has(args.path)) {
        return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'json' };
      }
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
      if (cmd === 'delete_worktree_file') { files.delete(args.path); return null; }
      return invoke(cmd, args);
    };
  });
}

const nodeCount = (page) => page.locator('.dgm__svg [data-node]').count();
const edgeCount = (page) => page.locator('.dgm__svg [data-edge]').count();

test('Diagram editor: create, edit, connect, undo and agent tools update the same canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);

  // Menu + welcome state
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Diagram editor' })).toBeVisible();

  // Create from a template
  await page.getByRole('button', { name: /Flowchart/ }).click();
  await expect(page.locator('.dgm__svg')).toBeVisible();
  await expect.poll(() => nodeCount(page)).toBe(4);
  await expect.poll(() => edgeCount(page)).toBe(4);
  expect(await page.evaluate(() => [...window.__worktree.keys()])).toContain('.pigry/diagrams/user/flowchart.diagram.json');

  // The selected shape shows up as a chip in the chat composer; selecting an edge swaps it
  const chips = page.locator('.ai-composer__sel-chip--layer');
  await page.locator('.dgm__svg [data-node]').filter({ hasText: 'Start' }).first().click();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText('Start');
  await chips.first().getByRole('button').click();
  await expect(chips).toHaveCount(0);
  await page.locator('.dgm__svg [data-node]').filter({ hasText: 'Process step' }).first().click();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText('Process step');

  // Add a shape and name it inline
  await page.getByRole('button', { name: 'Add Process' }).click();
  await expect.poll(() => nodeCount(page)).toBe(5);
  const label = page.getByRole('textbox', { name: 'Edit label' });
  await expect(label).toBeVisible();
  await label.fill('Check stock');
  await label.press('Enter');
  await expect(page.locator('.dgm__svg')).toContainText('Check stock');

  // Connect it to an existing node by dragging the blue handle
  const target = page.locator('.dgm__svg [data-node]').filter({ hasText: 'Start' }).first();
  await page.locator('.dgm__svg [data-node]').filter({ hasText: 'Check stock' }).click();
  const handle = page.locator('.dgm__svg [data-handle="connect"]');
  await expect(handle).toBeVisible();
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => edgeCount(page)).toBe(5);

  // Undo removes the connection again, redo restores it
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => edgeCount(page)).toBe(4);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(() => edgeCount(page)).toBe(5);

  // Autosave reaches the file
  const savedFile = () => page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/diagrams/user/flowchart.diagram.json')));
  await expect.poll(async () => (await savedFile()).edges.length, { timeout: 6000 }).toBe(5);
  expect((await savedFile()).nodes.some((n) => n.label === 'Check stock')).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  // An agent tool edits the same file: the open canvas refreshes
  await page.evaluate(async () => {
    const { DIAGRAM_TOOLS } = await import('/src/lib/diagramTools.ts');
    const tool = (name) => DIAGRAM_TOOLS.find((t) => t.name === name);
    window.__tools = (name) => ({ run: (input) => tool(name).run({ agent: 'sa', ...input }) });
    window.__editResult = await window.__tools('diagram_edit').run({
      name: 'user/flowchart',
      operations: [{ op: 'add_node', id: 'audit', label: 'Write audit log' }, { op: 'add_edge', from: 'Done?', to: 'audit', label: 'log' }, { op: 'remove_node', id: 'ghost' }],
    });
  });
  const editResult = await page.evaluate(() => window.__editResult);
  expect(editResult).toContain('added process audit');
  expect(editResult).toContain('Not applied');
  await expect.poll(() => nodeCount(page)).toBe(6);
  await expect(page.locator('.dgm__svg')).toContainText('Write audit log');

  // diagram_write creates a second diagram, refuses to clobber, and diagram_open shows it
  const written = await page.evaluate(async () => {
    const write = window.__tools('diagram_write');
    const first = await write.run({
      name: 'Shop ERD', type: 'erd', direction: 'LR',
      nodes: [{ id: 'user', label: 'User', fields: ['id PK', 'email'] }, { id: 'order', label: 'Order', fields: ['id PK', 'user_id FK'] }],
      edges: [{ from: 'user', to: 'order', label: 'places', fromLabel: '1', toLabel: 'N' }],
    });
    const again = await write.run({ name: 'shop-erd', nodes: [{ label: 'x' }] });
    const opened = await window.__tools('diagram_open').run({ name: 'shop-erd' });
    return { first, again, opened };
  });
  expect(written.first).toContain('saved .pigry/diagrams/sa/shop-erd.diagram.json');
  expect(written.again).toContain('already exists');
  expect(written.opened).toContain('opened');
  await expect(page.getByRole('button', { name: 'shop-erd', exact: true })).toBeVisible();
  await expect(page.locator('.dgm__owner', { hasText: 'sa' })).toBeVisible();
  await expect.poll(() => nodeCount(page)).toBe(2);
  await expect(page.locator('.dgm__svg')).toContainText('user_id');

  // Export tools
  const exported = await page.evaluate(async () => {
    const svg = await window.__tools('diagram_export').run({ name: 'shop-erd', format: 'svg' });
    const mermaid = await window.__tools('diagram_export').run({ name: 'shop-erd', format: 'mermaid' });
    const bad = await window.__tools('diagram_export').run({ name: 'shop-erd', format: 'svg', path: '../evil.svg' });
    const outside = await window.__tools('diagram_export').run({ name: 'shop-erd', format: 'svg', path: 'docs/shop.svg' });
    const inside = await window.__tools('diagram_export').run({ name: 'shop-erd', format: 'svg', path: '.pigry/reports/sa/shop.svg' });
    return { svg, mermaid, bad, outside, inside, file: window.__worktree.get('.pigry/diagrams/sa/shop-erd.svg') };
  });
  expect(exported.svg).toContain('saved .pigry/diagrams/sa/shop-erd.svg');
  expect(exported.file).toMatch(/^<svg /);
  expect(exported.mermaid).toContain('erDiagram');
  expect(exported.bad).toContain('error');
  expect(exported.outside).toContain('inside .pigry/');
  expect(exported.inside).toContain('saved .pigry/reports/sa/shop.svg');
});

test('SA is a base agent in Explorer, Diagram and Copilot and the Diagram agents get the diagram tools', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  const info = await page.evaluate(async () => {
    const { builtinAgents } = await import('/src/lib/agentExtras.ts');
    const { AGENT_TOOLS } = await import('/src/lib/agentTools.ts');
    const { BUILTIN_SKILLS } = await import('/src/lib/skills.ts');
    const agents = builtinAgents();
    const sa = agents.filter((a) => /(^|-)sa$/.test(a.username)).map((a) => ({ u: a.username, team: a.team, tier: a.tier, tools: a.tools, skills: a.skills }));
    const diagramAgent = agents.find((a) => a.username === 'diagram');
    return {
      sa, diagramAgent,
      tools: AGENT_TOOLS.filter((t) => t.group === 'Diagram').map((t) => t.name),
      skills: BUILTIN_SKILLS.map((s) => s.id).filter((id) => /diagram|system-analysis/.test(id)),
    };
  });
  expect(info.sa.map((a) => `${a.team}:${a.u}`).sort()).toEqual(['Board:board-sa', 'Copilot:copilot-sa', 'Diagram:diagram-sa', 'Explorer:sa']);
  for (const agent of info.sa) {
    expect(agent.tier).toBe('base');
    expect(agent.tools).toEqual(expect.arrayContaining(['diagram_write', 'diagram_edit', 'diagram_read', 'diagram_export', 'diagram_open', 'diagram_list']));
    expect(agent.skills).toEqual(expect.arrayContaining(['system-analysis', 'diagram-modeling', 'diagram-editor']));
  }
  expect(info.diagramAgent.team).toBe('Diagram');
  expect(info.tools).toHaveLength(6);
  expect(info.skills.sort()).toEqual(['diagram-editor', 'diagram-modeling', 'system-analysis']);
});
