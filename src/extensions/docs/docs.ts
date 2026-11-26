/** Document model of the Docs menu (Google Docs-style): paragraphs with styles, lists and inline formatting,
 * tables with merged cells, images, footnotes, equations, horizontal lines, page breaks, a table of contents,
 * comments and suggested edits (track changes), plus the page setup and header / footer.
 * Pure TypeScript with explicit .ts imports so node tests, agent tools and the editor share exactly one logic. */

export const DOCS_DIR = '.pigry/docs/';
export const DOCS_EXT = '.doc.json';
/** Stands for an image, footnote mark or equation in the plain text of a paragraph. */
export const ATOM = '￼';

export type ParaStyle = 'normal' | 'title' | 'subtitle' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
export type Align = 'left' | 'center' | 'right' | 'justify';
export type ListKind = 'bullet' | 'number' | 'check';
export type PageSize = 'letter' | 'a4' | 'legal' | 'a5' | 'tabloid' | 'executive';

export interface Marks {
  b?: boolean; i?: boolean; u?: boolean; s?: boolean; sup?: boolean; sub?: boolean; code?: boolean;
  color?: string; bg?: string; font?: string; size?: number; link?: string;
  /** Comment ids anchored on this text. */
  c?: string[];
  /** Suggestion id: text suggested for insertion / for deletion. */
  ins?: string; del?: string;
}
export interface TextRun extends Marks { t: string }
export interface ImageRun extends Marks { img: string; w?: number; h?: number; alt?: string }
export interface FootnoteRun extends Marks { fn: string }
export interface EqRun extends Marks { eq: string }
export type Run = TextRun | ImageRun | FootnoteRun | EqRun;

export interface Para {
  type: 'p'; id: string; style?: ParaStyle; align?: Align;
  /** Line spacing as a multiple (1, 1.15, 1.5, 2). */
  lh?: number;
  /** Space before / after the paragraph in points. */
  sb?: number; sa?: number;
  /** Indent level (0.5 inch each) for paragraphs that are not list items. */
  ind?: number;
  list?: ListKind; lvl?: number; checked?: boolean;
  runs: Run[];
}
export interface Cell { paras: Para[]; cs?: number; rs?: number; hidden?: boolean; bg?: string }
export interface Table { type: 'table'; id: string; rows: Cell[][]; widths?: number[] }
export interface Rule { type: 'hr'; id: string }
export interface PageBreak { type: 'pagebreak'; id: string }
export interface Toc { type: 'toc'; id: string }
export type Block = Para | Table | Rule | PageBreak | Toc;

export interface Reply { author: string; at: string; text: string }
export interface Comment { id: string; author: string; at: string; text: string; quote: string; resolved?: boolean; replies: Reply[] }
export interface Suggestion { id: string; kind: 'ins' | 'del'; author: string; at: string }
export interface Footnote { id: string; text: string }
export interface HeaderFooter { text: string; align?: Align }
export interface Margins { top: number; right: number; bottom: number; left: number }
export interface PageSetup { size: PageSize; orientation: 'portrait' | 'landscape'; margins: Margins; color?: string }

export interface Doc {
  kind: 'pigry-doc';
  version: 1;
  title: string;
  page: PageSetup;
  font: { family: string; size: number };
  blocks: Block[];
  comments: Comment[];
  suggestions: Suggestion[];
  footnotes: Footnote[];
  header?: HeaderFooter;
  footer?: HeaderFooter;
  /** No header / footer on the first page. */
  firstPageDifferent?: boolean;
  /** Counter for new ids (b12, c3, s4, f2). */
  seq: number;
}

export interface Pos { b: number; o: number }
export interface Range { from: Pos; to: Pos }

/** Page sizes in inches (portrait). */
export const PAGE_SIZES: Record<PageSize, { w: number; h: number; label: string }> = {
  letter: { w: 8.5, h: 11, label: 'Letter (8.5" x 11")' },
  a4: { w: 8.27, h: 11.69, label: 'A4 (8.27" x 11.69")' },
  legal: { w: 8.5, h: 14, label: 'Legal (8.5" x 14")' },
  a5: { w: 5.83, h: 8.27, label: 'A5 (5.83" x 8.27")' },
  tabloid: { w: 11, h: 17, label: 'Tabloid (11" x 17")' },
  executive: { w: 7.25, h: 10.5, label: 'Executive (7.25" x 10.5")' },
};
export const PARA_STYLES: { id: ParaStyle; label: string }[] = [
  { id: 'normal', label: 'Normal text' }, { id: 'title', label: 'Title' }, { id: 'subtitle', label: 'Subtitle' },
  { id: 'h1', label: 'Heading 1' }, { id: 'h2', label: 'Heading 2' }, { id: 'h3', label: 'Heading 3' },
  { id: 'h4', label: 'Heading 4' }, { id: 'h5', label: 'Heading 5' }, { id: 'h6', label: 'Heading 6' },
];
/** Default look of each paragraph style (Google Docs defaults): size in pt, colour, spacing in pt. */
export const STYLE_LOOK: Record<ParaStyle, { size: number; color?: string; bold?: boolean; italic?: boolean; sb: number; sa: number }> = {
  normal: { size: 11, sb: 0, sa: 0 },
  title: { size: 26, sb: 0, sa: 3 },
  subtitle: { size: 15, color: '#666666', sb: 0, sa: 16 },
  h1: { size: 20, sb: 20, sa: 6 },
  h2: { size: 16, sb: 18, sa: 6 },
  h3: { size: 14, color: '#434343', sb: 16, sa: 4 },
  h4: { size: 12, color: '#666666', sb: 14, sa: 4 },
  h5: { size: 11, color: '#666666', sb: 12, sa: 4 },
  h6: { size: 11, color: '#666666', italic: true, sb: 12, sa: 4 },
};
export const FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New', 'Georgia', 'Garamond', 'Roboto', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Noto Sans Thai', 'Sarabun'];
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
export const MAX_INDENT = 8;

const MARK_KEYS = ['b', 'i', 'u', 's', 'sup', 'sub', 'code', 'color', 'bg', 'font', 'size', 'link', 'c', 'ins', 'del'] as const;
/** Marks that "Clear formatting" removes (links, comments and suggestions stay). */
export const LOOK_KEYS = ['b', 'i', 'u', 's', 'sup', 'sub', 'code', 'color', 'bg', 'font', 'size'] as const;
type MarkKey = typeof MARK_KEYS[number];

export class DocError extends Error {}
const fail = (message: string): never => { throw new DocError(message); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/* ---------------- creating, ids, normalising ---------------- */

export function newId(doc: Doc, prefix: string): string {
  doc.seq = (doc.seq || 0) + 1;
  return `${prefix}${doc.seq}`;
}
export const emptyPara = (id: string, patch: Partial<Para> = {}): Para => ({ type: 'p', id, runs: [], ...patch });

export function emptyDoc(title = 'Untitled document'): Doc {
  return {
    kind: 'pigry-doc', version: 1, title,
    page: { size: 'letter', orientation: 'portrait', margins: { top: 1, right: 1, bottom: 1, left: 1 } },
    font: { family: 'Arial', size: 11 },
    blocks: [emptyPara('b1')], comments: [], suggestions: [], footnotes: [], seq: 1,
  };
}

export interface NormalizeResult { doc: Doc; warnings: string[] }

const str = (v: unknown, max = 100_000): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : undefined);
const COLOR = /^#[0-9a-f]{3,8}$/i;
const color = (v: unknown): string | undefined => (typeof v === 'string' && COLOR.test(v.trim()) ? v.trim().toLowerCase() : undefined);
const STYLES = new Set<string>(PARA_STYLES.map((s) => s.id));
export const ALIGNS_LIST: Align[] = ['left', 'center', 'right', 'justify'];
const ALIGNS = new Set<string>(ALIGNS_LIST);
const LISTS = new Set(['bullet', 'number', 'check']);

