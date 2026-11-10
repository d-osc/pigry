import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor, type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { GitCompare, History, Quote, SquareTerminal, Eye,
} from 'lucide-react';
import { readWorktreeFile, writeWorktreeFile, readBinaryFile, openPathExternal } from '../../lib/tauriClient';
import { currentResolvedTheme, THEME_CHANGED_EVENT } from '../../lib/theme';
import { useRepository } from '../../hooks/useRepository';
import { useFileBlame } from '../../hooks/useFileBlame';
import { useLineChanges } from '../../hooks/useLineChanges';
import { relativeTime } from '../../lib/relativeTime';
import type { WorktreeFileContent } from '../../types/repository';
import { TerminalPanel } from '../../app/TerminalPanel';
import { ResizeHandle } from '../../app/ResizeHandle';
import { FileHistoryPanel } from './FileHistoryPanel';
import { FileViewer, MarkdownViewer, SvgViewer, fileKindFor, type ViewerKind, type BinaryContent } from './FileViewers';
import { ComparePanel } from './ComparePanel';
import '../../editor/monacoSetup';
import './EditorPane.css';
import './FileViewers.css';

interface EditorPaneProps {
  path: string;
  /** Jump to this line once the buffer is ready (code-search navigation). */
  revealLine?: number | null;
  revealColumn?: number | null;
  /** Integrated terminal panel, shown between the editor and the footer. */
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  /** Reports the current buffer + dirty flag so tabs and the header stay in sync. */
  onBufferChange: (
    buffer: { content: string; language: string; dirty: boolean } | null,
    path: string,
  ) => void;
  /** Opens the commit graph focused on the given commit. */
  onJumpToCommit: (oid: string) => void;
  /** Reports the current text selection (VS Code-style "add to chat"). */
  onSelectionChange?: (
    selection: { path: string; text: string; startLine: number; endLine: number } | null,
  ) => void;
  /** Reports the history commit selected in the file-history panel (for the
   * AI chat's "attach file history" chip). */
  onHistorySelect?: (info: { path: string; oid: string } | null) => void;
}

function editorPrefs(): {
  fontSize: number;
  wordWrap: boolean;
  fontFamily: string;
  ligatures: boolean;
  tabSize: number;
  minimap: boolean;
  lineNumbers: boolean;
} {
  try {
    return {
      fontSize: Number(localStorage.getItem('orbit:editor-font-size') ?? 12) || 12,
      wordWrap: (localStorage.getItem('orbit:editor-word-wrap') ?? '0') === '1',
      fontFamily:
        localStorage.getItem('orbit:editor-font-family') ?? "'Fira Code', ui-monospace, monospace",
      ligatures: (localStorage.getItem('orbit:editor-ligatures') ?? '1') === '1',
      tabSize: Number(localStorage.getItem('orbit:editor-tab-size') ?? 2) || 2,
      minimap: (localStorage.getItem('orbit:editor-minimap') ?? '0') === '1',
      lineNumbers: (localStorage.getItem('orbit:editor-line-numbers') ?? '1') === '1',
    };
  } catch {
    return {
      fontSize: 12,
      wordWrap: false,
      fontFamily: "'Fira Code', ui-monospace, monospace",
      ligatures: true,
      tabSize: 2,
      minimap: false,
      lineNumbers: true,
    };
  }
}

