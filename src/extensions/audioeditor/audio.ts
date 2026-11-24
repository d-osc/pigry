/** Audio Editor project model — pure data and logic (no DOM, no Web Audio), so it runs in the editor, in the agent tools and in node tests.
 *
 * A project is a list of tracks (mono or stereo) holding clips: a clip is a region of an imported audio file (an "asset") or of
 * generated sound (tone, chirp, noise, silence, metronome). Everything the user does — cut, paste, fade, amplify, EQ, noise
 * reduction, reverse, change speed… — is an operation applied through `applyOps`, all-or-nothing, so the editor UI and the agent
 * share one code path. Effects are stored on the clip as a small "effect chain" and rendered by audioDsp.ts, which keeps the
 * project file small and every edit reversible (Audacity bakes effects into the samples; here they stay editable). */

export const AUDIO_DIR = '.pigry/audio/';
export const AUDIO_EXT = '.audio.json';
export const MEDIA_DIR = '.pigry/audio/media/';
export const MAX_DURATION = 7200;
export const MAX_CLIPS = 400;
export const MAX_TRACKS = 16;
export const MIN_CLIP = 0.005;
export const SAMPLE_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000];

export type TrackKind = 'mono' | 'stereo';
export type TrackView = 'wave' | 'spectrogram' | 'both';
export type FadeCurve = 'linear' | 'log' | 'cos';
export const FADE_CURVES: FadeCurve[] = ['linear', 'log', 'cos'];

export interface Fx { type: string; p: Record<string, unknown> }
export interface GenSpec { type: 'tone' | 'chirp' | 'noise' | 'silence' | 'click'; wave: 'sine' | 'square' | 'sawtooth' | 'triangle'; freq: number; freq2: number; amp: number; color: 'white' | 'pink' | 'brown'; bpm: number }
export interface EnvPoint { t: number; v: number }
export interface Clip {
  id: string; name: string; asset: string; gen: GenSpec | null;
  start: number; duration: number; offset: number;
  speed: number; tempo: number; pitch: number; reverse: boolean;
  gain: number; fadeIn: number; fadeOut: number; fadeCurve: FadeCurve; muted: boolean;
  envelope: EnvPoint[]; fx: Fx[];
}
export interface Track { id: string; name: string; kind: TrackKind; gain: number; pan: number; mute: boolean; solo: boolean; locked: boolean; view: TrackView; clips: Clip[] }
export interface Asset { id: string; name: string; path: string; duration: number; sampleRate: number; channels: number }
export interface Label { id: string; start: number; end: number; text: string }
export interface Selection { start: number; end: number; tracks: string[] }
export interface Project {
  version: 1; title: string; sampleRate: number;
  tracks: Track[]; assets: Asset[]; labels: Label[]; master: Fx[]; selection: Selection | null;
}

/* ---------------------------------------------------------------- effect catalogue (also drives the editor's effect dialog) */

export interface ParamSpec { def: number | string | boolean; min?: number; max?: number; step?: number; choices?: (string | number)[]; unit?: string; label: string }
export interface FxSpec { label: string; group: 'Volume' | 'EQ & filters' | 'Dynamics' | 'Restoration' | 'Time & pitch' | 'Space & colour' | 'Channels'; help: string; params: Record<string, ParamSpec> }
const P = (label: string, def: ParamSpec['def'], extra: Partial<ParamSpec> = {}): ParamSpec => ({ label, def, ...extra });

