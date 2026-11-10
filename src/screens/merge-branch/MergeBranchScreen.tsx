/** Merge Branch screen — merge a branch INTO the checked-out branch with
 * strategy choice, conflict handling (file list + abort) and a result log. */
import { useEffect, useRef, useState } from 'react';
import { DiffEditor, Editor } from '@monaco-editor/react';
import { GitBranch, GitMerge, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  mergePreview,
  mergeFileVersions,
  mergeStatus,
  writeWorktreeFile,
  stagePaths,
  readFileAtCommit,
  type MergePreview,
  type MergeStatusInfo,
} from '../../lib/tauriClient';
import { ConflictController } from '../../editor/conflictMarkers';
import { relativeTime } from '../../lib/relativeTime';
import { languageForPath } from '../../lib/ghData';
import '../../editor/monacoSetup';
import './MergeBranchScreen.css';

type MergeStrategy = 'ff' | 'no-ff' | 'squash';

const STRATEGIES: Array<{ id: MergeStrategy; title: string; detail: string }> = [
  { id: 'ff', title: 'Fast-forward only', detail: 'Moves the branch pointer when possible — fails when both branches diverged.' },
  { id: 'no-ff', title: 'Always merge commit', detail: 'Creates a merge commit even when a fast-forward is possible.' },
  { id: 'squash', title: 'Squash', detail: 'Stages the branch changes as one set — you commit to finish.' },
];

