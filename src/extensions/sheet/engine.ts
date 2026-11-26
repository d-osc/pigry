/** Calculation engine of the Sheet menu: computes every formula of a workbook with a dependency graph, spills array
 * results into neighbouring cells, detects circular references, and recalculates only what an edit affects. */
import { FErr, colIndex, err, isErr, isMatrix, parse, parseAddr, staticDeps, VOLATILE, type Matrix, type RefTok, type RefV, type Scalar } from './formula.ts';
import { evaluate, evaluateFormula, toScalar, type Cx, type Host } from './functions.ts';
import { formatValue, isDatePattern } from './numfmt.ts';
import type { Cell, Sheet, Workbook } from './sheet.ts';

const W = 32768;
export const keyOf = (r: number, c: number): number => r * W + c;
export const rowOf = (k: number): number => Math.floor(k / W);
export const colOf = (k: number): number => k % W;

interface Calc {
  sheet: Sheet;
  index: Map<number, Cell>;
  vals: Map<number, Scalar>;
  /** 1 = computing, 2 = done */
  state: Map<number, number>;
  /** spilled cell → origin key */
  spillOwner: Map<number, number>;
  /** origin → [rows, cols] of its spilled result */
  spillSize: Map<number, [number, number]>;
  spillVals: Map<number, Scalar>;
  /** Inferred number format for formula cells without their own. */
  inferred: Map<number, string>;
  rows: number;
  cols: number;
}

interface Dep { sid: string; r1: number; c1: number; r2: number; c2: number; from: string }

export interface DisplayCell { text: string; color?: string; align: 'left' | 'right' | 'center'; value: Scalar; error?: string }

export interface EngineOptions { now?: number; random?: () => number }

export class Engine implements Host {
  wb: Workbook;
  readonly now0: number;
  private rnd: () => number;
  private calc = new Map<string, Calc>();
  private byName = new Map<string, string>();
  /** direct dependents: "sid|key" → formula cells "sid|key" that read it */
  private direct = new Map<string, Set<string>>();
  private ranges: Dep[] = [];
  private alwaysDirty = new Set<string>();
  private stack: string[] = [];
  private circular = new Set<string>();
  /** Bumped whenever values change; renderers use it to invalidate caches. */
  version = 0;
  private condCache = new Map<string, unknown>();

  constructor(wb: Workbook, opts: EngineOptions = {}) {
    this.wb = wb;
    this.now0 = opts.now ?? Date.now();
    this.rnd = opts.random ?? Math.random;
    this.index();
    this.recalcAll();
  }

  /* ---------------- Host ---------------- */

