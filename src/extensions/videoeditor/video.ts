/** Video Editor project model — pure data and logic (no DOM), so it runs in the editor, in the agent tools and in node tests.
 *
 * A project is a stack of tracks (index 0 is the bottom layer). Video tracks hold clips that draw on the canvas
 * (video, image, text, shape, sticker); audio tracks hold sound (audio files and synthesised sound). Every change goes
 * through `applyOps`, all-or-nothing, so the editor UI and the agent share one code path. `layersAt(project, t)` turns
 * the project into the drawing instructions for a single moment, which is what the renderer and the tests look at. */

export const VIDEOS_DIR = '.pigry/videos/';
export const VIDEO_EXT = '.video.json';
export const MAX_DURATION = 900;
export const MAX_CLIPS = 500;
export const MAX_TRACKS = 24;
export const MIN_CLIP = 0.1;

export const ASPECTS: Record<string, { w: number; h: number; label: string }> = {
  '9:16': { w: 1080, h: 1920, label: 'TikTok / Reels / Shorts' },
  '16:9': { w: 1920, h: 1080, label: 'YouTube / landscape' },
  '1:1': { w: 1080, h: 1080, label: 'Square' },
  '4:5': { w: 1080, h: 1350, label: 'Instagram portrait' },
  '4:3': { w: 1440, h: 1080, label: 'Classic 4:3' },
  '21:9': { w: 2560, h: 1080, label: 'Cinematic' },
};

export type ClipKind = 'video' | 'image' | 'audio' | 'text' | 'shape' | 'sticker' | 'synth';
export type TrackKind = 'video' | 'audio';
export const VISUAL_KINDS: ClipKind[] = ['video', 'image', 'text', 'shape', 'sticker'];
export const SOUND_KINDS: ClipKind[] = ['video', 'audio', 'synth'];

export type EaseId = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'back' | 'bounce' | 'hold';
export const EASES: EaseId[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back', 'bounce', 'hold'];

export function ease(id: EaseId | undefined, p: number): number {
  const x = Math.min(1, Math.max(0, p));
  switch (id) {
    case 'ease-in': return x * x * x;
    case 'ease-out': return 1 - (1 - x) ** 3;
    case 'ease-in-out': return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case 'back': { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; }
    case 'bounce': {
      const n = 7.5625, d = 2.75;
      if (x < 1 / d) return n * x * x;
      if (x < 2 / d) { const y = x - 1.5 / d; return n * y * y + 0.75; }
      if (x < 2.5 / d) { const y = x - 2.25 / d; return n * y * y + 0.9375; }
      const y = x - 2.625 / d; return n * y * y + 0.984375;
    }
    case 'hold': return x >= 1 ? 1 : 0;
    default: return x;
  }
}

export interface Keyframe { t: number; v: number; ease?: EaseId }
export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume';
export const ANIM_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'];

export interface Adjust { brightness: number; contrast: number; saturation: number; hue: number; blur: number; vignette: number; grain: number }
export const ADJUST_RANGES: Record<keyof Adjust, [number, number]> = {
  brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], hue: [-180, 180], blur: [0, 100], vignette: [0, 100], grain: [0, 100],
};
export const emptyAdjust = (): Adjust => ({ brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, vignette: 0, grain: 0 });

export interface TextProps {
  text: string; font: 'sans' | 'serif' | 'mono' | 'display' | 'hand'; size: number; color: string; bold: boolean; italic: boolean;
  align: 'left' | 'center' | 'right'; stroke: string; strokeWidth: number; bg: string; shadow: boolean; letterSpacing: number; lineHeight: number; width: number;
}
export const FONTS: TextProps['font'][] = ['sans', 'serif', 'mono', 'display', 'hand'];
export const FONT_STACKS: Record<TextProps['font'], string> = {
  sans: '"Segoe UI", Inter, Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'Consolas, "SF Mono", "Courier New", monospace',
  display: 'Impact, "Arial Black", "Segoe UI Black", sans-serif',
  hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive',
};

export const SHAPES = ['rect', 'ellipse', 'triangle', 'star', 'heart', 'line', 'arrow'] as const;
export interface ShapeProps { shape: (typeof SHAPES)[number]; w: number; h: number; color: string; color2: string; angle: number; radius: number; stroke: string; strokeWidth: number }
export const SYNTH_PRESETS = ['tone', 'pad', 'beat', 'arp', 'bass', 'riser', 'whoosh', 'click', 'impact'] as const;
export interface SynthProps { preset: (typeof SYNTH_PRESETS)[number]; note: string; bpm: number; scale: 'major' | 'minor'; wave: 'sine' | 'square' | 'sawtooth' | 'triangle' }

export interface Transition { type: string; duration: number }
export interface Clip {
  id: string; kind: ClipKind; name: string; start: number; duration: number; offset: number; speed: number;
  volume: number; fadeIn: number; fadeOut: number; muted: boolean;
  asset: string; fit: 'contain' | 'cover';
  x: number; y: number; scale: number; rotation: number; opacity: number; flipX: boolean; flipY: boolean;
  blend: string; filter: string; adjust: Adjust; effect: string; effectAmount: number;
  transitionIn: Transition | null; animIn: Transition | null; animOut: Transition | null;
  keyframes: Partial<Record<AnimProp, Keyframe[]>>;
  text: TextProps | null; shape: ShapeProps | null; sticker: string; synth: SynthProps | null;
}
export interface Track { id: string; name: string; kind: TrackKind; hidden: boolean; muted: boolean; locked: boolean; clips: Clip[] }
export interface Asset { id: string; name: string; kind: 'video' | 'image' | 'audio'; path: string; duration: number; width: number; height: number }
export interface Marker { t: number; label: string }
export interface Project {
  version: 1; title: string; width: number; height: number; fps: number; background: string;
  tracks: Track[]; assets: Asset[]; markers: Marker[];
}

/* ---------------------------------------------------------------- catalogues */

export const BLENDS: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', 'color-dodge': 'color-dodge', 'soft-light': 'soft-light', difference: 'difference',
};
type GlobalCompositeOperation = string;

export interface FilterPreset { label: string; brightness: number; contrast: number; saturate: number; hue: number; sepia: number; gray: number; blur: number }
const fp = (label: string, p: Partial<FilterPreset>): FilterPreset => ({ label, brightness: 1, contrast: 1, saturate: 1, hue: 0, sepia: 0, gray: 0, blur: 0, ...p });
export const FILTERS: Record<string, FilterPreset> = {
  none: fp('Original', {}),
  vivid: fp('Vivid', { contrast: 1.12, saturate: 1.45 }),
  warm: fp('Warm', { brightness: 1.04, saturate: 1.15, sepia: 0.22, hue: -8 }),
  cool: fp('Cool', { saturate: 1.05, hue: 12, brightness: 1.02, contrast: 1.04 }),
  cinematic: fp('Cinematic', { contrast: 1.2, saturate: 0.9, brightness: 0.96, sepia: 0.12, hue: -6 }),
  tealorange: fp('Teal & orange', { contrast: 1.15, saturate: 1.25, hue: 8, sepia: 0.1 }),
  vintage: fp('Vintage', { sepia: 0.55, contrast: 0.92, saturate: 0.85, brightness: 1.03 }),
  film: fp('Film', { contrast: 1.08, saturate: 0.88, sepia: 0.18, brightness: 1.02 }),
  bw: fp('Black & white', { gray: 1, contrast: 1.1 }),
  noir: fp('Noir', { gray: 1, contrast: 1.45, brightness: 0.88 }),
  fade: fp('Faded', { contrast: 0.82, brightness: 1.1, saturate: 0.8 }),
  dreamy: fp('Dreamy', { brightness: 1.1, contrast: 0.9, saturate: 1.15, blur: 0.6 }),
  sunset: fp('Sunset', { sepia: 0.35, saturate: 1.5, hue: -14, contrast: 1.05 }),
  neon: fp('Neon', { contrast: 1.25, saturate: 1.9, hue: 24, brightness: 1.05 }),
  matte: fp('Matte', { contrast: 0.88, saturate: 0.92, brightness: 1.05 }),
  moody: fp('Moody', { brightness: 0.85, contrast: 1.25, saturate: 0.8, hue: 6 }),
};

export const EFFECTS: Record<string, string> = {
  none: 'None', shake: 'Shake', pulse: 'Pulse (beat zoom)', glitch: 'Glitch', flicker: 'Flicker', glow: 'Glow', vignette: 'Vignette', grain: 'Film grain', rgb: 'RGB split',
};

export const TRANSITIONS: Record<string, string> = {
  fade: 'Dissolve', 'fade-black': 'Dip to black', flash: 'White flash', 'slide-left': 'Slide left', 'slide-right': 'Slide right', 'slide-up': 'Slide up', 'slide-down': 'Slide down',
  'wipe-left': 'Wipe left', 'wipe-right': 'Wipe right', 'wipe-up': 'Wipe up', 'wipe-down': 'Wipe down', 'zoom-in': 'Zoom in', 'zoom-out': 'Zoom out', spin: 'Spin', blur: 'Blur',
};

export const ANIMATIONS: Record<string, string> = {
  fade: 'Fade', 'slide-left': 'Slide from right', 'slide-right': 'Slide from left', 'slide-up': 'Slide from bottom', 'slide-down': 'Slide from top',
  'zoom-in': 'Zoom in', 'zoom-out': 'Zoom out', pop: 'Pop', spin: 'Spin', bounce: 'Bounce', typewriter: 'Typewriter', blur: 'Blur in',
};

export const TEXT_STYLES: Record<string, { label: string; y: number; text: Partial<TextProps> }> = {
  caption: { label: 'Caption', y: 0.28, text: { size: 5.2, bold: true, color: '#ffffff', stroke: '#000000', strokeWidth: 8, shadow: true, bg: '', font: 'sans', width: 0.84 } },
  'caption-box': { label: 'Caption (box)', y: 0.28, text: { size: 4.6, bold: true, color: '#ffffff', stroke: '', strokeWidth: 0, bg: '#000000b3', shadow: false, font: 'sans', width: 0.84 } },
  title: { label: 'Title', y: 0, text: { size: 10, bold: true, color: '#ffffff', stroke: '', strokeWidth: 0, shadow: true, bg: '', font: 'display', width: 0.86 } },
  'lower-third': { label: 'Lower third', y: 0.3, text: { size: 4.4, bold: true, color: '#111111', stroke: '', strokeWidth: 0, shadow: false, bg: '#ffd166', font: 'sans', align: 'left', width: 0.7 } },
  quote: { label: 'Quote', y: 0, text: { size: 6, bold: false, italic: true, color: '#fff5e6', stroke: '', strokeWidth: 0, shadow: true, bg: '', font: 'serif', width: 0.8 } },
  neon: { label: 'Neon', y: 0, text: { size: 9, bold: true, color: '#7efcf6', stroke: '#ff2fd0', strokeWidth: 6, shadow: true, bg: '', font: 'display', width: 0.86 } },
};

