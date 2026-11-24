import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { encodeWav } from '../../src/extensions/audioeditor/audioDsp.ts';

/** Gives the mock backend a real in-memory worktree so audio projects and imported media persist. */
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
      if (cmd === 'write_worktree_binary_chunk') {
        window.__binary.set(args.path, args.append ? btoa(atob(window.__binary.get(args.path) ?? '') + atob(args.data)) : args.data);
        window.__chunks = (window.__chunks ?? 0) + 1;
        return atob(window.__binary.get(args.path)).length;
      }
      if (cmd === 'read_binary_chunk' && window.__binary.has(args.path)) {
        const bin = atob(window.__binary.get(args.path));
        return { data: btoa(bin.slice(args.offset, args.offset + args.length)), size: bin.length };
      }
      if (cmd === 'read_binary_file' && window.__binary.has(args.path)) {
        const data = window.__binary.get(args.path);
        const mime = args.path.endsWith('.wav') ? 'audio/wav' : args.path.endsWith('.png') ? 'image/png' : 'application/octet-stream';
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
  await page.getByRole('button', { name: 'Audio Editor', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Audio Editor', level: 2 })).toBeVisible();
}

async function createAudio(page, name, kind = 'Blank', rate) {
  await page.getByRole('button', { name: 'New audio' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New audio project' });
  await dialog.getByLabel('Project name').fill(name);
  await dialog.getByRole('radio', { name: new RegExp(kind) }).click();
  if (rate) await dialog.getByLabel('Project rate').selectOption(String(rate));
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('timeline')).toBeVisible();
}

const stored = async (page, slug) => JSON.parse(await page.evaluate((s) => window.__worktree.get(`.pigry/audio/user/${s}.audio.json`), slug));
const allClips = (p) => p.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, track: t.id })));
const menu = async (page, name, item) => {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
/** Number of "waveform coloured" pixels in the first clip canvas (0 = nothing drawn). */
const inked = (page) => page.evaluate(() => {
  const c = document.querySelector('[data-clip] canvas');
  if (!c) return 0;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 180 && d[i] < 140) n++;
  return n;
});
const timeText = (page) => page.getByTestId('time').innerText();
const generateTone = async (page, seconds = 3) => {
  await menu(page, 'Generate', /^Tone/);
  const dialog = page.getByRole('dialog', { name: 'Generate Tone' });
  await dialog.getByLabel('Duration').fill(String(seconds));
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByRole('button', { name: /^Clip c\d+: 440 Hz sine/ }).first()).toBeVisible();
};
/** Drags a selection across the first track from second a to second b (80 px per second). */
const dragSelect = async (page, a, b) => {
  const lane = page.locator('.au-lane[data-track]').first();
  const box = await lane.boundingBox();
  await page.mouse.move(box.x + a * 80, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + b * 80, box.y + 20, { steps: 8 });
  await page.mouse.up();
};

test('Audio Editor is a built-in extension menu', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  await page.getByRole('button', { name: 'Audio Editor', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Audio Editor', level: 2 })).toBeVisible();
  await expect(page.getByText('Record, import and edit sound the Audacity way')).toBeVisible();
});

test('a podcast project is created with tracks, a menu bar and a saved file', async ({ page }) => {
  await setup(page);
  await createAudio(page, 'episode', 'Podcast', 48000);
  for (const name of ['Voice', 'Music', 'Effects']) await expect(page.getByLabel(`Name of ${name === 'Voice' ? 't1' : name === 'Music' ? 't2' : 't3'}`)).toHaveValue(name);
  for (const m of ['File', 'Edit', 'Select', 'View', 'Transport', 'Generate', 'Effect', 'Analyze']) await expect(page.getByRole('button', { name: m, exact: true })).toBeVisible();
  await expect.poll(async () => (await stored(page, 'episode')).tracks.length).toBe(3);
  const p = await stored(page, 'episode');
  expect(p.sampleRate).toBe(48000); expect(p.tracks[0].kind).toBe('mono'); expect(p.master[0].type).toBe('limiter');
  await expect(page.getByLabel('Project sample rate')).toHaveValue('48000');
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).first().click();
  await expect(page.getByText('Play / stop').first()).toBeVisible();
});

