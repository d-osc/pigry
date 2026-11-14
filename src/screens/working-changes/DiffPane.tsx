import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatAwareDiffEditor } from '../../lib/ChatAwareDiffEditor';
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

interface LineRange {
  start: number;
  end: number;
}

/** One line of the unified (inline) diff view. */
interface InlineEntry {
  origin: 'old' | 'new' | 'ctx';
  oldNo: number | null;
  newNo: number | null;
}

type MonacoChange = {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
};

/**
 * Reconstructs the unified view's line layout from monaco's line changes:
 * each change block renders original (deleted) lines first, then modified
 * (added) lines, with shared context between blocks. Returns viewLine → entry.
 */
function buildInlineMap(changes: MonacoChange[]): Map<number, InlineEntry> {
  const map = new Map<number, InlineEntry>();
  let view = 1;
  let o = 1;
  let m = 1;
  for (const change of changes) {
    const origStart = Math.max(change.originalStartLineNumber, 1);
    const modStart = Math.max(change.modifiedStartLineNumber, 1);
    while (o < origStart && m < modStart) {
      map.set(view++, { origin: 'ctx', oldNo: o, newNo: m });
      o += 1;
      m += 1;
    }
    const origEnd = change.originalEndLineNumber;
    for (let n = o; n <= origEnd; n += 1) {
      map.set(view++, { origin: 'old', oldNo: n, newNo: null });
    }
    o = Math.max(o, origEnd + 1);
    const modEnd = change.modifiedEndLineNumber;
    for (let n = m; n <= modEnd; n += 1) {
      map.set(view++, { origin: 'new', oldNo: null, newNo: n });
    }
    m = Math.max(m, modEnd + 1);
  }
  return map;
}

/** Selected ranges stamped with the file they belong to (race guard). */
interface LineSelection {
  id: string;
  oldSel: LineRange | null;
  newSel: LineRange | null;
}

function rangeLineCount(range: LineRange | null): number {
  return range ? range.end - range.start + 1 : 0;
}

function rangeToNumbers(range: LineRange | null): number[] {
  if (!range) return [];
  const out: number[] = [];
  for (let n = range.start; n <= range.end; n += 1) out.push(n);
  return out;
}

export function DiffPane({ selectedFileId }: DiffPaneProps) {
  const { repository, stage, unstage, discard, stageLines, busy } = useRepository();
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [unified, setUnified] = useState(true);
  const [mutatedKey, setMutatedKey] = useState(0);
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [entry, setEntry] = useState<{
    id: string;
    diff: FileDiffContent | null;
    failed: boolean;
  } | null>(null);
  const diffEditorRef =
    useRef<import('@monaco-editor/react').MonacoDiffEditor | null>(null);

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
    // mutatedKey: the diff changes after hunk/line-level operations.
  }, [selectedFileId, path, staged, mutatedKey]);

  // Ignore entries from a previously selected file while the new one loads.
  const current = entry?.id === selectedFileId ? entry : null;
  const diff = current?.diff ?? null;
  const loading = current === null;

  const activeSelection = selection?.id === selectedFileId ? selection : null;
  const selectedCount =
    rangeLineCount(activeSelection?.oldSel ?? null) +
    rangeLineCount(activeSelection?.newSel ?? null);

  const handleDiffMount = useCallback(
    (diffEditor: import('@monaco-editor/react').MonacoDiffEditor) => {
      diffEditorRef.current = diffEditor;
      // Last-active editor wins: a selection in one side clears the other.
      const track = (
        editor: { onDidChangeCursorSelection: (cb: (e: {
          selection: { startLineNumber: number; endLineNumber: number };
        }) => void) => void },
        side: 'oldSel' | 'newSel',
      ) => {
        editor.onDidChangeCursorSelection((event) => {
          const { startLineNumber, endLineNumber } = event.selection;
          const hasText = endLineNumber >= startLineNumber;
          setSelection((prev) => {
            const base = prev?.id === selectedFileId ? prev : { id: selectedFileId, oldSel: null, newSel: null };
            // Selection collapsed to nothing → clear this side only.
            return {
              ...base,
              [side]: hasText
                ? { start: startLineNumber, end: endLineNumber }
                : null,
            };
          });
        });
      };
      track(diffEditor.getOriginalEditor(), 'oldSel');
      track(diffEditor.getModifiedEditor(), 'newSel');
    },
    [selectedFileId],
  );

  const handleStageLines = useCallback(() => {
    const editor = diffEditorRef.current;
    if (!editor || !activeSelection) return;
    let selectedOld: number[] = [];
    let selectedNew: number[] = [];
    if (unified) {
      // The inline view numbers lines across both sides — map view lines to
      // their old/new file numbers via monaco's line changes.
      const view = rangeToNumbers(activeSelection.newSel ?? activeSelection.oldSel);
      const map = buildInlineMap((editor.getLineChanges() ?? []) as MonacoChange[]);
      for (const viewLine of view) {
        const mapped = map.get(viewLine);
        if (!mapped) continue;
        if (mapped.origin === 'old' && mapped.oldNo !== null) selectedOld.push(mapped.oldNo);
        if (mapped.origin === 'new' && mapped.newNo !== null) selectedNew.push(mapped.newNo);
      }
    } else {
      selectedOld = rangeToNumbers(activeSelection.oldSel);
      selectedNew = rangeToNumbers(activeSelection.newSel);
    }
    if (selectedOld.length === 0 && selectedNew.length === 0) return;
    void stageLines(
      path,
      staged ? 'staged' : 'unstaged',
      selectedOld,
      selectedNew,
    );
    setMutatedKey((k) => k + 1);
  }, [activeSelection, unified, path, staged, stageLines]);

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

      <HunkBar
        selectedFileId={selectedFileId}
        reloadKey={mutatedKey}
        onMutated={() => setMutatedKey((k) => k + 1)}
      />

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
          <ChatAwareDiffEditor
            chatMeta={{ path, source: 'Working changes' }}
            key={`${selectedFileId}:${mutatedKey}`}
            original={diff.original ?? ''}
            modified={diff.modified ?? ''}
            language={diff.language}
            theme="pigry-dark"
            onMount={handleDiffMount}
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
        {selectedCount > 0 ? (
          <button
            type="button"
            className="diff-pane__stage-lines"
            onClick={handleStageLines}
            disabled={busy}
            title={staged ? 'Remove the selected lines from the index' : 'Add the selected lines to the index'}
          >
            <Plus size={12} />
            {staged ? 'Unstage' : 'Stage'} {selectedCount} selected line{selectedCount === 1 ? '' : 's'}
          </button>
        ) : (
          <span className="diff-pane__hint">
            Select lines in either side to stage part of this file
          </span>
        )}
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
