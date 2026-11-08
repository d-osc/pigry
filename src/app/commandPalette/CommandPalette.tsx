import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, File as FileIcon, Search } from 'lucide-react';
import { fuzzyRank, type FuzzyMatch } from '../../lib/fuzzy';
import { extractSymbols, extractWorkspaceSymbols, type SymbolItem } from '../symbolSearch';
import type { Command } from '../commands';
import './CommandPalette.css';

export type PaletteMode = 'commands' | 'files' | 'quick';

interface CommandPaletteProps {
  mode: PaletteMode;
  commands: Command[];
  /** Repository file paths (files mode only). */
  files: string[];
  filesLoading: boolean;
  onOpenFile: (path: string) => void;
  onSwitchToFiles: () => void;
  onSwitchToCommands: () => void;
  /** Recently opened file paths, newest first (quick mode). */
  recentlyOpened: string[];
  /** Open the Explorer code search, optionally seeding the query (% prefix). */
  onSearchText: (query?: string) => void;
  /** Path of the file open in the editor (for @ symbol search). */
  activeEditorPath?: string | null;
  /** Reads a worktree file (for symbol scans). */
  readFile: (path: string) => Promise<string>;
  /** Seeds the query on open (e.g. ':' for go-to-line, '>' for commands). */
  initialQuery?: string;
  onClose: () => void;
}

function disabledRow(id: string, title: string): { row: PaletteRow; match: FuzzyMatch } {
  return { row: { id, title, enabled: false, run: () => {} }, match: { indices: [], score: 0 } };
}

interface PaletteRow {
  id: string;
  title: string;
  section?: string;
  hint?: string;
  enabled: boolean;
  /** Keep the palette open after running (mode-switch rows). */
  keepOpen?: boolean;
  run: () => void;
}

