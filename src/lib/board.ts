/** Board document model for the Board editor (a FigJam-style whiteboard) and the
 * agent's board tools: sticky notes, free text, shapes, connectors, sections,
 * freehand pen strokes and emoji stamps — with normalization, edit operations,
 * automatic placement, review checks, Markdown/SVG export and a dependency-free
 * SVG renderer (the editor draws with the same renderer it exports with).
 * Pure functions — no DOM, no Tauri — so everything is unit-testable in Node. */

import { CODE_CHAR, CODE_ROW, codeHeaderSvg, codeKey, codePalette, commitBodySvg, describeCode, normalizeCodeRef, type CodeKind, type CodeRef, type CodeSnapshot, type CodeTheme } from './codeSnap.ts';
export type { CodeRef, CodeSnapshot } from './codeSnap.ts';

export type ItemType = 'sticky' | 'text' | 'shape' | 'connector' | 'section' | 'pen' | 'stamp' | 'embed' | 'code';
export type EmbedKind = 'diagram' | 'design';
/** A diagram or design shown on the board; the content itself stays in its own file. */
export interface EmbedRef { kind: EmbedKind; /** "owner/name" of the diagram or design file */ ref: string; /** Design only: a top-level frame (id or name); empty = the whole canvas */ node?: string }
export type ShapeKind = 'rect' | 'round' | 'ellipse' | 'diamond' | 'triangle';
export type BoardColor = 'yellow' | 'orange' | 'pink' | 'red' | 'green' | 'teal' | 'blue' | 'purple' | 'gray' | 'white';
export type Route = 'straight' | 'elbow' | 'curve';
export type ArrowStyle = 'end' | 'both' | 'none';

export interface BoardItem {
  id: string;
  type: ItemType;
  x: number; y: number; w: number; h: number;
  /** Sticky / text / shape content, section title, connector label. */
  text?: string;
  color?: BoardColor;
  shape?: ShapeKind;
  fontSize?: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Section this item sits in (moves with it). */
  parent?: string;
  /** Who made it (agent username or "user") — shown small on stickies. */
  author?: string;
  /** Names of the people (or agents) who voted. */
  votes?: string[];
  locked?: boolean;
  /* connector */
  from?: string; to?: string;
  fromPoint?: [number, number]; toPoint?: [number, number];
  arrow?: ArrowStyle; dashed?: boolean; route?: Route;
  /* pen: points relative to x,y */
  points?: Array<[number, number]>;
  width?: number;
  /* stamp */
  emoji?: string;
  /* embed: a diagram or design from its own editor */
  embed?: EmbedRef;
  /* code: lines of a file, a compare of two refs, or a commit (loaded live from the repository) */
  code?: CodeRef;
}

export interface Board { version: 1; title: string; items: BoardItem[] }

export const ITEM_TYPES: ItemType[] = ['sticky', 'text', 'shape', 'connector', 'section', 'pen', 'stamp', 'embed', 'code'];
export const BOARD_COLORS: BoardColor[] = ['yellow', 'orange', 'pink', 'red', 'green', 'teal', 'blue', 'purple', 'gray', 'white'];
export const SHAPE_KINDS: ShapeKind[] = ['rect', 'round', 'ellipse', 'diamond', 'triangle'];
export const STAMPS = ['👍', '❤️', '⭐', '🔥', '❓', '✅'];
export const MAX_ITEMS = 1500;

export const BOARDS_DIR = '.pigry/boards/';
export const BOARD_EXT = '.board.json';

export const COLOR_STYLES: Record<BoardColor, { fill: string; stroke: string }> = {
  yellow: { fill: '#ffe27a', stroke: '#d9b72f' },
  orange: { fill: '#ffb86b', stroke: '#d98a2e' },
  pink: { fill: '#ffa8d1', stroke: '#d9669f' },
  red: { fill: '#ff8f8f', stroke: '#d95a5a' },
  green: { fill: '#a6e3a1', stroke: '#5fb85a' },
  teal: { fill: '#8fe3d6', stroke: '#45b3a4' },
  blue: { fill: '#9ec8ff', stroke: '#5a93de' },
  purple: { fill: '#c9b3ff', stroke: '#8f70d9' },
  gray: { fill: '#d9dce3', stroke: '#9aa0ad' },
  white: { fill: '#ffffff', stroke: '#b9bfcc' },
};

const COLOR_ALIASES: Record<string, BoardColor> = { grey: 'gray', violet: 'purple', cyan: 'teal', lime: 'green', amber: 'orange', gold: 'yellow' };
const TYPE_ALIASES: Record<string, ItemType> = {
  note: 'sticky', postit: 'sticky', 'post-it': 'sticky', card: 'sticky', idea: 'sticky',
  box: 'shape', rectangle: 'shape', rect: 'shape', circle: 'shape', ellipse: 'shape', diamond: 'shape',
  arrow: 'connector', link: 'connector', line: 'connector', edge: 'connector',
  group: 'section', column: 'section', lane: 'section', frame: 'section', area: 'section',
  label: 'text', title: 'text', heading: 'text', emoji: 'stamp', reaction: 'stamp', drawing: 'pen', stroke: 'pen',
  diagram: 'embed', design: 'embed', mockup: 'embed', screen: 'embed',
  code: 'code', snippet: 'code', file: 'code', compare: 'code', diff: 'code', commit: 'code',
};

/* ---------- helpers ---------- */

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const clip = (value: unknown, max = 600): string => String(value ?? '').slice(0, max);
const round = (value: number): number => Math.round(value * 10) / 10;

export const isConnector = (item: BoardItem): boolean => item.type === 'connector';
export const colorOf = (item: BoardItem): { fill: string; stroke: string } => COLOR_STYLES[item.color ?? (item.type === 'section' ? 'gray' : item.type === 'shape' ? 'white' : 'yellow')];

export function defaultSize(type: ItemType, shape?: ShapeKind): { w: number; h: number } {
  switch (type) {
    case 'sticky': return { w: 180, h: 180 };
    case 'text': return { w: 160, h: 28 };
    case 'shape': return shape === 'diamond' ? { w: 170, h: 130 } : shape === 'ellipse' ? { w: 170, h: 110 } : shape === 'triangle' ? { w: 140, h: 120 } : { w: 170, h: 100 };
    case 'section': return { w: 440, h: 320 };
    case 'stamp': return { w: 56, h: 56 };
    case 'embed': return { w: 380, h: 280 };
    case 'code': return { w: 520, h: 260 };
    default: return { w: 0, h: 0 };
  }
}

export interface TextMetrics { lines: string[]; width: number; height: number; lineHeightPx: number }

