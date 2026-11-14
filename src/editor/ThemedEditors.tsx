import { useSyncExternalStore, type ComponentProps } from 'react';
import { Editor as MonacoEditor, DiffEditor as MonacoDiffEditor } from '@monaco-editor/react';
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
  return <MonacoDiffEditor {...props} theme={theme} />;
}