  sheetId(name: string): string | null { return this.byName.get(name.toLowerCase()) ?? null; }
  sheetName(id: string): string { return this.calc.get(id)?.sheet.name ?? id; }
  size(sid: string): { rows: number; cols: number } { const c = this.calc.get(sid); return c ? { rows: c.rows, cols: c.cols } : { rows: 0, cols: 0 }; }
  now(): number { return this.now0; }
  random(): number { return this.rnd(); }
  name(name: string): RefV | null {
    const target = Object.entries(this.wb.names ?? {}).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
    if (!target) return null;
    const bang = target.lastIndexOf('!');
    const sheetName = bang >= 0 ? target.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'") : this.wb.sheets[0]?.name;
    const sid = sheetName ? this.sheetId(sheetName) : null;
    if (!sid) return null;
    const t = (bang >= 0 ? target.slice(bang + 1) : target).replace(/\$/g, '');
    const c = this.calc.get(sid)!;
    const m = /^([A-Z]{1,3})(\d+)?(?::([A-Z]{1,3})(\d+)?)?$/i.exec(t);
    if (!m) return null;
    const r1 = m[2] ? Number(m[2]) - 1 : 0, c1 = colIndex(m[1]);
    const r2 = m[3] ? (m[4] ? Number(m[4]) - 1 : Math.max(r1, c.rows - 1)) : m[2] ? r1 : Math.max(0, c.rows - 1);
    const c2 = m[3] ? colIndex(m[3]) : c1;
    return { kind: 'ref', sheet: sid, r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
  }
  formula(sid: string, r: number, c: number): string | null { const cell = this.calc.get(sid)?.index.get(keyOf(r, c)); return cell?.f ?? null; }

  get(sid: string, r: number, c: number): Scalar {
    const calc = this.calc.get(sid);
    if (!calc) return err('#REF!');
    const k = keyOf(r, c);
    const cell = calc.index.get(k);
    if (cell?.f) return this.compute(calc, sid, k);
    if (cell && cell.v !== undefined && cell.v !== null && cell.v !== '') return cell.v;
    const owner = calc.spillOwner.get(k);
    if (owner !== undefined) { this.compute(calc, sid, owner); return calc.spillVals.get(k) ?? null; }
    return null;
  }

  /* ---------------- public API ---------------- */

  value(sid: string, r: number, c: number): Scalar { return this.get(sid, r, c); }

  /** Value as the grid shows it: number format, colour from the format, and default alignment. */
  display(sid: string, r: number, c: number): DisplayCell {
    const calc = this.calc.get(sid);
    const cell = calc?.index.get(keyOf(r, c));
    const v = this.get(sid, r, c);
    const nf = cell?.s?.nf ?? (cell?.f ? calc?.inferred.get(keyOf(r, c)) : undefined) ?? (calc?.spillOwner.has(keyOf(r, c)) ? calc.inferred.get(calc.spillOwner.get(keyOf(r, c))!) : undefined);
    if (isErr(v)) return { text: v.code, align: 'center', value: v, error: v.message || errorHelp(v.code) };
    const f = formatValue(v, nf);
    const align = typeof v === 'number' ? 'right' : typeof v === 'boolean' ? 'center' : 'left';
    return { text: f.text, color: f.color, align, value: v };
  }

  /** Evaluates a formula as if it were typed in a cell of a sheet (sheet_query, conditional formatting, the formula bar preview). */
  evalAt(sid: string, formula: string, r = 0, c = 0): Scalar | Matrix {
    const cx: Cx = { host: this, sheet: sid, r, c };
    return evaluateFormula(formula.startsWith('=') ? formula : '=' + formula, cx);
  }

  /** Cells that a formula reads (as "Sheet!A1:B2" texts). */
  precedents(sid: string, r: number, c: number): string[] {
    const cell = this.calc.get(sid)?.index.get(keyOf(r, c));
    if (!cell?.f) return [];
    try {
      const d = staticDeps(parse(cell.f));
      return [...d.refs.map((ref) => `${ref.sheet ?? this.sheetName(sid)}!${refRange(ref)}`), ...d.names];
    } catch { return []; }
  }
  /** Formula cells that read this cell (directly). */
  dependents(sid: string, r: number, c: number): string[] {
    const k = `${sid}|${keyOf(r, c)}`;
    const out = new Set(this.direct.get(k) ?? []);
    for (const d of this.ranges) if (d.sid === sid && r >= d.r1 && r <= d.r2 && c >= d.c1 && c <= d.c2) out.add(d.from);
    return [...out].map((x) => { const [s, kk] = x.split('|'); const n = Number(kk); return `${this.sheetName(s)}!${colName(colOf(n))}${rowOf(n) + 1}`; });
  }

  spillOf(sid: string, r: number, c: number): { origin: [number, number]; size: [number, number] } | null {
    const calc = this.calc.get(sid);
    if (!calc) return null;
    const k = keyOf(r, c);
    const o = calc.spillSize.has(k) ? k : calc.spillOwner.get(k);
    if (o === undefined) return null;
    const size = calc.spillSize.get(o);
    return size ? { origin: [rowOf(o), colOf(o)], size } : null;
  }
  isCircular(sid: string, r: number, c: number): boolean { return this.circular.has(`${sid}|${keyOf(r, c)}`); }

  /** Every formula error in the workbook (for reviews and the agent). */
  errors(limit = 50): { sheet: string; cell: string; code: string; message: string }[] {
    const out: { sheet: string; cell: string; code: string; message: string }[] = [];
    for (const [sid, calc] of this.calc) {
      for (const [k, cell] of calc.index) {
        if (!cell.f) continue;
        const v = calc.vals.get(k);
        if (isErr(v)) { out.push({ sheet: calc.sheet.name, cell: `${colName(colOf(k))}${rowOf(k) + 1}`, code: v.code, message: v.message || errorHelp(v.code) }); if (out.length >= limit) return out; }
        void sid;
      }
    }
    return out;
  }

  /** A per-engine cache the renderer uses (conditional formatting, filter state). */
  memo<T>(key: string, make: () => T): T {
    if (this.condCache.has(key)) return this.condCache.get(key) as T;
    const v = make();
    this.condCache.set(key, v);
    return v;
  }

  /** Returns an engine for an edited workbook, recalculating only cells that depend on `touched` ("sheetId!A1"). */
  update(wb: Workbook, touched?: string[] | 'all'): Engine {
    const sameShape = wb.sheets.length === this.wb.sheets.length && wb.sheets.every((s, i) => s.id === this.wb.sheets[i].id && s.name === this.wb.sheets[i].name)
      && JSON.stringify(wb.names ?? {}) === JSON.stringify(this.wb.names ?? {});
    if (!touched || touched === 'all' || !sameShape || touched.length > 5000) return new Engine(wb, { now: Date.now(), random: this.rnd });
    const next = Object.create(Engine.prototype) as Engine;
    Object.assign(next, {
      wb, now0: Date.now(), rnd: this.rnd, calc: new Map(), byName: new Map(this.byName), direct: this.direct, ranges: this.ranges,
      alwaysDirty: this.alwaysDirty, stack: [], circular: new Set<string>(), version: this.version + 1, condCache: new Map(),
    });
    // carry the old values over
    for (const s of wb.sheets) {
      const old = this.calc.get(s.id)!;
      const calc: Calc = {
        sheet: s, index: old.sheet === s ? old.index : indexCells(s), vals: new Map(old.vals), state: new Map(old.state),
        spillOwner: new Map(old.spillOwner), spillSize: new Map(old.spillSize), spillVals: new Map(old.spillVals), inferred: new Map(old.inferred), rows: 0, cols: 0,
      };
      extent(calc);
      next.calc.set(s.id, calc);
    }
    // dirty closure
    const seeds = new Set<string>();
    for (const t of touched) {
      const bang = t.lastIndexOf('!');
      const sid = t.slice(0, bang), a = parseAddr(t.slice(bang + 1));
      if (!a || !next.calc.has(sid)) return new Engine(wb, { now: Date.now(), random: this.rnd });
      const k = keyOf(a.r, a.c);
      seeds.add(`${sid}|${k}`);
      const calc = next.calc.get(sid)!;
      const owner = calc.spillOwner.get(k);
      if (owner !== undefined) seeds.add(`${sid}|${owner}`);
      const size = calc.spillSize.get(k);
      if (size) for (let r = 0; r < size[0]; r++) for (let c = 0; c < size[1]; c++) seeds.add(`${sid}|${keyOf(a.r + r, a.c + c)}`);
    }
    for (const x of this.alwaysDirty) seeds.add(x);
    const dirty = next.closure(seeds);
    // origins that are dirty lose their spill claims; their old spill cells become dirty too
    for (const x of [...dirty]) {
      const [sid, kk] = x.split('|'); const k = Number(kk);
      const calc = next.calc.get(sid)!;
      const size = calc.spillSize.get(k);
      if (size) {
        const r0 = rowOf(k), c0 = colOf(k);
        for (let r = 0; r < size[0]; r++) for (let c = 0; c < size[1]; c++) { const sk = keyOf(r0 + r, c0 + c); calc.spillOwner.delete(sk); calc.spillVals.delete(sk); for (const d of next.closure(new Set([`${sid}|${sk}`]))) dirty.add(d); }
        calc.spillSize.delete(k);
      }
    }
    for (const x of dirty) { const [sid, kk] = x.split('|'); const calc = next.calc.get(sid)!; const k = Number(kk); calc.vals.delete(k); calc.state.delete(k); calc.inferred.delete(k); }
    // rebuild dependencies of the touched formula cells
    next.direct = new Map([...this.direct].map(([k, v]) => [k, new Set(v)]));
    next.ranges = [...this.ranges];
    next.alwaysDirty = new Set(this.alwaysDirty);
    for (const t of seeds) next.unregister(t);
    for (const t of seeds) { const [sid, kk] = t.split('|'); const calc = next.calc.get(sid)!; const cell = calc.index.get(Number(kk)); if (cell?.f) next.register(sid, Number(kk), cell.f); }
    const before = new Map([...next.calc].map(([sid, c]) => [sid, new Map(c.spillSize)]));
    for (const x of dirty) { const [sid, kk] = x.split('|'); const calc = next.calc.get(sid)!; const k = Number(kk); if (calc.index.get(k)?.f) next.compute(calc, sid, k); }
    // a spill that appeared or changed shape can change what other cells read: be safe and recalculate everything
    for (const [sid, calc] of next.calc) {
      const was = before.get(sid)!;
      for (const [k, size] of calc.spillSize) { const w = was.get(k); if (!w || w[0] !== size[0] || w[1] !== size[1]) return new Engine(wb, { now: Date.now(), random: this.rnd }); }
    }
    for (const c of this.circular) if (!dirty.has(c)) next.circular.add(c);
    return next;
  }

  /* ---------------- internals ---------------- */

  private index(): void {
    this.calc.clear(); this.byName.clear();
    for (const s of this.wb.sheets) {
      const calc: Calc = { sheet: s, index: indexCells(s), vals: new Map(), state: new Map(), spillOwner: new Map(), spillSize: new Map(), spillVals: new Map(), inferred: new Map(), rows: 0, cols: 0 };
      extent(calc);
      this.calc.set(s.id, calc);
      this.byName.set(s.name.toLowerCase(), s.id);
    }
    this.direct = new Map(); this.ranges = []; this.alwaysDirty = new Set();
    for (const [sid, calc] of this.calc) for (const [k, cell] of calc.index) if (cell.f) this.register(sid, k, cell.f);
  }

  private register(sid: string, k: number, f: string): void {
    const from = `${sid}|${k}`;
    let d;
    try { d = staticDeps(parse(f)); } catch { return; }
    if (d.dynamic || d.volatile || d.names.length || d.fns.some((x) => VOLATILE.has(x))) this.alwaysDirty.add(from);
    for (const ref of d.refs) {
      const target = ref.sheet === undefined ? sid : this.sheetId(ref.sheet);
      if (!target) continue;
      if (ref.kind === 'cell') {
        const key = `${target}|${keyOf(ref.r1, ref.c1)}`;
        let set = this.direct.get(key);
        if (!set) { set = new Set(); this.direct.set(key, set); }
        set.add(from);
      } else {
        this.ranges.push({ sid: target, r1: ref.r1, c1: ref.c1, r2: Number.isFinite(ref.r2) ? ref.r2 : Infinity, c2: Number.isFinite(ref.c2) ? ref.c2 : Infinity, from });
      }
    }
  }
  private unregister(from: string): void {
    for (const set of this.direct.values()) set.delete(from);
    this.ranges = this.ranges.filter((d) => d.from !== from);
    this.alwaysDirty.delete(from);
  }
  private closure(seeds: Set<string>): Set<string> {
    const out = new Set<string>(seeds);
    const queue = [...seeds];
    while (queue.length) {
      const x = queue.pop()!;
      const [sid, kk] = x.split('|'); const k = Number(kk), r = rowOf(k), c = colOf(k);
      const add = (y: string) => { if (!out.has(y)) { out.add(y); queue.push(y); } };
      for (const y of this.direct.get(x) ?? []) add(y);
      for (const d of this.ranges) if (d.sid === sid && r >= d.r1 && r <= d.r2 && c >= d.c1 && c <= d.c2) add(d.from);
      // a dirty spill origin makes its spilled cells' readers dirty
      const calc = this.calc.get(sid);
      const size = calc?.spillSize.get(k);
      if (size) for (let i = 0; i < size[0]; i++) for (let j = 0; j < size[1]; j++) if (i || j) add(`${sid}|${keyOf(r + i, c + j)}`);
    }
    return out;
  }

  private recalcAll(): void {
    // pass 1 computes everything; if spills appeared that earlier cells may have read as empty, run again knowing them
    for (let pass = 0; pass < 4; pass++) {
      const known = new Map([...this.calc].map(([sid, c]) => [sid, new Map(c.spillOwner)]));
      for (const calc of this.calc.values()) {
        calc.vals.clear(); calc.state.clear(); calc.spillSize.clear(); calc.spillVals.clear(); calc.inferred.clear();
        calc.spillOwner = known.get(calc.sheet.id)!; // reading a known spill cell first computes its origin
      }
      this.circular.clear();
      for (const [sid, calc] of this.calc) for (const [k, cell] of calc.index) if (cell.f) this.compute(calc, sid, k);
      // drop claims that were only "known" from the previous pass
      let stable = true;
      for (const [sid, calc] of this.calc) {
        const fresh = new Map<number, number>();
        for (const [o, size] of calc.spillSize) { const r0 = rowOf(o), c0 = colOf(o); for (let r = 0; r < size[0]; r++) for (let c = 0; c < size[1]; c++) if (r || c) fresh.set(keyOf(r0 + r, c0 + c), o); }
        const prev = known.get(sid)!;
        if (fresh.size !== prev.size || [...fresh].some(([k, o]) => prev.get(k) !== o)) stable = false;
        calc.spillOwner = fresh;
      }
      if (stable) break;
    }
  }

  private compute(calc: Calc, sid: string, k: number): Scalar {
    const st = calc.state.get(k);
    if (st === 2) return calc.vals.get(k) ?? null;
    const id = `${sid}|${k}`;
    if (st === 1) {
      const at = this.stack.indexOf(id);
      for (const x of at >= 0 ? this.stack.slice(at) : [id]) this.circular.add(x);
      return err('#CIRCULAR!', 'Circular dependency detected: the formula refers to its own result.');
    }
    if (this.stack.length > 4000) return err('#ERROR!', 'Formula chain is too deep');
    const cell = calc.index.get(k)!;
    calc.state.set(k, 1);
    this.stack.push(id);
    const r = rowOf(k), c = colOf(k);
    let out: Scalar;
    try {
      let node;
      try { node = parse(cell.f!); } catch (e) { throw err('#ERROR!', `Formula parse error: ${e instanceof Error ? e.message : String(e)}`); }
      const cx: Cx = { host: this, sheet: sid, r, c };
      const v = evaluate(node, cx);
      let m: Scalar | Matrix;
      if (v && typeof v === 'object' && 'kind' in v) {
        m = v.r1 === v.r2 && v.c1 === v.c2 ? this.get(v.sheet, v.r1, v.c1) : toMatrixSafe(v, cx);
      } else m = v as Scalar | Matrix;
      if (isMatrix(m)) out = this.spill(calc, k, m);
      else out = m === undefined ? null : m;
      if (!cell.s?.nf) { const nf = inferFormat(cell.f!, (ref) => this.formatOfRef(ref, sid)); if (nf) calc.inferred.set(k, nf); }
    } catch (e) {
      out = e instanceof FErr ? e : err('#ERROR!', e instanceof Error ? e.message : String(e));
    }
    this.stack.pop();
    if (this.circular.has(id)) out = err('#CIRCULAR!', 'Circular dependency detected: the formula refers to its own result.');
    calc.vals.set(k, out);
    calc.state.set(k, 2);
    return out;
  }

  private spill(calc: Calc, k: number, m: Matrix): Scalar {
    const h = m.length, w = m[0]?.length ?? 0;
    if (!h || !w) return err('#N/A', 'The result is empty');
    if (h === 1 && w === 1) return m[0][0] ?? 0;
    const r0 = rowOf(k), c0 = colOf(k);
    const s = calc.sheet;
    if (r0 + h > s.rows || c0 + w > s.cols) return err('#REF!', `Array result was not expanded because it would run past the edge of the sheet (needs ${h} rows × ${w} columns).`);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      if (!r && !c) continue;
      const sk = keyOf(r0 + r, c0 + c);
      const cell = calc.index.get(sk);
      const owner = calc.spillOwner.get(sk);
      if ((cell && (cell.f || (cell.v !== undefined && cell.v !== null && cell.v !== ''))) || (owner !== undefined && owner !== k && calc.spillSize.has(owner))) {
        return err('#REF!', `Array result was not expanded because it would overwrite data in ${colName(c0 + c)}${r0 + r + 1}.`);
      }
    }
    calc.spillSize.set(k, [h, w]);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      if (!r && !c) continue;
      const sk = keyOf(r0 + r, c0 + c);
      calc.spillOwner.set(sk, k);
      const v = m[r][c];
      calc.spillVals.set(sk, v === undefined ? null : v);
    }
    const first = m[0][0];
    return first === undefined || first === null ? 0 : first;
  }

  private formatOfRef(ref: RefTok, sid: string): string | undefined {
    const target = ref.sheet === undefined ? sid : this.sheetId(ref.sheet);
    if (!target) return undefined;
    const calc = this.calc.get(target);
    const cell = calc?.index.get(keyOf(ref.r1, ref.c1));
    return cell?.s?.nf ?? (cell?.f ? calc?.inferred.get(keyOf(ref.r1, ref.c1)) : undefined);
  }
}