export const FX: Record<string, FxSpec> = {
  amplify: { label: 'Amplify', group: 'Volume', help: 'Raise or lower the level by a number of decibels (0 dB = unchanged; +6 dB ≈ twice the amplitude).', params: { db: P('Gain', 0, { min: -60, max: 60, step: 0.1, unit: 'dB' }) } },
  normalize: { label: 'Normalize (peak)', group: 'Volume', help: 'Scale so the highest peak reaches the target level; optionally remove DC offset first.', params: { peak: P('Peak level', -1, { min: -60, max: 0, step: 0.1, unit: 'dB' }), dc: P('Remove DC offset', true) } },
  loudnorm: { label: 'Loudness normalize', group: 'Volume', help: 'Set the integrated loudness (ITU-R BS.1770 LUFS) of this audio, then keep peaks under the ceiling.', params: { target: P('Target loudness', -16, { min: -40, max: -5, step: 0.1, unit: 'LUFS' }), ceiling: P('Peak ceiling', -1, { min: -20, max: 0, step: 0.1, unit: 'dB' }) } },
  invert: { label: 'Invert', group: 'Volume', help: 'Flip the waveform upside down (polarity). Inaudible alone; useful against phase problems.', params: {} },
  dcremove: { label: 'Remove DC offset', group: 'Restoration', help: 'Centre the waveform on zero (subtract the average).', params: {} },
  eq: { label: 'Graphic EQ (5 bands)', group: 'EQ & filters', help: 'Five fixed bands: low shelf 100 Hz, 400 Hz, 1 kHz, 3.5 kHz, high shelf 10 kHz. Pass "bands":[{"type":"peak|lowshelf|highshelf|lowpass|highpass|notch","f":Hz,"gain":dB,"q":n}] for a custom parametric EQ.', params: { low: P('100 Hz', 0, { min: -24, max: 24, step: 0.5, unit: 'dB' }), lowmid: P('400 Hz', 0, { min: -24, max: 24, step: 0.5, unit: 'dB' }), mid: P('1 kHz', 0, { min: -24, max: 24, step: 0.5, unit: 'dB' }), highmid: P('3.5 kHz', 0, { min: -24, max: 24, step: 0.5, unit: 'dB' }), high: P('10 kHz', 0, { min: -24, max: 24, step: 0.5, unit: 'dB' }) } },
  hpf: { label: 'High-pass filter', group: 'EQ & filters', help: 'Remove everything below the cutoff (rumble, plosives, handling noise).', params: { freq: P('Cutoff', 80, { min: 10, max: 2000, step: 1, unit: 'Hz' }), slope: P('Slope', 12, { choices: [12, 24, 48], unit: 'dB/oct' }) } },
  lpf: { label: 'Low-pass filter', group: 'EQ & filters', help: 'Remove everything above the cutoff (hiss, harshness, telephone effect).', params: { freq: P('Cutoff', 8000, { min: 200, max: 20000, step: 10, unit: 'Hz' }), slope: P('Slope', 12, { choices: [12, 24, 48], unit: 'dB/oct' }) } },
  notch: { label: 'Notch filter', group: 'EQ & filters', help: 'Cut one narrow frequency (and optionally its harmonics), e.g. a 50/60 Hz hum.', params: { freq: P('Frequency', 60, { min: 20, max: 20000, step: 1, unit: 'Hz' }), q: P('Q (narrowness)', 30, { min: 1, max: 100, step: 1 }), harmonics: P('Extra harmonics', 0, { min: 0, max: 10, step: 1 }) } },
  bass: { label: 'Bass boost / cut', group: 'EQ & filters', help: 'Low shelf: raise or lower everything below the frequency.', params: { db: P('Gain', 3, { min: -24, max: 24, step: 0.5, unit: 'dB' }), freq: P('Frequency', 100, { min: 40, max: 400, step: 5, unit: 'Hz' }) } },
  treble: { label: 'Treble boost / cut', group: 'EQ & filters', help: 'High shelf: raise or lower everything above the frequency (air, brightness).', params: { db: P('Gain', 3, { min: -24, max: 24, step: 0.5, unit: 'dB' }), freq: P('Frequency', 5000, { min: 1000, max: 12000, step: 50, unit: 'Hz' }) } },
  compressor: { label: 'Compressor', group: 'Dynamics', help: 'Reduce the level of loud parts above the threshold by the ratio; evens out a voice. Podcast starting point: ratio 2:1–4:1, attack 10 ms, release 100–200 ms.', params: { threshold: P('Threshold', -18, { min: -60, max: 0, step: 0.5, unit: 'dB' }), ratio: P('Ratio', 3, { min: 1, max: 20, step: 0.1, unit: ': 1' }), attack: P('Attack', 10, { min: 0.1, max: 200, step: 0.1, unit: 'ms' }), release: P('Release', 120, { min: 10, max: 2000, step: 5, unit: 'ms' }), knee: P('Knee', 6, { min: 0, max: 24, step: 0.5, unit: 'dB' }), makeup: P('Make-up gain', 0, { min: -12, max: 24, step: 0.1, unit: 'dB' }), auto: P('Auto make-up', false) } },
  limiter: { label: 'Limiter', group: 'Dynamics', help: 'Look-ahead brick-wall limiter: nothing exceeds the ceiling. Use last in a chain or on the master.', params: { ceiling: P('Ceiling', -1, { min: -20, max: 0, step: 0.1, unit: 'dB' }), release: P('Release', 50, { min: 1, max: 1000, step: 1, unit: 'ms' }), lookahead: P('Look-ahead', 5, { min: 0.5, max: 20, step: 0.5, unit: 'ms' }) } },
  gate: { label: 'Noise gate', group: 'Dynamics', help: 'Turn the level down while the signal is below the threshold (between words).', params: { threshold: P('Threshold', -50, { min: -80, max: 0, step: 0.5, unit: 'dB' }), reduction: P('Reduction', 40, { min: 0, max: 80, step: 1, unit: 'dB' }), attack: P('Attack', 5, { min: 0.1, max: 100, step: 0.1, unit: 'ms' }), hold: P('Hold', 50, { min: 0, max: 500, step: 5, unit: 'ms' }), release: P('Release', 150, { min: 5, max: 2000, step: 5, unit: 'ms' }) } },
  deesser: { label: 'De-esser', group: 'Dynamics', help: 'Tame harsh "s" and "t" sounds: turns the sibilance band down only when it gets loud.', params: { freq: P('Sibilance centre', 6500, { min: 3000, max: 12000, step: 100, unit: 'Hz' }), threshold: P('Threshold', -30, { min: -60, max: 0, step: 0.5, unit: 'dB' }), amount: P('Max reduction', 8, { min: 0, max: 24, step: 0.5, unit: 'dB' }) } },
  noisereduce: { label: 'Noise reduction', group: 'Restoration', help: 'Spectral gating à la Audacity: learns the noise spectrum from a noise-only part (profileFrom/profileTo, timeline seconds; default = the quietest 0.5 s) and turns matching frequencies down. Starting point 12 dB / sensitivity 6 / smoothing 3.', params: { reduction: P('Noise reduction', 12, { min: 0, max: 48, step: 1, unit: 'dB' }), sensitivity: P('Sensitivity', 6, { min: 0, max: 24, step: 0.1 }), smoothing: P('Frequency smoothing', 3, { min: 0, max: 12, step: 1, unit: 'bands' }), profileFrom: P('Noise profile start (source s)', -1, { min: -1, max: 100000, step: 0.01 }), profileTo: P('Noise profile end (source s)', -1, { min: -1, max: 100000, step: 0.01 }) } },
  declick: { label: 'Click removal', group: 'Restoration', help: 'Find sharp single-sample spikes (vinyl pops, mouth clicks) and replace them by interpolation.', params: { sensitivity: P('Sensitivity', 40, { min: 1, max: 100, step: 1 }), width: P('Max click width', 10, { min: 1, max: 50, step: 1, unit: 'samples' }) } },
  dehum: { label: 'Hum removal', group: 'Restoration', help: 'Notch out mains hum (50 Hz Europe/Asia, 60 Hz Americas) and its harmonics.', params: { freq: P('Mains frequency', 50, { choices: [50, 60], unit: 'Hz' }), harmonics: P('Harmonics', 4, { min: 1, max: 8, step: 1 }), q: P('Q', 30, { min: 5, max: 100, step: 1 }) } },
  reverb: { label: 'Reverb', group: 'Space & colour', help: 'Room simulation (Freeverb-style). Extend the clip with silence if you want the tail to ring out.', params: { room: P('Room size', 0.5, { min: 0, max: 1, step: 0.01 }), damp: P('Damping', 0.5, { min: 0, max: 1, step: 0.01 }), wet: P('Wet', 0.25, { min: 0, max: 1, step: 0.01 }), predelay: P('Pre-delay', 10, { min: 0, max: 200, step: 1, unit: 'ms' }) } },
  echo: { label: 'Echo / delay', group: 'Space & colour', help: 'Repeat the sound after a delay, each repeat quieter by the decay factor.', params: { delay: P('Delay', 0.4, { min: 0.01, max: 5, step: 0.01, unit: 's' }), decay: P('Decay', 0.5, { min: 0, max: 0.95, step: 0.01 }), repeats: P('Repeats', 4, { min: 1, max: 16, step: 1 }) } },
  chorus: { label: 'Chorus', group: 'Space & colour', help: 'Thicken the sound with slightly detuned, modulated copies.', params: { rate: P('Rate', 0.8, { min: 0.1, max: 5, step: 0.1, unit: 'Hz' }), depth: P('Depth', 3, { min: 0.5, max: 10, step: 0.1, unit: 'ms' }), mix: P('Mix', 0.5, { min: 0, max: 1, step: 0.01 }) } },
  distortion: { label: 'Distortion', group: 'Space & colour', help: 'Soft clip, hard clip, wave-fold or bit-crush (lo-fi).', params: { type: P('Type', 'soft', { choices: ['soft', 'hard', 'fold', 'bitcrush'] }), drive: P('Drive', 12, { min: 0, max: 40, step: 0.5, unit: 'dB' }), mix: P('Mix', 1, { min: 0, max: 1, step: 0.01 }), bits: P('Bits (bitcrush)', 8, { min: 2, max: 16, step: 1 }) } },
  tremolo: { label: 'Tremolo', group: 'Space & colour', help: 'Periodic volume wobble.', params: { rate: P('Rate', 5, { min: 0.1, max: 20, step: 0.1, unit: 'Hz' }), depth: P('Depth', 0.5, { min: 0, max: 1, step: 0.01 }) } },
  mono: { label: 'Channels: mix / swap', group: 'Channels', help: 'mix = both channels averaged, left / right = keep one side, swap = exchange left and right, vocal = cancel centre (vocal reduction).', params: { mode: P('Mode', 'mix', { choices: ['mix', 'left', 'right', 'swap', 'vocal'] }) } },
  ramp: { label: 'Fade ramp', group: 'Volume', help: 'Internal: gain ramp across the clip (written by fade_in / fade_out).', params: { from: P('Start gain', 0, { min: 0, max: 4, step: 0.01 }), to: P('End gain', 1, { min: 0, max: 4, step: 0.01 }), curve: P('Curve', 'linear', { choices: FADE_CURVES }) } },
};
export const FX_TYPES = Object.keys(FX);

export const GEN_TYPES = ['tone', 'chirp', 'noise', 'silence', 'click'] as const;

/* ---------------------------------------------------------------- helpers */

const num = (v: unknown, def: number, min = -Infinity, max = Infinity): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
export const round = (n: number, d = 4): number => { const k = 10 ** d; return Math.round(n * k) / k; };
const str = (v: unknown, def = '', max = 400): string => (typeof v === 'string' ? v.slice(0, max) : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const pick = <T extends string>(v: unknown, list: readonly T[], def: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : def);
const EPS = 1e-6;
export const dbToLin = (db: number): number => 10 ** (db / 20);
export const linToDb = (lin: number): number => (lin <= 1e-9 ? -180 : 20 * Math.log10(lin));
export const clipEnd = (c: Clip): number => round(c.start + c.duration);
/** Seconds of source material one clip-second consumes (speed and tempo both shorten the clip). */
export const rate = (c: Clip): number => c.speed * c.tempo;
export const sourceSpan = (c: Clip): number => c.duration * rate(c);
export const allClips = (p: Project): Clip[] => p.tracks.flatMap((t) => t.clips);
export const projectDuration = (p: Project): number => round(p.tracks.reduce((m, t) => t.clips.reduce((mm, c) => Math.max(mm, clipEnd(c)), m), 0));
export function findClip(p: Project, id: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) { const index = track.clips.findIndex((c) => c.id === id); if (index >= 0) return { track, clip: track.clips[index], index }; }
  return null;
}
export const findAsset = (p: Project, id: string): Asset | undefined => p.assets.find((a) => a.id === id);

export function defaultGen(type: GenSpec['type'] = 'tone'): GenSpec {
  return { type, wave: 'sine', freq: 440, freq2: 1000, amp: 0.5, color: 'white', bpm: 120 };
}
export function newClip(id: string, start = 0, duration = 1): Clip {
  return { id, name: '', asset: '', gen: null, start, duration, offset: 0, speed: 1, tempo: 1, pitch: 0, reverse: false, gain: 1, fadeIn: 0, fadeOut: 0, fadeCurve: 'linear', muted: false, envelope: [], fx: [] };
}
export function newTrack(id: string, name: string, kind: TrackKind = 'stereo'): Track {
  return { id, name, kind, gain: 1, pan: 0, mute: false, solo: false, locked: false, view: 'wave', clips: [] };
}
export function emptyProject(title = 'Untitled audio', sampleRate = 44100): Project {
  return { version: 1, title, sampleRate: SAMPLE_RATES.includes(sampleRate) ? sampleRate : 44100, tracks: [newTrack('t1', 'Audio Track')], assets: [], labels: [], master: [], selection: null };
}

