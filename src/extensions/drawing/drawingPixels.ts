/** Pixel maths for the Drawing extension: colours, flood fill, selection masks, gradients and filters. Everything here
 * works on plain RGBA arrays (no canvas, no DOM) so it runs in the editor, in the agent tools and in node tests. */

export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
/** One byte per pixel: 0 = not selected, 255 = fully selected (feathered edges are in between). */
export type Mask = Uint8Array;
/** Channels are 0–255 (alpha too). */
export interface RGBA { r: number; g: number; b: number; a: number }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const byte = (v: number): number => clamp(Math.round(v), 0, 255);

/* ---------- colours ---------- */

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#8b4513', gray: '#808080', grey: '#808080', cyan: '#00ffff',
  magenta: '#ff00ff', navy: '#000080', teal: '#008080', gold: '#ffd700', skyblue: '#87ceeb', transparent: '#00000000',
};

/** "#rgb", "#rrggbb", "#rrggbbaa", "rgb()/rgba()" or a common colour name; null when it is not a colour. */
export function parseColor(input: unknown): RGBA | null {
  if (typeof input !== 'string') return null;
  let text = input.trim().toLowerCase();
  if (NAMED[text]) text = NAMED[text];
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(text);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return { r: byte(+fn[1]), g: byte(+fn[2]), b: byte(+fn[3]), a: byte(alpha * 255) };
  }
  return null;
}

