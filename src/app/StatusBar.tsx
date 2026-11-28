import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bell,
  CircleCheck,
  CircleX,
  CloudDownload,
  GitBranch,
  Unplug,
  SquareTerminal,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import { RefPicker } from './RefPicker';
import {
  completionSettings, isThinking, setCompletionSettings, subscribeCompletionSettings, subscribeThinking,
} from '../lib/inlineAiClient';
import './StatusBar.css';

/** Live info of the focused editor, merged into the single status bar. */
export interface EditorStatusInfo {
  path: string;
  line: number;
  column: number;
  language: string;
  dirty: boolean;
  /** Why AI help is off for this file (secret, ignored, binary, too large), or null. */
  aiSkip?: string | null;
}

export function StatusBar({
  editorStatus,
  terminalOpen,
  onToggleTerminal,
  onDisconnectSsh,
}: {
  editorStatus?: EditorStatusInfo | null;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  onDisconnectSsh?: () => void;
} = {}) {
  const { repository, state, refresh, busy, fetchRemote, pullRemote, pushRemote, notifications, clearNotifications } =
    useRepository();
  const aiSettings = useSyncExternalStore(subscribeCompletionSettings, completionSettings);
  const aiThinking = useSyncExternalStore(subscribeThinking, isThinking);
  const [bellOpen, setBellOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const ssh = state?.sshWorkspace;
  const displayPath = (ssh && state?.activePath) || repository.localPath;
  const detached = repository.currentBranch === 'HEAD' && repository.headOid;
  const branchLabel = detached ? `${repository.headOid?.slice(0, 7)} (detached)` : repository.currentBranch || 'main';

  return (
    <footer className="status-bar">
      <div className="status-bar__connection">
        <span className={`status-bar__dot${synced ? '' : ' status-bar__dot--dirty'}`} />
        {upstream ? (
          <span title={upstream.name}>
            {synced ? 'Up to date' : `↑${upstream.ahead} ↓${upstream.behind}`}
          </span>
        ) : (
          <span>{ssh ? 'SSH workspace' : 'Local repository'}</span>
        )}
        <button
          type="button"
          className="status-bar__branch"
          aria-label={`Checkout branch or tag (current: ${branchLabel})`}
          title={`${branchLabel} — click to checkout a branch or tag`}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          disabled={busy}
          onClick={() => setPickerOpen(true)}
        >
          <GitBranch size={11} strokeWidth={1.75} />
          {branchLabel}
          {editorStatus?.dirty ? ' ✱' : ''}
        </button>
        {pickerOpen && <RefPicker onClose={() => setPickerOpen(false)} />}
      </div>
      <span className="status-bar__path" title={displayPath}>{displayPath}</span>
      {ssh && (
        <button type="button" className="status-bar__net-button" title="Disconnect SSH workspace"
          aria-label="Disconnect SSH workspace" disabled={busy} onClick={onDisconnectSsh}>
          <Unplug size={12} />
        </button>
      )}
      <div className="status-bar__right">
        {repository.files.length > 0 || ssh ? (
          <button
            type="button"
            className="status-bar__summary"
            onClick={() => void refresh()}
            disabled={busy}
            title="Click to rescan"
          >
            {repository.files.length === 0 ? 'Working tree clean' : (
              <>
                {repository.files.length} files changed
                <span className="status-bar__sep">·</span>
                {staged} staged / {unstaged} unstaged
              </>
            )}
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
        {editorStatus && (
          <>
            <span className="status-bar__editor">
              Ln {editorStatus.line}, Col {editorStatus.column} · Spaces: 2 · UTF-8 · LF ·{' '}
              {editorStatus.language}
            </span>
            <button
              type="button"
              className={`status-bar__ai${aiSettings.enabled ? ' status-bar__ai--on' : ''}${editorStatus.aiSkip ? ' status-bar__ai--skipped' : ''}`}
              aria-label={`AI completions: ${aiSettings.enabled ? 'on' : 'off'}`}
              aria-pressed={aiSettings.enabled}
              title={
                editorStatus.aiSkip
                  ? `AI help is off for this file (${editorStatus.aiSkip}). Click to turn AI completions ${aiSettings.enabled ? 'off' : 'on'}.`
                  : `AI completions are ${aiSettings.enabled ? 'on' : 'off'} — click to turn them ${aiSettings.enabled ? 'off' : 'on'}. Ctrl+I edits code with AI.`
              }
              onClick={() => setCompletionSettings({ enabled: !aiSettings.enabled })}
            >
              {aiThinking ? (
                <Loader2 size={11} strokeWidth={1.75} className="status-bar__ai-spin" aria-label="AI is thinking" />
              ) : (
                <Sparkles size={11} strokeWidth={1.5} />
              )}
              AI
            </button>
            <button
              type="button"
              className={`status-bar__terminal${terminalOpen ? ' status-bar__terminal--open' : ''}`}
              aria-label="Toggle terminal"
              title="Toggle terminal"
              onClick={() => onToggleTerminal?.()}
            >
              <SquareTerminal size={11} strokeWidth={1.5} />
              Terminal
            </button>
          </>
        )}
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
            <div
              className="status-bell__menu"
              role="menu"
              aria-label="Notifications"
              onClick={() => setBellOpen(false)}
            >
              <header className="status-bell__head">
                <strong>Notifications</strong>
                {notifications.length > 0 && (
                  <button
                    type="button"
                    className="status-bell__clear"
                    onClick={(event) => {
                      // Clearing keeps the menu open so the empty state is visible.
                      event.stopPropagation();
                      clearNotifications();
                    }}
                  >
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
                      <span className="status-bell__msg" title={item.message}>
                        {item.message}
                      </span>
                      <span className="status-bell__time">
                        {new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}
