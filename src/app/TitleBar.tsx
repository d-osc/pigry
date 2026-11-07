import { PanelRight, Search } from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import './TitleBar.css';

export function TitleBar() {
  const { repository } = useRepository();

  return (
    <header className="title-bar">
      {/* Drag region: the whole bar except interactive controls */}
      <div className="title-bar__drag" data-tauri-drag-region aria-hidden="true" />

      <div className="title-bar__brand">
        <span className="title-bar__logo" aria-hidden="true" />
        <span className="title-bar__name">orbit</span>
        <span className="title-bar__beta">GIT</span>
      </div>

      {repository && (
        <nav className="title-bar__breadcrumb" aria-label="Repository">
          <span className="title-bar__org">{repository.organization}</span>
          {repository.organization && (
            <span className="title-bar__sep">/</span>
          )}
          <span className="title-bar__repo">{repository.name}</span>
          {repository.visibility && (
            <span className="title-bar__visibility">{repository.visibility}</span>
          )}
        </nav>
      )}

      <div className="title-bar__actions">
        <div className="command-search">
          <Search size={13} className="command-search__icon" />
          <input
            className="command-search__input"
            placeholder="Search or jump to…"
            readOnly
            tabIndex={-1}
          />
          <kbd className="command-search__kbd">⌘ K</kbd>
        </div>
        <button className="icon-button" type="button" aria-label="Toggle secondary panel">
          <PanelRight size={13} />
        </button>
        {repository && (
          <div
            className="avatar"
            title={`${repository.account.name} · ${repository.account.email}`}
          >
            {repository.account.initials}
          </div>
        )}
      </div>
    </header>
  );
}
