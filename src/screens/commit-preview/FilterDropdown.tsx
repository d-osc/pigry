import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './FilterDropdown.css';

/** Generic filter dropdown — closes on any outside click (capture phase). */
export function FilterDropdown({
  icon,
  label,
  active,
  children,
  menuWidth,
  ariaLabel,
  closeOnSelect = false,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  children: ReactNode;
  menuWidth?: number;
  ariaLabel?: string;
  closeOnSelect?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Flip to right-aligned when the menu would overflow the window edge.
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setAlignRight(rect.right > window.innerWidth - 8);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [open]);

  return (
    <div className="filter-dd" ref={ref}>
      <button
        type="button"
        className={`filter-pill${active ? ' filter-pill--active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {icon}
        {label}
        <Chevron />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={`filter-dd__menu${alignRight ? ' filter-dd__menu--right' : ''}`}
          role="menu"
          onClick={closeOnSelect ? () => setOpen(false) : undefined}
          style={menuWidth ? { width: menuWidth } : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
