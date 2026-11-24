import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FX, FX_TYPES, applyOps, checkProject, emptyProject, envelopeAt, extractRange, normFx, normalizeProject, parseOps, parseProjectJson, projectDuration, serializeProject, summarizeProject, splitClipAt, newClip,
} from '../src/extensions/audioeditor/audio.ts';
import {
  analyze, applyFx, biquadCoef, applyBiquad, decodeWav, describeAnalysis, encodeWav, fft, findClipping, findSilence, generate, loudness, renderProject, resampleBy, spectrogram, spectrum, timeStretch, truePeakDb, waveformPeaks,
} from '../src/extensions/audioeditor/audioDsp.ts';

const SR = 8000;
const run = (project, ops) => {
  const parsed = parseOps(ops);
  assert.deepEqual(parsed.errors, []);
  const result = applyOps(project, parsed.ops);
  assert.equal(result.error, undefined, result.error);
  return result.project;
};
const base = () => emptyProject('T', 44100);
const sine = (f, secs = 1, amp = 0.5, sr = SR) => Float32Array.from({ length: Math.round(secs * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const db = (v) => 20 * Math.log10(v);
const tone = (extra = {}) => ({ op: 'generate', type: 'tone', track: 't1', start: 0, duration: 2, freq: 440, amp: 0.5, ...extra });
const mkProject = (extra = []) => run({ ...emptyProject('T', 8000) }, [tone(), ...extra]);

test('FFT of a sine peaks in the right bin and the inverse restores the signal', () => {
  const N = 1024, re = new Float64Array(N), im = new Float64Array(N), x = sine(1000, N / SR);
  for (let i = 0; i < N; i++) re[i] = x[i];
  fft(re, im);
  let best = 0; for (let k = 1; k < N / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
  assert.equal(best, Math.round((1000 * N) / SR));
  fft(re, im, true);
  assert.ok(Math.abs(re[10] - x[10]) < 1e-9);
});

test('a new project, generate and clip ops build a track of clips', () => {
  const p = run(base(), [tone({ duration: 3 }), { op: 'generate', type: 'noise', color: 'pink', start: 3, duration: 1, amp: 0.2 }, { op: 'generate', type: 'silence', start: 4, duration: 1 }]);
  assert.equal(p.tracks[0].clips.length, 3);
  assert.equal(projectDuration(p), 5);
  assert.equal(p.tracks[0].clips[1].gen.color, 'pink');
  assert.match(summarizeProject(p), /440 Hz/);
});

test('ops are all-or-nothing and unknown input is reported', () => {
  const p = base();
  const bad = applyOps(p, [tone(), { op: 'clip_set', clip: 'nope', gain: 2 }]);
  assert.match(bad.error, /op 2/);
  assert.equal(bad.project, p, 'the original project comes back untouched');
  assert.equal(p.tracks[0].clips.length, 0);
  assert.match(parseOps([{ op: 'bogus' }]).errors[0], /unknown op/);
  assert.match(parseOps('not json').errors[0], /not valid JSON/);
  assert.match(applyOps(p, [{ op: 'effect', effect: 'warp', from: 0, to: 1 }]).error, /./);
});

test('splitting keeps source alignment, also for reversed clips', () => {
  const c = { ...newClip('c1', 0, 4), asset: 'a1', offset: 10, speed: 2 };
  const [l, r] = splitClipAt(c, 1, 'c2');
  assert.equal(l.offset, 10); assert.equal(r.offset, 12); assert.equal(r.start, 1); assert.equal(r.duration, 3);
  const rev = { ...c, reverse: true };
  const [rl, rr] = splitClipAt(rev, 1, 'c2');
  assert.equal(rr.offset, 10, 'the later part of the timeline plays the earlier source when reversed');
  assert.equal(rl.offset, 16);
});

test('range delete ripples later audio left; ripple false leaves silence', () => {
  let p = run(base(), [tone({ duration: 6 })]);
  const rip = run(p, [{ op: 'range_delete', from: 2, to: 4 }]);
  assert.equal(projectDuration(rip), 4);
  assert.deepEqual(rip.tracks[0].clips.map((c) => [c.start, c.duration]), [[0, 2], [2, 2]]);
  const gap = run(p, [{ op: 'range_silence', from: 2, to: 4 }]);
  assert.equal(projectDuration(gap), 6);
  assert.deepEqual(gap.tracks[0].clips.map((c) => [c.start, c.duration]), [[0, 2], [4, 2]]);
  p = run(p, [{ op: 'select', start: 1, end: 2 }, { op: 'range_delete' }]);
  assert.equal(projectDuration(p), 5, 'no from/to means the selection');
});

test('insert silence, duplicate, repeat, trim, join, reverse', () => {
  const base2 = run(base(), [tone({ duration: 2 })]);
  const ins = run(base2, [{ op: 'insert_silence', at: 1, duration: 0.5 }]);
  assert.equal(projectDuration(ins), 2.5);
  const dup = run(base2, [{ op: 'range_duplicate', from: 0, to: 1, at: 2 }]);
  assert.equal(projectDuration(dup), 3);
  const rep = run(base2, [{ op: 'repeat', from: 0, to: 1, count: 2 }]);
  assert.equal(projectDuration(rep), 4);
  const tr = run(base2, [{ op: 'trim', from: 0.5, to: 1.5 }]);
  assert.equal(projectDuration(tr), 1); assert.equal(tr.tracks[0].clips[0].start, 0);
  const joined = run(base(), [tone({ duration: 1 }), tone({ start: 3, duration: 1 }), { op: 'join', clips: ['c1', 'c2'] }]);
  assert.equal(projectDuration(joined), 2);
  const rev = run(base2, [{ op: 'reverse', from: 0, to: 2 }]);
  assert.equal(rev.tracks[0].clips[0].reverse, true);
});

test('effect ops split at the range edges and keep the effect on the covered clips only', () => {
  const p = run(base(), [tone({ duration: 4 }), { op: 'effect', effect: 'amplify', params: { db: 6 }, from: 1, to: 2 }]);
  const clips = p.tracks[0].clips;
  assert.equal(clips.length, 3);
  assert.deepEqual(clips.map((c) => c.fx.length), [0, 1, 0]);
  assert.equal(clips[1].fx[0].p.db, 6);
  const limited = run(p, [{ op: 'effect', effect: 'amplify', params: { db: 999 }, from: 0, to: 1 }]);
  assert.equal(limited.tracks[0].clips[0].fx[0].p.db, 60, 'parameters are clamped to the catalogue range');
  assert.match(applyOps(p, [{ op: 'effect', effect: 'amplify', from: 10, to: 11 }]).error, /no audio/);
});

test('fade_in over a range ramps the covered clips so gain reaches 1 at the end', () => {
  const p = run(base(), [tone({ duration: 4 }), { op: 'fade_in', from: 0, to: 2 }, { op: 'fade_out', from: 3, to: 4 }]);
  const mix = renderProject({ ...p, sampleRate: 44100 }, {});
  const x = mix.channels[0];
  assert.ok(peak(x.subarray(0, 441)) < 0.01, 'starts silent');
  assert.ok(peak(x.subarray(Math.round(2.2 * 44100), Math.round(2.8 * 44100))) > 0.45, 'full volume after the fade');
  assert.ok(peak(x.subarray(x.length - 200)) < 0.02, 'ends silent');
});

test('speed, tempo and pitch ops change length or pitch as documented', () => {
  const p0 = run(base(), [tone({ duration: 4 })]);
  const fast = run(p0, [{ op: 'speed', factor: 2, from: 0, to: 4 }]);
  assert.equal(projectDuration(fast), 2); assert.equal(fast.tracks[0].clips[0].speed, 2);
  const tempo = run(p0, [{ op: 'tempo', factor: 0.5, from: 0, to: 4 }]);
  assert.equal(projectDuration(tempo), 8);
  const pitch = run(p0, [{ op: 'pitch', semitones: 12, from: 0, to: 4 }]);
  assert.equal(projectDuration(pitch), 4); assert.equal(pitch.tracks[0].clips[0].pitch, 12);
  const mid = run(p0, [{ op: 'speed', factor: 2, from: 1, to: 3 }]);
  assert.equal(projectDuration(mid), 3, 'audio after the changed part moves up');
});

test('envelope, labels, selection, tracks, master', () => {
  let p = run(base(), [tone({ duration: 4 }), { op: 'envelope_set', clip: 'c1', points: [{ t: 0, v: 1 }, { t: 2, v: 0 }] }]);
  assert.equal(envelopeAt(p.tracks[0].clips[0].envelope, 1), 0.5);
  p = run(p, [{ op: 'label_add', start: 1.5, text: 'intro' }, { op: 'label_add', start: 1, end: 2, text: 'verse' }, { op: 'label_set', label: 'l1', text: 'Intro!' }]);
  assert.deepEqual(p.labels.map((l) => l.text), ['verse', 'Intro!']);
  p = run(p, [{ op: 'label_remove', label: 'l2' }, { op: 'track_add', kind: 'mono', name: 'Voice' }, { op: 'track_set', track: 't2', solo: true, pan: -0.5, view: 'both' }, { op: 'master_effect', effect: 'limiter', params: { ceiling: -2 } }]);
  assert.equal(p.labels.length, 1); assert.equal(p.tracks[1].kind, 'mono'); assert.equal(p.master[0].p.ceiling, -2);
  p = run(p, [{ op: 'select', start: 1, end: 2, tracks: ['t2'] }]);
  assert.deepEqual(p.selection, { start: 1, end: 2, tracks: ['t2'] });
  assert.equal(run(p, [{ op: 'select', none: true }]).selection, null);
  assert.match(applyOps(p, [{ op: 'track_set', track: 't1', locked: true }, { op: 'range_delete', from: 0, to: 1, track: 't1' }]).error, /locked/);
});

test('paste puts extracted clips at a new position', () => {
  const p0 = run(base(), [tone({ duration: 4 })]);
  const clip = extractRange(p0, 1, 2);
  assert.equal(clip.length, 1); assert.equal(clip[0].duration, 1);
  const p1 = run(p0, [{ op: 'paste', at: 6, track: 't1', clips: clip }]);
  assert.equal(projectDuration(p1), 7);
});

test('normalizeProject repairs damaged files', () => {
  const { project, warnings } = normalizeProject({ title: 5, sampleRate: 7, tracks: [{ kind: 'weird', clips: [{ start: -3, duration: 99999, asset: 'ghost', fx: [{ type: 'amplify', p: { db: 500 } }, { type: 'nope' }] }] }] });
  assert.equal(project.sampleRate, 44100);
  assert.equal(project.tracks[0].kind, 'stereo');
  assert.ok(project.tracks[0].clips[0].duration <= 7200);
  assert.equal(project.tracks[0].clips[0].fx.length, 1);
  assert.equal(project.tracks[0].clips[0].fx[0].p.db, 60);
  assert.ok(warnings.some((w) => /missing asset/.test(w)));
  assert.equal(parseProjectJson('{{{', 'x').warnings.length, 1);
  const round = parseProjectJson(serializeProject(mkProject()), 'x').project;
  assert.equal(round.tracks[0].clips[0].gen.freq, 440);
});

test('every catalogued effect validates its own defaults', () => {
  for (const type of FX_TYPES) {
    const fx = normFx(type, {});
    assert.equal(typeof fx, 'object', type);
    for (const [k, s] of Object.entries(FX[type].params)) assert.equal(fx.p[k], s.def, `${type}.${k}`);
  }
  assert.equal(typeof normFx('nope', {}), 'string');
});

test('generators make the expected tones', () => {
  const t = generate({ type: 'tone', wave: 'sine', freq: 1000, freq2: 0, amp: 0.5, color: 'white', bpm: 120 }, 1, SR);
  assert.ok(Math.abs(peak(t) - 0.5) < 0.01);
  assert.ok(Math.abs(rms(t) - 0.5 / Math.SQRT2) < 0.01);
  const noise = generate({ type: 'noise', wave: 'sine', freq: 0, freq2: 0, amp: 0.5, color: 'white', bpm: 0 }, 1, SR);
  assert.ok(rms(noise) > 0.2 && rms(noise) < 0.35);
  const sil = generate({ type: 'silence', wave: 'sine', freq: 0, freq2: 0, amp: 0.5, color: 'white', bpm: 0 }, 0.5, SR);
  assert.equal(peak(sil), 0);
  const chirp = generate({ type: 'chirp', wave: 'sine', freq: 200, freq2: 2000, amp: 0.5, color: 'white', bpm: 0 }, 1, SR);
  assert.ok(peak(chirp) > 0.4);
});

test('amplify, invert, normalize and loudnorm change levels precisely', () => {
  const x = [sine(440)];
  assert.ok(Math.abs(db(peak(applyFx({ type: 'amplify', p: { db: 6 } }, x, SR)[0]) / 0.5) - 6) < 0.01);
  const inv = applyFx({ type: 'invert', p: {} }, x, SR)[0];
  assert.ok(Math.abs(inv[5] + x[0][5]) < 1e-6);
  const norm = applyFx({ type: 'normalize', p: { peak: -3, dc: true } }, x, SR)[0];
  assert.ok(Math.abs(db(peak(norm)) + 3) < 0.05);
  const loud = applyFx({ type: 'loudnorm', p: { target: -20, ceiling: -1 } }, [sine(440, 6, 0.9, 48000)], 48000);
  assert.ok(Math.abs(loudness(loud, 48000).integrated + 20) < 0.5);
});

test('loudness of a full-scale 997 Hz-ish sine follows BS.1770 (−3.01 LUFS per channel pair rule)', () => {
  const x = sine(1000, 5, 1, 48000);
  const l = loudness([x], 48000);
  assert.ok(Math.abs(l.integrated - -3.7) < 0.7, `mono full-scale sine ≈ −3.7 LUFS, got ${l.integrated}`);
  const stereo = loudness([x, x], 48000);
  assert.ok(Math.abs(stereo.integrated - (l.integrated + 3.01)) < 0.1, 'two identical channels add 3 dB');
  assert.equal(loudness([new Float32Array(48000)], 48000).integrated, -Infinity);
  const quiet = loudness([sine(1000, 5, 0.1, 48000), sine(1000, 5, 0.1, 48000)], 48000);
  assert.ok(Math.abs(stereo.integrated - quiet.integrated - 20) < 0.1, '−20 dB amplitude is −20 LU');
});

test('true peak reports inter-sample peaks above the sample peak', () => {
  const x = new Float32Array(400); for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 11025 * i) / 44100 + Math.PI / 4) * 0.99;
  assert.ok(truePeakDb([x]) >= 20 * Math.log10(peak(x)) - 0.01);
});

test('filters attenuate the right frequencies', () => {
  const mix = Float32Array.from({ length: SR * 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 100 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 2000 * i) / SR));
  const hp = applyFx({ type: 'hpf', p: { freq: 800, slope: 24 } }, [mix], SR)[0].subarray(SR);
  const lp = applyFx({ type: 'lpf', p: { freq: 800, slope: 24 } }, [mix], SR)[0].subarray(SR);
  const at = (x, f) => { let a = 0, b = 0; for (let i = 0; i < x.length; i++) { a += x[i] * Math.sin((2 * Math.PI * f * i) / SR); b += x[i] * Math.cos((2 * Math.PI * f * i) / SR); } return Math.hypot(a, b) / x.length * 2; };
  assert.ok(at(hp, 100) < 0.02 && at(hp, 2000) > 0.27, 'high-pass keeps 2 kHz, removes 100 Hz');
  assert.ok(at(lp, 2000) < 0.02 && at(lp, 100) > 0.27, 'low-pass keeps 100 Hz, removes 2 kHz');
  const notch = applyFx({ type: 'notch', p: { freq: 100, q: 20, harmonics: 0 } }, [mix], SR)[0].subarray(SR);
  assert.ok(at(notch, 100) < 0.05 && at(notch, 2000) > 0.27);
  const eq = applyFx({ type: 'eq', p: { low: 0, lowmid: 0, mid: 0, highmid: 12, high: 0 } }, [sine(3500, 1)], SR)[0].subarray(4000);
  assert.ok(peak(eq) > 0.5 * 3, 'a +12 dB band at 3.5 kHz roughly quadruples the amplitude');
  const coef = biquadCoef('peak', 1000, 1, 0, SR);
  const same = applyBiquad(sine(1000, 0.2), coef);
  assert.ok(Math.abs(peak(same) - 0.5) < 0.01, 'peak filter with 0 dB gain is transparent');
});

test('compressor reduces loud parts, limiter never exceeds its ceiling, gate silences quiet parts', () => {
  const loud = sine(440, 1, 0.9), quiet = sine(440, 1, 0.05);
  const x = new Float32Array(SR * 2); x.set(quiet, 0); x.set(loud, SR);
  const c = applyFx({ type: 'compressor', p: { threshold: -20, ratio: 4, attack: 1, release: 50, knee: 0, makeup: 0, auto: false } }, [x], SR)[0];
  assert.ok(peak(c.subarray(SR + 4000)) < 0.6, 'loud part is turned down');
  assert.ok(Math.abs(peak(c.subarray(2000, SR - 100)) - 0.05) < 0.01, 'quiet part passes unchanged');
  const lim = applyFx({ type: 'limiter', p: { ceiling: -6, release: 50, lookahead: 5 } }, [Float32Array.from(x, (v) => v * 1.5)], SR)[0];
  assert.ok(peak(lim) <= 0.5012 + 1e-4, `limiter ceiling −6 dB = 0.501, got ${peak(lim)}`);
  assert.ok(peak(lim) > 0.45, 'and it does not over-reduce');
  const g = applyFx({ type: 'gate', p: { threshold: -20, reduction: 60, attack: 1, hold: 5, release: 20 } }, [x], SR)[0];
  assert.ok(peak(g.subarray(1000, SR - 2000)) < 0.005, 'quiet part gated');
  assert.ok(peak(g.subarray(SR + 2000)) > 0.8);
});

test('noise reduction lowers a hiss floor while keeping a tone', () => {
  const sr = 16000, len = sr * 3, noise = generate({ type: 'noise', wave: 'sine', freq: 0, freq2: 0, amp: 0.05, color: 'white', bpm: 0 }, 3, sr);
  const x = new Float32Array(len); for (let i = 0; i < len; i++) x[i] = noise[i] + (i > sr ? 0.4 * Math.sin((2 * Math.PI * 700 * i) / sr) : 0);
  const out = applyFx({ type: 'noisereduce', p: { reduction: 24, sensitivity: 6, smoothing: 3, profileFrom: -1, profileTo: -1 } }, [x], sr)[0];
  const before = rms(x.subarray(0, sr * 0.9)), after = rms(out.subarray(0, sr * 0.9));
  assert.ok(db(after / before) < -8, `noise-only part should drop by >8 dB, dropped ${db(after / before).toFixed(1)}`);
  const tone = rms(out.subarray(sr * 2, sr * 3)) / rms(x.subarray(sr * 2, sr * 3));
  assert.ok(tone > 0.8, `the tone survives (${tone.toFixed(2)})`);
});

test('click removal repairs a spike; hum removal removes 50 Hz', () => {
  const x = sine(300, 1, 0.4); const clean = x.slice(); x[4000] = 0.95; x[4001] = -0.9;
  const out = applyFx({ type: 'declick', p: { sensitivity: 40, width: 10 } }, [x], SR)[0];
  assert.ok(peak(out.subarray(3990, 4010)) < 0.5);
  assert.ok(Math.abs(out[1000] - clean[1000]) < 1e-6, 'untouched samples stay identical');
  const hum = Float32Array.from({ length: SR * 4 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 50 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 1000 * i) / SR));
  assert.ok(analyze([hum], SR).hum?.freq === 50);
  const cleaned = applyFx({ type: 'dehum', p: { freq: 50, harmonics: 3, q: 30 } }, [hum], SR)[0];
  assert.equal(analyze([cleaned.subarray(SR * 2)], SR).hum, null);
});

