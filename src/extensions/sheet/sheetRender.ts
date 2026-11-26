/** Drawing for the Sheet menu: row/column geometry, conditional formatting, the canvas grid (shared by the editor
 * and the agent's sheet_preview image) and charts as SVG. No React here. */
import { addr, inRect, isErr, parseRect, shiftFormula, type Rect, type Scalar } from './formula.ts';
import type { Engine } from './engine.ts';
import { toBool } from './functions.ts';
import {
  DEFAULT_COL_W, DEFAULT_ROW_H, cellAt, condTest, filterHiddenRows, resolveRange, validationAt, validationItems,
  type Cell, type CellFmt, type Chart, type CondFormat, type CondStyle, type Sheet, type Workbook,
} from './sheet.ts';
import { displayScalar } from './numfmt.ts';

export const HEADER_W = 46;
export const HEADER_H = 24;
export const SELECT = '#1a73e8';
/** Categorical series colours, in fixed order (validated palette from the dataviz guidance). */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

/* ---------------- geometry ---------------- */

export class Axis {
  readonly n: number;
  readonly off: Float64Array;
  constructor(n: number, size: (i: number) => number) {
    this.n = n;
    this.off = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) this.off[i + 1] = this.off[i] + size(i);
  }
  start(i: number): number { return this.off[Math.max(0, Math.min(this.n, i))]; }
  size(i: number): number { return i < 0 || i >= this.n ? 0 : this.off[i + 1] - this.off[i]; }
  get total(): number { return this.off[this.n]; }
  /** Index whose span contains px (clamped). */
  at(px: number): number {
    if (px <= 0) return 0;
    if (px >= this.total) return this.n - 1;
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.off[mid] <= px) lo = mid; else hi = mid - 1; }
    return lo;
  }
}

export interface Layout { rows: Axis; cols: Axis; filtered: Set<number> }
const layoutCache = new WeakMap<Sheet, { key: unknown; layout: Layout }>();
export function layoutOf(s: Sheet, engine: Engine): Layout {
  const filtered = engine.memo(`filter:${s.id}`, () => filterHiddenRows(s, engine));
  const hit = layoutCache.get(s);
  if (hit && hit.key === filtered) return hit.layout;
  const hr = new Set(s.hiddenRows), hc = new Set(s.hiddenCols);
  // rows grow for large fonts, wrapped text and line breaks (like Sheets) unless their height was set by hand
  const auto = new Map<number, number>();
  const merged = new Set<string>();
  for (const m of s.merges) { const x = parseRect(m); if (x) for (let r = x.r1; r <= x.r2; r++) for (let c = x.c1; c <= x.c2; c++) merged.add(`${r},${c}`); }
  for (const [a, cell] of Object.entries(s.cells)) {
    const f = cell.s;
    const text = typeof cell.v === 'string' ? cell.v : '';
    if (!f?.fs && f?.wrap !== 'wrap' && !text.includes('\n')) continue;
    const m = /^([A-Z]+)(\d+)$/.exec(a);
    if (!m) continue;
    let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; c -= 1;
    const r = Number(m[2]) - 1;
    if (s.rowH[r] !== undefined || merged.has(`${r},${c}`)) continue;
    const px = (f?.fs ?? 10) * 1.333;
    let lines = text.split('\n').length;
    if (f?.wrap === 'wrap') {
      const shown = cell.f ? engine.display(s.id, r, c).text : text || engine.display(s.id, r, c).text;
      const width = Math.max(10, (s.colW[c] ?? DEFAULT_COL_W) - 8);
      lines = shown.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil((part.length * px * 0.55) / width)), 0);
    }
    const h = Math.min(400, Math.ceil(lines * px * 1.25 + 6));
    if (h > DEFAULT_ROW_H && h > (auto.get(r) ?? 0)) auto.set(r, h);
  }
  const layout: Layout = {
    rows: new Axis(s.rows, (r) => (hr.has(r) || filtered.has(r) ? 0 : s.rowH[r] ?? auto.get(r) ?? DEFAULT_ROW_H)),
    cols: new Axis(s.cols, (c) => (hc.has(c) ? 0 : s.colW[c] ?? DEFAULT_COL_W)),
    filtered,
  };
  layoutCache.set(s, { key: filtered, layout });
  return layout;
}

/** Screen geometry of a sheet view: frozen panes, scroll offsets and header sizes. */
export class GridView {
  readonly s: Sheet;
  readonly L: Layout;
  readonly sx: number;
  readonly sy: number;
  readonly w: number;
  readonly h: number;
  readonly headers: boolean;
  readonly fw: number;
  readonly fh: number;
  readonly hw: number;
  readonly hh: number;
  constructor(s: Sheet, L: Layout, scrollX: number, scrollY: number, w: number, h: number, headers = true) {
    this.s = s; this.L = L; this.sx = scrollX; this.sy = scrollY; this.w = w; this.h = h; this.headers = headers;
    this.fw = L.cols.start(s.frozenCols); this.fh = L.rows.start(s.frozenRows);
    this.hw = headers ? HEADER_W : 0; this.hh = headers ? HEADER_H : 0;
  }
  /** Left edge of a column on screen. */
  x(c: number): number { return c < this.s.frozenCols ? this.hw + this.L.cols.start(c) : this.hw + this.L.cols.start(c) - this.sx; }
  y(r: number): number { return r < this.s.frozenRows ? this.hh + this.L.rows.start(r) : this.hh + this.L.rows.start(r) - this.sy; }
  rect(r: Rect): { x: number; y: number; w: number; h: number } {
    const x = this.x(r.c1), y = this.y(r.r1);
    return { x, y, w: this.x(r.c2) + this.L.cols.size(r.c2) - x, h: this.y(r.r2) + this.L.rows.size(r.r2) - y };
  }
  /** Column at a screen x (headers excluded), honouring frozen columns. */
  colAt(px: number): number {
    const gx = px - this.hw;
    return gx < this.fw ? this.L.cols.at(gx) : this.L.cols.at(gx + this.sx);
  }
  rowAt(py: number): number {
    const gy = py - this.hh;
    return gy < this.fh ? this.L.rows.at(gy) : this.L.rows.at(gy + this.sy);
  }
  /** Visible index ranges of the scrolling part. */
  visibleCols(): [number, number] { return [this.L.cols.at(this.fw + this.sx), this.L.cols.at(this.fw + this.sx + this.w - this.hw - this.fw)]; }
  visibleRows(): [number, number] { return [this.L.rows.at(this.fh + this.sy), this.L.rows.at(this.fh + this.sy + this.h - this.hh - this.fh)]; }
}

/* ---------------- conditional formatting ---------------- */

