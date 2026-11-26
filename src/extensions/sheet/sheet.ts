/** Workbook model of the Sheet menu (Google Sheets-style): sheets, cells with values / formulas / formats, sizes,
 * hidden and frozen rows and columns, merges, named ranges, notes, data validation, conditional formatting,
 * alternating colours, filters, charts — and every edit as an all-or-nothing list of operations.
 * Pure TypeScript with explicit .ts imports so node tests and agent tools use exactly the editor's logic. */
import {
  MAX_COLS, MAX_ROWS, addr, colIndex, colName, inRect, isErr, isMatrix, norm, overlaps, parse, parseAddr, parseRect, quoteSheet, rectText,
  shiftFormula, staticDeps, transformRefs, type Rect, type RefTok, type Scalar,
} from './formula.ts';
import { Engine, keyOf } from './engine.ts';
import { compare, criterion } from './functions.ts';
import { displayScalar, formatPattern, parseInput, partsFromSerial, serialFromParts, MONTHS, DAYS } from './numfmt.ts';

export const SHEET_DIR = '.pigry/sheets/';
export const SHEET_EXT = '.sheet.json';
export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLS = 26;
export const DEFAULT_COL_W = 100;
export const DEFAULT_ROW_H = 21;
export const MAX_CELLS = 2_000_000;

export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';
export type Wrap = 'overflow' | 'wrap' | 'clip';
export type LineStyle = 'solid' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';

export interface CellFmt {
  b?: boolean; i?: boolean; u?: boolean; s?: boolean;
  /** font size in pt (default 10) */
  fs?: number;
  ff?: string;
  color?: string;
  fill?: string;
  ha?: HAlign;
  va?: VAlign;
  wrap?: Wrap;
  /** number format pattern (see numfmt.ts) */
  nf?: string;
  /** borders as "style color", e.g. "solid #000000" */
  bt?: string; bb?: string; bl?: string; br?: string;
  /** text rotation in degrees (−90…90) */
  rot?: number;
}
export interface Cell {
  /** literal value (absent when the cell holds a formula) */
  v?: number | string | boolean | null;
  /** formula including the leading "=" */
  f?: string;
  s?: CellFmt;
  note?: string;
  link?: string;
}
export type ValidationType = 'list' | 'range' | 'number' | 'checkbox' | 'date' | 'text_length' | 'custom';
export interface Validation {
  id: string;
  range: string;
  type: ValidationType;
  /** list: the allowed items; range: source range text such as "Lists!A2:A20" */
  values?: string[];
  source?: string;
  /** number / date / text_length: between, not_between, gt, gte, lt, lte, eq, neq */
  op?: string;
  min?: number;
  max?: number;
  /** custom: formula relative to the top-left cell that must be TRUE */
  formula?: string;
  /** reject invalid input (true) or just warn (false) */
  strict: boolean;
  help?: string;
  /** colours of list items (chips) */
  colors?: Record<string, string>;
}
export type CondType = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | 'not_between' | 'contains' | 'not_contains' | 'starts' | 'ends' | 'empty' | 'not_empty' | 'formula' | 'scale' | 'duplicate' | 'unique' | 'top' | 'bottom' | 'above_avg' | 'below_avg' | 'error';
export interface CondStyle { fill?: string; color?: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean }
export interface CondFormat {
  id: string;
  range: string;
  type: CondType;
  value?: string | number;
  value2?: string | number;
  /** top/bottom: how many (default 10); percent: n is a percentage */
  n?: number;
  percent?: boolean;
  style?: CondStyle;
  /** scale: [min colour, max colour] or [min, mid, max] */
  colors?: string[];
}
export interface Banding { id: string; range: string; header?: string; odd: string; even: string; footer?: string }
export interface FilterState {
  range: string;
  /** column index (in the sheet) → hidden values (display text) */
  hidden: Record<string, string[]>;
  /** column index → condition, e.g. { type: 'gt', value: 10 } */
  cond: Record<string, { type: CondType; value?: string | number; value2?: string | number }>;
}
export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'stacked_column' | 'stacked_bar' | 'combo';
export interface Chart {
  id: string;
  type: ChartType;
  /** data range, may include a sheet name */
  range: string;
  title?: string;
  /** top-left cell the chart floats over */
  anchor: string;
  dx: number; dy: number;
  w: number; h: number;
  /** first row of the range holds series names */
  headers: boolean;
  /** first column of the range holds the x categories / values */
  labels: boolean;
  legend: 'right' | 'bottom' | 'top' | 'none';
  colors?: string[];
  xTitle?: string;
  yTitle?: string;
  smooth?: boolean;
  trendline?: boolean;
  /** pie: show percentages on slices */
  showValues?: boolean;
}
export interface Sheet {
  id: string;
  name: string;
  rows: number;
  cols: number;
  cells: Record<string, Cell>;
  /** column index → width in px; row index → height in px */
  colW: Record<string, number>;
  rowH: Record<string, number>;
  hiddenRows: number[];
  hiddenCols: number[];
  frozenRows: number;
  frozenCols: number;
  merges: string[];
  color?: string;
  hidden?: boolean;
  gridlines: boolean;
  validations: Validation[];
  condFormats: CondFormat[];
  bands: Banding[];
  filter?: FilterState;
  charts: Chart[];
}
export interface Workbook {
  version: 1;
  title: string;
  sheets: Sheet[];
  /** named ranges: name → "Sheet1!A1:B9" */
  names: Record<string, string>;
  nextId: number;
}

/* ---------------- construction and normalising ---------------- */

export function emptySheet(id: string, name: string, rows = DEFAULT_ROWS, cols = DEFAULT_COLS): Sheet {
  return { id, name, rows, cols, cells: {}, colW: {}, rowH: {}, hiddenRows: [], hiddenCols: [], frozenRows: 0, frozenCols: 0, merges: [], gridlines: true, validations: [], condFormats: [], bands: [], charts: [] };
}
export function emptyWorkbook(title = 'Untitled spreadsheet'): Workbook {
  return { version: 1, title, sheets: [emptySheet('s1', 'Sheet1')], names: {}, nextId: 2 };
}

export interface NormalizeResult { workbook: Workbook; warnings: string[] }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const COLOR_RE = /^#[0-9a-f]{3,8}$|^rgba?\([^)]*\)$|^[a-z]{3,20}$/i;
const color = (v: unknown): string | undefined => (typeof v === 'string' && COLOR_RE.test(v.trim()) ? v.trim() : undefined);

function normFmt(v: unknown): CellFmt | undefined {
  if (!isObj(v)) return undefined;
  const out: CellFmt = {};
  for (const k of ['b', 'i', 'u', 's'] as const) if (v[k] === true) out[k] = true;
  if (typeof v.fs === 'number') out.fs = num(v.fs, 10, 6, 72);
  if (typeof v.ff === 'string' && v.ff.length < 60) out.ff = v.ff;
  const c = color(v.color); if (c) out.color = c;
  const f = color(v.fill); if (f) out.fill = f;
  if (v.ha === 'left' || v.ha === 'center' || v.ha === 'right') out.ha = v.ha;
  if (v.va === 'top' || v.va === 'middle' || v.va === 'bottom') out.va = v.va;
  if (v.wrap === 'wrap' || v.wrap === 'clip' || v.wrap === 'overflow') out.wrap = v.wrap;
  if (typeof v.nf === 'string' && v.nf.length < 200) out.nf = v.nf;
  for (const k of ['bt', 'bb', 'bl', 'br'] as const) if (typeof v[k] === 'string' && /^(solid|medium|thick|dashed|dotted|double) \S+$/.test(v[k] as string)) out[k] = v[k] as string;
  if (typeof v.rot === 'number') out.rot = num(v.rot, 0, -90, 90);
  return Object.keys(out).length ? out : undefined;
}

export function normalizeWorkbook(input: unknown, fallbackTitle = 'Untitled spreadsheet'): NormalizeResult {
  const warnings: string[] = [];
  const src = isObj(input) ? input : {};
  if (!isObj(input)) warnings.push('the file was not a workbook object; started empty');
  const wb: Workbook = { version: 1, title: str(src.title, fallbackTitle).slice(0, 200) || fallbackTitle, sheets: [], names: {}, nextId: num(src.nextId, 1, 1) };
  const sheets = Array.isArray(src.sheets) ? src.sheets : [];
  const seen = new Set<string>();
  let maxId = 0;
  for (const raw of sheets) {
    if (!isObj(raw)) { warnings.push('dropped a sheet that was not an object'); continue; }
    let id = str(raw.id) || `s${wb.sheets.length + 1}`;
    if (seen.has(id)) { let n = sheets.length + 1; while (seen.has(`s${n}`)) n++; id = `s${n}`; warnings.push('renamed a duplicate sheet id'); }
    let name = str(raw.name).trim().slice(0, 100) || `Sheet${wb.sheets.length + 1}`;
    while (wb.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase())) name += ' (2)';
    seen.add(id);
    const s = emptySheet(id, name, Math.round(num(raw.rows, DEFAULT_ROWS, 1, MAX_ROWS)), Math.round(num(raw.cols, DEFAULT_COLS, 1, MAX_COLS)));
    if (isObj(raw.cells)) {
      let count = 0;
      for (const [a, c] of Object.entries(raw.cells)) {
        const p = parseAddr(a);
        if (!p || !isObj(c)) continue;
        if (++count > MAX_CELLS) { warnings.push(`only the first ${MAX_CELLS} cells were kept`); break; }
        const cell: Cell = {};
        if (typeof c.f === 'string' && c.f.startsWith('=') && c.f.length > 1) cell.f = c.f.slice(0, 50000);
        else if (typeof c.v === 'number' && Number.isFinite(c.v)) cell.v = c.v;
        else if (typeof c.v === 'string') cell.v = c.v.slice(0, 50000);
        else if (typeof c.v === 'boolean') cell.v = c.v;
        const fmt = normFmt(c.s); if (fmt) cell.s = fmt;
        if (typeof c.note === 'string' && c.note) cell.note = c.note.slice(0, 5000);
        if (typeof c.link === 'string' && /^(https?:|mailto:|#)/i.test(c.link)) cell.link = c.link;
        if (cell.f !== undefined || cell.v !== undefined || cell.s || cell.note || cell.link) {
          s.rows = Math.max(s.rows, p.r + 1); s.cols = Math.max(s.cols, p.c + 1);
          s.cells[addr(p.r, p.c)] = cell;
        }
      }
    }
    for (const [k, target] of [['colW', s.colW], ['rowH', s.rowH]] as const) {
      if (isObj(raw[k])) for (const [i, w] of Object.entries(raw[k] as Record<string, unknown>)) if (/^\d+$/.test(i) && typeof w === 'number') target[i] = num(w, 100, 2, 2000);
    }
    s.hiddenRows = Array.isArray(raw.hiddenRows) ? [...new Set(raw.hiddenRows.filter((x): x is number => Number.isInteger(x) && x >= 0))].sort((a, b) => a - b) : [];
    s.hiddenCols = Array.isArray(raw.hiddenCols) ? [...new Set(raw.hiddenCols.filter((x): x is number => Number.isInteger(x) && x >= 0))].sort((a, b) => a - b) : [];
    s.frozenRows = Math.round(num(raw.frozenRows, 0, 0, 50));
    s.frozenCols = Math.round(num(raw.frozenCols, 0, 0, 20));
    s.merges = Array.isArray(raw.merges) ? raw.merges.filter((m): m is string => typeof m === 'string' && !!parseRect(m)).map((m) => rectText(parseRect(m)!)) : [];
    const c = color(raw.color); if (c) s.color = c;
    if (raw.hidden === true) s.hidden = true;
    s.gridlines = raw.gridlines !== false;
    s.validations = Array.isArray(raw.validations) ? raw.validations.filter(isObj).filter((v) => typeof v.range === 'string' && parseRect(String(v.range))).map((v) => ({ ...(v as unknown as Validation), id: str(v.id) || `v${wb.nextId++}`, strict: v.strict !== false })) : [];
    s.condFormats = Array.isArray(raw.condFormats) ? raw.condFormats.filter(isObj).filter((v) => typeof v.range === 'string' && typeof v.type === 'string').map((v) => ({ ...(v as unknown as CondFormat), id: str(v.id) || `cf${wb.nextId++}` })) : [];
    s.bands = Array.isArray(raw.bands) ? raw.bands.filter(isObj).filter((v) => typeof v.range === 'string').map((v) => ({ ...(v as unknown as Banding), id: str(v.id) || `b${wb.nextId++}` })) : [];
    if (isObj(raw.filter) && typeof raw.filter.range === 'string' && parseRect(raw.filter.range)) s.filter = { range: raw.filter.range, hidden: isObj(raw.filter.hidden) ? (raw.filter.hidden as Record<string, string[]>) : {}, cond: isObj(raw.filter.cond) ? (raw.filter.cond as FilterState['cond']) : {} };
    s.charts = Array.isArray(raw.charts) ? raw.charts.filter(isObj).filter((v) => typeof v.range === 'string').map((v) => normChart(v, `ch${wb.nextId++}`)) : [];
    wb.sheets.push(s);
    const m = /^s(\d+)$/.exec(id); if (m) maxId = Math.max(maxId, Number(m[1]));
  }
  if (!wb.sheets.length) { wb.sheets.push(emptySheet('s1', 'Sheet1')); maxId = Math.max(maxId, 1); }
  if (isObj(src.names)) for (const [n, r] of Object.entries(src.names)) if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && typeof r === 'string') wb.names[n] = r;
  wb.nextId = Math.max(wb.nextId, maxId + 1);
  return { workbook: wb, warnings };
}
function normChart(v: Record<string, unknown>, id: string): Chart {
  const types: ChartType[] = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'stacked_column', 'stacked_bar', 'combo'];
  return {
    id: str(v.id) || id, type: types.includes(v.type as ChartType) ? (v.type as ChartType) : 'column', range: str(v.range),
    title: typeof v.title === 'string' ? v.title.slice(0, 200) : undefined, anchor: parseAddr(str(v.anchor)) ? str(v.anchor).toUpperCase() : 'H2',
    dx: num(v.dx, 0, 0, 2000), dy: num(v.dy, 0, 0, 2000), w: num(v.w, 480, 160, 2400), h: num(v.h, 300, 120, 1600),
    headers: v.headers !== false, labels: v.labels !== false, legend: (['right', 'bottom', 'top', 'none'] as const).includes(v.legend as 'right') ? (v.legend as Chart['legend']) : 'bottom',
    colors: Array.isArray(v.colors) ? v.colors.map(color).filter((c): c is string => !!c) : undefined,
    xTitle: typeof v.xTitle === 'string' ? v.xTitle : undefined, yTitle: typeof v.yTitle === 'string' ? v.yTitle : undefined,
    smooth: v.smooth === true, trendline: v.trendline === true, showValues: v.showValues === true,
  };
}

