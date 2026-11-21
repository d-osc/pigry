import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so design files persist. */
async function installWorktree(page) {
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = new Map();
    window.__worktree = files;
    window.__binary = new Map();
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_file_tree') {
        const base = await invoke(cmd, args);
        return { ...base, entries: [...base.entries, ...files.keys()] };
      }
      if (cmd === 'read_worktree_file' && files.has(args.path)) {
        return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'json' };
      }
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
      if (cmd === 'write_worktree_binary') { window.__binary.set(args.path, args.data); return null; }
      if (cmd === 'delete_worktree_file') { files.delete(args.path); return null; }
      return invoke(cmd, args);
    };
  });
}

const layerCount = (page) => page.locator('[role="tree"] [role="treeitem"]').count();

test('Design editor: create, draw, style, layers, undo and per-agent files', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);

  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Design editor' })).toBeVisible();

  // Template creates the file in the user's own folder
  await page.getByRole('button', { name: /Mobile app/ }).click();
  await expect(page.locator('.dgn__svg')).toBeVisible();
  expect(await page.evaluate(() => [...window.__worktree.keys()])).toContain('.pigry/designs/user/mobile-app.design.json');
  await expect(page.getByRole('tree', { name: 'Layers' })).toContainText('Mobile — Home');
  const before = await layerCount(page);
  expect(before).toBeGreaterThan(8);

  // Select a layer from the panel and recolour it from the properties panel
  await page.locator('.dgn-layer__name', { hasText: 'Summary card' }).click();

  // The selected layer shows up in the chat composer; shift-click adds another; ✕ removes them
  const chips = page.locator('.ai-composer__sel-chip--layer');
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText('Summary card');
  await page.locator('.dgn-layer__name', { hasText: 'Greeting' }).click({ modifiers: ['Shift'] });
  await expect(chips).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove layer Summary card from chat' }).click();
  await expect(chips).toHaveCount(0);
  await page.locator('.dgn-layer__name', { hasText: 'Summary card' }).click();
  await expect(chips).toHaveCount(1);
  await page.getByRole('button', { name: 'Solid' }).click();
  await page.getByLabel('Fill value').fill('#ff0000');
  const fillOf = () => page.evaluate(() => {
    const file = JSON.parse(window.__worktree.get('.pigry/designs/user/mobile-app.design.json'));
    const find = (nodes) => { for (const n of nodes) { if (n.name === 'Summary card') return n; const r = find(n.children ?? []); if (r) return r; } };
    return find(file.nodes).fill;
  });
  await expect.poll(fillOf, { timeout: 6000 }).toBe('#ff0000');

  // Two undo steps (colour edit, then Gradient → Solid) restore the gradient; redo brings the colour back
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(fillOf, { timeout: 6000 }).toBe('$primary');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(fillOf, { timeout: 6000 }).toMatchObject({ from: '$primary', to: '$primary-dark' });
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(fillOf, { timeout: 6000 }).toBe('#ff0000');

  // Draw a rectangle with the R tool inside the frame
  const frame = page.locator('.dgn__svg [data-id]').first();
  const box = await frame.boundingBox();
  await page.getByRole('button', { name: 'Rectangle' }).click();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.9, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => layerCount(page)).toBe(before + 1);
  await expect(page.getByRole('spinbutton', { name: 'Width' })).not.toHaveValue('100');

  // Rename through the layers panel and hide/lock toggles
  await page.locator('.dgn-layer__name', { hasText: 'Rectangle' }).dblclick();
  await page.getByRole('textbox', { name: 'Layer name' }).fill('Promo banner');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tree', { name: 'Layers' })).toContainText('Promo banner');
  await page.getByRole('button', { name: 'Hide Promo banner' }).click({ force: true });
  await expect(page.getByRole('button', { name: 'Show Promo banner' })).toBeAttached();
  await page.getByRole('button', { name: 'Show Promo banner' }).click({ force: true });

  // Delete from the properties panel, then Undo brings it back
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => layerCount(page)).toBe(before);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => layerCount(page)).toBe(before + 1);

  expect(errors).toEqual([]);
});

