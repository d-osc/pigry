/** Dialogs of the RESTful API screen: import, code snippet, save as, collection runner, unsaved changes. */
import { useMemo, useRef, useState } from 'react';
import { Check, Copy, Play, Square, Upload } from 'lucide-react';
import { Field, Modal } from '../docs/DocsDialogs';
import { formatTime, walk, type ApiRequest, type Collection, type PreparedRequest } from './api';
import { SNIPPET_LANGS, snippet, type SnippetLang } from './apiFormat';
import { failedCount, passedCount, type RunnerStep } from './apiRun';
import { copyText, MethodBadge } from './ApiParts';

export function ImportDialog({ onImport, onClose }: { onImport: (text: string, fileName?: string) => Promise<string | null>; onClose: () => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const run = async () => {
    setBusy(true); setError('');
    const err = await onImport(text, fileName);
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <Modal title="Import" okLabel={busy ? 'Importing…' : 'Import'} okDisabled={!text.trim() || busy} onOk={() => void run()} onClose={onClose} wide
      extra={<button type="button" className="dc-btn" onClick={() => input.current?.click()}><Upload size={12} /> Choose file…</button>}>
      <p className="dc-note">Paste a cURL command, a Postman Collection (v2.1) or environment, or an OpenAPI 3 / Swagger 2 document (JSON or YAML) — or choose a file.</p>
      <textarea className="api-code" aria-label="Import text" rows={14} spellCheck={false} value={text} placeholder={"curl https://api.example.com/users -H 'Accept: application/json'"} onChange={(e) => { setText(e.target.value); setFileName(undefined); setError(''); }} />
      {fileName && <p className="dc-note">File: {fileName}</p>}
      {error && <p className="api-warn" role="alert">{error}</p>}
      <input ref={input} type="file" hidden aria-label="Import file" accept=".json,.yaml,.yml,.txt,.sh,application/json" onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        void f.text().then((t) => { setText(t); setFileName(f.name); setError(''); });
      }} />
    </Modal>
  );
}

export function CodeDialog({ prepared, onClose }: { prepared: PreparedRequest; onClose: () => void }) {
  const [lang, setLang] = useState<SnippetLang>(() => { try { return (localStorage.getItem('pigry:api-snippet') as SnippetLang) || 'curl'; } catch { return 'curl'; } });
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => snippet(lang, prepared), [lang, prepared]);
  return (
    <Modal title="Code snippet" onClose={onClose} wide extra={
      <button type="button" className="dc-btn" onClick={() => void copyText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); })}>{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}</button>
    }>
      <Field label="Language">
        <select className="dc-select" aria-label="Snippet language" value={lang} onChange={(e) => { const v = e.target.value as SnippetLang; setLang(v); try { localStorage.setItem('pigry:api-snippet', v); } catch { /* storage unavailable */ } }}>
          {SNIPPET_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </Field>
      <pre className="api-pre api-pre--code" aria-label="Generated code">{code}</pre>
      <p className="dc-note">Variables are filled in with their current values — check the snippet for secrets before you share it.</p>
    </Modal>
  );
}

export interface SaveTarget { collection: string; folder: string | null; name: string }
export function SaveAsDialog({ name, collections, initial, onSave, onClose }: { name: string; collections: Array<{ key: string; collection: Collection }>; initial?: string | null; onSave: (t: SaveTarget) => void; onClose: () => void }) {
  const [title, setTitle] = useState(name);
  const [target, setTarget] = useState(initial ?? collections[0]?.key ?? '');
  const [folder, setFolder] = useState<string>('');
  const folders = useMemo(() => {
    const c = collections.find((x) => x.key === target)?.collection;
    return c ? [...walk(c.items)].filter((f) => f.item.type === 'folder').map((f) => ({ id: f.item.id, label: [...f.folders.map((x) => x.name), f.item.name].join(' / ') })) : [];
  }, [collections, target]);
  return (
    <Modal title="Save request" okLabel="Save" okDisabled={!title.trim()} onOk={() => onSave({ collection: target, folder: folder || null, name: title.trim() })} onClose={onClose}>
      <Field label="Request name"><input className="dc-input" aria-label="Request name" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Collection">
        <select className="dc-select" aria-label="Save to collection" value={target} onChange={(e) => { setTarget(e.target.value); setFolder(''); }}>
          {!collections.length && <option value="">New collection “My Collection”</option>}
          {collections.map((c) => <option key={c.key} value={c.key}>{c.collection.name} ({c.key})</option>)}
        </select>
      </Field>
      {folders.length > 0 && (
        <Field label="Folder">
          <select className="dc-select" aria-label="Save to folder" value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">(top level)</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>
      )}
    </Modal>
  );
}

