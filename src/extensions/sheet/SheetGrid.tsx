/** The spreadsheet grid of the Sheet menu: a virtualised canvas (only the visible cells are drawn, so thousands of
 * rows scroll smoothly), the in-cell editor, the fill handle, row/column resizing, floating charts, dropdown and
 * filter popups. All edits go back to the screen through GridApi. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ClipboardEvent as ReactClipboardEvent } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { addr, inRect, norm, parseAddr, parseRect, type Rect } from './formula';
import type { Engine } from './engine';
import { cellAt, validationAt, type Chart, type Op, type Sheet, type Workbook } from './sheet';
import { GridView, HEADER_H, HEADER_W, chartSvg, dropdownItems, drawGrid, layoutOf, type Overlay } from './sheetRender';

export interface Selection { ranges: Rect[]; active: { r: number; c: number }; anchor: { r: number; c: number } }
export interface EditorState { r: number; c: number; text: string; mode: 'enter' | 'edit'; origin: 'cell' | 'bar'; sheet: string }
export interface GridApi {
  select: (sel: Selection) => void;
  startEdit: (r: number, c: number, text: string, mode: 'enter' | 'edit') => void;
  editText: (text: string) => void;
  editorKey: (e: ReactKeyboardEvent<HTMLTextAreaElement>, el: HTMLTextAreaElement) => void;
  keyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /** a click on a cell while a formula is being edited: insert the reference; returns true when handled */
  pointRef: (rect: Rect, extend: boolean) => boolean;
  canPoint: () => boolean;
  commitEdit: () => void;
  run: (ops: Op[], label: string) => boolean;
  copy: (e: ReactClipboardEvent<HTMLTextAreaElement>, cut: boolean) => void;
  paste: (e: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  contextMenu: (kind: 'cell' | 'col' | 'row', x: number, y: number) => void;
  chartEdit: (id: string) => void;
}

export const selRect = (sel: Selection): Rect => sel.ranges[0] ?? { r1: sel.active.r, c1: sel.active.c, r2: sel.active.r, c2: sel.active.c };
const one = (r: number, c: number): Selection => ({ ranges: [{ r1: r, c1: c, r2: r, c2: c }], active: { r, c }, anchor: { r, c } });
export const singleSel = one;

interface Props {
  wb: Workbook;
  sheet: Sheet;
  engine: Engine;
  zoom: number;
  sel: Selection;
  editor: EditorState | null;
  refs: { rect: Rect; color: string }[];
  copyRect: Rect | null;
  found: { r: number; c: number }[];
  showFormulas: boolean;
  /** bump to scroll the active cell into view */
  scrollNonce: number;
  api: GridApi;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  autocomplete: { items: { name: string; syntax: string }[]; index: number } | null;
  signature: string | null;
  onPickSuggestion: (name: string) => void;
}

type Drag =
  | { kind: 'select'; anchor: { r: number; c: number }; add: boolean; base: Rect[] }
  | { kind: 'cols' | 'rows'; anchor: number; add: boolean; base: Rect[] }
  | { kind: 'resize-col' | 'resize-row'; index: number; start: number; size: number }
  | { kind: 'fill'; from: Rect; to: Rect }
  | { kind: 'point'; anchor: { r: number; c: number } }
  | { kind: 'chart-move' | 'chart-size'; id: string; x0: number; y0: number; dx: number; dy: number };

