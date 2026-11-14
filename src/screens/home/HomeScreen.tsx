import { useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FolderOpen,
  GitBranch,
  History,
} from 'lucide-react';
import { PigryMark } from '../../app/PigryMark';
import { useRepository } from '../../hooks/useRepository';
import './HomeScreen.css';

/**
 * Landing screen — pick a repository to work on. Aggregates every repository
 * previously opened (persisted in the app config) with the actions to open a
 * folder or clone a new one.
 */
export function HomeScreen({
  onBackToWorkspace,
}: {
  /** Present only while a repository is already open behind this screen. */
  onBackToWorkspace?: () => void;
}) {
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneTarget, setCloneTarget] = useState('');
  const [cloneOpen, setCloneOpen] = useState(false);
  const { state, pickRepository, openRepository, cloneRepo, busy, error, refresh } =
    useRepository();

  const recent = state?.recent ?? [];
  const activePath = state?.activePath ?? null;

  const repoName = (path: string) => {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  };

  return (
    <div className="home">
      <div className="home__wrap">
        <header className="home__brand">
          <h1 className="home__brand-name">
            <span className="home__brand-mark" aria-hidden="true">
              <PigryMark size={40} />
            </span>
            PIGRY <span className="home__brand-chip">GIT</span>
          </h1>
          <p className="home__brand-sub">Select a repository to start working.</p>
          {onBackToWorkspace && (
            <button
              type="button"
              className="outline-button home__back"
              onClick={onBackToWorkspace}
            >
              <ArrowLeft size={12} strokeWidth={1.5} />
              Back to workspace
            </button>
          )}
        </header>

        <div className="home__card">
          <div className="home__actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void pickRepository()}
              disabled={busy}
            >
              <FolderOpen size={13} strokeWidth={1.5} />
              Open repository…
            </button>
            <button
              type="button"
              className="outline-button"
              onClick={() => setCloneOpen((open) => !open)}
              disabled={busy}
            >
              <Download size={12} strokeWidth={1.5} />
              Clone repository
            </button>
          </div>

          {cloneOpen && (
            <div className="home__clone">
              <input
                className="home__clone-input"
                placeholder="Repository URL…"
                value={cloneUrl}
                onChange={(event) => setCloneUrl(event.target.value)}
                spellCheck={false}
              />
              <input
                className="home__clone-input"
                placeholder="Target directory…"
                value={cloneTarget}
                onChange={(event) => setCloneTarget(event.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  if (cloneUrl && cloneTarget) {
                    void cloneRepo(cloneUrl, cloneTarget);
                  }
                }}
                disabled={busy || !cloneUrl || !cloneTarget}
              >
                <Download size={12} strokeWidth={1.5} />
                Clone
              </button>
              <p className="home__clone-hint">
                The cloned repository opens automatically when finished.
              </p>
            </div>
          )}

          {error && (
            <p className="home__error" role="alert">
              {error}{' '}
              <button type="button" onClick={() => void refresh()}>
                Retry
              </button>
            </p>
          )}

          <div className="home__recent">
            <p className="home__recent-heading">
              <History size={11} strokeWidth={1.5} />
              Recent repositories
            </p>
            {recent.length === 0 ? (
              <p className="home__recent-empty">
                No repositories yet — open a folder above to get started.
              </p>
            ) : (
              recent.map((path, index) => {
                const isOpen = path === activePath;
                const chip = isOpen
                  ? 'Open now'
                  : index === 0 && !activePath
                    ? 'Last opened'
                    : null;
                return (
                  <button
                    key={path}
                    type="button"
                    className="home__recent-item"
                    onClick={() => {
                      // The repository already open behind this screen —
                      // the row simply returns to it.
                      if (isOpen && onBackToWorkspace) {
                        onBackToWorkspace();
                        return;
                      }
                      void openRepository(path);
                    }}
                    disabled={busy}
                    title={path}
                  >
                    <span className="home__recent-icon">
                      <GitBranch size={13} strokeWidth={1.25} />
                    </span>
                    <span className="home__recent-text">
                      <span className="home__recent-name">
                        {repoName(path)}
                        {chip && <em className="home__recent-chip">{chip}</em>}
                      </span>
                      <span className="home__recent-path">{path}</span>
                    </span>
                    <ChevronRight size={13} strokeWidth={1.25} className="home__recent-go" />
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
