import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRepository } from '../../hooks/useRepository';
import { getFileTree } from '../../lib/tauriClient';
import type { FileTree as FileTreeData } from '../../types/repository';
import { FileTree } from './FileTree';
import { EditorPane } from './EditorPane';
import { FileHistoryPanel } from './FileHistoryPanel';
import { ComparePanel } from './ComparePanel';
import './ExplorerScreen.css';

interface ExplorerScreenProps {
  /** Path requested by the palette (⌘P) — opens it when it changes. */
  openPath?: string | null;
}

export function ExplorerScreen({ openPath }: ExplorerScreenProps) {
  const { repository } = useRepository();
  const [tree, setTree] = useState<FileTreeData | null>(null);
  // Remounted by AppShell on openPath change (key), so the initializer runs.
  const [selectedPath, setSelectedPath] = useState<string | null>(openPath ?? null);
  const [historyOn, setHistoryOn] = useState(false);
  const [compareOn, setCompareOn] = useState(false);
  const [baseOid, setBaseOid] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<{
    content: string;
    language: string;
  } | null>(null);

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

  const handleBufferChange = useCallback((next: { content: string; language: string } | null) => {
    setBuffer(next);
  }, []);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
    setBaseOid(null); // history selection resets per file
  }, []);

  return (
    <div className="explorer-screen">
      <header className="explorer-screen__bar">
        <h1 className="explorer-screen__title">Explorer</h1>
        <span className="explorer-screen__subtitle">Browse and edit repository files</span>
        <span className="explorer-screen__count">
          {tree ? `${tree.entries.length} files` : ''}
        </span>
      </header>
      <div className="explorer-screen__body">
        <aside className="explorer-screen__tree">
          <FileTree tree={tree} selectedPath={effectiveSelection} onSelect={handleSelectFile} />
        </aside>
        {effectiveSelection ? (
          <>
            <EditorPane
              key={effectiveSelection}
              path={effectiveSelection}
              historyOn={historyOn}
              compareOn={compareOn}
              onToggleHistory={() => setHistoryOn((value) => !value)}
              onToggleCompare={() => setCompareOn((value) => !value)}
              onBufferChange={handleBufferChange}
            />
            {historyOn && (
              <div className="explorer-screen__panels">
                <FileHistoryPanel
                  path={effectiveSelection}
                  selectedOid={baseOid}
                  onSelect={setBaseOid}
                />
              </div>
            )}
            {compareOn && buffer && (
              <div className="explorer-screen__compare">
                <ComparePanel
                  path={effectiveSelection}
                  workingContent={buffer.content}
                  language={buffer.language}
                  baseOid={baseOid}
                />
              </div>
            )}
          </>
        ) : (
          <div className="explorer-screen__placeholder">Select a file to open it</div>
        )}
      </div>
    </div>
  );
}
