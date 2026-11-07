/**
 * Monaco bootstrap — bundles the editor locally (no CDN) and registers the
 * orbit-dark theme so every editor/diff instance matches the design tokens.
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

loader.config({ monaco });

monaco.editor.defineTheme('orbit-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'c9ced8' },
    { token: 'comment', foreground: '656d7c', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b59aff' },
    { token: 'keyword.control', foreground: '8b9dff' },
    { token: 'string', foreground: '6dd6ad' },
    { token: 'number', foreground: 'edb675' },
    { token: 'type', foreground: '62cee7' },
    { token: 'type.identifier', foreground: '62cee7' },
    { token: 'identifier', foreground: 'c9ced8' },
    { token: 'delimiter', foreground: '9299a7' },
    { token: 'tag', foreground: 'e79098' },
    { token: 'attribute.name', foreground: '8b9dff' },
    { token: 'attribute.value', foreground: '6dd6ad' },
    { token: 'variable', foreground: 'e9ebf0' },
    { token: 'function', foreground: '62cee7' },
  ],
  colors: {
    'editor.background': '#1a1d24',
    'editor.foreground': '#c9ced8',
    'editorGutter.background': '#1a1d24',
    'editorLineNumber.foreground': '#656d7c',
    'editorLineNumber.activeForeground': '#9299a7',
    'editor.lineHighlightBackground': '#20242b',
    'editorCursor.foreground': '#8b9dff',
    'editor.selectionBackground': '#252d49',
    'editor.inactiveSelectionBackground': '#20242b',
    'editorIndentGuide.background': '#252932',
    'editorIndentGuide.activeBackground': '#343a46',
    'editorWidget.background': '#191c22',
    'editorWidget.border': '#2a2e37',
    'editorSuggestWidget.background': '#191c22',
    'editorHoverWidget.background': '#191c22',
    'scrollbarSlider.background': '#30374380',
    'scrollbarSlider.hoverBackground': '#3d4450aa',
    'scrollbarSlider.activeBackground': '#43517baa',
    'diffEditor.insertedLineBackground': '#152a2466',
    'diffEditor.insertedTextBackground': '#152a2480',
    'diffEditor.removedLineBackground': '#453a2c66',
    'diffEditor.removedTextBackground': '#453a2c80',
    'diffEditor.border': '#2a2e37',
    'diffEditorOverview.insertedForeground': '#6dd6ad80',
    'diffEditorOverview.removedForeground': '#e7909880',
  },
});
