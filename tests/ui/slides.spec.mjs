import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so presentations, side files and exports persist. */
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
        return { ...base, entries: [...base.entries, ...files.keys(), ...window.__binary.keys()] };
      }
      if (cmd === 'read_worktree_file' && files.has(args.path)) {
        return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'json' };
      }
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
      if (cmd === 'write_worktree_binary') { window.__binary.set(args.path, args.data); return null; }
      if (cmd === 'read_binary_file' && window.__binary.has(args.path)) {
        const data = window.__binary.get(args.path);
        return { data, mime: 'application/octet-stream', size: data.length };
      }
      if (cmd === 'delete_worktree_file') { files.delete(args.path); window.__binary.delete(args.path); return null; }
      return invoke(cmd, args);
    };
  });
}

async function setup(page) {
  await page.setViewportSize({ width: 1700, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installWorktree(page);
  await page.getByRole('button', { name: 'Slides', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Slides', level: 2 })).toBeVisible();
}
async function createDeck(page, name, template = 'Blank') {
  await page.getByRole('button', { name: 'New presentation' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New presentation' });
  await dialog.getByLabel('Presentation name').fill(name);
  await dialog.getByRole('radio', { name: template }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(canvas(page)).toBeVisible();
}
const canvas = (page) => page.getByTestId('slide-canvas');
const thumbs = (page) => page.getByTestId('slide-thumb');
const stored = async (page, slug, owner = 'user') => JSON.parse(await page.evaluate(([s, o]) => window.__worktree.get(`.pigry/slides/${o}/${s}.slides.json`) ?? 'null', [slug, owner]));
const saved = (page, slug, fn) => expect.poll(async () => { try { return fn(await stored(page, slug)); } catch { return undefined; } }, { timeout: 6000 });
const text = (el) => (el?.paras ?? []).map((p) => p.runs.map((r) => r.t).join('')).join('\n');
const menu = async (page, top, item, sub) => {
  await page.getByRole('navigation', { name: 'Slides menu' }).getByRole('button', { name: top, exact: true }).click();
  const popup = page.getByRole('menu', { name: top });
  if (!sub) return popup.getByRole('menuitem', { name: item, exact: true }).or(popup.getByRole('menuitemcheckbox', { name: item, exact: true }));
  await popup.getByRole('menuitem', { name: new RegExp(`^${item} ▸$`) }).click();
  return page.getByRole('menu', { name: item }).getByRole('menuitem', { name: sub, exact: true }).or(page.getByRole('menu', { name: item }).getByRole('menuitemcheckbox', { name: sub, exact: true }));
};
const el = (page, id) => canvas(page).locator(`.sld-el[data-id="${id}"]`);
async function dragBy(page, x, y, dx, dy, opts = {}) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
  if (opts.beforeUp) await opts.beforeUp();
  await page.mouse.up();
}
async function centerOf(locator) { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; }

test('empty state, new presentation from a template, add, duplicate, skip and delete slides', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: 'New Pitch deck presentation' })).toBeVisible();
  await createDeck(page, 'talk');
  await expect(thumbs(page)).toHaveCount(1);
  await expect(page.getByTestId('slide-count')).toHaveText('Slide 1 of 1');
  await page.getByRole('button', { name: 'New slide', exact: true }).click();
  await expect(thumbs(page)).toHaveCount(2);
  await expect(page.getByTestId('slide-count')).toHaveText('Slide 2 of 2');
  await saved(page, 'talk', (d) => d?.slides.map((s) => s.layout)).toEqual(['title', 'title-body']);
  // Ctrl+M adds another, Ctrl+D (in the filmstrip) duplicates it
  await page.getByRole('button', { name: /^Slide 2/ }).click();
  await page.keyboard.press('Control+m');
  await expect(thumbs(page)).toHaveCount(3);
  await page.getByRole('button', { name: /^Slide 3/ }).click();
  await page.keyboard.press('Control+d');
  await expect(thumbs(page)).toHaveCount(4);
  await (await menu(page, 'Slide', 'Skip slide')).click();
  await expect(page.getByRole('button', { name: /^Slide 4.*\(skipped\)/ })).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(thumbs(page)).toHaveCount(3);
  await saved(page, 'talk', (d) => d?.slides.length).toBe(3);
  // a layout from the toolbar
  await page.getByRole('button', { name: 'New slide with layout' }).click();
  await page.getByRole('menu', { name: 'Layouts' }).getByRole('menuitem', { name: 'Big number' }).click();
  await saved(page, 'talk', (d) => d?.slides.at(-1).layout).toBe('big-number');
  // undo / redo
  await page.keyboard.press('Control+z');
  await expect(thumbs(page)).toHaveCount(3);
  await page.keyboard.press('Control+y');
  await expect(thumbs(page)).toHaveCount(4);
});

test('edit text in place, format a whole box, and speaker notes', async ({ page }) => {
  await setup(page);
  await createDeck(page, 'notes');
  const deck = await stored(page, 'notes');
  const [title, subtitle] = deck.slides[0].elements;
  await expect(el(page, title.id)).toContainText('notes');
  await expect(el(page, subtitle.id)).toContainText('Click to add subtitle');
  await el(page, title.id).dblclick();
  const editor = page.getByTestId('slide-text-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Quarterly review');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' now');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await saved(page, 'notes', (d) => text(d?.slides[0].elements[0])).toBe('Quarterly review now');
  const runs = (await stored(page, 'notes')).slides[0].elements[0].paras[0].runs;
  expect(runs.some((r) => r.t.includes('now') && r.b === false), JSON.stringify(runs)).toBe(true); // titles are bold: Ctrl+B turned it off
  expect((await stored(page, 'notes')).slides[0].elements[0].placeholder).toBeUndefined();
  // a list in the subtitle box with Tab indent
  await el(page, subtitle.id).dblclick();
  await page.keyboard.type('First');
  await page.keyboard.press('Control+Shift+8');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await saved(page, 'notes', (d) => d?.slides[0].elements[1].paras.map((p) => [p.list ?? null, p.level ?? 0, p.runs.map((r) => r.t).join('')])).toEqual([['bullet', 0, 'First'], ['bullet', 1, 'Second']]);
  // whole-box formatting with the box selected (not edited)
  await el(page, subtitle.id).click();
  await expect(page.getByTestId('selection-box')).toHaveCount(1);
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await page.getByRole('button', { name: 'Center align', exact: true }).click();
  await saved(page, 'notes', (d) => d?.slides[0].elements[1].paras.every((p) => p.align === 'center' && p.runs.every((r) => r.i))).toBe(true);
  // speaker notes
  await page.getByRole('textbox', { name: 'Speaker notes' }).fill('Open with the customer quote.');
  await page.getByRole('textbox', { name: 'Speaker notes' }).blur();
  await saved(page, 'notes', (d) => d?.slides[0].notes).toBe('Open with the customer quote.');
  await page.keyboard.press('Control+Alt+Shift+S');
  await expect(page.getByRole('textbox', { name: 'Speaker notes' })).toHaveCount(0);
});

test('insert, move with smart guides, resize, rotate, group, align and delete objects', async ({ page }) => {
  await setup(page);
  await createDeck(page, 'shapes');
  await page.getByRole('button', { name: 'New slide with layout' }).click();
  await page.getByRole('menu', { name: 'Layouts' }).getByRole('menuitem', { name: 'Blank' }).click();
  await (await menu(page, 'Insert', 'Shape', 'Oval')).click();
  await saved(page, 'shapes', (d) => d?.slides[1].elements.length).toBe(1);
  const shape = (await stored(page, 'shapes')).slides[1].elements[0];
  expect([shape.x, shape.y, shape.w, shape.h]).toEqual([380, 200, 200, 140]); // centred on 960×540
  const c = await centerOf(el(page, shape.id));
  // drag: a guide shows while the shape is centred on the slide
  let sawGuide = false;
  await dragBy(page, c.x, c.y, 120, 3, { beforeUp: async () => { sawGuide = (await page.getByTestId('smart-guide').count()) > 0; } });
  expect(sawGuide).toBe(true);
  await saved(page, 'shapes', (d) => { const e = d?.slides[1].elements[0]; return e && e.x > 400 && e.y === 200; }).toBe(true);
  // resize with the south-east handle
  const before = (await stored(page, 'shapes')).slides[1].elements[0];
  const handle = await centerOf(canvas(page).locator('.sl-handle--se'));
  await dragBy(page, handle.x, handle.y, 60, 40, {});
  await saved(page, 'shapes', (d) => { const e = d?.slides[1].elements[0]; return e && e.w > before.w + 30 && e.h > before.h + 20 && e.x === before.x; }).toBe(true);
  // rotate with the round handle (Shift snaps to 15°)
  const rot = await centerOf(canvas(page).locator('.sl-handle--rot'));
  const mid = await centerOf(el(page, shape.id));
  await page.keyboard.down('Shift');
  await dragBy(page, rot.x, rot.y, mid.x + 200 - rot.x, mid.y - rot.y, {});
  await page.keyboard.up('Shift');
  await saved(page, 'shapes', (d) => d?.slides[1].elements[0].rot).toBe(90);
  // a second shape, select both, align left, group
  await (await menu(page, 'Insert', 'Shape', 'Star')).click();
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('selection-box')).toHaveCount(2);
  await (await menu(page, 'Arrange', 'Align', 'Left')).click();
  await saved(page, 'shapes', (d) => { const [a, b] = d?.slides[1].elements ?? []; return a && b && Math.abs(a.x - b.x) < 0.2; }).toBe(true);
  await page.keyboard.press('Control+Alt+g');
  await saved(page, 'shapes', (d) => { const [a, b] = d?.slides[1].elements ?? []; return !!a?.group && a.group === b.group; }).toBe(true);
  await page.keyboard.press('Control+Alt+Shift+G');
  await saved(page, 'shapes', (d) => d?.slides[1].elements.every((e) => !e.group)).toBe(true);
  // nudge and z-order with the keyboard, then delete
  await page.keyboard.press('Escape');
  const star = (await stored(page, 'shapes')).slides[1].elements[1];
  await el(page, star.id).click({ position: { x: 60, y: 60 } });
  await page.keyboard.press('ArrowRight');
  await saved(page, 'shapes', (d) => d?.slides[1].elements[1].x).toBe(star.x + 4);
  await page.keyboard.press('Control+Shift+ArrowDown');
  await saved(page, 'shapes', (d) => d?.slides[1].elements[0].id).toBe(star.id);
  await page.keyboard.press('Delete');
  await saved(page, 'shapes', (d) => d?.slides[1].elements.length).toBe(1);
  // draw a text box by dragging, then type into it
  await page.getByRole('button', { name: 'Text box' }).click();
  const box = await canvas(page).boundingBox();
  await dragBy(page, box.x + 40, box.y + 40, 260, 70, {});
  await expect(page.getByTestId('slide-text-editor')).toBeFocused();
  await page.keyboard.type('Drawn box');
  await page.keyboard.press('Escape');
  await saved(page, 'shapes', (d) => text(d?.slides[1].elements.at(-1))).toBe('Drawn box');
});

