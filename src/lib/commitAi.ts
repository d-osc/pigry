/** AI commit-message generation. Uses the chat's active provider when the
 * app is connected to one (green dot + a model, or a CLI agent); callers
 * fall back to the heuristic composer when this returns null or throws. */
import {
  activeProvider,
  anthropicEndpoint,
  isCliProvider,
  loadProviders,
  providerStatus,
  resolveEndpoint,
} from './aiProviders';
import { aiChat, cliAgentRun, getStagedDiffPreview } from './tauriClient';

const MAX_DIFF_CHARS = 12_000;

function promptFor(diff: string): string {
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
  ].join('\n');
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
 * Generates a commit message through the connected AI provider.
 * Returns `null` when the app isn't connected to a provider/model — the
 * caller then uses the old heuristic composer. Throws on provider errors.
 */
export async function aiCommitMessage(): Promise<AiCommitResult | null> {
  const provider = activeProvider(loadProviders());
  if (!provider || provider.enabled === false) return null;
  // Orange (unusable) dot or model-less HTTP provider = not connected.
  if (providerStatus(provider) !== 'ok') return null;
  if (!provider.model && !isCliProvider(provider)) return null;

  const diff = await getStagedDiffPreview(MAX_DIFF_CHARS);

  let text = '';
  if (isCliProvider(provider)) {
    // The provider type IS the CLI binary (claude-code → claude, zcode-cli → zcode).
    const cli =
      provider.type === 'claude-code'
        ? 'claude'
        : provider.type === 'zcode-cli'
          ? 'zcode'
          : provider.type;
    text = await cliAgentRun(cli, promptFor(diff), provider.model || undefined);
  } else {
    const isAnthropic = provider.apiFormat === 'anthropic';
    const endpoint = isAnthropic
      ? anthropicEndpoint(resolveEndpoint(provider))
      : resolveEndpoint(provider);
    const payload = isAnthropic
      ? {
          model: provider.model,
          max_tokens: 400,
          messages: [{ role: 'user', content: promptFor(diff) }],
        }
      : {
          model: provider.model,
          messages: [{ role: 'user', content: promptFor(diff) }],
          temperature: 0.2,
          stream: false,
        };
    const result = await aiChat(
      endpoint,
      provider.apiKey,
      JSON.stringify(payload),
      isAnthropic ? 'anthropic' : 'bearer',
    );
    let parsed: {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ type?: string; text?: string }>;
      error?: { message?: string };
      message?: string;
    } = {};
    try {
      parsed = JSON.parse(result.body) as typeof parsed;
    } catch {
      // non-JSON body — fall through to the error below
    }
    if (!result.ok) {
      throw new Error(
        parsed.error?.message ?? parsed.message ?? result.error ?? `HTTP ${result.status}`,
      );
    }
    text = isAnthropic
      ? (parsed.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('')
      : parsed.choices?.[0]?.message?.content ?? '';
  }

  const message = cleanMessage(text || '');
  if (!message) return null;
  const used = provider.model || provider.name;
  return { message, used };
}