/** Approximate, font-independent text layout — identical for the editor and the exports. */
export function measureText(content: string, fontSize: number, bold: boolean, maxWidth: number | null): TextMetrics {
  const charW = fontSize * 0.56 * (bold ? 1.07 : 1);
  const lineHeightPx = fontSize * 1.3;
  const maxChars = maxWidth === null ? Infinity : Math.max(1, Math.floor(maxWidth / charW));
  const lines: string[] = [];
  for (const paragraph of content.split('\n')) {
    if (maxChars === Infinity) { lines.push(paragraph); continue; }
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let piece = word;
      while (piece.length > maxChars) {
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
  return { lines, width: Math.max(...lines.map((l) => l.length), 0) * charW, height: lines.length * lineHeightPx, lineHeightPx };
}

export function allIds(b: Board): Set<string> { return new Set(b.items.map((i) => i.id)); }

function freshId(taken: Set<string>, prefix = 'i'): string {
  let n = taken.size + 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  const id = `${prefix}${n}`;
  taken.add(id);
  return id;
}

/** Finds an item by id, or by its text when exactly one item has it. */
export function findItem(b: Board, ref: unknown): BoardItem | undefined {
  const key = String(ref ?? '').trim();
  if (!key) return undefined;
  const byId = b.items.find((i) => i.id === key);
  if (byId) return byId;
  const byText = b.items.filter((i) => i.type !== 'connector' && (i.text ?? '').trim().toLowerCase() === key.toLowerCase());
  return byText.length === 1 ? byText[0] : undefined;
}

export const childrenOf = (b: Board, sectionId: string): BoardItem[] => b.items.filter((i) => i.parent === sectionId);

/** Bounding box of the item (connectors: the span of their endpoints). */
export function boxOf(b: Board, item: BoardItem): { x: number; y: number; w: number; h: number } {
  if (item.type === 'connector') {
    const g = connectorGeometry(b, item);
    if (!g) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = g.points.map((p) => p[0]), ys = g.points.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}

export function boundsOf(b: Board, ids?: string[]): { x: number; y: number; w: number; h: number } | null {
  const items = b.items.filter((i) => !ids || ids.includes(i.id)).filter((i) => i.type !== 'connector');
  if (items.length === 0) return null;
  const x = Math.min(...items.map((i) => i.x)), y = Math.min(...items.map((i) => i.y));
  return { x, y, w: Math.max(...items.map((i) => i.x + i.w)) - x, h: Math.max(...items.map((i) => i.y + i.h)) - y };
}

/* ---------- normalization ---------- */

export interface NormalizeResult { board: Board; warnings: string[] }

const parseColor = (value: unknown): BoardColor | undefined => {
  const v = String(value ?? '').toLowerCase().trim();
  if (BOARD_COLORS.includes(v as BoardColor)) return v as BoardColor;
  return COLOR_ALIASES[v];
};

/** Applies the editable fields of `raw` onto `item` (shared by normalize and update ops). */
export function applyItemFields(item: BoardItem, raw: Record<string, unknown>): void {
  const text = raw.text ?? raw.content ?? raw.title ?? raw.label;
  if (text !== undefined) item.text = clip(text, item.type === 'section' ? 120 : 800);
  if (raw.x !== undefined) item.x = round(num(raw.x, item.x));
  if (raw.y !== undefined) item.y = round(num(raw.y, item.y));
  if (raw.w !== undefined && item.type !== 'connector') item.w = Math.max(24, round(num(raw.w, item.w)));
  if (raw.h !== undefined && item.type !== 'connector') item.h = Math.max(item.type === 'text' ? 12 : 24, round(num(raw.h, item.h)));
  if (raw.color !== undefined) { const c = parseColor(raw.color); if (c) item.color = c; }
  if (raw.shape !== undefined && SHAPE_KINDS.includes(raw.shape as ShapeKind)) item.shape = raw.shape as ShapeKind;
  if (raw.fontSize !== undefined) item.fontSize = clamp(num(raw.fontSize, 16), 8, 96);
  if (raw.bold !== undefined) item.bold = raw.bold === true ? true : undefined;
  if (raw.align !== undefined) item.align = ['left', 'center', 'right'].includes(raw.align as string) ? (raw.align as BoardItem['align']) : undefined;
  if (raw.author !== undefined) item.author = raw.author ? clip(raw.author, 40) : undefined;
  if (raw.locked !== undefined) item.locked = raw.locked === true ? true : undefined;
  if (raw.parent !== undefined) item.parent = raw.parent ? String(raw.parent).slice(0, 60) : undefined;
  if (raw.votes !== undefined) {
    if (Array.isArray(raw.votes)) item.votes = raw.votes.map((v) => clip(v, 40)).filter(Boolean).slice(0, 50);
    else if (typeof raw.votes === 'number') item.votes = Array.from({ length: clamp(Math.round(raw.votes), 0, 50) }, (_, i) => `vote ${i + 1}`);
    if (item.votes && item.votes.length === 0) item.votes = undefined;
  }
  if (raw.arrow !== undefined) item.arrow = raw.arrow === 'both' || raw.arrow === 'none' ? (raw.arrow as ArrowStyle) : undefined;
  if (raw.dashed !== undefined) item.dashed = raw.dashed === true ? true : undefined;
  if (raw.route !== undefined) item.route = raw.route === 'elbow' || raw.route === 'curve' ? (raw.route as Route) : undefined;
  if (raw.emoji !== undefined) item.emoji = clip(raw.emoji, 8);
  if (raw.width !== undefined) item.width = clamp(num(raw.width, 3), 1, 24);
  if (item.type === 'code') {
    const hint = raw.codeKind === 'file' || raw.codeKind === 'compare' || raw.codeKind === 'commit' ? raw.codeKind as CodeKind : undefined;
    const ref = normalizeCodeRef(raw, hint, item.code);
    if (ref) item.code = ref;
  }
  if (item.type === 'embed') {
    const e = (raw.embed && typeof raw.embed === 'object' ? raw.embed : raw) as Record<string, unknown>;
    const ref = e.ref ?? e.source ?? e.file;
    if (typeof ref === 'string' && ref.trim()) {
      const kind: EmbedKind = e.kind === 'design' || (e.kind === undefined && item.embed?.kind === 'design') ? 'design' : 'diagram';
      item.embed = { kind, ref: ref.trim().replace(/\\/g, '/').slice(0, 120), ...(typeof e.node === 'string' && e.node.trim() ? { node: e.node.trim().slice(0, 80) } : {}) };
    } else if (e.node !== undefined && item.embed) {
      item.embed = { ...item.embed, node: typeof e.node === 'string' && e.node.trim() ? e.node.trim().slice(0, 80) : undefined };
    }
  }
}

interface BuildState { taken: Set<string>; warnings: string[]; count: number; unplaced: Set<string> }

function makeItem(raw: Record<string, unknown>, state: BuildState, parent?: string): BoardItem | null {
  if (state.count >= MAX_ITEMS) { if (state.count === MAX_ITEMS) { state.warnings.push(`Only the first ${MAX_ITEMS} items were kept.`); state.count += 1; } return null; }
  const typeKey = String(raw.type ?? '').toLowerCase();
  const type: ItemType = ITEM_TYPES.includes(typeKey as ItemType) ? (typeKey as ItemType) : TYPE_ALIASES[typeKey]
    ?? (raw.from !== undefined || raw.to !== undefined ? 'connector' : Array.isArray(raw.notes) || Array.isArray(raw.children) || Array.isArray(raw.items) ? 'section' : 'sticky');
  if (raw.type !== undefined && !ITEM_TYPES.includes(typeKey as ItemType) && !TYPE_ALIASES[typeKey]) state.warnings.push(`Unknown item type "${clip(raw.type, 20)}" — used "${type}".`);
  if (type === 'shape' && TYPE_ALIASES[typeKey] === 'shape' && typeKey !== 'box' && typeKey !== 'shape') {
    raw = { ...raw, shape: raw.shape ?? (typeKey === 'rectangle' || typeKey === 'rect' ? 'rect' : typeKey === 'circle' || typeKey === 'ellipse' ? 'ellipse' : typeKey) };
  }
  if (type === 'embed' && (typeKey === 'diagram' || typeKey === 'design')) raw = { ...raw, kind: raw.kind ?? typeKey };
  if (type === 'code') raw = { ...raw, codeKind: typeKey === 'file' ? 'file' : typeKey === 'compare' || typeKey === 'diff' ? 'compare' : typeKey === 'commit' ? 'commit' : undefined };
  if (type === 'text' && typeKey === 'title') raw = { ...raw, fontSize: raw.fontSize ?? 32, bold: raw.bold ?? true };
  if (type === 'text' && typeKey === 'heading') raw = { ...raw, fontSize: raw.fontSize ?? 24, bold: raw.bold ?? true };
  state.count += 1;
  let id = String(raw.id ?? '').trim().replace(/[^\w.\-]+/g, '_').slice(0, 60);
  if (!id || state.taken.has(id)) { if (id) state.warnings.push(`Duplicate id "${id}" was renamed.`); id = freshId(state.taken, type === 'connector' ? 'c' : type === 'section' ? 's' : 'n'); } else state.taken.add(id);
  const size = defaultSize(type, SHAPE_KINDS.includes(raw.shape as ShapeKind) ? (raw.shape as ShapeKind) : undefined);
  const item: BoardItem = { id, type, x: 0, y: 0, w: size.w, h: size.h };
  if (type === 'sticky') item.color = 'yellow';
  if (type === 'shape') item.shape = 'round';
  if (type === 'section') item.color = 'gray';
  if (type === 'stamp') item.emoji = '👍';
  if (type === 'pen') { item.color = 'blue'; item.width = 3; item.points = []; }
  applyItemFields(item, raw);
  if (type === 'pen' && Array.isArray(raw.points)) {
    item.points = (raw.points as unknown[]).map((p) => (Array.isArray(p) ? [num(p[0], 0), num(p[1], 0)] as [number, number] : null)).filter((p): p is [number, number] => p !== null).slice(0, 2000);
    const xs = item.points.map((p) => p[0]), ys = item.points.map((p) => p[1]);
    if (item.points.length) { item.w = Math.max(1, Math.max(...xs)); item.h = Math.max(1, Math.max(...ys)); }
  }
  if (type === 'code' && !item.code) { state.warnings.push('A code item without a file path, compare (base + head) or commit was dropped.'); state.taken.delete(id); return null; }
  if (type === 'embed' && !item.embed) { state.warnings.push('An embed without a diagram or design reference (ref) was dropped.'); state.taken.delete(id); return null; }
  if (type === 'connector') {
    for (const key of ['from', 'to'] as const) if (raw[key] !== undefined) item[key] = String(raw[key]);
    for (const key of ['fromPoint', 'toPoint'] as const) {
      const v = raw[key];
      if (Array.isArray(v) && v.length === 2) item[key] = [num(v[0], 0), num(v[1], 0)];
    }
  }
  if (parent) item.parent = parent;
  if (type === 'text' && raw.w === undefined && item.text) item.w = Math.max(24, Math.ceil(measureText(item.text, item.fontSize ?? 18, item.bold === true, null).width));
  const placed = typeof raw.x === 'number' && typeof raw.y === 'number';
  if (!placed && type !== 'connector' && type !== 'pen') state.unplaced.add(id);
  if (type === 'sticky' && !item.text) item.text = '';
  return item;
}

const SECTION_PAD = 20;
const SECTION_HEAD = 44;
const CELL_GAP = 16;

/** Lays the children of a section out in a grid inside it and sizes the section to fit. */
export function arrangeSection(items: BoardItem[], section: BoardItem, columns?: number): void {
  const kids = items.filter((i) => i.parent === section.id && i.type !== 'connector');
  if (kids.length === 0) return;
  const cols = columns && columns > 0 ? columns : Math.max(1, Math.min(4, Math.ceil(Math.sqrt(kids.length))));
  const cellW = Math.max(...kids.map((k) => k.w)), cellH = Math.max(...kids.map((k) => k.h));
  kids.forEach((kid, i) => {
    kid.x = round(section.x + SECTION_PAD + (i % cols) * (cellW + CELL_GAP));
    kid.y = round(section.y + SECTION_HEAD + Math.floor(i / cols) * (cellH + CELL_GAP));
  });
  const rows = Math.ceil(kids.length / cols);
  section.w = Math.max(section.w, SECTION_PAD * 2 + Math.min(cols, kids.length) * cellW + (Math.min(cols, kids.length) - 1) * CELL_GAP);
  section.h = Math.max(section.h, SECTION_HEAD + rows * cellH + (rows - 1) * CELL_GAP + SECTION_PAD);
  if (kids.length >= 1) { section.w = Math.max(section.w, 240); }
}

/** Places items that have no position: sections in a row, children inside their section, loose items in a grid below. */
export function placeUnpositioned(b: Board, unplaced: Set<string>): void {
  const items = b.items;
  const sections = items.filter((i) => i.type === 'section' && unplaced.has(i.id));
  let cursor = 0;
  const placedBox = boundsOf({ ...b, items: items.filter((i) => !unplaced.has(i.id) && i.type !== 'connector') });
  if (placedBox) cursor = placedBox.x + placedBox.w + 60;
  for (const section of sections) {
    section.x = cursor; section.y = placedBox ? placedBox.y : 0;
    // Children of a new section are always arranged, even if they carried positions.
    arrangeSection(items, section);
    cursor = section.x + section.w + 40;
    unplaced.delete(section.id);
  }
  // Children whose section was placed earlier (or by hand) but who have no position of their own.
  for (const kid of items.filter((i) => unplaced.has(i.id) && i.parent)) {
    const section = items.find((s) => s.id === kid.parent);
    if (!section) continue;
    arrangeSection(items, section);
    items.filter((i) => i.parent === section.id).forEach((i) => unplaced.delete(i.id));
  }
  const loose = items.filter((i) => unplaced.has(i.id) && i.type !== 'connector');
  if (loose.length === 0) return;
  const all = boundsOf({ ...b, items: items.filter((i) => !unplaced.has(i.id) && i.type !== 'connector') });
  const startX = all ? all.x : 0;
  const startY = all ? all.y + all.h + 60 : 0;
  let x = startX, y = startY, rowH = 0;
  for (const item of loose) {
    if (x > startX && x + item.w > startX + 1400) { x = startX; y += rowH + CELL_GAP; rowH = 0; }
    item.x = round(x); item.y = round(y);
    x += item.w + CELL_GAP; rowH = Math.max(rowH, item.h);
  }
}

/** Turns untrusted input (a file or a model's tool arguments) into a valid, placed board. */
export function normalizeBoard(raw: unknown, fallbackTitle = 'Untitled'): NormalizeResult {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const state: BuildState = { taken: new Set(), warnings: [], count: 0, unplaced: new Set() };
  const rawItems = Array.isArray(input.items) ? input.items : Array.isArray(input.nodes) ? input.nodes : [];
  const items: BoardItem[] = [];
  const pendingSections: Array<{ section: BoardItem; kids: unknown[] }> = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') continue;
    const item = makeItem(entry as Record<string, unknown>, state);
    if (!item) continue;
    items.push(item);
    const e = entry as Record<string, unknown>;
    const kids = item.type === 'section' ? (Array.isArray(e.notes) ? e.notes : Array.isArray(e.children) ? e.children : Array.isArray(e.items) ? e.items : []) : [];
    if (kids.length) pendingSections.push({ section: item, kids });
  }
  for (const { section, kids } of pendingSections) {
    for (const kid of kids) {
      const spec: Record<string, unknown> | null = typeof kid === 'string' ? { type: 'sticky', text: kid } : kid && typeof kid === 'object' ? { ...(kid as Record<string, unknown>) } : null;
      if (!spec) continue;
      if (spec.color === undefined && section.color && section.color !== 'gray' && (spec.type === undefined || spec.type === 'sticky')) spec.color = section.color;
      delete spec.x; delete spec.y; // children of a section are always laid out by the section
      const item = makeItem(spec, state, section.id);
      if (item) { items.push(item); state.unplaced.add(item.id); }
    }
  }
  // Drop dangling parents, then resolve connector endpoints by id or text.
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) if (item.parent && (!ids.has(item.parent) || item.parent === item.id || items.find((s) => s.id === item.parent)?.type !== 'section')) delete item.parent;
  const board: Board = { version: 1, title: clip(input.title, 120) || fallbackTitle, items };
  const resolved: BoardItem[] = [];
  for (const item of items) {
    if (item.type !== 'connector') { resolved.push(item); continue; }
    const from = item.from !== undefined ? findItem(board, item.from) : undefined;
    const to = item.to !== undefined ? findItem(board, item.to) : undefined;
    if ((item.from !== undefined && !from) || (item.to !== undefined && !to)) { state.warnings.push(`Connector ${clip(item.from, 24)} → ${clip(item.to, 24)} was dropped: unknown item.`); continue; }
    if (!from && !item.fromPoint) { state.warnings.push('A connector without a start was dropped.'); continue; }
    if (!to && !item.toPoint) { state.warnings.push('A connector without an end was dropped.'); continue; }
    item.from = from?.id; item.to = to?.id;
    if (!from) delete item.from;
    if (!to) delete item.to;
    resolved.push(item);
  }
  board.items = resolved;
  for (const item of resolved) if (item.author === undefined && item.type === 'sticky' && typeof input.author === 'string') item.author = clip(input.author, 40);
  placeUnpositioned(board, state.unplaced);
  return { board, warnings: state.warnings };
}

export const emptyBoard = (title = 'Untitled'): Board => ({ version: 1, title, items: [] });

export function parseBoardJson(text: string, fallbackTitle?: string): NormalizeResult {
  try {
    return normalizeBoard(JSON.parse(text), fallbackTitle);
  } catch (error) {
    throw new Error(`not valid board JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const serializeBoard = (b: Board): string => `${JSON.stringify(b, null, 2)}\n`;

/* ---------- connector geometry ---------- */

export interface ConnectorGeometry {
  points: Array<[number, number]>;
  /** SVG path data. */
  path: string;
  label: [number, number];
  /** Unit direction of the first and last segment (for arrow heads). */
  startDir: [number, number];
  endDir: [number, number];
}

const centerOf = (i: BoardItem): [number, number] => [i.x + i.w / 2, i.y + i.h / 2];

/** Where the line from the item's centre towards (tx, ty) leaves its outline. */
export function borderPoint(item: BoardItem, tx: number, ty: number): [number, number] {
  const [cx, cy] = centerOf(item);
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = item.w / 2, hh = item.h / 2;
  if (item.type === 'shape' && item.shape === 'ellipse') {
    const t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
    return [cx + dx * t, cy + dy * t];
  }
  if (item.type === 'shape' && item.shape === 'diamond') {
    const t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    return [cx + dx * t, cy + dy * t];
  }
  const t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return [cx + dx * t, cy + dy * t];
}

const unit = (a: [number, number], b: [number, number]): [number, number] => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};

export function connectorGeometry(b: Board, c: BoardItem): ConnectorGeometry | null {
  const from = c.from ? b.items.find((i) => i.id === c.from) : undefined;
  const to = c.to ? b.items.find((i) => i.id === c.to) : undefined;
  if ((c.from && !from) || (c.to && !to)) return null;
  const aim = (item: BoardItem | undefined, point: [number, number] | undefined): [number, number] | null => (item ? centerOf(item) : point ?? null);
  const startAim = aim(from, c.fromPoint), endAim = aim(to, c.toPoint);
  if (!startAim || !endAim) return null;
  const route = c.route ?? 'straight';
  let start = from ? borderPoint(from, endAim[0], endAim[1]) : startAim;
  let end = to ? borderPoint(to, startAim[0], startAim[1]) : endAim;
  let points: Array<[number, number]>;
  let path: string;
  if (route === 'elbow') {
    const horizontal = Math.abs(endAim[0] - startAim[0]) >= Math.abs(endAim[1] - startAim[1]);
    if (from) start = horizontal ? borderPoint(from, endAim[0], startAim[1]) : borderPoint(from, startAim[0], endAim[1]);
    if (to) end = horizontal ? borderPoint(to, startAim[0], endAim[1]) : borderPoint(to, endAim[0], startAim[1]);
    const mid: [number, number] = horizontal ? [(start[0] + end[0]) / 2, start[1]] : [start[0], (start[1] + end[1]) / 2];
    const mid2: [number, number] = horizontal ? [mid[0], end[1]] : [end[0], mid[1]];
    points = [start, mid, mid2, end];
    path = `M ${start[0]} ${start[1]} L ${mid[0]} ${mid[1]} L ${mid2[0]} ${mid2[1]} L ${end[0]} ${end[1]}`;
  } else if (route === 'curve') {
    const horizontal = Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1]);
    const k = 0.5;
    const c1: [number, number] = horizontal ? [start[0] + (end[0] - start[0]) * k, start[1]] : [start[0], start[1] + (end[1] - start[1]) * k];
    const c2: [number, number] = horizontal ? [end[0] - (end[0] - start[0]) * k, end[1]] : [end[0], end[1] - (end[1] - start[1]) * k];
    points = [start, c1, c2, end];
    path = `M ${start[0]} ${start[1]} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${end[0]} ${end[1]}`;
  } else {
    points = [start, end];
    path = `M ${start[0]} ${start[1]} L ${end[0]} ${end[1]}`;
  }
  const label: [number, number] = route === 'curve'
    ? [(start[0] + 3 * points[1][0] + 3 * points[2][0] + end[0]) / 8, (start[1] + 3 * points[1][1] + 3 * points[2][1] + end[1]) / 8]
    : route === 'elbow' ? [(points[1][0] + points[2][0]) / 2, (points[1][1] + points[2][1]) / 2] : [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  return { points, path, label, startDir: unit(start, points[1] ?? end), endDir: unit(points[points.length - 2] ?? start, end) };
}

/* ---------- edit operations ---------- */

export interface BoardOp { op: string; [key: string]: unknown }
export interface BoardOpsResult { board: Board; log: string[]; errors: string[] }

const sectionAtPoint = (b: Board, px: number, py: number, exclude?: string): BoardItem | undefined =>
  [...b.items].reverse().filter((s) => s.type === 'section' && s.id !== exclude && px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h)
    .sort((a, c) => a.w * a.h - c.w * c.h)[0];

/** Re-assigns an item to the smallest section containing its centre (or none). */
export function reparentByPosition(b: Board, item: BoardItem): void {
  if (item.type === 'connector' || item.type === 'section') return;
  const section = sectionAtPoint(b, item.x + item.w / 2, item.y + item.h / 2);
  if (section) item.parent = section.id; else delete item.parent;
}

/** Items that move together with `ids` (a section drags its children). */
export function withChildren(b: Board, ids: string[]): string[] {
  const set = new Set(ids);
  for (const item of b.items) if (item.parent && set.has(item.parent)) set.add(item.id);
  return [...set];
}

function removeItems(b: Board, ids: Set<string>): void {
  b.items = b.items.filter((i) => !ids.has(i.id) && !(i.type === 'connector' && ((i.from && ids.has(i.from)) || (i.to && ids.has(i.to)))));
  for (const i of b.items) if (i.parent && ids.has(i.parent)) delete i.parent;
}

/** Applies operations in order; valid ones are applied, invalid ones reported in `errors`. */
export function applyBoardOps(input: Board, ops: BoardOp[], actor = 'user'): BoardOpsResult {
  const b: Board = structuredClone(input);
  const log: string[] = [];
  const errors: string[] = [];
  const get = (ref: unknown): BoardItem => {
    const item = findItem(b, ref);
    if (!item) throw new Error(`no item "${String(ref)}"`);
    return item;
  };
  ops.forEach((op, i) => {
    const where = `op ${i + 1} (${String(op?.op ?? '?')})`;
    try {
      switch (String(op.op)) {
        case 'add': {
          const { op: _o, section: sectionRef, item: nested, ...flat } = op as Record<string, unknown>;
          void _o;
          const spec = (nested && typeof nested === 'object' ? { ...(nested as Record<string, unknown>) } : flat) as Record<string, unknown>;
          const section = sectionRef ? get(sectionRef) : undefined;
          if (section && section.type !== 'section') throw new Error(`"${section.text ?? section.id}" is not a section`);
          const state: BuildState = { taken: allIds(b), warnings: [], count: b.items.length, unplaced: new Set() };
          if (spec.author === undefined && actor) spec.author = actor;
          const kidsSpec = Array.isArray(spec.notes) ? spec.notes : Array.isArray(spec.children) ? spec.children : Array.isArray(spec.items) ? spec.items : [];
          const item = makeItem(spec, state, section?.id);
          if (!item) throw new Error('could not create the item');
          if (section && spec.color === undefined && section.color && section.color !== 'gray' && item.type === 'sticky') item.color = section.color;
          b.items.push(item);
          if (item.type === 'section') {
            for (const kid of kidsSpec) {
              const kidSpec: Record<string, unknown> = typeof kid === 'string' ? { type: 'sticky', text: kid } : { ...(kid as Record<string, unknown>) };
              delete kidSpec.x; delete kidSpec.y;
              if (kidSpec.author === undefined) kidSpec.author = actor;
              const child = makeItem(kidSpec, state, item.id);
              if (child) { b.items.push(child); state.unplaced.add(child.id); }
            }
          }
          if (item.type === 'connector') {
            const from = item.from !== undefined ? findItem(b, item.from) : undefined;
            const to = item.to !== undefined ? findItem(b, item.to) : undefined;
            if ((item.from !== undefined && !from) || (item.to !== undefined && !to)) { b.items.pop(); throw new Error('connector endpoints must be existing items'); }
            item.from = from?.id; item.to = to?.id;
            if (!from) delete item.from;
            if (!to) delete item.to;
          }
          if (item.type !== 'connector' && state.unplaced.has(item.id) && section && item.type !== 'section') {
            arrangeSection(b.items, section);
            state.unplaced.delete(item.id);
          }
          placeUnpositioned(b, state.unplaced);
          log.push(`added ${item.type} ${item.id}${item.text ? ` "${item.text.slice(0, 40)}"` : ''}${section ? ` in ${section.id}` : ''}`);
          break;
        }
        case 'update': {
          const item = get(op.id ?? op.item);
          const { op: _o, id: _id, item: _item, set, ...flat } = op as Record<string, unknown>;
          void _o; void _id; void _item;
          applyItemFields(item, { ...flat, ...((set && typeof set === 'object') ? (set as Record<string, unknown>) : {}) });
          if (item.type === 'text' && item.text !== undefined && flat.w === undefined) item.w = Math.max(24, Math.ceil(measureText(item.text, item.fontSize ?? 18, item.bold === true, null).width));
          log.push(`updated ${item.id}`);
          break;
        }
        case 'remove': {
          const item = get(op.id ?? op.item);
          removeItems(b, new Set([item.id]));
          log.push(`removed ${item.id}`);
          break;
        }
        case 'move': {
          const item = get(op.id ?? op.item);
          const dx = typeof op.dx === 'number' ? op.dx : typeof op.x === 'number' ? op.x - item.x : 0;
          const dy = typeof op.dy === 'number' ? op.dy : typeof op.y === 'number' ? op.y - item.y : 0;
          for (const moving of b.items.filter((m) => withChildren(b, [item.id]).includes(m.id))) { moving.x = round(moving.x + dx); moving.y = round(moving.y + dy); }
          if (item.type !== 'section') reparentByPosition(b, item);
          log.push(`moved ${item.id}`);
          break;
        }
        case 'connect': {
          const from = get(op.from), to = get(op.to);
          const spec = { type: 'connector', from: from.id, to: to.id, label: op.label, text: op.label ?? op.text, arrow: op.arrow, dashed: op.dashed, route: op.route, color: op.color };
          const state: BuildState = { taken: allIds(b), warnings: [], count: b.items.length, unplaced: new Set() };
          const c = makeItem(spec as Record<string, unknown>, state);
          if (!c) throw new Error('could not create the connector');
          b.items.push(c);
          log.push(`connected ${from.id} → ${to.id}`);
          break;
        }
        case 'group': {
          const ids = (Array.isArray(op.ids) ? op.ids : [op.id]).map(get);
          let section = op.section !== undefined ? findItem(b, op.section) : undefined;
          if (!section) {
            const taken = allIds(b);
            const box = boundsOf(b, ids.map((x) => x.id)) ?? { x: 0, y: 0, w: 200, h: 200 };
            section = { id: freshId(taken, 's'), type: 'section', x: box.x - SECTION_PAD, y: box.y - SECTION_HEAD, w: box.w + SECTION_PAD * 2, h: box.h + SECTION_HEAD + SECTION_PAD, text: clip(op.section ?? op.title ?? 'Section', 120), color: parseColor(op.color) ?? 'gray' };
            b.items.unshift(section);
          } else if (section.type !== 'section') throw new Error(`"${section.text ?? section.id}" is not a section`);
          for (const item of ids) { if (item.type !== 'section' && item.type !== 'connector') item.parent = section.id; }
          if (op.arrange !== false && op.arrange !== undefined) arrangeSection(b.items, section);
          log.push(`grouped ${ids.length} item(s) in ${section.id}`);
          break;
        }
        case 'ungroup': {
          const ids = (Array.isArray(op.ids) ? op.ids : [op.id]).map(get);
          for (const item of ids) delete item.parent;
          log.push(`ungrouped ${ids.length} item(s)`);
          break;
        }
        case 'arrange': {
          const section = op.section !== undefined ? get(op.section) : undefined;
          if (section) {
            if (section.type !== 'section') throw new Error(`"${section.text ?? section.id}" is not a section`);
            arrangeSection(b.items, section, typeof op.columns === 'number' ? op.columns : undefined);
            log.push(`arranged ${section.id}`);
          } else {
            const ids = (Array.isArray(op.ids) ? op.ids : []).map(get).filter((x) => x.type !== 'connector');
            if (ids.length === 0) throw new Error('arrange needs a section or ids');
            const mode = op.mode === 'row' || op.mode === 'column' ? op.mode : 'grid';
            const cols = mode === 'row' ? ids.length : mode === 'column' ? 1 : typeof op.columns === 'number' && op.columns > 0 ? op.columns : Math.max(1, Math.ceil(Math.sqrt(ids.length)));
            const box = boundsOf(b, ids.map((x) => x.id))!;
            const cellW = Math.max(...ids.map((x) => x.w)), cellH = Math.max(...ids.map((x) => x.h));
            ids.forEach((item, n) => { item.x = round(box.x + (n % cols) * (cellW + CELL_GAP)); item.y = round(box.y + Math.floor(n / cols) * (cellH + CELL_GAP)); });
            log.push(`arranged ${ids.length} item(s) as ${mode}`);
          }
          break;
        }
        case 'vote': {
          const item = get(op.id ?? op.item);
          const by = clip(op.by ?? actor ?? 'user', 40);
          const votes = item.votes ?? [];
          if (op.remove === true) item.votes = votes.filter((v, idx) => !(v === by && votes.indexOf(v) === idx)); else item.votes = [...votes, by];
          if (item.votes.length === 0) item.votes = undefined;
          log.push(`${op.remove === true ? 'removed a vote from' : 'voted for'} ${item.id}`);
          break;
        }
        case 'duplicate': {
          const item = get(op.id ?? op.item);
          if (item.type === 'connector') throw new Error('connectors cannot be duplicated');
          const taken = allIds(b);
          const ids = withChildren(b, [item.id]);
          const map = new Map<string, string>();
          const copies = b.items.filter((x) => ids.includes(x.id)).map((x) => {
            const copy = structuredClone(x);
            copy.id = freshId(taken, x.type === 'section' ? 's' : 'n');
            map.set(x.id, copy.id);
            copy.x += 30; copy.y += 30;
            return copy;
          });
          for (const copy of copies) if (copy.parent) copy.parent = map.get(copy.parent) ?? copy.parent;
          b.items.push(...copies);
          log.push(`duplicated ${item.id} as ${map.get(item.id)}`);
          break;
        }
        case 'set_meta': {
          if (op.title !== undefined) b.title = clip(op.title, 120);
          log.push('updated title');
          break;
        }
        default:
          throw new Error('unknown op — use add, update, remove, move, connect, group, ungroup, arrange, vote, duplicate or set_meta');
      }
    } catch (error) {
      errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { board: b, log, errors };
}

/* ---------- review checks, summaries, Markdown ---------- */

export interface BoardIssue { severity: 'warn' | 'info'; id: string; message: string }

export function checkBoard(b: Board): BoardIssue[] {
  const issues: BoardIssue[] = [];
  const add = (severity: BoardIssue['severity'], item: BoardItem, message: string) => issues.push({ severity, id: item.id, message: `${item.id}: ${message}` });
  const sections = b.items.filter((i) => i.type === 'section');
  const notes = b.items.filter((i) => i.type === 'sticky');
  for (const note of notes) {
    if (!(note.text ?? '').trim()) add('warn', note, 'empty sticky note');
    else if ((note.text ?? '').length > 160) add('info', note, 'long note — one idea per sticky works better');
    if (sections.length > 0 && !note.parent) add('info', note, `"${(note.text ?? '').slice(0, 30)}" is not in any section`);
  }
  for (const section of sections) {
    const kids = childrenOf(b, section.id);
    for (const kid of kids) {
      if (kid.x < section.x - 1 || kid.y < section.y - 1 || kid.x + kid.w > section.x + section.w + 1 || kid.y + kid.h > section.y + section.h + 1) add('warn', kid, `sticks out of section "${section.text ?? section.id}" — use arrange`);
    }
    if (!(section.text ?? '').trim()) add('info', section, 'section has no title');
  }
  const boxes = b.items.filter((i) => i.type === 'sticky' || i.type === 'shape');
  let overlaps = 0;
  for (let i = 0; i < boxes.length && overlaps < 5; i += 1) {
    for (let j = i + 1; j < boxes.length && overlaps < 5; j += 1) {
      const a = boxes[i], c = boxes[j];
      if (a.x < c.x + c.w - 4 && c.x < a.x + a.w - 4 && a.y < c.y + c.h - 4 && c.y < a.y + a.h - 4) { overlaps += 1; add('warn', a, `overlaps ${c.id} — use arrange`); }
    }
  }
  return issues;
}

/** One-line description of an item (id, kind, text, votes) — used by summaries and the chat context. */
export const describeItem = (b: Board, item: BoardItem): string => {
  const votes = item.votes?.length ? ` · ${item.votes.length} vote${item.votes.length === 1 ? '' : 's'}` : '';
  const by = item.author && item.author !== 'user' ? ` · by ${item.author}` : '';
  const text = (item.text ?? '').replace(/\n/g, ' ⏎ ').slice(0, 90);
  switch (item.type) {
    case 'sticky': return `${item.id} [sticky ${item.color ?? 'yellow'}] "${text}"${votes}${by}`;
    case 'shape': return `${item.id} [${item.shape ?? 'round'} shape ${item.color ?? 'white'}] "${text}"`;
    case 'text': return `${item.id} [text] "${text}"`;
    case 'stamp': return `${item.id} [stamp ${item.emoji ?? ''}]`;
    case 'pen': return `${item.id} [pen drawing]`;
    case 'code': return `${item.id} [code ${item.code?.kind ?? 'file'}] ${item.code ? describeCode(item.code) : '?'}${text ? ` "${text}"` : ''}`;
    case 'embed': return `${item.id} [${item.embed?.kind ?? 'diagram'} embed] ${item.embed?.ref ?? '?'}${item.embed?.node ? ` › ${item.embed.node}` : ''}${text ? ` "${text}"` : ''}`;
    case 'connector': {
      const name = (id: string | undefined, point?: [number, number]) => (id ? `${id} ("${(b.items.find((i) => i.id === id)?.text ?? '').slice(0, 24)}")` : `(${Math.round(point?.[0] ?? 0)},${Math.round(point?.[1] ?? 0)})`);
      return `${item.id} [connector] ${name(item.from, item.fromPoint)} ${item.dashed ? '-->' : '->'} ${name(item.to, item.toPoint)}${item.text ? ` "${item.text}"` : ''}`;
    }
    default: return `${item.id} [${item.type}] "${text}"`;
  }
};

export function summarizeBoard(b: Board, maxLines = 220): string {
  const lines: string[] = [`"${b.title}" — ${b.items.length} items (${b.items.filter((i) => i.type === 'sticky').length} stickies, ${b.items.filter((i) => i.type === 'section').length} sections, ${b.items.filter((i) => i.type === 'connector').length} connectors)`];
  const sections = b.items.filter((i) => i.type === 'section');
  for (const section of sections) {
    const kids = childrenOf(b, section.id).filter((k) => k.type !== 'connector');
    lines.push(`Section ${section.id} "${section.text ?? ''}" (${section.color ?? 'gray'}, ${Math.round(section.w)}×${Math.round(section.h)} @${Math.round(section.x)},${Math.round(section.y)}) — ${kids.length} item(s):`);
    for (const kid of kids) lines.push(`  - ${describeItem(b, kid)}`);
  }
  const loose = b.items.filter((i) => i.type !== 'section' && i.type !== 'connector' && !i.parent);
  if (loose.length) { lines.push(sections.length ? 'Outside sections:' : 'Items:'); for (const item of loose) lines.push(`  - ${describeItem(b, item)} @${Math.round(item.x)},${Math.round(item.y)}`); }
  const connectors = b.items.filter((i) => i.type === 'connector');
  if (connectors.length) { lines.push('Connections:'); for (const c of connectors) lines.push(`  - ${describeItem(b, c)}`); }
  if (lines.length > maxLines) { lines.length = maxLines; lines.push(`… (outline truncated at ${maxLines} lines)`); }
  return lines.join('\n');
}

/** Markdown outline of the board: sections with their notes, votes, then relations. */
export function boardToMarkdown(b: Board): string {
  const out: string[] = [`# ${b.title}`, ''];
  const note = (item: BoardItem) => `- ${(item.text ?? '').replace(/\n/g, ' ').trim() || '(empty)'}${item.votes?.length ? ` (${item.votes.length} vote${item.votes.length === 1 ? '' : 's'})` : ''}`;
  const sections = b.items.filter((i) => i.type === 'section');
  for (const section of sections) {
    const kids = childrenOf(b, section.id).filter((k) => k.type === 'sticky' || k.type === 'text' || k.type === 'shape');
    out.push(`## ${section.text || 'Section'} (${kids.length})`, '');
    out.push(...(kids.length ? [...kids].sort((a, c) => (c.votes?.length ?? 0) - (a.votes?.length ?? 0)).map(note) : ['_No notes_']), '');
  }
  const loose = b.items.filter((i) => (i.type === 'sticky' || i.type === 'text' || i.type === 'shape') && !i.parent);
  if (loose.length) out.push(sections.length ? '## Unsorted' : '## Notes', '', ...loose.map(note), '');
  const codes = b.items.filter((i) => i.type === 'code' && i.code);
  if (codes.length) out.push('## Code', '', ...codes.map((c) => `- ${c.text || c.code!.kind}: \`${describeCode(c.code!)}\``), '');
  const embeds = b.items.filter((i) => i.type === 'embed' && i.embed);
  if (embeds.length) out.push('## Embedded', '', ...embeds.map((e) => `- ${e.embed!.kind === 'design' ? 'Design' : 'Diagram'}: ${e.text || e.embed!.ref} (\`${e.embed!.ref}\`${e.embed!.node ? ` › ${e.embed!.node}` : ''})`), '');
  const connectors = b.items.filter((i) => i.type === 'connector' && i.from && i.to);
  if (connectors.length) {
    const label = (id: string) => (b.items.find((i) => i.id === id)?.text ?? id).replace(/\n/g, ' ').trim() || id;
    out.push('## Relations', '', ...connectors.map((c) => `- ${label(c.from!)} → ${label(c.to!)}${c.text ? ` (${c.text})` : ''}`), '');
  }
  return out.join('\n').trimEnd() + '\n';
}

/* ---------- SVG rendering ---------- */

export const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The drawable content of an embedded diagram or design (see prepareEmbedSvg). */
export interface EmbedContent { inner: string; viewBox: [number, number, number, number] }
export const embedKey = (e: EmbedRef): string => `${e.kind}:${e.ref}:${e.node ?? ''}`;

/** Turns a standalone SVG into content that can be nested in the board. Ids are prefixed so several embeds never collide. */
export function prepareEmbedSvg(svg: string, prefix: string): EmbedContent | null {
  const root = /<svg\b[^>]*\sviewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"[^>]*>/.exec(svg);
  if (!root) return null;
  const inner = svg.slice(root.index + root[0].length, svg.lastIndexOf('</svg>'))
    .replace(/\sdata-(?:id|node|edge|layer)="[^"]*"/g, '') // the board's hit testing must only see its own items
    .replace(/(\s)id="([^"]+)"/g, (_m, sp: string, id: string) => `${sp}id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}${id})`)
    .replace(/href="#([^"]+)"/g, (_m, id: string) => `href="#${prefix}${id}"`);
  return { inner, viewBox: [Number(root[1]), Number(root[2]), Number(root[3]), Number(root[4])] };
}

export interface BoardRenderOptions {
  /** Content of the embedded diagrams/designs, keyed by embedKey(). */
  embeds?: Record<string, EmbedContent>;
  /** Loaded code of `code` items, keyed by codeKey(). */
  codes?: Record<string, CodeSnapshot>;
  /** Colours of code cards (the editor follows the app theme; exports stay light). */
  codeTheme?: CodeTheme;
  /** Adds data-id hooks used by the editor's hit testing. */
  interactive?: boolean;
  /** Item whose text is hidden because an inline editor covers it. */
  editingId?: string | null;
  /** Colour of ink on a transparent canvas (editor passes a CSS var). */
  ink?: string;
}

const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

function textBlock(item: BoardItem, lines: string[], lineHeight: number, fontSize: number, anchorX: number, y0: number, anchor: 'start' | 'middle' | 'end', fill: string): string {
  return `<text text-anchor="${anchor}" font-family="${escapeXml(FONT)}" font-size="${fontSize}" font-weight="${item.bold ? 700 : 400}" style="fill:${fill};stroke:none">`
    + lines.map((line, i) => `<tspan x="${anchorX}" y="${round(y0 + i * lineHeight)}" xml:space="preserve">${escapeXml(line)}</tspan>`).join('') + '</text>';
}

function shapePath(item: BoardItem): string {
  const { w, h } = item;
  switch (item.shape ?? 'round') {
    case 'ellipse': return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}"`;
    case 'diamond': return `<polygon points="${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}"`;
    case 'triangle': return `<polygon points="${w / 2},0 ${w},${h} 0,${h}"`;
    case 'rect': return `<rect width="${w}" height="${h}"`;
    default: return `<rect width="${w}" height="${h}" rx="14"`;
  }
}

