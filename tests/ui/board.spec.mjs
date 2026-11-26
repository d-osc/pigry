import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so board files persist. */
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
      if (cmd === 'read_binary_file' && window.__binary.has(args.path)) { const data = window.__binary.get(args.path); return { data, mime: 'image/png', size: atob(data).length }; }
      if (cmd === 'delete_worktree_file') { files.delete(args.path); window.__binary.delete(args.path); return null; }
      return invoke(cmd, args);
    };
  });
}

const FILE = '.pigry/boards/user/retrospective.board.json';
const saved = (page) => page.evaluate((path) => JSON.parse(window.__worktree.get(path)), FILE);
const cards = (page, text) => page.locator('.brd__svg [data-id]').filter({ hasText: text });

test('Board editor: template, sticky, chat chips, move a section, vote, connect and undo', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);

  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Board editor' })).toBeVisible();
  await page.getByRole('button', { name: /Retrospective/ }).click();
  await expect(page.locator('.brd__svg')).toBeVisible();
  await expect.poll(async () => (await saved(page)).items.length).toBe(6);
  const start = await saved(page);
  expect(start.items.filter((i) => i.type === 'section').map((i) => i.text)).toEqual(['Went well', 'To improve', 'Action items']);
  await expect(page.getByRole('tree', { name: 'Board items' })).toContainText('Add what went well');

  // Add a sticky with the S tool, type into it, commit with Escape
  await page.locator('.brd__svg').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('s');
  const stage = await page.locator('.brd__stage').boundingBox();
  await page.mouse.click(stage.x + stage.width - 160, stage.y + stage.height - 160);
  const editor = page.getByRole('textbox', { name: 'Edit text' });
  await expect(editor).toBeVisible();
  await editor.fill('Ship the board editor');
  await page.keyboard.press('Escape');
  await expect(cards(page, 'Ship the')).toHaveCount(1);
  await expect.poll(async () => (await saved(page)).items.some((i) => i.text === 'Ship the board editor')).toBe(true);

  // The selected item is shown in the chat composer
  const chips = page.locator('.ai-composer__sel-chip--layer');
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText('Ship the board editor');
  await page.locator('.brd-row__text', { hasText: 'Add what to improve' }).click();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText('Add what to improve');
  await page.locator('.brd-row__text', { hasText: 'Add what went well' }).click({ modifiers: ['Shift'] });
  await expect(chips).toHaveCount(2);
  await chips.first().getByRole('button').click();
  await expect(chips).toHaveCount(0);

  // Outline search
  await page.getByRole('textbox', { name: 'Search notes' }).fill('ship');
  await expect(page.getByRole('tree', { name: 'Board items' })).toContainText('Ship the board editor');
  await expect(page.getByRole('tree', { name: 'Board items' })).not.toContainText('Add what to improve');
  await page.getByRole('textbox', { name: 'Search notes' }).fill('');

  // Moving a section moves its notes along
  const before = await saved(page);
  const section = before.items.find((i) => i.text === 'Went well');
  const note = before.items.find((i) => i.parent === section.id);
  const header = cards(page, 'Went well').first();
  const hb = await header.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 12);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + 12 + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await saved(page)).items.find((i) => i.id === note.id).x).toBeGreaterThan(note.x + 50);
  const after = await saved(page);
  expect(after.items.find((i) => i.id === section.id).x).toBeGreaterThan(section.x + 50);

  // Vote on the selected sticky from the properties panel, then take it back
  await page.locator('.brd-row__text', { hasText: 'Add what went well' }).click();
  await page.getByRole('button', { name: 'Vote', exact: true }).click();
  await expect.poll(async () => (await saved(page)).items.find((i) => i.id === note.id).votes).toEqual(['you']);
  await page.getByRole('button', { name: 'Remove my vote' }).click();
  await expect.poll(async () => (await saved(page)).items.find((i) => i.id === note.id).votes).toBeUndefined();

  // Connector tool: drag from one note to another
  await page.locator('.brd__svg').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('c');
  const a = await cards(page, 'Add what to').first().boundingBox();
  const b = await cards(page, 'Who will').first().boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await saved(page)).items.filter((i) => i.type === 'connector').length).toBe(1);

  // Undo removes it again
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await saved(page)).items.filter((i) => i.type === 'connector').length).toBe(0);
  expect(errors).toEqual([]);
});

