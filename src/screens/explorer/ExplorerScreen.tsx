import { useEffect, useMemo, useState } from 'react';
import { useRepository } from '../../hooks/useRepository';
import { getFileTree } from '../../lib/tauriClient';
import type { FileTree as FileTreeData } from '../../types/repository';
import { FileTree } from './FileTree';
import { EditorPane } from './EditorPane';
import './ExplorerScreen.css';

export function ExplorerScreen() {
  const { repository } = useRepository();
  const [tree, setTree] = useState<FileTreeData | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

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
        if (!cancelled) setTree(result);
      })
      .catch(() => {
        if (!cancelled) setTree(null);
      });
    return () => {
      cancelled = true;
    };
  }, [changeFingerprint]);

  // Keep a valid selection as files come and go.
  const effectiveSelection =
    selectedPath && tree?.entries.includes(selectedPath)
      ? selectedPath
      : (tree?.entries[0] ?? null);

  return (
    <div className="explorer-screen">
      <header className="explorer-screen__bar">
        <h1 className="explorer-screen__title">Explorer</h1>
        <span className="explorer-screen__count">
          {tree ? `${tree.entries.length} files` : ''}
        </span>
      </header>
      <div className="explorer-screen__body">
        <aside className="explorer-screen__tree">
          <FileTree tree={tree} selectedPath={effectiveSelection} onSelect={setSelectedPath} />
        </aside>
        {effectiveSelection ? (
          <EditorPane key={effectiveSelection} path={effectiveSelection} />
        ) : (
          <div className="explorer-screen__placeholder">Select a file to open it</div>
        )}
      </div>
    </div>
  );
}