export function CommandPalette({
  mode,
  commands,
  files,
  filesLoading,
  onOpenFile,
  onSwitchToFiles,
  onSwitchToCommands,
  recentlyOpened,
  onSearchText,
  activeEditorPath,
  readFile,
  initialQuery,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [activeIndex, setActiveIndex] = useState(0);
  const [editorSymbols, setEditorSymbols] = useState<SymbolItem[] | null>(null);
  const [workspaceSymbols, setWorkspaceSymbols] = useState<SymbolItem[] | null>(null);
  const [offsetInfo, setOffsetInfo] = useState<{ length: number; line: number; column: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Typing a provider prefix ('@', '#', ':', '%', '>') switches the palette
  // into quick mode even if it was opened as file/command search.
  const effectiveMode: PaletteMode =
    mode !== 'quick' && /^[::@#%>]/.test(query) ? 'quick' : mode;

  // '@' → symbols of the active editor file.
  useEffect(() => {
    if (effectiveMode !== 'quick' || !query.startsWith('@')) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      if (!activeEditorPath) {
        setEditorSymbols([]);
        return;
      }
      readFile(activeEditorPath)
        .then((content) => {
          if (!cancelled) setEditorSymbols(extractSymbols(content));
        })
        .catch(() => {
          if (!cancelled) setEditorSymbols([]);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [mode, query, effectiveMode, activeEditorPath, readFile]);

  // '#' → workspace-wide symbol scan (bounded, progressive).
  useEffect(() => {
    if (effectiveMode !== 'quick' || !query.startsWith('#')) return;
    let cancelled = false;
    const filesSnapshot = files.slice(0, 150);
    const t = window.setTimeout(() => {
      setWorkspaceSymbols(null);
      extractWorkspaceSymbols(filesSnapshot, readFile, query.slice(1), (partial) => {
        if (!cancelled) setWorkspaceSymbols(partial);
      }).then(() => {
        if (!cancelled) setWorkspaceSymbols((prev) => prev ?? []);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [mode, query, effectiveMode, files, readFile]);

  // '::' → resolve a character offset to line/column in the active file.
  useEffect(() => {
    if (effectiveMode !== 'quick' || !query.startsWith('::')) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      const offset = Number.parseInt(query.slice(2).trim(), 10);
      if (!activeEditorPath || Number.isNaN(offset) || offset < 1) {
        if (!cancelled) setOffsetInfo(null);
        return;
      }
      readFile(activeEditorPath)
        .then((content) => {
          if (cancelled) return;
          const clamped = Math.min(offset, content.length + 1);
          const lines = content.slice(0, clamped - 1).split('\n');
          setOffsetInfo({
            length: content.length,
            line: lines.length,
            column: lines[lines.length - 1].length + 1,
          });
        })
        .catch(() => {
          if (!cancelled) setOffsetInfo(null);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [mode, query, effectiveMode, activeEditorPath, readFile]);

  // In files mode the searchable key is the full path.
  const ranked: Array<{ row: PaletteRow; match: { indices: number[] } }> = useMemo(() => {
    if (effectiveMode === 'quick') {
      const jumpTo = (line: number, column = 1) => {
        onClose();
        window.dispatchEvent(new CustomEvent('orbit:goto-line', { detail: { line, column } }));
      };
      // '::' → go to character offset in the active file.
      if (query.startsWith('::')) {
        if (!activeEditorPath) {
          return [disabledRow('offset-no-editor', 'No active editor — open a file first')];
        }
        const offset = Number.parseInt(query.slice(2).trim(), 10);
        if (Number.isNaN(offset) || offset < 1) {
          return [disabledRow('offset-hint', 'Type a character offset (e.g. ::240)')];
        }
        if (offsetInfo === null) {
          return [disabledRow('offset-loading', 'Loading file…')];
        }
        if (offset > offsetInfo.length) {
          return [disabledRow('offset-oob', 'Offset beyond end of file (max ' + offsetInfo.length + ')')];
        }
        return [{
          row: {
            id: 'offset:' + offset,
            title: 'Go to offset ' + offset,
            hint: 'Ln ' + offsetInfo.line + ', Col ' + offsetInfo.column,
            enabled: true,
            run: () => jumpTo(offsetInfo.line, offsetInfo.column),
          },
          match: { indices: [], score: 0 },
        }];
      }
      // ':' → go to line/column.
      if (query.startsWith(':')) {
        if (!activeEditorPath) {
          return [disabledRow('line-no-editor', 'No active editor — open a file first')];
        }
        const parts = query.slice(1).split(':');
        const line = Number.parseInt(parts[0].trim(), 10);
        const column = parts[1] ? Number.parseInt(parts[1].trim(), 10) : 1;
        if (Number.isNaN(line) || line < 1) {
          return [disabledRow('line-hint', 'Type a line number (e.g. :42 or :42:8)')];
        }
        const col = Number.isNaN(column) || column < 1 ? 1 : column;
        return [{
          row: {
            id: 'line:' + line + ':' + col,
            title: 'Go to line ' + line + (col > 1 ? ', column ' + col : ''),
            hint: 'Enter to jump',
            enabled: true,
            run: () => jumpTo(line, col),
          },
          match: { indices: [], score: 0 },
        }];
      }
      // '@' → symbols in the active editor (flat, or grouped with '@:' / '@@').
      if (query.startsWith('@')) {
        const grouped = query.startsWith('@:') || query.startsWith('@@');
        const q = query.slice(grouped ? 2 : 1).trim().toLowerCase();
        if (!activeEditorPath) {
          return [{ row: { id: 'sym-no-editor', title: 'No active editor — open a file first', enabled: false, run: () => {} }, match: { indices: [], score: 0 } }];
        }
        if (editorSymbols === null) {
          return [{ row: { id: 'sym-loading', title: 'Loading symbols…', enabled: false, run: () => {} }, match: { indices: [], score: 0 } }];
        }
        const items = editorSymbols.filter((sym) => !q || sym.name.toLowerCase().includes(q));
        if (items.length === 0) {
          // The active file has no (matching) symbols — point the user at the
          // workspace-wide scan instead of a dead end.
          const fileLabel = activeEditorPath.split('/').pop() ?? activeEditorPath;
          return [
            { row: { id: 'sym-none', title: q ? 'No symbols matching "' + q + '" in ' + fileLabel : 'No symbols in ' + fileLabel + ' — open a source file or use #', enabled: false, run: () => {} }, match: { indices: [], score: 0 } },
            { row: { id: 'sym-workspace-fallback', title: q ? 'Search "' + q + '" in all files instead' : 'Search symbols in all files instead', hint: '#', enabled: true, keepOpen: true, run: () => setQuery(q ? '#' + q : '#') }, match: { indices: [], score: 0 } },
          ];
        }
        const jump = jumpTo;
        if (grouped) {
          const byKind = new Map<string, typeof items>();
          items.forEach((sym) => {
            const list = byKind.get(sym.kind) ?? [];
            list.push(sym);
            byKind.set(sym.kind, list);
          });
          const rows: Array<{ row: PaletteRow; match: FuzzyMatch }> = [];
          for (const [kind, list] of byKind) {
            rows.push({ row: { id: 'kind:' + kind, title: kind, section: kind, enabled: false, run: () => {} }, match: { indices: [], score: 0 } });
            list.forEach((sym) =>
              rows.push({
                row: { id: 'sym:' + kind + ':' + sym.name + ':' + sym.line, title: sym.name, hint: 'line ' + sym.line, enabled: true, run: () => jump(sym.line) },
                match: { indices: [], score: 0 },
              }),
            );
          }
          return rows;
        }
        return items.map((sym) => ({
          row: { id: 'sym:' + sym.kind + ':' + sym.name + ':' + sym.line, title: sym.name, hint: sym.kind + ' · line ' + sym.line, enabled: true, run: () => jump(sym.line) },
          match: { indices: [], score: 0 },
        }));
      }
      // '%' → hand the query to the Explorer code search.
      if (query.startsWith('%')) {
        const q = query.slice(1).trim();
        return [{
          row: {
            id: 'search-text:' + q,
            title: q ? 'Search for "' + q + '" across files' : 'Search for text across files',
            hint: 'Enter to search',
            enabled: true,
            run: () => onSearchText(q || undefined),
          },
          match: { indices: [], score: 0 },
        }];
      }
      // '#' → workspace-wide symbols.
      if (query.startsWith('#')) {
        if (workspaceSymbols === null) {
          return [{ row: { id: 'ws-loading', title: 'Searching workspace symbols…', enabled: false, run: () => {} }, match: { indices: [], score: 0 } }];
        }
        if (workspaceSymbols.length === 0) {
          return [{ row: { id: 'ws-none', title: 'No matching symbols', enabled: false, run: () => {} }, match: { indices: [], score: 0 } }];
        }
        return workspaceSymbols.filter((sym): sym is SymbolItem & { path: string } => !!sym.path).map((sym) => ({
          row: {
            id: 'ws:' + sym.path + ':' + sym.name + ':' + sym.line,
            title: sym.name,
            hint: sym.path + ':' + sym.line,
            enabled: true,
            run: () => {
              onOpenFile(sym.path);
              window.setTimeout(
                () => window.dispatchEvent(new CustomEvent('orbit:goto-line', { detail: { line: sym.line } })),
                300,
              );
            },
          },
          match: { indices: [], score: 0 },
        }));
      }
      // '>' → show and run commands.
      if (query.startsWith('>')) {
        const q = query.slice(1).trim();
        return fuzzyRank(q, commands, (c) => c.title).map(({ item, match }) => ({
          row: {
            id: item.id,
            title: item.title,
            section: item.section,
            hint: item.hint,
            enabled: item.enabled,
            run: () => item.run(),
          },
          match,
        }));
      }
      if (!query) {
        const rows: Array<{ row: PaletteRow; match: FuzzyMatch }> = [
          { row: { id: 'go-file', title: 'Go to File', hint: 'Ctrl P', enabled: true, run: () => onSwitchToFiles(), keepOpen: true }, match: { indices: [], score: 0 } },
          { row: { id: 'go-line', title: 'Go to Line/Column', hint: 'Ctrl G', enabled: true, run: () => setQuery(':'), keepOpen: true }, match: { indices: [], score: 0 } },
          { row: { id: 'go-offset', title: 'Go to Offset', hint: '::', enabled: true, run: () => setQuery('::'), keepOpen: true }, match: { indices: [], score: 0 } },
          { row: { id: 'sym-editor', title: 'Go to Symbol in Editor', hint: 'Ctrl Shift O', enabled: true, run: () => setQuery('@'), keepOpen: true }, match: { indices: [], score: 0 } },
          { row: { id: 'sym-category', title: 'Go to Symbol in Editor by Category', hint: 'Ctrl Shift O', enabled: true, run: () => setQuery('@:'), keepOpen: true }, match: { indices: [], score: 0 } },
          { row: { id: 'sym-workspace', title: 'Go to Symbol in Workspace', hint: 'Ctrl T', enabled: true, run: () => setQuery('#'), keepOpen: true }, match: { indices: [], score: 0 } },
          { row: { id: 'search-text', title: 'Search for Text', hint: '%', enabled: true, run: () => setQuery('%'), keepOpen: true }, match: { indices: [], score: 0 } },
          { row: { id: 'go-commands', title: 'Show and Run Commands', hint: 'Ctrl Shift P', enabled: true, run: () => setQuery('>'), keepOpen: true }, match: { indices: [], score: 0 } },
        ];
        for (const file of recentlyOpened) {
          rows.push({
            row: { id: 'recent:' + file, title: file, section: 'recently opened', enabled: true, run: () => onOpenFile(file) },
            match: { indices: [], score: 0 },
          });
        }
        return rows;
      }
      return fuzzyRank(query, files, (path) => path).map(({ item, match }) => ({
        row: { id: 'file:' + item, title: item, enabled: true, run: () => onOpenFile(item) },
        match,
      }));
    }
    if (effectiveMode === 'files') {
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
  }, [mode, query, commands, files, onOpenFile, onSwitchToFiles, onSwitchToCommands, recentlyOpened, onClose, onSearchText, activeEditorPath, editorSymbols, workspaceSymbols, offsetInfo, effectiveMode]);

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
    if (!row.keepOpen) onClose();
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
            placeholder={
              effectiveMode === 'quick'
                ? "Search files by name, or use ':' line · '@' symbol · '#' workspace · '%' text · '>' commands"
                : effectiveMode === 'files'
                  ? 'Go to file…'
                  : 'Type a command…'
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={mode === 'files' ? 'File search' : 'Command search'}
          />
          {(mode === 'commands' || mode === 'quick') && (
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
          {effectiveMode === 'files' && filesLoading ? (
            <div className="command-palette__empty">Loading files…</div>
          ) : ranked.length === 0 ? (
            <div className="command-palette__empty">
              {mode === 'commands' ? 'No matching commands' : 'No matching files'}
            </div>
          ) : (
            ranked.map(({ row }) => {
              // Disabled rows stay visible (dimmed) like VS Code hints,
              // but keyboard navigation only moves through `selectable`.
              const selectableIndex = selectable.findIndex((candidate) => candidate.row.id === row.id);
              const isActive = selectableIndex === clampedIndex;
              return (
                <div key={row.id}>
                  {effectiveMode !== 'files' && row.section !== lastSection && (
                    <p className="command-palette__section">{row.section}</p>
                  )}
                  {(() => {
                    lastSection = row.section;
                    return null;
                  })()}
                  <button
                    type="button"
                    className={`command-palette__item${isActive ? ' command-palette__item--active' : ''}${row.enabled ? '' : ' command-palette__item--disabled'}`}
                    data-active={isActive}
                    onMouseEnter={() => {
                      if (selectableIndex >= 0) setActiveIndex(selectableIndex);
                    }}
                    onClick={() => runRow(row)}
                  >
                    {effectiveMode === 'files' && <FileIcon size={13} />}
                    <span className="command-palette__title">{row.title}</span>
                    {row.hint && <span className="command-palette__hint">{row.hint}</span>}
                    {isActive && <CornerDownLeft size={11} className="command-palette__enter" />}
                  </button>
                </div>
              );
            })
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