/** Validates an effect's parameters against the catalogue: unknown params are dropped, numbers clamped, choices checked. */
export function normFx(type: string, raw: unknown): Fx | string {
  const spec = FX[type];
  if (!spec) return `unknown effect "${type}" (known: ${FX_TYPES.join(', ')})`;
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const p: Record<string, unknown> = {};
  for (const [key, s] of Object.entries(spec.params)) {
    const v = src[key];
    if (typeof s.def === 'boolean') p[key] = bool(v, s.def);
    else if (s.choices) {
      const found = s.choices.find((c) => c === v || String(c) === String(v));
      p[key] = found ?? s.def;
    } else if (typeof s.def === 'number') p[key] = round(num(v, s.def, s.min, s.max), 4);
    else p[key] = str(v, String(s.def), 40);
  }
  if (type === 'eq' && Array.isArray(src.bands)) {
    p.bands = src.bands.slice(0, 12).filter((b) => b && typeof b === 'object').map((b) => {
      const o = b as Record<string, unknown>;
      return { type: pick(o.type, ['peak', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch'] as const, 'peak'), f: round(num(o.f, 1000, 20, 20000), 1), gain: round(num(o.gain, 0, -24, 24), 2), q: round(num(o.q, 1, 0.1, 20), 2) };
    });
  }
  return { type, p };
}

/* ---------------------------------------------------------------- normalize (repair whatever is on disk) */

function normEnvelope(raw: unknown): EnvPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && typeof e === 'object').slice(0, 200)
    .map((e) => ({ t: round(num((e as Record<string, unknown>).t, 0, 0, MAX_DURATION)), v: round(num((e as Record<string, unknown>).v, 1, 0, 4)) }))
    .sort((a, b) => a.t - b.t);
}
function normGen(raw: unknown): GenSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>; const d = defaultGen(pick(o.type, GEN_TYPES, 'tone'));
  return { type: d.type, wave: pick(o.wave, ['sine', 'square', 'sawtooth', 'triangle'] as const, d.wave), freq: round(num(o.freq, d.freq, 1, 20000), 2), freq2: round(num(o.freq2, d.freq2, 1, 20000), 2), amp: round(num(o.amp, d.amp, 0, 1)), color: pick(o.color, ['white', 'pink', 'brown'] as const, d.color), bpm: round(num(o.bpm, d.bpm, 20, 400), 1) };
}
function normFxList(raw: unknown): Fx[] {
  if (!Array.isArray(raw)) return [];
  const out: Fx[] = [];
  for (const f of raw.slice(0, 30)) {
    if (!f || typeof f !== 'object') continue;
    const r = normFx(str((f as Record<string, unknown>).type, ''), (f as Record<string, unknown>).p);
    if (typeof r !== 'string') out.push(r);
  }
  return out;
}
function normClip(raw: unknown, fallbackId: string): Clip | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const c = newClip(str(o.id, fallbackId, 40) || fallbackId, round(num(o.start, 0, 0, MAX_DURATION)), round(num(o.duration, 1, MIN_CLIP, MAX_DURATION)));
  c.name = str(o.name, '', 80); c.asset = str(o.asset, '', 40); c.gen = normGen(o.gen);
  c.offset = round(num(o.offset, 0, 0, 1e6)); c.speed = round(num(o.speed, 1, 0.1, 10)); c.tempo = round(num(o.tempo, 1, 0.1, 10)); c.pitch = round(num(o.pitch, 0, -48, 48), 2);
  c.reverse = bool(o.reverse, false); c.gain = round(num(o.gain, 1, 0, 8)); c.fadeIn = round(num(o.fadeIn, 0, 0, MAX_DURATION)); c.fadeOut = round(num(o.fadeOut, 0, 0, MAX_DURATION));
  c.fadeCurve = pick(o.fadeCurve, FADE_CURVES, 'linear'); c.muted = bool(o.muted, false); c.envelope = normEnvelope(o.envelope); c.fx = normFxList(o.fx);
  return c;
}

export interface NormalizeResult { project: Project; warnings: string[] }
export function normalizeProject(raw: unknown, fallbackTitle = 'Untitled audio'): NormalizeResult {
  const warnings: string[] = [];
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const project: Project = { ...emptyProject(str(o.title, fallbackTitle, 120) || fallbackTitle, num(o.sampleRate, 44100)), tracks: [], assets: [], labels: [], master: normFxList(o.master), selection: null };
  const ids = new Set<string>();
  const unique = (id: string, prefix: string): string => { let n = ids.size + 1; let out = id; while (!out || ids.has(out)) out = `${prefix}${n++}`; ids.add(out); return out; };
  if (Array.isArray(o.assets)) {
    for (const a of o.assets.slice(0, 200)) {
      if (!a || typeof a !== 'object') continue;
      const r = a as Record<string, unknown>;
      project.assets.push({ id: unique(str(r.id, '', 40), 'a'), name: str(r.name, 'audio', 120), path: str(r.path, '', 500), duration: round(num(r.duration, 0, 0, 1e5)), sampleRate: Math.round(num(r.sampleRate, 44100, 3000, 384000)), channels: Math.round(num(r.channels, 2, 1, 2)) });
    }
  }
  let clipCount = 0;
  const tracks = Array.isArray(o.tracks) ? o.tracks.slice(0, MAX_TRACKS) : [];
  for (const [ti, t] of tracks.entries()) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const track = newTrack(unique(str(r.id, '', 40), 't'), str(r.name, `Track ${ti + 1}`, 60), pick(r.kind, ['mono', 'stereo'] as const, 'stereo'));
    track.gain = round(num(r.gain, 1, 0, 4)); track.pan = round(num(r.pan, 0, -1, 1)); track.mute = bool(r.mute, false); track.solo = bool(r.solo, false); track.locked = bool(r.locked, false);
    track.view = pick(r.view, ['wave', 'spectrogram', 'both'] as const, 'wave');
    for (const rc of Array.isArray(r.clips) ? r.clips : []) {
      if (clipCount >= MAX_CLIPS) { warnings.push(`only the first ${MAX_CLIPS} clips were kept`); break; }
      const clip = normClip(rc, `c${clipCount + 1}`);
      if (!clip) continue;
      clip.id = unique(clip.id, 'c');
      if (clip.asset && !project.assets.some((a) => a.id === clip.asset)) { warnings.push(`clip ${clip.id} pointed at a missing asset, so it was cleared`); clip.asset = ''; }
      if (!clip.asset && !clip.gen) clip.gen = defaultGen('silence');
      track.clips.push(clip); clipCount++;
    }
    track.clips.sort((a, b) => a.start - b.start);
    project.tracks.push(track);
  }
  if (project.tracks.length === 0) { project.tracks = [newTrack('t1', 'Audio Track')]; if (tracks.length) warnings.push('no usable tracks; started with one empty track'); }
  if (Array.isArray(o.labels)) {
    for (const l of o.labels.slice(0, 500)) {
      if (!l || typeof l !== 'object') continue;
      const r = l as Record<string, unknown>; const start = round(num(r.start, 0, 0, MAX_DURATION));
      project.labels.push({ id: unique(str(r.id, '', 40), 'l'), start, end: Math.max(start, round(num(r.end, start, 0, MAX_DURATION))), text: str(r.text, '', 120) });
    }
    project.labels.sort((a, b) => a.start - b.start);
  }
  const sel = o.selection && typeof o.selection === 'object' ? (o.selection as Record<string, unknown>) : null;
  if (sel) {
    const start = round(num(sel.start, 0, 0, MAX_DURATION)), end = round(num(sel.end, start, 0, MAX_DURATION));
    project.selection = { start: Math.min(start, end), end: Math.max(start, end), tracks: Array.isArray(sel.tracks) ? sel.tracks.filter((x): x is string => typeof x === 'string' && project.tracks.some((t) => t.id === x)) : [] };
  }
  return { project, warnings };
}
export function parseProjectJson(text: string, fallbackTitle = 'Untitled audio'): NormalizeResult {
  try { return normalizeProject(JSON.parse(text), fallbackTitle); } catch { return { project: emptyProject(fallbackTitle), warnings: ['The file was not valid JSON; started an empty project.'] }; }
}
export const serializeProject = (p: Project): string => JSON.stringify(p, null, 1);

