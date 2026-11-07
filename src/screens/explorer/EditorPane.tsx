import { useCallback, useEffect, useRef, useState } from 'react';
import { Editor } from '@monaco-editor/react';
import { Save } from 'lucide-react';
import { readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { useRepository } from '../../hooks/useRepository';
import type { WorktreeFileContent } from '../../types/repository';
import '../../editor/monacoSetup';
import './EditorPane.css';

interface EditorPaneProps {
  path: string;
}

export function EditorPane({ path }: EditorPaneProps) {
  const { refresh, busy } = useRepository();
  const [entry, setEntry] = useState<{
    path: string;
    content: WorktreeFileContent;
  } | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const draftRef = useRef(draft);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    readWorktreeFile(path)
      .then((content) => {
        if (!cancelled) {
          setEntry({ path, content });
          setDraft(content.content);
        }
      })
      .catch(() => {
        if (!cancelled) setEntry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

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

  if (!entry || entry.path !== path) {
    return <div className="editor-pane__notice">Loading…</div>;
  }
  const { content } = entry;
  if (content.binary) {
    return <div className="editor-pane__notice">Binary file — cannot edit</div>;
  }
  if (content.tooLarge) {
    return <div className="editor-pane__notice">File is too large to edit (over 1 MB)</div>;
  }

  const dirty = draft !== content.content;

  return (
    <div className="editor-pane">
      <header className="editor-pane__bar">
        <span className="editor-pane__path">{path}</span>
        {dirty && <span className="editor-pane__dirty">Unsaved changes</span>}
        {savedFlash && !dirty && <span className="editor-pane__saved">Saved</span>}
        <button
          type="button"
          className="outline-button"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          <Save size={12} />
          {saving ? 'Saving…' : 'Save'}
        </button>
        <kbd className="editor-pane__kbd">Ctrl S</kbd>
      </header>
      <div className="editor-pane__editor">
        <Editor
          key={path}
          value={draft}
          language={content.language}
          theme="orbit-dark"
          onChange={(value) => setDraft(value ?? '')}
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
      </div>
    </div>
  );
}