test('Generate ▸ Tone draws a waveform, plays, and moves the cursor', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await createAudio(page, 'tone');
  await generateTone(page, 3);
  await expect.poll(async () => allClips(await stored(page, 'tone')).length).toBe(1);
  await expect.poll(() => inked(page), { message: 'the waveform is painted' }).toBeGreaterThan(200);
  expect(await timeText(page)).toContain('00:00.000');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect.poll(() => timeText(page), { timeout: 8000 }).not.toContain('00:00.000 /');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.getByLabel('Audio editor').focus();
  await page.keyboard.press('End');
  await expect.poll(() => timeText(page)).toContain('00:03.000 /');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => timeText(page)).toContain('00:01.000 /');
});

test('selecting, deleting, undo/redo and the history list', async ({ page }) => {
  await setup(page);
  await createAudio(page, 'cuts');
  await generateTone(page, 4);
  await dragSelect(page, 1, 2);
  await expect(page.getByLabel('Selection length')).toHaveValue(/^1\.0\d\d$/);
  await page.keyboard.press('Delete');
  await expect.poll(async () => { const p = await stored(page, 'cuts'); return p.tracks[0].clips.map((c) => [c.start, c.duration]); }).toEqual([[0, 1], [1, 2]]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await stored(page, 'cuts')).tracks[0].clips.length).toBe(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await stored(page, 'cuts')).tracks[0].clips.length).toBe(2);
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('dialog', { name: 'History' });
  await expect(history.getByRole('button', { name: 'Delete' })).toBeVisible();
  await history.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(async () => (await stored(page, 'cuts')).tracks[0].clips.length).toBe(1);
});

test('copy, paste, silence, trim and split use the selection', async ({ page }) => {
  await setup(page);
  await createAudio(page, 'edit');
  await generateTone(page, 4);
  await dragSelect(page, 0, 1);
  await page.keyboard.press('Control+c');
  await page.getByRole('button', { name: 'Go to end' }).click();
  await page.getByRole('button', { name: 'Paste' }).click();
  await expect.poll(async () => allClips(await stored(page, 'edit')).length).toBe(2);
  await dragSelect(page, 1, 2);
  await page.keyboard.press('Control+l');
  await expect.poll(async () => (await stored(page, 'edit')).tracks[0].clips.length).toBeGreaterThanOrEqual(3);
  await dragSelect(page, 0, 3);
  await page.keyboard.press('Control+t');
  await expect.poll(async () => { const p = await stored(page, 'edit'); return Math.max(...allClips(p).map((c) => c.start + c.duration)); }).toBeCloseTo(3, 1);
});

test('an effect is applied to the selection from a dialog and can be undone', async ({ page }) => {
  await setup(page);
  await createAudio(page, 'fx');
  await generateTone(page, 4);
  await dragSelect(page, 1, 3);
  await menu(page, 'Effect', /^Amplify/);
  const dialog = page.getByRole('dialog', { name: 'Amplify' });
  await expect(dialog.getByTestId('effect-range')).toContainText('on the selected track');
  await dialog.getByLabel('Gain', { exact: true }).fill('-6');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => { const p = await stored(page, 'fx'); return p.tracks[0].clips.map((c) => c.fx.map((f) => `${f.type}:${f.p.db}`)); }).toEqual([[], ['amplify:-6'], []]);
  await menu(page, 'Effect', /^Fade in/);
  await expect.poll(async () => JSON.stringify((await stored(page, 'fx')).tracks[0].clips.flatMap((c) => c.fx.map((f) => f.type)))).toContain('ramp');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await menu(page, 'Effect', /^Repeat last effect/);
  await expect.poll(async () => JSON.stringify((await stored(page, 'fx')).tracks[0].clips.flatMap((c) => c.fx.map((f) => f.type)))).toContain('amplify');
});

