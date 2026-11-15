import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor } from '../../editor/ThemedEditors';
import { Clock, FileClock, GitCompare, X } from 'lucide-react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import type { Monaco } from '@monaco-editor/react';
import { relativeTime } from '../../lib/relativeTime';
import { getFileBlame } from '../../lib/tauriClient';
import { ResizeHandle } from '../../app/ResizeHandle';
import type { BlameLine } from '../../types/repository';
import '../../editor/monacoSetup';
import { FileHistoryPanel } from '../explorer/FileHistoryPanel';
import { ComparePanel } from '../explorer/ComparePanel';
import './PrDiffDialog.css';

interface PrDiffFile {
  path: string;
  original: string;
  modified: string;
  language: string;
}

function fileStat(file: PrDiffFile): { added: number; removed: number } {
  // Empty string = "no lines" (new/deleted file); a trailing newline does not
  // create an extra line (GitHub-style counting).
  const splitLines = (content: string) => {
    if (!content) return [];
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const origLines = splitLines(file.original);
  const modLines = splitLines(file.modified);
  const counts = new Map<string, number>();
  for (const line of origLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of modLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) {
      common += 1;
      counts.set(line, remaining - 1);
    }
  }
  return {
    added: modLines.length - common,
    removed: origLines.length - common,
  };
}

/**
 * Fullscreen compare dialog for a pull request. Starts on the current code
 * diff; History / Compare / Blame toggle panels on top of it, exactly like the
 * Explorer editor's toggles — History = the PR's commit timeline for this file.
 */
