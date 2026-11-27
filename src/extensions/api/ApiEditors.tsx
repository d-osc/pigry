/** The editors in the RESTful API tabs: a request (URL bar, params, auth, headers, body, scripts, settings and the
 * response), a collection or folder (overview, auth, scripts, variables) and an environment. */
import { useMemo } from 'react';
import { Code2, Save, Send, X } from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import { METHODS, setRequestParams, setRequestUrl, undefinedVars, type ApiFolder, type ApiRequest, type Auth, type Collection, type CookieJar, type Environment, type KV, type VarScopes } from './api';
import { AuthEditor, BodyEditor, KVTable, ResponsePanel, ScriptPane, VariablesTable, VarText, methodColor, type ResponseTab } from './ApiParts';
import type { RunResult } from './apiRun';

export type ReqTab = 'params' | 'auth' | 'headers' | 'body' | 'pre' | 'tests' | 'settings';
export type ContainerSection = 'overview' | 'auth' | 'pre' | 'tests' | 'variables';

const AUTO_HEADERS = (r: ApiRequest, auth: Auth): string[] => {
  const out: string[] = [];
  if (auth.type === 'bearer' || auth.type === 'basic') out.push('Authorization');
  if (auth.type === 'apikey' && auth.in !== 'query' && auth.key) out.push(auth.key);
  if (r.body.mode === 'raw' && r.body.raw) out.push('Content-Type');
  if (r.body.mode === 'urlencoded' || r.body.mode === 'formdata' || (r.body.mode === 'binary' && r.body.file)) out.push('Content-Type');
  return out;
};

interface RequestEditorProps {
  draft: ApiRequest;
  path: string[];
  dirty: boolean;
  scopes: VarScopes;
  inherited: { auth: Auth; from: string };
  result: RunResult | null;
  sending: boolean;
  reqTab: ReqTab;
  resTab: ResponseTab;
  split: number;
  jar: CookieJar;
  onChange: (fn: (r: ApiRequest) => void) => void;
  onSend: () => void;
  onCancel: () => void;
  onSave: () => void;
  onCode: () => void;
  onReqTab: (t: ReqTab) => void;
  onResTab: (t: ResponseTab) => void;
  onSplit: (dy: number) => void;
  onPickFile: (target: 'binary' | string) => void;
  onClearCookies: () => void;
}