export function parseWorkbookJson(text: string, fallbackTitle?: string): NormalizeResult {
  try { return normalizeWorkbook(JSON.parse(text), fallbackTitle); }
  catch { const r = normalizeWorkbook(null, fallbackTitle); r.warnings = ['the file is not valid JSON; started empty']; return r; }
}
export const serializeWorkbook = (wb: Workbook): string => JSON.stringify(wb, null, 1) + '\n';

/* ---------------- lookups ---------------- */

export const cellAt = (s: Sheet, r: number, c: number): Cell | undefined => s.cells[addr(r, c)];
export function findSheet(wb: Workbook, ref: unknown): Sheet | undefined {
  if (typeof ref === 'number') return wb.sheets[ref - 1];
  const t = String(ref ?? '').trim();
  return wb.sheets.find((s) => s.id === t) ?? wb.sheets.find((s) => s.name.toLowerCase() === t.toLowerCase());
}
/** "Sheet2!A1:B3" or "A1:B3" (on `fallback`) → sheet + rectangle (clamped to the sheet's size). */
export function resolveRange(wb: Workbook, text: string, fallback: Sheet): { sheet: Sheet; rect: Rect } | null {
  const t = text.trim();
  const bang = t.lastIndexOf('!');
  let sheet = fallback, body = t;
  if (bang >= 0) {
    const nm = t.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    const found = findSheet(wb, nm);
    if (!found) return null;
    sheet = found; body = t.slice(bang + 1);
  } else {
    const named = Object.entries(wb.names).find(([n]) => n.toLowerCase() === t.toLowerCase());
    if (named) return resolveRange(wb, named[1], fallback);
  }
  const rect = parseRect(body, sheet.rows, sheet.cols);
  if (!rect) return null;
  return { sheet, rect: { r1: rect.r1, c1: rect.c1, r2: Math.min(rect.r2, sheet.rows - 1), c2: Math.min(rect.c2, sheet.cols - 1) } };
}
export function usedRect(s: Sheet): Rect | null {
  let r2 = -1, c2 = -1, r1 = Infinity, c1 = Infinity;
  for (const [a, cell] of Object.entries(s.cells)) {
    if (cell.f === undefined && (cell.v === undefined || cell.v === null || cell.v === '')) continue;
    const p = parseAddr(a)!;
    r1 = Math.min(r1, p.r); c1 = Math.min(c1, p.c); r2 = Math.max(r2, p.r); c2 = Math.max(c2, p.c);
  }
  return r2 < 0 ? null : { r1, c1, r2, c2 };
}
export const mergeAt = (s: Sheet, r: number, c: number): Rect | null => {
  for (const m of s.merges) { const rect = parseRect(m)!; if (inRect(rect, r, c)) return rect; }
  return null;
};
export const colWidth = (s: Sheet, c: number): number => (s.hiddenCols.includes(c) ? 0 : s.colW[c] ?? DEFAULT_COL_W);
export const rowHeight = (s: Sheet, r: number): number => (s.hiddenRows.includes(r) ? 0 : s.rowH[r] ?? DEFAULT_ROW_H);

/* ---------------- operations ---------------- */

export type Op = Record<string, unknown> & { op: string };
export interface ApplyResult { workbook: Workbook; error?: string; log: string[]; touched: string[] | 'all'; created?: string }
export interface ApplyOptions { sheet?: string; engine?: Engine }

class OpError extends Error {}
const fail = (msg: string): never => { throw new OpError(msg); };

export const OP_HELP = [
  'set {range, value | values: [[…],[…]] | formula} — type into cells like a person would: "=…" is a formula, "12%", "$5", "2026-01-31", "TRUE" are parsed; raw:true keeps text as is. values fills rows from the top-left of range.',
  'clear {range, what?: all|values|formats|notes}',
  'format {range, bold, italic, underline, strike, size, font, color, fill, align: left|center|right, valign: top|middle|bottom, wrap: overflow|wrap|clip, number: preset id (number, percent, currency, thb, date, time, datetime, scientific, accounting, financial, text, integer, auto…) or pattern ("#,##0.00", "0.0%", "yyyy-mm-dd", "[Red]-0.00"), rotate}',
  'border {range, where: all|outer|inner|top|bottom|left|right|horizontal|vertical|none, style: solid|medium|thick|dashed|dotted|double, color}',
  'merge {range, mode?: all|horizontal|vertical} · unmerge {range}',
  'insert_rows {at: row number, count?, before?: true} · delete_rows {at, count?} · insert_cols {at: "C" or number, count?} · delete_cols {at, count?} — formulas everywhere are adjusted (deleted references become #REF!)',
  'row_height {from, to?, size} · col_width {from: "A", to?, size | fit: true} · hide_rows/show_rows {from, to?} · hide_cols/show_cols {from, to?}',
  'freeze {rows?, cols?}',
  'sheet_add {name, at?, rows?, cols?} · sheet_rename {sheet, name} (formulas follow) · sheet_delete {sheet} · sheet_duplicate {sheet, name?} · sheet_move {sheet, to: position} · sheet_set {sheet, color?, hidden?, gridlines?, rows?, cols?}',
  'name_set {name, range} · name_delete {name}',
  'note {cell, text} (empty text removes) · link {cell, url}',
  'validation {range, type: list|range|number|checkbox|date|text_length|custom, values?: [..] (list), source?: "A1:A9" (range), rule?: between|not_between|gt|gte|lt|lte|eq|neq, min?, max?, formula? (custom), strict?: true, help?} · validation_clear {range}',
  'cond_format {range, type: gt|gte|lt|lte|eq|neq|between|not_between|contains|not_contains|starts|ends|empty|not_empty|error|duplicate|unique|top|bottom|above_avg|below_avg|formula|scale, value?, value2?, n?, percent?, style?: {fill, color, bold, italic, strike}, colors?: [min, (mid), max] for scale} · cond_format_delete {id | range}',
  'banding {range, header?: colour, odd: colour, even: colour} · banding_delete {range}',
  'sort {range, by: [{col: "B", desc?: true}] | col + desc, header?: true} — sorts rows of the range by computed values',
  'filter {range} turns on the filter for a table · filter_set {col: "B", hide?: ["value", …], condition?: {type, value, value2}} · filter_clear {}',
  'find_replace {find, replace, all_sheets?, match_case?, whole?, regex?, formulas?}',
  'copy {from, to, paste?: all|values|formats|formulas, transpose?} — relative references shift like copy/paste · move {from, to} — like cut/paste: references to the moved cells follow',
  'fill {from, to} — the fill handle: numbers, dates, "Item 1", months and weekdays continue as a series, formulas are copied with relative references',
  'remove_duplicates {range, cols?: ["A","C"], header?: true} · trim {range} · split {range, delimiter?: "," } (text to columns) · fill_series_down is fill',
  'chart_add {type: column|bar|line|area|pie|doughnut|scatter|stacked_column|stacked_bar|combo, range, title?, anchor?: "H2", w?, h?, headers?, labels?, legend?, colors?, xTitle?, yTitle?, smooth?, trendline?} · chart_set {id, …} · chart_delete {id}',
  'pivot {source: "A1:D100", rows: "B" (group by column), values: [{col: "D", fn: sum|count|counta|average|min|max}], columns?: "C", target: "F1" or "NewSheet!A1"} — writes a summary table built from live SUMIFS/COUNTIFS/AVERAGEIFS/MINIFS/MAXIFS formulas',
  'workbook {title}',
].join('\n');

interface Ctx { wb: Workbook; sheet: Sheet; log: string[]; touched: Set<string> | 'all'; engine: () => Engine; created?: string }

const touch = (cx: Ctx, s: Sheet, r: number, c: number): void => { if (cx.touched !== 'all') cx.touched.add(`${s.id}!${addr(r, c)}`); };
const touchRect = (cx: Ctx, s: Sheet, rect: Rect): void => {
  if (cx.touched === 'all') return;
  if ((rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1) > 4000) { cx.touched = 'all'; return; }
  for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) touch(cx, s, r, c);
};
const structural = (cx: Ctx): void => { cx.touched = 'all'; };

function rangeArg(cx: Ctx, op: Op, key = 'range', required = true): { sheet: Sheet; rect: Rect } {
  const raw = op[key] ?? (key === 'range' ? op.cell : undefined);
  if (raw === undefined || raw === null || raw === '') { if (required) fail(`needs ${key}`); return { sheet: cx.sheet, rect: { r1: 0, c1: 0, r2: 0, c2: 0 } }; }
  const sheetOf = op.sheet !== undefined ? findSheet(cx.wb, op.sheet) : cx.sheet;
  if (!sheetOf) fail(`no sheet "${String(op.sheet)}"`);
  const res = resolveRange(cx.wb, String(raw), sheetOf!);
  if (!res) fail(`"${String(raw)}" is not a range like A1, B2:D9, C:C or Sheet2!A1:B5`);
  return res!;
}
const sheetArg = (cx: Ctx, op: Op, key = 'sheet'): Sheet => {
  const s = op[key] === undefined ? cx.sheet : findSheet(cx.wb, op[key]);
  if (!s) fail(`no sheet "${String(op[key])}" (sheets: ${cx.wb.sheets.map((x) => x.name).join(', ')})`);
  return s!;
};
const colArg = (v: unknown, what = 'column'): number => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v - 1;
  if (typeof v === 'string' && /^[A-Za-z]{1,3}$/.test(v.trim())) return colIndex(v.trim());
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v) - 1;
  return fail(`${what} must be a letter like "C" or a number from 1`);
};
const rowArg = (v: unknown, what = 'row'): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`${what} must be a row number from 1`);
  return n - 1;
};
const newId = (cx: Ctx, prefix: string): string => `${prefix}${cx.wb.nextId++}`;

function setCell(s: Sheet, r: number, c: number, cell: Cell | undefined): void {
  const a = addr(r, c);
  if (!cell || (cell.f === undefined && (cell.v === undefined || cell.v === null || cell.v === '') && !cell.s && !cell.note && !cell.link)) { delete s.cells[a]; return; }
  if (cell.v === null || cell.v === '') delete cell.v;
  s.cells[a] = cell;
}
/** Input as a person types it: formulas, numbers, %, currency, dates (with an automatic number format), booleans, text. */
export function inputCell(old: Cell | undefined, value: unknown, rawText = false): Cell | undefined {
  const next: Cell = { ...(old ?? {}) };
  delete next.f; delete next.v;
  if (value === null || value === undefined || value === '') return next;
  if (typeof value === 'number' || typeof value === 'boolean') { if (typeof value === 'number' && !Number.isFinite(value)) fail('numbers must be finite'); next.v = value; return next; }
  const text = String(value);
  if (!rawText && text.startsWith('=') && text.length > 1) {
    try { parse(text); } catch (e) { fail(`formula ${text} does not parse: ${e instanceof Error ? e.message : String(e)}`); }
    next.f = text; return next;
  }
  if (rawText || old?.s?.nf === '@') { next.v = text; return next; }
  const p = parseInput(text);
  next.v = p.value;
  if (p.format && !old?.s?.nf) next.s = { ...(next.s ?? {}), nf: p.format };
  return next;
}

function eachCell(rect: Rect, fn: (r: number, c: number) => void): void {
  if ((rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1) > MAX_CELLS) fail('the range is too large');
  for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) fn(r, c);
}
/** Cells that actually exist inside a (possibly huge) rectangle. */
function existing(s: Sheet, rect: Rect): { r: number; c: number; a: string }[] {
  const out: { r: number; c: number; a: string }[] = [];
  for (const a of Object.keys(s.cells)) { const p = parseAddr(a)!; if (inRect(rect, p.r, p.c)) out.push({ r: p.r, c: p.c, a }); }
  return out;
}

const NUMBER_ALIASES: Record<string, string> = { percent: 'percent', percentage: 'percent', currency: 'currency', money: 'currency', date: 'date', time: 'time', datetime: 'datetime', number: 'number', plain: 'text', text: 'text', automatic: 'auto', auto: 'auto', general: 'auto' };
function numberPattern(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const id = NUMBER_ALIASES[v.toLowerCase()] ?? v;
  const preset = formatPattern(id);
  if (preset !== undefined) return preset;
  if (v.length > 200) fail('number format is too long');
  return v;
}

function applyFormat(cx: Ctx, op: Op): void {
  const { sheet, rect } = rangeArg(cx, op);
  const patch: CellFmt = {};
  const unset: (keyof CellFmt)[] = [];
  const flag = (k: 'b' | 'i' | 'u' | 's', v: unknown) => { if (v === true) patch[k] = true; else if (v === false) unset.push(k); };
  flag('b', op.bold ?? op.b); flag('i', op.italic ?? op.i); flag('u', op.underline ?? op.u); flag('s', op.strike ?? op.strikethrough ?? op.s);
  if (op.size !== undefined) patch.fs = num(Number(op.size), 10, 6, 72);
  if (typeof op.font === 'string') patch.ff = op.font.slice(0, 60);
  for (const [k, key] of [['color', 'color'], ['fill', 'fill'], ['fill', 'background']] as const) {
    if (op[key] === null || op[key] === '') unset.push(k);
    else if (op[key] !== undefined) { const c = color(op[key]); if (!c) fail(`${key} must be a colour like #1a73e8`); patch[k] = c; }
  }
  if (op.align !== undefined) { if (!['left', 'center', 'right'].includes(String(op.align))) fail('align must be left, center or right'); patch.ha = op.align as HAlign; }
  if (op.valign !== undefined) { if (!['top', 'middle', 'bottom'].includes(String(op.valign))) fail('valign must be top, middle or bottom'); patch.va = op.valign as VAlign; }
  if (op.wrap !== undefined) { const w = op.wrap === true ? 'wrap' : op.wrap === false ? 'overflow' : String(op.wrap); if (!['overflow', 'wrap', 'clip'].includes(w)) fail('wrap must be overflow, wrap or clip'); patch.wrap = w as Wrap; }
  if (op.number !== undefined || op.nf !== undefined) { const p = numberPattern(op.number ?? op.nf); if (p === '' || p === undefined) unset.push('nf'); else patch.nf = p; }
  if (op.rotate !== undefined) patch.rot = num(Number(op.rotate), 0, -90, 90);
  if (op.reset === true || op.clear === true) {
    for (const { r, c } of existing(sheet, rect)) { const cell = cellAt(sheet, r, c); if (cell) { const n = { ...cell }; delete n.s; setCell(sheet, r, c, n); } }
    touchRect(cx, sheet, rect);
    return;
  }
  if (!Object.keys(patch).length && !unset.length) fail('format needs at least one property (bold, color, fill, number, align…)');
  eachCell(rect, (r, c) => {
    const cell = { ...(cellAt(sheet, r, c) ?? {}) };
    const s = { ...(cell.s ?? {}), ...patch };
    for (const k of unset) delete s[k];
    cell.s = Object.keys(s).length ? s : undefined;
    if (!cell.s) delete cell.s;
    setCell(sheet, r, c, cell);
  });
  touchRect(cx, sheet, rect);
}

