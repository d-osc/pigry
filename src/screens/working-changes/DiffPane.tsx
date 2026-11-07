import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { FileCode2, RotateCcw, Plus } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { getFileDiff } from '../../lib/tauriClient';
import type { FileDiffContent } from '../../types/repository';
import '../../editor/monacoSetup';
import { HunkBar } from './HunkBar';
import './DiffPane.css';

interface DiffPaneProps {
  selectedFileId: string;
}

export function DiffPane({ selectedFileId }: DiffPaneProps) {
  const { repository, stage, unstage, discard, busy } = useRepository();
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [unified, setUnified] = useState(true);
  const [hunkReloadKey, setHunkReloadKey] = useState(0);
  const [entry, setEntry] = useState<{
    id: string;
    diff: FileDiffContent | null;
    failed: boolean;
  } | null>(null);

  // selectedFileId = "<path>:staged|unstaged"
  const separator = selectedFileId.lastIndexOf(':');
  const path = selectedFileId.slice(0, separator);
  const staged = selectedFileId.slice(separator + 1) === 'staged';

  const file = repository?.files.find((f) => f.id === selectedFileId);

  useEffect(() => {
    let cancelled = false;
    getFileDiff(path, staged)
      .then((diff) => {
        if (!cancelled) setEntry({ id: selectedFileId, diff, failed: false });
      })
      .catch(() => {
        if (!cancelled) setEntry({ id: selectedFileId, diff: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFileId, path, staged]);

  // Ignore entries from a previously selected file while the new one loads.
  const current = entry?.id === selectedFileId ? entry : null;
  const diff = current?.diff ?? null;
  const loading = current === null;

  const comparison = staged ? 'HEAD → Index' : 'Index → Working tree';
  const meta = diff ? `${languageLabel(diff.language)} · UTF-8 · LF` : '';

  return (
    <section className="diff-pane" aria-label={`Diff for ${path}`}>
      <header className="diff-pane__toolbar">
        <FileCode2 size={14} className="diff-pane__file-icon" />
        <span className="diff-pane__path">{path}</span>
        <span className={`diff-pane__state ${staged ? 'is-staged' : 'is-unstaged'}`}>
          {staged ? 'Staged' : 'Unstaged'}
        </span>
        <div className="diff-pane__actions">
          <button
            type="button"
            className="outline-button"
            onClick={() => void discard(path)}
            disabled={busy || staged}
            title={staged ? 'Unstage the file first to discard' : 'Restore this file'}
          >
            <RotateCcw size={12} />
            Discard file
          </button>
          <button
            type="button"
            className="outline-button"
            onClick={() => void (staged ? unstage([path]) : stage([path]))}
            disabled={busy}
          >
            <Plus size={12} />
            {staged ? 'Unstage file' : 'Stage file'}
          </button>
        </div>
      </header>

      <div className="diff-pane__controls">
        <span className="diff-pane__comparison">{comparison}</span>
        {file && (
          <span className="diffstat">
            <span className="diffstat__additions">+{file.additions}</span>
            <span className="diffstat__deletions">−{file.deletions}</span>
          </span>
        )}
        <div className="diff-pane__view-options">
          <label className="diff-toggle">
            <input
              type="checkbox"
              checked={ignoreWhitespace}
              onChange={(event) => setIgnoreWhitespace(event.target.checked)}
            />
            Ignore whitespace
          </label>
          <div className="segmented" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={`segmented__item${unified ? ' is-active' : ''}`}
              onClick={() => setUnified(true)}
            >
              Unified
            </button>
            <button
              type="button"
              className={`segmented__item${!unified ? ' is-active' : ''}`}
              onClick={() => setUnified(false)}
            >
              Split
            </button>
          </div>
        </div>
      </div>

      {!staged && (
        <HunkBar
          selectedFileId={selectedFileId}
          reloadKey={hunkReloadKey}
          onStaged={() => setHunkReloadKey((k) => k + 1)}
        />
      )}

      <div className="diff-pane__editor">
        {loading ? (
          <div className="diff-pane__notice">Loading diff…</div>
        ) : !diff || diff.binary ? (
          <div className="diff-pane__notice">
            {diff?.binary
              ? 'Binary file — preview is not available'
              : 'Diff unavailable'}
          </div>
        ) : diff.tooLarge ? (
          <div className="diff-pane__notice">
            File is too large to display (over 1 MB)
          </div>
        ) : (
          <DiffEditor
            key={selectedFileId}
            original={diff.original ?? ''}
            modified={diff.modified ?? ''}
            language={diff.language}
            theme="orbit-dark"
            options={{
              readOnly: true,
              renderSideBySide: !unified,
              ignoreTrimWhitespace: ignoreWhitespace,
              renderOverviewRuler: true,
              fontSize: 11,
              lineHeight: 18,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderLineHighlight: 'line',
              diffWordWrap: 'off',
              padding: { top: 8, bottom: 8 },
              automaticLayout: true,
              scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
                useShadows: false,
              },
              stickyScroll: { enabled: false },
            }}
            loading={<div className="diff-pane__notice">Loading diff…</div>}
          />
        )}
      </div>

      <footer className="diff-pane__footer">
        <span className="diff-pane__hint">Select lines to stage part of this file</span>
        <span className="diff-pane__meta">{meta}</span>
      </footer>
    </section>
  );
}

function languageLabel(language: string): string {
  switch (language) {
    case 'typescript':
      return 'TypeScript';
    case 'javascript':
      return 'JavaScript';
    case 'css':
      return 'CSS';
    case 'markdown':
      return 'Markdown';
    case 'rust':
      return 'Rust';
    case 'json':
      return 'JSON';
    default:
      return language.charAt(0).toUpperCase() + language.slice(1);
  }
}
