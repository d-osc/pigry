/** The assertion engine behind `.should()`, `.and()` and `expect()` of the
 * Cypress-style E2E runner: a chai-like chainer language ("have.text",
 * "not.be.visible", "have.length.greaterThan", …) evaluated against either a
 * snapshot of DOM elements (see cyPage.js) or a plain value. Pure — no DOM,
 * no Tauri — so it is unit-tested in Node. */

export interface ElSnap {
  tag: string; id: string; cls: string[]; text: string; html: string; value?: string;
  vis: boolean; dis: boolean; chk: boolean; sel: boolean; foc: boolean;
  attrs: Record<string, string>; css: Record<string, string>; empty: boolean;
  rect: { x: number; y: number; w: number; h: number }; desc: string;
  readOnly: boolean; required: boolean; type: string; name: string;
}
export interface DomSnap { count: number; els: ElSnap[] }

export interface AssertResult { pass: boolean; message: string; actual?: unknown; expected?: unknown }

export const isDomSnap = (v: unknown): v is DomSnap => !!v && typeof v === 'object' && 'els' in (v as object) && 'count' in (v as object);

/** How a value is shown in assertion messages. */
export function fmt(v: unknown, max = 80): string {
  let s: string;
  if (typeof v === 'string') s = `'${v}'`;
  else if (v === undefined) s = 'undefined';
  else if (typeof v === 'function') s = '[Function]';
  else if (v instanceof RegExp) s = String(v);
  else { try { s = JSON.stringify(v); } catch { s = String(v); } if (s === undefined) s = String(v); }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b);
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Colours and lengths written differently still compare equal ("rgb(255, 0, 0)" ↔ "#f00" ↔ "red"). */
const NAMED: Record<string, string> = { red: '#ff0000', green: '#008000', blue: '#0000ff', white: '#ffffff', black: '#000000', transparent: 'rgba(0, 0, 0, 0)', yellow: '#ffff00', orange: '#ffa500', gray: '#808080', grey: '#808080', purple: '#800080', pink: '#ffc0cb' };
export function normCss(v: string): string {
  let s = String(v).trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return h.length === 8 ? `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${+(n(6) / 255).toFixed(2)})` : `rgb(${n(0)}, ${n(2)}, ${n(4)})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(s);
  if (rgb) {
    const p = rgb[1].split(/[,/ ]+/).filter(Boolean);
    if (p.length >= 3) return p.length === 4 && +p[3] !== 1 ? `rgba(${+p[0]}, ${+p[1]}, ${+p[2]}, ${+p[3]})` : `rgb(${+p[0]}, ${+p[1]}, ${+p[2]})`;
  }
  return s.replace(/\s+/g, ' ');
}

const ALIAS: Record<string, string> = {
  equals: 'equal', eq: 'equal', equal: 'equal', eql: 'eql', eqls: 'eql', include: 'include', includes: 'include', contain: 'include', contains: 'include',
  lengthOf: 'length', length: 'length', above: 'above', gt: 'above', greaterThan: 'above', below: 'below', lt: 'below', lessThan: 'below',
  least: 'least', gte: 'least', most: 'most', lte: 'most', match: 'match', matches: 'match', a: 'a', an: 'a',
};
const WORDS = new Set(['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'still', 'also']);

interface Parsed { not: boolean; deep: boolean; any: boolean; all: boolean; own: boolean; terms: string[] }
export function parseChainer(chainer: string): Parsed {
  const out: Parsed = { not: false, deep: false, any: false, all: false, own: false, terms: [] };
  for (const raw of chainer.split('.').map((w) => w.trim()).filter(Boolean)) {
    if (raw === 'not') out.not = !out.not;
    else if (raw === 'deep') out.deep = true;
    else if (raw === 'any') out.any = true;
    else if (raw === 'all') out.all = true;
    else if (raw === 'own') out.own = true;
    else if (WORDS.has(raw)) { /* filler */ } else out.terms.push(raw);
  }
  return out;
}

const textOf = (d: DomSnap) => d.els.map((e) => e.text).join('');
const label = (d: DomSnap) => (d.count === 1 ? d.els[0].desc : `${d.count} elements`);

const cmpNum = (term: string, actual: number, n: number): boolean =>
  term === 'above' ? actual > n : term === 'below' ? actual < n : term === 'least' ? actual >= n : actual <= n;

/** Evaluates `chainer` against a DOM snapshot. */
export function assertDom(d: DomSnap, chainer: string, args: unknown[]): AssertResult {
  const p = parseChainer(chainer);
  const t = p.terms.map((w) => ALIAS[w] ?? w);
  const first = t[0];
  const sub = label(d);
  const neg = p.not;
  const done = (pass: boolean, msgPos: string, msgNeg: string, actual?: unknown, expected?: unknown): AssertResult => {
    const ok = neg ? !pass : pass;
    return { pass: ok, message: ok ? (neg ? msgNeg : msgPos) : `${neg ? msgNeg : msgPos}${actual !== undefined ? ` (actual: ${fmt(actual)})` : ''}`.replace(/^expected/, 'expected'), actual, expected };
  };
  const requireEl = (): AssertResult | null => (d.count === 0 && first !== 'exist' ? { pass: false, message: `expected to find an element, but never found it` } : null);

  if (first === 'exist') return done(d.count > 0, `expected ${d.count > 0 ? sub : 'element'} to exist in the DOM`, `expected ${d.count > 0 ? sub : 'element'} not to exist in the DOM`);
  const needEl = requireEl();
  if (needEl) return needEl;
  const el = d.els[0];
  switch (first) {
    case 'visible': return done(d.els.every((e) => e.vis), `expected ${sub} to be visible`, `expected ${sub} not to be visible`);
    case 'hidden': return done(d.els.every((e) => !e.vis), `expected ${sub} to be hidden`, `expected ${sub} not to be hidden`);
    case 'enabled': return done(d.els.every((e) => !e.dis), `expected ${sub} to be enabled`, `expected ${sub} not to be enabled`);
    case 'disabled': return done(d.els.every((e) => e.dis), `expected ${sub} to be disabled`, `expected ${sub} not to be disabled`);
    case 'checked': return done(d.els.every((e) => e.chk), `expected ${sub} to be checked`, `expected ${sub} not to be checked`);
    case 'selected': return done(d.els.every((e) => e.sel), `expected ${sub} to be selected`, `expected ${sub} not to be selected`);
    case 'focused': case 'focus': return done(el.foc, `expected ${sub} to be focused`, `expected ${sub} not to be focused`);
    case 'empty': return done(d.els.every((e) => e.empty), `expected ${sub} to be empty`, `expected ${sub} not to be empty`);
    case 'readonly': return done(el.readOnly, `expected ${sub} to be readonly`, `expected ${sub} not to be readonly`);
    case 'required': return done(el.required, `expected ${sub} to be required`, `expected ${sub} not to be required`);
    case 'ok': return done(d.count > 0, `expected ${sub} to be truthy`, `expected ${sub} to be falsy`);
    default: break;
  }
  if (first === 'text' || (first === 'include' && t[1] === 'text')) {
    const want = args[0];
    const actual = textOf(d);
    const exact = first === 'text';
    const pass = want instanceof RegExp ? want.test(actual) : exact ? actual === String(want) : actual.includes(String(want));
    return done(pass, `expected ${sub} to ${exact ? 'have' : 'contain'} text ${fmt(want)}`, `expected ${sub} not to ${exact ? 'have' : 'contain'} text ${fmt(want)}`, actual.slice(0, 120), want);
  }
  if (first === 'include' && t[1] === 'html' || first === 'html') {
    const want = String(args[0]); const actual = d.els.map((e) => e.html).join('');
    const exact = first === 'html';
    return done(exact ? actual === want : actual.includes(want), `expected ${sub} to ${exact ? 'have' : 'contain'} HTML ${fmt(want)}`, `expected ${sub} not to ${exact ? 'have' : 'contain'} HTML ${fmt(want)}`, actual.slice(0, 120), want);
  }
  if (first === 'value' || (first === 'include' && t[1] === 'value')) {
    const want = args[0]; const actual = el.value ?? '';
    const exact = first === 'value';
    const pass = want instanceof RegExp ? want.test(actual) : exact ? actual === String(want) : actual.includes(String(want));
    return done(pass, `expected ${sub} to ${exact ? 'have' : 'contain'} value ${fmt(want)}`, `expected ${sub} not to ${exact ? 'have' : 'contain'} value ${fmt(want)}`, actual, want);
  }
  if (first === 'attr' || first === 'attribute') {
    const name = String(args[0]); const has = Object.prototype.hasOwnProperty.call(el.attrs, name);
    if (args.length < 2) return done(has, `expected ${sub} to have attribute ${fmt(name)}`, `expected ${sub} not to have attribute ${fmt(name)}`);
    const want = args[1]; const actual = el.attrs[name];
    const pass = has && (want instanceof RegExp ? want.test(actual) : actual === String(want));
    return done(pass, `expected ${sub} to have attribute ${fmt(name)} with the value ${fmt(want)}`, `expected ${sub} not to have attribute ${fmt(name)} with the value ${fmt(want)}`, has ? actual : '(missing)', want);
  }
  if (first === 'class') {
    const name = String(args[0]);
    return done(el.cls.includes(name), `expected ${sub} to have class ${fmt(name)}`, `expected ${sub} not to have class ${fmt(name)}`, el.cls.join(' '), name);
  }
  if (first === 'id') return done(el.id === String(args[0]), `expected ${sub} to have id ${fmt(args[0])}`, `expected ${sub} not to have id ${fmt(args[0])}`, el.id, args[0]);
  if (first === 'css') {
    const prop = String(args[0]);
    const actual = el.css[prop] ?? el.css[prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)];
    if (actual === undefined) return { pass: false, message: `expected ${sub} to have css property ${fmt(prop)}, but it was not measured` };
    const want = args[1];
    const pass = want === undefined ? actual !== '' : normCss(actual) === normCss(String(want)) || actual === String(want);
    return done(pass, `expected ${sub} to have CSS property ${fmt(prop)} with the value ${fmt(want)}`, `expected ${sub} not to have CSS property ${fmt(prop)} with the value ${fmt(want)}`, actual, want);
  }
  if (first === 'prop' || first === 'property') {
    const name = String(args[0]);
    const map: Record<string, unknown> = { checked: el.chk, disabled: el.dis, value: el.value, selected: el.sel, readOnly: el.readOnly, required: el.required, id: el.id, className: el.cls.join(' '), tagName: el.tag.toUpperCase(), type: el.type, name: el.name, innerText: el.text, textContent: el.text, innerHTML: el.html };
    const has = name in map;
    if (args.length < 2) return done(has, `expected ${sub} to have property ${fmt(name)}`, `expected ${sub} not to have property ${fmt(name)}`);
    return done(has && deepEqual(map[name], args[1]), `expected ${sub} to have property ${fmt(name)} with the value ${fmt(args[1])}`, `expected ${sub} not to have property ${fmt(name)} with the value ${fmt(args[1])}`, map[name], args[1]);
  }
  if (first === 'length') {
    const cmp = t[1];
    if (cmp && ['above', 'below', 'least', 'most'].includes(cmp)) return done(cmpNum(cmp, d.count, Number(args[0])), `expected ${sub} to have a length ${cmp === 'above' ? 'above' : cmp === 'below' ? 'below' : cmp === 'least' ? 'of at least' : 'of at most'} ${args[0]}`, `expected ${sub} not to have a length ${cmp} ${args[0]}`, d.count, args[0]);
    if (t[1] === 'within') return done(d.count >= Number(args[0]) && d.count <= Number(args[1]), `expected length to be within ${args[0]}..${args[1]}`, `expected length not to be within ${args[0]}..${args[1]}`, d.count);
    return done(d.count === Number(args[0]), `expected ${d.count === 1 ? sub : 'elements'} to have a length of ${args[0]}`, `expected elements not to have a length of ${args[0]}`, d.count, args[0]);
  }
  if (first === 'equal' || first === 'eql') return done(false, 'expected a DOM subject to equal a value', 'expected a DOM subject not to equal a value');
  return { pass: false, message: `unknown assertion "${chainer}" for a DOM element` };
}

/** Evaluates `chainer` against any value (the engine behind expect() and should() on non-DOM subjects). */
export function assertValue(actual: unknown, chainer: string, args: unknown[]): AssertResult {
  const p = parseChainer(chainer);
  const t = p.terms.map((w) => ALIAS[w] ?? w);
  const neg = p.not;
  const sub = fmt(actual);
  const done = (pass: boolean, pos: string, nneg: string): AssertResult => {
    const ok = neg ? !pass : pass;
    return { pass: ok, message: neg ? nneg : pos, actual, expected: args[0] };
  };
  const first = t[0];
  const num = typeof actual === 'number' ? actual : NaN;
  const lenOf = (v: unknown): number | undefined => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' && typeof (v as { length?: unknown }).length === 'number' ? (v as { length: number }).length : undefined);
  switch (first) {
    case 'true': return done(actual === true, `expected ${sub} to be true`, `expected ${sub} not to be true`);
    case 'false': return done(actual === false, `expected ${sub} to be false`, `expected ${sub} not to be false`);
    case 'null': return done(actual === null, `expected ${sub} to be null`, `expected ${sub} not to be null`);
    case 'undefined': return done(actual === undefined, `expected ${sub} to be undefined`, `expected ${sub} not to be undefined`);
    case 'NaN': return done(Number.isNaN(actual), `expected ${sub} to be NaN`, `expected ${sub} not to be NaN`);
    case 'ok': return done(!!actual, `expected ${sub} to be truthy`, `expected ${sub} to be falsy`);
    case 'exist': return done(actual !== null && actual !== undefined, `expected ${sub} to exist`, `expected ${sub} not to exist`);
    case 'empty': {
      const e = typeof actual === 'string' || Array.isArray(actual) ? actual.length === 0 : actual && typeof actual === 'object' ? Object.keys(actual).length === 0 : false;
      return done(e, `expected ${sub} to be empty`, `expected ${sub} not to be empty`);
    }
    case 'equal': return done(Object.is(actual, args[0]) || (p.deep && deepEqual(actual, args[0])), `expected ${sub} to equal ${fmt(args[0])}`, `expected ${sub} not to equal ${fmt(args[0])}`);
    case 'eql': return done(deepEqual(actual, args[0]), `expected ${sub} to deeply equal ${fmt(args[0])}`, `expected ${sub} not to deeply equal ${fmt(args[0])}`);
    case 'a': {
      const want = String(args[0]).toLowerCase();
      const type = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
      return done(type === want, `expected ${sub} to be a ${want}`, `expected ${sub} not to be a ${want}`);
    }
    case 'match': return done(args[0] instanceof RegExp ? args[0].test(String(actual)) : new RegExp(String(args[0])).test(String(actual)), `expected ${sub} to match ${fmt(args[0])}`, `expected ${sub} not to match ${fmt(args[0])}`);
    case 'above': case 'below': case 'least': case 'most':
      return done(cmpNum(first, num, Number(args[0])), `expected ${sub} to be ${first === 'above' ? 'above' : first === 'below' ? 'below' : first === 'least' ? 'at least' : 'at most'} ${fmt(args[0])}`, `expected ${sub} not to be ${first} ${fmt(args[0])}`);
    case 'within': return done(num >= Number(args[0]) && num <= Number(args[1]), `expected ${sub} to be within ${args[0]}..${args[1]}`, `expected ${sub} not to be within ${args[0]}..${args[1]}`);
    case 'length': {
      const len = lenOf(actual);
      const cmp = t[1];
      if (cmp && ['above', 'below', 'least', 'most'].includes(cmp)) return done(len !== undefined && cmpNum(cmp, len, Number(args[0])), `expected ${sub} to have a length ${cmp} ${args[0]}`, `expected ${sub} not to have a length ${cmp} ${args[0]}`);
      return done(len === Number(args[0]), `expected ${sub} to have a length of ${args[0]} but got ${len}`, `expected ${sub} not to have a length of ${args[0]}`);
    }
    case 'include': {
      const want = args[0];
      let pass = false;
      if (typeof actual === 'string') pass = actual.includes(String(want));
      else if (Array.isArray(actual)) pass = p.deep ? actual.some((x) => deepEqual(x, want)) : actual.includes(want);
      else if (actual && typeof actual === 'object') pass = want && typeof want === 'object' ? Object.keys(want as object).every((k) => deepEqual((actual as Record<string, unknown>)[k], (want as Record<string, unknown>)[k])) : String(want) in (actual as object);
      return done(pass, `expected ${sub} to include ${fmt(want)}`, `expected ${sub} not to include ${fmt(want)}`);
    }
    case 'property': case 'prop': {
      const name = String(args[0]);
      const has = actual !== null && actual !== undefined && (name in Object(actual));
      if (args.length < 2) return done(has, `expected ${sub} to have property ${fmt(name)}`, `expected ${sub} not to have property ${fmt(name)}`);
      const v = has ? (actual as Record<string, unknown>)[name] : undefined;
      return done(has && (p.deep ? deepEqual(v, args[1]) : Object.is(v, args[1])), `expected ${sub} to have property ${fmt(name)} of ${fmt(args[1])}`, `expected ${sub} not to have property ${fmt(name)} of ${fmt(args[1])}`);
    }
    case 'keys': case 'key': {
      const want = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(String);
      const have = actual && typeof actual === 'object' ? Object.keys(actual as object) : [];
      const pass = p.any ? want.some((k) => have.includes(k)) : p.all || true ? (want.every((k) => have.includes(k)) && (p.all || t.includes('include') || have.length === want.length)) : false;
      return done(pass, `expected ${sub} to have keys ${fmt(want)}`, `expected ${sub} not to have keys ${fmt(want)}`);
    }
    case 'members': return done(Array.isArray(actual) && Array.isArray(args[0]) && actual.length === args[0].length && args[0].every((x) => (actual as unknown[]).some((y) => deepEqual(x, y))), `expected ${sub} to have the same members as ${fmt(args[0])}`, `expected ${sub} not to have the same members as ${fmt(args[0])}`);
    case 'calledWith': case 'calledOnce': case 'calledTwice': case 'calledThrice': case 'called': case 'callCount': {
      const calls = (actual as { calls?: Array<{ args: unknown[] }> } | undefined)?.calls ?? [];
      if (first === 'calledWith') return done(calls.some((c) => args.every((a, i) => deepEqual(c.args[i], a))), `expected spy to have been called with ${fmt(args)}`, `expected spy not to have been called with ${fmt(args)}`);
      const n = first === 'calledOnce' ? 1 : first === 'calledTwice' ? 2 : first === 'calledThrice' ? 3 : first === 'callCount' ? Number(args[0]) : -1;
      if (n >= 0) return done(calls.length === n, `expected spy to have been called ${n} time(s), but it was called ${calls.length}`, `expected spy not to have been called ${n} time(s)`);
      return done(calls.length > 0, 'expected spy to have been called at least once', 'expected spy not to have been called');
    }
    default: return { pass: false, message: `unknown assertion "${chainer}"` };
  }
}

/** `should('have.been.calledWith', …)` style chainers use "been"; "have.been.called" → terms [called]. */
export function runAssertion(subject: DomSnap | unknown, chainer: string, args: unknown[]): AssertResult {
  if (isDomSnap(subject) && !/^(not\.)?(be\.)?(a|an|equal|eq|eql|deep|match|true|false|null|undefined|a\.)/.test(chainer)) return assertDom(subject, chainer, args);
  if (isDomSnap(subject)) return assertValue(subject.count === 1 ? subject.els[0] : subject.els, chainer, args);
  return assertValue(subject, chainer, args);
}

/** A jQuery-flavoured read-only view of a DOM snapshot, handed to `.then($el => …)` callbacks. */
export class JQ {
  readonly length: number;
  /** The query this view came from, so cy.wrap($el) can keep working with the live elements. */
  subject?: unknown;
  private readonly d: DomSnap;
  constructor(d: DomSnap) { this.d = d; this.length = d.count; }
  get(i = 0) { return this.d.els[i]; }
  toArray() { return this.d.els.slice(); }
  eq(i: number) { const e = this.d.els[i < 0 ? this.d.els.length + i : i]; return new JQ({ count: e ? 1 : 0, els: e ? [e] : [] }); }
  first() { return this.eq(0); }
  last() { return this.eq(-1); }
  text() { return textOf(this.d); }
  html() { return this.d.els[0]?.html ?? ''; }
  val() { return this.d.els[0]?.value; }
  attr(name: string) { return this.d.els[0]?.attrs[name]; }
  prop(name: string) { const e = this.d.els[0]; return e ? ({ checked: e.chk, disabled: e.dis, value: e.value, id: e.id, tagName: e.tag.toUpperCase() } as Record<string, unknown>)[name] : undefined; }
  hasClass(name: string) { return !!this.d.els[0]?.cls.includes(name); }
  css(prop: string) { return this.d.els[0]?.css[prop]; }
  width() { return this.d.els[0]?.rect.w; }
  height() { return this.d.els[0]?.rect.h; }
  is(sel: string) { const e = this.d.els[0]; if (!e) return false; return sel === ':visible' ? e.vis : sel === ':hidden' ? !e.vis : sel === ':disabled' ? e.dis : sel === ':enabled' ? !e.dis : sel === ':checked' ? e.chk : sel === ':focus' ? e.foc : sel.startsWith('.') ? e.cls.includes(sel.slice(1)) : sel.startsWith('#') ? e.id === sel.slice(1) : e.tag === sel; }
  map<T>(fn: (el: ElSnap, i: number) => T): T[] { return this.d.els.map(fn); }
  each(fn: (el: ElSnap, i: number) => void) { this.d.els.forEach(fn); return this; }
  toString() { return label(this.d); }
}

/* ---------- expect(): chai-style chain builder on top of assertValue ---------- */

export class AssertionError extends Error {
  constructor(message: string) { super(message); this.name = 'AssertionError'; }
}

const TERMINALS = new Set(['equal', 'equals', 'eq', 'eql', 'eqls', 'include', 'includes', 'contain', 'contains', 'match', 'matches', 'above', 'gt', 'greaterThan', 'below', 'lt', 'lessThan', 'least', 'gte', 'most', 'lte', 'within', 'lengthOf', 'property', 'keys', 'key', 'members', 'a', 'an', 'calledWith', 'callCount', 'text', 'value', 'attr', 'class', 'css', 'id', 'html', 'prop']);
const FLAGS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'ok', 'exist', 'empty', 'visible', 'hidden', 'enabled', 'disabled', 'checked', 'selected', 'focused', 'called', 'calledOnce', 'calledTwice', 'calledThrice']);

/** expect(value).to.equal(1) / expect($el).to.have.text('x') … throws AssertionError on failure. */
export function expectFn(actual: unknown): Record<string, unknown> {
  const build = (words: string[]): unknown => new Proxy(function () { /* callable chain */ }, {
    get(_t, prop: string) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;
      const run = (args: unknown[], tail: string[]) => {
        const chain = [...words, ...tail].join('.');
        const subject = actual instanceof JQ ? (actual as unknown as { d: DomSnap }).d : actual;
        const r = isDomSnap(subject) ? assertDom(subject, chain, args) : assertValue(subject, chain, args);
        if (!r.pass) throw new AssertionError(r.message);
        return undefined;
      };
      if (TERMINALS.has(prop)) return (...args: unknown[]) => run(args, [prop]);
      if (prop === 'length' || prop === 'lengthOf') {
        const next = build([...words, 'length']) as ((...a: unknown[]) => unknown);
        return new Proxy(function () { /* length(n) or length.above(n) */ }, { get: (_x, p: string) => (next as unknown as Record<string, unknown>)[p], apply: (_x, _this, a) => run(a, ['length']) });
      }
      if (FLAGS.has(prop)) { run([], [prop]); return build([...words]); }
      return build([...words, prop]);
    },
    apply(_t, _this, args) { return run(args); function run(a: unknown[]) { return a; } },
  });
  return build([]) as Record<string, unknown>;
}

/** assert.equal(a, b) / assert.isTrue(x) … the small subset the Cypress docs use. */
export const assertFn = Object.assign((value: unknown, message?: string) => { if (!value) throw new AssertionError(message ?? `expected ${fmt(value)} to be truthy`); }, {
  equal: (a: unknown, b: unknown, m?: string) => { if (a != b) throw new AssertionError(m ?? `expected ${fmt(a)} to equal ${fmt(b)}`); },
  strictEqual: (a: unknown, b: unknown, m?: string) => { if (!Object.is(a, b)) throw new AssertionError(m ?? `expected ${fmt(a)} to strictly equal ${fmt(b)}`); },
  deepEqual: (a: unknown, b: unknown, m?: string) => { if (!deepEqual(a, b)) throw new AssertionError(m ?? `expected ${fmt(a)} to deeply equal ${fmt(b)}`); },
  notEqual: (a: unknown, b: unknown, m?: string) => { if (a == b) throw new AssertionError(m ?? `expected ${fmt(a)} not to equal ${fmt(b)}`); },
  isTrue: (a: unknown, m?: string) => { if (a !== true) throw new AssertionError(m ?? `expected ${fmt(a)} to be true`); },
  isFalse: (a: unknown, m?: string) => { if (a !== false) throw new AssertionError(m ?? `expected ${fmt(a)} to be false`); },
  isOk: (a: unknown, m?: string) => { if (!a) throw new AssertionError(m ?? `expected ${fmt(a)} to be truthy`); },
  include: (a: unknown, b: unknown, m?: string) => { const r = assertValue(a, 'include', [b]); if (!r.pass) throw new AssertionError(m ?? r.message); },
  lengthOf: (a: unknown, n: number, m?: string) => { const r = assertValue(a, 'length', [n]); if (!r.pass) throw new AssertionError(m ?? r.message); },
  match: (a: unknown, re: RegExp, m?: string) => { if (!re.test(String(a))) throw new AssertionError(m ?? `expected ${fmt(a)} to match ${fmt(re)}`); },
  fail: (m?: string) => { throw new AssertionError(m ?? 'assert.fail()'); },
});

/* ---------- viewport presets (the same names Cypress knows) ---------- */

export const VIEWPORT_PRESETS: Record<string, [number, number]> = {
  'macbook-16': [1536, 960], 'macbook-15': [1440, 900], 'macbook-13': [1280, 800], 'macbook-11': [1366, 768],
  'ipad-2': [768, 1024], 'ipad-mini': [768, 1024], 'iphone-xr': [414, 896], 'iphone-x': [375, 812], 'iphone-6+': [414, 736],
  'iphone-se2': [375, 667], 'iphone-8': [375, 667], 'iphone-7': [375, 667], 'iphone-6': [375, 667], 'iphone-5': [320, 568], 'iphone-4': [320, 480], 'iphone-3': [320, 480],
  'samsung-s10': [360, 760], 'samsung-note9': [414, 846],
};

/** Minimal sinon-flavoured spy/stub for runner-side callbacks (cy.stub(), cy.spy()). */
export interface Stub { (...args: unknown[]): unknown; calls: Array<{ args: unknown[] }>; callCount: number; returns(v: unknown): Stub; callsFake(fn: (...a: unknown[]) => unknown): Stub; resolves(v: unknown): Stub; restore(): void; alias?: string }
export function makeStub(impl?: (...a: unknown[]) => unknown): Stub {
  let fake = impl; let ret: unknown; let hasRet = false;
  const stub = ((...args: unknown[]) => { stub.calls.push({ args }); stub.callCount = stub.calls.length; if (fake) return fake(...args); return hasRet ? ret : undefined; }) as Stub;
  stub.calls = []; stub.callCount = 0; stub.restore = () => undefined;
  stub.returns = (v) => { ret = v; hasRet = true; return stub; };
  stub.resolves = (v) => { ret = Promise.resolve(v); hasRet = true; return stub; };
  stub.callsFake = (fn) => { fake = fn; return stub; };
  return stub;
}