type CondFn = (r: number, c: number, v: Scalar) => CondStyle | null;
function lerpColor(a: string, b: string, t: number): string {
  const p = (h: string) => { const x = h.replace('#', ''); const f = x.length === 3 ? x.split('').map((ch) => ch + ch).join('') : x.slice(0, 6); return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
  const A = p(a), B = p(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
}
function compileRule(cf: CondFormat, s: Sheet, engine: Engine): { rect: Rect; fn: CondFn } | null {
  const rect = parseRect(cf.range, s.rows, s.cols);
  if (!rect) return null;
  const values = (): number[] => {
    const out: number[] = [];
    const r2 = Math.min(rect.r2, s.rows - 1, rect.r1 + 20000);
    for (let r = rect.r1; r <= r2; r++) for (let c = rect.c1; c <= Math.min(rect.c2, rect.c1 + 200); c++) { const v = engine.value(s.id, r, c); if (typeof v === 'number') out.push(v); }
    return out;
  };
  const style = cf.style ?? { fill: '#b7e1cd' };
  switch (cf.type) {
    case 'scale': {
      const xs = values(); if (!xs.length) return { rect, fn: () => null };
      const lo = Math.min(...xs), hi = Math.max(...xs), cols = cf.colors ?? ['#ffffff', '#57bb8a'];
      return { rect, fn: (_r, _c, v) => {
        if (typeof v !== 'number') return null;
        const t = hi === lo ? 1 : (v - lo) / (hi - lo);
        const fill = cols.length === 3 ? (t < 0.5 ? lerpColor(cols[0], cols[1], t * 2) : lerpColor(cols[1], cols[2], (t - 0.5) * 2)) : lerpColor(cols[0], cols[1], t);
        return { fill };
      } };
    }
    case 'top': case 'bottom': {
      const xs = values().sort((a, b) => (cf.type === 'top' ? b - a : a - b));
      const n = cf.percent ? Math.max(1, Math.round((xs.length * (cf.n ?? 10)) / 100)) : cf.n ?? 10;
      const cut = xs[Math.min(n, xs.length) - 1];
      return { rect, fn: (_r, _c, v) => (typeof v === 'number' && cut !== undefined && (cf.type === 'top' ? v >= cut : v <= cut) ? style : null) };
    }
    case 'above_avg': case 'below_avg': {
      const xs = values(); const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
      return { rect, fn: (_r, _c, v) => (typeof v === 'number' && (cf.type === 'above_avg' ? v > m : v < m) ? style : null) };
    }
    case 'duplicate': case 'unique': {
      const counts = new Map<string, number>();
      const r2 = Math.min(rect.r2, s.rows - 1, rect.r1 + 20000);
      for (let r = rect.r1; r <= r2; r++) for (let c = rect.c1; c <= rect.c2; c++) { const v = engine.value(s.id, r, c); if (v === null || v === '') continue; const k = typeof v === 'string' ? v.toLowerCase() : displayScalar(isErr(v) ? v.code : v); counts.set(k, (counts.get(k) ?? 0) + 1); }
      return { rect, fn: (_r, _c, v) => { if (v === null || v === '') return null; const k = typeof v === 'string' ? v.toLowerCase() : displayScalar(isErr(v) ? v.code : v); const n = counts.get(k) ?? 0; return (cf.type === 'duplicate' ? n > 1 : n === 1) ? style : null; } };
    }
    case 'formula': {
      const f = String(cf.value ?? '');
      return { rect, fn: (r, c) => { const res = engine.evalAt(s.id, shiftFormula(f, r - rect.r1, c - rect.c1), r, c); const v = Array.isArray(res) ? res[0]?.[0] ?? null : res; const b = toBool(v as Scalar); return b === true ? style : null; } };
    }
    default: {
      const t = condTest(cf.type, cf.value, cf.value2);
      return t ? { rect, fn: (_r, _c, v) => (t(v) ? style : null) } : null;
    }
  }
}
/** Combined conditional style of a cell (first matching rule wins per property, like Sheets). */
export function condStyleOf(s: Sheet, engine: Engine): (r: number, c: number) => CondStyle | null {
  const rules = engine.memo(`cf:${s.id}:${s.condFormats.length}:${JSON.stringify(s.condFormats).length}`, () => s.condFormats.map((cf) => compileRule(cf, s, engine)).filter((x): x is { rect: Rect; fn: CondFn } => !!x));
  if (!rules.length) return () => null;
  return (r, c) => {
    let out: CondStyle | null = null;
    for (const rule of rules) {
      if (!inRect(rule.rect, r, c)) continue;
      const st = rule.fn(r, c, engine.value(s.id, r, c));
      if (st) out = { ...st, ...(out ?? {}) };
    }
    return out;
  };
}
export function bandFill(s: Sheet, r: number, c: number): string | undefined {
  for (const b of s.bands) {
    const rect = parseRect(b.range);
    if (!rect || !inRect(rect, r, c)) continue;
    if (b.header && r === rect.r1) return b.header;
    if (b.footer && r === rect.r2) return b.footer;
    return (r - rect.r1 - (b.header ? 1 : 0)) % 2 === 0 ? b.odd : b.even;
  }
  return undefined;
}

/* ---------------- canvas grid ---------------- */

export interface Overlay {
  /** selected ranges; the first is the main one */
  ranges?: Rect[];
  active?: { r: number; c: number };
  /** copy marquee */
  copy?: Rect | null;
  /** coloured reference boxes while editing a formula */
  refs?: { rect: Rect; color: string }[];
  /** highlighted find matches */
  found?: { r: number; c: number }[];
  /** hide the text of the cell being edited */
  editing?: { r: number; c: number } | null;
  /** show formulas instead of their results (View ▸ Show formulas) */
  formulas?: boolean;
  dark?: boolean;
}

const FONT = 'Arial, "Noto Sans Thai", "Leelawadee UI", sans-serif';
const fontOf = (f: CellFmt | undefined, scale = 1) => `${f?.i ? 'italic ' : ''}${f?.b ? 'bold ' : ''}${Math.round((f?.fs ?? 10) * 1.333 * scale)}px ${f?.ff ? `"${f.ff}", ` : ''}${FONT}`;
const lineWidth = (style: string) => (style.startsWith('thick') ? 3 : style.startsWith('medium') || style.startsWith('double') ? 2 : 1);

export interface Theme { bg: string; grid: string; head: string; headText: string; headOn: string; headOnText: string; text: string; frozen: string }
export const LIGHT: Theme = { bg: '#ffffff', grid: '#e2e3e3', head: '#f8f9fa', headText: '#5f6368', headOn: '#d3e3fd', headOnText: '#0b57d0', text: '#202124', frozen: '#c4c7c5' };

function wrapLines(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (g.measureText(test).width > width && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
      while (g.measureText(line).width > width && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && g.measureText(line.slice(0, k)).width > width) k--;
        out.push(line.slice(0, k)); line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

/** Paints the visible part of a sheet (cells, headers, frozen panes, selection) into a 2D context in CSS pixels. */
export function drawGrid(g: CanvasRenderingContext2D, _wb: Workbook, view: GridView, engine: Engine, ov: Overlay = {}, theme: Theme = LIGHT): void {
  const s = view.s, L = view.L;
  g.save();
  g.fillStyle = theme.bg; g.fillRect(0, 0, view.w, view.h);
  const cond = condStyleOf(s, engine);
  const merges = s.merges.map((m) => parseRect(m)!).filter(Boolean);
  const covered = new Map<string, Rect>();
  for (const m of merges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) covered.set(`${r},${c}`, m);
  const [vc1, vc2] = view.visibleCols(), [vr1, vr2] = view.visibleRows();
  const sel = ov.ranges ?? [];
  const selRows = (r: number) => sel.some((x) => r >= x.r1 && r <= x.r2);
  const selCols = (c: number) => sel.some((x) => c >= x.c1 && c <= x.c2);
  const panes: { rows: [number, number]; cols: [number, number]; clip: [number, number, number, number] }[] = [];
  const fr = s.frozenRows, fc = s.frozenCols;
  const bodyX = view.hw + view.fw, bodyY = view.hh + view.fh;
  panes.push({ rows: [Math.max(vr1, fr), vr2], cols: [Math.max(vc1, fc), vc2], clip: [bodyX, bodyY, view.w - bodyX, view.h - bodyY] });
  if (fr) panes.push({ rows: [0, fr - 1], cols: [Math.max(vc1, fc), vc2], clip: [bodyX, view.hh, view.w - bodyX, view.fh] });
  if (fc) panes.push({ rows: [Math.max(vr1, fr), vr2], cols: [0, fc - 1], clip: [view.hw, bodyY, view.fw, view.h - bodyY] });
  if (fr && fc) panes.push({ rows: [0, fr - 1], cols: [0, fc - 1], clip: [view.hw, view.hh, view.fw, view.fh] });

  const validations = s.validations.length > 0;
  for (const pane of panes) {
    g.save();
    g.beginPath(); g.rect(...pane.clip); g.clip();
    const [r1, r2] = pane.rows, [c1, c2] = pane.cols;
    // pass 1: fills
    for (let r = r1; r <= r2; r++) {
      const rh = L.rows.size(r); if (!rh) continue;
      const y = view.y(r);
      for (let c = c1; c <= c2; c++) {
        const cw = L.cols.size(c); if (!cw) continue;
        const m = covered.get(`${r},${c}`);
        if (m && (m.r1 !== r || m.c1 !== c) && !(r === r1 && m.r1 < r1) && !(c === c1 && m.c1 < c1)) continue;
        const cell = cellAt(s, m ? m.r1 : r, m ? m.c1 : c);
        const cs = cond(m ? m.r1 : r, m ? m.c1 : c);
        const fill = cs?.fill ?? cell?.s?.fill ?? bandFill(s, r, c);
        if (fill) { const box = m ? view.rect(m) : { x: view.x(c), y, w: cw, h: rh }; g.fillStyle = fill; g.fillRect(box.x, box.y, box.w, box.h); }
      }
    }
    // pass 2: grid lines
    if (s.gridlines) {
      g.strokeStyle = theme.grid; g.lineWidth = 1;
      g.beginPath();
      for (let r = r1; r <= r2 + 1; r++) { if (r < s.rows && !L.rows.size(r) && r <= r2) continue; const y = Math.round(view.y(r)) - 0.5; g.moveTo(pane.clip[0], y); g.lineTo(pane.clip[0] + pane.clip[2], y); }
      for (let c = c1; c <= c2 + 1; c++) { if (c < s.cols && !L.cols.size(c) && c <= c2) continue; const x = Math.round(view.x(c)) - 0.5; g.moveTo(x, pane.clip[1]); g.lineTo(x, pane.clip[1] + pane.clip[3]); }
      g.stroke();
      // merged areas hide the lines inside them
      for (const m of merges) {
        if (m.r2 < r1 || m.r1 > r2 || m.c2 < c1 || m.c1 > c2) continue;
        const box = view.rect(m);
        const cell = cellAt(s, m.r1, m.c1);
        g.fillStyle = cond(m.r1, m.c1)?.fill ?? cell?.s?.fill ?? bandFill(s, m.r1, m.c1) ?? theme.bg;
        g.fillRect(box.x, box.y, box.w - 1, box.h - 1);
      }
    }
    // pass 3: text and decorations
    for (let r = r1; r <= r2; r++) {
      const rh = L.rows.size(r); if (!rh) continue;
      for (let c = c1; c <= c2; c++) {
        const cw = L.cols.size(c); if (!cw) continue;
        const m = covered.get(`${r},${c}`);
        if (m && (m.r1 !== r || m.c1 !== c) && !(r === r1 && m.r1 < r1 && c === Math.max(m.c1, c1)) && !(c === c1 && m.c1 < c1 && r === Math.max(m.r1, r1))) continue;
        const rr = m ? m.r1 : r, cc = m ? m.c1 : c;
        if (ov.editing && ov.editing.r === rr && ov.editing.c === cc) continue;
        const cell = cellAt(s, rr, cc);
        const box = m ? view.rect(m) : { x: view.x(c), y: view.y(r), w: cw, h: rh };
        const d0 = engine.display(s.id, rr, cc);
        const d = ov.formulas && cell?.f ? { ...d0, text: cell.f, align: 'left' as const, color: undefined } : d0;
        const v = validations && !(ov.formulas && cell?.f) ? validationAt(s, rr, cc) : undefined;
        if (v?.type === 'checkbox') { drawCheckbox(g, box, d.value === true, cell?.s?.color); continue; }
        const cs = cond(rr, cc);
        if (v && (v.type === 'list' || v.type === 'range') && d.text) {
          const chip = v.colors?.[d.text];
          if (chip) { g.fillStyle = chip; roundRect(g, box.x + 3, box.y + 3, Math.min(box.w - 6, g.measureText(d.text).width + 30), box.h - 6, 9); g.fill(); }
        }
        if (d.text) drawText(g, s, rr, cc, box, d.text, cell, d.align, cs, d.color, theme, covered, view, r2, c2, d.value);
        if (v && (v.type === 'list' || v.type === 'range') && (d.text || (ov.active && ov.active.r === rr && ov.active.c === cc))) drawArrow(g, box);
        if (cell?.note) { g.fillStyle = '#f9ab00'; g.beginPath(); g.moveTo(box.x + box.w - 7, box.y); g.lineTo(box.x + box.w - 1, box.y); g.lineTo(box.x + box.w - 1, box.y + 6); g.fill(); }
        if (d.error && cell?.f) { g.fillStyle = '#d93025'; g.beginPath(); g.moveTo(box.x + box.w - 7, box.y); g.lineTo(box.x + box.w - 1, box.y); g.lineTo(box.x + box.w - 1, box.y + 6); g.fill(); }
      }
    }
    // pass 4: borders
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const f = cellAt(s, r, c)?.s;
        if (!f || !(f.bt || f.bb || f.bl || f.br)) continue;
        const x = view.x(c), y = view.y(r), w = L.cols.size(c), h = L.rows.size(r);
        const line = (spec: string | undefined, x1: number, y1: number, x2: number, y2: number) => {
          if (!spec) return;
          const [style, col] = spec.split(' ');
          g.strokeStyle = col; g.lineWidth = lineWidth(style);
          g.setLineDash(style === 'dashed' ? [4, 2] : style === 'dotted' ? [1, 2] : []);
          g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
          if (style === 'double') { const dx = y1 === y2 ? 0 : 2, dy = y1 === y2 ? 2 : 0; g.lineWidth = 1; g.beginPath(); g.moveTo(x1 + dx, y1 + dy); g.lineTo(x2 + dx, y2 + dy); g.stroke(); }
        };
        line(f.bt, x - 0.5, y - 0.5, x + w - 0.5, y - 0.5); line(f.bb, x - 0.5, y + h - 0.5, x + w - 0.5, y + h - 0.5);
        line(f.bl, x - 0.5, y - 0.5, x - 0.5, y + h - 0.5); line(f.br, x + w - 0.5, y - 0.5, x + w - 0.5, y + h - 0.5);
        g.setLineDash([]);
      }
    }
    // filter buttons on the header row of a filtered table
    if (s.filter) {
      const fr0 = parseRect(s.filter.range);
      if (fr0 && fr0.r1 >= r1 && fr0.r1 <= r2) for (let c = Math.max(c1, fr0.c1); c <= Math.min(c2, fr0.c2); c++) {
        const x = view.x(c) + L.cols.size(c) - 18, y = view.y(fr0.r1) + (L.rows.size(fr0.r1) - 14) / 2;
        const on = (s.filter.hidden[c]?.length ?? 0) > 0 || !!s.filter.cond[c];
        g.fillStyle = on ? '#1a73e8' : '#ffffff'; g.strokeStyle = on ? '#1a73e8' : '#9aa0a6'; g.lineWidth = 1;
        roundRect(g, x, y, 14, 14, 3); g.fill(); g.stroke();
        g.fillStyle = on ? '#ffffff' : '#5f6368'; g.beginPath(); g.moveTo(x + 3, y + 4); g.lineTo(x + 11, y + 4); g.lineTo(x + 8, y + 8); g.lineTo(x + 8, y + 11); g.lineTo(x + 6, y + 11); g.lineTo(x + 6, y + 8); g.closePath(); g.fill();
      }
    }
    // overlays
    for (const ref of ov.refs ?? []) { const b = view.rect(ref.rect); g.strokeStyle = ref.color; g.lineWidth = 2; g.setLineDash([]); g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1); g.fillStyle = ref.color + '22'; g.fillRect(b.x, b.y, b.w, b.h); }
    for (const f of ov.found ?? []) { const b = view.rect({ r1: f.r, c1: f.c, r2: f.r, c2: f.c }); g.fillStyle = 'rgba(251,188,4,0.35)'; g.fillRect(b.x, b.y, b.w, b.h); }
    sel.forEach((range, i) => {
      const b = view.rect(range);
      const single = range.r1 === range.r2 && range.c1 === range.c2;
      if (!single || sel.length > 1) { g.fillStyle = 'rgba(14,101,235,0.10)'; g.fillRect(b.x, b.y, b.w, b.h); }
      if (i === 0) { g.strokeStyle = SELECT; g.lineWidth = 1; g.strokeRect(b.x - 0.5, b.y - 0.5, b.w, b.h); }
    });
    if (ov.active) {
      const m = covered.get(`${ov.active.r},${ov.active.c}`) ?? { r1: ov.active.r, c1: ov.active.c, r2: ov.active.r, c2: ov.active.c };
      const b = view.rect(m);
      if (sel.length && !(sel[0].r1 === sel[0].r2 && sel[0].c1 === sel[0].c2) && !(merges.some((x) => x.r1 === sel[0].r1 && x.c1 === sel[0].c1 && x.r2 === sel[0].r2 && x.c2 === sel[0].c2))) { const cell = cellAt(s, m.r1, m.c1); g.fillStyle = cond(m.r1, m.c1)?.fill ?? cell?.s?.fill ?? bandFill(s, m.r1, m.c1) ?? theme.bg; g.fillRect(b.x, b.y, b.w - 1, b.h - 1); const d = engine.display(s.id, m.r1, m.c1); if (d.text && !(ov.editing && ov.editing.r === m.r1 && ov.editing.c === m.c1)) drawText(g, s, m.r1, m.c1, b, d.text, cell, d.align, cond(m.r1, m.c1), d.color, theme, new Map(), view, m.r2, m.c2, d.value); }
      g.strokeStyle = SELECT; g.lineWidth = 2; g.strokeRect(b.x, b.y, b.w - 1, b.h - 1);
    }
    if (sel.length) {
      const b = view.rect(sel[0]);
      g.fillStyle = SELECT; g.fillRect(b.x + b.w - 4, b.y + b.h - 4, 6, 6);
      g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.strokeRect(b.x + b.w - 4.5, b.y + b.h - 4.5, 7, 7);
    }
    if (ov.copy) { const b = view.rect(ov.copy); g.strokeStyle = SELECT; g.lineWidth = 2; g.setLineDash([5, 3]); g.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2); g.setLineDash([]); }
    g.restore();
  }
  // frozen dividers
  g.fillStyle = theme.frozen;
  if (fr) g.fillRect(view.hw, view.hh + view.fh - 2, view.w, 3);
  if (fc) g.fillRect(view.hw + view.fw - 2, view.hh, 3, view.h);
  if (view.headers) drawHeaders(g, view, theme, selRows, selCols, sel, s);
  g.restore();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function drawCheckbox(g: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number }, on: boolean, color?: string): void {
  const size = 13, x = Math.round(box.x + (box.w - size) / 2) + 0.5, y = Math.round(box.y + (box.h - size) / 2) + 0.5;
  g.lineWidth = 1.5; g.strokeStyle = on ? color ?? SELECT : '#5f6368'; g.fillStyle = on ? color ?? SELECT : '#ffffff';
  roundRect(g, x, y, size, size, 2); g.fill(); g.stroke();
  if (on) { g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.beginPath(); g.moveTo(x + 3, y + 6.5); g.lineTo(x + 5.5, y + 9.5); g.lineTo(x + 10, y + 3.5); g.stroke(); }
}
function drawArrow(g: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number }): void {
  const x = box.x + box.w - 13, y = box.y + box.h / 2 - 2;
  g.fillStyle = '#5f6368'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 7, y); g.lineTo(x + 3.5, y + 4); g.closePath(); g.fill();
}

