/** Monaco DiffEditor that reports text selections (คลุมดำ in either pane)
 * to the AI chat as attachable context. Monaco manages its own selection,
 * so DOM `selectionchange` never sees it — this hooks the editor API
 * directly. Drop-in for DiffEditor plus a `chatMeta` prop. */
import { type ComponentProps } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { shareSelectionWithChat } from './chatBridge';

interface ChatMeta {
  /** File being compared — shown on the chat chip and in the context block. */
  path: string;
  /** Workspace menu the compare lives in (e.g. "Rebase Branch"). */
  source: string;
}

/** Structural subset of the Monaco editor API — keeps this file free of
 * direct monaco-editor type imports. */
interface EditorLike {
  getModel(): unknown;
  onDidChangeCursorSelection(
    cb: (event: { selection: { isEmpty(): boolean } }) => void,
  ): { dispose(): void };
}

function attachEditor(editor: EditorLike, meta: ChatMeta) {
  editor.onDidChangeCursorSelection((event) => {
    if (event.selection.isEmpty()) return;
    const model = editor.getModel() as { getValueInRange(range: unknown): string } | null;
    if (!model) return;
    const text = model.getValueInRange(event.selection);
    if (!text.trim()) return;
    shareSelectionWithChat({ text: text.slice(0, 8000), path: meta.path, source: meta.source });
  });
}

type DiffEditorProps = ComponentProps<typeof DiffEditor>;

export function ChatAwareDiffEditor({
  chatMeta,
  onMount,
  ...rest
}: DiffEditorProps & { chatMeta: ChatMeta }) {
  const handleMount: DiffOnMount = (editor, monaco) => {
    attachEditor(editor.getOriginalEditor(), chatMeta);
    attachEditor(editor.getModifiedEditor(), chatMeta);
    onMount?.(editor, monaco);
  };
  return <DiffEditor onMount={handleMount} {...rest} />;
}
