/** The evaluator and the function library of the Sheet menu. Semantics follow Google Sheets where it is practical:
 * dates are serial numbers, text compares case-insensitively, ranges ignore text in SUM-like functions, and any
 * formula that returns an array spills into the cells next to it (operators and scalar functions broadcast over arrays,
 * so ARRAYFORMULA is accepted but not required). */
import {
  ERR_CODES, FErr, addr, colIndex, colName, err, isErr, isMatrix, isRef, parse, parseAddr, quoteSheet, tokenize,
  type ErrCode, type Matrix, type Node, type RefV, type Scalar, type Value,
} from './formula.ts';
import { DAYS, MONTHS, displayScalar, formatValue, parseDateText, partsFromSerial, serialFromLocal, serialFromParts, textToNumber } from './numfmt.ts';

export interface Host {
  /** Sheet id for a sheet name (case-insensitive), or null. */
  sheetId(name: string): string | null;
  sheetName(id: string): string;
  /** Computed value of one cell (recursing into formulas). */
  get(sheet: string, r: number, c: number): Scalar;
  /** Extent used to clamp whole-column / whole-row references. */
  size(sheet: string): { rows: number; cols: number };
  /** A named range, or null. */
  name(name: string): RefV | null;
  /** Does the cell hold a formula (ISFORMULA, FORMULATEXT)? */
  formula?(sheet: string, r: number, c: number): string | null;
  now(): number;
  random(): number;
}
export interface Cx { host: Host; sheet: string; r: number; c: number }

/* ---------------- coercion ---------------- */

export function toScalar(v: Value, cx: Cx): Scalar {
  if (isRef(v)) {
    if (v.r1 > v.r2 || v.c1 > v.c2) return null;
    if (v.r1 === v.r2 && v.c1 === v.c2) return cx.host.get(v.sheet, v.r1, v.c1);
    // implicit intersection with the formula's own row / column, else the top-left cell
    if (v.sheet === cx.sheet && v.c1 === v.c2 && cx.r >= v.r1 && cx.r <= v.r2) return cx.host.get(v.sheet, cx.r, v.c1);
    if (v.sheet === cx.sheet && v.r1 === v.r2 && cx.c >= v.c1 && cx.c <= v.c2) return cx.host.get(v.sheet, v.r1, cx.c);
    return cx.host.get(v.sheet, v.r1, v.c1);
  }
  if (isMatrix(v)) return v.length && v[0].length ? v[0][0] : null;
  return v;
}
const MAX_MATRIX = 2_000_000;
export function toMatrix(v: Value, cx: Cx): Matrix {
  if (isRef(v)) {
    const h = v.r2 - v.r1 + 1, w = v.c2 - v.c1 + 1;
    if (h <= 0 || w <= 0) return [];
    if (h * w > MAX_MATRIX) throw err('#NUM!', 'Range is too large');
    const out: Matrix = [];
    for (let r = v.r1; r <= v.r2; r++) { const row: Scalar[] = []; for (let c = v.c1; c <= v.c2; c++) row.push(cx.host.get(v.sheet, r, c)); out.push(row); }
    return out;
  }
  if (isMatrix(v)) return v;
  return [[v]];
}
/** Single value or array (a multi-cell reference becomes an array). */
function settle(v: Value, cx: Cx): Scalar | Matrix {
  if (isRef(v)) return v.r1 === v.r2 && v.c1 === v.c2 ? cx.host.get(v.sheet, v.r1, v.c1) : toMatrix(v, cx);
  if (isMatrix(v) && v.length === 1 && v[0].length === 1) return v[0][0];
  return v;
}
export function toNum(v: Scalar): number | FErr {
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isErr(v)) return v;
  const n = textToNumber(v);
  return n === null ? err('#VALUE!', `"${v.length > 30 ? v.slice(0, 30) + '…' : v}" is text, not a number`) : n;
}
export function toStr(v: Scalar): string | FErr {
  if (isErr(v)) return v;
  return displayScalar(v);
}
export function toBool(v: Scalar): boolean | FErr {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (isErr(v)) return v;
  const t = v.trim().toUpperCase();
  if (t === 'TRUE') return true;
  if (t === 'FALSE') return false;
  return err('#VALUE!', `"${v}" is not TRUE or FALSE`);
}
const N = (v: Value, cx: Cx): number => { const n = toNum(toScalar(v, cx)); if (isErr(n)) throw n; return n; };
const Sx = (v: Value, cx: Cx): string => { const s = toStr(toScalar(v, cx)); if (isErr(s)) throw s; return s; };
const B = (v: Value, cx: Cx): boolean => { const b = toBool(toScalar(v, cx)); if (isErr(b)) throw b; return b; };
const raw = (v: Value, cx: Cx): Scalar => { const s = toScalar(v, cx); if (isErr(s)) throw s; return s; };
const int = (v: Value, cx: Cx): number => Math.trunc(N(v, cx));

/** Compare like Sheets: numbers < text < booleans; text is case-insensitive; empty equals 0, "" and FALSE. */
export function compare(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === 'number' ? 0 : typeof b === 'boolean' ? false : '';
  if (b === null) b = typeof a === 'number' ? 0 : typeof a === 'boolean' ? false : '';
  const rank = (x: Scalar) => (typeof x === 'number' ? 0 : typeof x === 'string' ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') { const x = a.toLowerCase(), y = b.toLowerCase(); return x === y ? 0 : x < y ? -1 : 1; }
  return Number(a) - Number(b);
}

/* ---------------- evaluator ---------------- */

export function evaluate(node: Node, cx: Cx): Value {
  try { return ev(node, cx); }
  catch (e) { if (e instanceof FErr) return e; throw e; }
}

function ev(n: Node, cx: Cx): Value {
  switch (n.t) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'bool': return n.v;
    case 'err': return err(n.v);
    case 'empty': return null;
    case 'ref': {
      const r = n.ref;
      let sheet = cx.sheet;
      if (r.sheet !== undefined) {
        const id = cx.host.sheetId(r.sheet);
        if (!id) return err('#REF!', `Unresolved sheet name '${r.sheet}'`);
        sheet = id;
      }
      const size = cx.host.size(sheet);
      const r2 = Number.isFinite(r.r2) ? r.r2 : Math.max(r.r1, size.rows - 1);
      const c2 = Number.isFinite(r.c2) ? r.c2 : Math.max(r.c1, size.cols - 1);
      if (r.r1 < 0 || r.c1 < 0) return err('#REF!');
      return { kind: 'ref', sheet, r1: Math.min(r.r1, r2), c1: Math.min(r.c1, c2), r2: Math.max(r.r1, r2), c2: Math.max(r.c1, c2) };
    }
    case 'name': {
      const ref = cx.host.name(n.v);
      if (!ref) return err('#NAME?', `Unknown range name: '${n.v}'`);
      return ref;
    }
    case 'arr': return n.rows.map((row) => row.map((x) => { const v = settle(ev(x, cx), cx); return isMatrix(v) ? (v[0]?.[0] ?? null) : v; }));
    case 'un': {
      const a = settle(ev(n.a, cx), cx);
      return map1(a, (x) => { const v = toNum(x); return isErr(v) ? v : n.op === '-' ? -v : v; });
    }
    case 'pct': return map1(settle(ev(n.a, cx), cx), (x) => { const v = toNum(x); return isErr(v) ? v : v / 100; });
    case 'bin': {
      const a = settle(ev(n.a, cx), cx), b = settle(ev(n.b, cx), cx);
      return map2(a, b, (x, y) => binop(n.op, x, y));
    }
    case 'fn': return callFn(n.name, n.args, cx);
  }
}

function binop(op: string, x: Scalar, y: Scalar): Scalar {
  if (op === '&') { const a = toStr(x), b = toStr(y); if (isErr(a)) return a; if (isErr(b)) return b; return a + b; }
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    if (isErr(x)) return x; if (isErr(y)) return y;
    const c = compare(x, y);
    return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  }
  const a = toNum(x); if (isErr(a)) return a;
  const b = toNum(y); if (isErr(b)) return b;
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? err('#DIV/0!', 'Function DIVIDE parameter 2 cannot be zero.') : a / b;
    case '^': { const v = Math.pow(a, b); return Number.isFinite(v) ? v : err('#NUM!'); }
  }
  return err('#ERROR!', `Unknown operator ${op}`);
}

function map1(a: Scalar | Matrix, f: (x: Scalar) => Scalar): Scalar | Matrix {
  return isMatrix(a) ? a.map((row) => row.map(f)) : f(a);
}
function map2(a: Scalar | Matrix, b: Scalar | Matrix, f: (x: Scalar, y: Scalar) => Scalar): Scalar | Matrix {
  if (!isMatrix(a) && !isMatrix(b)) return f(a, b);
  const A = isMatrix(a) ? a : [[a]], Bm = isMatrix(b) ? b : [[b]];
  const h = Math.max(A.length, Bm.length), w = Math.max(A[0]?.length ?? 0, Bm[0]?.length ?? 0);
  const at = (m: Matrix, r: number, c: number): Scalar | undefined => {
    const rr = m.length === 1 ? 0 : r, cc = (m[0]?.length ?? 0) === 1 ? 0 : c;
    return m[rr]?.[cc];
  };
  const out: Matrix = [];
  for (let r = 0; r < h; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < w; c++) { const x = at(A, r, c), y = at(Bm, r, c); row.push(x === undefined || y === undefined ? err('#N/A') : f(x, y)); }
    out.push(row);
  }
  return out;
}

/* ---------------- function library ---------------- */

export interface FnDef {
  cat: 'Math' | 'Statistical' | 'Logical' | 'Lookup' | 'Text' | 'Date' | 'Financial' | 'Array' | 'Info';
  syntax: string;
  desc: string;
  min: number;
  max: number;
  /** Gets the unevaluated argument nodes (IF, IFERROR…) instead of values. */
  lazy?: (args: Node[], cx: Cx) => Value;
  run?: (args: Value[], cx: Cx) => Value;
}
export const FUNCTIONS: Record<string, FnDef> = {};
const def = (name: string, d: FnDef): void => { FUNCTIONS[name] = d; };
const alias = (name: string, target: string): void => { FUNCTIONS[name] = FUNCTIONS[target]; };

function callFn(name: string, nodes: Node[], cx: Cx): Value {
  const f = FUNCTIONS[name];
  if (!f) return err('#NAME?', `Unknown function: '${name}'`);
  if (nodes.length < f.min || nodes.length > f.max) {
    return err('#N/A', `Wrong number of arguments to ${name}. Expected ${f.min === f.max ? f.min : f.max === Infinity ? `at least ${f.min}` : `between ${f.min} and ${f.max}`} arguments, but got ${nodes.length}.`);
  }
  try {
    if (f.lazy) return f.lazy(nodes, cx);
    const args = nodes.map((n) => ev(n, cx));
    return f.run!(args, cx);
  } catch (e) {
    if (e instanceof FErr) return e;
    throw e;
  }
}

/** Wraps a function of plain scalars so it broadcasts over arrays and propagates errors. */
function scalarFn(f: (xs: Scalar[], cx: Cx) => Scalar) {
  return (args: Value[], cx: Cx): Value => {
    const vals = args.map((a) => settle(a, cx));
    if (!vals.some(isMatrix)) {
      try { return f(vals as Scalar[], cx); } catch (e) { if (e instanceof FErr) return e; throw e; }
    }
    let h = 1, w = 1;
    for (const v of vals) if (isMatrix(v)) { h = Math.max(h, v.length); w = Math.max(w, v[0]?.length ?? 0); }
    const out: Matrix = [];
    for (let r = 0; r < h; r++) {
      const row: Scalar[] = [];
      for (let c = 0; c < w; c++) {
        const xs = vals.map((v) => (isMatrix(v) ? v[v.length === 1 ? 0 : r]?.[(v[0]?.length ?? 0) === 1 ? 0 : c] ?? err('#N/A') : v));
        try { row.push(f(xs, cx)); } catch (e) { if (e instanceof FErr) row.push(e); else throw e; }
      }
      out.push(row);
    }
    return out;
  };
}
const sn = (x: Scalar): number => { const n = toNum(x); if (isErr(n)) throw n; return n; };
const ss = (x: Scalar): string => { const s = toStr(x); if (isErr(s)) throw s; return s; };
const sb = (x: Scalar): boolean => { const b = toBool(x); if (isErr(b)) throw b; return b; };
const opt = (xs: Scalar[], i: number, d: number): number => (xs[i] === undefined || xs[i] === null ? d : sn(xs[i]));
const fin = (v: number): number | FErr => (Number.isFinite(v) ? v : err('#NUM!'));