function drawText(g: CanvasRenderingContext2D, s: Sheet, r: number, c: number, box: { x: number; y: number; w: number; h: number }, text: string, cell: Cell | undefined, align: 'left' | 'right' | 'center', cs: CondStyle | null, nfColor: string | undefined, theme: Theme, covered: Map<string, Rect>, view: GridView, _r2: number, c2: number, value: Scalar = null): void {
  const f = cell?.s;
  const ha = f?.ha ?? align;
  const va = f?.va ?? 'bottom';
  const wrap = f?.wrap ?? 'overflow';
  const bold = cs?.b ?? f?.b, italic = cs?.i ?? f?.i;
  g.font = fontOf({ ...f, b: bold, i: italic });
  g.fillStyle = cs?.color ?? nfColor ?? f?.color ?? (cell?.link ? '#1155cc' : theme.text);
  g.textBaseline = 'alphabetic';
  const pad = 3, fs = (f?.fs ?? 10) * 1.333, lh = fs * 1.25;
  let clipW = box.w;
  // overflow into empty neighbours (left aligned text spills right, right aligned spills left)
  let spillLeft = 0;
  if (wrap === 'overflow' && !covered.has(`${r},${c}`)) {
    const tw = g.measureText(text).width + pad * 2;
    if (tw > box.w && typeof value === 'string') {
      if (ha === 'left' || ha === 'center') { for (let k = c + 1; k <= Math.min(c2 + 20, s.cols - 1) && clipW < tw; k++) { if (hasContent(s, r, k) || covered.has(`${r},${k}`)) break; clipW += view.L.cols.size(k); } }
      if (ha === 'right' || ha === 'center') { let k = c - 1, extra = 0; while (k >= 0 && extra + box.w < tw && !hasContent(s, r, k) && !covered.has(`${r},${k}`)) { extra += view.L.cols.size(k); k--; } spillLeft = extra; }
    }
  }
  g.save();
  g.beginPath(); g.rect(box.x - spillLeft, box.y, clipW + spillLeft - 1, box.h - 1); g.clip();
  const lines = wrap === 'wrap' ? wrapLines(g, text, box.w - pad * 2) : text.split('\n');
  const total = lines.length * lh;
  let y0 = va === 'top' ? box.y + fs + 2 : va === 'middle' ? box.y + (box.h - total) / 2 + fs * 0.9 : box.y + box.h - total + fs * 0.95 - 3;
  if (f?.rot) {
    g.translate(box.x + box.w / 2, box.y + box.h / 2); g.rotate((-f.rot * Math.PI) / 180);
    g.textAlign = 'center'; g.fillText(text, 0, fs / 3);
    g.restore(); return;
  }
  for (const line of lines) {
    const w = g.measureText(line).width;
    let x = ha === 'left' ? box.x + pad : ha === 'right' ? box.x + box.w - pad - w : box.x + (box.w - w) / 2;
    if (ha === 'center' && spillLeft) x = box.x + (box.w - w) / 2;
    g.textAlign = 'left';
    g.fillText(line, x, y0);
    if (cs?.u ?? f?.u ?? !!cell?.link) { g.fillRect(x, y0 + 2, w, 1); }
    if (cs?.s ?? f?.s) { g.fillRect(x, y0 - fs * 0.32, w, 1); }
    y0 += lh;
  }
  g.restore();
}
const hasContent = (s: Sheet, r: number, c: number): boolean => { const cell = s.cells[addr(r, c)]; return !!cell && (cell.f !== undefined || (cell.v !== undefined && cell.v !== null && cell.v !== '')); };

