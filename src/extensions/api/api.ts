/** RESTful API model (a Postman-style API client): a collection file holds folders and saved requests, collection
 * variables, auth and scripts; environments are files of variables. This module also builds the HTTP request that goes
 * out (variables, auth inheritance, params ⇄ URL, path variables, bodies, cookies). Pure — node tests import it. */

export const API_DIR = '.pigry/apis/';
export const API_EXT = '.api.json';
export const ENV_EXT = '.env.json';
/** Global variables are the environment file user/globals.env.json; it is not listed as an environment. */
export const GLOBALS_SLUG = 'globals';
/** Local, git-ignored state: secret values, history and the cookie jar. */
export const LOCAL_DIR = '.pigry/cache/apis/';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type Method = (typeof METHODS)[number];
export const RAW_LANGUAGES = ['json', 'text', 'xml', 'html', 'javascript'] as const;
export type RawLanguage = (typeof RAW_LANGUAGES)[number];
export const RAW_TYPES: Record<RawLanguage, string> = { json: 'application/json', text: 'text/plain', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript' };
export const BODY_MODES = ['none', 'raw', 'formdata', 'urlencoded', 'binary'] as const;
export type BodyMode = (typeof BODY_MODES)[number];
export const AUTH_TYPES = ['inherit', 'none', 'bearer', 'basic', 'apikey'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export interface KV { id: string; key: string; value: string; enabled: boolean; description?: string }
export interface FormField extends KV { type: 'text' | 'file'; fileName?: string; src?: string }
export interface Variable { id: string; key: string; value: string; enabled: boolean; secret?: boolean; description?: string }
export interface Auth { type: AuthType; token?: string; username?: string; password?: string; key?: string; value?: string; in?: 'header' | 'query' }
export interface BinaryFile { name: string; src: string }
export interface Body { mode: BodyMode; raw: string; language: RawLanguage; formdata: FormField[]; urlencoded: KV[]; file: BinaryFile | null }
export interface RequestSettings { timeoutMs: number; followRedirects: boolean; verifyTls: boolean }
export interface ApiRequest {
  id: string; type: 'request'; name: string; description: string; method: string; url: string;
  params: KV[]; pathVars: KV[]; headers: KV[]; auth: Auth; body: Body; preRequest: string; tests: string; settings: RequestSettings;
}
export interface ApiFolder { id: string; type: 'folder'; name: string; description: string; auth: Auth; preRequest: string; tests: string; items: ApiItem[] }
export type ApiItem = ApiRequest | ApiFolder;
export interface Collection { version: 1; name: string; description: string; auth: Auth; variables: Variable[]; preRequest: string; tests: string; items: ApiItem[] }
export interface Environment { version: 1; name: string; values: Variable[] }

let idCounter = 0;
export const newId = (prefix = 'r'): string => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const newKV = (key = '', value = '', enabled = true, description?: string): KV => ({ id: newId('k'), key, value, enabled, ...(description ? { description } : {}) });
export const newVariable = (key = '', value = '', secret = false): Variable => ({ id: newId('v'), key, value, enabled: true, ...(secret ? { secret: true } : {}) });
export const emptyBody = (): Body => ({ mode: 'none', raw: '', language: 'json', formdata: [], urlencoded: [], file: null });
export const defaultSettings = (): RequestSettings => ({ timeoutMs: 0, followRedirects: true, verifyTls: true });

export function newRequest(patch: Partial<ApiRequest> = {}): ApiRequest {
  return {
    id: newId('r'), type: 'request', name: 'New Request', description: '', method: 'GET', url: '', params: [], pathVars: [], headers: [],
    auth: { type: 'inherit' }, body: emptyBody(), preRequest: '', tests: '', settings: defaultSettings(), ...patch,
  };
}
export const newFolder = (name = 'New Folder', patch: Partial<ApiFolder> = {}): ApiFolder => ({ id: newId('f'), type: 'folder', name, description: '', auth: { type: 'inherit' }, preRequest: '', tests: '', items: [], ...patch });
export const emptyCollection = (name = 'New Collection'): Collection => ({ version: 1, name, description: '', auth: { type: 'none' }, variables: [], preRequest: '', tests: '', items: [] });
export const emptyEnvironment = (name = 'New Environment'): Environment => ({ version: 1, name, values: [] });

/* ---------------- normalize / parse / serialize ---------------- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 1_000_000): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback);

export interface NormalizeResult<T> { value: T; warnings: string[] }

function normKVs(input: unknown, seen: Set<string>): KV[] {
  if (!Array.isArray(input)) return [];
  return input.filter(isObj).map((x) => {
    let id = str(x.id, 60);
    if (!id || seen.has(id)) id = newId('k');
    seen.add(id);
    return { id, key: str(x.key, 10_000), value: str(x.value), enabled: bool(x.enabled, true), ...(str(x.description) ? { description: str(x.description, 4000) } : {}) };
  });
}
function normForm(input: unknown, seen: Set<string>): FormField[] {
  if (!Array.isArray(input)) return [];
  return input.filter(isObj).map((x) => {
    const kv = normKVs([x], seen)[0];
    const type = x.type === 'file' ? 'file' : 'text';
    return { ...kv, type, ...(type === 'file' && str(x.fileName) ? { fileName: str(x.fileName, 500) } : {}), ...(type === 'file' && str(x.src) ? { src: str(x.src, 200_000_000) } : {}) };
  });
}
function normVars(input: unknown, seen: Set<string>): Variable[] {
  if (!Array.isArray(input)) return [];
  return input.filter(isObj).map((x) => {
    let id = str(x.id, 60);
    if (!id || seen.has(id)) id = newId('v');
    seen.add(id);
    return { id, key: str(x.key, 10_000), value: str(x.value), enabled: bool(x.enabled, true), ...(x.secret === true ? { secret: true } : {}), ...(str(x.description) ? { description: str(x.description, 4000) } : {}) };
  });
}
export function normAuth(input: unknown, allowInherit: boolean): Auth {
  const x = isObj(input) ? input : {};
  const type = oneOf(x.type, AUTH_TYPES, allowInherit ? 'inherit' : 'none');
  const t: AuthType = !allowInherit && type === 'inherit' ? 'none' : type;
  switch (t) {
    case 'bearer': return { type: t, token: str(x.token) };
    case 'basic': return { type: t, username: str(x.username), password: str(x.password) };
    case 'apikey': return { type: t, key: str(x.key), value: str(x.value), in: x.in === 'query' ? 'query' : 'header' };
    default: return { type: t };
  }
}
function normBody(input: unknown, seen: Set<string>): Body {
  const x = isObj(input) ? input : {};
  const file = isObj(x.file) && str(x.file.src) ? { name: str(x.file.name, 500) || 'file', src: str(x.file.src, 200_000_000) } : null;
  return { mode: oneOf(x.mode, BODY_MODES, 'none'), raw: str(x.raw, 50_000_000), language: oneOf(x.language, RAW_LANGUAGES, 'json'), formdata: normForm(x.formdata, seen), urlencoded: normKVs(x.urlencoded, seen), file };
}
function normItems(input: unknown, seen: Set<string>, warnings: string[], depth: number): ApiItem[] {
  if (!Array.isArray(input)) return [];
  const out: ApiItem[] = [];
  for (const raw of input) {
    if (!isObj(raw)) { warnings.push('dropped an item that is not an object'); continue; }
    let id = str(raw.id, 60);
    if (!id || seen.has(id)) { if (id) warnings.push(`gave a new id to duplicate item ${id}`); id = newId(raw.type === 'folder' ? 'f' : 'r'); }
    seen.add(id);
    if (raw.type === 'folder' || (Array.isArray(raw.items) && raw.type !== 'request')) {
      if (depth > 30) { warnings.push('dropped folders nested more than 30 deep'); continue; }
      out.push({ id, type: 'folder', name: str(raw.name, 500) || 'Folder', description: str(raw.description, 100_000), auth: normAuth(raw.auth, true), preRequest: str(raw.preRequest, 500_000), tests: str(raw.tests, 500_000), items: normItems(raw.items, seen, warnings, depth + 1) });
    } else {
      const s = isObj(raw.settings) ? raw.settings : {};
      const timeout = typeof s.timeoutMs === 'number' && Number.isFinite(s.timeoutMs) ? Math.max(0, Math.min(600_000, Math.round(s.timeoutMs))) : 0;
      out.push({
        id, type: 'request', name: str(raw.name, 500) || 'Request', description: str(raw.description, 100_000), method: (str(raw.method, 24).toUpperCase() || 'GET').replace(/[^A-Z_-]/g, '') || 'GET',
        url: str(raw.url, 100_000), params: normKVs(raw.params, seen), pathVars: normKVs(raw.pathVars, seen), headers: normKVs(raw.headers, seen), auth: normAuth(raw.auth, true),
        body: normBody(raw.body, seen), preRequest: str(raw.preRequest, 500_000), tests: str(raw.tests, 500_000),
        settings: { timeoutMs: timeout, followRedirects: bool(s.followRedirects, true), verifyTls: bool(s.verifyTls, true) },
      });
    }
  }
  return out;
}

export function normalizeCollection(input: unknown, fallbackName = 'Collection'): NormalizeResult<Collection> {
  const warnings: string[] = [];
  const x = isObj(input) ? input : {};
  if (!isObj(input)) warnings.push('the file was not a collection object; started an empty one');
  const seen = new Set<string>();
  return {
    value: { version: 1, name: str(x.name, 500) || fallbackName, description: str(x.description, 200_000), auth: normAuth(x.auth, false), variables: normVars(x.variables, seen), preRequest: str(x.preRequest, 500_000), tests: str(x.tests, 500_000), items: normItems(x.items, seen, warnings, 0) },
    warnings,
  };
}
export function normalizeEnvironment(input: unknown, fallbackName = 'Environment'): NormalizeResult<Environment> {
  const x = isObj(input) ? input : {};
  return { value: { version: 1, name: str(x.name, 500) || fallbackName, values: normVars(x.values, new Set()) }, warnings: isObj(input) ? [] : ['the file was not an environment object'] };
}
const parseJson = (text: string): { value?: unknown; error?: string } => { try { return { value: JSON.parse(text) as unknown }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } };
export function parseCollectionJson(text: string, fallbackName = 'Collection'): NormalizeResult<Collection> {
  const p = parseJson(text);
  if (p.error) { const r = normalizeCollection({}, fallbackName); r.warnings.unshift(`the file is not valid JSON (${p.error})`); return r; }
  return normalizeCollection(p.value, fallbackName);
}
export function parseEnvironmentJson(text: string, fallbackName = 'Environment'): NormalizeResult<Environment> {
  const p = parseJson(text);
  if (p.error) return { value: emptyEnvironment(fallbackName), warnings: [`the file is not valid JSON (${p.error})`] };
  return normalizeEnvironment(p.value, fallbackName);
}
export const serializeCollection = (c: Collection): string => `${JSON.stringify(c, null, 2)}\n`;
export const serializeEnvironment = (e: Environment): string => `${JSON.stringify(e, null, 2)}\n`;

/* ---------------- secrets: kept out of git ---------------- */

/** The variables marked secret, as key → value, and a copy whose secret values are blank (what goes into git). */
export function splitSecrets(vars: Variable[]): { pub: Variable[]; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const pub = vars.map((v) => { if (!v.secret) return v; if (v.value) secrets[v.key] = v.value; return { ...v, value: '' }; });
  return { pub, secrets };
}
export const mergeSecrets = (vars: Variable[], secrets: Record<string, string> | undefined): Variable[] =>
  vars.map((v) => (v.secret && secrets && typeof secrets[v.key] === 'string' ? { ...v, value: secrets[v.key] } : v));

/* ---------------- the item tree ---------------- */

export interface Found { item: ApiItem; parent: ApiFolder | null; index: number; folders: ApiFolder[] }

export function* walk(items: ApiItem[], folders: ApiFolder[] = []): Generator<Found> {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    yield { item, parent: folders.length ? folders[folders.length - 1] : null, index: i, folders };
    if (item.type === 'folder') yield* walk(item.items, [...folders, item]);
  }
}
export const findItem = (c: Collection, id: string): Found | null => { for (const f of walk(c.items)) if (f.item.id === id) return f; return null; };
export const listRequests = (c: Collection): Array<{ request: ApiRequest; folders: ApiFolder[] }> => [...walk(c.items)].filter((f) => f.item.type === 'request').map((f) => ({ request: f.item as ApiRequest, folders: f.folders }));
export const itemPath = (f: Found): string => [...f.folders.map((x) => x.name), f.item.name].join(' / ');
const childrenOf = (c: Collection, parentId: string | null | undefined): ApiItem[] | null => {
  if (!parentId) return c.items;
  const f = findItem(c, parentId);
  return f && f.item.type === 'folder' ? f.item.items : null;
};

/** Finds an item by id, by "Folder / Request" path or by a unique name (case-insensitive). */
export function lookupItem(c: Collection, ref: unknown): Found | null {
  const text = String(ref ?? '').trim();
  if (!text) return null;
  const byId = findItem(c, text);
  if (byId) return byId;
  const all = [...walk(c.items)];
  const lower = text.toLowerCase();
  const byPath = all.filter((f) => itemPath(f).toLowerCase() === lower || [...f.folders.map((x) => x.name), f.item.name].join('/').toLowerCase() === lower);
  if (byPath.length === 1) return byPath[0];
  const byName = all.filter((f) => f.item.name.toLowerCase() === lower);
  return byName.length === 1 ? byName[0] : null;
}

export function addItem(c: Collection, item: ApiItem, parentId?: string | null, index?: number): void {
  const list = childrenOf(c, parentId);
  if (!list) throw new Error(`no folder "${parentId}"`);
  const at = index === undefined || index < 0 || index > list.length ? list.length : index;
  list.splice(at, 0, item);
}
export function removeItem(c: Collection, id: string): ApiItem | null {
  const f = findItem(c, id);
  if (!f) return null;
  (f.parent ? f.parent.items : c.items).splice(f.index, 1);
  return f.item;
}
/** Gives every request, folder and row in a copied item fresh ids. */
export function reId(item: ApiItem): ApiItem {
  const kv = <T extends KV>(list: T[]): T[] => list.map((x) => ({ ...x, id: newId('k') }));
  if (item.type === 'folder') return { ...item, id: newId('f'), items: item.items.map(reId) };
  return { ...item, id: newId('r'), params: kv(item.params), pathVars: kv(item.pathVars), headers: kv(item.headers), body: { ...item.body, formdata: kv(item.body.formdata), urlencoded: kv(item.body.urlencoded) } };
}
export function duplicateItem(c: Collection, id: string): ApiItem | null {
  const f = findItem(c, id);
  if (!f) return null;
  const copy = reId(clone(f.item));
  copy.name = `${f.item.name} Copy`;
  (f.parent ? f.parent.items : c.items).splice(f.index + 1, 0, copy);
  return copy;
}
const contains = (folder: ApiItem, id: string): boolean => folder.type === 'folder' && folder.items.some((x) => x.id === id || contains(x, id));
/** Moves an item before or after another item, or inside a folder (at the end), or to the top level (target null). */
export function moveItem(c: Collection, id: string, targetId: string | null, position: 'before' | 'after' | 'inside'): boolean {
  if (id === targetId) return false;
  const f = findItem(c, id);
  if (!f) return false;
  if (targetId && contains(f.item, targetId)) return false;
  if (targetId === null) { removeItem(c, id); c.items.push(f.item); return true; }
  const t = findItem(c, targetId);
  if (!t) return false;
  if (position === 'inside') {
    if (t.item.type !== 'folder') return false;
    removeItem(c, id);
    t.item.items.push(f.item);
    return true;
  }
  removeItem(c, id);
  const again = findItem(c, targetId)!;
  (again.parent ? again.parent.items : c.items).splice(again.index + (position === 'after' ? 1 : 0), 0, f.item);
  return true;
}

/* ---------------- URL, query params and path variables ---------------- */

export function splitUrl(url: string): { base: string; query: string; hash: string } {
  let rest = url;
  let hash = '';
  const h = rest.indexOf('#');
  if (h >= 0) { hash = rest.slice(h); rest = rest.slice(0, h); }
  const q = rest.indexOf('?');
  return q < 0 ? { base: rest, query: '', hash } : { base: rest.slice(0, q), query: rest.slice(q + 1), hash };
}
/** "a=1&b&c=x=y" → rows, as written (not decoded) so {{vars}} and encodings survive the round trip. */
export function parseQuery(query: string): Array<{ key: string; value: string }> {
  if (!query) return [];
  return query.split('&').filter((p, i, all) => p !== '' || (i < all.length - 1)).map((part) => {
    const eq = part.indexOf('=');
    return eq < 0 ? { key: part, value: '' } : { key: part.slice(0, eq), value: part.slice(eq + 1) };
  });
}
const queryOf = (params: Array<{ key: string; value: string; enabled?: boolean }>): string =>
  params.filter((p) => p.enabled !== false && (p.key || p.value)).map((p) => (p.value === '' && !p.key.includes('=') ? p.key : `${p.key}=${p.value}`)).join('&');

/** The URL with its query string rebuilt from the enabled params. */
export function urlWithParams(url: string, params: KV[]): string {
  const { base, hash } = splitUrl(url);
  const q = queryOf(params);
  return `${base}${q ? `?${q}` : ''}${hash}`;
}
/** The params table after the URL was typed: rows from the query string (reusing ids and descriptions), disabled rows kept. */
export function paramsFromUrl(url: string, previous: KV[]): KV[] {
  const parsed = parseQuery(splitUrl(url).query);
  const enabled = previous.filter((p) => p.enabled);
  const out: KV[] = parsed.map((p, i) => {
    const old = enabled[i];
    return old ? { ...old, key: p.key, value: p.value } : newKV(p.key, p.value);
  });
  return [...out, ...previous.filter((p) => !p.enabled)];
}
/** `:name` segments of the URL's path (not the port, not inside {{…}}). */
export function pathVarNames(url: string): string[] {
  const { base } = splitUrl(url);
  const withoutScheme = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/\{\{[^}]*\}\}/g, '');
  const names: string[] = [];
  for (const m of withoutScheme.matchAll(/\/:([A-Za-z_][\w-]*)/g)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}
