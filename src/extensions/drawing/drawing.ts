/** The Drawing document: a raster painting made of layers (stored as PNGs inside a JSON file), the brushes, the blend
 * modes, and the list of drawing operations that both the editor and the agent tools understand. Pure data — no canvas. */
import { parseColor } from './drawingPixels.ts';

export const DRAWINGS_DIR = '.pigry/drawings/';
export const DRAWING_EXT = '.drawing.json';

export const MIN_SIDE = 1;
export const MAX_SIDE = 4096;
export const MAX_LAYERS = 50;
export const DEFAULT_WIDTH = 1024;
export const DEFAULT_HEIGHT = 768;

export interface BlendMode { id: string; label: string; /** The canvas globalCompositeOperation. */ op: GlobalCompositeOperation }

export const BLEND_MODES: BlendMode[] = [
  { id: 'normal', label: 'Normal', op: 'source-over' },
  { id: 'multiply', label: 'Multiply', op: 'multiply' },
  { id: 'screen', label: 'Screen', op: 'screen' },
  { id: 'overlay', label: 'Overlay', op: 'overlay' },
  { id: 'darken', label: 'Darken', op: 'darken' },
  { id: 'lighten', label: 'Lighten', op: 'lighten' },
  { id: 'color-dodge', label: 'Color dodge', op: 'color-dodge' },
  { id: 'color-burn', label: 'Color burn', op: 'color-burn' },
  { id: 'hard-light', label: 'Hard light', op: 'hard-light' },
  { id: 'soft-light', label: 'Soft light', op: 'soft-light' },
  { id: 'difference', label: 'Difference', op: 'difference' },
  { id: 'exclusion', label: 'Exclusion', op: 'exclusion' },
  { id: 'hue', label: 'Hue', op: 'hue' },
  { id: 'saturation', label: 'Saturation', op: 'saturation' },
  { id: 'color', label: 'Color', op: 'color' },
  { id: 'luminosity', label: 'Luminosity', op: 'luminosity' },
];

export const blendOp = (id: string): GlobalCompositeOperation => BLEND_MODES.find((m) => m.id === id)?.op ?? 'source-over';
export const isBlend = (id: unknown): id is string => typeof id === 'string' && BLEND_MODES.some((m) => m.id === id);

export interface DrawingLayer {
  id: string;
  name: string;
  visible: boolean;
  /** 0–1 */
  opacity: number;
  blend: string;
  /** Locked layers cannot be painted on. */
  locked: boolean;
  /** Paint only where the layer already has pixels (Krita's "lock alpha"). */
  alphaLock: boolean;
  /** Clipping: show only where the layer below has pixels (Krita's "inherit alpha"). */
  clip: boolean;
  /** The layer's pixels as a PNG data URL; '' for an empty layer. */
  png: string;
}

export interface Drawing {
  version: 1;
  title: string;
  width: number;
  height: number;
  /** A colour behind the layers, or null for transparent. */
  background: string | null;
  /** Bottom layer first. */
  layers: DrawingLayer[];
}

export const newLayerId = (layers: Array<{ id: string }>): string => {
  let n = layers.length + 1;
  while (layers.some((l) => l.id === `l${n}`)) n++;
  return `l${n}`;
};

export function emptyLayer(id: string, name: string): DrawingLayer {
  return { id, name, visible: true, opacity: 1, blend: 'normal', locked: false, alphaLock: false, clip: false, png: '' };
}

export function emptyDrawing(title = 'Untitled', width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, background: string | null = '#ffffff'): Drawing {
  return { version: 1, title, width: clampSide(width), height: clampSide(height), background, layers: [emptyLayer('l1', 'Layer 1')] };
}

export const clampSide = (n: unknown): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_SIDE, Math.max(MIN_SIDE, v)) : DEFAULT_WIDTH;
};

export interface NormalizeResult { drawing: Drawing; warnings: string[] }