test('noise reduction learns a profile from the selection', async ({ page }) => {
  await setup(page);
  await createAudio(page, 'nr');
  await generateTone(page, 4);
  await dragSelect(page, 0, 1);
  await menu(page, 'Effect', /^Noise reduction/);
  const dialog = page.getByRole('dialog', { name: 'Noise reduction' });
  await dialog.getByRole('button', { name: 'Get noise profile from the selection' }).click();
  await expect(dialog.getByText(/Profile: 0\.0\d–1\.\d\d s/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => { const c = allClips(await stored(page, 'nr')).flatMap((x) => x.fx).find((f) => f.type === 'noisereduce'); return c ? [c.p.reduction, c.p.sensitivity] : null; }).toEqual([12, 6]);
});

test('analysis reports loudness, peaks and the spectrum', async ({ page }) => {
  await setup(page);
  await createAudio(page, 'meter');
  await generateTone(page, 3);
  await menu(page, 'Analyze', /^Loudness and levels/);
  const dialog = page.getByRole('dialog', { name: 'Loudness and levels' });
  await expect(dialog.getByTestId('analysis')).toContainText('LUFS');
  await expect(dialog.getByTestId('analysis')).toContainText('Peak -6');
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await menu(page, 'Analyze', /^Plot spectrum/);
  await expect(page.getByRole('dialog', { name: 'Plot spectrum' }).getByRole('status')).toContainText('Peak at 4', { timeout: 5000 });
});

test('track controls: mute, solo, gain, pan and the spectrogram view are saved', async ({ page }) => {
  await setup(page);
  await createAudio(page, 'mix', 'Podcast');
  await page.getByRole('button', { name: 'Mute Voice' }).click();
  await page.getByRole('button', { name: 'Solo Music' }).click();
  await page.getByLabel('Gain of Music').fill('-12');
  await page.getByLabel('Pan of Effects').fill('0.5');
  await page.getByLabel('View of Voice').selectOption('spectrogram');
  await expect.poll(async () => { const p = await stored(page, 'mix'); return [p.tracks[0].mute, p.tracks[1].solo, p.tracks[1].gain, p.tracks[2].pan, p.tracks[0].view]; }).toEqual([true, true, 0.251, 0.5, 'spectrogram']);
  await menu(page, 'Edit', /^Add stereo track/);
  await expect.poll(async () => (await stored(page, 'mix')).tracks.length).toBe(4);
});

test('labels, the envelope tool and the time-shift tool edit the project', async ({ page }) => {
  await setup(page);
  await createAudio(page, 'tools');
  await generateTone(page, 4);
  await dragSelect(page, 1, 2);
  await page.keyboard.press('Control+b');
  await expect.poll(async () => (await stored(page, 'tools')).labels.map((l) => [l.start, l.end])).toEqual([[1, 2]]);
  await page.getByRole('button', { name: /^Label 1/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit label' });
  await dlg.getByLabel('Label text').fill('Chorus');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await stored(page, 'tools')).labels[0].text).toBe('Chorus');
  await page.getByRole('button', { name: 'Envelope tool' }).click();
  const clip = page.getByRole('button', { name: /^Clip c1:/ });
  const box = await clip.boundingBox();
  await page.mouse.click(box.x + 160, box.y + box.height * 0.8);
  await expect.poll(async () => (await stored(page, 'tools')).tracks[0].clips[0].envelope.length).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: 'Time shift tool' }).click();
  const b2 = await page.getByRole('button', { name: /^Clip c1:/ }).boundingBox();
  await page.mouse.move(b2.x + 100, b2.y + 40);
  await page.mouse.down();
  await page.mouse.move(b2.x + 260, b2.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await stored(page, 'tools')).tracks[0].clips[0].start).toBeCloseTo(2, 0);
});

