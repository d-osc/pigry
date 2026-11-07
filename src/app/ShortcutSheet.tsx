/** Keyboard shortcut reference sheet (⌘/ overlay). */
import { X } from 'lucide-react';
import './ShortcutSheet.css';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'General',
    items: [
      ['⌘ K', 'Command palette'],
      ['⌘ P', 'Search files'],
      ['⌘ /', 'This shortcut sheet'],
      ['⌘ ,', 'Repository settings'],
    ],
  },
  {
    title: 'Navigation',
    items: [
      ['⌘ 1', 'Working changes'],
      ['⌘ 2', 'Commit graph'],
      ['⌘ 3', 'Explorer'],
    ],
  },
  {
    title: 'Working changes',
    items: [
      ['⌘ F', 'Filter file list'],
      ['⌘ ↵', 'Commit staged files'],
      ['⌘ S', 'Save file (Explorer)'],
    ],
  },
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="shortcut-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="shortcut-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header className="shortcut-sheet__header">
          <h2 className="shortcut-sheet__title">Keyboard shortcuts</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close shortcuts">
            <X size={14} />
          </button>
        </header>
        <div className="shortcut-sheet__groups">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcut-sheet__group">
              <h3 className="shortcut-sheet__group-title">{group.title}</h3>
              {group.items.map(([keys, label]) => (
                <div key={keys} className="shortcut-sheet__row">
                  <span className="shortcut-sheet__label">{label}</span>
                  <kbd className="shortcut-sheet__keys">{keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
