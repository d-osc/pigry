/**
 * Monaco bootstrap — bundles the editor locally (no CDN) and registers the
 * pigry-dark theme so every editor/diff instance matches the design tokens.
 */
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { loader } from '@monaco-editor/react';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Monaco rejects an in-flight diff computation when its diff editor is disposed (navigating away, switching files):
// a cancellation, not an error — keep it out of the unhandled-rejection reports.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string } | string | undefined;
    const message = typeof reason === 'string' ? reason : reason?.message;
    if (message === 'no diff result available') event.preventDefault();
  });
}

loader.config({ monaco });

monaco.editor.defineTheme('pigry-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'e6edf3' },
    { token: 'comment', foreground: '8b949e', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'ff7b72' },
    { token: 'keyword.control', foreground: 'ff7b72' },
    { token: 'string', foreground: 'a5d6ff' },
    { token: 'number', foreground: '79c0ff' },
    { token: 'type', foreground: '62cee7' },
    { token: 'type.identifier', foreground: '62cee7' },
    { token: 'identifier', foreground: 'e6edf3' },
    { token: 'delimiter', foreground: '9299a7' },
    { token: 'tag', foreground: 'e79098' },
    { token: 'attribute.name', foreground: 'ff7b72' },
    { token: 'attribute.value', foreground: 'a5d6ff' },
    { token: 'variable', foreground: 'e9ebf0' },
    { token: 'function', foreground: '62cee7' },
  ],
  colors: {
    'editor.background': '#0d1117',
    'editor.foreground': '#e6edf3',
    'editorGutter.background': '#0d1117',
    'editorLineNumber.foreground': '#8b949e',
    'editorLineNumber.activeForeground': '#9198a1',
    'editor.lineHighlightBackground': '#161b22',
    'editorCursor.foreground': '#4493f8',
    'editor.selectionBackground': '#1f3350',
    'editor.inactiveSelectionBackground': '#161b22',
    'editorIndentGuide.background': '#252932',
    'editorIndentGuide.activeBackground': '#343a46',
    'editorWidget.background': '#161b22',
    'editorWidget.border': '#30363d',
    'editorSuggestWidget.background': '#161b22',
    'editorHoverWidget.background': '#161b22',
    'scrollbarSlider.background': '#30374380',
    'scrollbarSlider.hoverBackground': '#3d4450aa',
    'scrollbarSlider.activeBackground': '#43517baa',
    'diffEditor.insertedLineBackground': '#12261e',
    'diffEditor.insertedTextBackground': '#1c442880',
    'diffEditor.removedLineBackground': '#2d1519',
    'diffEditor.removedTextBackground': '#5d1f2680',
    'diffEditor.border': '#30363d',
    'diffEditorOverview.insertedForeground': '#6dd6ad80',
    'diffEditorOverview.removedForeground': '#e7909880',
  },
});

monaco.editor.defineTheme('pigry-light', {
  base: 'vs', inherit: true, rules: [],
  colors: {
    'editor.background': '#ffffff', 'editor.foreground': '#1f2328',
    'editorGutter.background': '#ffffff',
    'editorLineNumber.foreground': '#687384',
    'editorLineNumber.activeForeground': '#3d4652',
    'editor.selectionBackground': '#cbd6fa',
    'editor.inactiveSelectionBackground': '#e1e6f0',
    'editor.lineHighlightBackground': '#e9edf2',
    'editorWidget.background': '#ffffff', 'editorWidget.border': '#d1d9e0',
    'diffEditor.insertedLineBackground': '#dafbe1',
    'diffEditor.insertedTextBackground': '#b9e7cf80',
    'diffEditor.removedLineBackground': '#ffebe9',
    'diffEditor.removedTextBackground': '#f2b9c380',
    'diffEditor.border': '#d1d9e0', 'diffEditor.diagonalFill': '#d1d9e0',
  },
});
