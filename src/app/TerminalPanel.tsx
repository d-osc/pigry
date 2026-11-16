/** Integrated terminal panel — VS Code-style: real PTY panes (xterm.js),
 * tab list, split, shell-profile dropdown, find, maximize.
 *
 * Terminals live in GROUPS: a group is one split tree (a lone terminal is a
 * one-leaf tree, splitting nests two panes). The pane area renders the
 * active group; the tab bar lists every terminal across groups. */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Plus,
  SquareSplitHorizontal,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  isTauri,
  ptyCreate,
  ptyKill,
  ptyListShells,
  type ShellProfile,
} from '../lib/tauriClient';
import { PtyTerminalView } from './PtyTerminalView';
import { ResizeHandle } from './ResizeHandle';
import './TerminalPanel.css';

interface TerminalPanelProps {
  /** Repository root — new terminals start here. */
  cwd: string;
  /** Panel visibility; hidden panels keep their PTY sessions + scrollback. */
  visible: boolean;
  onClose: () => void;
}

interface TerminalTab {
  /** Backend PTY session id. */
  id: number;
  /** Tab label — shell name until the shell reports an OSC title. */
  label: string;
  shellId: string;
  shellName: string;
  exited: boolean;
}

/** Binary pane tree: a leaf holds one PTY, a split holds two panes + weights. */
type PaneNode =
  | { kind: 'leaf'; id: number }
  | { kind: 'split'; splitId: number; children: [PaneNode, PaneNode]; weights: [number, number] };

interface TerminalGroup {
  id: number;
  tree: PaneNode;
}

const MIN_PANE = 80;
const HEIGHT_KEY = 'pigry:terminal-height';
const SHELL_KEY = 'pigry:terminal-shell';
let splitSeq = 1;
let groupSeq = 1;

const leaf = (id: number): PaneNode => ({ kind: 'leaf', id });
const makeSplit = (a: PaneNode, b: PaneNode): PaneNode => ({
  kind: 'split',
  splitId: splitSeq++,
  children: [a, b],
  weights: [1, 1],
});

function insertSplit(node: PaneNode, targetId: number, newId: number): PaneNode {
  if (node.kind === 'leaf') {
    return node.id === targetId ? makeSplit(node, leaf(newId)) : node;
  }
  const children = node.children.map((child) => insertSplit(child, targetId, newId)) as [PaneNode, PaneNode];
  return { ...node, children };
}

