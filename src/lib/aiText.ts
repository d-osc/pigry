/** One-shot text generation through the agent selected in chat — the path the
 * commit-message and pull-request-description generators share. */
import {
  activeProvider,
  anthropicEndpoint,
  configuredModelEffort,
  effortPayloadFragment,
  isCliProvider,
  loadProviders,
  matchModelSpec,
  maxOutputTokenPayload,
  providerStatus,
  resolveEndpoint,
} from './aiProviders';
import { emptyReplyMessage, readChatReply } from './chatReply';
import { builtinAgents, teamForScreen } from './agentExtras';
import { aiChat, cliAgentRun } from './tauriClient';
import type { AiProviderEntry } from '../types/repository';

export interface ChatTarget {
  provider: AiProviderEntry;
  model: string;
  /** Label for the toast, e.g. "glm-5.3" or the provider name. */
  used: string;
  /** Reasoning effort chosen for the agent or the model, sent the way the AI panel sends it. */
  effort?: string;
}

/** Resolves the chat's selected agent the same way the AI panel's model pill
 * does: the default agent of the screen's team when it pins a provider/model,
 * otherwise the global chat selection. Null = not connected. */
export function chatTarget(screen: string): ChatTarget | null {
  const providers = loadProviders();
  const active = activeProvider(providers);
  const team = teamForScreen(screen);
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
  const effort = agent?.effort || configuredModelEffort(provider.models.find((m) => m.name === model)) || '';
  return {
    provider,
    model,
    used: model ? (effort ? `${model} · ${effort}` : model) : provider.name,
    effort: effort || undefined,
  };
}

/** The language the user set for this model's text output, if any. */
export function targetLanguage({ provider, model }: ChatTarget): string | undefined {
  return provider.models.find((entry) => entry.name === model)?.textOutputLanguage;
}

/** Sends one prompt and returns the reply text, built like an AI panel turn: the model's own output-token limit and
 * reasoning effort go with it, so reasoning models have room to answer. Throws with a reason the user can act on when
 * the provider fails or sends no answer. `minTokens` is the floor for Anthropic when the model's limit is unknown. */
export async function completeText(
  { provider, model, used, effort }: ChatTarget,
  prompt: string,
  minTokens = 400,
): Promise<string> {
  if (isCliProvider(provider)) {
    // The provider type IS the CLI binary (claude-code → claude, zcode-cli → zcode).
    const cli =
      provider.type === 'claude-code'
        ? 'claude'
        : provider.type === 'zcode-cli'
          ? 'zcode'
          : provider.type;
    return cliAgentRun(cli, prompt, model || undefined);
  }
  const isAnthropic = provider.apiFormat === 'anthropic';
  const endpoint = isAnthropic
    ? anthropicEndpoint(resolveEndpoint(provider))
    : resolveEndpoint(provider);
  const entry = provider.models.find((item) => item.name === model);
  const knownLimit = entry?.maxOutputTokens ?? matchModelSpec(model)?.maxOutputTokens;
  const tokenLimit = maxOutputTokenPayload(
    provider.apiFormat,
    endpoint,
    knownLimit ?? (isAnthropic ? Math.max(minTokens, 4096) : undefined),
  );
  const effortParams = effortPayloadFragment(effort, entry?.reasoningMapping ?? matchModelSpec(model)?.reasoningMapping) ?? {};
  const messages = [{ role: 'user', content: prompt }];
  const payload = isAnthropic
    ? { model, ...tokenLimit, messages, ...effortParams }
    : { model, messages, ...tokenLimit, ...effortParams, stream: false };
  const result = await aiChat(
    endpoint,
    provider.apiKey,
    JSON.stringify(payload),
    isAnthropic ? 'anthropic' : 'bearer',
  );
  if (!result.ok) {
    let parsed: { error?: { message?: string } | string; message?: string } = {};
    try {
      parsed = JSON.parse(result.body) as typeof parsed;
    } catch {
      // non-JSON body — fall through to the status below
    }
    const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    throw new Error(detail ?? parsed.message ?? (result.error || `HTTP ${result.status}`));
  }
  const reply = readChatReply(result.body, isAnthropic);
  if (!reply.text.trim()) throw new Error(emptyReplyMessage(used, reply, result.body));
  return reply.text;
}
