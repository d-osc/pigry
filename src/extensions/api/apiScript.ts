/** The Pre-request / Tests script runtime: a small Postman-like `pm` API (variables, request, response, pm.test,
 * pm.expect) for code written by the user or an agent. Pure — node tests import it.
 *
 * Isolation: in the app the scripts run in a dedicated Web Worker (apiScriptWorker.ts) that has no DOM, no Tauri
 * bridge, and whose network globals (fetch, XMLHttpRequest, WebSocket, importScripts, …) are removed before any
 * script runs; the worker is terminated when a script runs too long. Here the browser/node globals are also
 * shadowed, so a script cannot reach them by name. */

export interface ScriptRequest { method: string; url: string; headers: Array<{ key: string; value: string; enabled?: boolean }>; body: { mode: string; raw: string } }
export interface ScriptResponse { code: number; status: string; headers: Array<{ key: string; value: string }>; body: string; responseTime: number; responseSize: number; cookies: Array<{ name: string; value: string }> }
export interface ScriptScopes { globals: Record<string, string>; collection: Record<string, string>; environment: Record<string, string>; local: Record<string, string> }
export interface ScriptInput {
  code: string;
  event: 'prerequest' | 'test';
  request: ScriptRequest;
  response?: ScriptResponse;
  scopes: ScriptScopes;
  info?: { requestName?: string; requestId?: string; iteration?: number; iterationCount?: number };
  /** False when no environment is selected: pm.environment.set then warns instead of writing. */
  hasEnvironment?: boolean;
}
export interface TestResult { name: string; passed: boolean; error?: string; skipped?: boolean }
export interface ScriptLog { level: 'log' | 'info' | 'warn' | 'error'; text: string }
export interface ScriptOutput { tests: TestResult[]; logs: ScriptLog[]; error?: string; request: ScriptRequest; scopes: ScriptScopes; nextRequest?: string | null }

/* ---------------- pm.expect: a chai-like assertion chain ---------------- */

class AssertionError extends Error {
  constructor(message: string) { super(message); this.name = 'AssertionError'; }
}

const RESPONSE = Symbol('pm.response');
const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function show(v: unknown): string {
  if (typeof v === 'string') return `'${v.length > 120 ? `${v.slice(0, 120)}…` : v}'`;
  if (typeof v === 'function') return '[Function]';
  if (v && typeof v === 'object' && (v as Record<symbol, unknown>)[RESPONSE]) return `response ${(v as { code: number }).code}`;
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 160 ? `${s.slice(0, 160)}…` : s; } catch { return String(v); }
}
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
const getPath = (obj: unknown, path: string): { found: boolean; value: unknown } => {
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as object))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: true, value: cur };
};