export function SheetGrid({ wb, sheet, engine, zoom, sel, editor, refs, copyRect, found, showFormulas, scrollNonce, api, inputRef, autocomplete, signature, onPickSuggestion }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [fillPreview, setFillPreview] = useState<Rect | null>(null);
  const [guide, setGuide] = useState<{ kind: 'col' | 'row'; at: number } | null>(null);
  const [chartSel, setChartSel] = useState<string | null>(null);
  const [chartDrag, setChartDrag] = useState<{ id: string; dx: number; dy: number; dw: number; dh: number } | null>(null);
  const [hover, setHover] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const [dropdown, setDropdown] = useState<{ r: number; c: number; items: string[]; x: number; y: number } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState('cell');

  const L = layoutOf(sheet, engine);
  const z = zoom;
  const view = new GridView(sheet, L, scroll.x / z, scroll.y / z, size.w / z, size.h / z);
  const totalW = (HEADER_W + L.cols.total) * z + 40, totalH = (HEADER_H + L.rows.total) * z + 40;

  /* ---------- size and scroll ---------- */

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(50, el.clientWidth), h: Math.max(50, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    setScroll({ x: el.scrollLeft, y: el.scrollTop });
  };
  // keep the active cell visible after keyboard moves
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !scrollNonce) return;
    const { r, c } = sel.active;
    const x0 = L.cols.start(c) * z, x1 = (L.cols.start(c) + L.cols.size(c)) * z, y0 = L.rows.start(r) * z, y1 = (L.rows.start(r) + L.rows.size(r)) * z;
    const fw = L.cols.start(sheet.frozenCols) * z, fh = L.rows.start(sheet.frozenRows) * z;
    const vw = el.clientWidth - HEADER_W * z - fw, vh = el.clientHeight - HEADER_H * z - fh;
    if (c >= sheet.frozenCols) { if (x0 - fw < el.scrollLeft) el.scrollLeft = x0 - fw; else if (x1 - fw > el.scrollLeft + vw) el.scrollLeft = x1 - fw - vw; }
    if (r >= sheet.frozenRows) { if (y0 - fh < el.scrollTop) el.scrollTop = y0 - fh; else if (y1 - fh > el.scrollTop + vh) el.scrollTop = y1 - fh - vh; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollNonce]);

  /* ---------- painting ---------- */

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(size.w * dpr), H = Math.round(size.h * dpr);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
    const v = new GridView(sheet, layoutOf(sheet, engine), scroll.x / z, scroll.y / z, size.w / z, size.h / z);
    const ranges = fillPreview ? [fillPreview, ...sel.ranges.slice(1)] : sel.ranges;
    const ov: Overlay = { ranges, active: sel.active, copy: copyRect, refs, found, editing: editor && editor.sheet === sheet.id ? { r: editor.r, c: editor.c } : null, formulas: showFormulas };
    drawGrid(g, wb, v, engine, ov);
    if (fillPreview) { const b = v.rect(fillPreview); g.strokeStyle = '#1a73e8'; g.setLineDash([4, 3]); g.lineWidth = 1; g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1); g.setLineDash([]); }
  }, [wb, sheet, engine, scroll, size, z, sel, fillPreview, copyRect, refs, found, editor, showFormulas]);

  /* ---------- hit testing ---------- */

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = scrollerRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  };
  type Hit = { area: 'corner' } | { area: 'col'; c: number; resize?: number } | { area: 'row'; r: number; resize?: number } | { area: 'cell'; r: number; c: number; fill?: boolean; filter?: boolean; check?: boolean; arrow?: boolean };
  const hitAt = (x: number, y: number): Hit => {
    if (x < HEADER_W && y < HEADER_H) return { area: 'corner' };
    if (y < HEADER_H) {
      const c = view.colAt(x);
      const right = view.x(c) + L.cols.size(c);
      if (Math.abs(x - right) <= 4) return { area: 'col', c, resize: c };
      if (c > 0 && Math.abs(x - view.x(c)) <= 3) { let k = c - 1; while (k > 0 && !L.cols.size(k)) k--; return { area: 'col', c, resize: k }; }
      return { area: 'col', c };
    }
    if (x < HEADER_W) {
      const r = view.rowAt(y);
      const bottom = view.y(r) + L.rows.size(r);
      if (Math.abs(y - bottom) <= 3) return { area: 'row', r, resize: r };
      if (r > 0 && Math.abs(y - view.y(r)) <= 2) { let k = r - 1; while (k > 0 && !L.rows.size(k)) k--; return { area: 'row', r, resize: k }; }
      return { area: 'row', r };
    }
    const r = view.rowAt(y), c = view.colAt(x);
    const b = view.rect(selRect(sel));
    if (Math.abs(x - (b.x + b.w)) <= 5 && Math.abs(y - (b.y + b.h)) <= 5) return { area: 'cell', r, c, fill: true };
    const cx = view.x(c), cy = view.y(r), cw = L.cols.size(c), ch = L.rows.size(r);
    if (sheet.filter) { const fr = parseRect(sheet.filter.range); if (fr && r === fr.r1 && c >= fr.c1 && c <= fr.c2 && x >= cx + cw - 19 && y >= cy + (ch - 14) / 2 - 1 && y <= cy + (ch + 14) / 2 + 1) return { area: 'cell', r, c, filter: true }; }
    const v = sheet.validations.length ? validationAt(sheet, r, c) : undefined;
    if (v?.type === 'checkbox' && Math.abs(x - (cx + cw / 2)) <= 10 && Math.abs(y - (cy + ch / 2)) <= 10) return { area: 'cell', r, c, check: true };
    if (v && (v.type === 'list' || v.type === 'range') && x >= cx + cw - 16) return { area: 'cell', r, c, arrow: true };
    return { area: 'cell', r, c };
  };
  const mergedAt = (r: number, c: number): Rect | null => { for (const m of sheet.merges) { const x = parseRect(m)!; if (inRect(x, r, c)) return x; } return null; };
  const expand = (rect: Rect): Rect => {
    // a selection that touches part of a merged cell grows to cover it
    let out = norm(rect), changed = true;
    while (changed) {
      changed = false;
      for (const m of sheet.merges) { const x = parseRect(m)!; if (x.r1 <= out.r2 && x.r2 >= out.r1 && x.c1 <= out.c2 && x.c2 >= out.c1 && (x.r1 < out.r1 || x.r2 > out.r2 || x.c1 < out.c1 || x.c2 > out.c2)) { out = { r1: Math.min(out.r1, x.r1), c1: Math.min(out.c1, x.c1), r2: Math.max(out.r2, x.r2), c2: Math.max(out.c2, x.c2) }; changed = true; } }
    }
    return out;
  };
  const focusInput = (): void => { window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0); };

  /* ---------- pointer ---------- */

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.sh-chart, .sh-pop, .sh-editor, .sh-tip')) return;
    const el = scrollerRef.current!;
    const box = el.getBoundingClientRect();
    if (e.clientX - box.left > el.clientWidth || e.clientY - box.top > el.clientHeight) return; // the scrollbars
    setChartSel(null); setDropdown(null); setFilterMenu(null);
    const { x, y } = local(e);
    const h = hitAt(x, y);
    if (e.button === 2) {
      if (h.area === 'cell' && !sel.ranges.some((rg) => inRect(rg, h.r, h.c))) api.select(one(h.r, h.c));
      if (h.area === 'col' && !sel.ranges.some((rg) => rg.r1 === 0 && rg.r2 >= sheet.rows - 1 && h.c >= rg.c1 && h.c <= rg.c2)) api.select({ ranges: [{ r1: 0, r2: sheet.rows - 1, c1: h.c, c2: h.c }], active: { r: 0, c: h.c }, anchor: { r: 0, c: h.c } });
      if (h.area === 'row' && !sel.ranges.some((rg) => rg.c1 === 0 && rg.c2 >= sheet.cols - 1 && h.r >= rg.r1 && h.r <= rg.r2)) api.select({ ranges: [{ r1: h.r, r2: h.r, c1: 0, c2: sheet.cols - 1 }], active: { r: h.r, c: 0 }, anchor: { r: h.r, c: 0 } });
      return;
    }
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (h.area === 'corner') { if (editor) api.commitEdit(); api.select({ ranges: [{ r1: 0, c1: 0, r2: sheet.rows - 1, c2: sheet.cols - 1 }], active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } }); focusInput(); return; }
    if (h.area === 'col') {
      if (h.resize !== undefined) { drag.current = { kind: 'resize-col', index: h.resize, start: x, size: L.cols.size(h.resize) }; setGuide({ kind: 'col', at: view.x(h.resize) + L.cols.size(h.resize) }); return; }
      if (editor) api.commitEdit();
      const add = e.ctrlKey || e.metaKey;
      const a = e.shiftKey ? sel.anchor.c : h.c;
      const rect = { r1: 0, r2: sheet.rows - 1, c1: Math.min(a, h.c), c2: Math.max(a, h.c) };
      drag.current = { kind: 'cols', anchor: a, add, base: add ? sel.ranges : [] };
      api.select({ ranges: add ? [rect, ...sel.ranges] : [rect], active: { r: view.visibleRows()[0] < sheet.frozenRows ? 0 : 0, c: h.c }, anchor: { r: 0, c: a } });
      focusInput(); return;
    }
    if (h.area === 'row') {
      if (h.resize !== undefined) { drag.current = { kind: 'resize-row', index: h.resize, start: y, size: L.rows.size(h.resize) }; setGuide({ kind: 'row', at: view.y(h.resize) + L.rows.size(h.resize) }); return; }
      if (editor) api.commitEdit();
      const add = e.ctrlKey || e.metaKey;
      const a = e.shiftKey ? sel.anchor.r : h.r;
      const rect = { c1: 0, c2: sheet.cols - 1, r1: Math.min(a, h.r), r2: Math.max(a, h.r) };
      drag.current = { kind: 'rows', anchor: a, add, base: add ? sel.ranges : [] };
      api.select({ ranges: add ? [rect, ...sel.ranges] : [rect], active: { r: h.r, c: 0 }, anchor: { r: a, c: 0 } });
      focusInput(); return;
    }
    // cells
    if (editor && api.canPoint()) {
      const m = mergedAt(h.r, h.c) ?? { r1: h.r, c1: h.c, r2: h.r, c2: h.c };
      if (api.pointRef(m, false)) { drag.current = { kind: 'point', anchor: { r: h.r, c: h.c } }; return; }
    }
    if (h.fill && !editor) { drag.current = { kind: 'fill', from: selRect(sel), to: selRect(sel) }; return; }
    if (editor) api.commitEdit();
    if (h.filter) { const b = view.rect({ r1: h.r, c1: h.c, r2: h.r, c2: h.c }); setFilterMenu({ col: h.c, x: (b.x + b.w - 18) * z, y: (b.y + b.h) * z }); api.select(one(h.r, h.c)); return; }
    if (h.check) {
      const v = engine.value(sheet.id, h.r, h.c);
      api.select(one(h.r, h.c));
      api.run([{ op: 'set', sheet: sheet.id, range: addr(h.r, h.c), value: v === true ? false : true }], 'Toggle checkbox');
      focusInput(); return;
    }
    if (h.arrow) {
      api.select(one(h.r, h.c));
      const items = dropdownItems(wb, sheet, h.r, h.c, engine) ?? [];
      const b = view.rect(mergedAt(h.r, h.c) ?? { r1: h.r, c1: h.c, r2: h.r, c2: h.c });
      setDropdown({ r: h.r, c: h.c, items, x: b.x * z, y: (b.y + b.h) * z });
      return;
    }
    const add = e.ctrlKey || e.metaKey;
    const anchor = e.shiftKey ? sel.anchor : { r: h.r, c: h.c };
    const rect = expand({ r1: anchor.r, c1: anchor.c, r2: h.r, c2: h.c });
    drag.current = { kind: 'select', anchor, add, base: add ? sel.ranges : [] };
    api.select({ ranges: add ? [rect, ...sel.ranges] : [rect], active: e.shiftKey ? sel.active : { r: h.r, c: h.c }, anchor });
    focusInput();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const { x, y } = local(e);
    const d = drag.current;
    if (!d) {
      if ((e.target as HTMLElement).closest('.sh-chart, .sh-pop, .sh-editor')) return;
      const h = hitAt(x, y);
      const cur = h.area === 'col' && h.resize !== undefined ? 'col-resize' : h.area === 'row' && h.resize !== undefined ? 'row-resize' : h.area === 'cell' && h.fill ? 'crosshair' : h.area === 'cell' && (h.check || h.arrow || h.filter) ? 'pointer' : h.area === 'col' ? 's-resize' : h.area === 'row' ? 'e-resize' : 'cell';
      if (cur !== cursor) setCursor(cur);
      if (h.area === 'cell') {
        const cell = cellAt(sheet, h.r, h.c);
        const err = cell?.f ? engine.display(sheet.id, h.r, h.c).error : undefined;
        if (cell?.note || err || validationAt(sheet, h.r, h.c)?.help) { if (!hover || hover.r !== h.r || hover.c !== h.c) { const b = view.rect({ r1: h.r, c1: h.c, r2: h.r, c2: h.c }); setHover({ r: h.r, c: h.c, x: (b.x + b.w) * z, y: b.y * z }); } }
        else if (hover) setHover(null);
      } else if (hover) setHover(null);
      return;
    }
    // auto-scroll while dragging past an edge
    const el = scrollerRef.current!;
    if (d.kind === 'select' || d.kind === 'cols' || d.kind === 'rows' || d.kind === 'fill' || d.kind === 'point') {
      if (x * z > el.clientWidth - 16) el.scrollLeft += 24; else if (x < HEADER_W + view.fw && el.scrollLeft > 0) el.scrollLeft -= 24;
      if (y * z > el.clientHeight - 16) el.scrollTop += 24; else if (y < HEADER_H + view.fh && el.scrollTop > 0) el.scrollTop -= 24;
    }
    const r = Math.max(0, Math.min(sheet.rows - 1, view.rowAt(Math.max(HEADER_H, y)))), c = Math.max(0, Math.min(sheet.cols - 1, view.colAt(Math.max(HEADER_W, x))));
    switch (d.kind) {
      case 'select': {
        const rect = expand({ r1: d.anchor.r, c1: d.anchor.c, r2: r, c2: c });
        api.select({ ranges: [rect, ...d.base], active: sel.active, anchor: d.anchor });
        break;
      }
      case 'cols': api.select({ ranges: [{ r1: 0, r2: sheet.rows - 1, c1: Math.min(d.anchor, c), c2: Math.max(d.anchor, c) }, ...d.base], active: sel.active, anchor: sel.anchor }); break;
      case 'rows': api.select({ ranges: [{ c1: 0, c2: sheet.cols - 1, r1: Math.min(d.anchor, r), r2: Math.max(d.anchor, r) }, ...d.base], active: sel.active, anchor: sel.anchor }); break;
      case 'resize-col': { const w = Math.max(6, d.size + (x - d.start)); setGuide({ kind: 'col', at: view.x(d.index) + w }); break; }
      case 'resize-row': { const h = Math.max(6, d.size + (y - d.start)); setGuide({ kind: 'row', at: view.y(d.index) + h }); break; }
      case 'fill': {
        const f = d.from;
        const down = r > f.r2 ? r - f.r2 : 0, up = r < f.r1 ? f.r1 - r : 0, right = c > f.c2 ? c - f.c2 : 0, left = c < f.c1 ? f.c1 - c : 0;
        const vertical = Math.max(down, up) >= Math.max(right, left);
        const to = vertical ? { ...f, r1: up && !down ? r : f.r1, r2: down ? r : f.r2 } : { ...f, c1: left && !right ? c : f.c1, c2: right ? c : f.c2 };
        d.to = to;
        setFillPreview(to);
        break;
      }
      case 'point': api.pointRef(expand({ r1: d.anchor.r, c1: d.anchor.c, r2: r, c2: c }), true); break;
      case 'chart-move': case 'chart-size': {
        const dx = (e.clientX - d.x0) / z, dy = (e.clientY - d.y0) / z;
        d.dx = dx; d.dy = dy;
        setChartDrag(d.kind === 'chart-move' ? { id: d.id, dx, dy, dw: 0, dh: 0 } : { id: d.id, dx: 0, dy: 0, dw: dx, dh: dy });
        break;
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    drag.current = null;
    try { scrollerRef.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d) return;
    const { x, y } = local(e);
    if (d.kind === 'resize-col' || d.kind === 'resize-row') {
      setGuide(null);
      const col = d.kind === 'resize-col';
      const size = Math.round(Math.max(6, d.size + ((col ? x : y) - d.start)));
      if (Math.abs(size - d.size) < 1) return;
      // resizing one of several selected whole columns resizes them all
      const whole = sel.ranges.filter((rg) => (col ? rg.r1 === 0 && rg.r2 >= sheet.rows - 1 && d.index >= rg.c1 && d.index <= rg.c2 : rg.c1 === 0 && rg.c2 >= sheet.cols - 1 && d.index >= rg.r1 && d.index <= rg.r2));
      const span = whole[0] ? (col ? [whole[0].c1, whole[0].c2] : [whole[0].r1, whole[0].r2]) : [d.index, d.index];
      api.run([col ? { op: 'col_width', sheet: sheet.id, from: span[0] + 1, to: span[1] + 1, size } : { op: 'row_height', sheet: sheet.id, from: span[0] + 1, to: span[1] + 1, size }], col ? 'Resize column' : 'Resize row');
      return;
    }
    if (d.kind === 'fill') {
      setFillPreview(null);
      if (d.to.r1 === d.from.r1 && d.to.r2 === d.from.r2 && d.to.c1 === d.from.c1 && d.to.c2 === d.from.c2) return;
      if (api.run([{ op: 'fill', sheet: sheet.id, from: rectA1(d.from), to: rectA1(d.to) }], 'Fill')) api.select({ ranges: [d.to], active: sel.active, anchor: sel.anchor });
      focusInput();
      return;
    }
    if (d.kind === 'chart-move' || d.kind === 'chart-size') {
      setChartDrag(null);
      const ch = sheet.charts.find((c) => c.id === d.id);
      if (!ch || (Math.abs(d.dx) < 2 && Math.abs(d.dy) < 2)) return;
      if (d.kind === 'chart-size') { api.run([{ op: 'chart_set', id: ch.id, w: Math.round(ch.w + d.dx), h: Math.round(ch.h + d.dy) }], 'Resize chart'); return; }
      const p = parseAddr(ch.anchor)!;
      const gx = Math.max(0, L.cols.start(p.c) + ch.dx + d.dx), gy = Math.max(0, L.rows.start(p.r) + ch.dy + d.dy);
      const c = L.cols.at(gx), r = L.rows.at(gy);
      api.run([{ op: 'chart_set', id: ch.id, anchor: addr(r, c), dx: Math.round(gx - L.cols.start(c)), dy: Math.round(gy - L.rows.start(r)) }], 'Move chart');
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.sh-chart, .sh-pop, .sh-editor')) return;
    const { x, y } = local(e);
    const h = hitAt(x, y);
    if (h.area === 'col' && h.resize !== undefined) { api.run([{ op: 'col_width', sheet: sheet.id, from: h.resize + 1, fit: true }], 'Fit column'); return; }
    if (h.area === 'row' && h.resize !== undefined) { api.run([{ op: 'row_height', sheet: sheet.id, from: h.resize + 1, reset: true }], 'Reset row height'); return; }
    if (h.area !== 'cell' || h.check || h.filter) return;
    if (h.fill) {
      // double-clicking the fill handle fills down as far as the column to the left has data (like Sheets)
      const f = selRect(sel);
      let last = f.r2;
      const probe = f.c1 > 0 ? f.c1 - 1 : f.c2 + 1;
      while (last + 1 < sheet.rows && engine.value(sheet.id, last + 1, probe) !== null) last++;
      if (last > f.r2) api.run([{ op: 'fill', sheet: sheet.id, from: rectA1(f), to: rectA1({ ...f, r2: last }) }], 'Fill down');
      return;
    }
    const m = mergedAt(h.r, h.c);
    const r = m ? m.r1 : h.r, c = m ? m.c1 : h.c;
    const cell = cellAt(sheet, r, c);
    api.startEdit(r, c, cell?.f ?? rawText(cell, engine.display(sheet.id, r, c).text), 'edit');
  };

  /* ---------- editor geometry ---------- */

  const edBox = editor && editor.sheet === sheet.id ? (() => {
    const m = mergedAt(editor.r, editor.c) ?? { r1: editor.r, c1: editor.c, r2: editor.r, c2: editor.c };
    const b = view.rect(m);
    const f = cellAt(sheet, editor.r, editor.c)?.s;
    const fs = (f?.fs ?? 10) * 1.333 * z;
    const lines = editor.text.split('\n');
    const longest = Math.max(...lines.map((l) => l.length));
    return { left: b.x * z, top: b.y * z, minW: b.w * z, w: Math.min(size.w - b.x * z - 4, Math.max(b.w * z, longest * fs * 0.6 + 16)), h: Math.max(b.h * z, lines.length * fs * 1.3 + 6), fs, f };
  })() : null;
  const activeBox = (() => { const b = view.rect(mergedAt(sel.active.r, sel.active.c) ?? { r1: sel.active.r, c1: sel.active.c, r2: sel.active.r, c2: sel.active.c }); return { left: b.x * z, top: b.y * z }; })();

  /* ---------- charts ---------- */

  const chartSvgs = useMemo(() => new Map(sheet.charts.map((ch) => [ch.id, chartSvg(ch, wb, sheet, engine)])), [sheet, wb, engine]);
  const chartPos = (ch: Chart): { left: number; top: number } => {
    const p = parseAddr(ch.anchor) ?? { r: 0, c: 0 };
    const extra = chartDrag && chartDrag.id === ch.id ? chartDrag : null;
    return { left: (view.x(p.c) - HEADER_W + ch.dx + (extra?.dx ?? 0)) * z, top: (view.y(p.r) - HEADER_H + ch.dy + (extra?.dy ?? 0)) * z };
  };

  const filterRect = sheet.filter ? parseRect(sheet.filter.range) : null;
  const cellNote = hover ? cellAt(sheet, hover.r, hover.c) : null;
  const hoverErr = hover && cellNote?.f ? engine.display(sheet.id, hover.r, hover.c).error : undefined;
  const hoverHelp = hover ? validationAt(sheet, hover.r, hover.c)?.help : undefined;

  return (
    <div className="sh-grid" ref={scrollerRef} onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick} onContextMenu={(e) => { if ((e.target as HTMLElement).closest('.sh-pop, .sh-editor')) return; e.preventDefault(); const { x, y } = local(e); const h = hitAt(x, y); api.contextMenu(h.area === 'col' ? 'col' : h.area === 'row' ? 'row' : 'cell', e.clientX, e.clientY); }}
      style={{ cursor }} data-testid="sheet-grid">
      <div className="sh-grid__sticky" style={{ width: size.w, height: size.h }}>
        <canvas ref={canvasRef} className="sh-grid__canvas" style={{ width: size.w, height: size.h }} role="grid" aria-label="Spreadsheet grid" aria-rowcount={sheet.rows} aria-colcount={sheet.cols} />
        {guide && <div className={`sh-guide sh-guide--${guide.kind}`} style={guide.kind === 'col' ? { left: guide.at * z } : { top: guide.at * z }} />}
        <div className="sh-charts" style={{ left: HEADER_W * z, top: HEADER_H * z }}>
          {sheet.charts.map((ch) => {
            const pos = chartPos(ch);
            const extra = chartDrag && chartDrag.id === ch.id ? chartDrag : null;
            const w = Math.max(160, ch.w + (extra?.dw ?? 0)), h = Math.max(120, ch.h + (extra?.dh ?? 0));
            return (
              <div key={ch.id} className={`sh-chart${chartSel === ch.id ? ' sh-chart--on' : ''}`} style={{ left: pos.left, top: pos.top, width: w * z, height: h * z }} role="figure" aria-label={`Chart ${ch.title ?? ch.type}`} tabIndex={0}
                onPointerDown={(e) => { if ((e.target as HTMLElement).closest('button')) return; e.stopPropagation(); e.preventDefault(); setChartSel(ch.id); drag.current = { kind: (e.target as HTMLElement).classList.contains('sh-chart__size') ? 'chart-size' : 'chart-move', id: ch.id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 }; try { scrollerRef.current?.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }}
                onDoubleClick={(e) => { e.stopPropagation(); api.chartEdit(ch.id); }}
                onKeyDown={(e) => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); api.run([{ op: 'chart_delete', id: ch.id }], 'Delete chart'); } }}>
                <div className="sh-chart__svg" style={{ transform: `scale(${(w / ch.w) * z}, ${(h / ch.h) * z})` }} dangerouslySetInnerHTML={{ __html: chartSvgs.get(ch.id) ?? '' }} />
                {chartSel === ch.id && (
                  <>
                    <div className="sh-chart__tools">
                      <button type="button" aria-label="Edit chart" title="Edit chart" onClick={() => api.chartEdit(ch.id)}><Pencil size={12} /></button>
                      <button type="button" aria-label="Delete chart" title="Delete chart" onClick={() => api.run([{ op: 'chart_delete', id: ch.id }], 'Delete chart')}><Trash2 size={12} /></button>
                    </div>
                    <span className="sh-chart__size" aria-hidden />
                  </>
                )}
              </div>
            );
          })}
        </div>
        <textarea
          ref={inputRef}
          className={edBox ? 'sh-editor' : 'sh-keys'}
          aria-label={edBox ? 'Cell editor' : 'Spreadsheet keyboard input'}
          spellCheck={false}
          value={edBox && editor?.origin === 'cell' ? editor.text : edBox ? editor!.text : ''}
          style={edBox ? { left: edBox.left, top: edBox.top, minWidth: edBox.minW, width: edBox.w, height: edBox.h, fontSize: edBox.fs, fontWeight: edBox.f?.b ? 700 : 400, fontStyle: edBox.f?.i ? 'italic' : 'normal', color: edBox.f?.color, background: edBox.f?.fill ?? '#fff', textAlign: edBox.f?.ha ?? 'left' } : { left: activeBox.left, top: activeBox.top }}
          onChange={(e) => { if (editor) api.editText(e.target.value); else if (e.target.value) api.startEdit(sel.active.r, sel.active.c, e.target.value, 'enter'); }}
          onKeyDown={(e) => { if (editor) api.editorKey(e, e.currentTarget); else api.keyDown(e); }}
          onCopy={(e) => { if (!editor) api.copy(e, false); }}
          onCut={(e) => { if (!editor) api.copy(e, true); }}
          onPaste={(e) => { if (!editor) api.paste(e); }}
          onFocus={(e) => { if (!editor) e.currentTarget.select(); }}
        />
        {edBox && autocomplete && autocomplete.items.length > 0 && (
          <div className="sh-pop sh-suggest" role="listbox" aria-label="Function suggestions" style={{ left: edBox.left, top: edBox.top + edBox.h + 2 }}>
            {autocomplete.items.map((it, i) => (
              <button key={it.name} type="button" role="option" aria-selected={i === autocomplete.index} className={i === autocomplete.index ? 'sh-suggest--on' : ''} onPointerDown={(e) => { e.preventDefault(); onPickSuggestion(it.name); }}>
                <b>{it.name}</b><span>{it.syntax}</span>
              </button>
            ))}
          </div>
        )}
        {edBox && signature && !(autocomplete && autocomplete.items.length) && <div className="sh-pop sh-sig" role="note" style={{ left: edBox.left, top: edBox.top + edBox.h + 2 }}>{signature}</div>}
        {hover && (cellNote?.note || hoverErr || hoverHelp) && (
          <div className="sh-tip" role="tooltip" style={{ left: Math.min(hover.x + 4, size.w - 260), top: hover.y }}>
            {hoverErr && <p className="sh-tip__err"><b>Error</b> {hoverErr}</p>}
            {cellNote?.note && <p>{cellNote.note}</p>}
            {hoverHelp && <p>{hoverHelp}</p>}
          </div>
        )}
        {dropdown && (
          <div className="sh-pop sh-dropdown" role="listbox" aria-label="Choose a value" style={{ left: dropdown.x, top: dropdown.y }}>
            {dropdown.items.length === 0 && <p className="sh-note">No items</p>}
            {dropdown.items.map((it) => {
              const chip = validationAt(sheet, dropdown.r, dropdown.c)?.colors?.[it];
              return <button key={it} type="button" role="option" aria-selected={engine.display(sheet.id, dropdown.r, dropdown.c).text === it} onClick={() => { api.run([{ op: 'set', sheet: sheet.id, range: addr(dropdown.r, dropdown.c), value: it }], 'Choose value'); setDropdown(null); focusInput(); }}><span className="sh-chip" style={chip ? { background: chip } : undefined}>{it}</span></button>;
            })}
          </div>
        )}
        {filterMenu && filterRect && <FilterMenu sheet={sheet} engine={engine} col={filterMenu.col} rect={filterRect} x={Math.min(filterMenu.x, size.w - 280)} y={filterMenu.y} api={api} onClose={() => { setFilterMenu(null); focusInput(); }} />}
      </div>
      <div style={{ width: totalW, height: Math.max(0, totalH - size.h) }} aria-hidden />
    </div>
  );
}