function normMarks(src: Record<string, unknown>, out: Marks): void {
  for (const k of ['b', 'i', 'u', 's', 'sup', 'sub', 'code'] as const) if (src[k] === true) out[k] = true;
  const c1 = color(src.color); if (c1) out.color = c1;
  const c2 = color(src.bg); if (c2) out.bg = c2;
  const f = str(src.font, 80); if (f && f.trim()) out.font = f.trim();
  const sz = num(src.size, 1, 400); if (sz !== undefined) out.size = Math.round(sz * 2) / 2;
  const l = str(src.link, 2000); if (l && l.trim()) out.link = l.trim();
  if (Array.isArray(src.c)) { const ids = src.c.filter((x): x is string => typeof x === 'string' && !!x); if (ids.length) out.c = [...new Set(ids)]; }
  const ins = str(src.ins, 40); if (ins) out.ins = ins;
  const del = str(src.del, 40); if (del && !out.ins) out.del = del;
  if (out.sup && out.sub) delete out.sub;
}
function normRun(v: unknown): Run | null {
  if (!isObj(v)) return typeof v === 'string' ? { t: v } : null;
  let run: Run;
  if (typeof v.img === 'string') {
    run = { img: v.img };
    const w = num(v.w, 1, 10000); if (w !== undefined) run.w = Math.round(w);
    const h = num(v.h, 1, 10000); if (h !== undefined) run.h = Math.round(h);
    const alt = str(v.alt, 500); if (alt) run.alt = alt;
  } else if (typeof v.fn === 'string') run = { fn: v.fn };
  else if (typeof v.eq === 'string') run = { eq: v.eq.slice(0, 2000) };
  else if (typeof v.t === 'string') run = { t: v.t.replace(/\r\n?/g, '\n') };
  else return null;
  normMarks(v, run);
  return run;
}
function normPara(v: Record<string, unknown>, id: string): Para {
  const p: Para = { type: 'p', id, runs: [] };
  if (typeof v.style === 'string' && STYLES.has(v.style) && v.style !== 'normal') p.style = v.style as ParaStyle;
  if (typeof v.align === 'string' && ALIGNS.has(v.align) && v.align !== 'left') p.align = v.align as Align;
  const lh = num(v.lh, 0.5, 5); if (lh !== undefined && lh !== 1.15) p.lh = lh;
  const sb = num(v.sb, 0, 200); if (sb !== undefined) p.sb = sb;
  const sa = num(v.sa, 0, 200); if (sa !== undefined) p.sa = sa;
  const ind = num(v.ind, 0, MAX_INDENT); if (ind) p.ind = Math.round(ind);
  if (typeof v.list === 'string' && LISTS.has(v.list)) {
    p.list = v.list as ListKind;
    const lvl = num(v.lvl, 0, MAX_INDENT); if (lvl) p.lvl = Math.round(lvl);
    if (p.list === 'check' && v.checked === true) p.checked = true;
  }
  const runs = Array.isArray(v.runs) ? v.runs.map(normRun).filter((r): r is Run => r !== null) : typeof v.text === 'string' ? [{ t: v.text }] : [];
  p.runs = normalizeRuns(runs);
  return p;
}

export function normalizeDoc(input: unknown, fallbackTitle = 'Untitled document'): NormalizeResult {
  const warnings: string[] = [];
  const doc = emptyDoc(fallbackTitle);
  if (!isObj(input)) {
    if (input !== null && input !== undefined) warnings.push('the file is not a document object; started empty');
    return { doc, warnings };
  }
  doc.title = (str(input.title, 300) ?? fallbackTitle).trim() || fallbackTitle;
  doc.seq = typeof input.seq === 'number' && Number.isFinite(input.seq) ? Math.max(0, Math.floor(input.seq)) : 0;
  if (isObj(input.page)) {
    const pg = input.page;
    if (typeof pg.size === 'string' && pg.size in PAGE_SIZES) doc.page.size = pg.size as PageSize;
    if (pg.orientation === 'landscape') doc.page.orientation = 'landscape';
    if (isObj(pg.margins)) for (const k of ['top', 'right', 'bottom', 'left'] as const) { const m = num(pg.margins[k], 0, 4); if (m !== undefined) doc.page.margins[k] = m; }
    const c = color(pg.color); if (c && c !== '#ffffff') doc.page.color = c;
  }
  if (isObj(input.font)) {
    const f = str(input.font.family, 80); if (f && f.trim()) doc.font.family = f.trim();
    const s = num(input.font.size, 6, 96); if (s !== undefined) doc.font.size = s;
  }
  for (const k of ['header', 'footer'] as const) {
    const hf = input[k];
    if (isObj(hf) && typeof hf.text === 'string' && hf.text.trim()) doc[k] = { text: hf.text.slice(0, 1000), ...(typeof hf.align === 'string' && ALIGNS.has(hf.align) ? { align: hf.align as Align } : {}) };
  }
  if (input.firstPageDifferent === true) doc.firstPageDifferent = true;

  const used = new Set<string>();
  const fresh = (prefix: string, want: unknown): string => {
    if (typeof want === 'string' && /^[a-z][a-z0-9_-]{0,40}$/i.test(want) && !used.has(want)) { used.add(want); return want; }
    let id = '';
    do { id = `${prefix}${++doc.seq}`; } while (used.has(id));
    used.add(id);
    return id;
  };
  const blocks: Block[] = [];
  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : [];
  for (const b of rawBlocks) {
    if (!isObj(b)) { warnings.push('dropped a block that is not an object'); continue; }
    const type = b.type ?? 'p';
    if (type === 'p') blocks.push(normPara(b, fresh('b', b.id)));
    else if (type === 'hr' || type === 'pagebreak' || type === 'toc') blocks.push({ type, id: fresh('b', b.id) } as Block);
    else if (type === 'table') {
      const rowsIn = Array.isArray(b.rows) ? b.rows.filter(Array.isArray) as unknown[][] : [];
      const cols = Math.max(0, ...rowsIn.map((r) => r.length));
      if (!rowsIn.length || !cols) { warnings.push('dropped an empty table'); continue; }
      const rows: Cell[][] = rowsIn.slice(0, 500).map((r) => Array.from({ length: Math.min(cols, 50) }, (_, ci) => {
        const c = isObj(r[ci]) ? r[ci] as Record<string, unknown> : {};
        const paras = Array.isArray(c.paras) ? c.paras.filter(isObj).map((p) => normPara(p, fresh('b', p.id))) : [];
        const cell: Cell = { paras };
        const cs = num(c.cs, 1, 50); if (cs && cs > 1) cell.cs = Math.round(cs);
        const rs = num(c.rs, 1, 500); if (rs && rs > 1) cell.rs = Math.round(rs);
        if (c.hidden === true) cell.hidden = true;
        const bg = color(c.bg); if (bg) cell.bg = bg;
        return cell;
      }));
      const t: Table = { type: 'table', id: fresh('b', b.id), rows };
      if (Array.isArray(b.widths)) { const w = b.widths.map((x) => (typeof x === 'number' && x > 0 ? x : 1)).slice(0, rows[0].length); if (w.length === rows[0].length) t.widths = w; }
      repairMerges(t, warnings);
      for (const row of t.rows) for (const cell of row) {
        if (cell.hidden) cell.paras = [];
        else if (!cell.paras.length) cell.paras = [emptyPara(fresh('b', undefined))];
      }
      blocks.push(t);
    } else warnings.push(`dropped a block of unknown type "${String(type)}"`);
  }
  doc.blocks = blocks.length ? blocks : [emptyPara(fresh('b', undefined))];
  if (!(doc.blocks[doc.blocks.length - 1].type === 'p')) doc.blocks.push(emptyPara(fresh('b', undefined)));

  const isoish = (v: unknown): string => (typeof v === 'string' && v ? v.slice(0, 40) : '');
  doc.comments = (Array.isArray(input.comments) ? input.comments : []).filter(isObj).map((c) => ({
    id: fresh('c', c.id), author: str(c.author, 80) || 'user', at: isoish(c.at), text: str(c.text, 20_000) ?? '', quote: str(c.quote, 400) ?? '',
    ...(c.resolved === true ? { resolved: true } : {}),
    replies: (Array.isArray(c.replies) ? c.replies : []).filter(isObj).map((r) => ({ author: str(r.author, 80) || 'user', at: isoish(r.at), text: str(r.text, 20_000) ?? '' })),
  }));
  doc.suggestions = (Array.isArray(input.suggestions) ? input.suggestions : []).filter(isObj).filter((s) => s.kind === 'ins' || s.kind === 'del').map((s) => ({
    id: fresh('s', s.id), kind: s.kind as 'ins' | 'del', author: str(s.author, 80) || 'user', at: isoish(s.at),
  }));
  doc.footnotes = (Array.isArray(input.footnotes) ? input.footnotes : []).filter(isObj).map((f) => ({ id: fresh('f', f.id), text: str(f.text, 20_000) ?? '' }));
  // Keep the id counter ahead of every id in the file.
  for (const id of used) { const m = /(\d+)$/.exec(id); if (m) doc.seq = Math.max(doc.seq, Number(m[1])); }
  cleanupRefs(doc);
  return { doc, warnings };
}

