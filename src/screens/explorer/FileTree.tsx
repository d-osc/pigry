import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { buildTree, flattenVisibleTree, type TreeNode } from '../../lib/fileTree';
import type { FileTree as FileTreeData } from '../../types/repository';
import './FileTree.css';

interface FileTreeProps {
  tree: FileTreeData | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Case-insensitive substring filter over full paths. */
  filter?: string;
  /** Repository name + branch for the root folder row. */
  repoName?: string;
  branch?: string;
  /** Currently expanded folder paths (controlled by the Explorer screen). */
  expanded: Set<string>;
  onToggleFolder: (path: string) => void;
  /** Right-click on a row — the Explorer screen renders the context menu. */
  onItemContextMenu?: (
    target: { kind: 'file' | 'folder'; path: string },
    event: React.MouseEvent,
  ) => void;
  /** When set, this file row turns into an inline rename input. */
  renamingPath?: string | null;
  onRenameSubmit?: (path: string, newName: string) => void;
  onRenameCancel?: () => void;
  /** Move a file/folder to a target folder (VS Code drag & drop). */
  onMove?: (sourcePath: string, targetFolder: string) => void;
  /** Bump when a file is opened externally — reveals + scrolls to its row. */
  revealPath?: string | null;
}

/**
 * File/folder icons from the Material Icon Theme (MIT)
 * https://github.com/material-extensions/vscode-material-icon-theme
 */
const FILE_ICONS: Record<string, string> = {
  '.gitignore': 'git',
  tsx: 'react_ts',
  ts: 'typescript',
  jsx: 'react',
  js: 'javascript',
  css: 'css',
  md: 'markdown',
  rs: 'rust',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  lock: 'lock',
  html: 'html',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  sh: 'console',
  txt: 'license',
};

/** Special whole-name overrides (checked before the extension). */
const FILE_NAME_ICONS: Record<string, string> = {
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'vite.config.ts': 'vite',
  'webpack.config.js': 'webpack',
  'webpack.config.ts': 'webpack',
  'readme.md': 'readme',
  'license': 'license',
  'license.md': 'license',
};

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  const named = FILE_NAME_ICONS[lower];
  if (named) return `/fileicons/${named}.svg`;
  if (lower.startsWith('tsconfig')) return '/fileicons/tsconfig.svg';
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  const mapped = FILE_ICONS[ext];
  return `/fileicons/${mapped ?? 'license'}.svg`;
}

const FOLDER_ICONS: Record<string, string> = {
  src: 'folder-src',
  'src-tauri': 'folder-src-tauri',
  app: 'folder-app',
  components: 'folder-components',
  tests: 'folder-test',
  test: 'folder-test',
  lib: 'folder-lib',
  utils: 'folder-utils',
  config: 'folder-config',
  dist: 'folder-dist',
  public: 'folder-public',
};

function folderIcon(name: string): string {
  return `/fileicons/${FOLDER_ICONS[name.toLowerCase()] ?? 'folder-base'}.svg`;
}