/* ---------------------------------------------------------------- helpers */

const num = (v: unknown, def: number, min = -Infinity, max = Infinity): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const round = (n: number, d = 3): number => { const k = 10 ** d; return Math.round(n * k) / k; };
const str = (v: unknown, def = '', max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const pick = <T extends string>(v: unknown, list: readonly T[], def: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : def);
export const clipEnd = (c: Clip): number => c.start + c.duration;
/** Length of the source material a clip plays (duration stretched by speed). */
export const sourceSpan = (c: Clip): number => c.duration * c.speed;

export function defaultText(): TextProps {
  return { text: 'Text', font: 'sans', size: 7, color: '#ffffff', bold: true, italic: false, align: 'center', stroke: '#000000', strokeWidth: 0, bg: '', shadow: true, letterSpacing: 0, lineHeight: 1.15, width: 0.84 };
}
export function defaultShape(): ShapeProps {
  return { shape: 'rect', w: 0.5, h: 0.3, color: '#ff4d6d', color2: '', angle: 90, radius: 0, stroke: '', strokeWidth: 0 };
}
export function defaultSynth(): SynthProps {
  return { preset: 'tone', note: 'A3', bpm: 110, scale: 'minor', wave: 'sine' };
}

export function newClip(id: string, kind: ClipKind, start = 0, duration = 3): Clip {
  return {
    id, kind, name: '', start, duration, offset: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false, asset: '', fit: 'contain',
    x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipX: false, flipY: false, blend: 'normal', filter: 'none', adjust: emptyAdjust(), effect: 'none', effectAmount: 0.5,
    transitionIn: null, animIn: null, animOut: null, keyframes: {},
    text: kind === 'text' ? defaultText() : null, shape: kind === 'shape' ? defaultShape() : null, sticker: kind === 'sticker' ? '⭐' : '', synth: kind === 'synth' ? defaultSynth() : null,
  };
}

export function emptyProject(title = 'Untitled video', aspect = '9:16'): Project {
  const a = ASPECTS[aspect] ?? ASPECTS['9:16'];
  const track = (id: string, name: string, kind: TrackKind): Track => ({ id, name, kind, hidden: false, muted: false, locked: false, clips: [] });
  return {
    version: 1, title, width: a.w, height: a.h, fps: 30, background: '#000000',
    tracks: [track('t1', 'Main', 'video'), track('t2', 'Overlay', 'video'), track('t3', 'Text', 'video'), track('t4', 'Audio', 'audio')],
    assets: [], markers: [],
  };
}

export const projectDuration = (p: Project): number => round(p.tracks.reduce((m, t) => t.clips.reduce((mm, c) => Math.max(mm, clipEnd(c)), m), 0));
export const allClips = (p: Project): Clip[] => p.tracks.flatMap((t) => t.clips);
export function findClip(p: Project, id: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) { const index = track.clips.findIndex((c) => c.id === id); if (index >= 0) return { track, clip: track.clips[index], index }; }
  return null;
}
export const findAsset = (p: Project, id: string): Asset | undefined => p.assets.find((a) => a.id === id);

/* ---------------------------------------------------------------- normalize (repair whatever is on disk) */

function normKeyframes(raw: unknown): Clip['keyframes'] {
  const out: Clip['keyframes'] = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const prop of ANIM_PROPS) {
    const list = (raw as Record<string, unknown>)[prop];
    if (!Array.isArray(list)) continue;
    const frames = list.filter((k) => k && typeof k === 'object').map((k) => {
      const o = k as Record<string, unknown>;
      return { t: round(num(o.t, 0, 0, MAX_DURATION)), v: num(o.v, 0, -1000, 1000), ease: pick(o.ease, EASES, 'linear') as EaseId };
    }).sort((a, b) => a.t - b.t);
    if (frames.length) out[prop] = frames;
  }
  return out;
}
const normTransition = (raw: unknown, types: Record<string, string>): Transition | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return typeof o.type === 'string' && o.type in types ? { type: o.type, duration: round(num(o.duration, 0.5, 0.1, 5)) } : null;
};

function normClip(raw: unknown, fallbackId: string, warnings: string[]): Clip | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = pick(o.kind, ['video', 'image', 'audio', 'text', 'shape', 'sticker', 'synth'] as const, 'shape');
  if (typeof o.kind !== 'string') warnings.push(`clip ${fallbackId} had no kind`);
  const c = newClip(str(o.id, fallbackId, 40) || fallbackId, kind, round(num(o.start, 0, 0, MAX_DURATION)), round(num(o.duration, 3, MIN_CLIP, MAX_DURATION)));
  c.name = str(o.name, '', 80); c.offset = round(num(o.offset, 0, 0, 100000)); c.speed = round(num(o.speed, 1, 0.1, 8));
  c.volume = round(num(o.volume, 1, 0, 4)); c.fadeIn = round(num(o.fadeIn, 0, 0, 60)); c.fadeOut = round(num(o.fadeOut, 0, 0, 60)); c.muted = bool(o.muted, false);
  c.asset = str(o.asset, '', 40); c.fit = pick(o.fit, ['contain', 'cover'] as const, 'contain');
  c.x = round(num(o.x, 0, -5, 5)); c.y = round(num(o.y, 0, -5, 5)); c.scale = round(num(o.scale, 1, 0.01, 20)); c.rotation = round(num(o.rotation, 0, -3600, 3600), 2);
  c.opacity = round(num(o.opacity, 1, 0, 1)); c.flipX = bool(o.flipX, false); c.flipY = bool(o.flipY, false);
  c.blend = typeof o.blend === 'string' && o.blend in BLENDS ? o.blend : 'normal';
  c.filter = typeof o.filter === 'string' && o.filter in FILTERS ? o.filter : 'none';
  const adj = o.adjust && typeof o.adjust === 'object' ? (o.adjust as Record<string, unknown>) : {};
  for (const key of Object.keys(ADJUST_RANGES) as (keyof Adjust)[]) c.adjust[key] = num(adj[key], 0, ADJUST_RANGES[key][0], ADJUST_RANGES[key][1]);
  c.effect = typeof o.effect === 'string' && o.effect in EFFECTS ? o.effect : 'none'; c.effectAmount = round(num(o.effectAmount, 0.5, 0, 1));
  c.transitionIn = normTransition(o.transitionIn, TRANSITIONS); c.animIn = normTransition(o.animIn, ANIMATIONS); c.animOut = normTransition(o.animOut, ANIMATIONS);
  c.keyframes = normKeyframes(o.keyframes);
  if (kind === 'text') {
    const t = (o.text && typeof o.text === 'object' ? o.text : {}) as Record<string, unknown>; const d = defaultText();
    c.text = {
      text: str(t.text, d.text, 2000), font: pick(t.font, FONTS, d.font), size: num(t.size, d.size, 0.5, 60), color: str(t.color, d.color, 40), bold: bool(t.bold, d.bold), italic: bool(t.italic, d.italic),
      align: pick(t.align, ['left', 'center', 'right'] as const, d.align), stroke: str(t.stroke, d.stroke, 40), strokeWidth: num(t.strokeWidth, 0, 0, 40), bg: str(t.bg, d.bg, 40), shadow: bool(t.shadow, d.shadow),
      letterSpacing: num(t.letterSpacing, 0, -10, 40), lineHeight: num(t.lineHeight, d.lineHeight, 0.6, 3), width: num(t.width, d.width, 0.1, 1),
    };
  }
  if (kind === 'shape') {
    const s = (o.shape && typeof o.shape === 'object' ? o.shape : {}) as Record<string, unknown>; const d = defaultShape();
    c.shape = {
      shape: pick(s.shape, SHAPES, d.shape), w: num(s.w, d.w, 0.005, 5), h: num(s.h, d.h, 0.005, 5), color: str(s.color, d.color, 40), color2: str(s.color2, '', 40), angle: num(s.angle, 90, -360, 360),
      radius: num(s.radius, 0, 0, 0.5), stroke: str(s.stroke, '', 40), strokeWidth: num(s.strokeWidth, 0, 0, 80),
    };
  }
  if (kind === 'sticker') c.sticker = str(o.sticker, '⭐', 16) || '⭐';
  if (kind === 'synth') {
    const s = (o.synth && typeof o.synth === 'object' ? o.synth : {}) as Record<string, unknown>; const d = defaultSynth();
    c.synth = { preset: pick(s.preset, SYNTH_PRESETS, d.preset), note: /^[A-Ga-g][#b]?[0-8]$/.test(str(s.note)) ? str(s.note) : d.note, bpm: num(s.bpm, d.bpm, 40, 220), scale: pick(s.scale, ['major', 'minor'] as const, d.scale), wave: pick(s.wave, ['sine', 'square', 'sawtooth', 'triangle'] as const, d.wave) };
  }
  return c;
}

export interface NormalizeResult { project: Project; warnings: string[] }
export function normalizeProject(raw: unknown, fallbackTitle = 'Untitled video'): NormalizeResult {
  const warnings: string[] = [];
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = emptyProject(str(o.title, fallbackTitle, 120) || fallbackTitle);
  const project: Project = {
    ...base, width: Math.round(num(o.width, base.width, 64, 4096)), height: Math.round(num(o.height, base.height, 64, 4096)), fps: Math.round(num(o.fps, 30, 1, 60)),
    background: str(o.background, '#000000', 40), tracks: [], assets: [], markers: [],
  };
  const ids = new Set<string>();
  const unique = (id: string, prefix: string): string => { let n = ids.size + 1; let out = id; while (!out || ids.has(out)) out = `${prefix}${n++}`; ids.add(out); return out; };
  if (Array.isArray(o.assets)) {
    for (const a of o.assets.slice(0, 200)) {
      if (!a || typeof a !== 'object') continue;
      const r = a as Record<string, unknown>;
      project.assets.push({ id: unique(str(r.id, '', 40), 'a'), name: str(r.name, 'media', 120), kind: pick(r.kind, ['video', 'image', 'audio'] as const, 'video'), path: str(r.path, '', 500), duration: num(r.duration, 0, 0, 100000), width: num(r.width, 0, 0, 20000), height: num(r.height, 0, 0, 20000) });
    }
  }
  const tracks = Array.isArray(o.tracks) ? o.tracks.slice(0, MAX_TRACKS) : [];
  let clipCount = 0;
  for (const [ti, t] of tracks.entries()) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const track: Track = { id: unique(str(r.id, '', 40), 't'), name: str(r.name, `Track ${ti + 1}`, 60), kind: pick(r.kind, ['video', 'audio'] as const, 'video'), hidden: bool(r.hidden, false), muted: bool(r.muted, false), locked: bool(r.locked, false), clips: [] };
    for (const raw of Array.isArray(r.clips) ? r.clips : []) {
      if (clipCount >= MAX_CLIPS) { warnings.push(`only the first ${MAX_CLIPS} clips were kept`); break; }
      const clip = normClip(raw, `c${clipCount + 1}`, warnings);
      if (!clip) continue;
      clip.id = unique(clip.id, 'c');
      if (clip.asset && !project.assets.some((a) => a.id === clip.asset)) { warnings.push(`clip ${clip.id} pointed at a missing asset, so it was cleared`); clip.asset = ''; }
      track.clips.push(clip); clipCount++;
    }
    track.clips.sort((a, b) => a.start - b.start);
    project.tracks.push(track);
  }
  if (project.tracks.length === 0) { project.tracks = base.tracks; if (tracks.length) warnings.push('no usable tracks; started with the default tracks'); }
  if (Array.isArray(o.markers)) for (const m of o.markers.slice(0, 200)) { if (m && typeof m === 'object') project.markers.push({ t: round(num((m as Record<string, unknown>).t, 0, 0, MAX_DURATION)), label: str((m as Record<string, unknown>).label, '', 60) }); }
  project.markers.sort((a, b) => a.t - b.t);
  return { project, warnings };
}
export function parseProjectJson(text: string, fallbackTitle = 'Untitled video'): NormalizeResult {
  try { return normalizeProject(JSON.parse(text), fallbackTitle); } catch { return { project: emptyProject(fallbackTitle), warnings: ['The file was not valid JSON; started an empty project.'] }; }
}
export const serializeProject = (p: Project): string => JSON.stringify(p, null, 1);

