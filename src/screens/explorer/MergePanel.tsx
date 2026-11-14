/** Merge code — two modes:
 *  • Branch — merge a branch INTO the checked-out branch (git merge), with
 *    strategy choice and conflict handling (file list + abort).
 *  • History — carry code from the commit picked in File history into the
 *    working file (side-by-side merge editor). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor } from '../../editor/ThemedEditors';
import { GitMerge } from 'lucide-react';
import { readFileAtCommit, mergeBranch, mergeAbort, mergeStatus, type MergeStatusInfo } from '../../lib/tauriClient';
import { useRepository } from '../../hooks/useRepository';
import { useFileHistory } from '../../hooks/useFileHistory';
import './MergePanel.css';

interface MergePanelProps {
  path: string;
  /** Current editor buffer — the merge RESULT starts from this. */
  workingContent: string;
  language: string;
  baseOid: string | null;
  /** History walks this ref instead of HEAD (e.g. a PR head branch). */
  refName?: string | null;
  /** Writes the merged buffer into the working file. */
  onApply: (merged: string) => void;
}

type MergeMode = 'branch' | 'history';

type MergeStrategy = 'ff' | 'no-ff' | 'squash';

const STRATEGY_LABEL: Record<MergeStrategy, string> = {
  ff: 'Fast-forward (if possible)',
  'no-ff': 'Always merge commit',
  squash: 'Squash (staged, commit to finish)',
};

