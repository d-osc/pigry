/** Formula language for the Sheet menu: A1 references, tokenizer, parser, reference rewriting and the evaluator.
 * Pure TypeScript (no DOM) so node tests and the agent tools compute exactly what the editor shows. */

/* ---------------- A1 helpers ---------------- */

const COL_CACHE: string[] = [];
export function colName(c: number): string {
  if (c < 1024 && COL_CACHE[c]) return COL_CACHE[c];
  let n = c + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  if (c < 1024) COL_CACHE[c] = s;
  return s;
}
export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const addr = (r: number, c: number): string => `${colName(c)}${r + 1}`;
export function parseAddr(a: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a.trim());
  if (!m) return null;
  const r = Number(m[2]) - 1;
  return r < 0 ? null : { r, c: colIndex(m[1]) };
}
export interface Rect { r1: number; c1: number; r2: number; c2: number }
export const MAX_ROWS = 200_000;
export const MAX_COLS = 18_278;
/** "A1", "A1:C9", "A:A", "2:4", "B2:B" → rectangle (open ends become the given limits). */
export function parseRect(text: string, rows = MAX_ROWS, cols = MAX_COLS): Rect | null {
  const t = text.trim().replace(/\$/g, '');
  let m: RegExpExecArray | null;
  if ((m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+)?)?$/.exec(t))) {
    const r1 = Number(m[2]) - 1, c1 = colIndex(m[1]);
    if (r1 < 0) return null;
    if (!m[3]) return { r1, c1, r2: r1, c2: c1 };
    const r2 = m[4] ? Number(m[4]) - 1 : rows - 1, c2 = colIndex(m[3]);
    if (r2 < 0) return null;
    return norm({ r1, c1, r2, c2 });
  }
  if ((m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(t))) return norm({ r1: 0, c1: colIndex(m[1]), r2: rows - 1, c2: colIndex(m[2]) });
  if ((m = /^(\d+):(\d+)$/.exec(t))) { const a = Number(m[1]) - 1, b = Number(m[2]) - 1; return a < 0 || b < 0 ? null : norm({ r1: a, c1: 0, r2: b, c2: cols - 1 }); }
  return null;
}
export const norm = (r: Rect): Rect => ({ r1: Math.min(r.r1, r.r2), c1: Math.min(r.c1, r.c2), r2: Math.max(r.r1, r.r2), c2: Math.max(r.c1, r.c2) });
export const rectText = (r: Rect): string => (r.r1 === r.r2 && r.c1 === r.c2 ? addr(r.r1, r.c1) : `${addr(r.r1, r.c1)}:${addr(r.r2, r.c2)}`);
export const inRect = (r: Rect, row: number, col: number): boolean => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
export const overlaps = (a: Rect, b: Rect): boolean => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
export function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(true|false)$/i.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/* ---------------- values ---------------- */

export type ErrCode = '#NULL!' | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A' | '#ERROR!' | '#CIRCULAR!' | '#SPILL!';
export const ERR_CODES: ErrCode[] = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#ERROR!', '#CIRCULAR!', '#SPILL!'];
export class FErr {
  code: ErrCode;
  message: string;
  constructor(code: ErrCode, message = '') { this.code = code; this.message = message; }
}
export type Scalar = number | string | boolean | null | FErr;
export type Matrix = Scalar[][];
export interface RefV { kind: 'ref'; sheet: string; r1: number; c1: number; r2: number; c2: number }
export type Value = Scalar | Matrix | RefV;
export const isErr = (v: unknown): v is FErr => v instanceof FErr;
export const isRef = (v: unknown): v is RefV => typeof v === 'object' && v !== null && (v as RefV).kind === 'ref';
export const isMatrix = (v: unknown): v is Matrix => Array.isArray(v);
export const err = (code: ErrCode, message = ''): FErr => new FErr(code, message);

/* ---------------- tokenizer ---------------- */

export type TokType = 'num' | 'str' | 'bool' | 'err' | 'ref' | 'fn' | 'name' | 'op' | 'lp' | 'rp' | 'sep' | 'lb' | 'rb' | 'semi' | 'ws';
export interface Token { type: TokType; text: string; start: number; end: number; ref?: RefTok }
export interface RefTok {
  sheet?: string; // as written, unquoted
  kind: 'cell' | 'range' | 'cols' | 'rows' | 'open';
  r1: number; c1: number; r2: number; c2: number;
  ar1: boolean; ac1: boolean; ar2: boolean; ac2: boolean;
}