test('Board agent tools: write in the agent folder, edit live, preview, export, open', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Board editor' })).toBeVisible();

  const result = await page.evaluate(async () => {
    const { BOARD_TOOLS } = await import('/src/extensions/board/boardTools.ts');
    const { takeImages } = await import('/src/lib/pendingImages.ts');
    const run = (name, input) => BOARD_TOOLS.find((t) => t.name === name).run({ agent: 'sa', ...input });
    const out = {};
    out.write = await run('board_write', {
      name: 'Checkout retro', title: 'Checkout retro',
      items: [
        { type: 'text', text: 'Checkout redesign — retro', fontSize: 28, bold: true, x: 0, y: -80 },
        { type: 'section', text: 'Went well', color: 'green', notes: ['Fast payment', 'Clear errors', { text: 'Guest checkout', votes: 3 }] },
        { type: 'section', text: 'To improve', color: 'orange', notes: ['Slow address lookup', 'Coupons confusing'] },
        { type: 'connector', from: 'Slow address lookup', to: 'Coupons confusing', text: 'related', route: 'elbow' },
      ],
    });
    out.again = await run('board_write', { name: 'checkout-retro', items: [{ text: 'x' }] });
    out.foreign = await run('board_write', { name: 'user/checkout-retro', items: [{ text: 'x' }] });
    out.list = await run('board_list', {});
    out.read = await run('board_read', { name: 'checkout-retro' });
    out.edit = await run('board_edit', { name: 'checkout-retro', operations: [
      { op: 'add', section: 'To improve', text: 'Too many form fields', color: 'red' },
      { op: 'vote', id: 'Slow address lookup', by: 'ann' },
      { op: 'group', ids: ['Fast payment', 'Clear errors'], section: 'Highlights', color: 'purple' },
      { op: 'remove', id: 'ghost' },
    ] });
    out.md = await run('board_export', { name: 'checkout-retro', format: 'markdown' });
    out.svg = await run('board_export', { name: 'checkout-retro', format: 'svg' });
    out.png = await run('board_export', { name: 'checkout-retro', format: 'png' });
    out.bad = await run('board_export', { name: 'checkout-retro', format: 'svg', path: 'docs/x.svg' });
    out.preview = await run('board_preview', { name: 'checkout-retro', save_as: '.pigry/boards/sa/preview.png' });
    const attachedImages = takeImages('sa');
    out.attached = attachedImages.length;
    out.attachedIsPng = attachedImages[0]?.startsWith('data:image/png;base64,') ?? false;
    out.opened = await run('board_open', { name: 'checkout-retro', item: 'Guest checkout' });
    out.files = [...window.__worktree.keys()];
    out.binary = [...window.__binary.keys()];
    out.mdFile = window.__worktree.get('.pigry/boards/sa/checkout-retro.md');
    return out;
  });

  expect(result.write).toContain('saved .pigry/boards/sa/checkout-retro.board.json');
  expect(result.write).toContain('Section s');
  expect(result.again).toContain('already exists');
  expect(result.foreign).toContain('your own folder');
  expect(result.list).toContain('sa/checkout-retro');
  expect(result.read).toContain('"Guest checkout" · 3 votes');
  expect(result.read).toContain('by sa');
  expect(result.edit).toContain('✓ added sticky');
  expect(result.edit).toContain('Not applied');
  expect(result.md).toContain('## Went well');
  expect(result.md).toContain('(3 votes)');
  expect(result.svg).toContain('.pigry/boards/sa/checkout-retro.svg');
  expect(result.png).toContain('checkout-retro.png');
  expect(result.bad).toContain('inside .pigry/');
  expect(result.preview).toContain('attached to your next turn');
  expect(result.attached).toBe(1);
  expect(result.attachedIsPng).toBe(true);
  expect(result.opened).toContain('selected');
  expect(result.files).toEqual(expect.arrayContaining(['.pigry/boards/sa/checkout-retro.board.json', '.pigry/boards/sa/checkout-retro.svg']));
  expect(result.binary).toEqual(expect.arrayContaining(['.pigry/boards/sa/preview.png', '.pigry/boards/sa/checkout-retro.png']));
  expect(result.mdFile).toContain('## Highlights');

  // The editor opened the agent's board, selected the note, shows the owner and the chat chip
  await expect(page.getByRole('button', { name: 'checkout-retro', exact: true })).toBeVisible();
  await expect(page.locator('.brd__owner', { hasText: 'sa' })).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Board items' })).toContainText('Too many form fields');
  await expect(page.locator('.ai-composer__sel-chip--layer')).toContainText('Guest checkout');
  await expect(page.locator('.brd__svg')).toContainText('Highlights');
});