function TreeRow({
  node,
  depth,
  selectedPath,
  statusMap,
  unpushedSet,
  expanded,
  onToggle,
  onSelect,
  onContextMenu,
  renaming,
  onRenameSubmit,
  onRenameCancel,
  onMove,
  revealPath,
  flat = false,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  statusMap: Map<string, string>;
  unpushedSet: Set<string>;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu?: (
    target: { kind: 'file' | 'folder'; path: string },
    event: React.MouseEvent,
  ) => void;
  renaming?: boolean;
  onRenameSubmit?: (path: string, newName: string) => void;
  onRenameCancel?: () => void;
  onMove?: (sourcePath: string, targetFolder: string) => void;
  revealPath?: string | null;
  flat?: boolean;
}) {
  // Drag state for DnD move (VS Code style: file/folder onto a folder row).
  const [dropTarget, setDropTarget] = useState(false);
  const isFolder = node.kind === 'folder';
  const isOpen = isFolder && expanded.has(node.path);
  // Guards the rename input against the phantom blur that fires when the
  // context menu unmounts in the same commit.
  const hadFocus = useRef(false);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const isSelected = !isFolder && selectedPath === node.path;
  const fileStatus = !isFolder ? statusMap.get(node.path) : undefined;
  const unpushed = !isFolder && unpushedSet.has(node.path);
  const iconSrc = isFolder ? folderIcon(node.name) : fileIcon(node.name);

  // Reveal: scroll this row into view when it is the requested reveal target.
  useEffect(() => {
    if (revealPath && node.path === revealPath) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [revealPath, node.path]);

  const handleClick = () => {
    if (isFolder) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  const rowIcons = (
    <>
      {Array.from({ length: depth }).map((_, index) => (
        <i key={index} className="tree-row__guide" aria-hidden="true" />
      ))}
      {isFolder ? (
        isOpen ? <ChevronDown size={8.5} strokeWidth={1.5} /> : <ChevronRight size={8.5} strokeWidth={1.5} />
      ) : null}
      <img className="tree-row__fileicon" src={iconSrc} alt="" draggable={false} />
    </>
  );

  // While renaming, the row becomes a plain div — nesting the input inside
  // the row button steals its focus (invalid interactive nesting).
  if (renaming) {
    return (
      <>
        <div
          className={`tree-row tree-row--renaming${isFolder ? ' tree-row--folder' : ''}${isSelected ? ' tree-row--selected' : ''}`}
          data-path={node.path}
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          {rowIcons}
          <input
            className="tree-row__rename"
            defaultValue={node.name}
            autoFocus
            spellCheck={false}
            aria-label="New name"
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRenameSubmit?.(node.path, (event.target as HTMLInputElement).value.trim());
              if (event.key === 'Escape') onRenameCancel?.();
            }}
            onFocus={() => {
              hadFocus.current = true;
            }}
            onBlur={() => {
              if (hadFocus.current) onRenameCancel?.();
            }}
          />
        </div>
        {!flat && isFolder && isOpen && (
          <>
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                statusMap={statusMap} unpushedSet={unpushedSet}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                renaming={false}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
              />
            ))}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <button
        ref={rowRef}
        data-path={node.path}
        type="button"
        className={`tree-row${isFolder ? ' tree-row--folder' : ''}${isSelected ? ' tree-row--selected' : ''}${dropTarget ? ' tree-row--droptarget' : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={handleClick}
        draggable={onMove != null}
        onDragStart={(event) => {
          event.dataTransfer.setData('application/pigry-move', node.path);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          if (!isFolder || !onMove) return;
          const dragged = event.dataTransfer.getData('application/pigry-move');
          if (!dragged || dragged === node.path || node.path.startsWith(`${dragged}/`)) return;
          event.preventDefault();
          setDropTarget(true);
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(event) => {
          setDropTarget(false);
          if (!onMove) return;
          const dragged = event.dataTransfer.getData('application/pigry-move');
          if (!dragged || dragged === node.path || node.path.startsWith(`${dragged}/`)) return;
          event.preventDefault();
          event.stopPropagation();
          onMove(dragged, node.path);
        }}
        onContextMenu={(event) =>
          onContextMenu?.({ kind: isFolder ? 'folder' : 'file', path: node.path }, event)
        }
        title={node.path}
      >
        {rowIcons}
        <span className="tree-row__name">{node.name}</span>
        {fileStatus && (
          <span
            className={`tree-row__status tree-row__status--${fileStatus}`}
            title={fileStatus === "M" ? "Modified" : fileStatus === "U" ? "Untracked" : fileStatus === "A" ? "Added (staged)" : fileStatus === "D" ? "Deleted" : fileStatus === "C" ? "Conflicted" : "Renamed"}
          >
            {fileStatus}
          </span>
        )}
        {unpushed && fileStatus && (
          <span className="tree-row__unpushed" title="In commits that have not been pushed">↑</span>
        )}
      </button>
      {!flat && isFolder && isOpen && (
        <>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              statusMap={statusMap} unpushedSet={unpushedSet}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              renaming={renaming}
              onRenameSubmit={onRenameSubmit}
              onMove={onMove}
              revealPath={revealPath}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </>
      )}
    </>
  );
}

export function FileTree({
  tree,
  selectedPath,
  onSelect,
  filter,
  repoName,
  branch,
  expanded,
  onToggleFolder,
  onItemContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  onMove,
}: FileTreeProps & {
  onMove?: (sourcePath: string, targetFolder: string) => void;
}) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);
  useEffect(() => {
    const host = treeRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // VS Code-style reveal: scroll the active row into view when it changes.
  useEffect(() => {
    const host = treeRef.current;
    if (!selectedPath || !host) return;
    const timer = window.setTimeout(() => {
      const row = host.querySelector(
        `[data-path="${CSS.escape(selectedPath)}"]`,
      );
      row?.scrollIntoView({ block: 'nearest' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [selectedPath, tree]);

  const visibleEntries = useMemo(() => {
    if (!filter) return tree?.entries ?? [];
    return (tree?.entries ?? []).filter((entry) => entry.toLowerCase().includes(filter));
  }, [tree, filter]);

  const nodes = useMemo(() => buildTree(visibleEntries), [visibleEntries]);
  const rows = useMemo(() => flattenVisibleTree(nodes, expanded), [nodes, expanded]);
  const virtual = rows.length > 500;
  const rootOffset = (repoName || branch) && !filter ? 26 : 0;
  const count = Math.ceil(viewportHeight / 26) + 16;
  const start = Math.min(Math.max(0, rows.length - count), Math.max(0, Math.floor((scrollTop - rootOffset) / 26) - 8));
  useEffect(() => {
    const host = treeRef.current;
    if (!virtual || !host) return;
    const index = rows.findIndex(({ node }) => node.path === (renamingPath ?? selectedPath));
    if (index < 0) return;
    const top = rootOffset + index * 26;
    if (top < host.scrollTop) host.scrollTop = top;
    else if (top + 24 > host.scrollTop + host.clientHeight) host.scrollTop = top + 24 - host.clientHeight;
  }, [virtual, rows, selectedPath, renamingPath, rootOffset]);
  const statusMap = useMemo(
    () => new Map((tree?.changed ?? []).map((file) => [file.path, file.status])),
    [tree],
  );
  const unpushedSet = useMemo(
    () => new Set(tree?.unpushedPaths ?? []),
    [tree],
  );

  return (
    <div
      className="file-tree"
      ref={treeRef}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onDragOver={(event) => {
        // Root drop target: dropping on empty area moves to the repo root.
        if (!onMove) return;
        const dragged = event.dataTransfer.getData('application/pigry-move');
        if (!dragged || !dragged.includes('/')) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onMove) return;
        const dragged = event.dataTransfer.getData('application/pigry-move');
        if (!dragged || !dragged.includes('/')) return;
        event.preventDefault();
        onMove(dragged, '');
      }}
    >
      {(repoName || branch) && !filter && (
        <div className="tree-root">
          <img className="tree-row__fileicon" src="/fileicons/folder-base.svg" alt="" draggable={false} />
          <span className="tree-root__name" title={(repoName ?? 'repository').toUpperCase()}>
            {(repoName ?? 'repository').toUpperCase()}
          </span>
          {branch && (
            <span className="tree-root__branch" title={branch}>
              {branch}
            </span>
          )}
        </div>
      )}
      {(!tree || tree.entries.length === 0) && (
        <div className="file-tree__empty">Empty repository</div>
      )}
      {tree && tree.entries.length > 0 && visibleEntries.length === 0 && (
        <div className="file-tree__empty">No files match this filter</div>
      )}
      {virtual ? (
        <div style={{ position: 'relative', height: rows.length * 26, flexShrink: 0 }}>
          {rows.slice(start, start + count).map(({ node, depth }, index) => (
            <div key={node.path} className="file-tree__virtual-row" style={{ position: 'absolute', top: (start + index) * 26, width: '100%', height: 24 }}>
              <TreeRow node={node} depth={depth} flat selectedPath={selectedPath}
                statusMap={statusMap} unpushedSet={unpushedSet} expanded={expanded}
                onToggle={onToggleFolder} onSelect={onSelect} onContextMenu={onItemContextMenu}
                renaming={node.path === renamingPath} onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel} onMove={onMove} />
            </div>
          ))}
        </div>
      ) : visibleEntries.length > 0 &&
        nodes.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            statusMap={statusMap} unpushedSet={unpushedSet}
            expanded={expanded}
            onToggle={onToggleFolder}
            onSelect={onSelect}
            onContextMenu={onItemContextMenu}
            renaming={node.path === renamingPath}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
            onMove={onMove}
          />
        ))}
    </div>
  );
}
