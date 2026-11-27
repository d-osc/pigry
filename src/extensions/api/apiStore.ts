/** RESTful API files and local state, shared by the API screen and the agent's api_* tools.
 *
 * In git (.pigry/apis/<owner>/):  <name>.api.json  collections   ·  <name>.env.json  environments  ·  user/globals.env.json  globals
 * Local only (.pigry/cache/apis/, git-ignored): secrets.json (values of variables marked secret), history.json, cookies.json.
 *
 * Also here: change events, "flush unsaved edits", "open this collection / request", the selected environment, and
 * the transport (the Rust http_send command) and script runner (a Web Worker) the send pipeline uses. */
import { getFileTree, httpCancel, httpSend, readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { deleteDoc, readDocText, writeDocText } from '../../lib/docFile';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, USER_OWNER, type OwnedRef, type Resolved } from '../../lib/ownedFiles';
import {
  API_DIR, API_EXT, ENV_EXT, GLOBALS_SLUG, HISTORY_LIMIT, LOCAL_DIR, emptyEnvironment, mergeSecrets, parseCollectionJson, parseEnvironmentJson, serializeCollection, serializeEnvironment, splitSecrets,
  type ApiResponse, type Collection, type CookieJar, type Environment, type HistoryEntry,
} from './api';
import { runScript, type ScriptInput, type ScriptOutput } from './apiScript';
import type { Transport, WireRequest } from './apiRun';

export const API_CHANGED = 'pigry:api-changed';
export const API_OPEN = 'pigry:open-api';
export const API_LOCAL_CHANGED = 'pigry:api-local-changed';

export interface ApiChange { kind: 'collection' | 'environment' | 'globals'; key: string; source: 'editor' | 'agent'; deleted?: boolean }

export const collectionPath = (ref: OwnedRef): string => pathOf(API_DIR, API_EXT, ref);
export const environmentPath = (ref: OwnedRef): string => pathOf(API_DIR, ENV_EXT, ref);
export const GLOBALS_REF: OwnedRef = { owner: USER_OWNER, slug: GLOBALS_SLUG };
export const keyOf = (ref: OwnedRef): string => refKey(ref);
export const refOfKey = (key: string): OwnedRef => { const cut = key.indexOf('/'); return cut < 0 ? { owner: '', slug: key } : { owner: key.slice(0, cut), slug: key.slice(cut + 1) }; };

export function notifyApiChanged(change: ApiChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ApiChange>(API_CHANGED, { detail: change }));
}

async function listRefs(ext: string): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(API_DIR, ext, path)).filter((ref): ref is OwnedRef => ref !== null));
}
export const listCollectionRefs = (): Promise<OwnedRef[]> => listRefs(API_EXT);
/** Environments, without the globals file. */
export const listEnvironmentRefs = async (): Promise<OwnedRef[]> => (await listRefs(ENV_EXT)).filter((r) => !(r.owner === GLOBALS_REF.owner && r.slug === GLOBALS_REF.slug));
export async function resolveCollectionRef(name: string, caller?: string): Promise<Resolved> { return resolveRef(await listCollectionRefs(), name, caller, [API_EXT]); }
export async function resolveEnvironmentRef(name: string, caller?: string): Promise<Resolved> { return resolveRef(await listEnvironmentRefs(), name, caller, [ENV_EXT]); }

/* ---------------- local, git-ignored state ---------------- */

const SECRETS = `${LOCAL_DIR}secrets.json`;
const HISTORY = `${LOCAL_DIR}history.json`;
const COOKIES = `${LOCAL_DIR}cookies.json`;
const CACHE_IGNORE = '.pigry/cache/.gitignore';
let ignoreChecked = false;
let localQueue: Promise<unknown> = Promise.resolve();

