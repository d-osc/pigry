import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, CircleDashed, FastForward, FileCode2, FileJson, FileText, Film, Loader2, Play, RotateCw, Square, X } from 'lucide-react';
import { readBinaryFile } from '../../lib/tauriClient';
import type { E2eConfig, LogEntry, Snapshot, TestError, TestStatus } from '../../lib/e2e/runner';

export type ViewStatus = TestStatus | 'running';

export interface TestView {
  key: string;
  title: string[];
  status: ViewStatus;
  log: LogEntry[];
  error?: TestError;
  screenshots: string[];
  networkFile?: string;
  console?: string;
  attempt?: number;
  ms?: number;
  flaky?: boolean;
}

interface Props {
  spec: string;
  tests: TestView[];
  snapshots: Snapshot[];
  running: boolean;
  /** true while showing a stored result (no live DOM snapshots) */
  stored: boolean;
  startedAt: number;
  durationMs?: number;
  video?: string;
  config: E2eConfig;
  onStop: () => void;
  onRerun: () => void;
  onOpenLine: (line: number) => void;
  onOpenFile: (path: string) => void;
  /** The run is paused (cy.pause() or step mode). */
  paused?: { command: string; line?: number } | null;
  onResume?: () => void;
  onNext?: () => void;
  onExportReport?: () => void;
  junitPath?: string;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

function StatusIcon({ status }: { status: ViewStatus | LogEntry['state'] }) {
  if (status === 'passed') return <Check size={12} strokeWidth={2.5} className="e2e-ic e2e-ic--pass" />;
  if (status === 'failed') return <X size={12} strokeWidth={2.5} className="e2e-ic e2e-ic--fail" />;
  if (status === 'running' || status === 'pending') return <Loader2 size={12} className="e2e-ic e2e-ic--run" />;
  return <CircleDashed size={12} className="e2e-ic e2e-ic--skip" />;
}

/** A screenshot or other saved evidence file shown inline. */
export function EvidenceImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    readBinaryFile(path).then((f) => { if (!cancelled) setSrc(`data:${f.mime || 'image/png'};base64,${f.data}`); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [path]);
  if (failed) return <span className="e2e-evidence__missing">{path.split('/').pop()} (not readable)</span>;
  return src ? <img className="e2e-evidence__img" src={src} alt={path.split('/').pop() ?? 'screenshot'} /> : <span className="e2e-evidence__missing">loading…</span>;
}

/** Page DOM at one moment, drawn in a sandboxed frame scaled to fit. */
function SnapshotFrame({ snap }: { snap: Snapshot | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const doc = useMemo(() => {
    if (!snap) return '';
    let origin = '';
    try { origin = new URL(snap.url).origin; } catch { /* about:blank */ }
    const inject = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; frame-src 'none'">${origin ? `<base href="${origin}/">` : ''}<style>[data-cy-target]{outline:3px solid #4a90e2 !important;outline-offset:1px;box-shadow:0 0 0 6px rgba(159,196,231,.55) !important}</style>`;
    return /<head[^>]*>/i.test(snap.html) ? snap.html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + snap.html;
  }, [snap]);
  if (!snap) return <div className="e2e-preview__empty" ref={box}>No DOM snapshot for this command.<br /><small>Snapshots are taken for visits, queries and actions while a spec runs here (Settings → Snapshots).</small></div>;
  const scale = Math.min(1, (size.w - 8) / snap.w, (size.h - 8) / snap.h);
  return (
    <div className="e2e-preview__stage" ref={box}>
      <div className="e2e-preview__viewport" style={{ width: snap.w * scale, height: snap.h * scale }}>
        <iframe title="Page snapshot" className="e2e-preview__frame" sandbox="" srcDoc={doc} style={{ width: snap.w, height: snap.h, transform: `scale(${scale})` }} />
      </div>
    </div>
  );
}

export function E2eRunnerView({ spec, tests, snapshots, running, stored, startedAt, durationMs, video, config, onStop, onRerun, onOpenLine, onOpenFile, paused, onResume, onNext, onExportReport, junitPath }: Props) {
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState<{ test: string; id: number } | null>(null);
  const [hover, setHover] = useState<{ test: string; id: number } | null>(null);
  const [side, setSide] = useState<'before' | 'after'>('after');
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!running) return; const t = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(t); }, [running]);

  // running and failed tests are open unless the user closed them
  const isOpen = (t: TestView) => override[t.key] ?? (t.status === 'running' || t.status === 'failed');
  const lastLogCount = tests.reduce((n, t) => n + t.log.length, 0);
  useEffect(() => { if (running && listRef.current && !pinned) listRef.current.scrollTop = listRef.current.scrollHeight; }, [running, lastLogCount, pinned]);

  const passed = tests.filter((t) => t.status === 'passed').length;
  const failed = tests.filter((t) => t.status === 'failed').length;
  const pending = tests.filter((t) => t.status === 'pending' || t.status === 'skipped').length;
  const elapsed = running ? now - startedAt : durationMs ?? 0;

  const find = (ref: { test: string; id: number } | null): LogEntry | undefined => (ref ? tests.find((t) => t.key === ref.test)?.log.find((l) => l.id === ref.id) : undefined);
  const latestWithSnap = useMemo(() => {
    const t = tests.find((x) => x.status === 'running') ?? [...tests].reverse().find((x) => x.log.some((l) => l.before !== undefined || l.after !== undefined || l.name === 'visit'));
    return t ? [...t.log].reverse().find((l) => l.before !== undefined || l.after !== undefined) : undefined;
  }, [tests]);
  const active = find(hover) ?? find(pinned) ?? latestWithSnap;
  const idx = active ? (side === 'before' ? (active.before ?? active.after) : (active.after ?? active.before)) : undefined;
  const snap = idx !== undefined ? snapshots[idx] ?? null : null;

  const suites = useMemo(() => {
    const out: Array<{ title: string; depth: number; test?: TestView }> = [];
    let prev: string[] = [];
    for (const t of tests) {
      const path = t.title.slice(0, -1);
      let common = 0;
      while (common < prev.length && common < path.length && prev[common] === path[common]) common += 1;
      for (let d = common; d < path.length; d += 1) out.push({ title: path[d], depth: d });
      out.push({ title: t.title[t.title.length - 1], depth: path.length, test: t });
      prev = path;
    }
    return out;
  }, [tests]);

  const toggle = (t: TestView) => setOverride((o) => ({ ...o, [t.key]: !isOpen(t) }));

  return (
    <div className="e2e-run">
      <div className="e2e-run__bar" role="status" aria-label="Run summary">
        <span className="e2e-stat e2e-stat--pass" title="Passed"><Check size={12} strokeWidth={2.5} /> {passed}</span>
        <span className="e2e-stat e2e-stat--fail" title="Failed"><X size={12} strokeWidth={2.5} /> {failed}</span>
        <span className="e2e-stat e2e-stat--skip" title="Pending / skipped"><Circle size={10} /> {pending}</span>
        <span className="e2e-run__time">{fmtMs(elapsed)}</span>
        <span className="e2e-run__spec">{spec}</span>
        {snap && <span className="e2e-run__url" title={snap.url}>{snap.url}</span>}
        <span className="e2e-run__grow" />
        {paused && (
          <span className="e2e-paused" role="status" aria-label="Paused">
            Paused{paused.command ? ` at ${paused.command}` : ''}
            <button type="button" className="e2e-btn e2e-btn--primary" onClick={onResume}><Play size={11} /> Resume</button>
            <button type="button" className="e2e-btn" onClick={onNext}><FastForward size={11} /> Next command</button>
          </span>
        )}
        {!running && onExportReport && <button type="button" className="e2e-btn" onClick={onExportReport} title="Save a Markdown report with the steps, errors and screenshots"><FileText size={12} /> Report</button>}
        {!running && junitPath && <button type="button" className="e2e-btn" onClick={() => onOpenFile(junitPath)} title="JUnit XML for CI systems"><FileCode2 size={12} /> JUnit</button>}
        {video && <button type="button" className="e2e-btn" onClick={() => onOpenFile(video)}><Film size={12} /> Video</button>}
        {running ? <button type="button" className="e2e-btn e2e-btn--danger" onClick={onStop}><Square size={11} /> Stop</button> : <button type="button" className="e2e-btn" onClick={onRerun}><RotateCw size={12} /> Run again</button>}
      </div>
      <div className="e2e-run__split">
        <div className="e2e-reporter" ref={listRef} aria-label="Tests and commands">
          {tests.length === 0 && <p className="e2e-empty">{running ? 'Loading the spec…' : 'No tests.'}</p>}
          {suites.map((row, i) => {
            if (!row.test) return <div key={`s${i}`} className="e2e-suite" style={{ paddingLeft: 10 + row.depth * 14 }}>{row.title}</div>;
            const t = row.test;
            const expanded = isOpen(t);
            return (
              <div key={t.key} className={`e2e-test e2e-test--${t.status}`} data-status={t.status}>
                <button type="button" className="e2e-test__head" style={{ paddingLeft: 10 + row.depth * 14 }} aria-expanded={expanded} onClick={() => toggle(t)}>
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <StatusIcon status={t.status} />
                  <span className="e2e-test__title">{row.title}</span>
                  {(t.attempt ?? 1) > 1 && <span className="e2e-chip">attempt {t.attempt}</span>}
                  {t.flaky && <span className="e2e-chip e2e-chip--warn" title="Passed only after a retry">flaky</span>}
                  {t.ms !== undefined && t.status !== 'running' && t.status !== 'pending' && <span className="e2e-test__ms">{fmtMs(t.ms)}</span>}
                </button>
                {expanded && (
                  <div className="e2e-test__body">
                    <ol className="e2e-log">
                      {t.log.map((l, n) => {
                        const on = pinned?.test === t.key && pinned.id === l.id;
                        return (
                          <li key={l.id}>
                            <button type="button" className={`e2e-cmd e2e-cmd--${l.state} e2e-cmd--${l.kind}${on ? ' e2e-cmd--pinned' : ''}`} style={{ paddingLeft: 8 + Math.max(0, l.level - 1) * 14 }}
                              onMouseEnter={() => setHover({ test: t.key, id: l.id })} onMouseLeave={() => setHover(null)}
                              onClick={() => setPinned(on ? null : { test: t.key, id: l.id })}>
                              <span className="e2e-cmd__n">{n + 1}</span>
                              {l.kind === 'assertion' ? <StatusIcon status={l.state} /> : null}
                              <span className="e2e-cmd__name">{l.kind === 'assertion' ? 'assert' : l.name}</span>
                              <span className="e2e-cmd__msg">{l.message}</span>
                              {l.alias && <span className="e2e-chip">@{l.alias}</span>}
                              {(l.before !== undefined || l.after !== undefined) && <span className="e2e-cmd__snap" title="DOM snapshot — hover or click to time-travel">◉</span>}
                              {l.state === 'failed' && <X size={11} className="e2e-ic e2e-ic--fail" />}
                            </button>
                            {on && l.line !== undefined && <button type="button" className="e2e-link" onClick={() => onOpenLine(l.line!)}>Go to line {l.line} in the spec</button>}
                            {on && l.props && (
                              <pre className="e2e-props">{Object.entries(l.props).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`).join('\n')}</pre>
                            )}
                            {l.error && <div className="e2e-cmd__err">{l.error.split('\n')[0]}</div>}
                          </li>
                        );
                      })}
                      {t.log.length === 0 && <li className="e2e-empty">{t.status === 'pending' ? 'Not run.' : 'No commands yet.'}</li>}
                    </ol>
                    {t.error && (
                      <div className="e2e-error" role="alert">
                        <div className="e2e-error__title">{t.error.name}</div>
                        <pre className="e2e-error__msg">{t.error.message}</pre>
                        {t.error.frame && (
                          <pre className="e2e-frame" aria-label="Code frame">
                            {t.error.frame.lines.map((l) => <button key={l.n} type="button" className={`e2e-frame__line${l.hit ? ' e2e-frame__line--hit' : ''}`} onClick={() => onOpenLine(l.n)}><i>{l.n}</i>{l.text || ' '}</button>)}
                          </pre>
                        )}
                        {t.console && <pre className="e2e-console" aria-label="Browser console">{t.console}</pre>}
                      </div>
                    )}
                    {(t.screenshots.length > 0 || t.networkFile) && (
                      <div className="e2e-evidence">
                        {t.screenshots.map((s) => <figure key={s} className="e2e-evidence__item"><EvidenceImage path={s} /><figcaption>{s.split('/').pop()}</figcaption></figure>)}
                        {t.networkFile && <button type="button" className="e2e-btn" onClick={() => onOpenFile(t.networkFile!)}><FileJson size={12} /> API evidence</button>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="e2e-preview" aria-label="Application preview">
          <div className="e2e-preview__bar">
            <span className="e2e-preview__label">{active ? `${active.name} ${active.message}`.trim().slice(0, 60) : 'Preview'}</span>
            <span className="e2e-run__grow" />
            <div className="e2e-seg" role="group" aria-label="Snapshot">
              <button type="button" className={side === 'before' ? 'on' : ''} onClick={() => setSide('before')} disabled={!active || active.before === undefined}>Before</button>
              <button type="button" className={side === 'after' ? 'on' : ''} onClick={() => setSide('after')} disabled={!active || (active.after === undefined && active.before === undefined)}>After</button>
            </div>
            {snap && <span className="e2e-chip" title="Viewport of the test browser">{snap.w}×{snap.h}</span>}
          </div>
          {stored ? <div className="e2e-preview__empty">Stored results keep the command log and evidence files, not DOM snapshots.<br /><small>Run the spec again to time-travel through the commands. Viewport: {config.viewportWidth}×{config.viewportHeight}.</small></div> : <SnapshotFrame snap={snap} />}
        </div>
      </div>
    </div>
  );
}