function drawHeaders(g: CanvasRenderingContext2D, view: GridView, theme: Theme, selRows: (r: number) => boolean, selCols: (c: number) => boolean, sel: Rect[], s: Sheet): void {
  const L = view.L;
  const [vc1, vc2] = view.visibleCols(), [vr1, vr2] = view.visibleRows();
  const full = (r: Rect) => r.r1 === 0 && r.r2 >= s.rows - 1;
  const fullRow = (r: Rect) => r.c1 === 0 && r.c2 >= s.cols - 1;
  g.font = `11px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'center';
  // column header
  g.fillStyle = theme.head; g.fillRect(0, 0, view.w, view.hh);
  const cols = [...range(0, s.frozenCols - 1), ...range(Math.max(vc1, s.frozenCols), vc2)];
  for (const c of cols) {
    const w = L.cols.size(c); if (!w) continue;
    const x = view.x(c);
    if (c >= s.frozenCols && x + w < view.hw + view.fw) continue;
    const on = selCols(c), whole = sel.some((r) => full(r) && c >= r.c1 && c <= r.c2);
    if (on) { g.fillStyle = whole ? '#0b57d0' : theme.headOn; g.fillRect(x, 0, w, view.hh); }
    g.fillStyle = whole ? '#ffffff' : on ? theme.headOnText : theme.headText;
    g.fillText(colLabel(c), x + w / 2, view.hh / 2 + 1);
    g.fillStyle = theme.grid; g.fillRect(x + w - 1, 0, 1, view.hh);
    if (s.hiddenCols.includes(c + 1)) drawHiddenMark(g, x + w, view.hh / 2, true);
  }
  // row header
  g.fillStyle = theme.head; g.fillRect(0, view.hh, view.hw, view.h);
  const rows = [...range(0, s.frozenRows - 1), ...range(Math.max(vr1, s.frozenRows), vr2)];
  for (const r of rows) {
    const h = L.rows.size(r); if (!h) continue;
    const y = view.y(r);
    if (r >= s.frozenRows && y + h < view.hh + view.fh) continue;
    const on = selRows(r), whole = sel.some((x) => fullRow(x) && r >= x.r1 && r <= x.r2);
    if (on) { g.fillStyle = whole ? '#0b57d0' : theme.headOn; g.fillRect(0, y, view.hw, h); }
    g.fillStyle = whole ? '#ffffff' : on ? theme.headOnText : theme.headText;
    if (h >= 10) g.fillText(String(r + 1), view.hw / 2, y + h / 2 + 1);
    g.fillStyle = theme.grid; g.fillRect(0, y + h - 1, view.hw, 1);
    if (s.hiddenRows.includes(r + 1)) drawHiddenMark(g, view.hw / 2, y + h, false);
  }
  g.fillStyle = theme.head; g.fillRect(0, 0, view.hw, view.hh);
  g.strokeStyle = theme.frozen; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, view.hh - 0.5); g.lineTo(view.w, view.hh - 0.5); g.moveTo(view.hw - 0.5, 0); g.lineTo(view.hw - 0.5, view.h); g.stroke();
  // the corner shows the frozen handles like Sheets
  g.fillStyle = '#bdc1c6'; g.fillRect(view.hw - 4, 2, 2, view.hh - 4); g.fillRect(2, view.hh - 4, view.hw - 4, 2);
}
function drawHiddenMark(g: CanvasRenderingContext2D, x: number, y: number, col: boolean): void {
  g.fillStyle = '#5f6368';
  g.beginPath();
  if (col) { g.moveTo(x - 4, y - 3); g.lineTo(x, y); g.lineTo(x - 4, y + 3); g.moveTo(x + 4, y - 3); g.lineTo(x, y); g.lineTo(x + 4, y + 3); }
  else { g.moveTo(x - 3, y - 4); g.lineTo(x, y); g.lineTo(x + 3, y - 4); g.moveTo(x - 3, y + 4); g.lineTo(x, y); g.lineTo(x + 3, y + 4); }
  g.fill();
}
const range = (a: number, b: number): number[] => { const out: number[] = []; for (let i = a; i <= b; i++) out.push(i); return out; };
const colLabel = (c: number): string => { let n = c + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

/* ---------------- charts ---------------- */

export interface ChartData { categories: string[]; series: { name: string; values: (number | null)[] }[]; xNumeric?: (number | null)[] }

export function chartData(ch: Chart, wb: Workbook, home: Sheet, engine: Engine): ChartData | null {
  const res = resolveRange(wb, ch.range, home);
  if (!res) return null;
  const { sheet, rect } = res;
  const r2 = Math.min(rect.r2, rect.r1 + 2000);
  const val = (r: number, c: number) => engine.value(sheet.id, r, c);
  const text = (r: number, c: number) => engine.display(sheet.id, r, c).text;
  const startR = ch.headers ? rect.r1 + 1 : rect.r1;
  const startC = ch.labels ? rect.c1 + 1 : rect.c1;
  // trailing empty rows are not data
  let last = r2;
  while (last >= startR && range(rect.c1, rect.c2).every((c) => val(last, c) === null)) last--;
  const categories: string[] = [];
  for (let r = startR; r <= last; r++) categories.push(ch.labels ? text(r, rect.c1) : String(r - startR + 1));
  const series: ChartData['series'] = [];
  for (let c = startC; c <= rect.c2; c++) {
    const values: (number | null)[] = [];
    for (let r = startR; r <= last; r++) { const v = val(r, c); values.push(typeof v === 'number' ? v : null); }
    series.push({ name: ch.headers ? text(rect.r1, c) || `Series ${series.length + 1}` : `Series ${series.length + 1}`, values });
  }
  const xNumeric = ch.labels ? range(startR, last).map((r) => { const v = val(r, rect.c1); return typeof v === 'number' ? v : null; }) : undefined;
  return { categories, series, xNumeric };
}

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (lo === hi) { hi = lo + 1; lo = Math.min(0, lo); }
  const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => span / k <= n) ?? 10 * mag;
  const start = Math.floor(lo / step) * step, out: number[] = [];
  for (let v = start; v <= hi + step * 0.5; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
const fmtNum = (v: number): string => (Math.abs(v) >= 1e6 ? `${Number((v / 1e6).toPrecision(3))}M` : Math.abs(v) >= 1e4 ? `${Number((v / 1e3).toPrecision(3))}k` : String(Number(v.toPrecision(6))));
const MARGIN = 12;

/** The chart as a standalone SVG string (escaped text, <title> tooltips on every mark). */
export function chartSvg(ch: Chart, wb: Workbook, home: Sheet, engine: Engine): string {
  const W = ch.w, H = ch.h;
  const data = chartData(ch, wb, home, engine);
  const ink = '#202124', muted = '#5f6368', grid = '#e8eaed';
  const colors = ch.colors?.length ? ch.colors : SERIES;
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, sans-serif" role="img" aria-label="${esc(ch.title ?? `${ch.type} chart`)}">`, `<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  let top = MARGIN;
  if (ch.title) { parts.push(`<text x="${W / 2}" y="${top + 14}" text-anchor="middle" font-size="15" fill="${ink}">${esc(ch.title)}</text>`); top += 26; }
  if (!data || !data.series.length || !data.categories.length) {
    parts.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12" fill="${muted}">No data in ${esc(ch.range)}</text></svg>`);
    return parts.join('');
  }
  const pie = ch.type === 'pie' || ch.type === 'doughnut';
  const series = (pie ? data.series.slice(0, 1) : data.series).slice(0, 8);
  const legendItems = pie ? data.categories.slice(0, 8) : series.map((s) => s.name);
  const legend = ch.legend !== 'none' && (pie || series.length > 1);
  let right = W - MARGIN, bottom = H - MARGIN, left = MARGIN;
  const legendSvg: string[] = [];
  if (legend) {
    if (ch.legend === 'right') {
      const lw = Math.min(160, Math.max(...legendItems.map((t) => t.length)) * 7 + 24);
      legendItems.forEach((t, i) => legendSvg.push(`<rect x="${W - MARGIN - lw}" y="${top + i * 18}" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/><text x="${W - MARGIN - lw + 15}" y="${top + i * 18 + 9}" font-size="11" fill="${ink}">${esc(t.slice(0, 22))}</text>`));
      right -= lw + 8;
    } else {
      let x = MARGIN; const y = ch.legend === 'top' ? top + 8 : H - MARGIN - 4;
      legendItems.forEach((t, i) => { const label = esc(t.slice(0, 18)); legendSvg.push(`<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/><text x="${x + 14}" y="${y}" font-size="11" fill="${ink}">${label}</text>`); x += Math.min(18, t.length) * 6.4 + 30; });
      if (ch.legend === 'top') top += 22; else bottom -= 22;
    }
  }
  parts.push(...legendSvg);
  if (pie) {
    const vals = series[0].values.map((v) => Math.max(0, v ?? 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = (left + right) / 2, cy = (top + bottom) / 2, R = Math.max(10, Math.min(right - left, bottom - top) / 2 - 4), r0 = ch.type === 'doughnut' ? R * 0.55 : 0;
    let a = -Math.PI / 2;
    vals.forEach((v, i) => {
      if (!v) return;
      const da = (v / total) * Math.PI * 2, a2 = a + da, large = da > Math.PI ? 1 : 0;
      const p = (rad: number, ang: number) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
      const d = da >= Math.PI * 2 - 1e-6
        ? `M${p(R, a)} A${R},${R} 0 1 1 ${p(R, a + Math.PI)} A${R},${R} 0 1 1 ${p(R, a)}Z`
        : r0 ? `M${p(R, a)} A${R},${R} 0 ${large} 1 ${p(R, a2)} L${p(r0, a2)} A${r0},${r0} 0 ${large} 0 ${p(r0, a)}Z` : `M${cx},${cy} L${p(R, a)} A${R},${R} 0 ${large} 1 ${p(R, a2)}Z`;
      parts.push(`<path d="${d}" fill="${colors[i % colors.length]}" stroke="#ffffff" stroke-width="2"><title>${esc(data.categories[i])}: ${esc(fmtNum(v))} (${((v / total) * 100).toFixed(1)}%)</title></path>`);
      if (da > 0.35) { const mid = a + da / 2, lr = r0 ? (R + r0) / 2 : R * 0.65; parts.push(`<text x="${(cx + lr * Math.cos(mid)).toFixed(1)}" y="${(cy + lr * Math.sin(mid) + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="#ffffff" font-weight="bold">${((v / total) * 100).toFixed(0)}%</text>`); }
      a = a2;
    });
    parts.push('</svg>');
    return parts.join('');
  }
  const horizontal = ch.type === 'bar' || ch.type === 'stacked_bar';
  const stacked = ch.type === 'stacked_column' || ch.type === 'stacked_bar' || (ch.type === 'area' && series.length > 1);
  const scatter = ch.type === 'scatter';
  const n = data.categories.length;
  // value range
  let lo = 0, hi = 0;
  if (stacked) for (let i = 0; i < n; i++) { let pos = 0, neg = 0; for (const s of series) { const v = s.values[i] ?? 0; if (v >= 0) pos += v; else neg += v; } hi = Math.max(hi, pos); lo = Math.min(lo, neg); }
  else for (const s of series) for (const v of s.values) if (v !== null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
  if (scatter || ch.type === 'line') { const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null)); if (all.length) { lo = Math.min(...all); hi = Math.max(...all); if (lo > 0 && lo < hi * 0.5) lo = 0; } }
  const ticks = niceTicks(lo, hi);
  const vmin = Math.min(ticks[0], lo), vmax = Math.max(ticks[ticks.length - 1], hi);
  const tickW = Math.max(...ticks.map((t) => fmtNum(t).length)) * 6.5 + 8;
  if (ch.yTitle) left += 16;
  if (ch.xTitle) bottom -= 16;
  const catLabelH = horizontal ? 0 : 18;
  const catLabelW = horizontal ? Math.min(120, Math.max(...data.categories.map((c) => c.length)) * 6.2 + 8) : 0;
  const px0 = left + (horizontal ? catLabelW : tickW), px1 = right - (horizontal ? 14 : 4), py0 = top + 4, py1 = bottom - (horizontal ? 18 : catLabelH);
  const scaleV = (v: number) => (horizontal ? px0 + ((v - vmin) / (vmax - vmin || 1)) * (px1 - px0) : py1 - ((v - vmin) / (vmax - vmin || 1)) * (py1 - py0));
  // grid + value axis
  for (const t of ticks) {
    const p = scaleV(t);
    if (horizontal) parts.push(`<line x1="${p.toFixed(1)}" y1="${py0}" x2="${p.toFixed(1)}" y2="${py1}" stroke="${t === 0 ? '#9aa0a6' : grid}" stroke-width="1"/><text x="${p.toFixed(1)}" y="${py1 + 13}" text-anchor="middle" font-size="10" fill="${muted}">${fmtNum(t)}</text>`);
    else parts.push(`<line x1="${px0}" y1="${p.toFixed(1)}" x2="${px1}" y2="${p.toFixed(1)}" stroke="${t === 0 ? '#9aa0a6' : grid}" stroke-width="1"/><text x="${px0 - 6}" y="${(p + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${muted}">${fmtNum(t)}</text>`);
  }
  if (ch.yTitle) parts.push(`<text transform="translate(${MARGIN + 10},${(py0 + py1) / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="${muted}">${esc(ch.yTitle)}</text>`);
  if (ch.xTitle) parts.push(`<text x="${(px0 + px1) / 2}" y="${bottom + 12}" text-anchor="middle" font-size="11" fill="${muted}">${esc(ch.xTitle)}</text>`);
  if (scatter) {
    const xs = data.xNumeric ?? data.categories.map((_, i) => i + 1);
    const valid = xs.filter((x): x is number => x !== null);
    const xt = niceTicks(Math.min(...valid), Math.max(...valid));
    const xmin = Math.min(xt[0], ...valid), xmax = Math.max(xt[xt.length - 1], ...valid);
    const sx = (x: number) => px0 + ((x - xmin) / (xmax - xmin || 1)) * (px1 - px0);
    for (const t of xt) parts.push(`<text x="${sx(t).toFixed(1)}" y="${py1 + 13}" text-anchor="middle" font-size="10" fill="${muted}">${fmtNum(t)}</text>`);
    series.forEach((s, si) => {
      s.values.forEach((v, i) => { const x = xs[i]; if (v === null || x === null) return; parts.push(`<circle cx="${sx(x).toFixed(1)}" cy="${scaleV(v).toFixed(1)}" r="4" fill="${colors[si % colors.length]}" stroke="#ffffff" stroke-width="1.5"><title>${esc(s.name)}: (${esc(fmtNum(x))}, ${esc(fmtNum(v))})</title></circle>`); });
      if (ch.trendline) {
        const pts = s.values.map((v, i) => [xs[i], v] as const).filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null);
        if (pts.length > 1) {
          const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
          const k = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / (pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0) || 1);
          parts.push(`<line x1="${sx(xmin).toFixed(1)}" y1="${scaleV(my + k * (xmin - mx)).toFixed(1)}" x2="${sx(xmax).toFixed(1)}" y2="${scaleV(my + k * (xmax - mx)).toFixed(1)}" stroke="${colors[si % colors.length]}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
        }
      }
    });
    parts.push('</svg>');
    return parts.join('');
  }
  // category axis
  const band = ((horizontal ? py1 - py0 : px1 - px0) / Math.max(1, n));
  const catPos = (i: number) => (horizontal ? py0 + band * i : px0 + band * i);
  const every = Math.max(1, Math.ceil((n * (horizontal ? 14 : 48)) / Math.max(1, horizontal ? py1 - py0 : px1 - px0)));
  data.categories.forEach((c, i) => {
    if (i % every) return;
    const label = esc(c.length > 14 ? c.slice(0, 13) + '…' : c);
    if (horizontal) parts.push(`<text x="${px0 - 6}" y="${(catPos(i) + band / 2 + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${muted}">${label}</text>`);
    else parts.push(`<text x="${(catPos(i) + band / 2).toFixed(1)}" y="${py1 + 13}" text-anchor="middle" font-size="10" fill="${muted}">${label}</text>`);
  });
  const bars = ch.type === 'column' || ch.type === 'bar' || ch.type === 'stacked_column' || ch.type === 'stacked_bar' || ch.type === 'combo';
  if (bars) {
    const barSeries = ch.type === 'combo' ? series.slice(0, 1) : series;
    const inner = band * 0.72, gap = 2;
    const each = stacked ? inner : Math.max(1, (inner - gap * (barSeries.length - 1)) / barSeries.length);
    const base = scaleV(Math.max(vmin, Math.min(0, vmax)));
    for (let i = 0; i < n; i++) {
      let pos = 0, neg = 0;
      barSeries.forEach((s, si) => {
        const v = s.values[i]; if (v === null) return;
        const from = stacked ? (v >= 0 ? pos : neg) : 0, to = from + v;
        if (stacked) { if (v >= 0) pos = to; else neg = to; }
        const a = scaleV(from), b = scaleV(to);
        const off = catPos(i) + (band - inner) / 2 + (stacked ? 0 : si * (each + gap));
        const color = colors[si % colors.length];
        const tip = `<title>${esc(data.categories[i])} · ${esc(s.name)}: ${esc(fmtNum(v))}</title>`;
        if (horizontal) parts.push(`<rect x="${Math.min(a, b).toFixed(1)}" y="${off.toFixed(1)}" width="${Math.max(0.5, Math.abs(b - a) - (stacked ? 1 : 0)).toFixed(1)}" height="${each.toFixed(1)}" rx="${Math.min(4, each / 2)}" fill="${color}">${tip}</rect>`);
        else parts.push(`<rect x="${off.toFixed(1)}" y="${Math.min(a, b).toFixed(1)}" width="${each.toFixed(1)}" height="${Math.max(0.5, Math.abs(b - a) - (stacked ? 1 : 0)).toFixed(1)}" rx="${Math.min(4, each / 2)}" fill="${color}">${tip}</rect>`);
      });
      void base;
    }
  }
  if (ch.type === 'line' || ch.type === 'area' || ch.type === 'combo') {
    const lineSeries = ch.type === 'combo' ? series.slice(1) : series;
    const acc = new Array(n).fill(0);
    lineSeries.forEach((s, k) => {
      const si = ch.type === 'combo' ? k + 1 : k;
      const color = colors[si % colors.length];
      const pts = s.values.map((v, i) => { if (v === null) return null; const val = ch.type === 'area' && stacked ? (acc[i] += v) : v; return [catPos(i) + band / 2, scaleV(val)] as [number, number]; });
      const segs: [number, number][][] = [[]];
      pts.forEach((p) => { if (p) segs[segs.length - 1].push(p); else if (segs[segs.length - 1].length) segs.push([]); });
      for (const seg of segs) {
        if (!seg.length) continue;
        const d = ch.smooth && seg.length > 2 ? smoothPath(seg) : seg.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
        if (ch.type === 'area') parts.push(`<path d="${d} L${seg[seg.length - 1][0].toFixed(1)},${scaleV(Math.max(vmin, 0)).toFixed(1)} L${seg[0][0].toFixed(1)},${scaleV(Math.max(vmin, 0)).toFixed(1)}Z" fill="${color}" fill-opacity="0.22"/>`);
        parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      }
      pts.forEach((p, i) => { if (p) parts.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${n <= 40 ? 3.5 : 0}" fill="${color}" stroke="#ffffff" stroke-width="1.5"><title>${esc(data.categories[i])} · ${esc(s.name)}: ${esc(fmtNum(s.values[i]!))}</title></circle><rect x="${(p[0] - band / 2).toFixed(1)}" y="${py0}" width="${band.toFixed(1)}" height="${py1 - py0}" fill="transparent"><title>${esc(data.categories[i])} · ${esc(s.name)}: ${esc(fmtNum(s.values[i]!))}</title></rect>`); });
    });
  }
  parts.push('</svg>');
  return parts.join('');
}
function smoothPath(pts: [number, number][]): string {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Items of a dropdown validation at a cell, for the editor's popup. */
export function dropdownItems(wb: Workbook, s: Sheet, r: number, c: number, engine: Engine): string[] | null {
  const v = validationAt(s, r, c);
  if (!v || (v.type !== 'list' && v.type !== 'range')) return null;
  return validationItems(wb, s, v, engine);
}

/* ---------------- preview image (agents) ---------------- */

/** Renders a range of a sheet (with headers and the charts that sit over it) to a PNG data URL. Browser only. */
export async function renderPreview(wb: Workbook, s: Sheet, engine: Engine, rect: Rect, opts: { charts?: boolean; scale?: number } = {}): Promise<{ dataUrl: string; width: number; height: number }> {
  const L = layoutOf(s, engine);
  const scale = opts.scale ?? 1;
  const gw = Math.min(2400, L.cols.start(rect.c2 + 1) - L.cols.start(rect.c1)), gh = Math.min(3000, L.rows.start(rect.r2 + 1) - L.rows.start(rect.r1));
  // charts anchored inside or just to the right of the range extend the picture
  const charts = opts.charts === false ? [] : s.charts.map((ch) => {
    const a = /^([A-Z]+)(\d+)$/.exec(ch.anchor)!;
    let c = 0; for (const k of a[1]) c = c * 26 + k.charCodeAt(0) - 64;
    const ar = Number(a[2]) - 1, ac = c - 1;
    return { ch, x: L.cols.start(ac) - L.cols.start(rect.c1) + ch.dx, y: L.rows.start(ar) - L.rows.start(rect.r1) + ch.dy };
  }).filter((p) => p.x < gw + 1200 && p.y < gh + 800 && p.x + p.ch.w > 0 && p.y + p.ch.h > 0);
  const W = Math.min(3200, Math.max(gw, ...charts.map((p) => p.x + p.ch.w)) + HEADER_W + 8);
  const H = Math.min(3200, Math.max(gh, ...charts.map((p) => p.y + p.ch.h)) + HEADER_H + 8);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
  const g = canvas.getContext('2d')!;
  g.scale(scale, scale);
  const sheetView: Sheet = { ...s, frozenRows: 0, frozenCols: 0 };
  const view = new GridView(sheetView, L, L.cols.start(rect.c1), L.rows.start(rect.r1), W, H, true);
  drawGrid(g, wb, view, engine, {});
  for (const p of charts) {
    const svg = chartSvg(p.ch, wb, s, engine);
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = url; });
    const x = HEADER_W + p.x, y = HEADER_H + p.y;
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x + 1, y + 2, p.ch.w, p.ch.h);
    try { g.drawImage(img, x, y, p.ch.w, p.ch.h); } catch { /* image failed to decode */ }
    g.strokeStyle = '#dadce0'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, p.ch.w - 1, p.ch.h - 1);
  }
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

