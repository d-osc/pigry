/** Building blocks of the RESTful API screen: the {{variable}}-highlighting input, key/value tables, the auth, body
 * and script editors, and the response panel. */
import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Eye, EyeOff, Search, Trash2, Upload, X } from 'lucide-react';
import {
  AUTH_TYPES, RAW_LANGUAGES, bodyKind, contentTypeOf, formatSize, formatTime, jsonTokens, lookupVar, newKV, prettyJson, prettyXml, responseCookies, responseText, statusTone, varTokens,
  type ApiResponse, type Auth, type Body, type BodyMode, type CookieJar, type FormField, type KV, type PreparedRequest, type RawLanguage, type Variable, type VarScopes,
} from './api';
import { SNIPPETS, type TestResult } from './apiScript';
import type { RunResult } from './apiRun';

export const METHOD_COLORS: Record<string, string> = { GET: '#3fb950', POST: '#d29922', PUT: '#58a6ff', PATCH: '#a371f7', DELETE: '#f85149', HEAD: '#3fb950', OPTIONS: '#db61a2' };
export const methodColor = (m: string): string => METHOD_COLORS[m.toUpperCase()] ?? 'var(--text-muted)';
export const MethodBadge = ({ method, short }: { method: string; short?: boolean }) => {
  const m = method.toUpperCase();
  const text = short ? ({ DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' } as Record<string, string>)[m] ?? m : m;
  return <span className="api-method" style={{ color: methodColor(m) }}>{text}</span>;
};

export const copyText = (text: string): Promise<void> => (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))).catch(() => undefined);

/* ---------------- text with {{variables}} ---------------- */

export function varTitle(text: string, scopes: VarScopes): string {
  return varTokens(text, scopes).filter((t) => t.name).map((t) => {
    if (!t.defined) return `{{${t.name}}} is not defined`;
    if (t.scope === 'dynamic') return `{{${t.name}}} = a new value every send`;
    const hit = lookupVar(scopes, t.name!);
    return `{{${t.name}}} = ${hit?.value ?? ''} (${t.scope})`;
  }).join('\n');
}

interface VarTextProps { value: string; onChange: (v: string) => void; scopes: VarScopes; label: string; placeholder?: string; className?: string; onEnter?: () => void; type?: 'text' | 'password'; readOnly?: boolean }
/** An input that colours {{variables}}: green when defined, red when no scope defines them. */
export function VarText({ value, onChange, scopes, label, placeholder, className, onEnter, type = 'text', readOnly }: VarTextProps) {
  const mirror = useRef<HTMLDivElement | null>(null);
  const tokens = useMemo(() => varTokens(value, scopes), [value, scopes]);
  const title = useMemo(() => varTitle(value, scopes), [value, scopes]);
  const masked = type === 'password';
  return (
    <div className={`api-var${className ? ` ${className}` : ''}${masked ? ' api-var--masked' : ''}`}>
      {!masked && (
        <div className="api-var__mirror" ref={mirror} aria-hidden>
          {tokens.map((t, i) => (t.name ? <span key={i} className={t.defined ? 'api-var__ok' : 'api-var__bad'}>{t.text}</span> : <span key={i}>{t.text}</span>))}
        </div>
      )}
      <input type={type} aria-label={label} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off" readOnly={readOnly} title={title || undefined}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => { if (mirror.current) mirror.current.scrollLeft = e.currentTarget.scrollLeft; }}
        onKeyDown={(e) => { if (e.key === 'Enter' && onEnter && !e.ctrlKey && !e.metaKey) { e.preventDefault(); onEnter(); } }} />
    </div>
  );
}

/* ---------------- key / value tables ---------------- */

