import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so model files persist. */
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

const CANVAS = 'canvas[aria-label="3D viewport"]';

async function setup(page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: '3D Model', exact: true }).click();
  await expect(page.getByRole('heading', { name: '3D Model', level: 2 })).toBeVisible();
}

async function createScene(page, name, starter = true) {
  await page.getByRole('button', { name: 'New scene' }).first().click();
  const form = page.getByRole('group', { name: 'New scene' });
  await form.getByLabel('New scene name').fill(name);
  if (!starter) await form.getByLabel(/Start with the default scene/).uncheck();
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator(CANVAS)).toBeVisible();
}

const menu = async (page, name, item) => {
  await page.getByRole('navigation', { name: '3D menu' }).getByRole('button', { name, exact: true }).click();
  await page.getByRole('menu', { name }).getByRole('menuitem', { name: item }).first().click();
};

const stored = async (page, slug) => JSON.parse(await page.evaluate((s) => window.__worktree.get(`.pigry/models/user/${s}.model.json`), slug));

/** The colour of the viewport at (fx, fy) as fractions of its size. */
const viewportPixel = (page, fx, fy) => page.locator(CANVAS).evaluate((canvas, [x, y]) => {
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  return Array.from(ctx.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data);
}, [fx, fy]);

test('3D Model is a built-in extension menu with a guide', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await page.getByRole('button', { name: '3D Model', exact: true }).click();
  await expect(page.getByRole('heading', { name: '3D Model', level: 2 })).toBeVisible();
});