export function parseDocJson(text: string, fallbackTitle?: string): NormalizeResult {
  try { return normalizeDoc(JSON.parse(text), fallbackTitle); }
  catch { const r = normalizeDoc(null, fallbackTitle); r.warnings = ['the file is not valid JSON; started empty']; return r; }
}
export const serializeDoc = (doc: Doc): string => JSON.stringify(doc) + '\n';

/** Drops suggestions and footnotes nothing refers to, and run marks that refer to nothing. */
export function cleanupRefs(doc: Doc): void {
  const ins = new Set<string>(), del = new Set<string>(), fns = new Set<string>();
  const comments = new Set(doc.comments.map((c) => c.id));
  for (const { para } of textBlocks(doc)) for (const r of para.runs) {
    if (r.ins) ins.add(r.ins);
    if (r.del) del.add(r.del);
    if ('fn' in r) fns.add(r.fn);
    if (r.c) { r.c = r.c.filter((id) => comments.has(id)); if (!r.c.length) delete r.c; }
  }
  const known = new Map(doc.suggestions.map((s) => [s.id, s]));
  for (const id of [...ins, ...del]) if (!known.has(id)) { const s: Suggestion = { id, kind: ins.has(id) ? 'ins' : 'del', author: 'user', at: '' }; known.set(id, s); doc.suggestions.push(s); }
  doc.suggestions = doc.suggestions.filter((s) => (s.kind === 'ins' ? ins.has(s.id) : del.has(s.id)));
  const fnKnown = new Set(doc.footnotes.map((f) => f.id));
  for (const id of fns) if (!fnKnown.has(id)) doc.footnotes.push({ id, text: '' });
  doc.footnotes = doc.footnotes.filter((f) => fns.has(f.id));
}

/** Makes every merged area a proper rectangle with hidden cells under it. */
function repairMerges(t: Table, warnings: string[]): void {
  const R = t.rows.length, C = t.rows[0].length;
  const covered: boolean[][] = t.rows.map((r) => r.map(() => false));
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const cell = t.rows[r][c];
    if (covered[r][c]) { cell.hidden = true; delete cell.cs; delete cell.rs; continue; }
    delete cell.hidden;
    const cs = Math.min(cell.cs ?? 1, C - c), rs = Math.min(cell.rs ?? 1, R - r);
    if (cs > 1) cell.cs = cs; else delete cell.cs;
    if (rs > 1) cell.rs = rs; else delete cell.rs;
    for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) if (i !== r || j !== c) covered[i][j] = true;
  }
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (t.rows[r][c].hidden && !covered[r][c]) { delete t.rows[r][c].hidden; warnings.push('repaired a merged table cell'); }
}

/* ---------------- runs ---------------- */

export const isTextRun = (r: Run): r is TextRun => 't' in r;
export const runLen = (r: Run): number => (isTextRun(r) ? r.t.length : 1);
export const paraLen = (p: Para): number => p.runs.reduce((n, r) => n + runLen(r), 0);
/** Plain text with ATOM for images, footnotes and equations. */
export const paraText = (p: Para): string => p.runs.map((r) => (isTextRun(r) ? r.t : ATOM)).join('');
/** Readable text: equations as their source, images as [image], footnotes dropped; suggested deletions skipped when `final`. */
export function plainText(p: Para, final = false): string {
  return p.runs.map((r) => (final && r.del ? '' : isTextRun(r) ? r.t : 'eq' in r ? r.eq : 'img' in r ? (r.alt ? `[${r.alt}]` : '[image]') : '')).join('');
}

export function marksOf(r: Run): Marks {
  const m: Marks = {};
  for (const k of MARK_KEYS) if (r[k] !== undefined) (m as Record<string, unknown>)[k] = k === 'c' ? [...(r.c ?? [])] : r[k];
  return m;
}
const sameMark = (a: Run, b: Run, k: MarkKey): boolean => (k === 'c' ? (a.c ?? []).join(' ') === (b.c ?? []).join(' ') : a[k] === b[k]);
export const sameMarks = (a: Run, b: Run): boolean => MARK_KEYS.every((k) => sameMark(a, b, k));

/** Merges neighbouring text runs with the same marks and drops empty ones. */
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (isTextRun(r) && !r.t) continue;
    const last = out[out.length - 1];
    if (last && isTextRun(last) && isTextRun(r) && sameMarks(last, r)) { out[out.length - 1] = { ...last, t: last.t + r.t }; continue; }
    out.push(r);
  }
  return out;
}

/** Copies runs and splits them so that a run boundary falls at `offset`; returns the index of the first run at/after it. */
function splitRuns(runs: Run[], offset: number): { runs: Run[]; index: number } {
  const out: Run[] = [];
  let pos = 0, index = -1;
  for (const r of runs) {
    const len = runLen(r);
    if (index < 0 && offset <= pos) index = out.length;
    if (index < 0 && offset > pos && offset < pos + len && isTextRun(r)) {
      const cut = offset - pos;
      out.push({ ...r, t: r.t.slice(0, cut) });
      index = out.length;
      out.push({ ...r, t: r.t.slice(cut) });
    } else out.push({ ...r });
    pos += len;
  }
  if (index < 0) index = out.length;
  return { runs: out, index };
}
export function sliceRuns(runs: Run[], from: number, to: number): Run[] {
  const a = splitRuns(runs, to);
  const b = splitRuns(a.runs.slice(0, a.index), from);
  return b.runs.slice(b.index).map((r) => ({ ...r, ...(r.c ? { c: [...r.c] } : {}) }));
}
/** Maps fn over the runs between two offsets of a paragraph (splitting at the edges). */
function mapRange(p: Para, from: number, to: number, fn: (r: Run) => Run | null): void {
  if (to <= from) return;
  const a = splitRuns(p.runs, from);
  const b = splitRuns(a.runs, to);
  const out: Run[] = [];
  b.runs.forEach((r, i) => {
    if (i >= a.index && i < b.index) { const m = fn(r); if (m) out.push(m); } else out.push(r);
  });
  p.runs = normalizeRuns(out);
}
function insertRunsAt(p: Para, offset: number, runs: Run[]): void {
  const s = splitRuns(p.runs, offset);
  p.runs = normalizeRuns([...s.runs.slice(0, s.index), ...runs, ...s.runs.slice(s.index)]);
}
function deleteInPara(p: Para, from: number, to: number): void { mapRange(p, from, to, () => null); }
/** Marks of the character before `offset` (or after it at the start) — what typed text takes on. */
export function marksAt(p: Para, offset: number): Marks {
  let pos = 0, prev: Run | undefined;
  for (const r of p.runs) {
    const len = runLen(r);
    if (offset > pos && offset <= pos + len) return isTextRun(r) ? marksOf(r) : {};
    if (offset === 0 && pos === 0) prev = r;
    pos += len;
  }
  return prev && isTextRun(prev) ? marksOf(prev) : {};
}

