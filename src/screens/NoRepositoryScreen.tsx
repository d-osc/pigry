import { FolderOpen, History } from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import './NoRepositoryScreen.css';

export function NoRepositoryScreen() {
  const { state, pickRepository, openRepository, busy, error, refresh } = useRepository();

  return (
    <div className="no-repo">
      <div className="no-repo__card">
        <h1 className="no-repo__title">No repository open</h1>
        <p className="no-repo__subtitle">
          Pick a folder containing a Git repository to start working.
        </p>
        {error && (
          <p className="no-repo__error" role="alert">
            {error}{' '}
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          </p>
        )}
        <button
          type="button"
          className="primary-button"
          onClick={() => void pickRepository()}
          disabled={busy}
        >
          <FolderOpen size={13} />
          Open repository…
        </button>

        {state && state.recent.length > 0 && (
          <div className="no-repo__recent">
            <p className="no-repo__recent-heading">
              <History size={11} />
              Recent
            </p>
            {state.recent.map((path) => (
              <button
                key={path}
                type="button"
                className="no-repo__recent-item"
                onClick={() => void openRepository(path)}
                disabled={busy}
                title={path}
              >
                <span className="no-repo__recent-name">
                  {path.split(/[\\/]/).pop()}
                </span>
                <span className="no-repo__recent-path">{path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