export function RequestEditor(p: RequestEditorProps) {
  const r = p.draft;
  const missing = useMemo(() => undefinedVars(r, p.scopes, r.auth.type === 'inherit' ? p.inherited.auth : r.auth), [r, p.scopes, p.inherited]);
  const effective = r.auth.type === 'inherit' ? p.inherited.auth : r.auth;
  const auto = AUTO_HEADERS(r, effective);
  const count = (list: KV[]) => list.filter((x) => x.enabled && x.key).length;
  const tabs: Array<[ReqTab, string]> = [
    ['params', `Params${count(r.params) ? ` (${count(r.params)})` : ''}`], ['auth', 'Authorization'], ['headers', `Headers${count(r.headers) + auto.length ? ` (${count(r.headers) + auto.length})` : ''}`],
    ['body', 'Body'], ['pre', 'Pre-request Script'], ['tests', 'Tests'], ['settings', 'Settings'],
  ];
  const dot = (t: ReqTab) => (t === 'body' && r.body.mode !== 'none') || (t === 'pre' && r.preRequest.trim()) || (t === 'tests' && r.tests.trim()) || (t === 'auth' && r.auth.type !== 'inherit');
  return (
    <div className="api-request">
      <div className="api-request__top">
        <div className="api-crumbs" aria-label="Location">
          {p.path.map((c, i) => <span key={i} className="api-crumbs__part">{c}<span className="api-crumbs__sep">/</span></span>)}
          <input className="api-crumbs__name" aria-label="Request title" value={r.name} onChange={(e) => { const v = e.target.value; p.onChange((d) => { d.name = v; }); }} />
        </div>
        <span className="dc-grow" />
        <button type="button" className="dc-btn" onClick={p.onSave} title="Save (Ctrl+S)"><Save size={12} /> Save{p.dirty ? ' *' : ''}</button>
        <button type="button" className="dc-icon" aria-label="Code snippet" title="Code snippet (cURL, fetch, Python)" onClick={p.onCode}><Code2 size={15} /></button>
      </div>
      <div className="api-urlbar">
        <select className="api-urlbar__method" aria-label="HTTP method" value={METHODS.includes(r.method as never) ? r.method : 'CUSTOM'} style={{ color: methodColor(r.method) }}
          onChange={(e) => { const v = e.target.value; p.onChange((d) => { d.method = v; }); }}>
          {METHODS.map((m) => <option key={m} value={m} style={{ color: methodColor(m) }}>{m}</option>)}
          {!METHODS.includes(r.method as never) && <option value="CUSTOM">{r.method}</option>}
        </select>
        <VarText className="api-urlbar__url" label="Request URL" value={r.url} scopes={p.scopes} placeholder="Enter URL or paste a cURL command" onEnter={p.onSend}
          onChange={(v) => p.onChange((d) => { setRequestUrl(d, v); })} />
        {p.sending
          ? <button type="button" className="dc-btn api-send api-send--cancel" onClick={p.onCancel}><X size={13} /> Cancel</button>
          : <button type="button" className="dc-btn dc-btn--primary api-send" onClick={p.onSend} title="Send (Ctrl+Enter)"><Send size={13} /> Send</button>}
      </div>
      {missing.length > 0 && <p className="api-warn api-urlbar__warn" role="note">Not defined in the selected environment or any scope: {missing.map((m) => `{{${m}}}`).join(', ')}</p>}
      <div className="api-request__split" style={{ gridTemplateRows: `${p.split}px auto minmax(120px, 1fr)` }}>
        <div className="api-request__pane">
          <div className="api-tabs" role="tablist" aria-label="Request sections">
            {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={p.reqTab === id} className={`api-tab${p.reqTab === id ? ' api-tab--on' : ''}`} onClick={() => p.onReqTab(id)}>{label}{dot(id) && <span className="api-tab__dot" aria-hidden />}</button>)}
          </div>
          <div className="api-request__content">
            {p.reqTab === 'params' && (
              <>
                <h4 className="api-h">Query Params</h4>
                <KVTable rows={r.params} noun="Param" scopes={p.scopes} onChange={(rows) => p.onChange((d) => { setRequestParams(d, rows); })} />
                {r.pathVars.length > 0 && (<><h4 className="api-h">Path Variables</h4><KVTable rows={r.pathVars} noun="Path variable" fixedKeys scopes={p.scopes} onChange={(rows) => p.onChange((d) => { d.pathVars = rows; })} /></>)}
              </>
            )}
            {p.reqTab === 'auth' && <AuthEditor auth={r.auth} allowInherit inherited={p.inherited} scopes={p.scopes} onChange={(a) => p.onChange((d) => { d.auth = a; })} />}
            {p.reqTab === 'headers' && (
              <>
                {auto.length > 0 && <p className="api-muted">Added when sent: {auto.join(', ')} (from {effective.type !== 'none' && auto.includes('Authorization') ? 'Authorization and ' : ''}the body type){' '}— a header of the same name here wins.</p>}
                <KVTable rows={r.headers} noun="Header" scopes={p.scopes} onChange={(rows) => p.onChange((d) => { d.headers = rows; })} />
              </>
            )}
            {p.reqTab === 'body' && <BodyEditor body={r.body} scopes={p.scopes} onPickFile={p.onPickFile} onChange={(b) => p.onChange((d) => { d.body = b; })} />}
            {p.reqTab === 'pre' && <ScriptPane label="Pre-request script" event="prerequest" value={r.preRequest} onChange={(v) => p.onChange((d) => { d.preRequest = v; })} />}
            {p.reqTab === 'tests' && <ScriptPane label="Tests script" event="test" value={r.tests} onChange={(v) => p.onChange((d) => { d.tests = v; })} />}
            {p.reqTab === 'settings' && (
              <div className="api-settings">
                <label className="api-field"><span>Request timeout (ms, 0 = default 30 s)</span>
                  <input className="dc-input" type="number" min={0} max={600000} step={1000} aria-label="Request timeout" value={r.settings.timeoutMs} onChange={(e) => { const n = Math.max(0, Math.min(600000, Number(e.target.value) || 0)); p.onChange((d) => { d.settings = { ...d.settings, timeoutMs: n }; }); }} />
                </label>
                <label className="api-inline"><input type="checkbox" checked={r.settings.followRedirects} onChange={(e) => { const v = e.target.checked; p.onChange((d) => { d.settings = { ...d.settings, followRedirects: v }; }); }} /> Automatically follow redirects</label>
                <label className="api-inline"><input type="checkbox" checked={r.settings.verifyTls} onChange={(e) => { const v = e.target.checked; p.onChange((d) => { d.settings = { ...d.settings, verifyTls: v }; }); }} /> Enable SSL certificate verification</label>
                <label className="api-field"><span>Description</span><textarea className="api-code api-code--prose" aria-label="Request description" rows={4} value={r.description} onChange={(e) => { const v = e.target.value; p.onChange((d) => { d.description = v; }); }} /></label>
              </div>
            )}
          </div>
        </div>
        <ResizeHandle orientation="h" label="Resize response panel" onDelta={(_dx, dy) => p.onSplit(dy)} />
        <ResponsePanel result={p.result} sending={p.sending} onCancel={p.onCancel} tab={p.resTab} onTab={p.onResTab} jar={p.jar} onClearCookies={p.onClearCookies} />
      </div>
    </div>
  );
}

