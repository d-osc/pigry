import { History } from 'lucide-react';
import { useFileHistory } from '../../hooks/useFileHistory';
import { relativeTime } from '../../lib/relativeTime';
import './FileHistoryPanel.css';

interface FileHistoryPanelProps {
  path: string;
  selectedOid: string | null;
  onSelect: (oid: string) => void;
  /** Walk history from this ref instead of HEAD (e.g. a PR head branch). */
  refName?: string | null;
}

export function FileHistoryPanel({
  path,
  selectedOid,
  onSelect,
  refName,
}: FileHistoryPanelProps) {
  const { commits, loading } = useFileHistory(path, refName ?? null);
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
        {loading ? (
          <div className="file-history__empty">Loading…</div>
        ) : !commits || commits.length === 0 ? (
          <div className="file-history__empty">No commits touch this file</div>
        ) : (
          commits.map((commit, index) => (
            <button
              key={commit.oid}
              type="button"
              className={`file-history__row${
                selectedOid === commit.oid ? ' file-history__row--selected' : ''
              }`}
              onClick={() => onSelect(commit.oid)}
            >
              <div className="file-history__row-head">
                <span className="file-history__sha">{commit.shortOid}</span>
                {index === 0 && (
                  <span className="file-history__latest">Latest commit</span>
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
          ))
        )}
      </div>
    </aside>
  );
}