/* ---------------- text blocks and positions ---------------- */

export interface TextBlock { para: Para; top: number; cell?: { r: number; c: number; p: number } }
/** Every paragraph in document order — top-level ones and those in table cells (merged-away cells skipped). */
export function textBlocks(doc: Doc): TextBlock[] {
  const out: TextBlock[] = [];
  doc.blocks.forEach((b, top) => {
    if (b.type === 'p') out.push({ para: b, top });
    else if (b.type === 'table') b.rows.forEach((row, r) => row.forEach((cell, c) => { if (!cell.hidden) cell.paras.forEach((para, p) => out.push({ para, top, cell: { r, c, p } })); }));
  });
  return out;
}
export const cmpPos = (a: Pos, b: Pos): number => a.b - b.b || a.o - b.o;
export const orderRange = (r: Range): Range => (cmpPos(r.from, r.to) <= 0 ? r : { from: r.to, to: r.from });
export const isCollapsed = (r: Range): boolean => r.from.b === r.to.b && r.from.o === r.to.o;
/** Index of the first text block of a top-level block (or of the next one after it). */
export function firstTextBlockOf(doc: Doc, top: number): number {
  const tbs = textBlocks(doc);
  const i = tbs.findIndex((t) => t.top >= top);
  return i < 0 ? tbs.length - 1 : i;
}
function clampPos(doc: Doc, pos: Pos, tbs = textBlocks(doc)): Pos {
  const b = clamp(Math.floor(pos.b), 0, tbs.length - 1);
  return { b, o: clamp(Math.floor(pos.o), 0, paraLen(tbs[b].para)) };
}
const sameContainer = (a: TextBlock, b: TextBlock): boolean => (!a.cell && !b.cell) || (!!a.cell && !!b.cell && a.top === b.top && a.cell.r === b.cell.r && a.cell.c === b.cell.c);
function containerParas(doc: Doc, tb: TextBlock): Para[] | null {
  if (!tb.cell) return null;
  const t = doc.blocks[tb.top] as Table;
  return t.rows[tb.cell.r][tb.cell.c].paras;
}

/** The text between two positions (blocks joined with newlines). */
export function rangeText(doc: Doc, range: Range, final = false): string {
  const { from, to } = orderRange(range);
  const tbs = textBlocks(doc);
  const parts: string[] = [];
  for (let b = from.b; b <= to.b && b < tbs.length; b++) {
    const p = tbs[b].para;
    const runs = sliceRuns(p.runs, b === from.b ? from.o : 0, b === to.b ? to.o : paraLen(p));
    parts.push(plainText({ ...p, runs }, final));
  }
  return parts.join('\n');
}

/* ---------------- editing operations (mutate the doc they get) ---------------- */

/** Applies (or with `null` values removes) marks on a range. */
export function formatRange(doc: Doc, range: Range, patch: Partial<Record<MarkKey, unknown>>): void {
  const { from, to } = orderRange(range);
  const tbs = textBlocks(doc);
  for (let b = from.b; b <= to.b && b < tbs.length; b++) {
    const p = tbs[b].para;
    mapRange(p, b === from.b ? from.o : 0, b === to.b ? to.o : paraLen(p), (r) => {
      const n = { ...r } as Run & Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === false || v === '') delete n[k];
        else n[k] = v;
        if (k === 'sup' && v) delete n.sub;
        if (k === 'sub' && v) delete n.sup;
      }
      return n;
    });
  }
}
/** True when every character in the range already has the mark (what a toolbar toggle checks). */
export function rangeHas(doc: Doc, range: Range, key: MarkKey): boolean {
  const { from, to } = orderRange(range);
  const tbs = textBlocks(doc);
  let any = false;
  for (let b = from.b; b <= to.b && b < tbs.length; b++) {
    const p = tbs[b].para;
    for (const r of sliceRuns(p.runs, b === from.b ? from.o : 0, b === to.b ? to.o : paraLen(p))) { any = true; if (!r[key]) return false; }
  }
  return any;
}
export function toggleMark(doc: Doc, range: Range, key: 'b' | 'i' | 'u' | 's' | 'sup' | 'sub' | 'code'): void {
  formatRange(doc, range, { [key]: rangeHas(doc, range, key) ? null : true });
}
export function clearFormatting(doc: Doc, range: Range): void {
  formatRange(doc, range, Object.fromEntries(LOOK_KEYS.map((k) => [k, null])));
}

export type ParaPatch = { style?: ParaStyle; align?: Align | null; lh?: number | null; sb?: number | null; sa?: number | null; ind?: number | null; list?: ListKind | null; lvl?: number | null; checked?: boolean | null };
export function setParaProps(p: Para, patch: ParaPatch): void {
  const rec = p as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || (k === 'style' && v === 'normal') || (k === 'align' && v === 'left') || ((k === 'ind' || k === 'lvl') && v === 0) || (k === 'checked' && v === false)) delete rec[k];
    else rec[k] = k === 'ind' || k === 'lvl' ? clamp(Math.round(v as number), 0, MAX_INDENT) : v;
  }
  if (!p.list) { delete p.lvl; delete p.checked; }
  if (p.list !== 'check') delete p.checked;
}
/** Paragraphs touched by a range (text-block indices). */
export function parasIn(doc: Doc, range: Range): Para[] {
  const { from, to } = orderRange(range);
  return textBlocks(doc).slice(from.b, to.b + 1).map((t) => t.para);
}
/** Turns a list on for the paragraphs, or off when all of them already are that kind of list. */
export function toggleList(doc: Doc, range: Range, kind: ListKind): void {
  const ps = parasIn(doc, range);
  const off = ps.every((p) => p.list === kind);
  for (const p of ps) setParaProps(p, off ? { list: null } : { list: kind, lvl: p.list ? p.lvl ?? 0 : p.ind ?? 0, ind: null });
}
export function indent(doc: Doc, range: Range, delta: 1 | -1): void {
  for (const p of parasIn(doc, range)) {
    if (p.list) setParaProps(p, { lvl: (p.lvl ?? 0) + delta });
    else setParaProps(p, { ind: (p.ind ?? 0) + delta });
  }
}

/** Inserts text (with marks) at a position; "\n" inside becomes a soft line break. Returns the position after it. */
export function insertText(doc: Doc, pos: Pos, text: string, marks?: Marks): Pos {
  const tbs = textBlocks(doc);
  const at = clampPos(doc, pos, tbs);
  const p = tbs[at.b].para;
  const m = marks ?? marksAt(p, at.o);
  if (!marks) { delete m.ins; delete m.del; }
  if (!text) return at;
  insertRunsAt(p, at.o, [{ ...m, t: text }]);
  return { b: at.b, o: at.o + text.length };
}
export function insertInline(doc: Doc, pos: Pos, run: Run): Pos {
  const tbs = textBlocks(doc);
  const at = clampPos(doc, pos, tbs);
  insertRunsAt(tbs[at.b].para, at.o, [run]);
  return { b: at.b, o: at.o + runLen(run) };
}

/** Splits the paragraph at a position (Enter). A new paragraph after a heading is Normal text; lists continue;
 * Enter in an empty list item ends the list (or outdents a nested one). Returns the caret position after. */
