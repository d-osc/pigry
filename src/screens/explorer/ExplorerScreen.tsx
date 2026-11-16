import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FoldVertical,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  ReplaceAll,
  Settings,
  SplitSquareHorizontal,
  X,
} from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { ResizeHandle } from '../../app/ResizeHandle';
import {
  getFileTree,
  readWorktreeFile,
  writeWorktreeFile,
  deleteWorktreeFile,
  renameWorktreeFile,
  deleteWorktreeFolder,
  renameWorktreeFolder,
  searchCode,
} from '../../lib/tauriClient';
import type { CodeSearchHit, FileTree as FileTreeData } from '../../types/repository';
import {
  buildSearchRegex,
  passesPathFilters,
  replaceAllInContent,
  scanWorktreeCode,
  type CodeSearchOptions,
} from '../../lib/codeSearch';
import { FileTree } from './FileTree';
import { EditorPane } from './EditorPane';
import { AiAgentPanel } from './AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import './ExplorerScreen.css';

/** One VS Code-style editor group: its own tab strip and active editor. */
interface EditorGroup {
  /** Ordered tab paths in this group. */
  tabs: string[];
  /** Selected tab of this group (falls back to its last tab). */
  active: string | null;
}

const MAX_GROUPS = 3;

interface ExplorerScreenProps {
  /** Path requested by the palette (⌘P) — opens it when it changes. */
  openPath?: string | null;
  /** Opens the commit graph focused on the given commit. */
  onJumpToCommit: (oid: string) => void;
  /** Opens the command palette in file mode (⌘P). */
  onOpenFilePalette: () => void;
  /** Integrated terminal panel visibility (rendered in the editor column). */
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
}

function languageTag(path: string): string {
  const lower = path.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  switch (ext) {
    case 'tsx': return 'TSX';
    case 'ts': return 'TS';
    case 'js': return 'JS';
    case 'jsx': return 'JSX';
    case 'json': return 'JSON';
    case 'css': return 'CSS';
    case 'rs': return 'RS';
    case 'md': return 'MD';
    default: return ext.toUpperCase().slice(0, 4) || 'FILE';
  }
}

