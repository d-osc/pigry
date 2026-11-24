/** Design document model for the Design editor and the agent's design tools:
 * a Figma-style tree of frames, shapes and text with auto layout, colour
 * tokens, normalization, edit operations, review checks, an SVG renderer (the
 * editor draws with the same renderer it exports with) and an HTML/CSS export.
 * Pure functions — no DOM, no Tauri — so everything is unit-testable in Node. */

export type NodeType = 'frame' | 'rect' | 'ellipse' | 'text' | 'line' | 'image';
export type FontFamily = 'sans' | 'serif' | 'mono';

export interface Gradient { from: string; to: string; /** degrees, 180 = top to bottom */ angle: number }
export type Fill = string | Gradient | null;
export interface Shadow { x: number; y: number; blur: number; color: string }

export interface AutoLayout {
  dir: 'row' | 'column';
  gap: number;
  /** top, right, bottom, left */
  padding: [number, number, number, number];
  justify: 'start' | 'center' | 'end' | 'between';
  align: 'start' | 'center' | 'end' | 'stretch';
  /** Frame shrinks to its content along that axis. */
  hugW: boolean;
  hugH: boolean;
}

export interface DesignNode {
  id: string;
  type: NodeType;
  name: string;
  /** Relative to the parent (top-level nodes: canvas position). */
  x: number; y: number; w: number; h: number;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  /** Solid colour, "$token", gradient, or null for none. Text uses it as the text colour. */
  fill?: Fill;
  stroke?: string;
  strokeWidth?: number;
  radius?: number | [number, number, number, number];
  shadow?: Shadow;
  /** Frames: clip children to the frame (default true). */
  clip?: boolean;
  layout?: AutoLayout;
  /** Child of an auto layout frame: share of the free space along the main axis. */
  grow?: number;
  selfAlign?: 'start' | 'center' | 'end' | 'stretch';
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: FontFamily;
  textAlign?: 'left' | 'center' | 'right';
  /** Multiplier, e.g. 1.4. */
  lineHeight?: number;
  /** 'w' = fit to text, 'h' = fixed width with wrapping, 'none' = fixed box. */
  autoSize?: 'w' | 'h' | 'none';
  /** Image source: data: or https: URL. */
  src?: string;
  children?: DesignNode[];
}

export interface Design {
  version: 1;
  title: string;
  tokens: { colors: Record<string, string> };
  /** Top-level nodes (usually frames) on the canvas. */
  nodes: DesignNode[];
}

export const NODE_TYPES: NodeType[] = ['frame', 'rect', 'ellipse', 'text', 'line', 'image'];
export const MAX_NODES = 2000;
const MAX_DEPTH = 14;

export const DESIGNS_DIR = '.pigry/designs/';
export const DESIGN_EXT = '.design.json';

export const FRAME_PRESETS: Array<{ id: string; label: string; w: number; h: number }> = [
  { id: 'iphone', label: 'iPhone 15 (390×844)', w: 390, h: 844 },
  { id: 'android', label: 'Android (360×800)', w: 360, h: 800 },
  { id: 'tablet', label: 'Tablet (820×1180)', w: 820, h: 1180 },
  { id: 'laptop', label: 'Laptop (1280×800)', w: 1280, h: 800 },
  { id: 'desktop', label: 'Desktop (1440×900)', w: 1440, h: 900 },
];

export const FONT_STACKS: Record<FontFamily, string> = {
  sans: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, Menlo, Consolas, monospace',
};
const CHAR_WIDTH: Record<FontFamily, number> = { sans: 0.56, serif: 0.52, mono: 0.6 };

/* ---------- small helpers ---------- */

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const text = (value: unknown, max = 400): string => String(value ?? '').slice(0, max);
const round = (value: number): number => Math.round(value * 100) / 100;

export const isGradient = (fill: unknown): fill is Gradient =>
  typeof fill === 'object' && fill !== null && 'from' in fill && 'to' in fill;

export function walk(nodes: DesignNode[], visit: (node: DesignNode, parent: DesignNode | null, depth: number) => void, parent: DesignNode | null = null, depth = 0): void {
  for (const node of nodes) {
    visit(node, parent, depth);
    if (node.children) walk(node.children, visit, node, depth + 1);
  }
}

export function allNodes(d: Design): DesignNode[] {
  const out: DesignNode[] = [];
  walk(d.nodes, (node) => out.push(node));
  return out;
}

/** Finds by id, or by name when exactly one node has it. */
export function findNode(d: Design, ref: unknown): DesignNode | undefined {
  const key = String(ref ?? '').trim();
  if (!key) return undefined;
  const nodes = allNodes(d);
  const byId = nodes.find((n) => n.id === key);
  if (byId) return byId;
  const byName = nodes.filter((n) => n.name.trim().toLowerCase() === key.toLowerCase());
  return byName.length === 1 ? byName[0] : undefined;
}

export function parentOf(d: Design, id: string): DesignNode | null | undefined {
  let found: DesignNode | null | undefined;
  walk(d.nodes, (node, parent) => { if (node.id === id) found = parent; });
  return found;
}

export function siblingsOf(d: Design, id: string): DesignNode[] {
  const parent = parentOf(d, id);
  return parent === undefined ? [] : parent ? parent.children ?? [] : d.nodes;
}

/** Position on the canvas (sum of ancestor offsets). */
export function absolutePosition(d: Design, id: string): { x: number; y: number } | null {
  let result: { x: number; y: number } | null = null;
  const go = (nodes: DesignNode[], ox: number, oy: number): boolean => {
    for (const node of nodes) {
      if (node.id === id) { result = { x: ox + node.x, y: oy + node.y }; return true; }
      if (node.children && go(node.children, ox + node.x, oy + node.y)) return true;
    }
    return false;
  };
  go(d.nodes, 0, 0);
  return result;
}

export function absoluteBox(d: Design, id: string): { x: number; y: number; w: number; h: number } | null {
  const node = findNode(d, id);
  const pos = node ? absolutePosition(d, node.id) : null;
  return node && pos ? { x: pos.x, y: pos.y, w: node.w, h: node.h } : null;
}

export const isAutoLayoutFrame = (node: DesignNode | null | undefined): boolean => node?.type === 'frame' && !!node.layout;

const uniqueId = (taken: Set<string>): string => {
  let n = taken.size + 1;
  while (taken.has(`n${n}`)) n += 1;
  const id = `n${n}`;
  taken.add(id);
  return id;
};

const TYPE_NAMES: Record<NodeType, string> = { frame: 'Frame', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text', line: 'Line', image: 'Image' };

/* ---------- text measurement ---------- */

export interface TextMetrics { lines: string[]; width: number; height: number; lineHeightPx: number }

/** Approximate, font-independent text layout — identical for the editor and the exports. */
export function measureText(content: string, fontSize: number, weight: number, family: FontFamily, maxWidth: number | null, lineHeight: number): TextMetrics {
  const charW = fontSize * CHAR_WIDTH[family] * (weight >= 600 ? 1.07 : 1);
  const lineHeightPx = fontSize * lineHeight;
  const maxChars = maxWidth === null ? Infinity : Math.max(1, Math.floor(maxWidth / charW));
  const lines: string[] = [];
  for (const paragraph of content.split('\n')) {
    if (maxChars === Infinity) { lines.push(paragraph); continue; }
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let piece = word;
      while (piece.length > maxChars) { // a single over-long word is hard-broken
        if (current) { lines.push(current); current = ''; }
        lines.push(piece.slice(0, maxChars));
        piece = piece.slice(maxChars);
      }
      if (!current) current = piece;
      else if ((current + ' ' + piece).length <= maxChars) current += ` ${piece}`;
      else { lines.push(current); current = piece; }
    }
    lines.push(current);
  }
  const width = Math.max(...lines.map((line) => line.length), 0) * charW;
  return { lines, width, height: lines.length * lineHeightPx, lineHeightPx };
}