const RE_SHEET = /^(?:'((?:[^']|'')+)'|([A-Za-z_฀-๿][A-Za-z0-9_.฀-๿]*))!/;
const RE_RANGE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+)?)?/;
const RE_COLS = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/;
const RE_ROWS = /^(\$?)(\d+):(\$?)(\d+)(?![0-9.])/;
const RE_NUM = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/;
const RE_ERR = /^(#NULL!|#DIV\/0!|#VALUE!|#REF!|#NAME\?|#NUM!|#N\/A|#ERROR!|#CIRCULAR!|#SPILL!)/i;
const RE_ID = /^[A-Za-z_฀-๿][A-Za-z0-9_.฀-๿]*/;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (type: TokType, len: number, ref?: RefTok) => { out.push({ type, text: src.slice(i, i + len), start: i, end: i + len, ref }); i += len; };
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i];
    if (/\s/.test(ch)) { let j = i; while (j < src.length && /\s/.test(src[j])) j++; push('ws', j - i); continue; }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length) { if (src[j] === '"') { if (src[j + 1] === '"') { j += 2; continue; } break; } j++; }
      push('str', Math.min(src.length, j + 1) - i); continue;
    }
    let m: RegExpExecArray | null;
    if ((m = RE_ERR.exec(rest))) { push('err', m[0].length); continue; }
    // a reference, optionally with a sheet prefix
    const sm = RE_SHEET.exec(rest);
    const after = sm ? rest.slice(sm[0].length) : rest;
    const sheet = sm ? (sm[1] !== undefined ? sm[1].replace(/''/g, "'") : sm[2]) : undefined;
    const pre = sm ? sm[0].length : 0;
    const prevSignificant = [...out].reverse().find((t) => t.type !== 'ws');
    const afterValue = prevSignificant && ['num', 'str', 'bool', 'err', 'ref', 'name', 'rp', 'rb'].includes(prevSignificant.type);
    if (!afterValue || sm) {
      if ((m = RE_COLS.exec(after))) {
        push('ref', pre + m[0].length, { sheet, kind: 'cols', r1: 0, r2: Infinity, c1: colIndex(m[2]), c2: colIndex(m[4]), ar1: false, ar2: false, ac1: !!m[1], ac2: !!m[3] }); continue;
      }
      if ((m = RE_ROWS.exec(after)) && (sm || !/^\d+:\d+:/.test(after))) {
        push('ref', pre + m[0].length, { sheet, kind: 'rows', r1: Number(m[2]) - 1, r2: Number(m[4]) - 1, c1: 0, c2: Infinity, ar1: !!m[1], ar2: !!m[3], ac1: false, ac2: false }); continue;
      }
      if ((m = RE_RANGE.exec(after))) {
        const tail = after.slice(m[0].length);
        if (!/^[A-Za-z0-9_.(]/.test(tail) && !(m[6] === undefined && /^\s*\(/.test(tail))) {
          const r1 = Number(m[4]) - 1, c1 = colIndex(m[2]);
          if (m[6] === undefined) push('ref', pre + m[0].length, { sheet, kind: 'cell', r1, c1, r2: r1, c2: c1, ar1: !!m[3], ac1: !!m[1], ar2: !!m[3], ac2: !!m[1] });
          else if (m[8] === undefined) push('ref', pre + m[0].length, { sheet, kind: 'open', r1, c1, r2: Infinity, c2: colIndex(m[6]), ar1: !!m[3], ac1: !!m[1], ar2: false, ac2: !!m[5] });
          else push('ref', pre + m[0].length, { sheet, kind: 'range', r1, c1, r2: Number(m[8]) - 1, c2: colIndex(m[6]), ar1: !!m[3], ac1: !!m[1], ar2: !!m[7], ac2: !!m[5] });
          continue;
        }
      }
    }
    if ((m = RE_NUM.exec(rest))) { push('num', m[0].length); continue; }
    if ((m = RE_ID.exec(rest))) {
      const word = m[0];
      const tail = rest.slice(word.length);
      if (/^\s*\(/.test(tail)) { push('fn', word.length); continue; }
      if (/^(true|false)$/i.test(word)) { push('bool', word.length); continue; }
      push('name', word.length); continue;
    }
    if (rest.startsWith('<=') || rest.startsWith('>=') || rest.startsWith('<>')) { push('op', 2); continue; }
    if ('+-*/^&=<>%'.includes(ch)) { push('op', 1); continue; }
    if (ch === '(') { push('lp', 1); continue; }
    if (ch === ')') { push('rp', 1); continue; }
    if (ch === ',') { push('sep', 1); continue; }
    if (ch === ';') { push('semi', 1); continue; }
    if (ch === '{') { push('lb', 1); continue; }
    if (ch === '}') { push('rb', 1); continue; }
    if (ch === ':') { push('op', 1); continue; }
    push('op', 1); // unknown character: the parser reports it
  }
  return out;
}

/* ---------------- parser ---------------- */

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: ErrCode }
  | { t: 'ref'; ref: RefTok }
  | { t: 'name'; v: string }
  | { t: 'fn'; name: string; args: Node[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'pct'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'arr'; rows: Node[][] }
  | { t: 'empty' };

export class ParseError extends Error {}

const parseCache = new Map<string, Node | ParseError>();

/** Parses a formula (with or without the leading "="). Throws ParseError. Results are cached by text. */
export function parse(formula: string): Node {
  const src = formula.startsWith('=') ? formula.slice(1) : formula;
  const hit = parseCache.get(src);
  if (hit instanceof ParseError) throw hit;
  if (hit) return hit;
  try {
    const node = new Parser(tokenize(src).filter((t) => t.type !== 'ws')).parseAll();
    if (parseCache.size > 20000) parseCache.clear();
    parseCache.set(src, node);
    return node;
  } catch (e) {
    const pe = e instanceof ParseError ? e : new ParseError(String(e));
    parseCache.set(src, pe);
    throw pe;
  }
}

class Parser {
  toks: Token[];
  i = 0;
  constructor(toks: Token[]) { this.toks = toks; }
  peek(): Token | undefined { return this.toks[this.i]; }
  next(): Token { const t = this.toks[this.i++]; if (!t) throw new ParseError('Formula ends too early'); return t; }
  parseAll(): Node {
    if (!this.toks.length) throw new ParseError('Empty formula');
    const n = this.expr(0);
    if (this.i < this.toks.length) throw new ParseError(`Unexpected "${this.toks[this.i].text}"`);
    return n;
  }
  static PREC: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  expr(min: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== 'op' || !(t.text in Parser.PREC)) break;
      const p = Parser.PREC[t.text];
      if (p < min) break;
      this.i++;
      const right = this.expr(p + 1);
      left = { t: 'bin', op: t.text, a: left, b: right };
    }
    return left;
  }
  unary(): Node {
    const t = this.peek();
    if (t && t.type === 'op' && (t.text === '-' || t.text === '+')) { this.i++; return { t: 'un', op: t.text, a: this.unary() }; }
    return this.postfix();
  }
  postfix(): Node {
    let n = this.primary();
    while (this.peek()?.type === 'op' && this.peek()?.text === '%') { this.i++; n = { t: 'pct', a: n }; }
    return n;
  }
  primary(): Node {
    const t = this.next();
    switch (t.type) {
      case 'num': return { t: 'num', v: Number(t.text) };
      case 'str': return { t: 'str', v: t.text.slice(1, t.text.endsWith('"') && t.text.length > 1 ? -1 : undefined).replace(/""/g, '"') };
      case 'bool': return { t: 'bool', v: t.text.toUpperCase() === 'TRUE' };
      case 'err': return { t: 'err', v: t.text.toUpperCase() as ErrCode };
      case 'ref': return { t: 'ref', ref: t.ref! };
      case 'name': return { t: 'name', v: t.text };
      case 'lp': { const n = this.expr(0); if (this.next().type !== 'rp') throw new ParseError('Missing )'); return n; }
      case 'fn': {
        if (this.next().type !== 'lp') throw new ParseError('Missing (');
        const args: Node[] = [];
        if (this.peek()?.type === 'rp') { this.i++; return { t: 'fn', name: t.text.toUpperCase(), args }; }
        for (;;) {
          const p = this.peek();
          if (p && (p.type === 'sep' || p.type === 'semi' || p.type === 'rp')) args.push({ t: 'empty' });
          else args.push(this.expr(0));
          const s = this.next();
          if (s.type === 'rp') break;
          if (s.type !== 'sep' && s.type !== 'semi') throw new ParseError(`Expected , or ) but found "${s.text}"`);
        }
        return { t: 'fn', name: t.text.toUpperCase(), args };
      }
      case 'lb': {
        const rows: Node[][] = [[]];
        for (;;) {
          rows[rows.length - 1].push(this.expr(0));
          const s = this.next();
          if (s.type === 'rb') break;
          if (s.type === 'sep') continue;
          if (s.type === 'semi') { rows.push([]); continue; }
          throw new ParseError('Bad array literal');
        }
        if (rows.some((r) => r.length !== rows[0].length)) throw new ParseError('Array rows must have the same length');
        return { t: 'arr', rows };
      }
      default: throw new ParseError(`Unexpected "${t.text}"`);
    }
  }
}

