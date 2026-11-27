/** AI commit-message generation. Uses the agent selected in chat (the
 * working-changes menu's default agent and the provider/model it points at,
 * mirroring the composer's model pill) when the app is connected to one;
 * callers fall back to the heuristic composer when this returns null. */
import { textOutputLanguageInstruction } from './aiProviders';
import { chatTarget, completeText, targetLanguage } from './aiText';
import { getStagedDiffPreview } from './tauriClient';

const MAX_DIFF_CHARS = 12_000;

function promptFor(diff: string, language?: string): string {
  return [
    'You are writing a git commit message for the staged changes below.',
    'Rules:',
    '- First line: concise imperative summary, max 72 chars, no trailing period.',
    '- Prefer a conventional prefix (feat:/fix:/refactor:/docs:/test:/chore:) when it fits.',
    '- Then one blank line, then a short body only if it adds real information.',
    '- Respond with ONLY the commit message text — no markdown fences, no commentary.',
    '',
    'Staged diff:',
    diff,
  ].join('\n') + textOutputLanguageInstruction(language);
}

/** Strips fences, wrapping quotes and excess whitespace from model output. */
function cleanMessage(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // One-line answers wrapped in quotes.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Some models prefix a label like "Commit message:".
  text = text.replace(/^commit message:?\s*\n?/i, '');
  return text.trim();
}

export interface AiCommitResult {
  message: string;
  /** Provider/model label for the toast. */
  used: string;
}

/**
 * Generates a commit message through the agent selected in chat.
 * Returns `null` when the app isn't connected to a provider/model — the
 * caller then uses the old heuristic composer. Throws on provider errors.
 */
export async function aiCommitMessage(): Promise<AiCommitResult | null> {
  const target = chatTarget('working-changes');
  if (!target) return null;

  const diff = await getStagedDiffPreview(MAX_DIFF_CHARS);
  const text = await completeText(target, promptFor(diff, targetLanguage(target)));

  const message = cleanMessage(text || '');
  if (!message) return null;
  return { message, used: target.used };
}
