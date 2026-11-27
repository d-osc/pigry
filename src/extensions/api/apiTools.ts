/** Agent tools for the RESTful API menu. Collections are files (.pigry/apis/<owner>/<name>.api.json, one folder per agent),
 * environments are .env.json files next to them, and secret values, history and cookies stay in .pigry/cache (git-ignored).
 * The tools list, read, create and edit collections (all-or-nothing ops with a log), manage environments, send requests
 * (from the backend, with scripts and tests), run a collection, export Postman JSON or code, and open things in the menu. */
import type { ToolSpec } from '../../lib/agentTools';
import { readWorktreeFile, writeWorktreeFile, yamlToJson } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import {
  API_EXT, ENV_EXT, bodyKind, effectiveAuth, emptyCollection, emptyEnvironment, findItem, formatSize, formatTime, listRequests, lookupItem, newId, newVariable, prepareRequest, prettyJson,
  responseText, varsToMap, walk,
  type ApiRequest, type Collection, type Environment, type Variable, type VarScopes,
} from './api';
import { exportPostman, importAny, snippet, type SnippetLang } from './apiFormat';
import { OP_HELP, applyOps, parseOps, readCollection, requestFromInput, summarizeCollection, type Op } from './apiOps';
import { failedCount, passedCount, runCollection, runRequest, scopeChanges, type RunResult } from './apiRun';
import {
  flushApiEditors, getSelectedEnvironment, listCollectionRefs, listEnvironmentRefs, loadCollection, loadCookies, loadEnvironment, loadGlobals, pushHistory, refOfKey, requestOpenApi,
  resolveCollectionRef, resolveEnvironmentRef, runScriptSandboxed, saveCollection, saveCookies, saveEnvironment, saveGlobals, sendViaBackend, setSelectedEnvironment,
} from './apiStore';