/* ---------------------------------------------------------------- envelope + clip splitting */

/** Gain multiplier of a clip's envelope at clip-local time (1 when there are no points). */
export function envelopeAt(env: EnvPoint[], t: number): number {
  if (env.length === 0) return 1;
  if (t <= env[0].t) return env[0].v;
  const last = env[env.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < env.length - 1; i++) {
    const a = env[i], b = env[i + 1];
    if (t >= a.t && t <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return last.v;
}
/** The part of an envelope between a and b, re-based to start at 0. */
function sliceEnvelope(env: EnvPoint[], a: number, b: number): EnvPoint[] {
  if (env.length === 0) return [];
  const pts = [{ t: 0, v: round(envelopeAt(env, a)) }, ...env.filter((e) => e.t > a + EPS && e.t < b - EPS).map((e) => ({ t: round(e.t - a), v: e.v })), { t: round(b - a), v: round(envelopeAt(env, b)) }];
  return pts;
}

/** Curve value for a fade at progress x in 0..1 (0 = silent, 1 = full). */
export function fadeShape(curve: FadeCurve, x: number): number {
  const v = Math.min(1, Math.max(0, x));
  if (curve === 'log') return v * v;
  if (curve === 'cos') return 0.5 - 0.5 * Math.cos(Math.PI * v);
  return v;
}

/** Splits a clip into [left, right] at clip-local time x. The caller supplies the id of the new right-hand clip. */
export function splitClipAt(clip: Clip, x: number, rightId: string): [Clip, Clip] {
  const k = rate(clip);
  const left: Clip = JSON.parse(JSON.stringify(clip)); const right: Clip = JSON.parse(JSON.stringify(clip));
  right.id = rightId;
  left.duration = round(x); right.duration = round(clip.duration - x); right.start = round(clip.start + x);
  if (clip.reverse) { left.offset = round(clip.offset + (clip.duration - x) * k, 6); right.offset = clip.offset; }
  else right.offset = round(clip.offset + x * k, 6);
  left.fadeOut = 0; right.fadeIn = 0;
  left.fadeIn = Math.min(clip.fadeIn, left.duration); right.fadeOut = Math.min(clip.fadeOut, right.duration);
  if (clip.fadeIn > x) { left.fadeIn = round(x); }
  if (clip.fadeOut > clip.duration - x) { right.fadeOut = round(clip.duration - x); }
  left.envelope = sliceEnvelope(clip.envelope, 0, x); right.envelope = sliceEnvelope(clip.envelope, x, clip.duration);
  for (const [side, from, to] of [[left, 0, x], [right, x, clip.duration]] as [Clip, number, number][]) {
    side.fx = side.fx.map((f) => {
      if (f.type !== 'ramp') return f;
      const a = Number(f.p.from), b = Number(f.p.to), n = clip.duration;
      return { type: 'ramp', p: { ...f.p, from: round(a + ((b - a) * from) / n), to: round(a + ((b - a) * to) / n) } };
    });
  }
  return [left, right];
}

/* ---------------------------------------------------------------- operations (the single way to change a project) */

export const OP_HELP = [
  '{"op":"project","title":"…","sampleRate":44100|48000|…} — project settings',
  '{"op":"track_add","kind":"mono|stereo","name":"Voice","gain":1,"pan":0} · {"op":"track_set","track":"t1","name":"…","kind":"mono|stereo","gain":0.8,"pan":-0.3,"mute":false,"solo":true,"locked":false,"view":"wave|spectrogram|both"} · {"op":"track_remove","track":"t2"}',
  '{"op":"asset_add","path":".pigry/audio/media/voice.wav","name":"voice","duration":42.5,"sampleRate":44100,"channels":1} — register an audio file already in the workspace (the editor fills in length and rate on load)',
  '{"op":"clip_add","asset":"a1","track":"t1","start":0,"duration":10,"offset":0,…props} — put (part of) an imported file on a track; without duration the whole file is used',
  '{"op":"generate","type":"tone|chirp|noise|silence|click","track":"t1","start":0,"duration":3,"wave":"sine|square|sawtooth|triangle","freq":440,"freq2":2000,"amp":0.5,"color":"white|pink|brown","bpm":120} — Generate menu: tone, chirp (sweep freq→freq2), noise, silence, click track',
  'Clip props (clip_add / clip_set): start, duration, offset (source in-point, s), speed 0.1–10 (changes pitch and length), tempo 0.1–10 (changes length only), pitch (semitones, keeps length), reverse, gain 0–8 (1 = unity), fadeIn, fadeOut (s), fadeCurve linear|log|cos, muted, name',
  '{"op":"clip_set","clip":"c3",…props} · {"op":"clip_move","clip":"c3","start":4,"track":"t2"} (Time Shift tool) · {"op":"clip_trim","clip":"c3","from":1.5,"to":6} (new timeline edges; source stays in place) · {"op":"clip_split","clip":"c3","at":2.5} · {"op":"clip_duplicate","clip":"c3","start":8} · {"op":"clip_delete","clip":"c3","ripple":true} · {"op":"join","clips":["c1","c2"]} — butt clips together, removing the gaps',
  'Range ops (from/to in seconds; omitted = the current selection, else everything; "track"/"tracks" omitted = selected tracks, else all unlocked): {"op":"range_delete","from":2,"to":4,"ripple":true} (Cut/Delete; ripple:false leaves silence) · {"op":"range_silence","from":2,"to":4} (replace with silence) · {"op":"insert_silence","at":2,"duration":1.5,"tracks":["t1"]} · {"op":"range_duplicate","from":2,"to":4,"at":10} (copy + paste) · {"op":"repeat","from":2,"to":4,"count":3} · {"op":"range_split","from":2,"to":4} · {"op":"trim","from":2,"to":4} (keep only the range, move it to 0) · {"op":"paste","at":5,"track":"t1","clips":[…clipboard clips from the editor…]}',
  '{"op":"effect","effect":"amplify|normalize|loudnorm|invert|dcremove|eq|hpf|lpf|notch|bass|treble|compressor|limiter|gate|deesser|noisereduce|declick|dehum|reverb|echo|chorus|distortion|tremolo|mono","params":{…},"from":2,"to":4,"tracks":["t1"]} — apply an effect to a range (the clips are split at the edges; the effect stays editable on each clip); params as listed under Effects. {"op":"fade_in","from":0,"to":2,"curve":"linear|log|cos"} · {"op":"fade_out","from":18,"to":20} · {"op":"effect_remove","clip":"c3","index":0} (or "type":"reverb") · {"op":"master_effect","effect":"limiter","params":{…}} · {"op":"master_clear"}',
  '{"op":"reverse","from":2,"to":4} · {"op":"speed","factor":1.25,"from":0,"to":10} (pitch and length change, later audio ripples) · {"op":"tempo","factor":0.9,…} (length only) · {"op":"pitch","semitones":2,…} (pitch only) · {"op":"envelope_set","clip":"c3","points":[{"t":0,"v":1},{"t":2,"v":0.3}]} (Envelope tool: gain multiplier over clip-local time) · {"op":"envelope_clear","clip":"c3"}',
  '{"op":"label_add","start":12.3,"end":12.3,"text":"intro"} · {"op":"label_set","label":"l1","start":…,"end":…,"text":"…"} · {"op":"label_remove","label":"l1"} · {"op":"select","start":2,"end":4,"tracks":["t1"]} (or "all":true, or "none":true)',
].join('\n');

export interface Op { op: string; [key: string]: unknown }
const OP_NAMES = ['project', 'track_add', 'track_set', 'track_remove', 'asset_add', 'clip_add', 'generate', 'clip_set', 'clip_move', 'clip_trim', 'clip_split', 'clip_duplicate', 'clip_delete', 'join',
  'range_delete', 'range_silence', 'insert_silence', 'range_duplicate', 'repeat', 'range_split', 'trim', 'paste', 'effect', 'fade_in', 'fade_out', 'effect_remove', 'master_effect', 'master_clear',
  'reverse', 'speed', 'tempo', 'pitch', 'envelope_set', 'envelope_clear', 'label_add', 'label_set', 'label_remove', 'select'];
export function parseOps(value: unknown): { ops: Op[]; errors: string[] } {
  let list = value;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return { ops: [], errors: ['ops is not valid JSON'] }; } }
  if (!Array.isArray(list)) return { ops: [], errors: ['ops must be an array of operation objects'] };
  const ops: Op[] = [], errors: string[] = [];
  for (const [i, raw] of list.entries()) {
    if (!raw || typeof raw !== 'object' || typeof (raw as Op).op !== 'string') { errors.push(`op ${i + 1}: needs an "op" name`); continue; }
    if (!OP_NAMES.includes((raw as Op).op)) { errors.push(`op ${i + 1}: unknown op "${(raw as Op).op}" (known: ${OP_NAMES.join(', ')})`); continue; }
    ops.push(raw as Op);
  }
  return { ops, errors };
}