function toMatrixSafe(v: RefV, cx: Cx): Matrix {
  const out: Matrix = [];
  if ((v.r2 - v.r1 + 1) * (v.c2 - v.c1 + 1) > 2_000_000) return [[err('#NUM!', 'Range is too large')]];
  for (let r = v.r1; r <= v.r2; r++) { const row: Scalar[] = []; for (let c = v.c1; c <= v.c2; c++) row.push(toScalar({ ...v, r1: r, r2: r, c1: c, c2: c }, cx)); out.push(row); }
  return out;
}

function indexCells(s: Sheet): Map<number, Cell> {
  const m = new Map<number, Cell>();
  for (const [a, cell] of Object.entries(s.cells)) { const p = parseAddr(a); if (p) m.set(keyOf(p.r, p.c), cell); }
  return m;
}
function extent(calc: Calc): void {
  let rows = 0, cols = 0;
  for (const k of calc.index.keys()) { const r = rowOf(k) + 1, c = colOf(k) + 1; if (r > rows) rows = r; if (c > cols) cols = c; }
  calc.rows = Math.min(calc.sheet.rows, Math.max(rows, 1));
  calc.cols = Math.min(calc.sheet.cols, Math.max(cols, 1));
}

const DATE_FNS: Record<string, string> = { TODAY: 'yyyy-mm-dd', DATE: 'yyyy-mm-dd', EDATE: 'yyyy-mm-dd', EOMONTH: 'yyyy-mm-dd', WORKDAY: 'yyyy-mm-dd', DATEVALUE: 'yyyy-mm-dd', NOW: 'yyyy-mm-dd hh:mm:ss', TIME: 'h:mm:ss AM/PM', TIMEVALUE: 'h:mm:ss AM/PM' };
/** Sheets shows =TODAY() as a date and =A1+7 in A1's format; this guesses the same from the formula. */
function inferFormat(f: string, formatOf: (ref: RefTok) => string | undefined): string | undefined {
  let node;
  try { node = parse(f); } catch { return undefined; }
  if (node.t === 'fn' && DATE_FNS[node.name]) return DATE_FNS[node.name];
  if (node.t === 'fn' && ['MIN', 'MAX', 'SUM', 'AVERAGE', 'MEDIAN', 'ROUND', 'INDEX', 'VLOOKUP', 'XLOOKUP', 'HLOOKUP', 'IF', 'SUMIF', 'SUMIFS', 'MINIFS', 'MAXIFS', 'LARGE', 'SMALL', 'AVERAGEIF', 'AVERAGEIFS'].includes(node.name)) {
    const d = staticDeps(node);
    const first = d.refs.find(() => true);
    if (node.name === 'IF' || node.name === 'VLOOKUP' || node.name === 'HLOOKUP' || node.name === 'SUMIF' || node.name === 'AVERAGEIF') return undefined;
    const nf = first ? formatOf(first) : undefined;
    if (nf && node.name !== 'COUNT') return nf;
    return undefined;
  }
  if (node.t === 'ref' && node.ref.kind === 'cell') return formatOf(node.ref);
  if (node.t === 'bin' && (node.op === '+' || node.op === '-')) {
    const side = (n: typeof node.a): string | undefined => (n.t === 'ref' && n.ref.kind === 'cell' ? formatOf(n.ref) : n.t === 'fn' && DATE_FNS[n.name] ? DATE_FNS[n.name] : undefined);
    const a = side(node.a), b = side(node.b);
    if (node.op === '-' && a && b && isDatePattern(a) && isDatePattern(b)) return undefined; // date − date = days
    return a ?? (node.op === '+' ? b : undefined);
  }
  if (node.t === 'bin' && (node.op === '*' || node.op === '/')) {
    const a = node.a.t === 'ref' && node.a.ref.kind === 'cell' ? formatOf(node.a.ref) : undefined;
    if (a && !isDatePattern(a) && !a.includes('%')) return a;
  }
  return undefined;
}

