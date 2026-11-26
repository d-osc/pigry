import { History, RotateCcw } from 'lucide-react';
import { useFileHistory } from '../../hooks/useFileHistory';
import { relativeTime } from '../../lib/relativeTime';
import { canRestoreFromCommit, restoreButtonTitle } from '../../lib/fileRestore';
import type { FileCommitEntry } from '../../types/repository';
import './FileHistoryPanel.css';

interface FileHistoryPanelProps {
  path: string;
  selectedOid: string | null;
  onSelect: (oid: string) => void;
  /** Walk history from this ref instead of HEAD (e.g. a PR head branch). */
  refName?: string | null;
  /** Shows a Restore button per commit that puts the working file back to
   * that version. Left out where the file is read-only (PR review). */
  onRestore?: (commit: FileCommitEntry) => void;
  /** A restore is running: every Restore button waits. */
  restoring?: boolean;
}

export function FileHistoryPanel({
  path,
  selectedOid,
  onSelect,
  refName,
  onRestore,
  restoring = false,
}: FileHistoryPanelProps) {
  const { commits, loading, error, retry } = useFileHistory(path, refName ?? null);
  const fileName = path.split('/').pop() ?? path;

  return (
    <aside className="file-history">
      <header className="file-history__head">
        <History size={12} />
        <span className="file-history__title">File history</span>
        <span className="file-history__count">
          {commits ? `${fileName} · ${commits.length} commit${commits.length === 1 ? '' : 's'}` : ''}
        </span>
      </header>
      <div className="file-history__list">
        {error ? (<div className="file-history__empty" role="alert">{error}<button className="outline-button" onClick={retry}>Try again</button></div>) : loading ? (
          <div className="file-history__empty">Loading…</div>
        ) : !commits || commits.length === 0 ? (
          <div className="file-history__empty">No commits touch this file</div>
        ) : (
          commits.map((commit, index) => (
            <div
              key={commit.oid}
              className={`file-history__row${
                selectedOid === commit.oid ? ' file-history__row--selected' : ''
              }${onRestore ? ' file-history__row--restorable' : ''}`}
              data-oid={commit.oid}
            >
              <button
                type="button"
                className="file-history__pick"
                aria-pressed={selectedOid === commit.oid}
                onClick={() => onSelect(commit.oid)}
              >
                <div className="file-history__row-head">
                  <span className="file-history__sha">{commit.shortOid}</span>
                  {index === 0 && (
                    <span className="file-history__latest">Latest commit</span>
                  )}
                  {commit.deleted && <span className="file-history__tag">Deleted</span>}
                  {commit.path && commit.path !== path && (
                    <span className="file-history__tag" title={commit.path}>
                      {commit.path.split('/').pop()}
                    </span>
                  )}
                  <span className="file-history__time">
                    {relativeTime(commit.timeSeconds)}
                  </span>
                </div>
                <p className="file-history__summary">{commit.summary}</p>
                <p className="file-history__author">
                  <span className="file-history__avatar">{commit.authorInitials}</span>
                  {commit.authorName}
                </p>
              </button>
              {onRestore && (
                <button
                  type="button"
                  className="file-history__restore"
                  aria-label={`Restore ${fileName} from ${commit.shortOid}`}
                  title={restoreButtonTitle(path, commit)}
                  disabled={restoring || !canRestoreFromCommit(commit)}
                  onClick={() => onRestore(commit)}
                >
                  <RotateCcw size={11} strokeWidth={1.75} />
                  Restore
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