export class OpError extends Error {}
const fail = (message: string): never => { throw new OpError(message); };
export interface ApplyResult { project: Project; log: string[]; error?: string; created?: string }

const CLIP_NUMBERS: Record<string, [number, number]> = {
  start: [0, MAX_DURATION], duration: [MIN_CLIP, MAX_DURATION], offset: [0, 1e6], speed: [0.1, 10], tempo: [0.1, 10], pitch: [-48, 48], gain: [0, 8], fadeIn: [0, MAX_DURATION], fadeOut: [0, MAX_DURATION],
};

class Editor {
  log: string[] = [];
  last = '';
  project: Project;
  constructor(project: Project) { this.project = project; }

  private nextId(prefix: string, taken: string[]): string {
    let n = 1 + taken.reduce((m, id) => (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)) ? Math.max(m, Number(id.slice(prefix.length))) : m), 0);
    while (taken.includes(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }
  private clipId = (): string => this.nextId('c', allClips(this.project).map((c) => c.id));
  private resolve(ref: unknown, kind: string): string { return ref === 'last' && kind === 'clip' ? this.last : String(ref ?? ''); }

  track(ref: unknown): Track {
    const id = String(ref ?? '');
    const t = this.project.tracks.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
    if (!t) return fail(`no track "${id}" (tracks: ${this.project.tracks.map((x) => `${x.id} "${x.name}"`).join(', ')})`);
    return t;
  }
  clip(ref: unknown): { track: Track; clip: Clip; index: number } {
    const id = this.resolve(ref, 'clip');
    const f = findClip(this.project, id);
    if (!f) return fail(`no clip "${id}"`);
    return f;
  }
  /** Tracks an op acts on: explicit ids, else the selection's tracks, else every unlocked track. */
  tracksFor(op: Op): Track[] {
    const explicit = op.tracks !== undefined ? (Array.isArray(op.tracks) ? op.tracks : [op.tracks]) : op.track !== undefined ? [op.track] : null;
    if (explicit) {
      const list = explicit.map((r) => this.track(r));
      const locked = list.find((t) => t.locked);
      if (locked) fail(`track ${locked.id} is locked (unlock it with track_set)`);
      return list;
    }
    const sel = this.project.selection;
    const base = sel && sel.tracks.length ? this.project.tracks.filter((t) => sel.tracks.includes(t.id)) : this.project.tracks;
    return base.filter((t) => !t.locked);
  }
  range(op: Op): [number, number] {
    const sel = this.project.selection;
    const dur = projectDuration(this.project);
    const from = round(num(op.from, sel ? sel.start : 0, 0, MAX_DURATION)), to = round(num(op.to, sel && sel.end > sel.start ? sel.end : dur, 0, MAX_DURATION));
    if (to - from < MIN_CLIP) fail(`empty range ${from}–${to}s (give from/to or make a selection)`);
    return [from, to];
  }

  /** Splits the clip of `track` that spans time t (if t falls strictly inside a clip). */
  splitAt(track: Track, t: number): void {
    const i = track.clips.findIndex((c) => c.start + EPS < t && clipEnd(c) - EPS > t);
    if (i < 0) return;
    const c = track.clips[i];
    const [l, r] = splitClipAt(c, round(t - c.start), this.clipId());
    track.clips.splice(i, 1, l, r);
  }
  clipsIn(track: Track, from: number, to: number): Clip[] {
    return track.clips.filter((c) => c.start >= from - EPS && clipEnd(c) <= to + EPS);
  }
  private sortAll(): void { for (const t of this.project.tracks) t.clips.sort((a, b) => a.start - b.start); }
  private shiftAfter(track: Track, t: number, delta: number): void {
    for (const c of track.clips) if (c.start >= t - EPS) c.start = round(Math.max(0, c.start + delta));
  }

  private applyClipProps(c: Clip, op: Op): void {
    for (const [key, [lo, hi]] of Object.entries(CLIP_NUMBERS)) {
      if (op[key] !== undefined) { const n = num(op[key], NaN); if (!Number.isFinite(n)) fail(`${key} must be a number`); (c as unknown as Record<string, number>)[key] = round(Math.min(hi, Math.max(lo, n)), 4); }
    }
    if (op.reverse !== undefined) c.reverse = op.reverse === true;
    if (op.muted !== undefined) c.muted = op.muted === true;
    if (op.name !== undefined) c.name = str(op.name, '', 80);
    if (op.fadeCurve !== undefined) c.fadeCurve = pick(op.fadeCurve, FADE_CURVES, 'linear');
  }

  private pushClip(track: Track, clip: Clip): void {
    if (allClips(this.project).length >= MAX_CLIPS) fail(`a project can hold at most ${MAX_CLIPS} clips`);
    track.clips.push(clip); track.clips.sort((a, b) => a.start - b.start);
    this.last = clip.id;
  }
  private applyEffect(track: Track, from: number, to: number, fx: Fx): number {
    this.splitAt(track, from); this.splitAt(track, to);
    const hit = this.clipsIn(track, from, to);
    for (const c of hit) c.fx.push(JSON.parse(JSON.stringify(fx)));
    return hit.length;
  }
  private profileToSource(track: Track, p: Record<string, unknown>, params: Record<string, unknown>): void {
    const a = num(params.profileFrom, -1), b = num(params.profileTo, -1);
    if (a < 0 || b <= a) { p.profileFrom = -1; p.profileTo = -1; return; }
    const c = track.clips.find((x) => x.start - EPS <= a && clipEnd(x) + EPS >= a && x.asset);
    if (!c) { p.profileFrom = -1; p.profileTo = -1; return; }
    const k = rate(c);
    p.profileFrom = round(c.offset + (a - c.start) * k, 4); p.profileTo = round(c.offset + (Math.min(b, clipEnd(c)) - c.start) * k, 4);
  }

  run(op: Op): string {
    const P = this.project;
    switch (op.op) {
      case 'project': {
        if (op.title !== undefined) P.title = str(op.title, P.title, 120) || P.title;
        if (op.sampleRate !== undefined) { const r = num(op.sampleRate, 0); if (!SAMPLE_RATES.includes(r)) fail(`sampleRate must be one of ${SAMPLE_RATES.join(', ')}`); P.sampleRate = r; }
        return `project "${P.title}" at ${P.sampleRate} Hz`;
      }
      case 'track_add': {
        if (P.tracks.length >= MAX_TRACKS) fail(`at most ${MAX_TRACKS} tracks`);
        const t = newTrack(this.nextId('t', P.tracks.map((x) => x.id)), str(op.name, `Audio Track ${P.tracks.length + 1}`, 60), pick(op.kind, ['mono', 'stereo'] as const, 'stereo'));
        t.gain = round(num(op.gain, 1, 0, 4)); t.pan = round(num(op.pan, 0, -1, 1));
        P.tracks.push(t);
        return `track ${t.id} "${t.name}" (${t.kind})`;
      }
      case 'track_set': {
        const t = this.track(op.track);
        if (op.name !== undefined) t.name = str(op.name, t.name, 60) || t.name;
        if (op.kind !== undefined) t.kind = pick(op.kind, ['mono', 'stereo'] as const, t.kind);
        if (op.gain !== undefined) t.gain = round(num(op.gain, t.gain, 0, 4));
        if (op.pan !== undefined) t.pan = round(num(op.pan, t.pan, -1, 1));
        for (const k of ['mute', 'solo', 'locked'] as const) if (op[k] !== undefined) t[k] = op[k] === true;
        if (op.view !== undefined) t.view = pick(op.view, ['wave', 'spectrogram', 'both'] as const, t.view);
        return `track ${t.id} updated`;
      }
      case 'track_remove': {
        const t = this.track(op.track);
        if (P.tracks.length <= 1) fail('a project needs at least one track');
        P.tracks = P.tracks.filter((x) => x !== t);
        if (P.selection) P.selection.tracks = P.selection.tracks.filter((id) => id !== t.id);
        return `removed track ${t.id} with ${t.clips.length} clip(s)`;
      }
      case 'asset_add': {
        const path = str(op.path, '', 500).replace(/\\/g, '/');
        if (!path) fail('asset_add needs a path');
        const a: Asset = { id: this.nextId('a', P.assets.map((x) => x.id)), name: str(op.name, path.split('/').pop() ?? 'audio', 120), path, duration: round(num(op.duration, 0, 0, 1e5)), sampleRate: Math.round(num(op.sampleRate, 44100, 3000, 384000)), channels: Math.round(num(op.channels, 2, 1, 2)) };
        P.assets.push(a);
        return `asset ${a.id} "${a.name}"`;
      }
      case 'clip_add': {
        const asset = findAsset(P, String(op.asset ?? ''));
        if (!asset) return fail(`no asset "${op.asset}" (register one with asset_add)`);
        const track = op.track !== undefined ? this.track(op.track) : P.tracks.find((t) => !t.locked) ?? fail('every track is locked');
        if (track.locked) fail(`track ${track.id} is locked`);
        const start = round(num(op.start, 0, 0, MAX_DURATION));
        const offset = round(num(op.offset, 0, 0, 1e6));
        const dur = op.duration !== undefined ? round(num(op.duration, 1, MIN_CLIP, MAX_DURATION)) : Math.max(MIN_CLIP, round((asset.duration || 5) - offset));
        const c = newClip(this.clipId(), start, dur); c.asset = asset.id; c.offset = offset; c.name = asset.name;
        this.applyClipProps(c, { ...op, start: undefined, duration: undefined, offset: undefined });
        this.pushClip(track, c);
        return `clip ${c.id} on ${track.id} at ${c.start}s for ${c.duration}s`;
      }
      case 'generate': {
        const track = op.track !== undefined ? this.track(op.track) : P.tracks.find((t) => !t.locked) ?? fail('every track is locked');
        if (track.locked) fail(`track ${track.id} is locked`);
        const type = pick(op.type, GEN_TYPES, 'tone');
        const gen = normGen({ ...op, type }) ?? defaultGen(type);
        const c = newClip(this.clipId(), round(num(op.start, 0, 0, MAX_DURATION)), round(num(op.duration, 3, MIN_CLIP, MAX_DURATION)));
        c.gen = gen; c.name = type === 'tone' ? `${gen.freq} Hz ${gen.wave}` : type === 'chirp' ? `chirp ${gen.freq}→${gen.freq2} Hz` : type === 'noise' ? `${gen.color} noise` : type === 'click' ? `clicks ${gen.bpm} bpm` : 'silence';
        this.applyClipProps(c, { ...op, start: undefined, duration: undefined, offset: undefined });
        this.pushClip(track, c);
        return `${c.name} as clip ${c.id} on ${track.id} (${c.start}–${clipEnd(c)}s)`;
      }
      case 'clip_set': {
        const { clip } = this.clip(op.clip);
        this.applyClipProps(clip, op);
        if (op.gen !== undefined && clip.gen) clip.gen = normGen({ ...clip.gen, ...(op.gen as object) }) ?? clip.gen;
        this.sortAll();
        return `clip ${clip.id} updated`;
      }
      case 'clip_move': {
        const f = this.clip(op.clip);
        if (f.track.locked) fail(`track ${f.track.id} is locked`);
        if (op.start !== undefined) f.clip.start = round(num(op.start, f.clip.start, 0, MAX_DURATION));
        if (op.track !== undefined) { const dest = this.track(op.track); if (dest.locked) fail(`track ${dest.id} is locked`); if (dest !== f.track) { f.track.clips.splice(f.index, 1); dest.clips.push(f.clip); } }
        this.sortAll();
        return `clip ${f.clip.id} now at ${f.clip.start}s`;
      }
      case 'clip_trim': {
        const { clip } = this.clip(op.clip);
        const from = round(num(op.from, clip.start, 0, MAX_DURATION)), to = round(num(op.to, clipEnd(clip), 0, MAX_DURATION));
        if (to - from < MIN_CLIP) fail('trim leaves nothing');
        const k = rate(clip);
        if (clip.reverse) clip.offset = round(Math.max(0, clip.offset + (clipEnd(clip) - to) * k), 6);
        else clip.offset = round(Math.max(0, clip.offset + (from - clip.start) * k), 6);
        clip.envelope = sliceEnvelope(clip.envelope, from - clip.start, to - clip.start);
        clip.start = from; clip.duration = round(to - from);
        return `clip ${clip.id} now ${from}–${to}s`;
      }
      case 'clip_split': {
        const f = this.clip(op.clip);
        const at = num(op.at, NaN);
        if (!Number.isFinite(at) || at <= f.clip.start + EPS || at >= clipEnd(f.clip) - EPS) fail(`"at" must fall inside the clip (${f.clip.start}–${clipEnd(f.clip)}s)`);
        const [l, r] = splitClipAt(f.clip, round(at - f.clip.start), this.clipId());
        f.track.clips.splice(f.index, 1, l, r);
        this.last = r.id;
        return `split ${l.id} | ${r.id} at ${at}s`;
      }
      case 'clip_duplicate': {
        const f = this.clip(op.clip);
        const c: Clip = JSON.parse(JSON.stringify(f.clip)); c.id = this.clipId();
        c.start = op.start !== undefined ? round(num(op.start, 0, 0, MAX_DURATION)) : clipEnd(f.clip);
        this.pushClip(f.track, c);
        return `clip ${c.id} at ${c.start}s`;
      }
      case 'clip_delete': {
        const f = this.clip(op.clip);
        f.track.clips.splice(f.index, 1);
        if (op.ripple === true) this.shiftAfter(f.track, clipEnd(f.clip) - EPS, -f.clip.duration);
        return `deleted ${f.clip.id}${op.ripple === true ? ' and closed the gap' : ''}`;
      }
      case 'join': {
        const refs = Array.isArray(op.clips) ? op.clips.map((r) => this.clip(r)) : fail('join needs "clips":[ids]');
        const list = refs.sort((a, b) => a.clip.start - b.clip.start);
        if (list.length < 2) fail('join needs at least two clips');
        let t = list[0].clip.start;
        for (const f of list) { f.clip.start = round(t); t += f.clip.duration; }
        this.sortAll();
        return `joined ${list.length} clips into ${round(t - list[0].clip.start, 3)}s`;
      }
      case 'range_delete': case 'range_silence': {
        const [from, to] = this.range(op); const ripple = op.op === 'range_delete' && op.ripple !== false;
        let n = 0;
        for (const t of this.tracksFor(op)) {
          this.splitAt(t, from); this.splitAt(t, to);
          const hit = new Set(this.clipsIn(t, from, to));
          n += hit.size; t.clips = t.clips.filter((c) => !hit.has(c));
          if (ripple) this.shiftAfter(t, to - EPS, -(to - from));
        }
        return `${ripple ? 'removed' : 'silenced'} ${from}–${to}s (${n} clip(s))`;
      }
      case 'insert_silence': {
        const at = round(num(op.at, 0, 0, MAX_DURATION)), dur = round(num(op.duration, 1, MIN_CLIP, MAX_DURATION));
        for (const t of this.tracksFor(op)) { this.splitAt(t, at); this.shiftAfter(t, at - EPS, dur); }
        return `inserted ${dur}s of silence at ${at}s`;
      }
      case 'range_duplicate': case 'repeat': {
        const [from, to] = this.range(op); const len = round(to - from);
        const count = op.op === 'repeat' ? Math.round(num(op.count, 1, 1, 50)) : 1;
        const at = op.op === 'repeat' ? to : round(num(op.at, to, 0, MAX_DURATION));
        let n = 0;
        for (const t of this.tracksFor(op)) {
          this.splitAt(t, from); this.splitAt(t, to);
          const src = this.clipsIn(t, from, to).map((c) => JSON.parse(JSON.stringify(c)) as Clip);
          if (op.op === 'repeat') this.shiftAfter(t, to - EPS, len * count);
          for (let i = 0; i < count; i++) for (const c of src) { const d: Clip = JSON.parse(JSON.stringify(c)); d.id = this.clipId(); d.start = round(at + i * len + (c.start - from)); this.pushClip(t, d); n++; }
        }
        return `${op.op === 'repeat' ? 'repeated' : 'copied'} ${from}–${to}s ×${count} (${n} clip(s))`;
      }
      case 'range_split': {
        const [from, to] = this.range(op);
        for (const t of this.tracksFor(op)) { this.splitAt(t, from); this.splitAt(t, to); }
        return `split at ${from}s and ${to}s`;
      }
      case 'trim': {
        const [from, to] = this.range(op);
        for (const t of this.tracksFor(op)) {
          this.splitAt(t, from); this.splitAt(t, to);
          t.clips = t.clips.filter((c) => c.start >= from - EPS && clipEnd(c) <= to + EPS);
          for (const c of t.clips) c.start = round(c.start - from);
        }
        if (P.selection) P.selection = null;
        return `kept ${from}–${to}s`;
      }
      case 'paste': {
        const track = this.tracksFor({ ...op, tracks: undefined })[0] ?? fail('no unlocked track to paste into');
        const at = round(num(op.at, 0, 0, MAX_DURATION));
        const list = Array.isArray(op.clips) ? op.clips : fail('paste needs "clips":[…] (the editor fills this from its clipboard)');
        const base = Math.min(...list.map((c) => num((c as Record<string, unknown>).start, 0)));
        let n = 0;
        for (const raw of list) {
          const c = normClip(raw, this.clipId()); if (!c) continue;
          if (c.asset && !findAsset(P, c.asset)) fail(`pasted clip uses unknown asset ${c.asset}`);
          c.id = this.clipId(); c.start = round(at + c.start - base); this.pushClip(track, c); n++;
        }
        return `pasted ${n} clip(s) at ${at}s on ${track.id}`;
      }
      case 'effect': case 'fade_in': case 'fade_out': {
        const [from, to] = this.range(op);
        if (op.op === 'effect') {
          const type = str(op.effect, '');
          const fx = normFx(type, op.params);
          if (typeof fx === 'string') return fail(fx);
          let total = 0;
          for (const t of this.tracksFor(op)) {
            const one: Fx = JSON.parse(JSON.stringify(fx));
            if (type === 'noisereduce') this.profileToSource(t, one.p, (op.params ?? {}) as Record<string, unknown>);
            total += this.applyEffect(t, from, to, one);
          }
          if (total === 0) fail(`no audio between ${from}s and ${to}s on the chosen tracks`);
          return `${FX[type].label} on ${from}–${to}s (${total} clip(s))`;
        }
        const curve = pick(op.curve, FADE_CURVES, 'linear'); const len = to - from; let total = 0;
        for (const t of this.tracksFor(op)) {
          this.splitAt(t, from); this.splitAt(t, to);
          for (const c of this.clipsIn(t, from, to)) {
            const a = (c.start - from) / len, b = (clipEnd(c) - from) / len;
            c.fx.push({ type: 'ramp', p: op.op === 'fade_in' ? { from: round(a), to: round(b), curve } : { from: round(1 - a), to: round(1 - b), curve } });
            total++;
          }
        }
        if (total === 0) fail(`no audio between ${from}s and ${to}s`);
        return `${op.op === 'fade_in' ? 'fade in' : 'fade out'} over ${from}–${to}s`;
      }
      case 'effect_remove': {
        const { clip } = this.clip(op.clip);
        if (op.type !== undefined) { const n = clip.fx.length; clip.fx = clip.fx.filter((f) => f.type !== op.type); return `removed ${n - clip.fx.length} ${String(op.type)} effect(s) from ${clip.id}`; }
        const i = Math.round(num(op.index, -1));
        if (i < 0 || i >= clip.fx.length) fail(`effect index ${i} out of range (clip has ${clip.fx.length})`);
        const [gone] = clip.fx.splice(i, 1);
        return `removed ${gone.type} from ${clip.id}`;
      }
      case 'master_effect': {
        const fx = normFx(str(op.effect, ''), op.params);
        if (typeof fx === 'string') return fail(fx);
        if (['noisereduce', 'ramp'].includes(fx.type)) fail(`${fx.type} cannot run on the master`);
        P.master.push(fx);
        return `master: ${FX[fx.type].label}`;
      }
      case 'master_clear': { const n = P.master.length; P.master = []; return `cleared ${n} master effect(s)`; }
      case 'reverse': {
        const [from, to] = this.range(op); let n = 0;
        for (const t of this.tracksFor(op)) {
          this.splitAt(t, from); this.splitAt(t, to);
          for (const c of this.clipsIn(t, from, to)) { c.reverse = !c.reverse; c.start = round(from + to - clipEnd(c)); n++; }
          t.clips.sort((a, b) => a.start - b.start);
        }
        return `reversed ${from}–${to}s (${n} clip(s))`;
      }
      case 'speed': case 'tempo': case 'pitch': {
        const [from, to] = this.range(op); let n = 0;
        const factor = op.op === 'pitch' ? 1 : num(op.factor ?? (op.percent !== undefined ? 1 + num(op.percent, 0) / 100 : undefined), NaN, 0.1, 10);
        if (op.op !== 'pitch' && !Number.isFinite(factor)) fail(`${op.op} needs "factor" (e.g. 1.25) or "percent"`);
        const semis = op.op === 'pitch' ? num(op.semitones, NaN, -48, 48) : 0;
        if (op.op === 'pitch' && !Number.isFinite(semis)) fail('pitch needs "semitones"');
        for (const t of this.tracksFor(op)) {
          this.splitAt(t, from); this.splitAt(t, to);
          const hit = this.clipsIn(t, from, to); if (!hit.length) continue;
          if (op.op === 'pitch') { for (const c of hit) { c.pitch = round(Math.max(-48, Math.min(48, c.pitch + semis)), 2); n++; } continue; }
          const newLen = (to - from) / factor;
          for (const c of hit) {
            if (op.op === 'speed') c.speed = round(c.speed * factor, 4); else c.tempo = round(c.tempo * factor, 4);
            c.start = round(from + (c.start - from) / factor); c.duration = round(c.duration / factor);
            c.fadeIn = round(c.fadeIn / factor); c.fadeOut = round(c.fadeOut / factor);
            c.envelope = c.envelope.map((e) => ({ t: round(e.t / factor), v: e.v }));
            n++;
          }
          if (op.ripple !== false) this.shiftAfter({ ...t, clips: t.clips.filter((c) => !hit.includes(c)) } as Track, to - EPS, newLen - (to - from));
        }
        return `${op.op} ${op.op === 'pitch' ? `${semis > 0 ? '+' : ''}${semis} semitones` : `×${round(factor, 3)}`} on ${from}–${to}s (${n} clip(s))`;
      }
      case 'envelope_set': {
        const { clip } = this.clip(op.clip);
        if (!Array.isArray(op.points)) fail('envelope_set needs "points":[{t,v}] (t = seconds from the clip start, v = gain multiplier 0–4)');
        clip.envelope = normEnvelope(op.points).filter((e) => e.t <= clip.duration + EPS);
        return `envelope with ${clip.envelope.length} point(s) on ${clip.id}`;
      }
      case 'envelope_clear': { const { clip } = this.clip(op.clip); clip.envelope = []; return `cleared envelope of ${clip.id}`; }
      case 'label_add': {
        const start = round(num(op.start, num(op.at, 0), 0, MAX_DURATION));
        const l: Label = { id: this.nextId('l', P.labels.map((x) => x.id)), start, end: Math.max(start, round(num(op.end, start, 0, MAX_DURATION))), text: str(op.text, '', 120) };
        P.labels.push(l); P.labels.sort((a, b) => a.start - b.start);
        return `label ${l.id} "${l.text}" at ${l.start}s`;
      }
      case 'label_set': {
        const l = P.labels.find((x) => x.id === String(op.label ?? '')) ?? fail(`no label "${op.label}"`);
        if (op.start !== undefined) l.start = round(num(op.start, l.start, 0, MAX_DURATION));
        if (op.end !== undefined) l.end = round(num(op.end, l.end, 0, MAX_DURATION));
        if (l.end < l.start) l.end = l.start;
        if (op.text !== undefined) l.text = str(op.text, l.text, 120);
        P.labels.sort((a, b) => a.start - b.start);
        return `label ${l.id} updated`;
      }
      case 'label_remove': {
        const i = P.labels.findIndex((x) => x.id === String(op.label ?? ''));
        if (i < 0) fail(`no label "${op.label}"`);
        P.labels.splice(i, 1);
        return `removed label ${String(op.label)}`;
      }
      case 'select': {
        if (op.none === true) { P.selection = null; return 'selection cleared'; }
        if (op.all === true) { P.selection = { start: 0, end: projectDuration(P), tracks: [] }; return `selected everything (0–${P.selection.end}s)`; }
        const a = num(op.start, NaN, 0, MAX_DURATION), b = num(op.end, a, 0, MAX_DURATION);
        if (!Number.isFinite(a)) fail('select needs start (and end), or all:true, or none:true');
        const tracks = (Array.isArray(op.tracks) ? op.tracks : []).map((r) => this.track(r).id);
        P.selection = { start: round(Math.min(a, b)), end: round(Math.max(a, b)), tracks };
        return `selected ${P.selection.start}–${P.selection.end}s${tracks.length ? ' on ' + tracks.join(', ') : ''}`;
      }
      default: return fail(`unknown op "${op.op}"`);
    }
  }
}

