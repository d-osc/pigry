/** The painting engine of the Drawing extension: layers as canvases, the brush, shapes, text, fills, selections, filters,
 * transforms and undo history. The editor screen and the agent tools drive the same `DrawingSession`. Browser only. */
import {
  BLEND_MODES, FONT_STACKS, MAX_LAYERS, brushById, blendOp, clampSide, emptyLayer, findLayer, newLayerId,
  type BrushSettings, type Drawing, type DrawingLayer, type DrawOp, type FontFamily,
} from './drawing';
import {
  applyFilter, bucketFill, combineMasks, ellipseMask, featherMask, fillGradient, fillMask, floodMask, growMask, hexOf, invertMask, makeMask, maskBounds,
  maskEdges, maskIsEmpty, parseColor, polygonMask, rectMask, type Mask, type Pixels, type RGBA, type SelectMode,
} from './drawingPixels';

type Ctx = CanvasRenderingContext2D;

export interface LayerRt { meta: Omit<DrawingLayer, 'png'>; canvas: HTMLCanvasElement }
export interface StrokePoint { x: number; y: number; p: number }
export interface StrokeOptions extends BrushSettings { color: RGBA; erase: boolean; mirrorX: boolean; mirrorY: boolean }

interface Snapshot {
  label: string;
  width: number;
  height: number;
  background: string | null;
  meta: Array<Omit<DrawingLayer, 'png'>>;
  pixels: Map<string, ImageData>;
  selection: Mask | null;
  full: boolean;
}