function renderItem(b: Board, item: BoardItem, o: BoardRenderOptions): string {
  const id = item.id.replace(/[^\w-]/g, '_');
  const hook = o.interactive ? ` data-id="${escapeXml(item.id)}"${item.locked ? ' data-locked="1"' : ''}` : '';
  const c = colorOf(item);
  const editing = o.editingId === item.id;
  const ink = o.ink ?? '#1f2430';
  switch (item.type) {
    case 'section': {
      const title = item.text ?? '';
      return `<g transform="translate(${item.x} ${item.y})"${hook}>`
        + `<rect width="${item.w}" height="${item.h}" rx="14" style="fill:${c.fill};fill-opacity:0.18;stroke:${c.stroke};stroke-width:2"/>`
        + `<rect width="${item.w}" height="34" rx="14" style="fill:${c.fill};fill-opacity:0.55;stroke:none"/>`
        + (editing ? '' : `<text x="14" y="23" font-family="${escapeXml(FONT)}" font-size="16" font-weight="700" style="fill:${ink};stroke:none">${escapeXml(title.slice(0, Math.max(4, Math.floor((item.w - 28) / 9))))}</text>`)
        + '</g>';
    }
    case 'sticky': {
      const size = item.fontSize ?? 16;
      const m = measureText(item.text ?? '', size, item.bold === true, item.w - 28);
      const align = item.align ?? 'left';
      const x = align === 'center' ? item.w / 2 : align === 'right' ? item.w - 14 : 14;
      const votes = item.votes?.length ?? 0;
      return `<g transform="translate(${item.x} ${item.y})"${hook}>`
        + `<defs><filter id="sh-${id}" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.22"/></filter></defs>`
        + `<rect width="${item.w}" height="${item.h}" rx="4" filter="url(#sh-${id})" style="fill:${c.fill};stroke:none"/>`
        + (editing ? '' : textBlock(item, m.lines.slice(0, Math.max(1, Math.floor((item.h - 40) / m.lineHeightPx))), m.lineHeightPx, size, x, 14 + size * 0.95, align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start', '#1f2430'))
        + (item.author && item.author !== 'user' ? `<text x="12" y="${item.h - 10}" font-family="${escapeXml(FONT)}" font-size="11" style="fill:#1f2430;fill-opacity:0.55;stroke:none">${escapeXml(item.author.slice(0, 18))}</text>` : '')
        + (votes > 0 ? `<g transform="translate(${item.w - 30} ${item.h - 28})"><circle cx="12" cy="12" r="12" style="fill:#1f2430;stroke:none"/><text x="12" y="16.5" text-anchor="middle" font-family="${escapeXml(FONT)}" font-size="12" font-weight="700" style="fill:#fff;stroke:none">${votes}</text></g>` : '')
        + '</g>';
    }
    case 'shape': {
      const size = item.fontSize ?? 16;
      const m = measureText(item.text ?? '', size, item.bold === true, item.w - 28);
      const top = (item.h - m.height) / 2 + size * 0.95 + (m.lineHeightPx - size * 1.3) / 2;
      return `<g transform="translate(${item.x} ${item.y})"${hook}>`
        + `${shapePath(item)} style="fill:${c.fill};stroke:${c.stroke};stroke-width:2"/>`
        + (editing ? '' : textBlock(item, m.lines.slice(0, 6), m.lineHeightPx, size, item.w / 2, top - size * 0.1, 'middle', '#1f2430'))
        + '</g>';
    }
    case 'text': {
      const size = item.fontSize ?? 18;
      const m = measureText(item.text ?? '', size, item.bold === true, item.w);
      const align = item.align ?? 'left';
      return `<g transform="translate(${item.x} ${item.y})"${hook}><rect width="${item.w}" height="${Math.max(item.h, m.height)}" style="fill:transparent"/>`
        + (editing ? '' : textBlock(item, m.lines, m.lineHeightPx, size, align === 'center' ? item.w / 2 : align === 'right' ? item.w : 0, size * 0.95, align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start', ink))
        + '</g>';
    }
    case 'code': {
      const c = item.code;
      const snap = c ? o.codes?.[codeKey(c)] : undefined;
      const p = codePalette(o.codeTheme);
      const badge = c?.kind === 'compare' ? 'COMPARE' : c?.kind === 'commit' ? 'COMMIT' : 'FILE';
      const tone = p.badges[c?.kind ?? 'file'];
      const bw = badge.length * 6.4 + 12;
      const tabs = c ? codeHeaderSvg(c, snap, item.w, FONT, o.codeTheme) : '';
      const title = (item.text || (snap?.commit ? '' : snap?.title) || (c ? describeCode(c) : '')).slice(0, Math.max(6, Math.floor((item.w - bw - 34) / 7)));
      const mono = '"JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace';
      const gutter = Math.max(...(snap?.lines ?? []).map((l) => (l.n ?? '').length), 2) * CODE_CHAR + 14;
      const maxChars = Math.max(4, Math.floor((item.w - 16 - gutter - 8) / CODE_CHAR));
      const rowsMax = Math.max(1, Math.floor((item.h - 62) / CODE_ROW));
      const sub = !tabs && snap?.subtitle ? `<text x="${item.w - 12}" y="20" text-anchor="end" font-family="${escapeXml(FONT)}" font-size="11" style="fill:${p.headMuted};stroke:none">${escapeXml(snap.subtitle.slice(0, Math.floor(item.w / 8)))}</text>` : '';
      const rows = (snap?.lines ?? []).slice(0, rowsMax).map((l, i) => {
        const y = 15 + i * CODE_ROW;
        const bg = l.k === 'add' ? p.codeAdd : l.k === 'del' ? p.codeDel : l.k === 'hunk' ? p.codeHunk : null;
        const mark = l.k === 'add' ? '+ ' : l.k === 'del' ? '− ' : '';
        return (bg ? `<rect x="0" y="${y - 13}" width="${item.w}" height="${CODE_ROW}" style="fill:${bg};stroke:none"/>` : '')
          + `<text x="${gutter - 8}" y="${y}" text-anchor="end" font-family="${escapeXml(mono)}" font-size="12" style="fill:${p.gutter};stroke:none">${escapeXml(l.n ?? '')}</text>`
          + `<text x="${gutter}" y="${y}" font-family="${escapeXml(mono)}" font-size="12" xml:space="preserve" style="fill:${p.codeInk[l.k]};stroke:none">${mark}${escapeXml(l.t.replace(/\t/g, '  ').slice(0, maxChars))}</text>`;
      }).join('');
      const more = snap && snap.lines.length > rowsMax ? `<text x="${item.w - 14}" y="${item.h - 12}" text-anchor="end" font-family="${escapeXml(FONT)}" font-size="10.5" style="fill:${p.headMuted};stroke:none">+${snap.lines.length - rowsMax} more lines</text>` : '';
      const frame = (bg: string, stroke: string) => `<rect width="${item.w - 16}" height="${item.h - 42}" rx="6" style="fill:${bg};stroke:${stroke};stroke-width:1"/>`;
      const body = snap && !snap.error && snap.commit
        ? `<svg x="8" y="34" width="${item.w - 16}" height="${item.h - 42}">${frame(p.panel, p.panelStroke)}${commitBodySvg(snap, item.w, item.h, FONT, mono, o.codeTheme)}</svg>`
        : snap && !snap.error
          ? `<svg x="8" y="34" width="${item.w - 16}" height="${item.h - 42}">${frame(p.codeBg, 'none')}<g transform="translate(0 7)">${rows}</g></svg>${more}`
          : `<rect x="8" y="34" width="${item.w - 16}" height="${item.h - 42}" rx="6" style="fill:#f3f4f8;stroke:#c3c8d6;stroke-width:1" stroke-dasharray="6 4"/><text x="${item.w / 2}" y="${34 + (item.h - 42) / 2 + 4}" text-anchor="middle" font-family="${escapeXml(FONT)}" font-size="12" style="fill:#6b7385;stroke:none">${escapeXml((snap?.error ?? (c ? 'loading…' : 'missing source')).slice(0, Math.floor((item.w - 16) / 6.5)))}</text>`;
      return `<g transform="translate(${item.x} ${item.y})"${hook}>`
        + `<defs><filter id="sh-${id}" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#000" flood-opacity="${o.codeTheme === 'dark' ? 0.5 : 0.2}"/></filter></defs>`
        + `<rect width="${item.w}" height="${item.h}" rx="10" filter="url(#sh-${id})" style="fill:${p.card};stroke:${p.cardStroke};stroke-width:1.2"/>`
        + `<rect x="8" y="7" width="${bw}" height="18" rx="9" style="fill:${tone[0]};stroke:none"/>`
        + `<text x="${8 + bw / 2}" y="19.5" text-anchor="middle" font-family="${escapeXml(FONT)}" font-size="10" font-weight="700" style="fill:${tone[1]};stroke:none">${badge}</text>`
        + (editing ? '' : tabs || `<text x="${8 + bw + 10}" y="20" font-family="${escapeXml(FONT)}" font-size="13" font-weight="600" style="fill:${p.headInk};stroke:none">${escapeXml(title)}</text>`)
        + sub + body + '</g>';
    }
    case 'embed': {
      const e = item.embed;
      const content = e ? o.embeds?.[embedKey(e)] : undefined;
      const title = (item.text || e?.ref || '').slice(0, Math.max(6, Math.floor((item.w - 90) / 7)));
      const badge = e?.kind === 'design' ? 'DESIGN' : 'DIAGRAM';
      const bodyW = item.w - 16, bodyH = item.h - 42;
      const body = content
        ? `<svg x="8" y="34" width="${bodyW}" height="${bodyH}" viewBox="${content.viewBox.join(' ')}" preserveAspectRatio="xMidYMid meet">${content.inner}</svg>`
        : `<rect x="8" y="34" width="${bodyW}" height="${bodyH}" rx="6" style="fill:#f3f4f8;stroke:#c3c8d6;stroke-width:1" stroke-dasharray="6 4"/><text x="${item.w / 2}" y="${34 + bodyH / 2 + 4}" text-anchor="middle" font-family="${escapeXml(FONT)}" font-size="12" style="fill:#6b7385;stroke:none">${e ? escapeXml(`${e.kind} not found: ${e.ref}`.slice(0, Math.floor(bodyW / 6.5))) : 'missing source'}</text>`;
      return `<g transform="translate(${item.x} ${item.y})"${hook}>`
        + `<defs><filter id="sh-${id}" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#000" flood-opacity="0.2"/></filter></defs>`
        + `<rect width="${item.w}" height="${item.h}" rx="10" filter="url(#sh-${id})" style="fill:#ffffff;stroke:#c9ceda;stroke-width:1.2"/>`
        + `<rect x="8" y="7" width="${badge.length * 6.4 + 12}" height="18" rx="9" style="fill:${e?.kind === 'design' ? '#ede9fe' : '#dbeafe'};stroke:none"/>`
        + `<text x="${8 + (badge.length * 6.4 + 12) / 2}" y="19.5" text-anchor="middle" font-family="${escapeXml(FONT)}" font-size="10" font-weight="700" style="fill:${e?.kind === 'design' ? '#6d28d9' : '#1d4ed8'};stroke:none">${badge}</text>`
        + (editing ? '' : `<text x="${8 + badge.length * 6.4 + 22}" y="20" font-family="${escapeXml(FONT)}" font-size="13" font-weight="600" style="fill:#1f2430;stroke:none">${escapeXml(title)}</text>`)
        + body + '</g>';
    }
    case 'stamp':
      return `<g transform="translate(${item.x} ${item.y})"${hook}><rect width="${item.w}" height="${item.h}" style="fill:transparent"/><text x="${item.w / 2}" y="${item.h * 0.74}" text-anchor="middle" font-size="${Math.round(item.h * 0.78)}">${escapeXml(item.emoji ?? '👍')}</text></g>`;
    case 'pen': {
      const pts = item.points ?? [];
      if (pts.length < 2) return '';
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
      return `<g transform="translate(${item.x} ${item.y})"${hook}>`
        + (o.interactive ? `<path d="${d}" style="fill:none;stroke:transparent;stroke-width:${(item.width ?? 3) + 10}" stroke-linecap="round" stroke-linejoin="round"/>` : '')
        + `<path d="${d}" style="fill:none;stroke:${COLOR_STYLES[item.color ?? 'blue'].stroke};stroke-width:${item.width ?? 3}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    }
    case 'connector': {
      const g = connectorGeometry(b, item);
      if (!g) return '';
      const stroke = item.color ? COLOR_STYLES[item.color].stroke : (o.ink ? o.ink : '#4a5163');
      const head = (p: [number, number], dir: [number, number]) => {
        const bx = p[0] - dir[0] * 11, by = p[1] - dir[1] * 11;
        return `<polygon points="${p[0]},${p[1]} ${bx - dir[1] * 5.5},${by + dir[0] * 5.5} ${bx + dir[1] * 5.5},${by - dir[0] * 5.5}" style="fill:${stroke};stroke:none"/>`;
      };
      const label = item.text && !editing
        ? `<rect x="${g.label[0] - Math.max(14, item.text.length * 3.6 + 8)}" y="${g.label[1] - 10}" width="${Math.max(28, item.text.length * 7.2 + 16)}" height="20" rx="5" style="fill:#fff;stroke:${stroke};stroke-width:1"/>`
          + `<text x="${g.label[0]}" y="${g.label[1] + 4.5}" text-anchor="middle" font-family="${escapeXml(FONT)}" font-size="12" style="fill:#1f2430;stroke:none">${escapeXml(item.text.slice(0, 40))}</text>` : '';
      return `<g${hook}>`
        + (o.interactive ? `<path d="${g.path}" style="fill:none;stroke:transparent;stroke-width:16" pointer-events="stroke"/>` : '')
        + `<path d="${g.path}" style="fill:none;stroke:${stroke};stroke-width:2.2"${item.dashed ? ' stroke-dasharray="8 6"' : ''} stroke-linecap="round" stroke-linejoin="round"/>`
        + (item.arrow === 'none' ? '' : head(g.points[g.points.length - 1], g.endDir))
        + (item.arrow === 'both' ? head(g.points[0], [-g.startDir[0], -g.startDir[1]]) : '')
        + label + '</g>';
    }
  }
}

export function renderBoardContent(b: Board, options: BoardRenderOptions = {}): string {
  const order = (i: BoardItem) => (i.type === 'section' ? 0 : i.type === 'connector' ? 2 : 1);
  return [...b.items].sort((a, c) => order(a) - order(c)).map((item) => renderItem(b, item, options)).join('');
}

/** A standalone SVG of the whole board, cropped to its content. */
export function renderBoardSvg(b: Board, options: { background?: string | null; padding?: number; only?: string[]; embeds?: Record<string, EmbedContent>; codes?: Record<string, CodeSnapshot> } = {}): string {
  const items = b.items.filter((i) => !options.only || options.only.includes(i.id) || (i.parent && options.only.includes(i.parent)));
  const view: Board = { ...b, items };
  const boxes = items.map((i) => boxOf(view, i)).filter((x) => x.w > 0 || x.h > 0);
  const pad = options.padding ?? 40;
  let x = 0, y = 0, w = 400, h = 300;
  if (boxes.length) {
    const x1 = Math.min(...boxes.map((r) => r.x)), y1 = Math.min(...boxes.map((r) => r.y));
    x = Math.floor(x1 - pad); y = Math.floor(y1 - pad);
    w = Math.ceil(Math.max(...boxes.map((r) => r.x + r.w)) - x1 + pad * 2);
    h = Math.ceil(Math.max(...boxes.map((r) => r.y + r.h)) - y1 + pad * 2);
  }
  const bg = options.background === undefined ? '#ffffff' : options.background;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`
    + `<title>${escapeXml(b.title)}</title>`
    + (bg ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" style="fill:${bg}"/>` : '')
    + renderBoardContent(view, { embeds: options.embeds, codes: options.codes }) + '</svg>';
}

/* ---------- geometry helpers for the editor ---------- */

export interface Box { x: number; y: number; w: number; h: number }
export interface Guide { axis: 'x' | 'y'; pos: number; from: number; to: number }

/** Snaps a moving box to the edges/centres of other items. */
export function snapBox(box: Box, targets: Box[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [box.x, box.x + box.w / 2, box.x + box.w], ys = [box.y, box.y + box.h / 2, box.y + box.h];
  let bx: { delta: number; pos: number; t: Box } | null = null, by: { delta: number; pos: number; t: Box } | null = null;
  for (const t of targets) {
    for (const tx of [t.x, t.x + t.w / 2, t.x + t.w]) for (const x of xs) { const delta = tx - x; if (Math.abs(delta) <= threshold && (!bx || Math.abs(delta) < Math.abs(bx.delta))) bx = { delta, pos: tx, t }; }
    for (const ty of [t.y, t.y + t.h / 2, t.y + t.h]) for (const y of ys) { const delta = ty - y; if (Math.abs(delta) <= threshold && (!by || Math.abs(delta) < Math.abs(by.delta))) by = { delta, pos: ty, t }; }
  }
  const dx = bx?.delta ?? 0, dy = by?.delta ?? 0;
  const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const guides: Guide[] = [];
  if (bx) guides.push({ axis: 'x', pos: bx.pos, from: Math.min(moved.y, bx.t.y), to: Math.max(moved.y + moved.h, bx.t.y + bx.t.h) });
  if (by) guides.push({ axis: 'y', pos: by.pos, from: Math.min(moved.x, by.t.x), to: Math.max(moved.x + moved.w, by.t.x + by.t.w) });
  return { dx, dy, guides };
}

export const itemsInRect = (b: Board, r: Box): string[] =>
  b.items.filter((i) => i.type !== 'connector' && !i.locked && i.x < r.x + r.w && i.x + i.w > r.x && i.y < r.y + r.h && i.y + i.h > r.y).map((i) => i.id);

/** Top-level of a selection: drops items whose section is also selected (they move with it). */
export function topLevelIds(b: Board, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => { const item = b.items.find((i) => i.id === id); return !(item?.parent && set.has(item.parent)); });
}

export function stepZOrder(b: Board, id: string, delta: 1 | -1): boolean {
  const index = b.items.findIndex((i) => i.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= b.items.length) return false;
  [b.items[index], b.items[target]] = [b.items[target], b.items[index]];
  return true;
}

/* ---------- starter templates ---------- */

export type BoardTemplate = 'blank' | 'brainstorm' | 'retro' | 'journey' | 'matrix';

export function templateBoard(kind: BoardTemplate, title: string): Board {
  const sections = (names: Array<[string, BoardColor, string[]]>) => names.map(([text, color, notes]) => ({ type: 'section', text, color, notes }));
  const raw: Record<string, unknown> = { title, items: [] };
  if (kind === 'brainstorm') {
    raw.items = [
      { type: 'text', text: 'How might we …?', fontSize: 32, bold: true, x: 0, y: 0 },
      ...sections([['Ideas', 'yellow', ['Idea 1', 'Idea 2', 'Idea 3']], ['Questions', 'blue', ['What do we not know yet?']], ['Next steps', 'green', ['Who does what by when?']]]).map((s, i) => ({ ...s, x: i * 480, y: 80 })),
    ];
  } else if (kind === 'retro') {
    raw.items = [
      ...sections([['Went well', 'green', ['Add what went well']], ['To improve', 'orange', ['Add what to improve']], ['Action items', 'blue', ['Who will do what?']]]).map((s, i) => ({ ...s, x: i * 480, y: 0 })),
    ];
  } else if (kind === 'journey') {
    raw.items = sections([['Awareness', 'purple', ['What triggers the need?']], ['Consideration', 'blue', ['What do they compare?']], ['Purchase', 'green', ['What could block them?']], ['Retention', 'orange', ['What brings them back?']]]);
  } else if (kind === 'matrix') {
    raw.items = [
      { type: 'section', text: 'High impact · Low effort', color: 'green', x: 0, y: 0, w: 420, h: 320 },
      { type: 'section', text: 'High impact · High effort', color: 'orange', x: 450, y: 0, w: 420, h: 320 },
      { type: 'section', text: 'Low impact · Low effort', color: 'blue', x: 0, y: 350, w: 420, h: 320 },
      { type: 'section', text: 'Low impact · High effort', color: 'red', x: 450, y: 350, w: 420, h: 320 },
    ];
  }
  const { board } = normalizeBoard(raw, title);
  return board;
}
