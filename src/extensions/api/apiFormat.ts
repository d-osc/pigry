/** Formats for the RESTful API menu: cURL import, code snippets (cURL, JavaScript fetch, Python requests), Postman
 * Collection v2.1 / environment import and export, and OpenAPI 3 (and Swagger 2) import. Pure — node tests import it. */
import {
  RAW_LANGUAGES, emptyBody, emptyCollection, emptyEnvironment, formEncode, newFolder, newKV, newRequest, newVariable, normalizeCollection, paramsFromUrl, splitUrl, syncPathVars, walk,
  type ApiFolder, type ApiItem, type ApiRequest, type Auth, type Collection, type Environment, type FormField, type KV, type PreparedRequest, type RawLanguage, type Variable,
} from './api.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/* ---------------- cURL ---------------- */

/** Splits a shell command line like a POSIX shell (quotes, backslash escapes, line continuations; also cmd ^ and PowerShell ` continuations). */
export function shellWords(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let any = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { if (any) { out.push(cur); cur = ''; any = false; } i++; continue; }
    any = true;
    if (ch === "'") { const end = text.indexOf("'", i + 1); if (end < 0) { cur += text.slice(i + 1); i = text.length; } else { cur += text.slice(i + 1, end); i = end + 1; } continue; }
    if (ch === '$' && text[i + 1] === "'") {
      i += 2;
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\' && i + 1 < text.length) { const n = text[i + 1]; cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n; i += 2; } else cur += text[i++];
      }
      i++; continue;
    }
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) { cur += text[i + 1]; i += 2; } else cur += text[i++];
      }
      i++; continue;
    }
    if (ch === '\\' && i + 1 < text.length) { cur += text[i + 1]; i += 2; continue; }
    cur += ch; i++;
  }
  if (any) out.push(cur);
  return out;
}

const languageFor = (contentType: string): RawLanguage => (/json/i.test(contentType) ? 'json' : /xml/i.test(contentType) ? 'xml' : /html/i.test(contentType) ? 'html' : /javascript/i.test(contentType) ? 'javascript' : 'text');

