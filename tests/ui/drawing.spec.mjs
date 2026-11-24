import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so drawing files persist. */
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

const CANVAS = 'canvas[aria-label="Painting"]';

async function setup(page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: 'Drawing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Drawing', level: 2 })).toBeVisible();
}

async function createDrawing(page, name, size = null) {
  await page.getByRole('button', { name: 'New drawing' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New drawing' });
  await dialog.getByLabel('Drawing name').fill(name);
  if (size) { await dialog.getByLabel('Width').fill(String(size[0])); await dialog.getByLabel('Height').fill(String(size[1])); }
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator(CANVAS)).toBeVisible();
  await expect.poll(async () => (await page.locator(CANVAS).boundingBox())?.width ?? 0).toBeGreaterThan(100);
}

/** A point of the picture (document pixels) on screen. */
async function screenPoint(page, x, y) {
  const box = await page.locator(CANVAS).boundingBox();
  const width = await page.locator(CANVAS).evaluate((c) => c.width);
  const k = box.width / width;
  return { x: box.x + x * k, y: box.y + y * k };
}

const pixel = (page, x, y) => page.locator(CANVAS).evaluate((c, [px, py]) => Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data), [x, y]);

async function drag(page, from, to) {
  const a = await screenPoint(page, from[0], from[1]), b = await screenPoint(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

async function setForeground(page, hex) {
  const input = page.getByLabel('Hex colour');
  await input.fill(hex);
  await input.press('Enter');
}

const tool = (page, name) => page.getByRole('button', { name, exact: true });
const menu = async (page, name, item) => {
  await page.getByRole('navigation', { name: 'Drawing menu' }).getByRole('button', { name, exact: true }).click();
  await page.getByRole('menu', { name }).getByRole('menuitem', { name: item }).click();
};

test('Drawing is a built-in extension menu with a guide', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await page.getByRole('button', { name: 'Drawing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Drawing', level: 2 })).toBeVisible();
});

test('paint with the brush, undo and redo, pick a colour and fill', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  await createDrawing(page, 'sketch', [400, 300]);
  expect(await page.evaluate(() => [...window.__worktree.keys()])).toContain('.pigry/drawings/user/sketch.drawing.json');
  expect(await pixel(page, 200, 150)).toEqual([255, 255, 255, 255]);

  // brush: a thick red stroke
  await setForeground(page, '#ff0000');
  await page.locator('.drw__opts').getByLabel('Size').fill('30');
  await drag(page, [60, 150], [340, 150]);
  const painted = await pixel(page, 200, 150);
  expect(painted[0]).toBeGreaterThan(240);
  expect(painted[1]).toBeLessThan(20);
  expect(await pixel(page, 200, 40)).toEqual([255, 255, 255, 255]);
  await expect(page.getByRole('status').filter({ hasText: /Unsaved|Saving|Saved/ })).toBeVisible();

  // undo / redo
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await pixel(page, 200, 150)).toEqual([255, 255, 255, 255]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await pixel(page, 200, 150))[1]).toBeLessThan(20);

  // eraser takes it away again
  await tool(page, 'Eraser').click();
  await drag(page, [60, 150], [340, 150]);
  expect(await pixel(page, 200, 150)).toEqual([255, 255, 255, 255]);

  // the colour picker reads the colour of the picture, and the bucket fills the area
  await tool(page, 'Freehand brush').click();
  await drag(page, [60, 250], [340, 250]);
  await tool(page, 'Colour picker').click();
  await setForeground(page, '#0000ff');
  const point = await screenPoint(page, 200, 250);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByLabel('Hex colour')).toHaveValue('#ff0000');
  await setForeground(page, '#00aa00');
  await tool(page, 'Fill (paint bucket)').click();
  const empty = await screenPoint(page, 30, 40);
  await page.mouse.click(empty.x, empty.y);
  expect(await pixel(page, 30, 40)).toEqual([0, 170, 0, 255]);
  expect((await pixel(page, 200, 250))[0]).toBeGreaterThan(200); // the red stroke itself is not covered by the bucket's area
  expect(errors).toEqual([]);
});