test('Board selection is sent to the model and shown in the sent message', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pigry:ai-providers', JSON.stringify([{
      id: 'fixture', name: 'Fixture', type: 'custom', apiFormat: 'openai',
      baseUrl: 'https://fixture.invalid/v1/chat/completions', apiKey: 'fixture',
      enabled: true, model: 'fixture-model', models: [{ id: 'fixture-model', name: 'fixture-model', enabled: true }],
    }]));
  });
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__bodies = [];
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'ai_chat' && !args.body.includes('[session-end task]')) {
        window.__bodies.push(args.body);
        const result = await invoke(cmd, args);
        return { ...result, body: JSON.stringify({ choices: [{ message: { content: 'Done.' } }] }) };
      }
      return invoke(cmd, args);
    };
  });
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: /Brainstorm/ }).click();
  await page.locator('.brd-row__text', { hasText: 'Idea 2' }).click();
  const composer = page.getByRole('textbox', { name: 'Ask AI' });
  await composer.fill('turn this into a user story');
  await composer.press('Enter');
  await expect(page.getByText('Done.')).toBeVisible();
  const body = await page.evaluate(() => window.__bodies.join('\n'));
  expect(body).toContain('Selected board items');
  expect(body).toContain('Idea 2');
  expect(body).toMatch(/Edit them with board_edit/);
  await expect(page.locator('.explorer-ai__msg-layers')).toContainText('Idea 2');
});

test('Base agent SA lives in the Board menu with the board tools and skills', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  const info = await page.evaluate(async () => {
    const { builtinAgents } = await import('/src/lib/agentExtras.ts');
    const { AGENT_TOOLS } = await import('/src/lib/agentTools.ts');
    const { BUILTIN_SKILLS } = await import('/src/lib/skills.ts');
    const agents = builtinAgents();
    return {
      sa: agents.find((a) => a.username === 'board-sa'),
      lead: agents.find((a) => a.username === 'board'),
      explorerSa: agents.find((a) => a.username === 'sa'),
      everyone: agents.filter((a) => a.team === 'Board').map((a) => a.username),
      tools: AGENT_TOOLS.filter((t) => t.group === 'Board').map((t) => t.name),
      skills: BUILTIN_SKILLS.map((s) => s.id).filter((id) => /^(board-editor|workshop-facilitation|discovery-mapping)$/.test(id)),
    };
  });
  expect(info.sa.team).toBe('Board');
  expect(info.sa.tier).toBe('base');
  expect(info.sa.name).toBe('SA');
  expect(info.sa.tools).toEqual(expect.arrayContaining(['board_write', 'board_edit', 'board_preview', 'board_export', 'diagram_write']));
  expect(info.sa.skills).toEqual(expect.arrayContaining(['workshop-facilitation', 'discovery-mapping', 'board-editor']));
  expect(info.explorerSa.tools).toContain('board_write');
  expect(info.lead.tier).toBe('default');
  expect(info.everyone.sort()).toEqual(['board', 'board-sa']);
  expect(info.tools).toHaveLength(7);
  expect(info.skills.sort()).toEqual(['board-editor', 'discovery-mapping', 'workshop-facilitation']);
});