export function syncPathVars(url: string, previous: KV[]): KV[] {
  return pathVarNames(url).map((name) => previous.find((p) => p.key === name) ?? newKV(name, ''));
}
/** Sets the URL and keeps params and path variables in step with it. */
export function setRequestUrl(r: ApiRequest, url: string): void {
  r.url = url;
  r.params = paramsFromUrl(url, r.params);
  r.pathVars = syncPathVars(url, r.pathVars);
}
/** Sets the params and rewrites the URL's query string from them. */
export function setRequestParams(r: ApiRequest, params: KV[]): void {
  r.params = params;
  r.url = urlWithParams(r.url, params);
}

/* ---------------- variables ---------------- */

export type VarScopeName = 'local' | 'environment' | 'collection' | 'globals';
export interface VarScopes { globals: Record<string, string>; collection: Record<string, string>; environment: Record<string, string>; local: Record<string, string> }
export const emptyScopes = (): VarScopes => ({ globals: {}, collection: {}, environment: {}, local: {} });
export const varsToMap = (vars: Variable[]): Record<string, string> => { const out: Record<string, string> = {}; for (const v of vars) if (v.enabled && v.key) out[v.key] = v.value; return out; };
const ORDER: VarScopeName[] = ['local', 'environment', 'collection', 'globals'];
const has = (o: Record<string, string>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The value of a variable and the scope it came from (local beats environment beats collection beats globals). */
export function lookupVar(scopes: VarScopes, name: string): { value: string; scope: VarScopeName } | null {
  for (const s of ORDER) if (has(scopes[s], name)) return { value: scopes[s][name], scope: s };
  return null;
}

const HEX = '0123456789abcdef';
const rand = (n: number): number => Math.floor(Math.random() * n);
export const uuid = (): string => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => HEX[c === 'x' ? rand(16) : (rand(4) + 8)]);
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'nova', 'orbit', 'pixel', 'quartz', 'river', 'sierra'];
/** Postman-style dynamic variables: {{$guid}}, {{$timestamp}}, … */
export const DYNAMIC_VARS: Record<string, () => string> = {
  $guid: uuid, $randomUUID: uuid,
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(rand(1001)),
  $randomAlphaNumeric: () => 'abcdefghijklmnopqrstuvwxyz0123456789'[rand(36)],
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomEmail: () => `${WORDS[rand(WORDS.length)]}${rand(1000)}@example.com`,
  $randomUserName: () => `${WORDS[rand(WORDS.length)]}_${rand(1000)}`,
  $randomFirstName: () => ['Ada', 'Grace', 'Alan', 'Linus', 'Somchai', 'Malee'][rand(6)],
  $randomWord: () => WORDS[rand(WORDS.length)],
};

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** Replaces {{name}} (nested up to 5 levels deep). Unknown variables stay as written. */
export function resolveVars(text: string, scopes: VarScopes, missing?: Set<string>): string {
  if (!text || !text.includes('{{')) return text;
  let out = text;
  for (let pass = 0; pass < 5 && out.includes('{{'); pass++) {
    let changed = false;
    out = out.replace(VAR_RE, (whole, raw: string) => {
      const name = raw.trim();
      const hit = lookupVar(scopes, name);
      if (hit) { changed = true; return hit.value; }
      const dyn = DYNAMIC_VARS[name];
      if (dyn) { changed = true; return dyn(); }
      missing?.add(name);
      return whole;
    });
    if (!changed) break;
  }
  return out;
}
export interface VarToken { text: string; name?: string; scope?: VarScopeName | 'dynamic'; defined?: boolean }
/** Splits text into plain runs and {{variable}} runs, telling which are defined — for highlighting. */
export function varTokens(text: string, scopes: VarScopes): VarToken[] {
  const out: VarToken[] = [];
  let last = 0;
  for (const m of text.matchAll(VAR_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    const name = m[1].trim();
    const hit = lookupVar(scopes, name);
    out.push({ text: m[0], name, scope: hit ? hit.scope : DYNAMIC_VARS[name] ? 'dynamic' : undefined, defined: !!hit || !!DYNAMIC_VARS[name] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
/** Variable names used anywhere in a request (URL, params, headers, auth, body) that no scope defines. */
export function undefinedVars(r: ApiRequest, scopes: VarScopes, auth?: Auth): string[] {
  const missing = new Set<string>();
  const texts = [r.url, ...r.params.filter((p) => p.enabled).flatMap((p) => [p.key, p.value]), ...r.pathVars.map((p) => p.value), ...r.headers.filter((h) => h.enabled).flatMap((h) => [h.key, h.value])];
  const a = auth ?? r.auth;
  texts.push(a.token ?? '', a.username ?? '', a.password ?? '', a.key ?? '', a.value ?? '');
  if (r.body.mode === 'raw') texts.push(r.body.raw);
  if (r.body.mode === 'urlencoded') texts.push(...r.body.urlencoded.filter((p) => p.enabled).flatMap((p) => [p.key, p.value]));
  if (r.body.mode === 'formdata') texts.push(...r.body.formdata.filter((p) => p.enabled && p.type === 'text').flatMap((p) => [p.key, p.value]));
  for (const t of texts) resolveVars(t, scopes, missing);
  return [...missing];
}

/* ---------------- auth inheritance ---------------- */

/** The auth a request really uses: its own, or the first parent folder's, or the collection's. */
export function effectiveAuth(c: Collection, requestId: string, own?: Auth): { auth: Auth; from: string } {
  const f = findItem(c, requestId);
  const first = own ?? (f?.item.type === 'request' ? f.item.auth : { type: 'inherit' as const });
  if (first.type !== 'inherit') return { auth: first, from: 'request' };
  const folders = f ? [...f.folders].reverse() : [];
  for (const folder of folders) if (folder.auth.type !== 'inherit') return { auth: folder.auth, from: `folder "${folder.name}"` };
  return { auth: c.auth.type === 'inherit' ? { type: 'none' } : c.auth, from: 'collection' };
}
/** Scripts that run for a request, outermost first: collection, folders, then the request. */
export function scriptChain(c: Collection, requestId: string, event: 'preRequest' | 'tests', own?: string): Array<{ from: string; code: string }> {
  const f = findItem(c, requestId);
  const out: Array<{ from: string; code: string }> = [];
  if (c[event].trim()) out.push({ from: 'collection', code: c[event] });
  for (const folder of f?.folders ?? []) if (folder[event].trim()) out.push({ from: `folder "${folder.name}"`, code: folder[event] });
  const mine = own ?? (f?.item.type === 'request' ? f.item[event] : '');
  if (mine.trim()) out.push({ from: 'request', code: mine });
  return out;
}

/* ---------------- building the HTTP request ---------------- */

export type PreparedBody =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'urlencoded'; fields: Array<{ key: string; value: string }> }
  | { kind: 'form'; fields: Array<{ key: string; value?: string; fileName?: string; src?: string; contentType?: string }> }
  | { kind: 'binary'; fileName: string; src: string };
export interface PreparedRequest { method: string; url: string; headers: Array<{ key: string; value: string }>; body: PreparedBody }

export const headerValue = (headers: Array<{ key: string; value: string }>, name: string): string | undefined =>
  headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

const encodeUtf8Base64 = (text: string): string => bytesToBase64(new TextEncoder().encode(text));
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
/** data:[mime][;base64],payload → bytes and mime. */
export function dataUrlBytes(src: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(src);
  if (!m) return { bytes: new TextEncoder().encode(src), mime: 'application/octet-stream' };
  const mime = m[1] || 'application/octet-stream';
  return m[2].includes(';base64') ? { bytes: base64ToBytes(m[3]), mime } : { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime };
}
/** encodeURIComponent, but keeps characters that are already %-escapes. */
export const encodeComponent = (text: string): string => text.split(/(%[0-9A-Fa-f]{2})/).map((part, i) => (i % 2 ? part : encodeURIComponent(part))).join('');
/** Makes a typed URL sendable: adds http:// when there is no scheme and escapes spaces and non-ASCII characters. */
export function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!u) return u;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/[^\x21-\x7e]|[ "<>\\^`{|}]/g, (ch) => encodeURIComponent(ch));
}

/** Everything resolved: variables, path variables, auth, default Content-Type. What is sent, before the wire encoding. */
export function prepareRequest(r: ApiRequest, scopes: VarScopes, auth: Auth): PreparedRequest {
  const v = (t: string) => resolveVars(t, scopes);
  const parts = splitUrl(v(r.url));
  const { query, hash } = parts;
  let base = parts.base;
  for (const p of r.pathVars) {
    if (!p.key) continue;
    const value = encodeComponent(v(p.value));
    base = base.replace(new RegExp(`/:${p.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/;.]|$)`, 'g'), () => `/${value}`);
  }
  const headers = r.headers.filter((h) => h.enabled && h.key.trim()).map((h) => ({ key: v(h.key).trim(), value: v(h.value) }));
  const hasHeader = (name: string) => headers.some((h) => h.key.toLowerCase() === name.toLowerCase());
  const extraQuery: string[] = [];
  if (auth.type === 'bearer' && v(auth.token ?? '') && !hasHeader('authorization')) headers.push({ key: 'Authorization', value: `Bearer ${v(auth.token ?? '')}` });
  if (auth.type === 'basic' && !hasHeader('authorization')) headers.push({ key: 'Authorization', value: `Basic ${encodeUtf8Base64(`${v(auth.username ?? '')}:${v(auth.password ?? '')}`)}` });
  if (auth.type === 'apikey' && v(auth.key ?? '')) {
    if (auth.in === 'query') extraQuery.push(`${encodeComponent(v(auth.key ?? ''))}=${encodeComponent(v(auth.value ?? ''))}`);
    else if (!hasHeader(v(auth.key ?? ''))) headers.push({ key: v(auth.key ?? ''), value: v(auth.value ?? '') });
  }
  const q = [query, ...extraQuery].filter(Boolean).join('&');
  const url = normalizeUrl(`${base}${q ? `?${q}` : ''}${hash}`);
  let body: PreparedBody = { kind: 'none' };
  const b = r.body;
  const setType = (type: string) => { if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: type }); };
  if (b.mode === 'raw' && b.raw !== '') { body = { kind: 'text', text: v(b.raw) }; setType(RAW_TYPES[b.language]); }
  else if (b.mode === 'urlencoded') { const fields = b.urlencoded.filter((f) => f.enabled && f.key).map((f) => ({ key: v(f.key), value: v(f.value) })); if (fields.length) { body = { kind: 'urlencoded', fields }; setType('application/x-www-form-urlencoded'); } }
  else if (b.mode === 'formdata') {
    const fields = b.formdata.filter((f) => f.enabled && f.key).map((f) => (f.type === 'file' ? { key: v(f.key), fileName: f.fileName || 'file', src: f.src ?? '' } : { key: v(f.key), value: v(f.value) }));
    if (fields.length) body = { kind: 'form', fields };
  } else if (b.mode === 'binary' && b.file) { body = { kind: 'binary', fileName: b.file.name, src: b.file.src }; setType(dataUrlBytes(b.file.src).mime); }
  return { method: (v(r.method).trim() || 'GET').toUpperCase(), url, headers, body };
}

export const formEncode = (fields: Array<{ key: string; value: string }>): string =>
  fields.map((f) => `${encodeURIComponent(f.key).replace(/%20/g, '+')}=${encodeURIComponent(f.value).replace(/%20/g, '+')}`).join('&');

/** The bytes that go out: text bodies as text, multipart and files as base64; multipart gets its boundary header. */
export function toWire(p: PreparedRequest, boundary = `----PigryBoundary${Math.random().toString(16).slice(2, 14)}`): { headers: Array<{ key: string; value: string }>; body?: string; bodyBase64?: string } {
  const headers = [...p.headers];
  const b = p.body;
  if (b.kind === 'text') return { headers, body: b.text };
  if (b.kind === 'urlencoded') return { headers, body: formEncode(b.fields) };
  if (b.kind === 'binary') return { headers, bodyBase64: bytesToBase64(dataUrlBytes(b.src).bytes) };
  if (b.kind === 'form') {
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const quote = (s: string) => s.replace(/"/g, '%22').replace(/\r?\n/g, ' ');
    for (const f of b.fields) {
      if (f.fileName !== undefined) {
        const { bytes, mime } = dataUrlBytes(f.src ?? '');
        chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(f.key)}"; filename="${quote(f.fileName)}"\r\nContent-Type: ${f.contentType || mime}\r\n\r\n`), bytes, enc.encode('\r\n'));
      } else chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(f.key)}"\r\n\r\n${f.value ?? ''}\r\n`));
    }
    chunks.push(enc.encode(`--${boundary}--\r\n`));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    const i = headers.findIndex((h) => h.key.toLowerCase() === 'content-type');
    const type = `multipart/form-data; boundary=${boundary}`;
    if (i >= 0 && headers[i].value.toLowerCase().startsWith('multipart/form-data')) headers[i] = { key: headers[i].key, value: type };
    else if (i < 0) headers.push({ key: 'Content-Type', value: type });
    return { headers, bodyBase64: bytesToBase64(all) };
  }
  return { headers };
}

