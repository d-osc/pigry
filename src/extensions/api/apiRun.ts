/** Sending a request the Postman way: pre-request scripts (collection → folders → request), variables and auth,
 * cookies from the jar, the HTTP call, then the test scripts. The transport and the script runner are passed in, so
 * the same pipeline runs in the app (Rust backend + Web Worker) and in node tests (fakes). Pure — node tests import it. */
import {
  cookieHeaderFor, effectiveAuth, headerValue, prepareRequest, resolveVars, responseCookies, responseText, scriptChain, storeCookies, toWire,
  type ApiRequest, type ApiResponse, type Collection, type CookieJar, type PreparedRequest, type VarScopes,
} from './api.ts';
import type { ScriptInput, ScriptLog, ScriptOutput, TestResult } from './apiScript.ts';

export interface WireRequest { id: string; method: string; url: string; headers: Array<{ key: string; value: string }>; body?: string; bodyBase64?: string; timeoutMs?: number; followRedirects?: boolean; verifyTls?: boolean }
export type Transport = (req: WireRequest) => Promise<ApiResponse>;
export type ScriptRunner = (input: ScriptInput) => Promise<ScriptOutput>;

export interface RunOptions {
  /** The collection the request belongs to (for inherited auth, scripts and variables); an empty one for drafts. */
  collection: Collection;
  request: ApiRequest;
  scopes: VarScopes;
  hasEnvironment: boolean;
  send: Transport;
  runScript: ScriptRunner;
  jar?: CookieJar;
  id?: string;
  /** Default timeout when the request has none of its own. */
  timeoutMs?: number;
  iteration?: number;
  iterationCount?: number;
}
export interface RunResult {
  prepared: PreparedRequest | null;
  response: ApiResponse | null;
  error?: string;
  /** Where the error happened. */
  stage?: 'prerequest' | 'send' | 'test';
  tests: TestResult[];
  logs: Array<ScriptLog & { from: string }>;
  scopes: VarScopes;
  jar: CookieJar;
  nextRequest?: string | null;
}

const pairs = (list: Array<{ key: string; value: string; enabled?: boolean }>) => list.filter((h) => h.enabled !== false).map((h) => ({ key: h.key, value: h.value }));