export const rectA1 = (r: Rect): string => (r.r1 === r.r2 && r.c1 === r.c2 ? addr(r.r1, r.c1) : `${addr(r.r1, r.c1)}:${addr(r.r2, r.c2)}`);
/** What the editor shows for a cell that has no formula: numbers raw (not formatted, except dates/percent), text as is. */
export function rawText(cell: ReturnType<typeof cellAt>, shown: string): string {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
  if (typeof cell.v === 'number') {
    const nf = cell.s?.nf ?? '';
    if (/[yd]|h:|AM\/PM/i.test(nf.replace(/"[^"]*"/g, ''))) return shown;
    if (nf.includes('%')) return `${Number((cell.v * 100).toPrecision(12))}%`;
    return String(Number(cell.v.toPrecision(15)));
  }
  return typeof cell.v === 'string' && /^[-+]?(\d|\.\d)/.test(cell.v) && !Number.isNaN(Number(cell.v.replace(/,/g, ''))) ? `'${cell.v}` : String(cell.v);
}

function FilterMenu({ sheet, engine, col, rect, x, y, api, onClose }: { sheet: Sheet; engine: Engine; col: number; rect: Rect; x: number; y: number; api: GridApi; onClose: () => void }) {
  const values = useMemo(() => {
    const set = new Map<string, number>();
    const last = Math.min(rect.r2, sheet.rows - 1, rect.r1 + 5000);
    for (let r = rect.r1 + 1; r <= last; r++) { const t = engine.display(sheet.id, r, col).text; set.set(t, (set.get(t) ?? 0) + 1); }
    return [...set.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [sheet, engine, col, rect]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(sheet.filter?.hidden[col] ?? []));
  const [search, setSearch] = useState('');
  const cond0 = sheet.filter?.cond[col];
  const [condType, setCondType] = useState<string>(cond0?.type ?? '');
  const [condValue, setCondValue] = useState(String(cond0?.value ?? ''));
  const [condValue2, setCondValue2] = useState(String(cond0?.value2 ?? ''));
  const shown = values.filter(([t]) => t.toLowerCase().includes(search.toLowerCase()));
  const numeric = (v: string) => (v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
  const apply = (): void => {
    api.run([{ op: 'filter_set', sheet: sheet.id, col: col + 1, hide: [...hidden], condition: condType ? { type: condType, value: numeric(condValue), value2: numeric(condValue2) } : null }], 'Filter');
    onClose();
  };
  const sort = (desc: boolean): void => { api.run([{ op: 'sort', sheet: sheet.id, range: rectA1(rect), header: true, by: [{ col: col + 1, desc }] }], desc ? 'Sort Z→A' : 'Sort A→Z'); onClose(); };
  return (
    <div className="sh-pop sh-filter" role="dialog" aria-label={`Filter column ${addr(0, col).replace(/\d+/, '')}`} style={{ left: x, top: y }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
      <button type="button" className="sh-filter__sort" onClick={() => sort(false)}>Sort A → Z</button>
      <button type="button" className="sh-filter__sort" onClick={() => sort(true)}>Sort Z → A</button>
      <hr />
      <label className="sh-field">Filter by condition
        <select className="sh-select" aria-label="Filter condition" value={condType} onChange={(e) => setCondType(e.target.value)}>
          <option value="">None</option>
          <option value="empty">Is empty</option><option value="not_empty">Is not empty</option>
          <option value="contains">Text contains</option><option value="not_contains">Text does not contain</option><option value="starts">Text starts with</option><option value="ends">Text ends with</option>
          <option value="eq">Is equal to</option><option value="neq">Is not equal to</option>
          <option value="gt">Greater than</option><option value="gte">Greater than or equal to</option><option value="lt">Less than</option><option value="lte">Less than or equal to</option>
          <option value="between">Is between</option><option value="not_between">Is not between</option>
        </select>
      </label>
      {condType && !['empty', 'not_empty'].includes(condType) && <input className="sh-input" aria-label="Condition value" value={condValue} onChange={(e) => setCondValue(e.target.value)} />}
      {(condType === 'between' || condType === 'not_between') && <input className="sh-input" aria-label="Second condition value" value={condValue2} onChange={(e) => setCondValue2(e.target.value)} />}
      <p className="sh-h">Filter by values</p>
      <div className="sh-filter__row"><button type="button" className="sh-link" onClick={() => setHidden(new Set())}>Select all</button><button type="button" className="sh-link" onClick={() => setHidden(new Set(values.map(([t]) => t)))}>Clear</button></div>
      <input className="sh-input" aria-label="Search values" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="sh-filter__list">
        {shown.slice(0, 300).map(([t, n]) => (
          <label key={t} className="sh-check"><input type="checkbox" checked={!hidden.has(t)} onChange={(e) => { const next = new Set(hidden); if (e.target.checked) next.delete(t); else next.add(t); setHidden(next); }} /> {t === '' ? '(Blanks)' : t} <i>{n}</i></label>
        ))}
      </div>
      <div className="sh-filter__row"><span className="sh-grow" /><button type="button" className="sh-btn" onClick={onClose}>Cancel</button><button type="button" className="sh-btn sh-btn--primary" onClick={apply}>OK</button></div>
    </div>
  );
}