/* ---------------------------------------------------------------- evaluation: what is on screen at time t */

export function keyframeValue(frames: Keyframe[] | undefined, local: number, fallback: number): number {
  if (!frames || frames.length === 0) return fallback;
  if (local <= frames[0].t) return frames[0].v;
  const last = frames[frames.length - 1];
  if (local >= last.t) return last.v;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    if (local >= a.t && local <= b.t) { const span = b.t - a.t; return a.v + (b.v - a.v) * ease(a.ease, span <= 0 ? 1 : (local - a.t) / span); }
  }
  return last.v;
}

export interface Motion { opacity: number; dx: number; dy: number; scale: number; rot: number; blur: number; wipe: { dir: 'left' | 'right' | 'up' | 'down'; p: number } | null; flash: number; dip: number }
const noMotion = (): Motion => ({ opacity: 1, dx: 0, dy: 0, scale: 1, rot: 0, blur: 0, wipe: null, flash: 0, dip: 0 });

/** How an entering (kind 'in', p 0→1) or leaving (kind 'out', p 0→1) clip is displaced by an animation. */
export function animMotion(type: string, kind: 'in' | 'out', p: number): Motion {
  const m = noMotion();
  const q = kind === 'in' ? 1 - ease('ease-out', p) : ease('ease-in', p); // 1 = fully "away", 0 = at rest
  switch (type) {
    case 'fade': m.opacity = 1 - q; break;
    case 'slide-left': m.dx = 0.6 * q * (kind === 'in' ? 1 : -1); m.opacity = 1 - q * 0.6; break;
    case 'slide-right': m.dx = -0.6 * q * (kind === 'in' ? 1 : -1); m.opacity = 1 - q * 0.6; break;
    case 'slide-up': m.dy = -0.5 * q * (kind === 'in' ? 1 : -1); m.opacity = 1 - q * 0.6; break;
    case 'slide-down': m.dy = 0.5 * q * (kind === 'in' ? 1 : -1); m.opacity = 1 - q * 0.6; break;
    case 'zoom-in': m.scale = kind === 'in' ? 0.3 + 0.7 * (1 - q) : 1 + 0.7 * q; m.opacity = 1 - q; break;
    case 'zoom-out': m.scale = kind === 'in' ? 1.6 - 0.6 * (1 - q) : 1 - 0.7 * q; m.opacity = 1 - q; break;
    case 'pop': { const s = kind === 'in' ? ease('back', p) : 1 - ease('ease-in', p); m.scale = Math.max(0, s); m.opacity = kind === 'in' ? Math.min(1, p * 4) : 1 - q; break; }
    case 'spin': m.rot = 180 * q * (kind === 'in' ? -1 : 1); m.scale = 1 - 0.7 * q; m.opacity = 1 - q; break;
    case 'bounce': m.dy = kind === 'in' ? -0.4 * (1 - ease('bounce', p)) : 0.4 * ease('ease-in', p); m.opacity = kind === 'in' ? Math.min(1, p * 5) : 1 - q; break;
    case 'blur': m.blur = 24 * q; m.opacity = 1 - q * 0.7; break;
    case 'typewriter': m.opacity = 1; break;
    default: break;
  }
  return m;
}

/** Motion for the clip coming in (inc) and the clip going out (out) while a transition at progress p (0→1) plays. */
export function transitionMotion(type: string, p: number): { inc: Motion; out: Motion } {
  const inc = noMotion(), out = noMotion();
  const e = ease('ease-in-out', p);
  switch (type) {
    case 'fade': inc.opacity = e; break;
    case 'fade-black': out.opacity = 1 - Math.min(1, p * 2); inc.opacity = Math.max(0, p * 2 - 1); out.dip = Math.min(1, p * 2); break;
    case 'flash': inc.opacity = p < 0.5 ? 0 : 1; out.opacity = p < 0.5 ? 1 : 0; inc.flash = out.flash = 1 - Math.abs(p - 0.5) * 2; break;
    case 'slide-left': inc.dx = 1 - e; out.dx = -e; break;
    case 'slide-right': inc.dx = -(1 - e); out.dx = e; break;
    case 'slide-up': inc.dy = -(1 - e); out.dy = e; break;
    case 'slide-down': inc.dy = 1 - e; out.dy = -e; break;
    case 'wipe-left': inc.wipe = { dir: 'left', p: e }; break;
    case 'wipe-right': inc.wipe = { dir: 'right', p: e }; break;
    case 'wipe-up': inc.wipe = { dir: 'up', p: e }; break;
    case 'wipe-down': inc.wipe = { dir: 'down', p: e }; break;
    case 'zoom-in': inc.scale = 0.6 + 0.4 * e; inc.opacity = e; out.scale = 1 + 0.5 * e; out.opacity = 1 - e; break;
    case 'zoom-out': inc.scale = 1.5 - 0.5 * e; inc.opacity = e; out.scale = 1 - 0.4 * e; out.opacity = 1 - e; break;
    case 'spin': inc.rot = -90 * (1 - e); inc.scale = 0.5 + 0.5 * e; inc.opacity = e; out.rot = 90 * e; out.scale = 1 - 0.5 * e; out.opacity = 1 - e; break;
    case 'blur': inc.blur = 30 * (1 - e); inc.opacity = e; out.blur = 30 * e; out.opacity = 1 - e; break;
    default: inc.opacity = e; break;
  }
  return { inc, out };
}

export interface EffectState { dx: number; dy: number; scale: number; brightness: number; opacity: number; rot: number }
/** Per-frame displacement of the "movement" effects. The overlay ones (glow, vignette, grain, rgb, glitch bars) are drawn by the renderer. */
export function effectState(effect: string, amount: number, t: number): EffectState {
  const s: EffectState = { dx: 0, dy: 0, scale: 1, brightness: 1, opacity: 1, rot: 0 };
  const a = Math.min(1, Math.max(0, amount));
  const hash = (n: number): number => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const step = Math.floor(t * 24);
  switch (effect) {
    case 'shake': s.dx = (hash(step) - 0.5) * 0.04 * a; s.dy = (hash(step + 99) - 0.5) * 0.03 * a; s.rot = (hash(step + 7) - 0.5) * 2 * a; s.scale = 1 + 0.03 * a; break;
    case 'pulse': { const beat = (t * 2) % 1; s.scale = 1 + 0.08 * a * (1 - ease('ease-out', Math.min(1, beat * 2))); break; }
    case 'glitch': { const on = hash(step) > 0.72; if (on) { s.dx = (hash(step + 3) - 0.5) * 0.08 * a; s.brightness = 1 + 0.3 * a * hash(step + 5); } break; }
    case 'flicker': s.brightness = 1 - 0.35 * a * hash(step); s.opacity = 1 - 0.15 * a * (hash(step + 1) > 0.85 ? 1 : 0); break;
    default: break;
  }
  return s;
}

