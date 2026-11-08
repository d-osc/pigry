import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, FolderUp, MoreHorizontal, RefreshCw, Archive, RotateCcw, SquareStack } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { ResizeHandle } from '../../app/ResizeHandle';
import { relativeTime } from '../../lib/relativeTime';
import { ChangedFileList } from './ChangedFileList';
import { CommitComposer } from './CommitComposer';
import { DiffPane } from './DiffPane';
import './WorkingChangesScreen.css';

export function WorkingChangesScreen() {
  const { repository, refresh, stash, stage, unstage, discard, busy, notify } = useRepository();
  const [listWidth, setListWidth] = useState(360);
  // Real scan timestamp — starts now, updates on every Refresh.
  const [lastScan, setLastScan] = useState(() => Date.now());
  const [, setTick] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Keep the "Scanned X ago" text fresh.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // Clicking anywhere outside the actions menu closes it (capture phase).
  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [menuOpen]);

  const files = useMemo(() => repository?.files ?? [], [repository]);
  const [requestedFileId, setSelectedFileId] = useState<string | null>(null);

  // Fall back to the first file when the selection no longer exists.
  const selectedFileId = files.some((f) => f.id === requestedFileId)
    ? requestedFileId
    : (files[0]?.id ?? null);

  const totals = useMemo(
    () => ({
      staged: files.filter((f) => f.staged).length,
      unstaged: files.filter((f) => !f.staged).length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    }),
    [files],
  );

  const handleRefresh = async () => {
    await refresh();
    setLastScan(Date.now());
  };

  const stageAll = async () => {
    const paths = [...new Set(files.filter((file) => !file.staged).map((file) => file.path))];
    if (paths.length === 0) return;
    await stage(paths);
    setMenuOpen(false);
  };

  const unstageAll = async () => {
    const paths = [...new Set(files.filter((file) => file.staged).map((file) => file.path))];
    if (paths.length === 0) return;
    await unstage(paths);
    setMenuOpen(false);
  };

  const discardAll = async () => {
    const paths = [...new Set(files.filter((file) => !file.staged).map((file) => file.path))];
    if (paths.length === 0) return;
    if (!window.confirm(`Discard changes in ${paths.length} file(s)? This cannot be undone.`)) return;
    for (const path of paths) {
      await discard(path);
    }
    notify(`Discarded ${paths.length} file${paths.length === 1 ? '' : 's'}`, 'success');
    setMenuOpen(false);
  };

  const copySummary = async () => {
    const text = `${repository?.currentBranch ?? ''}: ${totals.staged} staged / ${totals.unstaged} unstaged (+${totals.additions} −${totals.deletions})`;
    try {
      await navigator.clipboard.writeText(text);
      notify('Summary copied to clipboard', 'success');
    } catch {
      notify('Could not access the clipboard', 'error');
    }
    setMenuOpen(false);
  };

  return (
    <div className="working-changes">
      <header className="working-changes__header">
        <div className="working-changes__title-row">
          <h1 className="working-changes__title">Working changes</h1>
          <span className="working-changes__subtitle">
            {files.length === 0
              ? 'Clean'
              : `${files.length} file${files.length === 1 ? '' : 's'} changed`}
          </span>
          <span className="working-changes__scanned">
            Scanned {relativeTime(Math.floor(lastScan / 1000))}
          </span>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void handleRefresh()}
            disabled={busy}
          >
            <RefreshCw size={12} />
            Refresh
          </button>
          <button
            type="button"
            className="outline-button"
            onClick={() => void stash()}
            disabled={busy || files.length === 0}
          >
            <Archive size={12} />
            Stash changes
          </button>
          <div className="working-changes__more" ref={menuRef}>
            <button
              type="button"
              className="icon-button"
              aria-label="More working changes actions"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={14} />
            </button>
            {menuOpen && (
              <div className="working-changes__menu" role="menu" onClick={() => setMenuOpen(false)}>
                <button
                  type="button"
                  role="menuitem"
                  className="working-changes__menu-item"
                  onClick={() => void stageAll()}
                  disabled={totals.unstaged === 0}
                >
                  <FolderUp size={12} strokeWidth={1.5} />
                  Stage all files
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="working-changes__menu-item"
                  onClick={() => void unstageAll()}
                  disabled={totals.staged === 0}
                >
                  <SquareStack size={12} strokeWidth={1.5} />
                  Unstage all files
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="working-changes__menu-item"
                  onClick={() => void discardAll()}
                  disabled={totals.unstaged === 0}
                >
                  <RotateCcw size={12} strokeWidth={1.5} />
                  Discard all changes…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="working-changes__menu-item"
                  onClick={() => void copySummary()}
                >
                  <Copy size={12} strokeWidth={1.5} />
                  Copy status summary
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="working-changes__context-row">
          <span className="branch-pill">{repository?.currentBranch ?? '—'}</span>
          <span className="working-changes__context">
            Local changes against HEAD
            <span className="working-changes__dot">·</span>
            {totals.staged} staged / {totals.unstaged} unstaged
          </span>
          <span className="diffstat">
            <span className="diffstat__additions">+{totals.additions}</span>
            <span className="diffstat__deletions">−{totals.deletions}</span>
          </span>
        </div>
      </header>

      {files.length === 0 ? (
        <div className="working-changes__empty">
          <p className="working-changes__empty-title">No uncommitted changes</p>
          <p className="working-changes__empty-note">
            Everything is committed. Edit files to see them here.
          </p>
        </div>
      ) : (
        <div className="working-changes__review">
          <div className="working-changes__files-and-commit" style={{ width: listWidth }}>
            <ChangedFileList
              files={files}
              selectedFileId={selectedFileId}
              onSelect={setSelectedFileId}
            />
            <CommitComposer />
          </div>
          <ResizeHandle
            orientation="v"
            label="Resize file list"
            onDelta={(dx) => setListWidth((w) => Math.min(560, Math.max(260, w + dx)))}
          />
          {selectedFileId && <DiffPane selectedFileId={selectedFileId} />}
        </div>
      )}
    </div>
  );
}
