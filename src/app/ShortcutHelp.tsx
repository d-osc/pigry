import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string; label: string }>;
}

interface Props {
  title: string;
  groups: ShortcutGroup[];
  onClose: () => void;
}

/** Keys such as "Ctrl+Shift+G" drawn as separate key caps ("Ctrl" shows as ⌘ on macOS). */
function Keys({ combo }: { combo: string }) {
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  return (
    <span className="shortcut-help__keys">
      {combo.split(' / ').map((alt, a) => (
        <span key={alt} className="shortcut-help__alt">
          {a > 0 && <em>or</em>}
          {(alt === '+' ? ['+'] : alt.split('+')).map((part, i) => <kbd key={`${part}${i}`}>{mac && part === 'Ctrl' ? '⌘' : part}</kbd>)}
        </span>
      ))}
    </span>
  );
}

/** Overlay listing the keyboard shortcuts of an editor (opened with "?"). */
export function ShortcutHelp({ title, groups, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === '?') { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="shortcut-help__scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className="shortcut-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1}>
        <header className="shortcut-help__head">
          <strong>{title}</strong>
          <button type="button" className="shortcut-help__close" aria-label="Close shortcuts" onClick={onClose}><X size={14} /></button>
        </header>
        <div className="shortcut-help__body">
          {groups.map((group) => (
            <section key={group.title} className="shortcut-help__group">
              <h3>{group.title}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.label}><span>{item.label}</span><Keys combo={item.keys} /></li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="shortcut-help__foot">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</footer>
      </div>
    </div>
  );
}