async function readLocal<T>(path: string, fallback: T, check: (v: unknown) => boolean): Promise<T> {
  try {
    const file = await readWorktreeFile(path);
    if (file.binary || file.tooLarge) return fallback;
    const value = JSON.parse(file.content) as unknown;
    return check(value) ? (value as T) : fallback;
  } catch { return fallback; }
}
/** Makes sure .pigry/cache/ is ignored by git before anything secret is written there. */
async function ensureIgnored(): Promise<void> {
  if (ignoreChecked) return;
  let ok = false;
  try { const f = await readWorktreeFile(CACHE_IGNORE); ok = !f.binary && /^\s*\*\s*$/m.test(f.content); } catch { ok = false; }
  if (!ok) await writeWorktreeFile(CACHE_IGNORE, "# Pigry's local caches and secrets: never committed.\n*\n");
  ignoreChecked = true;
}
/** Read-modify-write of one local file, one at a time. */
function updateLocal<T>(path: string, fallback: T, check: (v: unknown) => boolean, fn: (v: T) => T): Promise<T> {
  const run = localQueue.then(async () => {
    await ensureIgnored();
    const next = fn(await readLocal(path, fallback, check));
    await writeWorktreeFile(path, `${JSON.stringify(next, null, 1)}\n`);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(API_LOCAL_CHANGED, { detail: path }));
    return next;
  });
  localQueue = run.catch(() => undefined);
  return run;
}
const isRecord = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
type SecretStore = Record<string, Record<string, string>>;
const secretsOf = async (scope: string): Promise<Record<string, string>> => (await readLocal<SecretStore>(SECRETS, {}, isRecord))[scope] ?? {};
const writeSecrets = (scope: string, values: Record<string, string> | null): Promise<SecretStore> =>
  updateLocal<SecretStore>(SECRETS, {}, isRecord, (all) => { const next = { ...all }; if (values && Object.keys(values).length) next[scope] = values; else delete next[scope]; return next; });

export const loadHistory = (): Promise<HistoryEntry[]> => readLocal<HistoryEntry[]>(HISTORY, [], Array.isArray);
export const pushHistory = (entry: HistoryEntry): Promise<HistoryEntry[]> => updateLocal<HistoryEntry[]>(HISTORY, [], Array.isArray, (list) => [entry, ...list.filter((e) => e && typeof e === 'object')].slice(0, HISTORY_LIMIT));
export const removeHistory = (id: string | null): Promise<HistoryEntry[]> => updateLocal<HistoryEntry[]>(HISTORY, [], Array.isArray, (list) => (id === null ? [] : list.filter((e) => e.id !== id)));
export const loadCookies = (): Promise<CookieJar> => readLocal<CookieJar>(COOKIES, {}, isRecord);
export const saveCookies = (jar: CookieJar): Promise<CookieJar> => updateLocal<CookieJar>(COOKIES, {}, isRecord, () => jar);

/* ---------------- collections and environments ---------------- */

export async function loadCollection(ref: OwnedRef): Promise<{ collection: Collection; warnings: string[]; ref: OwnedRef }> {
  const file = await readDocText(collectionPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${collectionPath(ref)} is not a readable collection`);
  const { value, warnings } = parseCollectionJson(file.content, ref.slug);
  value.variables = mergeSecrets(value.variables, await secretsOf(`collection:${refKey(ref)}`));
  return { collection: value, warnings, ref };
}
export async function saveCollection(ref: OwnedRef, c: Collection, source: ApiChange['source'] = 'editor'): Promise<string> {
  const { pub, secrets } = splitSecrets(c.variables);
  await writeDocText(collectionPath(ref), serializeCollection({ ...c, variables: pub }));
  await writeSecrets(`collection:${refKey(ref)}`, secrets);
  notifyApiChanged({ kind: 'collection', key: refKey(ref), source });
  return collectionPath(ref);
}
export async function removeCollection(ref: OwnedRef): Promise<void> {
  await deleteDoc(collectionPath(ref));
  await writeSecrets(`collection:${refKey(ref)}`, null);
  notifyApiChanged({ kind: 'collection', key: refKey(ref), source: 'editor', deleted: true });
}

const isGlobals = (ref: OwnedRef): boolean => ref.owner === GLOBALS_REF.owner && ref.slug === GLOBALS_REF.slug;
export async function loadEnvironment(ref: OwnedRef): Promise<Environment> {
  const file = await readDocText(environmentPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${environmentPath(ref)} is not a readable environment`);
  const env = parseEnvironmentJson(file.content, ref.slug).value;
  env.values = mergeSecrets(env.values, await secretsOf(`environment:${refKey(ref)}`));
  return env;
}
export async function saveEnvironment(ref: OwnedRef, env: Environment, source: ApiChange['source'] = 'editor'): Promise<string> {
  const { pub, secrets } = splitSecrets(env.values);
  await writeDocText(environmentPath(ref), serializeEnvironment({ ...env, values: pub }));
  await writeSecrets(`environment:${refKey(ref)}`, secrets);
  notifyApiChanged({ kind: isGlobals(ref) ? 'globals' : 'environment', key: refKey(ref), source });
  return environmentPath(ref);
}
export async function removeEnvironment(ref: OwnedRef): Promise<void> {
  await deleteDoc(environmentPath(ref));
  await writeSecrets(`environment:${refKey(ref)}`, null);
  notifyApiChanged({ kind: 'environment', key: refKey(ref), source: 'editor', deleted: true });
}
/** The global variables (an empty set until something is saved). */
export async function loadGlobals(): Promise<Environment> {
  const refs = await listRefs(ENV_EXT).catch(() => [] as OwnedRef[]);
  if (!refs.some(isGlobals)) return emptyEnvironment('Globals');
  try { return await loadEnvironment(GLOBALS_REF); } catch { return emptyEnvironment('Globals'); }
}
export const saveGlobals = (env: Environment, source: ApiChange['source'] = 'editor'): Promise<string> => saveEnvironment(GLOBALS_REF, { ...env, name: 'Globals' }, source);