function refRange(ref: RefTok): string {
  const a = (r: number, c: number) => `${colName(c)}${r + 1}`;
  if (ref.kind === 'cell') return a(ref.r1, ref.c1);
  if (ref.kind === 'cols') return `${colName(ref.c1)}:${colName(ref.c2)}`;
  if (ref.kind === 'rows') return `${ref.r1 + 1}:${ref.r2 + 1}`;
  if (ref.kind === 'open') return `${a(ref.r1, ref.c1)}:${colName(ref.c2)}`;
  return `${a(ref.r1, ref.c1)}:${a(ref.r2, ref.c2)}`;
}
function colName(c: number): string { let n = c + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

export function errorHelp(code: string): string {
  switch (code) {
    case '#DIV/0!': return 'Division by zero (or an average of no numbers).';
    case '#VALUE!': return 'A value has the wrong type, e.g. text where a number is needed.';
    case '#REF!': return 'The reference is not valid (deleted cells, or an array that cannot spill).';
    case '#NAME?': return 'Unknown function or range name — check the spelling.';
    case '#N/A': return 'Value not available — usually a lookup that found nothing.';
    case '#NUM!': return 'The number is not valid for this calculation.';
    case '#CIRCULAR!': return 'Circular dependency: the formula depends on its own result.';
    case '#ERROR!': return 'The formula could not be parsed.';
    default: return '';
  }
}