test('Design agent tools: write in the agent folder, edit live, review, preview, export', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Design editor' })).toBeVisible();

  const result = await page.evaluate(async () => {
    const { DESIGN_TOOLS } = await import('/src/lib/designTools.ts');
    const { pendingImages } = await import('/src/lib/pendingImages.ts');
    const run = (name, input) => DESIGN_TOOLS.find((t) => t.name === name).run({ agent: 'uxui', ...input });
    const out = {};
    out.write = await run('design_write', {
      name: 'Login screen', title: 'Login', tokens: { colors: { primary: '#2563eb', text: '#111827' } },
      nodes: [{
        type: 'frame', name: 'Mobile — Login', w: 390, h: 700, fill: '#ffffff', layout: { dir: 'column', gap: 16, padding: 24, align: 'stretch', justify: 'center' },
        children: [
          { type: 'text', name: 'Title', text: 'Welcome back', fontSize: 28, fontWeight: 700, fill: '$text' },
          { type: 'text', name: 'Hint', text: 'tiny grey hint', fontSize: 9, fill: '#cccccc' },
          { type: 'frame', name: 'Email input', h: 48, radius: 10, stroke: '#d1d5db', layout: { dir: 'row', padding: [0, 12, 0, 12], align: 'center' }, children: [{ type: 'text', name: 'Placeholder', text: 'Email', fill: '#6b7280' }] },
          { type: 'frame', name: 'Sign in button', h: 30, radius: 8, fill: '$primary', layout: { dir: 'row', justify: 'center', align: 'center' }, children: [{ type: 'text', name: 'Label', text: 'Sign in', fill: '#ffffff', fontWeight: 600 }] },
        ],
      }],
    });
    out.again = await run('design_write', { name: 'login-screen', nodes: [{ type: 'frame' }] });
    out.foreign = await run('design_write', { name: 'sa/login-screen', nodes: [{ type: 'frame' }] });
    out.list = await run('design_list', {});
    out.read = await run('design_read', { name: 'login-screen', node: 'Sign in button' });
    out.edit = await run('design_edit', { name: 'login-screen', operations: [
      { op: 'update', id: 'Sign in button', h: 52 },
      { op: 'update', id: 'Hint', fontSize: 13, fill: '#4b5563' },
      { op: 'add', parent: 'Mobile — Login', node: { type: 'text', name: 'Footer', text: 'Forgot password?', fontSize: 14, fill: '$primary' } },
      { op: 'remove', id: 'ghost' },
    ] });
    out.check = await run('design_check', { name: 'login-screen', severity: 'warn' });
    out.preview = await run('design_preview', { name: 'login-screen', save_as: '.pigry/designs/uxui/login-preview.png' });
    out.attached = pendingImages.length;
    out.attachedIsPng = pendingImages[0]?.startsWith('data:image/png;base64,') ?? false;
    pendingImages.length = 0;
    out.svg = await run('design_export', { name: 'login-screen', format: 'svg' });
    out.png = await run('design_export', { name: 'login-screen', format: 'png', node: 'Mobile — Login' });
    out.html = await run('design_export', { name: 'login-screen', format: 'html' });
    out.badPath = await run('design_export', { name: 'login-screen', format: 'svg', path: 'docs/x.svg' });
    out.opened = await run('design_open', { name: 'login-screen', node: 'Sign in button' });
    out.files = [...window.__worktree.keys()];
    out.binary = [...window.__binary.keys()];
    out.html_content = window.__worktree.get('.pigry/designs/uxui/login-screen.html');
    return out;
  });

  expect(result.write).toContain('saved .pigry/designs/uxui/login-screen.design.json');
  expect(result.write).toMatch(/too small|below 44px|contrast/);
  expect(result.again).toContain('already exists');
  expect(result.foreign).toContain('your own folder');
  expect(result.list).toContain('uxui/login-screen');
  expect(result.read).toContain('Sign in button');
  expect(result.edit).toContain('✓ updated');
  expect(result.edit).toContain('Not applied');
  expect(result.check).not.toContain('too small');
  expect(result.preview).toContain('attached to your next turn');
  expect(result.attached).toBe(1);
  expect(result.attachedIsPng).toBe(true);
  expect(result.svg).toContain('.pigry/designs/uxui/login-screen.svg');
  expect(result.png).toContain('--mobile-login.png');
  expect(result.html).toContain('static HTML');
  expect(result.html_content).toContain('--primary: #2563eb');
  expect(result.badPath).toContain('inside .pigry/');
  expect(result.opened).toContain('selected');
  expect(result.files).toEqual(expect.arrayContaining(['.pigry/designs/uxui/login-screen.design.json', '.pigry/designs/uxui/login-screen.svg']));
  expect(result.binary).toEqual(expect.arrayContaining(['.pigry/designs/uxui/login-preview.png', '.pigry/designs/uxui/login-screen--mobile-login.png']));

  // The editor opened the agent's design, selected the node and shows who owns it
  await expect(page.getByRole('button', { name: 'login-screen', exact: true })).toBeVisible();
  await expect(page.locator('.dgn__owner', { hasText: 'uxui' })).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Layers' })).toContainText('Footer');
  await expect(page.getByRole('spinbutton', { name: 'Height' })).toHaveValue('52');
});

test('Base agent UX/UI Designer lives in the Design menu with the design tools and skills', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  const info = await page.evaluate(async () => {
    const { builtinAgents } = await import('/src/lib/agentExtras.ts');
    const { AGENT_TOOLS } = await import('/src/lib/agentTools.ts');
    const { BUILTIN_SKILLS } = await import('/src/lib/skills.ts');
    const agents = builtinAgents();
    return {
      uxui: agents.find((a) => a.username === 'uxui'),
      lead: agents.find((a) => a.username === 'design'),
      everyone: agents.filter((a) => a.team === 'Design').map((a) => a.username),
      tools: AGENT_TOOLS.filter((t) => t.group === 'Design').map((t) => t.name),
      skills: BUILTIN_SKILLS.map((s) => s.id).filter((id) => /^(design-editor|ui-design-system|ux-design-process)$/.test(id)),
    };
  });
  expect(info.uxui.team).toBe('Design');
  expect(info.uxui.tier).toBe('base');
  expect(info.uxui.name).toBe('UX/UI Designer');
  expect(info.uxui.tools).toEqual(expect.arrayContaining(['design_write', 'design_edit', 'design_preview', 'design_check', 'design_export', 'read_image']));
  expect(info.uxui.skills).toEqual(['ux-design-process', 'ui-design-system', 'design-editor']);
  expect(info.lead.tier).toBe('default');
  expect(info.everyone.sort()).toEqual(['design', 'uxui']);
  expect(info.tools).toHaveLength(8);
  expect(info.skills.sort()).toEqual(['design-editor', 'ui-design-system', 'ux-design-process']);
});