/* ---------------- the selected environment (shared by the screen and the tools) ---------------- */

const ENV_KEY = 'pigry:api-environment';
export function getSelectedEnvironment(): string | null { try { return localStorage.getItem(ENV_KEY) || null; } catch { return null; } }
export function setSelectedEnvironment(key: string | null): void {
  try { if (key) localStorage.setItem(ENV_KEY, key); else localStorage.removeItem(ENV_KEY); } catch { /* storage unavailable */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(API_LOCAL_CHANGED, { detail: ENV_KEY }));
}

/* ---------------- unsaved editor state: tools flush it before they read ---------------- */

const flushers = new Set<() => Promise<void>>();
export function registerApiFlush(flush: () => Promise<void>): () => void { flushers.add(flush); return () => { flushers.delete(flush); }; }
export async function flushApiEditors(): Promise<void> { await Promise.all([...flushers].map((f) => f().catch(() => undefined))); }

/* ---------------- "open this in the RESTful API menu" ---------------- */

export interface ApiOpenRequest { key: string; request?: string; response?: ApiResponse }
let pendingOpen: ApiOpenRequest | null = null;
let openKey: string | null = null;
let openRequest: string | null = null;
export function requestOpenApi(key: string, request?: string): void {
  pendingOpen = { key, request };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ApiOpenRequest>(API_OPEN, { detail: pendingOpen }));
}
export function takePendingOpenApi(): ApiOpenRequest | null { const r = pendingOpen; pendingOpen = null; return r; }
/** What the RESTful API menu shows (the agent panel mentions it as context). */
export const setOpenApi = (key: string | null, request: string | null = null): void => { openKey = key; openRequest = request; };
export const getOpenApi = (): { collection: string | null; request: string | null } => ({ collection: openKey, request: openRequest });

/* ---------------- transport and script runner used in the app ---------------- */

export const sendViaBackend: Transport = async (req: WireRequest) => {
  const res = await httpSend({ ...req, id: req.id || `api-${Date.now().toString(36)}` });
  return res as ApiResponse;
};
export const cancelRequest = (id: string): Promise<boolean> => httpCancel(id).catch(() => false);

const SCRIPT_TIMEOUT_MS = 5000;
/** Runs a script in a fresh Web Worker (no DOM, no Tauri bridge, no network), stopped after 5 s. */
export function runScriptSandboxed(input: ScriptInput, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ScriptOutput> {
  const failed = (error: string): ScriptOutput => ({ tests: [], logs: [], error, request: input.request, scopes: input.scopes });
  if (typeof Worker === 'undefined') return runScript(input);
  return new Promise((resolve) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./apiScriptWorker.ts', import.meta.url), { type: 'module' }); }
    catch (e) { resolve(failed(`Could not start the script sandbox: ${e instanceof Error ? e.message : String(e)}`)); return; }
    const timer = window.setTimeout(() => { worker.terminate(); resolve(failed(`Error: the script ran longer than ${timeoutMs / 1000} s and was stopped`)); }, timeoutMs);
    worker.onmessage = (event: MessageEvent<ScriptOutput>) => { window.clearTimeout(timer); worker.terminate(); resolve(event.data); };
    worker.onerror = (event) => { window.clearTimeout(timer); worker.terminate(); event.preventDefault(); resolve(failed(`Error: ${event.message || 'the script sandbox failed'}`)); };
    worker.postMessage(input);
  });
}