/** Repairs whatever was read from disk (or written by an agent) into a valid drawing, listing what it had to fix. */
export function normalizeDrawing(raw: unknown, fallbackTitle = 'Untitled'): NormalizeResult {
  const warnings: string[] = [];
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const width = clampSide(obj.width ?? DEFAULT_WIDTH), height = clampSide(obj.height ?? DEFAULT_HEIGHT);
  const bg = obj.background === null ? null : typeof obj.background === 'string' && parseColor(obj.background) ? obj.background : '#ffffff';
  const layers: DrawingLayer[] = [];
  for (const entry of Array.isArray(obj.layers) ? obj.layers.slice(0, MAX_LAYERS) : []) {
    if (!entry || typeof entry !== 'object') { warnings.push('Dropped a layer that was not an object.'); continue; }
    const l = entry as Record<string, unknown>;
    let id = typeof l.id === 'string' && l.id ? l.id : newLayerId(layers);
    if (layers.some((x) => x.id === id)) { id = newLayerId(layers); warnings.push(`Renamed a duplicate layer id to ${id}.`); }
    const png = typeof l.png === 'string' && (l.png === '' || l.png.startsWith('data:image/')) ? l.png : '';
    if (typeof l.png === 'string' && l.png !== png) warnings.push(`Layer "${String(l.name ?? id)}" had an image that is not a data: URL and was emptied.`);
    layers.push({
      id, name: typeof l.name === 'string' && l.name.trim() ? l.name.trim().slice(0, 60) : `Layer ${layers.length + 1}`,
      visible: l.visible !== false, opacity: typeof l.opacity === 'number' ? Math.min(1, Math.max(0, l.opacity)) : 1,
      blend: isBlend(l.blend) ? l.blend : 'normal', locked: l.locked === true, alphaLock: l.alphaLock === true, clip: l.clip === true, png,
    });
  }
  if (layers.length === 0) { layers.push(emptyLayer('l1', 'Layer 1')); warnings.push('The drawing had no layers; added an empty one.'); }
  return { drawing: { version: 1, title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 80) : fallbackTitle, width, height, background: bg, layers }, warnings };
}

export function parseDrawingJson(text: string, fallbackTitle = 'Untitled'): NormalizeResult {
  try {
    return normalizeDrawing(JSON.parse(text), fallbackTitle);
  } catch {
    return { drawing: emptyDrawing(fallbackTitle), warnings: ['The file was not valid JSON; started an empty drawing.'] };
  }
}

export const serializeDrawing = (drawing: Drawing): string => JSON.stringify(drawing);

/** The layer an id, a name (case-insensitive) or a 1-based position ("1" is the bottom layer) refers to. */
export function findLayer(layers: DrawingLayer[], ref: unknown): DrawingLayer | undefined {
  if (typeof ref === 'number') return layers[ref - 1];
  const text = String(ref ?? '').trim();
  if (!text) return undefined;
  return layers.find((l) => l.id === text) ?? layers.find((l) => l.name.toLowerCase() === text.toLowerCase()) ?? (/^\d+$/.test(text) ? layers[Number(text) - 1] : undefined);
}

/** One line per layer, top first — what the agent reads before it edits. */
export function summarizeDrawing(drawing: Drawing): string {
  const lines = [`"${drawing.title}" — ${drawing.width}×${drawing.height} px, background ${drawing.background ?? 'transparent'}, ${drawing.layers.length} layer${drawing.layers.length === 1 ? '' : 's'} (top first):`];
  for (const [i, l] of [...drawing.layers].reverse().entries()) {
    const flags = [l.visible ? '' : 'hidden', l.locked ? 'locked' : '', l.alphaLock ? 'alpha-locked' : '', l.clip ? 'clipped to the layer below' : '', l.blend !== 'normal' ? l.blend : '', l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : '', l.png ? '' : 'empty'].filter(Boolean);
    lines.push(`${drawing.layers.length - i}. ${l.id} "${l.name}"${flags.length ? ` (${flags.join(', ')})` : ''}`);
  }
  return lines.join('\n');
}

/* ---------- brushes ---------- */

