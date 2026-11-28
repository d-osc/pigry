/** Copilot-style ghost text for the Explorer editor. One Monaco provider serves every Explorer editor; each
 * editor registers its model with `attachInlineCompletions`, and models without a registration (diff views,
 * dialogs, other menus) get nothing. Tab accepts, Esc dismisses and Ctrl+→ accepts the next word — Monaco's
 * own inline-suggest commands. */
import type * as MonacoNS from 'monaco-editor';
import {
  contextWindow, createDebouncer, createRequestGate, debounceFor, reuseCompletion, shouldOfferCompletion,
  COMPLETION_DEBOUNCE_MS, type CachedCompletion,
} from '../lib/inlineAi';
import { completionSettings, requestCompletion, withThinking } from '../lib/inlineAiClient';

type Monaco = typeof MonacoNS;

export interface CompletionSource {
  path: () => string;
  language: () => string;
  /** Why this file must not be sent (secret, ignored, binary, too large), or null. */
  skipReason: () => string | null;
}

const sources = new Map<string, CompletionSource>();
const gate = createRequestGate();
const debouncer = createDebouncer(COMPLETION_DEBOUNCE_MS);
let cache: CachedCompletion | null = null;
let registration: MonacoNS.IDisposable | null = null;

function ensureProvider(monaco: Monaco) {
  if (registration) return;
  registration = monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, context, token) {
      const source = sources.get(model.uri.toString());
      if (!source || !completionSettings().enabled || source.skipReason()) return undefined;
      const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      const line = model.getLineContent(position.lineNumber);
      const linePrefix = line.slice(0, position.column - 1);
      const lineSuffix = line.slice(position.column - 1);
      if (!explicit && !shouldOfferCompletion(linePrefix, lineSuffix)) return undefined;
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const path = source.path();
      const fullPrefix = text.slice(0, offset);
      const fullSuffix = text.slice(offset);
      const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
      const items = (insertText: string) => (insertText ? { items: [{ insertText, range }] } : undefined);

      const reused = reuseCompletion(cache, path, fullPrefix, fullSuffix);
      if (reused !== null) return items(reused);

      const id = gate.next();
      const go = await debouncer.wait(debounceFor(explicit));
      if (!go || token.isCancellationRequested || !gate.isCurrent(id)) return undefined;
      const { prefix, suffix } = contextWindow(text, offset);
      let completion = '';
      try {
        completion = await withThinking(() => requestCompletion({ path, language: source.language(), prefix, suffix }));
      } catch {
        // A failed completion shows nothing; the next keystroke tries again.
        return undefined;
      }
      // Cached even when stale: it is reused if the user types the same characters.
      cache = { path, prefix: fullPrefix, suffix: fullSuffix, text: completion };
      if (token.isCancellationRequested || !gate.isCurrent(id)) return undefined;
      return items(completion);
    },
    disposeInlineCompletions() {
      // nothing held per list
    },
  });
}

/** Serves ghost text to `editor`'s model while the returned handle lives. */
export function attachInlineCompletions(
  monaco: Monaco,
  editor: MonacoNS.editor.IStandaloneCodeEditor,
  source: CompletionSource,
): MonacoNS.IDisposable {
  ensureProvider(monaco);
  const model = editor.getModel();
  const key = model?.uri.toString() ?? '';
  if (key) sources.set(key, source);
  return {
    dispose() {
      if (key && sources.get(key) === source) sources.delete(key);
      gate.cancelAll();
      debouncer.cancel();
      if (sources.size === 0) {
        registration?.dispose();
        registration = null;
        cache = null;
      }
    },
  };
}

/** Drops pending requests and the shown ghost text (the user turned completions off). */
export function hideInlineCompletion(editor: MonacoNS.editor.IStandaloneCodeEditor) {
  gate.cancelAll();
  debouncer.cancel();
  editor.trigger('pigry-ai', 'editor.action.inlineSuggest.hide', null);
}