export function splitPara(doc: Doc, pos: Pos): Pos {
  const tbs = textBlocks(doc);
  const at = clampPos(doc, pos, tbs);
  const tb = tbs[at.b];
  const p = tb.para;
  if (p.list && paraLen(p) === 0) {
    if ((p.lvl ?? 0) > 0) setParaProps(p, { lvl: (p.lvl ?? 0) - 1 }); else setParaProps(p, { list: null });
    return at;
  }
  const s = splitRuns(p.runs, at.o);
  const left = normalizeRuns(s.runs.slice(0, s.index)), right = normalizeRuns(s.runs.slice(s.index));
  const next: Para = { ...p, id: newId(doc, 'b'), runs: right };
  if (next.checked) delete next.checked;
  if (at.o >= paraLen(p) && p.style && p.style !== 'normal') { delete next.style; delete next.sb; delete next.sa; }
  p.runs = left;
  const paras = containerParas(doc, tb);
  if (paras) paras.splice(paras.indexOf(p) + 1, 0, next);
  else doc.blocks.splice(tb.top + 1, 0, next);
  return { b: at.b + 1, o: 0 };
}

/** Deletes a range. Within one container (the body or one table cell) the paragraphs at the ends are joined and
 * whole blocks between them removed; across containers only the text is cleared. Returns the start position. */
export function deleteRange(doc: Doc, range: Range): Pos {
  const { from, to } = orderRange(range);
  if (isCollapsed({ from, to })) return from;
  const tbs = textBlocks(doc);
  const a = tbs[from.b], z = tbs[to.b];
  if (!a || !z) return from;
  if (from.b === to.b) { deleteInPara(a.para, from.o, to.o); return from; }
  if (sameContainer(a, z)) {
    const tail = sliceRuns(z.para.runs, to.o, paraLen(z.para));
    deleteInPara(a.para, from.o, paraLen(a.para));
    a.para.runs = normalizeRuns([...a.para.runs, ...tail]);
    const paras = containerParas(doc, a);
    if (paras) paras.splice(paras.indexOf(a.para) + 1, paras.indexOf(z.para) - paras.indexOf(a.para));
    else doc.blocks.splice(a.top + 1, z.top - a.top);
    return from;
  }
  for (let b = from.b; b <= to.b; b++) {
    const p = tbs[b].para;
    deleteInPara(p, b === from.b ? from.o : 0, b === to.b ? to.o : paraLen(p));
  }
  return from;
}

/** Pastes blocks at a position: a single paragraph goes inline; several are spliced in (the first joins the text
 * before the caret, the last the text after it). Tables can't go into tables — they land after the table.
 * Returns the position after the inserted content. */
export function insertFragment(doc: Doc, pos: Pos, blocks: Block[]): Pos {
  if (!blocks.length) return pos;
  let tbs = textBlocks(doc);
  let at = clampPos(doc, pos, tbs);
  const tb = tbs[at.b];
  if (blocks.length === 1 && blocks[0].type === 'p') {
    const runs = blocks[0].runs.map((r) => ({ ...r }));
    insertRunsAt(tb.para, at.o, runs);
    const p0 = blocks[0];
    if (paraLen(tb.para) === runs.reduce((n, r) => n + runLen(r), 0)) setParaProps(tb.para, { style: p0.style ?? 'normal', list: p0.list ?? null, lvl: p0.lvl ?? null });
    return { b: at.b, o: at.o + runs.reduce((n, r) => n + runLen(r), 0) };
  }
  const fresh = blocks.map((b) => reId(doc, b));
  if (tb.cell) {
    if (fresh.some((b) => b.type !== 'p')) {
      // Leave the table: insert after it.
      doc.blocks.splice(tb.top + 1, 0, ...fresh);
      ensureTrailingPara(doc);
      tbs = textBlocks(doc);
      return { b: lastTextBlockBefore(doc, tbs, tb.top + 1 + fresh.length), o: 0 };
    }
    const paras = containerParas(doc, tb)!;
    const after = splitPara(doc, at);
    const right = paras[paras.indexOf(tb.para) + 1];
    paras.splice(paras.indexOf(right), 0, ...(fresh as Para[]));
    joinEdges(tb.para, right, paras, fresh as Para[]);
    void after;
    tbs = textBlocks(doc);
    const lastIdx = tbs.findIndex((t) => t.para === (fresh[fresh.length - 1] as Para));
    return lastIdx >= 0 ? { b: lastIdx, o: paraLen(tbs[lastIdx].para) } : at;
  }
  // Body: split the paragraph and splice the blocks in between.
  const leftEmpty = paraLen(tb.para) === 0;
  splitPara(doc, at);
  const right = doc.blocks[tb.top + 1] as Para;
  doc.blocks.splice(tb.top + 1, 0, ...fresh);
  const first = fresh[0], last = fresh[fresh.length - 1];
  if (first.type === 'p' && !leftEmpty) { tb.para.runs = normalizeRuns([...tb.para.runs, ...first.runs]); doc.blocks.splice(doc.blocks.indexOf(first), 1); }
  else if (leftEmpty) doc.blocks.splice(doc.blocks.indexOf(tb.para), 1);
  let caretPara: Para;
  if (last.type === 'p' && last !== first) { const len = paraLen(last); last.runs = normalizeRuns([...last.runs, ...right.runs]); doc.blocks.splice(doc.blocks.indexOf(right), 1); caretPara = last; at = { b: 0, o: len }; }
  else { caretPara = right; at = { b: 0, o: 0 }; }
  ensureTrailingPara(doc);
  tbs = textBlocks(doc);
  const idx = tbs.findIndex((t) => t.para === caretPara);
  return { b: Math.max(0, idx), o: idx >= 0 ? at.o : 0 };
}
function joinEdges(left: Para, right: Para, paras: Para[], fresh: Para[]): void {
  const first = fresh[0], last = fresh[fresh.length - 1];
  if (paraLen(left) > 0 || paras.indexOf(left) > 0) { left.runs = normalizeRuns([...left.runs, ...first.runs]); paras.splice(paras.indexOf(first), 1); }
  if (last !== first) { last.runs = normalizeRuns([...last.runs, ...right.runs]); paras.splice(paras.indexOf(right), 1); }
}
function lastTextBlockBefore(doc: Doc, tbs: TextBlock[], top: number): number {
  let idx = 0;
  tbs.forEach((t, i) => { if (t.top < top) idx = i; });
  void doc;
  return idx;
}
/** Gives a block (and everything in it) new ids from the document's counter. */
export function reId<T extends Block>(doc: Doc, block: T): T {
  const b = structuredClone(block);
  b.id = newId(doc, 'b');
  if (b.type === 'table') for (const row of b.rows) for (const cell of row) for (const p of cell.paras) p.id = newId(doc, 'b');
  return b;
}
export function ensureTrailingPara(doc: Doc): void {
  if (!doc.blocks.length || doc.blocks[doc.blocks.length - 1].type !== 'p') doc.blocks.push(emptyPara(newId(doc, 'b')));
}

/** Inserts a non-text block (table, line, page break, contents) at the caret: the paragraph is split there. */
export function insertBlockAt(doc: Doc, pos: Pos, block: Block): Pos {
  const tbs = textBlocks(doc);
  const at = clampPos(doc, pos, tbs);
  const tb = tbs[at.b];
  const b = reId(doc, block);
  let index: number;
  if (tb.cell) index = tb.top + 1;
  else if (at.o === 0 && paraLen(tb.para) > 0) index = tb.top;
  else if (at.o >= paraLen(tb.para)) index = tb.top + 1;
  else { splitPara(doc, at); index = tb.top + 1; }
  if (!tb.cell && paraLen(tb.para) === 0 && at.o === 0 && b.type !== 'pagebreak') { doc.blocks.splice(tb.top, 1, b); index = tb.top; }
  else doc.blocks.splice(index, 0, b);
  if (index + 1 >= doc.blocks.length || doc.blocks[index + 1].type !== 'p') doc.blocks.splice(index + 1, 0, emptyPara(newId(doc, 'b')));
  const after = textBlocks(doc).findIndex((t) => t.top > index);
  return { b: after < 0 ? 0 : after, o: 0 };
}

