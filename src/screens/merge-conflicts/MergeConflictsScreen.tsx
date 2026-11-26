/** Merge conflicts: one place to finish any merge, rebase, cherry-pick or revert that stopped with conflicts.
 * Each conflict block is shown as two readable sides with plain-language labels; pick a side, keep both, or edit,
 * then save the file, mark it resolved (stage it) and continue or abort the operation. */
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, FileCode2, FileWarning, GitMerge, Pencil, RotateCcw, Sparkles, Undo2, X,
} from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import * as client from '../../lib/tauriClient';
import type { ConflictStateInfo, ConflictVersionsInfo } from '../../lib/tauriClient';
import {
  autoChoice, blockContext, choiceLabel, choiceLines, describeBlock, parseConflicts, resolveText, type Choice, type ConflictBlock, type ParsedConflicts,
} from '../../lib/conflicts';
import './MergeConflictsScreen.css';

const OP_NAME: Record<string, string> = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' };

interface Loaded { path: string; text: string; parsed: ParsedConflicts; versions: ConflictVersionsInfo | null; error?: string }

function goTo(screen: string): void { window.dispatchEvent(new CustomEvent('pigry:go-screen', { detail: screen })); }
function openInExplorer(path: string, line?: number): void { window.dispatchEvent(new CustomEvent('pigry:goto-file', { detail: { path, line } })); }

function Lines({ lines, start, other, base, kind }: { lines: string[]; start?: number; other: string[]; base: string[] | null; kind: 'current' | 'incoming' | 'base' | 'result' | 'context' }) {
  const compare = new Set(base ?? other);
  if (lines.length === 0) return <div className={`mc-lines mc-lines--${kind} mc-lines--empty`}>(no lines — this side removed them)</div>;
  return (
    <div className={`mc-lines mc-lines--${kind}`}>
      {lines.map((line, i) => (
        <div key={i} className={`mc-line${(kind === 'current' || kind === 'incoming') && !compare.has(line) ? ' mc-line--changed' : ''}`}>
          {start !== undefined && <span className="mc-line__no">{start + i}</span>}
          <code>{line || ' '}</code>
        </div>
      ))}
    </div>
  );
}

/** One conflict block: both sides, the chosen result, and the accept / edit actions. Also used by Duplicate commit,
 * which passes its own side names. */
