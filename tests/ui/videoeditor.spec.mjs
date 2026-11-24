import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** Gives the mock backend a real in-memory worktree so video files and imported media persist. */
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
      if (cmd === 'read_binary_file' && window.__binary.has(args.path)) {
        const data = window.__binary.get(args.path);
        const mime = args.path.endsWith('.png') ? 'image/png' : args.path.endsWith('.webm') ? 'video/webm' : 'application/octet-stream';
        return { data, mime, size: data.length };
      }
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
  await page.getByRole('button', { name: 'Video Editor', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Video Editor', level: 2 })).toBeVisible();
}

async function createVideo(page, name, kind = 'Blank', aspect) {
  await page.getByRole('button', { name: 'New video' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New video' });
  await dialog.getByLabel('Video name').fill(name);
  await dialog.getByRole('radio', { name: new RegExp(kind) }).click();
  if (aspect) await dialog.getByLabel('Aspect ratio').selectOption(aspect);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible();
}

const stored = async (page, slug) => JSON.parse(await page.evaluate((s) => window.__worktree.get(`.pigry/videos/user/${s}.video.json`), slug));
const allClips = (p) => p.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, track: t.id })));
const clipBtn = (page, kind, text) => page.getByRole('button', { name: new RegExp(`^${kind} clip c\\d+: ${text ?? ''}`) }).first();
/** Mean colour of the preview canvas as [r, g, b, nonBlackPixelsFraction]. */
const paint = (page) => page.evaluate(() => {
  const c = document.querySelector('canvas[aria-label="Video preview"]');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let r = 0, gr = 0, b = 0, lit = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; if (d[i] + d[i + 1] + d[i + 2] > 30) lit++; }
  return [Math.round(r / n), Math.round(gr / n), Math.round(b / n), lit / n];
});
const timeText = (page) => page.getByTestId('time').innerText();

test('Video Editor is a built-in extension menu', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await page.getByRole('button', { name: 'Video Editor', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Video Editor', level: 2 })).toBeVisible();
  await expect(page.getByText('Cut, layer and animate video the CapCut way')).toBeVisible();
});

test('a motion promo is created, drawn on the canvas, and saved', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'demo', 'Motion promo', '9:16');
  await expect(page.getByTestId('timeline')).toBeVisible();
  for (const name of ['Main', 'Overlay', 'Text', 'Audio']) await expect(page.getByTestId('timeline').getByText(name, { exact: true }).first()).toBeVisible();
  await expect(clipBtn(page, 'text', 'MAKE IT')).toBeVisible();
  await expect(clipBtn(page, 'synth')).toBeVisible();
  await expect.poll(async () => (await paint(page))[3], { message: 'the first scene is painted' }).toBeGreaterThan(0.3);
  await expect.poll(async () => (await stored(page, 'demo')).tracks.length).toBeGreaterThanOrEqual(5);
  const p = await stored(page, 'demo');
  expect(p.width).toBe(1080); expect(p.height).toBe(1920);
  const canvas = await page.getByTestId('preview').boundingBox();
  expect(canvas.height / canvas.width).toBeCloseTo(16 / 9, 1);
});

test('playback advances the playhead; Home and the arrow keys move it', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'play', 'Motion promo');
  expect(await timeText(page)).toContain('00:00.0');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => timeText(page), { timeout: 8000 }).not.toContain('00:00.0 /');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByLabel('Video editor').focus();
  await page.keyboard.press('Home');
  await expect.poll(() => timeText(page)).toContain('00:00.0 /');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => timeText(page)).toContain('00:01.0 /');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => timeText(page)).toMatch(/00:01\.0 \//); // one frame = 0.03 s, still shows 1.0
  await page.getByRole('button', { name: 'Go to end' }).click();
  await expect.poll(() => timeText(page)).toContain('00:12');
});

test('editing a text clip in the properties panel updates the video, the file, and undo/redo', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'edit', 'Motion promo');
  await clipBtn(page, 'text', 'EDIT FAST').click();
  const props = page.getByLabel('Clip properties');
  await expect(props.getByLabel('Text content')).toHaveValue('EDIT FAST');
  await props.getByLabel('Text content').fill('NEW WORDS');
  await expect(clipBtn(page, 'text', 'NEW WORDS')).toBeVisible();
  await props.getByRole('slider', { name: 'Opacity' }).fill('0.5');
  await expect.poll(async () => allClips(await stored(page, 'edit')).find((c) => c.text?.text === 'NEW WORDS')?.opacity).toBe(0.5);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => allClips(await stored(page, 'edit')).find((c) => c.text?.text === 'NEW WORDS')?.opacity).toBe(1);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => allClips(await stored(page, 'edit')).find((c) => c.text?.text === 'NEW WORDS')?.opacity).toBe(0.5);
});