/* ---------------- responses ---------------- */

export interface HttpTimings { dnsMs: number; connectMs: number; tlsMs: number; firstByteMs: number; totalMs: number }
export interface ApiResponse {
  status: number; statusText: string; httpVersion: string; headers: Array<{ key: string; value: string }>;
  body: string; encoding: 'utf8' | 'base64'; timeMs: number; timings: HttpTimings; bodySize: number; headersSize: number; url: string; redirects: number; truncated: boolean;
}
export const responseText = (res: ApiResponse): string => (res.encoding === 'utf8' ? res.body : new TextDecoder().decode(base64ToBytes(res.body)));
export const contentTypeOf = (res: ApiResponse): string => (headerValue(res.headers, 'content-type') ?? '').toLowerCase();
export type BodyKind = 'json' | 'xml' | 'html' | 'image' | 'text' | 'binary';
export function bodyKind(res: ApiResponse): BodyKind {
  const ct = contentTypeOf(res);
  if (ct.startsWith('image/')) return 'image';
  if (res.encoding === 'base64') return 'binary';
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  const t = res.body.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) { try { JSON.parse(res.body); return 'json'; } catch { /* text */ } }
  if (/^<!doctype html|^<html/i.test(t)) return 'html';
  if (t.startsWith('<?xml')) return 'xml';
  return 'text';
}
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 2 : 1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
export const formatTime = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
export function statusTone(status: number): 'ok' | 'redirect' | 'client' | 'server' | 'info' {
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  if (status >= 300) return 'redirect';
  if (status >= 200) return 'ok';
  return 'info';
}

