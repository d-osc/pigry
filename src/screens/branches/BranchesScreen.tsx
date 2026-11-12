/** Branches screen — every local and remote branch on the left (with
 * local/cloud symbols + search), the selected branch's commits on the right
 * (with commit search, expandable detail and per-file compares).
 * The panes are split-resizable, only the lists scroll (search stays put),
 * and rows carry branch actions: rename, delete (local/cloud), download a
 * cloud branch to local, and "create branch from" any commit or branch. */
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { DiffEditor } from '@monaco-editor/react';
import {
  Check,
  Cloud,
  Download,
  GitBranch,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  getBranchCommits,
  getCommitDetail,
  readFileAtCommit,
  renameBranch,
} from '../../lib/tauriClient';
import type {
  CommitDetail,
  CommitFileEntry,
  CommitRow,
  WorktreeFileContent,
} from '../../types/repository';
import { relativeTime } from '../../lib/relativeTime';
import { languageForPath } from '../../lib/ghData';
import '../../editor/monacoSetup';
import './BranchesScreen.css';

interface BranchEntry {
  /** Ref name to walk ("main", "origin/main"). */
  ref: string;
  /** Display name without the remote prefix for local entries. */
  name: string;
  kind: 'local' | 'remote';
  remote: string | null;
  isHead: boolean;
}

/** Modal dialog the row actions open: rename / delete / create-from. */
interface BranchDialog {
  kind: 'rename' | 'delete' | 'create';
  entry: BranchEntry | null;
  /** Create-from source ref (commit oid or branch ref). */
  fromRef?: string;
  /** Human label of the create-from source for the dialog title. */
  fromLabel?: string;
}

const SPLIT_KEY = 'pigry:branches-split';
const SPLIT_MIN = 220;
const SPLIT_MAX = 620;

function loadSplitWidth(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    if (raw) {
      const width = Number(JSON.parse(raw));
      if (Number.isFinite(width) && width >= SPLIT_MIN && width <= SPLIT_MAX) return width;
    }
  } catch {
    // corrupt cache — default
  }
  return 300;
}