export interface BrushSettings {
  /** Diameter in pixels. */
  size: number;
  /** Most opaque the whole stroke can get, 0–1. */
  opacity: number;
  /** How much paint each dab adds, 0–1 (low = builds up gradually like an airbrush). */
  flow: number;
  /** 0 = very soft edge, 1 = hard edge. */
  hardness: number;
  /** Distance between dabs as a fraction of the size. */
  spacing: number;
  /** Pen pressure changes the size / the opacity. */
  sizePressure: boolean;
  opacityPressure: boolean;
  /** Stabiliser: 0 = follow the pointer exactly, up to 0.95 = very smooth. */
  smoothing: number;
  /** Random scatter of the dabs (fraction of the size) and of their size. */
  scatter: number;
  /** Squares instead of circles, no anti-aliasing. */
  pixel: boolean;
}

export interface BrushPreset extends BrushSettings { id: string; name: string }

export const BRUSHES: BrushPreset[] = [
  { id: 'pencil', name: 'Pencil', size: 4, opacity: 1, flow: 1, hardness: 0.9, spacing: 0.08, sizePressure: true, opacityPressure: false, smoothing: 0.1, scatter: 0, pixel: false },
  { id: 'ink', name: 'Ink pen', size: 8, opacity: 1, flow: 1, hardness: 1, spacing: 0.06, sizePressure: true, opacityPressure: false, smoothing: 0.5, scatter: 0, pixel: false },
  { id: 'marker', name: 'Marker', size: 22, opacity: 0.8, flow: 1, hardness: 0.7, spacing: 0.1, sizePressure: false, opacityPressure: false, smoothing: 0.3, scatter: 0, pixel: false },
  { id: 'airbrush', name: 'Airbrush', size: 60, opacity: 1, flow: 0.12, hardness: 0, spacing: 0.1, sizePressure: false, opacityPressure: true, smoothing: 0.2, scatter: 0, pixel: false },
  { id: 'watercolor', name: 'Watercolor', size: 40, opacity: 0.45, flow: 0.5, hardness: 0.25, spacing: 0.12, sizePressure: true, opacityPressure: true, smoothing: 0.35, scatter: 0.05, pixel: false },
  { id: 'charcoal', name: 'Charcoal', size: 18, opacity: 0.85, flow: 0.55, hardness: 0.5, spacing: 0.15, sizePressure: true, opacityPressure: false, smoothing: 0.1, scatter: 0.35, pixel: false },
  { id: 'chalk', name: 'Chalk', size: 26, opacity: 0.9, flow: 0.3, hardness: 0.8, spacing: 0.2, sizePressure: false, opacityPressure: false, smoothing: 0, scatter: 0.5, pixel: false },
  { id: 'pixel', name: 'Pixel', size: 4, opacity: 1, flow: 1, hardness: 1, spacing: 1, sizePressure: false, opacityPressure: false, smoothing: 0, scatter: 0, pixel: true },
];

export const brushById = (id: unknown): BrushPreset => BRUSHES.find((b) => b.id === id) ?? BRUSHES[0];

/* ---------- drawing operations ---------- */

export type FontFamily = 'sans' | 'serif' | 'mono' | 'handwriting';
export const FONT_STACKS: Record<FontFamily, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  handwriting: '"Comic Sans MS", "Segoe Print", cursive',
};

interface OpSpec { summary: string; required: string[]; numbers: string[]; colors: string[]; }

/** Every operation an agent (or the editor's own code) can apply. `layer` (id, name or position) picks the target
 * layer; the active/top layer is used when it is left out. Coordinates are canvas pixels from the top-left. */