test('create a scene, see it in WebGL, add shapes, edit them and undo', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await createScene(page, 'toy');
  expect(await page.evaluate(() => [...window.__worktree.keys()])).toContain('.pigry/models/user/toy.model.json');
  const tree = page.getByRole('tree', { name: 'Outliner' });
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
  await expect(tree).toContainText('Ground');

  // the scene is really rendered: the middle of the viewport is the cube, not the background colour
  await expect.poll(async () => (await viewportPixel(page, 0.5, 0.5)).join(',')).not.toBe('43,47,54,255');
  await expect(page.getByRole('status', { name: 'Scene statistics' })).toContainText('4 objects');

  // add a sphere from the Add menu
  await menu(page, 'Add', 'UV Sphere');
  await expect(tree.getByRole('treeitem')).toHaveCount(5);
  await expect(tree.getByRole('treeitem', { name: 'Object Sphere' })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Location X').fill('2.5');
  await page.getByLabel('Scale Y').fill('2');
  await expect.poll(async () => (await stored(page, 'toy')).objects.find((o) => o.name === 'Sphere')?.position[0]).toBe(2.5);
  expect((await stored(page, 'toy')).objects.find((o) => o.name === 'Sphere').scale[1]).toBe(2);

  // rename in the outliner
  await tree.getByText('Sphere', { exact: true }).dblclick();
  await tree.getByLabel('Object name').fill('Ball');
  await tree.getByLabel('Object name').press('Enter');
  await expect(tree).toContainText('Ball');

  // shape parameters
  await page.getByRole('tab', { name: 'Shape' }).click();
  await page.getByLabel('Radius', { exact: true }).fill('1.5');
  await expect.poll(async () => (await stored(page, 'toy')).objects.find((o) => o.name === 'Ball')?.params.radius).toBe(1.5);

  // undo steps back through the edits, redo returns
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await stored(page, 'toy')).objects.find((o) => o.name === 'Ball')?.params.radius).toBe(0.5);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await stored(page, 'toy')).objects.find((o) => o.name === 'Ball')?.params.radius).toBe(1.5);

  // delete via the Edit menu
  await menu(page, 'Edit', 'Delete');
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('clicking in the viewport selects, G R S switch the gizmo, visibility and parenting work', async ({ page }) => {
  await setup(page);
  await createScene(page, 'pick');
  const tree = page.getByRole('tree', { name: 'Outliner' });
  const box = await page.locator(CANVAS).boundingBox();

  // the default view looks at the cube: clicking the middle selects it
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(tree.getByRole('treeitem', { name: 'Object Cube' })).toHaveAttribute('aria-selected', 'true');
  // clicking the empty corner of the sky/ground deselects
  await page.mouse.click(box.x + 8, box.y + 8);
  await expect(tree.getByRole('treeitem', { name: 'Object Cube' })).toHaveAttribute('aria-selected', 'false');

  await page.getByRole('treeitem', { name: 'Object Cube' }).locator('.m3d-row').click();
  const work = page.getByLabel('3D editor');
  await work.press('g');
  await expect(page.getByRole('button', { name: 'Move', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await work.press('r');
  await expect(page.getByRole('button', { name: 'Rotate', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await work.press('s');
  await expect(page.getByRole('button', { name: 'Scale', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await work.press('q');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // hide and show
  await page.getByRole('button', { name: 'Hide Cube' }).click();
  await expect.poll(async () => (await stored(page, 'pick')).objects.find((o) => o.name === 'Cube').visible).toBe(false);
  await page.getByRole('button', { name: 'Show Cube' }).click();

  // parenting through the Parent field
  await page.getByLabel('Parent').selectOption({ label: 'Ground' });
  await expect.poll(async () => (await stored(page, 'pick')).objects.find((o) => o.name === 'Cube').parent).not.toBeNull();
  await expect(tree.getByRole('group').getByRole('treeitem', { name: 'Object Cube' })).toBeVisible();

  // duplicate with Shift+D and delete with X from the keyboard
  await work.press('Shift+D');
  await expect(tree.getByRole('treeitem')).toHaveCount(5);
  await work.press('x');
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
});

test('materials, modifiers, lights and the world have properties', async ({ page }) => {
  await setup(page);
  await createScene(page, 'props');
  const tree = page.getByRole('tree', { name: 'Outliner' });
  await tree.getByText('Cube', { exact: true }).click();

  await page.getByRole('tab', { name: 'Material' }).click();
  await page.getByRole('button', { name: 'Gold' }).click();
  await expect.poll(async () => (await stored(page, 'props')).objects.find((o) => o.name === 'Cube').material.metalness).toBe(1);
  await page.getByLabel('Base colour').fill('#336699');
  await expect.poll(async () => (await stored(page, 'props')).objects.find((o) => o.name === 'Cube').material.color).toBe('#336699');

  await page.getByRole('tab', { name: 'Modifiers' }).click();
  await page.getByRole('button', { name: 'Array' }).click();
  await expect(page.getByRole('status', { name: 'Scene statistics' })).toContainText('triangles');
  const before = await page.getByRole('status', { name: 'Scene statistics' }).textContent();
  await page.getByRole('spinbutton', { name: 'Count' }).fill('5');
  await expect.poll(async () => page.getByRole('status', { name: 'Scene statistics' }).textContent()).not.toBe(before);
  await page.getByRole('button', { name: 'Remove array modifier' }).click();
  await expect(page.getByRole('group', { name: 'array modifier' })).toHaveCount(0);

  await tree.getByText('Sun', { exact: true }).click();
  await page.getByRole('tab', { name: 'Light' }).click();
  await page.getByLabel('Intensity').fill('6');
  await expect.poll(async () => (await stored(page, 'props')).objects.find((o) => o.name === 'Sun').light.intensity).toBe(6);
  await page.getByLabel('Light type').selectOption('spot');
  await expect(page.getByLabel('Cone angle')).toBeVisible();

  await page.getByRole('tab', { name: 'World' }).click();
  await page.getByLabel('Background colour').fill('#112233');
  await expect.poll(async () => (await stored(page, 'props')).world.background).toBe('#112233');
});

test('shading, views, snap and the render and export commands', async ({ page }) => {
  await setup(page);
  await createScene(page, 'out');
  await page.getByRole('radio', { name: 'Wireframe' }).click();
  await expect(page.getByRole('radio', { name: 'Wireframe' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Material' }).click();
  await page.getByRole('button', { name: 'Perspective' }).click();
  await expect(page.getByRole('button', { name: 'Orthographic' })).toBeVisible();
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await page.getByRole('button', { name: 'Snap', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Snap', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await menu(page, 'Render', 'Render image');
  await expect.poll(() => page.evaluate(() => [...window.__binary.keys()])).toContain('.pigry/models/user/out-render.png');
  const png = await page.evaluate(() => window.__binary.get('.pigry/models/user/out-render.png'));
  expect(png.startsWith('iVBOR')).toBe(true);

  await menu(page, 'File', 'Export GLB (glTF binary) to workspace');
  await menu(page, 'File', 'Export STL to workspace');
  await menu(page, 'File', 'Export OBJ to workspace');
  await expect.poll(() => page.evaluate(() => [...window.__binary.keys()].sort())).toEqual(expect.arrayContaining(['.pigry/models/user/out.glb', '.pigry/models/user/out.obj', '.pigry/models/user/out.stl']));
  const glb = await page.evaluate(() => window.__binary.get('.pigry/models/user/out.glb'));
  expect(Buffer.from(glb, 'base64').subarray(0, 4).toString()).toBe('glTF');
});

test('the agent tools create, read, edit, preview, export and open scenes', async ({ page }) => {
  await setup(page);
  const run = (name, input) => page.evaluate(async ([tool, args]) => {
    const { MODEL_TOOLS } = await import('/src/extensions/model3d/model3dTools.ts');
    return MODEL_TOOLS.find((t) => t.name === tool).run({ agent: 'modeler', ...args });
  }, [name, input]);

  expect(await run('model_list', {})).toContain('No 3D models yet');
  const written = await run('model_write', {
    name: 'table', title: 'Table', starter: true,
    ops: [
      { op: 'add', kind: 'box', name: 'Top', position: [0, 0.725, 0], params: { width: 1.4, height: 0.05, depth: 0.8 }, material: { color: '#8b5a2b', roughness: 0.7 } },
      { op: 'add', kind: 'box', name: 'Leg', position: [0.65, 0.35, 0.35], params: { width: 0.06, height: 0.7, depth: 0.06 }, modifiers: [{ type: 'mirror', axis: 'x' }, { type: 'mirror', axis: 'z' }] },
      { op: 'add', kind: 'cylinder', name: 'Mug', position: [0.3, 0.84, 0], params: { radiusTop: 0.04, radiusBottom: 0.04, height: 0.1 }, material: { color: 'white' } },
    ],
  });
  expect(written).toContain('saved .pigry/models/modeler/table.model.json');
  expect(written).toContain('"Top"');
  expect(await run('model_list', {})).toContain('modeler/table');
  const read = await run('model_read', { name: 'table' });
  expect(read).toContain('mirror x, mirror z');
  expect(read).toContain('"Mug"');

  // opened in the editor
  await run('model_open', { name: 'table' });
  await expect(page.locator(CANVAS)).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Outliner' })).toContainText('Mug');

  // edits are all-or-nothing and validated
  const before = await page.evaluate(() => window.__worktree.get('.pigry/models/modeler/table.model.json'));
  const bad = await run('model_edit', { name: 'table', ops: [{ op: 'move', target: 'Top', by: [0, 1, 0] }, { op: 'move', target: 'Nope', by: [0, 1, 0] }] });
  expect(bad).toContain('error:');
  expect(bad).toContain('no object "Nope"');
  expect(await page.evaluate(() => window.__worktree.get('.pigry/models/modeler/table.model.json'))).toBe(before);
  expect(await run('model_edit', { name: 'table', ops: [{ op: 'sparkle' }] })).toContain('unknown op');
  expect(await run('model_edit', { name: 'table', ops: [{ op: 'add', kind: 'box', position: [1, 2] }] })).toContain('[x, y, z]');
  const edited = await run('model_edit', { name: 'table', ops: [{ op: 'material', target: 'Mug', color: '#cc3333' }, { op: 'align', target: 'Mug', ground: true }, { op: 'move', target: 'Mug', by: [0, 0.75, 0] }] });
  expect(edited).toContain('✓ material');
  await expect.poll(async () => (await page.evaluate(() => window.__worktree.get('.pigry/models/modeler/table.model.json'))).includes('#cc3333')).toBe(true);

  // preview is a real WebGL render and queues an image for the agent
  const preview = await run('model_preview', { name: 'table', position: [3, 2, 3], target: [0, 0.5, 0], save_as: '.pigry/models/modeler/table-preview.png', shading: 'solid' });
  expect(preview).toContain('attached to your next turn');
  const saved = await page.evaluate(() => window.__binary.get('.pigry/models/modeler/table-preview.png'));
  expect(saved.startsWith('iVBOR')).toBe(true);
  expect(await run('model_preview', { name: 'table', save_as: '../escape.png' })).toContain('path must stay inside .pigry/');
  expect(await run('model_preview', { name: 'table', camera: 'Camera' })).toContain('attached');
  expect(await run('model_preview', { name: 'table', camera: 'Nope' })).toContain('no camera "Nope"');

  expect(await run('model_export', { name: 'table', format: 'glb' })).toContain('table.glb');
  expect(await run('model_export', { name: 'table', format: 'stl' })).toContain('table.stl');
  expect(await run('model_export', { name: 'table', format: 'obj', path: '.pigry/models/modeler/custom.obj' })).toContain('custom.obj');
  expect(await run('model_export', { name: 'table', format: 'fbx' })).toContain('format must be');

  // folders and overwrite rules
  expect(await run('model_write', { name: 'other/table' })).toContain('your own folder');
  expect(await run('model_write', { name: 'table' })).toContain('already exists');
  expect(await run('model_write', { name: 'table', overwrite: true, ops: [{ op: 'add', kind: 'sphere' }] })).toContain('1 object');
  expect(await run('model_preview', { name: 'table' })).toContain('attached');
});

test('a mirror modifier adds a copy across the parent origin and an array repeats the object', async ({ page }) => {
  await setup(page);
  const counts = await page.evaluate(async () => {
    const { applyModelOps, emptyModel } = await import('/src/extensions/model3d/model3d.ts');
    const { buildScene } = await import('/src/extensions/model3d/modelScene.ts');
    const model = emptyModel('m');
    applyModelOps(model, [
      { op: 'add', kind: 'box', name: 'Leg', position: [0.65, 0.35, 0.35], modifiers: [{ type: 'mirror', axis: 'x' }, { type: 'mirror', axis: 'z' }] },
      { op: 'add', kind: 'box', name: 'Post', position: [0, 0.5, 5], modifiers: [{ type: 'array', count: 3, offset: [2, 0, 0] }] },
    ]);
    const built = buildScene(model);
    const legs = built.pickables.filter((m) => m.userData.objId === 'o1');
    const xs = legs.map((m) => { const p = m.getWorldPosition(new m.position.constructor()); return [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100].join(','); }).sort();
    return { legs: legs.length, xs, posts: built.pickables.filter((m) => m.userData.objId === 'o2').length, roots: built.roots.length };
  });
  expect(counts.legs).toBe(4);
  expect(counts.xs).toEqual(['-0.65,-0.35', '-0.65,0.35', '0.65,-0.35', '0.65,0.35']);
  expect(counts.posts).toBe(3);
  expect(counts.roots).toBe(2 + 3);
});