interface KVTableProps<T extends KV> {
  rows: T[];
  onChange: (rows: T[]) => void;
  scopes: VarScopes;
  /** Singular noun for labels: "Param" → "Param key 1", "New param key". */
  noun: string;
  fixedKeys?: boolean;
  describe?: boolean;
  make?: (key: string, value: string) => T;
  /** Extra cells after the value (form-data type, file picker). */
  extra?: (row: T, update: (patch: Partial<T>) => void, index: number) => ReactNode;
  valueCell?: (row: T, update: (patch: Partial<T>) => void, index: number) => ReactNode | null;
  bulk?: boolean;
}
export function KVTable<T extends KV>({ rows, onChange, scopes, noun, fixedKeys, describe = true, make, extra, valueCell, bulk = true }: KVTableProps<T>) {
  const [bulkText, setBulkText] = useState<string | null>(null);
  const create = make ?? ((k: string, v: string) => newKV(k, v) as T);
  const update = (i: number, patch: Partial<T>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const lower = noun.toLowerCase();
  const allOn = rows.length > 0 && rows.every((r) => r.enabled);
  if (bulkText !== null) {
    return (
      <div className="api-kv api-kv--bulk">
        <div className="api-kv__tools"><span className="api-muted">One per line as key:value — lines starting with // are turned off</span><span className="dc-grow" /><button type="button" className="dc-link" onClick={() => {
          const next = bulkText.split('\n').filter((l) => l.trim()).map((line) => {
            const off = line.trim().startsWith('//');
            const t = off ? line.trim().slice(2) : line;
            const c = t.indexOf(':');
            const row = create(c < 0 ? t.trim() : t.slice(0, c).trim(), c < 0 ? '' : t.slice(c + 1).trim());
            return { ...row, enabled: !off };
          });
          onChange(next); setBulkText(null);
        }}>Key-Value Edit</button></div>
        <textarea className="api-code" aria-label={`${noun} bulk edit`} value={bulkText} spellCheck={false} onChange={(e) => setBulkText(e.target.value)} />
      </div>
    );
  }
  return (
    <div className="api-kv">
      <table className="api-table">
        <thead>
          <tr>
            <th className="api-table__check">{!fixedKeys && rows.length > 0 && <input type="checkbox" aria-label={`Turn all ${lower}s on or off`} checked={allOn} onChange={() => onChange(rows.map((r) => ({ ...r, enabled: !allOn })))} />}</th>
            <th>Key</th><th>Value</th>{extra && <th className="api-table__narrow" />}{describe && <th>Description</th>}
            <th className="api-table__act">{bulk && !fixedKeys && <button type="button" className="dc-link" onClick={() => setBulkText(rows.map((r) => `${r.enabled ? '' : '//'}${r.key}:${r.value}`).join('\n'))}>Bulk Edit</button>}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id} className={row.enabled ? '' : 'api-table__off'}>
              <td className="api-table__check">{!fixedKeys && <input type="checkbox" aria-label={`${noun} ${i + 1} enabled`} checked={row.enabled} onChange={(e) => update(i, { enabled: e.target.checked } as Partial<T>)} />}</td>
              <td>{fixedKeys ? <span className="api-table__key">{row.key}</span> : <input className="api-cell" aria-label={`${noun} key ${i + 1}`} value={row.key} spellCheck={false} placeholder="Key" onChange={(e) => update(i, { key: e.target.value } as Partial<T>)} />}</td>
              <td>{valueCell?.(row, (p) => update(i, p), i) ?? <VarText className="api-cell" label={`${noun} value ${i + 1}`} value={row.value} scopes={scopes} placeholder="Value" onChange={(v) => update(i, { value: v } as Partial<T>)} />}</td>
              {extra && <td className="api-table__narrow">{extra(row, (p) => update(i, p), i)}</td>}
              {describe && <td><input className="api-cell" aria-label={`${noun} description ${i + 1}`} value={row.description ?? ''} placeholder="Description" onChange={(e) => update(i, { description: e.target.value } as Partial<T>)} /></td>}
              <td className="api-table__act">{!fixedKeys && <button type="button" className="dc-icon" aria-label={`Delete ${lower} ${i + 1}`} title="Delete" onClick={() => remove(i)}><Trash2 size={12} /></button>}</td>
            </tr>
          ))}
          {!fixedKeys && (
            <tr className="api-table__ghost">
              <td className="api-table__check" />
              <td><input className="api-cell" aria-label={`New ${lower} key`} value="" placeholder="Key" spellCheck={false} onChange={(e) => onChange([...rows, create(e.target.value, '')])} /></td>
              <td><input className="api-cell" aria-label={`New ${lower} value`} value="" placeholder="Value" spellCheck={false} onChange={(e) => onChange([...rows, create('', e.target.value)])} /></td>
              {extra && <td />}{describe && <td />}<td />
            </tr>
          )}
        </tbody>
      </table>
      {fixedKeys && rows.length === 0 && <p className="api-muted">No path variables — add :name segments to the URL path.</p>}
    </div>
  );
}