export const OP_SPECS: Record<string, OpSpec> = {
  layer_add: { summary: '{op:"layer_add", name?, fill?: colour, above?: layer} — a new layer above `above` (default: the top)', required: [], numbers: [], colors: ['fill'] },
  layer_edit: { summary: '{op:"layer_edit", layer, name?, visible?, opacity? (0-1), blend?, locked?, alphaLock?, clip?}', required: ['layer'], numbers: ['opacity'], colors: [] },
  layer_delete: { summary: '{op:"layer_delete", layer}', required: ['layer'], numbers: [], colors: [] },
  layer_duplicate: { summary: '{op:"layer_duplicate", layer}', required: ['layer'], numbers: [], colors: [] },
  layer_merge_down: { summary: '{op:"layer_merge_down", layer} — merge into the layer below', required: ['layer'], numbers: [], colors: [] },
  layer_move: { summary: '{op:"layer_move", layer, to} — to = new 1-based position (1 = bottom)', required: ['layer', 'to'], numbers: ['to'], colors: [] },
  layer_clear: { summary: '{op:"layer_clear", layer?} — erase every pixel of the layer (inside the selection if there is one)', required: [], numbers: [], colors: [] },
  stroke: { summary: '{op:"stroke", points: [[x,y,pressure?],…], color, size?, brush? (pencil|ink|marker|airbrush|watercolor|charcoal|chalk|pixel), opacity?, flow?, hardness?, erase?} — a brush stroke along the points', required: ['points', 'color'], numbers: ['size', 'opacity', 'flow', 'hardness'], colors: ['color'] },
  line: { summary: '{op:"line", x1,y1,x2,y2, color, width?, cap? (round|butt|square), dash?: [on,off]}', required: ['x1', 'y1', 'x2', 'y2', 'color'], numbers: ['x1', 'y1', 'x2', 'y2', 'width'], colors: ['color'] },
  rect: { summary: '{op:"rect", x,y,w,h, fill?, stroke?, width?, radius?}', required: ['x', 'y', 'w', 'h'], numbers: ['x', 'y', 'w', 'h', 'width', 'radius'], colors: ['fill', 'stroke'] },
  ellipse: { summary: '{op:"ellipse", x,y,w,h, fill?, stroke?, width?} — inside the box x,y,w,h', required: ['x', 'y', 'w', 'h'], numbers: ['x', 'y', 'w', 'h', 'width'], colors: ['fill', 'stroke'] },
  polygon: { summary: '{op:"polygon", points: [[x,y],…], fill?, stroke?, width?, closed?: true} — a polygon or (closed:false) a polyline', required: ['points'], numbers: ['width'], colors: ['fill', 'stroke'] },
  text: { summary: '{op:"text", x,y, text, size?, color?, font? (sans|serif|mono|handwriting), weight?, italic?, align? (left|center|right)} — y is the top of the first line', required: ['x', 'y', 'text'], numbers: ['x', 'y', 'size', 'weight'], colors: ['color'] },
  fill: { summary: '{op:"fill", x,y, color, tolerance? (0-255, default 32), contiguous?: true} — paint bucket on the layer', required: ['x', 'y', 'color'], numbers: ['x', 'y', 'tolerance'], colors: ['color'] },
  gradient: { summary: '{op:"gradient", x1,y1,x2,y2, from, to, kind? (linear|radial)} — fills the layer (or the selection)', required: ['x1', 'y1', 'x2', 'y2', 'from', 'to'], numbers: ['x1', 'y1', 'x2', 'y2'], colors: ['from', 'to'] },
  filter: { summary: '{op:"filter", filter: id, params?} — filter ids: invert, grayscale, sepia, brightness-contrast, hue-saturation, posterize, threshold, blur, sharpen, pixelate, noise, edges, emboss, vignette', required: ['filter'], numbers: [], colors: [] },
  select: { summary: '{op:"select", shape: all|none|invert|rect|ellipse|color|grow|shrink|feather, x,y,w,h (rect/ellipse), mode? (replace|add|subtract|intersect), at?: [x,y] + tolerance? (color), amount? (grow/shrink/feather)} — the selection limits later fills, strokes and filters', required: ['shape'], numbers: ['x', 'y', 'w', 'h', 'tolerance', 'amount'], colors: [] },
  fill_selection: { summary: '{op:"fill_selection", color} — fill the selected area of the layer', required: ['color'], numbers: [], colors: ['color'] },
  flip: { summary: '{op:"flip", axis: horizontal|vertical, layer?} — mirror one layer (or the whole image with layer:"all")', required: ['axis'], numbers: [], colors: [] },
  rotate: { summary: '{op:"rotate", degrees} — rotate the whole image by 90, 180 or 270', required: ['degrees'], numbers: ['degrees'], colors: [] },
  canvas_resize: { summary: '{op:"canvas_resize", width, height, scale?: false} — change the canvas size (scale:true resamples the pixels)', required: ['width', 'height'], numbers: ['width', 'height'], colors: [] },
  crop: { summary: '{op:"crop", x,y,w,h} — keep only that rectangle of the canvas', required: ['x', 'y', 'w', 'h'], numbers: ['x', 'y', 'w', 'h'], colors: [] },
};