export function ExplorerScreen({ openPath, onJumpToCommit, onOpenFilePalette, terminalOpen, onToggleTerminal }: ExplorerScreenProps) {
  const { repository, stage, unstage, discard, notify } = useRepository();
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeAttempt, setTreeAttempt] = useState(0);
  const [tree, setTree] = useState<FileTreeData | null>(null);
  // Remounted by AppShell on openPath change (key), so the initializer runs.
  // VS Code-style editor groups — each group owns a tab strip; splitting
  // copies the focused editor into a new group beside it (up to MAX_GROUPS).
  const [groups, setGroups] = useState<EditorGroup[]>(
    openPath ? [{ tabs: [openPath], active: openPath }] : [{ tabs: [], active: null }],
  );
  const [activeGroup, setActiveGroup] = useState(0);
  // Split ratios as flex-grow units (1 = equal share), one per group.
  const [groupWidths, setGroupWidths] = useState<number[]>([1]);
  const [filter, setFilter] = useState('');
  const [codeHits, setCodeHits] = useState<CodeSearchHit[] | null>(null);
  // VS Code Search view options (Aa / ab / .* / AB / include / exclude / gear).
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchPreserveCase, setSearchPreserveCase] = useState(false);
  const [searchInclude, setSearchInclude] = useState('');
  const [searchExclude, setSearchExclude] = useState('');
  const [searchUseIgnore, setSearchUseIgnore] = useState(true);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [replaceText, setReplaceText] = useState('');
  const [codeSearchError, setCodeSearchError] = useState<string | null>(null);
  const [revealTarget, setRevealTarget] = useState<{ path: string; line: number; column: number } | null>(null);
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // Right-click context menu over the file tree.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    target: { kind: 'file' | 'folder'; path: string };
  } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // Draggable column widths (px).
  const [treeWidth, setTreeWidth] = useState(288);
  // FILES panel folds away — default open, remembered across restarts.
  const [filesOpen, setFilesOpen] = useState(() => {
    try {
      return localStorage.getItem('pigry:files-open') !== '0';
    } catch {
      return true;
    }
  });
  const [aiWidth, setAiWidth] = useState(360);
  // AI rail folds away — default closed, reopen via the edge strip.
  const [aiOpen, setAiOpen] = useState(false);
  // Live editor selection — surfaced in the AI agent panel (VS Code style).
  const [editorSelection, setEditorSelection] = useState<{
    path: string;
    text: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  // History commit picked in the file-history panel — chat attaches it too.
  const [historySelection, setHistorySelection] = useState<{
    path: string;
    oid: string;
  } | null>(null);
  // Folder expansion is controlled here so the header's fold button can
  // collapse everything without effects inside the tree component.
  const [treeOverrides, setTreeOverrides] = useState<{
    added: Set<string>;
    removed: Set<string>;
  } | null>(null);

  const defaultExpanded = useMemo(() => {
    const roots = new Set<string>();
    for (const entry of tree?.entries ?? []) {
      const segment = entry.split('/')[0];
      if (entry.includes('/')) roots.add(segment);
    }
    return roots;
  }, [tree]);

  const expandedFolders = useMemo(() => {
    const set = new Set(defaultExpanded);
    const q = filter.trim().toLowerCase();
    if (q) {
      // While filtering, expand every folder on a matching path.
      for (const entry of tree?.entries ?? []) {
        if (!entry.toLowerCase().includes(q)) continue;
        const parts = entry.split('/');
        let prefix = '';
        for (const part of parts.slice(0, -1)) {
          prefix = prefix ? `${prefix}/${part}` : part;
          set.add(prefix);
        }
      }
    } else if (treeOverrides) {
      treeOverrides.added.forEach((path) => set.add(path));
      treeOverrides.removed.forEach((path) => set.delete(path));
    }
    return set;
  }, [defaultExpanded, treeOverrides, filter, tree]);

  const handleToggleFolder = useCallback(
    (path: string) => {
      setTreeOverrides((previous) => {
        const added = new Set(previous?.added ?? []);
        const removed = new Set(previous?.removed ?? []);
        const isOpen = expandedFolders.has(path);
        if (isOpen) {
          added.delete(path);
          removed.add(path);
        } else {
          added.add(path);
          removed.delete(path);
        }
        return { added, removed };
      });
    },
    [expandedFolders],
  );

  const handleCollapseAll = useCallback(() => {
    const removed = new Set<string>();
    for (const entry of tree?.entries ?? []) {
      const parts = entry.split('/');
      let prefix = '';
      for (const part of parts.slice(0, -1)) {
        prefix = prefix ? `${prefix}/${part}` : part;
        removed.add(prefix);
      }
    }
    setTreeOverrides({ added: new Set(), removed });
  }, [tree]);

  // Load the tree; reload when the working-copy summary changes so status
  // dots stay fresh after commits, saves and staging.
  const changeFingerprint = useMemo(
    () => repository?.files.map((file) => file.path).join('|') ?? '',
    [repository],
  );

  useEffect(() => {
    let cancelled = false;
    getFileTree()
      .then((result) => {
        if (!cancelled) { setTreeError(null); setTree(result); }
      })
      .catch((error: unknown) => {
        if (!cancelled) { setTreeError(error instanceof Error ? error.message : String(error)); setTree(null); }
      });
    return () => {
      cancelled = true;
    };
  }, [changeFingerprint, treeAttempt]);

  // The first file is auto-opened as an implicit tab, but once the user closes
  // every tab the Explorer stays empty until a file is picked again.
  const [closedAll, setClosedAll] = useState(false);

  const safeActiveGroup = Math.min(activeGroup, groups.length - 1);
  // Union of every explicit tab across groups (order of first appearance).
  const unionTabs = useMemo(() => {
    const seen: string[] = [];
    for (const group of groups) {
      for (const tab of group.tabs) {
        if (!seen.includes(tab)) seen.push(tab);
      }
    }
    return seen;
  }, [groups]);
  // Implicit auto-opened first file — shown until the first real tab opens.
  const implicitTab =
    !closedAll && unionTabs.length === 0 && tree?.entries.length
      ? (tree.entries[0] ?? null)
      : null;

  // Active file = the focused group's selection when still open, else its last tab.
  const focusedGroup = groups[safeActiveGroup];
  const focusedTabs =
    focusedGroup.tabs.length > 0 ? focusedGroup.tabs : implicitTab ? [implicitTab] : [];
  const activePath = focusedTabs.includes(focusedGroup.active ?? '')
    ? focusedGroup.active
    : (focusedTabs[focusedTabs.length - 1] ?? null);

  const handleSelectFile = useCallback(
    (path: string) => {
      setClosedAll(false);
      setActiveGroup(safeActiveGroup);
      setGroups((gs) =>
        gs.map((group, index) => {
          if (index !== safeActiveGroup) return group;
          if (group.tabs.includes(path)) return { ...group, active: path };
          // The auto-opened first file is implicit — keep it when a second opens.
          if (group.tabs.length === 0 && implicitTab && implicitTab !== path) {
            return { tabs: [implicitTab, path], active: path };
          }
          return { tabs: [...group.tabs, path], active: path };
        }),
      );
    },
    [safeActiveGroup, implicitTab],
  );

  const handleCloseTab = useCallback(
    (path: string) => {
      const explicit = groups.some((group) => group.tabs.includes(path));
      if (!explicit) {
        // Closing the implicit auto-opened file clears the editor.
        setClosedAll(true);
        setDirtyTabs((dirty) => {
          const next = new Set(dirty);
          next.delete(path);
          return next;
        });
        return;
      }
      setGroups((gs) => {
        let next = gs.map((group) => {
          if (!group.tabs.includes(path)) return group;
          const tabs = group.tabs.filter((tab) => tab !== path);
          return {
            tabs,
            active: group.active === path ? (tabs[tabs.length - 1] ?? null) : group.active,
          };
        });
        // A group left without tabs folds away (unless it is the only one).
        if (next.length > 1) next = next.filter((group) => group.tabs.length > 0);
        return next;
      });
      if (groups.length === 1 && focusedTabs.length <= 1) setClosedAll(true);
      setDirtyTabs((dirty) => {
        const next = new Set(dirty);
        next.delete(path);
        return next;
      });
    },
    [groups, focusedTabs.length],
  );

  // Split the focused editor into a new group beside it (VS Code style —
  // the active editor is copied, not moved).
  const handleSplitEditor = useCallback(() => {
    setGroups((gs) => {
      if (gs.length >= MAX_GROUPS) return gs;
      const index = Math.min(activeGroup, gs.length - 1);
      const source = gs[index];
      const seed = source.active ?? source.tabs[source.tabs.length - 1] ?? null;
      const next = [...gs];
      next.splice(index + 1, 0, { tabs: seed ? [seed] : [], active: seed });
      return next;
    });
    setActiveGroup((current) => Math.min(current + 1, MAX_GROUPS - 1));
    setGroupWidths((ws) => {
      const next = [...ws];
      while (next.length < groups.length + 1) next.push(1);
      return next;
    });
  }, [activeGroup, groups.length]);

  const handleCloseGroup = useCallback((index: number) => {
    setGroups((gs) => (gs.length > 1 ? gs.filter((_, i) => i !== index) : gs));
    setActiveGroup((current) => Math.max(0, current >= index ? current - 1 : current));
    setGroupWidths((ws) => {
      const next = [...ws];
      next.splice(index, 1);
      return next.length > 0 ? next : [1];
    });
  }, []);

  // Drag a tab from one group's strip onto another group to move it there.
  // The source strip is carried in the drag payload — the same file may be
  // open in several groups, so a path alone is ambiguous.
  const handleMoveTabToGroup = useCallback(
    (path: string, fromIndex: number, targetIndex: number) => {
      if (fromIndex === targetIndex || groups[fromIndex] === undefined || groups[targetIndex] === undefined)
        return;
      if (!groups[fromIndex].tabs.includes(path)) return;
      const stripped = groups.map((group, i) => {
        if (i !== fromIndex) return group;
        const tabs = group.tabs.filter((tab) => tab !== path);
        return {
          tabs,
          active: group.active === path ? (tabs[tabs.length - 1] ?? null) : group.active,
        };
      });
      const target = stripped[targetIndex];
      stripped[targetIndex] = target.tabs.includes(path)
        ? { ...target, active: path }
        : { tabs: [...target.tabs, path], active: path };
      const kept = stripped
        .map((group, i) => ({ group, i }))
        .filter(({ group }) => group.tabs.length > 0);
      const keptGroups = kept.map(({ group }) => group);
      const nextTarget = kept.findIndex(({ i }) => i === targetIndex);
      setGroups(keptGroups);
      setActiveGroup(nextTarget === -1 ? Math.min(targetIndex, keptGroups.length - 1) : nextTarget);
    },
    [groups],
  );

  // Dragging a divider shifts flex-grow units between the two neighbors.
  const groupsRowRef = useRef<HTMLDivElement | null>(null);
  const shiftGroupWidths = useCallback(
    (leftIndex: number, rightIndex: number, dx: number) => {
      setGroupWidths((ws) => {
        const widths = groups.map((_, i) => ws[i] ?? 1);
        const total = widths.reduce((sum, grow) => sum + grow, 0);
        const rowWidth = groupsRowRef.current?.clientWidth ?? 0;
        if (rowWidth <= 0) return ws;
        const delta = (dx / rowWidth) * total;
        const next = [...widths];
        next[leftIndex] = Math.max(0.12, next[leftIndex] + delta);
        next[rightIndex] = Math.max(0.12, next[rightIndex] - delta);
        return next;
      });
    },
    [groups],
  );

  // Ctrl+\ splits the focused editor right (VS Code default binding).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '\\') {
        event.preventDefault();
        handleSplitEditor();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSplitEditor]);

  const handleBufferChange = useCallback(
    (buffer: { content: string; language: string; dirty: boolean } | null, path: string) => {
      setDirtyTabs((dirty) => {
        const next = new Set(dirty);
        if (buffer?.dirty) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [],
  );

  // VS Code-style: query of 2+ chars also searches file contents. With any
  // option active (case/word/regex/include/exclude/gear) the scan runs in the
  // worktree client-side; the plain literal query keeps the fast backend path.
  useEffect(() => {
    const q = filter.trim();
    const options: CodeSearchOptions = {
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
      regex: searchRegex,
      include: searchInclude,
      exclude: searchExclude,
      useDefaultIgnores: searchUseIgnore,
    };
    const advanced =
      searchCaseSensitive ||
      searchWholeWord ||
      searchRegex ||
      searchInclude.trim() !== '' ||
      searchExclude.trim() !== '' ||
      !searchUseIgnore;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        if (q.length < 2) {
          setCodeHits(null);
          setCodeSearchError(null);
          return;
        }
        const re = buildSearchRegex(q, options);
        if (re === null && searchRegex) {
          setCodeSearchError('Invalid regular expression');
          setCodeHits([]);
          return;
        }
        setCodeSearchError(null);
        if (advanced) {
          const readFile = (path: string) =>
            readWorktreeFile(path).then((file) =>
              file.binary || file.tooLarge ? '' : file.content,
            );
          scanWorktreeCode(tree?.entries ?? [], readFile, q, options)
            .then((hits) => {
              if (!cancelled) setCodeHits(hits);
            })
            .catch(() => {
              if (!cancelled) setCodeHits([]);
            });
          return;
        }
        searchCode(q)
          .then((hits) => {
            if (!cancelled) setCodeHits(hits.filter((hit) => passesPathFilters(hit.path, options)));
          })
          .catch(() => {
            // Search failed — keep the tree visible instead of an empty list.
            if (!cancelled) setCodeHits(null);
          });
      },
      q.length < 2 ? 0 : 250,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filter, tree, searchCaseSensitive, searchWholeWord, searchRegex, searchInclude, searchExclude, searchUseIgnore]);

  // Replace All: apply the matcher to every file that had hits and write back.
  const handleReplaceAll = useCallback(async () => {
    const q = filter.trim();
    if (!q || !codeHits?.length) return;
    const options: CodeSearchOptions = {
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
      regex: searchRegex,
      include: searchInclude,
      exclude: searchExclude,
      useDefaultIgnores: searchUseIgnore,
    };
    const re = buildSearchRegex(q, options);
    if (!re) {
      notify('Invalid regular expression', 'error');
      return;
    }
    const paths = [...new Set(codeHits.map((hit) => hit.path))];
    let filesChanged = 0;
    let total = 0;
    try {
      for (const path of paths) {
        const file = await readWorktreeFile(path);
        if (file.binary || file.tooLarge) continue;
        const result = replaceAllInContent(file.content, re, replaceText, {
          preserveCase: searchPreserveCase,
          isRegex: searchRegex,
        });
        if (result.count > 0) {
          await writeWorktreeFile(path, result.content);
          filesChanged += 1;
          total += result.count;
        }
      }
    } catch {
      notify('Replace failed — some files could not be written', 'error');
      return;
    }
    if (total > 0) {
      getFileTree()
        .then(setTree)
        .catch(() => {});
      notify(
        `Replaced ${total} occurrence${total === 1 ? '' : 's'} in ${filesChanged} file${filesChanged === 1 ? '' : 's'}`,
        'success',
      );
    } else {
      notify('Nothing to replace', 'error');
    }
  }, [filter, codeHits, replaceText, searchCaseSensitive, searchWholeWord, searchRegex, searchPreserveCase, searchInclude, searchExclude, searchUseIgnore, notify]);

  const groupedHits = useMemo(() => {
    if (!codeHits) return [];
    const map = new Map<string, CodeSearchHit[]>();
    for (const hit of codeHits) {
      const list = map.get(hit.path) ?? [];
      list.push(hit);
      map.set(hit.path, list);
    }
    return [...map.entries()];
  }, [codeHits]);

  const openSearchHit = useCallback((hit: CodeSearchHit) => {
    setRevealTarget({ path: hit.path, line: hit.line, column: hit.column });
    handleSelectFile(hit.path);
  }, [handleSelectFile]);

  // Explorer search box can be focused from the Quick Open palette
  // ("Search for Text") — AppShell switches to this screen first.
  useEffect(() => {
    const onFocusSearch = (event: Event) => {
      const detail = (event as CustomEvent<{ query?: string | null }>).detail;
      if (detail?.query != null) setFilter(String(detail.query));
      filterInputRef.current?.focus();
    };
    window.addEventListener('pigry:focus-file-search', onFocusSearch);
    return () => window.removeEventListener('pigry:focus-file-search', onFocusSearch);
  }, []);

  // Open a file (optionally at a line) from anywhere — AI panel tool chips.
  // AppShell switches to this screen first, then dispatches after the mount.
  useEffect(() => {
    const onOpenFile = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; line?: number }>).detail;
      if (!detail?.path) return;
      handleSelectFile(detail.path);
      if (detail.line) {
        setRevealTarget({ path: detail.path, line: detail.line, column: 1 });
      }
    };
    window.addEventListener('pigry:open-file', onOpenFile);
    return () => window.removeEventListener('pigry:open-file', onOpenFile);
  }, [handleSelectFile]);

  // Go-to-line from the Quick Open palette (':' prefix).
  useEffect(() => {
    const onGotoLine = (event: Event) => {
      const detail = (event as CustomEvent<{ line?: number; column?: number }>).detail;
      if (!detail?.line || !activePath) return;
      setRevealTarget({
        path: activePath,
        line: detail.line,
        column: detail.column ?? 1,
      });
    };
    window.addEventListener('pigry:goto-line', onGotoLine);
    return () => window.removeEventListener('pigry:goto-line', onGotoLine);
  }, [activePath]);

  // Tell the Quick Open palette which file the editor shows ('@' symbols).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('pigry:active-editor', { detail: { path: activePath } }));
  }, [activePath]);

  // ⌘F / Ctrl+F focuses the file filter (matches the kbd hint).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // New file / new folder — created inside the active file's folder (or the
  // repository root), then the tree reloads and the file opens in a tab.
  const handleCreateFile = useCallback(
    async (asFolder: boolean, targetDir?: string) => {
      const baseDir =
        targetDir ??
        (activePath?.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/')) : '');
      let candidate = asFolder ? `${baseDir ? `${baseDir}/` : ''}new-folder/.gitkeep` : `${baseDir ? `${baseDir}/` : ''}untitled.txt`;
      let counter = 1;
      const taken = new Set(tree?.entries ?? []);
      while (taken.has(candidate)) {
        counter += 1;
        candidate = asFolder
          ? `${baseDir ? `${baseDir}/` : ''}new-folder-${counter}/.gitkeep`
          : `${baseDir ? `${baseDir}/` : ''}untitled-${counter}.txt`;
      }
      try {
        await writeWorktreeFile(candidate, '');
        const next = await getFileTree();
        setTree(next);
        handleSelectFile(candidate);
      } catch {
        // The write failed (read-only demo, locked file) — nothing to open.
      }
    },
    [activePath, tree, handleSelectFile],
  );

  // Context-menu state — closes on Escape / outside click.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const openContextMenu = useCallback(
    (target: { kind: 'file' | 'folder'; path: string }, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({ x: event.clientX, y: event.clientY, target });
    },
    [],
  );

  const fileEntry = contextMenu?.target.kind === 'file'
    ? repository?.files.find((file) => file.path === contextMenu.target.path)
    : undefined;

  const handleMove = useCallback(
    async (sourcePath: string, targetFolder: string) => {
      if (!sourcePath || sourcePath === targetFolder || targetFolder.startsWith(`${sourcePath}/`)) {
        return;
      }
      const base = sourcePath.split('/').pop() ?? sourcePath;
      const newPath = targetFolder ? `${targetFolder}/${base}` : base;
      if (newPath === sourcePath) return;
      const isFolder = (tree?.entries ?? []).some(
        (entry) => entry === sourcePath || entry.startsWith(`${sourcePath}/`),
      );
      try {
        if (isFolder) {
          await renameWorktreeFolder(sourcePath, newPath);
        } else {
          await renameWorktreeFile(sourcePath, newPath);
        }
        setTree(await getFileTree());
        const remap = (tab: string) => {
          if (tab === sourcePath) return newPath;
          if (isFolder && tab.startsWith(`${sourcePath}/`)) {
            return `${newPath}/${tab.slice(sourcePath.length + 1)}`;
          }
          return tab;
        };
        setGroups((gs) =>
          gs.map((group) => ({
            tabs: group.tabs.map(remap),
            active: group.active ? remap(group.active) : group.active,
          })),
        );
        notify(`Moved to ${newPath}`, 'success');
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
    [tree, notify],
  );

  // Remember the FILES panel fold state.
  useEffect(() => {
    try {
      localStorage.setItem('pigry:files-open', filesOpen ? '1' : '0');
    } catch {
      // storage unavailable — session-only
    }
  }, [filesOpen]);

  // VS Code reveal: keep the active file's parents expanded so its row
  // stays visible in the tree.
  useEffect(() => {
    if (!activePath) return;
    const t = window.setTimeout(() => {
      setTreeOverrides((previous) => {
        const added = new Set(previous?.added ?? []);
        const parts = activePath.split('/');
        let prefix = '';
        for (const part of parts.slice(0, -1)) {
          prefix = prefix ? `${prefix}/${part}` : part;
          added.add(prefix);
        }
        return { added, removed: previous?.removed ?? new Set() };
      });
    }, 0);
    return () => window.clearTimeout(t);
  }, [activePath]);

  const handleRename = useCallback(
    async (oldPath: string, newName: string, kind: 'file' | 'folder') => {
      setRenamingPath(null);
      const oldName = oldPath.split('/').pop() ?? oldPath;
      if (!newName || newName === oldName) return;
      const dir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
      const newPath = `${dir ? `${dir}/` : ''}${newName}`;
      try {
        if (kind === 'folder') {
          await renameWorktreeFolder(oldPath, newPath);
        } else {
          await renameWorktreeFile(oldPath, newPath);
        }
        setTree(await getFileTree());
        // Move open tabs / dirty markers under the renamed path.
        const remap = (tab: string) => {
          if (tab === oldPath) return newPath;
          if (kind === 'folder' && tab.startsWith(`${oldPath}/`)) {
            return `${newPath}/${tab.slice(oldPath.length + 1)}`;
          }
          return tab;
        };
        setGroups((gs) =>
          gs.map((group) => ({
            tabs: group.tabs.map(remap),
            active: group.active ? remap(group.active) : group.active,
          })),
        );
        setDirtyTabs((dirty) => {
          const next = new Set<string>();
          dirty.forEach((tab) => next.add(remap(tab)));
          return next;
        });
      } catch {
        // Rename refused (missing/occupied path) — keep the old name.
      }
    },
    [],
  );

  const handleDelete = useCallback(
    async (path: string, kind: 'file' | 'folder') => {
      try {
        if (kind === 'folder') {
          await deleteWorktreeFolder(path);
        } else {
          await deleteWorktreeFile(path);
        }
      } catch {
        return;
      }
      setTree(await getFileTree());
      const underPath = (tab: string) =>
        tab === path || (kind === 'folder' && tab.startsWith(`${path}/`));
      setGroups((gs) =>
        gs.map((group) => {
          const tabs = group.tabs.filter((tab) => !underPath(tab));
          return {
            tabs,
            active: group.active && !underPath(group.active) ? group.active : null,
          };
        }),
      );
      setDirtyTabs((dirty) => {
        if (![...dirty].some(underPath)) return dirty;
        const next = new Set(dirty);
        [...dirty].filter(underPath).forEach((tab) => next.delete(tab));
        return next;
      });
    },
    [],
  );

  const folderCount = useMemo(() => {
    const dirs = new Set<string>();
    for (const entry of tree?.entries ?? []) {
      const parts = entry.split('/');
      parts.pop();
      let prefix = '';
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        dirs.add(prefix);
      }
    }
    return dirs.size;
  }, [tree]);

  const repoName = repository?.name ?? 'platform';

  return (
    <div className="explorer-screen">
      <header className="explorer-screen__bar">
        <h1 className="explorer-screen__title">Explorer</h1>
        <span className="explorer-screen__subtitle">Browse and edit repository files</span>
        <div className="explorer-screen__bar-actions">
          {dirtyTabs.size > 0 && (
            <span className="explorer-screen__unsaved">
              <i />
              {dirtyTabs.size} unsaved file{dirtyTabs.size === 1 ? '' : 's'}
            </span>
          )}
          <span className="explorer-screen__count">
            {tree ? `${tree.entries.length} files` : ''}
          </span>
          <button type="button" className="outline-button" onClick={onOpenFilePalette}>
            Open file <kbd className="explorer-screen__kbd">⌘ P</kbd>
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => window.dispatchEvent(new CustomEvent('pigry:save-file'))}
          >
            Save file <kbd className="explorer-screen__kbd explorer-screen__kbd--inverted">⌘ S</kbd>
          </button>
        </div>
      </header>
      <div className="explorer-screen__body">
        {filesOpen ? (
        <aside className="explorer-screen__tree" style={{ width: treeWidth }}>
          <div className="explorer-tree-head">
            <span>Files</span>
            <div className="explorer-tree-head__actions">
              <button
                type="button"
                aria-label="New file"
                title="New file (in the selected folder)"
                onClick={() => void handleCreateFile(false)}
              >
                <FilePlus2 size={13} strokeWidth={1.25} />
              </button>
              <button
                type="button"
                aria-label="New folder"
                title="New folder (with .gitkeep)"
                onClick={() => void handleCreateFile(true)}
              >
                <FolderPlus size={13} strokeWidth={1.25} />
              </button>
              <button
                type="button"
                aria-label="Refresh"
                title="Refresh file tree"
                onClick={() => {
                  void getFileTree()
                    .then(setTree)
                    .catch(() => {});
                }}
              >
                <RefreshCw size={13} strokeWidth={1.25} />
              </button>
              <button
                type="button"
                aria-label="Collapse all folders"
                title="Collapse all folders"
                onClick={handleCollapseAll}
              >
                <FoldVertical size={13} strokeWidth={1.25} />
              </button>
              <button
                type="button"
                aria-label="Collapse FILES panel"
                title="Hide FILES panel"
                onClick={() => setFilesOpen(false)}
              >
                <ChevronLeft size={13} strokeWidth={1.25} />
              </button>
            </div>
          </div>
          <div className="search-view">
            <div className="search-view__row">
              <button
                type="button"
                className="search-view__chevron"
                aria-label={searchExpanded ? 'Hide replace and file filters' : 'Show replace and file filters'}
                title={searchExpanded ? 'Hide Replace' : 'Toggle Replace'}
                onClick={() => setSearchExpanded((value) => !value)}
              >
                <ChevronRight
                  size={14}
                  strokeWidth={1.5}
                  className={`search-view__chevron-icon${searchExpanded ? ' search-view__chevron-icon--open' : ''}`}
                />
              </button>
              <input
                ref={filterInputRef}
                placeholder="Search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                aria-label="Search files"
                spellCheck={false}
              />
              <button
                type="button"
                className={`search-view__toggle${searchCaseSensitive ? ' search-view__toggle--on' : ''}`}
                title="Match Case"
                aria-label="Match case"
                aria-pressed={searchCaseSensitive}
                onClick={() => setSearchCaseSensitive((value) => !value)}
              >
                Aa
              </button>
              <button
                type="button"
                className={`search-view__toggle${searchWholeWord ? ' search-view__toggle--on' : ''}`}
                title="Match Whole Word"
                aria-label="Match whole word"
                aria-pressed={searchWholeWord}
                onClick={() => setSearchWholeWord((value) => !value)}
              >
                ab
              </button>
              <button
                type="button"
                className={`search-view__toggle${searchRegex ? ' search-view__toggle--on' : ''}`}
                title="Use Regular Expression"
                aria-label="Use regular expression"
                aria-pressed={searchRegex}
                onClick={() => setSearchRegex((value) => !value)}
              >
                .*
              </button>
              {filter && (
                <button
                  type="button"
                  className="search-view__clear"
                  aria-label="Clear search"
                  onClick={() => {
                    setFilter('');
                    filterInputRef.current?.focus();
                  }}
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              )}
            </div>
            {searchExpanded && (
              <div className="search-view__extra">
                <div className="search-view__row">
                  <input
                    placeholder="Replace"
                    value={replaceText}
                    onChange={(event) => setReplaceText(event.target.value)}
                    aria-label="Replace"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className={`search-view__toggle${searchPreserveCase ? ' search-view__toggle--on' : ''}`}
                    title="Preserve Case"
                    aria-label="Preserve case"
                    aria-pressed={searchPreserveCase}
                    onClick={() => setSearchPreserveCase((value) => !value)}
                  >
                    AB
                  </button>
                  <button
                    type="button"
                    className="search-view__toggle search-view__toggle--primary"
                    title="Replace All"
                    aria-label="Replace all"
                    disabled={!filter.trim() || !codeHits?.length}
                    onClick={() => void handleReplaceAll()}
                  >
                    <ReplaceAll size={14} strokeWidth={1.5} />
                  </button>
                </div>
                <input
                  className="search-view__files"
                  placeholder="files to include"
                  value={searchInclude}
                  onChange={(event) => setSearchInclude(event.target.value)}
                  aria-label="Files to include"
                  spellCheck={false}
                />
                <div className="search-view__row">
                  <input
                    placeholder="files to exclude"
                    value={searchExclude}
                    onChange={(event) => setSearchExclude(event.target.value)}
                    aria-label="Files to exclude"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className={`search-view__toggle${searchUseIgnore ? ' search-view__toggle--on' : ''}`}
                    title="Use Default Ignore Rules (node_modules, dist, target…)"
                    aria-label="Use default ignore rules"
                    aria-pressed={searchUseIgnore}
                    onClick={() => setSearchUseIgnore((value) => !value)}
                  >
                    <Settings size={14} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            )}
          </div>
          {codeHits ? (
            <div className="code-results">
              {codeSearchError && <p className="code-results__error">{codeSearchError}</p>}
              <p className="code-results__summary">
                {codeHits.length} result{codeHits.length === 1 ? '' : 's'} in{' '}
                {groupedHits.length} file{groupedHits.length === 1 ? '' : 's'}
              </p>
              {codeHits.length === 0 && (
                <p className="code-results__empty">No matches found in file contents.</p>
              )}
              {groupedHits.map(([path, hits]) => (
                <section key={path} className="code-results__file">
                  <p className="code-results__path" title={path}>
                    {path}
                    <span className="code-results__count">{hits.length}</span>
                  </p>
                  {hits.map((hit) => {
                    const hitRe = buildSearchRegex(filter, {
                      caseSensitive: searchCaseSensitive,
                      wholeWord: searchWholeWord,
                      regex: searchRegex,
                    });
                    const lineMatch = hitRe ? hitRe.exec(hit.text) : null;
                    const at = lineMatch ? lineMatch.index : -1;
                    const matchedLen = lineMatch ? lineMatch[0].length : filter.trim().length;
                    const head = at > 0 ? hit.text.slice(Math.max(0, at - 20), at) : '';
                    const start = at > 0 ? Math.max(0, at - 20) : 0;
                    const match = hit.text.slice(start, at + matchedLen);
                    const tail = hit.text.slice(at + matchedLen, at + matchedLen + 60);
                    return (
                      <button
                        key={`${hit.line}-${hit.column}`}
                        type="button"
                        className="code-results__line"
                        onClick={() => openSearchHit(hit)}
                        title={`${path}:${hit.line}`}
                      >
                        <span className="code-results__ln">{hit.line}</span>
                        <code>
                          {head}
                          <mark>{match}</mark>
                          {tail}
                        </code>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          ) : (
          <>
          {treeError && <div className="code-results__error" role="alert">{treeError}<button className="outline-button" onClick={() => setTreeAttempt((n) => n + 1)}>Try again</button></div>}
          <FileTree
            tree={tree}
            selectedPath={activePath}
            onSelect={handleSelectFile}
            filter={filter.trim().toLowerCase()}
            repoName={repository?.name}
            branch={repository?.currentBranch}
            expanded={expandedFolders}
            onToggleFolder={handleToggleFolder}
            onItemContextMenu={openContextMenu}
            renamingPath={renamingPath}
            onRenameSubmit={(path, name) => {
              const isFolder = (tree?.entries ?? []).some(
                (entry) => entry === path || entry.startsWith(`${path}/`),
              );
              void handleRename(path, name, isFolder ? 'folder' : 'file');
            }}
            onRenameCancel={() => setRenamingPath(null)}
            onMove={(sourcePath, targetFolder) => void handleMove(sourcePath, targetFolder)}
            revealPath={activePath}
          />
          </>
          )}
          <div className="explorer-tree-foot">
            <span>
              {tree ? `${tree.entries.length} files · ${folderCount} folders` : ''}
            </span>
            {tree && tree.changed.length > 0 && (
              <span className="explorer-tree-foot--modified">
                {tree.changed.length} working changes
              </span>
            )}
            {tree && tree.unpushedPaths.length > 0 && (
              <span className="explorer-tree-foot--unpushed" title="Files touched by commits that have not been pushed">
                ↑ {tree.unpushedPaths.length} unpushed
              </span>
            )}
          </div>
        </aside>
        ) : (
          <button
            type="button"
            className="files-strip"
            aria-label="Show FILES panel"
            title="Show FILES panel"
            onClick={() => setFilesOpen(true)}
          >
            <ChevronRight size={13} strokeWidth={1.5} />
            <span>FILES</span>
          </button>
        )}

        {filesOpen && (
          <ResizeHandle
            orientation="v"
            label="Resize file tree"
            onDelta={(dx) =>
              setTreeWidth((w) => Math.min(440, Math.max(200, w + dx)))
            }
          />
        )}

        <div className="explorer-screen__groups" ref={groupsRowRef}>
          {unionTabs.length === 0 && !implicitTab ? (
            <div className="explorer-screen__placeholder">Select a file to open it</div>
          ) : (
            groups.map((group, index) => {
              const focused = index === safeActiveGroup;
              const tabs =
                group.tabs.length > 0 ? group.tabs : implicitTab ? [implicitTab] : [];
              const groupActive = tabs.includes(group.active ?? '')
                ? group.active
                : (tabs[tabs.length - 1] ?? null);
              return (
                <Fragment key={index}>
                  {index > 0 && (
                    <ResizeHandle
                      orientation="v"
                      label="Resize editor split"
                      onDelta={(dx) => shiftGroupWidths(index - 1, index, dx)}
                    />
                  )}
                  <section
                    className={`explorer-screen__editor-col${focused ? ' explorer-screen__editor-col--focused' : ''}`}
                    style={{ flexGrow: groupWidths[index] ?? 1 }}
                    onMouseDown={() => setActiveGroup(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      const dropped = event.dataTransfer.getData('text/pigry-tab');
                      if (!dropped) return;
                      const from = Number(
                        event.dataTransfer.getData('text/pigry-tab-group'),
                      );
                      handleMoveTabToGroup(
                        dropped,
                        Number.isFinite(from) ? from : index,
                        index,
                      );
                    }}
                  >
                    <div className="explorer-tabs" role="tablist">
                      {tabs.map((path) => {
                        const name = path.split('/').pop() ?? path;
                        const active = path === groupActive;
                        const dirty = dirtyTabs.has(path);
                        return (
                          <button
                            key={path}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            className={`explorer-tab${active ? ' explorer-tab--active' : ''}`}
                            draggable
                            onDragStart={(event) => {
                              event.dataTransfer.setData('text/pigry-tab', path);
                              event.dataTransfer.setData(
                                'text/pigry-tab-group',
                                String(index),
                              );
                            }}
                            onClick={() => {
                              setActiveGroup(index);
                              setGroups((gs) =>
                                gs.map((g, i) =>
                                  i === index ? { ...g, active: path } : g,
                                ),
                              );
                            }}
                          >
                            <span className="explorer-tab__lang">{languageTag(path)}</span>
                            <span className="explorer-tab__name">{name}</span>
                            {dirty && <i className="explorer-tab__dirty" />}
                            <span
                              className="explorer-tab__close"
                              role="button"
                              aria-label={`Close ${name}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleCloseTab(path);
                              }}
                            >
                              <X size={11} strokeWidth={1.75} />
                            </span>
                          </button>
                        );
                      })}
                      {index === groups.length - 1 && (
                        <span
                          className="explorer-tabs__repo"
                          title={`Root folder · branch ${repository?.currentBranch ?? ''}`}
                        >
                          <FolderOpen size={12} strokeWidth={1.25} />
                          {repoName}
                        </span>
                      )}
                      <span className="explorer-tabs__spacer" />
                      {groups.length < MAX_GROUPS && (
                        <button
                          type="button"
                          className="explorer-tabs__action"
                          aria-label="Split editor right"
                          title="Split editor right (Ctrl+\)"
                          onClick={handleSplitEditor}
                        >
                          <SplitSquareHorizontal size={12} strokeWidth={1.5} />
                        </button>
                      )}
                      {groups.length > 1 && (
                        <button
                          type="button"
                          className="explorer-tabs__action"
                          aria-label="Close editor group"
                          title="Close editor group"
                          onClick={() => handleCloseGroup(index)}
                        >
                          <X size={12} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                    {groupActive ? (
                      <EditorPane
                        key={`${index}:${groupActive}`}
                        path={groupActive}
                        revealLine={
                          focused && revealTarget?.path === groupActive
                            ? revealTarget.line
                            : null
                        }
                        revealColumn={
                          focused && revealTarget?.path === groupActive
                            ? revealTarget.column
                            : null
                        }
                        terminalOpen={focused ? terminalOpen : false}
                        onToggleTerminal={onToggleTerminal}
                        onBufferChange={handleBufferChange}
                        onJumpToCommit={onJumpToCommit}
                        onSelectionChange={setEditorSelection}
                        onHistorySelect={setHistorySelection}
                      />
                    ) : (
                      <div className="explorer-screen__placeholder">
                        Select a file to open it
                      </div>
                    )}
                  </section>
                </Fragment>
              );
            })
          )}
        </div>

        {aiOpen && (
          <ResizeHandle
            orientation="v"
            label="Resize AI panel"
            onDelta={(dx) => setAiWidth((w) => Math.min(480, Math.max(280, w - dx)))}
          />
        )}

        {/* The AI rail folds away — the edge strip reopens it. It stays even
            when every editor tab is closed (chip falls back to the repo name). */}
        {aiOpen ? (
          <AiAgentPanel
            width={aiWidth}
            fileName={
              activePath ? (activePath.split('/').pop() ?? activePath) : (repository?.name ?? 'platform')
            }
            selection={editorSelection}
            defaultTeam={teamForScreen('explorer')}
            onCollapse={() => setAiOpen(false)}
            onOpenFile={(path, line) => {
              handleSelectFile(path);
              if (line) setRevealTarget({ path, line, column: 1 });
            }}
            historySelection={historySelection}
          />
        ) : (
          <button
            type="button"
            className="ai-rail-strip"
            title="Show AI Agent panel"
            onClick={() => setAiOpen(true)}
          >
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          ref={(el) => {
            // Keep the menu inside the window when opened near an edge.
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const maxX = window.innerWidth - rect.width - 8;
            const maxY = window.innerHeight - rect.height - 8;
            el.style.left = `${Math.max(8, Math.min(contextMenu.x, maxX))}px`;
            el.style.top = `${Math.max(8, Math.min(contextMenu.y, maxY))}px`;
          }}
        >
          {contextMenu.target.kind === 'file' ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  handleSelectFile(contextMenu.target.path);
                  setContextMenu(null);
                }}
              >
                Open
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard?.writeText(contextMenu.target.path);
                  setContextMenu(null);
                }}
              >
                Copy path
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRenamingPath(contextMenu.target.path);
                  setContextMenu(null);
                }}
              >
                Rename…
              </button>
              {fileEntry && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void (fileEntry.staged
                      ? unstage([contextMenu.target.path])
                      : stage([contextMenu.target.path]));
                    setContextMenu(null);
                  }}
                >
                  {fileEntry.staged ? 'Unstage file' : 'Stage file'}
                </button>
              )}
              {fileEntry && !fileEntry.untracked && (
                <button
                  type="button"
                  role="menuitem"
                  className="context-menu__item--danger"
                  onClick={() => {
                    void discard(contextMenu.target.path);
                    setContextMenu(null);
                  }}
                >
                  Discard changes
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="context-menu__item--danger"
                onClick={() => {
                  void handleDelete(contextMenu.target.path, 'file');
                  setContextMenu(null);
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void handleCreateFile(false, contextMenu.target.path);
                  setContextMenu(null);
                }}
              >
                New file here
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void handleCreateFile(true, contextMenu.target.path);
                  setContextMenu(null);
                }}
              >
                New folder here
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  handleCollapseAll();
                  setContextMenu(null);
                }}
              >
                Collapse all
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRenamingPath(contextMenu.target.path);
                  setContextMenu(null);
                }}
              >
                Rename…
              </button>
              <button
                type="button"
                role="menuitem"
                className="context-menu__item--danger"
                onClick={() => {
                  void handleDelete(contextMenu.target.path, 'folder');
                  setContextMenu(null);
                }}
              >
                Delete folder
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