interface ContainerEditorProps {
  kind: 'collection' | 'folder';
  target: Collection | ApiFolder;
  fileKey: string;
  section: ContainerSection;
  scopes: VarScopes;
  inherited?: { auth: Auth; from: string };
  onSection: (s: ContainerSection) => void;
  onChange: (fn: (x: Collection | ApiFolder) => void) => void;
  onRun: () => void;
}
export function ContainerEditor({ kind, target, fileKey, section, scopes, inherited, onSection, onChange, onRun }: ContainerEditorProps) {
  const tabs: Array<[ContainerSection, string]> = [['overview', 'Overview'], ['auth', 'Authorization'], ['pre', 'Pre-request Script'], ['tests', 'Tests'], ...(kind === 'collection' ? [['variables', 'Variables'] as [ContainerSection, string]] : [])];
  return (
    <div className="api-container">
      <div className="api-request__top">
        <input className="api-crumbs__name api-crumbs__name--big" aria-label={kind === 'collection' ? 'Collection name' : 'Folder name'} value={target.name} onChange={(e) => { const v = e.target.value; onChange((x) => { x.name = v; }); }} />
        <span className="api-muted">{kind === 'collection' ? fileKey : 'Folder'}</span>
        <span className="dc-grow" />
        <button type="button" className="dc-btn" onClick={onRun}><Send size={12} /> Run</button>
      </div>
      <div className="api-tabs" role="tablist" aria-label={`${kind} sections`}>
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={section === id} className={`api-tab${section === id ? ' api-tab--on' : ''}`} onClick={() => onSection(id)}>{label}</button>)}
      </div>
      <div className="api-request__content api-container__content">
        {section === 'overview' && (
          <label className="api-field"><span>Description</span><textarea className="api-code api-code--prose" aria-label="Description" rows={12} placeholder="Describe what this is for, how to authenticate, and which environment to use." value={target.description} onChange={(e) => { const v = e.target.value; onChange((x) => { x.description = v; }); }} /></label>
        )}
        {section === 'auth' && <AuthEditor auth={target.auth} allowInherit={kind === 'folder'} inherited={inherited} scopes={scopes} onChange={(a) => onChange((x) => { x.auth = a; })} />}
        {section === 'pre' && <ScriptPane label={`${kind} pre-request script`} event="prerequest" value={target.preRequest} onChange={(v) => onChange((x) => { x.preRequest = v; })} />}
        {section === 'tests' && <ScriptPane label={`${kind} tests script`} event="test" value={target.tests} onChange={(v) => onChange((x) => { x.tests = v; })} />}
        {section === 'variables' && kind === 'collection' && (
          <>
            <p className="api-muted">Collection variables are used by every request in the collection. An environment variable of the same name wins. Values marked Secret stay on this computer (.pigry/cache), the rest is committed.</p>
            <VariablesTable rows={(target as Collection).variables} scopes={scopes} onChange={(rows) => onChange((x) => { (x as Collection).variables = rows; })} />
          </>
        )}
      </div>
    </div>
  );
}

export function EnvironmentEditor({ env, fileKey, globals, active, scopes, onChange, onActivate }: { env: Environment; fileKey: string; globals: boolean; active: boolean; scopes: VarScopes; onChange: (fn: (e: Environment) => void) => void; onActivate: () => void }) {
  return (
    <div className="api-container">
      <div className="api-request__top">
        {globals ? <h2 className="api-crumbs__name api-crumbs__name--big">Globals</h2>
          : <input className="api-crumbs__name api-crumbs__name--big" aria-label="Environment name" value={env.name} onChange={(e) => { const v = e.target.value; onChange((x) => { x.name = v; }); }} />}
        <span className="api-muted">{globals ? 'Available in every collection and environment' : fileKey}</span>
        <span className="dc-grow" />
        {!globals && <button type="button" className="dc-btn" disabled={active} onClick={onActivate}>{active ? 'Active environment' : 'Set active'}</button>}
      </div>
      <div className="api-request__content api-container__content">
        <p className="api-muted">Use variables as {'{{name}}'} in URLs, params, headers, auth and bodies. Values marked Secret are masked and kept in .pigry/cache (git-ignored); the rest is saved in {globals ? 'user/globals.env.json' : `${fileKey}.env.json`} and committed.</p>
        <VariablesTable rows={env.values} scopes={scopes} onChange={(rows) => onChange((x) => { x.values = rows; })} />
      </div>
    </div>
  );
}