export type DrawOp = { op: string } & Record<string, unknown>;

export const OP_HELP = Object.values(OP_SPECS).map((s) => `- ${s.summary}`).join('\n');

function isPoints(value: unknown, min: number): boolean {
  return Array.isArray(value) && value.length >= min && value.every((p) => Array.isArray(p) && p.length >= 2 && p.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n)));
}

/** An error message for an operation that cannot be applied, or null. */
export function validateOp(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'an operation must be an object like {"op":"rect",…}';
  const op = raw as DrawOp;
  const spec = OP_SPECS[op.op];
  if (!spec) return `unknown op "${String(op.op)}" (known: ${Object.keys(OP_SPECS).join(', ')})`;
  for (const key of spec.required) if (op[key] === undefined || op[key] === null || op[key] === '') return `${op.op} needs "${key}"`;
  for (const key of spec.numbers) if (op[key] !== undefined && (typeof op[key] !== 'number' || !Number.isFinite(op[key] as number))) return `${op.op}: "${key}" must be a number`;
  for (const key of spec.colors) if (op[key] !== undefined && op[key] !== null && !parseColor(op[key])) return `${op.op}: "${key}" must be a colour like "#ff8800", "rgba(0,0,0,0.5)" or "red" (got ${JSON.stringify(op[key])})`;
  if (op.op === 'stroke' && !isPoints(op.points, 1)) return 'stroke: "points" must be a list of [x, y] pairs';
  if (op.op === 'polygon' && !isPoints(op.points, 2)) return 'polygon: "points" must be a list of at least two [x, y] pairs';
  if (op.blend !== undefined && !isBlend(op.blend)) return `blend must be one of ${BLEND_MODES.map((m) => m.id).join(', ')}`;
  if (op.op === 'select' && !['all', 'none', 'invert', 'rect', 'ellipse', 'color', 'grow', 'shrink', 'feather'].includes(String(op.shape))) return 'select: shape must be all, none, invert, rect, ellipse, color, grow, shrink or feather';
  if (op.op === 'filter' && typeof op.filter !== 'string') return 'filter: "filter" must be a filter id';
  if (op.op === 'rotate' && ![90, 180, 270, -90].includes(op.degrees as number)) return 'rotate: degrees must be 90, 180, 270 or -90';
  if (op.op === 'canvas_resize' && ((op.width as number) < 1 || (op.height as number) < 1 || (op.width as number) > MAX_SIDE || (op.height as number) > MAX_SIDE)) return `canvas_resize: width and height must be between 1 and ${MAX_SIDE}`;
  return null;
}

/** Accepts a list of operations or its JSON text; reports the first problem per operation instead of throwing. */
export function parseOps(value: unknown): { ops: DrawOp[]; errors: string[] } {
  let list: unknown = value;
  if (typeof value === 'string') { try { list = JSON.parse(value); } catch { return { ops: [], errors: ['"ops" is not valid JSON'] }; } }
  if (list && typeof list === 'object' && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list)) return { ops: [], errors: ['"ops" must be a list of operations'] };
  const ops: DrawOp[] = [], errors: string[] = [];
  list.forEach((entry, i) => { const err = validateOp(entry); if (err) errors.push(`op ${i + 1}: ${err}`); else ops.push(entry as DrawOp); });
  return { ops, errors };
}
