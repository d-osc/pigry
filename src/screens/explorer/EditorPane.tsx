import { mayReloadBuffer, savedBufferIsDirty } from '../../lib/editorBuffer';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Monaco } from '@monaco-editor/react';
import { Editor } from '../../editor/ThemedEditors';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { GitCompare, GitMerge, History, Quote, Eye, RotateCcw,
} from 'lucide-react';
import { readWorktreeFile, writeWorktreeFile, readBinaryFile, openPathExternal, restoreFileFromCommit } from '../../lib/tauriClient';
import {
  canRestoreFromCommit, restoreConfirmMessage, restoreNeedsConfirm, restoreSourcePath, restoreToastMessage,
} from '../../lib/fileRestore';
import { useRepository } from '../../hooks/useRepository';
import { useFileBlame } from '../../hooks/useFileBlame';
import { useLineChanges } from '../../hooks/useLineChanges';
import { relativeTime } from '../../lib/relativeTime';
import type { FileCommitEntry, WorktreeFileContent } from '../../types/repository';
import { ResizeHandle } from '../../app/ResizeHandle';
import { FileHistoryPanel } from './FileHistoryPanel';
import { MergePanel } from './MergePanel';
import './MergePanel.css';
import { ConflictController } from '../../editor/conflictMarkers';
import type { EditorStatusInfo } from '../../app/StatusBar';
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
  /** Reports this pane's live info to the merged status bar (focused group
   * only — undefined while another group is focused). */
  onStatusChange?: (status: EditorStatusInfo | null) => void;
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
      fontSize: Number(localStorage.getItem('pigry:editor-font-size') ?? 12) || 12,
      wordWrap: (localStorage.getItem('pigry:editor-word-wrap') ?? '0') === '1',
      fontFamily:
        localStorage.getItem('pigry:editor-font-family') ?? "'Fira Code', ui-monospace, monospace",
      ligatures: (localStorage.getItem('pigry:editor-ligatures') ?? '1') === '1',
      tabSize: Number(localStorage.getItem('pigry:editor-tab-size') ?? 2) || 2,
      minimap: (localStorage.getItem('pigry:editor-minimap') ?? '0') === '1',
      lineNumbers: (localStorage.getItem('pigry:editor-line-numbers') ?? '1') === '1',
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
  onBufferChange,
  onJumpToCommit,
  onSelectionChange,
  onHistorySelect,
  onStatusChange,
}: EditorPaneProps) {
  const { refresh, busy, repository, notify } = useRepository();
  const [entry, setEntry] = useState<{
    path: string;
    content: WorktreeFileContent;
  } | null>(null);
  const [saveError, setSaveError] = useState<{ path: string; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [blameOn, setBlameOn] = useState(false);
  const [historyOn, setHistoryOn] = useState(false);
  const [compareOn, setCompareOn] = useState(false);
  const [mergeOn, setMergeOn] = useState(false);
  const [baseOid, setBaseOid] = useState<string | null>(null);
  // File history "Restore": the commit waiting for confirmation (it belongs
  // to the file it was asked for) and whether a restore is running.
  const [restoreAsk, setRestoreAsk] = useState<{ path: string; commit: FileCommitEntry } | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Switching files drops the history selection — it belongs to the old file
  // (adjust-state-on-change, no effect needed).
  const [prevPath, setPrevPath] = useState(path);
  if (prevPath !== path) {
    setPrevPath(path);
    setBaseOid(null);
  }
  // Special viewers — files that don't route into Monaco.
  const kind: ViewerKind = fileKindFor(path);
  const isEditableText = kind === 'text' || kind === 'markdown' || kind === 'svg';
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
  const conflictRef = useRef<ConflictController | null>(null);
  const [editorInstance, setEditorInstance] =
    useState<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
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
    window.addEventListener('pigry:editor-prefs', onPrefs);
    return () => window.removeEventListener('pigry:editor-prefs', onPrefs);
  }, [editorInstance]);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null);
  const draftRef = useRef(draft);
  const currentPath = useRef(path);
  const bufferSnapshot = useRef({ path: entry?.path, draft, saved: entry?.content.content });
  useLayoutEffect(() => {
    currentPath.current = path;
    bufferSnapshot.current = { path: entry?.path, draft, saved: entry?.content.content };
  }, [path, entry, draft]);
  const [loadAttempt, setLoadAttempt] = useState(0);
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
    const snapshot = bufferSnapshot.current;
    if (!mayReloadBuffer(path, snapshot.path, snapshot.draft, snapshot.saved)) return;
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
          const current = bufferSnapshot.current;
          if (!mayReloadBuffer(path, current.path, current.draft, current.saved)) return;
          setEntry({ path, content });
          draftRef.current = content.content;
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
  }, [path, kind, binReloadKey, loadAttempt]);

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

  /** Merge code — writes the merged buffer into the working file and
   * refreshes the editor buffer (the file watcher handles the tree). */
  const applyMerged = useCallback(
    async (merged: string) => {
      if (busy) return;
      try {
        await writeWorktreeFile(path, merged);
        setDraft(merged);
        draftRef.current = merged;
        setEntry((current) =>
          current && current.path === path
            ? { ...current, content: { ...current.content, content: merged } }
            : current,
        );
        onBufferChange(
          { content: merged, language: entry?.content.language ?? 'plaintext', dirty: true },
          path,
        );
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 1600);
        void refresh();
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    },
    [path, entry, busy, refresh, onBufferChange],
  );

  const save = useCallback(async () => {
    if (saving || busy) return;
    const writtenSnapshot = draftRef.current;
    setSaveError(null);
    setSaving(true);
    try {
      await writeWorktreeFile(path, writtenSnapshot);
      if (currentPath.current !== path) return;
      setEntry((previous) =>
        previous && previous.path === path
          ? { path, content: { ...previous.content, content: writtenSnapshot } }
          : previous,
      );
      await refresh();
      if (currentPath.current !== path) return;
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
      onBufferChange(
        {
          content: draftRef.current,
          language: entry?.content.language ?? '',
          dirty: savedBufferIsDirty(draftRef.current, writtenSnapshot),
        },
        path,
      );
    } catch (error) {
      if (currentPath.current === path) setSaveError({ path, message: error instanceof Error ? error.message : String(error) });
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
    window.addEventListener('pigry:save-file', onSave);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pigry:save-file', onSave);
    };
  }, [save]);

  const segments = path.split('/');
  const dirty = entry?.path === path && draft !== entry.content.content;
  const languageLabel = entry?.content.language || 'plaintext';
  const workingChange = repository?.files.some((file) => file.path === path) ?? false;

  /** Puts the working file back to its content at `commit` (an unstaged
   * change, nothing committed), then reloads the buffer and working changes. */
  const runRestore = async (commit: FileCommitEntry) => {
    setRestoreAsk(null);
    if (restoring || busy) return;
    setRestoring(true);
    try {
      const result = await restoreFileFromCommit(path, commit.oid, restoreSourcePath(path, commit));
      if (isEditableText) {
        const content = await readWorktreeFile(path);
        if (currentPath.current === path) {
          setLoadError(null);
          setSaveError(null);
          setEntry({ path, content });
          draftRef.current = content.content;
          setDraft(content.content);
          onBufferChange({ content: content.content, language: content.language, dirty: false }, path);
        }
      } else {
        const content = await readBinaryFile(path);
        if (currentPath.current === path) setBin(content);
      }
      await refresh();
      notify(restoreToastMessage(path, result), 'success');
    } catch (error) {
      notify(`Could not restore ${path}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setRestoring(false);
    }
  };
  const requestRestore = (commit: FileCommitEntry) => {
    if (!canRestoreFromCommit(commit) || restoring) return;
    if (restoreNeedsConfirm({ unsavedEdits: dirty, workingChange })) setRestoreAsk({ path, commit });
    else void runRestore(commit);
  };
  const pendingRestore = restoreAsk?.path === path ? restoreAsk.commit : null;
  // Live info for the merged status bar — reported while this pane is the
  // focused group; the callback flips to undefined when focus moves away.
  useEffect(() => {
    if (!onStatusChange) return;
    onStatusChange({
      path,
      line: cursor.line,
      column: cursor.column,
      language: languageLabel,
      dirty,
    });
  }, [onStatusChange, cursor, path, languageLabel, dirty]);
  const symbolName = useMemo(() => {
    const name = path.split('/').pop() ?? '';
    const base = name.replace(/\.[^.]+$/, '');
    return base
      .split(/[-_.]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }, [path]);

  // Blame decorations: inject author + sha after each line when blame mode
  // is on. Cleared when toggled off or when the file changes. The previous
  // collection is always cleared first so re-runs can never stack duplicate
  // labels on the same line.
  useEffect(() => {
    decorationsRef.current?.clear();
    if (!blameOn || !blameLines || !editorInstance) return;
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
          : `  ${line.shortOid} ${line.authorName} · ${relativeTime(line.timeSeconds)}`;
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

  // Monaco commands live in a global registry; explicitly unregister editor actions.
  useEffect(() => {
    if (!editorInstance) return;
    const jump = editorInstance.addAction({
      id: 'pigry.jumpToCommit', label: 'View commit in graph',
      run: (_editor, oid: string) => jumpRef.current(oid),
    });
    const copy = editorInstance.addAction({
      id: 'pigry.copySha', label: 'Copy full SHA',
      run: (_editor, sha: string) => { void navigator.clipboard?.writeText(sha); },
    });
    const copyMsg = editorInstance.addAction({
      id: 'pigry.copyMessage', label: 'Copy commit message',
      run: (_editor, message: string) => { void navigator.clipboard?.writeText(message); },
    });
    return () => { jump.dispose(); copy.dispose(); copyMsg.dispose(); };
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
          hoverModel: MonacoEditorNS.ITextModel,
          position: { lineNumber: number },
        ) => {
          // Providers register per language; ignore hovers from other editors
          // sharing the language so contents never merge across editors.
          if (hoverModel.id !== model.id) return null;
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
            {
              value: `👤 **${info.authorName}**${info.authorEmail ? ` \`<${info.authorEmail}>\`` : ''}`,
            },
            {
              value: `🕐 ${absolute} · ${relativeTime(info.timeSeconds)}`,
            },
            { value: `🔑 \`${info.oid}\`` },
            { value: `📄 \`${path}\` · line ${info.line}` },
          );
          if (info.filesChanged !== undefined) {
            contents.push({
              value: `📊 ${info.filesChanged} file${info.filesChanged === 1 ? '' : 's'} changed · +${info.insertions ?? 0} −${info.deletions ?? 0}`,
            });
          }
          contents.push({
            value: [
              `[View commit in graph](command:${editorInstance.getId()}:pigry.jumpToCommit?${encodeURIComponent(JSON.stringify([info.oid]))})`,
              `[Copy full sha](command:${editorInstance.getId()}:pigry.copySha?${encodeURIComponent(JSON.stringify([info.oid]))})`,
              `[Copy commit message](command:${editorInstance.getId()}:pigry.copyMessage?${encodeURIComponent(JSON.stringify([info.message]))})`,
            ].join(' · '),
            isTrusted: true,
          });
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
      {saveError?.path === path && <div className="error-banner" role="alert">{saveError.message}<button className="outline-button" disabled={saving} onClick={() => void save()}>Retry save</button></div>}
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
          {/* History works for every file: binaries can be restored too. */}
          <button
            type="button"
            className={`editor-toggle${historyOn ? ' editor-toggle--on' : ''}`}
            onClick={() => setHistoryOn((value) => !value)}
          >
            <History size={12} strokeWidth={1.5} />
            History
          </button>
          {isEditableText && (
            <button
              type="button"
              className={`editor-toggle${compareOn ? ' editor-toggle--on' : ''}`}
              onClick={() => setCompareOn((value) => !value)}
            >
              <GitCompare size={12} strokeWidth={1.5} />
              Compare
            </button>
          )}
          {isEditableText && (
            <button
              type="button"
              className={`editor-toggle${mergeOn ? ' editor-toggle--on' : ''}`}
              onClick={() => setMergeOn((value) => !value)}
            >
              <GitMerge size={12} strokeWidth={1.5} />
              Merge
            </button>
          )}
          {isEditableText && (
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

      {pendingRestore && (
        <div className="editor-pane__confirm" role="alertdialog" aria-label="Confirm restore">
          <RotateCcw size={12} strokeWidth={1.75} />
          <span className="editor-pane__confirm-text">
            {restoreConfirmMessage(path, pendingRestore, { unsavedEdits: dirty, workingChange })}
          </span>
          <button type="button" className="primary-button" onClick={() => void runRestore(pendingRestore)}>
            Restore
          </button>
          <button type="button" className="outline-button" onClick={() => setRestoreAsk(null)}>
            Cancel
          </button>
        </div>
      )}

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
              onRestore={requestRestore}
              restoring={restoring}
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
          <div className="editor-pane__notice" role="alert">{loadError}<button className="outline-button" onClick={() => setLoadAttempt((n) => n + 1)}>Try again</button></div>
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
            File is too large to edit (over 20 MB)
          </div>
        ) : (
          <Editor
            key={path}
            value={draft}
            language={entry.content.language}
            onChange={handleDraftChange}
            onMount={(editor, monaco) => {
              setEditorInstance(editor);
              monacoRef.current = monaco;
              editor.onDidChangeCursorPosition((event) =>
                setCursor({ line: event.position.lineNumber, column: event.position.column }),
              );
              // Conflict markers: decorate + recompute as the buffer changes.
              const controller = new ConflictController(editor, monaco);
              conflictRef.current = controller;
              controller.onChange = (text) => {
                setDraft(text);
                draftRef.current = text;
              };
              editor.onDidChangeModelContent(() => controller.update());
              controller.update();
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
              onRestore={requestRestore}
              restoring={restoring}
            />
          </div>
        </>
      )}

      {mergeOn && entry && (
        <MergePanel
          path={path}
          workingContent={draft}
          language={entry.content.language}
          baseOid={baseOid}
          onApply={(merged) => void applyMerged(merged)}
        />
      )}

    </div>
  );
}