export function filterCss(clip: Clip, extra = 1, blurExtra = 0): string {
  const p = FILTERS[clip.filter] ?? FILTERS.none, a = clip.adjust;
  const brightness = (p.brightness * (1 + a.brightness / 100)) * extra;
  const contrast = p.contrast * (1 + a.contrast / 100);
  const saturate = p.saturate * (1 + a.saturation / 100);
  const hue = p.hue + a.hue;
  const blur = p.blur + a.blur / 10 + blurExtra;
  const parts: string[] = [];
  if (Math.abs(brightness - 1) > 0.001) parts.push(`brightness(${round(Math.max(0, brightness))})`);
  if (Math.abs(contrast - 1) > 0.001) parts.push(`contrast(${round(Math.max(0, contrast))})`);
  if (Math.abs(saturate - 1) > 0.001) parts.push(`saturate(${round(Math.max(0, saturate))})`);
  if (Math.abs(hue) > 0.01) parts.push(`hue-rotate(${round(hue, 1)}deg)`);
  if (p.sepia > 0.001) parts.push(`sepia(${round(p.sepia)})`);
  if (p.gray > 0.001) parts.push(`grayscale(${round(p.gray)})`);
  if (blur > 0.01) parts.push(`blur(${round(blur, 2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

export interface RenderLayer {
  clip: Clip; track: Track; local: number; src: number; outgoing: boolean;
  x: number; y: number; scale: number; rotation: number; opacity: number;
  css: string; wipe: Motion['wipe']; flash: number; dip: number; reveal: number;
  fx: EffectState; effect: string; effectAmount: number; t: number;
}

const ADJACENT = 0.04;
function previousClip(track: Track, clip: Clip): Clip | null {
  let best: Clip | null = null;
  for (const c of track.clips) if (c !== clip && Math.abs(clipEnd(c) - clip.start) <= ADJACENT && VISUAL_KINDS.includes(c.kind)) best = c;
  return best;
}
const mix = (a: Motion, b: Motion): Motion => ({
  opacity: a.opacity * b.opacity, dx: a.dx + b.dx, dy: a.dy + b.dy, scale: a.scale * b.scale, rot: a.rot + b.rot, blur: a.blur + b.blur, wipe: b.wipe ?? a.wipe, flash: Math.max(a.flash, b.flash), dip: Math.max(a.dip, b.dip),
});

function layerFor(track: Track, clip: Clip, t: number, motion: Motion, outgoing: boolean): RenderLayer | null {
  const local = t - clip.start;
  const frames = clip.keyframes;
  let m = motion;
  if (clip.animIn && local < clip.animIn.duration) m = mix(m, animMotion(clip.animIn.type, 'in', local / clip.animIn.duration));
  if (clip.animOut && local > clip.duration - clip.animOut.duration && !outgoing) m = mix(m, animMotion(clip.animOut.type, 'out', (local - (clip.duration - clip.animOut.duration)) / clip.animOut.duration));
  let opacity = keyframeValue(frames.opacity, local, clip.opacity) * m.opacity;
  if (clip.fadeIn > 0 && local < clip.fadeIn) opacity *= local / clip.fadeIn;
  if (clip.fadeOut > 0 && local > clip.duration - clip.fadeOut && !outgoing) opacity *= Math.max(0, (clip.duration - local) / clip.fadeOut);
  const fx = effectState(clip.effect, clip.effectAmount, t);
  opacity *= fx.opacity;
  if (opacity <= 0.001 && !m.wipe) return null;
  let reveal = 1;
  if (clip.kind === 'text') {
    if (clip.animIn?.type === 'typewriter') reveal = Math.min(1, Math.max(0, local / clip.animIn.duration));
  }
  return {
    clip, track, local, src: clip.offset + local * clip.speed, outgoing, t,
    x: keyframeValue(frames.x, local, clip.x) + m.dx + fx.dx, y: keyframeValue(frames.y, local, clip.y) + m.dy + fx.dy,
    scale: keyframeValue(frames.scale, local, clip.scale) * m.scale * fx.scale, rotation: keyframeValue(frames.rotation, local, clip.rotation) + m.rot + fx.rot,
    opacity: Math.min(1, opacity), css: filterCss(clip, fx.brightness, m.blur), wipe: m.wipe, flash: m.flash, dip: m.dip, reveal, fx, effect: clip.effect, effectAmount: clip.effectAmount,
  };
}

/** The visual layers on screen at time t, bottom first. Transitions keep the previous clip on screen while the next one comes in. */
export function layersAt(project: Project, t: number): RenderLayer[] {
  const out: RenderLayer[] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    for (const clip of clips) {
      if (!VISUAL_KINDS.includes(clip.kind)) continue;
      const tr = clip.transitionIn;
      if (tr) {
        const prev = previousClip(track, clip);
        if (prev && t >= clip.start && t < clip.start + tr.duration) {
          const p = (t - clip.start) / tr.duration;
          const { inc, out: outM } = transitionMotion(tr.type, p);
          const old = layerFor(track, prev, t, outM, true);
          if (old) { old.local = prev.duration + (t - clip.start); old.src = prev.offset + old.local * prev.speed; out.push(old); }
          const inLayer = layerFor(track, clip, t, inc, false);
          if (inLayer) out.push(inLayer);
          continue;
        }
      }
      if (t >= clip.start && t < clipEnd(clip)) {
        const layer = layerFor(track, clip, t, noMotion(), false);
        if (layer) out.push(layer);
      }
    }
  }
  return out;
}

/** Gain (0..4) of a clip's sound at clip-local time. */
export function gainAt(clip: Clip, local: number, trackMuted = false): number {
  if (clip.muted || trackMuted) return 0;
  let g = keyframeValue(clip.keyframes.volume, local, clip.volume);
  if (clip.fadeIn > 0 && local < clip.fadeIn) g *= Math.max(0, local / clip.fadeIn);
  if (clip.fadeOut > 0 && local > clip.duration - clip.fadeOut) g *= Math.max(0, (clip.duration - local) / clip.fadeOut);
  return Math.max(0, g);
}

/* ---------------------------------------------------------------- synthesised sound */

const NOTE_INDEX: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export function noteFreq(note: string): number {
  const m = /^([A-Ga-g])([#b]?)([0-8])$/.exec(note);
  if (!m) return 220;
  const semis = NOTE_INDEX[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * 2 ** ((semis - 69) / 12);
}
export interface SynthEvent { t: number; dur: number; kind: 'osc' | 'noise'; freq: number; wave: SynthProps['wave']; gain: number; sweepTo?: number; lowpass?: number }
const MAJOR = [0, 2, 4, 7, 9, 12, 14, 16], MINOR = [0, 2, 3, 7, 8, 12, 14, 15];

/** The notes a synth clip plays over its duration, as plain events the audio engine schedules. */
export function synthEvents(s: SynthProps, duration: number): SynthEvent[] {
  const events: SynthEvent[] = [];
  const base = noteFreq(s.note), beat = 60 / s.bpm;
  const steps = s.scale === 'major' ? MAJOR : MINOR;
  const at = (semi: number): number => base * 2 ** (semi / 12);
  switch (s.preset) {
    case 'tone': events.push({ t: 0, dur: duration, kind: 'osc', freq: base, wave: s.wave, gain: 0.35 }); break;
    case 'pad': for (const semi of [0, steps[2], steps[3]]) events.push({ t: 0, dur: duration, kind: 'osc', freq: at(semi), wave: 'triangle', gain: 0.16 }); break;
    case 'bass': for (let t = 0; t < duration; t += beat) events.push({ t, dur: beat * 0.9, kind: 'osc', freq: at(t / beat % 4 < 2 ? 0 : steps[3] - 12), wave: 'sawtooth', gain: 0.22, lowpass: 400 }); break;
    case 'arp': for (let i = 0, t = 0; t < duration; t += beat / 2, i++) events.push({ t, dur: beat / 2 * 0.8, kind: 'osc', freq: at(steps[[0, 2, 4, 2, 5, 4, 2, 1][i % 8]] ), wave: 'triangle', gain: 0.2 }); break;
    case 'beat':
      for (let i = 0, t = 0; t < duration; t += beat / 2, i++) {
        const step = i % 8;
        if (step === 0 || step === 3 || step === 4) events.push({ t, dur: 0.18, kind: 'osc', freq: 120, wave: 'sine', gain: 0.6, sweepTo: 45 });
        if (step === 2 || step === 6) events.push({ t, dur: 0.14, kind: 'noise', freq: 0, wave: 'sine', gain: 0.28, lowpass: 5000 });
        if (step % 2 === 1 || step === 4) events.push({ t, dur: 0.05, kind: 'noise', freq: 0, wave: 'sine', gain: 0.1, lowpass: 12000 });
      }
      break;
    case 'riser': events.push({ t: 0, dur: duration, kind: 'noise', freq: 0, wave: 'sine', gain: 0.3, lowpass: 8000 }, { t: 0, dur: duration, kind: 'osc', freq: base, wave: 'sawtooth', gain: 0.12, sweepTo: base * 8 }); break;
    case 'whoosh': events.push({ t: 0, dur: Math.min(duration, 1.2), kind: 'noise', freq: 0, wave: 'sine', gain: 0.4, lowpass: 3000 }); break;
    case 'click': events.push({ t: 0, dur: 0.04, kind: 'osc', freq: 1800, wave: 'square', gain: 0.25 }); break;
    case 'impact': events.push({ t: 0, dur: Math.min(duration, 1.2), kind: 'osc', freq: 90, wave: 'sine', gain: 0.8, sweepTo: 30 }, { t: 0, dur: 0.5, kind: 'noise', freq: 0, wave: 'sine', gain: 0.4, lowpass: 2500 }); break;
    default: break;
  }
  return events.filter((e) => e.t < duration);
}

/* ---------------------------------------------------------------- captions from a script */

export interface Cue { text: string; start: number; duration: number }
/** Splits a script into on-screen cues: at most `maxChars` per line, reading speed `cps`, 1–6 s per cue, optionally fitted into [start, end]. */
export function captionCues(script: string, start = 0, end?: number, opts: { maxChars?: number; lines?: number; cps?: number } = {}): Cue[] {
  const maxChars = Math.round(num(opts.maxChars, 32, 8, 80)), lines = Math.round(num(opts.lines, 1, 1, 3)), cps = num(opts.cps, 15, 5, 30);
  const words = script.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks: string[] = [];
  let line: string[] = [], cue: string[] = [];
  const lineLen = (): number => line.join(' ').length;
  const flushLine = (): void => { if (line.length) { cue.push(line.join(' ')); line = []; } };
  const flushCue = (): void => { flushLine(); if (cue.length) { chunks.push(cue.join('\n')); cue = []; } };
  for (const w of words) {
    if (line.length && lineLen() + 1 + w.length > maxChars) { flushLine(); if (cue.length >= lines) flushCue(); }
    line.push(w);
    if (/[.!?…]$/.test(w) && lineLen() >= maxChars * 0.5) flushCue();
    else if (/[,;:]$/.test(w) && lineLen() >= maxChars * 0.7) { flushLine(); if (cue.length >= lines) flushCue(); }
  }
  flushCue();
  const raw = chunks.map((c) => Math.min(6, Math.max(1, c.replace(/\n/g, ' ').length / cps)));
  const total = raw.reduce((a, b) => a + b, 0);
  const k = end !== undefined && total > 0 ? Math.max(0.2, (end - start) / total) : 1;
  let t = start;
  return chunks.map((text, i) => { const duration = round(raw[i] * k); const cueOut = { text, start: round(t), duration }; t += duration; return cueOut; });
}

/* ---------------------------------------------------------------- operations (the single way to change a project) */

export const OP_HELP = [
  '{"op":"project","title":"…","aspect":"9:16|16:9|1:1|4:5|4:3|21:9","width":1080,"height":1920,"fps":30,"background":"#000"} — canvas settings',
  '{"op":"track_add","kind":"video|audio","name":"B-roll"} — new track on top (video tracks stack: later = in front); {"op":"track_set","track":"t2","hidden":true,"muted":true,"locked":false,"name":"…"}; {"op":"track_remove","track":"t2"}',
  '{"op":"asset_add","path":"clips/intro.mp4","name":"intro","kind":"video|image|audio","duration":12.5} — register a media file that is already in the workspace (the editor fills in size and duration on load)',
  '{"op":"clip_add","kind":"video|image|audio|text|shape|sticker|synth","asset":"a1","track":"t1","start":0,"duration":3, …props} — add a clip. Text: "text":"Hello" (or an object with font,size,color,bold,italic,align,stroke,strokeWidth,bg,shadow); style:"caption|caption-box|title|lower-third|quote|neon". Shape: "shape":{"shape":"rect|ellipse|triangle|star|heart|line|arrow","w":0.5,"h":0.3,"color":"#ff4d6d","color2":"#7b2cbf","angle":90,"radius":0.1}. Sticker: "sticker":"🔥". Synth: "synth":{"preset":"tone|pad|beat|arp|bass|riser|whoosh|click|impact","note":"A2","bpm":120,"scale":"minor","wave":"sine"}',
  'Clip props (clip_add / clip_set): start, duration, offset (source in-point, s), speed 0.1–8, volume 0–4 (1 = 100%), fadeIn, fadeOut, muted, fit contain|cover, x, y (fraction of the canvas from the centre: 0.5 = the edge), scale, rotation (deg), opacity 0–1, flipX, flipY, blend normal|multiply|screen|overlay|darken|lighten|color-dodge|soft-light|difference, filter (preset id), adjust {brightness,contrast,saturation,hue,blur,vignette,grain}, effect none|shake|pulse|glitch|flicker|glow|vignette|grain|rgb, effectAmount 0–1, name',
  '{"op":"clip_set","clip":"c3", …props} · {"op":"clip_move","clip":"c3","start":4,"track":"t2"} · {"op":"clip_trim","clip":"c3","from":1.5,"to":6} (new start/end on the timeline, source stays in place) · {"op":"clip_split","clip":"c3","at":2.5} · {"op":"clip_duplicate","clip":"c3","start":8} · {"op":"clip_delete","clip":"c3","ripple":true}',
  '{"op":"arrange","clips":["c1","c2","c3"],"gap":0,"start":0} — put clips back to back on their track; {"op":"transition_set","clip":"c2","type":"fade|fade-black|flash|slide-left|slide-right|slide-up|slide-down|wipe-left|wipe-right|wipe-up|wipe-down|zoom-in|zoom-out|spin|blur|none","duration":0.5} — plays over the cut between the previous clip on the track and this one',
  '{"op":"anim_set","clip":"c3","which":"in|out","type":"fade|slide-left|slide-right|slide-up|slide-down|zoom-in|zoom-out|pop|spin|bounce|typewriter|blur|none","duration":0.5}',
  '{"op":"keyframe_set","clip":"c3","prop":"x|y|scale|rotation|opacity|volume","t":0,"v":1,"ease":"linear|ease-in|ease-out|ease-in-out|back|bounce|hold"} (t = seconds from the clip start) · {"op":"keyframe_clear","clip":"c3","prop":"scale","t":1} (omit t to clear the property) · {"op":"kenburns","clip":"c3","from":1,"to":1.18,"dx":0.03,"dy":0} — slow zoom/pan for stills',
  '{"op":"captions","text":"full script…","start":0,"end":20,"track":"t3","style":"caption","maxChars":32,"lines":1} — split a script into timed text clips (≤ maxChars per line, ~15 characters/second); {"op":"duck","clip":"c9","under":["t4"],"db":14} — lower a music clip while the clips on the given tracks play; {"op":"marker_add","t":2.5,"label":"drop"} · {"op":"markers_bpm","bpm":120,"from":0,"to":16,"every":4}',
].join('\n');

export interface Op { op: string; [key: string]: unknown }
const OP_NAMES = ['project', 'track_add', 'track_set', 'track_remove', 'asset_add', 'clip_add', 'clip_set', 'clip_move', 'clip_trim', 'clip_split', 'clip_duplicate', 'clip_delete', 'arrange', 'transition_set', 'anim_set', 'keyframe_set', 'keyframe_clear', 'kenburns', 'captions', 'duck', 'marker_add', 'markers_bpm'];
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

const CLIP_NUMBERS: Record<string, [number, number, number]> = {
  start: [0, MAX_DURATION, 3], duration: [MIN_CLIP, MAX_DURATION, 3], offset: [0, 100000, 3], speed: [0.1, 8, 3], volume: [0, 4, 3], fadeIn: [0, 60, 3], fadeOut: [0, 60, 3],
  x: [-5, 5, 4], y: [-5, 5, 4], scale: [0.01, 20, 4], rotation: [-3600, 3600, 2], opacity: [0, 1, 3], effectAmount: [0, 1, 3],
};

export class OpError extends Error {}
const fail = (message: string): never => { throw new OpError(message); };

class Editor {
  project: Project;
  log: string[] = [];
  last = '';
  constructor(project: Project) { this.project = project; }

  nextId(prefix: string, taken: string[]): string { let n = taken.length + 1; while (taken.includes(`${prefix}${n}`)) n++; return `${prefix}${n}`; }
  clipIds(): string[] { return allClips(this.project).map((c) => c.id); }
  track(ref: unknown): Track {
    const key = String(ref ?? '');
    const t = this.project.tracks.find((x) => x.id === key) ?? this.project.tracks.find((x) => x.name.toLowerCase() === key.toLowerCase());
    return t ?? fail(`no track "${key}" (tracks: ${this.project.tracks.map((x) => `${x.id}=${x.name}`).join(', ')})`);
  }
  clip(ref: unknown): { track: Track; clip: Clip; index: number } {
    const key = ref === 'last' ? this.last : String(ref ?? '');
    return findClip(this.project, key) ?? fail(`no clip "${key}" (clips: ${this.clipIds().join(', ') || 'none'})`);
  }
  defaultTrack(kind: ClipKind): Track {
    const wantAudio = kind === 'audio' || kind === 'synth';
    const wantKind: TrackKind = wantAudio ? 'audio' : 'video';
    const byName = (name: string): Track | undefined => this.project.tracks.find((t) => t.kind === 'video' && t.name.toLowerCase() === name);
    const list = this.project.tracks.filter((t) => t.kind === wantKind && !t.locked);
    if (kind === 'text') return byName('text') ?? list[list.length - 1] ?? this.addTrack('video', 'Text');
    if (kind === 'video' || kind === 'image') return list[0] ?? this.addTrack('video', 'Main');
    if (kind === 'shape' || kind === 'sticker') return byName('overlay') ?? list[Math.min(1, list.length - 1)] ?? this.addTrack('video', 'Overlay');
    return list[0] ?? this.addTrack('audio', 'Audio');
  }
  addTrack(kind: TrackKind, name: string): Track {
    if (this.project.tracks.length >= MAX_TRACKS) fail(`at most ${MAX_TRACKS} tracks`);
    const track: Track = { id: this.nextId('t', this.project.tracks.map((t) => t.id)), name: name.slice(0, 60) || (kind === 'audio' ? 'Audio' : 'Video'), kind, hidden: false, muted: false, locked: false, clips: [] };
    this.project.tracks.push(track);
    return track;
  }
  trackEnd(track: Track): number { return track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0); }

  setProps(clip: Clip, props: Record<string, unknown>, creating = false): void {
    for (const [key, value] of Object.entries(props)) {
      if (['op', 'clip', 'track', 'kind', 'id', 'style'].includes(key)) continue;
      if (key in CLIP_NUMBERS) {
        const [min, max, d] = CLIP_NUMBERS[key]; const n = Number(value);
        if (!Number.isFinite(n)) fail(`${key} must be a number`);
        (clip as unknown as Record<string, number>)[key] = round(Math.min(max, Math.max(min, n)), d);
      } else if (key === 'muted' || key === 'flipX' || key === 'flipY') {
        (clip as unknown as Record<string, boolean>)[key] = value === true || value === 'true';
      } else if (key === 'fit') {
        if (value !== 'contain' && value !== 'cover') fail('fit must be "contain" or "cover"'); clip.fit = value as Clip['fit'];
      } else if (key === 'blend') {
        if (typeof value !== 'string' || !(value in BLENDS)) fail(`blend must be one of ${Object.keys(BLENDS).join(', ')}`); clip.blend = value as string;
      } else if (key === 'filter') {
        if (typeof value !== 'string' || !(value in FILTERS)) fail(`filter must be one of ${Object.keys(FILTERS).join(', ')}`); clip.filter = value as string;
      } else if (key === 'effect') {
        if (typeof value !== 'string' || !(value in EFFECTS)) fail(`effect must be one of ${Object.keys(EFFECTS).join(', ')}`); clip.effect = value as string;
      } else if (key === 'name') {
        clip.name = str(value, '', 80);
      } else if (key === 'asset') {
        const id = String(value ?? '');
        if (id && !findAsset(this.project, id)) fail(`no asset "${id}" (assets: ${this.project.assets.map((a) => a.id).join(', ') || 'none — add one with asset_add'})`);
        clip.asset = id;
      } else if (key === 'adjust') {
        if (!value || typeof value !== 'object') fail('adjust must be an object');
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!(k in ADJUST_RANGES)) fail(`adjust.${k} is not a thing (use ${Object.keys(ADJUST_RANGES).join(', ')})`);
          const [min, max] = ADJUST_RANGES[k as keyof Adjust]; clip.adjust[k as keyof Adjust] = num(v, 0, min, max);
        }
      } else if (key === 'text') {
        if (clip.kind !== 'text' || !clip.text) fail(`clip ${clip.id} is not a text clip`);
        const patch = typeof value === 'string' ? { text: value } : value && typeof value === 'object' ? (value as Record<string, unknown>) : fail('text must be a string or an object');
        const t = clip.text as TextProps;
        for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
          if (k === 'text' || k === 'color' || k === 'stroke' || k === 'bg') (t as unknown as Record<string, string>)[k] = str(v, '', 2000);
          else if (k === 'font') t.font = pick(v, FONTS, t.font);
          else if (k === 'align') t.align = pick(v, ['left', 'center', 'right'] as const, t.align);
          else if (k === 'bold' || k === 'italic' || k === 'shadow') (t as unknown as Record<string, boolean>)[k] = v === true;
          else if (['size', 'strokeWidth', 'letterSpacing', 'lineHeight', 'width'].includes(k)) (t as unknown as Record<string, number>)[k] = num(v, (t as unknown as Record<string, number>)[k]);
          else fail(`text.${k} is not a thing (use text, font, size, color, bold, italic, align, stroke, strokeWidth, bg, shadow, letterSpacing, lineHeight, width)`);
        }
      } else if (key === 'shape') {
        if (clip.kind !== 'shape' || !clip.shape) fail(`clip ${clip.id} is not a shape clip`);
        const patch = typeof value === 'string' ? { shape: value } : value && typeof value === 'object' ? (value as Record<string, unknown>) : fail('shape must be a name or an object');
        const s = clip.shape as ShapeProps;
        for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
          if (k === 'shape') { if (!SHAPES.includes(v as (typeof SHAPES)[number])) fail(`shape must be one of ${SHAPES.join(', ')}`); s.shape = v as ShapeProps['shape']; }
          else if (['color', 'color2', 'stroke'].includes(k)) (s as unknown as Record<string, string>)[k] = str(v, '', 40);
          else if (['w', 'h', 'angle', 'radius', 'strokeWidth'].includes(k)) (s as unknown as Record<string, number>)[k] = num(v, (s as unknown as Record<string, number>)[k]);
          else fail(`shape.${k} is not a thing (use shape, w, h, color, color2, angle, radius, stroke, strokeWidth)`);
        }
      } else if (key === 'sticker') {
        if (clip.kind !== 'sticker') fail(`clip ${clip.id} is not a sticker`); clip.sticker = str(value, '⭐', 16) || '⭐';
      } else if (key === 'synth') {
        if (clip.kind !== 'synth' || !clip.synth) fail(`clip ${clip.id} is not a synth clip`);
        const patch = typeof value === 'string' ? { preset: value } : value && typeof value === 'object' ? (value as Record<string, unknown>) : fail('synth must be a preset name or an object');
        const s = clip.synth as SynthProps;
        for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
          if (k === 'preset') { if (!SYNTH_PRESETS.includes(v as (typeof SYNTH_PRESETS)[number])) fail(`synth preset must be one of ${SYNTH_PRESETS.join(', ')}`); s.preset = v as SynthProps['preset']; }
          else if (k === 'note') { if (!/^[A-Ga-g][#b]?[0-8]$/.test(String(v))) fail('synth note looks like "A2" or "C#4"'); s.note = String(v); }
          else if (k === 'bpm') s.bpm = num(v, s.bpm, 40, 220);
          else if (k === 'scale') s.scale = pick(v, ['major', 'minor'] as const, s.scale);
          else if (k === 'wave') s.wave = pick(v, ['sine', 'square', 'sawtooth', 'triangle'] as const, s.wave);
          else fail(`synth.${k} is not a thing (use preset, note, bpm, scale, wave)`);
        }
      } else if (creating && key === 'transitionIn') {
        /* handled by transition_set */
      } else {
        fail(`${key} is not a clip property`);
      }
    }
    void creating;
  }

  run(op: Op): string {
    switch (op.op) {
      case 'project': {
        const p = this.project;
        if (typeof op.aspect === 'string') { const a = ASPECTS[op.aspect]; if (!a) fail(`aspect must be one of ${Object.keys(ASPECTS).join(', ')}`); p.width = a.w; p.height = a.h; }
        if (op.width !== undefined) p.width = Math.round(num(op.width, p.width, 64, 4096));
        if (op.height !== undefined) p.height = Math.round(num(op.height, p.height, 64, 4096));
        if (op.fps !== undefined) p.fps = Math.round(num(op.fps, p.fps, 1, 60));
        if (typeof op.title === 'string') p.title = op.title.slice(0, 120);
        if (typeof op.background === 'string') p.background = op.background.slice(0, 40);
        return `${p.width}×${p.height} @ ${p.fps} fps`;
      }
      case 'track_add': { const t = this.addTrack(op.kind === 'audio' ? 'audio' : 'video', str(op.name, '', 60)); return `track ${t.id} "${t.name}" (${t.kind})`; }
      case 'track_set': {
        const t = this.track(op.track);
        if (typeof op.name === 'string') t.name = op.name.slice(0, 60);
        for (const k of ['hidden', 'muted', 'locked'] as const) if (typeof op[k] === 'boolean') t[k] = op[k] as boolean;
        return `track ${t.id}`;
      }
      case 'track_remove': {
        const t = this.track(op.track);
        this.project.tracks = this.project.tracks.filter((x) => x !== t);
        return `removed track ${t.id} with ${t.clips.length} clip(s)`;
      }
      case 'asset_add': {
        const path = str(op.path, '').trim().replace(/\\/g, '/');
        if (!path) fail('asset_add needs a path');
        if (this.project.assets.length >= 200) fail('at most 200 assets');
        const ext = path.split('.').pop()?.toLowerCase() ?? '';
        const kind = op.kind === 'video' || op.kind === 'image' || op.kind === 'audio' ? op.kind
          : ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'].includes(ext) ? 'video' : ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext) ? 'audio' : 'image';
        const existing = this.project.assets.find((a) => a.path === path);
        if (existing) { this.last = existing.id; return `asset ${existing.id} already registered`; }
        const asset: Asset = { id: this.nextId('a', this.project.assets.map((a) => a.id)), name: str(op.name, path.split('/').pop() ?? path, 120), kind, path, duration: num(op.duration, 0, 0, 100000), width: num(op.width, 0, 0, 20000), height: num(op.height, 0, 0, 20000) };
        this.project.assets.push(asset);
        return `asset ${asset.id} "${asset.name}" (${kind})`;
      }
      case 'clip_add': {
        if (allClips(this.project).length >= MAX_CLIPS) fail(`at most ${MAX_CLIPS} clips`);
        const asset = typeof op.asset === 'string' && op.asset ? findAsset(this.project, op.asset) ?? fail(`no asset "${op.asset}" (add one with asset_add)`) : undefined;
        const kind = (typeof op.kind === 'string' ? op.kind : asset?.kind) as ClipKind | undefined;
        if (!kind || !['video', 'image', 'audio', 'text', 'shape', 'sticker', 'synth'].includes(kind)) fail('clip_add needs a kind (video, image, audio, text, shape, sticker or synth) or an asset');
        if ((kind === 'video' || kind === 'image' || kind === 'audio') && !asset) fail(`a ${kind} clip needs an asset (asset_add first)`);
        if (asset && asset.kind !== kind && !(asset.kind === 'video' && kind === 'audio')) fail(`asset ${asset.id} is ${asset.kind}, not ${kind}`);
        const track = op.track !== undefined ? this.track(op.track) : this.defaultTrack(kind!);
        if (track.locked) fail(`track ${track.id} is locked`);
        if (track.kind === 'audio' && (['image', 'text', 'shape', 'sticker'] as ClipKind[]).includes(kind!)) fail(`a ${kind} clip cannot go on the audio track ${track.id}`);
        if (track.kind === 'video' && (kind === 'audio' || kind === 'synth')) fail(`a ${kind} clip needs an audio track`);
        const id = this.nextId('c', this.clipIds());
        const dur = op.duration !== undefined ? num(op.duration, 3, MIN_CLIP, MAX_DURATION) : kind === 'image' ? 3 : asset && asset.duration > 0 ? asset.duration : kind === 'text' ? 3 : kind === 'sticker' || kind === 'shape' ? 3 : 4;
        const clip = newClip(id, kind!, op.start !== undefined ? num(op.start, 0, 0, MAX_DURATION) : this.trackEnd(track), dur);
        if (asset) { clip.asset = asset.id; clip.name = asset.name; }
        if (kind === 'text' && typeof op.style === 'string') {
          const style = TEXT_STYLES[op.style] ?? fail(`style must be one of ${Object.keys(TEXT_STYLES).join(', ')}`);
          Object.assign(clip.text as TextProps, style.text); clip.y = style.y;
        }
        const props = { ...op } as Record<string, unknown>;
        this.setProps(clip, props, true);
        track.clips.push(clip); track.clips.sort((a, b) => a.start - b.start);
        this.last = id;
        return `clip ${id} (${kind}) on ${track.id} at ${clip.start}s for ${clip.duration}s`;
      }
      case 'clip_set': { const { clip } = this.clip(op.clip); this.setProps(clip, op as Record<string, unknown>); this.resort(); return `clip ${clip.id}`; }
      case 'clip_move': {
        const found = this.clip(op.clip);
        if (op.start !== undefined) found.clip.start = round(num(op.start, found.clip.start, 0, MAX_DURATION));
        if (op.track !== undefined) {
          const to = this.track(op.track);
          if (to.locked) fail(`track ${to.id} is locked`);
          if ((to.kind === 'audio') !== SOUND_KINDS.includes(found.clip.kind) || (to.kind === 'audio' && found.clip.kind === 'video')) {
            if (!(to.kind === 'video' && VISUAL_KINDS.includes(found.clip.kind))) fail(`a ${found.clip.kind} clip cannot go on track ${to.id}`);
          }
          found.track.clips = found.track.clips.filter((c) => c !== found.clip); to.clips.push(found.clip);
        }
        this.resort();
        return `clip ${found.clip.id} at ${found.clip.start}s`;
      }
      case 'clip_trim': {
        const { clip } = this.clip(op.clip);
        const from = op.from !== undefined ? num(op.from, clip.start, 0, MAX_DURATION) : clip.start;
        const to = op.to !== undefined ? num(op.to, clipEnd(clip), 0, MAX_DURATION) : clipEnd(clip);
        if (to - from < MIN_CLIP) fail(`trim leaves less than ${MIN_CLIP}s`);
        const shift = from - clip.start;
        if (clip.kind === 'video' || clip.kind === 'audio') { clip.offset = round(Math.max(0, clip.offset + shift * clip.speed)); }
        clip.start = round(from); clip.duration = round(to - from);
        this.resort();
        return `clip ${clip.id} now ${clip.start}s → ${round(clipEnd(clip))}s`;
      }
      case 'clip_split': {
        const found = this.clip(op.clip);
        const at = num(op.at, NaN);
        if (!Number.isFinite(at) || at <= found.clip.start + MIN_CLIP / 2 || at >= clipEnd(found.clip) - MIN_CLIP / 2) fail(`split time must fall inside clip ${found.clip.id} (${found.clip.start}s – ${round(clipEnd(found.clip))}s)`);
        if (allClips(this.project).length >= MAX_CLIPS) fail(`at most ${MAX_CLIPS} clips`);
        const first = found.clip;
        const second: Clip = JSON.parse(JSON.stringify(first));
        second.id = this.nextId('c', this.clipIds());
        const cut = at - first.start;
        second.start = round(at); second.duration = round(first.duration - cut); first.duration = round(cut);
        if (first.kind === 'video' || first.kind === 'audio') second.offset = round(first.offset + cut * first.speed);
        second.transitionIn = null; second.animIn = null; first.animOut = null; first.fadeOut = 0; second.fadeIn = 0;
        for (const prop of ANIM_PROPS) {
          const frames = first.keyframes[prop];
          if (!frames) continue;
          const v1 = keyframeValue(frames, cut, 0);
          const a: Keyframe[] = frames.filter((k) => k.t < cut).concat([{ t: round(cut), v: v1, ease: 'linear' as EaseId }]);
          const b: Keyframe[] = [{ t: 0, v: v1, ease: 'linear' }, ...frames.filter((k) => k.t > cut).map((k) => ({ ...k, t: round(k.t - cut) }))];
          first.keyframes[prop] = a; second.keyframes[prop] = b;
        }
        found.track.clips.push(second); this.resort(); this.last = second.id;
        return `split ${first.id} at ${round(at)}s → ${first.id} + ${second.id}`;
      }
      case 'clip_duplicate': {
        if (allClips(this.project).length >= MAX_CLIPS) fail(`at most ${MAX_CLIPS} clips`);
        const found = this.clip(op.clip);
        const copy: Clip = JSON.parse(JSON.stringify(found.clip));
        copy.id = this.nextId('c', this.clipIds()); copy.start = round(op.start !== undefined ? num(op.start, 0, 0, MAX_DURATION) : clipEnd(found.clip)); copy.transitionIn = null;
        const to = op.track !== undefined ? this.track(op.track) : found.track;
        to.clips.push(copy); this.resort(); this.last = copy.id;
        return `clip ${copy.id} (copy of ${found.clip.id}) at ${copy.start}s`;
      }
      case 'clip_delete': {
        const found = this.clip(op.clip);
        found.track.clips = found.track.clips.filter((c) => c !== found.clip);
        if (op.ripple === true) { for (const c of found.track.clips) if (c.start >= clipEnd(found.clip) - 0.001) c.start = round(Math.max(0, c.start - found.clip.duration)); }
        return `deleted ${found.clip.id}${op.ripple === true ? ' and closed the gap' : ''}`;
      }
      case 'arrange': {
        const ids = Array.isArray(op.clips) ? op.clips.map(String) : fail('arrange needs "clips": [ids…]');
        let t = op.start !== undefined ? num(op.start, 0, 0, MAX_DURATION) : this.clip(ids[0]).clip.start;
        const gap = num(op.gap, 0, -5, 30);
        for (const id of ids) { const { clip } = this.clip(id); clip.start = round(Math.max(0, t)); t = clipEnd(clip) + gap; }
        this.resort();
        return `arranged ${ids.length} clips, ending at ${round(t - gap)}s`;
      }
      case 'transition_set': {
        const { clip } = this.clip(op.clip);
        if (op.type === 'none') { clip.transitionIn = null; return `removed the transition on ${clip.id}`; }
        const type = String(op.type ?? 'fade');
        if (!(type in TRANSITIONS)) fail(`transition must be one of ${Object.keys(TRANSITIONS).join(', ')}, none`);
        clip.transitionIn = { type, duration: round(num(op.duration, 0.5, 0.1, 5)) };
        return `clip ${clip.id}: ${type} ${clip.transitionIn.duration}s (needs a clip that ends where this one starts, on the same track)`;
      }
      case 'anim_set': {
        const { clip } = this.clip(op.clip);
        const which = op.which === 'out' ? 'animOut' : 'animIn';
        if (op.type === 'none') { clip[which] = null; return `cleared ${which} on ${clip.id}`; }
        const type = String(op.type ?? 'fade');
        if (!(type in ANIMATIONS)) fail(`animation must be one of ${Object.keys(ANIMATIONS).join(', ')}, none`);
        if (type === 'typewriter' && clip.kind !== 'text') fail('typewriter only works on text clips');
        clip[which] = { type, duration: round(num(op.duration, 0.5, 0.1, 5)) };
        return `clip ${clip.id}: ${which} ${type} ${clip[which]!.duration}s`;
      }
      case 'keyframe_set': {
        const { clip } = this.clip(op.clip);
        const prop = String(op.prop) as AnimProp;
        if (!ANIM_PROPS.includes(prop)) fail(`prop must be one of ${ANIM_PROPS.join(', ')}`);
        const t = round(num(op.t, NaN, 0, MAX_DURATION)), v = num(op.v, NaN, -1000, 1000);
        if (!Number.isFinite(t) || !Number.isFinite(v)) fail('keyframe_set needs numeric t and v');
        if (t > clip.duration + 0.001) fail(`t is seconds from the clip start (clip ${clip.id} lasts ${clip.duration}s)`);
        const frames = (clip.keyframes[prop] ?? []).filter((k) => Math.abs(k.t - t) > 0.0005);
        frames.push({ t, v, ease: pick(op.ease, EASES, 'ease-in-out') as EaseId }); frames.sort((a, b) => a.t - b.t);
        clip.keyframes[prop] = frames;
        return `clip ${clip.id}: ${prop} = ${v} at ${t}s`;
      }
      case 'keyframe_clear': {
        const { clip } = this.clip(op.clip);
        const prop = String(op.prop) as AnimProp;
        if (!ANIM_PROPS.includes(prop)) fail(`prop must be one of ${ANIM_PROPS.join(', ')}`);
        if (op.t === undefined) delete clip.keyframes[prop];
        else { const t = num(op.t, 0); const kept = (clip.keyframes[prop] ?? []).filter((k) => Math.abs(k.t - t) > 0.0005); if (kept.length) clip.keyframes[prop] = kept; else delete clip.keyframes[prop]; }
        return `clip ${clip.id}: cleared ${prop} keyframes`;
      }
      case 'kenburns': {
        const { clip } = this.clip(op.clip);
        const from = num(op.from, 1, 0.1, 10), to = num(op.to, 1.18, 0.1, 10), dx = num(op.dx, 0.02, -1, 1), dy = num(op.dy, 0, -1, 1);
        clip.keyframes.scale = [{ t: 0, v: from, ease: 'ease-in-out' }, { t: clip.duration, v: to, ease: 'linear' }];
        if (dx) clip.keyframes.x = [{ t: 0, v: clip.x - dx / 2, ease: 'ease-in-out' }, { t: clip.duration, v: clip.x + dx / 2, ease: 'linear' }];
        if (dy) clip.keyframes.y = [{ t: 0, v: clip.y - dy / 2, ease: 'ease-in-out' }, { t: clip.duration, v: clip.y + dy / 2, ease: 'linear' }];
        return `clip ${clip.id}: Ken Burns ${from}→${to}`;
      }
      case 'captions': {
        const script = str(op.text, '').trim();
        if (!script) fail('captions needs "text"');
        const track = op.track !== undefined ? this.track(op.track) : this.defaultTrack('text');
        const style = typeof op.style === 'string' ? op.style : 'caption';
        if (!(style in TEXT_STYLES)) fail(`style must be one of ${Object.keys(TEXT_STYLES).join(', ')}`);
        const portrait = this.project.height > this.project.width;
        const cues = captionCues(script, num(op.start, 0, 0, MAX_DURATION), op.end !== undefined ? num(op.end, 0, 0, MAX_DURATION) : undefined, { maxChars: op.maxChars !== undefined ? Number(op.maxChars) : portrait ? 24 : 42, lines: op.lines !== undefined ? Number(op.lines) : 1 });
        if (allClips(this.project).length + cues.length > MAX_CLIPS) fail(`that would pass ${MAX_CLIPS} clips`);
        const ids: string[] = [];
        for (const cue of cues) {
          const clip = newClip(this.nextId('c', this.clipIds().concat(ids)), 'text', cue.start, cue.duration);
          Object.assign(clip.text as TextProps, TEXT_STYLES[style].text, { text: cue.text }); clip.y = TEXT_STYLES[style].y; clip.name = 'caption';
          track.clips.push(clip); ids.push(clip.id);
        }
        track.clips.sort((a, b) => a.start - b.start);
        this.last = ids[ids.length - 1] ?? '';
        return `${cues.length} caption clip(s) ${ids[0]}–${ids[ids.length - 1]} on ${track.id}, ${cues[0]?.start ?? 0}s → ${round((cues[cues.length - 1]?.start ?? 0) + (cues[cues.length - 1]?.duration ?? 0))}s`;
      }
      case 'duck': {
        const { clip } = this.clip(op.clip);
        const underIds = Array.isArray(op.under) ? op.under.map(String) : typeof op.under === 'string' ? [op.under] : fail('duck needs "under": [track ids]');
        const db = num(op.db, 14, 3, 40), factor = 10 ** (-db / 20);
        const spans: [number, number][] = [];
        for (const ref of underIds) { const tr = this.track(ref); for (const c of tr.clips) if (SOUND_KINDS.includes(c.kind) && !c.muted && c !== clip) spans.push([c.start, clipEnd(c)]); }
        spans.sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const s of spans) { const l = merged[merged.length - 1]; if (l && s[0] <= l[1] + 0.4) l[1] = Math.max(l[1], s[1]); else merged.push([s[0], s[1]]); }
        const frames: Keyframe[] = [];
        const base = clip.volume, low = round(base * factor, 3);
        const add = (t: number, v: number): void => { const lt = round(Math.min(clip.duration, Math.max(0, t - clip.start))); const prev = frames[frames.length - 1]; if (prev && lt <= prev.t) { if (lt === prev.t) prev.v = Math.min(prev.v, v); return; } frames.push({ t: lt, v, ease: 'ease-in-out' }); };
        add(clip.start, base);
        let used = 0;
        for (const [s, e] of merged) {
          if (e < clip.start || s > clipEnd(clip)) continue;
          used++; add(s - 0.25, base); add(s + 0.05, low); add(e, low); add(e + 0.45, base);
        }
        add(clipEnd(clip), base);
        if (used === 0) fail('nothing on those tracks overlaps the music clip');
        clip.keyframes.volume = frames;
        return `clip ${clip.id}: ducked ${db} dB (×${round(factor, 2)}) under ${used} spoken stretch(es)`;
      }
      case 'marker_add': { this.project.markers.push({ t: round(num(op.t, 0, 0, MAX_DURATION)), label: str(op.label, '', 60) }); this.project.markers.sort((a, b) => a.t - b.t); return `marker at ${op.t}s`; }
      case 'markers_bpm': {
        const bpm = num(op.bpm, 120, 40, 240), from = num(op.from, 0, 0, MAX_DURATION), to = num(op.to, from + 16, from, MAX_DURATION), every = Math.round(num(op.every, 1, 1, 16));
        const step = 60 / bpm * every; let n = 0;
        for (let t = from; t <= to + 1e-6 && n < 200; t += step, n++) this.project.markers.push({ t: round(t), label: n % 4 === 0 ? 'bar' : 'beat' });
        this.project.markers.sort((a, b) => a.t - b.t);
        return `${n} beat markers every ${round(step)}s`;
      }
      default: return fail(`unknown op ${op.op}`);
    }
  }
  resort(): void { for (const t of this.project.tracks) t.clips.sort((a, b) => a.start - b.start); }
}

export interface ApplyResult { project: Project; log: string[]; error?: string; created?: string }
/** Applies operations to a copy of the project; either all of them work or none is applied. */
export function applyOps(project: Project, ops: Op[]): ApplyResult {
  const editor = new Editor(JSON.parse(JSON.stringify(project)) as Project);
  for (const [i, op] of ops.entries()) {
    try { editor.log.push(`✓ ${op.op}: ${editor.run(op)}`); }
    catch (error) {
      if (error instanceof OpError) return { project, log: editor.log, error: `op ${i + 1} (${op.op}): ${error.message}` };
      throw error;
    }
  }
  if (projectDuration(editor.project) > MAX_DURATION) return { project, log: editor.log, error: `the video would be longer than ${MAX_DURATION}s` };
  return { project: editor.project, log: editor.log, created: editor.last };
}

/* ---------------------------------------------------------------- review & summary */

export function checkProject(p: Project): string[] {
  const out: string[] = [];
  const dur = projectDuration(p);
  if (dur === 0) return ['The video is empty — add clips.'];
  const portrait = p.height > p.width;
  for (const track of p.tracks) {
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1], cur = clips[i];
      if (cur.start < clipEnd(prev) - 0.04 && !(track.kind === 'video' && cur.transitionIn)) out.push(`${track.name}: ${prev.id} and ${cur.id} overlap on the same track (${round(clipEnd(prev) - cur.start, 2)}s) — move one to another track or trim it`);
      else if (track.kind === 'video' && track.name.toLowerCase() === 'main' && cur.start - clipEnd(prev) > 0.25) out.push(`${track.name}: ${round(cur.start - clipEnd(prev), 2)}s of empty space between ${prev.id} and ${cur.id} shows the background colour`);
    }
  }
  for (const c of allClips(p)) {
    if (c.asset && !findAsset(p, c.asset)) out.push(`${c.id}: missing asset ${c.asset}`);
    const asset = c.asset ? findAsset(p, c.asset) : undefined;
    if (asset && asset.duration > 0 && (c.kind === 'video' || c.kind === 'audio') && c.offset + sourceSpan(c) > asset.duration + 0.1) out.push(`${c.id}: plays past the end of ${asset.name} (${round(asset.duration, 1)}s) — trim it or lower the duration`);
    if (c.kind === 'text' && c.text) {
      const lines = c.text.text.split('\n');
      const longest = Math.max(...lines.map((l) => l.length));
      const limit = portrait ? 30 : 42;
      if (longest > limit && c.name === 'caption') out.push(`${c.id}: caption line is ${longest} characters (aim for ≤ ${limit}) — split it`);
      const cps = c.text.text.replace(/\s+/g, ' ').length / c.duration;
      if (c.name === 'caption' && cps > 20) out.push(`${c.id}: caption is read at ${round(cps, 1)} characters/second (aim for ≤ 17–20) — show it longer`);
      if (c.name === 'caption' && c.duration < 1) out.push(`${c.id}: caption shows for only ${c.duration}s (aim for 1–6 s)`);
      if (portrait && c.name === 'caption' && c.y > 0.33) out.push(`${c.id}: caption sits in the bottom ${Math.round((0.5 - c.y) * 100)}% where TikTok/Reels/Shorts overlay their buttons — keep y ≤ 0.3`);
      if (c.text.size < 3 && portrait) out.push(`${c.id}: text size ${c.text.size}% is hard to read on a phone`);
    }
    if (c.kind === 'synth' && c.volume > 0.45 && p.tracks.some((t) => t.kind === 'audio' && t !== p.tracks.find((x) => x.clips.includes(c)) && t.clips.some((o) => o.start < clipEnd(c) && clipEnd(o) > c.start))) out.push(`${c.id}: music at ${Math.round(c.volume * 100)}% plays over other sound — duck it (op "duck") or set volume ≈ 0.25`);
    if (clipEnd(c) > dur + 0.001) out.push(`${c.id}: ends after the video`);
  }
  if (!allClips(p).some((c) => SOUND_KINDS.includes(c.kind) && !c.muted)) out.push('There is no sound — add music or a voice-over, or mute on purpose.');
  if (dur > 90 && portrait) out.push(`The video is ${round(dur)}s; vertical short-form usually works best under 60–90 s.`);
  return out;
}

const fmt = (t: number): string => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
export function describeClip(c: Clip, p: Project): string {
  const bits: string[] = [`${c.id} ${c.kind}`, `${fmt(c.start)}–${fmt(clipEnd(c))}`];
  if (c.name) bits.push(`"${c.name}"`);
  if (c.asset) bits.push(`asset ${c.asset}${findAsset(p, c.asset) ? ` (${findAsset(p, c.asset)!.name})` : ''}`);
  if (c.text) bits.push(`“${c.text.text.replace(/\n/g, ' / ').slice(0, 50)}”`);
  if (c.shape) bits.push(`${c.shape.shape} ${c.shape.color}${c.shape.color2 ? '→' + c.shape.color2 : ''}`);
  if (c.sticker) bits.push(c.sticker);
  if (c.synth) bits.push(`synth ${c.synth.preset} ${c.synth.note} ${c.synth.bpm}bpm`);
  if (c.speed !== 1) bits.push(`speed ×${c.speed}`);
  if (c.offset) bits.push(`from ${c.offset}s`);
  if (c.volume !== 1 && SOUND_KINDS.includes(c.kind)) bits.push(`vol ${Math.round(c.volume * 100)}%`);
  if (c.filter !== 'none') bits.push(`filter ${c.filter}`);
  if (c.effect !== 'none') bits.push(`effect ${c.effect}`);
  if (c.transitionIn) bits.push(`transition ${c.transitionIn.type} ${c.transitionIn.duration}s`);
  if (c.animIn) bits.push(`in:${c.animIn.type}`); if (c.animOut) bits.push(`out:${c.animOut.type}`);
  if (Object.keys(c.keyframes).length) bits.push(`keyframes ${Object.entries(c.keyframes).map(([k, v]) => `${k}×${v!.length}`).join(',')}`);
  if (c.x || c.y || c.scale !== 1 || c.rotation) bits.push(`at (${c.x}, ${c.y}) ×${c.scale}${c.rotation ? ` ∠${c.rotation}°` : ''}`);
  return bits.join(' · ');
}
export function summarizeProject(p: Project): string {
  const lines = [`"${p.title}" — ${p.width}×${p.height} (${p.width > p.height ? 'landscape' : p.width < p.height ? 'portrait' : 'square'}), ${p.fps} fps, ${fmt(projectDuration(p))} long, background ${p.background}`];
  if (p.assets.length) lines.push('Media:', ...p.assets.map((a) => `- ${a.id} ${a.kind} "${a.name}" ${a.path}${a.duration ? ` ${round(a.duration, 1)}s` : ''}${a.width ? ` ${a.width}×${a.height}` : ''}`));
  lines.push('Tracks (top of the list = in front):');
  for (const t of [...p.tracks].reverse()) {
    lines.push(`- ${t.id} "${t.name}" (${t.kind}${t.hidden ? ', hidden' : ''}${t.muted ? ', muted' : ''}${t.locked ? ', locked' : ''}) ${t.clips.length ? '' : '— empty'}`);
    for (const c of t.clips) lines.push(`    ${describeClip(c, p)}`);
  }
  if (p.markers.length) lines.push(`Markers: ${p.markers.slice(0, 24).map((m) => `${m.t}s${m.label ? ' ' + m.label : ''}`).join(', ')}${p.markers.length > 24 ? ' …' : ''}`);
  return lines.join('\n');
}

/* ---------------------------------------------------------------- starter projects (all generated: no media files needed) */

export type VideoTemplate = 'blank' | 'promo' | 'title';
export function templateProject(kind: VideoTemplate, title = 'Untitled video'): Project {
  const base = emptyProject(title, kind === 'title' ? '16:9' : '9:16');
  if (kind === 'blank') return base;
  const ops: Op[] = kind === 'title'
    ? [
      { op: 'clip_add', kind: 'shape', track: 't1', start: 0, duration: 6, shape: { shape: 'rect', w: 1, h: 1, color: '#1b1464', color2: '#0f9b8e', angle: 120 } },
      { op: 'clip_add', kind: 'shape', track: 't2', start: 0.4, duration: 5.2, shape: { shape: 'ellipse', w: 0.34, h: 0.6, color: '#ffffff22' }, x: 0.32, y: -0.1, opacity: 0.35, effect: 'pulse', effectAmount: 0.4 },
      { op: 'clip_add', kind: 'text', track: 't3', start: 0.5, duration: 5, text: 'Your Title Here', style: 'title', y: -0.04 },
      { op: 'anim_set', clip: 'last', which: 'in', type: 'pop', duration: 0.7 }, { op: 'anim_set', clip: 'last', which: 'out', type: 'fade', duration: 0.5 },
      { op: 'track_add', kind: 'video', name: 'Subtitle' },
      { op: 'clip_add', kind: 'text', track: 't5', start: 1.2, duration: 4.3, text: 'A subtitle that explains it', style: 'quote', y: 0.1 },
      { op: 'anim_set', clip: 'last', which: 'in', type: 'typewriter', duration: 1.6 },
      { op: 'clip_add', kind: 'synth', start: 0, duration: 6, synth: { preset: 'pad', note: 'D3', scale: 'minor' }, volume: 0.5, fadeIn: 0.8, fadeOut: 1.2 },
    ]
    : [
      { op: 'clip_add', kind: 'shape', track: 't1', start: 0, duration: 4, shape: { shape: 'rect', w: 1, h: 1, color: '#ff512f', color2: '#dd2476', angle: 150 } },
      { op: 'clip_add', kind: 'shape', track: 't1', start: 4, duration: 4, shape: { shape: 'rect', w: 1, h: 1, color: '#1d2671', color2: '#c33764', angle: 60 } },
      { op: 'transition_set', clip: 'last', type: 'slide-left', duration: 0.5 },
      { op: 'clip_add', kind: 'shape', track: 't1', start: 8, duration: 4.6, shape: { shape: 'rect', w: 1, h: 1, color: '#11998e', color2: '#38ef7d', angle: 200 } },
      { op: 'transition_set', clip: 'last', type: 'zoom-in', duration: 0.5 },
      { op: 'clip_add', kind: 'sticker', track: 't2', start: 0.4, duration: 3.2, sticker: '🔥', scale: 2.2, y: -0.12 },
      { op: 'anim_set', clip: 'last', which: 'in', type: 'pop', duration: 0.5 }, { op: 'clip_set', clip: 'last', effect: 'pulse' },
      { op: 'clip_add', kind: 'sticker', track: 't2', start: 4.4, duration: 3.2, sticker: '✨', scale: 2.4, y: -0.1 },
      { op: 'anim_set', clip: 'last', which: 'in', type: 'spin', duration: 0.6 },
      { op: 'clip_add', kind: 'sticker', track: 't2', start: 8.4, duration: 3.2, sticker: '🚀', scale: 2.4, y: -0.1 },
      { op: 'anim_set', clip: 'last', which: 'in', type: 'bounce', duration: 0.7 },
      { op: 'clip_add', kind: 'text', track: 't3', start: 0.3, duration: 3.4, text: { text: 'MAKE IT\nMOVE', size: 12 }, style: 'title', y: 0.1 },
      { op: 'anim_set', clip: 'last', which: 'in', type: 'slide-up', duration: 0.5 },
      { op: 'clip_add', kind: 'text', track: 't3', start: 4.3, duration: 3.4, text: 'EDIT FAST', style: 'neon', y: 0.1 },
      { op: 'anim_set', clip: 'last', which: 'in', type: 'zoom-in', duration: 0.5 },
      { op: 'captions', text: 'Cut it. Add music. Drop in captions. Export.', start: 8.4, end: 12.4, track: 't3' },
      { op: 'clip_add', kind: 'synth', track: 't4', start: 0, duration: 12.6, synth: { preset: 'beat', bpm: 120 }, volume: 0.6 },
      { op: 'track_add', kind: 'audio', name: 'Bass' },
      { op: 'clip_add', kind: 'synth', track: 't5', start: 0, duration: 12.6, synth: { preset: 'bass', note: 'A1', bpm: 120 }, volume: 0.5, fadeOut: 1 },
      { op: 'markers_bpm', bpm: 120, from: 0, to: 12, every: 4 },
    ];
  const result = applyOps(base, ops);
  if (result.error) throw new Error(`template ${kind}: ${result.error}`);
  return result.project;
}