export function BranchesScreen() {
  const { repository, refresh, notify } = useRepository();
  const [branchQuery, setBranchQuery] = useState('');
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [rows, setRows] = useState<CommitRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingRows, setLoadingRows] = useState(true);
  const [commitQuery, setCommitQuery] = useState('');
  const [selectedCommit, setSelectedCommit] = useState<CommitRow | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{
    before: string;
    after: string;
    language: string;
  } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [splitView, setSplitView] = useState(true);

  /** Pane splitter width (px) — persisted per install. */
  const [splitWidth, setSplitWidth] = useState(loadSplitWidth);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_KEY, JSON.stringify(splitWidth));
    } catch {
      // storage full — skip persist
    }
  }, [splitWidth]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = splitWidth;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      const w = Math.round(
        Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, startW + ev.clientX - startX)),
      );
      setSplitWidth(w);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      setResizing(false);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  /** Row-action dialog (rename / delete / create-from). */
  const [dialog, setDialog] = useState<BranchDialog | null>(null);
  const [dialogName, setDialogName] = useState('');
  const [dialogCheckout, setDialogCheckout] = useState(true);
  const [dialogBusy, setDialogBusy] = useState(false);

  const entries: BranchEntry[] = useMemo(() => {
    const localBranches = repository?.branches ?? [];
    const remoteGroups = repository?.remotes ?? [];
    const list: BranchEntry[] = localBranches.map((branch) => ({
      ref: branch.name,
      name: branch.name,
      kind: 'local' as const,
      remote: null,
      isHead: branch.isHead,
    }));
    for (const group of remoteGroups) {
      for (const name of group.branches) {
        if (name === 'HEAD') continue;
        list.push({
          ref: `${group.remote}/${name}`,
          name,
          kind: 'remote' as const,
          remote: group.remote,
          isHead: false,
        });
      }
    }
    return list;
  }, [repository]);

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) => entry.ref.toLowerCase().includes(query),
    );
  }, [entries, branchQuery]);

  /** How many branch commits are shown before "Show more". */
  const [visibleCount, setVisibleCount] = useState(100);
  const filteredRows = useMemo(() => {
    const query = commitQuery.trim().toLowerCase();
    if (!query) return rows.slice(0, visibleCount);
    return rows.filter(
      (row) =>
        row.oid.toLowerCase().includes(query) ||
        row.shortOid.toLowerCase().includes(query) ||
        row.summary.toLowerCase().includes(query),
    );
  }, [rows, commitQuery, visibleCount]);

  /** Effective selection: HEAD's branch until the user picks one — derived,
   * so no auto-select effect is needed. */
  const effectiveRef = useMemo(
    () =>
      selectedRef ??
      entries.find((entry) => entry.isHead)?.ref ??
      entries[0]?.ref ??
      null,
    [selectedRef, entries],
  );

  const selectBranch = (ref: string) => {
    setSelectedRef(ref);
    setVisibleCount(100);
  };

  // Load the selected branch's commits (and reload on repo changes).
  const headOid = repository?.headOid ?? '';
  useEffect(() => {
    if (!effectiveRef) return;
    let cancelled = false;
    getBranchCommits(effectiveRef)
      .then((history) => {
        if (cancelled) return;
        setRows(history.commits);
        setTotal(history.total);
        setSelectedCommit(null);
        setDetail(null);
        setOpenFile(null);
        setFileContent(null);
        setLoadingRows(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setLoadingRows(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveRef, headOid]);

  const selectCommit = async (row: CommitRow) => {
    if (selectedCommit?.oid === row.oid) {
      setSelectedCommit(null);
      setDetail(null);
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setSelectedCommit(row);
    setDetail(null);
    setOpenFile(null);
    setFileContent(null);
    setLoadingDetail(true);
    try {
      setDetail(await getCommitDetail(row.oid));
    } catch {
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const openCompare = async (oid: string, parentOid: string | null, filePath: string) => {
    const key = `${oid}:${filePath}`;
    if (openFile === key) {
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setOpenFile(key);
    setFileContent(null);
    setLoadingFile(true);
    try {
      const [before, after]: [WorktreeFileContent | null, WorktreeFileContent] =
        await Promise.all([
          parentOid ? readFileAtCommit(filePath, parentOid) : null,
          readFileAtCommit(filePath, oid),
        ]);
      setFileContent({
        before: before?.content ?? '',
        after: after?.content ?? '',
        language: after?.language || before?.language || languageForPath(filePath),
      });
    } catch {
      setFileContent(null);
    } finally {
      setLoadingFile(false);
    }
  };

  const doCheckout = (entry: BranchEntry) => {
    if (entry.kind !== 'local' || entry.isHead) return;
    checkoutBranch(entry.name)
      .then(() => {
        notify(`Checked out ${entry.name}`, 'success');
        refresh();
      })
      .catch((error) => {
        notify(error instanceof Error ? error.message : String(error), 'error');
      });
  };

  /** Downloads a cloud branch: local tracking branch from origin + checkout. */
  const doDownload = (entry: BranchEntry) => {
    if (entry.kind !== 'remote' || !entry.remote) return;
    checkoutRemoteBranch(entry.remote, entry.name)
      .then(() => {
        notify(`Downloaded ${entry.remote}/${entry.name} to local`, 'success');
        refresh();
      })
      .catch((error) => {
        notify(error instanceof Error ? error.message : String(error), 'error');
      });
  };

  const openDialog = (next: BranchDialog) => {
    setDialogName(
      next.kind === 'rename' && next.entry ? next.entry.name : '',
    );
    setDialogCheckout(true);
    setDialogBusy(false);
    setDialog(next);
  };

  const runDialog = () => {
    if (!dialog || dialogBusy) return;
    const name = dialogName.trim();
    if (dialog.kind === 'rename') {
      if (!dialog.entry || !name || name === dialog.entry.name) return;
      setDialogBusy(true);
      renameBranch(dialog.entry.name, name)
        .then(() => {
          notify(`Renamed ${dialog.entry!.name} → ${name}`, 'success');
          setDialog(null);
          refresh();
        })
        .catch((error) => {
          setDialogBusy(false);
          notify(error instanceof Error ? error.message : String(error), 'error');
        });
      return;
    }
    if (dialog.kind === 'delete') {
      if (!dialog.entry) return;
      setDialogBusy(true);
      const done = () => {
        notify(`Deleted ${dialog.entry!.ref}`, 'success');
        setDialog(null);
        refresh();
      };
      const fail = (error: unknown) => {
        setDialogBusy(false);
        notify(error instanceof Error ? error.message : String(error), 'error');
      };
      if (dialog.entry.kind === 'local') {
        deleteBranch(dialog.entry.name).then(done).catch(fail);
      } else if (dialog.entry.remote) {
        deleteRemoteBranch(dialog.entry.remote, dialog.entry.name).then(done).catch(fail);
      }
      return;
    }
    // create-from
    if (!name || !dialog.fromRef) return;
    setDialogBusy(true);
    createBranch(name, dialogCheckout, dialog.fromRef)
      .then(() => {
        notify(`Created ${name}${dialogCheckout ? ' (checked out)' : ''}`, 'success');
        setDialog(null);
        refresh();
      })
      .catch((error) => {
        setDialogBusy(false);
        notify(error instanceof Error ? error.message : String(error), 'error');
      });
  };

  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runDialog();
    } else if (e.key === 'Escape') {
      setDialog(null);
    }
  };

  return (
    <div
      className={`branches-screen${resizing ? ' is-resizing' : ''}`}
      style={{ gridTemplateColumns: `${splitWidth}px 6px minmax(0, 1fr)` }}
    >
      <aside className="branches__left">
        <h3 className="branches__pane-title">Branches</h3>
        <input
          type="text"
          className="branches__search"
          placeholder="Search branches…"
          value={branchQuery}
          onChange={(event) => setBranchQuery(event.target.value)}
        />
        <ul className="branches__list">
          {filteredBranches.map((entry) => (
            <li key={entry.ref} className="branches__item">
              <button
                type="button"
                className={`branches__branch${effectiveRef === entry.ref ? ' is-selected' : ''}`}
                onClick={() => selectBranch(entry.ref)}
                title={entry.ref}
              >
                {entry.kind === 'local' ? (
                  <GitBranch size={12} strokeWidth={1.5} className="branches__icon branches__icon--local" />
                ) : (
                  <Cloud size={12} strokeWidth={1.5} className="branches__icon branches__icon--remote" />
                )}
                <span className="branches__branch-name">{entry.name}</span>
                {entry.kind === 'remote' && (
                  <span className="branches__remote-tag">{entry.remote}</span>
                )}
                {entry.isHead && (
                  <span className="branches__head-tag">
                    <Check size={11} strokeWidth={2} />
                    HEAD
                  </span>
                )}
              </button>
              <span className="branches__actions">
                {entry.kind === 'local' && !entry.isHead && (
                  <button
                    type="button"
                    className="branches__checkout-btn"
                    title={`Checkout ${entry.name}`}
                    onClick={() => doCheckout(entry)}
                  >
                    Checkout
                  </button>
                )}
                {entry.kind === 'remote' && (
                  <button
                    type="button"
                    className="branches__act"
                    title={`Download ${entry.remote}/${entry.name} to local and checkout`}
                    onClick={() => doDownload(entry)}
                  >
                    <Download size={13} strokeWidth={1.6} />
                  </button>
                )}
                {entry.kind === 'local' && !entry.isHead && (
                  <button
                    type="button"
                    className="branches__act"
                    title={`Rename ${entry.name}`}
                    onClick={() => openDialog({ kind: 'rename', entry })}
                  >
                    <Pencil size={13} strokeWidth={1.6} />
                  </button>
                )}
                {!entry.isHead && (
                  <button
                    type="button"
                    className="branches__act branches__act--danger"
                    title={
                      entry.kind === 'local'
                        ? `Delete ${entry.name}`
                        : `Delete ${entry.remote}/${entry.name} on the remote`
                    }
                    onClick={() => openDialog({ kind: 'delete', entry })}
                  >
                    <Trash2 size={13} strokeWidth={1.6} />
                  </button>
                )}
              </span>
            </li>
          ))}
          {filteredBranches.length === 0 && (
            <li className="branches__empty">No branches match.</li>
          )}
        </ul>
      </aside>

      <div
        className="branches__split"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize branches pane"
        onPointerDown={startResize}
        onDoubleClick={() => setSplitWidth(300)}
      />

      <section className="branches__right">
        <h3 className="branches__pane-title">
          Commits — <span className="branches__selected-ref">{effectiveRef ?? '…'}</span>
          {total > 0 && <span className="branches__count">({total})</span>}
          <button
            type="button"
            className="branches__new-branch"
            title="Create a branch from the selected branch"
            disabled={!effectiveRef}
            onClick={() =>
              openDialog({
                kind: 'create',
                entry: null,
                fromRef: effectiveRef ?? undefined,
                fromLabel: effectiveRef ?? '',
              })
            }
          >
            <Plus size={13} strokeWidth={1.8} />
            New branch
          </button>
        </h3>
        <input
          type="text"
          className="branches__search"
          placeholder="Search commits — sha or message"
          value={commitQuery}
          onChange={(event) => {
              setCommitQuery(event.target.value);
              setVisibleCount(100);
            }}
        />
        <ul className="branches__rows">
          {loadingRows && <li className="branches__empty">Loading commits…</li>}
          {!loadingRows && filteredRows.map((row) => {
            const isSelected = selectedCommit?.oid === row.oid;
            return (
              <li key={row.oid} className="branches__row-item">
                <div className="branches__row-wrap">
                  <button
                    type="button"
                    className={`branches__row${isSelected ? ' is-selected' : ''}`}
                    onClick={() => void selectCommit(row)}
                  >
                    <span className="branches__row-sha">{row.shortOid}</span>
                    <span className="branches__row-summary">{row.summary}</span>
                    <span className="branches__row-meta">
                      {row.authorName} · {relativeTime(row.timeSeconds)}
                    </span>
                  </button>
                  <span className="branches__actions">
                    <button
                      type="button"
                      className="branches__act"
                      title={`Create branch from ${row.shortOid}`}
                      onClick={() =>
                        openDialog({
                          kind: 'create',
                          entry: null,
                          fromRef: row.oid,
                          fromLabel: `${row.shortOid} ${row.summary}`.slice(0, 60),
                        })
                      }
                    >
                      <GitBranch size={13} strokeWidth={1.6} />
                    </button>
                  </span>
                </div>
                {isSelected && (
                  <div className="branches__detail">
                    {loadingDetail && <p className="branches__empty">Loading commit…</p>}
                    {detail && (
                      <>
                        <div className="branches__detail-head">
                          <div>
                            <span className="branches__detail-sha">{detail.shortOid}</span>
                            <span className="branches__detail-summary">{detail.summary}</span>
                            <div className="branches__detail-meta">
                              {detail.authorName} · {relativeTime(detail.timeSeconds)}
                              {detail.isMerge && ' · merge commit'}
                            </div>
                          </div>
                        </div>
                        {detail.message !== detail.summary && (
                          <pre className="branches__detail-body">{detail.message}</pre>
                        )}
                        <h4 className="branches__section-title">
                          Files ({detail.files.length})
                        </h4>
                        <ul className="branches__files">
                          {detail.files.map((file: CommitFileEntry) => {
                            const parentOid = detail.parents[0] ?? null;
                            const fileKey = `${detail.oid}:${file.path}`;
                            const fileOpen = openFile === fileKey;
                            return (
                              <li key={`${file.path}:${file.status}`} className="branches__file">
                                <button
                                  type="button"
                                  className="branches__file-row"
                                  title={`Compare ${file.path} (parent vs commit)`}
                                  onClick={() =>
                                    void openCompare(detail.oid, parentOid, file.path)
                                  }
                                >
                                  <span
                                    className={`branches__file-status branches__file-status--${file.status}`}
                                  >
                                    {file.status}
                                  </span>
                                  <span className="branches__file-path">{file.path}</span>
                                  <span className="branches__file-stats">
                                    <span className="stats-add">+{file.additions}</span>
                                    <span className="stats-del">−{file.deletions}</span>
                                  </span>
                                </button>
                                {fileOpen && (
                                  <>
                                    {loadingFile && (
                                      <p className="branches__empty">Loading versions…</p>
                                    )}
                                    <div className="branches__file-view">
                                      <div className="branches__file-view-labels">
                                        <span>
                                          BEFORE — {parentOid?.slice(0, 7) ?? '(new file)'}
                                        </span>
                                        <span>COMMIT — {detail.shortOid}</span>
                                        <div
                                          className="branches__view-mode"
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
                                        key={fileKey}
                                        original={fileContent?.before ?? ''}
                                        modified={fileContent?.after ?? ''}
                                        language={fileContent?.language ?? 'plaintext'}
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
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {!loadingRows && filteredRows.length === 0 && rows.length > 0 && (
            <li className="branches__empty">No commits match the search.</li>
          )}
          {!loadingRows && !commitQuery.trim() && rows.length > visibleCount && (
            <li className="branches__show-more-row">
              <button
                type="button"
                className="branches__show-more"
                onClick={() => setVisibleCount((count) => count + 100)}
              >
                Show more — {rows.length - visibleCount} older commits
              </button>
            </li>
          )}
        </ul>
      </section>

      {dialog && (
        <div
          className="bdlg__backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDialog(null);
          }}
        >
          <div className="bdlg" role="dialog" aria-modal="true" onKeyDown={onDialogKeyDown}>
            <button
              type="button"
              className="bdlg__close"
              aria-label="Close"
              onClick={() => setDialog(null)}
            >
              <X size={14} strokeWidth={1.6} />
            </button>
            {dialog.kind === 'rename' && dialog.entry && (
              <>
                <h4 className="bdlg__title">Rename branch</h4>
                <p className="bdlg__hint">Renaming local branch “{dialog.entry.name}”.</p>
                <input
                  autoFocus
                  type="text"
                  className="bdlg__input"
                  value={dialogName}
                  placeholder="new branch name"
                  onChange={(e) => setDialogName(e.target.value)}
                />
                <div className="bdlg__foot">
                  <button type="button" className="bdlg__btn" onClick={() => setDialog(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="bdlg__btn bdlg__btn--accent"
                    disabled={dialogBusy || !dialogName.trim() || dialogName.trim() === dialog.entry.name}
                    onClick={runDialog}
                  >
                    Rename
                  </button>
                </div>
              </>
            )}
            {dialog.kind === 'delete' && dialog.entry && (
              <>
                <h4 className="bdlg__title">
                  Delete {dialog.entry.kind === 'local' ? 'branch' : 'cloud branch'}?
                </h4>
                {dialog.entry.kind === 'local' ? (
                  <p className="bdlg__hint">
                    “{dialog.entry.name}” will be deleted locally. Only merged branches can be
                    deleted.
                  </p>
                ) : (
                  <p className="bdlg__hint bdlg__hint--danger">
                    “{dialog.entry.remote}/{dialog.entry.name}” will be deleted on the remote
                    (cloud) — this cannot be undone locally afterwards.
                  </p>
                )}
                <div className="bdlg__foot">
                  <button type="button" className="bdlg__btn" onClick={() => setDialog(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="bdlg__btn bdlg__btn--danger"
                    disabled={dialogBusy}
                    onClick={runDialog}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
            {dialog.kind === 'create' && (
              <>
                <h4 className="bdlg__title">Create branch</h4>
                <p className="bdlg__hint">
                  From <span className="bdlg__ref">{dialog.fromLabel ?? dialog.fromRef}</span>
                </p>
                <input
                  autoFocus
                  type="text"
                  className="bdlg__input"
                  value={dialogName}
                  placeholder="branch name"
                  onChange={(e) => setDialogName(e.target.value)}
                />
                <label className="bdlg__check">
                  <input
                    type="checkbox"
                    checked={dialogCheckout}
                    onChange={(e) => setDialogCheckout(e.target.checked)}
                  />
                  Checkout the new branch
                </label>
                <div className="bdlg__foot">
                  <button type="button" className="bdlg__btn" onClick={() => setDialog(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="bdlg__btn bdlg__btn--accent"
                    disabled={dialogBusy || !dialogName.trim()}
                    onClick={runDialog}
                  >
                    Create
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