/** A cURL command → a request (method, URL, params, headers, auth, body). Throws when it is not a curl command. */
export function parseCurl(command: string): ApiRequest {
  const words = shellWords(command.trim());
  if (!words.length || !/^curl(\.exe)?$/i.test(words[0].replace(/^.*[\\/]/, ''))) throw new Error('not a cURL command (it must start with curl)');
  let method = '';
  let url = '';
  const headers: KV[] = [];
  const data: string[] = [];
  const urlencoded: string[] = [];
  const form: FormField[] = [];
  let auth: Auth = { type: 'inherit' };
  let get = false, head = false, json = false;
  const settings = { timeoutMs: 0, followRedirects: false, verifyTls: true };
  const takesValue = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '-F', '--form', '--form-string', '-u', '--user', '-A', '--user-agent', '-b', '--cookie', '-e', '--referer', '--url', '-m', '--max-time', '--connect-timeout', '-o', '--output', '-x', '--proxy', '--oauth2-bearer', '-w', '--write-out', '-c', '--cookie-jar', '-T', '--upload-file', '--retry', '--cacert', '--cert', '--key', '-E']);
  for (let i = 1; i < words.length; i++) {
    let w = words[i];
    let value: string | undefined;
    if (w.startsWith('--') && w.includes('=') && takesValue.has(w.slice(0, w.indexOf('=')))) { value = w.slice(w.indexOf('=') + 1); w = w.slice(0, w.indexOf('=')); }
    else if (/^-[XHdFuAbem]./.test(w) && !w.startsWith('--')) { value = w.slice(2); w = w.slice(0, 2); }
    const next = (): string => (value !== undefined ? value : words[++i] ?? '');
    switch (w) {
      case '-X': case '--request': method = next().toUpperCase(); break;
      case '-H': case '--header': {
        const h = next();
        const c = h.indexOf(':');
        if (c > 0) headers.push(newKV(h.slice(0, c).trim(), h.slice(c + 1).trim()));
        else if (h.endsWith(';')) headers.push(newKV(h.slice(0, -1).trim(), ''));
        break;
      }
      case '-d': case '--data': case '--data-ascii': case '--data-binary': case '--data-raw': data.push(next()); break;
      case '--json': data.push(next()); json = true; break;
      case '--data-urlencode': urlencoded.push(next()); break;
      case '-F': case '--form': case '--form-string': {
        const f = next();
        const eq = f.indexOf('=');
        if (eq <= 0) break;
        const key = f.slice(0, eq), val = f.slice(eq + 1);
        if (w !== '--form-string' && val.startsWith('@')) form.push({ ...newKV(key, ''), type: 'file', fileName: val.slice(1).split(';')[0].replace(/^.*[\\/]/, '') });
        else form.push({ ...newKV(key, w !== '--form-string' && val.startsWith('<') ? '' : val.replace(/^"(.*)"$/, '$1')), type: 'text' });
        break;
      }
      case '-u': case '--user': { const u = next(); const c = u.indexOf(':'); auth = { type: 'basic', username: c < 0 ? u : u.slice(0, c), password: c < 0 ? '' : u.slice(c + 1) }; break; }
      case '--oauth2-bearer': auth = { type: 'bearer', token: next() }; break;
      case '-A': case '--user-agent': headers.push(newKV('User-Agent', next())); break;
      case '-b': case '--cookie': { const c = next(); if (c.includes('=')) headers.push(newKV('Cookie', c)); break; }
      case '-e': case '--referer': headers.push(newKV('Referer', next())); break;
      case '--url': url = next(); break;
      case '-G': case '--get': get = true; break;
      case '-I': case '--head': head = true; break;
      case '-L': case '--location': settings.followRedirects = true; break;
      case '-k': case '--insecure': settings.verifyTls = false; break;
      case '-m': case '--max-time': { const n = Number(next()); if (Number.isFinite(n) && n > 0) settings.timeoutMs = Math.round(n * 1000); break; }
      default:
        if (takesValue.has(w)) { next(); break; }
        if (!w.startsWith('-') && !url) url = w;
    }
  }
  if (!url) throw new Error('the cURL command has no URL');
  const r = newRequest({ name: url.replace(/^[a-z]+:\/\//i, '').split('?')[0].slice(0, 80) || 'Imported request' });
  r.auth = auth;
  r.settings = { ...r.settings, ...settings, followRedirects: settings.followRedirects };
  if (json) {
    if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push(newKV('Content-Type', 'application/json'));
    if (!headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push(newKV('Accept', 'application/json'));
  }
  const ct = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  if (get && (data.length || urlencoded.length)) {
    const q = [...data, ...urlencoded.map((u) => encodeUrlencodeArg(u))].join('&');
    url += (url.includes('?') ? '&' : '?') + q;
  } else if (form.length) {
    r.body = { ...emptyBody(), mode: 'formdata', formdata: form };
    const i = headers.findIndex((h) => h.key.toLowerCase() === 'content-type' && /multipart/i.test(h.value));
    if (i >= 0) headers.splice(i, 1);
  } else if (data.length || urlencoded.length) {
    const joined = data.join('&');
    const isForm = !json && (!ct || /x-www-form-urlencoded/i.test(ct)) && (urlencoded.length > 0 || /^[^=&\s{}[\]<>"]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(joined));
    if (isForm) {
      const fields = [...(joined ? joined.split('&') : []), ...urlencoded.map((u) => encodeUrlencodeArg(u))].map((p) => {
        const eq = p.indexOf('=');
        const dec = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
        return newKV(dec(eq < 0 ? p : p.slice(0, eq)), dec(eq < 0 ? '' : p.slice(eq + 1)));
      });
      r.body = { ...emptyBody(), mode: 'urlencoded', urlencoded: fields };
      const i = headers.findIndex((h) => h.key.toLowerCase() === 'content-type' && /x-www-form-urlencoded/i.test(h.value));
      if (i >= 0) headers.splice(i, 1);
    } else {
      let language = languageFor(ct);
      if (!ct && /^\s*[[{]/.test(joined)) { try { JSON.parse(joined); language = 'json'; } catch { /* text */ } }
      r.body = { ...emptyBody(), mode: 'raw', raw: joined, language };
      const i = headers.findIndex((h) => h.key.toLowerCase() === 'content-type' && h.value.toLowerCase().split(';')[0].trim() === ({ json: 'application/json', text: 'text/plain', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript' } as const)[language]);
      if (i >= 0 && !/charset/i.test(headers[i].value)) headers.splice(i, 1);
    }
  }
  r.method = method || (head ? 'HEAD' : (r.body.mode !== 'none' ? 'POST' : 'GET'));
  r.headers = headers;
  r.url = url;
  r.params = paramsFromUrl(url, []);
  r.pathVars = syncPathVars(url, []);
  return r;
}
function encodeUrlencodeArg(arg: string): string {
  const eq = arg.indexOf('=');
  if (eq < 0) return encodeURIComponent(arg);
  return `${arg.slice(0, eq)}=${encodeURIComponent(arg.slice(eq + 1))}`;
}

/* ---------------- code snippets ---------------- */

const shQuote = (t: string): string => `'${t.replace(/'/g, `'\\''`)}'`;
export const SNIPPET_LANGS = [
  { id: 'curl', label: 'cURL' },
  { id: 'fetch', label: 'JavaScript – Fetch' },
  { id: 'python', label: 'Python – Requests' },
] as const;
export type SnippetLang = (typeof SNIPPET_LANGS)[number]['id'];

export function toCurl(p: PreparedRequest): string {
  const lines = [`curl --location${p.method === 'GET' && p.body.kind === 'none' ? '' : ` --request ${p.method}`} ${shQuote(p.url)}`];
  const b = p.body;
  for (const h of p.headers) if (!(b.kind === 'form' && h.key.toLowerCase() === 'content-type')) lines.push(`--header ${shQuote(`${h.key}: ${h.value}`)}`);
  if (b.kind === 'text') lines.push(`--data-raw ${shQuote(b.text)}`);
  else if (b.kind === 'urlencoded') for (const f of b.fields) lines.push(`--data-urlencode ${shQuote(`${f.key}=${f.value}`)}`);
  else if (b.kind === 'form') for (const f of b.fields) lines.push(f.fileName !== undefined ? `--form ${shQuote(`${f.key}=@"${f.fileName}"`)}` : `--form ${shQuote(`${f.key}=${f.value ?? ''}`)}`);
  else if (b.kind === 'binary') lines.push(`--data-binary ${shQuote(`@${b.fileName}`)}`);
  return lines.join(' \\\n');
}

const js = (v: string): string => JSON.stringify(v);
export function toFetch(p: PreparedRequest): string {
  const b = p.body;
  const out: string[] = [];
  const headers = p.headers.filter((h) => !(b.kind === 'form' && h.key.toLowerCase() === 'content-type'));
  out.push('const headers = new Headers();');
  for (const h of headers) out.push(`headers.append(${js(h.key)}, ${js(h.value)});`);
  out.push('');
  let bodyVar = '';
  if (b.kind === 'text') {
    const pretty = (() => { try { return JSON.stringify(JSON.parse(b.text), null, 2); } catch { return null; } })();
    out.push(pretty !== null ? `const body = JSON.stringify(${pretty.split('\n').join('\n')});` : `const body = ${js(b.text)};`);
    bodyVar = 'body';
  } else if (b.kind === 'urlencoded') {
    out.push('const body = new URLSearchParams();');
    for (const f of b.fields) out.push(`body.append(${js(f.key)}, ${js(f.value)});`);
    bodyVar = 'body';
  } else if (b.kind === 'form') {
    out.push('const body = new FormData();');
    for (const f of b.fields) out.push(f.fileName !== undefined ? `body.append(${js(f.key)}, fileInput.files[0], ${js(f.fileName)});` : `body.append(${js(f.key)}, ${js(f.value ?? '')});`);
    bodyVar = 'body';
  } else if (b.kind === 'binary') { out.push(`const body = fileInput.files[0]; // ${b.fileName}`); bodyVar = 'body'; }
  if (bodyVar) out.push('');
  out.push('const requestOptions = {', `  method: ${js(p.method)},`, '  headers,', ...(bodyVar ? ['  body,'] : []), "  redirect: 'follow',", '};', '');
  out.push(`fetch(${js(p.url)}, requestOptions)`, '  .then((response) => response.text())', '  .then((result) => console.log(result))', '  .catch((error) => console.error(error));');
  return out.join('\n');
}

const py = (v: string): string => (/['\\\n]/.test(v) ? JSON.stringify(v) : `'${v}'`);
export function toPython(p: PreparedRequest): string {
  const b = p.body;
  const out = ['import requests', '', `url = ${py(p.url)}`, ''];
  const headers = p.headers.filter((h) => !(b.kind === 'form' && h.key.toLowerCase() === 'content-type'));
  let args = '';
  if (b.kind === 'text') { out.push(`payload = ${py(b.text)}`); args = ', data=payload'; }
  else if (b.kind === 'urlencoded') { out.push(`payload = ${py(formEncode(b.fields))}`); args = ', data=payload'; }
  else if (b.kind === 'form') {
    const texts = b.fields.filter((f) => f.fileName === undefined);
    const files = b.fields.filter((f) => f.fileName !== undefined);
    out.push(`payload = {${texts.map((f) => `${py(f.key)}: ${py(f.value ?? '')}`).join(', ')}}`);
    out.push(`files = [${files.map((f) => `(${py(f.key)}, (${py(f.fileName ?? 'file')}, open(${py(f.fileName ?? 'file')}, 'rb')))`).join(', ')}]`);
    args = ', data=payload, files=files';
  } else if (b.kind === 'binary') { out.push(`payload = open(${py(b.fileName)}, 'rb').read()`); args = ', data=payload'; }
  out.push(headers.length ? `headers = {\n${headers.map((h) => `  ${py(h.key)}: ${py(h.value)}`).join(',\n')}\n}` : 'headers = {}', '');
  out.push(`response = requests.request(${py(p.method)}, url, headers=headers${args})`, '', 'print(response.text)');
  return out.join('\n');
}
export const snippet = (lang: SnippetLang, p: PreparedRequest): string => (lang === 'curl' ? toCurl(p) : lang === 'fetch' ? toFetch(p) : toPython(p));

/* ---------------- Postman Collection v2.1 ---------------- */

export const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const lines = (code: string): string[] => (code ? code.split(/\r?\n/) : []);
const scriptOf = (events: unknown, listen: string): string => {
  for (const e of arr(events)) if (isObj(e) && e.listen === listen && isObj(e.script)) { const exec = e.script.exec; return Array.isArray(exec) ? exec.map(s).join('\n') : s(exec); }
  return '';
};
const pmKv = (list: unknown): KV[] => arr(list).filter(isObj).map((x) => newKV(s(x.key), s(x.value), x.disabled !== true, s(x.description) || (isObj(x.description) ? s(x.description.content) : undefined)));
const kvAttr = (list: unknown, key: string): string => { for (const x of arr(list)) if (isObj(x) && x.key === key) return s(x.value); return ''; };

function authFromPostman(a: unknown, inherit: boolean): Auth {
  if (!isObj(a)) return { type: inherit ? 'inherit' : 'none' };
  switch (a.type) {
    case 'noauth': return { type: 'none' };
    case 'bearer': return { type: 'bearer', token: isObj(a.bearer) ? s(a.bearer.token) : kvAttr(a.bearer, 'token') };
    case 'basic': return { type: 'basic', username: isObj(a.basic) ? s(a.basic.username) : kvAttr(a.basic, 'username'), password: isObj(a.basic) ? s(a.basic.password) : kvAttr(a.basic, 'password') };
    case 'apikey': return { type: 'apikey', key: isObj(a.apikey) ? s(a.apikey.key) : kvAttr(a.apikey, 'key'), value: isObj(a.apikey) ? s(a.apikey.value) : kvAttr(a.apikey, 'value'), in: (isObj(a.apikey) ? s(a.apikey.in) : kvAttr(a.apikey, 'in')) === 'query' ? 'query' : 'header' };
    case 'oauth2': { const t = isObj(a.oauth2) ? s(a.oauth2.accessToken) : kvAttr(a.oauth2, 'accessToken'); return { type: 'bearer', token: t }; }
    default: return { type: inherit ? 'inherit' : 'none' };
  }
}
function authToPostman(a: Auth): Record<string, unknown> | undefined {
  switch (a.type) {
    case 'none': return { type: 'noauth' };
    case 'bearer': return { type: 'bearer', bearer: [{ key: 'token', value: a.token ?? '', type: 'string' }] };
    case 'basic': return { type: 'basic', basic: [{ key: 'username', value: a.username ?? '', type: 'string' }, { key: 'password', value: a.password ?? '', type: 'string' }] };
    case 'apikey': return { type: 'apikey', apikey: [{ key: 'key', value: a.key ?? '', type: 'string' }, { key: 'value', value: a.value ?? '', type: 'string' }, { key: 'in', value: a.in ?? 'header', type: 'string' }] };
    default: return undefined;
  }
}
const urlFromPostman = (u: unknown): { raw: string; pathVars: KV[]; params: KV[] } => {
  if (typeof u === 'string') return { raw: u, pathVars: [], params: [] };
  if (!isObj(u)) return { raw: '', pathVars: [], params: [] };
  let raw = s(u.raw);
  if (!raw) {
    const host = Array.isArray(u.host) ? u.host.map(s).join('.') : s(u.host);
    const path = Array.isArray(u.path) ? u.path.map((p) => (isObj(p) ? s(p.value) : s(p))).join('/') : s(u.path);
    const q = arr(u.query).filter(isObj).filter((x) => x.disabled !== true).map((x) => (x.value === null || x.value === undefined ? s(x.key) : `${s(x.key)}=${s(x.value)}`)).join('&');
    raw = `${u.protocol ? `${s(u.protocol)}://` : ''}${host}${u.port ? `:${s(u.port)}` : ''}${path ? `/${path}` : ''}${q ? `?${q}` : ''}`;
  }
  const disabled = arr(u.query).filter(isObj).filter((x) => x.disabled === true).map((x) => newKV(s(x.key), s(x.value), false));
  const described = pmKv(u.query);
  const params = paramsFromUrl(raw, []).map((p) => { const d = described.find((x) => x.key === p.key && x.enabled); return d?.description ? { ...p, description: d.description } : p; });
  return { raw, pathVars: pmKv(u.variable), params: [...params, ...disabled] };
};
function bodyFromPostman(b: unknown): ApiRequest['body'] {
  const body = emptyBody();
  if (!isObj(b)) return body;
  const mode = s(b.mode);
  if (b.disabled === true) return body;
  if (mode === 'raw') {
    const lang = isObj(b.options) && isObj(b.options.raw) ? s(b.options.raw.language) : '';
    body.mode = 'raw'; body.raw = s(b.raw);
    body.language = (RAW_LANGUAGES as readonly string[]).includes(lang) ? (lang as RawLanguage) : /^\s*[[{]/.test(body.raw) ? 'json' : 'text';
  } else if (mode === 'urlencoded') { body.mode = 'urlencoded'; body.urlencoded = pmKv(b.urlencoded); }
  else if (mode === 'formdata') {
    body.mode = 'formdata';
    body.formdata = arr(b.formdata).filter(isObj).map((x) => (x.type === 'file'
      ? { ...newKV(s(x.key), '', x.disabled !== true), type: 'file' as const, fileName: (Array.isArray(x.src) ? s(x.src[0]) : s(x.src)).replace(/^.*[\\/]/, '') || 'file' }
      : { ...newKV(s(x.key), s(x.value), x.disabled !== true), type: 'text' as const }));
  } else if (mode === 'file') { body.mode = 'binary'; body.file = null; }
  else if (mode === 'graphql' && isObj(b.graphql)) { body.mode = 'raw'; body.language = 'json'; body.raw = JSON.stringify({ query: s(b.graphql.query), variables: (() => { try { return JSON.parse(s(b.graphql.variables) || '{}'); } catch { return {}; } })() }, null, 2); }
  return body;
}
function itemFromPostman(x: Record<string, unknown>, depth: number): ApiItem {
  if (Array.isArray(x.item) && depth < 30) {
    return newFolder(s(x.name) || 'Folder', { description: s(x.description) || (isObj(x.description) ? s(x.description.content) : ''), auth: authFromPostman(x.auth, true), preRequest: scriptOf(x.event, 'prerequest'), tests: scriptOf(x.event, 'test'), items: x.item.filter(isObj).map((c) => itemFromPostman(c, depth + 1)) });
  }
  const req = isObj(x.request) ? x.request : typeof x.request === 'string' ? { url: x.request, method: 'GET' } : {};
  const url = urlFromPostman(req.url);
  const pathVars = syncPathVars(url.raw, url.pathVars);
  return newRequest({
    name: s(x.name) || url.raw || 'Request', description: s(req.description) || (isObj(req.description) ? s(req.description.content) : ''),
    method: (s(req.method) || 'GET').toUpperCase(), url: url.raw, params: url.params, pathVars, headers: Array.isArray(req.header) ? pmKv(req.header) : [],
    auth: authFromPostman(req.auth, true), body: bodyFromPostman(req.body), preRequest: scriptOf(x.event, 'prerequest'), tests: scriptOf(x.event, 'test'),
  });
}
const varsFromPostman = (list: unknown): Variable[] => arr(list).filter(isObj).map((x) => ({ ...newVariable(s(x.key), s(x.value), x.type === 'secret'), enabled: x.disabled !== true }));

export const isPostmanCollection = (v: unknown): boolean => isObj(v) && isObj(v.info) && Array.isArray(v.item);
export const isPostmanEnvironment = (v: unknown): boolean => isObj(v) && Array.isArray(v.values) && !isObj(v.info);

export function importPostman(v: unknown): Collection {
  if (!isPostmanCollection(v)) throw new Error('not a Postman collection (it needs info and item)');
  const x = v as Record<string, unknown>;
  const info = x.info as Record<string, unknown>;
  const c = emptyCollection(s(info.name) || 'Imported collection');
  c.description = s(info.description) || (isObj(info.description) ? s(info.description.content) : '');
  c.auth = authFromPostman(x.auth, false);
  c.variables = varsFromPostman(x.variable);
  c.preRequest = scriptOf(x.event, 'prerequest');
  c.tests = scriptOf(x.event, 'test');
  c.items = (x.item as unknown[]).filter(isObj).map((i) => itemFromPostman(i, 0));
  return c;
}

const urlToPostman = (r: ApiRequest): Record<string, unknown> => {
  const { base } = splitUrl(r.url);
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(base);
  const hostPort = m ? m[2] : base.split('/')[0];
  const pathPart = m ? m[3] : base.slice(hostPort.length);
  const port = /:(\d+)$/.exec(hostPort)?.[1];
  const host = (port ? hostPort.slice(0, -(port.length + 1)) : hostPort);
  const out: Record<string, unknown> = { raw: r.url };
  if (m) out.protocol = m[1];
  out.host = /^\{\{.*\}\}$/.test(host) ? [host] : host.split('.').filter(Boolean);
  if (port) out.port = port;
  out.path = pathPart.split('/').filter(Boolean);
  if (r.params.length) out.query = r.params.map((p) => ({ key: p.key, value: p.value, ...(p.enabled ? {} : { disabled: true }), ...(p.description ? { description: p.description } : {}) }));
  if (r.pathVars.length) out.variable = r.pathVars.map((p) => ({ key: p.key, value: p.value, ...(p.description ? { description: p.description } : {}) }));
  return out;
};
const events = (pre: string, tests: string): Array<Record<string, unknown>> | undefined => {
  const out: Array<Record<string, unknown>> = [];
  if (pre.trim()) out.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: lines(pre) } });
  if (tests.trim()) out.push({ listen: 'test', script: { type: 'text/javascript', exec: lines(tests) } });
  return out.length ? out : undefined;
};
function itemToPostman(i: ApiItem): Record<string, unknown> {
  if (i.type === 'folder') {
    return { name: i.name, ...(i.description ? { description: i.description } : {}), item: i.items.map(itemToPostman), ...(authToPostman(i.auth) ? { auth: authToPostman(i.auth) } : {}), ...(events(i.preRequest, i.tests) ? { event: events(i.preRequest, i.tests) } : {}) };
  }
  const b = i.body;
  let body: Record<string, unknown> | undefined;
  if (b.mode === 'raw') body = { mode: 'raw', raw: b.raw, options: { raw: { language: b.language } } };
  else if (b.mode === 'urlencoded') body = { mode: 'urlencoded', urlencoded: b.urlencoded.map((f) => ({ key: f.key, value: f.value, ...(f.enabled ? {} : { disabled: true }), type: 'text' })) };
  else if (b.mode === 'formdata') body = { mode: 'formdata', formdata: b.formdata.map((f) => (f.type === 'file' ? { key: f.key, type: 'file', src: f.fileName ?? '', ...(f.enabled ? {} : { disabled: true }) } : { key: f.key, value: f.value, type: 'text', ...(f.enabled ? {} : { disabled: true }) })) };
  else if (b.mode === 'binary') body = { mode: 'file', file: { src: b.file?.name ?? '' } };
  const request: Record<string, unknown> = {
    method: i.method,
    header: i.headers.map((h) => ({ key: h.key, value: h.value, type: 'text', ...(h.enabled ? {} : { disabled: true }), ...(h.description ? { description: h.description } : {}) })),
    ...(body ? { body } : {}),
    url: urlToPostman(i),
    ...(i.description ? { description: i.description } : {}),
    ...(authToPostman(i.auth) ? { auth: authToPostman(i.auth) } : {}),
  };
  return { name: i.name, ...(events(i.preRequest, i.tests) ? { event: events(i.preRequest, i.tests) } : {}), request, response: [] };
}
/** A collection as Postman Collection v2.1 JSON (secret variable values are left out). */
export function exportPostman(c: Collection, id = ''): Record<string, unknown> {
  return {
    info: { ...(id ? { _postman_id: id } : {}), name: c.name, ...(c.description ? { description: c.description } : {}), schema: POSTMAN_SCHEMA },
    item: c.items.map(itemToPostman),
    ...(authToPostman(c.auth) && c.auth.type !== 'none' ? { auth: authToPostman(c.auth) } : {}),
    ...(events(c.preRequest, c.tests) ? { event: events(c.preRequest, c.tests) } : {}),
    variable: c.variables.map((v) => ({ key: v.key, value: v.secret ? '' : v.value, type: v.secret ? 'secret' : 'string', ...(v.enabled ? {} : { disabled: true }) })),
  };
}
export function importPostmanEnvironment(v: unknown): Environment {
  if (!isPostmanEnvironment(v)) throw new Error('not a Postman environment (it needs values)');
  const x = v as Record<string, unknown>;
  const e = emptyEnvironment(s(x.name) || 'Imported environment');
  e.values = arr(x.values).filter(isObj).map((y) => ({ ...newVariable(s(y.key), s(y.value), y.type === 'secret'), enabled: y.enabled !== false }));
  return e;
}
/** An environment as Postman environment JSON (secret values left out unless includeSecrets). */
export function exportEnvironment(e: Environment, scope: 'environment' | 'globals' = 'environment', includeSecrets = false): Record<string, unknown> {
  return { name: e.name, values: e.values.map((v) => ({ key: v.key, value: v.secret && !includeSecrets ? '' : v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled })), _postman_variable_scope: scope };
}

/* ---------------- OpenAPI 3 / Swagger 2 ---------------- */

export const isOpenApi = (v: unknown): boolean => isObj(v) && (typeof v.openapi === 'string' || typeof v.swagger === 'string') && isObj(v.paths);
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

/** Resolves a local "#/components/…" reference. */
function deref(root: Record<string, unknown>, v: unknown, seen: Set<string> = new Set()): unknown {
  if (!isObj(v) || typeof v.$ref !== 'string') return v;
  const ref = v.$ref;
  if (!ref.startsWith('#/') || seen.has(ref)) return {};
  seen.add(ref);
  let cur: unknown = root;
  for (const part of ref.slice(2).split('/')) cur = isObj(cur) ? cur[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  return deref(root, cur, seen);
}
/** An example value for a JSON schema (examples first, then defaults, enums, formats and types). */
export function exampleFor(root: Record<string, unknown>, schemaIn: unknown, depth = 0, seen: Set<string> = new Set()): unknown {
  if (depth > 8) return null;
  const ref = isObj(schemaIn) && typeof schemaIn.$ref === 'string' ? schemaIn.$ref : '';
  if (ref && seen.has(ref)) return {};
  const nextSeen = ref ? new Set([...seen, ref]) : seen;
  const schema = deref(root, schemaIn);
  if (!isObj(schema)) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    const list = arr(schema[key]);
    if (!list.length) continue;
    if (key === 'allOf') { const merged: Record<string, unknown> = {}; for (const part of list) { const ex = exampleFor(root, part, depth + 1, nextSeen); if (isObj(ex)) Object.assign(merged, ex); } return merged; }
    return exampleFor(root, list[0], depth + 1, nextSeen);
  }
  const type = Array.isArray(schema.type) ? s(schema.type.find((t) => t !== 'null')) : s(schema.type) || (isObj(schema.properties) ? 'object' : schema.items ? 'array' : '');
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      if (isObj(schema.properties)) for (const [k, p] of Object.entries(schema.properties)) out[k] = exampleFor(root, p, depth + 1, nextSeen);
      return out;
    }
    case 'array': return [exampleFor(root, schema.items, depth + 1, nextSeen)];
    case 'integer': case 'number': return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean': return true;
    case 'string': {
      const f = s(schema.format);
      return f === 'date-time' ? '2026-01-01T00:00:00Z' : f === 'date' ? '2026-01-01' : f === 'email' ? 'user@example.com' : f === 'uuid' ? '00000000-0000-4000-8000-000000000000' : f === 'uri' || f === 'url' ? 'https://example.com' : f === 'binary' ? '' : 'string';
    }
    default: return null;
  }
}
const paramExample = (root: Record<string, unknown>, p: Record<string, unknown>): string => {
  if (p.example !== undefined) return s(p.example);
  if (isObj(p.examples)) { const first = Object.values(p.examples)[0]; const ex = deref(root, first); if (isObj(ex) && ex.value !== undefined) return s(ex.value); }
  const schema = deref(root, p.schema);
  if (isObj(schema)) { if (schema.example !== undefined) return s(schema.example); if (schema.default !== undefined) return s(schema.default); if (Array.isArray(schema.enum) && schema.enum.length) return s(schema.enum[0]); }
  if (p.default !== undefined) return s(p.default);
  return '';
};

/** An OpenAPI 3 (or Swagger 2) document → a collection: one folder per tag, one request per operation, baseUrl and auth as collection variables. */
export function importOpenApi(doc: unknown): Collection {
  if (!isOpenApi(doc)) throw new Error('not an OpenAPI document (it needs openapi or swagger, and paths)');
  const root = doc as Record<string, unknown>;
  const info = isObj(root.info) ? root.info : {};
  const c = emptyCollection(s(info.title) || 'Imported API');
  c.description = [s(info.description), s(info.version) ? `Version ${s(info.version)}` : ''].filter(Boolean).join('\n\n');
  const swagger2 = typeof root.swagger === 'string';
  let baseUrl = '';
  if (swagger2) {
    const scheme = arr(root.schemes).map(s)[0] || 'https';
    baseUrl = root.host ? `${scheme}://${s(root.host)}${s(root.basePath)}` : s(root.basePath);
  } else {
    const server = arr(root.servers).find(isObj);
    if (server) {
      baseUrl = s(server.url);
      if (isObj(server.variables)) for (const [k, v] of Object.entries(server.variables)) if (isObj(v)) baseUrl = baseUrl.split(`{${k}}`).join(s(v.default));
    }
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  c.variables.push(newVariable('baseUrl', baseUrl || 'http://localhost'));

  // security schemes → collection auth and variables
  const schemes = swagger2 ? (isObj(root.securityDefinitions) ? root.securityDefinitions : {}) : isObj(root.components) && isObj(root.components.securitySchemes) ? root.components.securitySchemes : {};
  const authFor = (name: string): Auth | null => {
    const sc = deref(root, (schemes as Record<string, unknown>)[name]);
    if (!isObj(sc)) return null;
    const type = s(sc.type).toLowerCase();
    const scheme = s(sc.scheme).toLowerCase();
    const addVar = (k: string, secret = true) => { if (!c.variables.some((v) => v.key === k)) c.variables.push(newVariable(k, '', secret)); };
    if ((type === 'http' && scheme === 'bearer') || type === 'oauth2' || type === 'openidconnect') { addVar(type === 'http' ? 'bearerToken' : 'accessToken'); return { type: 'bearer', token: type === 'http' ? '{{bearerToken}}' : '{{accessToken}}' }; }
    if ((type === 'http' && scheme === 'basic') || type === 'basic') { addVar('username', false); addVar('password'); return { type: 'basic', username: '{{username}}', password: '{{password}}' }; }
    if (type === 'apikey') { addVar('apiKey'); return { type: 'apikey', key: s(sc.name) || 'X-API-Key', value: '{{apiKey}}', in: s(sc.in) === 'query' ? 'query' : 'header' }; }
    return null;
  };
  const firstAuth = (security: unknown): Auth | null | undefined => {
    if (!Array.isArray(security)) return undefined;
    if (security.length === 0 || security.every((x) => isObj(x) && Object.keys(x).length === 0)) return null;
    for (const req of security) if (isObj(req)) for (const name of Object.keys(req)) { const a = authFor(name); if (a) return a; }
    return undefined;
  };
  const globalAuth = firstAuth(root.security);
  if (globalAuth) c.auth = globalAuth;

  const folders = new Map<string, ApiFolder>();
  const tagDescriptions = new Map(arr(root.tags).filter(isObj).map((t) => [s(t.name), s(t.description)]));
  for (const [path, itemIn] of Object.entries(root.paths as Record<string, unknown>)) {
    const item = deref(root, itemIn);
    if (!isObj(item)) continue;
    const shared = arr(item.parameters);
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!isObj(op)) continue;
      const params = new Map<string, Record<string, unknown>>();
      for (const p of [...shared, ...arr(op.parameters)]) { const x = deref(root, p); if (isObj(x)) params.set(`${s(x.in)}:${s(x.name)}`, x); }
      const urlPath = path.replace(/\{([^}]+)\}/g, ':$1');
      const r = newRequest({ name: s(op.summary) || s(op.operationId) || `${m.toUpperCase()} ${path}`, description: s(op.description), method: m.toUpperCase() });
      const query: KV[] = [];
      const headers: KV[] = [];
      const pathVars: KV[] = [];
      let formBody: Record<string, unknown> | null = null;
      for (const p of params.values()) {
        const where = s(p.in);
        const kv = newKV(s(p.name), paramExample(root, p), true, s(p.description) || undefined);
        if (where === 'query') query.push({ ...kv, enabled: p.required === true });
        else if (where === 'header') headers.push({ ...kv, enabled: p.required === true || !/^(accept|content-type|authorization)$/i.test(kv.key) });
        else if (where === 'path') pathVars.push(kv);
        else if (where === 'body' && swagger2) formBody = { 'application/json': { schema: p.schema } };
        else if (where === 'formData' && swagger2) { formBody = formBody ?? { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: {} } } }; }
      }
      const base = `{{baseUrl}}${urlPath}`;
      r.url = base;
      r.params = query;
      r.url = query.some((q) => q.enabled) ? `${base}?${query.filter((q) => q.enabled).map((q) => `${q.key}=${q.value}`).join('&')}` : base;
      r.pathVars = syncPathVars(r.url, pathVars);
      r.headers = headers;
      const content = !swagger2 ? (() => { const rb = deref(root, op.requestBody); return isObj(rb) && isObj(rb.content) ? rb.content : null; })() : formBody;
      if (swagger2) {
        const formParams = [...params.values()].filter((p) => s(p.in) === 'formData');
        if (formParams.length) {
          const files = formParams.some((p) => s(p.type) === 'file');
          if (files) r.body = { ...emptyBody(), mode: 'formdata', formdata: formParams.map((p) => (s(p.type) === 'file' ? { ...newKV(s(p.name), ''), type: 'file' as const, fileName: '' } : { ...newKV(s(p.name), paramExample(root, p)), type: 'text' as const })) };
          else r.body = { ...emptyBody(), mode: 'urlencoded', urlencoded: formParams.map((p) => newKV(s(p.name), paramExample(root, p))) };
        }
      }
      if (isObj(content) && r.body.mode === 'none') {
        const types = Object.keys(content);
        const json = types.find((t) => /json/i.test(t));
        const pick = json ?? types.find((t) => /x-www-form-urlencoded|multipart\/form-data|xml|text/i.test(t)) ?? types[0];
        const media = isObj(content[pick]) ? (content[pick] as Record<string, unknown>) : {};
        const example = media.example !== undefined ? media.example : isObj(media.examples) ? (() => { const ex = deref(root, Object.values(media.examples)[0]); return isObj(ex) ? ex.value : undefined; })() : exampleFor(root, media.schema);
        if (/x-www-form-urlencoded/i.test(pick) || /multipart\/form-data/i.test(pick)) {
          const schema = deref(root, media.schema);
          const props = isObj(schema) && isObj(schema.properties) ? schema.properties : {};
          const ex = isObj(example) ? example : {};
          if (/multipart/i.test(pick)) r.body = { ...emptyBody(), mode: 'formdata', formdata: Object.entries(props).map(([k, p]) => { const ps = deref(root, p); return isObj(ps) && s(ps.format) === 'binary' ? { ...newKV(k, ''), type: 'file' as const, fileName: '' } : { ...newKV(k, s(ex[k])), type: 'text' as const }; }) };
          else r.body = { ...emptyBody(), mode: 'urlencoded', urlencoded: Object.keys(props).map((k) => newKV(k, s(ex[k]))) };
        } else if (pick) {
          const language: RawLanguage = /json/i.test(pick) ? 'json' : /xml/i.test(pick) ? 'xml' : 'text';
          r.body = { ...emptyBody(), mode: 'raw', language, raw: language === 'json' ? JSON.stringify(example ?? {}, null, 2) : typeof example === 'string' ? example : '' };
          if (!/^(application\/json|application\/xml|text\/plain)$/i.test(pick)) r.headers.push(newKV('Content-Type', pick));
        }
      }
      const opAuth = firstAuth(op.security);
      if (opAuth === null) r.auth = { type: 'none' };
      else if (opAuth && JSON.stringify(opAuth) !== JSON.stringify(c.auth)) r.auth = opAuth;
      // expected status → a starter test
      const codes = isObj(op.responses) ? Object.keys(op.responses).filter((k) => /^2\d\d$/.test(k)) : [];
      if (codes.length) r.tests = `pm.test("Status code is ${codes[0]}", () => {\n  pm.response.to.have.status(${codes[0]});\n});`;
      const tag = arr(op.tags).map(s)[0] ?? '';
      if (!tag) { c.items.push(r); continue; }
      let folder = folders.get(tag);
      if (!folder) { folder = newFolder(tag, { description: tagDescriptions.get(tag) ?? '' }); folders.set(tag, folder); c.items.push(folder); }
      folder.items.push(r);
    }
  }
  return c;
}

/* ---------------- detection ---------------- */

export type ImportResult = { kind: 'collection'; collection: Collection; format: string } | { kind: 'environment'; environment: Environment; format: string } | { kind: 'request'; request: ApiRequest; format: string };

/** Recognises pasted text or a file: a cURL command, a Postman collection or environment, an OpenAPI/Swagger document
 * (JSON; YAML is converted by the caller first), or a collection in Pigry's own format. */
export function importAny(text: string, parsedYaml?: unknown): ImportResult {
  const t = text.trim();
  if (!t) throw new Error('nothing to import');
  if (/^curl(\.exe)?\s/i.test(t)) return { kind: 'request', request: parseCurl(t), format: 'cURL' };
  let v: unknown = parsedYaml;
  if (v === undefined) { try { v = JSON.parse(t); } catch { throw new Error('not a cURL command or JSON (paste a Postman collection, an OpenAPI document or a cURL command)'); } }
  if (isPostmanCollection(v)) return { kind: 'collection', collection: importPostman(v), format: 'Postman Collection v2.1' };
  if (isOpenApi(v)) return { kind: 'collection', collection: importOpenApi(v), format: typeof (v as Record<string, unknown>).swagger === 'string' ? 'Swagger 2' : 'OpenAPI 3' };
  if (isPostmanEnvironment(v)) return { kind: 'environment', environment: importPostmanEnvironment(v), format: 'Postman environment' };
  if (isObj(v) && v.version === 1 && Array.isArray(v.items)) {
    return { kind: 'collection', collection: normalizeCollection(v, 'Imported collection').value, format: 'Pigry collection' };
  }
  throw new Error('the JSON is not a Postman collection, a Postman environment or an OpenAPI document');
}

/** Number of requests per collection, for import messages. */
export const requestCount = (c: Collection): number => [...walk(c.items)].filter((f) => f.item.type === 'request').length;
