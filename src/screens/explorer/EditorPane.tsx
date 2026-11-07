import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor, type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { Save } from 'lucide-react';
import { readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { useRepository } from '../../hooks/useRepository';
import { useFileBlame } from '../../hooks/useFileBlame';
import { useLineChanges } from '../../hooks/useLineChanges';
import { relativeTime } from '../../lib/relativeTime';
import type { WorktreeFileContent } from '../../types/repository';
import '../../editor/monacoSetup';
import './EditorPane.css';

interface EditorPaneProps {
  path: string;
  historyOn: boolean;
  compareOn: boolean;
  onToggleHistory: () => void;
  onToggleCompare: () => void;
  /** Reports the current buffer so the compare panel can diff against it. */
  onBufferChange: (buffer: { content: string; language: string } | null) => void;
}

export function EditorPane({
  path,
  historyOn,
  compareOn,
  onToggleHistory,
  onToggleCompare,
  onBufferChange,
}: EditorPaneProps) {
  const { refresh, busy } = useRepository();
  const [entry, setEntry] = useState<{
    path: string;
    content: WorktreeFileContent;
  } | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [blameOn, setBlameOn] = useState(false);
  const [editorInstance, setEditorInstance] =
    useState<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null);
  const draftRef = useRef(draft);

  const { lines: blameLines } = useFileBlame(path, blameOn);
  const { repository } = useRepository();
  // Gutter reload key — derived from the repository's change fingerprint so
  // gutter decorations recompute after saves, commits and staging.
  const gutterReloadKey = useMemo(
    () => repository?.files.map((file) => file.path).join('|') ?? '',
    [repository],
  );
  const { changes: lineChangesData } = useLineChanges(path, gutterReloadKey);

  useEffect(() => {
    let cancelled = false;
    onBufferChange(null);
    readWorktreeFile(path)
      .then((content) => {
        if (!cancelled) {
          setEntry({ path, content });
          setDraft(content.content);
          onBufferChange({
            content: content.content,
            language: content.language,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setEntry(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const handleDraftChange = (value: string | undefined) => {
    const next = value ?? '';
    setDraft(next);
    if (entry) {
      onBufferChange({ content: next, language: entry.content.language });
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
    } finally {
      setSaving(false);
    }
  }, [busy, path, refresh, saving]);

  // Ctrl+S / Cmd+S saves the current file.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  const segments = path.split('/');
  const dirty = entry?.path === path && draft !== entry.content.content;

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
      <header className="editor-pane__bar">
        <nav className="editor-pane__breadcrumb" aria-label="File path">
          {segments.map((segment, index) => (
            <span
              key={`${segment}-${index}`}
              className={
                index === segments.length - 1 ? 'editor-pane__crumb--last' : undefined
              }
            >
              {segment}
              {index < segments.length - 1 && (
                <span className="editor-pane__crumb-sep">/</span>
              )}
            </span>
          ))}
        </nav>
        {dirty && <span className="editor-pane__dirty">Unsaved changes</span>}
        {savedFlash && !dirty && <span className="editor-pane__saved">Saved</span>}
        <div className="editor-pane__toggles">
          <button
            type="button"
            className={`toggle-pill${historyOn ? ' toggle-pill--on' : ''}`}
            onClick={onToggleHistory}
          >
            File history <span>{historyOn ? 'ON' : 'OFF'}</span>
          </button>
          <button
            type="button"
            className={`toggle-pill${compareOn ? ' toggle-pill--on' : ''}`}
            onClick={onToggleCompare}
          >
            Compare code <span>{compareOn ? 'ON' : 'OFF'}</span>
          </button>
          <button
            type="button"
            className={`toggle-pill${blameOn ? ' toggle-pill--on' : ''}`}
            onClick={() => setBlameOn((value) => !value)}
          >
            Blame <span>{blameOn ? 'ON' : 'OFF'}</span>
          </button>
        </div>
        <button
          type="button"
          className="outline-button"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          <Save size={12} />
          {saving ? 'Saving…' : 'Save'}
        </button>
        <kbd className="editor-pane__kbd">⌘ S</kbd>
      </header>
      <div className="editor-pane__editor">
        {!entry || entry.path !== path ? (
          <div className="editor-pane__notice">Loading…</div>
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
            theme="orbit-dark"
            onChange={handleDraftChange}
            onMount={(editor, monaco) => {
              setEditorInstance(editor);
              monacoRef.current = monaco;
            }}
            options={{
              fontSize: 12,
              lineHeight: 19,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              minimap: { enabled: true, scale: 1 },
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
    </div>
  );
}
