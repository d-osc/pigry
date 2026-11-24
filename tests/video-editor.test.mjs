import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANIMATIONS, ASPECTS, EFFECTS, FILTERS, TRANSITIONS, TEXT_STYLES, applyOps, captionCues, checkProject, emptyProject, ease, filterCss, gainAt, keyframeValue, layersAt, noteFreq,
  normalizeProject, parseOps, parseProjectJson, projectDuration, serializeProject, summarizeProject, synthEvents, templateProject, transitionMotion,
} from '../src/extensions/videoeditor/video.ts';

const run = (project, ops) => {
  const parsed = parseOps(ops);
  assert.deepEqual(parsed.errors, []);
  const result = applyOps(project, parsed.ops);
  assert.equal(result.error, undefined, result.error);
  return result.project;
};
const base = () => emptyProject('T', '16:9');
const shape = (extra = {}) => ({ op: 'clip_add', kind: 'shape', track: 't1', shape: { shape: 'rect', w: 1, h: 1, color: '#f00' }, ...extra });

test('easing curves start at 0, end at 1 and stay monotonic where they should', () => {
  for (const id of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back', 'bounce']) {
    assert.ok(Math.abs(ease(id, 0)) < 1e-9, `${id} starts at 0`);
    assert.ok(Math.abs(ease(id, 1) - 1) < 1e-9, `${id} ends at 1`);
  }
  assert.equal(ease('hold', 0.99), 0);
  assert.ok(ease('ease-in', 0.5) < 0.5 && ease('ease-out', 0.5) > 0.5);
});

test('a new project has the CapCut-style tracks and the chosen aspect ratio', () => {
  const p = emptyProject('x', '9:16');
  assert.deepEqual([p.width, p.height], [1080, 1920]);
  assert.deepEqual(p.tracks.map((t) => t.kind), ['video', 'video', 'video', 'audio']);
  assert.equal(projectDuration(p), 0);
  for (const [name, a] of Object.entries(ASPECTS)) assert.ok(a.w > 0 && a.h > 0, name);
});

test('clips are added to sensible default tracks and chain back to back', () => {
  let p = run(base(), [
    { op: 'clip_add', kind: 'shape', duration: 2 }, { op: 'clip_add', kind: 'shape', duration: 3 },
    { op: 'clip_add', kind: 'text', text: 'Hi', duration: 2 }, { op: 'clip_add', kind: 'synth', duration: 5 },
  ]);
  assert.equal(p.tracks[1].clips.length, 2, 'shapes go to the Overlay track');
  assert.equal(p.tracks[1].clips[1].start, 2, 'the second clip starts where the first ends');
  assert.equal(p.tracks[2].clips[0].text.text, 'Hi');
  assert.equal(p.tracks[3].clips[0].kind, 'synth');
  assert.equal(projectDuration(p), 5);
});

test('operations are all-or-nothing and error messages name the op', () => {
  const p = base();
  const result = applyOps(p, parseOps([shape({ duration: 2 }), { op: 'clip_set', clip: 'nope', opacity: 0.5 }]).ops);
  assert.match(result.error, /op 2 \(clip_set\).*no clip "nope"/);
  assert.equal(result.project, p, 'the original project is returned untouched');
  assert.equal(parseOps([{ op: 'explode' }]).errors.length, 1);
  assert.ok(applyOps(p, parseOps([{ op: 'clip_add', kind: 'video' }]).ops).error.includes('needs an asset'));
  assert.ok(applyOps(p, parseOps([shape({ bogus: 1 })]).ops).error.includes('bogus is not a clip property'));
  assert.ok(applyOps(p, parseOps([{ op: 'clip_add', kind: 'synth', track: 't1' }]).ops).error.includes('audio track'));
});