function removeLeaf(node: PaneNode, id: number): PaneNode | null {
  if (node.kind === 'leaf') return node.id === id ? null : node;
  const kept: PaneNode[] = [];
  const weights: number[] = [];
  node.children.forEach((child, index) => {
    const next = removeLeaf(child, id);
    if (next) {
      kept.push(next);
      weights.push(node.weights[index] ?? 1);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { ...node, children: kept as [PaneNode, PaneNode], weights: weights as [number, number] };
}

function adjustWeights(node: PaneNode, splitId: number, index: 0 | 1, delta: number): PaneNode {
  if (node.kind === 'leaf') return node;
  if (node.splitId === splitId) {
    const weights = [...node.weights] as [number, number];
    weights[index] = Math.max(MIN_PANE, weights[index] + delta);
    weights[1 - index] = Math.max(MIN_PANE, weights[1 - index] - delta);
    return { ...node, weights };
  }
  const children = node.children.map((child) => adjustWeights(child, splitId, index, delta)) as [PaneNode, PaneNode];
  return { ...node, children };
}

// --- xterm theme from the app tokens (Primer dark, light-aware) ------------

function terminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const bg = v('--bg-panel', '#161b22');
  const fg = v('--text-primary', '#e6edf3');
  const accent = v('--accent', '#4493f8');
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: `${accent}55`,
    // Primer dark ANSI palette.
    black: '#484f58',
    red: v('--red', '#f85149'),
    green: v('--green', '#3fb950'),
    yellow: '#d29922',
    blue: accent,
    magenta: '#db61a2',
    cyan: '#39c5cf',
    white: '#e6edf3',
    brightBlack: '#6e7681',
    brightRed: '#ff6a60',
    brightGreen: '#61d176',
    brightYellow: '#e3b341',
    brightBlue: '#6cb6ff',
    brightMagenta: '#f7a5cb',
    brightCyan: '#6fd7e0',
    brightWhite: '#ffffff',
  };
}

function useTerminalTheme(): Record<string, string> {
  const [theme, setTheme] = useState(terminalTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(terminalTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// ---------------------------------------------------------------------------

export function TerminalPanel({ cwd, visible, onClose }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [groups, setGroups] = useState<TerminalGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [lastShellId, setLastShellId] = useState<string | null>(() => localStorage.getItem(SHELL_KEY));
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [height, setHeight] = useState(() => {
    const stored = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= 140 && stored <= 600 ? stored : 280;
  });
  const [maximized, setMaximized] = useState(false);
  const theme = useTerminalTheme();
  const tabsRef = useRef<TerminalTab[]>([]);
  const groupsRef = useRef<TerminalGroup[]>([]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Kill every session when the panel unmounts (repository switch — the
  // panel is keyed by repo path, so unmount = the workspace went away).
  useEffect(() => {
    return () => {
      for (const tab of tabsRef.current) void ptyKill(tab.id);
    };
  }, []);

  const rememberHeight = useCallback((next: number) => {
    setHeight(next);
    localStorage.setItem(HEIGHT_KEY, String(Math.round(next)));
  }, []);

  const createTerminal = useCallback(
    async (shellId?: string | null) => {
      if (!isTauri()) return;
      const chosen = shellId ?? lastShellId ?? shells[0]?.id ?? null;
      try {
        const info = await ptyCreate(chosen, cwd);
        if (chosen) {
          setLastShellId(chosen);
          localStorage.setItem(SHELL_KEY, chosen);
        }
        const tab: TerminalTab = {
          id: info.id,
          label: info.label,
          shellId: chosen ?? shells[0]?.id ?? 'powershell',
          shellName: info.shellName,
          exited: false,
        };
        const group: TerminalGroup = { id: groupSeq++, tree: leaf(info.id) };
        setTabs((prev) => [...prev, tab]);
        setGroups((prev) => [...prev, group]);
        setActiveGroupId(group.id);
        setActiveId(info.id);
      } catch (error) {
        console.warn('terminal spawn failed', error);
      }
    },
    [cwd, lastShellId, shells],
  );

  // Load the shell profile list once.
  useEffect(() => {
    void ptyListShells().then(setShells).catch(() => undefined);
  }, []);

  // The first terminal spawns as soon as the panel exists (VS Code keeps at
  // least one shell around while the panel is open).
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current || !isTauri() || !cwd) return;
    bootedRef.current = true;
    void createTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const groupOf = (terminalId: number, list: TerminalGroup[]) =>
    list.find((group) => collectLeafIds(group.tree).includes(terminalId)) ?? null;

  const killTerminal = useCallback(
    (id: number) => {
      void ptyKill(id);
      const current = tabsRef.current;
      const nextTabs = current.filter((tab) => tab.id !== id);
      setTabs(nextTabs);

      // Groups that lose their last leaf die with the terminal.
      const kept: TerminalGroup[] = [];
      for (const group of groupsRef.current) {
        const tree = removeLeaf(group.tree, id);
        if (tree) kept.push({ ...group, tree });
      }
      setGroups(kept);

      if (kept.length === 0) {
        setActiveGroupId(null);
        setActiveId(null);
        if (nextTabs.length === 0) onClose();
      } else if (!kept.some((group) => group.id === activeGroupId)) {
        // Active group died — focus the neighbouring one.
        const fallback = kept[kept.length - 1];
        setActiveGroupId(fallback.id);
        setActiveId(firstLeafId(fallback.tree));
      } else if (activeId === id) {
        setActiveId(firstLeafId(kept[0].tree));
      }
    },
    [activeGroupId, activeId, onClose],
  );

  const splitActive = useCallback(
    (targetId?: number) => {
      const target = targetId ?? activeId ?? tabs[tabs.length - 1]?.id;
      if (!target) return;
      void (async () => {
        const shell = tabs.find((tab) => tab.id === target);
        try {
          const info = await ptyCreate(shell?.shellId ?? null, cwd);
          const tab: TerminalTab = {
            id: info.id,
            label: info.label,
            shellId: shell?.shellId ?? 'powershell',
            shellName: info.shellName,
            exited: false,
          };
          setTabs((prev) => [...prev, tab]);
          setGroups((prev) =>
            prev.map((group) =>
              collectLeafIds(group.tree).includes(target)
                ? { ...group, tree: insertSplit(group.tree, target, info.id) }
                : group,
            ),
          );
          setActiveId(info.id);
        } catch (error) {
          console.warn('terminal split failed', error);
        }
      })();
    },
    [activeId, cwd, tabs],
  );

  // Ctrl+Shift+` (AppShell) asks for a fresh default terminal.
  useEffect(() => {
    const onNew = () => void createTerminal();
    window.addEventListener('pigry:terminal-new', onNew);
    return () => window.removeEventListener('pigry:terminal-new', onNew);
  }, [createTerminal]);

  // Close popovers on outside interaction (ExplorerScreen context-menu pattern).
  useEffect(() => {
    if (!profileMenuOpen && !tabMenu) return;
    const close = () => {
      setProfileMenuOpen(false);
      setTabMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [profileMenuOpen, tabMenu]);

  const handleTitle = useCallback((id: number, title: string) => {
    let trimmed = title.trim();
    if (!trimmed) return;
    // PowerShell under ConPTY titles itself with its full exe path — show
    // the program name instead, the way VS Code's process title does.
    const lastSegment = trimmed.split(/[\\/]/).pop() ?? trimmed;
    if (lastSegment !== trimmed && /\.(exe|cmd|bat|ps1)$/i.test(lastSegment)) {
      trimmed = lastSegment.replace(/\.(exe|cmd|bat|ps1)$/i, '');
    }
    setTabs((prev) => prev.map((tab) => (tab.id === id && !tab.exited ? { ...tab, label: trimmed } : tab)));
  }, []);

  const handleExited = useCallback((id: number, code: number | null) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === id ? { ...tab, exited: true, label: `${tab.shellName} (exit ${code ?? '?'})` } : tab)),
    );
  }, []);

  const commitRename = useCallback(() => {
    const id = renamingId;
    const name = renameValue.trim();
    setRenamingId(null);
    if (!id || !name) return;
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, label: name } : tab)));
  }, [renamingId, renameValue]);

  const activateTab = useCallback((id: number) => {
    setActiveId(id);
    const group = groupOf(id, groupsRef.current);
    if (group) setActiveGroupId(group.id);
  }, []);

  const renderNode = (node: PaneNode): React.ReactNode => {
    if (node.kind === 'leaf') {
      return (
        <PtyTerminalView
          key={`pty-${node.id}`}
          id={node.id}
          focused={node.id === activeId}
          theme={theme}
          onFocused={setActiveId}
          onTitle={handleTitle}
          onExited={handleExited}
        />
      );
    }
    return (
      <div key={`split-${node.splitId}`} className="terminal-panel__split">
        {node.children.map((child, index) => (
          <Fragment key={child.kind === 'leaf' ? `pty-${child.id}` : `split-${child.splitId}`}>
            {index > 0 && (
              <ResizeHandle
                orientation="v"
                label="Resize terminal panes"
                onDelta={(dx) =>
                  setGroups((prev) =>
                    prev.map((group) =>
                      group.id === activeGroupId
                        ? { ...group, tree: adjustWeights(group.tree, node.splitId, (index - 1) as 0 | 1, dx) }
                        : group,
                    ),
                  )
                }
              />
            )}
            <div className="terminal-panel__pane" style={{ flexGrow: node.weights[index], flexBasis: 0, minWidth: MIN_PANE }}>
              {renderNode(child)}
            </div>
          </Fragment>
        ))}
      </div>
    );
  };

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null;
  const activeTree = groups.find((group) => group.id === activeGroupId)?.tree ?? null;
  const demo = !isTauri();

  return (
    <section
      className={`terminal-panel${visible ? '' : ' terminal-panel--hidden'}${maximized ? ' terminal-panel--max' : ''}`}
      role="region"
      aria-label="Integrated terminal"
      aria-hidden={!visible}
      style={maximized ? undefined : { height }}
    >
      {!maximized && (
        <ResizeHandle
          orientation="h"
          label="Resize terminal"
          onDelta={(_dx, dy) => rememberHeight(Math.min(600, Math.max(140, height - dy)))}
        />
      )}
      <header className="terminal-panel__tabsbar">
        <div className="terminal-panel__tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-panel__tab${tab.id === activeId ? ' terminal-panel__tab--active' : ''}${tab.exited ? ' terminal-panel__tab--exited' : ''}`}
              onMouseDown={() => activateTab(tab.id)}
              onDoubleClick={() => {
                setRenamingId(tab.id);
                setRenameValue(tab.label);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                activateTab(tab.id);
                setTabMenu({ x: event.clientX, y: event.clientY, id: tab.id });
              }}
              title={`${tab.shellName} — ${cwd}`}
            >
              {renamingId === tab.id ? (
                <input
                  className="terminal-panel__rename"
                  value={renameValue}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  spellCheck={false}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename();
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="terminal-panel__tab-btn"
                  title={`${tab.shellName} — ${cwd}`}
                >
                  <SquareTerminal size={12} strokeWidth={1.6} />
                  <span className="terminal-panel__tab-label">{tab.label}</span>
                </button>
              )}
              <button
                type="button"
                className="terminal-panel__tab-close"
                aria-label={`Kill ${tab.label}`}
                title="Kill terminal"
                onClick={(event) => {
                  event.stopPropagation();
                  killTerminal(tab.id);
                }}
              >
                <X size={11} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-panel__actions">
          <button
            type="button"
            className="terminal-panel__action"
            aria-label="Split terminal"
            title="Split terminal"
            disabled={demo || !activeTab}
            onClick={() => splitActive()}
          >
            <SquareSplitHorizontal size={13} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="terminal-panel__action"
            aria-label="Kill active terminal"
            title="Kill active terminal"
            disabled={demo || !activeTab}
            onClick={() => activeTab && killTerminal(activeTab.id)}
          >
            <Trash2 size={13} strokeWidth={1.5} />
          </button>
          <div className="terminal-panel__newgroup">
            <button
              type="button"
              className="terminal-panel__action terminal-panel__new"
              aria-label="New terminal"
              title={`New terminal (${shells.find((shell) => shell.id === lastShellId)?.name ?? shells[0]?.name ?? 'default shell'})`}
              disabled={demo}
              onClick={() => void createTerminal()}
            >
              <Plus size={13} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className="terminal-panel__action terminal-panel__newdrop"
              aria-label="Select shell profile"
              title="Select shell profile"
              disabled={demo}
              onClick={() => setProfileMenuOpen((open) => !open)}
            >
              <ChevronDown size={11} strokeWidth={1.75} />
            </button>
            {profileMenuOpen && (
              <div className="terminal-panel__profiles" role="menu">
                <div className="terminal-panel__profiles-title">Terminal profiles</div>
                {shells.map((shell) => (
                  <button
                    key={shell.id}
                    type="button"
                    className={`terminal-panel__profile${shell.id === lastShellId ? ' terminal-panel__profile--default' : ''}`}
                    role="menuitem"
                    title={shell.exe}
                    onClick={() => {
                      setProfileMenuOpen(false);
                      void createTerminal(shell.id);
                    }}
                  >
                    <SquareTerminal size={12} strokeWidth={1.6} />
                    <span>{shell.name}</span>
                    {shell.id === lastShellId && <span className="terminal-panel__profile-default">default</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="terminal-panel__action"
            aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
            title={maximized ? 'Restore panel size' : 'Maximize panel'}
            onClick={() => setMaximized((value) => !value)}
          >
            {maximized ? <ChevronDown size={13} strokeWidth={1.5} /> : <ChevronUp size={13} strokeWidth={1.5} />}
          </button>
          <button
            type="button"
            className="terminal-panel__action"
            aria-label="Close terminal panel"
            title="Close panel (stays running)"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="terminal-panel__body">
        {demo ? (
          <div className="terminal-panel__demo">
            <p>The integrated terminal runs in the desktop app — a real PTY (ConPTY) needs Tauri.</p>
          </div>
        ) : activeTree ? (
          renderNode(activeTree)
        ) : null}
      </div>

      {tabMenu && (
        <div className="context-menu" style={{ left: tabMenu.x, top: tabMenu.y }} role="menu" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const tab = tabs.find((candidate) => candidate.id === tabMenu.id);
              setTabMenu(null);
              if (tab) {
                setRenamingId(tab.id);
                setRenameValue(tab.label);
              }
            }}
          >
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const id = tabMenu.id;
              setTabMenu(null);
              splitActive(id);
            }}
          >
            Split terminal
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu__item--danger"
            onClick={() => {
              killTerminal(tabMenu.id);
              setTabMenu(null);
            }}
          >
            Kill terminal
          </button>
        </div>
      )}
    </section>
  );
}

function collectLeafIds(node: PaneNode, into: number[] = []): number[] {
  if (node.kind === 'leaf') into.push(node.id);
  else node.children.forEach((child) => collectLeafIds(child, into));
  return into;
}

function firstLeafId(node: PaneNode): number {
  return node.kind === 'leaf' ? node.id : firstLeafId(node.children[0]);
}