export function applyOps(project: Project, ops: Op[]): ApplyResult {
  const editor = new Editor(JSON.parse(JSON.stringify(project)) as Project);
  for (const [i, op] of ops.entries()) {
    try { editor.log.push(`✓ ${op.op}: ${editor.run(op)}`); }
    catch (error) {
      if (error instanceof OpError) return { project, log: editor.log, error: `op ${i + 1} (${op.op}): ${error.message}` };
      throw error;
    }
  }
  if (projectDuration(editor.project) > MAX_DURATION) return { project, log: editor.log, error: `the project would be longer than ${MAX_DURATION}s` };
  for (const t of editor.project.tracks) t.clips.sort((a, b) => a.start - b.start);
  return { project: editor.project, log: editor.log, created: editor.last };
}

/** Copies the clips of a time range (cut at the edges) so the editor can paste them later: Edit ▸ Copy. */
export function extractRange(project: Project, from: number, to: number, trackIds?: string[]): Clip[] {
  const copy = applyOps(project, [{ op: 'range_split', from, to, ...(trackIds?.length ? { tracks: trackIds } : {}) }]);
  const out: Clip[] = [];
  for (const t of copy.project.tracks) {
    if (trackIds?.length && !trackIds.includes(t.id)) continue;
    for (const c of t.clips) if (c.start >= from - EPS && clipEnd(c) <= to + EPS) out.push(JSON.parse(JSON.stringify(c)));
  }
  return out;
}