/** Pretty JSON with two-space indents; null when the text is not JSON. */
export function prettyJson(text: string): string | null {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return null; }
}
/** Indents XML/HTML one tag per line, keeping <tag>text</tag> on one line (a light formatter for reading, not a validator). */
export function prettyXml(text: string): string {
  const tokens = (text.match(/<[^>]+>|[^<]+/g) ?? []).map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  let depth = 0;
  const pad = () => '  '.repeat(depth);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('</')) { depth = Math.max(0, depth - 1); out.push(`${pad()}${t}`); continue; }
    if (!t.startsWith('<')) { out.push(`${pad()}${t}`); continue; }
    const single = /\/>$/.test(t) || /^<[?!]/.test(t) || /^<(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)\b/i.test(t);
    if (single) { out.push(`${pad()}${t}`); continue; }
    const next = tokens[i + 1], after = tokens[i + 2];
    if (next !== undefined && !next.startsWith('<') && after?.startsWith('</')) { out.push(`${pad()}${t}${next}${after}`); i += 2; continue; }
    if (next?.startsWith('</')) { out.push(`${pad()}${t}${next}`); i += 1; continue; }
    out.push(`${pad()}${t}`);
    depth++;
  }
  return out.join('\n');
}
export type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'space';
/** Splits (pretty) JSON text into tokens for syntax colouring. */
export function jsonTokens(text: string): Array<{ kind: JsonTokenKind; text: string }> {
  const out: Array<{ kind: JsonTokenKind; text: string }> = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}[\],:])|(\s+)|(.)/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) { out.push({ kind: m[2] ? 'key' : 'string', text: m[1] }); if (m[2]) out.push({ kind: 'punct', text: m[2] }); }
    else if (m[3]) out.push({ kind: 'number', text: m[3] });
    else if (m[4]) out.push({ kind: 'boolean', text: m[4] });
    else if (m[5]) out.push({ kind: 'null', text: m[5] });
    else if (m[6]) out.push({ kind: 'punct', text: m[6] });
    else out.push({ kind: m[7] ? 'space' : 'punct', text: m[0] });
  }
  return out;
}

