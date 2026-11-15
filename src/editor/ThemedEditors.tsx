import { useEffectEvent, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps } from 'react';
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

// Theme is owned by the app, including editors mounted in dialogs and conflict views.
export function Editor(props: Omit<ComponentProps<typeof MonacoEditor>, 'theme'>) {
  const theme = useEditorTheme();
  return <MonacoEditor {...props} theme={theme} />;
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
  return <MonacoDiffEditor {...props} theme={theme} onMount={onMount} />;
}