const HISTORY_LIMIT = 40;
const css = (c: RGBA): string => `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  return canvas;
}
const ctxOf = (canvas: HTMLCanvasElement): Ctx => canvas.getContext('2d', { willReadFrequently: true })!;

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new window.Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('an image could not be decoded')); image.src = src; });
  return image;
}

export class DrawingSession {
  title: string;
  width: number;
  height: number;
  background: string | null;
  layers: LayerRt[] = [];
  activeId = '';
  selection: Mask | null = null;
  /** Bumped on every change so views know to repaint. */
  rev = 0;
  /** Off for the agent tools, which do not need undo. */
  recording = true;
  clipboard: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners = new Set<() => void>();
  private scratch: HTMLCanvasElement | null = null;
  private preview: HTMLCanvasElement | null = null;
  private group: HTMLCanvasElement | null = null;
  private selCanvas: HTMLCanvasElement | null = null;
  private selCanvasFor: Mask | null = null;
  private edgesFor: Mask | null = null;
  private edgeCache: Int32Array = new Int32Array(0);
  private sprites = new Map<string, HTMLCanvasElement>();
  stroke: StrokeRt | null = null;
  moveOffset: { id: string; dx: number; dy: number } | null = null;

  constructor(title: string, width: number, height: number, background: string | null) {
    this.title = title; this.width = width; this.height = height; this.background = background;
  }

  static async from(drawing: Drawing): Promise<DrawingSession> {
    const session = new DrawingSession(drawing.title, drawing.width, drawing.height, drawing.background);
    for (const l of drawing.layers) {
      const canvas = makeCanvas(drawing.width, drawing.height);
      if (l.png) { try { ctxOf(canvas).drawImage(await loadImage(l.png), 0, 0); } catch { /* an unreadable layer stays empty */ } }
      const { png: _png, ...meta } = l;
      void _png;
      session.layers.push({ meta, canvas });
    }
    session.activeId = session.layers[session.layers.length - 1]?.meta.id ?? '';
    return session;
  }

  toDrawing(): Drawing {
    return {
      version: 1, title: this.title, width: this.width, height: this.height, background: this.background,
      layers: this.layers.map(({ meta, canvas }) => ({ ...meta, png: this.isBlank(canvas) ? '' : canvas.toDataURL('image/png') })),
    };
  }

  private isBlank(canvas: HTMLCanvasElement): boolean {
    const d = ctxOf(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }

  /* ---------- change tracking ---------- */

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  touch(): void { this.rev++; this.listeners.forEach((fn) => fn()); }

  private capture(label: string, ids: string[] | 'all'): Snapshot {
    const full = ids === 'all';
    const pixels = new Map<string, ImageData>();
    for (const l of this.layers) if (full || ids.includes(l.meta.id)) pixels.set(l.meta.id, ctxOf(l.canvas).getImageData(0, 0, l.canvas.width, l.canvas.height));
    return { label, width: this.width, height: this.height, background: this.background, meta: this.layers.map((l) => ({ ...l.meta })), pixels, selection: this.selection, full };
  }

  /** Remember the state before a change so it can be undone. `ids` = the layers whose pixels will change. */
  begin(label: string, ids: string[] | 'all'): void {
    if (!this.recording) return;
    this.undoStack.push(this.capture(label, ids));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private restore(snap: Snapshot): void {
    this.width = snap.width; this.height = snap.height; this.background = snap.background;
    const byId = new Map(this.layers.map((l) => [l.meta.id, l]));
    this.layers = snap.meta.map((meta) => {
      const existing = byId.get(meta.id);
      const data = snap.pixels.get(meta.id);
      let canvas = existing?.canvas;
      if (!canvas || canvas.width !== snap.width || canvas.height !== snap.height) canvas = makeCanvas(snap.width, snap.height);
      if (data) ctxOf(canvas).putImageData(data, 0, 0);
      return { meta: { ...meta }, canvas };
    });
    if (!this.layers.some((l) => l.meta.id === this.activeId)) this.activeId = this.layers[this.layers.length - 1]?.meta.id ?? '';
    this.setSelection(snap.selection, true);
  }

  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.redoStack.push(this.capture(snap.label, snap.full ? 'all' : [...snap.pixels.keys()]));
    this.restore(snap);
    this.touch();
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    this.undoStack.push(this.capture(snap.label, snap.full ? 'all' : [...snap.pixels.keys()]));
    this.restore(snap);
    this.touch();
    return true;
  }

  get historyLabels(): { undo: string[]; redo: string[] } { return { undo: this.undoStack.map((s) => s.label), redo: this.redoStack.map((s) => s.label).reverse() }; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /* ---------- layers ---------- */

  setActive(id: string): void {
    if (this.layers.some((l) => l.meta.id === id) && id !== this.activeId) { this.activeId = id; this.touch(); }
  }

  get active(): LayerRt | undefined { return this.layers.find((l) => l.meta.id === this.activeId); }
  layerOf(ref?: unknown): LayerRt | undefined {
    if (ref === undefined || ref === null || ref === '') return this.active ?? this.layers[this.layers.length - 1];
    const meta = findLayer(this.layers.map((l) => ({ ...l.meta, png: '' })), ref);
    return meta ? this.layers.find((l) => l.meta.id === meta.id) : undefined;
  }
  private indexOf(id: string): number { return this.layers.findIndex((l) => l.meta.id === id); }

  addLayer(name?: string, above?: string, fill?: RGBA): LayerRt {
    if (this.layers.length >= MAX_LAYERS) throw new Error(`a drawing can have at most ${MAX_LAYERS} layers`);
    this.begin('Add layer', 'all');
    const id = newLayerId(this.layers.map((l) => ({ id: l.meta.id })));
    const { png: _png, ...meta } = emptyLayer(id, name?.trim() || `Layer ${this.layers.length + 1}`);
    void _png;
    const layer: LayerRt = { meta, canvas: makeCanvas(this.width, this.height) };
    if (fill) { const c = ctxOf(layer.canvas); c.fillStyle = css(fill); c.fillRect(0, 0, this.width, this.height); }
    const at = above ? this.indexOf(above) : this.layers.length - 1;
    this.layers.splice(at + 1, 0, layer);
    this.activeId = id;
    this.touch();
    return layer;
  }

  editLayer(id: string, patch: Partial<Omit<DrawingLayer, 'id' | 'png'>>, label = 'Change layer'): void {
    const layer = this.layers.find((l) => l.meta.id === id);
    if (!layer) return;
    this.begin(label, []);
    if (patch.name !== undefined) layer.meta.name = String(patch.name).trim().slice(0, 60) || layer.meta.name;
    if (patch.visible !== undefined) layer.meta.visible = !!patch.visible;
    if (patch.opacity !== undefined) layer.meta.opacity = Math.min(1, Math.max(0, Number(patch.opacity)));
    if (patch.blend !== undefined && BLEND_MODES.some((m) => m.id === patch.blend)) layer.meta.blend = String(patch.blend);
    if (patch.locked !== undefined) layer.meta.locked = !!patch.locked;
    if (patch.alphaLock !== undefined) layer.meta.alphaLock = !!patch.alphaLock;
    if (patch.clip !== undefined) layer.meta.clip = !!patch.clip;
    this.touch();
  }

  deleteLayer(id: string): void {
    if (this.layers.length <= 1) { this.clearLayer(id); return; }
    this.begin('Delete layer', 'all');
    const i = this.indexOf(id);
    if (i < 0) return;
    this.layers.splice(i, 1);
    if (this.activeId === id) this.activeId = this.layers[Math.min(i, this.layers.length - 1)].meta.id;
    this.touch();
  }

  duplicateLayer(id: string): LayerRt | undefined {
    const src = this.layers.find((l) => l.meta.id === id);
    if (!src || this.layers.length >= MAX_LAYERS) return undefined;
    this.begin('Duplicate layer', 'all');
    const copyId = newLayerId(this.layers.map((l) => ({ id: l.meta.id })));
    const layer: LayerRt = { meta: { ...src.meta, id: copyId, name: `${src.meta.name} copy` }, canvas: makeCanvas(this.width, this.height) };
    ctxOf(layer.canvas).drawImage(src.canvas, 0, 0);
    this.layers.splice(this.indexOf(id) + 1, 0, layer);
    this.activeId = copyId;
    this.touch();
    return layer;
  }

  moveLayer(id: string, to: number): void {
    const from = this.indexOf(id);
    if (from < 0) return;
    const target = Math.min(this.layers.length - 1, Math.max(0, Math.round(to)));
    if (target === from) return;
    this.begin('Move layer', []);
    const [layer] = this.layers.splice(from, 1);
    this.layers.splice(target, 0, layer);
    this.touch();
  }

  mergeDown(id: string): void {
    const i = this.indexOf(id);
    if (i <= 0) return;
    this.begin('Merge down', 'all');
    const top = this.layers[i], below = this.layers[i - 1];
    const c = ctxOf(below.canvas);
    c.save();
    c.globalAlpha = top.meta.visible ? top.meta.opacity : 0;
    c.globalCompositeOperation = blendOp(top.meta.blend);
    c.drawImage(top.canvas, 0, 0);
    c.restore();
    this.layers.splice(i, 1);
    this.activeId = below.meta.id;
    this.touch();
  }

  /** Merge every visible layer into one (hidden layers are dropped). */
  flatten(): void {
    this.begin('Flatten image', 'all');
    const canvas = this.compose(true);
    this.layers = [{ meta: { ...emptyLayerMeta('l1', 'Flattened') }, canvas }];
    this.activeId = 'l1';
    this.touch();
  }

  clearLayer(id: string): void {
    const layer = this.layers.find((l) => l.meta.id === id);
    if (!layer) return;
    this.begin('Clear layer', [id]);
    const c = ctxOf(layer.canvas);
    if (this.selection) { const img = c.getImageData(0, 0, this.width, this.height); for (let p = 0; p < this.selection.length; p++) img.data[p * 4 + 3] *= 1 - this.selection[p] / 255; c.putImageData(img, 0, 0); } else c.clearRect(0, 0, this.width, this.height);
    this.touch();
  }

  /* ---------- selection ---------- */

  setSelection(mask: Mask | null, silent = false): void {
    this.selection = mask && !maskIsEmpty(mask) ? mask : null;
    if (!silent) this.touch();
  }

  selectShape(shape: 'rect' | 'ellipse' | 'polygon', geom: { x?: number; y?: number; w?: number; h?: number; points?: Array<{ x: number; y: number }> }, mode: SelectMode = 'replace'): void {
    const { width: W, height: H } = this;
    const next = shape === 'rect' ? rectMask(W, H, geom.x ?? 0, geom.y ?? 0, geom.w ?? 0, geom.h ?? 0)
      : shape === 'ellipse' ? ellipseMask(W, H, geom.x ?? 0, geom.y ?? 0, geom.w ?? 0, geom.h ?? 0) : polygonMask(W, H, geom.points ?? []);
    this.begin('Select', []);
    this.setSelection(combineMasks(this.selection, next, mode));
  }

  selectAll(): void { this.begin('Select all', []); this.setSelection(makeMask(this.width, this.height, 255)); }
  deselect(): void { if (this.selection) { this.begin('Deselect', []); this.setSelection(null); } }
  invertSelection(): void { this.begin('Invert selection', []); this.setSelection(this.selection ? invertMask(this.selection) : makeMask(this.width, this.height, 255)); }
  growSelection(n: number): void { if (this.selection) { this.begin(n >= 0 ? 'Grow selection' : 'Shrink selection', []); this.setSelection(growMask(this.selection, this.width, this.height, n)); } }
  featherSelection(r: number): void { if (this.selection) { this.begin('Feather selection', []); this.setSelection(featherMask(this.selection, this.width, this.height, r)); } }

  /** The magic wand: select the area that looks like the pixel at (x, y), judged on the active layer or on the whole picture. */
  selectColor(x: number, y: number, tolerance: number, contiguous: boolean, mode: SelectMode = 'replace', sampleAll = false): void {
    const px = sampleAll ? this.pixelsOf(this.compose(false)) : this.getPixels(this.active);
    if (!px) return;
    this.begin('Magic wand', []);
    this.setSelection(combineMasks(this.selection, floodMask(px, x, y, tolerance, contiguous), mode));
  }

  /** Outline pixels of the selection (x, y pairs), cached per selection. */
  selectionEdges(): Int32Array {
    if (!this.selection) return new Int32Array(0);
    if (this.edgesFor !== this.selection) { this.edgeCache = maskEdges(this.selection, this.width, this.height); this.edgesFor = this.selection; }
    return this.edgeCache;
  }

  selectionBounds(): { x: number; y: number; w: number; h: number } | null { return this.selection ? maskBounds(this.selection, this.width, this.height) : null; }

  private selectionCanvas(): HTMLCanvasElement | null {
    if (!this.selection) return null;
    if (this.selCanvasFor !== this.selection || !this.selCanvas) {
      const canvas = this.selCanvas && this.selCanvas.width === this.width && this.selCanvas.height === this.height ? this.selCanvas : makeCanvas(this.width, this.height);
      const c = ctxOf(canvas), img = c.createImageData(this.width, this.height);
      for (let p = 0; p < this.selection.length; p++) img.data[p * 4 + 3] = this.selection[p];
      c.putImageData(img, 0, 0);
      this.selCanvas = canvas; this.selCanvasFor = this.selection;
    }
    return this.selCanvas;
  }

  /* ---------- pixels ---------- */

  getPixels(layer?: LayerRt): Pixels | null {
    if (!layer) return null;
    const img = ctxOf(layer.canvas).getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    return { width: img.width, height: img.height, data: img.data };
  }
  private pixelsOf(canvas: HTMLCanvasElement): Pixels {
    const img = ctxOf(canvas).getImageData(0, 0, canvas.width, canvas.height);
    return { width: img.width, height: img.height, data: img.data };
  }
  private putPixels(layer: LayerRt, px: Pixels, keepAlpha: boolean): void {
    const c = ctxOf(layer.canvas);
    if (keepAlpha) {
      const old = c.getImageData(0, 0, px.width, px.height).data;
      for (let i = 3; i < old.length; i += 4) px.data[i] = old[i];
    }
    c.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
  }

  /** The colour at (x, y) of the active layer or of the whole picture; null outside the canvas. */
  sample(x: number, y: number, whole: boolean): RGBA | null {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return null;
    const source = whole ? this.compose(false) : this.active?.canvas;
    if (!source) return null;
    const d = ctxOf(source).getImageData(xi, yi, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  }

  /* ---------- compositing ---------- */

  private temp(kind: 'scratch' | 'preview' | 'group'): HTMLCanvasElement {
    let canvas = this[kind];
    if (!canvas || canvas.width !== this.width || canvas.height !== this.height) { canvas = makeCanvas(this.width, this.height); this[kind] = canvas; }
    else ctxOf(canvas).clearRect(0, 0, this.width, this.height);
    return canvas;
  }

  /** Draws `src` through the selection onto a layer: normal, erasing, or only where the layer already has pixels (alpha lock). */
  private blit(layer: LayerRt, src: HTMLCanvasElement, opts: { erase?: boolean; opacity?: number } = {}): void {
    this.blitTo(ctxOf(layer.canvas), src, layer.meta.alphaLock, opts);
  }

  private blitTo(target: Ctx, src: HTMLCanvasElement, alphaLock: boolean, opts: { erase?: boolean; opacity?: number }): void {
    let source = src;
    const sel = this.selectionCanvas();
    if (sel) {
      const masked = this.temp('group');
      const mc = ctxOf(masked);
      mc.drawImage(src, 0, 0);
      mc.globalCompositeOperation = 'destination-in';
      mc.drawImage(sel, 0, 0);
      mc.globalCompositeOperation = 'source-over';
      source = masked;
    }
    target.save();
    target.globalAlpha = opts.opacity ?? 1;
    target.globalCompositeOperation = opts.erase ? 'destination-out' : alphaLock ? 'source-atop' : 'source-over';
    target.drawImage(source, 0, 0);
    target.restore();
  }

  /** The layer as it should look right now: with a live brush stroke or a layer move in progress applied. */
  private layerSource(l: LayerRt): HTMLCanvasElement {
    if (this.moveOffset && this.moveOffset.id === l.meta.id) {
      const p = this.temp('preview');
      ctxOf(p).drawImage(l.canvas, this.moveOffset.dx, this.moveOffset.dy);
      return p;
    }
    const s = this.stroke;
    if (s && s.layerId === l.meta.id && !s.direct) {
      const p = this.temp('preview');
      const c = ctxOf(p);
      c.drawImage(l.canvas, 0, 0);
      this.blitTo(c, s.canvas, l.meta.alphaLock, { erase: s.opts.erase, opacity: s.opacity });
      return p;
    }
    return l.canvas;
  }

  /** Paints every visible layer (with blend modes, opacity and clipping) onto a fresh canvas. */
  compose(withBackground: boolean): HTMLCanvasElement {
    const out = makeCanvas(this.width, this.height);
    this.renderTo(ctxOf(out), withBackground);
    return out;
  }

  renderTo(ctx: Ctx, withBackground: boolean): void {
    ctx.clearRect(0, 0, this.width, this.height);
    if (withBackground && this.background) { ctx.fillStyle = this.background; ctx.fillRect(0, 0, this.width, this.height); }
    for (let i = 0; i < this.layers.length; i++) {
      const base = this.layers[i];
      let end = i + 1;
      while (end < this.layers.length && this.layers[end].meta.clip) end++;
      if (!base.meta.visible) { i = end - 1; continue; }
      const draw = (src: HTMLCanvasElement): void => {
        ctx.save();
        ctx.globalAlpha = base.meta.opacity;
        ctx.globalCompositeOperation = blendOp(base.meta.blend);
        ctx.drawImage(src, 0, 0);
        ctx.restore();
      };
      if (end === i + 1) { draw(this.layerSource(base)); continue; }
      // A clipping group: the layers above `base` that are clipped to it only show where `base` has pixels.
      const baseSource = this.layerSource(base);
      const group = makeCanvas(this.width, this.height);
      const gc = ctxOf(group);
      gc.drawImage(baseSource, 0, 0);
      for (let j = i + 1; j < end; j++) {
        const clipped = this.layers[j];
        if (!clipped.meta.visible) continue;
        gc.save();
        gc.globalAlpha = clipped.meta.opacity;
        gc.globalCompositeOperation = 'source-atop';
        gc.drawImage(this.layerSource(clipped), 0, 0);
        gc.restore();
      }
      draw(group);
      i = end - 1;
    }
  }

  /* ---------- brush ---------- */

  private sprite(diameter: number, hardness: number, c: RGBA): HTMLCanvasElement {
    const d = Math.max(1, Math.round(diameter));
    const key = `${d}|${hardness.toFixed(2)}|${c.r},${c.g},${c.b}`;
    const hit = this.sprites.get(key);
    if (hit) return hit;
    if (this.sprites.size > 120) this.sprites.clear();
    const size = d + 2, canvas = makeCanvas(size, size), g = ctxOf(canvas), r = d / 2, mid = size / 2;
    if (hardness >= 0.98) {
      g.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      g.beginPath(); g.arc(mid, mid, r, 0, Math.PI * 2); g.fill();
    } else {
      const gradient = g.createRadialGradient(mid, mid, 0, mid, mid, r);
      const inner = Math.max(0, hardness);
      gradient.addColorStop(0, `rgba(${c.r},${c.g},${c.b},1)`);
      gradient.addColorStop(inner, `rgba(${c.r},${c.g},${c.b},1)`);
      gradient.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, size, size);
    }
    this.sprites.set(key, canvas);
    return canvas;
  }

  private dab(s: StrokeRt, x: number, y: number, p: number): void {
    const o = s.opts;
    const size = Math.max(0.5, o.size * (o.sizePressure ? 0.15 + 0.85 * p : 1) * (1 + (o.scatter > 0 ? (s.rnd() - 0.5) * o.scatter * 0.6 : 0)));
    const alpha = Math.min(1, Math.max(0.01, o.flow * (o.opacityPressure ? 0.2 + 0.8 * p : 1)));
    const spots: Array<[number, number]> = [[x, y]];
    if (o.mirrorX) spots.push([this.width - x, y]);
    if (o.mirrorY) spots.push([x, this.height - y]);
    if (o.mirrorX && o.mirrorY) spots.push([this.width - x, this.height - y]);
    const g = s.ctx;
    g.globalAlpha = alpha;
    for (const [sx, sy] of spots) {
      const jx = o.scatter > 0 ? (s.rnd() - 0.5) * 2 * o.scatter * o.size : 0, jy = o.scatter > 0 ? (s.rnd() - 0.5) * 2 * o.scatter * o.size : 0;
      if (o.pixel) {
        const n = Math.max(1, Math.round(size));
        g.fillStyle = `rgb(${o.color.r},${o.color.g},${o.color.b})`;
        g.fillRect(Math.round(sx + jx - n / 2), Math.round(sy + jy - n / 2), n, n);
      } else {
        const sp = this.sprite(size, o.hardness, o.erase ? { r: 0, g: 0, b: 0, a: 255 } : o.color);
        g.drawImage(sp, sx + jx - sp.width / 2, sy + jy - sp.height / 2);
      }
    }
    g.globalAlpha = 1;
  }

  /** Starts a brush stroke on a layer. Returns false when the layer is locked, hidden or missing. */
  strokeBegin(layerRef: unknown, opts: StrokeOptions, pt: StrokePoint): boolean {
    const layer = this.layerOf(layerRef);
    if (!layer || layer.meta.locked || !layer.meta.visible) return false;
    this.begin(opts.erase ? 'Erase' : 'Brush stroke', [layer.meta.id]);
    let seed = (Math.floor(pt.x * 31 + pt.y * 17) ^ 0x9e3779b9) >>> 0;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const canvas = makeCanvas(this.width, this.height);
    this.stroke = { layerId: layer.meta.id, canvas, ctx: ctxOf(canvas), opts, opacity: opts.opacity, last: pt, smooth: pt, carry: 0, rnd, direct: false };
    this.dab(this.stroke, pt.x, pt.y, pt.p);
    this.touch();
    return true;
  }

  strokeMove(pt: StrokePoint): void {
    const s = this.stroke;
    if (!s) return;
    const k = s.opts.smoothing;
    const to: StrokePoint = { x: s.smooth.x + (pt.x - s.smooth.x) * (1 - k), y: s.smooth.y + (pt.y - s.smooth.y) * (1 - k), p: s.smooth.p + (pt.p - s.smooth.p) * (1 - k) };
    this.strokeSegment(s, to);
    this.touch();
  }

  private strokeSegment(s: StrokeRt, to: StrokePoint): void {
    const from = s.last;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const step = Math.max(s.opts.pixel ? 1 : 0.75, s.opts.size * s.opts.spacing);
    let at = step - s.carry;
    while (at <= dist) {
      const t = at / dist;
      this.dab(s, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.p + (to.p - from.p) * t);
      at += step;
    }
    s.carry = dist === 0 ? s.carry : (s.carry + dist) % step;
    s.last = to; s.smooth = to;
  }

  strokeEnd(finalPt?: StrokePoint): void {
    const s = this.stroke;
    if (!s) return;
    if (finalPt) this.strokeSegment(s, finalPt);
    const layer = this.layers.find((l) => l.meta.id === s.layerId);
    if (layer) this.blit(layer, s.canvas, { erase: s.opts.erase, opacity: s.opacity });
    this.stroke = null;
    this.touch();
  }

  /** Smudge: drags the paint under the brush along with it. */
  smudgeBegin(layerRef: unknown, size: number, strength: number, pt: StrokePoint): boolean {
    const layer = this.layerOf(layerRef);
    if (!layer || layer.meta.locked || !layer.meta.visible) return false;
    this.begin('Smudge', [layer.meta.id]);
    const canvas = makeCanvas(this.width, this.height);
    this.stroke = {
      layerId: layer.meta.id, canvas, ctx: ctxOf(canvas), opts: { ...brushById('airbrush'), size, color: { r: 0, g: 0, b: 0, a: 255 }, erase: false, mirrorX: false, mirrorY: false },
      opacity: strength, last: pt, smooth: pt, carry: 0, rnd: Math.random, direct: true,
    };
    return true;
  }

  smudgeMove(pt: StrokePoint): void {
    const s = this.stroke;
    const layer = s && this.layers.find((l) => l.meta.id === s.layerId);
    if (!s || !layer) return;
    const d = Math.max(2, Math.round(s.opts.size)), half = d / 2;
    const c = ctxOf(layer.canvas);
    const dist = Math.hypot(pt.x - s.last.x, pt.y - s.last.y), step = Math.max(1, d * 0.2);
    for (let at = step; at <= dist + 0.001; at += step) {
      const t = at / Math.max(dist, 0.001);
      const x = s.last.x + (pt.x - s.last.x) * t, y = s.last.y + (pt.y - s.last.y) * t;
      const px = s.last.x + (pt.x - s.last.x) * Math.max(0, t - step / Math.max(dist, 0.001)), py = s.last.y + (pt.y - s.last.y) * Math.max(0, t - step / Math.max(dist, 0.001));
      const grab = makeCanvas(d, d), gc = ctxOf(grab);
      gc.drawImage(layer.canvas, px - half, py - half, d, d, 0, 0, d, d);
      gc.globalCompositeOperation = 'destination-in';
      gc.drawImage(this.sprite(d, 0.2, { r: 0, g: 0, b: 0, a: 255 }), -1, -1);
      c.save();
      c.globalAlpha = Math.min(1, s.opacity);
      c.drawImage(grab, x - half, y - half);
      c.restore();
    }
    s.last = pt;
    this.touch();
  }

  smudgeEnd(): void { this.stroke = null; this.touch(); }

  /* ---------- operations (the agent's vocabulary, and the editor's shapes/fills/filters) ---------- */

  private target(op: DrawOp): LayerRt {
    const layer = this.layerOf(op.layer);
    if (!layer) throw new Error(`no layer "${String(op.layer)}" (see drawing_read)`);
    return layer;
  }

  private paintable(op: DrawOp): LayerRt {
    const layer = this.target(op);
    if (layer.meta.locked) throw new Error(`layer "${layer.meta.name}" is locked`);
    if (!layer.meta.visible) throw new Error(`layer "${layer.meta.name}" is hidden — show it first`);
    return layer;
  }

  /** Draws with `fn` on a scratch canvas, then puts the result onto the layer through the selection. */
  private draw(layer: LayerRt, label: string, fn: (c: Ctx) => void): void {
    this.begin(label, [layer.meta.id]);
    const canvas = this.temp('scratch');
    fn(ctxOf(canvas));
    this.blit(layer, canvas);
    this.touch();
  }

  private pixelOp(layer: LayerRt, label: string, fn: (px: Pixels) => void): void {
    this.begin(label, [layer.meta.id]);
    const px = this.getPixels(layer)!;
    fn(px);
    this.putPixels(layer, px, layer.meta.alphaLock);
    this.touch();
  }

  /** Applies one operation. Returns a short description of what happened; throws a readable error when it cannot. */
  apply(op: DrawOp): string {
    const num = (k: string, d = 0): number => (typeof op[k] === 'number' ? (op[k] as number) : d);
    const color = (k: string): RGBA | null => (op[k] === undefined || op[k] === null ? null : parseColor(op[k]));
    const strokeStyle = (c: Ctx, width: number, col: RGBA, dash?: unknown): void => {
      c.strokeStyle = css(col); c.lineWidth = Math.max(0.1, width); c.lineJoin = 'round';
      if (Array.isArray(dash) && dash.length === 2) c.setLineDash([Number(dash[0]) || 4, Number(dash[1]) || 4]);
    };
    switch (op.op) {
      case 'layer_add': {
        const layer = this.addLayer(typeof op.name === 'string' ? op.name : undefined, op.above !== undefined ? this.target({ ...op, layer: op.above }).meta.id : undefined, color('fill') ?? undefined);
        return `added layer ${layer.meta.id} "${layer.meta.name}"`;
      }
      case 'layer_edit': {
        const layer = this.target(op);
        this.editLayer(layer.meta.id, { name: op.name as string | undefined, visible: op.visible as boolean | undefined, opacity: op.opacity as number | undefined, blend: op.blend as string | undefined, locked: op.locked as boolean | undefined, alphaLock: op.alphaLock as boolean | undefined, clip: op.clip as boolean | undefined });
        return `updated layer ${layer.meta.id}`;
      }
      case 'layer_delete': { const l = this.target(op); this.deleteLayer(l.meta.id); return `deleted layer "${l.meta.name}"`; }
      case 'layer_duplicate': { const l = this.target(op); const d = this.duplicateLayer(l.meta.id); return d ? `duplicated as ${d.meta.id}` : 'could not duplicate (layer limit)'; }
      case 'layer_merge_down': { const l = this.target(op); this.mergeDown(l.meta.id); return `merged "${l.meta.name}" down`; }
      case 'layer_move': { const l = this.target(op); this.moveLayer(l.meta.id, num('to', 1) - 1); return `moved "${l.meta.name}" to position ${Math.min(this.layers.length, Math.max(1, num('to', 1)))}`; }
      case 'layer_clear': { const l = this.paintable(op); this.clearLayer(l.meta.id); return `cleared "${l.meta.name}"`; }
      case 'stroke': {
        const layer = this.paintable(op);
        const base = brushById(op.brush);
        const opts: StrokeOptions = {
          ...base, size: num('size', base.size), opacity: Math.min(1, Math.max(0, num('opacity', base.opacity))), flow: Math.min(1, Math.max(0.01, num('flow', base.flow))),
          hardness: Math.min(1, Math.max(0, num('hardness', base.hardness))), color: color('color')!, erase: op.erase === true, mirrorX: false, mirrorY: false, smoothing: 0,
        };
        const pts = (op.points as number[][]).map((p) => ({ x: p[0], y: p[1], p: typeof p[2] === 'number' ? p[2] : 1 }));
        this.strokeBegin(layer.meta.id, opts, pts[0]);
        for (const pt of pts.slice(1)) this.strokeMove(pt);
        this.strokeEnd();
        return `stroke of ${pts.length} point(s) on "${layer.meta.name}"`;
      }
      case 'line': {
        const layer = this.paintable(op), col = color('color')!;
        this.draw(layer, 'Line', (c) => {
          strokeStyle(c, num('width', 2), col, op.dash);
          c.lineCap = op.cap === 'butt' || op.cap === 'square' ? op.cap : 'round';
          c.beginPath(); c.moveTo(num('x1'), num('y1')); c.lineTo(num('x2'), num('y2')); c.stroke();
        });
        return `line on "${layer.meta.name}"`;
      }
      case 'rect': {
        const layer = this.paintable(op), fill = color('fill'), stroke = color('stroke');
        this.draw(layer, 'Rectangle', (c) => {
          const x = num('x'), y = num('y'), w = num('w'), h = num('h'), r = Math.min(Math.abs(w), Math.abs(h)) / 2;
          c.beginPath();
          if (num('radius') > 0) c.roundRect(x, y, w, h, Math.min(num('radius'), r)); else c.rect(x, y, w, h);
          if (fill) { c.fillStyle = css(fill); c.fill(); }
          if (stroke) { strokeStyle(c, num('width', 2), stroke); c.stroke(); }
        });
        return `rectangle on "${layer.meta.name}"`;
      }
      case 'ellipse': {
        const layer = this.paintable(op), fill = color('fill'), stroke = color('stroke');
        this.draw(layer, 'Ellipse', (c) => {
          c.beginPath(); c.ellipse(num('x') + num('w') / 2, num('y') + num('h') / 2, Math.abs(num('w')) / 2, Math.abs(num('h')) / 2, 0, 0, Math.PI * 2);
          if (fill) { c.fillStyle = css(fill); c.fill(); }
          if (stroke) { strokeStyle(c, num('width', 2), stroke); c.stroke(); }
        });
        return `ellipse on "${layer.meta.name}"`;
      }
      case 'polygon': {
        const layer = this.paintable(op), fill = color('fill'), stroke = color('stroke') ?? (fill ? null : { r: 0, g: 0, b: 0, a: 255 });
        const pts = op.points as number[][];
        this.draw(layer, 'Polygon', (c) => {
          c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
          for (const p of pts.slice(1)) c.lineTo(p[0], p[1]);
          if (op.closed !== false) c.closePath();
          if (fill) { c.fillStyle = css(fill); c.fill(); }
          if (stroke) { strokeStyle(c, num('width', 2), stroke); c.stroke(); }
        });
        return `polygon on "${layer.meta.name}"`;
      }
      case 'text': {
        const layer = this.paintable(op), col = color('color') ?? { r: 0, g: 0, b: 0, a: 255 };
        const size = Math.max(4, num('size', 32)), family = FONT_STACKS[(op.font as FontFamily) in FONT_STACKS ? (op.font as FontFamily) : 'sans'];
        const lines = String(op.text).split('\n');
        this.draw(layer, 'Text', (c) => {
          c.font = `${op.italic ? 'italic ' : ''}${num('weight', 400)} ${size}px ${family}`;
          c.fillStyle = css(col); c.textBaseline = 'top';
          c.textAlign = op.align === 'center' || op.align === 'right' ? op.align : 'left';
          lines.forEach((line, i) => c.fillText(line, num('x'), num('y') + i * size * 1.25));
        });
        return `text on "${layer.meta.name}"`;
      }
      case 'fill': {
        const layer = this.paintable(op);
        let changed = 0;
        this.pixelOp(layer, 'Fill', (px) => { changed = bucketFill(px, num('x'), num('y'), color('color')!, num('tolerance', 32), op.contiguous !== false, this.selection); });
        return `filled ${changed} pixels on "${layer.meta.name}"`;
      }
      case 'gradient': {
        const layer = this.paintable(op);
        this.pixelOp(layer, 'Gradient', (px) => fillGradient(px, num('x1'), num('y1'), num('x2'), num('y2'), color('from')!, color('to')!, op.kind === 'radial' ? 'radial' : 'linear', this.selection));
        return `${op.kind === 'radial' ? 'radial' : 'linear'} gradient on "${layer.meta.name}"`;
      }
      case 'filter': {
        const layer = this.paintable(op);
        let ok = true;
        this.pixelOp(layer, `Filter: ${String(op.filter)}`, (px) => { ok = applyFilter(px, String(op.filter), (op.params as Record<string, unknown>) ?? {}, this.selection); });
        if (!ok) throw new Error(`unknown filter "${String(op.filter)}"`);
        return `applied ${String(op.filter)} to "${layer.meta.name}"`;
      }
      case 'select': {
        const mode = (['replace', 'add', 'subtract', 'intersect'].includes(String(op.mode)) ? op.mode : 'replace') as SelectMode;
        switch (op.shape) {
          case 'all': this.selectAll(); break;
          case 'none': this.deselect(); break;
          case 'invert': this.invertSelection(); break;
          case 'rect': case 'ellipse': this.selectShape(op.shape, { x: num('x'), y: num('y'), w: num('w'), h: num('h') }, mode); break;
          case 'color': { const at = Array.isArray(op.at) ? (op.at as number[]) : [num('x'), num('y')]; this.selectColor(at[0], at[1], num('tolerance', 32), op.contiguous !== false, mode); break; }
          case 'grow': this.growSelection(num('amount', 2)); break;
          case 'shrink': this.growSelection(-num('amount', 2)); break;
          default: this.featherSelection(num('amount', 4));
        }
        const b = this.selectionBounds();
        return b ? `selection ${b.w}×${b.h} at ${b.x},${b.y}` : 'nothing selected';
      }
      case 'fill_selection': {
        const layer = this.paintable(op), col = color('color')!;
        if (!this.selection) throw new Error('nothing is selected — use select first');
        this.pixelOp(layer, 'Fill selection', (px) => fillMask(px, makeMask(px.width, px.height, 255), col, this.selection));
        return `filled the selection on "${layer.meta.name}"`;
      }
      case 'flip': {
        if (op.layer === 'all') { this.flipImage(op.axis === 'vertical'); return 'flipped the image'; }
        const layer = this.paintable(op);
        this.flipLayer(layer.meta.id, op.axis === 'vertical');
        return `flipped "${layer.meta.name}"`;
      }
      case 'rotate': this.rotateImage(num('degrees')); return `rotated the image by ${num('degrees')}°`;
      case 'canvas_resize': this.resizeCanvas(num('width'), num('height'), op.scale === true); return `canvas is now ${this.width}×${this.height}`;
      case 'crop': this.crop(num('x'), num('y'), num('w'), num('h')); return `cropped to ${this.width}×${this.height}`;
      default: throw new Error(`unknown op "${String(op.op)}"`);
    }
  }

  /* ---------- transforms ---------- */

  flipLayer(id: string, vertical: boolean): void {
    const layer = this.layers.find((l) => l.meta.id === id);
    if (!layer) return;
    this.begin('Flip layer', [id]);
    const copy = makeCanvas(this.width, this.height);
    ctxOf(copy).drawImage(layer.canvas, 0, 0);
    const c = ctxOf(layer.canvas);
    c.clearRect(0, 0, this.width, this.height);
    c.save();
    c.translate(vertical ? 0 : this.width, vertical ? this.height : 0);
    c.scale(vertical ? 1 : -1, vertical ? -1 : 1);
    c.drawImage(copy, 0, 0);
    c.restore();
    this.touch();
  }

  /** Scale (percent) and rotate (degrees) the content of a layer around the middle of the canvas. */
  transformLayer(id: string, scalePercent: number, degrees: number, dx = 0, dy = 0): void {
    const layer = this.layers.find((l) => l.meta.id === id);
    if (!layer) return;
    this.begin('Transform layer', [id]);
    const copy = makeCanvas(this.width, this.height);
    ctxOf(copy).drawImage(layer.canvas, 0, 0);
    const c = ctxOf(layer.canvas);
    c.clearRect(0, 0, this.width, this.height);
    c.save();
    c.translate(this.width / 2 + dx, this.height / 2 + dy);
    c.rotate((degrees * Math.PI) / 180);
    c.scale(scalePercent / 100, scalePercent / 100);
    c.drawImage(copy, -this.width / 2, -this.height / 2);
    c.restore();
    this.touch();
  }

  /** Shift a layer's pixels (the Move tool). */
  shiftLayer(id: string, dx: number, dy: number): void {
    const layer = this.layers.find((l) => l.meta.id === id);
    if (!layer || (dx === 0 && dy === 0)) return;
    this.begin('Move layer content', [id]);
    const copy = makeCanvas(this.width, this.height);
    ctxOf(copy).drawImage(layer.canvas, 0, 0);
    const c = ctxOf(layer.canvas);
    c.clearRect(0, 0, this.width, this.height);
    c.drawImage(copy, Math.round(dx), Math.round(dy));
    this.touch();
  }

  private rebuild(width: number, height: number, draw: (c: Ctx, src: HTMLCanvasElement) => void): void {
    this.layers = this.layers.map((l) => {
      const canvas = makeCanvas(width, height);
      draw(ctxOf(canvas), l.canvas);
      return { meta: l.meta, canvas };
    });
    this.width = width; this.height = height;
    this.selection = null;
    this.scratch = this.preview = this.group = this.selCanvas = null;
  }

  flipImage(vertical: boolean): void {
    this.begin('Flip image', 'all');
    const { width: w, height: h } = this;
    this.rebuild(w, h, (c, src) => { c.translate(vertical ? 0 : w, vertical ? h : 0); c.scale(vertical ? 1 : -1, vertical ? -1 : 1); c.drawImage(src, 0, 0); });
    this.touch();
  }

  rotateImage(degrees: number): void {
    const d = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
    if (d === 0) return;
    this.begin('Rotate image', 'all');
    const { width: w, height: h } = this;
    const swap = d !== 180;
    this.rebuild(swap ? h : w, swap ? w : h, (c, src) => {
      c.translate((swap ? h : w) / 2, (swap ? w : h) / 2);
      c.rotate((d * Math.PI) / 180);
      c.drawImage(src, -w / 2, -h / 2);
    });
    this.touch();
  }

  /** New canvas size. `scale` resamples the pixels; otherwise the picture keeps its size and sits at the top-left (or is cut). */
  resizeCanvas(width: number, height: number, scale: boolean, anchor: { x: number; y: number } = { x: 0, y: 0 }): void {
    const w = clampSide(width), h = clampSide(height);
    if (w === this.width && h === this.height) return;
    this.begin(scale ? 'Resize image' : 'Resize canvas', 'all');
    const ow = this.width, oh = this.height;
    this.rebuild(w, h, (c, src) => {
      if (scale) { c.imageSmoothingQuality = 'high'; c.drawImage(src, 0, 0, w, h); } else c.drawImage(src, Math.round((w - ow) * anchor.x), Math.round((h - oh) * anchor.y));
    });
    this.touch();
  }

  crop(x: number, y: number, w: number, h: number): void {
    const cx = Math.max(0, Math.round(x)), cy = Math.max(0, Math.round(y));
    const cw = Math.min(this.width - cx, Math.round(w)), ch = Math.min(this.height - cy, Math.round(h));
    if (cw < 1 || ch < 1) throw new Error('the crop rectangle is outside the canvas');
    this.begin('Crop', 'all');
    this.rebuild(cw, ch, (c, src) => c.drawImage(src, cx, cy, cw, ch, 0, 0, cw, ch));
    this.touch();
  }

  /* ---------- clipboard and images ---------- */

  /** Copies the selected part of the active layer (or the whole layer). With `cut` the pixels are removed. */
  copy(cut: boolean): boolean {
    const layer = this.active;
    if (!layer) return false;
    const b = this.selectionBounds() ?? { x: 0, y: 0, w: this.width, h: this.height };
    const canvas = makeCanvas(b.w, b.h), c = ctxOf(canvas);
    c.drawImage(layer.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    if (this.selection) {
      const img = c.getImageData(0, 0, b.w, b.h);
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) img.data[(y * b.w + x) * 4 + 3] *= this.selection[(b.y + y) * this.width + b.x + x] / 255;
      c.putImageData(img, 0, 0);
    }
    this.clipboard = { canvas, x: b.x, y: b.y };
    if (cut && !layer.meta.locked) this.clearLayer(layer.meta.id);
    return true;
  }

  /** Pastes the clipboard as a new layer where it was copied from. */
  paste(): LayerRt | null {
    if (!this.clipboard) return null;
    const layer = this.addLayer('Pasted');
    ctxOf(layer.canvas).drawImage(this.clipboard.canvas, this.clipboard.x, this.clipboard.y);
    this.touch();
    return layer;
  }

  /** An image file as a new layer, scaled down to fit the canvas and centred. */
  importImage(image: CanvasImageSource & { width: number; height: number }, name: string): LayerRt {
    const layer = this.addLayer(name);
    const k = Math.min(1, this.width / image.width, this.height / image.height);
    const w = image.width * k, h = image.height * k;
    ctxOf(layer.canvas).drawImage(image, (this.width - w) / 2, (this.height - h) / 2, w, h);
    this.touch();
    return layer;
  }

  /** The finished picture (background included) as a data URL. */
  exportDataUrl(type: 'image/png' | 'image/jpeg' | 'image/webp', quality = 0.92): string {
    const flat = this.compose(true);
    if (type === 'image/jpeg') {
      const solid = makeCanvas(this.width, this.height), c = ctxOf(solid);
      c.fillStyle = '#ffffff'; c.fillRect(0, 0, this.width, this.height); c.drawImage(flat, 0, 0);
      return solid.toDataURL(type, quality);
    }
    return flat.toDataURL(type, quality);
  }

  colorLabel(c: RGBA | null): string { return c ? hexOf(c) : ''; }
}

interface StrokeRt {
  layerId: string;
  canvas: HTMLCanvasElement;
  ctx: Ctx;
  opts: StrokeOptions;
  opacity: number;
  last: StrokePoint;
  smooth: StrokePoint;
  carry: number;
  rnd: () => number;
  /** Smudge strokes paint straight on the layer instead of a buffer. */
  direct: boolean;
}

function emptyLayerMeta(id: string, name: string): Omit<DrawingLayer, 'png'> {
  const { png: _png, ...meta } = emptyLayer(id, name);
  void _png;
  return meta;
}