export function EditorPane({
  path,
  revealLine,
  revealColumn,
  terminalOpen,
  onToggleTerminal,
  onBufferChange,
  onJumpToCommit,
  onSelectionChange,
  onHistorySelect,
}: EditorPaneProps) {
  const { refresh, busy, repository } = useRepository();
  const [entry, setEntry] = useState<{
    path: string;
    content: WorktreeFileContent;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [blameOn, setBlameOn] = useState(false);
  const [historyOn, setHistoryOn] = useState(true);
  const [compareOn, setCompareOn] = useState(false);
  const [baseOid, setBaseOid] = useState<string | null>(null);
  // Switching files drops the history selection — it belongs to the old file
  // (adjust-state-on-change, no effect needed).
  const [prevPath, setPrevPath] = useState(path);
  if (prevPath !== path) {
    setPrevPath(path);
    setBaseOid(null);
  }
  // Special viewers — files that don't route into Monaco.
  const kind: ViewerKind = fileKindFor(path);
  const [bin, setBin] = useState<BinaryContent | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [prevPreviewPath, setPrevPreviewPath] = useState(path);
  if (prevPreviewPath !== path) {
    setPrevPreviewPath(path);
    setPreviewOn(false);
    setBin(null);
  }
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  // Draggable panel heights; null = the CSS defaults.
  const [historyHeight, setHistoryHeight] = useState<number | null>(null);
  const [compareHeight, setCompareHeight] = useState<number | null>(null);
  const [editorInstance, setEditorInstance] =
    useState<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  // Editor colors follow the app theme (Settings → Appearance → Theme).
  const [uiTheme, setUiTheme] = useState<'orbit-dark' | 'orbit-light'>(() =>
    currentResolvedTheme() === 'light' ? 'orbit-light' : 'orbit-dark',
  );

  useEffect(() => {
    const onThemeChange = () =>
      setUiTheme(currentResolvedTheme() === 'light' ? 'orbit-light' : 'orbit-dark');
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
  }, []);

  // App Settings screen pushes editor preference changes live.
  useEffect(() => {
    const onPrefs = (event: Event) => {
      const detail = (event as CustomEvent<{
        fontSize?: number;
        wordWrap?: boolean;
        fontFamily?: string;
        ligatures?: boolean;
        tabSize?: number;
        minimap?: boolean;
        lineNumbers?: boolean;
      }>).detail;
      if (!detail || !editorInstance) return;
      editorInstance.updateOptions({
        fontSize: detail.fontSize ?? 12,
        wordWrap: detail.wordWrap ? 'on' : 'off',
        fontFamily: detail.fontFamily,
        fontLigatures: detail.ligatures,
        tabSize: detail.tabSize,
        minimap: { enabled: detail.minimap ?? false },
        lineNumbers: (detail.lineNumbers ?? true) ? 'on' : 'off',
      });
    };
    window.addEventListener('orbit:editor-prefs', onPrefs);
    return () => window.removeEventListener('orbit:editor-prefs', onPrefs);
  }, [editorInstance]);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null);
  const draftRef = useRef(draft);
  const jumpRef = useRef(onJumpToCommit);
  useEffect(() => {
    jumpRef.current = onJumpToCommit;
  }, [onJumpToCommit]);

  const { lines: blameLines } = useFileBlame(path, blameOn);
  // Gutter reload key — derived from the repository's change fingerprint so
  // gutter decorations recompute after saves, commits and staging.
  const gutterReloadKey = useMemo(
    () => repository?.files.map((file) => file.path).join('|') ?? '',
    [repository],
  );
  const { changes: lineChangesData } = useLineChanges(path, gutterReloadKey);
  // Binary viewers (images/pdf/office) refresh when the watcher sees a change.
  const binReloadKey = `${gutterReloadKey}|${repository?.files.length ?? 0}`;

  useEffect(() => {
    let cancelled = false;
    onBufferChange(null, path);
    if (kind !== 'text' && kind !== 'markdown' && kind !== 'svg') {
      // Images, PDFs and Office docs load as base64 for their viewers.
      // md/svg stay text (code view + rendered preview from the buffer).
      readBinaryFile(path)
        .then((content) => {
          if (!cancelled) {
            setLoadError(null);
            setBin(content);
          }
        })
        .catch(() => {
          if (!cancelled) setLoadError(`Could not load ${path}`);
        });
      return () => {
        cancelled = true;
      };
    }
    readWorktreeFile(path)
      .then((content) => {
        if (!cancelled) {
          setLoadError(null);
          setEntry({ path, content });
          setDraft(content.content);
          onBufferChange(
            { content: content.content, language: content.language, dirty: false },
            path,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(`Could not load ${path}`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, kind, binReloadKey]);

  // Code-search navigation: reveal + highlight the hit line once loaded.
  // Defensive: never let navigation break the editor mount.
  useEffect(() => {
    if (!revealLine || !entry || entry.path !== path || !editorInstance) return;
    try {
      const model = editorInstance.getModel();
      if (!model || revealLine > model.getLineCount()) return;
      editorInstance.revealLineNearTop(revealLine);
      editorInstance.setPosition({ lineNumber: revealLine, column: revealColumn ?? 1 });
      const monaco = monacoRef.current;
      if (monaco) {
        editorInstance.createDecorationsCollection([
          {
            range: new monaco.Range(revealLine, 1, revealLine, model.getLineMaxColumn(revealLine)),
            options: {
              isWholeLine: true,
              className: 'search-hit-line',
            },
          },
        ]);
      }
    } catch {
      // Navigation is best-effort; the editor content still renders.
    }
  }, [revealLine, revealColumn, entry, editorInstance, path]);

  // Report text selections upward (AI agent "add selection to chat").
  // Collapsed selections clear the report; switching files clears it too.
  const selectionCbRef = useRef(onSelectionChange);
  useEffect(() => {
    selectionCbRef.current = onSelectionChange;
  }, [onSelectionChange]);
  // Report the selected history commit upward (AI chat history chip). Only
  // real selections are reported — a transient remount (file-watcher tree
  // refresh) must not null out the chat's attached history.
  const historyCbRef = useRef(onHistorySelect);
  useEffect(() => {
    historyCbRef.current = onHistorySelect;
  }, [onHistorySelect]);
  useEffect(() => {
    if (baseOid && path) historyCbRef.current?.({ path, oid: baseOid });
  }, [baseOid, path]);
  useEffect(() => {
    if (!editorInstance) return;
    selectionCbRef.current?.(null);
    const disposable = editorInstance.onDidChangeCursorSelection((event) => {
      const sel = event.selection;
      const model = editorInstance.getModel();
      const collapsed =
        (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn) ||
        !model;
      if (collapsed) {
        selectionCbRef.current?.(null);
        return;
      }
      const text = model.getValueInRange(sel);
      if (!text.trim()) {
        selectionCbRef.current?.(null);
        return;
      }
      selectionCbRef.current?.({
        path,
        text,
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber,
      });
    });
    return () => disposable.dispose();
  }, [editorInstance, path]);

  const handleDraftChange = (value: string | undefined) => {
    const next = value ?? '';
    setDraft(next);
    // Keep the ref in sync — save() writes draftRef.current.
    draftRef.current = next;
    if (entry) {
      onBufferChange(
        { content: next, language: entry.content.language, dirty: next !== entry.content.content },
        path,
      );
    }
  };

  const save = useCallback(async () => {
    if (saving || busy) return;
    setSaving(true);
    try {
      await writeWorktreeFile(path, draftRef.current);
      setEntry((previous) =>
        previous && previous.path === path
          ? { path, content: { ...previous.content, content: draftRef.current } }
          : previous,
      );
      await refresh();
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
      onBufferChange(
        {
          content: draftRef.current,
          language: entry?.content.language ?? '',
          dirty: false,
        },
        path,
      );
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, path, refresh, saving]);

  // Ctrl+S / Cmd+S saves the current file; the Explorer header dispatches the
  // same action through a window event.
  useEffect(() => {
    const onSave = () => void save();
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('orbit:save-file', onSave);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('orbit:save-file', onSave);
    };
  }, [save]);

  const segments = path.split('/');
  const dirty = entry?.path === path && draft !== entry.content.content;
  const languageLabel = entry?.content.language || 'plaintext';
  const symbolName = useMemo(() => {
    const name = path.split('/').pop() ?? '';
    const base = name.replace(/\.[^.]+$/, '');
    return base
      .split(/[-_.]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }, [path]);

  // Blame decorations: inject author + sha after each line when blame mode
  // is on. Cleared when toggled off or when the file changes.
  useEffect(() => {
    const collection = decorationsRef.current;
    if (!blameOn || !blameLines || !editorInstance) {
      collection?.clear();
      return;
    }
    const model = editorInstance.getModel();
    if (!model) return;
    const monaco = monacoRef.current;
    if (!monaco) return;
    const decorations = blameLines
      .filter((line) => line.line <= model.getLineCount())
      .map((line) => {
        const lineNum = line.line;
        const maxCol = model.getLineMaxColumn(lineNum);
        const label = line.uncommitted
          ? '  — Uncommitted'
          : `  ${line.shortOid} ${line.authorInitials} · ${relativeTime(line.timeSeconds)}`;
        return {
          range: new monaco.Range(lineNum, 1, lineNum, maxCol),
          options: {
            after: {
              content: label,
              inlineClassName: 'blame-annotation',
            },
          },
        };
      });
    decorationsRef.current = editorInstance.createDecorationsCollection(decorations);
  }, [blameOn, blameLines, editorInstance, path]);

  // Jump-to-commit command used by the blame hover popup links. Commands die
  // with their editor instance, so no dispose is needed here.
  useEffect(() => {
    if (!editorInstance) return;
    editorInstance.addCommand(
      0,
      (_ctx, oid: string) => jumpRef.current(oid),
      'orbit.jumpToCommit',
    );
    editorInstance.addCommand(
      0,
      (_ctx, sha: string) => {
        void navigator.clipboard?.writeText(sha);
      },
      'orbit.copySha',
    );
  }, [editorInstance]);

  // Blame hover popup: rich GitLens-style card (summary, body, author with
  // email, absolute + relative dates, full sha, file/line, quick actions).
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorInstance?.getModel();
    if (!blameOn || !blameLines || !editorInstance || !monaco || !model) {
      return;
    }
    const byLine = new Map(blameLines.map((line) => [line.line, line]));
    const disposable = monaco.languages.registerHoverProvider(
      model.getLanguageId(),
      {
        provideHover: (
          _model: MonacoEditorNS.ITextModel,
          position: { lineNumber: number },
        ) => {
          const info = byLine.get(position.lineNumber);
          if (!info) return null;
          const range = new monaco.Range(position.lineNumber, 1, position.lineNumber, 1);

          if (info.uncommitted) {
            return {
              range,
              contents: [
                { value: '**Uncommitted changes**' },
                {
                  value: 'This line is edited in your working tree and is not part of any commit yet.',
                },
                {
                  value: `👤 You (working tree) · 📄 ${path} · line ${info.line}`,
                },
              ],
            };
          }

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
            {
              value: `👤 **${info.authorName}**${info.authorEmail ? ` \`<${info.authorEmail}>\`` : ''}`,
            },
            {
              value: `🕐 ${absolute} · ${relativeTime(info.timeSeconds)}`,
            },
            { value: `🔑 \`${info.oid}\`` },
            { value: `📄 \`${path}\` · line ${info.line}` },
            {
              value: [
                `[View commit in graph](command:orbit.jumpToCommit "${info.oid}")`,
                `[Copy full sha](command:orbit.copySha "${info.oid}")`,
              ].join(' · '),
              isTrusted: true,
            },
          );
          return { range, contents };
        },
      },
    );
    return () => disposable.dispose();
  }, [blameOn, blameLines, editorInstance, path]);

  // Gutter decorations: mark added/modified lines vs HEAD.
  const gutterDecorationsRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    const editor = editorInstance;
    if (!editor || !lineChangesData) {
      gutterDecorationsRef.current?.clear();
      return;
    }
    const model = editor.getModel();
    const monaco = monacoRef.current;
    if (!model || !monaco) return;
    const decorations = lineChangesData
      .filter((change) => change.line <= model.getLineCount())
      .map((change) => ({
        range: new monaco.Range(change.line, 1, change.line, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName:
            change.change === 'added' ? 'gutter-added' : 'gutter-modified',
        },
      }));
    gutterDecorationsRef.current = editor.createDecorationsCollection(decorations);
  }, [lineChangesData, editorInstance, path]);

  return (
    <div className="editor-pane">
      <div className="editor-pane__crumbrow">
        <nav className="editor-pane__breadcrumb" aria-label="File path">
          {segments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="editor-pane__crumb">
              {segment}
              {index < segments.length - 1 && <span className="editor-pane__crumb-sep">›</span>}
            </span>
          ))}
          <span className="editor-pane__symbol">{symbolName}</span>
        </nav>
        {dirty && <span className="editor-pane__dirty">Unsaved changes</span>}
        {savedFlash && !dirty && <span className="editor-pane__saved">Saved</span>}
        <div className="editor-pane__toggles">
          {(kind === 'markdown' || kind === 'svg') && (
            <button
              type="button"
              className={`editor-toggle${previewOn ? ' editor-toggle--on' : ''}`}
              onClick={() => setPreviewOn((value) => !value)}
            >
              <Eye size={12} strokeWidth={1.5} />
              Preview
            </button>
          )}
          {kind === 'pptx' && (
            <button
              type="button"
              className="editor-toggle"
              onClick={() => void openPathExternal(path)}
            >
              <Eye size={12} strokeWidth={1.5} />
              Open externally
            </button>
          )}
          {kind === 'text' && (
            <button
              type="button"
              className={`editor-toggle${historyOn ? ' editor-toggle--on' : ''}`}
              onClick={() => setHistoryOn((value) => !value)}
            >
              <History size={12} strokeWidth={1.5} />
              History
            </button>
          )}
          {kind === 'text' && (
            <button
              type="button"
              className={`editor-toggle${compareOn ? ' editor-toggle--on' : ''}`}
              onClick={() => setCompareOn((value) => !value)}
            >
              <GitCompare size={12} strokeWidth={1.5} />
              Compare
            </button>
          )}
          {kind === 'text' && (
            <button
              type="button"
              className={`editor-toggle${blameOn ? ' editor-toggle--on' : ''}`}
              onClick={() => setBlameOn((value) => !value)}
            >
              <Quote size={12} strokeWidth={1.5} />
              Blame
            </button>
          )}
        </div>
      </div>

      {historyOn && (
        <>
          <div
            className="editor-pane__history"
            style={historyHeight ? { maxHeight: historyHeight } : undefined}
          >
            <FileHistoryPanel
              path={path}
              selectedOid={baseOid}
              onSelect={setBaseOid}
            />
          </div>
          <ResizeHandle
            orientation="h"
            label="Resize file history"
            onDelta={(_dx, dy) =>
              setHistoryHeight((h) => Math.min(480, Math.max(90, (h ?? 190) + dy)))
            }
          />
        </>
      )}

      <div className="editor-pane__editor">
        {loadError ? (
          <div className="editor-pane__notice">{loadError}</div>
        ) : kind !== 'text' && kind !== 'markdown' && kind !== 'svg' ? (
          // Images, PDFs and Office docs — dedicated viewers, no Monaco.
          bin ? (
            <FileViewer kind={kind} bin={bin} path={path} textContent="" />
          ) : (
            <div className="editor-pane__notice">Loading…</div>
          )
        ) : !entry || entry.path !== path ? (
          <div className="editor-pane__notice">Loading…</div>
        ) : (kind === 'markdown' || kind === 'svg') && previewOn ? (
          kind === 'markdown' ? (
            <MarkdownViewer text={entry.content.content} />
          ) : (
            <SvgViewer text={entry.content.content} />
          )
        ) : entry.content.binary ? (
          <div className="editor-pane__notice">Binary file — cannot edit</div>
        ) : entry.content.tooLarge ? (
          <div className="editor-pane__notice">
            File is too large to edit (over 1 MB)
          </div>
        ) : (
          <Editor
            key={path}
            value={draft}
            language={entry.content.language}
            theme={uiTheme}
            onChange={handleDraftChange}
            beforeMount={(monaco) => {
              monaco.editor.defineTheme('orbit-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [],
                colors: {
                  'editor.background': '#1a1d24',
                  'editorGutter.background': '#1a1d24',
                },
              });
              monaco.editor.defineTheme('orbit-light', {
                base: 'vs',
                inherit: true,
                rules: [],
                colors: {
                  'editor.background': '#f4f6f8',
                  'editorGutter.background': '#f4f6f8',
                },
              });
            }}
            onMount={(editor, monaco) => {
              setEditorInstance(editor);
              monacoRef.current = monaco;
              editor.onDidChangeCursorPosition((event) =>
                setCursor({ line: event.position.lineNumber, column: event.position.column }),
              );
            }}
            options={{
              fontSize: editorPrefs().fontSize,
              wordWrap: editorPrefs().wordWrap ? 'on' : 'off',
              lineHeight: 19,
              fontFamily: editorPrefs().fontFamily,
              fontLigatures: editorPrefs().ligatures,
              tabSize: editorPrefs().tabSize,
              lineNumbers: editorPrefs().lineNumbers ? 'on' : 'off',
              minimap: { enabled: editorPrefs().minimap },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderWhitespace: 'selection',
              padding: { top: 10, bottom: 10 },
              scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
                useShadows: false,
              },
              stickyScroll: { enabled: false },
            }}
          />
        )}
      </div>

      {compareOn && entry && (
        <>
          <ResizeHandle
            orientation="h"
            label="Resize compare view"
            onDelta={(_dx, dy) =>
              setCompareHeight((h) => Math.min(560, Math.max(120, (h ?? 280) - dy)))
            }
          />
          <div className="editor-pane__compare" style={compareHeight ? { height: compareHeight } : undefined}>
            <ComparePanel
              path={path}
              workingContent={draft}
              language={entry.content.language}
              baseOid={baseOid}
            />
          </div>
        </>
      )}

      {terminalOpen && (
        <TerminalPanel
          cwd={repository?.localPath ?? ''}
          onClose={() => onToggleTerminal?.()}
        />
      )}

      <footer className="editor-pane__status">
        <span className="editor-pane__branch">
          <i />
          {repository?.currentBranch ?? 'main'}
          {dirty ? '✱' : ''}
        </span>
        <span className="editor-pane__status-right">
          Ln {cursor.line}, Col {cursor.column} · Spaces: 2 · UTF-8 · LF · {languageLabel}
          <button
            type="button"
            className="editor-pane__terminal"
            aria-label="Toggle terminal"
            onClick={() => onToggleTerminal?.()}
          >
            <SquareTerminal size={11} strokeWidth={1.5} />
            Terminal
          </button>
        </span>
      </footer>
    </div>
  );
}
