/** The Explorer editor's AI help, wired to the provider the user set up: the saved on/off switch and model
 * for ghost-text completions, the "thinking" flag the status bar shows, and the two model calls
 * (completion and inline edit). Uses the agent selected in the Explorer chat, like the other AI features. */
import { chatTarget, completeText, type ChatTarget } from './aiText';
import { isCliProvider } from './aiProviders';
import {
  buildCompletionPrompt, buildInlineEditPrompt, cleanCompletion, parseInlineEditReply,
  type CompletionRequest, type InlineEditRequest,
} from './inlineAi';

export const NO_PROVIDER_MESSAGE = 'No AI provider is connected — add one in Settings → AI Provider, then try again.';

const ENABLED_KEY = 'pigry:ai-completions';
const MODEL_KEY = 'pigry:ai-completions-model';
const CHANGED = 'pigry:ai-completions-changed';

export interface CompletionSettings {
  enabled: boolean;
  /** '' = the model the Explorer chat uses. */
  model: string;
}

let cached: CompletionSettings | null = null;

function read(): CompletionSettings {
  try {
    return {
      enabled: (localStorage.getItem(ENABLED_KEY) ?? '1') === '1',
      model: localStorage.getItem(MODEL_KEY) ?? '',
    };
  } catch {
    return { enabled: true, model: '' };
  }
}

/** Stable snapshot for useSyncExternalStore. */
export function completionSettings(): CompletionSettings {
  cached ??= read();
  return cached;
}

export function setCompletionSettings(patch: Partial<CompletionSettings>) {
  const next = { ...completionSettings(), ...patch };
  try {
    localStorage.setItem(ENABLED_KEY, next.enabled ? '1' : '0');
    localStorage.setItem(MODEL_KEY, next.model);
  } catch {
    // session-only
  }
  cached = next;
  window.dispatchEvent(new Event(CHANGED));
}

export function subscribeCompletionSettings(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ENABLED_KEY && event.key !== MODEL_KEY) return;
    cached = null;
    onChange();
  };
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

// "Thinking" counter behind the status-bar spinner.
let thinking = 0;
const thinkingListeners = new Set<() => void>();
const setThinking = (delta: number) => {
  thinking = Math.max(0, thinking + delta);
  for (const listener of thinkingListeners) listener();
};
export const isThinking = () => thinking > 0;
export function subscribeThinking(onChange: () => void) {
  thinkingListeners.add(onChange);
  return () => {
    thinkingListeners.delete(onChange);
  };
}

/** Runs `work` while the status bar shows the spinner. */
export async function withThinking<T>(work: () => Promise<T>): Promise<T> {
  setThinking(1);
  try {
    return await work();
  } finally {
    setThinking(-1);
  }
}

/** The chat target for code help: the Explorer chat's agent, with the completion model from Settings. */
export function codeTarget(): ChatTarget | null {
  return chatTarget('explorer');
}

/** Models the user can pick for completions: the Explorer chat provider's enabled models (none for CLI agents). */
export function completionModelChoices(): { provider: string; current: string; models: string[] } | null {
  const target = codeTarget();
  if (!target) return null;
  const models = isCliProvider(target.provider)
    ? []
    : target.provider.models.filter((entry) => entry.enabled !== false).map((entry) => entry.name);
  return { provider: target.provider.name, current: target.model, models };
}

function completionTarget(): ChatTarget | null {
  const target = codeTarget();
  // CLI agents start a whole process per call — far too slow for ghost text.
  if (!target || isCliProvider(target.provider)) return null;
  const { model } = completionSettings();
  const picked = model && target.provider.models.some((entry) => entry.name === model) ? model : target.model;
  // No reasoning effort: completions must come back fast.
  return { ...target, model: picked, used: picked, effort: undefined };
}

/** Ghost text for the cursor, or '' when the model has nothing (or no provider is connected). */
export async function requestCompletion(request: CompletionRequest): Promise<string> {
  const target = completionTarget();
  if (!target) return '';
  const reply = await completeText(target, buildCompletionPrompt(request), 256, { maxTokens: 256 });
  return cleanCompletion(reply, request.prefix, request.suffix);
}

/** Replacement code for a Ctrl+I edit. Throws a message fit to show the user. */
export async function requestInlineEdit(request: InlineEditRequest): Promise<{ code: string; used: string }> {
  const target = codeTarget();
  if (!target) throw new Error(NO_PROVIDER_MESSAGE);
  const reply = await completeText(target, buildInlineEditPrompt(request), 2000);
  const code = parseInlineEditReply(reply, request.region);
  if (!code.trim() && request.region.trim()) throw new Error(`${target.used} returned no code. Try again.`);
  return { code, used: target.used };
}
