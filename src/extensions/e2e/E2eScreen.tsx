import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  Check, ChevronLeft, Circle, CircleDashed, Crosshair, FileCode2, FlaskConical, History, ListChecks, Play, Plus, Settings2, Square, Trash2, X,
} from 'lucide-react';
import '../../editor/monacoSetup';
import { writeWorktreeFile } from '../../lib/tauriClient';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import {
  CYPRESS_DTS, E2E_CHANGED, E2E_OPEN, SPEC_EXT_TS, SPEC_TEMPLATES, analyticsOf, loadReplay, checkSpecSource, loadStats, resultToMarkdown, resultPath, type SpecRef, currentRun, listFixtures, listSpecRefs, loadConfig, loadHistory, loadResult, loadSpecSource,
  mergeConfig, removeSpec, runSpecRef, saveConfig, saveSpecSource, specPath, stopRun, type E2eChange, type HistoryEntry,
} from './engine/spec';
import { getOpenE2e, registerE2eFlush, setOpenE2e, takePendingOpenE2e, type E2eOpenRequest } from './engine/e2eTools';
import { DEFAULT_CONFIG, type E2eConfig, type RunEvent, type Snapshot, type SpecResult, type TestResult } from './engine/runner';
import { E2eRunnerView, type TestView } from './E2eRunnerView';
import { E2eSettings, SelectorPlayground, StudioRecorder } from './E2eTools';
import { E2eBrowserPicker } from './E2eBrowserPicker';
import './E2eScreen.css';

type SideTab = 'specs' | 'runs' | 'settings';
type Pane = 'editor' | 'runner';

const toView = (t: TestResult): TestView => ({ key: t.key, title: t.title, status: t.status, log: t.log, error: t.error, screenshots: t.screenshots, networkFile: t.networkFile, console: t.console, attempt: t.attempts, ms: t.ms, flaky: t.flaky });

interface Live {
  spec: string;
  startedAt: number;
  tests: Map<string, TestView>;
  order: string[];
  snapshots: Snapshot[];
  running: boolean;
  durationMs?: number;
  video?: string;
  stored: boolean;
  /** The browser the run used, e.g. "Chrome 120". */
  browser?: string;
  /** What the run could not do in that browser (e.g. no video in Firefox). */
  notes?: string[];
}

const emptyLive = (spec: string, stored = false): Live => ({ spec, startedAt: Date.now(), tests: new Map(), order: [], snapshots: [], running: false, stored });

