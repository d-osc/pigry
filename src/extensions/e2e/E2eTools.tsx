import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Circle, Copy, Crosshair, ExternalLink, Eye, EyeOff, Plus, Square, Trash2 } from 'lucide-react';
import { pageCall, tauriDriver } from './engine/driver';
import { VIEWPORT_PRESETS } from './engine/assert';
import type { E2eConfig } from './engine/runner';

const driver = tauriDriver();

/* ------------------------------------------------------------------ playground */

interface Pick { selector: string; contains?: string; desc?: string }

const asCy = (p: Pick): string => (p.contains ? `cy.contains('${p.selector}', ${JSON.stringify(p.contains)})` : `cy.get('${p.selector.replace(/'/g, "\\'")}')`);

/** Cypress's Selector Playground: pick an element on the page or type a selector, see how many elements match (highlighted in the test browser) and copy a stable command. */
export function SelectorPlayground({ baseUrl, onInsert }: { baseUrl: string; onInsert: (code: string) => void }) {
  const [urlEdit, setUrl] = useState<string | null>(null);
  const url = urlEdit ?? baseUrl;
  const [selector, setSelector] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<Pick | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [show, setShow] = useState(true);
  const timer = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

  const check = useCallback(async (value: string) => {
    if (!value.trim()) { setCount(null); setSuggestion(null); await pageCall(driver, 'clearHl').catch(() => undefined); return; }
    try {
      const n = await pageCall<number>(driver, 'count', [value]);
      setError(n < 0 ? 'Not a valid selector' : '');
      setCount(n < 0 ? null : n);
      if (n > 0) {
        const best = await pageCall<Pick | null>(driver, 'best', [[{ t: 'get', s: value }]]);
        setSuggestion(best);
        if (show) await pageCall(driver, 'hl', [value]);
      } else { setSuggestion(null); await pageCall(driver, 'clearHl').catch(() => undefined); }
    } catch (e) { setError(`${e instanceof Error ? e.message : String(e)} — open a page first`); setCount(null); }
  }, [show]);

  const onSelector = (value: string) => {
    setSelector(value);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void check(value); }, 300);
  };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); void pageCall(driver, 'stopPicker').catch(() => undefined); void pageCall(driver, 'clearHl').catch(() => undefined); }, []);

  const open = async () => {
    setError('');
    try { await driver.open(url.trim(), 600); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const startPick = async () => {
    setError('');
    try {
      await pageCall(driver, 'startPicker');
      setPicking(true);
      pollRef.current = window.setInterval(async () => {
        try {
          const st = await pageCall<{ picking: boolean; picked: Pick | null }>(driver, 'picked');
          if (st.picked) {
            window.clearInterval(pollRef.current!); pollRef.current = null; setPicking(false);
            setSelector(st.picked.selector);
            setSuggestion(st.picked);
            const n = await pageCall<number>(driver, 'count', [st.picked.selector]);
            setCount(n);
          } else if (!st.picking) { window.clearInterval(pollRef.current!); pollRef.current = null; setPicking(false); }
        } catch { window.clearInterval(pollRef.current!); pollRef.current = null; setPicking(false); }
      }, 500);
    } catch (e) { setError(`${e instanceof Error ? e.message : String(e)} — open a page in the test browser first`); }
  };
  const cancelPick = async () => { if (pollRef.current) window.clearInterval(pollRef.current); pollRef.current = null; setPicking(false); await pageCall(driver, 'stopPicker').catch(() => undefined); };

  const code = suggestion ? asCy(suggestion) : selector ? `cy.get('${selector}')` : '';
  return (
    <section className="e2e-tool" aria-label="Selector playground">
      <h3 className="e2e-tool__title"><Crosshair size={13} /> Selector playground</h3>
      <div className="e2e-row">
        <input className="e2e-input" aria-label="Page URL" placeholder="http://localhost:3000/" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void open(); }} />
        <button type="button" className="e2e-btn" onClick={() => void open()} disabled={!/^https?:\/\//.test(url.trim())}><ExternalLink size={12} /> Open</button>
      </div>
      <div className="e2e-row">
        <input className="e2e-input e2e-input--mono" aria-label="CSS selector" placeholder='[data-cy="submit"]  ·  button:contains("Save")' value={selector} onChange={(e) => onSelector(e.target.value)} />
        {picking
          ? <button type="button" className="e2e-btn e2e-btn--danger" onClick={() => void cancelPick()}><Square size={11} /> Cancel</button>
          : <button type="button" className="e2e-btn" onClick={() => void startPick()} title="Click an element in the test browser"><Crosshair size={12} /> Pick</button>}
        <button type="button" className="e2e-icon" aria-label={show ? 'Hide highlight' : 'Show highlight'} onClick={() => { setShow((s) => !s); if (show) void pageCall(driver, 'clearHl').catch(() => undefined); else void check(selector); }}>{show ? <Eye size={13} /> : <EyeOff size={13} />}</button>
      </div>
      {picking && <p className="e2e-hint">Click an element in the test browser window…</p>}
      {count !== null && <p className={`e2e-count${count === 1 ? ' e2e-count--one' : count === 0 ? ' e2e-count--none' : ''}`} role="status">{count} element{count === 1 ? '' : 's'} match{count === 1 ? 'es' : ''}{suggestion?.desc ? ` · ${suggestion.desc}` : ''}</p>}
      {error && <p className="e2e-error-line" role="alert">{error}</p>}
      {code && (
        <div className="e2e-code">
          <code aria-label="Suggested command">{code}</code>
          <button type="button" className="e2e-icon" aria-label="Copy command" onClick={() => void navigator.clipboard?.writeText(code)}><Copy size={12} /></button>
          <button type="button" className="e2e-icon" aria-label="Insert command into the spec" onClick={() => onInsert(`${code};`)}><Plus size={13} /></button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ studio */

interface RecEvent { type: string; selector?: string; contains?: string; value?: string | string[]; key?: string; secret?: boolean; url?: string }

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const target = (e: RecEvent) => (e.contains ? `cy.contains(${q(e.selector ?? '*')}, ${q(e.contains)})` : `cy.get(${q(e.selector ?? 'body')})`);

/** Turns recorded browser interactions into Cypress commands. */
export function generateCommands(events: RecEvent[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const next = events[i + 1];
    switch (e.type) {
      case 'visit': out.push(`cy.visit(${q(String(e.url ?? '/'))});`); break;
      case 'click': out.push(`${target(e)}.click();`); break;
      case 'dblclick': out.push(`${target(e)}.dblclick();`); break;
      case 'check': out.push(`${target(e)}.check();`); break;
      case 'uncheck': out.push(`${target(e)}.uncheck();`); break;
      case 'select': out.push(`${target(e)}.select(${Array.isArray(e.value) ? `[${e.value.map(q).join(', ')}]` : q(String(e.value ?? ''))});`); break;
      case 'type': {
        const submit = !!next && next.type === 'press' && next.selector === e.selector && next.key === 'enter';
        const raw = String(e.value ?? '').replace(/\{/g, '{{}');
        const arg = e.secret ? `Cypress.env('password')${submit ? " + '{enter}'" : ''}` : q(raw + (submit ? '{enter}' : ''));
        out.push(`${target(e)}.clear().type(${arg});`);
        if (submit) i += 1;
        break;
      }
      case 'press': out.push(`${target(e)}.type('{enter}');`); break;
      default: break;
    }
  }
  return out;
}

/** Cypress Studio: record clicks, typing, checkboxes and selects in the test browser and get the commands. */
export function StudioRecorder({ baseUrl, onInsert }: { baseUrl: string; onInsert: (code: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [urlEdit, setUrl] = useState<string | null>(null);
  const url = urlEdit ?? baseUrl;
  const [events, setEvents] = useState<RecEvent[]>([]);
  const [error, setError] = useState('');
  const pollRef = useRef<number | null>(null);
  const poll = useCallback(async () => {
    try { const r = await pageCall<{ on: boolean; events: RecEvent[] }>(driver, 'rec'); setEvents((cur) => { const visit = cur.find((e) => e.type === 'visit'); return visit ? [visit, ...r.events] : r.events; }); } catch { /* page navigating */ }
  }, []);
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); void pageCall(driver, 'stopRecording').catch(() => undefined); }, []);

  const start = async () => {
    setError('');
    try {
      if (/^https?:\/\//.test(url.trim())) await driver.open(url.trim(), 600);
      await pageCall(driver, 'startRecording', [true]);
      const first: RecEvent[] = /^https?:\/\//.test(url.trim()) ? [{ type: 'visit', url: url.trim().replace(baseUrl, '') || '/' }] : [];
      setEvents(first);
      setRecording(true);
      pollRef.current = window.setInterval(() => { void poll(); }, 700);
    } catch (e) { setError(`${e instanceof Error ? e.message : String(e)} — open a page in the test browser first`); }
  };
  const stop = async () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
    await poll();
    await pageCall(driver, 'stopRecording').catch(() => undefined);
    setRecording(false);
  };
  const lines = generateCommands(events);
  return (
    <section className="e2e-tool" aria-label="Studio recorder">
      <h3 className="e2e-tool__title"><Circle size={12} className={recording ? 'e2e-rec' : ''} /> Studio — record interactions</h3>
      <div className="e2e-row">
        <input className="e2e-input" aria-label="Start URL" placeholder="Start URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} disabled={recording} />
        {recording
          ? <button type="button" className="e2e-btn e2e-btn--danger" onClick={() => void stop()}><Square size={11} /> Stop</button>
          : <button type="button" className="e2e-btn e2e-btn--rec" onClick={() => void start()}><Circle size={11} /> Record</button>}
      </div>
      {recording && <p className="e2e-hint">Click, type, check and select in the test browser window — the commands appear here.</p>}
      {error && <p className="e2e-error-line" role="alert">{error}</p>}
      {lines.length > 0 && (
        <>
          <pre className="e2e-rec-code" aria-label="Recorded commands">{lines.join('\n')}</pre>
          <div className="e2e-row">
            <button type="button" className="e2e-btn" onClick={() => onInsert(lines.join('\n'))}><Check size={12} /> Insert into spec</button>
            <button type="button" className="e2e-btn" onClick={() => void navigator.clipboard?.writeText(lines.join('\n'))}><Copy size={12} /> Copy</button>
            <button type="button" className="e2e-icon" aria-label="Clear recording" onClick={() => { setEvents([]); void pageCall(driver, 'clearRec').catch(() => undefined); }}><Trash2 size={12} /></button>
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ settings */

const NUM_FIELDS: Array<{ key: keyof E2eConfig; label: string; min: number; max: number; hint?: string }> = [
  { key: 'defaultCommandTimeout', label: 'Command timeout (ms)', min: 100, max: 120000, hint: 'How long get, contains, should… retry' },
  { key: 'pageLoadTimeout', label: 'Page load timeout (ms)', min: 1000, max: 300000 },
  { key: 'responseTimeout', label: 'Response timeout (ms)', min: 1000, max: 300000, hint: 'cy.wait("@alias")' },
  { key: 'retries', label: 'Retries', min: 0, max: 5, hint: 'Re-run failed tests' },
  { key: 'animationDistanceThreshold', label: 'Animation threshold (px)', min: 0, max: 500, hint: 'Movement below this counts as still' },
];
const TOGGLES: Array<{ key: keyof E2eConfig; label: string; hint: string }> = [
  { key: 'realInput', label: 'Trusted input', hint: 'Real mouse and keyboard events through the browser (hover, :focus, typing delays)' },
  { key: 'chromeWebSecurity', label: 'Web security', hint: 'Turn off to test cross-origin requests and iframes (restarts the test browser)' },
  { key: 'includeShadowDom', label: 'Pierce shadow DOM', hint: 'cy.get / find / contains look inside open shadow roots' },
  { key: 'waitForAnimations', label: 'Wait for animations', hint: 'Actions wait until the element stops moving' },
  { key: 'video', label: 'Record video', hint: 'A .webm of each spec run' },
  { key: 'screenshotOnRunFailure', label: 'Screenshot on failure', hint: 'Automatically, like Cypress' },
  { key: 'networkEvidence', label: 'Save API calls per test', hint: 'DevTools network JSON with redacted bodies' },
  { key: 'snapshots', label: 'DOM snapshots', hint: 'Time travel through commands' },
  { key: 'testIsolation', label: 'Test isolation', hint: 'Clean cookies, storage and page before every test' },
];

export function E2eSettings({ config, onChange }: { config: E2eConfig; onChange: (next: E2eConfig) => void }) {
  const set = (patch: Partial<E2eConfig>) => onChange({ ...config, ...patch });
  const preset = Object.entries(VIEWPORT_PRESETS).find(([, [w, h]]) => w === config.viewportWidth && h === config.viewportHeight)?.[0] ?? '';
  return (
    <div className="e2e-settings" aria-label="E2E settings">
      <label className="e2e-field"><span>Support file</span>
        <input className="e2e-input e2e-input--mono" aria-label="Support file" placeholder=".pigry/e2e/support/e2e.js" defaultValue={config.supportFile} key={config.supportFile} onBlur={(e) => { if (e.target.value.trim() !== config.supportFile) set({ supportFile: e.target.value.trim() }); }} />
        <small>Runs before every spec — custom commands (Cypress.Commands.add), page helpers, global beforeEach. Empty = none.</small>
      </label>
      <label className="e2e-field"><span>Plugins file</span>
        <input className="e2e-input e2e-input--mono" aria-label="Plugins file" placeholder=".pigry/e2e/support/plugins.js" defaultValue={config.pluginsFile} key={`pf${config.pluginsFile}`} onBlur={(e) => { if (e.target.value.trim() !== config.pluginsFile) set({ pluginsFile: e.target.value.trim() }); }} />
        <small>module.exports = (on, config) =&gt; ... — register cy.task handlers and lifecycle events (setupNodeEvents of a cypress.config.js is read as well).</small>
      </label>
      <label className="e2e-field"><span>Extra spec patterns</span>
        <input className="e2e-input e2e-input--mono" aria-label="Spec patterns" placeholder="tests/**/*.spec.js, e2e/**/*.ts" defaultValue={config.specPattern.join(', ')} key={`sp${config.specPattern.join()}`} onBlur={(e) => { const next = e.target.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean); if (next.join() !== config.specPattern.join()) set({ specPattern: next }); }} />
        <small>Globs of spec files outside .pigry/e2e/specs (besides *.cy.js / *.cy.ts) — shown under the "repo" owner.</small>
      </label>
      <label className="e2e-field"><span>Component testing</span>
        <div className="e2e-row">
          <input className="e2e-input e2e-input--mono" aria-label="Component dev server" placeholder="http://localhost:5173" defaultValue={config.componentUrl} key={`cu${config.componentUrl}`} onBlur={(e) => { const v = e.target.value.trim().replace(/\/+$/, ''); if (v !== config.componentUrl) set({ componentUrl: v }); }} />
          <select className="e2e-input" aria-label="Component framework" value={config.componentFramework} onChange={(e) => set({ componentFramework: e.target.value as E2eConfig['componentFramework'] })}>
            <option value="custom">custom mount()</option><option value="react">React</option><option value="vue">Vue</option>
          </select>
        </div>
        <small>cy.mount with a module option imports your component from this dev server (React, Vue or its own mount function). The CLI starts one with --component.</small>
      </label>
      <label className="e2e-field"><span>Base URL</span>
        <input className="e2e-input" aria-label="Base URL" placeholder="http://localhost:3000" defaultValue={config.baseUrl} key={config.baseUrl} onBlur={(e) => { if (e.target.value.trim().replace(/\/+$/, '') !== config.baseUrl) set({ baseUrl: e.target.value.trim().replace(/\/+$/, '') }); }} />
        <small>cy.visit('/path') is resolved against it; tests run in an external Edge/Chrome window.</small>
      </label>
      <div className="e2e-field"><span>Viewport</span>
        <div className="e2e-row">
          <input className="e2e-input e2e-input--num" type="number" aria-label="Viewport width" min={200} max={4000} defaultValue={config.viewportWidth} key={`w${config.viewportWidth}`} onBlur={(e) => set({ viewportWidth: Number(e.target.value) || config.viewportWidth })} />
          <span>×</span>
          <input className="e2e-input e2e-input--num" type="number" aria-label="Viewport height" min={200} max={4000} defaultValue={config.viewportHeight} key={`h${config.viewportHeight}`} onBlur={(e) => set({ viewportHeight: Number(e.target.value) || config.viewportHeight })} />
          <select className="e2e-input" aria-label="Viewport preset" value={preset} onChange={(e) => { const p = VIEWPORT_PRESETS[e.target.value]; if (p) set({ viewportWidth: p[0], viewportHeight: p[1] }); }}>
            <option value="">Custom</option>
            {Object.entries(VIEWPORT_PRESETS).map(([name, [w, h]]) => <option key={name} value={name}>{name} ({w}×{h})</option>)}
          </select>
        </div>
      </div>
      {NUM_FIELDS.map((f) => (
        <label key={f.key} className="e2e-field"><span>{f.label}</span>
          <input className="e2e-input e2e-input--num" type="number" aria-label={f.label} min={f.min} max={f.max} defaultValue={Number(config[f.key])} key={`${f.key}${config[f.key]}`}
            onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n !== config[f.key]) set({ [f.key]: Math.min(f.max, Math.max(f.min, Math.round(n))) } as Partial<E2eConfig>); }} />
          {f.hint && <small>{f.hint}</small>}
        </label>
      ))}
      {TOGGLES.map((t) => (
        <label key={t.key} className="e2e-check"><input type="checkbox" aria-label={t.label} checked={config[t.key] === true} onChange={(e) => set({ [t.key]: e.target.checked } as Partial<E2eConfig>)} /><span>{t.label}</span><small>{t.hint}</small></label>
      ))}
      <EnvEditor key={JSON.stringify(config.env)} env={config.env} onChange={(env) => set({ env })} />
    </div>
  );
}

function EnvEditor({ env: initial, onChange }: { env: Record<string, unknown>; onChange: (env: Record<string, unknown>) => void }) {
  const [env, setEnv] = useState(() => JSON.stringify(initial, null, 2));
  const [envError, setEnvError] = useState('');
  return (
    <label className="e2e-field"><span>Environment variables</span>
      <textarea className="e2e-input e2e-input--mono e2e-area" aria-label="Environment variables" rows={5} spellCheck={false} value={env} onChange={(e) => { setEnv(e.target.value); setEnvError(''); }}
        onBlur={() => { try { const v = JSON.parse(env || '{}') as unknown; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('must be a JSON object'); onChange(v as Record<string, unknown>); } catch (err) { setEnvError(`Not valid JSON: ${(err as Error).message}`); } }} />
      <small>Read in specs with Cypress.env('name'). Stored in the workspace (.pigry/e2e/e2e.config.json) — keep real secrets out.</small>
      {envError && <span className="e2e-error-line" role="alert">{envError}</span>}
    </label>
  );
}