/** Walks every value of the arguments. `direct` is true for values typed as arguments (not from a range or array). */
function* walk(args: Value[], cx: Cx): Generator<{ v: Scalar; direct: boolean }> {
  for (const a of args) {
    if (isRef(a)) {
      if (a.r1 === a.r2 && a.c1 === a.c2) { yield { v: cx.host.get(a.sheet, a.r1, a.c1), direct: false }; continue; }
      for (const row of toMatrix(a, cx)) for (const v of row) yield { v, direct: false };
    } else if (isMatrix(a)) { for (const row of a) for (const v of row) yield { v, direct: false }; }
    else yield { v: a, direct: true };
  }
}
/** Numbers for SUM/AVERAGE/MIN/MAX: typed arguments are coerced, text and booleans inside ranges are skipped. */
function numbers(args: Value[], cx: Cx): number[] {
  const out: number[] = [];
  for (const { v, direct } of walk(args, cx)) {
    if (isErr(v)) throw v;
    if (typeof v === 'number') out.push(v);
    else if (direct && v !== null) out.push(sn(v));
  }
  return out;
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);
function variance(xs: number[], sample: boolean): number {
  if (xs.length < (sample ? 2 : 1)) throw err('#DIV/0!');
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - (sample ? 1 : 0));
}

/* ---- criteria (COUNTIF, SUMIFS, …) ---- */

export function wildcard(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && (pattern[i + 1] === '*' || pattern[i + 1] === '?' || pattern[i + 1] === '~')) { re += '\\' + pattern[++i]; continue; }
    if (ch === '*') re += '[\\s\\S]*'; else if (ch === '?') re += '[\\s\\S]'; else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
export function criterion(c: Scalar): (v: Scalar) => boolean {
  if (isErr(c)) return (v) => isErr(v) && v.code === c.code;
  if (typeof c === 'number') return (v) => (typeof v === 'number' ? v === c : typeof v === 'string' && textToNumber(v) === c && v.trim() !== '');
  if (typeof c === 'boolean') return (v) => v === c;
  if (c === null) return (v) => v === null || v === '';
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c)!;
  const op = m[1] ?? '=', rest = m[2];
  const num = rest.trim() === '' ? null : textToNumber(rest);
  if (rest === '' ) return op === '<>' ? (v) => v !== null && v !== '' : op === '=' ? (v) => v === null || v === '' : () => false;
  if (num !== null && !/^\s*$/.test(rest)) {
    const cmp = (v: Scalar): number | null => (typeof v === 'number' ? v : typeof v === 'boolean' || v === null || isErr(v) ? null : textToNumber(v) !== null && v.trim() !== '' ? textToNumber(v) : null);
    return (v) => {
      const x = cmp(v);
      if (x === null) return op === '<>';
      return op === '=' ? x === num : op === '<>' ? x !== num : op === '<' ? x < num : op === '>' ? x > num : op === '<=' ? x <= num : x >= num;
    };
  }
  if (/^(true|false)$/i.test(rest)) { const b = rest.toLowerCase() === 'true'; return (v) => (op === '<>' ? v !== b : v === b); }
  if (op === '=' || op === '<>') {
    const re = /[*?]/.test(rest) ? wildcard(rest) : null;
    const low = rest.toLowerCase();
    const eq = (v: Scalar) => { if (v === null || isErr(v)) return false; const s = displayScalar(v); return re ? re.test(s) : s.toLowerCase() === low; };
    return op === '=' ? eq : (v) => !eq(v);
  }
  return (v) => {
    if (typeof v !== 'string') return false;
    const r = compare(v, rest);
    return op === '<' ? r < 0 : op === '>' ? r > 0 : op === '<=' ? r <= 0 : r >= 0;
  };
}
/** Pairs of (range, criterion) → mask of matching positions (all ranges must have the same shape). */
function maskOf(pairs: Value[], cx: Cx): { mask: boolean[]; h: number; w: number } {
  let h = -1, w = -1, mask: boolean[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const m = toMatrix(pairs[i], cx);
    const test = criterion(raw(pairs[i + 1], cx));
    if (h < 0) { h = m.length; w = m[0]?.length ?? 0; mask = new Array(h * w).fill(true); }
    else if (m.length !== h || (m[0]?.length ?? 0) !== w) throw err('#VALUE!', 'Array arguments to the criteria functions are of different size.');
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (mask[r * w + c] && !test(m[r][c])) mask[r * w + c] = false;
  }
  return { mask, h, w };
}
function ifsValues(target: Value, pairs: Value[], cx: Cx): Scalar[] {
  const t = toMatrix(target, cx);
  const { mask, h, w } = maskOf(pairs, cx);
  if (t.length !== h || (t[0]?.length ?? 0) !== w) throw err('#VALUE!', 'Array arguments to the criteria functions are of different size.');
  const out: Scalar[] = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (mask[r * w + c]) out.push(t[r][c]);
  return out;
}
const numsOnly = (xs: Scalar[]): number[] => { const o: number[] = []; for (const x of xs) { if (isErr(x)) throw x; if (typeof x === 'number') o.push(x); } return o; };

/* ---------------- Math ---------------- */

