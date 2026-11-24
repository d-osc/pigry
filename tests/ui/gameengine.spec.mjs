import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so game files persist. */
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

async function setup(page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: 'Game Engine', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Game Engine', level: 2 })).toBeVisible();
}

async function createGame(page, name, template) {
  await page.getByRole('button', { name: 'New game' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New game' });
  await dialog.getByLabel('Game name').fill(name);
  await dialog.getByRole('radio', { name: new RegExp(template) }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('tree', { name: 'Scene tree' })).toBeVisible();
}

const stored = async (page, slug) => JSON.parse(await page.evaluate((s) => window.__worktree.get(`.pigry/games/user/${s}.game.json`), slug));
const node = (page, name) => page.getByRole('treeitem', { name: `Node ${name}` });
const menu = async (page, name, item) => {
  await page.getByRole('navigation', { name: 'Game menu' }).getByRole('button', { name, exact: true }).click();
  await page.getByRole('menu', { name }).getByRole('menuitem', { name: item }).first().click();
};

/** The sandboxed iframe of a running game. */
const gameFrame = (page) => page.frames().find((f) => f.url() === 'about:srcdoc');

test('Game Engine is a built-in extension menu', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await page.getByRole('button', { name: 'Game Engine', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Game Engine', level: 2 })).toBeVisible();
});

test('create a 2D platformer, browse its scene tree, edit nodes and undo', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await createGame(page, 'jumper', '2D platformer');
  expect(await page.evaluate(() => [...window.__worktree.keys()])).toContain('.pigry/games/user/jumper.game.json');
  const tree = page.getByRole('tree', { name: 'Scene tree' });
  await expect(tree).toContainText('Player');
  await expect(tree).toContainText('Coin1');
  await expect(page.getByLabel('Edited scene')).toHaveValue('main');

  // the inspector shows the selected node, its script and its exported variables
  await node(page, 'Player').locator('.gm-row-node').click();
  const inspector = page.getByLabel('Inspector for Player');
  await expect(inspector).toContainText('CharacterBody2D');
  await expect(inspector.getByRole('button', { name: /scripts\/player2d\.ts/ })).toBeVisible();
  await inspector.getByLabel('speed', { exact: true }).fill('300');
  await expect.poll(async () => (await stored(page, 'jumper')).scenes.main.root.children.find((n) => n.name === 'Player').exports?.speed).toBe(300);
  await inspector.getByLabel('Position X').fill('-250');
  await expect.poll(async () => (await stored(page, 'jumper')).scenes.main.root.children.find((n) => n.name === 'Player').props.position[0]).toBe(-250);

  // add a Timer under the selected node through the Create New Node dialog
  await page.getByRole('button', { name: 'Add child node' }).click();
  const add = page.getByRole('dialog', { name: 'Create new node' });
  await add.getByLabel('Search nodes').fill('timer');
  await add.getByRole('option', { name: 'Timer' }).click();
  await add.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByLabel('Inspector for Timer')).toBeVisible();
  await page.getByLabel('Wait Time').fill('2.5');
  await expect.poll(async () => JSON.stringify(await stored(page, 'jumper'))).toContain('"waitTime":2.5');

  // rename, groups, undo
  await node(page, 'Timer').getByText('Timer', { exact: true }).dblclick();
  await node(page, 'Timer').getByLabel('Node name').fill('SpawnTimer');
  await node(page, 'Timer').getByLabel('Node name').press('Enter');
  await expect(tree).toContainText('SpawnTimer');
  await page.getByLabel('Add group').fill('timers');
  await page.getByLabel('Add group').press('Enter');
  await expect(page.getByText('timers', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('timers', { exact: true })).toHaveCount(0);

  // delete from the toolbar
  await page.getByRole('button', { name: 'Delete node' }).click();
  await expect(tree).not.toContainText('SpawnTimer');
  expect(errors).toEqual([]);
});

test('scenes: create one, instance it, set the main scene, and the file system dock lists everything', async ({ page }) => {
  await setup(page);
  await createGame(page, 'scenes', 'Empty project');
  const fs = page.getByLabel('File system', { exact: true });
  await expect(fs).toContainText('main');
  await fs.getByRole('button', { name: 'New scene' }).click();
  const dialog = page.getByRole('dialog', { name: 'New scene' });
  await dialog.getByLabel('Scene name').fill('enemy');
  await dialog.getByLabel('Root node type').selectOption('CharacterBody3D');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByLabel('Edited scene')).toHaveValue('enemy');
  await expect(page.getByRole('tree', { name: 'Scene tree' })).toContainText('enemy');

  await page.getByLabel('Edited scene').selectOption('main');
  await page.getByRole('button', { name: 'Instance child scene' }).click();
  await page.getByRole('dialog', { name: 'Instance child scene' }).getByRole('option', { name: 'enemy' }).click();
  await expect(page.getByRole('tree', { name: 'Scene tree' })).toContainText('enemy');
  await expect(page.getByLabel('Inspector for enemy')).toContainText('instance of the scene “enemy”');
  await expect.poll(async () => (await stored(page, 'scenes')).scenes.main.root.children?.[0]?.instance).toBe('enemy');

  await page.getByRole('button', { name: 'Set enemy as the main scene' }).click();
  await expect.poll(async () => (await stored(page, 'scenes')).settings.mainScene).toBe('enemy');
});

test('project settings: size, gravity, input map and autoload', async ({ page }) => {
  await setup(page);
  await createGame(page, 'settings', '3D playground');
  await page.getByRole('button', { name: 'Project settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Project settings' });
  await dialog.getByLabel('3D gravity').fill('4.9');
  await dialog.getByLabel('Window width').fill('800');
  await expect.poll(async () => (await stored(page, 'settings')).settings.gravity3d).toBe(4.9);
  await expect.poll(async () => (await stored(page, 'settings')).settings.width).toBe(800);
  await expect(dialog.getByRole('region', { name: 'Input map' })).toContainText('move_left');
  await dialog.getByLabel('New action name').fill('shoot');
  await dialog.getByRole('button', { name: 'Add action' }).click();
  await dialog.getByRole('button', { name: 'Add key to shoot' }).click();
  await page.keyboard.press('KeyF');
  await expect.poll(async () => (await stored(page, 'settings')).settings.inputMap.shoot).toEqual(['KeyF']);
  await dialog.getByRole('button', { name: 'Close' }).click();
});

test('the 3D viewport renders the scene and the script workspace opens a script', async ({ page }) => {
  await setup(page);
  await createGame(page, 'viewer', '3D playground');
  const canvas = page.locator('canvas[aria-label="Scene viewport"]');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate((c) => {
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    t.getContext('2d').drawImage(c, 0, 0);
    const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    return seen.size;
  })).toBeGreaterThan(6);

  // selecting a node in the tree draws a gizmo target; W switches to the move gizmo
  await node(page, 'Player').locator('.gm-row-node').click();
  await page.getByLabel('Game editor').press('w');
  await expect(page.getByRole('button', { name: 'Move', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Game editor').press('q');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: 'Script' }).click();
  await expect(page.getByTestId('script-editor')).toBeVisible();
  await expect(page.getByTestId('script-editor')).toContainText('CharacterBody3D', { timeout: 15000 });
  await page.getByRole('tab', { name: '2D' }).click();
  await expect(canvas).toBeVisible();
});

test('Play runs the game in a sandboxed iframe, shows its output and stats, and Stop ends it', async ({ page }) => {
  await setup(page);
  await createGame(page, 'play', '2D platformer');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('iframe[title="Game"]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('iframe[title="Game"]')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.getByRole('status', { name: 'Game statistics' })).toContainText('FPS', { timeout: 20000 });
  await expect(page.getByRole('status', { name: 'Game statistics' })).toContainText('nodes');

  // the game is really drawn and its HUD exists
  await expect.poll(async () => gameFrame(page)?.evaluate(() => {
    const c = document.getElementById('c');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    t.getContext('2d').drawImage(c, 0, 0);
    const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 61) seen.add(`${d[i] >> 5},${d[i + 1] >> 5},${d[i + 2] >> 5}`);
    return seen.size;
  }), { timeout: 20000 }).toBeGreaterThan(3);
  await expect.poll(async () => gameFrame(page)?.evaluate(() => document.getElementById('ui').textContent)).toContain('Score: 0');

  // the game cannot reach the app: the sandbox has no access to the parent
  const reach = await gameFrame(page).evaluate(() => { try { return String(window.parent.document.title); } catch { return 'blocked'; } });
  expect(reach).toBe('blocked');

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('iframe[title="Game"]')).toHaveCount(0);
  await expect(page.getByText(/Press Play \(F5\)/)).toBeVisible();
});

test('Export writes a standalone HTML game', async ({ page }) => {
  await setup(page);
  await createGame(page, 'webgame', '3D playground');
  await menu(page, 'Project', 'Export web game (HTML) to workspace');
  await expect.poll(() => page.evaluate(() => window.__worktree.has('.pigry/games/user/webgame.html')), { timeout: 30000 }).toBe(true);
  const html = await page.evaluate(() => window.__worktree.get('.pigry/games/user/webgame.html'));
  expect(html).toContain('<script type="importmap">');
  expect(html).toContain('createEngine');
  expect(html).toContain('scripts/player.ts');
  expect(html.length).toBeGreaterThan(1_000_000);
});

test('the agent tools create, read, edit, run, preview, export and open games', async ({ page }) => {
  await setup(page);
  const run = (name, input) => page.evaluate(async ([tool, args]) => {
    const { GAME_TOOLS } = await import('/src/extensions/gameengine/gameTools.ts');
    return GAME_TOOLS.find((t) => t.name === tool).run({ agent: 'gamedev', ...args });
  }, [name, input]);

  expect(await run('game_list', {})).toContain('No games yet');
  const written = await run('game_write', {
    name: 'runner', title: 'Runner', template: '2d',
    ops: [{ op: 'set', node: 'Hud/Score', props: { text: 'Coins: 0' } }, { op: 'input_action', name: 'dash', keys: ['ShiftLeft'] }],
  });
  expect(written).toContain('saved .pigry/games/gamedev/runner.game.json');
  expect(written).toContain('Player [CharacterBody2D]');
  expect(await run('game_list', {})).toContain('gamedev/runner');
  const read = await run('game_read', { name: 'runner' });
  expect(read).toContain('dash=ShiftLeft');
  expect(read).toContain('scripts/player2d.ts');
  const script = await run('game_read', { name: 'runner', script: 'scripts/player2d.ts' });
  expect(script).toContain('export default class Player2D extends CharacterBody2D');
  expect(script).toContain('exported variables: speed=240');

  // atomic edits and readable errors
  const before = await page.evaluate(() => window.__worktree.get('.pigry/games/gamedev/runner.game.json'));
  const bad = await run('game_edit', { name: 'runner', ops: [{ op: 'add_node', type: 'Timer', name: 'T' }, { op: 'set', node: 'Nope', props: { text: 'x' } }] });
  expect(bad).toContain('error:');
  expect(bad).toContain('no node "Nope"');
  expect(await page.evaluate(() => window.__worktree.get('.pigry/games/gamedev/runner.game.json'))).toBe(before);
  expect(await run('game_edit', { name: 'runner', ops: [{ op: 'add_node', type: 'Dragon' }] })).toContain('unknown type');
  expect(await run('game_edit', { name: 'runner', ops: [{ op: 'add_node', type: 'Sprite2D', props: { colour: 'red' } }] })).toContain('has no property "colour"');

  // run it with scripted input: the player stands on the ground, then runs right
  const idle = await run('game_run', { name: 'runner', frames: 60 });
  expect(idle).toContain('ran 60 frames');
  expect(idle).toContain('onFloor=true');
  expect(idle).not.toContain('ERROR');
  const moved = await run('game_run', { name: 'runner', frames: 90, inputs: [{ frame: 0, action: 'move_right', pressed: true }], every: 30 });
  expect(moved).toContain('At frame 30');
  expect(moved).toMatch(/Main\/Player \[CharacterBody2D\] at \((-?\d+(\.\d+)?)/);
  const x = Number(/Final state:[\s\S]*?Main\/Player \[CharacterBody2D\] at \((-?[\d.]+)/.exec(moved)[1]);
  expect(x).toBeGreaterThan(-150);

  // a script with a runtime error is reported with the node and the message
  expect(await run('game_edit', { name: 'runner', ops: [{ op: 'set_script', path: 'scripts/coin.ts', code: 'export default class Coin extends Area2D { ready() { throw new Error("coin exploded"); } }' }] })).toContain('saved');
  const broken = await run('game_run', { name: 'runner', frames: 5 });
  expect(broken).toContain('ERROR');
  expect(broken).toContain('coin exploded');

  // a screenshot is attached for the agent and can be kept
  const preview = await run('game_preview', { name: 'runner', frames: 20, collisions: true, save_as: '.pigry/games/gamedev/shot.png' });
  expect(preview).toContain('attached to your next turn');
  expect(await page.evaluate(() => window.__binary.get('.pigry/games/gamedev/shot.png')?.startsWith('iVBOR'))).toBe(true);
  expect(await run('game_preview', { name: 'runner', save_as: '../x.png' })).toContain('path must stay inside .pigry/');

  // export refuses a game whose scripts fail to compile, and writes a standalone page otherwise
  const exported = await run('game_export', { name: 'runner' });
  expect(exported).toContain('saved .pigry/games/gamedev/runner.html');
  expect(await page.evaluate(() => window.__worktree.get('.pigry/games/gamedev/runner.html').includes('<script type="importmap">'))).toBe(true);
  expect(await run('game_export', { name: 'runner', path: '../x.html' })).toContain('path must stay inside .pigry/');

  // folders and overwrite rules, and opening in the editor
  expect(await run('game_write', { name: 'other/runner' })).toContain('your own folder');
  expect(await run('game_write', { name: 'runner' })).toContain('already exists');
  expect(await run('game_write', { name: 'runner', overwrite: true, template: 'empty' })).toContain('1 scene(s)');
  await run('game_open', { name: 'runner' });
  await expect(page.getByRole('tree', { name: 'Scene tree' })).toBeVisible();
});