export function MergeBranchScreen() {
  const { repository, refresh, notify, mergeBranch, mergeAbort } = useRepository();
  const currentBranch = repository?.currentBranch ?? '';
  const branches = (repository?.branches ?? []).filter((b) => !b.isHead && b.name !== currentBranch);

  const [source, setSource] = useState('');
  const [strategy, setStrategy] = useState<MergeStrategy>('no-ff');
  const [merging, setMerging] = useState(false);
  const [conflict, setConflict] = useState<MergeStatusInfo | null>(null);
  const [log, setLog] = useState<Array<{ text: string; kind: 'info' | 'success' | 'error' }>>([]);

  // Expanded file viewer: compare diff or conflict-marker editor.
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [versions, setVersions] = useState<{ ours: string; incoming: string; workdir: string } | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);

  // Commit expanded to show its full message + files.
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);

  // Compare layout for file views: side-by-side or unified.
  const [splitView, setSplitView] = useState(true);
  // Per-commit file compare inside "Commits merged in" detail rows.
  const [commitCompare, setCommitCompare] = useState<
    { key: string; before: string; after: string; language: string } | null
  >(null);
  const [loadingCommitCompare, setLoadingCommitCompare] = useState(false);

  const openCommitCompare = async (
    commit: { oid: string; parentOid: string | null },
    filePath: string,
  ) => {
    const key = commit.oid + ':' + filePath;
    if (commitCompare?.key === key) {
      setCommitCompare(null);
      return;
    }
    setCommitCompare(null);
    setLoadingCommitCompare(true);
    try {
      const [before, after] = await Promise.all([
        commit.parentOid ? readFileAtCommit(filePath, commit.parentOid) : null,
        readFileAtCommit(filePath, commit.oid),
      ]);
      setCommitCompare({
        key,
        before: before?.content ?? '',
        after: after?.content ?? '',
        language: after?.language || before?.language || 'plaintext',
      });
    } catch {
      setCommitCompare(null);
    } finally {
      setLoadingCommitCompare(false);
    }
  };

  // Conflicted files are ALL open at once; this set holds collapsed ones.
  const [collapsedConflicts, setCollapsedConflicts] = useState<Set<string>>(new Set());

  // git add one conflicted file straight from its row — refuses while the
  // working file still contains conflict markers.
  const stageOne = async (file: string) => {
    try {
      const versions = await mergeFileVersions(file, effectiveSource || currentBranch);
      if ((versions.workdir ?? '').includes('<<<<<<<')) {
        notify(`${file} still has conflict markers — resolve them first`, 'error');
        return;
      }
      await stagePaths([file]);
      notify(`Staged ${file} — commit to finish the merge`, 'success');
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const toggleFile = async (filePath: string) => {
    if (expandedPath === filePath) {
      setExpandedPath(null);
      setVersions(null);
      return;
    }
    setExpandedPath(filePath);
    setVersions(null);
    setLoadingVersions(true);
    try {
      const result = await mergeFileVersions(filePath, effectiveSource || currentBranch);
      setVersions({
        ours: result.ours ?? '',
        incoming: result.incoming ?? '',
        workdir: result.workdir ?? '',
      });
    } catch {
      setVersions(null);
    } finally {
      setLoadingVersions(false);
    }
  };

  // Auto-pick the first candidate until the user chooses one.
  const effectiveSource = source || branches[0]?.name || '';

  // Load the merge preview whenever the source branch changes.
  const [preview, setPreview] = useState<MergePreview | null>(null);
  useEffect(() => {
    if (!effectiveSource) {
      void Promise.resolve().then(() => setPreview(null));
      return;
    }
    let cancelled = false;
    mergePreview(effectiveSource)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
    return () => {
      cancelled = true;
    };
  }, [effectiveSource]);

  // Poll merge state while the screen is open (conflicts show live).
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void (async () => {
        try {
          const status = await mergeStatus();
          if (cancelled) return;
          const next = status.inProgress ? status : null;
          setConflict((prev) => {
            const same =
              (prev === null && next === null) ||
              (prev !== null &&
                next !== null &&
                prev.inProgress === next.inProgress &&
                prev.conflicted.join("|") === next.conflicted.join("|"));
            return same ? prev : next;
          });
        } catch {
          // merge state unreadable — keep the last known state
        }
      })();
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const addLog = (text: string, kind: 'info' | 'success' | 'error') => {
    setLog((entries) => [...entries, { text, kind }]);
  };

  const doMerge = async () => {
    if (!effectiveSource || merging) return;
    setMerging(true);
    try {
      await mergeBranch(effectiveSource, strategy);
      addLog(`Merged ${effectiveSource} into ${currentBranch}.`, 'success');
      setConflict(null);
      refresh();
      notify(`Merged ${effectiveSource} into ${currentBranch}`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toUpperCase().includes('CONFLICT')) {
        addLog('Merge conflict — resolve in Working changes, then commit.', 'error');
        const status = await mergeStatus().catch(() => null);
        if (status) setConflict(status);
        notify('Merge conflict — resolve in Working changes', 'error');
      } else {
        addLog(message, 'error');
        notify(message, 'error');
      }
    } finally {
      setMerging(false);
    }
  };

  const doAbort = async () => {
    try {
      await mergeAbort();
      addLog('Merge aborted — repository restored.', 'info');
      setConflict(null);
      refresh();
      notify('Merge aborted', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  return (
    <div className="merge-branch">
      <header className="merge-branch__head">
        <h2 className="merge-branch__title">
          <GitMerge size={18} strokeWidth={1.5} />
          Merge branch
        </h2>
        <p className="merge-branch__sub">
          Merge a branch into the checked-out branch
          {currentBranch ? (
            <>
              {' — '}
              <span className="merge-branch__current">{currentBranch}</span>
            </>
          ) : null}
        </p>
      </header>

      <div className="merge-branch__body">
        <section className="merge-branch__section">
          <h3 className="merge-branch__section-title">Source branch</h3>
          {branches.length === 0 ? (
            <p className="merge-branch__empty">No other branches to merge from.</p>
          ) : (
            <div className="merge-branch__branches">
              {branches.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  className={`merge-branch__branch${effectiveSource === branch.name ? ' is-selected' : ''}`}
                  onClick={() => setSource(branch.name)}
                >
                  <GitBranch size={13} strokeWidth={1.5} />
                  <span className="merge-branch__branch-name">{branch.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="merge-branch__section">
          <h3 className="merge-branch__section-title">Strategy</h3>
          <div className="merge-branch__strategies">
            {STRATEGIES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`merge-branch__strategy${strategy === entry.id ? ' is-selected' : ''}`}
                onClick={() => setStrategy(entry.id)}
              >
                <span className="merge-branch__strategy-title">{entry.title}</span>
                <span className="merge-branch__strategy-detail">{entry.detail}</span>
              </button>
            ))}
          </div>
        </section>

        {preview?.upToDate && (
          <section className="merge-branch__section merge-branch__up-to-date">
            <p className="merge-branch__empty">
              {effectiveSource} is already part of {currentBranch || 'the current branch'} — nothing to merge.
            </p>
          </section>
        )}

        {preview && !preview.upToDate && preview.commits.length > 0 && (
          <section className="merge-branch__section">
            <h3 className="merge-branch__section-title">
              Commits merged in ({preview.commits.length})
            </h3>
            <ul className="merge-branch__commits">
              {preview.commits.map((commit) => {
                const open = expandedCommit === commit.oid;
                return (
                  <li key={commit.oid} className="merge-branch__commit">
                    <button
                      type="button"
                      className={`merge-branch__commit-row${open ? ' is-open' : ''}`}
                      title="Show commit detail"
                      onClick={() => setExpandedCommit(open ? null : commit.oid)}
                    >
                      <span className="merge-branch__commit-sha">{commit.shortOid}</span>
                      <span className="merge-branch__commit-summary">{commit.summary}</span>
                      <span className="merge-branch__commit-meta">
                        {commit.authorName} · {relativeTime(commit.timeSeconds)}
                      </span>
                    </button>
                    {open && (
                      <div className="merge-branch__commit-detail">
                        {commit.body !== commit.summary && (
                          <pre className="merge-branch__commit-body">{commit.body}</pre>
                        )}
                        {commit.files.length > 0 ? (
                          <ul className="merge-branch__commit-files">
                            {commit.files.map((entry) => {
                              const compareKey = `${commit.oid}:${entry.path}`;
                              const fileOpen = commitCompare?.key === compareKey;
                              return (
                                <li
                                  key={`${entry.path}:${entry.status}`}
                                  className="merge-branch__commit-file"
                                >
                                  <button
                                    type="button"
                                    className="merge-branch__commit-file-btn"
                                    title={`Compare ${entry.path} (parent vs this commit)`}
                                    onClick={() => void openCommitCompare(commit, entry.path)}
                                  >
                                    <span
                                      className={`merge-branch__file-status merge-branch__file-status--${entry.status}`}
                                    >
                                      {entry.status}
                                    </span>
                                    <span className="merge-branch__file-path">{entry.path}</span>
                                    <span className="merge-branch__file-stats">
                                      <span className="stats-add">+{entry.additions}</span>
                                      <span className="stats-del">−{entry.deletions}</span>
                                    </span>
                                  </button>
                                  {fileOpen && (
                                    <>
                                      {loadingCommitCompare && (
                                        <p className="merge-branch__empty">Loading versions…</p>
                                      )}
                                      <div className="merge-branch__commit-file-view">
                                        <div className="merge-branch__file-view-labels">
                                          <span>
                                            BEFORE — {commit.parentOid?.slice(0, 7) ?? '(new file)'}
                                          </span>
                                          <span>COMMIT — {commit.shortOid}</span>
                                          <div
                                            className="merge-branch__view-mode"
                                            role="group"
                                            aria-label="Diff layout"
                                          >
                                            <button
                                              type="button"
                                              className={splitView ? 'is-active' : ''}
                                              onClick={() => setSplitView(true)}
                                            >
                                              Split
                                            </button>
                                            <button
                                              type="button"
                                              className={!splitView ? 'is-active' : ''}
                                              onClick={() => setSplitView(false)}
                                            >
                                              Unified
                                            </button>
                                          </div>
                                        </div>
                                        <DiffEditor
                                          key={compareKey}
                                          original={commitCompare?.before ?? ''}
                                          modified={commitCompare?.after ?? ''}
                                          language={commitCompare?.language ?? 'plaintext'}
                                          theme="orbit-dark"
                                          options={{
                                            readOnly: true,
                                            renderSideBySide: splitView,
                                            fontSize: 11,
                                            lineHeight: 18,
                                            minimap: { enabled: false },
                                            scrollBeyondLastLine: false,
                                            automaticLayout: true,
                                          }}
                                        />
                                      </div>
                                    </>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <p className="merge-branch__empty">No file changes (merge commit).</p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {preview && !preview.upToDate && preview.files.length > 0 && (
          <section className="merge-branch__section">
            <h3 className="merge-branch__section-title">
              Files changed ({preview.files.length})
            </h3>
            <ul className="merge-branch__files">
              {preview.files.map((file) => {
                const expanded = expandedPath === file.path && versions !== null;
                return (
                  <li key={file.path} className="merge-branch__file">
                    <button
                      type="button"
                      className="merge-branch__file-row"
                      title={`Compare ${file.path} (ours vs incoming)`}
                      onClick={() => void toggleFile(file.path)}
                    >
                      <span className={`merge-branch__file-status merge-branch__file-status--${file.status}`}>
                        {file.status}
                      </span>
                      <span className="merge-branch__file-path">{file.path}</span>
                      <span className="merge-branch__file-stats">
                        <span className="stats-add">+{file.additions}</span>
                        <span className="stats-del">−{file.deletions}</span>
                      </span>
                    </button>
                    {file.commits.length > 0 && (
                      <div className="merge-branch__file-commits">
                        {file.commits.map((entry) => (
                          <span
                            key={`${file.path}:${entry.shortOid}`}
                            className="merge-branch__file-commit"
                            title={`${entry.shortOid} ${entry.summary}`}
                          >
                            <span className="merge-branch__commit-sha">{entry.shortOid}</span>
                            <span className="merge-branch__file-commit-summary">{entry.summary}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {expanded && (
                      <>
                        {loadingVersions && versions === null && (
                          <div className="merge-branch__conflict-editor">
                            <p className="merge-branch__empty">Loading versions…</p>
                          </div>
                        )}
                        <div className="merge-branch__file-view">
                          <div className="merge-branch__file-view-labels">
                            <span>OURS — {currentBranch || 'current'}</span>
                            <span>INCOMING — {effectiveSource}</span>
                            <div className="merge-branch__view-mode" role="group" aria-label="Diff layout">
                              <button
                                type="button"
                                className={splitView ? 'is-active' : ''}
                                onClick={() => setSplitView(true)}
                              >
                                Split
                              </button>
                              <button
                                type="button"
                                className={!splitView ? 'is-active' : ''}
                                onClick={() => setSplitView(false)}
                              >
                                Unified
                              </button>
                            </div>
                          </div>
                          <DiffEditor
                            key={`${file.path}:${effectiveSource}`}
                            original={versions?.ours ?? ''}
                            modified={versions?.incoming ?? ''}
                            language={languageForPath(file.path)}
                            theme="orbit-dark"
                            options={{
                              readOnly: true,
                              renderSideBySide: splitView,
                              fontSize: 11,
                              lineHeight: 18,
                              minimap: { enabled: false },
                              scrollBeyondLastLine: false,
                              automaticLayout: true,
                            }}
                          />
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <div className="merge-branch__run">
          <button
            type="button"
            className="merge-branch__run-btn"
            disabled={!effectiveSource || merging}
            onClick={() => void doMerge()}
          >
            <GitMerge size={14} strokeWidth={1.5} />
            {merging ? 'Merging…' : `Merge ${effectiveSource || '…'} into ${currentBranch || '…'}`}
          </button>
          {conflict && (
            <button
              type="button"
              className="merge-branch__abort-btn"
              onClick={() => void doAbort()}
            >
              Abort merge
            </button>
          )}
        </div>

        {conflict && (
          <section className="merge-branch__section merge-branch__conflict">
            {conflict.conflicted.length === 0 ? (
              <>
                <h3 className="merge-branch__section-title">
                  <CheckCircle2 size={13} strokeWidth={1.5} />
                  Conflicts resolved
                </h3>
                <p className="merge-branch__conflict-resolved">
                  Every conflicted file is staged — commit to finish the merge.
                </p>
              </>
            ) : (
              <>
                <h3 className="merge-branch__section-title">
                  <AlertTriangle size={13} strokeWidth={1.5} />
                  Conflicts ({conflict.conflicted.length})
                </h3>
                <p className="merge-branch__conflict-hint">
                  Every conflicted file is open below — resolve each with the accept
                  buttons, or abort to restore the branch.
                </p>
                <ul className="merge-branch__conflict-list">
                  {conflict.conflicted.map((file) => {
                    const collapsed = collapsedConflicts.has(file);
                    return (
                      <li key={file} className="merge-branch__conflict-file">
                        <div className="merge-branch__conflict-file-row">
                          <button
                            type="button"
                            className={`merge-branch__conflict-file-btn${collapsed ? '' : ' is-open'}`}
                            title={collapsed ? 'Show conflict editor' : 'Collapse this conflict'}
                            onClick={() =>
                              setCollapsedConflicts((prev) => {
                                const next = new Set(prev);
                                if (next.has(file)) next.delete(file);
                                else next.add(file);
                                return next;
                              })
                            }
                          >
                            {file}
                          </button>
                          <button
                            type="button"
                            className="merge-branch__git-add-btn"
                            title={`git add ${file} — stage the resolved content`}
                            onClick={() => void stageOne(file)}
                          >
                            git add
                          </button>
                        </div>
                        {!collapsed && (
                          <div className="merge-branch__conflict-editor">
                            <ConflictEditor
                              key={`${file}:${effectiveSource || currentBranch}`}
                              path={file}
                              branch={effectiveSource || currentBranch}
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        )}

        {log.length > 0 && (
          <section className="merge-branch__section">
            <h3 className="merge-branch__section-title">Log</h3>
            <ul className="merge-branch__log">
              {log
                .slice()
                .reverse()
                .map((entry, index) => (
                  <li key={index} className={`merge-branch__log-row merge-branch__log-row--${entry.kind}`}>
                    {entry.kind === 'success' && <CheckCircle2 size={12} strokeWidth={1.5} />}
                    {entry.kind === 'error' && <AlertTriangle size={12} strokeWidth={1.5} />}
                    <span>{entry.text}</span>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}


/** Editable conflict-marker editor for one file — the VS Code-style accept
 * widget is attached through ConflictController; Save writes the resolved
 * buffer back to the working file. Loads its own working-tree content so
 * every conflicted file can stay open at once. */
function ConflictEditor({ path, branch }: { path: string; branch: string }) {
  const { refresh, notify } = useRepository();
  const [text, setText] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const valueRef = useRef('');
  const [saving, setSaving] = useState(false);
  const controllerRef = useRef<ConflictController | null>(null);
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    mergeFileVersions(path, branch)
      .then((versions) => {
        if (!alive) return;
        const workdir = versions.workdir ?? '';
        setText(workdir);
        setValue(workdir);
        valueRef.current = workdir;
      })
      .catch(() => {
        if (alive) setText('');
      });
    return () => {
      alive = false;
    };
  }, [path, branch]);

  const controllerAccept = (kind: 'current' | 'incoming' | 'both') => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.accept(kind);
    const resolved = controller.getValue();
    setValue(resolved);
    valueRef.current = resolved;
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await writeWorktreeFile(path, valueRef.current);
      // A conflict only leaves the list once the index is updated — stage
      // the file automatically when the markers are gone; keep it listed
      // (and editable) while markers remain.
      if (!valueRef.current.includes('<<<<<<<')) {
        await stagePaths([path]);
        notify('Conflict resolved and staged — commit to finish the merge', 'success');
      } else {
        notify('Saved — conflict markers remain, keep resolving', 'error');
      }
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    saveRef.current = () => void save();
  });

  if (text === null) {
    return (
      <div className="merge-branch__conflict-editor">
        <p className="merge-branch__empty">Loading {path}…</p>
      </div>
    );
  }

  const stageAndReport = async () => {
    try {
      await stagePaths([path]);
      notify('File staged — commit to finish the merge', 'success');
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  if (!text.includes('<<<<<<<')) {
    return (
      <div className="merge-branch__conflict-editor">
        <div className="merge-branch__conflict-editor-toolbar">
          <p className="merge-branch__conflict-resolved">
            No conflict markers remain — stage the file to finish.
          </p>
          <button type="button" className="merge-branch__save-btn" onClick={() => void stageAndReport()}>
            Stage file
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="merge-branch__conflict-editor">
      <div className="merge-branch__conflict-editor-toolbar">
        <div className="merge-branch__accept-actions">
          <button type="button" className="merge-branch__save-btn" onClick={() => controllerAccept('current')}>
            ✓ Accept Current
          </button>
          <button type="button" className="merge-branch__save-btn" onClick={() => controllerAccept('incoming')}>
            ✓ Accept Incoming
          </button>
          <button type="button" className="merge-branch__save-btn" onClick={() => controllerAccept('both')}>
            ⇉ Accept Both
          </button>
        </div>
        <button
          type="button"
          className="merge-branch__save-btn"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save resolved file'}
        </button>
      </div>
      <div className="merge-branch__conflict-editor-host">
        <Editor
          key={path}
          value={value}
          language="plaintext"
          theme="orbit-dark"
          onChange={(next) => {
            const nextText = next ?? '';
            setValue(nextText);
            valueRef.current = nextText;
          }}
          onMount={(editor, monaco) => {
            const controller = new ConflictController(editor, monaco);
            controllerRef.current = controller;
            controller.onChange = (text2) => {
              setValue(text2);
              valueRef.current = text2;
            };
            controller.update();
            // Ctrl+S saves + stages the resolution, like the Save button.
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
              saveRef.current();
            });
          }}
          options={{
            fontSize: 11,
            lineHeight: 18,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