function nodeMetrics(node: DesignNode, maxWidth: number | null): TextMetrics {
  return measureText(node.text ?? '', node.fontSize ?? 16, node.fontWeight ?? 400, node.fontFamily ?? 'sans', maxWidth, node.lineHeight ?? 1.3);
}

/* ---------- normalization ---------- */

export interface NormalizeResult { design: Design; warnings: string[] }

const parsePadding = (value: unknown): [number, number, number, number] => {
  if (typeof value === 'number') { const v = Math.max(0, value); return [v, v, v, v]; }
  if (Array.isArray(value)) {
    const v = value.map((item) => Math.max(0, num(item, 0)));
    if (v.length === 2) return [v[0], v[1], v[0], v[1]];
    if (v.length >= 4) return [v[0], v[1], v[2], v[3]];
    if (v.length === 1) return [v[0], v[0], v[0], v[0]];
  }
  return [0, 0, 0, 0];
};

function parseLayout(value: unknown): AutoLayout | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  const raw = (typeof value === 'object' ? value : { dir: value }) as Record<string, unknown>;
  const dir = raw.dir === 'row' || raw.dir === 'horizontal' ? 'row' : raw.dir === 'column' || raw.dir === 'vertical' || raw.dir === 'col' ? 'column' : null;
  if (!dir) return undefined;
  const hug = raw.hug;
  return {
    dir,
    gap: Math.max(0, num(raw.gap, 0)),
    padding: parsePadding(raw.padding),
    justify: ['start', 'center', 'end', 'between'].includes(raw.justify as string) ? (raw.justify as AutoLayout['justify']) : 'start',
    align: ['start', 'center', 'end', 'stretch'].includes(raw.align as string) ? (raw.align as AutoLayout['align']) : 'start',
    hugW: raw.hugW === true || hug === true || hug === 'both' || hug === 'w',
    hugH: raw.hugH === true || hug === true || hug === 'both' || hug === 'h',
  };
}

function parseFill(value: unknown): Fill | undefined {
  if (value === null || value === 'none') return null;
  if (typeof value === 'string') return text(value, 60);
  if (isGradient(value)) return { from: text(value.from, 60), to: text(value.to, 60), angle: num((value as Gradient).angle, 180) };
  return undefined;
}

function parseShadow(value: unknown): Shadow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as Record<string, unknown>;
  return { x: num(s.x, 0), y: num(s.y, 4), blur: Math.max(0, num(s.blur, 12)), color: text(s.color ?? 'rgba(0,0,0,0.2)', 60) };
}

const TYPE_ALIASES: Record<string, NodeType> = {
  rectangle: 'rect', box: 'rect', circle: 'ellipse', oval: 'ellipse', label: 'text', artboard: 'frame', group: 'frame', container: 'frame', img: 'image', picture: 'image',
};

/** Applies the editable fields of `raw` onto `node` (shared by normalize and update ops). */
export function applyNodeFields(node: DesignNode, raw: Record<string, unknown>): void {
  if (raw.name !== undefined) node.name = text(raw.name, 80) || node.name;
  for (const key of ['x', 'y'] as const) if (raw[key] !== undefined) node[key] = round(num(raw[key], node[key]));
  if (raw.w !== undefined) node.w = Math.max(1, round(num(raw.w, node.w)));
  if (raw.h !== undefined) node.h = Math.max(0, round(num(raw.h, node.h)));
  if (raw.visible !== undefined) node.visible = raw.visible === false ? false : undefined;
  if (raw.locked !== undefined) node.locked = raw.locked === true ? true : undefined;
  if (raw.opacity !== undefined) node.opacity = clamp(num(raw.opacity, 1), 0, 1) === 1 ? undefined : clamp(num(raw.opacity, 1), 0, 1);
  if (raw.fill !== undefined) { const fill = parseFill(raw.fill); if (fill !== undefined) node.fill = fill; }
  if (raw.stroke !== undefined) node.stroke = raw.stroke ? text(raw.stroke, 60) : undefined;
  if (raw.strokeWidth !== undefined) node.strokeWidth = Math.max(0, num(raw.strokeWidth, 1));
  if (raw.radius !== undefined) {
    node.radius = Array.isArray(raw.radius) && raw.radius.length === 4
      ? (raw.radius.map((v) => Math.max(0, num(v, 0))) as [number, number, number, number])
      : Math.max(0, num(raw.radius, 0));
  }
  if (raw.shadow !== undefined) node.shadow = raw.shadow === null ? undefined : parseShadow(raw.shadow);
  if (raw.clip !== undefined) node.clip = raw.clip === false ? false : undefined;
  if (raw.layout !== undefined) node.layout = parseLayout(raw.layout);
  if (raw.grow !== undefined) node.grow = Math.max(0, num(raw.grow, 0)) || undefined;
  if (raw.selfAlign !== undefined) node.selfAlign = ['start', 'center', 'end', 'stretch'].includes(raw.selfAlign as string) ? (raw.selfAlign as DesignNode['selfAlign']) : undefined;
  if (raw.text !== undefined) node.text = text(raw.text, 2000);
  if (raw.fontSize !== undefined) node.fontSize = clamp(num(raw.fontSize, 16), 6, 400);
  if (raw.fontWeight !== undefined) node.fontWeight = clamp(Math.round(num(raw.fontWeight, 400) / 100) * 100, 100, 900);
  if (raw.fontFamily !== undefined) node.fontFamily = ['sans', 'serif', 'mono'].includes(raw.fontFamily as string) ? (raw.fontFamily as FontFamily) : 'sans';
  if (raw.textAlign !== undefined) node.textAlign = ['left', 'center', 'right'].includes(raw.textAlign as string) ? (raw.textAlign as DesignNode['textAlign']) : 'left';
  if (raw.lineHeight !== undefined) node.lineHeight = clamp(num(raw.lineHeight, 1.3), 0.8, 3);
  if (raw.autoSize !== undefined) node.autoSize = ['w', 'h', 'none'].includes(raw.autoSize as string) ? (raw.autoSize as DesignNode['autoSize']) : undefined;
  if (raw.src !== undefined) node.src = /^(data:image\/|https?:\/\/)/i.test(String(raw.src)) ? text(raw.src, 2_000_000) : undefined;
}

interface NormalizeState { taken: Set<string>; counts: Record<string, number>; warnings: string[]; total: number }