def('SUM', { cat: 'Math', syntax: 'SUM(value1, [value2, …])', desc: 'Adds numbers and ranges', min: 1, max: Infinity, run: (a, cx) => sum(numbers(a, cx)) });
def('PRODUCT', { cat: 'Math', syntax: 'PRODUCT(factor1, [factor2, …])', desc: 'Multiplies numbers', min: 1, max: Infinity, run: (a, cx) => numbers(a, cx).reduce((x, y) => x * y, 1) });
def('SUMSQ', { cat: 'Math', syntax: 'SUMSQ(value1, [value2, …])', desc: 'Sum of squares', min: 1, max: Infinity, run: (a, cx) => sum(numbers(a, cx).map((x) => x * x)) });
def('SUMIF', {
  cat: 'Math', syntax: 'SUMIF(range, criterion, [sum_range])', desc: 'Sum where the range meets a condition, e.g. ">10" or "apple*"', min: 2, max: 3,
  run: (a, cx) => sum(numsOnly(ifsValues(a[2] ?? a[0], [a[0], a[1]], cx))),
});
def('SUMIFS', {
  cat: 'Math', syntax: 'SUMIFS(sum_range, range1, criterion1, [range2, criterion2, …])', desc: 'Sum where every condition holds', min: 3, max: Infinity,
  run: (a, cx) => { if (a.length % 2 === 0) throw err('#N/A', 'SUMIFS needs pairs of range and criterion'); return sum(numsOnly(ifsValues(a[0], a.slice(1), cx))); },
});
def('SUMPRODUCT', {
  cat: 'Math', syntax: 'SUMPRODUCT(array1, [array2, …])', desc: 'Multiplies arrays element by element and adds the results', min: 1, max: Infinity,
  run: (a, cx) => {
    const ms = a.map((x) => toMatrix(x, cx));
    const h = ms[0].length, w = ms[0][0]?.length ?? 0;
    if (ms.some((m) => m.length !== h || (m[0]?.length ?? 0) !== w)) throw err('#VALUE!', 'SUMPRODUCT has mismatched range sizes.');
    let total = 0;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      let p = 1;
      for (const m of ms) { const v = m[r][c]; if (isErr(v)) throw v; p *= typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : 0; }
      total += p;
    }
    return total;
  },
});
def('ABS', { cat: 'Math', syntax: 'ABS(value)', desc: 'Absolute value', min: 1, max: 1, run: scalarFn(([x]) => Math.abs(sn(x))) });
def('SIGN', { cat: 'Math', syntax: 'SIGN(value)', desc: '-1, 0 or 1', min: 1, max: 1, run: scalarFn(([x]) => Math.sign(sn(x))) });
def('INT', { cat: 'Math', syntax: 'INT(value)', desc: 'Rounds down to an integer', min: 1, max: 1, run: scalarFn(([x]) => Math.floor(sn(x))) });
def('TRUNC', { cat: 'Math', syntax: 'TRUNC(value, [places])', desc: 'Cuts off decimals', min: 1, max: 2, run: scalarFn((xs) => { const p = 10 ** Math.trunc(opt(xs, 1, 0)); return Math.trunc(sn(xs[0]) * p) / p; }) });
const roundHalfAway = (v: number, places: number): number => { const p = 10 ** places; const x = Math.abs(v) * p; const r = Math.round(Number(x.toPrecision(15))); return (Math.sign(v) * r) / p; };
def('ROUND', { cat: 'Math', syntax: 'ROUND(value, [places])', desc: 'Rounds half away from zero', min: 1, max: 2, run: scalarFn((xs) => roundHalfAway(sn(xs[0]), Math.trunc(opt(xs, 1, 0)))) });
def('ROUNDUP', { cat: 'Math', syntax: 'ROUNDUP(value, [places])', desc: 'Rounds away from zero', min: 1, max: 2, run: scalarFn((xs) => { const p = 10 ** Math.trunc(opt(xs, 1, 0)); const v = sn(xs[0]); return (Math.sign(v) * Math.ceil(Number((Math.abs(v) * p).toPrecision(15)))) / p; }) });
def('ROUNDDOWN', { cat: 'Math', syntax: 'ROUNDDOWN(value, [places])', desc: 'Rounds toward zero', min: 1, max: 2, run: scalarFn((xs) => { const p = 10 ** Math.trunc(opt(xs, 1, 0)); const v = sn(xs[0]); return (Math.sign(v) * Math.floor(Number((Math.abs(v) * p).toPrecision(15)))) / p; }) });
def('MROUND', { cat: 'Math', syntax: 'MROUND(value, factor)', desc: 'Rounds to the nearest multiple', min: 2, max: 2, run: scalarFn(([x, f]) => { const v = sn(x), m = sn(f); if (m === 0) return 0; if (Math.sign(v) * Math.sign(m) < 0) throw err('#NUM!'); return roundHalfAway(v / m, 0) * m; }) });
def('CEILING', { cat: 'Math', syntax: 'CEILING(value, [factor])', desc: 'Rounds up to a multiple', min: 1, max: 2, run: scalarFn((xs) => { const f = opt(xs, 1, 1); if (f === 0) return 0; return Math.ceil(Number((sn(xs[0]) / f).toPrecision(15))) * f; }) });
def('FLOOR', { cat: 'Math', syntax: 'FLOOR(value, [factor])', desc: 'Rounds down to a multiple', min: 1, max: 2, run: scalarFn((xs) => { const f = opt(xs, 1, 1); if (f === 0) throw err('#DIV/0!'); return Math.floor(Number((sn(xs[0]) / f).toPrecision(15))) * f; }) });
def('MOD', { cat: 'Math', syntax: 'MOD(dividend, divisor)', desc: 'Remainder with the sign of the divisor', min: 2, max: 2, run: scalarFn(([a, b]) => { const x = sn(a), y = sn(b); if (y === 0) throw err('#DIV/0!', 'Function MOD parameter 2 cannot be zero.'); return x - y * Math.floor(x / y); }) });
def('QUOTIENT', { cat: 'Math', syntax: 'QUOTIENT(dividend, divisor)', desc: 'Integer part of a division', min: 2, max: 2, run: scalarFn(([a, b]) => { const y = sn(b); if (y === 0) throw err('#DIV/0!'); return Math.trunc(sn(a) / y); }) });
def('POWER', { cat: 'Math', syntax: 'POWER(base, exponent)', desc: 'base^exponent', min: 2, max: 2, run: scalarFn(([a, b]) => fin(Math.pow(sn(a), sn(b)))) });
def('SQRT', { cat: 'Math', syntax: 'SQRT(value)', desc: 'Square root', min: 1, max: 1, run: scalarFn(([x]) => { const v = sn(x); if (v < 0) throw err('#NUM!', 'SQRT of a negative number'); return Math.sqrt(v); }) });
def('EXP', { cat: 'Math', syntax: 'EXP(value)', desc: 'e^value', min: 1, max: 1, run: scalarFn(([x]) => fin(Math.exp(sn(x)))) });
def('LN', { cat: 'Math', syntax: 'LN(value)', desc: 'Natural logarithm', min: 1, max: 1, run: scalarFn(([x]) => { const v = sn(x); if (v <= 0) throw err('#NUM!'); return Math.log(v); }) });
def('LOG', { cat: 'Math', syntax: 'LOG(value, [base])', desc: 'Logarithm (base 10 by default)', min: 1, max: 2, run: scalarFn((xs) => { const v = sn(xs[0]), b = opt(xs, 1, 10); if (v <= 0 || b <= 0 || b === 1) throw err('#NUM!'); return Math.log(v) / Math.log(b); }) });
def('LOG10', { cat: 'Math', syntax: 'LOG10(value)', desc: 'Base-10 logarithm', min: 1, max: 1, run: scalarFn(([x]) => { const v = sn(x); if (v <= 0) throw err('#NUM!'); return Math.log10(v); }) });
def('PI', { cat: 'Math', syntax: 'PI()', desc: '3.14159…', min: 0, max: 0, run: () => Math.PI });
for (const [name, f] of [['SIN', Math.sin], ['COS', Math.cos], ['TAN', Math.tan], ['ASIN', Math.asin], ['ACOS', Math.acos], ['ATAN', Math.atan]] as const) {
  def(name, { cat: 'Math', syntax: `${name}(value)`, desc: `${name.toLowerCase()} of an angle in radians`, min: 1, max: 1, run: scalarFn(([x]) => fin(f(sn(x)))) });
}
def('ATAN2', { cat: 'Math', syntax: 'ATAN2(x, y)', desc: 'Angle of the point (x, y)', min: 2, max: 2, run: scalarFn(([x, y]) => Math.atan2(sn(y), sn(x))) });
def('DEGREES', { cat: 'Math', syntax: 'DEGREES(radians)', desc: 'Radians to degrees', min: 1, max: 1, run: scalarFn(([x]) => (sn(x) * 180) / Math.PI) });
def('RADIANS', { cat: 'Math', syntax: 'RADIANS(degrees)', desc: 'Degrees to radians', min: 1, max: 1, run: scalarFn(([x]) => (sn(x) * Math.PI) / 180) });
const gcd2 = (a: number, b: number): number => (b === 0 ? a : gcd2(b, a % b));
def('GCD', { cat: 'Math', syntax: 'GCD(value1, [value2, …])', desc: 'Greatest common divisor', min: 1, max: Infinity, run: (a, cx) => numbers(a, cx).map((x) => Math.trunc(Math.abs(x))).reduce(gcd2, 0) });
def('LCM', { cat: 'Math', syntax: 'LCM(value1, [value2, …])', desc: 'Least common multiple', min: 1, max: Infinity, run: (a, cx) => numbers(a, cx).map((x) => Math.trunc(Math.abs(x))).reduce((x, y) => (x === 0 || y === 0 ? 0 : (x * y) / gcd2(x, y)), 1) });
const fact = (n: number): number => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
def('FACT', { cat: 'Math', syntax: 'FACT(value)', desc: 'Factorial', min: 1, max: 1, run: scalarFn(([x]) => { const n = Math.trunc(sn(x)); if (n < 0 || n > 170) throw err('#NUM!'); return fact(n); }) });
def('COMBIN', { cat: 'Math', syntax: 'COMBIN(n, k)', desc: 'Number of combinations', min: 2, max: 2, run: scalarFn(([a, b]) => { const n = Math.trunc(sn(a)), k = Math.trunc(sn(b)); if (k < 0 || n < k) throw err('#NUM!'); let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }) });
def('RAND', { cat: 'Math', syntax: 'RAND()', desc: 'Random number in [0, 1) — recalculated on every change', min: 0, max: 0, run: (_a, cx) => cx.host.random() });
def('RANDBETWEEN', { cat: 'Math', syntax: 'RANDBETWEEN(low, high)', desc: 'Random integer between two numbers', min: 2, max: 2, run: (a, cx) => { const lo = Math.ceil(N(a[0], cx)), hi = Math.floor(N(a[1], cx)); if (hi < lo) throw err('#NUM!'); return lo + Math.floor(cx.host.random() * (hi - lo + 1)); } });
def('RANDARRAY', { cat: 'Array', syntax: 'RANDARRAY([rows], [columns])', desc: 'Array of random numbers', min: 0, max: 2, run: (a, cx) => { const h = a[0] === undefined ? 1 : int(a[0], cx), w = a[1] === undefined ? 1 : int(a[1], cx); return Array.from({ length: h }, () => Array.from({ length: w }, () => cx.host.random())); } });
const SUBTOTAL_FN: Record<number, string> = { 1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT', 7: 'STDEV', 8: 'STDEVP', 9: 'SUM', 10: 'VAR', 11: 'VARP' };
def('SUBTOTAL', { cat: 'Math', syntax: 'SUBTOTAL(function_code, range1, [range2, …])', desc: '1 AVERAGE, 2 COUNT, 3 COUNTA, 4 MAX, 5 MIN, 6 PRODUCT, 7 STDEV, 8 STDEVP, 9 SUM, 10 VAR, 11 VARP (101–111 alike)', min: 2, max: Infinity, run: (a, cx) => { const code = int(a[0], cx) % 100; const f = SUBTOTAL_FN[code]; if (!f) throw err('#VALUE!'); return FUNCTIONS[f].run!(a.slice(1), cx); } });

/* ---------------- Statistical ---------------- */

def('AVERAGE', { cat: 'Statistical', syntax: 'AVERAGE(value1, [value2, …])', desc: 'Arithmetic mean (skips text and blanks)', min: 1, max: Infinity, run: (a, cx) => { const xs = numbers(a, cx); if (!xs.length) throw err('#DIV/0!', 'Evaluation of function AVERAGE caused a divide by zero error.'); return mean(xs); } });
def('AVERAGEIF', { cat: 'Statistical', syntax: 'AVERAGEIF(range, criterion, [average_range])', desc: 'Average where the range meets a condition', min: 2, max: 3, run: (a, cx) => { const xs = numsOnly(ifsValues(a[2] ?? a[0], [a[0], a[1]], cx)); if (!xs.length) throw err('#DIV/0!'); return mean(xs); } });
def('AVERAGEIFS', { cat: 'Statistical', syntax: 'AVERAGEIFS(average_range, range1, criterion1, …)', desc: 'Average where every condition holds', min: 3, max: Infinity, run: (a, cx) => { const xs = numsOnly(ifsValues(a[0], a.slice(1), cx)); if (!xs.length) throw err('#DIV/0!'); return mean(xs); } });
def('MIN', { cat: 'Statistical', syntax: 'MIN(value1, [value2, …])', desc: 'Smallest number (0 if none)', min: 1, max: Infinity, run: (a, cx) => { const xs = numbers(a, cx); return xs.length ? Math.min(...xs) : 0; } });
def('MAX', { cat: 'Statistical', syntax: 'MAX(value1, [value2, …])', desc: 'Largest number (0 if none)', min: 1, max: Infinity, run: (a, cx) => { const xs = numbers(a, cx); return xs.length ? Math.max(...xs) : 0; } });
def('MINIFS', { cat: 'Statistical', syntax: 'MINIFS(range, criteria_range1, criterion1, …)', desc: 'Smallest value where every condition holds', min: 3, max: Infinity, run: (a, cx) => { const xs = numsOnly(ifsValues(a[0], a.slice(1), cx)); return xs.length ? Math.min(...xs) : 0; } });
def('MAXIFS', { cat: 'Statistical', syntax: 'MAXIFS(range, criteria_range1, criterion1, …)', desc: 'Largest value where every condition holds', min: 3, max: Infinity, run: (a, cx) => { const xs = numsOnly(ifsValues(a[0], a.slice(1), cx)); return xs.length ? Math.max(...xs) : 0; } });
def('COUNT', { cat: 'Statistical', syntax: 'COUNT(value1, [value2, …])', desc: 'How many numbers', min: 1, max: Infinity, run: (a, cx) => { let n = 0; for (const { v, direct } of walk(a, cx)) if (typeof v === 'number' || (direct && v !== null && !isErr(v) && typeof toNum(v) === 'number')) n++; return n; } });
def('COUNTA', { cat: 'Statistical', syntax: 'COUNTA(value1, [value2, …])', desc: 'How many non-empty values', min: 1, max: Infinity, run: (a, cx) => { let n = 0; for (const { v, direct } of walk(a, cx)) if (v !== null || direct) n++; return n; } });
def('COUNTBLANK', { cat: 'Statistical', syntax: 'COUNTBLANK(range)', desc: 'How many empty cells', min: 1, max: 1, run: (a, cx) => { let n = 0; for (const { v } of walk(a, cx)) if (v === null || v === '') n++; return n; } });
def('COUNTIF', { cat: 'Statistical', syntax: 'COUNTIF(range, criterion)', desc: 'Count cells meeting a condition, e.g. ">=5", "<>done", "a*"', min: 2, max: 2, run: (a, cx) => maskOf(a, cx).mask.filter(Boolean).length });
def('COUNTIFS', { cat: 'Statistical', syntax: 'COUNTIFS(range1, criterion1, [range2, criterion2, …])', desc: 'Count rows meeting every condition', min: 2, max: Infinity, run: (a, cx) => { if (a.length % 2) throw err('#N/A', 'COUNTIFS needs pairs of range and criterion'); return maskOf(a, cx).mask.filter(Boolean).length; } });
def('COUNTUNIQUE', { cat: 'Statistical', syntax: 'COUNTUNIQUE(value1, [value2, …])', desc: 'How many different values', min: 1, max: Infinity, run: (a, cx) => { const set = new Set<string>(); for (const { v } of walk(a, cx)) if (v !== null && v !== '') set.add(typeof v === 'string' ? 's' + v.toLowerCase() : typeof v + displayScalar(v as Scalar)); return set.size; } });
def('MEDIAN', { cat: 'Statistical', syntax: 'MEDIAN(value1, [value2, …])', desc: 'Middle value', min: 1, max: Infinity, run: (a, cx) => { const xs = numbers(a, cx).sort((x, y) => x - y); if (!xs.length) throw err('#NUM!'); const m = xs.length >> 1; return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; } });
def('MODE', { cat: 'Statistical', syntax: 'MODE(value1, [value2, …])', desc: 'Most frequent number', min: 1, max: Infinity, run: (a, cx) => { const counts = new Map<number, number>(); let best: number | null = null, bc = 1; for (const x of numbers(a, cx)) { const c = (counts.get(x) ?? 0) + 1; counts.set(x, c); if (c > bc) { bc = c; best = x; } } if (best === null) throw err('#N/A', 'No value repeats'); return best; } });
def('STDEV', { cat: 'Statistical', syntax: 'STDEV(value1, [value2, …])', desc: 'Sample standard deviation', min: 1, max: Infinity, run: (a, cx) => Math.sqrt(variance(numbers(a, cx), true)) });
def('STDEVP', { cat: 'Statistical', syntax: 'STDEVP(value1, [value2, …])', desc: 'Population standard deviation', min: 1, max: Infinity, run: (a, cx) => Math.sqrt(variance(numbers(a, cx), false)) });
def('VAR', { cat: 'Statistical', syntax: 'VAR(value1, [value2, …])', desc: 'Sample variance', min: 1, max: Infinity, run: (a, cx) => variance(numbers(a, cx), true) });
def('VARP', { cat: 'Statistical', syntax: 'VARP(value1, [value2, …])', desc: 'Population variance', min: 1, max: Infinity, run: (a, cx) => variance(numbers(a, cx), false) });
alias('STDEV.S', 'STDEV'); alias('STDEV.P', 'STDEVP'); alias('VAR.S', 'VAR'); alias('VAR.P', 'VARP');
def('LARGE', { cat: 'Statistical', syntax: 'LARGE(data, n)', desc: 'n-th largest value', min: 2, max: 2, run: (a, cx) => { const xs = numbers([a[0]], cx).sort((x, y) => y - x); const k = int(a[1], cx); if (k < 1 || k > xs.length) throw err('#NUM!', `LARGE has no ${k}th value`); return xs[k - 1]; } });
def('SMALL', { cat: 'Statistical', syntax: 'SMALL(data, n)', desc: 'n-th smallest value', min: 2, max: 2, run: (a, cx) => { const xs = numbers([a[0]], cx).sort((x, y) => x - y); const k = int(a[1], cx); if (k < 1 || k > xs.length) throw err('#NUM!', `SMALL has no ${k}th value`); return xs[k - 1]; } });
def('RANK', { cat: 'Statistical', syntax: 'RANK(value, data, [is_ascending])', desc: 'Position of a value in a list (ties share the best rank)', min: 2, max: 3, run: (a, cx) => { const v = N(a[0], cx), xs = numbers([a[1]], cx); const asc = a[2] !== undefined && B(a[2], cx); if (!xs.includes(v)) throw err('#N/A', 'The value is not in the list'); return 1 + xs.filter((x) => (asc ? x < v : x > v)).length; } });
alias('RANK.EQ', 'RANK');
const percentile = (xs: number[], p: number): number => { if (!xs.length || p < 0 || p > 1) throw err('#NUM!'); const s = [...xs].sort((x, y) => x - y); const k = (s.length - 1) * p; const lo = Math.floor(k); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (k - lo); };
def('PERCENTILE', { cat: 'Statistical', syntax: 'PERCENTILE(data, percentile)', desc: 'Value at a percentile (0–1, inclusive)', min: 2, max: 2, run: (a, cx) => percentile(numbers([a[0]], cx), N(a[1], cx)) });
def('QUARTILE', { cat: 'Statistical', syntax: 'QUARTILE(data, quartile)', desc: 'Quartile 0–4', min: 2, max: 2, run: (a, cx) => { const q = int(a[1], cx); if (q < 0 || q > 4) throw err('#NUM!'); return percentile(numbers([a[0]], cx), q / 4); } });
def('CORREL', { cat: 'Statistical', syntax: 'CORREL(data_y, data_x)', desc: 'Pearson correlation', min: 2, max: 2, run: (a, cx) => { const [ys, xs] = pairedNums(a[0], a[1], cx); const my = mean(ys), mx = mean(xs); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; } if (!sxx || !syy) throw err('#DIV/0!'); return sxy / Math.sqrt(sxx * syy); } });
alias('PEARSON', 'CORREL');
def('SLOPE', { cat: 'Statistical', syntax: 'SLOPE(data_y, data_x)', desc: 'Slope of the linear regression line', min: 2, max: 2, run: (a, cx) => linreg(a, cx).slope });
def('INTERCEPT', { cat: 'Statistical', syntax: 'INTERCEPT(data_y, data_x)', desc: 'Intercept of the linear regression line', min: 2, max: 2, run: (a, cx) => linreg(a, cx).intercept });
def('FORECAST', { cat: 'Statistical', syntax: 'FORECAST(x, data_y, data_x)', desc: 'Linear prediction at x', min: 3, max: 3, run: (a, cx) => { const l = linreg([a[1], a[2]], cx); return l.intercept + l.slope * N(a[0], cx); } });
alias('FORECAST.LINEAR', 'FORECAST');
function pairedNums(ya: Value, xa: Value, cx: Cx): [number[], number[]] {
  const y = toMatrix(ya, cx).flat(), x = toMatrix(xa, cx).flat();
  if (y.length !== x.length) throw err('#N/A', 'The ranges have different sizes');
  const ys: number[] = [], xs: number[] = [];
  for (let i = 0; i < y.length; i++) { if (isErr(y[i])) throw y[i]; if (isErr(x[i])) throw x[i]; if (typeof y[i] === 'number' && typeof x[i] === 'number') { ys.push(y[i] as number); xs.push(x[i] as number); } }
  if (xs.length < 2) throw err('#DIV/0!');
  return [ys, xs];
}
function linreg(a: Value[], cx: Cx): { slope: number; intercept: number } {
  const [ys, xs] = pairedNums(a[0], a[1], cx);
  const my = mean(ys), mx = mean(xs);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (!sxx) throw err('#DIV/0!');
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/* ---------------- Logical ---------------- */

def('IF', {
  cat: 'Logical', syntax: 'IF(condition, value_if_true, [value_if_false])', desc: 'Picks a value by a condition', min: 2, max: 3,
  lazy: (n, cx) => {
    const c = settle(ev(n[0], cx), cx);
    if (isMatrix(c)) {
      const t = settle(ev(n[1], cx), cx), f = n[2] ? settle(ev(n[2], cx), cx) : false;
      const at = (v: Scalar | Matrix, r: number, k: number): Scalar => (isMatrix(v) ? v[v.length === 1 ? 0 : r]?.[(v[0]?.length ?? 0) === 1 ? 0 : k] ?? err('#N/A') : v);
      return c.map((row, r) => row.map((x, k) => { const b = toBool(x); return isErr(b) ? b : b ? at(t, r, k) : at(f, r, k); }));
    }
    const b = toBool(c); if (isErr(b)) return b;
    if (b) return ev(n[1], cx);
    return n[2] ? (n[2].t === 'empty' ? 0 : ev(n[2], cx)) : false;
  },
});
def('IFS', {
  cat: 'Logical', syntax: 'IFS(condition1, value1, [condition2, value2, …])', desc: 'First value whose condition is TRUE', min: 2, max: Infinity,
  lazy: (n, cx) => { if (n.length % 2) return err('#N/A', 'IFS needs pairs'); for (let i = 0; i < n.length; i += 2) if (B(ev(n[i], cx), cx)) return ev(n[i + 1], cx); return err('#N/A', 'No match.'); },
});
def('IFERROR', {
  cat: 'Logical', syntax: 'IFERROR(value, [value_if_error])', desc: 'Replaces an error', min: 1, max: 2,
  lazy: (n, cx) => {
    let v: Value;
    try { v = settle(ev(n[0], cx), cx); } catch (e) { if (e instanceof FErr) v = e; else throw e; }
    const alt = (): Value => (n[1] ? settle(ev(n[1], cx), cx) : '');
    if (isMatrix(v)) { const a = alt(); return v.map((row) => row.map((x) => (isErr(x) ? (isMatrix(a) ? a[0][0] : (a as Scalar)) : x))); }
    return isErr(v) ? alt() : v;
  },
});
def('IFNA', {
  cat: 'Logical', syntax: 'IFNA(value, value_if_na)', desc: 'Replaces #N/A only', min: 2, max: 2,
  lazy: (n, cx) => { const v = settle(ev(n[0], cx), cx); return isErr(v) && v.code === '#N/A' ? ev(n[1], cx) : v; },
});
const bools = (a: Value[], cx: Cx): boolean[] => { const out: boolean[] = []; for (const { v, direct } of walk(a, cx)) { if (isErr(v)) throw v; if (v === null || (!direct && typeof v === 'string')) continue; out.push(sb(v)); } if (!out.length) throw err('#VALUE!'); return out; };
def('AND', { cat: 'Logical', syntax: 'AND(expr1, [expr2, …])', desc: 'TRUE when all are TRUE', min: 1, max: Infinity, run: (a, cx) => bools(a, cx).every(Boolean) });
def('OR', { cat: 'Logical', syntax: 'OR(expr1, [expr2, …])', desc: 'TRUE when any is TRUE', min: 1, max: Infinity, run: (a, cx) => bools(a, cx).some(Boolean) });
def('XOR', { cat: 'Logical', syntax: 'XOR(expr1, [expr2, …])', desc: 'TRUE when an odd number are TRUE', min: 1, max: Infinity, run: (a, cx) => bools(a, cx).filter(Boolean).length % 2 === 1 });
def('NOT', { cat: 'Logical', syntax: 'NOT(expr)', desc: 'Opposite', min: 1, max: 1, run: scalarFn(([x]) => !sb(x)) });
def('TRUE', { cat: 'Logical', syntax: 'TRUE()', desc: 'TRUE', min: 0, max: 0, run: () => true });
def('FALSE', { cat: 'Logical', syntax: 'FALSE()', desc: 'FALSE', min: 0, max: 0, run: () => false });
def('SWITCH', {
  cat: 'Logical', syntax: 'SWITCH(expression, case1, value1, [case2, value2, …], [default])', desc: 'Value for the first matching case', min: 3, max: Infinity,
  lazy: (n, cx) => { const v = raw(ev(n[0], cx), cx); let i = 1; for (; i + 1 < n.length; i += 2) if (compare(v, raw(ev(n[i], cx), cx)) === 0) return ev(n[i + 1], cx); return i < n.length ? ev(n[i], cx) : err('#N/A', 'No match.'); },
});
def('CHOOSE', { cat: 'Lookup', syntax: 'CHOOSE(index, choice1, [choice2, …])', desc: 'Picks the n-th choice', min: 2, max: Infinity, lazy: (n, cx) => { const i = int(ev(n[0], cx), cx); if (i < 1 || i >= n.length) return err('#NUM!', `CHOOSE has no choice ${i}`); return ev(n[i], cx); } });

/* ---------------- Info ---------------- */

const isFn = (name: string, desc: string, test: (v: Scalar) => boolean) => def(name, { cat: 'Info', syntax: `${name}(value)`, desc, min: 1, max: 1, run: (a, cx) => { const v = settle(a[0], cx); return isMatrix(v) ? v.map((r) => r.map(test)) : test(v); } });
isFn('ISBLANK', 'TRUE if the cell is empty', (v) => v === null);
isFn('ISNUMBER', 'TRUE for a number', (v) => typeof v === 'number');
isFn('ISTEXT', 'TRUE for text', (v) => typeof v === 'string');
isFn('ISNONTEXT', 'TRUE for anything but text', (v) => typeof v !== 'string');
isFn('ISLOGICAL', 'TRUE for TRUE/FALSE', (v) => typeof v === 'boolean');
isFn('ISERROR', 'TRUE for any error', (v) => isErr(v));
isFn('ISERR', 'TRUE for any error except #N/A', (v) => isErr(v) && v.code !== '#N/A');
isFn('ISNA', 'TRUE for #N/A', (v) => isErr(v) && v.code === '#N/A');
def('ISEVEN', { cat: 'Info', syntax: 'ISEVEN(value)', desc: 'TRUE for an even number', min: 1, max: 1, run: scalarFn(([x]) => Math.trunc(sn(x)) % 2 === 0) });
def('ISODD', { cat: 'Info', syntax: 'ISODD(value)', desc: 'TRUE for an odd number', min: 1, max: 1, run: scalarFn(([x]) => Math.abs(Math.trunc(sn(x)) % 2) === 1) });
def('ISFORMULA', { cat: 'Info', syntax: 'ISFORMULA(cell)', desc: 'TRUE if the cell holds a formula', min: 1, max: 1, run: (a, cx) => { const r = a[0]; if (!isRef(r)) throw err('#N/A'); return !!cx.host.formula?.(r.sheet, r.r1, r.c1); } });
def('FORMULATEXT', { cat: 'Info', syntax: 'FORMULATEXT(cell)', desc: 'The formula of a cell as text', min: 1, max: 1, run: (a, cx) => { const r = a[0]; if (!isRef(r)) throw err('#N/A'); const f = cx.host.formula?.(r.sheet, r.r1, r.c1); if (!f) throw err('#N/A', 'The cell has no formula'); return f; } });
def('NA', { cat: 'Info', syntax: 'NA()', desc: 'The #N/A error', min: 0, max: 0, run: () => err('#N/A') });
def('ERROR.TYPE', { cat: 'Info', syntax: 'ERROR.TYPE(value)', desc: 'Number of an error (1 #NULL! … 8 #N/A)', min: 1, max: 1, run: (a, cx) => { const v = toScalar(a[0], cx); if (!isErr(v)) throw err('#N/A'); const i = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#ERROR!'].indexOf(v.code); return i < 0 ? 8 : i + 1; } });
def('N', { cat: 'Info', syntax: 'N(value)', desc: 'Number, or 0 for text', min: 1, max: 1, run: scalarFn(([x]) => (typeof x === 'number' ? x : typeof x === 'boolean' ? Number(x) : isErr(x) ? (() => { throw x; })() : 0)) });
def('T', { cat: 'Info', syntax: 'T(value)', desc: 'Text, or "" for anything else', min: 1, max: 1, run: scalarFn(([x]) => (typeof x === 'string' ? x : isErr(x) ? (() => { throw x; })() : '')) });
def('TYPE', { cat: 'Info', syntax: 'TYPE(value)', desc: '1 number, 2 text, 4 boolean, 16 error, 64 array', min: 1, max: 1, run: (a, cx) => { const v = settle(a[0], cx); return isMatrix(v) ? 64 : typeof v === 'number' || v === null ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 4 : 16; } });

/* ---------------- Lookup ---------------- */

function exactMatch(key: Scalar, v: Scalar, wild: boolean): boolean {
  if (typeof key === 'string' && wild && /[*?]/.test(key)) return typeof v === 'string' && wildcard(key).test(v);
  if (key === null) return v === null || v === '';
  return v !== null && compare(key, v) === 0 && typeof key === typeof v;
}
/** Index of the last item ≤ key in a sorted list (ascending), or -1. */
function approx(list: Scalar[], key: Scalar, desc = false): number {
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v === null || isErr(v) || typeof v !== typeof key) continue;
    const c = compare(v, key);
    if (desc ? c >= 0 : c <= 0) best = i; else break;
  }
  return best;
}
function vector(v: Value, cx: Cx): Scalar[] { const m = toMatrix(v, cx); return m.length === 1 ? m[0] : m.map((r) => r[0]); }

def('VLOOKUP', {
  cat: 'Lookup', syntax: 'VLOOKUP(search_key, range, index, [is_sorted])', desc: 'Looks down the first column and returns a value from column index. Use FALSE for an exact match (TRUE, the default, expects the first column sorted).', min: 3, max: 4,
  run: (a, cx) => {
    const key = raw(a[0], cx), m = toMatrix(a[1], cx), idx = int(a[2], cx);
    const sorted = a[3] === undefined || a[3] === null ? true : B(a[3], cx);
    if (idx < 1 || idx > (m[0]?.length ?? 0)) throw err('#VALUE!', `VLOOKUP evaluates to an out of bounds range (index ${idx}).`);
    const col = m.map((r) => r[0]);
    const i = sorted ? approx(col, key) : col.findIndex((v) => exactMatch(key, v, true));
    if (i < 0) throw err('#N/A', `Did not find value '${displayScalar(key)}' in VLOOKUP evaluation.`);
    return m[i][idx - 1];
  },
});
def('HLOOKUP', {
  cat: 'Lookup', syntax: 'HLOOKUP(search_key, range, index, [is_sorted])', desc: 'Looks across the first row and returns a value from row index', min: 3, max: 4,
  run: (a, cx) => {
    const key = raw(a[0], cx), m = toMatrix(a[1], cx), idx = int(a[2], cx);
    const sorted = a[3] === undefined || a[3] === null ? true : B(a[3], cx);
    if (idx < 1 || idx > m.length) throw err('#VALUE!', `HLOOKUP evaluates to an out of bounds range (index ${idx}).`);
    const row = m[0] ?? [];
    const i = sorted ? approx(row, key) : row.findIndex((v) => exactMatch(key, v, true));
    if (i < 0) throw err('#N/A', `Did not find value '${displayScalar(key)}' in HLOOKUP evaluation.`);
    return m[idx - 1][i];
  },
});
def('MATCH', {
  cat: 'Lookup', syntax: 'MATCH(search_key, range, [search_type])', desc: 'Position of a value: 1 = largest ≤ (sorted, default), 0 = exact, -1 = smallest ≥ (sorted descending)', min: 2, max: 3,
  run: (a, cx) => {
    const key = raw(a[0], cx), list = vector(a[1], cx), type = a[2] === undefined ? 1 : int(a[2], cx);
    const i = type === 0 ? list.findIndex((v) => exactMatch(key, v, true)) : approx(list, key, type < 0);
    if (i < 0) throw err('#N/A', `Did not find value '${displayScalar(key)}' in MATCH evaluation.`);
    return i + 1;
  },
});
def('XLOOKUP', {
  cat: 'Lookup', syntax: 'XLOOKUP(search_key, lookup_range, result_range, [missing_value], [match_mode], [search_mode])', desc: 'Finds a key and returns the matching result. match_mode 0 exact, -1 exact or next smaller, 1 exact or next larger, 2 wildcard; search_mode 1 first-to-last, -1 last-to-first', min: 3, max: 6,
  run: (a, cx) => {
    const key = raw(a[0], cx), list = vector(a[1], cx), res = toMatrix(a[2], cx);
    const mode = a[4] === undefined || a[4] === null ? 0 : int(a[4], cx), search = a[5] === undefined || a[5] === null ? 1 : int(a[5], cx);
    const lm = toMatrix(a[1], cx), vertical = lm.length > 1 || (lm[0]?.length ?? 0) === 1;
    const order = list.map((_, i) => i);
    if (search < 0) order.reverse();
    let found = -1;
    for (const i of order) if (exactMatch(key, list[i], mode === 2)) { found = i; break; }
    if (found < 0 && (mode === -1 || mode === 1)) {
      let bestV: Scalar = null;
      for (const i of order) {
        const v = list[i];
        if (v === null || isErr(v) || typeof v !== typeof key) continue;
        const c = compare(v, key);
        if ((mode === -1 && c < 0 && (found < 0 || compare(v, bestV) > 0)) || (mode === 1 && c > 0 && (found < 0 || compare(v, bestV) < 0))) { found = i; bestV = v; }
      }
    }
    if (found < 0) { if (a[3] !== undefined && a[3] !== null) return settle(a[3], cx); throw err('#N/A', `Did not find value '${displayScalar(key)}' in XLOOKUP evaluation.`); }
    if (vertical) { const row = res[found]; if (!row) throw err('#VALUE!'); return row.length === 1 ? row[0] : [row]; }
    const col = res.map((r) => r[found]);
    return col.length === 1 ? col[0] : col.map((v) => [v]);
  },
});
def('LOOKUP', { cat: 'Lookup', syntax: 'LOOKUP(search_key, search_range, [result_range])', desc: 'Approximate lookup in a sorted range', min: 2, max: 3, run: (a, cx) => { const key = raw(a[0], cx), list = vector(a[1], cx); const i = approx(list, key); if (i < 0) throw err('#N/A'); const res = a[2] ? vector(a[2], cx) : list; return res[i] ?? err('#N/A'); } });
def('INDEX', {
  cat: 'Lookup', syntax: 'INDEX(reference, [row], [column])', desc: 'The cell at a row and column of a range (0 = the whole column / row)', min: 1, max: 3,
  run: (a, cx) => {
    const ref = a[0];
    const row = a[1] === undefined || a[1] === null ? 0 : int(a[1], cx), col = a[2] === undefined || a[2] === null ? 0 : int(a[2], cx);
    if (isRef(ref)) {
      const h = ref.r2 - ref.r1 + 1, w = ref.c2 - ref.c1 + 1;
      let r = row, c = col;
      if (h === 1 && a[2] === undefined && row > 0) { c = row; r = 1; }
      if (r < 0 || c < 0 || r > h || c > w) throw err('#REF!', 'INDEX is out of range');
      return { kind: 'ref', sheet: ref.sheet, r1: r ? ref.r1 + r - 1 : ref.r1, r2: r ? ref.r1 + r - 1 : ref.r2, c1: c ? ref.c1 + c - 1 : ref.c1, c2: c ? ref.c1 + c - 1 : ref.c2 };
    }
    const m = toMatrix(ref, cx);
    let r = row, c = col;
    if (m.length === 1 && a[2] === undefined && row > 0) { c = row; r = 1; }
    if (r > m.length || c > (m[0]?.length ?? 0) || r < 0 || c < 0) throw err('#REF!', 'INDEX is out of range');
    if (r && c) return m[r - 1][c - 1];
    if (r) return [m[r - 1]];
    if (c) return m.map((x) => [x[c - 1]]);
    return m;
  },
});
def('ROW', { cat: 'Lookup', syntax: 'ROW([cell])', desc: 'Row number', min: 0, max: 1, run: (a, cx) => { const r = a[0]; if (r === undefined) return cx.r + 1; if (!isRef(r)) throw err('#VALUE!'); return r.r1 === r.r2 ? r.r1 + 1 : Array.from({ length: r.r2 - r.r1 + 1 }, (_, i) => [r.r1 + i + 1]); } });
def('COLUMN', { cat: 'Lookup', syntax: 'COLUMN([cell])', desc: 'Column number', min: 0, max: 1, run: (a, cx) => { const r = a[0]; if (r === undefined) return cx.c + 1; if (!isRef(r)) throw err('#VALUE!'); return r.c1 === r.c2 ? r.c1 + 1 : [Array.from({ length: r.c2 - r.c1 + 1 }, (_, i) => r.c1 + i + 1)]; } });
def('ROWS', { cat: 'Lookup', syntax: 'ROWS(range)', desc: 'Number of rows', min: 1, max: 1, run: (a, cx) => (isRef(a[0]) ? a[0].r2 - a[0].r1 + 1 : toMatrix(a[0], cx).length) });
def('COLUMNS', { cat: 'Lookup', syntax: 'COLUMNS(range)', desc: 'Number of columns', min: 1, max: 1, run: (a, cx) => (isRef(a[0]) ? a[0].c2 - a[0].c1 + 1 : toMatrix(a[0], cx)[0]?.length ?? 0) });
def('ADDRESS', { cat: 'Lookup', syntax: 'ADDRESS(row, column, [absolute], [use_a1], [sheet])', desc: 'Cell address as text (absolute: 1 $A$1, 2 A$1, 3 $A1, 4 A1)', min: 2, max: 5, run: (a, cx) => { const r = int(a[0], cx), c = int(a[1], cx), abs = a[2] === undefined ? 1 : int(a[2], cx); if (r < 1 || c < 1) throw err('#VALUE!'); const text = `${abs === 1 || abs === 3 ? '$' : ''}${colName(c - 1)}${abs === 1 || abs === 2 ? '$' : ''}${r}`; return a[4] !== undefined ? `${quoteSheet(Sx(a[4], cx))}!${text}` : text; } });
def('OFFSET', {
  cat: 'Lookup', syntax: 'OFFSET(reference, rows, columns, [height], [width])', desc: 'A range moved from a starting reference', min: 3, max: 5,
  run: (a, cx) => {
    const ref = a[0];
    if (!isRef(ref)) throw err('#VALUE!', 'OFFSET needs a reference');
    const dr = int(a[1], cx), dc = int(a[2], cx);
    const h = a[3] === undefined || a[3] === null ? ref.r2 - ref.r1 + 1 : int(a[3], cx), w = a[4] === undefined || a[4] === null ? ref.c2 - ref.c1 + 1 : int(a[4], cx);
    const r1 = ref.r1 + dr, c1 = ref.c1 + dc;
    if (r1 < 0 || c1 < 0 || h < 1 || w < 1) throw err('#REF!', 'OFFSET evaluates to an out of bounds range.');
    return { kind: 'ref', sheet: ref.sheet, r1, c1, r2: r1 + h - 1, c2: c1 + w - 1 };
  },
});
def('INDIRECT', {
  cat: 'Lookup', syntax: 'INDIRECT(cell_reference_as_string)', desc: 'A reference from text such as "B3" or "Sheet2!A1:A9"', min: 1, max: 2,
  run: (a, cx) => {
    const text = Sx(a[0], cx);
    const toks = tokenize(text).filter((t) => t.type !== 'ws');
    if (toks.length === 1 && toks[0].type === 'ref') return ev({ t: 'ref', ref: toks[0].ref! }, cx);
    if (toks.length === 1 && toks[0].type === 'name') { const r = cx.host.name(toks[0].text); if (r) return r; }
    throw err('#REF!', `Function INDIRECT parameter 1 value is '${text}'. It is not a valid cell/range reference.`);
  },
});
def('HYPERLINK', { cat: 'Lookup', syntax: 'HYPERLINK(url, [link_label])', desc: 'Shows a label for a link (the cell shows the label)', min: 1, max: 2, run: scalarFn((xs) => (xs[1] !== undefined && xs[1] !== null ? xs[1] : ss(xs[0]))) });

/* ---------------- Array ---------------- */

def('ARRAYFORMULA', { cat: 'Array', syntax: 'ARRAYFORMULA(array_formula)', desc: 'Accepted for compatibility: formulas already work on whole ranges', min: 1, max: 1, run: (a, cx) => settle(a[0], cx) });
def('TRANSPOSE', { cat: 'Array', syntax: 'TRANSPOSE(range)', desc: 'Swaps rows and columns', min: 1, max: 1, run: (a, cx) => { const m = toMatrix(a[0], cx); return (m[0] ?? []).map((_, c) => m.map((r) => r[c])); } });
def('FLATTEN', { cat: 'Array', syntax: 'FLATTEN(range1, [range2, …])', desc: 'All values in one column', min: 1, max: Infinity, run: (a, cx) => { const out: Matrix = []; for (const { v } of walk(a, cx)) out.push([v]); return out.length ? out : err('#N/A'); } });
def('SEQUENCE', {
  cat: 'Array', syntax: 'SEQUENCE(rows, [columns], [start], [step])', desc: 'A grid of numbers counting up', min: 1, max: 4,
  run: (a, cx) => {
    const h = int(a[0], cx), w = a[1] === undefined || a[1] === null ? 1 : int(a[1], cx);
    const start = a[2] === undefined || a[2] === null ? 1 : N(a[2], cx), step = a[3] === undefined || a[3] === null ? 1 : N(a[3], cx);
    if (h < 1 || w < 1) throw err('#VALUE!', 'SEQUENCE needs at least one row and column');
    if (h * w > 1_000_000) throw err('#NUM!', 'SEQUENCE is too large');
    return Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => start + (r * w + c) * step));
  },
});
const rowKey = (row: Scalar[]): string => row.map((v) => (typeof v === 'string' ? 's' + v.toLowerCase() : isErr(v) ? 'e' + v.code : typeof v + String(v))).join('\u0001');
def('UNIQUE', {
  cat: 'Array', syntax: 'UNIQUE(range, [by_column], [exactly_once])', desc: 'Rows (or columns) without duplicates, in order of first appearance', min: 1, max: 3,
  run: (a, cx) => {
    let m = toMatrix(a[0], cx);
    const byCol = a[1] !== undefined && a[1] !== null && B(a[1], cx), once = a[2] !== undefined && a[2] !== null && B(a[2], cx);
    if (byCol) m = (m[0] ?? []).map((_, c) => m.map((r) => r[c]));
    const counts = new Map<string, number>();
    for (const r of m) counts.set(rowKey(r), (counts.get(rowKey(r)) ?? 0) + 1);
    const seen = new Set<string>();
    let out = m.filter((r) => { const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return !once || counts.get(k) === 1; });
    out = out.filter((r) => r.some((v) => v !== null));
    if (!out.length) throw err('#N/A', 'No unique values');
    return byCol ? (out[0] ?? []).map((_, c) => out.map((r) => r[c])) : out;
  },
});
def('SORT', {
  cat: 'Array', syntax: 'SORT(range, [sort_column], [is_ascending], [sort_column2, is_ascending2, …])', desc: 'Sorted copy of rows; sort_column is an index in the range (default 1)', min: 1, max: Infinity,
  run: (a, cx) => {
    const m = toMatrix(a[0], cx).filter((r) => r.some((v) => v !== null));
    const keys: { col: Scalar[]; asc: boolean }[] = [];
    for (let i = 1; i < a.length; i += 2) {
      const k = a[i];
      const asc = a[i + 1] === undefined || a[i + 1] === null ? true : B(a[i + 1], cx);
      if (isRef(k) || isMatrix(k)) { const col = vector(k, cx); keys.push({ col, asc }); }
      else { const ci = int(k, cx); if (ci < 1 || ci > (m[0]?.length ?? 0)) throw err('#VALUE!', `SORT column ${ci} is outside the range`); keys.push({ col: m.map((r) => r[ci - 1]), asc }); }
    }
    if (!keys.length) keys.push({ col: m.map((r) => r[0]), asc: true });
    const idx = m.map((_, i) => i);
    idx.sort((x, y) => { for (const k of keys) { const vx = k.col[x], vy = k.col[y]; if (vx === null && vy !== null) return 1; if (vy === null && vx !== null) return -1; const c = compare(vx ?? null, vy ?? null); if (c) return k.asc ? c : -c; } return x - y; });
    if (!idx.length) throw err('#N/A');
    return idx.map((i) => m[i]);
  },
});
def('SORTN', {
  cat: 'Array', syntax: 'SORTN(range, [n], [display_ties_mode], [sort_column], [is_ascending], …)', desc: 'First n rows after sorting (ties mode 0 only)', min: 1, max: Infinity,
  run: (a, cx) => { const n = a[1] === undefined || a[1] === null ? 1 : int(a[1], cx); const sorted = FUNCTIONS.SORT.run!([a[0], ...a.slice(3)], cx) as Matrix; return sorted.slice(0, n); },
});
def('FILTER', {
  cat: 'Array', syntax: 'FILTER(range, condition1, [condition2, …])', desc: 'Rows (or columns) where every condition is TRUE', min: 2, max: Infinity,
  run: (a, cx) => {
    const m = toMatrix(a[0], cx);
    const conds = a.slice(1).map((c) => toMatrix(c, cx));
    const vertical = conds[0].length === m.length && (conds[0][0]?.length ?? 0) === 1;
    const n = vertical ? m.length : (m[0]?.length ?? 0);
    for (const c of conds) { const len = vertical ? c.length : (c[0]?.length ?? 0); if (len !== n) throw err('#VALUE!', 'FILTER has mismatched range sizes.'); }
    const keep: number[] = [];
    for (let i = 0; i < n; i++) if (conds.every((c) => { const v = vertical ? c[i][0] : c[0][i]; if (isErr(v)) throw v; return toBool(v) === true; })) keep.push(i);
    if (!keep.length) throw err('#N/A', 'No matches are found in FILTER evaluation.');
    return vertical ? keep.map((i) => m[i]) : m.map((r) => keep.map((i) => r[i]));
  },
});
def('MMULT', { cat: 'Array', syntax: 'MMULT(matrix1, matrix2)', desc: 'Matrix product', min: 2, max: 2, run: (a, cx) => { const A = toMatrix(a[0], cx), Bm = toMatrix(a[1], cx); if ((A[0]?.length ?? 0) !== Bm.length) throw err('#VALUE!'); return A.map((r) => (Bm[0] ?? []).map((_, j) => r.reduce((s: number, v, k) => s + sn(v) * sn(Bm[k][j]), 0))); } });