const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const nameOf = (input: Record<string, unknown>): string => s(input.name ?? input.collection).trim();
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const fail = (message: string): string => `error: ${message}`;
const asList = (value: unknown): unknown => { if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } } return value; };
const safePath = (p: string): string | null => { const x = p.replace(/\\/g, '/').trim(); return !x || x.split('/').includes('..') || /^[A-Za-z]:/.test(x) || x.startsWith('/') ? null : x; };
const opsSchema = { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order, all-or-nothing (a JSON string of the array is also accepted)' };
const requestProps = {
  method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS' },
  url: { type: 'string', description: 'URL; {{variables}} and :path segments are filled in' },
  headers: { type: 'object', description: '{"Accept": "application/json"} or a list of {key, value}' },
  params: { type: 'object', description: 'Query params {key: value} (rewrites the query string)' },
  path_vars: { type: 'object', description: 'Values of :segments, e.g. {"id": "42"}' },
  body: { type: 'object', description: '{json: {...}} | {text} | {xml} | {raw, language} | {urlencoded: {...}} | {formdata: {...}}' },
  auth: { type: 'object', description: '{type: bearer, token} | {type: basic, username, password} | {type: apikey, key, value, in} | {type: none}' },
  pre_request: { type: 'string', description: 'Pre-request script (pm API)' },
  tests: { type: 'string', description: 'Test script, e.g. pm.test("200", () => pm.response.to.have.status(200));' },
};

async function openCollection(input: Record<string, unknown>): Promise<{ ref: OwnedRef; collection: Collection; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a collection name (see api_list)');
  await flushApiEditors();
  const resolved = await resolveCollectionRef(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see api_list)`);
  try { const { collection, warnings } = await loadCollection(resolved.ref); return { ref: resolved.ref, collection, warnings }; }
  catch (error) { return fail(`could not read collection "${name}" — ${error instanceof Error ? error.message : String(error)}`); }
}

/** The environment a tool uses: the named one, "none", or the one selected in the menu. */
async function pickEnvironment(input: Record<string, unknown>): Promise<{ key: string | null; env: Environment | null } | string> {
  const wanted = s(input.environment).trim();
  if (wanted.toLowerCase() === 'none') return { key: null, env: null };
  if (wanted) {
    const r = await resolveEnvironmentRef(wanted, callerOf(input));
    if ('error' in r) return fail(`environment: ${r.error} (see api_env with action "list")`);
    return { key: refKey(r.ref), env: await loadEnvironment(r.ref) };
  }
  const selected = getSelectedEnvironment();
  if (!selected) return { key: null, env: null };
  const refs = await listEnvironmentRefs().catch(() => [] as OwnedRef[]);
  if (!refs.some((r) => refKey(r) === selected)) return { key: null, env: null };
  try { return { key: selected, env: await loadEnvironment(refOfKey(selected)) }; } catch { return { key: null, env: null }; }
}
const mask = (vars: Variable[]): string => vars.map((v) => `${v.enabled ? '' : '(off) '}${v.key} = ${v.secret ? (v.value ? '•••• (secret)' : '(secret, empty)') : v.value}`).join('\n') || '(no variables)';
function applyVarChanges(vars: Variable[], ch: { set: Record<string, string>; unset: string[] }): Variable[] {
  const out = vars.filter((v) => !ch.unset.includes(v.key)).map((v) => (Object.prototype.hasOwnProperty.call(ch.set, v.key) ? { ...v, value: ch.set[v.key] } : v));
  for (const [k, v] of Object.entries(ch.set)) if (!out.some((x) => x.key === k)) out.push(newVariable(k, v));
  return out;
}
const anyChange = (ch: { set: Record<string, string>; unset: string[] }): boolean => Object.keys(ch.set).length > 0 || ch.unset.length > 0;

/** Saves what scripts changed in the environment, collection variables and globals; returns a log (secret values hidden). */
async function persistScopes(before: VarScopes, after: VarScopes, env: { key: string | null; env: Environment | null }, col: { ref: OwnedRef; collection: Collection } | null, globals: Environment): Promise<string[]> {
  const log: string[] = [];
  const describe = (where: string, ch: { set: Record<string, string>; unset: string[] }, vars: Variable[]) => {
    for (const k of Object.keys(ch.set)) log.push(`${where} ${k} = ${vars.find((v) => v.key === k)?.secret ? '••••' : ch.set[k].length > 80 ? `${ch.set[k].slice(0, 80)}…` : ch.set[k]}`);
    for (const k of ch.unset) log.push(`${where} ${k} removed`);
  };
  const e = scopeChanges(before.environment, after.environment);
  if (env.key && env.env && anyChange(e)) { describe('environment', e, env.env.values); await saveEnvironment(refOfKey(env.key), { ...env.env, values: applyVarChanges(env.env.values, e) }, 'agent'); }
  const c = scopeChanges(before.collection, after.collection);
  if (col && anyChange(c)) {
    describe('collection variable', c, col.collection.variables);
    const fresh = (await loadCollection(col.ref)).collection;
    await saveCollection(col.ref, { ...fresh, variables: applyVarChanges(fresh.variables, c) }, 'agent');
  }
  const g = scopeChanges(before.globals, after.globals);
  if (anyChange(g)) { describe('global', g, globals.values); await saveGlobals({ ...globals, values: applyVarChanges(globals.values, g) }, 'agent'); }
  return log;
}

function describeResult(r: RunResult, maxChars: number, secretValues: string[]): string {
  const out: string[] = [];
  const hide = (t: string) => secretValues.reduce((acc, v) => (v.length >= 4 ? acc.split(v).join('••••') : acc), t);
  if (r.prepared) out.push(`${r.prepared.method} ${hide(r.prepared.url)}`);
  if (r.error) out.push(`ERROR: ${hide(r.error)}`);
  const res = r.response;
  if (res) {
    out.push(`→ ${res.status} ${res.statusText} · ${formatTime(res.timeMs)} · ${formatSize(res.bodySize)}${res.redirects ? ` · ${res.redirects} redirect(s) to ${res.url}` : ''}`);
    out.push(`headers:\n${res.headers.slice(0, 40).map((h) => `  ${h.key}: ${hide(h.value)}`).join('\n')}${res.headers.length > 40 ? `\n  …${res.headers.length - 40} more` : ''}`);
    const kind = bodyKind(res);
    if (kind === 'image' || kind === 'binary') out.push(`body: ${kind} (${formatSize(res.bodySize)})`);
    else {
      const text = responseText(res);
      const shown = kind === 'json' ? prettyJson(text) ?? text : text;
      out.push(`body (${kind}):\n${hide(shown.length > maxChars ? `${shown.slice(0, maxChars)}\n…[${shown.length - maxChars} more chars]` : shown)}`);
    }
  }
  if (r.tests.length) out.push(`tests: ${passedCount(r.tests)} passed, ${failedCount(r.tests)} failed\n${r.tests.map((t) => `  ${t.skipped ? 'SKIP' : t.passed ? 'PASS' : 'FAIL'} ${t.name}${t.error ? ` — ${t.error}` : ''}`).join('\n')}`);
  if (r.logs.length) out.push(`console:\n${r.logs.slice(0, 50).map((l) => `  [${l.from}] ${l.level === 'log' ? '' : `${l.level}: `}${hide(l.text)}`).join('\n')}`);
  return out.join('\n');
}

async function readImport(input: Record<string, unknown>): Promise<string | { text: string; yaml?: unknown }> {
  let text = s(input.import);
  if (!text && input.import_path !== undefined) {
    const p = safePath(s(input.import_path));
    if (!p) return fail('import_path must be a workspace path');
    try { const f = await readWorktreeFile(p); if (f.binary || f.tooLarge) return fail(`${p} is not a text file`); text = f.content; }
    catch (error) { return fail(`could not read ${p}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const t = text.trim();
  if (!t) return { text: '' };
  if (!/^curl(\.exe)?\s/i.test(t) && !/^[[{]/.test(t)) {
    try { return { text: t, yaml: await yamlToJson(t) }; } catch (error) { return fail(`the import is not cURL, JSON or YAML: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { text: t };
}

export const API_TOOLS: ToolSpec[] = [
  {
    id: 'api_list',
    name: 'api_list',
    description: 'List the API collections (.pigry/apis/<owner>/*.api.json) with their request counts, and the environments (which one is active). The user\'s own are under user/.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushApiEditors();
      const [cRefs, eRefs] = await Promise.all([listCollectionRefs(), listEnvironmentRefs()]);
      const rows: string[] = [];
      for (const ref of cRefs.slice(0, 60)) {
        try { rows.push(`- ${refKey(ref)}: ${summarizeCollection((await loadCollection(ref)).collection)}`); } catch { rows.push(`- ${refKey(ref)}: (unreadable)`); }
      }
      const selected = getSelectedEnvironment();
      const envRows: string[] = [];
      for (const ref of eRefs) { try { const e = await loadEnvironment(ref); envRows.push(`- ${refKey(ref)}: "${e.name}", ${e.values.length} variable(s)${refKey(ref) === selected ? ' (active)' : ''}`); } catch { envRows.push(`- ${refKey(ref)}: (unreadable)`); } }
      const g = await loadGlobals();
      return `Collections:\n${rows.join('\n') || '(none yet — create one with api_write)'}\n\nEnvironments:\n${envRows.join('\n') || '(none)'}\nGlobals: ${g.values.length} variable(s)${selected ? '' : '\nNo environment is active.'}`;
    },
  },
  {
    id: 'api_read',
    name: 'api_read',
    description: 'Read a collection: its variables (secret values hidden), auth, scripts and the tree of folders and requests with their ids. Give request (id, "Folder / Request" path or name) to see one request in full: URL, params, path variables, headers, auth (with what it inherits), body and scripts.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Collection name, or owner/name' }, request: { type: 'string', description: 'A request or folder: id, path or name' } }, required: ['name'] },
    run: async (input) => {
      const opened = await openCollection(input);
      if (typeof opened === 'string') return opened;
      return `${refKey(opened.ref)}\n${readCollection(opened.collection, input.request)}${opened.warnings.length ? `\nRepaired on load:\n- ${opened.warnings.join('\n- ')}` : ''}`;
    },
  },
  {
    id: 'api_write',
    name: 'api_write',
    description: `Create a collection in your own folder (or replace your own with overwrite: true): empty, from ops, or imported from a Postman Collection v2.1, an OpenAPI 3 / Swagger 2 document (JSON or YAML) or a cURL command given as import (text) or import_path (a workspace file). It is shown in the RESTful API menu.\n${OP_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Collection file name; becomes .pigry/apis/<you>/<name>.api.json' },
        title: { type: 'string', description: 'Display name (default: the imported title or the name)' },
        description: { type: 'string' },
        import: { type: 'string', description: 'Postman / OpenAPI JSON or YAML, or a cURL command' },
        import_path: { type: 'string', description: 'Workspace path of a file to import instead' },
        ops: opsSchema,
        overwrite: { type: 'boolean' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('api_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, [API_EXT]);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create collections in your own folder (${caller}/) — change another owner's collection with api_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushApiEditors();
      if ((await listCollectionRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) return fail(`collection "${refKey(ref)}" already exists. Read it with api_read and change it with api_edit, or pass overwrite: true.`);
      const imp = await readImport(input);
      if (typeof imp === 'string') return imp;
      let collection = emptyCollection(s(input.title).trim() || name);
      let note = '';
      if (imp.text) {
        try {
          const result = importAny(imp.text, imp.yaml);
          if (result.kind === 'environment') return fail('that is an environment — create it with api_env (action "create", import)');
          if (result.kind === 'request') collection.items.push(result.request);
          else collection = result.collection;
          note = `imported ${result.format}`;
          if (s(input.title).trim()) collection.name = s(input.title).trim();
        } catch (error) { return fail(`could not import: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (input.description !== undefined) collection.description = s(input.description);
      const { ops, errors } = input.ops === undefined ? { ops: [] as Op[], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const result = applyOps(collection, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveCollection(ref, result.collection, 'agent');
      return `saved ${path}${note ? ` (${note})` : ''}\n${summarizeCollection(result.collection)}${result.log.length ? `\n${result.log.slice(0, 60).join('\n')}` : ''}\n${readCollection(result.collection).split('\n').slice(1, 60).join('\n')}\nShow it to the user with api_open; send a request with api_send.`;
    },
  },
  {
    id: 'api_edit',
    name: 'api_edit',
    description: `Change a collection with a list of operations, applied in order and saved only if all of them work; returns a log with the ids of new requests and folders. ${OP_HELP}`,
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Collection name, or owner/name' }, ops: opsSchema }, required: ['name', 'ops'] },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (!ops.length) return fail('api_edit needs at least one operation');
      const opened = await openCollection(input);
      if (typeof opened === 'string') return opened;
      const result = applyOps(opened.collection, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved${result.log.length ? ` (the ops before it worked: ${result.log.join('; ')})` : ''}`);
      const path = await saveCollection(opened.ref, result.collection, 'agent');
      return `saved ${path}\n${result.log.slice(0, 80).join('\n')}\n${summarizeCollection(result.collection)}`;
    },
  },
  {
    id: 'api_env',
    name: 'api_env',
    description: 'Environments and global variables. action: "list"; "read" (name; secret values are hidden); "create" (name, values?: {key: value}, secret?: [keys], or import: a Postman environment JSON) in your own folder; "set" (name or scope: "globals", values: {key: value}, secret?: [keys that hold secrets — kept out of git]); "unset" (name or scope: "globals", keys: [..]); "select" (name, or "none") makes it the active environment in the menu.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'create', 'set', 'unset', 'select'] },
        name: { type: 'string', description: 'Environment name or owner/name' },
        scope: { type: 'string', enum: ['environment', 'globals'] },
        values: { type: 'object', description: '{"baseUrl": "http://localhost:3000", "token": "…"}' },
        secret: { type: 'array', items: { type: 'string' }, description: 'Keys whose values are secret (stored in .pigry/cache, masked)' },
        keys: { type: 'array', items: { type: 'string' } },
        import: { type: 'string', description: 'Postman environment JSON (for create)' },
      },
      required: ['action'],
    },
    run: async (input) => {
      const action = s(input.action);
      const caller = callerOf(input);
      await flushApiEditors();
      if (action === 'list') {
        const refs = await listEnvironmentRefs();
        const selected = getSelectedEnvironment();
        const rows: string[] = [];
        for (const ref of refs) { try { const e = await loadEnvironment(ref); rows.push(`- ${refKey(ref)}: "${e.name}" — ${e.values.map((v) => v.key).join(', ') || '(empty)'}${refKey(ref) === selected ? ' (active)' : ''}`); } catch { rows.push(`- ${refKey(ref)}: (unreadable)`); } }
        const g = await loadGlobals();
        return `${rows.join('\n') || 'No environments yet (create one with action "create").'}\nGlobals: ${g.values.map((v) => v.key).join(', ') || '(none)'}`;
      }
      const globalsScope = s(input.scope) === 'globals' || s(input.name).toLowerCase() === 'globals';
      const values = typeof input.values === 'object' && input.values !== null && !Array.isArray(input.values) ? (input.values as Record<string, unknown>) : null;
      const secret = new Set(Array.isArray(input.secret) ? input.secret.map(s) : []);
      const setValues = (vars: Variable[]): Variable[] => {
        const out = [...vars];
        for (const [k, raw] of Object.entries(values ?? {})) {
          const v = typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : s(raw);
          const i = out.findIndex((x) => x.key === k);
          if (i >= 0) out[i] = { ...out[i], value: v, enabled: true, ...(secret.has(k) ? { secret: true } : {}) };
          else out.push(newVariable(k, v, secret.has(k)));
        }
        for (const k of secret) { const i = out.findIndex((x) => x.key === k); if (i >= 0) out[i] = { ...out[i], secret: true }; }
        return out;
      };
      if (action === 'create') {
        const name = s(input.name).trim();
        if (!name) return fail('create needs a name');
        const parsed = parseRefName(name, [ENV_EXT]);
        if (parsed.owner && parsed.owner !== caller) return fail(`create environments in your own folder (${caller}/)`);
        const ref: OwnedRef = { owner: caller, slug: parsed.slug };
        if ((await listEnvironmentRefs()).some((r) => refKey(r) === refKey(ref))) return fail(`environment "${refKey(ref)}" already exists — change it with action "set"`);
        let env = emptyEnvironment(name);
        if (s(input.import).trim()) {
          try { const r = importAny(s(input.import)); if (r.kind !== 'environment') return fail('import is not a Postman environment'); env = r.environment; } catch (error) { return fail(`could not import: ${error instanceof Error ? error.message : String(error)}`); }
        }
        env.values = setValues(env.values);
        const path = await saveEnvironment(ref, env, 'agent');
        return `saved ${path}\n${mask(env.values)}\nMake it active with action "select".`;
      }
      if (action === 'select') {
        if (s(input.name).toLowerCase() === 'none' || !s(input.name)) { setSelectedEnvironment(null); return 'No environment is active now.'; }
        const r = await resolveEnvironmentRef(s(input.name), caller);
        if ('error' in r) return fail(r.error);
        setSelectedEnvironment(refKey(r.ref));
        return `"${refKey(r.ref)}" is the active environment now.`;
      }
      let ref: OwnedRef | null = null;
      let env: Environment;
      if (globalsScope) env = await loadGlobals();
      else {
        const r = await resolveEnvironmentRef(s(input.name), caller);
        if ('error' in r) return fail(`${r.error} (see action "list")`);
        ref = r.ref;
        env = await loadEnvironment(ref);
      }
      const label = ref ? refKey(ref) : 'globals';
      if (action === 'read') return `${label} ("${env.name}")\n${mask(env.values)}`;
      if (action === 'set') {
        if (!values && !secret.size) return fail('set needs values: {key: value}');
        const next = { ...env, values: setValues(env.values) };
        const path = ref ? await saveEnvironment(ref, next, 'agent') : await saveGlobals(next, 'agent');
        return `saved ${path}\n${mask(next.values)}`;
      }
      if (action === 'unset') {
        const keys = Array.isArray(input.keys) ? input.keys.map(s) : [];
        if (!keys.length) return fail('unset needs keys');
        const next = { ...env, values: env.values.filter((v) => !keys.includes(v.key)) };
        const path = ref ? await saveEnvironment(ref, next, 'agent') : await saveGlobals(next, 'agent');
        return `saved ${path}\n${mask(next.values)}`;
      }
      return fail('action must be list, read, create, set, unset or select');
    },
  },
  {
    id: 'api_send',
    name: 'api_send',
    description: 'Send an HTTP request from the backend (no CORS) and get the status, time, size, headers, body (JSON pretty-printed) and test results. Either a saved request (name: collection, request: id/path/name — its folder and collection auth, scripts and variables apply) or an ad-hoc one (method, url, headers, params, body, auth, tests). Uses the active environment unless environment is given ("none" for no environment). Variables set by scripts (pm.environment.set …) are saved; secret values are masked in the output.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Collection of the saved request' },
        request: { type: 'string', description: 'Saved request: id, "Folder / Request" path or name' },
        environment: { type: 'string', description: 'Environment name, or "none"' },
        ...requestProps,
        timeout_ms: { type: 'number' },
        max_body_chars: { type: 'number', description: 'How much of the body to return (default 6000)' },
        save: { type: 'boolean', description: 'Save variables that scripts set (default true)' },
      },
    },
    run: async (input) => {
      await flushApiEditors();
      let col: { ref: OwnedRef; collection: Collection } | null = null;
      let request: ApiRequest;
      if (s(input.request).trim()) {
        const opened = await openCollection(input);
        if (typeof opened === 'string') return opened;
        const found = lookupItem(opened.collection, input.request);
        if (!found || found.item.type !== 'request') return fail(`no request "${s(input.request)}" in ${refKey(opened.ref)} (see api_read)`);
        col = { ref: opened.ref, collection: opened.collection };
        request = found.item;
        const overrides = Object.keys(requestProps).filter((k) => input[k] !== undefined);
        if (overrides.length) {
          const edited = applyOps(opened.collection, [{ op: 'update_request', id: request.id, ...Object.fromEntries(overrides.map((k) => [k, input[k]])) }]);
          if (edited.error) return fail(edited.error);
          request = findItem(edited.collection, request.id)!.item as ApiRequest;
        }
      } else {
        if (!s(input.url).trim()) return fail('give url (an ad-hoc request) or name + request (a saved one)');
        const r = requestFromInput(input);
        if (typeof r === 'string') return fail(r);
        request = r;
        if (nameOf(input)) { const opened = await openCollection(input); if (typeof opened === 'string') return opened; col = { ref: opened.ref, collection: opened.collection }; }
      }
      if (typeof input.timeout_ms === 'number') request = { ...request, settings: { ...request.settings, timeoutMs: Math.max(0, Math.min(600_000, input.timeout_ms)) } };
      const env = await pickEnvironment(input);
      if (typeof env === 'string') return env;
      const globals = await loadGlobals();
      const collection = col?.collection ?? emptyCollection();
      const before: VarScopes = { globals: varsToMap(globals.values), collection: varsToMap(collection.variables), environment: env.env ? varsToMap(env.env.values) : {}, local: {} };
      const secrets = [...globals.values, ...collection.variables, ...(env.env?.values ?? [])].filter((v) => v.secret && v.value).map((v) => v.value);
      const jar = await loadCookies();
      const result = await runRequest({ collection, request, scopes: before, hasEnvironment: !!env.env, send: sendViaBackend, runScript: runScriptSandboxed, jar, id: newId('agent-send') });
      const saved = input.save === false ? [] : await persistScopes(before, result.scopes, env, col, globals).catch((e) => [`could not save variables: ${String(e)}`]);
      if (JSON.stringify(result.jar) !== JSON.stringify(jar)) await saveCookies(result.jar).catch(() => undefined);
      await pushHistory({
        id: newId('h'), at: new Date().toISOString(), method: result.prepared?.method ?? request.method, url: result.prepared?.url ?? request.url,
        status: result.response?.status ?? null, timeMs: result.response ? Math.round(result.response.timeMs) : null, size: result.response?.bodySize ?? null,
        ...(result.error ? { error: result.error } : {}), ...(col ? { source: { collection: refKey(col.ref), request: request.id } } : {}), request,
      }).catch(() => undefined);
      const max = typeof input.max_body_chars === 'number' ? Math.max(200, Math.min(100_000, input.max_body_chars)) : 6000;
      return `${col ? `${refKey(col.ref)} · ${request.name}\n` : ''}environment: ${env.key ?? 'none'}\n${describeResult(result, max, secrets)}${saved.length ? `\nsaved variables:\n  ${saved.join('\n  ')}` : ''}`;
    },
  },
  {
    id: 'api_run',
    name: 'api_run',
    description: 'Run every request of a collection (or of one folder) in order, like Postman\'s collection runner, with the active environment (or environment). Scripts run and variables chain from request to request (pm.setNextRequest works). Returns status, time and test results per request.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Collection' }, folder: { type: 'string', description: 'Only this folder (id, path or name)' }, environment: { type: 'string' } }, required: ['name'] },
    run: async (input) => {
      const opened = await openCollection(input);
      if (typeof opened === 'string') return opened;
      const c = opened.collection;
      let requests = listRequests(c).map((x) => x.request);
      if (s(input.folder).trim()) {
        const f = lookupItem(c, input.folder);
        if (!f || f.item.type !== 'folder') return fail(`no folder "${s(input.folder)}"`);
        requests = [...walk(f.item.items)].filter((x) => x.item.type === 'request').map((x) => x.item as ApiRequest);
      }
      if (!requests.length) return fail('there are no requests to run');
      const env = await pickEnvironment(input);
      if (typeof env === 'string') return env;
      const globals = await loadGlobals();
      const before: VarScopes = { globals: varsToMap(globals.values), collection: varsToMap(c.variables), environment: env.env ? varsToMap(env.env.values) : {}, local: {} };
      const jar = await loadCookies();
      const out = await runCollection({ collection: c, requests, scopes: before, hasEnvironment: !!env.env, send: sendViaBackend, runScript: runScriptSandboxed, jar });
      const saved = await persistScopes(before, out.scopes, env, { ref: opened.ref, collection: c }, globals).catch((e) => [`could not save variables: ${String(e)}`]);
      if (JSON.stringify(out.jar) !== JSON.stringify(jar)) await saveCookies(out.jar).catch(() => undefined);
      const tests = out.steps.flatMap((x) => x.tests);
      const lines = out.steps.map((x, i) => `${i + 1}. ${x.name}: ${x.status ?? 'no response'}${x.timeMs !== null ? ` · ${formatTime(x.timeMs)}` : ''}${x.error ? ` · ERROR ${x.error}` : ''}${x.tests.length ? `\n${x.tests.map((t) => `     ${t.skipped ? 'SKIP' : t.passed ? 'PASS' : 'FAIL'} ${t.name}${t.error ? ` — ${t.error}` : ''}`).join('\n')}` : ''}`);
      return `${refKey(opened.ref)} — ran ${out.steps.length} request(s) with environment ${env.key ?? 'none'}: ${passedCount(tests)} test(s) passed, ${failedCount(tests)} failed, ${out.steps.filter((x) => x.error).length} error(s)\n${lines.join('\n')}${saved.length ? `\nsaved variables:\n  ${saved.join('\n  ')}` : ''}`;
    },
  },
  {
    id: 'api_export',
    name: 'api_export',
    description: 'Export a collection as Postman Collection v2.1 JSON (format "postman", saved to path, default .pigry/apis/exports/<name>.postman_collection.json; secret values are left out), or one request as code: format "curl", "fetch" (JavaScript) or "python" (requests), with the active environment\'s values filled in.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, format: { type: 'string', enum: ['postman', 'curl', 'fetch', 'python'] }, request: { type: 'string' }, path: { type: 'string' }, environment: { type: 'string' } }, required: ['name', 'format'] },
    run: async (input) => {
      const opened = await openCollection(input);
      if (typeof opened === 'string') return opened;
      const format = s(input.format);
      if (format === 'postman') {
        const path = safePath(s(input.path) || `.pigry/apis/exports/${opened.ref.slug}.postman_collection.json`);
        if (!path) return fail('path must be inside the workspace');
        await writeWorktreeFile(path, `${JSON.stringify(exportPostman(opened.collection), null, 2)}\n`);
        return `saved ${path} (Postman Collection v2.1, ${listRequests(opened.collection).length} request(s))`;
      }
      if (!['curl', 'fetch', 'python'].includes(format)) return fail('format must be postman, curl, fetch or python');
      const found = lookupItem(opened.collection, input.request);
      if (!found || found.item.type !== 'request') return fail('give request (id, path or name) for a code snippet');
      const env = await pickEnvironment(input);
      if (typeof env === 'string') return env;
      const globals = await loadGlobals();
      const scopes: VarScopes = { globals: varsToMap(globals.values), collection: varsToMap(opened.collection.variables), environment: env.env ? varsToMap(env.env.values) : {}, local: {} };
      const prepared = prepareRequest(found.item, scopes, effectiveAuth(opened.collection, found.item.id).auth);
      return snippet(format as SnippetLang, prepared);
    },
  },
  {
    id: 'api_open',
    name: 'api_open',
    description: 'Open a collection in the RESTful API menu so the user can see it; optionally open one request (id, path or name) in a tab.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, request: { type: 'string' } }, required: ['name'] },
    run: async (input) => {
      const opened = await openCollection(input);
      if (typeof opened === 'string') return opened;
      let request: string | undefined;
      if (input.request !== undefined) {
        const f = lookupItem(opened.collection, input.request);
        if (!f || f.item.type !== 'request') return fail(`no request "${s(input.request)}" in ${refKey(opened.ref)}`);
        request = f.item.id;
      }
      requestOpenApi(refKey(opened.ref), request);
      return `opened "${refKey(opened.ref)}" in the RESTful API menu${request ? ` with request ${request}` : ''}`;
    },
  },
];