const hex2 = (n: number): string => byte(n).toString(16).padStart(2, '0');
/** "#rrggbb" (or "#rrggbbaa" when not opaque). */
export const hexOf = (c: RGBA): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 255 ? hex2(c.a) : ''}`;

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const hh = ((h % 360) + 360) % 360 / 60, c = v * s, x = c * (1 - Math.abs((hh % 2) - 1)), m = v - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255) };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), l = (max + min) / 2, d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  h *= 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) { const v = byte(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t0: number): number => {
    let t = t0 / 360;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return byte(v * 255);
  };
  return { r: f(h + 120), g: f(h), b: f(h - 120) };
}

/* ---------- blank images and masks ---------- */

export const makePixels = (width: number, height: number): Pixels => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
export const copyPixels = (px: Pixels): Pixels => ({ width: px.width, height: px.height, data: new Uint8ClampedArray(px.data) });
export const makeMask = (width: number, height: number, value = 0): Mask => new Uint8Array(width * height).fill(value);

/** Colour `c` laid over pixel `i` with extra coverage 0–1 (normal "source over" blending on straight alpha). */
function over(data: Uint8ClampedArray, i: number, c: RGBA, coverage: number): void {
  const sa = (c.a / 255) * coverage;
  if (sa <= 0) return;
  const da = data[i + 3] / 255, oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  data[i] = (c.r * sa + data[i] * da * (1 - sa)) / oa;
  data[i + 1] = (c.g * sa + data[i + 1] * da * (1 - sa)) / oa;
  data[i + 2] = (c.b * sa + data[i + 2] * da * (1 - sa)) / oa;
  data[i + 3] = oa * 255;
}

/* ---------- flood fill and the magic wand ---------- */

/** The pixels that look like the one at (x, y): every channel (alpha too) within `tolerance` (0–255). With
 * `contiguous` only pixels connected to the seed count (paint bucket, magic wand); otherwise the whole image. */
export function floodMask(px: Pixels, x: number, y: number, tolerance: number, contiguous = true): Mask {
  const { width: w, height: h, data } = px;
  const mask = makeMask(w, h);
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return mask;
  const s = (y * w + x) * 4;
  const sr = data[s], sg = data[s + 1], sb = data[s + 2], sa = data[s + 3];
  const tol = clamp(tolerance, 0, 255);
  const similar = (i: number): boolean => {
    // Fully transparent pixels all look alike whatever their colour channels say.
    if (sa === 0 && data[i + 3] === 0) return true;
    return Math.abs(data[i] - sr) <= tol && Math.abs(data[i + 1] - sg) <= tol && Math.abs(data[i + 2] - sb) <= tol && Math.abs(data[i + 3] - sa) <= tol;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (similar(p * 4)) mask[p] = 255;
    return mask;
  }
  const stack: number[] = [x, y];
  while (stack.length) {
    const cy = stack.pop()!, cx0 = stack.pop()!;
    let cx = cx0;
    while (cx >= 0 && mask[cy * w + cx] === 0 && similar((cy * w + cx) * 4)) cx--;
    cx++;
    let up = false, down = false;
    while (cx < w && mask[cy * w + cx] === 0 && similar((cy * w + cx) * 4)) {
      mask[cy * w + cx] = 255;
      if (cy > 0) {
        const open = mask[(cy - 1) * w + cx] === 0 && similar(((cy - 1) * w + cx) * 4);
        if (open && !up) { stack.push(cx, cy - 1); up = true; } else if (!open) up = false;
      }
      if (cy < h - 1) {
        const open = mask[(cy + 1) * w + cx] === 0 && similar(((cy + 1) * w + cx) * 4);
        if (open && !down) { stack.push(cx, cy + 1); down = true; } else if (!open) down = false;
      }
      cx++;
    }
  }
  return mask;
}

/** Paints `color` wherever `mask` is set, limited by the selection (if any). Returns how many pixels changed. */
export function fillMask(px: Pixels, mask: Mask, color: RGBA, selection?: Mask | null): number {
  let n = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const weight = (mask[p] / 255) * (selection ? selection[p] / 255 : 1);
    if (weight <= 0) continue;
    over(px.data, p * 4, color, weight);
    n++;
  }
  return n;
}

/** The paint bucket: fills the area that looks like the pixel at (x, y). */
export function bucketFill(px: Pixels, x: number, y: number, color: RGBA, tolerance: number, contiguous = true, selection?: Mask | null): number {
  const mask = floodMask(px, x, y, tolerance, contiguous);
  // Grow the area one pixel so anti-aliased edges are covered instead of leaving a light halo.
  return fillMask(px, growMask(mask, px.width, px.height, 1), color, selection);
}

/* ---------- selection masks ---------- */

export function rectMask(w: number, h: number, x: number, y: number, rw: number, rh: number): Mask {
  const mask = makeMask(w, h);
  const x0 = clamp(Math.round(Math.min(x, x + rw)), 0, w), x1 = clamp(Math.round(Math.max(x, x + rw)), 0, w);
  const y0 = clamp(Math.round(Math.min(y, y + rh)), 0, h), y1 = clamp(Math.round(Math.max(y, y + rh)), 0, h);
  for (let yy = y0; yy < y1; yy++) mask.fill(255, yy * w + x0, yy * w + x1);
  return mask;
}

export function ellipseMask(w: number, h: number, x: number, y: number, rw: number, rh: number): Mask {
  const mask = makeMask(w, h);
  const cx = x + rw / 2, cy = y + rh / 2, rx = Math.abs(rw) / 2, ry = Math.abs(rh) / 2;
  if (rx < 0.5 || ry < 0.5) return mask;
  for (let yy = Math.max(0, Math.floor(cy - ry)); yy < Math.min(h, Math.ceil(cy + ry)); yy++) {
    for (let xx = Math.max(0, Math.floor(cx - rx)); xx < Math.min(w, Math.ceil(cx + rx)); xx++) {
      const dx = (xx + 0.5 - cx) / rx, dy = (yy + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) mask[yy * w + xx] = 255;
    }
  }
  return mask;
}

/** The inside of a closed polygon (even-odd rule), e.g. the free-hand lasso. */
export function polygonMask(w: number, h: number, points: Array<{ x: number; y: number }>): Mask {
  const mask = makeMask(w, h);
  if (points.length < 3) return mask;
  for (let yy = 0; yy < h; yy++) {
    const cy = yy + 0.5, xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = clamp(Math.round(xs[i]), 0, w), x1 = clamp(Math.round(xs[i + 1]), 0, w);
      if (x1 > x0) mask.fill(255, yy * w + x0, yy * w + x1);
    }
  }
  return mask;
}

export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

/** `next` combined with the current selection `base` (null = nothing selected yet). */
export function combineMasks(base: Mask | null, next: Mask, mode: SelectMode): Mask {
  if (!base || mode === 'replace') return next;
  const out = new Uint8Array(next.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = mode === 'add' ? Math.max(base[i], next[i]) : mode === 'subtract' ? Math.max(0, base[i] - next[i]) : Math.min(base[i], next[i]);
  }
  return out;
}

export function invertMask(mask: Mask): Mask {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - mask[i];
  return out;
}

export const maskIsEmpty = (mask: Mask): boolean => !mask.some((v) => v > 0);

/** The tight box around the selected pixels, or null when nothing is selected. */
export function maskBounds(mask: Mask, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Grows (n > 0) or shrinks (n < 0) a selection by n pixels. */
export function growMask(mask: Mask, w: number, h: number, n: number): Mask {
  if (n === 0) return mask;
  const grow = n > 0;
  let cur = grow ? mask : invertMask(mask);
  for (let step = 0; step < Math.abs(n); step++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) next[i] = 255;
      }
    }
    cur = next;
  }
  return grow ? cur : invertMask(cur);
}

/** Softens the edge of a selection (a box blur of the mask, twice). */
export function featherMask(mask: Mask, w: number, h: number, radius: number): Mask {
  const r = Math.round(radius);
  if (r <= 0) return mask;
  const f = new Float32Array(mask);
  const tmp = new Float32Array(f.length);
  for (let pass = 0; pass < 2; pass++) {
    boxPassGeneric(f, tmp, w, h, r, true, 1);
    boxPassGeneric(tmp, f, w, h, r, false, 1);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = byte(f[i]);
  return out;
}

/** The pixels on the border of the selection (for the marching ants): x and y pairs. */
export function maskEdges(mask: Mask, w: number, h: number): Int32Array {
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] < 128) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || mask[i - 1] < 128 || mask[i + 1] < 128 || mask[i - w] < 128 || mask[i + w] < 128) out.push(x, y);
    }
  }
  return Int32Array.from(out);
}

/* ---------- gradients ---------- */

/** Fills with a gradient from (x1, y1) in `from` to (x2, y2) in `to` ("linear") or from the centre outwards ("radial"). */
export function fillGradient(
  px: Pixels, x1: number, y1: number, x2: number, y2: number, from: RGBA, to: RGBA, kind: 'linear' | 'radial' = 'linear', selection?: Mask | null,
): void {
  const { width: w, height: h, data } = px;
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const weight = selection ? selection[p] / 255 : 1;
      if (weight <= 0) continue;
      let t: number;
      if (len2 === 0) t = 1;
      else if (kind === 'radial') t = Math.hypot(x + 0.5 - x1, y + 0.5 - y1) / len;
      else t = ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / len2;
      t = clamp(t, 0, 1);
      const c: RGBA = { r: from.r + (to.r - from.r) * t, g: from.g + (to.g - from.g) * t, b: from.b + (to.b - from.b) * t, a: from.a + (to.a - from.a) * t };
      over(data, p * 4, c, weight);
    }
  }
}

/* ---------- filters ---------- */

export interface FilterParam { key: string; label: string; min: number; max: number; step: number; value: number }
export interface FilterDef { id: string; label: string; group: 'Adjust' | 'Blur' | 'Artistic' | 'Other'; params: FilterParam[]; run: (px: Pixels, p: Record<string, number>) => void }

function boxPassGeneric(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean, channels: number): void {
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const stepIn = (horizontal ? 1 : w) * channels, stepLine = (horizontal ? w : 1) * channels, div = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    const base = line * stepLine;
    for (let c = 0; c < channels; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + clamp(k, 0, len - 1) * stepIn + c];
      for (let i = 0; i < len; i++) {
        dst[base + i * stepIn + c] = sum / div;
        sum += src[base + Math.min(len - 1, i + r + 1) * stepIn + c] - src[base + Math.max(0, i - r) * stepIn + c];
      }
    }
  }
}

/** A gaussian-like blur (three box blurs) of premultiplied colour, so transparent edges do not turn dark. */
export function blurPixels(px: Pixels, radius: number): void {
  const r = Math.round(radius);
  if (r < 1) return;
  const { width: w, height: h, data } = px;
  const a = new Float32Array(w * h * 4), b = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const al = data[i * 4 + 3] / 255;
    a[i * 4] = data[i * 4] * al; a[i * 4 + 1] = data[i * 4 + 1] * al; a[i * 4 + 2] = data[i * 4 + 2] * al; a[i * 4 + 3] = data[i * 4 + 3];
  }
  const each = Math.max(1, Math.round(r / 2));
  for (let pass = 0; pass < 3; pass++) {
    boxPassGeneric(a, b, w, h, each, true, 4);
    boxPassGeneric(b, a, w, h, each, false, 4);
  }
  // The last pass wrote back into `a`.
  for (let i = 0; i < w * h; i++) {
    const al = a[i * 4 + 3] / 255;
    if (al <= 0) { data[i * 4] = 0; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; data[i * 4 + 3] = 0; continue; }
    data[i * 4] = byte(a[i * 4] / al); data[i * 4 + 1] = byte(a[i * 4 + 1] / al); data[i * 4 + 2] = byte(a[i * 4 + 2] / al); data[i * 4 + 3] = byte(a[i * 4 + 3]);
  }
}

function perPixel(px: Pixels, fn: (r: number, g: number, b: number, a: number) => [number, number, number]): void {
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = fn(d[i], d[i + 1], d[i + 2], d[i + 3]);
    d[i] = byte(r); d[i + 1] = byte(g); d[i + 2] = byte(b);
  }
}

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function convolve(px: Pixels, kernel: number[], factor: number, bias: number): void {
  const { width: w, height: h, data } = px;
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) sum += src[(clamp(y + ky, 0, h - 1) * w + clamp(x + kx, 0, w - 1)) * 4 + c] * kernel[(ky + 1) * 3 + kx + 1];
        }
        data[o + c] = byte(sum * factor + bias);
      }
    }
  }
}

export const FILTERS: FilterDef[] = [
  { id: 'invert', label: 'Invert', group: 'Adjust', params: [], run: (px) => perPixel(px, (r, g, b) => [255 - r, 255 - g, 255 - b]) },
  { id: 'grayscale', label: 'Desaturate (grayscale)', group: 'Adjust', params: [], run: (px) => perPixel(px, (r, g, b) => { const l = luma(r, g, b); return [l, l, l]; }) },
  {
    id: 'sepia', label: 'Sepia', group: 'Adjust', params: [],
    run: (px) => perPixel(px, (r, g, b) => [0.393 * r + 0.769 * g + 0.189 * b, 0.349 * r + 0.686 * g + 0.168 * b, 0.272 * r + 0.534 * g + 0.131 * b]),
  },
  {
    id: 'brightness-contrast', label: 'Brightness / Contrast', group: 'Adjust',
    params: [{ key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, value: 0 }, { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, value: 0 }],
    run: (px, p) => {
      const add = (p.brightness ?? 0) * 2.55, f = (259 * ((p.contrast ?? 0) * 2.55 + 255)) / (255 * (259 - (p.contrast ?? 0) * 2.55));
      perPixel(px, (r, g, b) => [f * (r + add - 128) + 128, f * (g + add - 128) + 128, f * (b + add - 128) + 128]);
    },
  },
  {
    id: 'hue-saturation', label: 'Hue / Saturation / Lightness', group: 'Adjust',
    params: [
      { key: 'hue', label: 'Hue shift (°)', min: -180, max: 180, step: 1, value: 0 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, value: 0 },
      { key: 'lightness', label: 'Lightness', min: -100, max: 100, step: 1, value: 0 },
    ],
    run: (px, p) => perPixel(px, (r, g, b) => {
      const c = rgbToHsl(r, g, b);
      const l = clamp(c.l + ((p.lightness ?? 0) / 100) * ((p.lightness ?? 0) > 0 ? 1 - c.l : c.l), 0, 1);
      const s = clamp(c.s * (1 + (p.saturation ?? 0) / 100), 0, 1);
      const out = hslToRgb(c.h + (p.hue ?? 0), s, l);
      return [out.r, out.g, out.b];
    }),
  },
  {
    id: 'posterize', label: 'Posterize', group: 'Artistic', params: [{ key: 'levels', label: 'Levels', min: 2, max: 16, step: 1, value: 4 }],
    run: (px, p) => { const n = Math.max(2, Math.round(p.levels ?? 4)) - 1; perPixel(px, (r, g, b) => [Math.round((r / 255) * n) * (255 / n), Math.round((g / 255) * n) * (255 / n), Math.round((b / 255) * n) * (255 / n)]); },
  },
  {
    id: 'threshold', label: 'Threshold (black and white)', group: 'Artistic', params: [{ key: 'level', label: 'Level', min: 0, max: 255, step: 1, value: 128 }],
    run: (px, p) => perPixel(px, (r, g, b) => { const v = luma(r, g, b) >= (p.level ?? 128) ? 255 : 0; return [v, v, v]; }),
  },
  { id: 'blur', label: 'Gaussian blur', group: 'Blur', params: [{ key: 'radius', label: 'Radius', min: 1, max: 60, step: 1, value: 6 }], run: (px, p) => blurPixels(px, p.radius ?? 6) },
  {
    id: 'sharpen', label: 'Sharpen (unsharp mask)', group: 'Blur',
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 300, step: 5, value: 100 }, { key: 'radius', label: 'Radius', min: 1, max: 20, step: 1, value: 2 }],
    run: (px, p) => {
      const blurred = copyPixels(px);
      blurPixels(blurred, p.radius ?? 2);
      const k = (p.amount ?? 100) / 100, d = px.data, b = blurred.data;
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = byte(d[i + c] + k * (d[i + c] - b[i + c]));
    },
  },
  {
    id: 'pixelate', label: 'Pixelate', group: 'Artistic', params: [{ key: 'size', label: 'Block size', min: 2, max: 64, step: 1, value: 8 }],
    run: (px, p) => {
      const n = Math.max(2, Math.round(p.size ?? 8)), { width: w, height: h, data } = px;
      for (let by = 0; by < h; by += n) {
        for (let bx = 0; bx < w; bx += n) {
          let r = 0, g = 0, b = 0, a = 0, count = 0;
          for (let y = by; y < Math.min(h, by + n); y++) for (let x = bx; x < Math.min(w, bx + n); x++) { const i = (y * w + x) * 4; const al = data[i + 3]; r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; count++; }
          const out = a > 0 ? [r / a, g / a, b / a, a / count] : [0, 0, 0, 0];
          for (let y = by; y < Math.min(h, by + n); y++) for (let x = bx; x < Math.min(w, bx + n); x++) { const i = (y * w + x) * 4; data[i] = byte(out[0]); data[i + 1] = byte(out[1]); data[i + 2] = byte(out[2]); data[i + 3] = byte(out[3]); }
        }
      }
    },
  },
  {
    id: 'noise', label: 'Add noise', group: 'Artistic',
    params: [{ key: 'amount', label: 'Amount', min: 1, max: 100, step: 1, value: 20 }, { key: 'seed', label: 'Seed', min: 1, max: 999, step: 1, value: 1 }],
    run: (px, p) => { const rnd = mulberry32(p.seed ?? 1), k = ((p.amount ?? 20) / 100) * 255; perPixel(px, (r, g, b) => { const n = (rnd() - 0.5) * k; return [r + n, g + n, b + n]; }); },
  },
  {
    id: 'edges', label: 'Edge detect', group: 'Other', params: [],
    run: (px) => {
      const { width: w, height: h, data } = px, gray = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      const at = (x: number, y: number): number => gray[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
          const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
          const v = byte(Math.hypot(gx, gy)), o = (y * w + x) * 4;
          data[o] = v; data[o + 1] = v; data[o + 2] = v;
        }
      }
    },
  },
  { id: 'emboss', label: 'Emboss', group: 'Other', params: [], run: (px) => convolve(px, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 128) },
  {
    id: 'vignette', label: 'Vignette', group: 'Other', params: [{ key: 'strength', label: 'Strength', min: 0, max: 100, step: 1, value: 50 }],
    run: (px, p) => {
      const { width: w, height: h } = px, k = (p.strength ?? 50) / 100, cx = w / 2, cy = h / 2, max = Math.hypot(cx, cy);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const t = Math.pow(Math.hypot(x - cx, y - cy) / max, 2) * k, o = (y * w + x) * 4;
          px.data[o] = byte(px.data[o] * (1 - t)); px.data[o + 1] = byte(px.data[o + 1] * (1 - t)); px.data[o + 2] = byte(px.data[o + 2] * (1 - t));
        }
      }
    },
  },
];

export const filterById = (id: string): FilterDef | undefined => FILTERS.find((f) => f.id === id);

/** `params` for a filter with the defaults filled in and every value kept inside its range. */
export function filterParams(def: FilterDef, given: Record<string, unknown> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const param of def.params) {
    const raw = typeof given[param.key] === 'number' ? (given[param.key] as number) : param.value;
    out[param.key] = clamp(raw, param.min, param.max);
  }
  return out;
}

/** Runs a filter on the pixels, only inside the selection (soft edges blend smoothly). Returns false for an unknown filter. */
export function applyFilter(px: Pixels, id: string, given: Record<string, unknown> = {}, selection?: Mask | null): boolean {
  const def = filterById(id);
  if (!def) return false;
  const filtered = copyPixels(px);
  def.run(filtered, filterParams(def, given));
  for (let p = 0; p < px.width * px.height; p++) {
    const w = selection ? selection[p] / 255 : 1;
    if (w <= 0) continue;
    for (let c = 0; c < 4; c++) px.data[p * 4 + c] = w >= 1 ? filtered.data[p * 4 + c] : px.data[p * 4 + c] + (filtered.data[p * 4 + c] - px.data[p * 4 + c]) * w;
  }
  return true;
}