test('a WAV file is imported, decoded, drawn and exported again as WAV', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await createAudio(page, 'imp');
  const sr = 22050, ch = Float32Array.from({ length: sr * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 330 * i) / sr));
  const wav = Buffer.from(encodeWav([ch], sr, 16));
  await page.getByLabel('Import audio files').setInputFiles({ name: 'voice.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.getByRole('button', { name: /^Clip c\d+: voice\.wav/ })).toBeVisible();
  await expect.poll(async () => { const p = await stored(page, 'imp'); return [p.assets[0]?.sampleRate, p.assets[0]?.channels, p.assets[0]?.duration, p.tracks[1]?.kind]; }).toEqual([22050, 1, 2, 'mono']);
  await expect.poll(async () => (await page.evaluate(() => [...window.__binary.keys()])).some((k) => k.startsWith('.pigry/audio/media/') && k.endsWith('voice.wav'))).toBe(true);
  await expect.poll(() => inked(page)).toBeGreaterThan(100);
  await page.getByRole('button', { name: /^Export$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export audio' });
  await dialog.getByLabel('Export format').selectOption('wav24');
  await dialog.getByRole('button', { name: 'Save to the workspace only' }).click();
  await expect(dialog.getByRole('status')).toContainText('Saved .pigry/audio/user/imp.wav', { timeout: 20_000 });
  const info = await page.evaluate(() => {
    const b64 = window.__binary.get('.pigry/audio/user/imp.wav'); const bin = atob(b64);
    return { magic: bin.slice(0, 4), wave: bin.slice(8, 12), bits: bin.charCodeAt(34), rate: bin.charCodeAt(24) | (bin.charCodeAt(25) << 8) | (bin.charCodeAt(26) << 16), size: bin.length };
  });
  expect(info.magic).toBe('RIFF'); expect(info.wave).toBe('WAVE'); expect(info.bits).toBe(24); expect(info.rate).toBe(44100);
  expect(info.size).toBeGreaterThan(44100 * 2 * 3 * 0.9);
});

test('the Sound Engineer agent has the tools, skills and the guide entry', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  const result = await page.evaluate(async () => {
    const { AUDIO_TOOLS } = await import('/src/extensions/audioeditor/audioTools.ts');
    const run = (name, input) => AUDIO_TOOLS.find((t) => t.name === name).run({ agent: 'tester', ...input });
    const out = {};
    out.names = AUDIO_TOOLS.map((t) => t.name);
    out.written = await run('audio_write', {
      name: 'jingle', template: 'podcast', sampleRate: 44100, ops: [
        { op: 'generate', type: 'tone', track: 't1', freq: 330, amp: 0.4, duration: 3 },
        { op: 'generate', type: 'noise', color: 'pink', track: 't2', amp: 0.05, duration: 3 },
        { op: 'effect', effect: 'compressor', params: { threshold: -24, ratio: 4 }, from: 0, to: 3, track: 't1' },
        { op: 'fade_out', from: 2.5, to: 3, track: 't1' },
        { op: 'label_add', start: 1.5, text: 'middle' },
      ],
    });
    out.dup = await run('audio_write', { name: 'jingle' });
    out.bad = await run('audio_edit', { name: 'jingle', ops: [{ op: 'clip_set', clip: 'c99', gain: 0.5 }] });
    out.read = await run('audio_read', { name: 'jingle' });
    out.edited = await run('audio_edit', { name: 'jingle', ops: JSON.stringify([{ op: 'master_effect', effect: 'loudnorm', params: { target: -16, ceiling: -1 } }]) });
    out.analyze = await run('audio_analyze', { name: 'jingle', target_lufs: -16 });
    out.track = await run('audio_analyze', { name: 'jingle', track: 't2' });
    out.preview = await run('audio_preview', { name: 'jingle', save_as: '.pigry/audio/tester/jingle-preview.png' });
    out.wav = await run('audio_export', { name: 'jingle', format: 'wav', bits: 24 });
    out.badPath = await run('audio_export', { name: 'jingle', format: 'wav', path: '../escape.wav' });
    out.badFormat = await run('audio_export', { name: 'jingle', format: 'mp3' });
    out.other = await run('audio_edit', { name: 'someone/jingle', ops: [{ op: 'label_add', start: 1 }] });
    out.foreign = await run('audio_write', { name: 'someone/else' });
    out.opened = await run('audio_open', { name: 'jingle' });
    out.list = await run('audio_list', {});
    out.files = [...window.__worktree.keys()].filter((k) => k.startsWith('.pigry/audio'));
    out.binaries = [...window.__binary.keys()];
    return out;
  });
  expect(result.names).toEqual(['audio_list', 'audio_read', 'audio_write', 'audio_edit', 'audio_preview', 'audio_analyze', 'audio_export', 'audio_open']);
  expect(result.written).toContain('saved .pigry/audio/tester/jingle.audio.json');
  expect(result.dup).toContain('already exists');
  expect(result.bad).toMatch(/error: op 1 \(clip_set\).*no clip "c99"/);
  expect(result.read).toContain('compressor('); expect(result.read).toContain('Review:'); expect(result.read).toContain('middle');
  expect(result.edited).toContain('master: Loudness normalize');
  expect(result.analyze).toMatch(/Loudness: integrated -1[5-7](\.\d)? LUFS/);
  expect(result.analyze).toContain('true peak');
  expect(result.track).toContain('track t2');
  expect(result.preview).toContain('attached to your next turn');
  expect(result.wav).toContain('saved .pigry/audio/tester/jingle.wav'); expect(result.wav).toContain('24-bit PCM');
  expect(result.badPath).toContain('must stay inside .pigry/');
  expect(result.badFormat).toContain('MP3');
  expect(result.other).toMatch(/error: .*someone/);
  expect(result.foreign).toContain('your own folder');
  expect(result.opened).toContain('opened "tester/jingle"');
  expect(result.list).toContain('tester/jingle');
  expect(result.files).toEqual(['.pigry/audio/tester/jingle.audio.json']);
  expect(result.binaries).toEqual(expect.arrayContaining(['.pigry/audio/tester/jingle.wav', '.pigry/audio/tester/jingle-preview.png']));
  // the editor shows what the agent built
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByLabel('Name of t1')).toHaveValue('Voice');
});

