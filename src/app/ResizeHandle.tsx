import { useCallback, useRef } from 'react';
import './ResizeHandle.css';

interface ResizeHandleProps {
  /** 'v' = vertical bar (drag left/right to resize width); 'h' = horizontal bar (drag up/down to resize height). */
  orientation: 'v' | 'h';
  /** Called with the pointer delta since the previous move event. */
  onDelta: (deltaX: number, deltaY: number) => void;
  label: string;
  /** Double-click handler — conventionally resets the pane size. */
  onReset?: () => void;
}

/** Draggable splitter between layout panes. */
export function ResizeHandle({ orientation, onDelta, label, onReset }: ResizeHandleProps) {
  const last = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Synthetic pointers (automation/tests) have no capturable id — drag
    // still works without capture, moves just stop outside the handle.
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    last.current = { x: event.clientX, y: event.clientY };
    document.body.classList.add('resizing');
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!last.current) return;
      const dx = event.clientX - last.current.x;
      const dy = event.clientY - last.current.y;
      last.current = { x: event.clientX, y: event.clientY };
      onDelta(dx, dy);
    },
    [onDelta],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // ignore — capture may never have been taken
    }
    last.current = null;
    document.body.classList.remove('resizing');
  }, []);

  return (
    <div
      className={`resize-handle resize-handle--${orientation}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onReset}
      role="separator"
      aria-orientation={orientation === 'v' ? 'vertical' : 'horizontal'}
      aria-label={label}
    />
  );
}