export function ConflictCard({
  block, total, parsed, choice, focused, info, names, onChoose, onFocus,
}: {
  block: ConflictBlock; total: number; parsed: ParsedConflicts; choice: Choice | undefined; focused: boolean; info: ConflictStateInfo | null;
  names?: { current: string; incoming: string };
  onChoose: (choice: Choice | undefined) => void; onFocus: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showBase, setShowBase] = useState(false);
  const [bothOpen, setBothOpen] = useState(false);
  const ctx = blockContext(parsed, block.index, 2);
  const auto = autoChoice(block);
  const n = block.index + 1;
  const currentName = names?.current ?? (info?.operation === 'rebase' ? 'Current — the new base' : 'Current — your branch');
  const incomingName = names?.incoming ?? (info?.operation === 'rebase' ? 'Incoming — your commit' : info?.operation === 'revert' ? 'Incoming — the undo' : 'Incoming — their change');
  return (
    <section className={`mc-card${choice ? ' mc-card--done' : ''}${focused ? ' mc-card--focus' : ''}`} aria-label={`Conflict ${n} of ${total}`} onClick={onFocus} data-testid={`conflict-${n}`}>
      <header className="mc-card__head">
        <span className="mc-card__title">Conflict {n} of {total}</span>
        <span className="mc-card__where">line {block.startLine}</span>
        <span className="mc-card__desc">{describeBlock(block)}</span>
        {choice && <span className="mc-chip mc-chip--ok"><Check size={11} /> {choiceLabel(choice)}</span>}
      </header>

      {!choice && auto && (
        <div className="mc-suggest" role="note">
          <Sparkles size={13} /> <span>{auto.reason} Suggested: <strong>{choiceLabel(auto.choice)}</strong>.</span>
          <button type="button" className="mc-btn mc-btn--small" onClick={(e) => { e.stopPropagation(); onChoose(auto.choice); }}>Use suggestion</button>
        </div>
      )}

      {ctx.before.length > 0 && <Lines lines={ctx.before} start={block.startLine - ctx.before.length} other={[]} base={null} kind="context" />}

      {choice ? (
        <div className="mc-result-block">
          <div className="mc-side__head"><span>Result</span><small>{choiceLabel(choice)}</small></div>
          <Lines lines={choiceLines(block, choice)} other={[]} base={null} kind="result" />
        </div>
      ) : editing !== null ? (
        <div className="mc-edit">
          <div className="mc-side__head"><span>Edit the result</span><small>combine the two sides by hand</small></div>
          <textarea className="mc-edit__area" aria-label={`Edited result for conflict ${n}`} value={editing} rows={Math.min(16, Math.max(4, editing.split('\n').length + 1))} spellCheck={false} onChange={(e) => setEditing(e.target.value)} />
          <div className="mc-actions">
            <button type="button" className="mc-btn mc-btn--primary" onClick={(e) => { e.stopPropagation(); onChoose({ kind: 'custom', text: editing }); setEditing(null); }}>Use this text</button>
            <button type="button" className="mc-btn" onClick={(e) => { e.stopPropagation(); setEditing(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="mc-sides">
          <div className="mc-side mc-side--current">
            <div className="mc-side__head"><span>{currentName}</span><small title="Text after <<<<<<< in the file">{block.currentLabel || 'HEAD'}</small></div>
            <Lines lines={block.current} start={block.startLine + 1} other={block.incoming} base={block.base} kind="current" />
          </div>
          <div className="mc-side mc-side--incoming">
            <div className="mc-side__head"><span>{incomingName}</span><small title="Text after >>>>>>> in the file">{block.incomingLabel || 'incoming'}</small></div>
            <Lines lines={block.incoming} start={block.endLine - block.incoming.length} other={block.current} base={block.base} kind="incoming" />
          </div>
        </div>
      )}

      {block.base && !choice && editing === null && (
        <div className="mc-base">
          <button type="button" className="mc-link" aria-expanded={showBase} onClick={(e) => { e.stopPropagation(); setShowBase((s) => !s); }}>
            {showBase ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Common ancestor (before either change)
          </button>
          {showBase && <Lines lines={block.base} other={[]} base={null} kind="base" />}
        </div>
      )}

      {ctx.after.length > 0 && <Lines lines={ctx.after} start={block.endLine + 1} other={[]} base={null} kind="context" />}

      <div className="mc-actions" role="group" aria-label={`Resolve conflict ${n}`}>
        {choice ? (
          <>
            <button type="button" className="mc-btn" onClick={(e) => { e.stopPropagation(); onChoose(undefined); }}><Undo2 size={13} /> Change</button>
            <button type="button" className="mc-btn" onClick={(e) => { e.stopPropagation(); setEditing(choiceLines(block, choice).join('\n')); onChoose(undefined); }}><Pencil size={13} /> Edit result</button>
          </>
        ) : editing === null && (
          <>
            <button type="button" className="mc-btn mc-btn--current" onClick={(e) => { e.stopPropagation(); onChoose({ kind: 'current' }); }} title="Keep only the current side (1)">Accept current</button>
            <button type="button" className="mc-btn mc-btn--incoming" onClick={(e) => { e.stopPropagation(); onChoose({ kind: 'incoming' }); }} title="Keep only the incoming side (2)">Accept incoming</button>
            <span className="mc-split">
              <button type="button" className="mc-btn" onClick={(e) => { e.stopPropagation(); onChoose({ kind: 'both', order: 'current-first' }); }} title="Keep both, current first (3)">Accept both</button>
              <button type="button" className="mc-btn mc-btn--caret" aria-label="More ways to keep both" aria-expanded={bothOpen} onClick={(e) => { e.stopPropagation(); setBothOpen((o) => !o); }}><ChevronDown size={12} /></button>
              {bothOpen && (
                <span className="mc-menu" role="menu">
                  <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); setBothOpen(false); onChoose({ kind: 'both', order: 'current-first' }); }}>Both — current first</button>
                  <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); setBothOpen(false); onChoose({ kind: 'both', order: 'incoming-first' }); }}>Both — incoming first</button>
                  {block.base && <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); setBothOpen(false); onChoose({ kind: 'base' }); }}>Neither — keep the ancestor</button>}
                </span>
              )}
            </span>
            <button type="button" className="mc-btn" onClick={(e) => { e.stopPropagation(); setEditing([...block.current, ...block.incoming].join('\n')); }} title="Write the result yourself (E)"><Pencil size={13} /> Edit</button>
          </>
        )}
      </div>
    </section>
  );
}