export function PrDiffDialog({
  title,
  files,
  initialPath,
  headRef,
  onClose,
}: {
  title: string;
  files: PrDiffFile[];
  initialPath?: string;
  /** Branch/ref the diff is taken from — history & blame walk this. */
  headRef?: string;
  onClose: () => void;
}) {
  const [activePath, setActivePath] = useState(initialPath ?? files[0]?.path ?? '');
  // Resizable panes — same drag handles as the Explorer editor layout.
  const [filesWidth, setFilesWidth] = useState(300);
  const [historyHeight, setHistoryHeight] = useState(220);
  const [compareHeight, setCompareHeight] = useState(300);
  // Toggles — all start off so the dialog opens on the current code diff.
  const [historyOn, setHistoryOn] = useState(false);
  const [compareOn, setCompareOn] = useState(false);
  const [blameOn, setBlameOn] = useState(false);
  const [compareOid, setCompareOid] = useState<string | null>(null);
  // Main (base→head) diff layout — split by default, toggleable inline.
  const [mainSplit, setMainSplit] = useState(true);
  const [blameRows, setBlameRows] = useState<BlameLine[] | null>(null);
  const [blameError, setBlameError] = useState('');
  const [modifiedEditor, setModifiedEditor] =
    useState<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const [monacoInst, setMonacoInst] = useState<Monaco | null>(null);
  const decorationsRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null);

  const active = files.find((file) => file.path === activePath) ?? files[0];
  const stat = useMemo(() => (active ? fileStat(active) : { added: 0, removed: 0 }), [active]);

  // Escape closes; clicking the dark backdrop also closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reset per-file data when switching files.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setCompareOid(null);
      setBlameRows(null);
      setBlameError('');
    }, 0);
    return () => window.clearTimeout(t);
  }, [activePath]);

  // Fetch blame for the active file when the Blame toggle turns on.
  useEffect(() => {
    if (!blameOn) return;
    const t = window.setTimeout(() => {
      getFileBlame(activePath, headRef ?? null)
        .then((rows) => setBlameRows(rows))
        .catch((error) =>
          setBlameError(error instanceof Error ? error.message : String(error)),
        );
    }, 0);
    return () => window.clearTimeout(t);
  }, [blameOn, activePath, headRef]);

  // Clicking anywhere outside the dialog closes it (capture phase).
  useEffect(() => {
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (document.querySelector('.pr-diff-dialog')?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [onClose]);

  // Blame decorations: author + sha injected after each modified line
  // (Explorer blame style). Cleared when toggled off or file changes.
  useEffect(() => {
    const collection = decorationsRef.current;
    if (!blameOn || !blameRows || !modifiedEditor) {
      collection?.clear();
      return;
    }
    const model = modifiedEditor.getModel();
    if (!model) return;
    const decorations = blameRows
      .filter((line) => line.line <= model.getLineCount())
      .map((line) => {
        const maxCol = model.getLineMaxColumn(line.line);
        const label = `  ${line.shortOid} ${line.authorInitials} · ${relativeTime(line.timeSeconds)}`;
        return {
          range: {
            startLineNumber: line.line,
            startColumn: 1,
            endLineNumber: line.line,
            endColumn: maxCol,
          },
          options: {
            after: {
              content: label,
              inlineClassName: 'blame-annotation',
            },
          },
        };
      });
    decorationsRef.current = modifiedEditor.createDecorationsCollection(decorations);
  }, [blameOn, blameRows, modifiedEditor, activePath]);

  // Blame hover popup: GitLens-style card on the modified editor.
  useEffect(() => {
    if (!blameOn || !blameRows || !modifiedEditor || !monacoInst) return;
    const byLine = new Map(blameRows.map((line) => [line.line, line]));
    const languageId = modifiedEditor.getModel()?.getLanguageId() ?? '';
    const disposable = monacoInst.languages.registerHoverProvider(languageId, {
      provideHover: (
        _model: MonacoEditorNS.ITextModel,
        position: { lineNumber: number },
      ) => {
        const info = byLine.get(position.lineNumber);
        if (!info) return null;
        const range = new monacoInst.Range(position.lineNumber, 1, position.lineNumber, 1);

        const body = info.message.startsWith(info.summary)
          ? info.message.slice(info.summary.length).trim()
          : info.message.trim();
        const authored = new Date(info.timeSeconds * 1000);
        const absolute = authored.toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });

        const contents: { value: string; isTrusted?: boolean }[] = [
          { value: `**${info.summary}**` },
        ];
        if (body) {
          for (const paragraph of body.split(/\n{2,}/)) {
            contents.push({ value: paragraph.replace(/\n/g, ' ') });
          }
        }
        contents.push(
          { value: `👤 **${info.authorName}**${info.authorEmail ? ` \`<${info.authorEmail}>\`` : ''}` },
          { value: `🕐 ${absolute} · ${relativeTime(info.timeSeconds)}` },
          { value: `🔑 \`${info.oid}\`` },
          { value: `📄 \`${activePath}\` · line ${info.line}` },
        );
        return { range, contents };
      },
    });
    return () => disposable.dispose();
  }, [blameOn, blameRows, modifiedEditor, monacoInst, activePath]);

  const statLabel = `+${stat.added} −${stat.removed}`;

  return (
    <div className="pr-diff-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="pr-diff-dialog__inner" onClick={(event) => event.stopPropagation()}>
        <header className="pr-diff-dialog__head">
          <strong>{title}</strong>
          <div className="pr-diff-dialog__actions">
            <span className="pr-diff-dialog__hint">Esc to close</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Close compare view"
              onClick={onClose}
            >
              <X size={15} strokeWidth={1.5} />
            </button>
          </div>
        </header>

        <div className="pr-diff-dialog__body">
          <aside className="pr-diff-dialog__files" style={{ width: filesWidth }}>
            <p className="pr-diff-dialog__files-label">
              {files.length} changed file{files.length === 1 ? '' : 's'}
            </p>
            {files.map((file) => {
              const fileSt = fileStat(file);
              return (
                <button
                  key={file.path}
                  type="button"
                  className={`pr-diff-dialog__file${file.path === activePath ? ' pr-diff-dialog__file--active' : ''}`}
                  onClick={() => setActivePath(file.path)}
                  title={file.path}
                >
                  <span className="pr-diff-dialog__file-path">{file.path}</span>
                  <span className="pr-diff-dialog__file-stat">
                    <span className="pr-diff--added">+{fileSt.added}</span>{' '}
                    <span className="pr-diff--removed">−{fileSt.removed}</span>
                  </span>
                </button>
              );
            })}
            {files.length === 0 && (
              <p className="pr-diff-dialog__files-label">No changed files.</p>
            )}
          </aside>

          <ResizeHandle
            orientation="v"
            label="Resize file list"
            onDelta={(dx) => setFilesWidth((w) => Math.min(480, Math.max(220, w + dx)))}
          />

          <div className="pr-diff-dialog__compare">
            <div className="diff-pane__controls pr-diff-dialog__controls">
              <span className="diff-pane__comparison">{active ? active.path : 'No files'}</span>
              <span className="diffstat">
                <span className="diffstat__additions">+{stat.added}</span>
                <span className="diffstat__deletions">−{stat.removed}</span>
              </span>
              <div className="segmented" role="group" aria-label="Diff layout">
                <button
                  type="button"
                  className={`segmented__item${mainSplit ? ' is-active' : ''}`}
                  onClick={() => setMainSplit(true)}
                >
                  Split
                </button>
                <button
                  type="button"
                  className={`segmented__item${!mainSplit ? ' is-active' : ''}`}
                  onClick={() => setMainSplit(false)}
                >
                  Unified
                </button>
              </div>
              <div className="diff-pane__view-options">
                {blameOn && blameError && (
                  <span className="pr-diff-dialog__hint">{blameError}</span>
                )}
                <div className="segmented" role="group" aria-label="Feature toggles">
                  <button
                    type="button"
                    className={`segmented__item${historyOn ? ' is-active' : ''}`}
                    onClick={() => setHistoryOn((value) => !value)}
                    title="File history timeline (PR commits)"
                  >
                    <FileClock size={12} strokeWidth={1.5} />
                    History
                  </button>
                  <button
                    type="button"
                    className={`segmented__item${compareOn ? ' is-active' : ''}`}
                    onClick={() => setCompareOn((value) => !value)}
                    title="Compare against the selected history commit"
                  >
                    <GitCompare size={12} strokeWidth={1.5} />
                    Compare
                  </button>
                  <button
                    type="button"
                    className={`segmented__item${blameOn ? ' is-active' : ''}`}
                    onClick={() => setBlameOn((value) => !value)}
                    title="Per-line blame annotations"
                  >
                    <Clock size={12} strokeWidth={1.5} />
                    Blame
                  </button>
                </div>
              </div>
            </div>

            {historyOn && (
              <>
                <div className="pr-diff-dialog__history" style={{ height: historyHeight }}>
                  <FileHistoryPanel
                    path={activePath}
                    refName={headRef}
                    selectedOid={compareOid}
                    onSelect={(oid) => {
                      setCompareOid(oid);
                      setCompareOn(true);
                    }}
                  />
                </div>
                <ResizeHandle
                  orientation="h"
                  label="Resize file history"
                  onDelta={(_dx, dy) =>
                    setHistoryHeight((h) => Math.min(480, Math.max(120, (h ?? 220) + dy)))
                  }
                />
              </>
            )}

            {active && (
              <div className="pr-diff-dialog__editor">
                <DiffEditor
                  key={active.path}
                  original={active.original}
                  modified={active.modified}
                  language={active.language}
                  onMount={(diffEditor, monaco) => {
                    setModifiedEditor(diffEditor.getModifiedEditor());
                    setMonacoInst(monaco);
                    requestAnimationFrame(() => diffEditor.layout());
                  }}
                  options={{
                    readOnly: true,
                    renderSideBySide: mainSplit,
                    ignoreTrimWhitespace: true,
                    renderOverviewRuler: true,
                    fontSize: 11,
                    lineHeight: 18,
                    fontFamily: "'Fira Code', ui-monospace, monospace",
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
              </div>
            )}

            {compareOn && active && (
              <>
                <ResizeHandle
                  orientation="h"
                  label="Resize compare view"
                  onDelta={(_dx, dy) =>
                    setCompareHeight((h) => Math.min(560, Math.max(140, (h ?? 300) - dy)))
                  }
                />
                <div className="pr-diff-dialog__comparewrap" style={{ height: compareHeight }}>
                  <ComparePanel
                  path={activePath}
                  workingContent={active.modified}
                  language={active.language}
                  baseOid={compareOid}
                  refName={headRef}
                />
              </div>
              </>
            )}
          </div>
        </div>

        <footer className="pr-diff-dialog__foot">
          <span>
            {[
              historyOn ? 'History on' : null,
              compareOn ? 'Compare on' : null,
              blameOn ? 'Blame on' : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Current code diff'}
          </span>
          <span>
            {statLabel} · {active?.path ?? ''}
          </span>
        </footer>
      </div>
    </div>
  );
}

