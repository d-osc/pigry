import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';
import { buildTree, type TreeNode } from '../../lib/fileTree';
import type { FileTree as FileTreeData } from '../../types/repository';
import './FileTree.css';

interface FileTreeProps {
  tree: FileTreeData | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function iconFor(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) return FileJson;
  if (/\.(ts|tsx|js|jsx|css|rs|py|go|sh|html)$/.test(lower)) return FileCode2;
  if (/\.(md|txt|log)$/.test(lower)) return FileText;
  return FileIcon;
}

function TreeRow({
  node,
  depth,
  selectedPath,
  changedPaths,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  changedPaths: Set<string>;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isFolder = node.kind === 'folder';
  const isOpen = isFolder && expanded.has(node.path);
  const isSelected = !isFolder && selectedPath === node.path;
  const changeKind = changedPaths.has(node.path);

  const handleClick = () => {
    if (isFolder) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`tree-row${isSelected ? ' tree-row--selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleClick}
      >
        {isFolder ? (
          <>
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
          </>
        ) : (
          <>
            <span className="tree-row__spacer" />
            {(() => {
              const Icon = iconFor(node.name);
              return <Icon size={13} />;
            })()}
          </>
        )}
        <span className="tree-row__name">{node.name}</span>
        {changeKind && <span className="tree-row__changed" title="Has pending changes" />}
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
            />
          ))}
        </>
      )}
    </>
  );
}

export function FileTree({ tree, selectedPath, onSelect }: FileTreeProps) {
  // Root-level folders start expanded; user toggles are tracked as overrides
  // so the default can be derived without an effect.
  const [overrides, setOverrides] = useState<{
    added: Set<string>;
    removed: Set<string>;
  } | null>(null);

  const nodes = useMemo(() => buildTree(tree?.entries ?? []), [tree]);
  const changedPaths = useMemo(
    () => new Set(tree?.changedPaths ?? []),
    [tree],
  );

  const defaultExpanded = useMemo(() => {
    const roots = new Set<string>();
    for (const entry of tree?.entries ?? []) {
      const segment = entry.split('/')[0];
      if (entry.includes('/')) roots.add(segment);
    }
    return roots;
  }, [tree]);

  const expanded = useMemo(() => {
    const set = new Set(defaultExpanded);
    if (overrides) {
      overrides.added.forEach((path) => set.add(path));
      overrides.removed.forEach((path) => set.delete(path));
    }
    return set;
  }, [defaultExpanded, overrides]);

  const toggle = (path: string) => {
    setOverrides((previous) => {
      const added = new Set(previous?.added ?? []);
      const removed = new Set(previous?.removed ?? []);
      if (expanded.has(path)) {
        added.delete(path);
        removed.add(path);
      } else {
        added.add(path);
        removed.delete(path);
      }
      return { added, removed };
    });
  };

  if (!tree || tree.entries.length === 0) {
    return <div className="file-tree__empty">Empty repository</div>;
  }

  return (
    <div className="file-tree">
      {nodes.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          changedPaths={changedPaths}
          expanded={expanded}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
