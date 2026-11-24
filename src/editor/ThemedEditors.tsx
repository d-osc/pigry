import { Component, useEffectEvent, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { Editor as MonacoEditor, DiffEditor as MonacoDiffEditor } from '@monaco-editor/react';
import type { DiffOnMount, MonacoDiffEditor as DiffInstance } from '@monaco-editor/react';
import { currentResolvedTheme, THEME_CHANGED_EVENT } from '../lib/theme';
import './monacoSetup';

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(THEME_CHANGED_EVENT, onChange);
}

function useEditorTheme() {
  return `pigry-${useSyncExternalStore(subscribe, currentResolvedTheme)}`;
}

/** Monaco throws "… has been disposed" when its wrapper touches an editor that was torn down a moment earlier — it happens when React
 * re-runs effects (hot reload while developing, or a fast remount). The editor itself is fine: mounting a fresh one fixes it, so this
 * boundary does that (up to 3 times in a row) instead of letting the whole screen show a crash. Any other error goes on to the screen's boundary. */
const MAX_REMOUNTS = 3;
class DisposedGuard extends Component<{ children: ReactNode }, { attempt: number; failures: number; error: Error | null }> {
  state = { attempt: 0, failures: 0, error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    if (/has been disposed/i.test(error.message) && this.state.failures < MAX_REMOUNTS) {
      this.setState((s) => ({ attempt: s.attempt + 1, failures: s.failures + 1, error: null }));
      // a remount that stays up for a while is a success: the next incident starts counting from zero
      window.setTimeout(() => this.setState((s) => ({ failures: Math.max(0, s.failures - 1) })), 3000);
    }
  }
  render() {
    const { error, attempt } = this.state;
    if (error && !(/has been disposed/i.test(error.message) && this.state.failures < MAX_REMOUNTS)) throw error;
    if (error) return null; // the remount is scheduled by componentDidCatch
    return <div key={attempt} style={{ display: 'contents' }}>{this.props.children}</div>;
  }
}

// Theme is owned by the app, including editors mounted in dialogs and conflict views.
export function Editor(props: Omit<ComponentProps<typeof MonacoEditor>, 'theme'>) {
  const theme = useEditorTheme();
  return <DisposedGuard><MonacoEditor {...props} theme={theme} /></DisposedGuard>;
}

export function DiffEditor(props: Omit<ComponentProps<typeof MonacoDiffEditor>, 'theme'>) {
  const theme = useEditorTheme();
  const editorRef = useRef<DiffInstance | null>(null);
  const detachModels = useEffectEvent(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const models = editor.getModel();
    // Monaco requires detaching a diff model before disposing either side.
    // Do this before the library's passive cleanup, which disposes models first.
    editor.setModel(null);
    if (models) {
      if (!props.keepCurrentOriginalModel) models.original.dispose();
      if (!props.keepCurrentModifiedModel && models.modified !== models.original) models.modified.dispose();
    }
    editorRef.current = null;
  });
  useLayoutEffect(() => () => detachModels(), []);
  const onMount: DiffOnMount = (editor, monaco) => {
    editorRef.current = editor;
    props.onMount?.(editor, monaco);
  };
  return <DisposedGuard><MonacoDiffEditor {...props} theme={theme} onMount={onMount} /></DisposedGuard>;
}