test('layers: add, rename, blend, opacity, hide and merge', async ({ page }) => {
  await setup(page);
  await createDrawing(page, 'layers', [300, 200]);
  const layers = page.getByRole('list', { name: 'Layers' });
  await expect(layers.getByRole('listitem')).toHaveCount(1);

  await page.getByRole('button', { name: 'Add layer' }).click();
  await expect(layers.getByRole('listitem')).toHaveCount(2);
  await layers.getByText('Layer 2').dblclick();
  await layers.getByLabel('Layer name').fill('Shadow');
  await layers.getByLabel('Layer name').press('Enter');
  await expect(layers).toContainText('Shadow');

  await page.getByLabel('Blend mode').selectOption('multiply');
  await page.getByLabel('Opacity', { exact: true }).last().fill('60');
  const drawing = async () => JSON.parse(await page.evaluate(() => window.__worktree.get('.pigry/drawings/user/layers.drawing.json')));
  await expect.poll(async () => (await drawing()).layers.find((l) => l.name === 'Shadow')?.blend).toBe('multiply');
  expect((await drawing()).layers.find((l) => l.name === 'Shadow').opacity).toBeCloseTo(0.6, 1);

  // paint on the top layer, hide it, the picture shows the layer below
  await setForeground(page, '#ff0000');
  await tool(page, 'Fill (paint bucket)').click();
  const p = await screenPoint(page, 100, 100);
  await page.mouse.click(p.x, p.y);
  await page.getByLabel('Blend mode').selectOption('normal');
  await page.getByLabel('Opacity', { exact: true }).last().fill('100');
  expect((await pixel(page, 100, 100))[1]).toBeLessThan(5);
  await page.getByRole('button', { name: 'Hide Shadow' }).click();
  expect(await pixel(page, 100, 100)).toEqual([255, 255, 255, 255]);
  await page.getByRole('button', { name: 'Show Shadow' }).click();

  // locked layers cannot be painted on
  await page.getByRole('button', { name: 'Lock Shadow' }).click();
  await tool(page, 'Freehand brush').click();
  await drag(page, [20, 20], [60, 20]);
  await expect(page.getByText('This layer is locked or hidden.')).toBeVisible();
  await page.getByRole('button', { name: 'Unlock Shadow' }).click();

  // merge down leaves one layer
  await page.getByRole('button', { name: 'Merge layer down' }).click();
  await expect(layers.getByRole('listitem')).toHaveCount(1);
});

test('selections limit painting, and filters preview, apply and undo', async ({ page }) => {
  await setup(page);
  await createDrawing(page, 'select', [300, 200]);
  await setForeground(page, '#ff0000');
  await tool(page, 'Rectangular selection').click();
  await drag(page, [50, 50], [150, 150]);
  await menu(page, 'Edit', 'Fill with foreground colour');
  expect((await pixel(page, 100, 100))[1]).toBeLessThan(5);
  expect(await pixel(page, 200, 100)).toEqual([255, 255, 255, 255]);

  await menu(page, 'Select', 'Deselect');
  await menu(page, 'Filter', 'Invert');
  const filter = page.getByRole('dialog', { name: 'Invert' });
  await expect(filter).toBeVisible();
  await expect.poll(async () => (await pixel(page, 100, 100))[1]).toBeGreaterThan(250); // the live preview
  await filter.getByRole('button', { name: 'Cancel' }).click();
  expect((await pixel(page, 100, 100))[1]).toBeLessThan(5);

  await menu(page, 'Filter', 'Invert');
  await page.getByRole('dialog', { name: 'Invert' }).getByRole('button', { name: 'Apply' }).click();
  expect(await pixel(page, 100, 100)).toEqual([0, 255, 255, 255]);
  expect(await pixel(page, 200, 100)).toEqual([255, 255, 255, 255]); // the empty part of the layer has nothing to invert
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await pixel(page, 100, 100))[1]).toBeLessThan(5);
});

test('shapes, gradient, canvas size and export', async ({ page }) => {
  await setup(page);
  await createDrawing(page, 'shapes', [300, 200]);
  await setForeground(page, '#0000ff');
  await tool(page, 'Rectangle').click();
  await page.locator('.drw__opts').getByLabel('Shape style').selectOption('fill');
  await drag(page, [20, 20], [120, 80]);
  expect(await pixel(page, 60, 50)).toEqual([0, 0, 255, 255]);
  await tool(page, 'Ellipse').click();
  await drag(page, [150, 100], [250, 180]);
  expect(await pixel(page, 200, 140)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 152, 102)).toEqual([255, 255, 255, 255]);

  await setForeground(page, '#000000');
  await tool(page, 'Gradient').click();
  await drag(page, [0, 190], [300, 190]);
  const left = await pixel(page, 5, 195), right = await pixel(page, 295, 195);
  expect(left[0]).toBeLessThan(40);
  expect(right[0]).toBeGreaterThan(215);

  await menu(page, 'Image', 'Canvas size…');
  const size = page.getByRole('dialog', { name: 'Canvas size' });
  await size.getByLabel('Keep the proportions').uncheck();
  await size.getByLabel('Width').fill('500');
  await size.getByLabel('Height').fill('400');
  await size.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => page.locator(CANVAS).evaluate((c) => `${c.width}x${c.height}`)).toBe('500x400');

  await menu(page, 'File', 'Save PNG to workspace');
  await expect.poll(() => page.evaluate(() => [...window.__binary.keys()])).toContain('.pigry/drawings/user/shapes.png');
});

