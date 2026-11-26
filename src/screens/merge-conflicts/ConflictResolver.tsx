/** A whole conflict session in one place: the conflicted files on the left, one card per conflict (current / incoming /
 * result with accept current / incoming / both / edit), a whole-file editor, whole-version choices, and Complete / Abort.
 * Choices stay in memory until Complete, which hands every file's resolution to the caller. Used by Duplicate commit
 * (resolved in memory, nothing written until the end) and Merge branch (resolved in the working tree). */
import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, FileWarning, RotateCcw, Undo2, X } from 'lucide-react';
import type { ConflictFileResolution } from '../../lib/tauriClient';
import { hasConflictMarkers, parseConflicts, resolveText, type Choice, type ParsedConflicts } from '../../lib/conflicts';
import { ConflictCard } from './MergeConflictsScreen';
import './MergeConflictsScreen.css';
import './ConflictResolver.css';

/** One conflicted file. `ours` is the current side, `theirs` the incoming side (null: that side deleted the file, or
 * the version is binary). `merged` is the text with conflict markers, null when it cannot be merged line by line. */
export interface ResolverFile {
  path: string;
  ours: string | null;
  theirs: string | null;
  merged: string | null;
  binary: boolean;
}

/** Names for the two sides, e.g. current "cloud-sit" (role "destination") and incoming "e767f32" (role "this commit"). */
export interface ResolverSides { current: string; currentRole: string; incoming: string; incomingRole: string }

type Side = 'ours' | 'theirs';
interface FileState { choices: Record<number, Choice | undefined>; manual: string | null; side: Side | null }
const EMPTY: FileState = { choices: {}, manual: null, side: null };

function resolutionFor(file: ResolverFile, parsed: ParsedConflicts | null, state: FileState): ConflictFileResolution | null {
  if (state.side) return { path: file.path, side: state.side };
  if (!parsed) return null;
  if (state.manual === null && parsed.malformed) return null;
  const text = state.manual ?? resolveText(parsed, state.choices);
  return hasConflictMarkers(text) ? null : { path: file.path, content: text };
}