test('split, trim, move, duplicate and ripple delete keep media in sync', () => {
  let p = run(base(), [
    { op: 'asset_add', path: 'clips/a.mp4', duration: 10 }, { op: 'clip_add', asset: 'a1', track: 't1', start: 0, duration: 10 },
    { op: 'clip_split', clip: 'c1', at: 4 },
  ]);
  const [first, second] = p.tracks[0].clips;
  assert.equal(first.duration, 4); assert.equal(second.start, 4); assert.equal(second.offset, 4, 'the second half continues where the first stopped');
  p = run(p, [{ op: 'clip_trim', clip: second.id, from: 5, to: 9 }]);
  const trimmed = p.tracks[0].clips[1];
  assert.deepEqual([trimmed.start, trimmed.duration, trimmed.offset], [5, 4, 5], 'trimming the head moves the in-point, not the picture');
  p = run(p, [{ op: 'clip_duplicate', clip: first.id, start: 20 }, { op: 'clip_delete', clip: first.id, ripple: true }]);
  assert.equal(p.tracks[0].clips.find((c) => c.start === 16)?.duration, 4, 'ripple delete closes the 4 s gap');
  assert.ok(applyOps(p, parseOps([{ op: 'clip_split', clip: trimmed.id, at: 100 }]).ops).error.includes('must fall inside'));
});

test('speed stretches the source: 2× reads twice as much media', () => {
  const p = run(base(), [{ op: 'asset_add', path: 'a.mp4', duration: 10 }, { op: 'clip_add', asset: 'a1', track: 't1', start: 0, duration: 4, speed: 2, offset: 1 }]);
  const [layer] = layersAt(p, 1);
  assert.equal(layer.src, 3, 'at 1 s timeline, 2× speed from 1 s reads source second 3');
  assert.ok(checkProject(run(p, [{ op: 'clip_set', clip: 'c1', duration: 6 }])).some((w) => /plays past the end/.test(w)));
});

test('keyframes interpolate with their easing and split keeps both halves continuous', () => {
  let p = run(base(), [shape({ duration: 4 }), { op: 'keyframe_set', clip: 'c1', prop: 'scale', t: 0, v: 1, ease: 'linear' }, { op: 'keyframe_set', clip: 'c1', prop: 'scale', t: 4, v: 2 }]);
  assert.equal(keyframeValue(p.tracks[0].clips[0].keyframes.scale, 2, 1), 1.5);
  assert.equal(layersAt(p, 3)[0].scale, 1.75);
  p = run(p, [{ op: 'clip_split', clip: 'c1', at: 2 }]);
  const [a, b] = p.tracks[0].clips;
  assert.equal(keyframeValue(a.keyframes.scale, 2, 0), 1.5); assert.equal(keyframeValue(b.keyframes.scale, 0, 0), 1.5); assert.equal(keyframeValue(b.keyframes.scale, 2, 0), 2);
  assert.ok(applyOps(p, parseOps([{ op: 'keyframe_set', clip: 'c1', prop: 'scale', t: 99, v: 1 }]).ops).error.includes('seconds from the clip start'));
  p = run(p, [{ op: 'keyframe_clear', clip: 'c1', prop: 'scale' }]);
  assert.equal(p.tracks[0].clips[0].keyframes.scale, undefined);
});

test('fades and animations shape opacity, scale and position over time', () => {
  const p = run(base(), [shape({ duration: 4, fadeIn: 1, fadeOut: 1 }), { op: 'anim_set', clip: 'c1', which: 'in', type: 'slide-left', duration: 1 }]);
  assert.ok(layersAt(p, 0.25)[0].opacity < 0.3);
  assert.ok(layersAt(p, 0.25)[0].x > 0.2, 'slides in from the right');
  assert.equal(layersAt(p, 2)[0].opacity, 1);
  assert.ok(layersAt(p, 3.75)[0].opacity < 0.3);
  assert.equal(layersAt(p, 4.5).length, 0, 'nothing after the clip ends');
  for (const type of Object.keys(ANIMATIONS)) assert.ok(applyOps(p, [{ op: 'anim_set', clip: 'c1', which: 'out', type: type === 'typewriter' ? 'fade' : type }]).error === undefined, type);
  assert.ok(applyOps(p, [{ op: 'anim_set', clip: 'c1', type: 'typewriter' }]).error.includes('text clips'));
});