test('split, duplicate and delete work from the toolbar and the keyboard', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'cuts', 'Motion promo');
  const before = allClips(await stored(page, 'cuts')).length;
  const scene = page.getByRole('button', { name: /^shape clip c1:/ });
  await scene.click();
  await page.getByRole('button', { name: 'Go to start' }).click();
  await page.getByLabel('Video editor').focus();
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); // 2.0 s
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect.poll(async () => allClips(await stored(page, 'cuts')).length).toBe(before + 1);
  const p = await stored(page, 'cuts');
  const main = p.tracks[0].clips;
  expect(main[0].duration).toBeCloseTo(2, 1); expect(main[1].start).toBeCloseTo(2, 1);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect.poll(async () => allClips(await stored(page, 'cuts')).length).toBe(before + 2);
  await page.keyboard.press('Delete');
  await expect.poll(async () => allClips(await stored(page, 'cuts')).length).toBe(before + 1);
});

test('dragging a clip edge trims it and dragging the body moves it', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'drag', 'Motion promo');
  const clip = clipBtn(page, 'text', 'EDIT FAST');
  const startBefore = allClips(await stored(page, 'drag')).find((c) => c.text?.text === 'EDIT FAST');
  const box = await clip.boundingBox();
  // move right by 60 px (= 1 s at the default zoom)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => allClips(await stored(page, 'drag')).find((c) => c.text?.text === 'EDIT FAST').start).toBeCloseTo(startBefore.start + 1, 1);
  const moved = await clip.boundingBox();
  // trim the right edge by 30 px (0.5 s)
  await page.mouse.move(moved.x + moved.width - 3, moved.y + moved.height / 2);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width - 33, moved.y + moved.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => allClips(await stored(page, 'drag')).find((c) => c.text?.text === 'EDIT FAST').duration).toBeCloseTo(startBefore.duration - 0.5, 1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => allClips(await stored(page, 'drag')).find((c) => c.text?.text === 'EDIT FAST').duration).toBeCloseTo(startBefore.duration, 1);
});

test('the library adds text, stickers, music, filters, effects and transitions', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'lib', 'Blank', '16:9');
  const lib = page.getByRole('complementary', { name: 'Media library' });
  await lib.getByRole('tab', { name: 'Text' }).click();
  await lib.getByRole('button', { name: 'Neon' }).click();
  await expect.poll(async () => allClips(await stored(page, 'lib')).filter((c) => c.kind === 'text').length).toBe(1);
  await lib.getByRole('tab', { name: 'Stickers' }).click();
  await lib.getByRole('button', { name: 'Sticker 🔥' }).click();
  await lib.getByRole('button', { name: 'Sunset' }).click();
  await lib.getByRole('tab', { name: 'Audio' }).click();
  await lib.getByRole('button', { name: 'Upbeat beat' }).click();
  await expect.poll(async () => { const c = allClips(await stored(page, 'lib')); return [c.some((x) => x.kind === 'sticker'), c.some((x) => x.kind === 'shape'), c.some((x) => x.kind === 'synth')]; }).toEqual([true, true, true]);
  // filter + effect apply to the selected clip
  await clipBtn(page, 'shape').click();
  await lib.getByRole('tab', { name: 'Filters' }).click();
  await lib.getByRole('button', { name: 'Noir' }).click();
  await lib.getByRole('tab', { name: 'Effects' }).click();
  await lib.getByRole('button', { name: /Glitch/ }).click();
  await expect.poll(async () => { const s = allClips(await stored(page, 'lib')).find((c) => c.kind === 'shape'); return [s.filter, s.effect]; }).toEqual(['noir', 'glitch']);
  // transition: needs a second clip adjacent to the first on the Main track
  await lib.getByRole('tab', { name: 'Stickers' }).click();
  await lib.getByRole('button', { name: 'Ocean' }).click();
  await page.getByLabel('Clip properties').getByLabel('Start').fill('4'); // right after the first background
  await lib.getByRole('tab', { name: 'Transitions' }).click();
  await lib.getByRole('button', { name: 'Slide left' }).click();
  await expect.poll(async () => allClips(await stored(page, 'lib')).filter((c) => c.transitionIn).map((c) => c.transitionIn.type)).toEqual(['slide-left']);
  await expect(lib.getByRole('button', { name: 'Slide left' })).toHaveClass(/ve-card--on/);
});

