/** Agent operations on a collection (all-or-nothing, with a log) and the compact reader. Pure — node tests import it. */
import {
  AUTH_TYPES, METHODS, RAW_LANGUAGES, addItem, clone, countItems, duplicateItem, effectiveAuth, emptyBody, itemPath, lookupItem, moveItem, newFolder, newKV, newRequest,
  newVariable, normAuth, removeItem, scriptChain, setRequestParams, setRequestUrl, syncPathVars, walk,
  type ApiFolder, type ApiItem, type ApiRequest, type Auth, type Body, type Collection, type FormField, type KV, type RawLanguage,
} from './api.ts';

export type Op = { op: string } & Record<string, unknown>;
export interface OpResult { collection: Collection; log: string[]; error?: string; created: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

export const OP_NAMES = ['add_request', 'update_request', 'add_folder', 'update_folder', 'rename', 'move', 'duplicate', 'delete', 'set_auth', 'set_script', 'set_variable', 'unset_variable', 'set_collection'] as const;

export const OP_HELP = [
  'Operations (ops), applied in order, all-or-nothing. Items are addressed by id (from api_read), by "Folder / Request" path or by a unique name:',
  '- {op:"add_request", name, method?:"GET", url:"{{baseUrl}}/users/:id?active=true", parent?: folder, index?, headers?: {"Accept":"application/json"} or [{key,value,enabled}] or ["Key: value"], params?, path_vars?: {id:"42"}, body?, auth?, pre_request?, tests?, description?}',
  '  body: {json: {...}} (raw JSON), {text: "..."}, {xml: "..."}, {raw: "...", language: json|text|xml|html|javascript}, {urlencoded: {k: v}}, {formdata: {k: v}}, or {mode:"none"}',
  '  auth: {type:"inherit"} (default: from the folder / collection), {type:"none"}, {type:"bearer", token:"{{token}}"}, {type:"basic", username, password}, {type:"apikey", key:"X-API-Key", value:"{{apiKey}}", in:"header"|"query"}',
  '- {op:"update_request", id, …any add_request field} — url rewrites the params; params rewrites the URL query; headers / params replace the whole list (add_headers / remove_headers to change some)',
  '- {op:"add_folder", name, parent?, description?, auth?, pre_request?, tests?}  {op:"update_folder", id, name?, description?, auth?, pre_request?, tests?}',
  '- {op:"rename", id, name}  {op:"duplicate", id}  {op:"delete", id}  {op:"move", id, before?: id | after?: id | into?: folder | root: true}',
  '- {op:"set_auth", target?: id (omit for the collection), auth}  {op:"set_script", target?, pre_request?, tests?} — scripts use pm.* (pm.test, pm.expect, pm.response.json(), pm.environment.set)',
  '- {op:"set_variable", key, value, secret?} (collection variable; secret values are kept out of git)  {op:"unset_variable", key}  {op:"set_collection", name?, description?}',
].join('\n');

const toKVs = (v: unknown): KV[] | string => {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') { try { return toKVs(JSON.parse(v)); } catch { return toKVs(v.split('\n').filter(Boolean)); } }
  if (Array.isArray(v)) {
    const out: KV[] = [];
    for (const x of v) {
      if (typeof x === 'string') { const c = x.indexOf(':'); const e = x.indexOf('='); const at = c > 0 ? c : e; if (at <= 0) return `"${x}" is not "Key: value"`; out.push(newKV(x.slice(0, at).trim(), x.slice(at + 1).trim())); }
      else if (isObj(x)) out.push(newKV(s(x.key ?? x.name), s(x.value), x.enabled !== false && x.disabled !== true, s(x.description) || undefined));
      else return 'rows must be objects {key, value} or "Key: value" strings';
    }
    return out;
  }
  if (isObj(v)) return Object.entries(v).map(([k, x]) => newKV(k, typeof x === 'object' && x !== null ? JSON.stringify(x) : s(x)));
  return 'expected an object {key: value} or a list of rows';
};
function toAuth(v: unknown, allowInherit: boolean): Auth | string {
  if (typeof v === 'string') { if (!(AUTH_TYPES as readonly string[]).includes(v)) return `auth type must be one of ${AUTH_TYPES.join(', ')}`; return normAuth({ type: v }, allowInherit); }
  if (!isObj(v)) return 'auth must be an object {type, …}';
  const type = s(v.type).toLowerCase().replace('api_key', 'apikey').replace('api-key', 'apikey');
  if (!(AUTH_TYPES as readonly string[]).includes(type)) return `auth type must be one of ${AUTH_TYPES.join(', ')}`;
  if (type === 'inherit' && !allowInherit) return 'the collection cannot inherit auth (use none)';
  return normAuth({ ...v, type, in: s(v.in ?? v.add_to ?? 'header') }, allowInherit);
}
function toBody(v: unknown): Body | string {
  if (v === undefined || v === null || v === '') return emptyBody();
  if (typeof v === 'string') return { ...emptyBody(), mode: 'raw', raw: v, language: /^\s*[[{]/.test(v) ? 'json' : 'text' };
  if (!isObj(v)) return 'body must be an object';
  const b = emptyBody();
  if (v.json !== undefined) return { ...b, mode: 'raw', language: 'json', raw: typeof v.json === 'string' ? v.json : JSON.stringify(v.json, null, 2) };
  if (v.text !== undefined) return { ...b, mode: 'raw', language: 'text', raw: s(v.text) };
  if (v.xml !== undefined) return { ...b, mode: 'raw', language: 'xml', raw: s(v.xml) };
  if (v.html !== undefined) return { ...b, mode: 'raw', language: 'html', raw: s(v.html) };
  if (v.urlencoded !== undefined) { const kv = toKVs(v.urlencoded); return typeof kv === 'string' ? `body.urlencoded: ${kv}` : { ...b, mode: 'urlencoded', urlencoded: kv }; }
  if (v.formdata !== undefined) {
    const kv = toKVs(v.formdata);
    if (typeof kv === 'string') return `body.formdata: ${kv}`;
    const form: FormField[] = kv.map((x) => ({ ...x, type: 'text' }));
    return { ...b, mode: 'formdata', formdata: form };
  }
  const mode = s(v.mode) || (v.raw !== undefined ? 'raw' : 'none');
  if (mode === 'none') return b;
  if (mode === 'raw') {
    const language = s(v.language) || 'json';
    if (!(RAW_LANGUAGES as readonly string[]).includes(language)) return `body.language must be one of ${RAW_LANGUAGES.join(', ')}`;
    return { ...b, mode: 'raw', raw: typeof v.raw === 'string' ? v.raw : JSON.stringify(v.raw ?? '', null, 2), language: language as RawLanguage };
  }
  return `body mode "${mode}" is not supported by ops (use json, text, xml, raw, urlencoded, formdata or none)`;
}
const methodOf = (v: unknown): string | null => {
  const m = s(v).trim().toUpperCase() || 'GET';
  return /^[A-Z_-]{1,24}$/.test(m) ? m : null;
};
const asCode = (v: unknown): string => (Array.isArray(v) ? v.map(s).join('\n') : s(v));

/** Fills a request from op fields. Returns an error message or null. */
function applyRequestFields(r: ApiRequest, op: Op, creating: boolean): string | null {
  if (op.name !== undefined) r.name = s(op.name).trim().slice(0, 500) || r.name;
  if (op.description !== undefined) r.description = s(op.description);
  if (op.method !== undefined || creating) { const m = methodOf(op.method); if (!m) return `invalid method "${s(op.method)}" (use ${METHODS.join(', ')})`; r.method = m; }
  if (op.url !== undefined) setRequestUrl(r, s(op.url).trim());
  if (op.params !== undefined) { const kv = toKVs(op.params); if (typeof kv === 'string') return `params: ${kv}`; setRequestParams(r, kv); }
  if (op.path_vars !== undefined || op.pathVars !== undefined) {
    const kv = toKVs(op.path_vars ?? op.pathVars);
    if (typeof kv === 'string') return `path_vars: ${kv}`;
    r.pathVars = syncPathVars(r.url, r.pathVars).map((p) => ({ ...p, value: kv.find((x) => x.key === p.key)?.value ?? p.value }));
    const unknown = kv.filter((x) => !r.pathVars.some((p) => p.key === x.key)).map((x) => x.key);
    if (unknown.length) return `path_vars ${unknown.join(', ')} are not :segments of the URL`;
  }
  if (op.headers !== undefined) { const kv = toKVs(op.headers); if (typeof kv === 'string') return `headers: ${kv}`; r.headers = kv; }
  if (op.add_headers !== undefined) {
    const kv = toKVs(op.add_headers);
    if (typeof kv === 'string') return `add_headers: ${kv}`;
    for (const h of kv) { const i = r.headers.findIndex((x) => x.key.toLowerCase() === h.key.toLowerCase()); if (i >= 0) r.headers[i] = { ...r.headers[i], value: h.value, enabled: true }; else r.headers.push(h); }
  }
  if (op.remove_headers !== undefined) { const keys = (Array.isArray(op.remove_headers) ? op.remove_headers : [op.remove_headers]).map((k) => s(k).toLowerCase()); r.headers = r.headers.filter((h) => !keys.includes(h.key.toLowerCase())); }
  if (op.body !== undefined) { const b = toBody(op.body); if (typeof b === 'string') return b; r.body = b; }
  if (op.auth !== undefined) { const a = toAuth(op.auth, true); if (typeof a === 'string') return a; r.auth = a; }
  if (op.pre_request !== undefined || op.preRequest !== undefined) r.preRequest = asCode(op.pre_request ?? op.preRequest);
  if (op.tests !== undefined) r.tests = asCode(op.tests);
  if (op.timeout_ms !== undefined) { const n = Number(op.timeout_ms); if (!Number.isFinite(n) || n < 0) return 'timeout_ms must be a number of milliseconds'; r.settings.timeoutMs = Math.min(600_000, Math.round(n)); }
  if (op.follow_redirects !== undefined) r.settings.followRedirects = op.follow_redirects !== false;
  if (op.verify_tls !== undefined) r.settings.verifyTls = op.verify_tls !== false;
  return null;
}

export function parseOps(input: unknown): { ops: Op[]; errors: string[] } {
  const list = Array.isArray(input) ? input : isObj(input) ? [input] : [];
  const errors: string[] = [];
  if (!Array.isArray(input) && !isObj(input)) errors.push('ops must be a list of operations');
  const ops: Op[] = [];
  list.forEach((x, i) => {
    if (!isObj(x) || typeof x.op !== 'string') { errors.push(`op ${i + 1}: needs an "op" name`); return; }
    if (!(OP_NAMES as readonly string[]).includes(x.op)) { errors.push(`op ${i + 1}: unknown op "${x.op}" (known: ${OP_NAMES.join(', ')})`); return; }
    ops.push(x as Op);
  });
  return { ops, errors };
}

const folderOf = (c: Collection, ref: unknown): ApiFolder | null | 'missing' => {
  if (ref === undefined || ref === null || ref === '') return null;
  const f = lookupItem(c, ref);
  return f && f.item.type === 'folder' ? f.item : 'missing';
};

export function applyOps(input: Collection, ops: Op[]): OpResult {
  const c = clone(input);
  const log: string[] = [];
  const created: string[] = [];
  const fail = (i: number, msg: string): OpResult => ({ collection: input, log, created, error: `op ${i + 1} (${ops[i].op}): ${msg}` });
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const target = (): ApiItem | null => lookupItem(c, op.id ?? op.target ?? op.name)?.item ?? null;
    switch (op.op) {
      case 'add_request': {
        const parent = folderOf(c, op.parent ?? op.folder);
        if (parent === 'missing') return fail(i, `no folder "${s(op.parent ?? op.folder)}"`);
        const r = newRequest({ name: s(op.name).trim() || s(op.url).trim() || 'New Request' });
        const err = applyRequestFields(r, op, true);
        if (err) return fail(i, err);
        addItem(c, r, parent?.id, typeof op.index === 'number' ? op.index : undefined);
        created.push(r.id);
        log.push(`added request ${r.id} "${r.name}" (${r.method} ${r.url})${parent ? ` in "${parent.name}"` : ''}`);
        break;
      }
      case 'update_request': {
        const item = target();
        if (!item || item.type !== 'request') return fail(i, `no request "${s(op.id)}"`);
        const err = applyRequestFields(item, { ...op, name: op.new_name ?? op.rename ?? (op.id !== undefined ? op.name : undefined) }, false);
        if (err) return fail(i, err);
        log.push(`updated request ${item.id} "${item.name}"`);
        break;
      }
      case 'add_folder': {
        const parent = folderOf(c, op.parent ?? op.folder);
        if (parent === 'missing') return fail(i, `no folder "${s(op.parent ?? op.folder)}"`);
        const f = newFolder(s(op.name).trim() || 'New Folder', { description: s(op.description), preRequest: asCode(op.pre_request), tests: asCode(op.tests) });
        if (op.auth !== undefined) { const a = toAuth(op.auth, true); if (typeof a === 'string') return fail(i, a); f.auth = a; }
        addItem(c, f, parent?.id, typeof op.index === 'number' ? op.index : undefined);
        created.push(f.id);
        log.push(`added folder ${f.id} "${f.name}"${parent ? ` in "${parent.name}"` : ''}`);
        break;
      }
      case 'update_folder': {
        const item = target();
        if (!item || item.type !== 'folder') return fail(i, `no folder "${s(op.id)}"`);
        if (op.new_name !== undefined || (op.id !== undefined && op.name !== undefined)) item.name = s(op.new_name ?? op.name).trim() || item.name;
        if (op.description !== undefined) item.description = s(op.description);
        if (op.auth !== undefined) { const a = toAuth(op.auth, true); if (typeof a === 'string') return fail(i, a); item.auth = a; }
        if (op.pre_request !== undefined) item.preRequest = asCode(op.pre_request);
        if (op.tests !== undefined) item.tests = asCode(op.tests);
        log.push(`updated folder ${item.id} "${item.name}"`);
        break;
      }
      case 'rename': {
        const item = lookupItem(c, op.id)?.item;
        if (!item) return fail(i, `no item "${s(op.id)}"`);
        const name = s(op.name).trim();
        if (!name) return fail(i, 'needs a name');
        log.push(`renamed ${item.id} "${item.name}" → "${name}"`);
        item.name = name.slice(0, 500);
        break;
      }
      case 'duplicate': {
        const item = lookupItem(c, op.id)?.item;
        if (!item) return fail(i, `no item "${s(op.id)}"`);
        const copy = duplicateItem(c, item.id)!;
        created.push(copy.id);
        log.push(`duplicated ${item.id} as ${copy.id} "${copy.name}"`);
        break;
      }
      case 'delete': {
        const item = lookupItem(c, op.id)?.item;
        if (!item) return fail(i, `no item "${s(op.id)}"`);
        removeItem(c, item.id);
        const n = item.type === 'folder' ? countItems(item.items) : null;
        log.push(`deleted ${item.type} ${item.id} "${item.name}"${n ? ` (with ${n.requests} request(s), ${n.folders} folder(s))` : ''}`);
        break;
      }
      case 'move': {
        const item = lookupItem(c, op.id)?.item;
        if (!item) return fail(i, `no item "${s(op.id)}"`);
        let ok: boolean;
        if (op.root === true) ok = moveItem(c, item.id, null, 'inside');
        else {
          const ref = op.before ?? op.after ?? op.into;
          const t = lookupItem(c, ref)?.item;
          if (!t) return fail(i, `no target "${s(ref)}" (give before, after, into or root: true)`);
          ok = moveItem(c, item.id, t.id, op.before !== undefined ? 'before' : op.after !== undefined ? 'after' : 'inside');
        }
        if (!ok) return fail(i, 'cannot move there (into itself, or into something that is not a folder)');
        log.push(`moved ${item.id} "${item.name}"`);
        break;
      }
      case 'set_auth': {
        const ref = op.target ?? op.id;
        const a = toAuth(op.auth, ref !== undefined && ref !== null && ref !== '');
        if (typeof a === 'string') return fail(i, a);
        if (ref === undefined || ref === null || ref === '') { c.auth = a; log.push(`collection auth: ${a.type}`); break; }
        const item = lookupItem(c, ref)?.item;
        if (!item) return fail(i, `no item "${s(ref)}"`);
        item.auth = a;
        log.push(`auth of ${item.id} "${item.name}": ${a.type}`);
        break;
      }
      case 'set_script': {
        const ref = op.target ?? op.id;
        const holder: { preRequest: string; tests: string; name: string } | null = ref === undefined || ref === null || ref === '' ? c : (lookupItem(c, ref)?.item ?? null);
        if (!holder) return fail(i, `no item "${s(ref)}"`);
        if (op.pre_request === undefined && op.tests === undefined) return fail(i, 'give pre_request and/or tests');
        if (op.pre_request !== undefined) holder.preRequest = asCode(op.pre_request);
        if (op.tests !== undefined) holder.tests = asCode(op.tests);
        log.push(`scripts of ${holder === c ? 'the collection' : `"${holder.name}"`} updated`);
        break;
      }
      case 'set_variable': {
        const key = s(op.key).trim();
        if (!key) return fail(i, 'needs a key');
        const existing = c.variables.find((v) => v.key === key);
        if (existing) { existing.value = s(op.value); existing.enabled = true; if (op.secret !== undefined) existing.secret = op.secret === true || undefined; }
        else c.variables.push(newVariable(key, s(op.value), op.secret === true));
        log.push(`collection variable ${key}${op.secret === true || existing?.secret ? ' (secret)' : ''} set`);
        break;
      }
      case 'unset_variable': {
        const key = s(op.key).trim();
        const before = c.variables.length;
        c.variables = c.variables.filter((v) => v.key !== key);
        if (c.variables.length === before) return fail(i, `no collection variable "${key}"`);
        log.push(`collection variable ${key} removed`);
        break;
      }
      case 'set_collection': {
        if (op.name !== undefined) c.name = s(op.name).trim().slice(0, 500) || c.name;
        if (op.description !== undefined) c.description = s(op.description);
        log.push('collection details updated');
        break;
      }
      default: return fail(i, 'unknown op');
    }
  }
  return { collection: c, log, created };
}

/* ---------------- reading ---------------- */

const authText = (a: Auth): string => {
  switch (a.type) {
    case 'bearer': return `Bearer ${a.token ? (a.token.includes('{{') ? a.token : '••••') : '(empty token)'}`;
    case 'basic': return `Basic ${a.username ?? ''}:${a.password ? (a.password.includes('{{') ? a.password : '••••') : ''}`;
    case 'apikey': return `API key ${a.key ?? ''} in ${a.in ?? 'header'} = ${a.value ? (a.value.includes('{{') ? a.value : '••••') : '(empty)'}`;
    default: return a.type;
  }
};
const bodyText = (b: Body, max = 4000): string => {
  switch (b.mode) {
    case 'raw': return `raw ${b.language}:\n${b.raw.length > max ? `${b.raw.slice(0, max)}…[${b.raw.length - max} more chars]` : b.raw}`;
    case 'urlencoded': return `x-www-form-urlencoded: ${b.urlencoded.map((f) => `${f.enabled ? '' : '(off) '}${f.key}=${f.value}`).join('&')}`;
    case 'formdata': return `form-data: ${b.formdata.map((f) => `${f.enabled ? '' : '(off) '}${f.key}=${f.type === 'file' ? `@${f.fileName || '(no file)'}` : f.value}`).join(', ')}`;
    case 'binary': return `binary file: ${b.file?.name ?? '(none chosen)'}`;
    default: return 'none';
  }
};
export const summarizeCollection = (c: Collection): string => {
  const n = countItems(c.items);
  return `"${c.name}": ${n.requests} request(s) in ${n.folders} folder(s), ${c.variables.length} collection variable(s), auth ${c.auth.type}`;
};

/** The collection as an outline with ids, or one request (or folder) in full. */
export function readCollection(c: Collection, ref?: unknown): string {
  if (ref !== undefined && ref !== null && ref !== '') {
    const f = lookupItem(c, ref);
    if (!f) return `error: no item "${s(ref)}"`;
    const item = f.item;
    const out: string[] = [`${item.type} ${item.id}: ${itemPath(f)}`];
    if (item.description) out.push(`description: ${item.description}`);
    if (item.type === 'folder') {
      out.push(`auth: ${item.auth.type === 'inherit' ? 'inherit' : authText(item.auth)}`);
      if (item.preRequest) out.push(`pre-request script:\n${item.preRequest}`);
      if (item.tests) out.push(`tests:\n${item.tests}`);
      out.push(`items: ${item.items.map((x) => `${x.id} ${x.type === 'request' ? `${x.method} ` : '📁 '}${x.name}`).join(' · ') || '(empty)'}`);
      return out.join('\n');
    }
    const eff = effectiveAuth(c, item.id);
    out.push(`${item.method} ${item.url}`);
    if (item.params.length) out.push(`params: ${item.params.map((p) => `${p.enabled ? '' : '(off) '}${p.key}=${p.value}${p.description ? ` — ${p.description}` : ''}`).join('; ')}`);
    if (item.pathVars.length) out.push(`path variables: ${item.pathVars.map((p) => `${p.key}=${p.value || '(empty)'}`).join('; ')}`);
    out.push(`headers: ${item.headers.length ? item.headers.map((h) => `${h.enabled ? '' : '(off) '}${h.key}: ${h.value}`).join('; ') : '(none)'}`);
    out.push(`auth: ${item.auth.type === 'inherit' ? `inherit → ${authText(eff.auth)} (from ${eff.from})` : authText(item.auth)}`);
    out.push(`body: ${bodyText(item.body)}`);
    const pre = scriptChain(c, item.id, 'preRequest'), tests = scriptChain(c, item.id, 'tests');
    if (item.preRequest) out.push(`pre-request script:\n${item.preRequest}`);
    if (item.tests) out.push(`tests:\n${item.tests}`);
    const inherited = [...pre, ...tests].filter((x) => x.from !== 'request').map((x) => x.from);
    if (inherited.length) out.push(`also runs scripts of: ${[...new Set(inherited)].join(', ')}`);
    const st = item.settings;
    if (st.timeoutMs || !st.followRedirects || !st.verifyTls) out.push(`settings: ${[st.timeoutMs ? `timeout ${st.timeoutMs} ms` : '', st.followRedirects ? '' : 'no redirects', st.verifyTls ? '' : 'TLS not verified'].filter(Boolean).join(', ')}`);
    return out.join('\n');
  }
  const out: string[] = [summarizeCollection(c)];
  if (c.description) out.push(`description: ${c.description.length > 600 ? `${c.description.slice(0, 600)}…` : c.description}`);
  if (c.auth.type !== 'none') out.push(`auth: ${authText(c.auth)}`);
  if (c.variables.length) out.push(`variables: ${c.variables.map((v) => `${v.enabled ? '' : '(off) '}${v.key}=${v.secret ? '(secret)' : v.value}`).join('; ')}`);
  if (c.preRequest) out.push(`collection pre-request script: ${c.preRequest.split('\n').length} line(s)`);
  if (c.tests) out.push(`collection tests: ${c.tests.split('\n').length} line(s)`);
  out.push('items:');
  for (const f of walk(c.items)) {
    const pad = '  '.repeat(f.folders.length + 1);
    const i = f.item;
    if (i.type === 'folder') out.push(`${pad}📁 ${i.id} ${i.name}${i.auth.type !== 'inherit' ? ` [auth ${i.auth.type}]` : ''}${i.preRequest || i.tests ? ' [scripts]' : ''}`);
    else out.push(`${pad}${i.id} ${i.method} ${i.url} — ${i.name}${i.auth.type !== 'inherit' ? ` [auth ${i.auth.type}]` : ''}${i.tests ? ' [tests]' : ''}${i.preRequest ? ' [pre-request]' : ''}`);
  }
  if (!c.items.length) out.push('  (empty — add requests with api_edit add_request)');
  return out.join('\n');
}

/** A request given inline to api_send (no collection): fields like add_request. */
export function requestFromInput(input: Record<string, unknown>): ApiRequest | string {
  const r = newRequest({ name: s(input.name) || 'Ad-hoc request' });
  const err = applyRequestFields(r, { op: 'add_request', ...input }, true);
  return err ?? r;
}