function applyBorder(cx: Ctx, op: Op): void {
  const { sheet, rect } = rangeArg(cx, op);
  const where = String(op.where ?? op.type ?? 'all');
  const style = String(op.style ?? 'solid');
  if (!['solid', 'medium', 'thick', 'dashed', 'dotted', 'double'].includes(style)) fail('style must be solid, medium, thick, dashed, dotted or double');
  const col = op.color === undefined ? '#000000' : color(op.color) ?? fail('color must be a colour like #000000');
  const line = `${style} ${col}`;
  if (!['all', 'outer', 'inner', 'top', 'bottom', 'left', 'right', 'horizontal', 'vertical', 'none'].includes(where)) fail('where must be all, outer, inner, top, bottom, left, right, horizontal, vertical or none');
  eachCell(rect, (r, c) => {
    const cell = { ...(cellAt(sheet, r, c) ?? {}) };
    const s: CellFmt = { ...(cell.s ?? {}) };
    const top = r === rect.r1, bottom = r === rect.r2, left = c === rect.c1, right = c === rect.c2;
    const set = (k: 'bt' | 'bb' | 'bl' | 'br', on: boolean) => { if (on) s[k] = line; };
    if (where === 'none') { delete s.bt; delete s.bb; delete s.bl; delete s.br; }
    else {
      set('bt', where === 'all' || (where === 'outer' && top) || (where === 'top' && top) || ((where === 'inner' || where === 'horizontal') && !top));
      set('bb', where === 'all' || (where === 'outer' && bottom) || (where === 'bottom' && bottom) || ((where === 'inner' || where === 'horizontal') && !bottom));
      set('bl', where === 'all' || (where === 'outer' && left) || (where === 'left' && left) || ((where === 'inner' || where === 'vertical') && !left));
      set('br', where === 'all' || (where === 'outer' && right) || (where === 'right' && right) || ((where === 'inner' || where === 'vertical') && !right));
    }
    cell.s = Object.keys(s).length ? s : undefined;
    if (!cell.s) delete cell.s;
    setCell(sheet, r, c, cell);
  });
  touchRect(cx, sheet, rect);
}

function applyMerge(cx: Ctx, op: Op): void {
  const { sheet, rect } = rangeArg(cx, op);
  const mode = String(op.mode ?? 'all');
  const parts: Rect[] = mode === 'horizontal' ? Array.from({ length: rect.r2 - rect.r1 + 1 }, (_, i) => ({ r1: rect.r1 + i, r2: rect.r1 + i, c1: rect.c1, c2: rect.c2 }))
    : mode === 'vertical' ? Array.from({ length: rect.c2 - rect.c1 + 1 }, (_, i) => ({ r1: rect.r1, r2: rect.r2, c1: rect.c1 + i, c2: rect.c1 + i }))
      : mode === 'all' ? [rect] : fail('mode must be all, horizontal or vertical');
  sheet.merges = sheet.merges.filter((m) => !overlaps(parseRect(m)!, rect));
  for (const p of parts) {
    if (p.r1 === p.r2 && p.c1 === p.c2) continue;
    // keep only the top-left value (like Sheets)
    for (const { r, c } of existing(sheet, p)) if (r !== p.r1 || c !== p.c1) { const cell = cellAt(sheet, r, c)!; const n = { ...cell }; delete n.v; delete n.f; setCell(sheet, r, c, n); }
    sheet.merges.push(rectText(p));
  }
  touchRect(cx, sheet, rect);
}

/* ---- structural changes: rows and columns ---- */

type Axis = 'row' | 'col';
/** Shifts a span [a, b] on an axis for an insert (n > 0 at `at`) or a delete (n < 0 removing [at, at−n)). null = gone. */
function shiftSpan(a: number, b: number, at: number, n: number): [number, number] | null {
  if (n > 0) return [a >= at ? a + n : a, Number.isFinite(b) && b >= at ? b + n : b];
  const del = -n, end = at + del - 1;
  if (a >= at && b <= end) return null;
  const na = a < at ? a : a > end ? a - del : at;
  const nb = !Number.isFinite(b) ? b : b < at ? b : b > end ? b - del : at - 1;
  if (nb < na) return null;
  return [na, nb];
}
function shiftRectAxis(rect: Rect, axis: Axis, at: number, n: number): Rect | null {
  const span = axis === 'row' ? shiftSpan(rect.r1, rect.r2, at, n) : shiftSpan(rect.c1, rect.c2, at, n);
  if (!span) return null;
  return axis === 'row' ? { ...rect, r1: span[0], r2: span[1] } : { ...rect, c1: span[0], c2: span[1] };
}
/** Rewrites formulas in every sheet for an insert / delete on `target`. */
function shiftWorkbookRefs(wb: Workbook, target: Sheet, axis: Axis, at: number, n: number): void {
  const fix = (ref: RefTok, home: Sheet): RefTok | null => {
    const sheet = ref.sheet === undefined ? home : findSheet(wb, ref.sheet);
    if (sheet !== target) return ref;
    if (axis === 'row' && ref.kind === 'cols') return ref;
    if (axis === 'col' && ref.kind === 'rows') return ref;
    const span = axis === 'row' ? shiftSpan(ref.r1, ref.r2, at, n) : shiftSpan(ref.c1, ref.c2, at, n);
    if (!span) return null;
    return axis === 'row' ? { ...ref, r1: span[0], r2: ref.kind === 'cell' ? span[0] : span[1] } : { ...ref, c1: span[0], c2: ref.kind === 'cell' ? span[0] : span[1] };
  };
  for (const s of wb.sheets) for (const cell of Object.values(s.cells)) if (cell.f) cell.f = transformRefs(cell.f, (ref) => fix(ref, s));
  for (const s of wb.sheets) for (const cf of s.condFormats) if (cf.type === 'formula' && typeof cf.value === 'string') cf.value = transformRefs(cf.value.startsWith('=') ? cf.value : '=' + cf.value, (ref) => fix(ref, s));
  for (const [name, text] of Object.entries(wb.names)) {
    const res = resolveRange(wb, text, wb.sheets[0]);
    if (!res || res.sheet !== target) continue;
    const moved = shiftRectAxis(res.rect, axis, at, n);
    if (!moved) delete wb.names[name]; else wb.names[name] = `${quoteSheet(res.sheet.name)}!${rectText(moved)}`;
  }
  for (const s of wb.sheets) for (const ch of s.charts) {
    const res = resolveRange(wb, ch.range, s);
    if (res && res.sheet === target) { const moved = shiftRectAxis(res.rect, axis, at, n); if (moved) ch.range = (ch.range.includes('!') ? `${quoteSheet(target.name)}!` : '') + rectText(moved); }
  }
}
function shiftSheetContent(s: Sheet, axis: Axis, at: number, n: number): void {
  const cells: Record<string, Cell> = {};
  for (const [a, cell] of Object.entries(s.cells)) {
    const p = parseAddr(a)!;
    const v = axis === 'row' ? p.r : p.c;
    let nv = v;
    if (n > 0) nv = v >= at ? v + n : v;
    else { const del = -n; if (v >= at && v < at + del) continue; nv = v >= at + del ? v - del : v; }
    cells[axis === 'row' ? addr(nv, p.c) : addr(p.r, nv)] = cell;
  }
  s.cells = cells;
  const remapIdx = (rec: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, w] of Object.entries(rec)) { const i = Number(k); if (n > 0) out[i >= at ? i + n : i] = w; else { const del = -n; if (i >= at && i < at + del) continue; out[i >= at + del ? i - del : i] = w; } }
    return out;
  };
  const remapList = (list: number[]): number[] => list.flatMap((i) => (n > 0 ? [i >= at ? i + n : i] : i >= at && i < at - n ? [] : [i >= at - n ? i + n : i]));
  if (axis === 'row') { s.rowH = remapIdx(s.rowH); s.hiddenRows = remapList(s.hiddenRows); s.rows = Math.max(1, Math.min(MAX_ROWS, s.rows + n)); }
  else { s.colW = remapIdx(s.colW); s.hiddenCols = remapList(s.hiddenCols); s.cols = Math.max(1, Math.min(MAX_COLS, s.cols + n)); }
  const rects = <T extends { range: string }>(list: T[]): T[] => list.flatMap((x) => { const r = parseRect(x.range); if (!r) return []; const m = shiftRectAxis(r, axis, at, n); return m ? [{ ...x, range: rectText(m) }] : []; });
  s.merges = s.merges.flatMap((m) => { const r = shiftRectAxis(parseRect(m)!, axis, at, n); return r && (r.r1 !== r.r2 || r.c1 !== r.c2) ? [rectText(r)] : []; });
  s.validations = rects(s.validations);
  s.condFormats = rects(s.condFormats);
  s.bands = rects(s.bands);
  if (s.filter) {
    const r = parseRect(s.filter.range); const m = r ? shiftRectAxis(r, axis, at, n) : null;
    if (!m) s.filter = undefined;
    else {
      const remapCols = <V>(rec: Record<string, V>): Record<string, V> => (axis === 'row' ? rec : Object.fromEntries(Object.entries(rec).flatMap(([k, v]) => { const i = Number(k); if (n < 0 && i >= at && i < at - n) return []; return [[String(n > 0 ? (i >= at ? i + n : i) : i >= at - n ? i + n : i), v]]; })));
      s.filter = { range: rectText(m), hidden: remapCols(s.filter.hidden), cond: remapCols(s.filter.cond) };
    }
  }
  for (const ch of s.charts) {
    const p = parseAddr(ch.anchor)!;
    const v = axis === 'row' ? p.r : p.c;
    const nv = n > 0 ? (v >= at ? v + n : v) : v >= at - n ? v + n : Math.min(v, at);
    ch.anchor = axis === 'row' ? addr(Math.max(0, nv), p.c) : addr(p.r, Math.max(0, nv));
  }
  if (axis === 'row' && n < 0 && s.frozenRows > at) s.frozenRows = Math.max(at, s.frozenRows + n);
  if (axis === 'col' && n < 0 && s.frozenCols > at) s.frozenCols = Math.max(at, s.frozenCols + n);
  if (axis === 'row' && n > 0 && s.frozenRows > at) s.frozenRows = Math.min(50, s.frozenRows + n);
  if (axis === 'col' && n > 0 && s.frozenCols > at) s.frozenCols = Math.min(20, s.frozenCols + n);
}
function insertDelete(cx: Ctx, op: Op, axis: Axis, insert: boolean): void {
  const s = sheetArg(cx, op);
  let at = axis === 'row' ? rowArg(op.at ?? op.row, 'at') : colArg(op.at ?? op.col, 'at');
  const count = Math.round(num(Number(op.count ?? 1), 1, 1, 100000));
  if (insert && op.after === true) at += 1;
  if (!insert && at >= (axis === 'row' ? s.rows : s.cols)) fail(`${axis === 'row' ? 'row' : 'column'} ${axis === 'row' ? at + 1 : colName(at)} is outside the sheet`);
  if (!insert && count >= (axis === 'row' ? s.rows : s.cols)) fail(`cannot delete every ${axis === 'row' ? 'row' : 'column'} of a sheet`);
  if (insert && (axis === 'row' ? s.rows : s.cols) + count > (axis === 'row' ? MAX_ROWS : MAX_COLS)) fail('the sheet would be too large');
  const n = insert ? count : -Math.min(count, (axis === 'row' ? s.rows : s.cols) - at);
  shiftWorkbookRefs(cx.wb, s, axis, at, n);
  shiftSheetContent(s, axis, at, n);
  structural(cx);
  cx.log.push(`${insert ? 'inserted' : 'deleted'} ${Math.abs(n)} ${axis === 'row' ? 'row' : 'column'}(s) at ${axis === 'row' ? at + 1 : colName(at)} on ${s.name}`);
}

/* ---- sheets ---- */

const validSheetName = (cx: Ctx, name: unknown, except?: Sheet): string => {
  const n = String(name ?? '').trim();
  if (!n) fail('needs a sheet name');
  if (n.length > 100 || /[[\]*?:\\/]/.test(n)) fail('a sheet name cannot be longer than 100 characters or contain [ ] * ? : \\ /');
  if (cx.wb.sheets.some((s) => s !== except && s.name.toLowerCase() === n.toLowerCase())) fail(`a sheet named "${n}" already exists`);
  return n;
};
function renameSheetRefs(wb: Workbook, oldName: string, newName: string): void {
  const fix = (ref: RefTok): RefTok => (ref.sheet !== undefined && ref.sheet.toLowerCase() === oldName.toLowerCase() ? { ...ref, sheet: newName } : ref);
  for (const s of wb.sheets) {
    for (const cell of Object.values(s.cells)) if (cell.f) cell.f = transformRefs(cell.f, fix);
    for (const ch of s.charts) ch.range = renameRangeText(ch.range, oldName, newName);
    for (const v of s.validations) if (v.source) v.source = renameRangeText(v.source, oldName, newName);
  }
  for (const [k, v] of Object.entries(wb.names)) wb.names[k] = renameRangeText(v, oldName, newName);
}
function renameRangeText(text: string, oldName: string, newName: string): string {
  const bang = text.lastIndexOf('!');
  if (bang < 0) return text;
  const nm = text.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  return nm.toLowerCase() === oldName.toLowerCase() ? `${quoteSheet(newName)}!${text.slice(bang + 1)}` : text;
}

/* ---- copy, move, fill ---- */

