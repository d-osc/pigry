/** AI commit-message generation. Uses the agent selected in chat (the
 * working-changes menu's default agent and the provider/model it points at,
 * mirroring the composer's model pill) when the app is connected to one;
 * callers fall back to the heuristic composer when this returns null. */
import {
  activeProvider,
  anthropicEndpoint,
  isCliProvider,
  loadProviders,
  providerStatus,
  resolveEndpoint,
} from './aiProviders';
import { builtinAgents, teamForScreen } from './agentExtras';
import { aiChat, cliAgentRun, getStagedDiffPreview } from './tauriClient';
import type { AiProviderEntry } from '../types/repository';

const MAX_DIFF_CHARS = 12_000;

interface ChatTarget {
  provider: AiProviderEntry;
  model: string;
  /** Label for the toast, e.g. "glm-5.3" or the provider name. */
  used: string;
}

/** Resolves the chat's selected agent the same way the AI panel's model pill
 * does: the default agent of this menu's team when it pins a provider/model,
 * otherwise the global chat selection. Null = not connected. */
function chatTarget(): ChatTarget | null {
  const providers = loadProviders();
  const active = activeProvider(providers);
  const team = teamForScreen('working-changes');
  const agent =
    builtinAgents().find(
      (entry) => entry.enabled && entry.tier === 'default' && entry.team === team,
    ) ?? null;
  const agentProvider = agent?.providerId
    ? providers.find((p) => p.id === agent.providerId) ?? null
    : null;
  const provider = agentProvider ?? active;
  if (!provider || provider.enabled === false) return null;
  // Orange (unusable) dot or model-less HTTP provider = not connected.
  if (providerStatus(provider) !== 'ok') return null;
  const model = agentProvider
    ? agent?.model || agentProvider.model || ''
    : active?.model ?? '';
  if (!model && !isCliProvider(provider)) return null;
  const effort = agent?.effort || provider.models.find((m) => m.name === model)?.effort || '';
  return {
    provider,
    model,
    used: model ? (effort ? `${model} · ${effort}` : model) : provider.name,
  };
}

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
 * Generates a commit message through the agent selected in chat.
 * Returns `null` when the app isn't connected to a provider/model — the
 * caller then uses the old heuristic composer. Throws on provider errors.
 */
export async function aiCommitMessage(): Promise<AiCommitResult | null> {
  const target = chatTarget();
  if (!target) return null;
  const { provider, model, used } = target;

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
    text = await cliAgentRun(cli, promptFor(diff), model || undefined);
  } else {
    const isAnthropic = provider.apiFormat === 'anthropic';
    const endpoint = isAnthropic
      ? anthropicEndpoint(resolveEndpoint(provider))
      : resolveEndpoint(provider);
    const payload = isAnthropic
      ? {
          model,
          max_tokens: 400,
          messages: [{ role: 'user', content: promptFor(diff) }],
        }
      : {
          model,
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
  return { message, used };
}