function Banner({ info, left, total, onContinue, onAbort, busy }: { info: ConflictStateInfo | null; left: number; total: number; onContinue: () => void; onAbort: () => void; busy: boolean }) {
  const op = info?.operation ?? null;
  const [confirm, setConfirm] = useState(false);
  let title = 'Conflicts in your working tree';
  let sub = 'They came from a stash, a cherry-pick or revert made without committing, or another command. Resolve each file, then commit it in Working changes.';
  if (op === 'merge') { title = `Merging into ${info?.branch ?? 'your branch'}`; sub = `${info?.incomingLabel ?? ''}${info?.incomingCommit ? ` · last incoming commit ${info.incomingCommit}` : ''}`; }
  if (op === 'rebase') { title = `Rebasing ${info?.branch ?? 'your branch'}${info?.step ? ` — step ${info.step[0]} of ${info.step[1]}` : ''}`; sub = `Replaying ${info?.incomingCommit ?? 'your commit'}. During a rebase "Current" is the new base and "Incoming" is your own commit.`; }
  if (op === 'cherry-pick') { title = `Cherry-picking onto ${info?.branch ?? 'your branch'}`; sub = `Applying ${info?.incomingCommit ?? 'a commit'}.`; }
  if (op === 'revert') { title = `Reverting on ${info?.branch ?? 'your branch'}`; sub = `Undoing ${info?.incomingCommit ?? 'a commit'}.`; }
  const name = op ? OP_NAME[op] : '';
  return (
    <section className="mc-banner" aria-label="Operation in progress">
      <GitMerge size={18} className="mc-banner__icon" />
      <div className="mc-banner__text">
        <strong>{title}</strong>
        <span>{sub}</span>
      </div>
      <div className="mc-banner__progress" aria-label="Files left">
        <span className="mc-progress"><span style={{ width: `${total ? Math.round(((total - left) / total) * 100) : 100}%` }} /></span>
        <small>{left === 0 ? 'All files resolved' : `${left} of ${total} file${total === 1 ? '' : 's'} left`}</small>
      </div>
      {op ? (
        confirm ? (
          <span className="mc-confirm" role="alert">
            Abort the {name}? Your branch goes back to how it was before and the resolutions are lost.
            <button type="button" className="mc-btn mc-btn--danger" disabled={busy} onClick={() => { setConfirm(false); onAbort(); }}>Abort {name}</button>
            <button type="button" className="mc-btn" onClick={() => setConfirm(false)}>Keep going</button>
          </span>
        ) : (
          <span className="mc-banner__actions">
            <button type="button" className="mc-btn" disabled={busy} onClick={() => setConfirm(true)}><X size={13} /> Abort {name}</button>
            <button type="button" className="mc-btn mc-btn--primary" disabled={busy || left > 0} title={left > 0 ? 'Resolve and mark every file first' : `Finish the ${name}`} onClick={onContinue}><Check size={13} /> {op === 'merge' ? 'Commit merge' : `Continue ${name}`}</button>
          </span>
        )
      ) : left === 0 ? (
        <button type="button" className="mc-btn mc-btn--primary" onClick={() => goTo('working-changes')}>Commit in Working changes</button>
      ) : null}
    </section>
  );
}