/** A chart alone as a PNG data URL (export). Browser only. */
export async function chartPng(ch: Chart, wb: Workbook, s: Sheet, engine: Engine, scale = 2): Promise<string> {
  const svg = chartSvg(ch, wb, s, engine);
  const img = new Image();
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('could not draw the chart')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  const canvas = document.createElement('canvas');
  canvas.width = ch.w * scale; canvas.height = ch.h * scale;
  const g = canvas.getContext('2d')!;
  g.scale(scale, scale); g.drawImage(img, 0, 0, ch.w, ch.h);
  return canvas.toDataURL('image/png');
}

/** A print-friendly HTML table of a range (used by File ▸ Print and export html). */
export function rangeHtml(wb: Workbook, s: Sheet, rect: Rect, engine: Engine, charts = true): string {
  const cond = condStyleOf(s, engine);
  const L = layoutOf(s, engine);
  const merges = s.merges.map((m) => parseRect(m)!);
  const skip = new Set<string>();
  for (const m of merges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) skip.add(`${r},${c}`);
  const css = (f: CellFmt | undefined, cs: CondStyle | null, align: string, extra: string[] = []) => {
    const out = [...extra];
    if (cs?.fill ?? f?.fill) out.push(`background:${cs?.fill ?? f?.fill}`);
    if (cs?.color ?? f?.color) out.push(`color:${cs?.color ?? f?.color}`);
    if (cs?.b ?? f?.b) out.push('font-weight:bold');
    if (cs?.i ?? f?.i) out.push('font-style:italic');
    const deco = [cs?.u ?? f?.u ? 'underline' : '', cs?.s ?? f?.s ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) out.push(`text-decoration:${deco}`);
    if (f?.fs) out.push(`font-size:${f.fs}pt`);
    if (f?.ff) out.push(`font-family:${esc(f.ff)}`);
    out.push(`text-align:${f?.ha ?? align}`);
    if (f?.va) out.push(`vertical-align:${f.va === 'middle' ? 'middle' : f.va}`);
    out.push(f?.wrap === 'wrap' ? 'white-space:pre-wrap' : 'white-space:nowrap');
    for (const [k, side] of [['bt', 'top'], ['bb', 'bottom'], ['bl', 'left'], ['br', 'right']] as const) {
      const spec = f?.[k]; if (!spec) continue;
      const [style, col] = spec.split(' ');
      out.push(`border-${side}:${lineWidth(style)}px ${style === 'thick' || style === 'medium' ? 'solid' : style} ${col}`);
    }
    return out.join(';');
  };
  const rows: string[] = [];
  const cols: string[] = [];
  for (let c = rect.c1; c <= rect.c2; c++) cols.push(`<col style="width:${L.cols.size(c)}px">`);
  for (let r = rect.r1; r <= rect.r2; r++) {
    if (!L.rows.size(r)) continue;
    const tds: string[] = [];
    for (let c = rect.c1; c <= rect.c2; c++) {
      if (skip.has(`${r},${c}`) || !L.cols.size(c)) continue;
      const m = merges.find((x) => x.r1 === r && x.c1 === c);
      const cell = cellAt(s, r, c);
      const d = engine.display(s.id, r, c);
      const fill = bandFill(s, r, c);
      const span = m ? ` rowspan="${m.r2 - m.r1 + 1}" colspan="${m.c2 - m.c1 + 1}"` : '';
      tds.push(`<td${span} style="${css(cell?.s, cond(r, c), d.align, [fill && !cell?.s?.fill ? `background:${fill}` : '', d.color ? `color:${d.color}` : ''].filter(Boolean))}">${esc(d.text)}</td>`);
    }
    rows.push(`<tr style="height:${L.rows.size(r)}px">${tds.join('')}</tr>`);
  }
  const chartHtml = charts ? s.charts.map((ch) => `<div class="chart">${chartSvg(ch, wb, s, engine)}</div>`).join('') : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(wb.title)} — ${esc(s.name)}</title><style>body{font-family:Arial,"Noto Sans Thai",sans-serif;font-size:10pt;margin:16px;color:#202124}h1{font-size:14pt;margin:0 0 10px}table{border-collapse:collapse;table-layout:fixed}td{border:1px solid #e2e3e3;padding:2px 4px;overflow:hidden}.chart{display:inline-block;margin:12px 12px 0 0;break-inside:avoid}@media print{body{margin:0}}</style></head><body><h1>${esc(wb.title)} — ${esc(s.name)}</h1><table><colgroup>${cols.join('')}</colgroup>${rows.join('')}</table>${chartHtml}</body></html>`;
}

export { addr };