test('Board embeds diagrams and designs, keeps them live, and opens the source', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);

  // A diagram (by SA) and a design (by UX/UI) that the board will show
  await page.evaluate(async () => {
    const { DIAGRAM_TOOLS } = await import('/src/extensions/diagram/diagramTools.ts');
    const { DESIGN_TOOLS } = await import('/src/extensions/design/designTools.ts');
    await DIAGRAM_TOOLS.find((t) => t.name === 'diagram_write').run({
      agent: 'sa', name: 'login-flow', title: 'Login flow', type: 'flowchart',
      nodes: [{ id: 'start', kind: 'terminator', label: 'Start' }, { id: 'form', label: 'Show form' }, { id: 'end', kind: 'terminator', label: 'End' }],
      edges: [{ from: 'start', to: 'form' }, { from: 'form', to: 'end' }],
    });
    await DESIGN_TOOLS.find((t) => t.name === 'design_write').run({
      agent: 'uxui', name: 'home', title: 'Home',
      nodes: [{ type: 'frame', name: 'Mobile — Home', w: 390, h: 500, layout: { dir: 'column', gap: 12, padding: 24 }, children: [{ type: 'text', name: 'Headline', text: 'Welcome home', fontSize: 28, fontWeight: 700 }] }],
    });
  });

  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: /Blank/ }).click();
  await expect(page.locator('.brd__svg')).toBeVisible();

  // Embed the diagram from the toolbar picker
  await page.getByRole('button', { name: 'Embed diagram or design' }).click();
  await expect(page.getByRole('menu', { name: 'Embed' })).toContainText('sa/login-flow');
  await page.getByRole('menuitem', { name: 'sa/login-flow' }).click();
  const embedded = page.locator('.brd__svg [data-id]').filter({ hasText: 'DIAGRAM' });
  await expect(embedded).toHaveCount(1);
  await expect(embedded.locator('svg')).toContainText('Show form');
  await expect(page.locator('.ai-composer__sel-chip--layer')).toContainText('Login flow');

  // Embed one frame of the design
  await page.getByRole('button', { name: 'Embed diagram or design' }).click();
  await page.getByRole('menuitem', { name: /Mobile — Home/ }).click();
  const design = page.locator('.brd__svg [data-id]').filter({ hasText: 'DESIGN' });
  await expect(design).toHaveCount(1);
  await expect(design.locator('svg')).toContainText('Welcome home');
  const file = () => page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/boards/user/blank.board.json')));
  await expect.poll(async () => (await file()).items.filter((i) => i.type === 'embed').map((i) => i.embed.kind).sort()).toEqual(['design', 'diagram']);
  const saved = (await file()).items.find((i) => i.embed?.kind === 'design');
  expect(saved.embed.ref).toBe('uxui/home');
  expect(saved.embed.node).toBeTruthy();

  // The embed stays live: editing the diagram redraws it on the board
  await page.evaluate(async () => {
    const { DIAGRAM_TOOLS } = await import('/src/extensions/diagram/diagramTools.ts');
    await DIAGRAM_TOOLS.find((t) => t.name === 'diagram_edit').run({ agent: 'sa', name: 'login-flow', operations: [{ op: 'add_node', id: 'audit', label: 'Write audit log' }, { op: 'add_edge', from: 'form', to: 'audit' }] });
  });
  await expect(embedded.locator('svg')).toContainText('Write audit log');

  // Agent tools can embed too: references are canonicalised, missing sources are reported, previews and exports draw them
  const result = await page.evaluate(async () => {
    const { BOARD_TOOLS } = await import('/src/extensions/board/boardTools.ts');
    const { takeImages } = await import('/src/lib/pendingImages.ts');
    const run = (name, input) => BOARD_TOOLS.find((t) => t.name === name).run({ agent: 'sa', ...input });
    const out = {};
    out.write = await run('board_write', { name: 'context', items: [
      { type: 'section', text: 'Discussion', color: 'blue', notes: ['Is the login flow clear?'] },
      { type: 'diagram', ref: 'login-flow', text: 'Login flow' },
      { type: 'design', ref: 'home', node: 'Mobile — Home' },
      { type: 'diagram', ref: 'does-not-exist' },
    ] });
    out.read = await run('board_read', { name: 'context' });
    out.md = await run('board_export', { name: 'context', format: 'markdown' });
    out.svg = await run('board_export', { name: 'context', format: 'svg' });
    out.svgFile = window.__worktree.get('.pigry/boards/sa/context.svg');
    out.preview = await run('board_preview', { name: 'context' });
    out.attached = takeImages('sa').length;
    out.json = JSON.parse(window.__worktree.get('.pigry/boards/sa/context.board.json'));
    return out;
  });
  expect(result.write).toContain('saved .pigry/boards/sa/context.board.json');
  expect(result.write).toContain('diagram not found'.slice(0, 7));
  expect(result.write).toMatch(/does-not-exist/);
  const embeds = result.json.items.filter((i) => i.type === 'embed');
  expect(embeds.map((i) => i.embed.ref)).toEqual(expect.arrayContaining(['sa/login-flow', 'uxui/home']));
  expect(embeds.find((i) => i.embed.ref === 'uxui/home').embed.node).toMatch(/^n\d+$/);
  expect(result.read).toContain('[diagram embed] sa/login-flow');
  expect(result.md).toContain('## Embedded');
  expect(result.svgFile).toContain('Show form');
  expect(result.svgFile).toContain('DIAGRAM');
  expect(result.attached).toBe(1);

  // Double-click opens the source in its own editor
  await embedded.dblclick();
  await expect(page.locator('.dgm__svg')).toBeVisible();
  await expect(page.locator('.dgm__svg')).toContainText('Write audit log');
});