export function MergePanel({
  path,
  workingContent,
  language,
  baseOid,
  refName,
  onApply,
}: MergePanelProps) {
  const { repository, refresh, notify } = useRepository();
  const [mode, setMode] = useState<MergeMode>('branch');

  /* ---------------- Branch mode ---------------- */
  const branches = repository?.branches ?? [];
  const currentBranch = repository?.currentBranch ?? '';
  const [sourceBranch, setSourceBranch] = useState('');
  const [strategy, setStrategy] = useState<MergeStrategy>('ff');
  const [merging, setMerging] = useState(false);
  const [conflict, setConflict] = useState<MergeStatusInfo | null>(null);
  const [lastResult, setLastResult] = useState('');

  const candidates = useMemo(
    () => branches.filter((branch) => !branch.isHead && branch.name !== currentBranch),
    [branches, currentBranch],
  );

  // Falls back to the first candidate until the user picks one.
  const effectiveSource = sourceBranch || candidates[0]?.name || '';

  // Poll conflict state while the panel is open (merge in progress?).
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      mergeStatus()
        .then((status) => {
          if (!cancelled) setConflict(status.inProgress ? status : null);
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [lastResult]);

  const doMerge = () => {
    if (!effectiveSource || merging) return;
    setMerging(true);
    setLastResult('');
    refresh();
    void (async () => {
      try {
        await mergeBranch(effectiveSource, strategy);
        notify(`Merged ${effectiveSource} into ${currentBranch}`, 'success');
        setLastResult(`Merged ${effectiveSource} into ${currentBranch}.`);
        setConflict(null);
        refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('CONFLICT')) {
          notify(`Merge conflict — resolve in Working changes`, 'error');
          const status = await mergeStatus().catch(() => null);
          if (status) setConflict(status);
          setLastResult('Merge stopped — conflicts must be resolved.');
        } else {
          notify(message, 'error');
          setLastResult(message);
        }
      } finally {
        setMerging(false);
      }
    })();
  };

  const doAbort = () => {
    mergeAbort().then(
      () => {
        notify('Merge aborted', 'success');
        setConflict(null);
        setLastResult('');
        refresh();
      },
      (error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error'),
    );
  };

  /* ---------------- History mode ---------------- */
  const { commits } = useFileHistory(path, refName ?? null);
  const [baseContent, setBaseContent] = useState<string | null>(null);
  const [result, setResult] = useState(workingContent);
  const [status, setStatus] = useState('');
  const editorRef = useRef<{ getValue: () => string; setValue: (v: string) => void } | null>(null);
  const fileName = path.split('/').pop() ?? path;
  const baseCommit = baseOid ? commits?.find((commit) => commit.oid === baseOid) : null;

  useEffect(() => {
    if (!baseCommit) return;
    let cancelled = false;
    readFileAtCommit(path, baseCommit.oid)
      .then((at) => {
        if (!cancelled) setBaseContent(at.binary || at.tooLarge ? null : at.content);
      })
      .catch(() => {
        if (!cancelled) setBaseContent(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, baseCommit?.oid]);

  const [prevWorking, setPrevWorking] = useState(workingContent);
  if (prevWorking !== workingContent) {
    setPrevWorking(workingContent);
    setResult(workingContent);
  }

  const takeBase = () => {
    if (baseContent === null || !editorRef.current) return;
    editorRef.current.setValue(baseContent);
    setResult(baseContent);
    setStatus('Base version taken — edit the right side, then Apply');
  };

  const resetToWorking = () => {
    if (!editorRef.current) return;
    editorRef.current.setValue(workingContent);
    setResult(workingContent);
    setStatus('Reset to the working file');
  };

  const apply = () => {
    const merged = editorRef.current?.getValue() ?? result;
    onApply(merged);
    setStatus('Applied to the working file');
  };

  return (
    <aside className="merge-panel">
      <header className="merge-panel__head">
        <GitMerge size={12} />
        <span className="merge-panel__title">Merge code</span>
        <span className="merge-panel__file">{fileName}</span>
        <div className="merge-panel__tabs" role="group" aria-label="Merge mode">
          <button
            type="button"
            className={`merge-panel__tab${mode === 'branch' ? ' is-active' : ''}`}
            onClick={() => setMode('branch')}
          >
            Branch
          </button>
          <button
            type="button"
            className={`merge-panel__tab${mode === 'history' ? ' is-active' : ''}`}
            onClick={() => setMode('history')}
          >
            File history
          </button>
        </div>
      </header>

      {mode === 'branch' && (
        <div className="merge-panel__branch">
          <div className="merge-panel__row">
            <span className="merge-panel__label">Merge</span>
            <select
              className="merge-panel__select"
              value={effectiveSource}
              aria-label="Branch to merge"
              onChange={(event) => setSourceBranch(event.target.value)}
            >
              {candidates.length === 0 && <option value="">No other branches</option>}
              {candidates.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.name}
                </option>
              ))}
            </select>
            <span className="merge-panel__label">into</span>
            <span className="merge-panel__current">{currentBranch || '(none)'}</span>
          </div>
          <div className="merge-panel__row">
            <span className="merge-panel__label">Strategy</span>
            <select
              className="merge-panel__select"
              value={strategy}
              aria-label="Merge strategy"
              onChange={(event) => setStrategy(event.target.value as MergeStrategy)}
            >
              {(Object.keys(STRATEGY_LABEL) as MergeStrategy[]).map((key) => (
                <option key={key} value={key}>
                  {STRATEGY_LABEL[key]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="merge-panel__btn merge-panel__btn--apply"
              disabled={!effectiveSource || merging}
              onClick={doMerge}
            >
              {merging ? 'Merging…' : 'Merge branch'}
            </button>
            {conflict && (
              <button
                type="button"
                className="merge-panel__btn merge-panel__btn--danger"
                onClick={doAbort}
              >
                Abort merge
              </button>
            )}
          </div>
          {conflict && (
            <div className="merge-panel__conflict">
              <strong>Conflicts ({conflict.conflicted.length})</strong> — resolve in Working
              changes, stage, then commit to finish the merge.
              <ul>
                {conflict.conflicted.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
          )}
          {lastResult && !conflict && (
            <div className="merge-panel__result">{lastResult}</div>
          )}
        </div>
      )}

      {mode === 'history' && (
        <>
          {!baseCommit ? (
            <div className="merge-panel__empty">
              Pick a commit in File history to merge code from.
            </div>
          ) : (
            <>
              <div className="merge-panel__row merge-panel__row--tight">
                <span className="merge-panel__label">
                  LEFT {baseCommit.shortOid} → RIGHT working (editable)
                </span>
                <div className="merge-panel__actions">
                  <button type="button" className="merge-panel__btn" onClick={takeBase}>
                    Take base version
                  </button>
                  <button type="button" className="merge-panel__btn" onClick={resetToWorking}>
                    Reset
                  </button>
                  <button
                    type="button"
                    className="merge-panel__btn merge-panel__btn--apply"
                    onClick={apply}
                  >
                    Apply to file
                  </button>
                </div>
              </div>
              {status && <div className="merge-panel__status">{status}</div>}
              <div className="merge-panel__editor">
                {baseContent === null ? (
                  <div className="merge-panel__empty">Loading base…</div>
                ) : (
                  <DiffEditor
                    key={`${path}:${baseCommit.oid}`}
                    original={baseContent}
                    modified={result}
                    language={language}
                    options={{
                      renderSideBySide: true,
                      fontSize: 11,
                      lineHeight: 18,
                      fontFamily: "'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
                      fontLigatures: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      renderOverviewRuler: false,
                      originalEditable: false,
                      readOnly: false,
                      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
                      stickyScroll: { enabled: false },
                    }}
                    onMount={(editor) => {
                      const modified = editor.getModifiedEditor();
                      editorRef.current = {
                        getValue: () => modified.getValue(),
                        setValue: (value: string) => modified.setValue(value),
                      };
                      modified.onDidChangeModelContent(() => {
                        setResult(modified.getValue());
                      });
                    }}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