test('a transition keeps the previous clip on screen while the next one comes in', () => {
  const p = run(base(), [shape({ duration: 3 }), shape({ duration: 3, shape: { shape: 'rect', w: 1, h: 1, color: '#00f' } }), { op: 'transition_set', clip: 'c2', type: 'slide-left', duration: 1 }]);
  assert.equal(layersAt(p, 2.9).length, 1);
  const mid = layersAt(p, 3.5);
  assert.equal(mid.length, 2, 'outgoing + incoming');
  assert.equal(mid[0].clip.id, 'c1'); assert.equal(mid[0].outgoing, true); assert.ok(mid[0].x < 0, 'old slides out to the left');
  assert.equal(mid[1].clip.id, 'c2'); assert.ok(mid[1].x > 0, 'new slides in from the right');
  assert.equal(layersAt(p, 4.2).length, 1);
  for (const type of Object.keys(TRANSITIONS)) {
    const a = transitionMotion(type, 0), b = transitionMotion(type, 1);
    assert.ok(a.inc.opacity <= 1 && b.inc.opacity >= 0.99 || b.inc.wipe || type === 'fade-black', type);
    assert.ok(Math.abs(b.inc.dx) < 1e-6 && Math.abs(b.inc.dy) < 1e-6, `${type} ends at rest`);
  }
  assert.ok(applyOps(p, [{ op: 'transition_set', clip: 'c2', type: 'teleport' }]).error.includes('must be one of'));
  assert.equal(run(p, [{ op: 'transition_set', clip: 'c2', type: 'none' }]).tracks[0].clips[1].transitionIn, null);
});