test('captions are generated from a script and keep readable limits', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'caps', 'Blank', '9:16');
  const lib = page.getByRole('complementary', { name: 'Media library' });
  await lib.getByRole('tab', { name: 'Captions' }).click();
  await lib.getByLabel('Caption script').fill('We made this editor so you can cut a video quickly. Add music, drop in captions, and export when it looks right.');
  await lib.getByRole('button', { name: /Generate captions/ }).click();
  await expect.poll(async () => allClips(await stored(page, 'caps')).filter((c) => c.name === 'caption').length).toBeGreaterThanOrEqual(4);
  const caps = allClips(await stored(page, 'caps')).filter((c) => c.name === 'caption');
  for (const c of caps) { expect(c.text.text.length).toBeLessThanOrEqual(24); expect(c.duration).toBeGreaterThanOrEqual(1); }
  await page.getByRole('navigation', { name: 'Video menu' }).getByRole('button', { name: 'View' }).click();
  await page.getByRole('menuitemcheckbox', { name: /Caption safe zone/ }).click();
  await expect(page.locator('.ve__safe--tall')).toBeVisible();
});

test('keyframes can be added at the playhead and removed', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'keys', 'Motion promo');
  await clipBtn(page, 'text', 'EDIT FAST').click();
  const props = page.getByLabel('Clip properties');
  await props.getByRole('button', { name: 'Add Scale keyframe' }).click();
  await expect.poll(async () => allClips(await stored(page, 'keys')).find((c) => c.text?.text === 'EDIT FAST').keyframes.scale?.length).toBe(1);
  await props.getByRole('button', { name: 'Clear Scale keyframes' }).click();
  await expect.poll(async () => allClips(await stored(page, 'keys')).find((c) => c.text?.text === 'EDIT FAST').keyframes.scale).toBeUndefined();
});

test('an imported image is stored in the workspace, shown on the canvas and added to the timeline', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'media', 'Blank', '16:9');
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const g = c.getContext('2d'); g.fillStyle = '#e02020'; g.fillRect(0, 0, 160, 90);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const lib = page.getByRole('complementary', { name: 'Media library' });
  await lib.getByLabel('Import media files').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(lib.getByRole('list', { name: 'Project media' }).getByText('red.png')).toBeVisible();
  const files = await page.evaluate(() => [...window.__binary.keys()]);
  expect(files.some((f) => f.startsWith('.pigry/videos/media/') && f.endsWith('red.png'))).toBe(true);
  await lib.getByRole('button', { name: 'Add red.png to the timeline' }).click();
  await expect(clipBtn(page, 'image', 'red.png')).toBeVisible();
  await expect.poll(async () => { const [r, g, b] = await paint(page); return r > 150 && g < 80 && b < 80; }, { message: 'the picture is drawn on the canvas' }).toBe(true);
  await page.getByLabel('Clip properties').getByLabel('Fit').selectOption('cover');
  await expect.poll(async () => allClips(await stored(page, 'media'))[0]?.fit).toBe('cover');
});

test('clicking the preview selects the clip under the pointer and dragging moves it', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'stage', 'Motion promo');
  await page.getByRole('button', { name: 'Go to start' }).click();
  await page.getByLabel('Video editor').focus();
  await page.keyboard.press('Shift+ArrowRight'); // 1 s: the title is on screen
  const stage = await page.getByTestId('stage').boundingBox();
  await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height * 0.6);
  await expect(page.getByLabel('Clip properties').getByLabel('Text content')).toHaveValue(/MAKE IT/);
  const before = allClips(await stored(page, 'stage')).find((c) => c.text?.text.startsWith('MAKE IT')).y;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height * 0.6 - 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => allClips(await stored(page, 'stage')).find((c) => c.text?.text.startsWith('MAKE IT')).y).toBeLessThan(before - 0.02);
});

test('project settings: ratio, review warnings and renaming', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'proj', 'Blank', '9:16');
  const panel = page.getByLabel('Project settings');
  await expect(panel.getByText('The video is empty')).toBeVisible();
  await page.getByLabel('Canvas ratio').selectOption('1:1');
  await expect.poll(async () => { const p = await stored(page, 'proj'); return [p.width, p.height]; }).toEqual([1080, 1080]);
  await panel.getByLabel('Project title').fill('Renamed');
  await expect.poll(async () => (await stored(page, 'proj')).title).toBe('Renamed');
});

test('the shortcuts window lists the editing keys', async ({ page }) => {
  await setup(page);
  await createVideo(page, 'keys2', 'Blank');
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByText('Split the selected clip at the playhead')).toBeVisible();
});