/* ---------------- Text ---------------- */

def('CONCAT', { cat: 'Text', syntax: 'CONCAT(value1, value2, …)', desc: 'Joins values', min: 1, max: Infinity, run: (a, cx) => { let s = ''; for (const { v } of walk(a, cx)) s += ss(v); return s; } });
alias('CONCATENATE', 'CONCAT');
def('TEXTJOIN', { cat: 'Text', syntax: 'TEXTJOIN(delimiter, ignore_empty, text1, [text2, …])', desc: 'Joins values with a delimiter', min: 3, max: Infinity, run: (a, cx) => { const d = Sx(a[0], cx), skip = B(a[1], cx); const parts: string[] = []; for (const { v } of walk(a.slice(2), cx)) { const s = ss(v); if (!skip || s !== '') parts.push(s); } return parts.join(d); } });
def('JOIN', { cat: 'Text', syntax: 'JOIN(delimiter, value_or_array1, …)', desc: 'Joins values with a delimiter', min: 2, max: Infinity, run: (a, cx) => { const d = Sx(a[0], cx); const parts: string[] = []; for (const { v } of walk(a.slice(1), cx)) parts.push(ss(v)); return parts.join(d); } });
def('LEFT', { cat: 'Text', syntax: 'LEFT(text, [count])', desc: 'First characters', min: 1, max: 2, run: scalarFn((xs) => { const n = opt(xs, 1, 1); if (n < 0) throw err('#VALUE!'); return [...ss(xs[0])].slice(0, n).join(''); }) });
def('RIGHT', { cat: 'Text', syntax: 'RIGHT(text, [count])', desc: 'Last characters', min: 1, max: 2, run: scalarFn((xs) => { const n = opt(xs, 1, 1); if (n < 0) throw err('#VALUE!'); const c = [...ss(xs[0])]; return n === 0 ? '' : c.slice(-n).join(''); }) });
def('MID', { cat: 'Text', syntax: 'MID(text, start, length)', desc: 'Characters from the middle', min: 3, max: 3, run: scalarFn(([t, s, l]) => { const st = Math.trunc(sn(s)), n = Math.trunc(sn(l)); if (st < 1 || n < 0) throw err('#VALUE!'); return [...ss(t)].slice(st - 1, st - 1 + n).join(''); }) });
def('LEN', { cat: 'Text', syntax: 'LEN(text)', desc: 'Number of characters', min: 1, max: 1, run: scalarFn(([t]) => [...ss(t)].length) });
def('UPPER', { cat: 'Text', syntax: 'UPPER(text)', desc: 'Capital letters', min: 1, max: 1, run: scalarFn(([t]) => ss(t).toUpperCase()) });
def('LOWER', { cat: 'Text', syntax: 'LOWER(text)', desc: 'Small letters', min: 1, max: 1, run: scalarFn(([t]) => ss(t).toLowerCase()) });
def('PROPER', { cat: 'Text', syntax: 'PROPER(text)', desc: 'Capitalises each word', min: 1, max: 1, run: scalarFn(([t]) => ss(t).toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, p: string, ch: string) => p + ch.toUpperCase())) });
def('TRIM', { cat: 'Text', syntax: 'TRIM(text)', desc: 'Removes leading, trailing and repeated spaces', min: 1, max: 1, run: scalarFn(([t]) => ss(t).replace(/[ \t ]+/g, ' ').trim()) });
def('CLEAN', { cat: 'Text', syntax: 'CLEAN(text)', desc: 'Removes non-printable characters', min: 1, max: 1, run: scalarFn(([t]) => ss(t).replace(/[\x00-\x1f\x7f]/g, '')) });
def('SUBSTITUTE', { cat: 'Text', syntax: 'SUBSTITUTE(text, search_for, replace_with, [occurrence])', desc: 'Replaces text (every occurrence, or only the n-th)', min: 3, max: 4, run: scalarFn((xs) => { const t = ss(xs[0]), f = ss(xs[1]), r = ss(xs[2]); if (!f) return t; if (xs[3] === undefined || xs[3] === null) return t.split(f).join(r); const n = Math.trunc(sn(xs[3])); let i = -1; for (let k = 0; k < n; k++) { i = t.indexOf(f, i + 1); if (i < 0) return t; } return t.slice(0, i) + r + t.slice(i + f.length); }) });
def('REPLACE', { cat: 'Text', syntax: 'REPLACE(text, position, length, new_text)', desc: 'Replaces part of a text by position', min: 4, max: 4, run: scalarFn(([t, p, l, n]) => { const c = [...ss(t)], st = Math.trunc(sn(p)) - 1; if (st < 0) throw err('#VALUE!'); c.splice(st, Math.trunc(sn(l)), ss(n)); return c.join(''); }) });
def('REPT', { cat: 'Text', syntax: 'REPT(text, times)', desc: 'Repeats text', min: 2, max: 2, run: scalarFn(([t, n]) => { const k = Math.trunc(sn(n)); if (k < 0 || k * ss(t).length > 50000) throw err('#VALUE!'); return ss(t).repeat(k); }) });
def('EXACT', { cat: 'Text', syntax: 'EXACT(text1, text2)', desc: 'Same text, case-sensitive', min: 2, max: 2, run: scalarFn(([x, y]) => ss(x) === ss(y)) });
def('CHAR', { cat: 'Text', syntax: 'CHAR(number)', desc: 'Character for a code', min: 1, max: 1, run: scalarFn(([x]) => String.fromCodePoint(Math.trunc(sn(x)))) });
def('CODE', { cat: 'Text', syntax: 'CODE(text)', desc: 'Code of the first character', min: 1, max: 1, run: scalarFn(([x]) => { const s = ss(x); if (!s) throw err('#VALUE!'); return s.codePointAt(0)!; }) });
alias('UNICHAR', 'CHAR'); alias('UNICODE', 'CODE');
def('FIND', { cat: 'Text', syntax: 'FIND(search_for, text, [start])', desc: 'Position of text, case-sensitive', min: 2, max: 3, run: scalarFn((xs) => { const st = opt(xs, 2, 1); const i = ss(xs[1]).indexOf(ss(xs[0]), st - 1); if (i < 0) throw err('#VALUE!', `FIND did not find '${ss(xs[0])}'`); return i + 1; }) });
def('SEARCH', { cat: 'Text', syntax: 'SEARCH(search_for, text, [start])', desc: 'Position of text, case-insensitive, with * and ? wildcards', min: 2, max: 3, run: scalarFn((xs) => { const st = opt(xs, 2, 1); const pat = ss(xs[0]); const text = ss(xs[1]); const re = new RegExp(wildcard(pat).source.slice(1, -1), 'i'); const m = re.exec(text.slice(st - 1)); if (!m) throw err('#VALUE!', `SEARCH did not find '${pat}'`); return m.index + st; }) });
const regex = (p: string): RegExp => { try { return new RegExp(p); } catch { throw err('#VALUE!', `Invalid regular expression: ${p}`); } };
def('REGEXMATCH', { cat: 'Text', syntax: 'REGEXMATCH(text, regular_expression)', desc: 'TRUE if the text matches', min: 2, max: 2, run: scalarFn(([t, p]) => regex(ss(p)).test(ss(t))) });
def('REGEXEXTRACT', { cat: 'Text', syntax: 'REGEXEXTRACT(text, regular_expression)', desc: 'The first match (or the first group)', min: 2, max: 2, run: scalarFn(([t, p]) => { const m = regex(ss(p)).exec(ss(t)); if (!m) throw err('#N/A', 'REGEXEXTRACT found no match'); return m[1] ?? m[0]; }) });
def('REGEXREPLACE', { cat: 'Text', syntax: 'REGEXREPLACE(text, regular_expression, replacement)', desc: 'Replaces every match ($1 for groups)', min: 3, max: 3, run: scalarFn(([t, p, r]) => ss(t).replace(new RegExp(regex(ss(p)).source, 'g'), ss(r))) });
def('SPLIT', {
  cat: 'Text', syntax: 'SPLIT(text, delimiter, [split_by_each], [remove_empty_text])', desc: 'Splits text into cells across a row', min: 2, max: 4,
  run: (a, cx) => {
    const t = Sx(a[0], cx), d = Sx(a[1], cx);
    const each = a[2] === undefined || a[2] === null ? true : B(a[2], cx), drop = a[3] === undefined || a[3] === null ? true : B(a[3], cx);
    if (!d) throw err('#VALUE!', 'SPLIT needs a delimiter');
    let parts = each ? t.split(new RegExp(`[${d.replace(/[\]\\^-]/g, '\\$&')}]`)) : t.split(d);
    if (drop) parts = parts.filter((p) => p !== '');
    return [parts.map((p) => { const n = textToNumber(p); return n !== null && p.trim() !== '' && /^[-+]?[\d.,]+$/.test(p.trim()) ? n : p; })];
  },
});
def('TEXT', { cat: 'Text', syntax: 'TEXT(number, format)', desc: 'A number as text in a format, e.g. TEXT(A1, "#,##0.00") or TEXT(A1, "yyyy-mm-dd")', min: 2, max: 2, run: scalarFn(([v, f]) => { const x = typeof v === 'string' ? (textToNumber(v) ?? v) : v; return formatValue(x, ss(f)).text; }) });
def('VALUE', { cat: 'Text', syntax: 'VALUE(text)', desc: 'Text that looks like a number, date or time as a number', min: 1, max: 1, run: scalarFn(([v]) => { if (typeof v === 'number') return v; const n = textToNumber(ss(v)); if (n === null) throw err('#VALUE!', `VALUE parameter '${ss(v)}' cannot be parsed to number.`); return n; }) });
def('FIXED', { cat: 'Text', syntax: 'FIXED(number, [decimals], [no_commas])', desc: 'Number rounded as text', min: 1, max: 3, run: scalarFn((xs) => { const d = opt(xs, 1, 2); const plain = xs[2] !== undefined && xs[2] !== null && sb(xs[2]); return formatValue(roundHalfAway(sn(xs[0]), d), `${plain ? '0' : '#,##0'}${d > 0 ? '.' + '0'.repeat(d) : ''}`).text; }) });
def('DOLLAR', { cat: 'Text', syntax: 'DOLLAR(number, [decimals])', desc: 'Number as currency text', min: 1, max: 2, run: scalarFn((xs) => { const d = opt(xs, 1, 2); return formatValue(sn(xs[0]), `$#,##0${d > 0 ? '.' + '0'.repeat(d) : ''}`).text; }) });
def('TO_TEXT', { cat: 'Text', syntax: 'TO_TEXT(value)', desc: 'A value as text', min: 1, max: 1, run: scalarFn(([v]) => ss(v)) });