/* ---------------------------------------------------------------- review & summary */

export function checkProject(p: Project): string[] {
  const out: string[] = [];
  if (projectDuration(p) === 0) return ['The project is empty — add clips or generate sound.'];
  for (const track of p.tracks) {
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1], cur = clips[i];
      if (cur.start < clipEnd(prev) - 0.005) out.push(`${track.name}: ${prev.id} and ${cur.id} overlap by ${round(clipEnd(prev) - cur.start, 3)}s — they will be mixed together; move one or use another track.`);
    }
    if (track.gain > 1.5) out.push(`${track.name}: track gain ${round(track.gain, 2)}× may clip — lower it or use a limiter.`);
  }
  for (const c of allClips(p)) {
    if (c.asset && !findAsset(p, c.asset)) out.push(`${c.id}: missing asset ${c.asset}`);
    const a = c.asset ? findAsset(p, c.asset) : undefined;
    if (a && a.duration > 0 && c.offset + sourceSpan(c) > a.duration + 0.05) out.push(`${c.id}: plays ${round(c.offset + sourceSpan(c) - a.duration, 2)}s past the end of "${a.name}" (that part is silent).`);
    if (c.gain > 3) out.push(`${c.id}: clip gain ${round(c.gain, 2)}× is very high — check for clipping.`);
    if (c.fadeIn + c.fadeOut > c.duration + 0.001) out.push(`${c.id}: fade in + fade out are longer than the clip.`);
    if (c.fx.filter((f) => f.type === 'noisereduce').length > 1) out.push(`${c.id}: noise reduction twice in one clip adds artefacts — keep one pass.`);
    const order = c.fx.map((f) => f.type);
    if (order.indexOf('limiter') >= 0 && order.indexOf('limiter') < order.length - 1 && order.slice(order.indexOf('limiter') + 1).some((t) => ['amplify', 'eq', 'bass', 'treble', 'compressor', 'distortion'].includes(t))) out.push(`${c.id}: a limiter is followed by an effect that changes level — put the limiter last.`);
    const nr = order.indexOf('noisereduce'), comp = order.indexOf('compressor');
    if (nr >= 0 && comp >= 0 && comp < nr) out.push(`${c.id}: compression before noise reduction raises the noise — denoise first.`);
  }
  if (p.master.length === 0 && p.tracks.filter((t) => t.clips.length).length > 1) out.push('Several tracks and no master limiter — the sum may clip; add master_effect limiter (ceiling −1 dB).');
  return out;
}