test('WebM export saves Opus audio to the workspace', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await createAudio(page, 'webm');
  await generateTone(page, 1);
  await page.getByRole('button', { name: /^Export$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export audio' });
  await dialog.getByLabel('Export format').selectOption('webm');
  await dialog.getByRole('button', { name: 'Save to the workspace only' }).click();
  await expect(dialog.getByRole('status')).toContainText('Saved .pigry/audio/user/webm.webm', { timeout: 30_000 });
  const size = await page.evaluate(() => window.__binary.get('.pigry/audio/user/webm.webm').length);
  expect(size).toBeGreaterThan(300);
});

test('a large WAV is copied in 6 MB pieces, drawn without copying and read back in pieces', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  await createAudio(page, 'big');
  const sr = 22050, secs = 300; // 300 s mono 16-bit = 13.2 MB, three 6 MB pieces
  const ch = Float32Array.from({ length: sr * secs }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / sr));
  const wav = Buffer.from(encodeWav([ch], sr, 16));
  expect(wav.length).toBeGreaterThan(13_000_000);
  await page.getByLabel('Import audio files').setInputFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.getByRole('button', { name: /^Clip c\d+: long\.wav/ })).toBeVisible({ timeout: 40_000 });
  expect(await page.evaluate(() => window.__chunks)).toBeGreaterThanOrEqual(3);
  const stored2 = await page.evaluate(() => atob([...window.__binary.entries()].find(([k]) => k.endsWith('long.wav'))[1]).length);
  expect(stored2).toBe(wav.length);
  await expect.poll(async () => { const p = await stored(page, 'big'); return [p.assets[0]?.duration, p.assets[0]?.sampleRate]; }).toEqual([300, 22050]);
  await expect.poll(() => inked(page), { timeout: 20_000 }).toBeGreaterThan(100);
});