/* ---------------- Date ---------------- */

const dateOf = (x: Scalar): number => { if (typeof x === 'string') { const d = parseDateText(x.trim()); if (d && typeof d.value === 'number') return d.value; } const n = sn(x); if (n < -693593) throw err('#NUM!'); return n; };
const ymd = (x: Scalar) => partsFromSerial(Math.floor(dateOf(x)));
def('TODAY', { cat: 'Date', syntax: 'TODAY()', desc: "Today's date (recalculated on every change)", min: 0, max: 0, run: (_a, cx) => Math.floor(serialFromLocal(cx.host.now())) });
def('NOW', { cat: 'Date', syntax: 'NOW()', desc: 'Current date and time', min: 0, max: 0, run: (_a, cx) => serialFromLocal(cx.host.now()) });
def('DATE', { cat: 'Date', syntax: 'DATE(year, month, day)', desc: 'A date from its parts (months and days may overflow, e.g. month 13)', min: 3, max: 3, run: scalarFn(([y, m, d]) => { let yy = Math.trunc(sn(y)); if (yy >= 0 && yy < 1900) yy += 1900; const dt = Date.UTC(yy, Math.trunc(sn(m)) - 1, Math.trunc(sn(d))); return Math.round((dt - Date.UTC(1899, 11, 30)) / 86_400_000); }) });
def('TIME', { cat: 'Date', syntax: 'TIME(hour, minute, second)', desc: 'A time of day as a fraction', min: 3, max: 3, run: scalarFn(([h, m, s]) => { const t = (sn(h) * 3600 + sn(m) * 60 + sn(s)) / 86400; return t - Math.floor(t); }) });
def('YEAR', { cat: 'Date', syntax: 'YEAR(date)', desc: 'Year of a date', min: 1, max: 1, run: scalarFn(([x]) => ymd(x).y) });
def('MONTH', { cat: 'Date', syntax: 'MONTH(date)', desc: 'Month 1–12', min: 1, max: 1, run: scalarFn(([x]) => ymd(x).m) });
def('DAY', { cat: 'Date', syntax: 'DAY(date)', desc: 'Day of the month', min: 1, max: 1, run: scalarFn(([x]) => ymd(x).d) });
def('HOUR', { cat: 'Date', syntax: 'HOUR(time)', desc: 'Hour 0–23', min: 1, max: 1, run: scalarFn(([x]) => partsFromSerial(dateOf(x)).hh) });
def('MINUTE', { cat: 'Date', syntax: 'MINUTE(time)', desc: 'Minute 0–59', min: 1, max: 1, run: scalarFn(([x]) => partsFromSerial(dateOf(x)).mi) });
def('SECOND', { cat: 'Date', syntax: 'SECOND(time)', desc: 'Second 0–59', min: 1, max: 1, run: scalarFn(([x]) => partsFromSerial(dateOf(x)).ss) });
def('WEEKDAY', { cat: 'Date', syntax: 'WEEKDAY(date, [type])', desc: 'Day of the week: type 1 Sun=1 (default), 2 Mon=1, 3 Mon=0', min: 1, max: 2, run: scalarFn((xs) => { const wd = ymd(xs[0]).wd, t = opt(xs, 1, 1); if (t === 1) return wd + 1; if (t === 2) return ((wd + 6) % 7) + 1; if (t === 3) return (wd + 6) % 7; throw err('#NUM!'); }) });
def('WEEKNUM', { cat: 'Date', syntax: 'WEEKNUM(date, [type])', desc: 'Week of the year (type 1 weeks start Sunday, 2 Monday)', min: 1, max: 2, run: scalarFn((xs) => { const s = Math.floor(dateOf(xs[0])), p = partsFromSerial(s), t = opt(xs, 1, 1); const jan1 = serialFromParts(p.y, 1, 1); const wd = partsFromSerial(jan1).wd; const off = t === 2 ? (wd + 6) % 7 : wd; return Math.floor((s - jan1 + off) / 7) + 1; }) });
def('ISOWEEKNUM', { cat: 'Date', syntax: 'ISOWEEKNUM(date)', desc: 'ISO 8601 week number', min: 1, max: 1, run: scalarFn(([x]) => { const s = Math.floor(dateOf(x)); const wd = (partsFromSerial(s).wd + 6) % 7; const th = s - wd + 3; const y = partsFromSerial(th).y; return Math.floor((th - serialFromParts(y, 1, 1)) / 7) + 1; }) });
const addMonths = (serial: number, months: number, eom: boolean): number => {
  const p = partsFromSerial(Math.floor(serial));
  const total = p.y * 12 + (p.m - 1) + months, y = Math.floor(total / 12), m = (total % 12) + 1;
  const last = partsFromSerial(serialFromParts(y, m + 1, 1) - 1).d;
  return serialFromParts(y, m, eom ? last : Math.min(p.d, last));
};
def('EDATE', { cat: 'Date', syntax: 'EDATE(start_date, months)', desc: 'Same day n months later', min: 2, max: 2, run: scalarFn(([d, m]) => addMonths(dateOf(d), Math.trunc(sn(m)), false)) });
def('EOMONTH', { cat: 'Date', syntax: 'EOMONTH(start_date, months)', desc: 'Last day of the month n months later', min: 2, max: 2, run: scalarFn(([d, m]) => addMonths(dateOf(d), Math.trunc(sn(m)), true)) });
def('DAYS', { cat: 'Date', syntax: 'DAYS(end_date, start_date)', desc: 'Days between two dates', min: 2, max: 2, run: scalarFn(([e, s]) => Math.floor(dateOf(e)) - Math.floor(dateOf(s))) });
def('DATEDIF', {
  cat: 'Date', syntax: 'DATEDIF(start_date, end_date, unit)', desc: 'Difference in "Y", "M", "D", "MD", "YM" or "YD"', min: 3, max: 3,
  run: scalarFn(([s, e, u]) => {
    const a = Math.floor(dateOf(s)), b = Math.floor(dateOf(e));
    if (b < a) throw err('#NUM!', 'DATEDIF start date is after the end date');
    const pa = partsFromSerial(a), pb = partsFromSerial(b);
    let months = (pb.y - pa.y) * 12 + (pb.m - pa.m); if (pb.d < pa.d) months--;
    switch (ss(u).toUpperCase()) {
      case 'Y': return Math.floor(months / 12);
      case 'M': return months;
      case 'D': return b - a;
      case 'MD': { const d = pb.d - pa.d; return d >= 0 ? d : b - addMonths(a, months, false); }
      case 'YM': return months % 12;
      case 'YD': { let anchor = serialFromParts(pb.y, pa.m, pa.d); if (anchor > b) anchor = serialFromParts(pb.y - 1, pa.m, pa.d); return b - anchor; }
      default: throw err('#NUM!', 'DATEDIF unit must be Y, M, D, MD, YM or YD');
    }
  }),
});
const holidaySet = (v: Value | undefined, cx: Cx): Set<number> => { const s = new Set<number>(); if (v === undefined) return s; for (const { v: x } of walk([v], cx)) if (x !== null) s.add(Math.floor(dateOf(x))); return s; };
const isWork = (d: number, hol: Set<number>) => { const wd = partsFromSerial(d).wd; return wd !== 0 && wd !== 6 && !hol.has(d); };
def('NETWORKDAYS', { cat: 'Date', syntax: 'NETWORKDAYS(start_date, end_date, [holidays])', desc: 'Working days (Mon–Fri) between two dates, inclusive', min: 2, max: 3, run: (a, cx) => { const s = Math.floor(dateOf(raw(a[0], cx))), e = Math.floor(dateOf(raw(a[1], cx))); const hol = holidaySet(a[2], cx); const [lo, hi, sign] = s <= e ? [s, e, 1] : [e, s, -1]; let n = 0; for (let d = lo; d <= hi; d++) if (isWork(d, hol)) n++; return n * sign; } });
def('WORKDAY', { cat: 'Date', syntax: 'WORKDAY(start_date, days, [holidays])', desc: 'Date n working days later', min: 2, max: 3, run: (a, cx) => { let d = Math.floor(dateOf(raw(a[0], cx))); let n = int(a[1], cx); const hol = holidaySet(a[2], cx); const step = n < 0 ? -1 : 1; while (n !== 0) { d += step; if (isWork(d, hol)) n -= step; } return d; } });
def('DATEVALUE', { cat: 'Date', syntax: 'DATEVALUE(date_string)', desc: 'A date written as text as a serial number', min: 1, max: 1, run: scalarFn(([x]) => { const d = parseDateText(ss(x).trim()); if (!d || typeof d.value !== 'number') throw err('#VALUE!', `DATEVALUE parameter '${ss(x)}' cannot be parsed to date/time.`); return Math.floor(d.value); }) });
def('TIMEVALUE', { cat: 'Date', syntax: 'TIMEVALUE(time_string)', desc: 'A time written as text as a fraction of a day', min: 1, max: 1, run: scalarFn(([x]) => { const d = parseDateText(ss(x).trim()); if (!d || typeof d.value !== 'number') throw err('#VALUE!'); return d.value - Math.floor(d.value); }) });
def('YEARFRAC', {
  cat: 'Date', syntax: 'YEARFRAC(start_date, end_date, [day_count_convention])', desc: 'Fraction of a year between dates (0 30/360 US, 1 actual/actual, 2 actual/360, 3 actual/365, 4 30E/360)', min: 2, max: 3,
  run: scalarFn((xs) => {
    let a = Math.floor(dateOf(xs[0])), b = Math.floor(dateOf(xs[1])); if (a > b) [a, b] = [b, a];
    const basis = opt(xs, 2, 0), pa = partsFromSerial(a), pb = partsFromSerial(b);
    const d360 = (eu: boolean) => { let d1 = pa.d, d2 = pb.d; if (eu) { if (d1 === 31) d1 = 30; if (d2 === 31) d2 = 30; } else { if (d1 === 31) d1 = 30; if (d2 === 31 && d1 >= 30) d2 = 30; } return ((pb.y - pa.y) * 360 + (pb.m - pa.m) * 30 + (d2 - d1)) / 360; };
    switch (basis) {
      case 0: return d360(false);
      case 1: { const years = pb.y - pa.y + 1; let days = 0; for (let y = pa.y; y <= pb.y; y++) days += serialFromParts(y + 1, 1, 1) - serialFromParts(y, 1, 1); return (b - a) / (days / years); }
      case 2: return (b - a) / 360;
      case 3: return (b - a) / 365;
      case 4: return d360(true);
      default: throw err('#NUM!');
    }
  }),
});