/* ---------------- tables ---------------- */

export function makeTable(doc: Doc, rows: number, cols: number, data?: string[][]): Table {
  const R = clamp(Math.floor(rows), 1, 500), C = clamp(Math.floor(cols), 1, 50);
  return {
    type: 'table', id: newId(doc, 'b'),
    rows: Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => {
      const text = data?.[r]?.[c];
      return { paras: [emptyPara(newId(doc, 'b'), text ? { runs: [{ t: String(text) }] } : {})] };
    })),
  };
}
const newCell = (doc: Doc): Cell => ({ paras: [emptyPara(newId(doc, 'b'))] });
/** The top-left cell of the merged area covering (r, c). */
export function anchorOf(t: Table, r: number, c: number): { r: number; c: number } {
  if (!t.rows[r]?.[c]?.hidden) return { r, c };
  for (let i = r; i >= 0; i--) for (let j = c; j >= 0; j--) {
    const cell = t.rows[i][j];
    if (!cell.hidden && i + (cell.rs ?? 1) > r && j + (cell.cs ?? 1) > c) return { r: i, c: j };
  }
  return { r, c };
}
const tableAt = (doc: Doc, top: number): Table => { const t = doc.blocks[top]; if (!t || t.type !== 'table') return fail('that block is not a table'); return t as Table; };

export function tableInsertRow(doc: Doc, top: number, at: number): void {
  const t = tableAt(doc, top);
  const R = t.rows.length, C = t.rows[0].length;
  const r0 = clamp(Math.floor(at), 0, R);
  const row: Cell[] = [];
  for (let c = 0; c < C; c++) {
    const cell = newCell(doc);
    if (r0 > 0 && r0 < R) {
      const a = anchorOf(t, r0, c);
      if (a.r < r0) { const anchor = t.rows[a.r][a.c]; if (a.c === c) anchor.rs = (anchor.rs ?? 1) + 1; cell.hidden = true; cell.paras = []; }
    }
    row.push(cell);
  }
  t.rows.splice(r0, 0, row);
}
export function tableDeleteRow(doc: Doc, top: number, r: number): void {
  const t = tableAt(doc, top);
  if (r < 0 || r >= t.rows.length) fail(`row ${r + 1} does not exist`);
  if (t.rows.length === 1) { doc.blocks.splice(top, 1); ensureTrailingPara(doc); if (!doc.blocks.some((b) => b.type === 'p')) doc.blocks.push(emptyPara(newId(doc, 'b'))); return; }
  const C = t.rows[0].length;
  for (let c = 0; c < C; c++) {
    const cell = t.rows[r][c];
    if (!cell.hidden && (cell.rs ?? 1) > 1) {
      const below = t.rows[r + 1][c];
      delete below.hidden;
      if ((cell.rs ?? 1) - 1 > 1) below.rs = (cell.rs ?? 1) - 1;
      if (cell.cs) below.cs = cell.cs;
      below.paras = cell.paras; if (cell.bg) below.bg = cell.bg;
    } else if (cell.hidden) {
      const a = anchorOf(t, r, c);
      if (a.r < r && a.c === c) { const anchor = t.rows[a.r][a.c]; anchor.rs = (anchor.rs ?? 1) - 1; if (anchor.rs <= 1) delete anchor.rs; }
    }
  }
  t.rows.splice(r, 1);
}
export function tableInsertCol(doc: Doc, top: number, at: number): void {
  const t = tableAt(doc, top);
  const C = t.rows[0].length;
  if (C >= 50) fail('a table can have at most 50 columns');
  const c0 = clamp(Math.floor(at), 0, C);
  t.rows.forEach((row, r) => {
    const cell = newCell(doc);
    if (c0 > 0 && c0 < C) {
      const a = anchorOf(t, r, c0);
      if (a.c < c0) { const anchor = t.rows[a.r][a.c]; if (a.r === r) anchor.cs = (anchor.cs ?? 1) + 1; cell.hidden = true; cell.paras = []; }
    }
    row.splice(c0, 0, cell);
  });
  if (t.widths) t.widths.splice(c0, 0, t.widths[Math.min(c0, t.widths.length - 1)] ?? 1);
}
export function tableDeleteCol(doc: Doc, top: number, c: number): void {
  const t = tableAt(doc, top);
  if (c < 0 || c >= t.rows[0].length) fail(`column ${c + 1} does not exist`);
  if (t.rows[0].length === 1) { doc.blocks.splice(top, 1); ensureTrailingPara(doc); return; }
  t.rows.forEach((row, r) => {
    const cell = row[c];
    if (!cell.hidden && (cell.cs ?? 1) > 1) {
      const right = row[c + 1];
      delete right.hidden;
      if ((cell.cs ?? 1) - 1 > 1) right.cs = (cell.cs ?? 1) - 1;
      if (cell.rs) right.rs = cell.rs;
      right.paras = cell.paras; if (cell.bg) right.bg = cell.bg;
    } else if (cell.hidden) {
      const a = anchorOf(t, r, c);
      if (a.c < c && a.r === r) { const anchor = t.rows[a.r][a.c]; anchor.cs = (anchor.cs ?? 1) - 1; if (anchor.cs <= 1) delete anchor.cs; }
    }
  });
  t.rows.forEach((row) => row.splice(c, 1));
  if (t.widths) t.widths.splice(c, 1);
}
/** Merges a rectangle of cells (grown to include any merged area it cuts). Text of the merged cells is kept. */
export function tableMerge(doc: Doc, top: number, r1: number, c1: number, r2: number, c2: number): void {
  const t = tableAt(doc, top);
  const R = t.rows.length, C = t.rows[0].length;
  let a = { r1: clamp(Math.min(r1, r2), 0, R - 1), c1: clamp(Math.min(c1, c2), 0, C - 1), r2: clamp(Math.max(r1, r2), 0, R - 1), c2: clamp(Math.max(c1, c2), 0, C - 1) };
  for (let grow = true, guard = 0; grow && guard < 100; guard++) {
    grow = false;
    for (let r = a.r1; r <= a.r2; r++) for (let c = a.c1; c <= a.c2; c++) {
      const an = anchorOf(t, r, c), cell = t.rows[an.r][an.c];
      const b = { r1: Math.min(a.r1, an.r), c1: Math.min(a.c1, an.c), r2: Math.max(a.r2, an.r + (cell.rs ?? 1) - 1), c2: Math.max(a.c2, an.c + (cell.cs ?? 1) - 1) };
      if (b.r1 !== a.r1 || b.c1 !== a.c1 || b.r2 !== a.r2 || b.c2 !== a.c2) { a = b; grow = true; }
    }
  }
  if (a.r1 === a.r2 && a.c1 === a.c2) fail('select at least two cells to merge');
  const anchor = t.rows[a.r1][a.c1];
  const paras: Para[] = [];
  for (let r = a.r1; r <= a.r2; r++) for (let c = a.c1; c <= a.c2; c++) {
    const cell = t.rows[r][c];
    if (!cell.hidden) for (const p of cell.paras) if (paraLen(p) > 0) paras.push(p);
    if (r !== a.r1 || c !== a.c1) { cell.hidden = true; delete cell.cs; delete cell.rs; cell.paras = []; }
  }
  anchor.paras = paras.length ? paras : [emptyPara(newId(doc, 'b'))];
  if (a.c2 > a.c1) anchor.cs = a.c2 - a.c1 + 1; else delete anchor.cs;
  if (a.r2 > a.r1) anchor.rs = a.r2 - a.r1 + 1; else delete anchor.rs;
}
export function tableUnmerge(doc: Doc, top: number, r: number, c: number): void {
  const t = tableAt(doc, top);
  const a = anchorOf(t, r, c);
  const cell = t.rows[a.r][a.c];
  if (!cell.cs && !cell.rs) fail('that cell is not merged');
  for (let i = a.r; i < a.r + (cell.rs ?? 1); i++) for (let j = a.c; j < a.c + (cell.cs ?? 1); j++) {
    const x = t.rows[i][j];
    delete x.hidden;
    if (!x.paras.length) x.paras = [emptyPara(newId(doc, 'b'))];
  }
  delete cell.cs; delete cell.rs;
}
/** Where a position is inside a table: the table's block index and the cell. */
export function cellAtPos(doc: Doc, pos: Pos): { top: number; r: number; c: number } | null {
  const tb = textBlocks(doc)[pos.b];
  return tb?.cell ? { top: tb.top, r: tb.cell.r, c: tb.cell.c } : null;
}