/* ---------------- cookies ---------------- */

export interface Cookie { name: string; value: string; domain: string; path: string; expires?: string; httpOnly: boolean; secure: boolean; sameSite?: string; hostOnly: boolean }
export type CookieJar = Record<string, Cookie[]>;
const hostOf = (url: string): { host: string; path: string; secure: boolean } => {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url.trim());
  if (!m) return { host: '', path: '/', secure: false };
  const host = m[2].replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
  return { host, path: m[3] || '/', secure: m[1].toLowerCase() === 'https' };
};
export function parseSetCookie(header: string, url: string): Cookie | null {
  const [pair, ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const { host, path } = hostOf(url);
  const c: Cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, path: path.replace(/\/[^/]*$/, '') || '/', httpOnly: false, secure: false, hostOnly: true };
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : a.slice(i + 1).trim();
    if (k === 'domain' && val) { c.domain = val.replace(/^\./, '').toLowerCase(); c.hostOnly = false; }
    else if (k === 'path' && val.startsWith('/')) c.path = val;
    else if (k === 'expires' && val) { const d = new Date(val); if (!Number.isNaN(d.getTime())) c.expires = d.toISOString(); }
    else if (k === 'max-age' && val) { const n = Number(val); if (Number.isFinite(n)) c.expires = new Date(n <= 0 ? 0 : Date.now() + n * 1000).toISOString(); }
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'secure') c.secure = true;
    else if (k === 'samesite') c.sameSite = val;
  }
  return c;
}
export const responseCookies = (res: ApiResponse): Cookie[] =>
  res.headers.filter((h) => h.key.toLowerCase() === 'set-cookie').map((h) => parseSetCookie(h.value, res.url)).filter((c): c is Cookie => c !== null);