class Assertion {
  private negate = false;
  private deepFlag = false;
  private nestedFlag = false;
  private value: unknown;
  constructor(value: unknown) { this.value = value; }
  private check(ok: boolean, message: string, negMessage: string): this {
    if (this.negate ? ok : !ok) throw new AssertionError(this.negate ? negMessage : message);
    return this;
  }
  private get res(): { code: number; headers: { get(n: string): string | undefined; has(n: string): boolean }; text(): string; json(): unknown } | null {
    const v = this.value as Record<symbol, unknown> | null;
    return v && typeof v === 'object' && v[RESPONSE] ? (this.value as never) : null;
  }
  // language chains
  get to() { return this; } get be() { return this; } get been() { return this; } get is() { return this; } get that() { return this; } get which() { return this; }
  get and() { return this; } get has() { return this; } get have() { return this; } get with() { return this; } get at() { return this; } get of() { return this; }
  get same() { return this; } get but() { return this; } get does() { return this; } get still() { return this; } get own() { return this; } get any() { return this; } get all() { return this; }
  get not() { this.negate = !this.negate; return this; }
  get deep() { this.deepFlag = true; return this; }
  get nested() { this.nestedFlag = true; return this; }
  // properties that assert
  get true() { return this.check(this.value === true, `expected ${show(this.value)} to be true`, `expected ${show(this.value)} not to be true`); }
  get false() { return this.check(this.value === false, `expected ${show(this.value)} to be false`, `expected ${show(this.value)} not to be false`); }
  get null() { return this.check(this.value === null, `expected ${show(this.value)} to be null`, `expected ${show(this.value)} not to be null`); }
  get undefined() { return this.check(this.value === undefined, `expected ${show(this.value)} to be undefined`, `expected ${show(this.value)} not to be undefined`); }
  get NaN() { return this.check(Number.isNaN(this.value), `expected ${show(this.value)} to be NaN`, `expected ${show(this.value)} not to be NaN`); }
  get exist() { return this.check(this.value !== null && this.value !== undefined, `expected ${show(this.value)} to exist`, `expected ${show(this.value)} not to exist`); }
  get empty() {
    const v = this.value;
    const empty = typeof v === 'string' || Array.isArray(v) ? v.length === 0 : v && typeof v === 'object' ? Object.keys(v).length === 0 : false;
    return this.check(empty, `expected ${show(v)} to be empty`, `expected ${show(v)} not to be empty`);
  }
  get ok() {
    const r = this.res;
    if (r) return this.check(r.code >= 200 && r.code < 300, `expected response to have a 2xx status but got ${r.code}`, `expected response not to have a 2xx status but got ${r.code}`);
    return this.check(!!this.value, `expected ${show(this.value)} to be truthy`, `expected ${show(this.value)} to be falsy`);
  }
  get success() { return this.ok; }
  private statusClass(lo: number, label: string) { const r = this.res; const code = r ? r.code : Number(this.value); return this.check(code >= lo && code < lo + 100, `expected response to be ${label} but got ${code}`, `expected response not to be ${label} but got ${code}`); }
  get info() { return this.statusClass(100, 'informational (1xx)'); }
  get redirection() { return this.statusClass(300, 'a redirection (3xx)'); }
  get clientError() { return this.statusClass(400, 'a client error (4xx)'); }
  get serverError() { return this.statusClass(500, 'a server error (5xx)'); }
  get error() { const r = this.res; const code = r ? r.code : 0; return this.check(code >= 400 && code < 600, `expected response to be an error but got ${code}`, `expected response not to be an error but got ${code}`); }
  get notFound() { return this.statusCode(404); }
  get unauthorized() { return this.statusCode(401); }
  get forbidden() { return this.statusCode(403); }
  get badRequest() { return this.statusCode(400); }
  get accepted() { return this.statusCode(202); }
  get json() {
    const r = this.res;
    if (!r) throw new AssertionError('.json only works on pm.response');
    let ok = true;
    try { r.json(); } catch { ok = false; }
    return this.check(ok, 'expected response body to be valid JSON', 'expected response body not to be JSON');
  }
  private statusCode(code: number) { const r = this.res; const got = r ? r.code : this.value; return this.check(got === code, `expected response to have status code ${code} but got ${show(got)}`, `expected response not to have status code ${code}`); }
  // methods
  equal(expected: unknown) {
    if (this.deepFlag) return this.eql(expected);
    return this.check(this.value === expected, `expected ${show(this.value)} to equal ${show(expected)}`, `expected ${show(this.value)} not to equal ${show(expected)}`);
  }
  equals(expected: unknown) { return this.equal(expected); }
  eq(expected: unknown) { return this.equal(expected); }
  eql(expected: unknown) { return this.check(deepEqual(this.value, expected), `expected ${show(this.value)} to deeply equal ${show(expected)}`, `expected ${show(this.value)} not to deeply equal ${show(expected)}`); }
  above(n: number) { return this.check(Number(this.value) > n, `expected ${show(this.value)} to be above ${n}`, `expected ${show(this.value)} to be at most ${n}`); }
  gt(n: number) { return this.above(n); } greaterThan(n: number) { return this.above(n); }
  below(n: number) { return this.check(Number(this.value) < n, `expected ${show(this.value)} to be below ${n}`, `expected ${show(this.value)} to be at least ${n}`); }
  lt(n: number) { return this.below(n); } lessThan(n: number) { return this.below(n); }
  least(n: number) { return this.check(Number(this.value) >= n, `expected ${show(this.value)} to be at least ${n}`, `expected ${show(this.value)} to be below ${n}`); }
  gte(n: number) { return this.least(n); }
  most(n: number) { return this.check(Number(this.value) <= n, `expected ${show(this.value)} to be at most ${n}`, `expected ${show(this.value)} to be above ${n}`); }
  lte(n: number) { return this.most(n); }
  within(lo: number, hi: number) { const v = Number(this.value); return this.check(v >= lo && v <= hi, `expected ${show(this.value)} to be within ${lo}..${hi}`, `expected ${show(this.value)} not to be within ${lo}..${hi}`); }
  a(type: string) { const t = typeOf(this.value); return this.check(t === type.toLowerCase(), `expected ${show(this.value)} to be a${/^[aeiou]/i.test(type) ? 'n' : ''} ${type} but got ${t}`, `expected ${show(this.value)} not to be a ${type}`); }
  an(type: string) { return this.a(type); }
  instanceOf(ctor: new (...args: never[]) => unknown) { return this.check(this.value instanceof ctor, `expected ${show(this.value)} to be an instance of ${ctor.name}`, `expected ${show(this.value)} not to be an instance of ${ctor.name}`); }
  include(item: unknown) {
    const v = this.value;
    let ok = false;
    if (typeof v === 'string') ok = v.includes(String(item));
    else if (Array.isArray(v)) ok = v.some((x) => (this.deepFlag || (typeof item === 'object' && item !== null) ? deepEqual(x, item) : x === item));
    else if (v && typeof v === 'object' && item && typeof item === 'object') ok = Object.entries(item as object).every(([k, x]) => deepEqual((v as Record<string, unknown>)[k], x));
    return this.check(ok, `expected ${show(v)} to include ${show(item)}`, `expected ${show(v)} not to include ${show(item)}`);
  }
  includes(item: unknown) { return this.include(item); } contain(item: unknown) { return this.include(item); } contains(item: unknown) { return this.include(item); }
  oneOf(list: unknown[]) { return this.check(Array.isArray(list) && list.some((x) => (this.deepFlag ? deepEqual(x, this.value) : x === this.value)), `expected ${show(this.value)} to be one of ${show(list)}`, `expected ${show(this.value)} not to be one of ${show(list)}`); }
  match(re: RegExp) { return this.check(re.test(String(this.value)), `expected ${show(this.value)} to match ${String(re)}`, `expected ${show(this.value)} not to match ${String(re)}`); }
  string(s: string) { return this.check(String(this.value).includes(s), `expected ${show(this.value)} to contain ${show(s)}`, `expected ${show(this.value)} not to contain ${show(s)}`); }
  property(name: string, ...rest: unknown[]) {
    const v = this.value;
    const hit = this.nestedFlag ? getPath(v, name) : { found: v !== null && v !== undefined && typeof v === 'object' && name in (v as object), value: v !== null && v !== undefined ? (v as Record<string, unknown>)[name] : undefined };
    if (rest.length === 0) { this.check(hit.found, `expected ${show(v)} to have property '${name}'`, `expected ${show(v)} not to have property '${name}'`); }
    else {
      const ok = hit.found && (this.deepFlag ? deepEqual(hit.value, rest[0]) : hit.value === rest[0]);
      this.check(ok, `expected ${show(v)} to have property '${name}' of ${show(rest[0])}, but got ${show(hit.value)}`, `expected ${show(v)} not to have property '${name}' of ${show(rest[0])}`);
    }
    if (!this.negate) this.value = hit.value;
    return this;
  }
  keys(...names: unknown[]) {
    const list = (names.length === 1 && Array.isArray(names[0]) ? names[0] : names).map(String);
    const v = this.value && typeof this.value === 'object' ? Object.keys(this.value as object) : [];
    return this.check(list.every((k) => v.includes(k)), `expected ${show(this.value)} to have keys ${show(list)}`, `expected ${show(this.value)} not to have keys ${show(list)}`);
  }
  key(name: string) { return this.keys(name); }
  members(list: unknown[]) {
    const v = Array.isArray(this.value) ? this.value : [];
    return this.check(Array.isArray(list) && list.length === v.length && list.every((x) => v.some((y) => deepEqual(x, y))), `expected ${show(this.value)} to have the same members as ${show(list)}`, `expected ${show(this.value)} not to have the same members as ${show(list)}`);
  }
  lengthOf(n: number) {
    const v = this.value as { length?: unknown } | null;
    const len = v && (typeof v === 'string' || Array.isArray(v)) ? v.length : typeof v === 'object' && v ? Object.keys(v).length : undefined;
    return this.check(len === n, `expected ${show(this.value)} to have a length of ${n} but got ${String(len)}`, `expected ${show(this.value)} not to have a length of ${n}`);
  }
  length(n: number) { return this.lengthOf(n); }
  satisfy(fn: (v: unknown) => boolean) { return this.check(!!fn(this.value), `expected ${show(this.value)} to satisfy the function`, `expected ${show(this.value)} not to satisfy the function`); }
  throw(match?: string | RegExp) {
    let thrown: unknown = null, did = false;
    try { (this.value as () => unknown)(); } catch (e) { did = true; thrown = e; }
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    const ok = did && (match === undefined || (typeof match === 'string' ? msg.includes(match) : match.test(msg)));
    return this.check(ok, `expected function to throw${match ? ` ${String(match)}` : ''}`, 'expected function not to throw');
  }
  // response helpers: pm.response.to.have.status(200), .header('Content-Type'), .body('x'), .jsonBody('a.b', 1), .responseTime.below(500)
  status(expected: number | string) {
    const r = this.res;
    if (!r) throw new AssertionError('.status() only works on pm.response');
    const st = (r as unknown as { status: string }).status;
    const ok = typeof expected === 'number' ? r.code === expected : st.toLowerCase() === String(expected).toLowerCase();
    return this.check(ok, `expected response to have status ${typeof expected === 'number' ? 'code ' : ''}${show(expected)} but got ${typeof expected === 'number' ? r.code : show(st)}`, `expected response not to have status ${show(expected)}`);
  }
  header(name: string, value?: string) {
    const r = this.res;
    if (!r) throw new AssertionError('.header() only works on pm.response');
    const got = r.headers.get(name);
    const ok = value === undefined ? r.headers.has(name) : got === value;
    return this.check(ok, value === undefined ? `expected response to have header ${name}` : `expected response header ${name} to be ${show(value)} but got ${show(got)}`, `expected response not to have header ${name}${value === undefined ? '' : ` with value ${show(value)}`}`);
  }
  body(expected?: unknown) {
    const r = this.res;
    if (!r) throw new AssertionError('.body() only works on pm.response');
    const text = r.text();
    let ok: boolean;
    if (expected === undefined) ok = text.length > 0;
    else if (typeof expected === 'string') ok = text === expected;
    else { try { ok = deepEqual(JSON.parse(text), expected); } catch { ok = false; } }
    return this.check(ok, expected === undefined ? 'expected response to have a body' : `expected response body to equal ${show(expected)}`, 'expected response body not to match');
  }
  jsonBody(path?: string, ...rest: unknown[]) {
    const r = this.res;
    if (!r) throw new AssertionError('.jsonBody() only works on pm.response');
    let data: unknown;
    try { data = r.json(); } catch { return this.check(false, 'expected response body to be JSON', 'expected response body not to be JSON'); }
    if (path === undefined) return this.check(true, '', 'expected response body not to be JSON');
    const hit = getPath(data, path);
    const ok = hit.found && (rest.length === 0 || deepEqual(hit.value, rest[0]));
    return this.check(ok, rest.length ? `expected JSON body to have ${path} = ${show(rest[0])} but got ${show(hit.value)}` : `expected JSON body to have ${path}`, `expected JSON body not to have ${path}`);
  }
}

