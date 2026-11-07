import { ArrowDown, ArrowUp, Terminal, CloudDownload } from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import './StatusBar.css';

export function StatusBar() {
  const { repository, refresh, busy, fetchRemote, pullRemote, pushRemote } = useRepository();
  if (!repository) return null;

  const staged = repository.files.filter((f) => f.staged).length;
  const unstaged = repository.files.length - staged;
  const upstream = repository.upstream;
  const synced = upstream === null || (upstream.ahead === 0 && upstream.behind === 0);
  const hasRemote = repository.remotes.length > 0;

  return (
    <footer className="status-bar">
      <div className="status-bar__connection">
        <span className={`status-bar__dot${synced ? '' : ' status-bar__dot--dirty'}`} />
        {upstream ? (
          <span title={upstream.name}>
            {synced ? 'Up to date' : `↑${upstream.ahead} ↓${upstream.behind}`}
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
        <div className="status-bar__net">
          <button
            type="button"
            className="status-bar__net-button"
            onClick={() => void fetchRemote()}
            disabled={busy || !hasRemote}
            title={hasRemote ? 'Fetch from remote' : 'No remote configured'}
          >
            <CloudDownload size={11} />
          </button>
          <button
            type="button"
            className="status-bar__net-button"
            onClick={() => void pullRemote()}
            disabled={busy || !upstream || upstream.behind === 0}
            title={upstream ? `Pull (behind ${upstream.behind})` : 'No upstream — fetch or publish first'}
          >
            <ArrowDown size={11} />
            {upstream && upstream.behind > 0 ? upstream.behind : ''}
          </button>
          <button
            type="button"
            className={`status-bar__net-button${upstream && upstream.ahead > 0 ? ' status-bar__net-button--attention' : ''}`}
            onClick={() => void pushRemote()}
            disabled={busy}
            title={upstream ? `Push (ahead ${upstream.ahead})` : 'Publish branch to origin'}
          >
            <ArrowUp size={11} />
            {upstream && upstream.ahead > 0 ? upstream.ahead : ''}
          </button>
        </div>
        <button type="button" className="status-bar__terminal" aria-label="Open terminal">
          <Terminal size={12} />
          <span>Terminal</span>
        </button>
      </div>
    </footer>
  );
}