/* ---------------- variables table (environments, globals, collection variables) ---------------- */

export function VariablesTable({ rows, onChange, scopes, noun = 'Variable' }: { rows: Variable[]; onChange: (rows: Variable[]) => void; scopes: VarScopes; noun?: string }) {
  const [shown, setShown] = useState<Set<string>>(new Set());
  return (
    <KVTable<Variable>
      rows={rows} onChange={onChange} scopes={scopes} noun={noun} describe={false} bulk={false}
      make={(key, value) => ({ ...newKV(key, value), secret: undefined })}
      valueCell={(row, update, i) => (
        <div className="api-secret">
          <VarText className="api-cell" label={`${noun} value ${i + 1}`} value={row.value} scopes={scopes} placeholder="Value" type={row.secret && !shown.has(row.id) ? 'password' : 'text'} onChange={(v) => update({ value: v })} />
          {row.secret && <button type="button" className="dc-icon" aria-label={shown.has(row.id) ? `Hide value ${i + 1}` : `Show value ${i + 1}`} onClick={() => setShown((s) => { const n = new Set(s); if (n.has(row.id)) n.delete(row.id); else n.add(row.id); return n; })}>{shown.has(row.id) ? <EyeOff size={12} /> : <Eye size={12} />}</button>}
        </div>
      )}
      extra={(row, update, i) => (
        <label className="api-inline" title="Secret values are kept in .pigry/cache (git-ignored), not in the committed file">
          <input type="checkbox" aria-label={`${noun} ${i + 1} secret`} checked={!!row.secret} onChange={(e) => update({ secret: e.target.checked || undefined })} /> Secret
        </label>
      )}
    />
  );
}

/* ---------------- authorization ---------------- */