test('the Video Producer agent has the tools, skills and the guide entry', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { VIDEO_TOOLS } = await import('/src/extensions/videoeditor/videoTools.ts');
    const run = (name, input) => VIDEO_TOOLS.find((t) => t.name === name).run({ agent: 'tester', ...input });
    const out = {};
    out.names = VIDEO_TOOLS.map((t) => t.name);
    out.written = await run('video_write', {
      name: 'teaser', aspect: '9:16', ops: [
        { op: 'clip_add', kind: 'shape', track: 't1', start: 0, duration: 4, shape: { shape: 'rect', w: 1, h: 1, color: '#2255ff', color2: '#ff2288', angle: 120 } },
        { op: 'clip_add', kind: 'text', text: 'Hello video', style: 'title', start: 0.3, duration: 3 }, { op: 'anim_set', clip: 'last', which: 'in', type: 'pop' },
        { op: 'clip_add', kind: 'synth', synth: { preset: 'beat' }, duration: 4, volume: 0.6 },
      ],
    });
    out.dup = await run('video_write', { name: 'teaser' });
    out.bad = await run('video_edit', { name: 'teaser', ops: [{ op: 'clip_set', clip: 'c99', opacity: 0.5 }] });
    out.read = await run('video_read', { name: 'teaser' });
    out.edited = await run('video_edit', { name: 'teaser', ops: JSON.stringify([{ op: 'captions', text: 'A short script that becomes captions.', start: 0.5, end: 3.5 }]) });
    out.preview = await run('video_preview', { name: 'teaser', at: [0.5, 2] });
    out.png = await run('video_export', { name: 'teaser', format: 'png', at: 1 });
    out.badPath = await run('video_export', { name: 'teaser', format: 'png', path: '../escape.png' });
    out.other = await run('video_edit', { name: 'someone/teaser', ops: [{ op: 'marker_add', t: 1 }] });
    out.opened = await run('video_open', { name: 'teaser' });
    out.list = await run('video_list', {});
    out.files = [...window.__worktree.keys()].filter((k) => k.startsWith('.pigry/videos'));
    out.binaries = [...window.__binary.keys()];
    return out;
  });
  expect(result.names).toEqual(['video_list', 'video_read', 'video_write', 'video_edit', 'video_preview', 'video_export', 'video_open']);
  expect(result.written).toContain('saved .pigry/videos/tester/teaser.video.json');
  expect(result.dup).toContain('already exists');
  expect(result.bad).toMatch(/error: op 1 \(clip_set\).*no clip "c99"/);
  expect(result.read).toContain('Hello video'); expect(result.read).toContain('Review:');
  expect(result.edited).toContain('caption clip(s)');
  expect(result.preview).toContain('contact sheet');
  expect(result.png).toContain('saved .pigry/videos/tester/teaser.png');
  expect(result.badPath).toContain('must stay inside .pigry/');
  expect(result.other).toMatch(/error: .*someone/);
  expect(result.opened).toContain('opened "tester/teaser"');
  expect(result.list).toContain('tester/teaser');
  expect(result.files).toEqual(['.pigry/videos/tester/teaser.video.json']);
  expect(result.binaries).toContain('.pigry/videos/tester/teaser.png');
  // the editor shows what the agent built
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(clipBtn(page, 'text', 'Hello video')).toBeVisible();
});

test('export saves a WebM with sound to the workspace', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await createVideo(page, 'tiny', 'Title card');
  // make the video short so the real-time export is quick
  const done = await page.evaluate(async () => {
    const { VIDEO_TOOLS } = await import('/src/extensions/videoeditor/videoTools.ts');
    const t = VIDEO_TOOLS.find((x) => x.name === 'video_write');
    return t.run({ agent: 'user', name: 'tiny2', ops: [
      { op: 'clip_add', kind: 'shape', track: 't1', start: 0, duration: 1.2, shape: { shape: 'rect', w: 1, h: 1, color: '#20a050' } },
      { op: 'clip_add', kind: 'synth', synth: { preset: 'tone' }, duration: 1.2 },
    ] });
  });
  expect(done).toContain('saved');
  await page.getByRole('button', { name: /^Export$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Save video to the workspace only/ }).click();
  await expect(dialog.getByRole('status')).toContainText('Saved .pigry/videos/user/', { timeout: 30_000 });
  const keys = await page.evaluate(() => [...window.__binary.keys()]);
  expect(keys.some((k) => k.endsWith('.webm'))).toBe(true);
  const size = await page.evaluate(() => window.__binary.get([...window.__binary.keys()].find((k) => k.endsWith('.webm'))).length);
  expect(size).toBeGreaterThan(500);
});