test('reverb adds a tail, echo repeats, chorus/distortion/tremolo/mono run', () => {
  const imp = new Float32Array(SR); imp[0] = 1;
  const rv = applyFx({ type: 'reverb', p: { room: 0.8, damp: 0.3, wet: 0.5, predelay: 0 } }, [imp], SR)[0];
  assert.ok(peak(rv.subarray(2000)) > 0.001, 'tail rings after the impulse');
  const e = applyFx({ type: 'echo', p: { delay: 0.25, decay: 0.5, repeats: 2 } }, [imp], SR)[0];
  assert.ok(Math.abs(e[SR / 4] - 0.5) < 1e-6 && Math.abs(e[SR / 2] - 0.25) < 1e-6);
  const s = [sine(440, 0.5)];
  for (const type of ['chorus', 'distortion', 'tremolo', 'deesser', 'bass', 'treble']) {
    const out = applyFx({ type, p: normFx(type, {}).p }, s, SR)[0];
    assert.equal(out.length, s[0].length, type); assert.ok(out.every(Number.isFinite), type);
  }
  const lr = [sine(440, 0.1), sine(880, 0.1)];
  assert.deepEqual([...applyFx({ type: 'mono', p: { mode: 'swap' } }, lr, SR)[0].subarray(0, 4)], [...lr[1].subarray(0, 4)]);
  assert.ok(peak(applyFx({ type: 'mono', p: { mode: 'vocal' } }, [sine(440, 0.1), sine(440, 0.1)], SR)[0]) < 1e-6, 'centre-panned content is cancelled');
});