const expired = (c: Cookie, now: number): boolean => !!c.expires && new Date(c.expires).getTime() <= now;
/** Puts a response's cookies in the jar (replacing same name/domain/path; expired ones are removed). */
export function storeCookies(jar: CookieJar, cookies: Cookie[], now = Date.now()): CookieJar {
  const next: CookieJar = { ...jar };
  for (const c of cookies) {
    const list = (next[c.domain] ?? []).filter((x) => !(x.name === c.name && x.path === c.path));
    if (!expired(c, now)) list.push(c);
    if (list.length) next[c.domain] = list; else delete next[c.domain];
  }
  return next;
}
/** The Cookie header the jar sends to a URL. */
export function cookieHeaderFor(jar: CookieJar, url: string, now = Date.now()): string {
  const { host, path, secure } = hostOf(url);
  if (!host) return '';
  const out: string[] = [];
  for (const [domain, list] of Object.entries(jar)) {
    for (const c of list) {
      const domainOk = c.hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
      const pathOk = path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`) || c.path === '/';
      if (domainOk && pathOk && (!c.secure || secure) && !expired(c, now)) out.push(`${c.name}=${c.value}`);
    }
  }
  return out.join('; ');
}

/* ---------------- history ---------------- */

export interface HistoryEntry {
  id: string; at: string; method: string; url: string; status: number | null; timeMs: number | null; size: number | null; error?: string;
  /** Where it came from (collection key and request id), when it was a saved request. */
  source?: { collection: string; request: string };
  request: ApiRequest;
}
export const HISTORY_LIMIT = 200;
export const addHistory = (list: HistoryEntry[], entry: HistoryEntry, limit = HISTORY_LIMIT): HistoryEntry[] => [entry, ...list].slice(0, limit);
/** Entries grouped by local day ("Today", "Yesterday", or the date), newest first. */
export function historyByDay(list: HistoryEntry[], now = Date.now()): Array<{ label: string; entries: HistoryEntry[] }> {
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const groups: Array<{ label: string; entries: HistoryEntry[] }> = [];
  for (const e of list) {
    const d = new Date(e.at);
    const label = dayKey(d) === dayKey(today) ? 'Today' : dayKey(d) === dayKey(yesterday) ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.entries.push(e); else groups.push({ label, entries: [e] });
  }
  return groups;
}

/** A short "METHOD url" label for a request, e.g. in lists. */
export const requestLabel = (r: ApiRequest): string => `${r.method} ${r.url || '(no URL)'}`;
/** Counts of folders and requests. */
export function countItems(items: ApiItem[]): { folders: number; requests: number } {
  let folders = 0, requests = 0;
  for (const f of walk(items)) if (f.item.type === 'folder') folders++; else requests++;
  return { folders, requests };
}