test('the agent tools create, read, edit, preview and open drawings', async ({ page }) => {
  await setup(page);
  const run = (name, input) => page.evaluate(async ([tool, args]) => {
    const { DRAWING_TOOLS } = await import('/src/extensions/drawing/drawingTools.ts');
    return DRAWING_TOOLS.find((t) => t.name === tool).run({ agent: 'illustrator', ...args });
  }, [name, input]);

  expect(await run('drawing_list', {})).toContain('No drawings yet');
  const written = await run('drawing_write', {
    name: 'sunset', width: 320, height: 200, background: '#112233',
    ops: [
      { op: 'layer_add', name: 'Sun' },
      { op: 'ellipse', layer: 'Sun', x: 120, y: 60, w: 80, h: 80, fill: '#ffaa00' },
      { op: 'gradient', layer: 1, x1: 0, y1: 0, x2: 0, y2: 200, from: '#ff7700', to: '#112233' },
    ],
  });
  expect(written).toContain('saved .pigry/drawings/illustrator/sunset.drawing.json');
  expect(written).toContain('2 layers');
  expect(await run('drawing_list', {})).toContain('illustrator/sunset');
  const read = await run('drawing_read', { name: 'sunset' });
  expect(read).toContain('320×200');
  expect(read).toContain('"Sun"');

  // the editor shows what the agent painted
  await run('drawing_open', { name: 'sunset' });
  await expect(page.locator(CANVAS)).toBeVisible();
  await expect.poll(async () => (await pixel(page, 160, 100))[0]).toBeGreaterThan(240);
  await expect.poll(async () => (await pixel(page, 160, 100))[2]).toBeLessThan(20);

  // edits are all-or-nothing
  const before = await page.evaluate(() => window.__worktree.get('.pigry/drawings/illustrator/sunset.drawing.json'));
  const bad = await run('drawing_edit', { name: 'sunset', ops: [{ op: 'rect', x: 0, y: 0, w: 50, h: 50, fill: 'red' }, { op: 'layer_edit', layer: 'Nope', opacity: 0.5 }] });
  expect(bad).toContain('error:');
  expect(bad).toContain('no layer "Nope"');
  expect(await page.evaluate(() => window.__worktree.get('.pigry/drawings/illustrator/sunset.drawing.json'))).toBe(before);
  expect(await run('drawing_edit', { name: 'sunset', ops: [{ op: 'rect', fill: 'red' }] })).toContain('needs "x"');
  expect(await run('drawing_edit', { name: 'sunset', ops: [{ op: 'sparkle' }] })).toContain('unknown op');

  const edited = await run('drawing_edit', {
    name: 'sunset',
    ops: [
      { op: 'select', shape: 'rect', x: 0, y: 150, w: 320, h: 50 },
      { op: 'fill_selection', color: '#003366', layer: 1 },
      { op: 'select', shape: 'none' },
      { op: 'text', layer: 'Sun', x: 10, y: 10, text: 'Hi', size: 24, color: '#ffffff' },
      { op: 'stroke', layer: 'Sun', points: [[10, 120], [60, 130], [110, 120]], color: '#00ff00', size: 6, brush: 'ink' },
      { op: 'filter', layer: 1, filter: 'vignette', params: { strength: 30 } },
    ],
  });
  expect(edited).toContain('✓ stroke');
  expect(edited).toContain('✓ filter');
  const saved = JSON.parse(await page.evaluate(() => window.__worktree.get('.pigry/drawings/illustrator/sunset.drawing.json')));
  expect(saved.layers.every((l) => l.png === '' || l.png.startsWith('data:image/png'))).toBe(true);
  expect(saved.layers[1].png).not.toBe('');

  // preview and export; one agent cannot create files in another's folder
  expect(await run('drawing_preview', { name: 'sunset', save_as: '.pigry/drawings/illustrator/preview.png' })).toContain('attached to your next turn');
  expect(await page.evaluate(() => window.__binary.has('.pigry/drawings/illustrator/preview.png'))).toBe(true);
  expect(await run('drawing_preview', { name: 'sunset', save_as: '../escape.png' })).toContain('path must stay inside .pigry/');
  expect(await run('drawing_export', { name: 'sunset', format: 'webp' })).toContain('sunset.webp');
  expect(await run('drawing_write', { name: 'other/sunset', width: 10, height: 10 })).toContain('your own folder');
  expect(await run('drawing_write', { name: 'sunset' })).toContain('already exists');
  expect(await run('drawing_write', { name: 'sunset', overwrite: true, width: 64, height: 64 })).toContain('64×64');
});