/* ---------------- Financial ---------------- */

const fvOf = (rate: number, n: number, pmt: number, pv: number, type: number): number => (rate === 0 ? -(pv + pmt * n) : -(pv * (1 + rate) ** n + (pmt * (1 + rate * type) * ((1 + rate) ** n - 1)) / rate));
const pmtOf = (rate: number, n: number, pv: number, fv: number, type: number): number => { if (n === 0) throw err('#NUM!'); if (rate === 0) return -(pv + fv) / n; const f = (1 + rate) ** n; return -(rate * (pv * f + fv)) / ((1 + rate * type) * (f - 1)); };
def('PMT', { cat: 'Financial', syntax: 'PMT(rate, number_of_periods, present_value, [future_value], [end_or_beginning])', desc: 'Payment per period of a loan (negative = money paid out). Use the rate per period, e.g. 6%/12 for monthly.', min: 3, max: 5, run: scalarFn((xs) => pmtOf(sn(xs[0]), sn(xs[1]), sn(xs[2]), opt(xs, 3, 0), opt(xs, 4, 0) ? 1 : 0)) });
def('FV', { cat: 'Financial', syntax: 'FV(rate, number_of_periods, payment_amount, [present_value], [end_or_beginning])', desc: 'Future value of regular payments', min: 3, max: 5, run: scalarFn((xs) => fvOf(sn(xs[0]), sn(xs[1]), sn(xs[2]), opt(xs, 3, 0), opt(xs, 4, 0) ? 1 : 0)) });
def('PV', { cat: 'Financial', syntax: 'PV(rate, number_of_periods, payment_amount, [future_value], [end_or_beginning])', desc: 'Present value of regular payments', min: 3, max: 5, run: scalarFn((xs) => { const r = sn(xs[0]), n = sn(xs[1]), p = sn(xs[2]), f = opt(xs, 3, 0), t = opt(xs, 4, 0) ? 1 : 0; if (r === 0) return -(f + p * n); const g = (1 + r) ** n; return -(f + (p * (1 + r * t) * (g - 1)) / r) / g; }) });
def('NPER', { cat: 'Financial', syntax: 'NPER(rate, payment_amount, present_value, [future_value], [end_or_beginning])', desc: 'Number of periods to pay off', min: 3, max: 5, run: scalarFn((xs) => { const r = sn(xs[0]), p = sn(xs[1]), pv = sn(xs[2]), f = opt(xs, 3, 0), t = opt(xs, 4, 0) ? 1 : 0; if (r === 0) { if (p === 0) throw err('#NUM!'); return -(pv + f) / p; } const num = p * (1 + r * t) - f * r, den = pv * r + p * (1 + r * t); const v = Math.log(num / den) / Math.log(1 + r); return fin(v); }) });
def('NPV', { cat: 'Financial', syntax: 'NPV(discount, cashflow1, [cashflow2, …])', desc: 'Net present value of cash flows at the end of each period (add the period-0 flow separately)', min: 2, max: Infinity, run: (a, cx) => { const r = N(a[0], cx); return numbers(a.slice(1), cx).reduce((s, v, i) => s + v / (1 + r) ** (i + 1), 0); } });
function solve(f: (x: number) => number, guess: number): number {
  let x = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(x), h = 1e-7, d = (f(x + h) - y) / h;
    if (!Number.isFinite(y) || !Number.isFinite(d) || d === 0) break;
    const nx = x - y / d;
    if (Math.abs(nx - x) < 1e-10) return nx;
    x = nx;
  }
  throw err('#NUM!', 'The calculation did not converge — try a different guess');
}
def('IRR', { cat: 'Financial', syntax: 'IRR(cashflow_amounts, [rate_guess])', desc: 'Internal rate of return of periodic cash flows', min: 1, max: 2, run: (a, cx) => { const v = numbers([a[0]], cx); if (!v.some((x) => x > 0) || !v.some((x) => x < 0)) throw err('#NUM!', 'IRR needs both positive and negative cash flows'); return solve((r) => v.reduce((s, x, i) => s + x / (1 + r) ** i, 0), a[1] === undefined ? 0.1 : N(a[1], cx)); } });
def('XNPV', { cat: 'Financial', syntax: 'XNPV(discount, cashflow_amounts, cashflow_dates)', desc: 'NPV of cash flows on specific dates', min: 3, max: 3, run: (a, cx) => { const r = N(a[0], cx), v = numbers([a[1]], cx), d = numbers([a[2]], cx); if (v.length !== d.length) throw err('#NUM!'); return v.reduce((s, x, i) => s + x / (1 + r) ** ((d[i] - d[0]) / 365), 0); } });
def('XIRR', { cat: 'Financial', syntax: 'XIRR(cashflow_amounts, cashflow_dates, [rate_guess])', desc: 'IRR of cash flows on specific dates', min: 2, max: 3, run: (a, cx) => { const v = numbers([a[0]], cx), d = numbers([a[1]], cx); if (v.length !== d.length) throw err('#NUM!'); return solve((r) => v.reduce((s, x, i) => s + x / (1 + r) ** ((d[i] - d[0]) / 365), 0), a[2] === undefined ? 0.1 : N(a[2], cx)); } });
def('RATE', { cat: 'Financial', syntax: 'RATE(number_of_periods, payment_per_period, present_value, [future_value], [end_or_beginning], [rate_guess])', desc: 'Interest rate per period', min: 3, max: 6, run: scalarFn((xs) => { const n = sn(xs[0]), p = sn(xs[1]), pv = sn(xs[2]), f = opt(xs, 3, 0), t = opt(xs, 4, 0) ? 1 : 0; return solve((r) => (Math.abs(r) < 1e-12 ? pv + p * n + f : pv * (1 + r) ** n + (p * (1 + r * t) * ((1 + r) ** n - 1)) / r + f), opt(xs, 5, 0.1)); }) });
const ipmtOf = (r: number, per: number, n: number, pv: number, fv: number, t: number): number => {
  if (per < 1 || per > n) throw err('#NUM!', 'period must be between 1 and the number of periods');
  const p = pmtOf(r, n, pv, fv, t);
  if (t === 1) return per === 1 ? 0 : (fvOf(r, per - 2, p, pv, 1) - p) * r;
  return fvOf(r, per - 1, p, pv, 0) * r;
};
def('IPMT', { cat: 'Financial', syntax: 'IPMT(rate, period, number_of_periods, present_value, [future_value], [end_or_beginning])', desc: 'Interest part of one payment', min: 4, max: 6, run: scalarFn((xs) => ipmtOf(sn(xs[0]), sn(xs[1]), sn(xs[2]), sn(xs[3]), opt(xs, 4, 0), opt(xs, 5, 0) ? 1 : 0)) });
def('PPMT', { cat: 'Financial', syntax: 'PPMT(rate, period, number_of_periods, present_value, [future_value], [end_or_beginning])', desc: 'Principal part of one payment', min: 4, max: 6, run: scalarFn((xs) => { const r = sn(xs[0]), per = sn(xs[1]), n = sn(xs[2]), pv = sn(xs[3]), f = opt(xs, 4, 0), t = opt(xs, 5, 0) ? 1 : 0; return pmtOf(r, n, pv, f, t) - ipmtOf(r, per, n, pv, f, t); }) });
def('SLN', { cat: 'Financial', syntax: 'SLN(cost, salvage, life)', desc: 'Straight-line depreciation per period', min: 3, max: 3, run: scalarFn(([c, s, l]) => { const n = sn(l); if (n === 0) throw err('#DIV/0!'); return (sn(c) - sn(s)) / n; }) });

/* ---------------- metadata for the UI and agents ---------------- */

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
export const FUNCTION_CATS: FnDef['cat'][] = ['Math', 'Statistical', 'Logical', 'Lookup', 'Text', 'Date', 'Financial', 'Array', 'Info'];
export const functionHelp = (name: string): FnDef | undefined => FUNCTIONS[name.toUpperCase()];

/** Evaluates a formula text in a context; the result keeps arrays (for spills and sheet_query). */
export function evaluateFormula(formula: string, cx: Cx): Scalar | Matrix {
  let node: Node;
  try { node = parse(formula); } catch (e) { return err('#ERROR!', `Formula parse error: ${e instanceof Error ? e.message : String(e)}`); }
  const v = evaluate(node, cx);
  try { return settle(v, cx); } catch (e) { if (e instanceof FErr) return e; throw e; }
}

export { ERR_CODES, addr, colIndex, parseAddr, MONTHS, DAYS };
export type { ErrCode };
