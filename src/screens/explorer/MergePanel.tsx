/** Merge code — side-by-side merge editor. LEFT is the file at the commit
 * picked in File history (read-only); RIGHT starts as the working file and
 * is editable, so lines can be carried over from the old version. Apply
 * writes the right-hand buffer back to the working file. */
import { useEffect, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { GitMerge } from 'lucide-react';
import { readFileAtCommit } from '../../lib/tauriClient';
import { useFileHistory } from '../../hooks/useFileHistory';
import './MergePanel.css';

interface MergePanelProps {
  path: string;
  /** Current editor buffer — the merge RESULT starts from this. */
  workingContent: string;
  language: string;
  baseOid: string | null;
  /** History walks this ref instead of HEAD (e.g. a PR head branch). */
  refName?: string | null;
  /** Writes the merged buffer into the working file. */
  onApply: (merged: string) => void;
}

export function MergePanel({
  path,
  workingContent,
  language,
  baseOid,
  refName,
  onApply,
}: MergePanelProps) {
  const { commits } = useFileHistory(path, refName ?? null);
  const [baseContent, setBaseContent] = useState<string | null>(null);
  const [result, setResult] = useState(workingContent);
  const [status, setStatus] = useState('');
  const editorRef = useRef<{ getValue: () => string; setValue: (v: string) => void } | null>(null);
  const fileName = path.split('/').pop() ?? path;

  const baseCommit = baseOid ? commits?.find((commit) => commit.oid === baseOid) : null;

  // Load the BASE blob whenever the selected commit changes.
  useEffect(() => {
    if (!baseCommit) return;
    let cancelled = false;
    readFileAtCommit(path, baseCommit.oid)
      .then((result) => {
        if (!cancelled) setBaseContent(result.binary || result.tooLarge ? null : result.content);
      })
      .catch(() => {
        if (!cancelled) setBaseContent(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, baseCommit?.oid]);

  // Reset the result buffer when the working file (or file) changes.
  const [prevWorking, setPrevWorking] = useState(workingContent);
  if (prevWorking !== workingContent) {
    setPrevWorking(workingContent);
    setResult(workingContent);
  }

  const takeBase = () => {
    if (baseContent === null || !editorRef.current) return;
    editorRef.current.setValue(baseContent);
    setResult(baseContent);
    setStatus('Base version taken — edit the right side, then Apply');
  };

  const resetToWorking = () => {
    if (!editorRef.current) return;
    editorRef.current.setValue(workingContent);
    setResult(workingContent);
    setStatus('Reset to the working file');
  };

  const apply = () => {
    const merged = editorRef.current?.getValue() ?? result;
    onApply(merged);
    setStatus('Applied to the working file');
  };

  if (!baseCommit) {
    return (
      <aside className="merge-panel">
        <header className="merge-panel__head">
          <GitMerge size={12} />
          <span className="merge-panel__title">Merge code</span>
        </header>
        <div className="merge-panel__empty">
          Pick a commit in File history to merge code from.
        </div>
      </aside>
    );
  }

  return (
    <aside className="merge-panel">
      <header className="merge-panel__head">
        <GitMerge size={12} />
        <span className="merge-panel__title">Merge code</span>
        <span className="merge-panel__file">{fileName}</span>
        <span className="merge-panel__mode">LEFT {baseCommit.shortOid} → RIGHT working (editable)</span>
        <div className="merge-panel__actions">
          <button type="button" className="merge-panel__btn" onClick={takeBase}>
            Take base version
          </button>
          <button type="button" className="merge-panel__btn" onClick={resetToWorking}>
            Reset
          </button>
          <button
            type="button"
            className="merge-panel__btn merge-panel__btn--apply"
            onClick={apply}
          >
            Apply to file
          </button>
        </div>
      </header>
      {status && <div className="merge-panel__status">{status}</div>}
      <div className="merge-panel__editor">
        {baseContent === null ? (
          <div className="merge-panel__empty">Loading base…</div>
        ) : (
          <DiffEditor
            key={`${path}:${baseCommit.oid}`}
            original={baseContent}
            modified={result}
            language={language}
            theme="orbit-dark"
            options={{
              renderSideBySide: true,
              fontSize: 11,
              lineHeight: 18,
              fontFamily: "'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
              fontLigatures: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderOverviewRuler: false,
              originalEditable: false,
              readOnly: false,
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
              stickyScroll: { enabled: false },
            }}
            onMount={(editor) => {
              const modified = editor.getModifiedEditor();
              editorRef.current = {
                getValue: () => modified.getValue(),
                setValue: (value: string) => modified.setValue(value),
              };
              modified.onDidChangeModelContent(() => {
                setResult(modified.getValue());
              });
            }}
          />
        )}
      </div>
    </aside>
  );
}