function copyCells(cx: Ctx, op: Op, cut: boolean): void {
  const src = rangeArg(cx, op, 'from');
  const dst = rangeArg(cx, op, 'to');
  const mode = String(op.paste ?? 'all');
  if (!['all', 'values', 'formats', 'formulas'].includes(mode)) fail('paste must be all, values, formats or formulas');
  const transpose = op.transpose === true;
  const h = src.rect.r2 - src.rect.r1 + 1, w = src.rect.c2 - src.rect.c1 + 1;
  if (h * w > MAX_CELLS) fail('the range is too large');
  const th = transpose ? w : h, tw = transpose ? h : w;
  // paste fills whole multiples of the source when the target is larger (like Sheets)
  const dh = dst.rect.r2 - dst.rect.r1 + 1, dw = dst.rect.c2 - dst.rect.c1 + 1;
  const reps = cut ? [1, 1] : [dh >= th && dh % th === 0 ? dh / th : 1, dw >= tw && dw % tw === 0 ? dw / tw : 1];
  const snapshot: (Cell | undefined)[][] = [];
  const engine = mode === 'values' ? cx.engine() : null;
  for (let r = 0; r < h; r++) { snapshot.push([]); for (let c = 0; c < w; c++) { const cell = cellAt(src.sheet, src.rect.r1 + r, src.rect.c1 + c); snapshot[r].push(cell ? structuredClone(cell) : undefined); } }
  const values: Scalar[][] = engine ? snapshot.map((row, r) => row.map((_, c) => engine.value(src.sheet.id, src.rect.r1 + r, src.rect.c1 + c))) : [];
  const r0 = dst.rect.r1, c0 = dst.rect.c1;
  if (r0 + th * reps[0] > dst.sheet.rows || c0 + tw * reps[1] > dst.sheet.cols) fail('the paste would run past the edge of the sheet — insert rows or columns first');
  if (cut) {
    // references elsewhere that point inside the moved block follow it
    const dr = r0 - src.rect.r1, dc = c0 - src.rect.c1;
    for (const s of cx.wb.sheets) for (const [a, cell] of Object.entries(s.cells)) {
      if (!cell.f) continue;
      const p = parseAddr(a)!;
      const inside = s === src.sheet && inRect(src.rect, p.r, p.c);
      cell.f = transformRefs(cell.f, (ref) => {
        const target = ref.sheet === undefined ? s : findSheet(cx.wb, ref.sheet);
        if (target !== src.sheet || ref.kind === 'cols' || ref.kind === 'rows' || ref.kind === 'open') return ref;
        const rr = { r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 };
        if (rr.r1 >= src.rect.r1 && rr.r2 <= src.rect.r2 && rr.c1 >= src.rect.c1 && rr.c2 <= src.rect.c2) {
          const moved = { ...ref, r1: ref.r1 + dr, r2: ref.r2 + dr, c1: ref.c1 + dc, c2: ref.c2 + dc };
          if (dst.sheet !== src.sheet || (inside && dst.sheet !== s)) moved.sheet = dst.sheet.name;
          else if (ref.sheet === undefined && s !== dst.sheet) moved.sheet = dst.sheet.name;
          return moved;
        }
        return ref;
      });
    }
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { const cell = cellAt(src.sheet, src.rect.r1 + r, src.rect.c1 + c); if (cell) snapshot[r][c] = structuredClone(cell); setCell(src.sheet, src.rect.r1 + r, src.rect.c1 + c, undefined); }
    touchRect(cx, src.sheet, src.rect);
  }
  for (let i = 0; i < reps[0]; i++) for (let j = 0; j < reps[1]; j++) {
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const tr = r0 + i * th + (transpose ? c : r), tc = c0 + j * tw + (transpose ? r : c);
      const from = snapshot[r][c];
      const old = cellAt(dst.sheet, tr, tc);
      let next: Cell | undefined;
      if (mode === 'all') {
        next = from ? structuredClone(from) : undefined;
        if (next?.f && !cut) next.f = shiftFormula(next.f, tr - (src.rect.r1 + r), tc - (src.rect.c1 + c));
      } else if (mode === 'values') {
        const v = values[r][c];
        next = { ...(old ?? {}) }; delete next.f; delete next.v;
        if (v !== null && !isErr(v)) next.v = v as number | string | boolean;
        else if (isErr(v)) next.v = v.code;
      } else if (mode === 'formats') {
        next = { ...(old ?? {}) }; delete next.s;
        if (from?.s) next.s = structuredClone(from.s);
      } else {
        next = { ...(old ?? {}) }; delete next.f; delete next.v;
        if (from?.f) next.f = shiftFormula(from.f, tr - (src.rect.r1 + r), tc - (src.rect.c1 + c));
        else if (from?.v !== undefined) next.v = from.v;
      }
      setCell(dst.sheet, tr, tc, next);
    }
  }
  if (cut || mode === 'all') {
    // merges inside the source come along
    for (const m of src.sheet.merges.map((x) => parseRect(x)!).filter((m) => m.r1 >= src.rect.r1 && m.r2 <= src.rect.r2 && m.c1 >= src.rect.c1 && m.c2 <= src.rect.c2)) {
      const moved = { r1: m.r1 - src.rect.r1 + r0, r2: m.r2 - src.rect.r1 + r0, c1: m.c1 - src.rect.c1 + c0, c2: m.c2 - src.rect.c1 + c0 };
      if (cut) src.sheet.merges = src.sheet.merges.filter((x) => x !== rectText(m));
      dst.sheet.merges = dst.sheet.merges.filter((x) => !overlaps(parseRect(x)!, moved));
      dst.sheet.merges.push(rectText(moved));
    }
  }
  if (cut) structural(cx); else touchRect(cx, dst.sheet, { r1: r0, c1: c0, r2: r0 + th * reps[0] - 1, c2: c0 + tw * reps[1] - 1 });
  cx.log.push(`${cut ? 'moved' : 'copied'} ${rectText(src.rect)} to ${dst.sheet.name}!${addr(r0, c0)}`);
}

const MONTH_LOWER = MONTHS.map((m) => m.toLowerCase());
const DAY_LOWER = DAYS.map((d) => d.toLowerCase());
/** Values for the fill handle continuing a line of source cells (one row or column). */
export function seriesValues(src: (Cell | undefined)[], count: number, srcStart: number, step: number, axisShift: (cell: Cell, k: number) => Cell): (Cell | undefined)[] {
  const n = src.length;
  const out: (Cell | undefined)[] = [];
  const nums = src.map((c) => (c && !c.f && typeof c.v === 'number' ? c.v : null));
  const allNums = n > 0 && nums.every((x) => x !== null);
  const isDate = !!src[0]?.s?.nf && /[yd]/i.test(src[0]!.s!.nf!.replace(/"[^"]*"/g, ''));
  const textNum = src.map((c) => (c && typeof c.v === 'string' ? /^(.*?)(\d+)$/.exec(c.v) : null));
  const word = (c: Cell | undefined, list: string[], short: boolean): number => { if (!c || typeof c.v !== 'string') return -1; const t = c.v.toLowerCase(); return short ? list.findIndex((m) => m.slice(0, 3) === t) : list.indexOf(t); };
  for (let k = 0; k < count; k++) {
    const i = srcStart + k * step; // position relative to the source start, may be negative when filling up/left
    const srcIdx = ((i % n) + n) % n;
    const base = src[srcIdx];
    if (allNums && (n > 1 || isDate)) {
      const first = nums[0]!, last = nums[n - 1]!;
      const d = n > 1 ? (last - first) / (n - 1) : 1;
      // least-squares-free linear trend from first and last like Sheets for evenly spaced input
      out.push({ ...(base ? structuredClone(base) : {}), v: Number((first + d * i).toPrecision(15)) });
      continue;
    }
    if (base?.f) { out.push(axisShift(base, i - srcIdx)); continue; }
    if (n === 1 && textNum[0] && base) { const m = textNum[0]; const v = Number(m[2]) + i; out.push({ ...structuredClone(base), v: m[1] + String(Math.max(0, v)).padStart(m[2].length, '0') }); continue; }
    if (n >= 1 && textNum.every(Boolean) && textNum.every((m) => m![1] === textNum[0]![1])) {
      const a = Number(textNum[0]![2]), b = Number(textNum[n - 1]![2]); const d = n > 1 ? (b - a) / (n - 1) : 1;
      out.push({ ...structuredClone(base ?? {}), v: textNum[0]![1] + String(Math.round(a + d * i)) }); continue;
    }
    for (const [list, short] of [[MONTH_LOWER, false], [MONTH_LOWER, true], [DAY_LOWER, false], [DAY_LOWER, true]] as const) {
      const first = word(src[0], list, short);
      if (first >= 0 && src.every((c) => word(c, list, short) >= 0)) {
        const second = n > 1 ? word(src[1], list, short) : first + 1;
        const d = ((second - first) % list.length + list.length) % list.length || 1;
        const idx = (((first + d * i) % list.length) + list.length) % list.length;
        const t = short ? list[idx].slice(0, 3) : list[idx];
        const sample = String(src[0]!.v);
        const cased = sample === sample.toUpperCase() ? t.toUpperCase() : sample[0] === sample[0].toUpperCase() ? t[0].toUpperCase() + t.slice(1) : t;
        out.push({ ...structuredClone(base ?? {}), v: cased });
        break;
      }
    }
    if (out.length === k) out.push(base ? structuredClone(base) : undefined);
  }
  return out;
}
function fillCells(cx: Ctx, op: Op): void {
  const src = rangeArg(cx, op, 'from');
  const dst = rangeArg(cx, op, 'to');
  if (src.sheet !== dst.sheet) fail('fill works on one sheet');
  const s = src.sheet, a = src.rect, b = dst.rect;
  const sameCols = b.c1 === a.c1 && b.c2 === a.c2, sameRows = b.r1 === a.r1 && b.r2 === a.r2;
  if (sameCols && b.r2 > a.r2 && b.r1 <= a.r1) fillAxis(cx, s, a, 'down', b.r2 - a.r2);
  else if (sameCols && b.r1 < a.r1 && b.r2 >= a.r2) fillAxis(cx, s, a, 'up', a.r1 - b.r1);
  else if (sameRows && b.c2 > a.c2 && b.c1 <= a.c1) fillAxis(cx, s, a, 'right', b.c2 - a.c2);
  else if (sameRows && b.c1 < a.c1 && b.c2 >= a.c2) fillAxis(cx, s, a, 'left', a.c1 - b.c1);
  else if (sameCols && b.r1 > a.r2) fillAxis(cx, s, a, 'down', b.r2 - a.r2);
  else fail('to must extend from in one direction (same columns down/up, or same rows right/left)');
  cx.log.push(`filled ${rectText(a)} → ${rectText(b)}`);
}
function fillAxis(cx: Ctx, s: Sheet, a: Rect, dir: 'down' | 'up' | 'right' | 'left', count: number): void {
  const vertical = dir === 'down' || dir === 'up';
  const lines = vertical ? a.c2 - a.c1 + 1 : a.r2 - a.r1 + 1;
  const len = vertical ? a.r2 - a.r1 + 1 : a.c2 - a.c1 + 1;
  for (let l = 0; l < lines; l++) {
    const src: (Cell | undefined)[] = [];
    for (let i = 0; i < len; i++) src.push(vertical ? cellAt(s, a.r1 + i, a.c1 + l) : cellAt(s, a.r1 + l, a.c1 + i));
    const forward = dir === 'down' || dir === 'right';
    const vals = seriesValues(src, count, forward ? len : -1, forward ? 1 : -1, (cell, k) => {
      const c = structuredClone(cell);
      c.f = vertical ? shiftFormula(cell.f!, k, 0) : shiftFormula(cell.f!, 0, k);
      return c;
    });
    for (let k = 0; k < count; k++) {
      const off = forward ? len + k : -1 - k;
      const r = vertical ? a.r1 + off : a.r1 + l, c = vertical ? a.c1 + l : a.c1 + off;
      if (r < 0 || c < 0 || r >= s.rows || c >= s.cols) continue;
      setCell(s, r, c, vals[k]);
      touch(cx, s, r, c);
    }
  }
}

/* ---- sort, filter, cleanup ---- */

function sortRange(cx: Ctx, op: Op): void {
  const { sheet, rect } = rangeArg(cx, op);
  const engine = cx.engine();
  let keys: { col: number; desc: boolean }[] = [];
  if (Array.isArray(op.by)) keys = op.by.map((k) => { const o = (typeof k === 'object' && k ? k : { col: k }) as Record<string, unknown>; return { col: colArg(o.col ?? o.column), desc: o.desc === true || o.order === 'desc' || o.ascending === false }; });
  else keys = [{ col: op.col === undefined && op.column === undefined ? rect.c1 : colArg(op.col ?? op.column), desc: op.desc === true || op.ascending === false }];
  for (const k of keys) if (k.col < rect.c1 || k.col > rect.c2) fail(`sort column ${colName(k.col)} is outside ${rectText(rect)}`);
  const start = op.header === true ? rect.r1 + 1 : rect.r1;
  const rows: number[] = [];
  const last = Math.min(rect.r2, (usedRect(sheet)?.r2 ?? rect.r1));
  for (let r = start; r <= last; r++) rows.push(r);
  const val = (r: number, c: number) => engine.value(sheet.id, r, c);
  const order = [...rows].sort((x, y) => {
    for (const k of keys) {
      const a = val(x, k.col), b = val(y, k.col);
      const ae = a === null || a === '', be = b === null || b === '';
      if (ae && !be) return 1; if (be && !ae) return -1;
      const c = compare(isErr(a) ? null : a, isErr(b) ? null : b);
      if (c) return k.desc ? -c : c;
    }
    return x - y;
  });
  const snapshot = order.map((r) => { const row: (Cell | undefined)[] = []; for (let c = rect.c1; c <= rect.c2; c++) row.push(cellAt(sheet, r, c)); return { r, row }; });
  snapshot.forEach(({ r: from, row }, i) => {
    const to = rows[i];
    row.forEach((cell, j) => {
      const next = cell ? structuredClone(cell) : undefined;
      if (next?.f) next.f = shiftFormula(next.f, to - from, 0);
      setCell(sheet, to, rect.c1 + j, next);
    });
  });
  structural(cx);
  cx.log.push(`sorted ${rectText({ ...rect, r1: start, r2: last })} by ${keys.map((k) => colName(k.col) + (k.desc ? ' Z→A' : ' A→Z')).join(', ')}`);
}

/** Rows a sheet's filter hides (row indexes), from computed values. */
export function filterHiddenRows(s: Sheet, engine: Engine): Set<number> {
  const out = new Set<number>();
  if (!s.filter) return out;
  const rect = parseRect(s.filter.range);
  if (!rect) return out;
  const last = Math.min(rect.r2, s.rows - 1, Math.max(rect.r1, usedRect(s)?.r2 ?? rect.r1));
  const tests: { col: number; test: (v: Scalar, text: string) => boolean }[] = [];
  for (const [k, hidden] of Object.entries(s.filter.hidden)) if (hidden.length) { const set = new Set(hidden); tests.push({ col: Number(k), test: (_v, t) => !set.has(t) }); }
  for (const [k, c] of Object.entries(s.filter.cond)) { const t = condTest(c.type, c.value, c.value2); if (t) tests.push({ col: Number(k), test: (v) => t(v) }); }
  if (!tests.length) return out;
  for (let r = rect.r1 + 1; r <= last; r++) {
    for (const t of tests) { const v = engine.value(s.id, r, t.col); if (!t.test(v, engine.display(s.id, r, t.col).text)) { out.add(r); break; } }
  }
  return out;
}
/** A value test for conditional formats and filter conditions. */
export function condTest(type: CondType, value?: string | number, value2?: string | number): ((v: Scalar) => boolean) | null {
  const n = (x: unknown) => (typeof x === 'number' ? x : Number(x));
  const asNum = (v: Scalar): number | null => (typeof v === 'number' ? v : null);
  const text = (v: Scalar) => (v === null || isErr(v) ? '' : displayScalar(v)).toLowerCase();
  const t = String(value ?? '').toLowerCase();
  switch (type) {
    case 'gt': return (v) => (asNum(v) ?? NaN) > n(value);
    case 'gte': return (v) => (asNum(v) ?? NaN) >= n(value);
    case 'lt': return (v) => (asNum(v) ?? NaN) < n(value);
    case 'lte': return (v) => (asNum(v) ?? NaN) <= n(value);
    case 'eq': return (v) => (typeof value === 'number' || (value !== undefined && value !== '' && !isNaN(Number(value))) ? asNum(v) === n(value) : text(v) === t);
    case 'neq': return (v) => (typeof value === 'number' || (value !== undefined && value !== '' && !isNaN(Number(value))) ? asNum(v) !== n(value) : text(v) !== t);
    case 'between': return (v) => { const x = asNum(v); return x !== null && x >= Math.min(n(value), n(value2)) && x <= Math.max(n(value), n(value2)); };
    case 'not_between': return (v) => { const x = asNum(v); return x !== null && (x < Math.min(n(value), n(value2)) || x > Math.max(n(value), n(value2))); };
    case 'contains': return (v) => text(v).includes(t);
    case 'not_contains': return (v) => !text(v).includes(t);
    case 'starts': return (v) => text(v).startsWith(t);
    case 'ends': return (v) => text(v).endsWith(t);
    case 'empty': return (v) => v === null || v === '';
    case 'not_empty': return (v) => v !== null && v !== '';
    case 'error': return (v) => isErr(v);
    default: return null;
  }
}

function removeDuplicates(cx: Ctx, op: Op): void {
  const { sheet, rect } = rangeArg(cx, op);
  const engine = cx.engine();
  const cols = Array.isArray(op.cols) ? op.cols.map((c) => colArg(c)) : Array.from({ length: rect.c2 - rect.c1 + 1 }, (_, i) => rect.c1 + i);
  const start = op.header === true ? rect.r1 + 1 : rect.r1;
  const last = Math.min(rect.r2, usedRect(sheet)?.r2 ?? rect.r1);
  const seen = new Set<string>();
  const keep: number[] = [];
  for (let r = start; r <= last; r++) {
    const key = cols.map((c) => { const v = engine.value(sheet.id, r, c); return typeof v === 'string' ? v.toLowerCase() : displayScalar(isErr(v) ? v.code : v); }).join('\u0001');
    if (cols.every((c) => engine.value(sheet.id, r, c) === null)) { keep.push(r); continue; }
    if (!seen.has(key)) { seen.add(key); keep.push(r); }
  }
  const removed = last - start + 1 - keep.length;
  const snapshot = keep.map((r) => { const row: (Cell | undefined)[] = []; for (let c = rect.c1; c <= rect.c2; c++) row.push(cellAt(sheet, r, c)); return { r, row }; });
  for (let r = start; r <= last; r++) for (let c = rect.c1; c <= rect.c2; c++) setCell(sheet, r, c, undefined);
  snapshot.forEach(({ r: from, row }, i) => row.forEach((cell, j) => { const next = cell ? structuredClone(cell) : undefined; if (next?.f) next.f = shiftFormula(next.f, start + i - from, 0); setCell(sheet, start + i, rect.c1 + j, next); }));
  structural(cx);
  cx.log.push(`removed ${removed} duplicate row(s); ${keep.length} row(s) remain`);
}

function findReplace(cx: Ctx, op: Op): void {
  const find = String(op.find ?? '');
  if (!find) fail('find_replace needs find');
  const replace = String(op.replace ?? '');
  const flags = op.match_case === true ? 'g' : 'gi';
  let re: RegExp;
  try { re = op.regex === true ? new RegExp(find, flags) : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); } catch { return fail('find is not a valid regular expression'); }
  const whole = op.whole === true;
  const sheets = op.all_sheets === true ? cx.wb.sheets : [sheetArg(cx, op)];
  let count = 0;
  for (const s of sheets) for (const [a, cell] of Object.entries(s.cells)) {
    const p = parseAddr(a)!;
    if (cell.f !== undefined) {
      if (op.formulas !== true) continue;
      const text = cell.f;
      const next = whole ? (new RegExp(`^(?:${re.source})$`, flags.replace('g', '')).test(text) ? replace : text) : text.replace(re, replace);
      if (next !== text) { const n = inputCell(cell, next); setCell(s, p.r, p.c, n); count++; touch(cx, s, p.r, p.c); }
      continue;
    }
    if (cell.v === undefined || cell.v === null) continue;
    const text = displayScalar(cell.v);
    const hit = whole ? new RegExp(`^(?:${re.source})$`, flags.replace('g', '')).test(text) : (re.lastIndex = 0, re.test(text));
    re.lastIndex = 0;
    if (!hit) continue;
    const next = whole ? replace : text.replace(re, replace);
    setCell(s, p.r, p.c, inputCell(cell, typeof cell.v === 'string' ? next : next));
    count++; touch(cx, s, p.r, p.c);
  }
  cx.log.push(`replaced ${count} cell(s)`);
}