test('filters, adjustments and effects produce CSS and motion', () => {
  const p = run(base(), [shape({ duration: 2, filter: 'bw', adjust: { brightness: 20, blur: 30 }, effect: 'shake', effectAmount: 1 })]);
  const [layer] = layersAt(p, 0.5);
  assert.match(layer.css, /grayscale\(1\)/); assert.match(layer.css, /brightness\(/); assert.match(layer.css, /blur\(3px\)/);
  assert.equal(filterCss(p.tracks[0].clips[0].constructor === Object ? { ...p.tracks[0].clips[0], filter: 'none', adjust: { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, vignette: 0, grain: 0 } } : null), 'none');
  assert.ok(layer.fx.dx !== 0 || layer.fx.rot !== 0, 'shake moves the layer');
  assert.ok(Object.keys(FILTERS).length >= 12 && Object.keys(EFFECTS).length >= 8);
  assert.ok(applyOps(p, [{ op: 'clip_set', clip: 'c1', filter: 'nope' }]).error.includes('filter must be one of'));
});

test('text clips: styles, typewriter reveal and edits', () => {
  const p = run(base(), [{ op: 'clip_add', kind: 'text', text: 'Hello world', style: 'caption', duration: 3 }, { op: 'anim_set', clip: 'c1', which: 'in', type: 'typewriter', duration: 2 }]);
  const clip = p.tracks[2].clips[0];
  assert.equal(clip.text.strokeWidth, 8); assert.equal(clip.y, TEXT_STYLES.caption.y);
  assert.equal(layersAt(p, 1)[0].reveal, 0.5);
  assert.equal(layersAt(p, 2.5)[0].reveal, 1);
  const edited = run(p, [{ op: 'clip_set', clip: 'c1', text: { text: 'Bye', size: 9, color: '#ff0' } }]).tracks[2].clips[0].text;
  assert.deepEqual([edited.text, edited.size, edited.color], ['Bye', 9, '#ff0']);
  assert.ok(applyOps(p, [{ op: 'clip_set', clip: 'c1', text: { colour: 'red' } }]).error.includes('text.colour'));
});

test('caption cues respect line length, reading speed and a target window', () => {
  const script = 'We made this editor so you can cut a video quickly. Add music, drop in captions, and export when it looks right.';
  const cues = captionCues(script, 0, undefined, { maxChars: 28 });
  assert.ok(cues.length >= 4);
  for (const c of cues) { assert.ok(c.text.length <= 28, c.text); assert.ok(c.duration >= 1 && c.duration <= 6); }
  for (let i = 1; i < cues.length; i++) assert.ok(Math.abs(cues[i].start - (cues[i - 1].start + cues[i - 1].duration)) < 0.01, 'cues are back to back');
  const fitted = captionCues(script, 2, 12, { maxChars: 28 });
  assert.ok(Math.abs(fitted[fitted.length - 1].start + fitted[fitted.length - 1].duration - 12) < 0.1, 'the last cue ends at the requested time');
  assert.equal(captionCues('', 0).length, 0);
  const two = captionCues('one two three four five six seven eight', 0, undefined, { maxChars: 10, lines: 2 });
  assert.ok(two.some((c) => c.text.includes('\n')));
  const p = run(base(), [{ op: 'captions', text: script, start: 1, end: 11, track: 't3' }]);
  assert.ok(p.tracks[2].clips.length >= 3 && p.tracks[2].clips.every((c) => c.name === 'caption'));
});

test('ducking lowers the music only while someone is talking', () => {
  const p = run(base(), [
    { op: 'clip_add', kind: 'synth', track: 't4', start: 0, duration: 20, volume: 0.8 },
    { op: 'track_add', kind: 'audio', name: 'Voice' }, { op: 'clip_add', kind: 'synth', track: 't5', start: 5, duration: 4 }, { op: 'duck', clip: 'c1', under: ['t5'], db: 12 },
  ]);
  const music = p.tracks[3].clips[0];
  assert.equal(gainAt(music, 2), 0.8);
  assert.ok(Math.abs(gainAt(music, 7) - 0.8 * 10 ** (-12 / 20)) < 0.01);
  assert.equal(gainAt(music, 15), 0.8);
  assert.equal(gainAt({ ...music, muted: true }, 7), 0);
  assert.equal(gainAt(music, 7, true), 0);
  assert.ok(applyOps(p, [{ op: 'duck', clip: 'c1', under: ['t1'] }]).error.includes('nothing on those tracks'));
});

test('synth clips turn into scheduled notes', () => {
  assert.ok(Math.abs(noteFreq('A4') - 440) < 0.01); assert.ok(Math.abs(noteFreq('C4') - 261.63) < 0.05);
  const beat = synthEvents({ preset: 'beat', note: 'A2', bpm: 120, scale: 'minor', wave: 'sine' }, 4);
  assert.ok(beat.length > 8 && beat.every((e) => e.t < 4));
  assert.ok(beat.some((e) => e.kind === 'noise') && beat.some((e) => e.kind === 'osc' && e.sweepTo));
  assert.equal(synthEvents({ preset: 'pad', note: 'D3', bpm: 90, scale: 'major', wave: 'sine' }, 3).length, 3);
  assert.equal(synthEvents({ preset: 'click', note: 'A2', bpm: 90, scale: 'major', wave: 'sine' }, 3).length, 1);
});

test('checkProject flags the usual mistakes', () => {
  const p = run(emptyProject('x', '9:16'), [
    { op: 'clip_add', kind: 'shape', track: 't1', start: 0, duration: 3 }, { op: 'clip_add', kind: 'shape', track: 't1', start: 2, duration: 3 },
    { op: 'clip_add', kind: 'text', text: 'This is a really long caption line that nobody can read quickly', duration: 0.5, name: 'caption', y: 0.45 },
  ]);
  const warnings = checkProject(p).join('\n');
  assert.match(warnings, /overlap on the same track/); assert.match(warnings, /characters \(aim for/); assert.match(warnings, /characters\/second/); assert.match(warnings, /TikTok/); assert.match(warnings, /no sound/);
  assert.deepEqual(checkProject(emptyProject()), ['The video is empty — add clips.']);
});

test('ops cover tracks, markers, arrange, kenburns and project settings', () => {
  const p = run(base(), [
    { op: 'project', title: 'Reel', aspect: '1:1', fps: 24, background: '#111' },
    { op: 'track_add', kind: 'video', name: 'B-roll' }, { op: 'track_set', track: 't5', hidden: true, name: 'Cutaways' },
    shape({ duration: 2 }), shape({ duration: 2, start: 9 }), { op: 'arrange', clips: ['c1', 'c2'], gap: 0.5, start: 1 }, { op: 'kenburns', clip: 'c1', from: 1, to: 1.3 },
    { op: 'markers_bpm', bpm: 120, from: 0, to: 4, every: 2 }, { op: 'marker_add', t: 3.25, label: 'drop' },
  ]);
  assert.deepEqual([p.width, p.height, p.fps, p.title], [1080, 1080, 24, 'Reel']);
  assert.equal(p.tracks[4].name, 'Cutaways'); assert.equal(p.tracks[4].hidden, true);
  assert.deepEqual(p.tracks[0].clips.map((c) => c.start), [1, 3.5]);
  assert.equal(p.tracks[0].clips[0].keyframes.scale.length, 2);
  assert.ok(p.markers.length >= 3 && p.markers.some((m) => m.label === 'drop'));
  assert.equal(layersAt(run(p, [{ op: 'track_set', track: 't1', hidden: true }]), 1.5).length, 0, 'hidden tracks do not render');
  assert.ok(applyOps(p, [{ op: 'project', aspect: '5:7' }]).error.includes('aspect must be one of'));
  assert.equal(run(p, [{ op: 'track_remove', track: 't5' }]).tracks.length, 4);
});

test('save/load round-trips and bad files are repaired, not trusted', () => {
  const t = templateProject('promo', 'Promo');
  const again = parseProjectJson(serializeProject(t), 'x');
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(again.project, t);
  const broken = normalizeProject({ width: 99999, fps: 500, tracks: [{ id: 't1', kind: 'video', clips: [{ kind: 'shape', id: 'c1', start: -4, duration: 0, opacity: 7, filter: 'nope', asset: 'ghost' }, 'junk', { kind: 'text', id: 'c1', text: { size: 9999 } }] }] });
  const c = broken.project.tracks[0].clips;
  assert.equal(broken.project.width, 4096); assert.equal(broken.project.fps, 60);
  assert.equal(c[0].start, 0); assert.ok(c[0].duration >= 0.1); assert.equal(c[0].opacity, 1); assert.equal(c[0].filter, 'none'); assert.equal(c[0].asset, '');
  assert.notEqual(c[0].id, c[1].id, 'duplicate ids are renamed'); assert.equal(c[1].text.size, 60);
  assert.ok(broken.warnings.some((w) => w.includes('missing asset')));
  assert.equal(parseProjectJson('{oops', 'Fallback').project.title, 'Fallback');
});

test('the starter templates are valid, long enough to show off, and have no lint warnings that matter', () => {
  for (const kind of ['blank', 'promo', 'title']) {
    const p = templateProject(kind, kind);
    assert.equal(normalizeProject(JSON.parse(serializeProject(p))).warnings.length, 0, kind);
    if (kind !== 'blank') {
      assert.ok(projectDuration(p) >= 6, kind);
      assert.ok(layersAt(p, 1).length >= 3, `${kind} has layers at 1s`);
      assert.ok(summarizeProject(p).includes('Tracks'));
      assert.ok(!checkProject(p).some((w) => /missing asset|overlap/.test(w)), `${kind}: ${checkProject(p).join('; ')}`);
    }
  }
});