/* ---------------- reference rewriting ---------------- */

export function refText(ref: RefTok): string {
  const p = ref.sheet !== undefined ? `${quoteSheet(ref.sheet)}!` : '';
  const cell = (r: number, c: number, ar: boolean, ac: boolean) => `${ac ? '$' : ''}${colName(c)}${ar ? '$' : ''}${r + 1}`;
  switch (ref.kind) {
    case 'cell': return p + cell(ref.r1, ref.c1, ref.ar1, ref.ac1);
    case 'range': return p + cell(ref.r1, ref.c1, ref.ar1, ref.ac1) + ':' + cell(ref.r2, ref.c2, ref.ar2, ref.ac2);
    case 'open': return p + cell(ref.r1, ref.c1, ref.ar1, ref.ac1) + ':' + (ref.ac2 ? '$' : '') + colName(ref.c2);
    case 'cols': return `${p}${ref.ac1 ? '$' : ''}${colName(ref.c1)}:${ref.ac2 ? '$' : ''}${colName(ref.c2)}`;
    case 'rows': return `${p}${ref.ar1 ? '$' : ''}${ref.r1 + 1}:${ref.ar2 ? '$' : ''}${ref.r2 + 1}`;
  }
}

/** Rewrites every reference in a formula. fn returns a new RefTok, or null to make it #REF!. Text outside references is kept. */
export function transformRefs(formula: string, fn: (ref: RefTok) => RefTok | null): string {
  if (!formula.startsWith('=')) return formula;
  const toks = tokenize(formula.slice(1));
  let out = '=';
  for (const t of toks) {
    if (t.type !== 'ref' || !t.ref) { out += t.text; continue; }
    const next = fn({ ...t.ref });
    out += next ? refText(next) : '#REF!';
  }
  return out;
}

