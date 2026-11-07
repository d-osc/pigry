import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { fuzzyRank } from '../../lib/fuzzy';
import type { Command } from '../commands';
import './CommandPalette.css';

interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => fuzzyRank(query, commands, (c) => c.title), [query, commands]);
  // Keyboard selection follows the visible list; disabled entries are skipped.
  const selectable = useMemo(() => ranked.filter(({ item }) => item.enabled), [ranked]);
  const clampedIndex = Math.min(activeIndex, Math.max(0, selectable.length - 1));
  const active = selectable[clampedIndex];

  // Scroll the highlighted row into view.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, query]);

  const runCommand = (command: Command) => {
    if (!command.enabled) return;
    onClose();
    void command.run();
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
      if (active) runCommand(active.item);
    }
  };

  let lastSection = '';

  return (
    <div className="command-overlay" role="presentation" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette__input-row">
          <Search size={14} />
          <input
            autoFocus
            className="command-palette__input"
            placeholder="Type a command…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Command search"
          />
          <kbd className="command-palette__kbd">esc</kbd>
        </div>
        <div className="command-palette__list" ref={listRef}>
          {ranked.length === 0 ? (
            <div className="command-palette__empty">No matching commands</div>
          ) : (
            ranked.map(({ item }) => {
              const showSection = item.section !== lastSection;
              lastSection = item.section;
              const isActive = active?.item.id === item.id;
              return (
                <div key={item.id}>
                  {showSection && (
                    <p className="command-palette__section">{item.section}</p>
                  )}
                  <button
                    type="button"
                    className={`command-palette__item${isActive ? ' command-palette__item--active' : ''}${
                      item.enabled ? '' : ' command-palette__item--disabled'
                    }`}
                    data-active={isActive}
                    onMouseEnter={() => {
                      const index = selectable.findIndex((entry) => entry.item.id === item.id);
                      if (index >= 0) setActiveIndex(index);
                    }}
                    onClick={() => runCommand(item)}
                  >
                    <item.icon size={13} />
                    <span className="command-palette__title">{item.title}</span>
                    {item.hint && <span className="command-palette__hint">{item.hint}</span>}
                    {isActive && <CornerDownLeft size={11} className="command-palette__enter" />}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <footer className="command-palette__footer">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </footer>
      </div>
    </div>
  );
}
