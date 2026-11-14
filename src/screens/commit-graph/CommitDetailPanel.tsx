import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  CircleX,
  ExternalLink,
  FileCode2,
  GitCommitVertical,
  GitMerge,
  ListTree,
  Maximize2,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Undo2,
  UnfoldVertical,
  X,
} from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { verifyCommitSig, getCommitDetail, getCommitFileDiff } from '../../lib/tauriClient';
import { relativeTime } from '../../lib/relativeTime';
import type { CommitDetail, CommitFileEntry, FileDiffContent } from '../../types/repository';
import { avatarTone } from './CommitGraphScreen';
import { ResizeHandle } from '../../app/ResizeHandle';
import { buildHunks } from './diffModel';
import './CommitDetailPanel.css';

interface CommitDetailPanelProps {
  oid: string;
  onClose: () => void;
  /** Opens the interactive rebase planner with this commit as the base. */
  onStartRebase: (oid: string) => void;
}

const TOTAL_UNITS = 5;

/** Five-block distribution strip: green units for additions, orange for deletions. */
function ChangeDistribution({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const green = total > 0 ? Math.max(1, Math.round((additions / total) * TOTAL_UNITS)) : 0;
  return (
    <span className="commit-detail__units" aria-hidden="true">
      {Array.from({ length: TOTAL_UNITS }, (_, i) => (
        <i key={i} className={i < green ? 'commit-detail__unit--add' : 'commit-detail__unit--del'} />
      ))}
    </span>
  );
}

export function CommitDetailPanel({ oid, onClose, onStartRebase }: CommitDetailPanelProps) {
  const { revertCommit, cherryPick, busy } = useRepository();
  const [diffRetry, setDiffRetry] = useState(0);
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<'overview' | 'changes'>('overview');
  const [selectedFile, setSelectedFile] = useState<CommitFileEntry | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [splitView, setSplitView] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Draggable panel height; null = the CSS default for the active tab.
  const [height, setHeight] = useState<number | null>(null);
  const [fileDiff, setFileDiff] = useState<{
    path: string;
    diff: FileDiffContent | null;
  } | null>(null);

  // Load commit metadata once per mount (parent remounts us via key={oid}).
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    getCommitDetail(oid)
      .then((result) => {
        if (!cancelled) setDetail(result);
        verifyCommitSig(result.oid).then((sig) => {
          if (!cancelled) setSignature(sig);
        }).catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [oid, retry]);

  // Load the selected file's diff.
  useEffect(() => {
    if (!selectedFile) return;
    let cancelled = false;
    getCommitFileDiff(oid, selectedFile.path)
      .then((diff) => {
        if (!cancelled) setFileDiff({ path: selectedFile.path, diff });
      })
      .catch(() => {
        if (!cancelled) setFileDiff({ path: selectedFile.path, diff: null });
      });
    return () => {
      cancelled = true;
    };
  }, [oid, selectedFile, diffRetry]);

  // ↑/↓ moves between changed files while the Changes tab is open.
  useEffect(() => {
    if (tab !== 'changes' || !detail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      setSelectedFile((current) => {
        const files = detail.files;
        if (files.length === 0) return current;
        const index = current ? files.findIndex((file) => file.path === current.path) : -1;
        const next =
          event.key === 'ArrowDown'
            ? Math.min(files.length - 1, index + 1)
            : Math.max(0, index - 1);
        return files[next] ?? current;
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tab, detail]);

  const totals = detail
    ? detail.files.reduce(
        (acc, file) => ({ add: acc.add + file.additions, del: acc.del + file.deletions }),
        { add: 0, del: 0 },
      )
    : null;

  const tone = detail ? avatarTone(detail.authorInitials) : null;

  const visibleFiles = useMemo(() => {
    if (!detail) return [];
    const q = fileFilter.trim().toLowerCase();
    if (!q) return detail.files;
    return detail.files.filter((file) => file.path.toLowerCase().includes(q));
  }, [detail, fileFilter]);

  const hunks = useMemo(() => {
    if (!fileDiff?.diff || fileDiff.path !== selectedFile?.path) return [];
    if (fileDiff.diff.binary || fileDiff.diff.tooLarge) return [];
    return buildHunks(fileDiff.diff.original ?? '', fileDiff.diff.modified ?? '');
  }, [fileDiff, selectedFile]);

  const selectedFileIndex = detail && selectedFile
    ? detail.files.findIndex((file) => file.path === selectedFile.path) + 1
    : 0;

  return (
    <aside
      className={`commit-detail${tab === 'changes' ? ' commit-detail--tall' : ''}`}
      style={height ? { height } : undefined}
      aria-label="Commit details"
    >
      <ResizeHandle
        orientation="h"
        label="Resize commit details"
        onDelta={(_dx, dy) =>
          setHeight((h) =>
            Math.min(760, Math.max(180, (h ?? (tab === 'changes' ? 460 : 280)) - dy)),
          )
        }
      />
      <nav className="commit-detail__tabs">
        <button
          type="button"
          className={`commit-detail__tab${tab === 'overview' ? ' commit-detail__tab--active' : ''}`}
          onClick={() => setTab('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          className={`commit-detail__tab${tab === 'changes' ? ' commit-detail__tab--active' : ''}`}
          onClick={() => setTab('changes')}
        >
          Changes
          {detail && (
            <span className="commit-detail__tab-count">{detail.files.length}</span>
          )}
        </button>

        <div className="commit-detail__actions">
          <button
            type="button"
            title="Cherry-pick this commit onto the current branch"
            onClick={() => void cherryPick(oid)}
            disabled={busy}
          >
            <CircleX size={13} strokeWidth={1.5} />
            Cherry-pick
          </button>
          <button
            type="button"
            title="Revert this commit"
            onClick={() => void revertCommit(oid)}
            disabled={busy}
          >
            <Undo2 size={13} strokeWidth={1.5} />
            Revert
          </button>
          <div className="commit-detail__more">
            <button
              type="button"
              aria-label="More actions"
              title="More actions"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={15} strokeWidth={1.5} />
            </button>
            {menuOpen && (
              <div className="commit-detail__menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onStartRebase(oid);
                  }}
                  disabled={busy}
                >
                  <ListTree size={13} strokeWidth={1.5} />
                  Rebase from here…
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="commit-detail__close"
            onClick={onClose}
            aria-label="Close commit details"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      </nav>

      {tab === 'overview' ? (
        <div className="commit-detail__overview">
          <div className="commit-detail__summary">
            {loadFailed ? (
              <div className="commit-detail__loading" role="alert">Failed to load commit<button className="outline-button" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>
            ) : !detail ? (
              <p className="commit-detail__loading">Loading…</p>
            ) : (
              <>
                <div className="commit-detail__identity">
                  {detail.isMerge ? (
                    <GitMerge size={15} strokeWidth={1.5} />
                  ) : (
                    <GitCommitVertical size={15} strokeWidth={1.5} />
                  )}
                  <span className="commit-detail__sha">{detail.shortOid}</span>
                  <span className="commit-detail__kind">
                    {detail.isMerge ? 'Merge commit' : 'Commit'}
                  </span>
                  {signature === 'good' && (
                    <span className="commit-detail__signed" title="GPG signature verified">
                      <ShieldCheck size={11} strokeWidth={1.5} /> Signed
                    </span>
                  )}
                  {signature === 'bad' && (
                    <span
                      className="commit-detail__signed commit-detail__signed--bad"
                      title="GPG signature invalid"
                    >
                      Invalid signature
                    </span>
                  )}
                </div>

                <p className="commit-detail__title">{detail.summary}</p>
                {detail.message !== detail.summary && (
                  <p className="commit-detail__message">{detail.message}</p>
                )}

                <div className="commit-detail__author">
                  <span
                    className="commit-detail__avatar"
                    style={tone ? { background: tone.bg, color: tone.fg } : undefined}
                  >
                    {detail.authorInitials}
                  </span>
                  <strong>{detail.authorName}</strong>
                  <span className="commit-detail__time">
                    {relativeTime(detail.timeSeconds)} ago
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="commit-detail__files">
            {detail && (
              <>
                <div className="commit-detail__files-head">
                  <span>{detail.files.length} files changed</span>
                  {totals && (
                    <>
                      <span className="commit-detail__add">+{totals.add}</span>
                      <span className="commit-detail__del">−{totals.del}</span>
                    </>
                  )}
                  <span className="commit-detail__files-note">Compared to first parent</span>
                </div>
                <div className="commit-detail__overview-files">
                  {detail.files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      className="commit-detail__overview-file"
                      onClick={() => {
                        setSelectedFile(file);
                        setTab('changes');
                      }}
                      title={file.path}
                    >
                      <FileCode2 size={13} strokeWidth={1.25} className="commit-detail__file-icon" />
                      <span className="commit-detail__overview-path">{file.path}</span>
                      <span className="commit-detail__file-add">+{file.additions}</span>
                      <span className="commit-detail__file-del">−{file.deletions}</span>
                      <ChangeDistribution additions={file.additions} deletions={file.deletions} />
                      <span className={`commit-detail__letter commit-detail__letter--${file.status === 'A' ? 'added' : file.status === 'D' ? 'deleted' : 'modified'}`}>
                        {file.status}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="commit-detail__controlbar">
            {detail?.isMerge ? (
              <GitMerge size={14} strokeWidth={1.5} />
            ) : (
              <GitCommitVertical size={14} strokeWidth={1.5} />
            )}
            <span className="commit-detail__controlbar-sha">{detail?.shortOid ?? '…'}</span>
            <span className="commit-detail__controlbar-summary">{detail?.summary ?? ''}</span>
            {detail && (
              <span className="commit-detail__controlbar-totals">
                <span>{detail.files.length} files changed</span>
                {totals && (
                  <>
                    <span className="commit-detail__add">+{totals.add}</span>
                    <span className="commit-detail__del">−{totals.del}</span>
                  </>
                )}
              </span>
            )}
            <div className="commit-detail__viewoptions">
              <span className="commit-detail__parent">
                Compared to first parent
                {detail?.parents?.[0] && (
                  <span className="commit-detail__parent-sha">{detail.parents[0]}</span>
                )}
              </span>
              <div className="commit-detail__viewswitch" role="group" aria-label="Diff view">
                <button
                  type="button"
                  className={`commit-detail__viewoption${!splitView ? ' commit-detail__viewoption--active' : ''}`}
                  onClick={() => setSplitView(false)}
                >
                  Unified
                </button>
                <button
                  type="button"
                  className={`commit-detail__viewoption${splitView ? ' commit-detail__viewoption--active' : ''}`}
                  onClick={() => setSplitView(true)}
                >
                  Split
                </button>
              </div>
              <Maximize2 size={14} strokeWidth={1.5} className="commit-detail__expand" />
            </div>
          </div>

          <div className="commit-detail__split">
            <div className="commit-detail__filenav">
              <div className="commit-detail__filenav-head">
                <span>Changed files</span>
                <ListTree size={14} strokeWidth={1.5} />
              </div>
              <div className="commit-detail__filenav-filter">
                <Search size={12} strokeWidth={1.5} />
                <input
                  placeholder="Filter files…"
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value)}
                  aria-label="Filter changed files"
                />
              </div>
              <div className="commit-detail__filenav-list">
                {visibleFiles.map((file) => {
                  const selected = selectedFile?.path === file.path;
                  return (
                    <button
                      key={file.path}
                      type="button"
                      className={`commit-detail__filenav-item${selected ? ' commit-detail__filenav-item--selected' : ''}`}
                      onClick={() => setSelectedFile(file)}
                      title={file.path}
                    >
                      <FileCode2 size={14} strokeWidth={1.25} />
                      <span className="commit-detail__filenav-info">
                        <span className="commit-detail__filenav-name">{file.name}</span>
                        <span className="commit-detail__filenav-meta">
                          <span className="commit-detail__filenav-dir">{file.directory}/</span>
                          <span className="commit-detail__filenav-add">+{file.additions}</span>
                          <span className="commit-detail__filenav-del">−{file.deletions}</span>
                        </span>
                      </span>
                      <span className={`commit-detail__letter commit-detail__letter--${file.status === 'A' ? 'added' : file.status === 'D' ? 'deleted' : 'modified'}`}>
                        {file.status}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="commit-detail__filenav-hint">
                <span className="commit-detail__hint-keys">↑ ↓</span>
                <span>Navigate changed files</span>
              </div>
            </div>

            <div className="commit-detail__codediff">
              {selectedFile ? (
                <>
                  <div className="commit-detail__diffbar">
                    <FileCode2 size={14} strokeWidth={1.25} />
                    <span className="commit-detail__diffbar-path">{selectedFile.path}</span>
                    <span className="commit-detail__add">+{selectedFile.additions}</span>
                    <span className="commit-detail__del">−{selectedFile.deletions}</span>
                    <div className="commit-detail__diffbar-actions">
                      <span>
                        {selectedFileIndex} of {detail?.files.length ?? 0} files
                      </span>
                      <button
                        type="button"
                        aria-label="Previous file"
                        onClick={() => {
                          if (!detail || detail.files.length === 0) return;
                          const index = detail.files.findIndex((f) => f.path === selectedFile.path);
                          setSelectedFile(detail.files[(index - 1 + detail.files.length) % detail.files.length]);
                        }}
                      >
                        <ChevronUp size={12} strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        aria-label="Next file"
                        onClick={() => {
                          if (!detail || detail.files.length === 0) return;
                          const index = detail.files.findIndex((f) => f.path === selectedFile.path);
                          setSelectedFile(detail.files[(index + 1) % detail.files.length]);
                        }}
                      >
                        <ChevronDown size={12} strokeWidth={1.5} />
                      </button>
                      <button type="button" className="commit-detail__open-file">
                        Open file
                        <ExternalLink size={12} strokeWidth={1.5} />
                      </button>
                      <MoreHorizontal size={15} strokeWidth={1.5} />
                    </div>
                  </div>

                  <div className="commit-detail__diffscroll">
                    {!fileDiff || fileDiff.path !== selectedFile.path ? (
                      <div className="commit-detail__diff-notice">Loading diff…</div>
                    ) : fileDiff.diff === null ? (<div className="commit-detail__diff-notice" role="alert">Could not load diff.<button className="outline-button" onClick={() => { setFileDiff(null); setDiffRetry((n) => n + 1); }}>Try again</button></div>) : fileDiff.diff?.binary ? (
                      <div className="commit-detail__diff-notice">Binary file</div>
                    ) : fileDiff.diff?.tooLarge ? (
                      <div className="commit-detail__diff-notice">File too large to display</div>
                    ) : hunks.length === 0 ? (
                      <div className="commit-detail__diff-notice">No changes</div>
                    ) : (
                      hunks.map((hunk, hunkIndex) => (
                        <div key={hunk.header}>
                          <div className="commit-detail__hunkhead">
                            <UnfoldVertical size={12} strokeWidth={1.5} />
                            <span className="commit-detail__hunkrange">{hunk.header}</span>
                            {hunk.section && (
                              <span className="commit-detail__hunksection">{hunk.section}</span>
                            )}
                            <span className="commit-detail__hunkindex">
                              Hunk {hunkIndex + 1} of {hunks.length}
                            </span>
                          </div>
                          {splitView ? (
                            <div className="commit-detail__diffrows commit-detail__diffrows--split">
                              <div className="commit-detail__splitcol">
                                {hunk.rows
                                  .filter((row) => row.type !== 'add')
                                  .map((row, index) => (
                                    <DiffRowView key={`${row.oldLine}-${index}`} row={row} side="old" />
                                  ))}
                              </div>
                              <div className="commit-detail__splitcol">
                                {hunk.rows
                                  .filter((row) => row.type !== 'del')
                                  .map((row, index) => (
                                    <DiffRowView key={`${row.newLine}-${index}`} row={row} side="new" />
                                  ))}
                              </div>
                            </div>
                          ) : (
                            <div className="commit-detail__diffrows">
                              {hunk.rows.map((row, index) => (
                                <DiffRowView key={`${row.type}-${row.oldLine ?? row.newLine}-${index}`} row={row} />
                              ))}
                            </div>
                          )}
                          {hunkIndex < hunks.length - 1 && (
                            <div className="commit-detail__nexthunkrow">
                              <span className="commit-detail__nexthunkrow-label">
                                <ChevronsDown size={12} strokeWidth={1.5} />
                                Show next hunk
                              </span>
                              <span className="commit-detail__nexthunkrow-range">
                                {hunks[hunkIndex + 1].header}
                              </span>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div className="commit-detail__diff-notice">Select a file to view its diff</div>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

function DiffRowView({ row, side }: { row: { type: string; oldLine?: number; newLine?: number; text: string }; side?: 'old' | 'new' }) {
  if (side === 'old' && row.type === 'add') return null;
  if (side === 'new' && row.type === 'del') return null;
  const typeClass = row.type === 'add' ? 'commit-detail__drow--add' : row.type === 'del' ? 'commit-detail__drow--del' : '';
  return (
    <div className={`commit-detail__drow ${typeClass}`}>
      <span className="commit-detail__dnum commit-detail__dnum--old">
        {row.type === 'add' ? '' : row.oldLine}
      </span>
      <span className="commit-detail__dnum commit-detail__dnum--new">
        {row.type === 'del' ? '' : row.newLine}
      </span>
      <span className="commit-detail__dsign">
        {row.type === 'del' ? '−' : row.type === 'add' ? '+' : ''}
      </span>
      <code className="commit-detail__dcode">{row.text || ' '}</code>
    </div>
  );
}