test('themes, master editing, background, layout and transition', async ({ page }) => {
  await setup(page);
  await createDeck(page, 'look');
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  const themes = page.getByRole('complementary', { name: 'Themes' });
  await themes.getByRole('button', { name: 'Theme Midnight' }).click();
  await saved(page, 'look', (d) => d?.theme.id).toBe('midnight');
  await expect(canvas(page).locator('.sld').first()).toHaveCSS('background-color', 'rgb(17, 24, 39)');
  await themes.getByRole('button', { name: 'Edit theme (colours and fonts)…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit theme' });
  await dialog.getByLabel('Title font').selectOption('Georgia');
  await dialog.getByLabel('Accent 1 colour').fill('#ff0000');
  await dialog.getByRole('button', { name: 'Apply to all slides' }).click();
  await saved(page, 'look', (d) => [d?.theme.fonts.title, d?.theme.colors.accent, d?.theme.id]).toEqual(['Georgia', '#ff0000', 'custom']);
  // background and layout from the slide panel (nothing selected)
  await page.getByRole('button', { name: 'Background', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Format options' });
  await panel.getByRole('button', { name: 'Background colour accent2' }).click();
  await saved(page, 'look', (d) => d?.slides[0].background).toEqual({ type: 'color', color: '$accent2' });
  await panel.getByRole('radio', { name: 'gradient' }).click();
  await panel.getByRole('button', { name: 'Gradient to accent', exact: true }).click();
  await saved(page, 'look', (d) => d?.slides[0].background?.type).toBe('gradient');
  await panel.getByLabel('Slide layout').selectOption('section');
  await saved(page, 'look', (d) => d?.slides[0].layout).toBe('section');
  await page.getByRole('button', { name: 'Transition', exact: true }).click();
  const motion = page.getByRole('complementary', { name: 'Motion' });
  await motion.getByLabel('Transition type').selectOption('zoom');
  await saved(page, 'look', (d) => d?.slides[0].transition?.type).toBe('zoom');
});

test('animations, present mode with keyboard, laser pointer and presenter view', async ({ page }) => {
  await setup(page);
  await createDeck(page, 'show', 'Project update');
  const deck = await stored(page, 'show');
  // add an on-click animation to the title of slide 2
  await page.getByRole('button', { name: /^Slide 2/ }).click();
  const title = deck.slides[1].elements.find((e) => e.role === 'title');
  await el(page, title.id).click();
  await page.getByRole('button', { name: 'Animate' }).click();
  const motion = page.getByRole('complementary', { name: 'Motion' });
  await motion.getByRole('button', { name: '+ Add animation' }).click();
  await expect(motion.getByTestId('animation-row')).toHaveCount(1);
  await motion.getByLabel('Animation 1 effect').selectOption('fly-left');
  await saved(page, 'show', (d) => d?.slides[1].anims.map((a) => [a.el, a.effect, a.start])).toEqual([[title.id, 'fly-left', 'click']]);
  await page.getByRole('textbox', { name: 'Speaker notes' }).fill('Say the status first.');
  await page.getByRole('textbox', { name: 'Speaker notes' }).blur();
  await saved(page, 'show', (d) => d?.slides[1].notes).toBe('Say the status first.');
  // present from this slide: the title is hidden until the click
  await page.keyboard.press('Control+F5');
  const show = page.getByRole('dialog', { name: 'Presentation' });
  await expect(show).toBeVisible();
  await expect(page.getByTestId('present-count')).toHaveText(`2 / ${deck.slides.length}`);
  const titleInShow = show.locator(`.sld-el[data-id="${title.id}"]`);
  await expect(titleInShow).toHaveCSS('visibility', 'hidden');
  await page.keyboard.press('ArrowRight');
  await expect(titleInShow).toHaveCSS('visibility', 'visible');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('present-count')).toHaveText(`3 / ${deck.slides.length}`);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('present-count')).toHaveText(`2 / ${deck.slides.length}`);
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('present-count')).toHaveText(`1 / ${deck.slides.length}`);
  await page.keyboard.press('l');
  await page.mouse.move(400, 300);
  await expect(page.getByTestId('laser')).toBeVisible();
  await page.keyboard.press('b');
  await expect(page.getByTestId('present-cover')).toBeVisible();
  await page.keyboard.press('b');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('s');
  await expect(page.locator('.sl-presenter')).toBeVisible();
  await expect(page.getByTestId('presenter-notes')).toHaveText('Say the status first.');
  await expect(page.getByTestId('presenter-timer')).toHaveText(/^\d\d:\d\d$/);
  await expect(page.getByRole('img', { name: /^Next slide/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(show).toHaveCount(0);
  await expect(page.getByTestId('slide-count')).toHaveText(`Slide 2 of ${deck.slides.length}`);
});

test('filmstrip drag to reorder, grid view, comments and find and replace', async ({ page }) => {
  await setup(page);
  await createDeck(page, 'order', 'Lesson');
  const before = (await stored(page, 'order')).slides.map((s) => s.id);
  await thumbs(page).nth(0).dragTo(thumbs(page).nth(2), { targetPosition: { x: 80, y: 70 } });
  await saved(page, 'order', (d) => d?.slides.map((s) => s.id)).toEqual([before[1], before[2], before[0], ...before.slice(3)]);
  await page.keyboard.press('Control+Alt+1');
  await expect(page.getByRole('list', { name: 'Slide grid' }).getByRole('listitem')).toHaveCount(before.length);
  await page.getByRole('button', { name: 'Grid slide 4' }).dblclick();
  await expect(page.getByTestId('slide-count')).toHaveText(`Slide 4 of ${before.length}`);
  // comment on the slide
  await page.keyboard.press('Control+Alt+m');
  const comments = page.getByRole('complementary', { name: 'Comments' });
  await comments.getByLabel('Comment text').fill('Too much text here?');
  await comments.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(comments.getByTestId('slide-comment')).toHaveCount(1);
  await saved(page, 'order', (d) => d?.slides[3].comments.map((c) => [c.author, c.text])).toEqual([['user', 'Too much text here?']]);
  await comments.getByRole('button', { name: /^Resolve comment/ }).click();
  await saved(page, 'order', (d) => d?.slides[3].comments[0].resolved).toBe(true);
  // find and replace across every slide
  await page.getByTestId('slide-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+h');
  const find = page.getByRole('dialog', { name: 'Find and replace' });
  await find.getByLabel('Find', { exact: true }).fill('lesson');
  await expect(find.getByRole('status')).toHaveText(/\d+ match/);
  await find.getByLabel('Replace with').fill('class');
  await find.getByRole('button', { name: 'Replace all' }).click();
  await expect(find.getByRole('status')).toHaveText(/Replaced \d+/);
  await saved(page, 'order', (d) => JSON.stringify(d?.slides).toLowerCase().includes('lesson')).toBe(false);
});

test('exports are written inside .pigry/ next to the presentation', async ({ page }) => {
  await setup(page);
  await createDeck(page, 'deck-export', 'Pitch deck');
  await (await menu(page, 'File', 'Download', 'Microsoft PowerPoint (.pptx)')).click();
  await expect.poll(() => page.evaluate(() => (window.__binary.get('.pigry/slides/user/deck-export.pptx') ?? '').slice(0, 4)), { timeout: 15000 }).toBe('UEsD'); // "PK\x03"
  await (await menu(page, 'File', 'Download', 'Web presentation (.html)')).click();
  await expect.poll(() => page.evaluate(() => window.__worktree.get('.pigry/slides/user/deck-export.html') ?? '')).toContain('<section class="slide"');
  await (await menu(page, 'File', 'Download', 'PDF document (.pdf)')).click();
  await expect.poll(() => page.evaluate(() => atob((window.__binary.get('.pigry/slides/user/deck-export.pdf') ?? '').slice(0, 12))), { timeout: 20000 }).toContain('%PDF-1.4');
  await (await menu(page, 'File', 'Download', 'PNG image (current slide)')).click();
  await expect.poll(() => page.evaluate(() => (window.__binary.get('.pigry/slides/user/deck-export-slide-1.png') ?? '').slice(0, 8)), { timeout: 15000 }).toBe('iVBORw0K');
  await (await menu(page, 'File', 'Download', 'Markdown outline (.md)')).click();
  await expect.poll(() => page.evaluate(() => window.__worktree.get('.pigry/slides/user/deck-export.md') ?? '')).toContain('## ');
});

test('agent tools write to the caller folder, edit all-or-nothing, preview, export and open the editor', async ({ page }) => {
  await setup(page);
  const out = await page.evaluate(async () => {
    const { SLIDES_TOOLS } = await import('/src/extensions/slides/slidesTools.ts');
    const run = (name, input) => SLIDES_TOOLS.find((t) => t.name === name).run({ agent: 'presenter', ...input });
    const o = {};
    o.write = await run('slides_write', { name: 'q4', title: 'Q4 review', theme: 'focus', markdown: '# Q4 review\nFor the leadership team\n\n## Revenue grew 18% on the new pricing\n- Enterprise +30%\n- Self-serve +9%\n> Start with the enterprise story\n\n## 42%\nof customers now pay annually' });
    o.other = await run('slides_write', { name: 'user/q4b', markdown: '# X' });
    o.again = await run('slides_write', { name: 'q4', markdown: '# Y' });
    o.edit = await run('slides_edit', { name: 'q4', ops: JSON.stringify([{ op: 'add', slide: 2, type: 'chart', chart: 'bar', labels: ['Enterprise', 'Self-serve'], series: [{ name: 'Growth %', values: [30, 9] }], x: 520, y: 150, w: 380, h: 300, title: 'Growth by segment', highlight: 0 }, { op: 'animate', slide: 2, el: 'Growth by segment', effect: 'fade-in' }, { op: 'transition', all: true, type: 'fade' }]) });
    o.bad = await run('slides_edit', { name: 'q4', ops: [{ op: 'title', title: 'Changed' }, { op: 'delete', slide: 9, el: 'x' }] });
    o.read = await run('slides_read', { name: 'q4' });
    o.outline = await run('slides_read', { name: 'q4', format: 'outline' });
    o.list = await run('slides_list', {});
    o.preview = await run('slides_preview', { name: 'q4', slides: [1, 2] });
    o.png = await run('slides_export', { name: 'q4', format: 'png', slides: [2] });
    o.pptx = await run('slides_export', { name: 'q4', format: 'pptx' });
    o.outside = await run('slides_export', { name: 'q4', format: 'html', path: 'docs/q4.html' });
    o.open = await run('slides_open', { name: 'q4', slide: '3' });
    return o;
  });
  expect(out.write).toContain('saved .pigry/slides/presenter/q4.slides.json');
  expect(out.write).toMatch(/2\. s\d+ title-body: Revenue grew 18%/);
  expect(out.other).toContain('only create presentations in your own folder');
  expect(out.again).toContain('already exists');
  expect(out.edit).toContain('added chart');
  expect(out.edit).toContain('transition fade on every slide');
  expect(out.bad).toContain('op 2 (delete): no slide "9"');
  expect(out.bad).toContain('nothing was saved');
  expect(out.read).toContain('theme Focus');
  expect(out.read).toContain('notes: Start with the enterprise story');
  expect(out.read).toContain('chart(bar)');
  expect(out.read).toMatch(/Review:/);
  expect(out.outline).toContain('Slide 3: 42%');
  expect(out.list).toContain('presenter/q4');
  expect(out.preview).toContain('is attached to your next turn');
  expect(out.png).toContain('.pigry/slides/presenter/q4-slide-2.png');
  expect(out.pptx).toContain('saved .pigry/slides/presenter/q4.pptx');
  expect(out.outside).toContain('must stay inside .pigry/');
  expect(out.open).toContain('at slide 3');
  const deck = await stored(page, 'q4', 'presenter');
  expect(deck.title).toBe('Q4 review');
  expect(deck.slides[1].elements.find((e) => e.type === 'chart').highlight).toBe(0);
  // slides_open shows it in the editor at slide 3
  await expect(page.getByTestId('slide-count')).toHaveText('Slide 3 of 3');
  await expect(page.getByRole('button', { name: /^q4/ }).first()).toBeVisible();
  // the agent's change shows up in the open editor
  await page.evaluate(async () => {
    const { SLIDES_TOOLS } = await import('/src/extensions/slides/slidesTools.ts');
    await SLIDES_TOOLS.find((t) => t.name === 'slides_edit').run({ agent: 'presenter', name: 'q4', ops: [{ op: 'add_slide', layout: 'title-body', title: 'Next steps', body: ['Ship it'] }] });
  });
  await expect(thumbs(page)).toHaveCount(4);
});