const AUTH_LABELS: Record<string, string> = { inherit: 'Inherit auth from parent', none: 'No Auth', bearer: 'Bearer Token', basic: 'Basic Auth', apikey: 'API Key' };
export const authLabel = (t: string): string => AUTH_LABELS[t] ?? t;
export function AuthEditor({ auth, onChange, scopes, allowInherit, inherited }: { auth: Auth; onChange: (a: Auth) => void; scopes: VarScopes; allowInherit: boolean; inherited?: { auth: Auth; from: string } }) {
  const set = (patch: Partial<Auth>) => onChange({ ...auth, ...patch });
  return (
    <div className="api-auth">
      <div className="api-auth__side">
        <label className="api-field"><span>Auth Type</span>
          <select className="dc-select" aria-label="Auth type" value={auth.type} onChange={(e) => {
            const type = e.target.value as Auth['type'];
            onChange(type === 'bearer' ? { type, token: auth.token ?? '' } : type === 'basic' ? { type, username: auth.username ?? '', password: auth.password ?? '' } : type === 'apikey' ? { type, key: auth.key ?? '', value: auth.value ?? '', in: auth.in ?? 'header' } : { type });
          }}>
            {AUTH_TYPES.filter((t) => allowInherit || t !== 'inherit').map((t) => <option key={t} value={t}>{authLabel(t)}</option>)}
          </select>
        </label>
        <p className="api-muted">
          {auth.type === 'inherit' ? 'The authorization header is set by the parent folder or the collection.' : auth.type === 'none' ? 'This request does not use any authorization.' : 'The authorization header is generated when you send the request. Use {{variables}} (marked secret in the environment) to keep tokens out of git.'}
        </p>
      </div>
      <div className="api-auth__main">
        {auth.type === 'inherit' && inherited && <p className="api-note">This request is using <strong>{authLabel(inherited.auth.type)}</strong> from the {inherited.from}.</p>}
        {auth.type === 'bearer' && <label className="api-field"><span>Token</span><VarText label="Bearer token" value={auth.token ?? ''} scopes={scopes} placeholder="Token" onChange={(v) => set({ token: v })} /></label>}
        {auth.type === 'basic' && (
          <>
            <label className="api-field"><span>Username</span><VarText label="Username" value={auth.username ?? ''} scopes={scopes} placeholder="Username" onChange={(v) => set({ username: v })} /></label>
            <label className="api-field"><span>Password</span><VarText label="Password" value={auth.password ?? ''} scopes={scopes} placeholder="Password" type={(auth.password ?? '').includes('{{') ? 'text' : 'password'} onChange={(v) => set({ password: v })} /></label>
          </>
        )}
        {auth.type === 'apikey' && (
          <>
            <label className="api-field"><span>Key</span><VarText label="API key name" value={auth.key ?? ''} scopes={scopes} placeholder="X-API-Key" onChange={(v) => set({ key: v })} /></label>
            <label className="api-field"><span>Value</span><VarText label="API key value" value={auth.value ?? ''} scopes={scopes} placeholder="Value" onChange={(v) => set({ value: v })} /></label>
            <label className="api-field"><span>Add to</span>
              <select className="dc-select" aria-label="Add API key to" value={auth.in ?? 'header'} onChange={(e) => set({ in: e.target.value === 'query' ? 'query' : 'header' })}><option value="header">Header</option><option value="query">Query Params</option></select>
            </label>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- code areas ---------------- */

export function CodeArea({ value, onChange, label, placeholder, rows = 10, readOnly }: { value: string; onChange?: (v: string) => void; label: string; placeholder?: string; rows?: number; readOnly?: boolean }) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || readOnly || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    const t = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = t;
    if (e.shiftKey) {
      const lineStart = t.value.lastIndexOf('\n', a - 1) + 1;
      if (t.value.slice(lineStart, lineStart + 2) === '  ') { t.setRangeText('', lineStart, lineStart + 2, 'end'); onChange?.(t.value); }
      return;
    }
    t.setRangeText('  ', a, b, 'end');
    onChange?.(t.value);
  };
  return <textarea className="api-code" aria-label={label} value={value} placeholder={placeholder} rows={rows} spellCheck={false} readOnly={readOnly} onChange={(e) => onChange?.(e.target.value)} onKeyDown={onKeyDown} />;
}

export function ScriptPane({ value, onChange, event, label }: { value: string; onChange: (v: string) => void; event: 'prerequest' | 'test'; label: string }) {
  const list = SNIPPETS.filter((s) => s.event === event || s.event === 'both');
  return (
    <div className="api-script">
      <div className="api-script__code">
        <CodeArea label={label} value={value} onChange={onChange} rows={14}
          placeholder={event === 'prerequest' ? '// Runs before the request is sent, e.g.\npm.environment.set("now", Date.now());' : '// Runs after the response arrives, e.g.\npm.test("Status code is 200", () => {\n  pm.response.to.have.status(200);\n});'} />
      </div>
      <aside className="api-script__snippets" aria-label="Snippets">
        <p className="api-muted">{event === 'prerequest' ? 'Pre-request scripts run before the request is sent. ' : 'Test scripts run after the response arrives. '}Scripts run in a sandbox with the pm API (no network or files).</p>
        <h4>Snippets</h4>
        {list.map((s) => <button key={s.label} type="button" className="dc-link api-snippet" onClick={() => onChange(value.trim() ? `${value.replace(/\s+$/, '')}\n\n${s.code}\n` : `${s.code}\n`)}>{s.label}</button>)}
      </aside>
    </div>
  );
}

/* ---------------- body ---------------- */

const BODY_LABELS: Record<BodyMode, string> = { none: 'none', formdata: 'form-data', urlencoded: 'x-www-form-urlencoded', raw: 'raw', binary: 'binary' };
const LANG_LABELS: Record<RawLanguage, string> = { json: 'JSON', text: 'Text', xml: 'XML', html: 'HTML', javascript: 'JavaScript' };
export function BodyEditor({ body, onChange, scopes, onPickFile }: { body: Body; onChange: (b: Body) => void; scopes: VarScopes; onPickFile: (target: 'binary' | string) => void }) {
  const set = (patch: Partial<Body>) => onChange({ ...body, ...patch });
  const jsonError = useMemo(() => {
    if (body.mode !== 'raw' || body.language !== 'json' || !body.raw.trim()) return '';
    const stripped = body.raw.replace(/"(?:\\.|[^"\\])*"|\{\{[^}]*\}\}/g, (m) => (m.startsWith('"') ? m : '0'));
    try { JSON.parse(stripped); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
  }, [body.mode, body.language, body.raw]);
  return (
    <div className="api-body">
      <div className="api-body__modes" role="radiogroup" aria-label="Body type">
        {(Object.keys(BODY_LABELS) as BodyMode[]).map((m) => (
          <label key={m} className="api-inline"><input type="radio" name="api-body-mode" checked={body.mode === m} onChange={() => set({ mode: m })} /> {BODY_LABELS[m]}</label>
        ))}
        {body.mode === 'raw' && (
          <>
            <select className="dc-select" aria-label="Raw body type" value={body.language} onChange={(e) => set({ language: e.target.value as RawLanguage })}>
              {RAW_LANGUAGES.map((l) => <option key={l} value={l}>{LANG_LABELS[l]}</option>)}
            </select>
            {body.language === 'json' && <button type="button" className="dc-link" onClick={() => { const p = prettyJson(body.raw); if (p !== null) set({ raw: p }); }}>Beautify</button>}
          </>
        )}
      </div>
      {body.mode === 'none' && <p className="api-muted api-center">This request does not have a body</p>}
      {body.mode === 'raw' && (
        <>
          <CodeArea label="Raw body" value={body.raw} onChange={(v) => set({ raw: v })} rows={12} placeholder={body.language === 'json' ? '{\n  "name": "{{name}}"\n}' : ''} />
          {jsonError && <p className="api-warn" role="note">JSON: {jsonError}</p>}
        </>
      )}
      {body.mode === 'urlencoded' && <KVTable rows={body.urlencoded} onChange={(rows) => set({ urlencoded: rows })} scopes={scopes} noun="Field" />}
      {body.mode === 'formdata' && (
        <KVTable<FormField>
          rows={body.formdata} onChange={(rows) => set({ formdata: rows })} scopes={scopes} noun="Form field" bulk={false}
          make={(k, v) => ({ ...newKV(k, v), type: 'text' })}
          valueCell={(row, _update, i) => (row.type === 'file'
            ? <button type="button" className="dc-btn api-file" aria-label={`Choose file ${i + 1}`} onClick={() => onPickFile(row.id)}><Upload size={12} /> {row.fileName || 'Select file'}</button>
            : null)}
          extra={(row, update, i) => (
            <select className="dc-select" aria-label={`Form field ${i + 1} type`} value={row.type} onChange={(e) => update({ type: e.target.value === 'file' ? 'file' : 'text' })}><option value="text">Text</option><option value="file">File</option></select>
          )}
        />
      )}
      {body.mode === 'binary' && (
        <div className="api-binary">
          <button type="button" className="dc-btn" onClick={() => onPickFile('binary')}><Upload size={12} /> {body.file ? 'Change file' : 'Select file'}</button>
          {body.file && <span>{body.file.name} <button type="button" className="dc-icon" aria-label="Remove file" onClick={() => set({ file: null })}><X size={12} /></button></span>}
        </div>
      )}
    </div>
  );
}

/* ---------------- response ---------------- */

export type ResponseTab = 'body' | 'cookies' | 'headers' | 'tests' | 'console';
type BodyView = 'pretty' | 'raw' | 'preview';

function highlight(text: string, query: string, active: number, startIndex: { n: number }): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase(), q = query.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  for (;;) {
    const i = lower.indexOf(q, at);
    if (i < 0) break;
    if (i > at) out.push(text.slice(at, i));
    const n = startIndex.n++;
    out.push(<mark key={`${i}-${n}`} className={n === active ? 'api-mark api-mark--on' : 'api-mark'} data-match={n}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function PrettyBody({ text, kind, query, active }: { text: string; kind: string; query: string; active: number }) {
  const lines = useMemo(() => {
    if (kind === 'json') {
      const pretty = prettyJson(text) ?? text;
      return pretty.split('\n').map((line) => jsonTokens(line));
    }
    const shown = kind === 'xml' || kind === 'html' ? prettyXml(text) : text;
    return shown.split('\n').map((line) => [{ kind: 'plain' as const, text: line }]);
  }, [text, kind]);
  const counter = { n: 0 };
  return (
    <pre className="api-pre api-pre--lines" aria-label="Response body">
      {lines.map((tokens, i) => (
        <div key={i} className="api-line"><span className="api-line__no">{i + 1}</span><span className="api-line__text">{tokens.map((t, j) => <span key={j} className={`api-json--${t.kind}`}>{highlight(t.text, query, active, counter)}</span>)}</span></div>
      ))}
    </pre>
  );
}

export function TestList({ tests }: { tests: TestResult[] }) {
  const [filter, setFilter] = useState<'all' | 'passed' | 'failed' | 'skipped'>('all');
  const shown = tests.filter((t) => filter === 'all' || (filter === 'passed' ? t.passed && !t.skipped : filter === 'failed' ? !t.passed : !!t.skipped));
  if (!tests.length) return <p className="api-muted api-center">There are no tests for this request. Write a test script in the Tests tab.</p>;
  return (
    <div className="api-tests">
      <div className="api-segmented" role="group" aria-label="Filter test results">
        {(['all', 'passed', 'skipped', 'failed'] as const).map((f) => <button key={f} type="button" className={filter === f ? 'api-segmented--on' : ''} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}
      </div>
      <ul className="api-tests__list">
        {shown.map((t, i) => (
          <li key={i} className={t.skipped ? 'api-test api-test--skip' : t.passed ? 'api-test api-test--pass' : 'api-test api-test--fail'}>
            <span className="api-test__badge">{t.skipped ? 'SKIPPED' : t.passed ? 'PASS' : 'FAIL'}</span>
            <span className="api-test__name">{t.name}</span>
            {t.error && <span className="api-test__error">| {t.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ResponsePanelProps {
  result: RunResult | null;
  sending: boolean;
  onCancel: () => void;
  tab: ResponseTab;
  onTab: (t: ResponseTab) => void;
  jar: CookieJar;
  onClearCookies: () => void;
}
export function ResponsePanel({ result, sending, onCancel, tab, onTab, jar, onClearCookies }: ResponsePanelProps) {
  const [view, setView] = useState<BodyView>('pretty');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLDivElement | null>(null);
  const res: ApiResponse | null = result?.response ?? null;
  const text = useMemo(() => (res ? responseText(res) : ''), [res]);
  const kind = res ? bodyKind(res) : 'text';
  const matches = useMemo(() => {
    if (!query || !text) return 0;
    const shown = kind === 'json' ? prettyJson(text) ?? text : kind === 'xml' || kind === 'html' ? prettyXml(text) : text;
    const source = view === 'raw' ? text : shown;
    let n = 0, at = 0;
    const l = source.toLowerCase(), q = query.toLowerCase();
    for (;;) { const i = l.indexOf(q, at); if (i < 0) break; n++; at = i + q.length; }
    return n;
  }, [query, text, kind, view]);
  const go = (delta: number) => {
    if (!matches) return;
    const next = (active + delta + matches) % matches;
    setActive(next);
    window.setTimeout(() => preRef.current?.querySelector(`[data-match="${next}"]`)?.scrollIntoView({ block: 'center' }), 0);
  };
  const cookies = res ? responseCookies(res) : [];
  const jarCount = Object.values(jar).reduce((n, l) => n + l.length, 0);
  const tests = result?.tests ?? [];
  const passed = tests.filter((t) => t.passed && !t.skipped).length;
  const failed = tests.some((t) => !t.passed);

  if (sending) {
    return (
      <section className="api-response api-response--empty" aria-label="Response">
        <div className="api-spinner" aria-hidden /><p>Sending request…</p>
        <button type="button" className="dc-btn" onClick={onCancel}>Cancel</button>
      </section>
    );
  }
  if (!result) {
    return <section className="api-response api-response--empty" aria-label="Response"><p className="api-muted">Enter the URL and click Send to get a response</p></section>;
  }
  const timings = res?.timings;
  return (
    <section className="api-response" aria-label="Response">
      <div className="api-response__bar">
        <div className="api-tabs" role="tablist" aria-label="Response sections">
          {([['body', 'Body'], ['cookies', `Cookies${cookies.length ? ` (${cookies.length})` : ''}`], ['headers', `Headers${res ? ` (${res.headers.length})` : ''}`], ['tests', tests.length ? `Test Results (${passed}/${tests.length})` : 'Test Results'], ['console', 'Console']] as Array<[ResponseTab, string]>).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`api-tab${tab === id ? ' api-tab--on' : ''}${id === 'tests' && failed ? ' api-tab--fail' : ''}`} onClick={() => onTab(id)}>{label}</button>
          ))}
        </div>
        <span className="dc-grow" />
        {res && (
          <div className="api-response__meta" role="status" aria-label="Response status">
            <span className={`api-status api-status--${statusTone(res.status)}`}>{res.status} {res.statusText}</span>
            <span title={timings ? `DNS ${formatTime(timings.dnsMs)} · TCP ${formatTime(Math.max(0, timings.connectMs - timings.dnsMs))} · TLS ${formatTime(timings.tlsMs ? Math.max(0, timings.tlsMs - timings.connectMs) : 0)} · first byte ${formatTime(timings.firstByteMs)} · total ${formatTime(timings.totalMs)}` : undefined}>{formatTime(res.timeMs)}</span>
            <span title={`Body ${formatSize(res.bodySize)} · headers ${formatSize(res.headersSize)}${res.truncated ? ' · cut at 50 MB' : ''}`}>{formatSize(res.bodySize + res.headersSize)}</span>
          </div>
        )}
      </div>
      {result.error && <div className="api-error" role="alert">{result.error}</div>}
      <div className="api-response__body">
        {tab === 'body' && res && (
          <>
            <div className="api-response__tools">
              <div className="api-segmented" role="group" aria-label="Body view">
                {(['pretty', 'raw', 'preview'] as BodyView[]).map((v) => <button key={v} type="button" className={view === v ? 'api-segmented--on' : ''} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
              </div>
              <span className="api-chip">{kind === 'json' ? 'JSON' : kind === 'xml' ? 'XML' : kind === 'html' ? 'HTML' : kind === 'image' ? 'Image' : kind === 'binary' ? 'Binary' : 'Text'}</span>
              <span className="dc-grow" />
              {searchOpen ? (
                <div className="api-search">
                  <Search size={12} />
                  <input aria-label="Search response" autoFocus value={query} placeholder="Find in response" onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { setSearchOpen(false); setQuery(''); } }} />
                  <span className="api-muted" aria-label="Matches">{matches ? `${active + 1} / ${matches}` : query ? 'No results' : ''}</span>
                  <button type="button" className="dc-icon" aria-label="Previous match" onClick={() => go(-1)}><ChevronUp size={12} /></button>
                  <button type="button" className="dc-icon" aria-label="Next match" onClick={() => go(1)}><ChevronDown size={12} /></button>
                  <button type="button" className="dc-icon" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery(''); }}><X size={12} /></button>
                </div>
              ) : <button type="button" className="dc-icon" aria-label="Search the response" title="Search" onClick={() => setSearchOpen(true)}><Search size={13} /></button>}
              <button type="button" className="dc-icon" aria-label="Copy response body" title="Copy" onClick={() => { void copyText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }); }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
            </div>
            <div className="api-response__content" ref={preRef}>
              {kind === 'image' && view !== 'raw' ? <img className="api-preview-img" alt="Response image" src={`data:${contentTypeOf(res).split(';')[0]};base64,${res.body}`} />
                : kind === 'binary' ? <p className="api-muted api-center">Binary response ({formatSize(res.bodySize)}, {contentTypeOf(res) || 'unknown type'})</p>
                : view === 'preview' ? (kind === 'html' ? <iframe className="api-preview" title="Response preview" sandbox="" srcDoc={text} /> : <pre className="api-pre" aria-label="Response body">{text}</pre>)
                : view === 'raw' ? <pre className="api-pre api-pre--wrap" aria-label="Response body">{highlight(text, query, active, { n: 0 })}</pre>
                : <PrettyBody text={text} kind={kind} query={query} active={active} />}
              {res.truncated && <p className="api-warn">The body was cut at 50 MB.</p>}
            </div>
          </>
        )}
        {tab === 'headers' && res && (
          <table className="api-table api-table--read" aria-label="Response headers"><thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody>{res.headers.map((h, i) => <tr key={i}><td>{h.key}</td><td>{h.value}</td></tr>)}</tbody></table>
        )}
        {tab === 'cookies' && (
          <div>
            {cookies.length ? (
              <table className="api-table api-table--read" aria-label="Response cookies"><thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>HttpOnly</th><th>Secure</th></tr></thead>
                <tbody>{cookies.map((c, i) => <tr key={i}><td>{c.name}</td><td>{c.value}</td><td>{c.domain}</td><td>{c.path}</td><td>{c.expires ? new Date(c.expires).toUTCString() : 'Session'}</td><td>{c.httpOnly ? 'true' : 'false'}</td><td>{c.secure ? 'true' : 'false'}</td></tr>)}</tbody></table>
            ) : <p className="api-muted api-center">No cookies were set by this response</p>}
            <p className="api-muted">The cookie jar keeps {jarCount} cookie(s) and sends them to matching URLs. <button type="button" className="dc-link" disabled={!jarCount} onClick={onClearCookies}>Clear all cookies</button></p>
          </div>
        )}
        {tab === 'tests' && <TestList tests={tests} />}
        {tab === 'console' && <ConsoleView result={result} />}
      </div>
    </section>
  );
}

function ConsoleView({ result }: { result: RunResult }) {
  const p: PreparedRequest | null = result.prepared;
  return (
    <div className="api-console">
      {p && (
        <details open>
          <summary><strong>{p.method}</strong> {p.url}</summary>
          <table className="api-table api-table--read" aria-label="Request headers sent"><tbody>{p.headers.map((h, i) => <tr key={i}><td>{h.key}</td><td>{/^authorization$/i.test(h.key) ? `${h.value.split(' ')[0]} ••••` : h.value}</td></tr>)}</tbody></table>
          {p.body.kind === 'text' && <pre className="api-pre api-pre--wrap">{p.body.text.length > 20000 ? `${p.body.text.slice(0, 20000)}…` : p.body.text}</pre>}
          {p.body.kind !== 'text' && p.body.kind !== 'none' && <p className="api-muted">Body: {p.body.kind}</p>}
        </details>
      )}
      {result.logs.length ? (
        <ul className="api-logs" aria-label="Script console">
          {result.logs.map((l, i) => <li key={i} className={`api-log api-log--${l.level}`}><span className="api-muted">{l.from}</span> {l.text}</li>)}
        </ul>
      ) : <p className="api-muted">Nothing was logged. console.log() in a script writes here.</p>}
    </div>
  );
}
