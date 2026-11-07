import { useMemo, useState } from 'react';
import { CloudDownload, GitBranchPlus, Search } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { useCommitHistory } from '../../hooks/useCommitHistory';
import { relativeTime } from '../../lib/relativeTime';
import { CommitGraphColumn } from './CommitGraphColumn';
import './CommitGraphScreen.css';

export function CommitGraphScreen() {
  const { repository, fetchRemote, busy } = useRepository();
  const [includeRemotes, setIncludeRemotes] = useState(false);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const { history, error, loading } = useCommitHistory(includeRemotes, reloadKey);

  const handleFetch = async () => {
    const ok = await fetchRemote();
    if (ok) setReloadKey((key) => key + 1);
  };

  const rows = useMemo(() => {
    if (!history) return [];
    const q = query.trim().toLowerCase();
    if (!q) return history.commits;
    return history.commits.filter(
      (row) =>
        row.summary.toLowerCase().includes(q) ||
        row.shortOid.toLowerCase().includes(q) ||
        row.oid.toLowerCase().includes(q) ||
        row.authorName.toLowerCase().includes(q),
    );
  }, [history, query]);

  const totalLabel = history
    ? history.truncated
      ? `${history.total}+ commits`
      : `${history.total} commit${history.total === 1 ? '' : 's'}`
    : '';

  return (
    <div className="commit-history">
      <header className="commit-history__header">
        <div className="commit-history__title-row">
          <h1 className="commit-history__title">Commit graph</h1>
          <span className="commit-history__subtitle">{totalLabel}</span>
          <span className="commit-history__scanned">
            {repository?.upstream ? 'Fetched just now' : 'Local repository'}
          </span>
          <button
            type="button"
            className="outline-button"
            onClick={() => void handleFetch()}
            disabled={busy || !repository?.remotes.length}
            title={
              repository?.remotes.length
                ? 'Fetch from remote (auth via your credential manager)'
                : 'No remote configured'
            }
          >
            <CloudDownload size={12} />
            {busy ? 'Fetching…' : 'Fetch origin'}
          </button>
          <button
            type="button"
            className="outline-button"
            disabled
            title="Branch creation arrives in a later milestone"
          >
            <GitBranchPlus size={12} />
            New branch
          </button>
        </div>

        <div className="commit-history__filters">
          <div className="commit-history__search">
            <Search size={12} />
            <input
              placeholder="Search commits, messages, or SHA…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <span className="filter-pill">All branches</span>
          <span className="filter-pill">All authors</span>
          <span className="filter-pill">All time</span>
          <label className="diff-toggle commit-history__remotes">
            <input
              type="checkbox"
              checked={includeRemotes}
              onChange={(event) => setIncludeRemotes(event.target.checked)}
            />
            Show remotes
          </label>
        </div>
      </header>

      {error && <div className="commit-history__notice">{error}</div>}

      <div className="commit-history__table">
        <div className="commit-history__head commit-row commit-row--head">
          <span>Graph</span>
          <span>Commit message</span>
          <span>Author</span>
          <span>Commit</span>
          <span>Time</span>
        </div>

        {loading && !history ? (
          <div className="commit-history__empty">Loading history…</div>
        ) : rows.length === 0 ? (
          <div className="commit-history__empty">
            {query
              ? 'No commits match this search.'
              : 'No commits yet — the first commit will appear here.'}
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.oid} className="commit-row">
              <span className="commit-row__graph">
                <CommitGraphColumn row={row} />
              </span>
              <span className="commit-row__message">
                {row.isMerge && <span className="commit-row__merge">Merge</span>}
                {row.summary}
                {row.refs.map((ref) => (
                  <span
                    key={ref}
                    className={`ref-pill ${ref.includes('/') ? 'ref-pill--remote' : ''}`}
                  >
                    {ref}
                  </span>
                ))}
              </span>
              <span className="commit-row__author">
                <span className="commit-row__avatar">{row.authorInitials}</span>
                {row.authorName}
              </span>
              <span className="commit-row__sha">{row.shortOid}</span>
              <span className="commit-row__time">
                {relativeTime(row.timeSeconds)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
