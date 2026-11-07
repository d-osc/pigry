/** Repository switcher tabs: every recently opened repo, one click to switch. */
import { Plus } from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import './WorkspaceBar.css';

function repoLabel(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() ?? path;
}

export function WorkspaceBar() {
  const { state, mode, openRepository, pickRepository, busy } = useRepository();
  if (mode !== 'tauri') return null;
  const recent = state?.recent ?? [];
  const activePath = state?.activePath ?? null;
  if (recent.length === 0) return null;

  return (
    <div className="workspace-bar" role="tablist" aria-label="Open repositories">
      {recent.map((path) => {
        const isActive = path === activePath;
        return (
          <button
            key={path}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`workspace-tab${isActive ? ' workspace-tab--active' : ''}`}
            title={path}
            onClick={() => {
              if (!isActive && !busy) void openRepository(path);
            }}
            disabled={busy}
          >
            <span className="workspace-tab__dot" aria-hidden="true" />
            {repoLabel(path)}
          </button>
        );
      })}
      <button
        type="button"
        className="workspace-bar__add"
        title="Open another repository…"
        aria-label="Open another repository"
        onClick={() => void pickRepository()}
        disabled={busy}
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
