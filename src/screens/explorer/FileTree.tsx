import { useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { buildTree, type TreeNode } from '../../lib/fileTree';
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
  changedPaths,
  expanded,
  onToggle,
  onSelect,
  onContextMenu,
  renaming,
  onRenameSubmit,
  onRenameCancel,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  changedPaths: Set<string>;
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
}) {
  const isFolder = node.kind === 'folder';
  const isOpen = isFolder && expanded.has(node.path);
  // Guards the rename input against the phantom blur that fires when the
  // context menu unmounts in the same commit.
  const hadFocus = useRef(false);
  const isSelected = !isFolder && selectedPath === node.path;
  const modified = !isFolder && changedPaths.has(node.path);
  const iconSrc = isFolder ? folderIcon(node.name) : fileIcon(node.name);

  const handleClick = () => {
    if (isFolder) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  const rowIcons = (
    <>
      {isFolder ? (
        isOpen ? <ChevronDown size={8.5} strokeWidth={1.5} /> : <ChevronRight size={8.5} strokeWidth={1.5} />
      ) : (
        depth > 0 && <i className="tree-row__guide" aria-hidden="true" />
      )}
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
        {isFolder && isOpen && (
          <>
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                changedPaths={changedPaths}
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
        type="button"
        className={`tree-row${isFolder ? ' tree-row--folder' : ''}${isSelected ? ' tree-row--selected' : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={handleClick}
        onContextMenu={(event) =>
          onContextMenu?.({ kind: isFolder ? 'folder' : 'file', path: node.path }, event)
        }
        title={node.path}
      >
        {rowIcons}
        <span className="tree-row__name">{node.name}</span>
        {modified && <span className="tree-row__modified">M</span>}
      </button>
      {isFolder && isOpen && (
        <>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              changedPaths={changedPaths}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              renaming={renaming}
              onRenameSubmit={onRenameSubmit}
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
}: FileTreeProps) {
  const visibleEntries = useMemo(() => {
    if (!filter) return tree?.entries ?? [];
    return (tree?.entries ?? []).filter((entry) => entry.toLowerCase().includes(filter));
  }, [tree, filter]);

  const nodes = useMemo(() => buildTree(visibleEntries), [visibleEntries]);
  const changedPaths = useMemo(
    () => new Set(tree?.changedPaths ?? []),
    [tree],
  );

  return (
    <div className="file-tree">
      {(repoName || branch) && !filter && (
        <div className="tree-root">
          <img className="tree-row__fileicon" src="/fileicons/folder-base.svg" alt="" draggable={false} />
          <span className="tree-root__name">{(repoName ?? 'repository').toUpperCase()}</span>
          {branch && <span className="tree-root__branch">{branch}</span>}
        </div>
      )}
      {(!tree || tree.entries.length === 0) && (
        <div className="file-tree__empty">Empty repository</div>
      )}
      {tree && tree.entries.length > 0 && visibleEntries.length === 0 && (
        <div className="file-tree__empty">No files match this filter</div>
      )}
      {visibleEntries.length > 0 &&
        nodes.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            changedPaths={changedPaths}
            expanded={expanded}
            onToggle={onToggleFolder}
            onSelect={onSelect}
            onContextMenu={onItemContextMenu}
            renaming={node.path === renamingPath}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
          />
        ))}
    </div>
  );
}
