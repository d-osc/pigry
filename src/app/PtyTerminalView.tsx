/** One xterm.js pane wired to a backend PTY session (VS Code integrated terminal). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { isTauri, ptyResize, ptyWrite, type PtyChunkEvent, type PtyExitEvent } from '../lib/tauriClient';

// ---------------------------------------------------------------------------
// Shared output router — ONE listener pair for every terminal pane. Chunks
// that arrive before their pane mounted (shell banners beat React) are
// stashed and replayed on attach, so no output is ever dropped.
// ---------------------------------------------------------------------------
const chunkWriters = new Map<number, ((data: string) => void) | null>();
const exitHandlers = new Map<number, ((code: number | null) => void) | null>();
const stashedChunks = new Map<number, string[]>();
const stashedExits = new Map<number, number | null>();
let listenerStarted = false;

function handlePtyChunk(id: number, data: string) {
  const write = chunkWriters.get(id);
  if (write) write(data);
  else {
    const stash = stashedChunks.get(id) ?? [];
    stash.push(data);
    stashedChunks.set(id, stash);
  }
}

function handlePtyExit(id: number, code: number | null) {
  const handler = exitHandlers.get(id);
  if (handler) handler(code);
  else stashedExits.set(id, code);
}

async function ensurePtyListener(): Promise<void> {
  if (listenerStarted || !isTauri()) return;
  listenerStarted = true;
  try {
    await listen<PtyChunkEvent>('pty-output', (event) => {
      handlePtyChunk(event.payload.id, event.payload.data);
    });
    await listen<PtyExitEvent>('pty-exit', (event) => {
      handlePtyExit(event.payload.id, event.payload.code);
    });
  } catch {
    listenerStarted = false;
  }
}

function drainStashed(id: number): { chunks: string[]; exit: number | null } {
  const chunks = stashedChunks.get(id) ?? [];
  stashedChunks.delete(id);
  const exit = stashedExits.get(id) ?? null;
  stashedExits.delete(id);
  return { chunks, exit };
}

// ---------------------------------------------------------------------------

interface PtyTerminalViewProps {
  /** Backend PTY session id this pane renders. */
  id: number;
  /** Pane has keyboard focus (drives xterm focus + tab highlight). */
  focused: boolean;
  /** xterm theme derived from the app tokens (updates on light/dark switch). */
  theme: ITheme;
  onFocused: (id: number) => void;
  /** OSC title from the shell — becomes the tab label, like VS Code. */
  onTitle: (id: number, title: string) => void;
  onExited: (id: number, code: number | null) => void;
}

export function PtyTerminalView({ id, focused, theme, onFocused, onTitle, onExited }: PtyTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const exitedRef = useRef(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const runFind = useCallback(
    (forward: boolean) => {
      const addon = searchRef.current;
      if (!addon || !findQuery) return;
      if (forward) addon.findNext(findQuery);
      else addon.findPrevious(findQuery);
    },
    [findQuery],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  }, []);

  // Create the xterm instance and wire it to the PTY once per session.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isTauri()) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 2000,
      theme,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(search);

    term.open(container);

    // PTY plumbing: input downstream, output upstream (via the shared router).
    chunkWriters.set(id, (data) => term.write(data));
    exitHandlers.set(id, (code) => {
      exitedRef.current = true;
      term.write(
        `\r\n\x1b[31m${code === null ? 'process terminated' : `process exited with code ${code}`}\x1b[0m\r\n`,
      );
      onExited(id, code);
    });
    const stashed = drainStashed(id);
    for (const chunk of stashed.chunks) term.write(chunk);
    if (stashed.exit !== null) {
      exitedRef.current = true;
      term.write(`\r\n\x1b[31mprocess exited with code ${stashed.exit}\x1b[0m\r\n`);
      onExited(id, stashed.exit);
    }

    term.onData((data) => {
      if (!exitedRef.current) void ptyWrite(id, data);
    });
    term.onTitleChange((title) => onTitle(id, title));
    term.onResize(({ cols, rows }) => {
      if (!exitedRef.current) void ptyResize(id, cols, rows);
    });

    // Refit on layout changes (panel drag, window resize, split, maximize).
    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          /* zero-dimension race during layout — next tick refits */
        }
      }
    });
    observer.observe(container);
    if (container.clientWidth > 0) {
      try {
        fit.fit();
      } catch {
        /* first layout may not be measured yet */
      }
    }

    void ensurePtyListener();

    return () => {
      observer.disconnect();
      chunkWriters.set(id, null);
      exitHandlers.set(id, null);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Re-theme without recreating the session (light/dark switch).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme;
  }, [theme]);

  // Follow pane focus changes.
  useEffect(() => {
    if (focused && !findOpen) termRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  // VS Code Windows clipboard behaviour: Ctrl+C copies a selection instead of
  // sending ^C; Ctrl+V pastes natively; Ctrl+Shift+C/V always copy/paste;
  // Ctrl+F opens the find widget. Everything else goes straight to the shell.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || exitedRef.current) return true;
      const key = event.key.toLowerCase();

      if (key === 'c' && !event.shiftKey && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (key === 'c' && event.shiftKey) {
        if (term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (key === 'v' && event.shiftKey) {
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text && !exitedRef.current) term.paste(text);
          })
          .catch(() => undefined);
        return false;
      }
      if (key === 'f' && !event.shiftKey) {
        setFindOpen(true);
        return false;
      }
      return true;
    });
  }, []); // term is created once — handlers close over refs

  // Right-click: copy when there is a selection, otherwise paste (VS Code's
  // `rightClickBehavior: 'copyPaste'` default on Windows).
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const term = termRef.current;
    if (!term || exitedRef.current) return;
    if (term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection());
      term.clearSelection();
    } else {
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => undefined);
    }
  };

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  if (!isTauri()) {
    return (
      <div className="pty-pane">
        <div className="pty-view pty-view--demo">
          <p>The integrated terminal runs in the desktop app — a real PTY (ConPTY) needs Tauri.</p>
        </div>
      </div>
    );
  }

  // Clicking a pane always focuses its xterm (even if it was already the
  // active pane — otherwise keyboard input can stay stranded elsewhere,
  // e.g. right after a rename input unmounts).
  const onMouseDown = () => {
    onFocused(id);
    termRef.current?.focus();
  };

  return (
    <div className="pty-pane" onMouseDown={onMouseDown} onContextMenu={onContextMenu}>
      <div className="pty-view" ref={containerRef} />
      {findOpen && (
        <div className="pty-view__find" role="search" aria-label="Find in terminal">
          <input
            ref={findInputRef}
            className="pty-view__find-input"
            value={findQuery}
            placeholder="Find"
            spellCheck={false}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runFind(!event.shiftKey);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <button type="button" className="pty-view__find-btn" aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => runFind(false)}>
            <ChevronUp size={12} strokeWidth={1.75} />
          </button>
          <button type="button" className="pty-view__find-btn" aria-label="Next match" title="Next match (Enter)" onClick={() => runFind(true)}>
            <ChevronDown size={12} strokeWidth={1.75} />
          </button>
          <button type="button" className="pty-view__find-btn" aria-label="Close find" title="Close (Escape)" onClick={closeFind}>
            <X size={12} strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  );
}