/* ---------------- comments ---------------- */

export function addComment(doc: Doc, range: Range, text: string, author: string, now: string): string {
  const r = orderRange(range);
  if (isCollapsed(r)) fail('select the text to comment on');
  if (!text.trim()) fail('the comment is empty');
  const id = newId(doc, 'c');
  const quote = rangeText(doc, r).slice(0, 200);
  const tbs = textBlocks(doc);
  for (let b = r.from.b; b <= r.to.b && b < tbs.length; b++) {
    const p = tbs[b].para;
    mapRange(p, b === r.from.b ? r.from.o : 0, b === r.to.b ? r.to.o : paraLen(p), (run) => ({ ...run, c: [...(run.c ?? []), id] }));
  }
  doc.comments.push({ id, author, at: now, text: text.trim(), quote, replies: [] });
  return id;
}
const commentById = (doc: Doc, id: string): Comment => doc.comments.find((c) => c.id === id) ?? fail(`no comment "${id}"`);
export function replyComment(doc: Doc, id: string, text: string, author: string, now: string): void {
  if (!text.trim()) fail('the reply is empty');
  const c = commentById(doc, id);
  c.replies.push({ author, at: now, text: text.trim() });
  if (c.resolved) delete c.resolved;
}
export function resolveComment(doc: Doc, id: string, resolved = true): void {
  const c = commentById(doc, id);
  if (resolved) c.resolved = true; else delete c.resolved;
}
export function deleteComment(doc: Doc, id: string): void {
  commentById(doc, id);
  doc.comments = doc.comments.filter((c) => c.id !== id);
  cleanupRefs(doc);
}
/** Comments in the order their text appears (comments whose text was deleted come last). */
export function orderedComments(doc: Doc): Comment[] {
  const order = new Map<string, number>();
  let n = 0;
  for (const { para } of textBlocks(doc)) for (const r of para.runs) for (const id of r.c ?? []) if (!order.has(id)) order.set(id, n++);
  return [...doc.comments].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
}

/* ---------------- suggestions (track changes) ---------------- */

/** Inserts text as a suggestion (shown as an insertion until it is accepted or rejected). */
export function suggestInsert(doc: Doc, pos: Pos, text: string, author: string, now: string, id?: string): { id: string; pos: Pos } {
  if (!text) fail('nothing to insert');
  const sid = id ?? newId(doc, 's');
  if (!doc.suggestions.some((s) => s.id === sid)) doc.suggestions.push({ id: sid, kind: 'ins', author, at: now });
  const tbs = textBlocks(doc);
  const at = clampPos(doc, pos, tbs);
  const m = marksAt(tbs[at.b].para, at.o);
  delete m.del; delete m.c;
  const end = insertText(doc, at, text, { ...m, ins: sid });
  return { id: sid, pos: end };
}
/** Marks a range as suggested for deletion. Text that is itself a pending insertion is simply removed. */
export function suggestDelete(doc: Doc, range: Range, author: string, now: string, id?: string): string {
  const r = orderRange(range);
  if (isCollapsed(r)) fail('nothing to delete');
  const sid = id ?? newId(doc, 's');
  const tbs = textBlocks(doc);
  for (let b = r.from.b; b <= r.to.b && b < tbs.length; b++) {
    const p = tbs[b].para;
    mapRange(p, b === r.from.b ? r.from.o : 0, b === r.to.b ? r.to.o : paraLen(p), (run) => (run.ins ? null : run.del ? run : { ...run, del: sid }));
  }
  if (!doc.suggestions.some((s) => s.id === sid)) doc.suggestions.push({ id: sid, kind: 'del', author, at: now });
  cleanupRefs(doc);
  return sid;
}
function resolveSuggestions(doc: Doc, which: string | 'all', accept: boolean): number {
  const ids = new Set(which === 'all' ? doc.suggestions.map((s) => s.id) : [which]);
  if (which !== 'all' && !doc.suggestions.some((s) => s.id === which)) fail(`no suggestion "${which}"`);
  for (const { para } of textBlocks(doc)) {
    para.runs = normalizeRuns(para.runs.flatMap((r) => {
      if (r.ins && ids.has(r.ins)) { if (!accept) return []; const n = { ...r }; delete n.ins; return [n]; }
      if (r.del && ids.has(r.del)) { if (accept) return []; const n = { ...r }; delete n.del; return [n]; }
      return [r];
    }));
  }
  const before = doc.suggestions.length;
  doc.suggestions = doc.suggestions.filter((s) => !ids.has(s.id));
  cleanupRefs(doc);
  return before - doc.suggestions.length;
}
export const acceptSuggestion = (doc: Doc, which: string | 'all'): number => resolveSuggestions(doc, which, true);
export const rejectSuggestion = (doc: Doc, which: string | 'all'): number => resolveSuggestions(doc, which, false);
export interface SuggestionView extends Suggestion { text: string; block: number }
/** Pending suggestions in document order, with the text they add or remove. */
export function listSuggestions(doc: Doc): SuggestionView[] {
  const map = new Map<string, SuggestionView>();
  const meta = new Map(doc.suggestions.map((s) => [s.id, s]));
  for (const { para, top } of textBlocks(doc)) for (const r of para.runs) {
    const id = r.ins ?? r.del;
    if (!id) continue;
    const s = meta.get(id);
    if (!s) continue;
    const v = map.get(id) ?? { ...s, text: '', block: top };
    v.text += isTextRun(r) ? r.t : 'eq' in r ? r.eq : 'img' in r ? '[image]' : '';
    map.set(id, v);
  }
  return [...map.values()];
}

/* ---------------- find and replace ---------------- */

