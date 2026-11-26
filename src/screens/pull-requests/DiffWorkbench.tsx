import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DiffEditor } from '../../editor/ThemedEditors';
import { Clock, FileClock, GitCompare } from 'lucide-react';
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

export interface DiffWorkbenchFile {
  path: string;
  additions: number;
  deletions: number;
  /** Optional git status letter (A/M/D/R…) shown as a badge in the file list. */
  status?: string;
}

/** What the right pane shows for the active file. */
export type DiffWorkbenchContent =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'notice'; message: string }
  | { kind: 'ready'; original: string; modified: string; language: string };

/**
 * Changed-file list (left) + compare editor (right) with Split/Unified and
 * History / Compare / Blame toggles, exactly like the Explorer editor's
 * toggles. Used by the PR "View full diff" dialog and inline by Compare branch.
 */
export function DiffWorkbench({
  files,
  activePath,
  onSelect,
  content,
  headRef,
  filesLabel,
  filesFooter,
}: {
  files: DiffWorkbenchFile[];
  activePath: string;
  onSelect: (path: string) => void;
  /** Content of the active file; null when there is no active file. */
  content: DiffWorkbenchContent | null;
  /** Branch/ref the diff is taken from — history & blame walk this. */
  headRef?: string;
  /** Replaces the default "N changed files" label above the list. */
  filesLabel?: ReactNode;
  /** Rendered below the file list (e.g. a "Show more" button). */
  filesFooter?: ReactNode;
}) {
  // Resizable panes — same drag handles as the Explorer editor layout.
  const [filesWidth, setFilesWidth] = useState(300);
  const [historyHeight, setHistoryHeight] = useState(220);
  const [compareHeight, setCompareHeight] = useState(300);
  // Toggles — all start off so the view opens on the current code diff.
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

  const active = files.find((file) => file.path === activePath);
  const ready = content?.kind === 'ready' ? content : null;

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
    if (!blameOn || !activePath) return;
    const t = window.setTimeout(() => {
      getFileBlame(activePath, headRef ?? null)
        .then((rows) => setBlameRows(rows))
        .catch((error) =>
          setBlameError(error instanceof Error ? error.message : String(error)),
        );
    }, 0);
    return () => window.clearTimeout(t);
  }, [blameOn, activePath, headRef]);

  // Blame decorations: author + sha injected after each modified line
  // (Explorer blame style). Cleared when toggled off or file changes. The
  // previous collection is always cleared first so re-runs can never stack
  // duplicate labels on the same line.
  useEffect(() => {
    decorationsRef.current?.clear();
    if (!blameOn || !blameRows || !modifiedEditor) return;
    const model = modifiedEditor.getModel();
    if (!model) return;
    const decorations = blameRows
      .filter((line) => line.line <= model.getLineCount())
      .map((line) => {
        const maxCol = model.getLineMaxColumn(line.line);
        const label = line.uncommitted
          ? '  — Uncommitted'
          : `  ${line.shortOid} ${line.authorName} · ${relativeTime(line.timeSeconds)}`;
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
    const model = modifiedEditor.getModel();
    if (!model) return;
    const languageId = model.getLanguageId();
    const disposable = monacoInst.languages.registerHoverProvider(languageId, {
      provideHover: (
        hoverModel: MonacoEditorNS.ITextModel,
        position: { lineNumber: number },
      ) => {
        // Providers register per language; ignore hovers from other editors
        // sharing the language so contents never merge across editors.
        if (hoverModel.id !== model.id) return null;
        const info = byLine.get(position.lineNumber);
        if (!info) return null;
        const range = new monacoInst.Range(position.lineNumber, 1, position.lineNumber, 1);

        if (info.uncommitted) {
          return {
            range,
            contents: [
              { value: '**Uncommitted changes**' },
              {
                value: 'This line is edited in your working tree and is not part of any commit yet.',
              },
              {
                value: `👤 You (working tree) · 📄 ${activePath} · line ${info.line}`,
              },
            ],
          };
        }

        // Summary is collapsed to one line by git (newlines → spaces), so
        // compare with whitespace normalized — a plain startsWith fails on
        // multi-line first paragraphs and echoed the summary twice.
        const summaryNorm = info.summary.replace(/\s+/g, ' ').trim();
        const paragraphs = info.message
          .split(/\n{2,}/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const bodyParas =
          paragraphs.length > 0 && paragraphs[0] === summaryNorm
            ? paragraphs.slice(1)
            : paragraphs;
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
        for (const paragraph of bodyParas) {
          contents.push({ value: paragraph });
        }
        contents.push(
          { value: `👤 **${info.authorName}**${info.authorEmail ? ` \`<${info.authorEmail}>\`` : ''}` },
          { value: `🕐 ${absolute} · ${relativeTime(info.timeSeconds)}` },
          { value: `🔑 \`${info.oid}\`` },
          { value: `📄 \`${activePath}\` · line ${info.line}` },
        );
        if (info.filesChanged !== undefined) {
          contents.push({
            value: `📊 ${info.filesChanged} file${info.filesChanged === 1 ? '' : 's'} changed · +${info.insertions ?? 0} −${info.deletions ?? 0}`,
          });
        }
        return { range, contents };
      },
    });
    return () => disposable.dispose();
  }, [blameOn, blameRows, modifiedEditor, monacoInst, activePath]);

  const added = active?.additions ?? 0;
  const removed = active?.deletions ?? 0;

  return (
    <>
      <div className="pr-diff-dialog__body">
        <aside className="pr-diff-dialog__files" style={{ width: filesWidth }} aria-label="Changed files">
          {filesLabel ?? (
            <p className="pr-diff-dialog__files-label">
              {files.length} changed file{files.length === 1 ? '' : 's'}
            </p>
          )}
          {files.length > 0 && (
            <ul className="pr-diff-dialog__file-list">
              {files.map((file) => {
                const isActive = file.path === activePath;
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`pr-diff-dialog__file${isActive ? ' pr-diff-dialog__file--active' : ''}`}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => onSelect(file.path)}
                      title={file.path}
                    >
                      <span className="pr-diff-dialog__file-path">
                        {file.status && (
                          <span className={`push__file-status push__file-status--${file.status}`}>{file.status}</span>
                        )}
                        {file.path}
                      </span>
                      <span className="pr-diff-dialog__file-stat">
                        <span className="pr-diff--added">+{file.additions}</span>{' '}
                        <span className="pr-diff--removed">−{file.deletions}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {files.length === 0 && (
            <p className="pr-diff-dialog__files-label">No changed files.</p>
          )}
          {filesFooter}
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
              <span className="diffstat__additions">+{added}</span>
              <span className="diffstat__deletions">−{removed}</span>
            </span>
            <div className="segmented" role="group" aria-label="Diff layout">
              <button
                type="button"
                className={`segmented__item${mainSplit ? ' is-active' : ''}`}
                aria-pressed={mainSplit}
                onClick={() => setMainSplit(true)}
              >
                Split
              </button>
              <button
                type="button"
                className={`segmented__item${!mainSplit ? ' is-active' : ''}`}
                aria-pressed={!mainSplit}
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
                  aria-pressed={historyOn}
                  onClick={() => setHistoryOn((value) => !value)}
                  title="File history timeline"
                >
                  <FileClock size={12} strokeWidth={1.5} />
                  History
                </button>
                <button
                  type="button"
                  className={`segmented__item${compareOn ? ' is-active' : ''}`}
                  aria-pressed={compareOn}
                  onClick={() => setCompareOn((value) => !value)}
                  title="Compare against the selected history commit"
                >
                  <GitCompare size={12} strokeWidth={1.5} />
                  Compare
                </button>
                <button
                  type="button"
                  className={`segmented__item${blameOn ? ' is-active' : ''}`}
                  aria-pressed={blameOn}
                  onClick={() => setBlameOn((value) => !value)}
                  title="Per-line blame annotations"
                >
                  <Clock size={12} strokeWidth={1.5} />
                  Blame
                </button>
              </div>
            </div>
          </div>

          {historyOn && active && (
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

          {active && content?.kind === 'loading' && (
            <p className="diff-pane__notice" role="status">Loading diff…</p>
          )}
          {active && content?.kind === 'error' && (
            <p className="diff-pane__notice" role="alert">{content.message}</p>
          )}
          {active && content?.kind === 'notice' && (
            <p className="diff-pane__notice">{content.message}</p>
          )}
          {active && ready && !ready.original && !ready.modified && (
            <p className="diff-pane__notice">No text diff available for this file.</p>
          )}
          {active && ready && (ready.original || ready.modified) && (
            <div className="pr-diff-dialog__editor">
              <DiffEditor
                key={active.path}
                original={ready.original}
                modified={ready.modified}
                language={ready.language}
                onMount={(diffEditor, monaco) => {
                  setModifiedEditor(diffEditor.getModifiedEditor());
                  setMonacoInst(monaco);
                  requestAnimationFrame(() => diffEditor.layout());
                }}
                options={{
                  readOnly: true,
                  renderSideBySide: mainSplit,
                  useInlineViewWhenSpaceIsLimited: false,
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

          {compareOn && active && ready && (
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
                  workingContent={ready.modified}
                  language={ready.language}
                  baseOid={compareOid}
                  refName={headRef}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="diff-pane__footer pr-diff-dialog__foot">
        <span>
          {[
            historyOn ? 'History on' : null,
            compareOn ? 'Compare on' : null,
            blameOn ? 'Blame on' : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'Current code diff'}
        </span>
        <span className="diff-pane__meta">
          +{added} −{removed} · {active?.path ?? ''}
        </span>
      </footer>
    </>
  );
}
