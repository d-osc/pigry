/** Floating in-app browser window — draggable native webview with Chrome-style
 * tabs. The webviews are Tauri child webviews positioned to track the panel;
 * in browser preview (no Tauri backend) the content area shows a note.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  Minus,
  Plus,
  Square,
  X,
} from 'lucide-react';
import {
  browserClose,
  browserCreate,
  browserNavigate,
  browserPosition,
  browserSetVisible,
  normalizeUrl,
} from '../lib/browserWebview';
import { isTauri } from '../lib/tauriClient';
import './BrowserPanel.css';

interface BrowserTab {
  id: string;
  url: string;
}

interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Two rows above the webview: tabs row + address row. */
const HEADER_H = 62;
const MIN_W = 420;
const MIN_H = 240;
const DEFAULT_URL = 'https://duckduckgo.com';

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 24);
  }
}

export function BrowserPanel({
  minimized = false,
  onMinimize,
  onClose,
  forceHidden = false,
}: {
  /** Folded into the title-bar browser button — webviews stay alive, hidden. */
  minimized?: boolean;
  onMinimize: () => void;
  onClose: () => void;
  /** Another native-layer panel (containers) is showing — hide our webviews. */
  forceHidden?: boolean;
}) {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [
    { id: `tab-${Date.now().toString(36)}`, url: DEFAULT_URL },
  ]);
  const [activeId, setActiveId] = useState(() => tabs[0]?.id ?? '');
  const [maximized, setMaximized] = useState(false);
  /** True while dragging — the native webview hides so it never trails. */
  const [dragging, setDragging] = useState(false);
  const [geom, setGeom] = useState<Geom>(() => ({
    x: Math.max(16, window.innerWidth - 790),
    y: 96,
    w: Math.min(760, window.innerWidth - 60),
    h: Math.min(520, window.innerHeight - 160),
  }));
  const [address, setAddress] = useState(DEFAULT_URL);
  /** Last backend error while creating the webview — shown in the view area. */
  const [viewError, setViewError] = useState('');
  const prevGeomRef = useRef<Geom | null>(null);
  const createdRef = useRef(new Set<string>());
  const positionPendingRef = useRef<{ id: string; rect: { x: number; y: number; width: number; height: number } } | null>(null);
  const positionRafRef = useRef<number | null>(null);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  /** Sends create/position/visibility to the backend whenever layout changes.
   * While dragging or when another native panel is open, webviews hide so
   * they never cover HTML UI — they re-appear when the flag clears. */
  useEffect(() => {
    const show = !minimized && !dragging && !forceHidden;
    const rect = {
      x: geom.x,
      y: geom.y + HEADER_H,
      width: geom.w,
      height: Math.max(0, geom.h - HEADER_H),
    };
    for (const tab of tabs) {
      if (!createdRef.current.has(tab.id)) {
        createdRef.current.add(tab.id);
        browserCreate(tab.id, tab.url, rect.x, rect.y, rect.width, rect.height).catch((error) => {
          setViewError(String(error));
          // allow retry on next layout change
          createdRef.current.delete(tab.id);
        });
      } else {
        void browserSetVisible(tab.id, tab.id === activeId && show);
        if (tab.id === activeId && show) {
          // Coalesce to one set_bounds per frame — dragging fires many updates.
          positionPendingRef.current = { id: tab.id, rect };
          if (!positionRafRef.current) {
            positionRafRef.current = requestAnimationFrame(() => {
              positionRafRef.current = null;
              const pending = positionPendingRef.current;
              positionPendingRef.current = null;
              if (pending) {
                void browserPosition(pending.id, pending.rect.x, pending.rect.y, pending.rect.width, pending.rect.height);
              }
            });
          }
        }
      }
    }
  }, [tabs, activeId, minimized, dragging, forceHidden, geom]);

  // App window resized — follow when maximized, clamp when floating.
  useEffect(() => {
    const onResize = () => {
      if (maximized) {
        setGeom((g) => ({ ...g, x: 0, y: 0, w: window.innerWidth, h: window.innerHeight - 28 }));
      } else {
        setGeom((g) => ({
          ...g,
          x: clamp(g.x, -g.w + 160, window.innerWidth - 160),
          y: clamp(g.y, 0, window.innerHeight - 60),
          w: Math.min(g.w, window.innerWidth - 16),
          h: Math.min(g.h, window.innerHeight - 60),
        }));
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [maximized]);

  // Safety: destroy webviews if the panel unmounts without closing properly.
  useEffect(
    () => () => {
      for (const tab of tabsRef.current) void browserClose(tab.id);
    },
    [],
  );

  const addTab = () => {
    const id = `tab-${Date.now().toString(36)}`;
    setTabs((current) => [...current, { id, url: DEFAULT_URL }]);
    setActiveId(id);
    setAddress(DEFAULT_URL);
  };

  const closeTab = (id: string) => {
    void browserClose(id);
    createdRef.current.delete(id);
    const rest = tabs.filter((tab) => tab.id !== id);
    if (rest.length === 0) {
      onClose();
      return;
    }
    setTabs(rest);
    if (activeId === id) {
      const next = rest[rest.length - 1];
      setActiveId(next.id);
      setAddress(next.url);
    }
  };

  const closePanel = () => {
    for (const tab of tabs) void browserClose(tab.id);
    onClose();
  };

  const toggleMaximize = () => {
    if (!maximized) {
      prevGeomRef.current = geom;
      // Fill the workspace BELOW the app title bar + status bar.
      setGeom({ x: 0, y: 56, w: window.innerWidth, h: window.innerHeight - 56 - 28 });
      setMaximized(true);
    } else {
      if (prevGeomRef.current) setGeom(prevGeomRef.current);
      setMaximized(false);
    }
  };

  const navigateActive = () => {
    const url = normalizeUrl(address);
    if (!url) return;
    setAddress(url);
    setTabs((current) =>
      current.map((tab) => (tab.id === activeId ? { ...tab, url } : tab)),
    );
    void browserNavigate(activeId, url);
  };

  /** Dragging by the header rows (pointer capture keeps events while moving). */
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const onHeaderPointerDown = (event: React.PointerEvent) => {
    // Interactive controls keep their clicks — never start a drag from them.
    if ((event.target as HTMLElement).closest('button, input, textarea, a')) return;
    dragRef.current = { dx: event.clientX - geom.x, dy: event.clientY - geom.y };
    setDragging(true);
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const onHeaderPointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const x = clamp(event.clientX - dragRef.current.dx, -geom.w + 180, window.innerWidth - 180);
    const y = clamp(event.clientY - dragRef.current.dy, 0, window.innerHeight - HEADER_H);
    setGeom((g) => ({ ...g, x, y }));
  };
  const onHeaderPointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  /** Bottom-right corner resize. */
  const resizeRef = useRef<{ startX: number; startY: number; w: number; h: number } | null>(null);
  const onResizePointerDown = (event: React.PointerEvent) => {
    resizeRef.current = { startX: event.clientX, startY: event.clientY, w: geom.w, h: geom.h };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const onResizePointerMove = (event: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    setGeom((g) => ({
      ...g,
      w: clamp(r.w + (event.clientX - r.startX), MIN_W, window.innerWidth - g.x),
      h: clamp(r.h + (event.clientY - r.startY), MIN_H, window.innerHeight - g.y),
    }));
  };
  const onResizePointerUp = () => {
    resizeRef.current = null;
  };

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  // Folded into the title-bar browser button — webviews stay alive (hidden).
  if (minimized) return null;

  return createPortal(
    <div
      className={`browser-win${minimized ? ' browser-win--min' : ''}${maximized ? ' browser-win--max' : ''}`}
      data-tauri-drag-region="false"
      data-no-drag=""
      // The panel renders inside the TitleBar's React tree — stop mousedown
      // bubbling or the title bar starts dragging the whole app window.
      onMouseDown={(event) => event.stopPropagation()}
      style={{ left: geom.x, top: geom.y, width: geom.w, height: minimized ? HEADER_H : geom.h }}
    >
      <div
        className="browser-win__tabs"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        {tabs.map((tab) => (
          <span
            key={tab.id}
            className={`browser-win__tab${tab.id === activeId ? ' browser-win__tab--active' : ''}`}
            title={tab.url}
            onClick={() => {
              setActiveId(tab.id);
              setAddress(tab.url);
            }}
          >
            <span className="browser-win__tab-label">{hostnameOf(tab.url)}</span>
            <span
              className="browser-win__tab-x"
              aria-label={`Close tab ${hostnameOf(tab.url)}`}
              onPointerDown={stop}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <X size={9} strokeWidth={2} />
            </span>
          </span>
        ))}
        <button
          type="button"
          className="browser-win__tab-new"
          title="New tab"
          aria-label="New tab"
          onPointerDown={stop}
          onClick={addTab}
        >
          <Plus size={12} strokeWidth={1.5} />
        </button>
        <span className="browser-win__spacer" />
        <button
          type="button"
          className="browser-win__ctl"
          title="Fold into the browser button"
          aria-label="Minimize browser"
          onPointerDown={stop}
          onClick={onMinimize}
        >
          <Minus size={12} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="browser-win__ctl"
          title={maximized ? 'Restore size' : 'Maximize'}
          aria-label="Maximize browser"
          onPointerDown={stop}
          onClick={toggleMaximize}
        >
          <Square size={10} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="browser-win__ctl browser-win__ctl--close"
          title="Close browser"
          aria-label="Close browser"
          onPointerDown={stop}
          onClick={closePanel}
        >
          <X size={12} strokeWidth={1.5} />
        </button>
      </div>

      <div
        className="browser-win__address"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <input
          value={address}
          spellCheck={false}
          aria-label="Browser address"
          placeholder="Search or enter address"
          onPointerDown={stop}
          onKeyDown={(event) => {
            if (event.key === 'Enter') navigateActive();
          }}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button
          type="button"
          title="Go"
          aria-label="Go"
          onPointerDown={stop}
          onClick={navigateActive}
        >
          <ArrowRight size={12} strokeWidth={1.5} />
        </button>
      </div>

      <div className="browser-win__view">
        {viewError ? (
          <p className="browser-win__note browser-win__note--error">{viewError}</p>
        ) : !isTauri() ? (
          <p className="browser-win__note">
            Native webview needs the desktop app — browser preview shows this placeholder.
          </p>
        ) : null}
      </div>

      {!minimized && !maximized && (
        <div
          className="browser-win__resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
        />
      )}
    </div>,
    document.body,
  );
}