export function UnsavedDialog({ name, onSave, onDiscard, onClose }: { name: string; onSave: () => void; onDiscard: () => void; onClose: () => void }) {
  return (
    <Modal title="Unsaved changes" okLabel="Save changes" onOk={onSave} onClose={onClose} extra={<button type="button" className="dc-btn" onClick={onDiscard}>Don't save</button>}>
      <p>“{name}” has changes that are not saved. Save them before closing the tab?</p>
    </Modal>
  );
}

export function RunnerDialog({ title, requests, running, steps, onRun, onStop, onClose }: { title: string; requests: ApiRequest[]; running: boolean; steps: RunnerStep[]; onRun: () => void; onStop: () => void; onClose: () => void }) {
  const tests = steps.flatMap((s) => s.tests);
  const errors = steps.filter((s) => s.error).length;
  const total = steps.reduce((n, s) => n + (s.timeMs ?? 0), 0);
  return (
    <Modal title={`Run ${title}`} onClose={onClose} wide extra={running
      ? <button type="button" className="dc-btn" onClick={onStop}><Square size={12} /> Stop</button>
      : <button type="button" className="dc-btn dc-btn--primary" disabled={!requests.length} onClick={onRun}><Play size={12} /> {steps.length ? 'Run again' : `Run ${requests.length} request${requests.length === 1 ? '' : 's'}`}</button>}>
      <p className="dc-note">Sends the requests in order with the selected environment, runs their scripts and collects the test results. pm.setNextRequest(name) jumps to another request; pm.setNextRequest(null) stops the run.</p>
      {steps.length > 0 && (
        <p className="api-runner__sum" role="status">
          {running ? 'Running… ' : 'Finished: '}{steps.length} request(s) · <span className="api-pass">{passedCount(tests)} passed</span> · <span className={failedCount(tests) ? 'api-fail' : ''}>{failedCount(tests)} failed</span>{errors ? ` · ${errors} error(s)` : ''} · {formatTime(total)}
        </p>
      )}
      <ol className="api-runner" aria-label="Run results">
        {(steps.length ? steps : requests.map((r) => ({ name: r.name, requestId: r.id, status: null, timeMs: null, tests: [] }) as RunnerStep)).map((s, i) => {
          const r = requests.find((x) => x.id === s.requestId);
          return (
            <li key={`${s.requestId}-${i}`} className="api-runner__step">
              <div className="api-runner__head">{r && <MethodBadge method={r.method} short />}<span className="api-runner__name">{s.name}</span><span className="dc-grow" />
                {s.status !== null && <span className={`api-status api-status--${s.status >= 400 ? 'client' : 'ok'}`}>{s.status}</span>}{s.timeMs !== null && <span className="api-muted">{formatTime(s.timeMs)}</span>}</div>
              {s.error && <div className="api-fail">{s.error}</div>}
              {s.tests.map((t, j) => <div key={j} className={t.passed ? 'api-pass' : 'api-fail'}>{t.skipped ? 'SKIP' : t.passed ? 'PASS' : 'FAIL'} {t.name}{t.error ? ` — ${t.error}` : ''}</div>)}
            </li>
          );
        })}
      </ol>
    </Modal>
  );
}