test('resampling and time stretching keep pitch and length where they should', () => {
  const x = sine(500, 1);
  const up = resampleBy(x, 2);
  assert.ok(Math.abs(up.length - SR / 2) <= 1);
  const dominant = (y) => { const N = 4096, re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = y[i] ?? 0; fft(re, im); let b = 1; for (let k = 1; k < N / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[b], im[b])) b = k; return (b * SR) / N; };
  assert.ok(Math.abs(dominant(up) - 1000) < 5, 'twice as fast = an octave up');
  const slow = timeStretch(sine(500, 2), 0.5, SR);
  assert.ok(Math.abs(slow.length - SR * 4) <= 2);
  assert.ok(Math.abs(dominant(slow.subarray(2000)) - 500) < 8, 'time stretch keeps the pitch');
});

test('renderProject mixes tracks with gain, balance, mute and solo, then the master limiter', () => {
  let p = run(emptyProject('T', 8000), [tone({ duration: 1 }), { op: 'track_add', kind: 'mono', name: 'B' }, { op: 'generate', type: 'tone', track: 't2', duration: 1, freq: 440, amp: 0.5 }]);
  let mix = renderProject(p, {});
  assert.ok(Math.abs(peak(mix.channels[0]) - 1) < 0.02, 'two identical tones sum');
  p = run(p, [{ op: 'track_set', track: 't2', mute: true }]);
  assert.ok(Math.abs(peak(renderProject(p, {}).channels[0]) - 0.5) < 0.02);
  p = run(p, [{ op: 'track_set', track: 't2', mute: false, solo: true }]);
  assert.ok(Math.abs(peak(renderProject(p, {}).channels[0]) - 0.5) < 0.02, 'solo plays only that track');
  p = run(p, [{ op: 'track_set', track: 't2', solo: false, pan: 1 }]);
  mix = renderProject(p, { master: false });
  assert.ok(Math.abs(peak(mix.channels[0]) - 0.5) < 0.02, 'right-panned mono track leaves the left at the first track only');
  p = run(p, [{ op: 'master_effect', effect: 'limiter', params: { ceiling: -12 } }]);
  assert.ok(peak(renderProject(p, {}).channels[1]) <= 0.2512 + 1e-3);
});

