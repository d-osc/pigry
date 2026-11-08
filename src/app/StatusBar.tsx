import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bell, CircleCheck, CircleX, CloudDownload } from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import './StatusBar.css';

export function StatusBar() {
  const { repository, refresh, busy, fetchRemote, pullRemote, pushRemote, notifications, clearNotifications } =
    useRepository();
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement | null>(null);
  const [lastReadId, setLastReadId] = useState(0);
  const unread = notifications.filter((item) => item.id > lastReadId).length;
  // Clicking anywhere outside the popover closes it (capture phase).
  useEffect(() => {
    if (!bellOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (bellRef.current?.contains(event.target as Node)) return;
      setBellOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [bellOpen]);

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
        <div ref={bellRef} className="status-bell">
          <button
            type="button"
            className={`status-bar__bell${bellOpen ? ' status-bar__bell--open' : ''}`}
            aria-label="Notifications"
            title="Notifications"
            onClick={() => {
              if (!bellOpen) setLastReadId(notifications[0]?.id ?? 0);
              setBellOpen((open) => !open);
            }}
          >
            <Bell size={12} />
            {unread > 0 && <span className="status-bar__bell-badge">{unread > 9 ? '9+' : unread}</span>}
          </button>
          {bellOpen && (
            <>
              <div
                className="status-bell__menu"
                role="menu"
                aria-label="Notifications"
                onClick={() => setBellOpen(false)}
              >
                <header className="status-bell__head">
                  <strong>Notifications</strong>
                  {notifications.length > 0 && (
                    <button type="button" className="status-bell__clear" onClick={clearNotifications}>
                      Clear all
                    </button>
                  )}
                </header>
                {notifications.length === 0 ? (
                  <p className="status-bell__empty">No notifications yet</p>
                ) : (
                  <ul className="status-bell__list">
                    {notifications.map((item) => (
                      <li key={item.id} className={`status-bell__item status-bell__item--${item.type}`}>
                        {item.type === 'success' ? (
                          <CircleCheck size={13} strokeWidth={1.5} />
                        ) : (
                          <CircleX size={13} strokeWidth={1.5} />
                        )}
                        <span className="status-bell__msg">{item.message}</span>
                        <span className="status-bell__time">
                          {new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </footer>
  );
}