export const fmtSec = (s: number): string => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };

export function summarizeProject(p: Project): string {
  const lines = [`"${p.title}" — ${p.sampleRate} Hz, ${projectDuration(p)}s, ${p.tracks.length} track(s), ${allClips(p).length} clip(s)`];
  if (p.assets.length) lines.push('Assets: ' + p.assets.map((a) => `${a.id} "${a.name}" ${a.duration ? a.duration + 's' : ''} ${a.channels}ch ${a.sampleRate}Hz (${a.path})`).join('; '));
  for (const t of p.tracks) {
    lines.push(`Track ${t.id} "${t.name}" ${t.kind}, gain ${round(t.gain, 2)}, pan ${round(t.pan, 2)}${t.mute ? ', MUTED' : ''}${t.solo ? ', SOLO' : ''}${t.locked ? ', locked' : ''}`);
    for (const c of t.clips) {
      const what = c.gen ? `gen ${c.gen.type}${c.gen.type === 'tone' ? ` ${c.gen.freq}Hz` : ''}` : `asset ${c.asset} @${c.offset}s`;
      const bits = [c.speed !== 1 ? `speed ×${c.speed}` : '', c.tempo !== 1 ? `tempo ×${c.tempo}` : '', c.pitch ? `pitch ${c.pitch > 0 ? '+' : ''}${c.pitch}st` : '', c.reverse ? 'reversed' : '', c.gain !== 1 ? `gain ×${c.gain}` : '', c.fadeIn ? `fadeIn ${c.fadeIn}s` : '', c.fadeOut ? `fadeOut ${c.fadeOut}s` : '', c.envelope.length ? `envelope(${c.envelope.length})` : '', c.muted ? 'muted' : ''].filter(Boolean);
      const fx = c.fx.map((f) => `${f.type}(${Object.entries(f.p).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${v}`).join(',')})`).join(' → ');
      lines.push(`  ${c.id} ${c.start}–${clipEnd(c)}s ${what}${c.name ? ` "${c.name}"` : ''}${bits.length ? ' [' + bits.join(', ') + ']' : ''}${fx ? ' fx: ' + fx : ''}`);
    }
  }
  if (p.master.length) lines.push('Master: ' + p.master.map((f) => `${f.type}(${Object.entries(f.p).map(([k, v]) => `${k}=${v}`).join(',')})`).join(' → '));
  if (p.labels.length) lines.push('Labels: ' + p.labels.map((l) => `${l.id} ${l.start}${l.end > l.start ? '–' + l.end : ''}s "${l.text}"`).join('; '));
  if (p.selection) lines.push(`Selection: ${p.selection.start}–${p.selection.end}s${p.selection.tracks.length ? ' on ' + p.selection.tracks.join(', ') : ''}`);
  return lines.join('\n');
}

/** Format information (Audacity's track "Rate / bit depth" panel): what the project plays at and what an export would be. */
export function formatInfo(p: Project): string {
  const mono = p.tracks.every((t) => t.kind === 'mono' || t.clips.length === 0);
  return `${p.sampleRate} Hz project rate, internal 32-bit float, ${mono ? 'mono' : 'stereo'} mix; exports: WAV 16-bit / 24-bit / 32-bit float, WebM (Opus) — no MP3 or FLAC.`;
}

/** Starting points for new projects: a blank stereo track, a podcast layout (voice + music + master limiter) or a three-track music layout. */
export function templateOps(kind: string): Op[] {
  if (kind === 'podcast') {
    return [
      { op: 'track_set', track: 't1', name: 'Voice', kind: 'mono' }, { op: 'track_add', kind: 'stereo', name: 'Music', gain: 0.35 }, { op: 'track_add', kind: 'stereo', name: 'Effects' },
      { op: 'master_effect', effect: 'limiter', params: { ceiling: -1 } },
    ];
  }
  if (kind === 'music') {
    return [{ op: 'track_set', track: 't1', name: 'Drums' }, { op: 'track_add', kind: 'stereo', name: 'Bass' }, { op: 'track_add', kind: 'stereo', name: 'Melody' }, { op: 'master_effect', effect: 'limiter', params: { ceiling: -1 } }];
  }
  return [];
}