function normalizeNode(raw: unknown, state: NormalizeState, depth: number, topLevel = depth === 0): DesignNode | null {
  if (!raw || typeof raw !== 'object') return null;
  if (state.total >= MAX_NODES) { if (state.total === MAX_NODES) { state.warnings.push(`Only the first ${MAX_NODES} nodes were kept.`); state.total += 1; } return null; }
  const r = raw as Record<string, unknown>;
  const typeKey = String(r.type ?? '').toLowerCase();
  const type: NodeType = NODE_TYPES.includes(typeKey as NodeType) ? (typeKey as NodeType)
    : TYPE_ALIASES[typeKey] ?? (Array.isArray(r.children) || r.layout ? 'frame' : r.text !== undefined || r.content !== undefined ? 'text' : 'rect');
  if (r.type !== undefined && !NODE_TYPES.includes(typeKey as NodeType) && !TYPE_ALIASES[typeKey]) state.warnings.push(`Unknown node type "${text(r.type, 20)}" — used "${type}".`);
  state.total += 1;
  let id = String(r.id ?? '').trim().replace(/[^\w.\-]+/g, '_').slice(0, 60);
  if (!id || state.taken.has(id)) { if (id) state.warnings.push(`Duplicate id "${id}" was renamed.`); id = uniqueId(state.taken); } else state.taken.add(id);
  state.counts[type] = (state.counts[type] ?? 0) + 1;
  const defaults: Record<NodeType, Pick<DesignNode, 'w' | 'h'>> = {
    frame: { w: 320, h: 480 }, rect: { w: 100, h: 100 }, ellipse: { w: 100, h: 100 }, text: { w: 100, h: 20 }, line: { w: 100, h: 0 }, image: { w: 120, h: 120 },
  };
  const node: DesignNode = { id, type, name: `${TYPE_NAMES[type]} ${state.counts[type]}`, x: 0, y: 0, ...defaults[type] };
  if (type === 'text') {
    node.text = ''; node.fontSize = 16; node.fontWeight = 400;
    node.autoSize = r.w !== undefined ? 'h' : 'w';
  }
  if (type === 'frame' && topLevel) node.fill = '#ffffff';
  if (type === 'rect' || type === 'ellipse') node.fill = '#d9d9d9';
  if (type === 'line') { node.stroke = '#333333'; node.strokeWidth = 1; }
  if (r.content !== undefined && r.text === undefined) r.text = r.content;
  if (r.color !== undefined && r.fill === undefined && type === 'text') r.fill = r.color;
  if (r.background !== undefined && r.fill === undefined) r.fill = r.background;
  if (type === 'text' && r.fill === undefined) node.fill = '#111111';
  applyNodeFields(node, r);
  // Plain layout wrappers (no fill, stroke or radius) don't clip, so children's shadows stay visible.
  if (type === 'frame' && !topLevel && r.clip === undefined && !node.fill && !node.stroke && !node.radius) node.clip = false;
  if (type === 'text' && r.autoSize === undefined) node.autoSize = r.w !== undefined ? 'h' : 'w';
  if (type !== 'frame') delete node.layout;
  if (Array.isArray(r.children) && depth < MAX_DEPTH) {
    const kids = r.children.map((child) => normalizeNode(child, state, depth + 1, false)).filter((child): child is DesignNode => child !== null);
    if (kids.length) node.children = kids;
    if (type !== 'frame' && kids.length) { node.type = 'frame'; node.fill = node.fill ?? null; }
  } else if (Array.isArray(r.children) && r.children.length) state.warnings.push(`Nesting deeper than ${MAX_DEPTH} levels was dropped.`);
  return node;
}

/** Turns untrusted input (a file or a model's tool arguments) into a valid design, laid out. */
export function normalizeDesign(raw: unknown, fallbackTitle = 'Untitled'): NormalizeResult {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const state: NormalizeState = { taken: new Set(), counts: {}, warnings: [], total: 0 };
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : Array.isArray(input.frames) ? input.frames : [];
  const normalized = rawNodes.map((node) => normalizeNode(node, state, 0));
  const nodes = normalized.filter((node): node is DesignNode => node !== null);
  // Top-level nodes without a position are placed side by side.
  let cursor = 0;
  rawNodes.forEach((item, i) => {
    const node = normalized[i];
    if (!node) return;
    const given = item && typeof item === 'object' && typeof (item as Record<string, unknown>).x === 'number';
    if (!given) node.x = cursor;
    cursor = Math.max(cursor, node.x + node.w + 80);
  });
  const colors: Record<string, string> = {};
  const rawColors = (input.tokens as { colors?: unknown } | undefined)?.colors;
  if (rawColors && typeof rawColors === 'object') {
    for (const [name, value] of Object.entries(rawColors as Record<string, unknown>).slice(0, 80)) {
      const key = name.replace(/[^\w-]+/g, '-').slice(0, 40);
      if (key && typeof value === 'string') colors[key] = text(value, 60);
    }
  }
  const design: Design = { version: 1, title: text(input.title, 120) || fallbackTitle, tokens: { colors }, nodes };
  return { design: layoutDesign(design), warnings: state.warnings };
}

export const emptyDesign = (title = 'Untitled'): Design => ({ version: 1, title, tokens: { colors: {} }, nodes: [] });