export function ConflictResolver({
  files, label, icon, title, description, sides, resultTarget, completeLabel, completeTitle, abortName, abortWarning, busy,
  onComplete, onAbort,
}: {
  files: ResolverFile[];
  /** Accessible name of the whole editor. */
  label: string;
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  sides: ResolverSides;
  /** Where the result goes, e.g. "committed on cloud-sit". */
  resultTarget: string;
  completeLabel: string;
  completeTitle: string;
  /** "duplicate", "merge" — used in "Abort duplicate". */
  abortName: string;
  abortWarning: string;
  busy: boolean;
  onComplete: (resolutions: ConflictFileResolution[]) => void;
  onAbort: () => void;
}) {
  const parsed = useMemo(
    () => new Map(files.map(file => [file.path, file.merged === null ? null : parseConflicts(file.merged)])),
    [files],
  );
  const [states, setStates] = useState<Record<string, FileState>>({});
  const [activePath, setActivePath] = useState(files[0]?.path ?? '');
  const [view, setView] = useState<'conflicts' | 'result'>('conflicts');
  const [focus, setFocus] = useState(0);
  const [confirmAbort, setConfirmAbort] = useState(false);

  const resolutions = files.map(file => resolutionFor(file, parsed.get(file.path) ?? null, states[file.path] ?? EMPTY));
  const resolvedCount = resolutions.filter(Boolean).length;
  const total = files.length;
  const file = files.find(entry => entry.path === activePath) ?? files[0];
  if (!file) return null;
  const fileParsed = parsed.get(file.path) ?? null;
  const state = states[file.path] ?? EMPTY;
  const resolved = resolutions[files.indexOf(file)];
  const blocks = fileParsed?.blocks ?? [];
  const chosen = blocks.filter(block => state.choices[block.index]).length;
  const resultText = fileParsed ? state.manual ?? resolveText(fileParsed, state.choices) : '';
  const nextUnresolved = files.find((entry, index) => entry !== file && !resolutions[index]);
  const currentName = `${sides.current} (${sides.currentRole})`;
  const incomingName = `${sides.incoming} (${sides.incomingRole})`;
  const canTakeSide = file.binary || file.ours !== null || file.theirs !== null;

  const update = (change: (current: FileState) => FileState): void =>
    setStates(all => ({ ...all, [file.path]: change(all[file.path] ?? EMPTY) }));
  const choose = (index: number, choice: Choice | undefined): void => {
    update(current => ({ ...current, choices: { ...current.choices, [index]: choice } }));
    if (choice) {
      const next = blocks.find(block => block.index > index && !state.choices[block.index]);
      if (next) setFocus(next.index);
    }
  };
  const chooseAll = (choice: Choice): void =>
    update(current => ({
      ...current,
      choices: Object.fromEntries(blocks.map(block => [block.index, current.choices[block.index] ?? choice])),
    }));
  const open = (path: string): void => {
    setActivePath(path);
    setFocus(0);
    setView('conflicts');
  };

  const sideLabel = (side: Side): string => {
    const text = side === 'ours' ? file.ours : file.theirs;
    if (text === null && !file.binary) return side === 'ours' ? `Keep it deleted, as in ${sides.current}` : `Delete it, as ${sides.incoming} does`;
    return side === 'ours' ? `Keep ${sides.current}'s version` : `Take ${sides.incoming}'s version`;
  };
  const sideText = (side: Side): string | null => (side === 'ours' ? file.ours : file.theirs);

  return (
    <section className="mc cr" aria-label={label}>
      <div className="mc-banner" role="group" aria-label={`${label} — progress`}>
        <span className="mc-banner__icon">{icon}</span>
        <div className="mc-banner__text">
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <div className="mc-banner__progress" aria-label="Files resolved">
          <span className="mc-progress"><span style={{ width: `${total ? Math.round((resolvedCount / total) * 100) : 100}%` }} /></span>
          <small>{resolvedCount === total ? 'All files resolved' : `${resolvedCount} of ${total} file${total === 1 ? '' : 's'} resolved`}</small>
        </div>
        {confirmAbort ? (
          <span className="mc-confirm" role="alert">
            {abortWarning}
            <button type="button" className="mc-btn mc-btn--danger" disabled={busy} onClick={onAbort}>Abort {abortName}</button>
            <button type="button" className="mc-btn" onClick={() => setConfirmAbort(false)}>Keep going</button>
          </span>
        ) : (
          <span className="mc-banner__actions">
            <button type="button" className="mc-btn" disabled={busy} onClick={() => setConfirmAbort(true)}>
              <X size={13} /> Abort
            </button>
            <button
              type="button"
              className="mc-btn mc-btn--primary"
              disabled={busy || resolvedCount < total}
              title={resolvedCount < total ? 'Resolve every file first' : completeTitle}
              onClick={() => onComplete(resolutions.filter((entry): entry is ConflictFileResolution => entry !== null))}
            >
              <Check size={13} /> {completeLabel}
            </button>
          </span>
        )}
      </div>

      <div className="mc-main">
        <nav className="mc-files" aria-label="Conflicted files">
          <h3>Files <span>{total}</span></h3>
          {files.map((entry, index) => {
            const done = Boolean(resolutions[index]);
            return (
              <button
                key={entry.path}
                type="button"
                className={`mc-file${entry === file ? ' mc-file--on' : ''}${done ? ' cr-file--done' : ''}`}
                aria-current={entry === file}
                title={entry.path}
                onClick={() => open(entry.path)}
              >
                {done ? <Check size={13} className="mc-file__icon" /> : <FileWarning size={13} className="mc-file__icon" />}
                <span className="mc-file__name">
                  {entry.path.split('/').pop()}
                  <small>{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''}</small>
                </span>
                <span className="cr-file__status">{done ? 'Resolved' : 'Conflicted'}</span>
              </button>
            );
          })}
        </nav>

        <section className="mc-detail" aria-label={`Resolve ${file.path}`}>
          <div className="mc-toolbar" role="toolbar" aria-label="File actions">
            <strong className="mc-toolbar__path" title={file.path}>{file.path}</strong>
            {blocks.length > 0 && !state.side && state.manual === null && (
              <span className="mc-chip" aria-label="Conflicts resolved in this file">{chosen} of {blocks.length} resolved</span>
            )}
            {resolved && <span className="mc-chip mc-chip--ok"><Check size={11} /> Resolved</span>}
            <span className="mc-grow" />
            {fileParsed && !state.side && (
              <>
                {view === 'conflicts' && state.manual === null && blocks.length > 0 && (
                  <>
                    <button type="button" className="mc-btn" onClick={() => chooseAll({ kind: 'current' })}>All current</button>
                    <button type="button" className="mc-btn" onClick={() => chooseAll({ kind: 'incoming' })}>All incoming</button>
                  </>
                )}
                <button
                  type="button"
                  className="mc-btn"
                  disabled={chosen === 0 && state.manual === null}
                  onClick={() => update(() => EMPTY)}
                >
                  <RotateCcw size={13} /> Reset
                </button>
                <span className="cr-views" role="group" aria-label="View">
                  <button type="button" className={`mc-btn${view === 'conflicts' ? ' mc-btn--on' : ''}`} aria-pressed={view === 'conflicts'} onClick={() => setView('conflicts')}>Conflicts</button>
                  <button type="button" className={`mc-btn${view === 'result' ? ' mc-btn--on' : ''}`} aria-pressed={view === 'result'} onClick={() => setView('result')}>Edit whole file</button>
                </span>
              </>
            )}
          </div>

          <div className="mc-cards">
            {state.side ? (
              <div className="mc-result-block" aria-label="Chosen version">
                <div className="mc-side__head">
                  <span>Result — the version from {state.side === 'ours' ? currentName : incomingName}</span>
                </div>
                {sideText(state.side) === null ? (
                  <div className="mc-lines mc-lines--empty">{file.binary ? 'Binary file — this version is kept as it is.' : 'The file will be deleted.'}</div>
                ) : (
                  <pre className="mc-preview cr-preview">{sideText(state.side)}</pre>
                )}
                <div className="mc-actions cr-pad">
                  <button type="button" className="mc-btn" onClick={() => update(current => ({ ...current, side: null }))}><Undo2 size={13} /> Change</button>
                </div>
              </div>
            ) : !fileParsed ? (
              <>
                <div className="mc-warn" role="note">
                  <AlertTriangle size={14} />
                  {file.binary
                    ? 'This is a binary file, so it cannot be merged line by line. Pick the version to keep below.'
                    : file.ours === null && file.theirs === null
                      ? 'This file could not be read. Resolve it in Merge conflicts or a terminal.'
                      : file.ours === null
                        ? `${sides.current} deleted this file, but ${sides.incoming} changes it. Keep it deleted or take ${sides.incoming}'s version below.`
                        : `${sides.incoming} deleted this file, but ${sides.current} changed it. Keep ${sides.current}'s version or delete it below.`}
                </div>
                {!file.binary && (file.ours !== null || file.theirs !== null) && (
                  <div className={`mc-side ${file.ours === null ? 'mc-side--incoming' : 'mc-side--current'}`} aria-label="Remaining version">
                    <div className="mc-side__head">
                      <span>{file.ours === null ? `Incoming — ${incomingName}` : `Current — ${currentName}`}</span>
                    </div>
                    <pre className="mc-preview cr-preview">{file.ours ?? file.theirs ?? ''}</pre>
                  </div>
                )}
              </>
            ) : view === 'result' ? (
              <div className="mc-edit cr-result">
                <div className="mc-side__head">
                  <span>Result — what will be {resultTarget}</span>
                  <small>{hasConflictMarkers(resultText) ? 'conflict markers left' : 'no conflict markers'}</small>
                </div>
                <textarea
                  className="mc-edit__area"
                  aria-label={`Result for ${file.path}`}
                  value={resultText}
                  rows={Math.min(30, Math.max(8, resultText.split('\n').length + 1))}
                  spellCheck={false}
                  onChange={event => update(current => ({ ...current, manual: event.target.value }))}
                />
              </div>
            ) : state.manual !== null ? (
              <div className="mc-ok" role="status">
                <CheckCircle2 size={14} /> You edited the result by hand, so it replaces the per-conflict choices.
                <button type="button" className="mc-link" onClick={() => setView('result')}>Show the result</button>
                <button type="button" className="mc-link" onClick={() => update(current => ({ ...current, manual: null }))}>Discard hand edits</button>
              </div>
            ) : (
              <>
                {fileParsed.malformed && (
                  <div className="mc-warn" role="alert"><AlertTriangle size={14} /> The conflict markers are broken: {fileParsed.malformed}. Fix them under Edit whole file.</div>
                )}
                {blocks.length === 0 && !fileParsed.malformed && (
                  <div className="mc-ok" role="status"><CheckCircle2 size={14} /> No conflict markers are left in this file — it is kept as it is.</div>
                )}
                {blocks.map(block => (
                  <ConflictCard
                    key={`${file.path}:${block.index}`}
                    block={block}
                    total={blocks.length}
                    parsed={fileParsed}
                    choice={state.choices[block.index]}
                    focused={focus === block.index}
                    info={null}
                    names={{ current: `Current — ${currentName}`, incoming: `Incoming — ${incomingName}` }}
                    onChoose={choice => choose(block.index, choice)}
                    onFocus={() => setFocus(block.index)}
                  />
                ))}
              </>
            )}
          </div>

          <footer className="mc-footer">
            {!state.side && canTakeSide && (
              <span className="mc-whole">
                Whole file:
                <button type="button" className="mc-link" onClick={() => update(current => ({ ...current, side: 'ours' }))}>{sideLabel('ours')}</button>
                <button type="button" className="mc-link" onClick={() => update(current => ({ ...current, side: 'theirs' }))}>{sideLabel('theirs')}</button>
              </span>
            )}
            <span className="mc-grow" />
            <span className="mc-note">
              {resolved
                ? 'This file is resolved.'
                : fileParsed && !state.side && state.manual === null && blocks.length > chosen
                  ? `${blocks.length - chosen} conflict${blocks.length - chosen === 1 ? ' still needs' : 's still need'} a choice.`
                  : fileParsed && !state.side
                    ? 'Remove every conflict marker to resolve this file.'
                    : 'Pick the version to keep.'}
            </span>
            {nextUnresolved && (
              <button type="button" className="mc-btn" onClick={() => open(nextUnresolved.path)}>
                Next file <ArrowRight size={13} />
              </button>
            )}
          </footer>
        </section>
      </div>
    </section>
  );
}
