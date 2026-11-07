import { Terminal } from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import './StatusBar.css';

export function StatusBar() {
  const { repository, refresh, busy } = useRepository();
  if (!repository) return null;

  const staged = repository.files.filter((f) => f.staged).length;
  const unstaged = repository.files.length - staged;
  const upstream = repository.upstream;
  const synced =
    upstream === null || (upstream.ahead === 0 && upstream.behind === 0);

  return (
    <footer className="status-bar">
      <div className="status-bar__connection">
        <span className={`status-bar__dot${synced ? '' : ' status-bar__dot--dirty'}`} />
        {upstream ? (
          <span>
            {synced
              ? 'Up to date'
              : `↑${upstream.ahead} ↓${upstream.behind} ${upstream.name}`}
          </span>
        ) : (
          <span>Local repository</span>
        )}
      </div>
      <span className="status-bar__path">{repository.localPath}</span>
      <div className="status-bar__right">
        {repository.files.length > 0 ? (
          <button
            type="button"
            className="status-bar__summary"
            onClick={() => void refresh()}
            disabled={busy}
            title="Click to rescan"
          >
            {repository.files.length} files changed
            <span className="status-bar__sep">·</span>
            {staged} staged / {unstaged} unstaged
          </button>
        ) : (
          <span>Working tree clean</span>
        )}
        <button type="button" className="status-bar__terminal" aria-label="Open terminal">
          <Terminal size={12} />
          <span>Terminal</span>
        </button>
      </div>
    </footer>
  );
}
