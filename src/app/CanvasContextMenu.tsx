import { useEffect, useLayoutEffect, useRef } from 'react';

export type CanvasMenuEntry =
  | { separator: true }
  | { label: string; onSelect: () => void; shortcut?: string; danger?: boolean; disabled?: boolean };

interface Props {
  x: number;
  y: number;
  entries: CanvasMenuEntry[];
  onClose: () => void;
  label?: string;
}

/** Right-click menu shared by the Diagram, Design and Board editors. */
export function CanvasContextMenu({ x, y, entries, onClose, label = 'Context menu' }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (buttons.length === 0) return;
      event.preventDefault();
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    };
    const away = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu context-menu--canvas" role="menu" aria-label={label} style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}>
      {entries.map((entry, index) => 'separator' in entry
        ? <div key={`sep${index}`} className="context-menu__sep" role="separator" />
        : (
          <button key={entry.label} type="button" role="menuitem" disabled={entry.disabled}
            className={entry.danger ? 'context-menu__item--danger' : undefined}
            onClick={() => { onClose(); entry.onSelect(); }}>
            <span>{entry.label}</span>
            {entry.shortcut && <kbd className="context-menu__kbd">{entry.shortcut}</kbd>}
          </button>
        ))}
    </div>
  );
}