export async function runRequest(o: RunOptions): Promise<RunResult> {
  let scopes: VarScopes = { globals: { ...o.scopes.globals }, collection: { ...o.scopes.collection }, environment: { ...o.scopes.environment }, local: { ...o.scopes.local } };
  let request: ApiRequest = { ...o.request, headers: o.request.headers.map((h) => ({ ...h })), body: { ...o.request.body } };
  let jar = o.jar ?? {};
  const logs: RunResult['logs'] = [];
  const tests: TestResult[] = [];
  let nextRequest: string | null | undefined;
  const info = { requestName: request.name, requestId: request.id, iteration: o.iteration ?? 0, iterationCount: o.iterationCount ?? 1 };
  const done = (patch: Partial<RunResult>): RunResult => ({ prepared: null, response: null, tests, logs, scopes, jar, ...(nextRequest !== undefined ? { nextRequest } : {}), ...patch });

  // 1. pre-request scripts
  for (const script of scriptChain(o.collection, request.id, 'preRequest', o.request.preRequest)) {
    const out = await o.runScript({ code: script.code, event: 'prerequest', request: { method: request.method, url: request.url, headers: request.headers, body: { mode: request.body.mode, raw: request.body.raw } }, scopes, info, hasEnvironment: o.hasEnvironment });
    scopes = out.scopes;
    logs.push(...out.logs.map((l) => ({ ...l, from: `${script.from} pre-request` })));
    tests.push(...out.tests);
    if (out.nextRequest !== undefined) nextRequest = out.nextRequest;
    // what the script changed on pm.request
    const keepIds = new Map(request.headers.map((h) => [`${h.key}\n${h.value}`, h.id]));
    request = {
      ...request, method: out.request.method || request.method, url: out.request.url,
      headers: out.request.headers.map((h, i) => ({ id: keepIds.get(`${h.key}\n${h.value}`) ?? `s${i}`, key: h.key, value: h.value, enabled: h.enabled !== false })),
      body: { ...request.body, mode: out.request.body.mode as ApiRequest['body']['mode'], raw: out.request.body.raw },
    };
    if (out.error) return done({ error: `There was an error in the ${script.from} pre-request script: ${out.error}`, stage: 'prerequest' });
  }

  // 2. build and send
  const missing = new Set<string>();
  resolveVars(request.url, scopes, missing);
  if (missing.size) return done({ error: `The URL uses ${missing.size === 1 ? 'a variable that is' : 'variables that are'} not defined: ${[...missing].map((m) => `{{${m}}}`).join(', ')} — pick an environment or add ${missing.size === 1 ? 'it' : 'them'}`, stage: 'send' });
  const { auth } = effectiveAuth(o.collection, request.id, o.request.auth);
  let prepared: PreparedRequest;
  try { prepared = prepareRequest(request, scopes, auth); }
  catch (e) { return done({ error: `Could not build the request: ${e instanceof Error ? e.message : String(e)}`, stage: 'send' }); }
  if (!headerValue(prepared.headers, 'cookie')) {
    const cookie = cookieHeaderFor(jar, prepared.url);
    if (cookie) prepared = { ...prepared, headers: [...prepared.headers, { key: 'Cookie', value: cookie }] };
  }
  if (!/^https?:\/\//i.test(prepared.url)) return done({ prepared, error: `Invalid URL "${prepared.url}" — only http:// and https:// can be sent`, stage: 'send' });
  const wire = toWire(prepared);
  let response: ApiResponse;
  try {
    response = await o.send({
      id: o.id ?? '', method: prepared.method, url: prepared.url, headers: wire.headers, body: wire.body, bodyBase64: wire.bodyBase64,
      timeoutMs: request.settings.timeoutMs || o.timeoutMs || undefined, followRedirects: request.settings.followRedirects, verifyTls: request.settings.verifyTls,
    });
  } catch (e) {
    return done({ prepared, error: e instanceof Error ? e.message : String(e), stage: 'send' });
  }
  jar = storeCookies(jar, responseCookies(response));

  // 3. tests
  const cookies = responseCookies(response).map((c) => ({ name: c.name, value: c.value }));
  const scriptResponse = { code: response.status, status: response.statusText, headers: response.headers, body: responseText(response), responseTime: Math.round(response.timeMs), responseSize: response.bodySize, cookies };
  for (const script of scriptChain(o.collection, request.id, 'tests', o.request.tests)) {
    const out = await o.runScript({ code: script.code, event: 'test', request: { method: prepared.method, url: prepared.url, headers: pairs(prepared.headers), body: { mode: request.body.mode, raw: request.body.raw } }, response: scriptResponse, scopes, info, hasEnvironment: o.hasEnvironment });
    scopes = out.scopes;
    logs.push(...out.logs.map((l) => ({ ...l, from: `${script.from} tests` })));
    tests.push(...out.tests);
    if (out.nextRequest !== undefined) nextRequest = out.nextRequest;
    if (out.error) return done({ prepared, response, error: `There was an error in the ${script.from} test script: ${out.error}`, stage: 'test' });
  }
  return done({ prepared, response });
}

/** What a run changed in one variable scope: values set and keys removed. */
export function scopeChanges(before: Record<string, string>, after: Record<string, string>): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(after)) if (before[k] !== v) set[k] = v;
  return { set, unset: Object.keys(before).filter((k) => !Object.prototype.hasOwnProperty.call(after, k)) };
}

export interface RunnerStep { name: string; requestId: string; status: number | null; timeMs: number | null; tests: TestResult[]; error?: string }
/** Runs requests in order (a folder or the whole collection), following pm.setNextRequest(name) / null like Postman's runner. */
export async function runCollection(o: Omit<RunOptions, 'request'> & { requests: ApiRequest[]; onStep?: (step: RunnerStep, index: number) => void; shouldStop?: () => boolean; maxSteps?: number }): Promise<{ steps: RunnerStep[]; scopes: VarScopes; jar: CookieJar }> {
  const steps: RunnerStep[] = [];
  let scopes = o.scopes;
  let jar = o.jar ?? {};
  let i = 0;
  const max = o.maxSteps ?? Math.max(50, o.requests.length * 10);
  while (i >= 0 && i < o.requests.length && steps.length < max) {
    if (o.shouldStop?.()) break;
    const request = o.requests[i];
    const r = await runRequest({ ...o, request, scopes, jar, iteration: 0, iterationCount: 1 });
    scopes = { ...r.scopes, local: {} };
    jar = r.jar;
    const step: RunnerStep = { name: request.name, requestId: request.id, status: r.response?.status ?? null, timeMs: r.response ? Math.round(r.response.timeMs) : null, tests: r.tests, ...(r.error ? { error: r.error } : {}) };
    steps.push(step);
    o.onStep?.(step, steps.length - 1);
    if (r.nextRequest === null) break;
    if (typeof r.nextRequest === 'string') {
      const at = o.requests.findIndex((x) => x.name === r.nextRequest || x.id === r.nextRequest);
      if (at < 0) break;
      i = at;
    } else i++;
  }
  return { steps, scopes, jar };
}

export const passedCount = (tests: TestResult[]): number => tests.filter((t) => t.passed && !t.skipped).length;
export const failedCount = (tests: TestResult[]): number => tests.filter((t) => !t.passed).length;