test('Board shows code: file lines, a compare and a commit, from the picker and from agent tools', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page, { branchComparison: { baseOid: 'b'.repeat(40), compareOid: 'c'.repeat(40), baseOnly: 1, compareOnly: 2, files: [{ path: 'src/App.tsx', status: 'M', additions: 3, deletions: 1 }] } });
  await openFixture(page);
  await installWorktree(page);
  const lines = Array.from({ length: 30 }, (_, i) => `const value${i + 1} = ${i + 1};`).join('\n');
  await page.evaluate((text) => window.__worktree.set('src/numbers.ts', text), lines);

  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: /Blank/ }).click();
  await expect(page.locator('.brd__svg')).toBeVisible();
  const svg = page.locator('.brd__svg');

  // File lines 5–8 only, with their real line numbers
  await page.getByRole('button', { name: 'Add code' }).click();
  await page.getByLabel('Code file path').fill('src/numbers.ts');
  await page.getByLabel('First line').fill('5');
  await page.getByLabel('Last line').fill('8');
  await page.getByRole('button', { name: 'Add to board' }).click();
  await expect(svg).toContainText('const value5 = 5;');
  await expect(svg).toContainText('const value8 = 8;');
  await expect(svg).not.toContainText('const value9 = 9;');
  await expect(svg).not.toContainText('const value4 = 4;');
  await expect(svg).toContainText('FILE');
  await expect(page.locator('.ai-composer__sel-chip--layer')).toContainText('src/numbers.ts:5-8');
  const file = () => page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/boards/user/blank.board.json')));
  await expect.poll(async () => (await file()).items.find((i) => i.type === 'code')?.code).toEqual({ kind: 'file', path: 'src/numbers.ts', start: 5, end: 8 });

  // The range can be changed in the properties panel
  await page.getByLabel('Code last line').fill('6');
  await expect(svg).not.toContainText('const value8 = 8;');
  await expect(svg).toContainText('const value6 = 6;');

  // A compare of two branches and a commit
  await page.getByRole('button', { name: 'Add code' }).click();
  await page.getByRole('tab', { name: 'Compare' }).click();
  await page.getByRole('button', { name: 'Add to board' }).click();
  await expect(svg).toContainText('COMPARE');
  await page.getByRole('button', { name: 'Add code' }).click();
  await page.getByRole('tab', { name: 'Commit' }).click();
  await page.getByLabel('Commit file path').fill('src/App.tsx');
  await page.getByRole('button', { name: 'Add to board' }).click();
  await expect(svg).toContainText('COMMIT');
  await expect(svg).toContainText('after');
  await expect.poll(async () => (await file()).items.filter((i) => i.type === 'code').map((i) => i.code.kind)).toEqual(['file', 'compare', 'commit']);

  // A commit without a file shows its details and changed files; a file opens its diff
  await page.getByRole('button', { name: 'Add code' }).click();
  await page.getByRole('tab', { name: 'Commit' }).click();
  await page.getByRole('button', { name: 'Add to board' }).click();
  await expect(svg).toContainText('files changed');
  await expect(svg).toContainText('Compared to first parent');
  // Overview / Changes tabs in the card header, and the file stepper
  const overviewCard = async () => (await file()).items.filter((i) => i.type === 'code' && i.code.kind === 'commit' && !i.code.path).at(-1);
  await expect.poll(overviewCard).toBeTruthy();
  const commitId = (await overviewCard()).id;
  const commitItem = async () => (await file()).items.find((i) => i.id === commitId);
  const card = page.locator(`.brd__svg [data-id="${commitId}"]`);
  const clickCard = async (localX, localY) => {
    const item = await commitItem();
    const box = await card.boundingBox();
    const scale = box.width / item.w;
    await page.mouse.click(box.x + localX * scale, box.y + localY * scale);
  };
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  {
    const box = await card.boundingBox();
    await page.keyboard.down('Control');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 2; i += 1) await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    // bring the zoomed card to the middle of the canvas
    const stage = await svg.boundingBox();
    await page.mouse.move(stage.x + 40, stage.y + 40);
    for (let i = 0; i < 8; i += 1) {
      const now = await card.boundingBox();
      const dx = now.x + now.width / 2 - (stage.x + stage.width / 2), dy = now.y + now.height / 2 - (stage.y + stage.height / 2);
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20) break;
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(50);
    }
  }
  await clickCard(190, 17);
  await expect(svg).not.toContainText('Compared to first parent');
  await expect(card).toContainText('1/4');
  const wide = await commitItem();
  await clickCard(wide.w - 23, 17);
  await expect(card).toContainText('2/4');
  await clickCard(110, 17);
  await expect(svg).toContainText('Compared to first parent');
  // The cards follow the app theme
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.dispatchEvent(new Event('pigry:theme-changed')); });
  await expect(page.locator('.brd__svg rect[style*="#1c2230"]').first()).toBeAttached();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; window.dispatchEvent(new Event('pigry:theme-changed')); });
  await expect(page.locator('.brd__svg rect[style*="#1c2230"]')).toHaveCount(0);
  const files = page.getByRole('list', { name: 'Changed files' });
  await expect(files.getByRole('listitem').first()).toBeVisible();
  await files.getByRole('listitem').first().click();
  await expect(page.getByRole('button', { name: /Back to commit details/ })).toBeVisible();
  await page.getByRole('button', { name: /Back to commit details/ }).click();
  await expect(files.getByRole('listitem').first()).toBeVisible();

  // Agent tools can add code too; the saved board resolves everything and exports it
  const result = await page.evaluate(async () => {
    const { BOARD_TOOLS } = await import('/src/extensions/board/boardTools.ts');
    const run = (name, input) => BOARD_TOOLS.find((t) => t.name === name).run({ agent: 'sa', ...input });
    const out = {};
    out.write = await run('board_write', { name: 'review', items: [
      { type: 'sticky', text: 'Why is value2 first?' },
      { type: 'code', path: 'src/numbers.ts', start: 1, end: 3, text: 'Numbers' },
      { type: 'code', path: 'src/missing.ts' },
      { type: 'commit', oid: 'abc1234' },
    ] });
    out.svg = await run('board_export', { name: 'review', format: 'svg' });
    out.svgFile = window.__worktree.get('.pigry/boards/sa/review.svg');
    out.read = await run('board_read', { name: 'review' });
    return out;
  });
  expect(result.write).toContain('saved .pigry/boards/sa/review.board.json');
  expect(result.read).toContain('[code file] src/numbers.ts:1-3 "Numbers"');
  expect(result.read).toContain('[code commit] commit abc1234');
  expect(result.svgFile).toContain('const value1 = 1;');
  expect(result.svgFile).toContain('const value3 = 3;');
  expect(result.svgFile).not.toContain('const value4 = 4;');

  // Double-click on a file card goes to the file in the Explorer
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await svg.locator('[data-id]').filter({ hasText: 'FILE' }).first().dblclick();
  await expect(page.getByRole('heading', { name: 'Explorer' }).first()).toBeVisible();
});