export interface FindOptions { matchCase?: boolean; wholeWord?: boolean; regex?: boolean }
export function findAll(doc: Doc, query: string, opts: FindOptions = {}, limit = 5000): Range[] {
  if (!query) return [];
  let re: RegExp;
  try {
    const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])` : src, `g${opts.matchCase ? '' : 'i'}u`);
  } catch (e) { return fail(`bad regular expression: ${e instanceof Error ? e.message : String(e)}`); }
  const out: Range[] = [];
  textBlocks(doc).forEach(({ para }, b) => {
    const text = paraText(para);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.length < limit) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push({ from: { b, o: m.index }, to: { b, o: m.index + m[0].length } });
    }
  });
  return out;
}
/** Replaces the text of a range inside one paragraph; the new text takes the marks of the first replaced character. */
export function replaceRange(doc: Doc, range: Range, text: string): Range {
  const r = orderRange(range);
  const tbs = textBlocks(doc);
  const p = tbs[r.from.b]?.para;
  if (!p || r.from.b !== r.to.b) fail('replace works inside one paragraph');
  const m = marksAt(p, r.from.o + 1);
  deleteInPara(p, r.from.o, r.to.o);
  if (text) insertRunsAt(p, r.from.o, [{ ...m, t: text }]);
  return { from: r.from, to: { b: r.from.b, o: r.from.o + text.length } };
}
/** Replaces every match; with regex, $1… in the replacement refer to groups. Returns how many were replaced. */
export function replaceAll(doc: Doc, query: string, replacement: string, opts: FindOptions = {}): number {
  const matches = findAll(doc, query, opts, 100_000);
  const tbs = textBlocks(doc);
  const re = opts.regex ? new RegExp(query, opts.matchCase ? 'u' : 'iu') : null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const found = paraText(tbs[m.from.b].para).slice(m.from.o, m.to.o);
    replaceRange(doc, m, re ? found.replace(re, replacement) : replacement);
  }
  return matches.length;
}

/* ---------------- outline, numbering, statistics ---------------- */

export interface OutlineItem { level: number; text: string; top: number; id: string; style: ParaStyle }
const HEADING_LEVEL: Partial<Record<ParaStyle, number>> = { title: 0, h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
export function outline(doc: Doc): OutlineItem[] {
  const out: OutlineItem[] = [];
  doc.blocks.forEach((b, top) => {
    if (b.type !== 'p' || !b.style || HEADING_LEVEL[b.style] === undefined) return;
    const text = plainText(b, true).trim();
    if (text) out.push({ level: HEADING_LEVEL[b.style]!, text, top, id: b.id, style: b.style });
  });
  return out;
}

const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const roman = (n: number): string => { let s = ''; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
const alpha = (n: number): string => { let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
export const BULLETS = ['●', '○', '■'];
export function numberLabel(n: number, lvl: number): string {
  const k = lvl % 3;
  return `${k === 0 ? n : k === 1 ? alpha(n) : roman(n)}.`;
}
/** The marker of every list paragraph in a run of blocks ("1.", "a.", "●", "☐"), keyed by the paragraph. */
export function listLabels(paras: Para[]): Map<Para, string> {
  const out = new Map<Para, string>();
  let counters: number[] = [];
  for (const p of paras) {
    if (!p.list) { counters = []; continue; }
    const lvl = p.lvl ?? 0;
    counters = counters.slice(0, lvl + 1);
    if (p.list === 'number') {
      while (counters.length <= lvl) counters.push(0);
      counters[lvl]++;
      out.set(p, numberLabel(counters[lvl], lvl));
    } else {
      counters.length = Math.min(counters.length, lvl);
      out.set(p, p.list === 'check' ? (p.checked ? '☑' : '☐') : BULLETS[lvl % 3]);
    }
  }
  return out;
}
/** List labels for the whole document (top-level runs of paragraphs and each table cell separately). */
export function docListLabels(doc: Doc): Map<Para, string> {
  const out = new Map<Para, string>();
  const body: Para[] = [];
  const flush = () => { for (const [k, v] of listLabels(body)) out.set(k, v); body.length = 0; };
  for (const b of doc.blocks) {
    if (b.type === 'p') { body.push(b); continue; }
    flush();
    if (b.type === 'table') for (const row of b.rows) for (const cell of row) for (const [k, v] of listLabels(cell.paras)) out.set(k, v);
  }
  flush();
  return out;
}

type SegmenterCtor = new (locale?: string, opts?: { granularity: 'word' }) => { segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }> };
const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
let segmenter: InstanceType<SegmenterCtor> | null = null;
/** Words in a text — Intl.Segmenter splits Thai and other languages written without spaces. */
export function countWords(text: string): number {
  if (!text.trim()) return 0;
  if (Segmenter) {
    segmenter ??= new Segmenter(undefined, { granularity: 'word' });
    let n = 0;
    for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
    return n;
  }
  return text.trim().split(/\s+/).length;
}
export interface DocStats { words: number; characters: number; charactersNoSpaces: number; paragraphs: number; tables: number; images: number; comments: number; suggestions: number }
export function docStats(doc: Doc, range?: Range): DocStats {
  const tbs = textBlocks(doc);
  const r = range ? orderRange(range) : null;
  let text = '', paragraphs = 0, images = 0;
  tbs.forEach(({ para }, b) => {
    if (r && (b < r.from.b || b > r.to.b)) return;
    const runs = r ? sliceRuns(para.runs, b === r.from.b ? r.from.o : 0, b === r.to.b ? r.to.o : paraLen(para)) : para.runs;
    const t = plainText({ ...para, runs }, true);
    images += runs.filter((x) => 'img' in x && !x.del).length;
    if (t.trim()) paragraphs++;
    text += t + '\n';
  });
  const body = text.replace(/\n$/, '');
  return {
    words: countWords(body), characters: body.replace(/\n/g, '').length, charactersNoSpaces: body.replace(/\s/g, '').length,
    paragraphs, tables: doc.blocks.filter((b) => b.type === 'table').length, images,
    comments: doc.comments.filter((c) => !c.resolved).length, suggestions: doc.suggestions.length,
  };
}

/** Footnote numbers in the order their marks appear. */
export function footnoteNumbers(doc: Doc): Map<string, number> {
  const out = new Map<string, number>();
  for (const { para } of textBlocks(doc)) for (const r of para.runs) if ('fn' in r && !out.has(r.fn)) out.set(r.fn, out.size + 1);
  return out;
}

/** Page size in inches with the orientation applied. */
export function pageInches(page: PageSetup): { w: number; h: number } {
  const s = PAGE_SIZES[page.size];
  return page.orientation === 'landscape' ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}
/** Header / footer text with {page}, {pages}, {title} and {date} filled in. */
export function fillFields(text: string, ctx: { page: number; pages: number; title: string; date: string }): string {
  return text.replace(/\{(page|pages|title|date)\}/gi, (_, k: string) => String(ctx[k.toLowerCase() as keyof typeof ctx]));
}

/* ---------------- pagination ---------------- */

export interface LayoutItem { top: number; height: number; pageBreak?: boolean }
/** Splits a column of blocks into pages. `top`/`height` are measured without any page gaps; `contentH` is the text
 * height of a page and `stride` the distance from one page's text to the next (page height + gap). Returns the
 * extra space to put before each block so it starts on the next page, and the number of pages. A block taller
 * than a page is not moved (it runs over the gap). */
export function paginate(items: LayoutItem[], contentH: number, stride: number): { pushes: number[]; pages: number } {
  const pushes: number[] = [];
  let shift = 0, page = 0, forceNext = false, bottom = 0;
  for (const it of items) {
    const y = it.top + shift;
    const pageTop = page * stride;
    let push = 0;
    if (forceNext || (y + it.height > pageTop + contentH + 0.5 && y > pageTop + 0.5 && it.height <= contentH)) {
      let next = page + 1;
      while (!forceNext && y >= (next) * stride) next++;
      const target = next * stride;
      push = Math.max(0, target - y);
      shift += push;
      page = next;
      forceNext = false;
    } else if (y >= (page + 1) * stride) page = Math.floor(y / stride);
    pushes.push(push);
    bottom = it.top + shift + it.height;
    if (it.pageBreak) forceNext = true;
  }
  const pages = Math.max(page + (forceNext ? 2 : 1), Math.floor(Math.max(0, bottom - 1) / stride) + 1);
  return { pushes, pages };
}

/** The word around a position (Intl.Segmenter, so Thai works), or null when the caret is not in a word. */
export function wordRangeAt(doc: Doc, pos: Pos): Range | null {
  const tb = textBlocks(doc)[pos.b];
  if (!tb) return null;
  const text = paraText(tb.para);
  if (Segmenter) {
    segmenter ??= new Segmenter(undefined, { granularity: 'word' });
    let at = 0;
    for (const s of segmenter.segment(text)) {
      const end = at + s.segment.length;
      if (s.isWordLike && pos.o > at && pos.o < end) return { from: { b: pos.b, o: at }, to: { b: pos.b, o: end } };
      at = end;
    }
    return null;
  }
  const isW = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
  if (!isW(text[pos.o - 1]) || !isW(text[pos.o])) return null;
  let a = pos.o, z = pos.o;
  while (isW(text[a - 1])) a--;
  while (isW(text[z])) z++;
  return { from: { b: pos.b, o: a }, to: { b: pos.b, o: z } };
}