function pivot(cx: Ctx, op: Op): void {
  const src = rangeArg(cx, op, 'source');
  const engine = cx.engine();
  const rowCol = colArg(op.rows, 'rows');
  const colCol = op.columns === undefined ? null : colArg(op.columns, 'columns');
  const values = Array.isArray(op.values) ? op.values : op.values ? [op.values] : [{ col: op.value ?? op.rows, fn: 'counta' }];
  const vals = values.map((v) => { const o = (typeof v === 'object' && v ? v : { col: v }) as Record<string, unknown>; const fn = String(o.fn ?? o.summarize ?? 'sum').toLowerCase(); if (!['sum', 'count', 'counta', 'average', 'min', 'max'].includes(fn)) fail('values fn must be sum, count, counta, average, min or max'); return { col: colArg(o.col ?? o.column), fn }; });
  const { sheet, rect } = src;
  for (const c of [rowCol, ...(colCol === null ? [] : [colCol]), ...vals.map((v) => v.col)]) if (c < rect.c1 || c > rect.c2) fail(`column ${colName(c)} is not in ${rectText(rect)}`);
  const last = Math.min(rect.r2, usedRect(sheet)?.r2 ?? rect.r1);
  const header = (c: number) => displayScalar(engine.value(sheet.id, rect.r1, c) as Scalar) || colName(c);
  const distinct = (c: number): Scalar[] => {
    const seen = new Map<string, Scalar>();
    for (let r = rect.r1 + 1; r <= last; r++) { const v = engine.value(sheet.id, r, c); if (v === null || v === '' || isErr(v)) continue; const k = typeof v === 'string' ? v.toLowerCase() : String(v); if (!seen.has(k)) seen.set(k, v); }
    return [...seen.values()].sort((a, b) => compare(a, b));
  };
  const rowKeys = distinct(rowCol);
  const colKeys = colCol === null ? [] : distinct(colCol);
  // where the table goes
  const targetText = String(op.target ?? '');
  let tsheet: Sheet, tr: number, tc: number;
  const bang = targetText.lastIndexOf('!');
  if (bang >= 0) {
    const nm = targetText.slice(0, bang).replace(/^'(.*)'$/, '$1');
    let found = findSheet(cx.wb, nm);
    if (!found) { found = emptySheet(newId(cx, 's'), validSheetName(cx, nm)); cx.wb.sheets.push(found); structural(cx); }
    tsheet = found; const p = parseAddr(targetText.slice(bang + 1)) ?? fail('target must be a cell like F1 or Summary!A1'); tr = p.r; tc = p.c;
  } else { tsheet = sheet; const p = parseAddr(targetText || 'A1') ?? fail('target must be a cell like F1 or Summary!A1'); tr = p.r; tc = p.c; }
  if (tsheet === sheet && tc <= rect.c2 && tc + vals.length * Math.max(1, colKeys.length) >= rect.c1 && tr <= last && tr + rowKeys.length + 2 >= rect.r1) fail('the pivot table would overlap its source — put it to the right, below, or on another sheet');
  const sref = (c: number) => `${tsheet === sheet ? '' : quoteSheet(sheet.name) + '!'}$${colName(c)}$${rect.r1 + 2}:$${colName(c)}$${last + 1}`;
  const FN: Record<string, string> = { sum: 'SUMIFS', average: 'AVERAGEIFS', min: 'MINIFS', max: 'MAXIFS', count: 'COUNTIFS', counta: 'COUNTIFS' };
  const lit = (v: Scalar) => (typeof v === 'number' ? String(v) : `"${displayScalar(v).replace(/"/g, '""')}"`);
  const formula = (vcol: number, fn: string, rk: string, ck?: string) => {
    const conds = `${sref(rowCol)},${rk}${colCol !== null && ck ? `,${sref(colCol)},${ck}` : ''}`;
    if (fn === 'count') return `=COUNTIFS(${conds},${sref(vcol)},">-1E+307")`;
    if (fn === 'counta') return `=COUNTIFS(${conds})`;
    return `=IFERROR(${FN[fn]}(${sref(vcol)},${conds}),0)`;
  };
  const put = (r: number, c: number, cell: Cell) => { if (r >= tsheet.rows || c >= tsheet.cols) fail('the pivot table does not fit on the sheet'); setCell(tsheet, r, c, cell); touch(cx, tsheet, r, c); };
  const bold: CellFmt = { b: true, fill: '#e8f0fe' };
  put(tr, tc, { v: header(rowCol), s: bold });
  const groups = colCol === null ? [null] : colKeys;
  let c = tc + 1;
  for (const g of groups) for (const v of vals) { put(tr, c++, { v: `${v.fn.toUpperCase()} of ${header(v.col)}${g === null ? '' : ` · ${displayScalar(g)}`}`, s: bold }); }
  rowKeys.forEach((rk, i) => {
    const r = tr + 1 + i;
    put(r, tc, { v: rk as string | number | boolean });
    let cc = tc + 1;
    for (const g of groups) for (const v of vals) put(r, cc++, { f: formula(v.col, v.fn, addr(r, tc).replace(/^([A-Z]+)/, '$$$1'), g === null ? undefined : lit(g)) });
  });
  const totalRow = tr + 1 + rowKeys.length;
  put(totalRow, tc, { v: 'Grand total', s: { b: true } });
  for (let k = 0; k < groups.length * vals.length; k++) {
    const col = tc + 1 + k;
    const v = vals[k % vals.length];
    const range = `${addr(tr + 1, col)}:${addr(totalRow - 1, col)}`;
    put(totalRow, col, { f: v.fn === 'average' ? `=IFERROR(AVERAGE(${range}),0)` : v.fn === 'min' ? `=MIN(${range})` : v.fn === 'max' ? `=MAX(${range})` : `=SUM(${range})`, s: { b: true } });
  }
  cx.log.push(`pivot table at ${tsheet.name}!${addr(tr, tc)}: ${rowKeys.length} row group(s)${colCol !== null ? ` × ${colKeys.length} column group(s)` : ''}, ${vals.map((v) => `${v.fn} of ${header(v.col)}`).join(', ')}`);
}

function addChart(cx: Ctx, op: Op): void {
  const s = sheetArg(cx, op);
  const range = String(op.range ?? '');
  if (!resolveRange(cx.wb, range, s)) fail('chart_add needs a data range such as A1:C13');
  const id = newId(cx, 'ch');
  const anchor = op.anchor ? String(op.anchor).toUpperCase() : (() => { const r = resolveRange(cx.wb, range, s)!.rect; return addr(r.r1, Math.min(s.cols - 1, r.c2 + 2)); })();
  if (!parseAddr(anchor)) fail('anchor must be a cell such as H2');
  s.charts.push(normChart({ ...op, id, anchor }, id));
  cx.created = id;
  cx.log.push(`added ${s.charts[s.charts.length - 1].type} chart ${id} for ${range} at ${anchor}`);
}

/* ---- the dispatcher ---- */