export function parseDesignJson(textValue: string, fallbackTitle?: string): NormalizeResult {
  try {
    return normalizeDesign(JSON.parse(textValue), fallbackTitle);
  } catch (error) {
    throw new Error(`not valid design JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const serializeDesign = (d: Design): string => `${JSON.stringify(d, null, 2)}\n`;

/* ---------- auto layout ---------- */

function layoutNode(node: DesignNode): void {
  const kids = node.children ?? [];
  for (const kid of kids) layoutNode(kid);

  if (node.type === 'text') {
    const mode = node.autoSize ?? 'none';
    if (mode === 'w') {
      const m = nodeMetrics(node, null);
      node.w = Math.max(1, Math.ceil(m.width)); node.h = Math.ceil(m.height);
    } else if (mode === 'h') {
      node.h = Math.ceil(nodeMetrics(node, node.w).height);
    }
    return;
  }
  const L = node.layout;
  if (node.type !== 'frame' || !L || kids.length === 0) return;

  const row = L.dir === 'row';
  const [pt, pr, pb, pl] = L.padding;
  const padMain = row ? pl + pr : pt + pb;
  const padCross = row ? pt + pb : pl + pr;
  const flow = kids.filter((kid) => kid.visible !== false);
  const mainOf = (kid: DesignNode) => (row ? kid.w : kid.h);
  const crossOf = (kid: DesignNode) => (row ? kid.h : kid.w);
  const gaps = Math.max(0, flow.length - 1) * L.gap;

  const hugMain = row ? L.hugW : L.hugH;
  const hugCross = row ? L.hugH : L.hugW;
  const contentMain = flow.reduce((sum, kid) => sum + mainOf(kid), 0) + gaps;
  if (hugMain) { const size = Math.ceil(contentMain + padMain); if (row) node.w = size; else node.h = size; }
  if (hugCross) {
    const size = Math.ceil(Math.max(0, ...flow.map((kid) => crossOf(kid))) + padCross);
    if (row) node.h = size; else node.w = size;
  }

  const innerMain = (row ? node.w : node.h) - padMain;
  const innerCross = (row ? node.h : node.w) - padCross;

  // Distribute free space to growing children.
  const growTotal = flow.reduce((sum, kid) => sum + (kid.grow ?? 0), 0);
  if (growTotal > 0 && !hugMain) {
    const free = innerMain - contentMain;
    if (free > 0) {
      for (const kid of flow) if (kid.grow) { const extra = (free * kid.grow) / growTotal; if (row) kid.w += extra; else kid.h += extra; }
    }
  }
  // Stretch children across the cross axis.
  for (const kid of flow) {
    const align = kid.selfAlign ?? L.align;
    if (align === 'stretch') { if (row) kid.h = Math.max(1, innerCross); else kid.w = Math.max(1, innerCross); }
  }

  const used = flow.reduce((sum, kid) => sum + mainOf(kid), 0) + gaps;
  const free = Math.max(0, innerMain - used);
  let gap = L.gap;
  let cursor = row ? pl : pt;
  if (L.justify === 'center') cursor += free / 2;
  else if (L.justify === 'end') cursor += free;
  else if (L.justify === 'between' && flow.length > 1) gap = L.gap + free / (flow.length - 1);
  for (const kid of flow) {
    const align = kid.selfAlign ?? L.align;
    const crossStart = row ? pt : pl;
    const size = crossOf(kid);
    const offset = align === 'center' ? (innerCross - size) / 2 : align === 'end' ? innerCross - size : 0;
    const main = cursor;
    const cross = crossStart + Math.max(0, offset);
    if (row) { kid.x = round(main); kid.y = round(cross); } else { kid.x = round(cross); kid.y = round(main); }
    cursor += mainOf(kid) + gap;
  }
  // Children whose size changed need their own contents re-flowed.
  for (const kid of flow) if (kid.children?.length || kid.type === 'text') layoutNode(kid);
}

/** Recomputes derived geometry (text size, auto layout). Returns a new design; the input is untouched. */
export function layoutDesign(d: Design): Design {
  const copy = structuredClone(d);
  for (const node of copy.nodes) layoutNode(node);
  return copy;
}

/* ---------- edit operations ---------- */

export interface DesignOp { op: string; [key: string]: unknown }
export interface DesignOpsResult { design: Design; log: string[]; errors: string[] }

function removeFrom(d: Design, id: string): DesignNode | null {
  const list = siblingsOf(d, id);
  const index = list.findIndex((n) => n.id === id);
  if (index < 0) return null;
  return list.splice(index, 1)[0];
}

function reId(node: DesignNode, taken: Set<string>): DesignNode {
  const copy: DesignNode = { ...node, id: uniqueId(taken) };
  if (node.children) copy.children = node.children.map((kid) => reId(kid, taken));
  return copy;
}

const idSet = (d: Design): Set<string> => new Set(allNodes(d).map((n) => n.id));
const isInside = (d: Design, id: string, ancestorId: string): boolean => {
  const ancestor = findNode(d, ancestorId);
  let found = false;
  if (ancestor) walk(ancestor.children ?? [], (n) => { if (n.id === id) found = true; });
  return found;
};

/** Applies operations in order; valid ones are applied, invalid ones reported in `errors`. */
export function applyDesignOps(input: Design, ops: DesignOp[]): DesignOpsResult {
  const d = structuredClone(input);
  const log: string[] = [];
  const errors: string[] = [];
  ops.forEach((op, i) => {
    const where = `op ${i + 1} (${String(op?.op ?? '?')})`;
    try {
      switch (String(op.op)) {
        case 'add': {
          const spec = (op.node ?? op) as Record<string, unknown>;
          const toCanvas = op.parent === undefined || op.parent === null || op.parent === '' || op.parent === 'canvas';
          const parent = toCanvas ? null : findNode(d, op.parent);
          if (!toCanvas && !parent) throw new Error(`no parent "${String(op.parent)}"`);
          if (parent && parent.type !== 'frame') throw new Error(`"${parent.name}" is not a frame`);
          const state: NormalizeState = { taken: idSet(d), counts: {}, warnings: [], total: allNodes(d).length };
          allNodes(d).forEach((n) => { state.counts[n.type] = (state.counts[n.type] ?? 0) + 1; });
          const { op: _drop, parent: _p, index: _i, node: _n, ...rest } = spec as Record<string, unknown>;
          void _drop; void _p; void _i; void _n;
          const node = normalizeNode(op.node ? spec : rest, state, 0, !parent);
          if (!node) throw new Error('could not create the node');
          const list = parent ? (parent.children ??= []) : d.nodes;
          const at = typeof op.index === 'number' ? clamp(Math.round(op.index), 0, list.length) : list.length;
          const placed = typeof (op.node ? spec : rest).x === 'number';
          if (!parent && !placed) node.x = d.nodes.length ? Math.max(...d.nodes.map((n) => n.x + n.w)) + 80 : 0;
          list.splice(at, 0, node);
          log.push(`added ${node.type} ${node.id} "${node.name}"${parent ? ` in ${parent.id}` : ''}`);
          state.warnings.forEach((w) => log.push(`note: ${w}`));
          break;
        }
        case 'update': {
          const node = findNode(d, op.id ?? op.node);
          if (!node) throw new Error(`no node "${String(op.id ?? op.node)}"`);
          const { op: _o, id: _id, node: _n, set, ...flat } = op as Record<string, unknown>;
          void _o; void _id; void _n;
          const patch = { ...flat, ...((set && typeof set === 'object') ? (set as Record<string, unknown>) : {}) };
          if (patch.color !== undefined && patch.fill === undefined && node.type === 'text') patch.fill = patch.color;
          if (patch.content !== undefined && patch.text === undefined) patch.text = patch.content;
          applyNodeFields(node, patch);
          if (node.type === 'text' && (patch.w !== undefined) && patch.autoSize === undefined) node.autoSize = 'h';
          log.push(`updated ${node.id}`);
          break;
        }
        case 'remove': {
          const node = findNode(d, op.id ?? op.node);
          if (!node) throw new Error(`no node "${String(op.id ?? op.node)}"`);
          removeFrom(d, node.id);
          log.push(`removed ${node.id} "${node.name}"`);
          break;
        }
        case 'move': {
          const node = findNode(d, op.id ?? op.node);
          if (!node) throw new Error(`no node "${String(op.id ?? op.node)}"`);
          const toCanvas = op.parent === null || op.parent === 'canvas' || op.parent === '';
          const target = toCanvas ? null : op.parent !== undefined ? findNode(d, op.parent) : parentOf(d, node.id) ?? null;
          if (!toCanvas && op.parent !== undefined && !target) throw new Error(`no parent "${String(op.parent)}"`);
          if (target && (target.id === node.id || isInside(d, target.id, node.id))) throw new Error('cannot move a node into itself');
          if (target && target.type !== 'frame') throw new Error(`"${target.name}" is not a frame`);
          const abs = absolutePosition(d, node.id);
          removeFrom(d, node.id);
          const list = target ? (target.children ??= []) : d.nodes;
          const at = typeof op.index === 'number' ? clamp(Math.round(op.index), 0, list.length) : list.length;
          list.splice(at, 0, node);
          const base = target ? absolutePosition(d, target.id) : { x: 0, y: 0 };
          if (abs && base) { node.x = round(abs.x - base.x); node.y = round(abs.y - base.y); }
          if (typeof op.x === 'number') node.x = op.x;
          if (typeof op.y === 'number') node.y = op.y;
          log.push(`moved ${node.id} to ${target ? target.id : 'canvas'} at ${at}`);
          break;
        }
        case 'duplicate': {
          const node = findNode(d, op.id ?? op.node);
          if (!node) throw new Error(`no node "${String(op.id ?? op.node)}"`);
          const list = siblingsOf(d, node.id);
          const copy = reId(structuredClone(node), idSet(d));
          copy.name = `${node.name} copy`;
          const offset = typeof op.offset === 'number' ? op.offset : 24;
          if (!isAutoLayoutFrame(parentOf(d, node.id) ?? null)) { copy.x += offset; copy.y += offset; }
          list.splice(list.indexOf(node) + 1, 0, copy);
          log.push(`duplicated ${node.id} as ${copy.id}`);
          break;
        }
        case 'wrap': {
          const ids = (Array.isArray(op.ids) ? op.ids : [op.id]).map((ref) => findNode(d, ref)).filter((n): n is DesignNode => !!n);
          if (ids.length === 0) throw new Error('wrap needs ids of existing nodes');
          const parent = parentOf(d, ids[0].id) ?? null;
          const list = parent ? parent.children ?? [] : d.nodes;
          const minX = Math.min(...ids.map((n) => n.x)), minY = Math.min(...ids.map((n) => n.y));
          const maxX = Math.max(...ids.map((n) => n.x + n.w)), maxY = Math.max(...ids.map((n) => n.y + n.h));
          const at = Math.min(...ids.map((n) => list.indexOf(n)).filter((n) => n >= 0));
          const frame: DesignNode = { id: uniqueId(idSet(d)), type: 'frame', name: text(op.name, 80) || 'Group', x: minX, y: minY, w: maxX - minX, h: maxY - minY, fill: null, clip: false, children: [] };
          for (const n of ids) { removeFrom(d, n.id); n.x -= minX; n.y -= minY; frame.children!.push(n); }
          if (op.layout) applyNodeFields(frame, { layout: op.layout });
          list.splice(Math.min(at, list.length), 0, frame);
          log.push(`wrapped ${ids.length} node(s) in ${frame.id}`);
          break;
        }
        case 'set_tokens': {
          const colors = (op.colors ?? {}) as Record<string, unknown>;
          let count = 0;
          for (const [name, value] of Object.entries(colors)) {
            const key = name.replace(/[^\w-]+/g, '-').slice(0, 40);
            if (!key) continue;
            if (value === null) delete d.tokens.colors[key]; else if (typeof value === 'string') d.tokens.colors[key] = text(value, 60);
            count += 1;
          }
          log.push(`updated ${count} colour token(s)`);
          break;
        }
        case 'set_meta': {
          if (op.title !== undefined) d.title = text(op.title, 120);
          log.push('updated title');
          break;
        }
        default:
          throw new Error('unknown op — use add, update, remove, move, duplicate, wrap, set_tokens or set_meta');
      }
    } catch (error) {
      errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { design: layoutDesign(d), log, errors };
}

/* ---------- colours ---------- */

export function resolveColor(color: string | undefined | null, tokens: Design['tokens']): string {
  if (!color) return 'none';
  if (color.startsWith('$')) return tokens.colors[color.slice(1)] ?? '#999999';
  return color;
}

type Rgba = [number, number, number, number];

export function parseColor(value: string | undefined | null): Rgba | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'white') return [255, 255, 255, 1];
  if (v === 'black') return [0, 0, 0, 1];
  if (v === 'transparent' || v === 'none') return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('').map((c) => parseInt(c + c, 16));
      return [r, g, b, h.length === 4 ? a / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    return null;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), a];
  }
  return null;
}

function luminance(c: Rgba): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const composite = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top[3] + bottom[3] * (1 - top[3]);
  if (a === 0) return [255, 255, 255, 1];
  return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat([a]) as Rgba;
};

const solidOf = (fill: Fill | undefined, tokens: Design['tokens']): Rgba | null => {
  if (fill === undefined || fill === null) return null;
  return parseColor(isGradient(fill) ? resolveColor(fill.from, tokens) : resolveColor(fill, tokens));
};

/** Colour behind a node: nearest ancestor fills composited over white. */
export function backgroundBehind(d: Design, id: string): Rgba {
  const chain: DesignNode[] = [];
  let current = parentOf(d, id);
  while (current) { chain.push(current); current = parentOf(d, current.id); }
  let bg: Rgba = [255, 255, 255, 1];
  for (const frame of chain.reverse()) {
    const solid = solidOf(frame.fill, d.tokens);
    if (solid && solid[3] > 0) bg = composite(solid, bg);
  }
  return bg;
}

/* ---------- review checks ---------- */

export interface DesignIssue { severity: 'error' | 'warn' | 'info'; id: string; message: string }

const INTERACTIVE_NAME = /\b(button|btn|cta|link|tab|toggle|switch|checkbox|radio|input|field|select|dropdown|icon[- ]?button|fab)\b/i;

/** UX/UI review: contrast, text size, touch targets, overflow, spacing grid, naming. */
export function checkDesign(d: Design): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const add = (severity: DesignIssue['severity'], node: DesignNode, message: string) => issues.push({ severity, id: node.id, message: `${node.name} (${node.id}): ${message}` });
  walk(d.nodes, (node, parent) => {
    if (node.visible === false) return;
    if (node.type === 'text') {
      const size = node.fontSize ?? 16;
      if (!(node.text ?? '').trim()) add('warn', node, 'empty text');
      if (size < 11) add('error', node, `text is ${size}px — too small to read (minimum 11px, body text 14–16px)`);
      else if (size < 12) add('warn', node, `text is ${size}px — small`);
      const fg = solidOf(node.fill ?? '#111111', d.tokens);
      if (fg) {
        const bg = backgroundBehind(d, node.id);
        const ratio = contrastRatio(composite(fg, bg), bg);
        const large = size >= 24 || (size >= 18.66 && (node.fontWeight ?? 400) >= 700);
        const need = large ? 3 : 4.5;
        if (ratio < need) add(ratio < 3 ? 'error' : 'warn', node, `contrast ${ratio.toFixed(2)}:1 is below ${need}:1 (WCAG AA)`);
      }
    }
    if (INTERACTIVE_NAME.test(node.name) && node.type !== 'text') {
      let root: DesignNode | null = parent;
      while (root && parentOf(d, root.id)) root = parentOf(d, root.id) ?? null;
      const topWidth = (root ?? node).w;
      const min = topWidth <= 480 ? 44 : 32;
      if (Math.min(node.w, node.h) < min) add('warn', node, `touch/click target ${Math.round(node.w)}×${Math.round(node.h)} is below ${min}px`);
    }
    if (parent && parent.type === 'frame' && parent.clip !== false && !isAutoLayoutFrame(parent) && node.type !== 'line') {
      if (node.x < -0.5 || node.y < -0.5 || node.x + node.w > parent.w + 0.5 || node.y + node.h > parent.h + 0.5) {
        add('warn', node, `extends outside its frame "${parent.name}" and will be clipped`);
      }
    }
    if (node.layout) {
      const values = [node.layout.gap, ...node.layout.padding];
      if (values.some((v) => v % 4 !== 0)) add('info', node, `spacing (${values.join('/')}) is off the 4px grid`);
    }
    if (node.type !== 'frame' && node.type !== 'text' && /^(Rectangle|Ellipse|Line|Image) \d+$/.test(node.name) && node.children === undefined) {
      add('info', node, 'has a default name — name layers by purpose (e.g. "Avatar", "Divider")');
    }
  });
  const names = new Map<string, number>();
  for (const frame of d.nodes) names.set(frame.name, (names.get(frame.name) ?? 0) + 1);
  for (const [name, count] of names) if (count > 1) issues.push({ severity: 'info', id: '', message: `${count} top-level frames are named "${name}"` });
  const order = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ---------- summaries ---------- */

export function summarizeDesign(d: Design, rootId?: string, maxLines = 220): string {
  const lines: string[] = [];
  const root = rootId ? findNode(d, rootId) : undefined;
  const colors = Object.entries(d.tokens.colors);
  lines.push(`"${d.title}" — ${d.nodes.length} top-level node(s), ${allNodes(d).length} total${colors.length ? `; tokens: ${colors.map(([k, v]) => `$${k}=${v}`).join(', ')}` : ''}`);
  const fillText = (fill: Fill | undefined) => (fill === undefined ? '' : fill === null ? ' fill none' : isGradient(fill) ? ` fill gradient(${fill.from}→${fill.to})` : ` fill ${fill}`);
  const describe = (node: DesignNode): string => {
    const base = `[${node.type}] "${node.name}" ${Math.round(node.w)}×${Math.round(node.h)} @${Math.round(node.x)},${Math.round(node.y)}`;
    const layout = node.layout ? ` layout ${node.layout.dir} gap ${node.layout.gap} pad ${node.layout.padding.join('/')} ${node.layout.justify}/${node.layout.align}${node.layout.hugW ? ' hugW' : ''}${node.layout.hugH ? ' hugH' : ''}` : '';
    const textInfo = node.type === 'text' ? ` ${node.fontSize ?? 16}px/${node.fontWeight ?? 400} "${(node.text ?? '').replace(/\n/g, '⏎').slice(0, 60)}"` : '';
    const extra = `${node.grow ? ` grow ${node.grow}` : ''}${node.radius ? ` r${Array.isArray(node.radius) ? node.radius.join('/') : node.radius}` : ''}${node.stroke ? ` stroke ${node.stroke}` : ''}${node.visible === false ? ' hidden' : ''}${node.locked ? ' locked' : ''}`;
    return `${base}${layout}${textInfo}${fillText(node.fill)}${extra}`;
  };
  const emit = (nodes: DesignNode[], depth: number) => {
    for (const node of nodes) {
      if (lines.length >= maxLines) return;
      lines.push(`${'  '.repeat(depth)}- ${node.id} ${describe(node)}`);
      if (node.children) emit(node.children, depth + 1);
    }
  };
  emit(root ? [root] : d.nodes, 0);
  if (lines.length >= maxLines) lines.push(`… (outline truncated at ${maxLines} lines — read a subtree with node: "<id>")`);
  return lines.join('\n');
}

/* ---------- SVG rendering ---------- */

export const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DesignRenderOptions {
  selected?: string[];
  /** Adds data-id hooks used by the editor's hit testing. */
  interactive?: boolean;
  /** Node whose text is hidden because an inline editor covers it. */
  editingId?: string | null;
  /** Label frames with their name above them (editor). */
  frameLabels?: boolean;
  /** Colour used for frame labels. */
  labelColor?: string;
}

const cornerPath = (w: number, h: number, r: [number, number, number, number]): string => {
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, w / 2, h / 2)) as [number, number, number, number];
  return `M ${tl} 0 H ${w - tr} A ${tr} ${tr} 0 0 1 ${w} ${tr} V ${h - br} A ${br} ${br} 0 0 1 ${w - br} ${h} H ${bl} A ${bl} ${bl} 0 0 1 0 ${h - bl} V ${tl} A ${tl} ${tl} 0 0 1 ${tl} 0 Z`;
};

function gradientDef(id: string, g: Gradient, tokens: Design['tokens']): string {
  const rad = ((g.angle - 90) * Math.PI) / 180;
  const x = Math.cos(rad) / 2, y = Math.sin(rad) / 2;
  return `<linearGradient id="grad-${id}" x1="${0.5 - x}" y1="${0.5 - y}" x2="${0.5 + x}" y2="${0.5 + y}"><stop offset="0" stop-color="${escapeXml(resolveColor(g.from, tokens))}"/><stop offset="1" stop-color="${escapeXml(resolveColor(g.to, tokens))}"/></linearGradient>`;
}

function renderNode(node: DesignNode, tokens: Design['tokens'], o: DesignRenderOptions, depth: number): string {
  if (node.visible === false) return '';
  const id = node.id.replace(/[^\w-]/g, '_');
  const defs: string[] = [];
  let fill = 'none';
  if (isGradient(node.fill)) { defs.push(gradientDef(id, node.fill, tokens)); fill = `url(#grad-${id})`; }
  else if (node.fill !== undefined && node.fill !== null) fill = escapeXml(resolveColor(node.fill, tokens));
  const stroke = node.stroke ? escapeXml(resolveColor(node.stroke, tokens)) : 'none';
  const sw = node.stroke ? node.strokeWidth ?? 1 : 0;
  if (node.shadow) {
    const s = node.shadow;
    defs.push(`<filter id="shadow-${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${s.x}" dy="${s.y}" stdDeviation="${s.blur / 2}" flood-color="${escapeXml(resolveColor(s.color, tokens))}"/></filter>`);
  }
  const attrs = [
    `transform="translate(${node.x} ${node.y})"`,
    o.interactive ? `data-id="${escapeXml(node.id)}"` : '',
    node.opacity !== undefined ? `opacity="${node.opacity}"` : '',
    node.shadow ? `filter="url(#shadow-${id})"` : '',
    node.locked && o.interactive ? 'data-locked="1"' : '',
  ].filter(Boolean).join(' ');
  const paint = `style="fill:${fill};stroke:${stroke};stroke-width:${sw}"`;
  const r = node.radius ?? 0;
  const rectShape = (): string => {
    if (Array.isArray(r)) return `<path d="${cornerPath(node.w, node.h, r)}" ${paint}/>`;
    return `<rect width="${node.w}" height="${node.h}" rx="${Math.min(r, node.w / 2, node.h / 2)}" ${paint}/>`;
  };
  let body = '';
  switch (node.type) {
    case 'frame': {
      body = rectShape();
      const kids = (node.children ?? []).map((kid) => renderNode(kid, tokens, o, depth + 1)).join('');
      if (kids) {
        if (node.clip !== false) {
          const clip = Array.isArray(r) ? `<path d="${cornerPath(node.w, node.h, r)}"/>` : `<rect width="${node.w}" height="${node.h}" rx="${Math.min(r, node.w / 2, node.h / 2)}"/>`;
          defs.push(`<clipPath id="clip-${id}">${clip}</clipPath>`);
          body += `<g clip-path="url(#clip-${id})">${kids}</g>`;
        } else body += kids;
      }
      break;
    }
    case 'rect': body = rectShape(); break;
    case 'ellipse': body = `<ellipse cx="${node.w / 2}" cy="${node.h / 2}" rx="${node.w / 2}" ry="${node.h / 2}" ${paint}/>`; break;
    case 'line':
      body = (o.interactive ? `<line x1="0" y1="0" x2="${node.w}" y2="${node.h}" style="stroke:transparent;stroke-width:12;fill:none"/>` : '')
        + `<line x1="0" y1="0" x2="${node.w}" y2="${node.h}" style="stroke:${stroke === 'none' ? '#333' : stroke};stroke-width:${node.strokeWidth ?? 1};fill:none" stroke-linecap="round"/>`;
      break;
    case 'image':
      body = (node.src
        ? `<image href="${escapeXml(node.src)}" width="${node.w}" height="${node.h}" preserveAspectRatio="xMidYMid slice"/>`
        : `<rect width="${node.w}" height="${node.h}" style="fill:#e4e6ec;stroke:#b7bccb;stroke-width:1"/><path d="M0 0 L${node.w} ${node.h} M${node.w} 0 L0 ${node.h}" style="stroke:#b7bccb;stroke-width:1"/>`);
      break;
    case 'text': {
      if (o.editingId === node.id) { body = `<rect width="${node.w}" height="${node.h}" style="fill:transparent"/>`; break; }
      const size = node.fontSize ?? 16;
      const m = nodeMetrics(node, node.autoSize === 'w' ? null : node.w);
      const align = node.textAlign ?? 'left';
      const anchorX = align === 'center' ? node.w / 2 : align === 'right' ? node.w : 0;
      const color = node.fill === null || node.fill === undefined ? '#111111' : isGradient(node.fill) ? node.fill.from : node.fill;
      body = `<rect width="${node.w}" height="${Math.max(node.h, m.height)}" style="fill:transparent"/>`
        + `<text text-anchor="${align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'}" font-family="${escapeXml(FONT_STACKS[node.fontFamily ?? 'sans'])}" font-size="${size}" font-weight="${node.fontWeight ?? 400}" style="fill:${escapeXml(resolveColor(color, tokens))};stroke:none">`
        + m.lines.map((line, i) => `<tspan x="${anchorX}" y="${round(i * m.lineHeightPx + (m.lineHeightPx + size * 0.7) / 2)}" xml:space="preserve">${escapeXml(line)}</tspan>`).join('')
        + '</text>';
      break;
    }
  }
  const label = o.frameLabels && depth === 0
    ? `<text y="-8" font-size="12" style="fill:${o.labelColor ?? '#888'};stroke:none;pointer-events:none" font-family="${escapeXml(FONT_STACKS.sans)}">${escapeXml(node.name)}</text>` : '';
  return `<g ${attrs}>${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${body}${label}</g>`;
}

export function renderDesignContent(d: Design, options: DesignRenderOptions = {}): string {
  return d.nodes.map((node) => renderNode(node, d.tokens, options, 0)).join('');
}

/** A standalone SVG of the whole canvas or of one node (cropped to it). */
export function renderDesignSvg(d: Design, options: { nodeId?: string; background?: string | null; padding?: number } = {}): string {
  const target = options.nodeId ? findNode(d, options.nodeId) : undefined;
  let box: { x: number; y: number; w: number; h: number };
  let content: string;
  if (target) {
    const abs = absoluteBox(d, target.id) ?? { x: 0, y: 0, w: target.w, h: target.h };
    box = abs;
    const clone: Design = { ...d, nodes: [{ ...structuredClone(target), x: 0, y: 0 }] };
    content = renderDesignContent(clone);
  } else {
    const nodes = d.nodes.filter((n) => n.visible !== false);
    if (nodes.length === 0) box = { x: 0, y: 0, w: 400, h: 300 };
    else {
      const x1 = Math.min(...nodes.map((n) => n.x)), y1 = Math.min(...nodes.map((n) => n.y));
      box = { x: x1, y: y1, w: Math.max(...nodes.map((n) => n.x + n.w)) - x1, h: Math.max(...nodes.map((n) => n.y + n.h)) - y1 };
    }
    content = renderDesignContent(d);
  }
  const pad = target ? options.padding ?? 0 : options.padding ?? 40;
  const vx = target ? -pad : box.x - pad, vy = target ? -pad : box.y - pad;
  const w = Math.ceil(box.w + pad * 2), h = Math.ceil(box.h + pad * 2);
  const bg = options.background === undefined ? '#ffffff' : options.background;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${w} ${h}" width="${w}" height="${h}">`
    + `<title>${escapeXml(d.title)}</title>`
    + (bg ? `<rect x="${vx}" y="${vy}" width="${w}" height="${h}" style="fill:${bg}"/>` : '')
    + content + '</svg>';
}

/* ---------- HTML / CSS export ---------- */

const cssColor = (c: Fill | undefined, tokens: Design['tokens'], usedTokens: Set<string>): string => {
  if (c === undefined || c === null) return 'transparent';
  if (isGradient(c)) return `linear-gradient(${c.angle}deg, ${cssColor(c.from, tokens, usedTokens)}, ${cssColor(c.to, tokens, usedTokens)})`;
  if (c.startsWith('$')) { const name = c.slice(1); if (tokens.colors[name]) { usedTokens.add(name); return `var(--${name})`; } return '#999'; }
  return c;
};

function htmlNode(node: DesignNode, parent: DesignNode | null, tokens: Design['tokens'], used: Set<string>, indent: number): string {
  if (node.visible === false) return '';
  const pad = '  '.repeat(indent);
  const inFlow = isAutoLayoutFrame(parent);
  const css: string[] = [];
  if (!inFlow) css.push('position:absolute', `left:${node.x}px`, `top:${node.y}px`);
  else css.push('position:relative', 'flex-shrink:0');
  css.push(node.grow && inFlow ? `flex:${node.grow} 1 0` : `width:${round(node.w)}px`);
  if (node.type !== 'text' || node.autoSize === 'none') css.push(`height:${round(node.h)}px`);
  if (inFlow && parent?.layout && (node.selfAlign ?? parent.layout.align) === 'stretch') css.push('align-self:stretch');
  if (node.opacity !== undefined) css.push(`opacity:${node.opacity}`);
  if (node.shadow) css.push(`box-shadow:${node.shadow.x}px ${node.shadow.y}px ${node.shadow.blur}px ${cssColor(node.shadow.color, tokens, used)}`);
  if (node.radius) css.push(`border-radius:${Array.isArray(node.radius) ? node.radius.map((v) => `${v}px`).join(' ') : `${node.radius}px`}`);
  if (node.stroke) css.push(`border:${node.strokeWidth ?? 1}px solid ${cssColor(node.stroke, tokens, used)}`, 'box-sizing:border-box');
  const tag = 'div';
  if (node.type === 'text') {
    css.push(`color:${cssColor(node.fill ?? '#111', tokens, used)}`, `font-size:${node.fontSize ?? 16}px`, `font-weight:${node.fontWeight ?? 400}`,
      `font-family:${FONT_STACKS[node.fontFamily ?? 'sans']}`, `line-height:${node.lineHeight ?? 1.3}`, `text-align:${node.textAlign ?? 'left'}`, 'margin:0');
    if (node.autoSize === 'w') css.push('white-space:pre');
    const content = escapeXml(node.text ?? '').replace(/\n/g, '<br>');
    return `${pad}<${tag} style="${css.join(';')}">${content}</${tag}>`;
  }
  if (node.type === 'image') {
    return `${pad}<img alt="${escapeXml(node.name)}" src="${escapeXml(node.src ?? '')}" style="${css.join(';')};object-fit:cover">`;
  }
  if (node.type === 'ellipse') css.push('border-radius:50%');
  if (node.type === 'line') {
    css.push(`border-top:${node.strokeWidth ?? 1}px solid ${cssColor(node.stroke ?? '#333', tokens, used)}`, 'height:0');
  } else if (node.fill !== undefined) css.push(`background:${cssColor(node.fill, tokens, used)}`);
  if (node.type === 'frame') {
    if (node.clip !== false) css.push('overflow:hidden');
    if (node.layout) {
      const L = node.layout;
      css.push('display:flex', `flex-direction:${L.dir}`, `gap:${L.gap}px`, `padding:${L.padding.map((v) => `${v}px`).join(' ')}`, 'box-sizing:border-box',
        `justify-content:${L.justify === 'between' ? 'space-between' : L.justify === 'start' ? 'flex-start' : L.justify === 'end' ? 'flex-end' : 'center'}`,
        `align-items:${L.align === 'stretch' ? 'stretch' : L.align === 'start' ? 'flex-start' : L.align === 'end' ? 'flex-end' : 'center'}`);
    }
  }
  const kids = (node.children ?? []).map((kid) => htmlNode(kid, node, tokens, used, indent + 1)).filter(Boolean);
  const inner = kids.length ? `\n${kids.join('\n')}\n${pad}` : '';
  return `${pad}<${tag} data-name="${escapeXml(node.name)}" style="${css.join(';')}">${inner}</${tag}>`;
}

/** Static HTML + CSS for one top-level frame (or all of them), for developer hand-off. */
export function renderDesignHtml(d: Design, nodeId?: string): string {
  const roots = nodeId ? [findNode(d, nodeId)].filter((n): n is DesignNode => !!n) : d.nodes;
  const used = new Set<string>();
  const body = roots.map((root) => htmlNode({ ...root, x: 0, y: 0 }, null, d.tokens, used, 2).replace('position:absolute', 'position:relative')).join('\n');
  const vars = [...used].map((name) => `      --${name}: ${d.tokens.colors[name]};`).join('\n');
  return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${escapeXml(d.title)}</title>\n  <style>\n    :root {\n${vars}\n    }\n    body { margin: 0; background: #f0f1f5; display: flex; gap: 40px; padding: 40px; align-items: flex-start; }\n  </style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/* ---------- starter templates ---------- */

export type TemplateKind = 'blank' | 'mobile' | 'desktop' | 'components';

export function templateDesign(kind: TemplateKind, title: string): Design {
  const colors = { primary: '#4f46e5', 'primary-dark': '#3730a3', surface: '#ffffff', background: '#f5f6fa', text: '#111827', muted: '#6b7280', border: '#e5e7eb', success: '#16a34a' };
  const raw: Record<string, unknown> = { title, tokens: { colors }, nodes: [] };
  const button = (label: string, fill = '$primary', color = '#ffffff') => ({
    type: 'frame', name: `${label} button`, w: 120, h: 48, radius: 12, fill, layout: { dir: 'row', justify: 'center', align: 'center', padding: [0, 20, 0, 20], hugW: true },
    children: [{ type: 'text', name: 'Label', text: label, fontSize: 16, fontWeight: 600, fill: color }],
  });
  if (kind === 'mobile') {
    raw.nodes = [{
      type: 'frame', name: 'Mobile — Home', w: 390, h: 844, fill: '$background', layout: { dir: 'column', gap: 16, padding: [56, 20, 24, 20], align: 'stretch' },
      children: [
        { type: 'text', name: 'Greeting', text: 'Good morning', fontSize: 14, fill: '$muted' },
        { type: 'text', name: 'Title', text: 'Your day at a glance', fontSize: 28, fontWeight: 700, fill: '$text', w: 350 },
        {
          type: 'frame', name: 'Summary card', h: 140, radius: 20, fill: { from: '$primary', to: '$primary-dark', angle: 135 }, shadow: { y: 8, blur: 24, color: 'rgba(79,70,229,0.35)' },
          layout: { dir: 'column', gap: 8, padding: [20, 20, 20, 20], justify: 'end' },
          children: [{ type: 'text', name: 'Card label', text: 'Tasks done', fontSize: 14, fill: '#e0e7ff' }, { type: 'text', name: 'Card value', text: '12 of 18', fontSize: 32, fontWeight: 700, fill: '#ffffff' }],
        },
        ...[1, 2, 3].map((n) => ({
          type: 'frame', name: `List item ${n}`, h: 64, radius: 14, fill: '$surface', stroke: '$border', layout: { dir: 'row', gap: 12, padding: [0, 16, 0, 16], align: 'center' },
          children: [{ type: 'ellipse', name: 'Avatar', w: 36, h: 36, fill: '$border' }, { type: 'text', name: 'Item title', text: `Task number ${n}`, fontSize: 16, fontWeight: 500, fill: '$text', grow: 1 }],
        })),
        { ...button('Add task'), w: 350, layout: { dir: 'row', justify: 'center', align: 'center', padding: [0, 20, 0, 20] } },
      ],
    }];
  } else if (kind === 'desktop') {
    raw.nodes = [{
      type: 'frame', name: 'Desktop — Dashboard', w: 1440, h: 900, fill: '$background', layout: { dir: 'row' },
      children: [
        {
          type: 'frame', name: 'Sidebar', w: 240, fill: '$surface', stroke: '$border', layout: { dir: 'column', gap: 8, padding: [24, 16, 24, 16], align: 'stretch' }, selfAlign: 'stretch',
          children: [{ type: 'text', name: 'Logo', text: 'Acme', fontSize: 20, fontWeight: 700, fill: '$primary' }, ...['Overview', 'Reports', 'Settings'].map((label) => ({ type: 'text', name: `Nav ${label}`, text: label, fontSize: 15, fill: '$text' }))],
        },
        {
          type: 'frame', name: 'Content', grow: 1, selfAlign: 'stretch', layout: { dir: 'column', gap: 24, padding: [32, 32, 32, 32], align: 'stretch' },
          children: [
            { type: 'text', name: 'Page title', text: 'Overview', fontSize: 32, fontWeight: 700, fill: '$text' },
            {
              type: 'frame', name: 'Stat row', h: 120, layout: { dir: 'row', gap: 24, align: 'stretch' },
              children: [1, 2, 3].map((n) => ({
                type: 'frame', name: `Stat card ${n}`, grow: 1, radius: 16, fill: '$surface', stroke: '$border', layout: { dir: 'column', gap: 6, padding: [20, 20, 20, 20], justify: 'center' },
                children: [{ type: 'text', name: 'Stat label', text: `Metric ${n}`, fontSize: 14, fill: '$muted' }, { type: 'text', name: 'Stat value', text: `${n * 1284}`, fontSize: 30, fontWeight: 700, fill: '$text' }],
              })),
            },
            { type: 'frame', name: 'Chart placeholder', grow: 1, radius: 16, fill: '$surface', stroke: '$border' },
          ],
        },
      ],
    }];
  } else if (kind === 'components') {
    raw.nodes = [{
      type: 'frame', name: 'Components', w: 520, h: 320, fill: '$surface', layout: { dir: 'column', gap: 24, padding: [32, 32, 32, 32], hugH: true },
      children: [
        { type: 'text', name: 'Section title', text: 'Buttons', fontSize: 14, fontWeight: 600, fill: '$muted' },
        { type: 'frame', name: 'Button row', layout: { dir: 'row', gap: 12, hugW: true, hugH: true }, children: [button('Primary'), button('Secondary', '$background', '#111827')] },
        { type: 'text', name: 'Input title', text: 'Input', fontSize: 14, fontWeight: 600, fill: '$muted' },
        { type: 'frame', name: 'Text input', w: 320, h: 48, radius: 10, fill: '$surface', stroke: '$border', layout: { dir: 'row', padding: [0, 14, 0, 14], align: 'center' }, children: [{ type: 'text', name: 'Placeholder', text: 'Email address', fontSize: 15, fill: '$muted' }] },
      ],
    }];
  } else {
    raw.nodes = [{ type: 'frame', name: 'Frame 1', w: 1440, h: 900, fill: '#ffffff' }];
  }
  return normalizeDesign(raw, title).design;
}