export const expect = (value: unknown): Assertion => new Assertion(value);

/* ---------------- the pm object ---------------- */

const cloneScopes = (s: ScriptScopes): ScriptScopes => ({ globals: { ...s.globals }, collection: { ...s.collection }, environment: { ...s.environment }, local: { ...s.local } });
const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const own = (o: Record<string, string>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function scopeApi(store: Record<string, string>, resolve: (t: string) => string, onWrite?: () => boolean) {
  return {
    get: (k: string) => (own(store, k) ? store[k] : undefined),
    set: (k: string, v: unknown) => { if (onWrite && !onWrite()) return; store[String(k)] = asText(v); },
    unset: (k: string) => { if (onWrite && !onWrite()) return; delete store[k]; },
    has: (k: string) => own(store, k),
    clear: () => { if (onWrite && !onWrite()) return; for (const k of Object.keys(store)) delete store[k]; },
    toObject: () => ({ ...store }),
    replaceIn: (t: string) => resolve(String(t)),
  };
}
function headerList(list: Array<{ key: string; value: string; enabled?: boolean }>, writable: boolean) {
  const find = (k: string) => list.findIndex((h) => h.enabled !== false && h.key.toLowerCase() === String(k).toLowerCase());
  const pair = (h: unknown, v?: unknown): { key: string; value: string } => (typeof h === 'string' ? (v === undefined && h.includes(':') ? { key: h.slice(0, h.indexOf(':')).trim(), value: h.slice(h.indexOf(':') + 1).trim() } : { key: h, value: asText(v) }) : { key: String((h as { key?: unknown })?.key ?? ''), value: asText((h as { value?: unknown })?.value) });
  const ro = () => { if (!writable) throw new Error('response headers cannot be changed'); };
  return {
    get: (k: string) => { const i = find(k); return i < 0 ? undefined : list[i].value; },
    has: (k: string) => find(k) >= 0,
    add: (h: unknown, v?: unknown) => { ro(); list.push({ ...pair(h, v), enabled: true }); },
    upsert: (h: unknown, v?: unknown) => { ro(); const p = pair(h, v); const i = find(p.key); if (i >= 0) list[i] = { ...list[i], value: p.value }; else list.push({ ...p, enabled: true }); },
    remove: (k: string) => { ro(); for (let i = list.length - 1; i >= 0; i--) if (list[i].key.toLowerCase() === String(k).toLowerCase()) list.splice(i, 1); },
    toObject: () => { const o: Record<string, string> = {}; for (const h of list) if (h.enabled !== false) o[h.key.toLowerCase()] = h.value; return o; },
    each: (fn: (h: { key: string; value: string }) => void) => { for (const h of list) if (h.enabled !== false) fn({ key: h.key, value: h.value }); },
    all: () => list.filter((h) => h.enabled !== false).map((h) => ({ key: h.key, value: h.value })),
    count: () => list.filter((h) => h.enabled !== false).length,
  };
}

/** Names that scripts must not reach. They are passed as `undefined` parameters, shadowing the real globals. */
const SHADOWED = ['window', 'self', 'globalThis', 'global', 'document', 'parent', 'top', 'frames', 'opener', 'location', 'navigator', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'BroadcastChannel', 'Worker', 'SharedWorker', 'importScripts', 'postMessage', 'close', 'process', 'require', 'module', 'exports', 'Deno', 'Bun',
  '__TAURI_INTERNALS__', '__TAURI__', 'Function', 'setInterval', 'WebAssembly'];

const MAX_LOGS = 500;

/** Runs one script. Never throws: a failure is returned as `error` (tests that ran before it are kept). */
export async function runScript(input: ScriptInput): Promise<ScriptOutput> {
  const scopes = cloneScopes(input.scopes);
  const request: ScriptRequest = { method: input.request.method, url: input.request.url, headers: input.request.headers.map((h) => ({ ...h })), body: { ...input.request.body } };
  const tests: TestResult[] = [];
  const logs: ScriptLog[] = [];
  const pending: Array<Promise<void>> = [];
  let nextRequest: string | null | undefined;
  const resolve = (t: string): string => t.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => {
    for (const s of [scopes.local, scopes.environment, scopes.collection, scopes.globals]) if (own(s, name.trim())) return s[name.trim()];
    return whole;
  });
  const log = (level: ScriptLog['level']) => (...args: unknown[]) => { if (logs.length < MAX_LOGS) logs.push({ level, text: args.map((a) => (typeof a === 'string' ? a : show(a))).join(' ') }); };
  const console = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('log') };
  const envWritable = () => { if (input.hasEnvironment === false) { log('warn')('pm.environment: no environment is selected, so the value was not saved'); return false; } return true; };

  const res = input.response;
  const resHeaders = res ? headerList(res.headers.map((h) => ({ ...h })), false) : null;
  const response = res ? {
    [RESPONSE]: true,
    code: res.code, status: res.status, responseTime: res.responseTime, responseSize: res.responseSize,
    headers: resHeaders!,
    text: () => res.body,
    json: () => { try { return JSON.parse(res.body) as unknown; } catch (e) { throw new Error(`JSONError: the response body is not valid JSON (${e instanceof Error ? e.message : String(e)})`); } },
    cookies: { get: (n: string) => res.cookies.find((c) => c.name === n)?.value, has: (n: string) => res.cookies.some((c) => c.name === n), toObject: () => Object.fromEntries(res.cookies.map((c) => [c.name, c.value])) },
    get to() { return expect(this).to; },
  } : undefined;

  const urlApi = {
    toString: () => request.url,
    getHost: () => /^[a-z]+:\/\/([^/?#:]+)/i.exec(request.url)?.[1] ?? '',
    getPath: () => (/^[a-z]+:\/\/[^/?#]+([^?#]*)/i.exec(request.url)?.[1] || '/'),
    getQueryString: () => { const q = request.url.indexOf('?'); return q < 0 ? '' : request.url.slice(q + 1).split('#')[0]; },
    query: {
      get: (k: string) => { const q = urlApi.getQueryString(); for (const p of q ? q.split('&') : []) { const [a, b = ''] = p.split('='); if (a === k) return b; } return undefined; },
      add: (p: string | { key: string; value?: string }) => { const s = typeof p === 'string' ? p : `${p.key}=${p.value ?? ''}`; const [base, hash = ''] = request.url.split('#'); request.url = `${base}${base.includes('?') ? '&' : '?'}${s}${hash ? `#${hash}` : ''}`; },
      remove: (k: string) => { const [base, hash = ''] = request.url.split('#'); const q = base.indexOf('?'); if (q < 0) return; const kept = base.slice(q + 1).split('&').filter((p) => p.split('=')[0] !== k); request.url = `${base.slice(0, q)}${kept.length ? `?${kept.join('&')}` : ''}${hash ? `#${hash}` : ''}`; },
      upsert: (p: { key: string; value?: string }) => { urlApi.query.remove(p.key); urlApi.query.add(p); },
    },
  };
  const pmRequest = {
    get url() { return urlApi; },
    set url(v: unknown) { request.url = asText(v); },
    get method() { return request.method; },
    set method(v: unknown) { request.method = asText(v).toUpperCase(); },
    headers: headerList(request.headers, input.event === 'prerequest'),
    body: {
      get mode() { return request.body.mode; },
      get raw() { return request.body.raw; },
      set raw(v: unknown) { request.body.raw = asText(v); if (request.body.mode === 'none') request.body.mode = 'raw'; },
      update: (v: unknown) => { request.body.raw = asText(v); if (request.body.mode === 'none') request.body.mode = 'raw'; },
      toString: () => request.body.raw,
    },
    addHeader: (h: unknown) => pmRequest.headers.add(h),
    removeHeader: (k: string) => pmRequest.headers.remove(k),
  };

  const variables = {
    get: (k: string) => { for (const s of [scopes.local, scopes.environment, scopes.collection, scopes.globals]) if (own(s, k)) return s[k]; return undefined; },
    set: (k: string, v: unknown) => { scopes.local[String(k)] = asText(v); },
    unset: (k: string) => { delete scopes.local[k]; },
    has: (k: string) => [scopes.local, scopes.environment, scopes.collection, scopes.globals].some((s) => own(s, k)),
    replaceIn: (t: string) => resolve(String(t)),
    toObject: () => ({ ...scopes.globals, ...scopes.collection, ...scopes.environment, ...scopes.local }),
  };
  const record = (name: string, fn?: () => unknown, skipped = false) => {
    const entry: TestResult = { name: String(name), passed: true, ...(skipped ? { skipped: true } : {}) };
    tests.push(entry);
    if (skipped || typeof fn !== 'function') return;
    const fail = (e: unknown) => { entry.passed = false; entry.error = e instanceof Error ? `${e.name === 'AssertionError' ? 'AssertionError' : e.name}: ${e.message}` : String(e); };
    try {
      const out = fn();
      if (out && typeof (out as Promise<unknown>).then === 'function') pending.push((out as Promise<unknown>).then(() => undefined, fail));
    } catch (e) { fail(e); }
  };
  const test = Object.assign((name: string, fn: () => unknown) => record(name, fn), { skip: (name: string) => record(name, undefined, true) });

  const pm = {
    info: { eventName: input.event, requestName: input.info?.requestName ?? '', requestId: input.info?.requestId ?? '', iteration: input.info?.iteration ?? 0, iterationCount: input.info?.iterationCount ?? 1 },
    environment: { ...scopeApi(scopes.environment, resolve, envWritable), name: '' },
    collectionVariables: scopeApi(scopes.collection, resolve),
    globals: scopeApi(scopes.globals, resolve),
    variables,
    iterationData: { get: () => undefined, has: () => false, toObject: () => ({}) },
    request: pmRequest,
    response,
    cookies: { get: (n: string) => response?.cookies.get(n), has: (n: string) => !!response?.cookies.has(n), toObject: () => response?.cookies.toObject() ?? {} },
    test,
    expect,
    setNextRequest: (name: string | null) => { nextRequest = name; },
    execution: { setNextRequest: (name: string | null) => { nextRequest = name; }, skipRequest: () => { nextRequest = undefined; throw new Error('pm.execution.skipRequest() is not supported'); } },
    sendRequest: () => { throw new Error('pm.sendRequest is not available in Pigry scripts (scripts have no network access)'); },
    require: (name: string) => { throw new Error(`require('${name}') is not available in Pigry scripts`); },
  };
  // legacy Postman globals
  const legacyTests: Record<string, unknown> = {};
  const postman = {
    setEnvironmentVariable: (k: string, v: unknown) => pm.environment.set(k, v), getEnvironmentVariable: (k: string) => pm.environment.get(k), clearEnvironmentVariable: (k: string) => pm.environment.unset(k),
    setGlobalVariable: (k: string, v: unknown) => pm.globals.set(k, v), getGlobalVariable: (k: string) => pm.globals.get(k), clearGlobalVariable: (k: string) => pm.globals.unset(k),
    setNextRequest: (n: string | null) => pm.setNextRequest(n),
  };
  const responseHeaders = res ? Object.fromEntries(res.headers.map((h) => [h.key, h.value])) : {};

  let error: string | undefined;
  const timer = (fn: unknown, ms?: number, ...args: unknown[]) => (typeof fn === 'function' ? setTimeout(fn as () => void, ms, ...args) : undefined);
  try {
    if (/\bimport\s*\(|\bimport\.meta\b|^\s*import\s|^\s*export\s/m.test(input.code)) throw new Error('import and export are not available in Pigry scripts');
    const names = ['setTimeout', 'pm', 'console', 'tests', 'postman', 'responseBody', 'responseCode', 'responseTime', 'responseHeaders', 'request', 'environment', 'globals', ...SHADOWED];
    const values: unknown[] = [timer, pm, console, legacyTests, postman, res?.body ?? '', res ? { code: res.code, name: res.status, detail: res.status } : undefined, res?.responseTime ?? 0, responseHeaders,
      { url: request.url, method: request.method, headers: Object.fromEntries(request.headers.map((h) => [h.key, h.value])), data: request.body.raw }, { ...scopes.environment }, { ...scopes.globals }, ...SHADOWED.map(() => undefined)];
    const fn = new Function(...names, `"use strict";\nreturn (async () => {\n${input.code}\n})();`) as (...args: unknown[]) => Promise<unknown>;
    await fn(...values);
    await Promise.all(pending);
  } catch (e) {
    await Promise.all(pending).catch(() => undefined);
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  for (const [name, value] of Object.entries(legacyTests)) tests.push({ name, passed: !!value, ...(value ? {} : { error: 'the test expression was false' }) });
  return { tests, logs, error, request, scopes, ...(nextRequest !== undefined ? { nextRequest } : {}) };
}

/** Starter snippets shown next to the script editors (like Postman's "Snippets" list). */
export const SNIPPETS: Array<{ label: string; event: 'prerequest' | 'test' | 'both'; code: string }> = [
  { label: 'Status code is 200', event: 'test', code: 'pm.test("Status code is 200", () => {\n  pm.response.to.have.status(200);\n});' },
  { label: 'Response time is less than 500 ms', event: 'test', code: 'pm.test("Response time is less than 500 ms", () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});' },
  { label: 'Body is JSON with a property', event: 'test', code: 'pm.test("Body has an id", () => {\n  const data = pm.response.json();\n  pm.expect(data).to.have.property("id");\n});' },
  { label: 'Body contains a string', event: 'test', code: 'pm.test("Body contains text", () => {\n  pm.expect(pm.response.text()).to.include("ok");\n});' },
  { label: 'Content-Type header is present', event: 'test', code: 'pm.test("Content-Type is present", () => {\n  pm.response.to.have.header("Content-Type");\n});' },
  { label: 'Save a value from the body to the environment', event: 'test', code: 'const data = pm.response.json();\npm.environment.set("token", data.token);' },
  { label: 'Set an environment variable', event: 'both', code: 'pm.environment.set("variable_key", "variable_value");' },
  { label: 'Get an environment variable', event: 'both', code: 'pm.environment.get("variable_key");' },
  { label: 'Set a collection variable', event: 'both', code: 'pm.collectionVariables.set("variable_key", "variable_value");' },
  { label: 'Set a global variable', event: 'both', code: 'pm.globals.set("variable_key", "variable_value");' },
  { label: 'Add a header to the request', event: 'prerequest', code: 'pm.request.headers.add({ key: "X-Request-Id", value: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) });' },
  { label: 'Timestamp variable', event: 'prerequest', code: 'pm.variables.set("now", new Date().toISOString());' },
];