function Help({ info }: { info: ConflictStateInfo | null }) {
  return (
    <aside className="mc-help" aria-label="How conflicts work">
      <h3><CircleHelp size={13} /> How to read a conflict</h3>
      <p>Git could not combine two changes to the same lines, so it wrote both into the file between markers:</p>
      <pre className="mc-help__sample">
        <span className="mc-help__m">{'<<<<<<< HEAD'}</span>{'\n'}
        <span className="mc-help__c">{'color = "red"'}</span>{'      ← current\n'}
        <span className="mc-help__m">{'======='}</span>{'\n'}
        <span className="mc-help__i">{'color = "green"'}</span>{'    ← incoming\n'}
        <span className="mc-help__m">{'>>>>>>> feature'}</span>
      </pre>
      <dl>
        <dt className="mc-help__c">Current</dt><dd>{info?.currentLabel ? `${info.currentLabel[0].toUpperCase()}${info.currentLabel.slice(1)}.` : 'What your branch has.'}</dd>
        <dt className="mc-help__i">Incoming</dt><dd>{info?.incomingLabel ? `${info.incomingLabel[0].toUpperCase()}${info.incomingLabel.slice(1)}.` : 'The change being brought in.'}</dd>
      </dl>
      <h3>Steps</h3>
      <ol>
        <li>Pick a file on the left.</li>
        <li>For each conflict choose <em>Accept current</em>, <em>Accept incoming</em>, <em>Accept both</em>, or <em>Edit</em> to write the result yourself.</li>
        <li>Press <em>Save &amp; mark resolved</em> — the file is saved and staged.</li>
        <li>When no files are left, finish with <em>Continue</em> (or <em>Commit merge</em>), or <em>Abort</em> to go back.</li>
      </ol>
      <h3>Keys</h3>
      <ul className="mc-keys">
        <li><kbd>N</kbd>/<kbd>P</kbd> next / previous conflict</li>
        <li><kbd>1</kbd> current · <kbd>2</kbd> incoming · <kbd>3</kbd> both</li>
        <li><kbd>Ctrl</kbd>+<kbd>S</kbd> save &amp; mark resolved</li>
      </ul>
      <p className="mc-note">Lines highlighted in a side differ from the other side (or from the common ancestor when the file has one).</p>
    </aside>
  );
}