test('clips from an imported asset are cut from the right place in the source (including reversed)', () => {
  const src = { sampleRate: 8000, channels: [Float32Array.from({ length: 8000 }, (_, i) => i / 8000)] };
  let p = run(emptyProject('T', 8000), [{ op: 'track_add', kind: 'mono' }, { op: 'asset_add', path: '.pigry/audio/media/ramp.wav', duration: 1, sampleRate: 8000, channels: 1 }, { op: 'clip_add', asset: 'a1', track: 't2', start: 0, offset: 0.5, duration: 0.25 }]);
  let x = renderProject({ ...p, tracks: [p.tracks[1]] }, { a1: src }).channels[0];
  assert.ok(Math.abs(x[0] - 0.5) < 0.001 && Math.abs(x[1999] - 0.75) < 0.001);
  p = run(p, [{ op: 'clip_set', clip: 'c1', reverse: true }]);
  x = renderProject({ ...p, tracks: [p.tracks[1]] }, { a1: src }).channels[0];
  assert.ok(Math.abs(x[0] - 0.75) < 0.001 && Math.abs(x[1999] - 0.5) < 0.001);
  assert.ok(checkProject(p).every((w) => !/missing asset/.test(w)));
});

test('analysis finds clipping, silence, loudness and the band balance', () => {
  const x = new Float32Array(SR * 3); x.set(sine(440, 1, 1.2).map((v) => Math.max(-1, Math.min(1, v))), 0);
  const a = analyze([x], SR, { silenceDb: -50, minSilence: 0.5 });
  assert.ok(a.clipping.samples > 0 && a.clipping.ranges[0].start < 1);
  assert.deepEqual(a.silences.map((r) => [Math.round(r.start), Math.round(r.end)]), [[1, 3]]);
  assert.ok(a.peakDb > -0.1 && a.truePeakDb >= a.peakDb - 0.1);
  assert.match(describeAnalysis(a, -16), /clipping present/);
  assert.equal(findSilence(sine(440, 1), SR).length, 0);
  assert.equal(findClipping([sine(440, 1, 0.5)], SR).samples, 0);
});

