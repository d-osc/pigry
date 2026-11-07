import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, File as FileIcon, Search } from 'lucide-react';
import { fuzzyRank } from '../../lib/fuzzy';
import type { Command } from '../commands';
import './CommandPalette.css';

export type PaletteMode = 'commands' | 'files';

interface CommandPaletteProps {
  mode: PaletteMode;
  commands: Command[];
  /** Repository file paths (files mode only). */
  files: string[];
  filesLoading: boolean;
  onOpenFile: (path: string) => void;
  onSwitchToFiles: () => void;
  onClose: () => void;
}

interface PaletteRow {
  id: string;
  title: string;
  section?: string;
  hint?: string;
  enabled: boolean;
  run: () => void;
}

export function CommandPalette({
  mode,
  commands,
  files,
  filesLoading,
  onOpenFile,
  onSwitchToFiles,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // In files mode the searchable key is the full path.
  const ranked: Array<{ row: PaletteRow; match: { indices: number[] } }> = useMemo(() => {
    if (mode === 'files') {
      return fuzzyRank(query, files, (path) => path).map(({ item, match }) => ({
        row: {
          id: `file:${item}`,
          title: item,
          enabled: true,
          run: () => onOpenFile(item),
        },
        match,
      }));
    }
    const commandRows = fuzzyRank(query, commands, (c) => c.title).map(({ item }) => ({
      row: {
        id: item.id,
        title: item.title,
        section: item.section,
        hint: item.hint,
        enabled: item.enabled,
        run: () => item.run(),
      },
      match: { indices: [] },
    }));
    // The file-search entry point is always available at the top of commands mode.
    if (!query) {
      commandRows.unshift({
        row: {
          id: 'file-search',
          title: 'Go to file…',
          section: 'Navigate',
          hint: '⌘ P',
          enabled: true,
          run: () => onSwitchToFiles(),
        },
        match: { indices: [] },
      });
    }
    return commandRows;
  }, [mode, query, commands, files, onOpenFile, onSwitchToFiles]);

  const selectable = ranked.filter(({ row }) => row.enabled);
  const clampedIndex = Math.min(activeIndex, Math.max(0, selectable.length - 1));
  const active = selectable[clampedIndex];

  // Scroll the highlighted row into view.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, query]);

  const runRow = (row: PaletteRow) => {
    if (!row.enabled) return;
    onClose();
    row.run();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(clampedIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(Math.max(clampedIndex - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active) runRow(active.row);
    }
  };

  let lastSection: string | undefined = undefined;

  return (
    <div className="command-overlay" role="presentation" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'files' ? 'Go to file' : 'Command palette'}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette__input-row">
          <Search size={14} />
          <input
            autoFocus
            className="command-palette__input"
            placeholder={mode === 'files' ? 'Go to file…' : 'Type a command…'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={mode === 'files' ? 'File search' : 'Command search'}
          />
          {mode === 'commands' && (
            <button
              type="button"
              className="command-palette__mode-switch"
              onClick={onSwitchToFiles}
              title="Switch to file search"
            >
              <FileIcon size={11} />
              ⌘ P
            </button>
          )}
          <kbd className="command-palette__kbd">esc</kbd>
        </div>
        <div className="command-palette__list" ref={listRef}>
          {mode === 'files' && filesLoading ? (
            <div className="command-palette__empty">Loading files…</div>
          ) : ranked.length === 0 ? (
            <div className="command-palette__empty">
              {mode === 'files' ? 'No matching files' : 'No matching commands'}
            </div>
          ) : (
            selectable.map(({ row }, index) => (
              <div key={row.id}>
                {mode === 'commands' && row.section !== lastSection && (
                  <p className="command-palette__section">{row.section}</p>
                )}
                {(() => {
                  lastSection = row.section;
                  return null;
                })()}
                <button
                  type="button"
                  className={`command-palette__item${index === clampedIndex ? ' command-palette__item--active' : ''}`}
                  data-active={index === clampedIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runRow(row)}
                >
                  {mode === 'files' && <FileIcon size={13} />}
                  <span className="command-palette__title">{row.title}</span>
                  {row.hint && <span className="command-palette__hint">{row.hint}</span>}
                  {index === clampedIndex && (
                    <CornerDownLeft size={11} className="command-palette__enter" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
        <footer className="command-palette__footer">
          <span>↑↓ navigate</span>
          <span>↵ {mode === 'files' ? 'open' : 'run'}</span>
          <span>esc close</span>
        </footer>
      </div>
    </div>
  );
}