function step(cx: Ctx, op: Op): void {
  switch (op.op) {
    case 'set': {
      const { sheet, rect } = rangeArg(cx, op);
      const rawText = op.raw === true;
      if (op.values !== undefined) {
        const rows = op.values;
        if (!Array.isArray(rows)) fail('values must be an array of rows, e.g. [["Name","Score"],["Ann",9]]');
        const grid = (rows as unknown[]).map((row) => (Array.isArray(row) ? row : [row]));
        if (grid.length > 100000) fail('too many rows in one set (100000 max)');
        if (rect.r1 + grid.length > sheet.rows) sheet.rows = Math.min(MAX_ROWS, rect.r1 + grid.length + 50);
        const width = Math.max(0, ...grid.map((r) => r.length));
        if (rect.c1 + width > sheet.cols) { if (rect.c1 + width > MAX_COLS) fail('too many columns'); sheet.cols = rect.c1 + width; }
        grid.forEach((row, i) => row.forEach((v, j) => { setCell(sheet, rect.r1 + i, rect.c1 + j, inputCell(cellAt(sheet, rect.r1 + i, rect.c1 + j), v, rawText)); touch(cx, sheet, rect.r1 + i, rect.c1 + j); }));
        cx.log.push(`set ${grid.length}×${width} cells at ${sheet.name}!${addr(rect.r1, rect.c1)}`);
      } else {
        const v = op.formula !== undefined ? (String(op.formula).startsWith('=') ? op.formula : '=' + String(op.formula)) : op.value;
        eachCell(rect, (r, c) => {
          const cell = inputCell(cellAt(sheet, r, c), v, rawText);
          if (cell?.f && (r !== rect.r1 || c !== rect.c1)) cell.f = shiftFormula(cell.f, r - rect.r1, c - rect.c1);
          setCell(sheet, r, c, cell); touch(cx, sheet, r, c);
        });
        cx.log.push(`set ${sheet.name}!${rectText(rect)}`);
      }
      return;
    }
    case 'clear': {
      const { sheet, rect } = rangeArg(cx, op);
      const what = String(op.what ?? 'all');
      if (!['all', 'values', 'formats', 'notes'].includes(what)) fail('what must be all, values, formats or notes');
      for (const { r, c } of existing(sheet, rect)) {
        const cell = { ...cellAt(sheet, r, c)! };
        if (what === 'all') { setCell(sheet, r, c, undefined); continue; }
        if (what === 'values') { delete cell.v; delete cell.f; }
        if (what === 'formats') delete cell.s;
        if (what === 'notes') delete cell.note;
        setCell(sheet, r, c, cell);
      }
      if (what === 'all' || what === 'formats') sheet.merges = sheet.merges.filter((m) => !(what === 'all' && overlaps(parseRect(m)!, rect) && rect.r1 <= parseRect(m)!.r1 && rect.r2 >= parseRect(m)!.r2 && rect.c1 <= parseRect(m)!.c1 && rect.c2 >= parseRect(m)!.c2));
      touchRect(cx, sheet, { ...rect, r2: Math.min(rect.r2, (usedRect(sheet)?.r2 ?? rect.r1) + 1) });
      if ((rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1) > 4000) structural(cx);
      cx.log.push(`cleared ${what} in ${sheet.name}!${rectText(rect)}`);
      return;
    }
    case 'format': applyFormat(cx, op); cx.log.push(`formatted ${String(op.range ?? op.cell)}`); return;
    case 'border': applyBorder(cx, op); cx.log.push(`borders (${String(op.where ?? 'all')}) on ${String(op.range)}`); return;
    case 'merge': applyMerge(cx, op); cx.log.push(`merged ${String(op.range)}`); return;
    case 'unmerge': { const { sheet, rect } = rangeArg(cx, op); const before = sheet.merges.length; sheet.merges = sheet.merges.filter((m) => !overlaps(parseRect(m)!, rect)); touchRect(cx, sheet, rect); cx.log.push(`unmerged ${before - sheet.merges.length} range(s)`); return; }
    case 'insert_rows': insertDelete(cx, op, 'row', true); return;
    case 'delete_rows': insertDelete(cx, op, 'row', false); return;
    case 'insert_cols': insertDelete(cx, op, 'col', true); return;
    case 'delete_cols': insertDelete(cx, op, 'col', false); return;
    case 'row_height': case 'rows_height': {
      const s = sheetArg(cx, op); const a = rowArg(op.from ?? op.row ?? op.at, 'from'), b = op.to === undefined ? a : rowArg(op.to, 'to');
      const size = num(Number(op.size ?? op.height), DEFAULT_ROW_H, 2, 2000);
      for (let r = Math.min(a, b); r <= Math.max(a, b); r++) { if (op.reset === true) delete s.rowH[r]; else s.rowH[r] = size; }
      cx.log.push(`row height ${size}px for rows ${a + 1}–${b + 1}`); return;
    }
    case 'col_width': case 'cols_width': {
      const s = sheetArg(cx, op); const a = colArg(op.from ?? op.col ?? op.at, 'from'), b = op.to === undefined ? a : colArg(op.to, 'to');
      for (let c = Math.min(a, b); c <= Math.max(a, b); c++) {
        if (op.fit === true) {
          const engine = cx.engine();
          let w = 30;
          for (const { r } of existing(s, { r1: 0, r2: s.rows - 1, c1: c, c2: c })) { const t = engine.display(s.id, r, c).text; const fs = cellAt(s, r, c)?.s?.fs ?? 10; w = Math.max(w, Math.min(600, t.length * fs * 0.72 + 14)); }
          s.colW[c] = Math.round(w);
        } else if (op.reset === true) delete s.colW[c];
        else s.colW[c] = num(Number(op.size ?? op.width), DEFAULT_COL_W, 2, 2000);
      }
      cx.log.push(`column width for ${colName(a)}–${colName(b)}`); return;
    }
    case 'hide_rows': case 'show_rows': case 'hide_cols': case 'show_cols': {
      const s = sheetArg(cx, op); const rows = op.op.endsWith('rows');
      const a = rows ? rowArg(op.from ?? op.at ?? op.row, 'from') : colArg(op.from ?? op.at ?? op.col, 'from');
      const b = op.to === undefined ? a : rows ? rowArg(op.to, 'to') : colArg(op.to, 'to');
      const list = new Set(rows ? s.hiddenRows : s.hiddenCols);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { if (op.op.startsWith('hide')) list.add(i); else list.delete(i); }
      const sorted = [...list].sort((x, y) => x - y);
      if (rows) s.hiddenRows = sorted; else s.hiddenCols = sorted;
      cx.log.push(`${op.op.replace('_', ' ')} ${rows ? a + 1 : colName(a)}–${rows ? b + 1 : colName(b)}`); return;
    }
    case 'freeze': {
      const s = sheetArg(cx, op);
      if (op.rows !== undefined) s.frozenRows = Math.round(num(Number(op.rows), 0, 0, 50));
      if (op.cols !== undefined) s.frozenCols = Math.round(num(Number(op.cols), 0, 0, 20));
      cx.log.push(`froze ${s.frozenRows} row(s) and ${s.frozenCols} column(s)`); return;
    }
    case 'sheet_add': {
      const name = validSheetName(cx, op.name ?? `Sheet${cx.wb.sheets.length + 1}`);
      const s = emptySheet(newId(cx, 's'), name, Math.round(num(Number(op.rows ?? DEFAULT_ROWS), DEFAULT_ROWS, 1, MAX_ROWS)), Math.round(num(Number(op.cols ?? DEFAULT_COLS), DEFAULT_COLS, 1, MAX_COLS)));
      const at = op.at === undefined ? cx.wb.sheets.length : Math.round(num(Number(op.at), cx.wb.sheets.length + 1, 1, cx.wb.sheets.length + 1)) - 1;
      cx.wb.sheets.splice(at, 0, s);
      cx.sheet = s; cx.created = s.id; structural(cx);
      cx.log.push(`added sheet "${name}" (${s.id})`); return;
    }
    case 'sheet_rename': {
      const s = sheetArg(cx, op); const name = validSheetName(cx, op.name ?? op.to, s);
      const old = s.name; s.name = name; renameSheetRefs(cx.wb, old, name); structural(cx);
      cx.log.push(`renamed sheet "${old}" to "${name}"`); return;
    }
    case 'sheet_delete': {
      const s = sheetArg(cx, op);
      if (cx.wb.sheets.filter((x) => !x.hidden).length <= 1 && !s.hidden) fail('a workbook needs at least one visible sheet');
      cx.wb.sheets = cx.wb.sheets.filter((x) => x !== s);
      for (const o of cx.wb.sheets) for (const cell of Object.values(o.cells)) if (cell.f) cell.f = transformRefs(cell.f, (ref) => (ref.sheet !== undefined && ref.sheet.toLowerCase() === s.name.toLowerCase() ? null : ref));
      for (const [k, v] of Object.entries(cx.wb.names)) if (v.toLowerCase().startsWith(quoteSheet(s.name).toLowerCase() + '!') || v.toLowerCase().startsWith(s.name.toLowerCase() + '!')) delete cx.wb.names[k];
      if (cx.sheet === s) cx.sheet = cx.wb.sheets.find((x) => !x.hidden) ?? cx.wb.sheets[0];
      structural(cx); cx.log.push(`deleted sheet "${s.name}"`); return;
    }
    case 'sheet_duplicate': {
      const s = sheetArg(cx, op);
      let name = op.name ? validSheetName(cx, op.name) : `Copy of ${s.name}`;
      let k = 2; while (cx.wb.sheets.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `Copy of ${s.name} ${k++}`;
      const copy: Sheet = { ...structuredClone(s), id: newId(cx, 's'), name, hidden: undefined };
      copy.charts = copy.charts.map((c) => ({ ...c, id: newId(cx, 'ch') }));
      cx.wb.sheets.splice(cx.wb.sheets.indexOf(s) + 1, 0, copy);
      cx.sheet = copy; cx.created = copy.id; structural(cx);
      cx.log.push(`duplicated "${s.name}" as "${name}"`); return;
    }
    case 'sheet_move': {
      const s = sheetArg(cx, op);
      const to = Math.round(num(Number(op.to ?? op.at), 1, 1, cx.wb.sheets.length)) - 1;
      cx.wb.sheets = cx.wb.sheets.filter((x) => x !== s); cx.wb.sheets.splice(to, 0, s);
      cx.log.push(`moved "${s.name}" to position ${to + 1}`); return;
    }
    case 'sheet_set': {
      const s = sheetArg(cx, op);
      if (op.color !== undefined) { if (op.color === null || op.color === '') delete s.color; else s.color = color(op.color) ?? fail('color must be a colour like #34a853'); }
      if (op.hidden !== undefined) {
        if (op.hidden === true && cx.wb.sheets.filter((x) => !x.hidden && x !== s).length === 0) fail('cannot hide the only visible sheet');
        if (op.hidden === true) s.hidden = true; else delete s.hidden;
      }
      if (op.gridlines !== undefined) s.gridlines = op.gridlines !== false;
      if (op.rows !== undefined) { const n = Math.round(num(Number(op.rows), s.rows, 1, MAX_ROWS)); if (n < s.rows && Object.keys(s.cells).some((a) => parseAddr(a)!.r >= n)) fail('cells below the new last row are not empty — delete_rows first'); s.rows = n; structural(cx); }
      if (op.cols !== undefined) { const n = Math.round(num(Number(op.cols), s.cols, 1, MAX_COLS)); if (n < s.cols && Object.keys(s.cells).some((a) => parseAddr(a)!.c >= n)) fail('cells right of the new last column are not empty'); s.cols = n; structural(cx); }
      if (op.name !== undefined && op.name !== s.name) { const old = s.name; s.name = validSheetName(cx, op.name, s); renameSheetRefs(cx.wb, old, s.name); structural(cx); }
      cx.log.push(`updated sheet "${s.name}"`); return;
    }
    case 'name_set': {
      const name = String(op.name ?? '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) || /^[A-Za-z]{1,3}\d+$/.test(name) || /^(true|false)$/i.test(name)) fail('a name starts with a letter or _, has only letters, digits, _ and ., and must not look like a cell (A1)');
      const { sheet, rect } = rangeArg(cx, op);
      for (const k of Object.keys(cx.wb.names)) if (k.toLowerCase() === name.toLowerCase()) delete cx.wb.names[k];
      cx.wb.names[name] = `${quoteSheet(sheet.name)}!${rectText(rect)}`;
      structural(cx); cx.log.push(`named ${cx.wb.names[name]} "${name}"`); return;
    }
    case 'name_delete': {
      const name = String(op.name ?? '');
      const k = Object.keys(cx.wb.names).find((x) => x.toLowerCase() === name.toLowerCase());
      if (!k) fail(`no named range "${name}"`);
      delete cx.wb.names[k!]; structural(cx); cx.log.push(`removed the name "${k}"`); return;
    }
    case 'note': case 'comment': {
      const { sheet, rect } = rangeArg(cx, op);
      const text = String(op.text ?? op.note ?? '').slice(0, 5000);
      const cell = { ...(cellAt(sheet, rect.r1, rect.c1) ?? {}) };
      if (text) cell.note = text; else delete cell.note;
      setCell(sheet, rect.r1, rect.c1, cell);
      cx.log.push(`${text ? 'note on' : 'removed the note of'} ${addr(rect.r1, rect.c1)}`); return;
    }
    case 'link': {
      const { sheet, rect } = rangeArg(cx, op);
      const url = String(op.url ?? '');
      if (url && !/^(https?:|mailto:|#)/i.test(url)) fail('url must start with http://, https://, mailto: or #');
      const cell = { ...(cellAt(sheet, rect.r1, rect.c1) ?? {}) };
      if (url) cell.link = url; else delete cell.link;
      if (url && cell.v === undefined && !cell.f) cell.v = String(op.text ?? url);
      setCell(sheet, rect.r1, rect.c1, cell); touch(cx, sheet, rect.r1, rect.c1);
      cx.log.push(`link on ${addr(rect.r1, rect.c1)}`); return;
    }
    case 'validation': {
      const { sheet, rect } = rangeArg(cx, op);
      const type = String(op.type ?? 'list') as ValidationType;
      if (!['list', 'range', 'number', 'checkbox', 'date', 'text_length', 'custom'].includes(type)) fail('type must be list, range, number, checkbox, date, text_length or custom');
      const v: Validation = { id: newId(cx, 'v'), range: rectText(rect), type, strict: op.strict !== false };
      if (type === 'list') { if (!Array.isArray(op.values) || !op.values.length) fail('a list validation needs values: ["A","B"]'); v.values = (op.values as unknown[]).map((x) => String(x)).slice(0, 500); }
      if (type === 'range') { if (!op.source || !resolveRange(cx.wb, String(op.source), sheet)) fail('a range validation needs source such as "Lists!A2:A20"'); v.source = String(op.source); }
      if (type === 'number' || type === 'date' || type === 'text_length') {
        v.op = String(op.rule ?? op.operator ?? 'between');
        if (!['between', 'not_between', 'gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(v.op)) fail('rule must be between, not_between, gt, gte, lt, lte, eq or neq');
        const toN = (x: unknown) => (typeof x === 'string' && type === 'date' ? (parseInput(x).value as number) : Number(x));
        if (op.min !== undefined) v.min = toN(op.min);
        if (op.max !== undefined) v.max = toN(op.max);
        if (v.min === undefined && v.max === undefined) fail('needs min and/or max');
      }
      if (type === 'custom') { const f = String(op.formula ?? ''); try { parse(f.startsWith('=') ? f : '=' + f); } catch { fail('formula does not parse'); } v.formula = f.startsWith('=') ? f : '=' + f; }
      if (typeof op.help === 'string') v.help = op.help.slice(0, 300);
      if (isObj(op.colors)) v.colors = Object.fromEntries(Object.entries(op.colors).flatMap(([k, c]) => (color(c) ? [[k, color(c)!]] : [])));
      sheet.validations = sheet.validations.filter((x) => !sameRect(x.range, rect));
      sheet.validations.push(v);
      if (type === 'checkbox') eachCell(rect, (r, c) => { const cell = cellAt(sheet, r, c); if (!cell || (cell.v !== true && cell.v !== false && !cell.f)) { setCell(sheet, r, c, { ...(cell ?? {}), v: false }); touch(cx, sheet, r, c); } });
      cx.created = v.id;
      cx.log.push(`${type} validation ${v.id} on ${rectText(rect)}`); return;
    }
    case 'validation_clear': {
      const { sheet, rect } = rangeArg(cx, op);
      const before = sheet.validations.length;
      sheet.validations = sheet.validations.filter((v) => !overlaps(parseRect(v.range)!, rect));
      cx.log.push(`removed ${before - sheet.validations.length} validation rule(s)`); return;
    }
    case 'cond_format': {
      const { sheet, rect } = rangeArg(cx, op);
      const type = String(op.type ?? 'gt') as CondType;
      const types: CondType[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'not_between', 'contains', 'not_contains', 'starts', 'ends', 'empty', 'not_empty', 'formula', 'scale', 'duplicate', 'unique', 'top', 'bottom', 'above_avg', 'below_avg', 'error'];
      if (!types.includes(type)) fail(`type must be one of ${types.join(', ')}`);
      const cf: CondFormat = { id: newId(cx, 'cf'), range: rectText(rect), type };
      if (op.value !== undefined) cf.value = typeof op.value === 'number' ? op.value : String(op.value);
      if (op.value2 !== undefined) cf.value2 = typeof op.value2 === 'number' ? op.value2 : String(op.value2);
      if (type === 'formula') { const f = String(op.value ?? op.formula ?? ''); try { parse(f.startsWith('=') ? f : '=' + f); } catch { fail('the custom formula does not parse'); } cf.value = f.startsWith('=') ? f : '=' + f; }
      if (type === 'top' || type === 'bottom') { cf.n = Math.round(num(Number(op.n ?? 10), 10, 1, 1000)); if (op.percent === true) cf.percent = true; }
      if (type === 'scale') {
        const cols = Array.isArray(op.colors) ? op.colors.map(color).filter((c): c is string => !!c) : ['#ffffff', '#57bb8a'];
        if (cols.length < 2 || cols.length > 3) fail('scale needs 2 or 3 colours');
        cf.colors = cols;
      } else {
        const st = isObj(op.style) ? op.style : op;
        const style: CondStyle = {};
        const f = color(st.fill ?? st.background); if (f) style.fill = f;
        const c = color(st.color); if (c) style.color = c;
        if (st.bold === true || st.b === true) style.b = true;
        if (st.italic === true || st.i === true) style.i = true;
        if (st.strike === true || st.s === true) style.s = true;
        if (st.underline === true || st.u === true) style.u = true;
        cf.style = Object.keys(style).length ? style : { fill: '#b7e1cd', color: '#0d652d' };
      }
      sheet.condFormats.push(cf);
      cx.created = cf.id;
      cx.log.push(`conditional format ${cf.id} (${type}) on ${rectText(rect)}`); return;
    }
    case 'cond_format_delete': {
      const s = sheetArg(cx, op);
      const before = s.condFormats.length;
      if (op.id !== undefined) s.condFormats = s.condFormats.filter((c) => c.id !== String(op.id));
      else { const { rect } = rangeArg(cx, op); s.condFormats = s.condFormats.filter((c) => !overlaps(parseRect(c.range)!, rect)); }
      if (before === s.condFormats.length) fail('no matching conditional format');
      cx.log.push(`removed ${before - s.condFormats.length} conditional format(s)`); return;
    }
    case 'banding': {
      const { sheet, rect } = rangeArg(cx, op);
      const b: Banding = { id: newId(cx, 'b'), range: rectText(rect), odd: color(op.odd) ?? '#ffffff', even: color(op.even) ?? '#f3f6fc' };
      const h = op.header === null ? undefined : color(op.header ?? '#bdd0f5'); if (h) b.header = h;
      const f = color(op.footer); if (f) b.footer = f;
      sheet.bands = sheet.bands.filter((x) => !overlaps(parseRect(x.range)!, rect));
      sheet.bands.push(b);
      cx.log.push(`alternating colours on ${rectText(rect)}`); return;
    }
    case 'banding_delete': { const { sheet, rect } = rangeArg(cx, op); sheet.bands = sheet.bands.filter((x) => !overlaps(parseRect(x.range)!, rect)); cx.log.push('removed alternating colours'); return; }
    case 'sort': sortRange(cx, op); return;
    case 'filter': {
      const { sheet, rect } = rangeArg(cx, op);
      const used = usedRect(sheet);
      const r = rect.r1 === rect.r2 && used ? { r1: rect.r1, c1: used.c1, r2: used.r2, c2: used.c2 } : rect;
      sheet.filter = { range: rectText(r), hidden: {}, cond: {} };
      cx.log.push(`filter on ${rectText(r)}`); return;
    }
    case 'filter_set': {
      const s = sheetArg(cx, op);
      if (!s.filter) fail('turn the filter on first with {op:"filter", range}');
      const col = colArg(op.col ?? op.column);
      const fr = parseRect(s.filter!.range)!;
      if (col < fr.c1 || col > fr.c2) fail(`column ${colName(col)} is not in the filter range ${s.filter!.range}`);
      if (Array.isArray(op.hide)) s.filter!.hidden[col] = op.hide.map(String); else if (op.hide === null) delete s.filter!.hidden[col];
      if (isObj(op.condition)) { const t = String(op.condition.type) as CondType; if (!condTest(t, 0, 0)) fail('condition type must be gt, gte, lt, lte, eq, neq, between, not_between, contains, not_contains, starts, ends, empty, not_empty or error'); s.filter!.cond[col] = { type: t, value: op.condition.value as string | number, value2: op.condition.value2 as string | number }; }
      else if (op.condition === null) delete s.filter!.cond[col];
      cx.log.push(`filter on column ${colName(col)} updated`); return;
    }
    case 'filter_clear': { const s = sheetArg(cx, op); s.filter = undefined; cx.log.push('filter removed'); return; }
    case 'find_replace': findReplace(cx, op); return;
    case 'copy': copyCells(cx, op, false); return;
    case 'move': copyCells(cx, op, true); return;
    case 'fill': fillCells(cx, op); return;
    case 'remove_duplicates': removeDuplicates(cx, op); return;
    case 'trim': {
      const { sheet, rect } = rangeArg(cx, op);
      let n = 0;
      for (const { r, c } of existing(sheet, rect)) { const cell = cellAt(sheet, r, c)!; if (typeof cell.v === 'string') { const t = cell.v.replace(/[ \t ]+/g, ' ').trim(); if (t !== cell.v) { setCell(sheet, r, c, { ...cell, v: t }); touch(cx, sheet, r, c); n++; } } }
      cx.log.push(`trimmed whitespace in ${n} cell(s)`); return;
    }
    case 'split': {
      const { sheet, rect } = rangeArg(cx, op);
      if (rect.c1 !== rect.c2) fail('split works on one column');
      const d = String(op.delimiter ?? ',');
      const auto = d === 'auto';
      let n = 0;
      for (const { r, c } of existing(sheet, rect).sort((a, b) => a.r - b.r)) {
        const cell = cellAt(sheet, r, c)!;
        if (typeof cell.v !== 'string') continue;
        const delim = auto ? ([',', ';', '\t', '|'].find((x) => (cell.v as string).includes(x)) ?? ' ') : d;
        const parts = (cell.v as string).split(delim).map((p) => p.trim());
        if (parts.length < 2) continue;
        if (c + parts.length > sheet.cols) sheet.cols = Math.min(MAX_COLS, c + parts.length);
        parts.forEach((p, i) => { setCell(sheet, r, c + i, inputCell(cellAt(sheet, r, c + i), p)); touch(cx, sheet, r, c + i); });
        n++;
      }
      cx.log.push(`split ${n} cell(s) into columns`); return;
    }
    case 'pivot': pivot(cx, op); return;
    case 'chart_add': addChart(cx, op); return;
    case 'chart_set': {
      const s = cx.wb.sheets.find((x) => x.charts.some((c) => c.id === String(op.id))) ?? fail(`no chart "${String(op.id)}"`);
      const i = s.charts.findIndex((c) => c.id === String(op.id));
      const merged = { ...s.charts[i], ...op } as Record<string, unknown>;
      delete merged.op;
      s.charts[i] = normChart(merged, s.charts[i].id);
      cx.log.push(`updated chart ${s.charts[i].id}`); return;
    }
    case 'chart_delete': {
      const s = cx.wb.sheets.find((x) => x.charts.some((c) => c.id === String(op.id))) ?? fail(`no chart "${String(op.id)}"`);
      s.charts = s.charts.filter((c) => c.id !== String(op.id));
      cx.log.push(`deleted chart ${String(op.id)}`); return;
    }
    case 'workbook': { if (typeof op.title === 'string') cx.wb.title = op.title.slice(0, 200) || cx.wb.title; cx.log.push(`title "${cx.wb.title}"`); return; }
    default: fail(`unknown op "${op.op}"`);
  }
}
const sameRect = (text: string, rect: Rect): boolean => { const r = parseRect(text); return !!r && r.r1 === rect.r1 && r.r2 === rect.r2 && r.c1 === rect.c1 && r.c2 === rect.c2; };

/** Applies operations in order; nothing changes if any of them fails. */
export function applyOps(wb: Workbook, ops: Op[], opts: ApplyOptions = {}): ApplyResult {
  const next = structuredClone(wb);
  let engine: Engine | null = opts.engine && ops.length ? opts.engine : null;
  let dirtySinceEngine = !engine;
  const cx: Ctx = {
    wb: next, sheet: (opts.sheet ? findSheet(next, opts.sheet) : undefined) ?? next.sheets.find((s) => !s.hidden) ?? next.sheets[0], log: [], touched: new Set(),
    engine: () => { if (!engine || dirtySinceEngine) { engine = new Engine(next); dirtySinceEngine = false; } return engine; },
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      if (!isObj(op) || typeof op.op !== 'string') fail('each op needs "op"');
      step(cx, op);
      dirtySinceEngine = true;
    } catch (e) {
      const msg = e instanceof OpError ? e.message : e instanceof Error ? `${e.message}` : String(e);
      return { workbook: wb, error: `op ${i + 1} (${isObj(op) ? String(op.op) : '?'}): ${msg}`, log: cx.log, touched: [] };
    }
  }
  return { workbook: next, log: cx.log, touched: cx.touched === 'all' ? 'all' : [...cx.touched], created: cx.created };
}

export function parseOps(value: unknown): { ops: Op[]; errors: string[] } {
  if (!Array.isArray(value)) return { ops: [], errors: ['ops must be an array of {op: …} objects'] };
  const ops: Op[] = [], errors: string[] = [];
  value.forEach((o, i) => { if (isObj(o) && typeof o.op === 'string') ops.push(o as Op); else errors.push(`op ${i + 1} is not an object with "op"`); });
  return { ops, errors };
}

/* ---------------- delimited text (CSV / TSV) ---------------- */

export function parseDelimited(text: string, delim = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false, i = 0;
  const t = text.replace(/^﻿/, '');
  while (i < t.length) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { q = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += ch === '\r' && t[i + 1] === '\n' ? 2 : 1; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
export function toDelimited(grid: string[][], delim = ','): string {
  const esc = (s: string) => (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r') || (delim === ',' && /^\s|\s$/.test(s)) ? `"${s.replace(/"/g, '""')}"` : s);
  return grid.map((row) => row.map(esc).join(delim)).join('\r\n');
}
/** Displayed values of a range as text rows (what CSV/TSV export and copy write). */
export function rangeText(s: Sheet, rect: Rect, engine: Engine, formulas = false): string[][] {
  const out: string[][] = [];
  for (let r = rect.r1; r <= rect.r2; r++) {
    const row: string[] = [];
    for (let c = rect.c1; c <= rect.c2; c++) {
      const cell = cellAt(s, r, c);
      row.push(formulas && cell?.f ? cell.f : engine.display(s.id, r, c).text);
    }
    out.push(row);
  }
  return out;
}

/* ---------------- review and summaries for agents ---------------- */

/** Canonical relative form of a formula (R1C1-like) so formulas of one column can be compared. */
export function relativeForm(f: string, r: number, c: number): string {
  return transformRefs(f, (ref) => ({ ...ref, r1: ref.ar1 ? ref.r1 : ref.r1 - r + 100000, r2: ref.ar2 || !Number.isFinite(ref.r2) ? ref.r2 : ref.r2 - r + 100000, c1: ref.ac1 ? ref.c1 : ref.c1 - c + 5000, c2: ref.ac2 || !Number.isFinite(ref.c2) ? ref.c2 : ref.c2 - c + 5000 }));
}

export function checkWorkbook(wb: Workbook, engine: Engine): string[] {
  const out: string[] = [];
  const errs = engine.errors(20);
  if (errs.length) out.push(`formula errors: ${errs.slice(0, 8).map((e) => `${e.sheet}!${e.cell} ${e.code}${e.message ? ` (${e.message})` : ''}`).join('; ')}${errs.length > 8 ? ` …and more` : ''}`);
  for (const s of wb.sheets) {
    // numbers stored as text
    const textNums: string[] = [];
    // hard-coded numbers in formulas
    const magic: string[] = [];
    // inconsistent formulas in a column
    const byCol = new Map<number, { r: number; form: string }[]>();
    for (const [a, cell] of Object.entries(s.cells)) {
      const p = parseAddr(a)!;
      if (typeof cell.v === 'string' && /^\s*[-+]?\d[\d,]*(\.\d+)?\s*$/.test(cell.v) && cell.s?.nf !== '@' && textNums.length < 6) textNums.push(a);
      if (cell.f) {
        if (/[^A-Z$0-9.:!](\d+\.\d+|\d{2,})(?![\d:A-Z])/.test(cell.f.replace(/"[^"]*"/g, '""').replace(/\$?[A-Z]{1,3}\$?\d+/g, 'R')) && magic.length < 4 && !/^=(ROUND|TEXT|DATE|SEQUENCE|LARGE|SMALL|INDEX|OFFSET|CHOOSE)/i.test(cell.f)) magic.push(`${a} ${cell.f}`);
        const list = byCol.get(p.c) ?? [];
        list.push({ r: p.r, form: relativeForm(cell.f, p.r, p.c) });
        byCol.set(p.c, list);
      }
    }
    if (textNums.length) out.push(`${s.name}: numbers stored as text in ${textNums.join(', ')} — SUM ignores them; set them again as numbers`);
    if (magic.length) out.push(`${s.name}: numbers typed inside formulas (${magic.join('; ')}) — consider an input cell so the assumption is visible and easy to change`);
    for (const [c, list] of byCol) {
      if (list.length < 3) continue;
      const counts = new Map<string, number>();
      for (const x of list) counts.set(x.form, (counts.get(x.form) ?? 0) + 1);
      const [major, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (n >= 3 && n < list.length) {
        const odd = list.filter((x) => x.form !== major).map((x) => addr(x.r, c));
        // only report a single odd one out inside a block of consistent formulas
        if (odd.length <= 2 && odd.length < list.length / 2) out.push(`${s.name}: ${odd.join(', ')} differ from the other formulas in column ${colName(c)} — check they are intended`);
      }
    }
    // validation violations
    for (const v of s.validations) {
      const rect = parseRect(v.range); if (!rect) continue;
      const bad: string[] = [];
      for (const { r, c, a } of existing(s, rect)) { const msg = validate(wb, s, v, engine.value(s.id, r, c), engine); if (msg && bad.length < 5) bad.push(a); }
      if (bad.length) out.push(`${s.name}: ${bad.join(', ')} break the ${v.type} rule on ${v.range}`);
    }
    for (const ch of s.charts) { const res = resolveRange(wb, ch.range, s); if (!res) out.push(`${s.name}: chart ${ch.id} points at a missing range ${ch.range}`); }
    if (s.merges.length && s.filter) out.push(`${s.name}: merged cells inside a filtered table make sorting and filtering unreliable`);
  }
  return out;
}

/** Error message when a value breaks a validation rule, or null when it is fine. */
export function validate(wb: Workbook, s: Sheet, v: Validation, value: Scalar, engine?: Engine): string | null {
  if (value === null || value === '') return null;
  const n = typeof value === 'number' ? value : null;
  const between = (x: number) => {
    const lo = v.min ?? -Infinity, hi = v.max ?? Infinity;
    switch (v.op) {
      case 'not_between': return x < lo || x > hi;
      case 'gt': return x > (v.min ?? v.max!);
      case 'gte': return x >= (v.min ?? v.max!);
      case 'lt': return x < (v.max ?? v.min!);
      case 'lte': return x <= (v.max ?? v.min!);
      case 'eq': return x === (v.min ?? v.max);
      case 'neq': return x !== (v.min ?? v.max);
      default: return x >= lo && x <= hi;
    }
  };
  switch (v.type) {
    case 'list': return (v.values ?? []).some((x) => x.toLowerCase() === displayScalar(value).toLowerCase()) ? null : `Choose one of: ${(v.values ?? []).slice(0, 8).join(', ')}`;
    case 'range': {
      const items = validationItems(wb, s, v, engine);
      return items.some((x) => x.toLowerCase() === displayScalar(value).toLowerCase()) ? null : 'Choose a value from the list';
    }
    case 'checkbox': return typeof value === 'boolean' ? null : 'Must be TRUE or FALSE (a checkbox)';
    case 'number': return n !== null && between(n) ? null : `Enter a number ${describeRule(v)}`;
    case 'date': return n !== null && between(Math.floor(n)) ? null : `Enter a date ${describeRule(v)}`;
    case 'text_length': return between(displayScalar(value).length) ? null : `Text length must be ${describeRule(v)}`;
    case 'custom': return null; // evaluated by the editor with the engine
  }
  return null;
}
export function describeRule(v: Validation): string {
  const f = (x: number | undefined) => (v.type === 'date' && x !== undefined ? isoDate(x) : String(x));
  switch (v.op) {
    case 'not_between': return `outside ${f(v.min)}–${f(v.max)}`;
    case 'gt': return `greater than ${f(v.min ?? v.max)}`;
    case 'gte': return `at least ${f(v.min ?? v.max)}`;
    case 'lt': return `less than ${f(v.max ?? v.min)}`;
    case 'lte': return `at most ${f(v.max ?? v.min)}`;
    case 'eq': return `equal to ${f(v.min ?? v.max)}`;
    case 'neq': return `not equal to ${f(v.min ?? v.max)}`;
    default: return `between ${f(v.min)} and ${f(v.max)}`;
  }
}
const isoDate = (serial: number): string => { const p = partsFromSerial(serial); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
export function validationItems(wb: Workbook, s: Sheet, v: Validation, engine?: Engine): string[] {
  if (v.type === 'list') return v.values ?? [];
  if (v.type !== 'range' || !v.source) return [];
  const res = resolveRange(wb, v.source, s);
  if (!res) return [];
  const e = engine ?? new Engine(wb);
  const out: string[] = [];
  const last = Math.min(res.rect.r2, res.rect.r1 + 500);
  for (let r = res.rect.r1; r <= last; r++) for (let c = res.rect.c1; c <= res.rect.c2; c++) { const t = e.display(res.sheet.id, r, c).text; if (t && !out.includes(t)) out.push(t); }
  return out;
}
export const validationAt = (s: Sheet, r: number, c: number): Validation | undefined => {
  for (let i = s.validations.length - 1; i >= 0; i--) { const rect = parseRect(s.validations[i].range); if (rect && inRect(rect, r, c)) return s.validations[i]; }
  return undefined;
};

export function summarizeWorkbook(wb: Workbook, engine: Engine): string {
  const lines = [`"${wb.title}" — ${wb.sheets.length} sheet(s)`];
  for (const s of wb.sheets) {
    const used = usedRect(s);
    const formulas = Object.values(s.cells).filter((c) => c.f).length;
    const head = used ? rangeText(s, { r1: used.r1, c1: used.c1, r2: used.r1, c2: Math.min(used.c2, used.c1 + 11) }, engine)[0].map((t, i) => `${colName(used.c1 + i)}=${t || '·'}`).join(' ') : '';
    lines.push(`- ${s.name}${s.hidden ? ' (hidden)' : ''} [${s.id}]: ${s.rows}×${s.cols} grid, used ${used ? rectText(used) : 'nothing'}, ${Object.keys(s.cells).length} cells, ${formulas} formulas`
      + `${s.frozenRows || s.frozenCols ? `, frozen ${s.frozenRows}r/${s.frozenCols}c` : ''}${s.merges.length ? `, ${s.merges.length} merge(s)` : ''}${s.validations.length ? `, ${s.validations.length} validation(s)` : ''}`
      + `${s.condFormats.length ? `, ${s.condFormats.length} conditional format(s)` : ''}${s.filter ? `, filter ${s.filter.range}` : ''}${s.charts.length ? `, charts: ${s.charts.map((c) => `${c.id} ${c.type} ${c.range}`).join('; ')}` : ''}`);
    if (head) lines.push(`  first row: ${head}`);
  }
  const names = Object.entries(wb.names);
  if (names.length) lines.push(`Named ranges: ${names.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines.join('\n');
}

/** Compact text of a range for agents: one line per row, "A1=value" or "A1=value ‹=FORMULA›". */
export function readRange(s: Sheet, rect: Rect, engine: Engine, opts: { formulas?: boolean; formats?: boolean; limit?: number } = {}): string {
  const limit = opts.limit ?? 2000;
  const lines: string[] = [];
  let n = 0;
  const used = usedRect(s);
  const r2 = Math.min(rect.r2, used ? used.r2 : rect.r1), c2 = Math.min(rect.c2, used ? Math.max(used.c2, rect.c1) : rect.c1);
  for (let r = rect.r1; r <= r2; r++) {
    const parts: string[] = [];
    for (let c = rect.c1; c <= c2; c++) {
      const cell = cellAt(s, r, c);
      const d = engine.display(s.id, r, c);
      if (!cell && !d.text) continue;
      if (++n > limit) { lines.push(`[stopped after ${limit} cells — read a smaller range]`); return lines.join('\n'); }
      let t = `${addr(r, c)}=${d.text === '' ? '∅' : JSON.stringify(d.text).slice(1, -1)}`;
      if (opts.formulas !== false && cell?.f) t += ` ‹${cell.f}›`;
      if (d.error && cell?.f) t += ` [${d.error}]`;
      if (opts.formats && cell?.s) t += ` {${Object.entries(cell.s).map(([k, v]) => `${k}:${v}`).join(',')}}`;
      if (cell?.note) t += ` (note: ${cell.note.slice(0, 80)})`;
      const sp = engine.spillOf(s.id, r, c);
      if (sp && sp.origin[0] === r && sp.origin[1] === c) t += ` [spills ${sp.size[0]}×${sp.size[1]}]`;
      parts.push(t);
    }
    if (parts.length) lines.push(parts.join(' | '));
  }
  return lines.length ? lines.join('\n') : '(empty range)';
}

/* ---------------- templates ---------------- */

export function templateOps(kind: string): Op[] {
  switch (kind) {
    case 'budget': return [
      { op: 'workbook', title: 'Monthly budget' },
      { op: 'sheet_rename', sheet: 'Sheet1', name: 'Budget' },
      { op: 'set', range: 'A1', values: [['Monthly budget'], [''], ['Category', 'Planned', 'Actual', 'Difference', '% of income'], ['Rent', 1500, 1500], ['Groceries', 600, 655], ['Transport', 250, 210], ['Utilities', 200, 188], ['Eating out', 200, 276], ['Savings', 1000, 1000], ['Other', 300, 140]] },
      { op: 'set', range: 'A11', values: [['Total spending', '=SUM(B4:B10)', '=SUM(C4:C10)'], [''], ['Income', 5000, 5200], ['Left over', '=B13-B11', '=C13-C11']] },
      { op: 'set', range: 'D4', formula: '=C4-B4' }, { op: 'fill', from: 'D4', to: 'D4:D11' },
      { op: 'set', range: 'E4', formula: '=IFERROR(C4/$C$13,0)' }, { op: 'fill', from: 'E4', to: 'E4:E11' },
      { op: 'format', range: 'A1', bold: true, size: 16 },
      { op: 'format', range: 'A3:E3', bold: true, fill: '#1a73e8', color: '#ffffff' },
      { op: 'format', range: 'B4:D14', number: '#,##0.00' }, { op: 'format', range: 'E4:E11', number: '0.0%' },
      { op: 'format', range: 'A11:E11', bold: true }, { op: 'border', range: 'A11:E11', where: 'top', style: 'medium' },
      { op: 'format', range: 'A13:C14', bold: true }, { op: 'format', range: 'A13:C13', fill: '#e8f0fe' },
      { op: 'cond_format', range: 'D4:D10', type: 'gt', value: 0, style: { color: '#c5221f', fill: '#fce8e6' } },
      { op: 'col_width', from: 'A', size: 140 }, { op: 'col_width', from: 'B', to: 'E', size: 110 },
      { op: 'freeze', rows: 3 },
      { op: 'chart_add', type: 'bar', range: 'A3:C10', title: 'Planned vs actual spending', anchor: 'G3', w: 460, h: 300 },
    ];
    case 'sales': return [
      { op: 'workbook', title: 'Sales tracker' },
      { op: 'sheet_rename', sheet: 'Sheet1', name: 'Sales' },
      { op: 'set', range: 'A1', values: [
        ['Date', 'Region', 'Product', 'Units', 'Price', 'Revenue'],
        ['2026-01-05', 'North', 'Widget', 12, 19.5], ['2026-01-09', 'South', 'Gadget', 7, 42], ['2026-01-14', 'East', 'Widget', 20, 19.5],
        ['2026-02-02', 'West', 'Gizmo', 5, 88], ['2026-02-11', 'North', 'Gadget', 9, 42], ['2026-02-20', 'South', 'Widget', 15, 19.5],
        ['2026-03-03', 'East', 'Gizmo', 4, 88], ['2026-03-12', 'West', 'Widget', 18, 19.5], ['2026-03-21', 'North', 'Gizmo', 6, 88],
        ['2026-04-01', 'South', 'Gadget', 11, 42], ['2026-04-15', 'East', 'Gadget', 8, 42], ['2026-04-28', 'West', 'Gizmo', 3, 88],
      ] },
      { op: 'set', range: 'F2', formula: '=D2*E2' }, { op: 'fill', from: 'F2', to: 'F2:F13' },
      { op: 'format', range: 'A1:F1', bold: true, fill: '#188038', color: '#ffffff' },
      { op: 'format', range: 'E2:F13', number: 'currency' },
      { op: 'banding', range: 'A1:F13', header: '#188038', odd: '#ffffff', even: '#e6f4ea' },
      { op: 'freeze', rows: 1 }, { op: 'filter', range: 'A1:F13' },
      { op: 'validation', range: 'B2:B100', type: 'list', values: ['North', 'South', 'East', 'West'] },
      { op: 'set', range: 'H1', values: [['Region', 'Revenue', 'Units'], ['North'], ['South'], ['East'], ['West'], ['Total']] },
      { op: 'set', range: 'I2', formula: '=SUMIFS($F$2:$F$13,$B$2:$B$13,H2)' }, { op: 'fill', from: 'I2', to: 'I2:I5' },
      { op: 'set', range: 'J2', formula: '=SUMIFS($D$2:$D$13,$B$2:$B$13,H2)' }, { op: 'fill', from: 'J2', to: 'J2:J5' },
      { op: 'set', range: 'I6', formula: '=SUM(I2:I5)' }, { op: 'set', range: 'J6', formula: '=SUM(J2:J5)' },
      { op: 'format', range: 'H1:J1', bold: true }, { op: 'format', range: 'H6:J6', bold: true }, { op: 'format', range: 'I2:I6', number: 'currency' },
      { op: 'cond_format', range: 'F2:F13', type: 'scale', colors: ['#ffffff', '#57bb8a'] },
      { op: 'col_width', from: 'A', size: 96 },
      { op: 'chart_add', type: 'column', range: 'H1:I5', title: 'Revenue by region', anchor: 'H9', w: 420, h: 260, legend: 'none' },
    ];
    case 'tasks': return [
      { op: 'workbook', title: 'Task list' },
      { op: 'sheet_rename', sheet: 'Sheet1', name: 'Tasks' },
      { op: 'set', range: 'A1', values: [['Done', 'Task', 'Owner', 'Status', 'Priority', 'Due'], [false, 'Write the brief', 'Ann', 'In progress', 'High', '2026-12-01'], [true, 'Book the venue', 'Ben', 'Done', 'Medium', '2026-11-20'], [false, 'Send invitations', 'Chai', 'Not started', 'High', '2026-12-05'], [false, 'Order catering', 'Ann', 'Blocked', 'Low', '2026-12-10']] },
      { op: 'validation', range: 'A2:A200', type: 'checkbox' },
      { op: 'validation', range: 'D2:D200', type: 'list', values: ['Not started', 'In progress', 'Blocked', 'Done'], colors: { 'Not started': '#e8eaed', 'In progress': '#d2e3fc', Blocked: '#fad2cf', Done: '#ceead6' } },
      { op: 'validation', range: 'E2:E200', type: 'list', values: ['High', 'Medium', 'Low'] },
      { op: 'format', range: 'A1:F1', bold: true, fill: '#f1f3f4' },
      { op: 'cond_format', range: 'A2:F200', type: 'formula', value: '=$A2=TRUE', style: { color: '#80868b', strike: true } },
      { op: 'cond_format', range: 'F2:F200', type: 'formula', value: '=AND($F2<>"",$F2<TODAY(),$A2=FALSE)', style: { color: '#c5221f', bold: true } },
      { op: 'set', range: 'H1', values: [['Open tasks', '=COUNTIF(A2:A200,FALSE)-COUNTBLANK(B2:B200)+COUNTBLANK(A2:A200)*0'], ['Done', '=COUNTIF(A2:A200,TRUE)'], ['Progress', '=IFERROR(I2/(I1+I2),0)']] },
      { op: 'set', range: 'I1', formula: '=COUNTIFS(A2:A200,FALSE,B2:B200,"<>")' },
      { op: 'format', range: 'I3', number: '0%' }, { op: 'format', range: 'H1:H3', bold: true },
      { op: 'col_width', from: 'B', size: 180 }, { op: 'col_width', from: 'A', size: 56 }, { op: 'freeze', rows: 1 },
    ];
    default: return [];
  }
}

export { addr, colName, colIndex, parseAddr, parseRect, rectText, inRect, norm, isMatrix, staticDeps, keyOf, serialFromParts, criterion };
export type { Rect, Scalar };