/** Shifts the relative parts of every reference by (dr, dc), as copy/paste and the fill handle do. */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  return transformRefs(formula, (ref) => {
    const r = { ...ref };
    if (ref.kind !== 'cols') { if (!r.ar1) r.r1 += dr; if (!r.ar2 && Number.isFinite(r.r2)) r.r2 += dr; }
    if (ref.kind !== 'rows') { if (!r.ac1) r.c1 += dc; if (!r.ac2 && Number.isFinite(r.c2)) r.c2 += dc; }
    if (r.r1 < 0 || r.c1 < 0 || r.r2 < 0 || r.c2 < 0 || r.r1 >= MAX_ROWS || r.c1 >= MAX_COLS) return null;
    return r;
  });
}

/** Static references a formula reads: used for the dependency graph and "trace precedents". */
export interface StaticDeps { refs: RefTok[]; names: string[]; dynamic: boolean; volatile: boolean; fns: string[] }
export function staticDeps(node: Node): StaticDeps {
  const out: StaticDeps = { refs: [], names: [], dynamic: false, volatile: false, fns: [] };
  const walk = (n: Node): void => {
    switch (n.t) {
      case 'ref': out.refs.push(n.ref); break;
      case 'name': out.names.push(n.v); break;
      case 'fn': {
        out.fns.push(n.name);
        if (n.name === 'INDIRECT' || n.name === 'OFFSET') out.dynamic = true;
        if (VOLATILE.has(n.name)) out.volatile = true;
        n.args.forEach(walk); break;
      }
      case 'un': case 'pct': walk(n.a); break;
      case 'bin': walk(n.a); walk(n.b); break;
      case 'arr': n.rows.forEach((r) => r.forEach(walk)); break;
      default: break;
    }
  };
  walk(node);
  return out;
}
export const VOLATILE = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'RANDARRAY']);