export function MergeConflictsScreen() {
  const { repository, notify, refresh, stage, conflictContinue, conflictAbort, busy } = useRepository();
  const conflicted = useMemo(() => [...new Set((repository?.files ?? []).filter((f) => f.status === 'C').map((f) => f.path))].sort(), [repository?.files]);
  const [info, setInfo] = useState<ConflictStateInfo | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [choices, setChoices] = useState<Record<string, Record<number, Choice | undefined>>>({});
  const [resolved, setResolved] = useState<string[]>([]);
  const [focus, setFocus] = useState(0);
  const [showResult, setShowResult] = useState(false);
  const [helpOpen, setHelpOpen] = useState(true);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [infoKey, setInfoKey] = useState(0);

  const active = picked && conflicted.includes(picked) ? picked : conflicted[0] ?? null;
  const conflictKey = conflicted.join('|');

  useEffect(() => {
    let off = false;
    void (async () => {
      try { const next = await client.conflictState(); if (!off) setInfo(next); } catch { if (!off) setInfo(null); }
    })();
    return () => { off = true; };
  }, [conflictKey, repository?.headOid, infoKey]);

  useEffect(() => {
    if (!active) return;
    let off = false;
    void (async () => {
      try {
        const [file, versions] = await Promise.all([client.readWorktreeFile(active), client.conflictVersions(active).catch(() => null)]);
        if (off) return;
        if (file.binary || file.tooLarge) { setLoaded({ path: active, text: '', parsed: parseConflicts(''), versions, error: file.binary ? 'This is a binary file.' : 'This file is too large to show.' }); return; }
        setLoaded({ path: active, text: file.content, parsed: parseConflicts(file.content), versions });
      } catch (error) {
        if (!off) setLoaded({ path: active, text: '', parsed: parseConflicts(''), versions: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { off = true; };
  }, [active, reload]);

  const file = loaded && loaded.path === active ? loaded : null;
  const fileChoices = (active && choices[active]) || {};
  const blocks = file?.parsed.blocks ?? [];
  const chosen = blocks.filter((b) => fileChoices[b.index]).length;
  const allChosen = !!file && !file.error && !file.parsed.malformed && chosen === blocks.length;
  const resultText = file ? resolveText(file.parsed, fileChoices) : '';
  const suggestions = blocks.filter((b) => !fileChoices[b.index] && autoChoice(b));

  const choose = (index: number, choice: Choice | undefined): void => {
    if (!active) return;
    setChoices((all) => ({ ...all, [active]: { ...(all[active] ?? {}), [index]: choice } }));
    if (choice) { const next = blocks.find((b) => b.index > index && !fileChoices[b.index]); if (next) setFocus(next.index); }
  };
  const chooseAll = (make: (b: ConflictBlock) => Choice | null): void => {
    if (!active) return;
    setChoices((all) => {
      const mine = { ...(all[active] ?? {}) };
      for (const b of blocks) { if (mine[b.index]) continue; const c = make(b); if (c) mine[b.index] = c; }
      return { ...all, [active]: mine };
    });
  };

  const save = async (markResolved: boolean): Promise<void> => {
    if (!file || !active || saving) return;
    setSaving(true);
    try {
      if (!file.error) await client.writeWorktreeFile(active, resultText);
      if (markResolved) {
        await stage([active]);
        setResolved((r) => [...new Set([...r, active])]);
        setChoices((all) => { const next = { ...all }; delete next[active]; return next; });
        setPicked(null);
      } else {
        await refresh();
        setChoices((all) => { const next = { ...all }; delete next[active]; return next; });
        setReload((n) => n + 1);
        notify(`Saved ${active}`, 'success');
      }
    } catch (error) {
      notify(`Could not save ${active}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally { setSaving(false); }
  };
  const takeWhole = async (side: 'current' | 'incoming'): Promise<void> => {
    if (!file?.versions || !active) return;
    const text = file.versions[side];
    if (text === null) { notify(`The ${side} side deleted ${active}. Delete the file in Explorer, then mark it resolved.`, 'error'); return; }
    await client.writeWorktreeFile(active, text);
    await stage([active]);
    setResolved((r) => [...new Set([...r, active])]);
    setPicked(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 's') { e.preventDefault(); if (allChosen) void save(true); else void save(false); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || !blocks.length) return;
    const go = (i: number): void => { e.preventDefault(); const at = Math.max(0, Math.min(blocks.length - 1, i)); setFocus(at); document.querySelector(`[data-testid="conflict-${at + 1}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    if (key === 'n' || key === 'j') return go(focus + 1);
    if (key === 'p' || key === 'k') return go(focus - 1);
    const block = blocks[focus];
    if (!block || fileChoices[block.index]) return;
    if (key === '1') { e.preventDefault(); choose(block.index, { kind: 'current' }); }
    if (key === '2') { e.preventDefault(); choose(block.index, { kind: 'incoming' }); }
    if (key === '3') { e.preventDefault(); choose(block.index, { kind: 'both', order: 'current-first' }); }
  };

  const total = conflicted.length + resolved.filter((p) => !conflicted.includes(p)).length;
  const hasWork = conflicted.length > 0 || !!info?.operation;

  return (
    <div className="screen mc" onKeyDown={onKeyDown}>
      <header className="screen-header">
        <h1 className="screen-header__title">Merge conflicts</h1>
        <span className="screen-header__meta">Resolve conflict markers one by one — pick a side, keep both, or write the result yourself</span>
        <button type="button" className={`secondary-button${helpOpen ? ' is-active' : ''}`} aria-pressed={helpOpen} onClick={() => setHelpOpen((o) => !o)}><CircleHelp size={12} strokeWidth={1.5} /> How it works</button>
      </header>

      {!hasWork ? (
        <div className="mc-empty">
          <CheckCircle2 size={34} strokeWidth={1.25} />
          <h2>No conflicts</h2>
          <p>Conflicts appear when a merge, rebase, cherry-pick, revert or stash changes the same lines as your branch. When that happens they are listed here, one card per conflict, so you can decide what to keep.</p>
          {resolved.length > 0 && <p>Resolved in this session: {resolved.join(', ')}.</p>}
          {(repository?.files.length ?? 0) > 0 && <button type="button" className="mc-btn mc-btn--primary" onClick={() => goTo('working-changes')}>Open Working changes</button>}
        </div>
      ) : (
        <div className="mc-body" tabIndex={-1}>
          <Banner info={info} left={conflicted.length} total={Math.max(total, conflicted.length)} busy={busy} onContinue={() => void conflictContinue().then(() => setInfoKey((k) => k + 1))} onAbort={() => { setResolved([]); setChoices({}); void conflictAbort().then(() => setInfoKey((k) => k + 1)); }} />
          <div className="mc-main">
            <nav className="mc-files" aria-label="Conflicted files">
              <h3>Conflicted <span>{conflicted.length}</span></h3>
              {conflicted.length === 0 && <p className="mc-note mc-pad">Every file is resolved.</p>}
              {conflicted.map((path) => {
                const left = path === active && file ? blocks.length - chosen : null;
                return (
                  <button key={path} type="button" className={`mc-file${path === active ? ' mc-file--on' : ''}`} aria-current={path === active} onClick={() => { setPicked(path); setFocus(0); setShowResult(false); }} title={path}>
                    <FileWarning size={13} className="mc-file__icon" />
                    <span className="mc-file__name">{path.split('/').pop()}<small>{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}</small></span>
                    {left !== null && <span className="mc-file__count" aria-label={`${left} conflicts left`}>{left}</span>}
                  </button>
                );
              })}
              {resolved.filter((p) => !conflicted.includes(p)).length > 0 && (
                <>
                  <h3>Resolved</h3>
                  {resolved.filter((p) => !conflicted.includes(p)).map((path) => (
                    <div key={path} className="mc-file mc-file--done" title={path}><Check size={13} className="mc-file__icon" /><span className="mc-file__name">{path.split('/').pop()}</span></div>
                  ))}
                </>
              )}
            </nav>

            <section className="mc-detail" aria-label="Conflicts in the file">
              {!active ? (
                <div className="mc-empty mc-empty--inner">
                  <CheckCircle2 size={28} strokeWidth={1.25} />
                  <p>{info?.operation ? `All files are resolved. Press ${info.operation === 'merge' ? 'Commit merge' : 'Continue'} above to finish.` : 'All files are resolved. Commit them in Working changes.'}</p>
                </div>
              ) : !file ? (
                <p className="mc-note mc-pad">Loading {active}…</p>
              ) : (
                <>
                  <div className="mc-toolbar" role="toolbar" aria-label="File actions">
                    <FileCode2 size={14} />
                    <strong className="mc-toolbar__path" title={active}>{active}</strong>
                    {blocks.length > 0 && <span className="mc-chip" aria-label="Conflicts resolved in this file">{chosen} of {blocks.length} resolved</span>}
                    <span className="mc-grow" />
                    {blocks.length > 0 && (
                      <>
                        {suggestions.length > 0 && <button type="button" className="mc-btn" onClick={() => chooseAll((b) => autoChoice(b)?.choice ?? null)}><Sparkles size={13} /> Apply {suggestions.length} safe suggestion{suggestions.length === 1 ? '' : 's'}</button>}
                        <button type="button" className="mc-btn" onClick={() => chooseAll(() => ({ kind: 'current' }))}>All current</button>
                        <button type="button" className="mc-btn" onClick={() => chooseAll(() => ({ kind: 'incoming' }))}>All incoming</button>
                        <button type="button" className="mc-btn" disabled={chosen === 0} onClick={() => setChoices((all) => ({ ...all, [active]: {} }))}><RotateCcw size={13} /> Reset</button>
                      </>
                    )}
                    <button type="button" className={`mc-btn${showResult ? ' mc-btn--on' : ''}`} aria-pressed={showResult} onClick={() => setShowResult((s) => !s)}>Preview result</button>
                    <button type="button" className="mc-btn" onClick={() => openInExplorer(active, blocks[focus]?.startLine)}>Open in Explorer</button>
                  </div>

                  {file.error && (
                    <div className="mc-warn" role="alert">
                      <AlertTriangle size={14} /> {file.error} Choose a whole version, or resolve it from a terminal and mark it resolved.
                    </div>
                  )}
                  {file.parsed.malformed && (
                    <div className="mc-warn" role="alert"><AlertTriangle size={14} /> The markers in this file are broken: {file.parsed.malformed}. Fix them in Explorer, or take a whole version below.</div>
                  )}
                  {!file.error && blocks.length === 0 && !file.parsed.malformed && (
                    <div className="mc-ok" role="status"><CheckCircle2 size={14} /> No conflict markers are left in this file. Mark it resolved to stage it.</div>
                  )}

                  <div className="mc-cards">
                    {showResult ? (
                      <pre className="mc-preview" aria-label="Result preview">{resultText.split(/\r?\n/).map((l, i) => <span key={i} className={/^(<{7}|={7}|>{7}|\|{7})/.test(l) ? 'mc-preview__marker' : ''}>{l}{'\n'}</span>)}</pre>
                    ) : blocks.map((block) => (
                      <ConflictCard
                        key={`${active}:${block.index}`} block={block} total={blocks.length} parsed={file.parsed} choice={fileChoices[block.index]} focused={focus === block.index}
                        info={info} onChoose={(c) => choose(block.index, c)} onFocus={() => setFocus(block.index)}
                      />
                    ))}
                  </div>

                  <footer className="mc-footer">
                    {file.versions && !file.versions.binary && (
                      <span className="mc-whole">
                        Whole file:
                        <button type="button" className="mc-link" onClick={() => void takeWhole('current')}>keep current version</button>
                        <button type="button" className="mc-link" onClick={() => void takeWhole('incoming')}>keep incoming version</button>
                      </span>
                    )}
                    <span className="mc-grow" />
                    {blocks.length > 0 && <span className="mc-note">{allChosen ? 'Every conflict has a choice.' : `${blocks.length - chosen} conflict${blocks.length - chosen === 1 ? ' still needs' : 's still need'} a choice.`}</span>}
                    {blocks.length > 0 && <button type="button" className="mc-btn" disabled={saving || chosen === 0} onClick={() => void save(false)} title="Write the choices so far; unresolved conflicts keep their markers">Save</button>}
                    <button type="button" className="mc-btn mc-btn--primary" disabled={saving || !!file.parsed.malformed || (blocks.length > 0 && !allChosen)} onClick={() => void save(true)} title="Save the file and stage it (Ctrl+S)">
                      <Check size={13} /> {blocks.length ? 'Save & mark resolved' : 'Mark resolved'}
                    </button>
                  </footer>
                </>
              )}
            </section>

            {helpOpen && <Help info={info} />}
          </div>
        </div>
      )}
    </div>
  );
}
