import { useMemo, useState } from 'react';
import { MoreHorizontal, RefreshCw, Archive } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { ChangedFileList } from './ChangedFileList';
import { CommitComposer } from './CommitComposer';
import { DiffPane } from './DiffPane';
import './WorkingChangesScreen.css';

export function WorkingChangesScreen() {
  const { repository, refresh, stash, busy } = useRepository();
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
          <span className="working-changes__scanned">Scanned just now</span>
          <button
            type="button"
            className="ghost-button"
            onClick={() => void refresh()}
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
          <button
            type="button"
            className="icon-button"
            aria-label="More working changes actions"
          >
            <MoreHorizontal size={14} />
          </button>
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
          <div className="working-changes__files-and-commit">
            <ChangedFileList
              files={files}
              selectedFileId={selectedFileId}
              onSelect={setSelectedFileId}
            />
            <CommitComposer />
          </div>
          {selectedFileId && <DiffPane selectedFileId={selectedFileId} />}
        </div>
      )}
    </div>
  );
}