export function E2eScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<E2eConfig>(DEFAULT_CONFIG);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [tab, setTab] = useState<SideTab>('specs');
  const [pane, setPane] = useState<Pane>('editor');
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState(SPEC_TEMPLATES[0].id);
  const [newLang, setNewLang] = useState<'js' | 'ts'>('js');
  const [paused, setPaused] = useState<{ command: string; line?: number } | null>(null);
  const [analytics, setAnalytics] = useState<ReturnType<typeof analyticsOf> | null>(null);
  const pauseResolve = useRef<((choice: 'resume' | 'step' | 'stop') => void) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [tool, setTool] = useState<'playground' | 'studio' | null>(null);
  const [watch, setWatch] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [, setTick] = useState(0);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);
  const [lint, setLint] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] });

  const refsRef = useRef<SpecRef[]>([]);
  const liveRef = useRef<Live | null>(null);
  const currentRef = useRef<string | null>(null);
  const sourceRef = useRef('');
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const watchRef = useRef(false);
  const rerunTimer = useRef<number | null>(null);
  const editorRef = useRef<{ editor: import('monaco-editor').editor.IStandaloneCodeEditor; monaco: typeof import('monaco-editor') } | null>(null);
  const configRef = useRef(config);
  const browserLabelRef = useRef('');
  const onBrowserLabel = useCallback((label: string) => { browserLabelRef.current = label; }, []);
  const [browserKind, setBrowserKind] = useState({ family: 'chromium', engine: 'cdp' });
  const onBrowserKind = useCallback((family: string, engine: string) => { setBrowserKind((k) => (k.family === family && k.engine === engine ? k : { family, engine })); }, []);

  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => { sourceRef.current = source; }, [source]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { watchRef.current = watch; }, [watch]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { setOpenE2e(current); return () => setOpenE2e(null); }, [current]);

  const isTs = () => (refsRef.current.find((r) => refKey(r) === currentRef.current)?.ext) === SPEC_EXT_TS;

  const refOf = (key: string | null): OwnedRef | null => {
    if (!key) return null;
    const { owner, slug } = parseRefName(key);
    const ref = { owner: owner ?? USER_OWNER, slug };
    // keep the file extension (.cy.js / .cy.ts) of the spec the list knows about
    return refsRef.current.find((r) => r.owner === ref.owner && r.slug === ref.slug) ?? ref;
  };

  /* ---- loading ---- */

  const refreshList = useCallback(async () => {
    try { const list = await listSpecRefs(); refsRef.current = list; setRefs(list); setFixtures(await listFixtures()); } catch { /* no workspace yet */ }
    try { setHistory(await loadHistory()); } catch { /* none */ }
    try { setAnalytics(analyticsOf(await loadStats())); } catch { /* none */ }
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void refreshList(); });
    void loadConfig().then(setConfig);
  }, [refreshList]);

  const bump = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => { rafRef.current = null; setTick((n) => n + 1); });
  }, []);

  /* ---- saving ---- */

  const saveNow = useCallback(async () => {
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const ref = refOf(currentRef.current);
    if (!ref || !dirtyRef.current) return;
    setSaving(true);
    try {
      await saveSpecSource(ref, sourceRef.current, 'editor');
      dirtyRef.current = false; setDirty(false);
      if (watchRef.current) scheduleRerun();
    } catch (error) { notify(`Could not save the spec: ${String(error)}`, 'error'); } finally { setSaving(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);
  useEffect(() => registerE2eFlush(saveNow), [saveNow]);

  const typeTimer = useRef<number | undefined>(undefined);
  /** Type errors of a .cy.ts spec (against the Cypress typings), shown as warnings under the editor. */
  const scheduleTypeCheck = (text: string) => {
    if (typeTimer.current) window.clearTimeout(typeTimer.current);
    if (!isTs()) return;
    const key = currentRef.current;
    typeTimer.current = window.setTimeout(() => {
      void import('./engine/transpile').then((m) => m.typeCheckTs(text, CYPRESS_DTS)).then((problems) => {
        if (currentRef.current !== key || sourceRef.current !== text) return;
        setLint((l) => ({ errors: l.errors, warnings: [...l.warnings.filter((w) => !w.startsWith('TS ')), ...problems.map((p) => `TS ${p}`)] }));
      }).catch(() => undefined);
    }, 600);
  };

  const onEdit = (value: string | undefined) => {
    const text = value ?? '';
    setSource(text); sourceRef.current = text;
    setDirty(true); dirtyRef.current = true;
    const ed = editorRef.current;
    if (ed) { const model = ed.editor.getModel(); if (model) ed.monaco.editor.setModelMarkers(model, 'e2e', []); }
    setLint(checkSpecSource(text, { typescript: isTs() }));
    scheduleTypeCheck(text);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, 700);
  };

  /* ---- opening ---- */

  const openSpec = useCallback(async (key: string, opts?: { line?: number }) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const text = await loadSpecSource(ref);
      setCurrent(key); currentRef.current = key;
      setSource(text); sourceRef.current = text;
      setDirty(false); dirtyRef.current = false;
      setLint(checkSpecSource(text, { typescript: isTs() }));
      scheduleTypeCheck(text);
      setPane('editor'); setTab('specs');
      if (opts?.line) window.setTimeout(() => revealLine(opts.line!), 150);
    } catch (error) { notify(`Could not open ${key}: ${String(error)}`, 'error'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveNow, notify]);

  const revealLine = (line: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.editor.revealLineInCenter(line);
    ed.editor.setPosition({ lineNumber: line, column: 1 });
  };

  const markErrors = useCallback((tests: TestView[]) => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = ed.editor.getModel();
    if (!model) return;
    const markers = tests.filter((t) => t.status === 'failed' && t.error?.line).map((t) => ({
      severity: ed.monaco.MarkerSeverity.Error, startLineNumber: t.error!.line!, endLineNumber: t.error!.line!, startColumn: 1, endColumn: 400,
      message: `${t.title[t.title.length - 1]}: ${t.error!.message.split('\n')[0]}`,
    }));
    ed.monaco.editor.setModelMarkers(model, 'e2e', markers);
  }, []);

  /* ---- spec CRUD ---- */

  const createSpec = async () => {
    const parsed = parseRefName(newName || 'new-spec');
    const ref: SpecRef = { owner: USER_OWNER, slug: nameSlug(parsed.slug, ['.cy.js', '.cy.ts']), ...(newLang === 'ts' ? { ext: SPEC_EXT_TS } : {}) };
    const template = SPEC_TEMPLATES.find((t) => t.id === newTemplate) ?? SPEC_TEMPLATES[0];
    if ((await listSpecRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug)) { notify(`A spec named "${ref.slug}" already exists`, 'error'); return; }
    await saveNow();
    await saveSpecSource(ref, template.source, 'editor');
    refsRef.current = [...refsRef.current.filter((r) => !(r.owner === ref.owner && r.slug === ref.slug)), ref];
    setCreating(false); setNewName('');
    await refreshList();
    await openSpec(refKey(ref));
  };

  const deleteSpec = async (key: string) => {
    const ref = refOf(key);
    if (!ref) return;
    setConfirmDelete(null);
    await removeSpec(ref);
    if (currentRef.current === key) { setCurrent(null); setSource(''); setDirty(false); }
    await refreshList();
  };

  /* ---- running ---- */

  const apply = useCallback((e: RunEvent) => {
    const l = liveRef.current;
    if (!l) return;
    if (e.type === 'spec:start') { e.tests.forEach((t) => { l.tests.set(t.key, { key: t.key, title: t.title, status: 'pending', log: [], screenshots: [] }); l.order.push(t.key); }); }
    else if (e.type === 'test:start') { const t = l.tests.get(e.key); if (t) { t.status = 'running'; t.attempt = e.attempt; t.log = []; t.error = undefined; } }
    else if (e.type === 'log') { const t = l.tests.get(e.entry.testKey); if (t) t.log = [...t.log, e.entry]; }
    else if (e.type === 'test:end') { l.tests.set(e.result.key, { ...toView(e.result) }); }
    else if (e.type === 'spec:end') { l.running = false; l.durationMs = e.result.ms; l.video = e.result.video; l.notes = e.result.notes; }
    bump();
  }, [bump]);

  const run = useCallback(async (grep?: string, runOpts?: { step?: boolean }) => {
    const key = currentRef.current;
    const ref = refOf(key);
    if (!ref || !key) return;
    if (currentRun()) { notify('A spec is already running — stop it first', 'error'); return; }
    await saveNow();
    const check = checkSpecSource(sourceRef.current, { typescript: isTs() });
    if (check.errors.length) { setLint(check); notify(check.errors[0], 'error'); return; }
    const snapshots: Snapshot[] = [];
    const l: Live = { ...emptyLive(key), snapshots, running: true, browser: browserLabelRef.current || undefined };
    liveRef.current = l; setLive(l); setPane('runner');
    try {
      const result = await runSpecRef(ref, {
        grep, snapshotSink: snapshots, onEvent: apply, step: runOpts?.step,
        onPause: (info) => new Promise((resolve) => { setPaused({ command: info.command, line: info.line }); pauseResolve.current = (choice) => { pauseResolve.current = null; setPaused(null); resolve(choice); }; if (info.line) window.setTimeout(() => revealLine(info.line!), 50); }),
      });
      l.running = false; l.durationMs = result.ms; l.video = result.video; l.browser = result.browser ?? l.browser; l.notes = result.notes;
      if (result.status === 'error') notify(result.error ?? 'The spec could not be loaded', 'error');
      markErrors([...l.tests.values()]);
    } catch (error) {
      l.running = false;
      pauseResolve.current?.('stop');
      notify(`Run failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    bump();
    void refreshList();
  }, [apply, bump, markErrors, notify, refreshList, saveNow]);

  function scheduleRerun() {
    if (rerunTimer.current) window.clearTimeout(rerunTimer.current);
    rerunTimer.current = window.setTimeout(() => { if (!currentRun()) void run(); }, 800);
  }

  const runAll = async () => {
    const list = await listSpecRefs();
    for (const ref of list) {
      await openSpec(refKey(ref));
      await run();
    }
  };

  const runAtCursor = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const pos = ed.editor.getPosition();
    const lines = sourceRef.current.split('\n');
    for (let n = (pos?.lineNumber ?? 1); n >= 1; n -= 1) {
      const m = /\b(?:it|specify)(?:\.only|\.skip)?\s*\(\s*(['"`])(.+?)\1/.exec(lines[n - 1] ?? '');
      if (m) { void run(m[2]); return; }
    }
    notify('Put the cursor inside an it(...) test to run just that test');
  };

  const exportReport = async () => {
    const key = liveRef.current?.spec ?? currentRef.current;
    const ref = refOf(key);
    if (!ref) return;
    const result = await loadResult(ref);
    if (!result) { notify('Run the spec first', 'error'); return; }
    const dir = `.pigry/reports/${ref.owner}`;
    const file = `${dir}/e2e-${ref.owner}-${ref.slug}.md`;
    try { await writeWorktreeFile(file, resultToMarkdown(result, dir)); notify(`Saved the report to ${file}`, 'success'); } catch (error) { notify(`Could not save the report: ${String(error)}`, 'error'); }
  };

  const showStored = async (key: string) => {
    const ref = refOf(key);
    if (!ref) return;
    const result: SpecResult | null = await loadResult(ref);
    if (!result) { notify('No stored result for this spec', 'error'); return; }
    const replay = await loadReplay(ref);
    const l = emptyLive(key, !replay);
    if (replay) l.snapshots = replay.snapshots;
    result.tests.forEach((t) => {
      const view = toView(t);
      const map = replay?.map[t.key] ?? {};
      view.log = view.log.map((e) => ({ ...e, before: map[e.id]?.before, after: map[e.id]?.after }));
      l.tests.set(t.key, view); l.order.push(t.key);
    });
    l.startedAt = result.startedAt; l.durationMs = result.ms; l.video = result.video; l.browser = result.browser; l.notes = result.notes;
    liveRef.current = l; setLive(l); setPane('runner');
    if (currentRef.current !== key) await openSpec(key);
    setPane('runner');
  };

  /* ---- external events: agent edits, open requests, watch ---- */

  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<E2eChange>).detail;
      void refreshList();
      if (change.kind === 'config') { void loadConfig().then(setConfig); return; }
      if (change.kind === 'spec' && change.key === currentRef.current && change.source === 'agent' && !dirtyRef.current) {
        const ref = refOf(change.key);
        if (ref) void loadSpecSource(ref).then((text) => { setSource(text); sourceRef.current = text; setLint(checkSpecSource(text, { typescript: isTs() })); if (watchRef.current) scheduleRerun(); }).catch(() => undefined);
      }
    };
    window.addEventListener(E2E_CHANGED, onChanged);
    return () => window.removeEventListener(E2E_CHANGED, onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshList]);

  useEffect(() => {
    const handle = (req: E2eOpenRequest) => { void openSpec(req.key, { line: req.line }).then(() => { if (req.run) void run(); }); };
    const pending = takePendingOpenE2e();
    if (pending) handle(pending);
    const onOpen = (event: Event) => { takePendingOpenE2e(); handle((event as CustomEvent<E2eOpenRequest>).detail); };
    window.addEventListener(E2E_OPEN, onOpen);
    return () => window.removeEventListener(E2E_OPEN, onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); if (rerunTimer.current) window.clearTimeout(rerunTimer.current); if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current); }, []);

  // restore the editor context when this screen mounts again
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const open = getOpenE2e(); if (open && !currentRef.current) void openSpec(open); }, []);

  /* ---- insert code from the playground / recorder ---- */

  const insertCode = (code: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const pos = ed.editor.getPosition() ?? { lineNumber: 1, column: 1 };
    const indent = (ed.editor.getModel()?.getLineContent(pos.lineNumber).match(/^\s*/)?.[0]) ?? '';
    const text = code.split('\n').map((l, i) => (i === 0 ? l : indent + l)).join('\n') + '\n' + indent;
    ed.editor.executeEdits('e2e-insert', [{ range: new ed.monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text }]);
    ed.editor.focus();
  };

  const updateConfig = async (next: E2eConfig) => {
    const merged = mergeConfig(next);
    setConfig(merged);
    try { await saveConfig(merged, 'editor'); } catch (error) { notify(`Could not save the settings: ${String(error)}`, 'error'); }
  };

  /* ---- derived ---- */

  const lastByKey = useMemo(() => { const m = new Map<string, HistoryEntry>(); for (const h of history) if (!m.has(h.spec)) m.set(h.spec, h); return m; }, [history]);
  const visibleRefs = useMemo(() => refs.filter((r) => refKey(r).toLowerCase().includes(filter.trim().toLowerCase())), [refs, filter]);
  const grouped = useMemo(() => { const m = new Map<string, OwnedRef[]>(); for (const r of visibleRefs) (m.get(r.owner) ?? m.set(r.owner, []).get(r.owner)!).push(r); return [...m.entries()]; }, [visibleRefs]);
  const running = live?.running ?? false;
  const liveTests = live ? live.order.map((k) => live.tests.get(k)!).filter(Boolean) : [];
  const dot = (status?: string) => (status === 'passed' ? <Check size={11} strokeWidth={2.5} className="e2e-ic e2e-ic--pass" /> : status === 'failed' || status === 'error' ? <X size={11} strokeWidth={2.5} className="e2e-ic e2e-ic--fail" /> : <CircleDashed size={11} className="e2e-ic e2e-ic--skip" />);

  return (
    <div className="screen e2e">
      <header className="screen-header">
        <h1 className="screen-header__title">E2E Testing</h1>
        <span className="screen-header__meta">Cypress-style specs, a live command log with time travel, network stubs and evidence — the QA agent writes and runs them too</span>
        {current && <span className={`e2e-save e2e-save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span>}
        <E2eBrowserPicker disabled={running} onLabel={onBrowserLabel} onKind={onBrowserKind} />
        <button type="button" className="e2e-btn" onClick={() => void runAll()} disabled={running || refs.length === 0}><Play size={12} /> Run all</button>
        <button type="button" className="primary-button" onClick={() => { setTab('specs'); setCreating((c) => !c); }}><Plus size={12} strokeWidth={1.5} /> New spec</button>
      </header>

      <div className="screen-body e2e__body">
        <aside className="e2e__side" aria-label="Specs, runs and settings">
          <div className="e2e-tabs" role="tablist" aria-label="Sidebar">
            <button type="button" role="tab" aria-selected={tab === 'specs'} className={tab === 'specs' ? 'on' : ''} onClick={() => setTab('specs')}><ListChecks size={12} /> Specs</button>
            <button type="button" role="tab" aria-selected={tab === 'runs'} className={tab === 'runs' ? 'on' : ''} onClick={() => setTab('runs')}><History size={12} /> Runs</button>
            <button type="button" role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}><Settings2 size={12} /> Settings</button>
          </div>

          {tab === 'specs' && (
            <div className="e2e__section">
              {creating && (
                <div className="e2e-new">
                  <div className="e2e-chips" role="radiogroup" aria-label="Template">
                    {SPEC_TEMPLATES.map((t) => <button key={t.id} type="button" role="radio" aria-checked={newTemplate === t.id} title={t.hint} className={`e2e-chip-btn${newTemplate === t.id ? ' on' : ''}`} onClick={() => setNewTemplate(t.id)}>{t.label}</button>)}
                  </div>
                  <div className="e2e-chips" role="radiogroup" aria-label="Language">
                    <button type="button" role="radio" aria-checked={newLang === 'js'} className={`e2e-chip-btn${newLang === 'js' ? ' on' : ''}`} onClick={() => setNewLang('js')}>JavaScript</button>
                    <button type="button" role="radio" aria-checked={newLang === 'ts'} className={`e2e-chip-btn${newLang === 'ts' ? ' on' : ''}`} onClick={() => setNewLang('ts')} title="Types are stripped when the spec runs">TypeScript</button>
                  </div>
                  <div className="e2e-row">
                    <input className="e2e-input" autoFocus placeholder="Spec name…" aria-label="New spec name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createSpec(); if (e.key === 'Escape') { setCreating(false); setNewName(''); } }} />
                    <button type="button" className="e2e-icon e2e-icon--ok" aria-label="Create spec" onClick={() => void createSpec()}><Check size={13} /></button>
                    <button type="button" className="e2e-icon" aria-label="Cancel" onClick={() => { setCreating(false); setNewName(''); }}><X size={13} /></button>
                  </div>
                </div>
              )}
              <input className="e2e-input e2e-search" placeholder="Search specs…" aria-label="Search specs" value={filter} onChange={(e) => setFilter(e.target.value)} />
              {refs.length === 0 && !creating && <p className="e2e-empty">No specs yet — create one, or ask the QA agent to write it.</p>}
              {grouped.map(([owner, list]) => (
                <div key={owner}>
                  <div className="e2e__owner">{owner}</div>
                  <ul className="e2e-list">
                    {list.map((ref) => {
                      const key = refKey(ref);
                      const last = lastByKey.get(key);
                      return (
                        <li key={key} className={`e2e-item${key === current ? ' e2e-item--active' : ''}`}>
                          <button type="button" className="e2e-item__main" title={specPath(ref)} onClick={() => { if (key !== current) void openSpec(key); else setPane('editor'); }}>
                            {dot(live?.spec === key && live.running ? 'pending' : last?.status)}
                            <span>{ref.slug}</span>
                            {(ref as SpecRef).ext === SPEC_EXT_TS && <b className="e2e-ts">TS</b>}
                            {last && <small className="e2e-item__meta">{last.passed}/{last.passed + last.failed}</small>}
                          </button>
                          {confirmDelete === key ? (
                            <span className="e2e-confirm">
                              <button type="button" className="e2e-icon e2e-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteSpec(key)}><Check size={12} /></button>
                              <button type="button" className="e2e-icon" aria-label="Keep spec" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                            </span>
                          ) : <button type="button" className="e2e-icon e2e-item__del" aria-label={`Delete ${ref.slug}`} title="Delete spec" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {fixtures.length > 0 && (
                <>
                  <div className="e2e__owner">fixtures</div>
                  <ul className="e2e-list">
                    {fixtures.map((f) => <li key={f}><button type="button" className="e2e-item__main" title="Open in Explorer" onClick={() => window.dispatchEvent(new CustomEvent('pigry:goto-file', { detail: { path: `.pigry/e2e/fixtures/${f}` } }))}><FileCode2 size={12} /><span>{f}</span></button></li>)}
                  </ul>
                </>
              )}
            </div>
          )}

          {tab === 'runs' && (
            <div className="e2e__section">
              {history.length === 0 && <p className="e2e-empty">No runs yet.</p>}
              <ul className="e2e-list">
                {history.slice(0, 40).map((h, i) => (
                  <li key={`${h.spec}-${h.at}-${i}`}>
                    <button type="button" className="e2e-item__main e2e-run-row" onClick={() => void showStored(h.spec)} title={new Date(h.at).toLocaleString()}>
                      {dot(h.status)}
                      <span>{h.spec}</span>
                      <small className="e2e-item__meta">{h.passed}✓ {h.failed}✗ · {(h.ms / 1000).toFixed(1)}s</small>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="e2e-hint">Click a run to see its command log, errors, screenshots and API evidence (the latest run of each spec is kept).</p>
              {analytics && (analytics.slowest.length > 0 || analytics.flaky.length > 0 || analytics.failing.length > 0) && (
                <div className="e2e-analytics" aria-label="Analytics">
                  {analytics.failing.length > 0 && <><h4>Failing most</h4><ul className="e2e-list">{analytics.failing.map((x) => <li key={`f-${x.spec}-${x.test}`}><span title={`${x.spec} · ${x.test}`}>{x.test}</span><b>{x.failRate}%</b></li>)}</ul></>}
                  {analytics.flaky.length > 0 && <><h4>Flaky</h4><ul className="e2e-list">{analytics.flaky.map((x) => <li key={`k-${x.spec}-${x.test}`}><span title={`${x.spec} · ${x.test}`}>{x.test}</span><b>{x.rate}%</b></li>)}</ul></>}
                  {analytics.slowest.length > 0 && <><h4>Slowest</h4><ul className="e2e-list">{analytics.slowest.map((x) => <li key={`s-${x.spec}-${x.test}`}><span title={`${x.spec} · ${x.test}`}>{x.test}</span><b>{(x.avgMs / 1000).toFixed(1)}s</b></li>)}</ul></>}
                </div>
              )}
            </div>
          )}

          {tab === 'settings' && <div className="e2e__section"><E2eSettings config={config} onChange={(next) => void updateConfig(next)} browser={browserKind} /></div>}
        </aside>

        <main className="e2e__main" aria-label="Spec editor and runner">
          {!current && pane !== 'runner' ? (
            <div className="e2e-welcome">
              <FlaskConical size={34} strokeWidth={1.2} />
              <h2>End-to-end tests, Cypress style</h2>
              <p>Write specs with <code>cy.visit</code>, <code>cy.get</code>, <code>.click()</code>, <code>.should()</code>, <code>cy.intercept</code>… and watch them run in a real browser window with a command log you can time-travel through.</p>
              <div className="e2e-welcome__row">
                {SPEC_TEMPLATES.map((t) => <button key={t.id} type="button" className="e2e-btn" title={t.hint} onClick={() => { setNewTemplate(t.id); setTab('specs'); setCreating(true); }}>{t.label}</button>)}
              </div>
              <p className="e2e-hint">Set the base URL of your app in Settings first. Tests start with clean cookies and storage. Tip: the Studio records clicks and typing for you; the selector playground finds stable selectors.</p>
            </div>
          ) : (
            <>
              <div className="e2e-bar" role="toolbar" aria-label="Spec actions">
                <div className="e2e-tabs e2e-tabs--inline" role="tablist" aria-label="View">
                  <button type="button" role="tab" aria-selected={pane === 'editor'} className={pane === 'editor' ? 'on' : ''} onClick={() => setPane('editor')} disabled={!current}>Spec</button>
                  <button type="button" role="tab" aria-selected={pane === 'runner'} className={pane === 'runner' ? 'on' : ''} onClick={() => setPane('runner')} disabled={!live}>Runner</button>
                </div>
                <span className="e2e-bar__name">{current ?? live?.spec}</span>
                <span className="e2e-run__grow" />
                {config.baseUrl ? <span className="e2e-chip" title="Base URL">{config.baseUrl}</span> : <button type="button" className="e2e-chip e2e-chip--warn" onClick={() => setTab('settings')}>Set base URL</button>}
                <label className="e2e-toggle" title="Re-run when the spec changes, whoever saves it"><input type="checkbox" aria-label="Watch for changes" checked={watch} onChange={(e) => setWatch(e.target.checked)} /> Watch</label>
                <button type="button" className={`e2e-btn${tool === 'playground' ? ' on' : ''}`} onClick={() => setTool((t) => (t === 'playground' ? null : 'playground'))} aria-pressed={tool === 'playground'}><Crosshair size={12} /> Playground</button>
                <button type="button" className={`e2e-btn${tool === 'studio' ? ' on' : ''}`} onClick={() => setTool((t) => (t === 'studio' ? null : 'studio'))} aria-pressed={tool === 'studio'}><Circle size={11} /> Studio</button>
                <button type="button" className="e2e-btn" onClick={runAtCursor} disabled={!current || running} title="Run the it(...) the cursor is in">Run test</button>
                {running
                  ? <button type="button" className="e2e-btn e2e-btn--danger" onClick={stopRun}><Square size={11} /> Stop</button>
                  : <><button type="button" className="e2e-btn" onClick={() => void run(undefined, { step: true })} disabled={!current} title="Run one command at a time">Step</button><button type="button" className="e2e-btn e2e-btn--primary" onClick={() => void run()} disabled={!current}><Play size={12} /> Run spec</button></>}
              </div>
              <div className="e2e__work">
                <div className="e2e__center">
                  {pane === 'editor' && current && (
                    <>
                      {(lint.errors.length > 0 || lint.warnings.length > 0) && (
                        <ul className="e2e-lint" aria-label="Spec problems">
                          {lint.errors.map((m) => <li key={m} className="e2e-lint__err">{m}</li>)}
                          {lint.warnings.map((m) => <li key={m} className="e2e-lint__warn">{m}</li>)}
                        </ul>
                      )}
                      <div className="e2e-editor" data-testid="e2e-editor">
                        <Editor
                          key={current}
                          value={source}
                          language={isTs() ? 'typescript' : 'javascript'}
                          theme="pigry-dark"
                          onChange={onEdit}
                          beforeMount={(monaco) => {
                            // Monaco 0.5x exposes the TypeScript service as monaco.typescript (monaco.languages.typescript is a stub)
                            type TsApi = { typescriptDefaults?: { addExtraLib(content: string, filePath: string): unknown; getExtraLibs(): Record<string, unknown> }; javascriptDefaults?: { setCompilerOptions(o: object): void; setExtraLibs(libs: Array<{ content: string; filePath: string }>): void }; ScriptTarget?: { ES2020: number } };
                            const ts = (monaco as unknown as { typescript?: TsApi }).typescript;
                            const tsd = ts?.typescriptDefaults;
                            if (tsd && !('ts:cypress.d.ts' in tsd.getExtraLibs())) tsd.addExtraLib(CYPRESS_DTS, 'ts:cypress.d.ts');
                            const js = ts?.javascriptDefaults;
                            if (!js) return;
                            js.setCompilerOptions({ allowNonTsExtensions: true, allowJs: true, target: ts?.ScriptTarget?.ES2020 ?? 7, checkJs: false });
                            js.setExtraLibs([{ content: CYPRESS_DTS, filePath: 'ts:cypress.d.ts' }]);
                          }}
                          onMount={(editor, monaco) => { editorRef.current = { editor, monaco }; editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveNow(); }); editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { void run(); }); }}
                          options={{ fontSize: 13, lineHeight: 20, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 10, bottom: 10 }, tabSize: 2, renderWhitespace: 'selection', glyphMargin: true }}
                        />
                      </div>
                    </>
                  )}
                  {pane === 'runner' && live && (
                    <E2eRunnerView
                      spec={live.spec} tests={liveTests} snapshots={live.snapshots} running={running} stored={live.stored} startedAt={live.startedAt} durationMs={live.durationMs} video={live.video} browser={live.browser} notes={live.notes} config={config}
                      paused={paused} onResume={() => pauseResolve.current?.('resume')} onNext={() => pauseResolve.current?.('step')} onExportReport={() => void exportReport()}
                      junitPath={refOf(live.spec) ? resultPath(refOf(live.spec)!).replace(/\.json$/, '.junit.xml') : undefined}
                      onStop={() => { pauseResolve.current?.('stop'); stopRun(); }} onRerun={() => { if (live.stored && currentRef.current !== live.spec) void openSpec(live.spec).then(() => run()); else void run(); }}
                      onOpenLine={(line) => { setPane('editor'); window.setTimeout(() => revealLine(line), 120); }}
                      onOpenFile={(path) => window.dispatchEvent(new CustomEvent('pigry:goto-file', { detail: { path } }))}
                    />
                  )}
                </div>
                {tool && (
                  <aside className="e2e__tool" aria-label={tool === 'playground' ? 'Selector playground' : 'Studio'}>
                    {tool === 'playground' ? <SelectorPlayground baseUrl={config.baseUrl} onInsert={insertCode} /> : <StudioRecorder baseUrl={config.baseUrl} onInsert={insertCode} />}
                  </aside>
                )}
              </div>
            </>
          )}
        </main>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('e2e')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>
    </div>
  );
}