test('spectrum and spectrogram locate a tone; peaks summarise a waveform', () => {
  const sp = spectrum(sine(1000, 2), SR);
  let b = 1; for (let k = 1; k < sp.db.length; k++) if (sp.db[k] > sp.db[b]) b = k;
  assert.ok(Math.abs(b * sp.binHz - 1000) < 10);
  const sg = spectrogram(sine(1000, 2), SR, 50, 512, 4000);
  assert.equal(sg.db.length, sg.cols * sg.bins);
  const col = sg.db.subarray(10 * sg.bins, 11 * sg.bins); let m = 0; for (let k = 1; k < col.length; k++) if (col[k] > col[m]) m = k;
  assert.ok(Math.abs(m * sg.binHz - 1000) < 30);
  const pk = waveformPeaks(sine(100, 1), 10);
  assert.equal(pk.length, 20); assert.ok(pk[1] > 0.4 && pk[0] < -0.4);
});

test('WAV round trip at 16, 24 and 32-bit, with stereo and header checks', () => {
  const l = sine(440, 0.25, 0.5), r = sine(660, 0.25, 0.25);
  for (const bits of [16, 24, 32]) {
    const bytes = encodeWav([l, r], SR, bits);
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
    assert.equal(bytes.length, 44 + l.length * 2 * (bits / 8));
    const back = decodeWav(bytes);
    assert.equal(back.sampleRate, SR); assert.equal(back.channels.length, 2);
    const tol = bits === 16 ? 2e-4 : bits === 24 ? 2e-7 : 1e-9;
    assert.ok(Math.abs(back.channels[0][100] - l[100]) < tol + 1e-6, `${bits}-bit left`);
    assert.ok(Math.abs(back.channels[1][100] - r[100]) < tol + 1e-6, `${bits}-bit right`);
  }
  assert.throws(() => decodeWav(new Uint8Array(100)), /not a WAV/);
  const hot = decodeWav(encodeWav([Float32Array.of(2, -2)], SR, 16, false));
  assert.ok(hot.channels[0][0] > 0.99 && hot.channels[0][1] < -0.99, 'PCM export clips instead of wrapping');
});

test('checkProject flags overlaps, missing master limiter and limiter order', () => {
  const p = run(base(), [tone({ duration: 3 }), tone({ start: 2, duration: 3 }), { op: 'track_add' }, { op: 'generate', type: 'tone', track: 't2', duration: 1 },
    { op: 'effect', effect: 'limiter', from: 0, to: 1, track: 't1' }, { op: 'effect', effect: 'amplify', from: 0, to: 1, track: 't1', params: { db: 3 } }]);
  const warns = checkProject(p).join('\n');
  assert.match(warns, /overlap/); assert.match(warns, /master limiter/); assert.match(warns, /limiter is followed/);
  assert.match(checkProject(base())[0], /empty/);
  assert.match(describeAnalysis(analyze([new Float32Array(SR)], SR)), /Peak/);
});
