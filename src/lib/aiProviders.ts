/** AI provider store — shared by Settings and the AI agent panels.
 *
 * Providers live in localStorage under `pigry:ai-providers`; the active one
 * is `pigry:ai-active`. The legacy single-provider key `pigry:ai-provider`
 * is kept mirrored so older consumers keep working.
 */
import type { AiProviderEntry, AiModelEntry, AiApiFormat } from '../types/repository';

export type { AiProviderEntry, AiModelEntry, AiApiFormat };

const LIST_KEY = 'pigry:ai-providers';
const ACTIVE_KEY = 'pigry:ai-active';

/** API keys that old builds baked in for throwaway test providers. Stored
 * entries still holding one are dropped on load (a customized key survives). */
const SEED_TEST_KEYS = [
  // qwen-cloud first-run seed
  'sk-sp-H.DIMED.vYbS.MEQCIEy6iulOjWXOLgPw684T5rX3ndHy3zRAmRxpbuDmiMtgAiBF6S8M1bUzjb9zuxWUK0_yk-J9rLmID0NRyk3NKRlk8A',
  // zai-test
  'c466230fbad74dda9f33d3cc9c18fdf1.kN4JqIlzCGV9mdkx',
];

/** Removes entries created by old builds' test seeds: the code-managed
 * "Z.ai (test)" provider and a Qwen Cloud copy still on its seeded key. */
function dropTestProviders(list: AiProviderEntry[]): AiProviderEntry[] {
  return list.filter(
    (entry) =>
      entry.id !== 'zai-test' &&
      !(entry.id === 'qwen-cloud' && SEED_TEST_KEYS.includes(entry.apiKey)),
  );
}

export const API_FORMAT_LABEL: Record<AiApiFormat, string> = {
  openai: 'OpenAI chat completions (/v1/chat/completions)',
  anthropic: 'Anthropic messages (/v1/messages)',
};

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

function makeModel(name: string, vision: boolean): AiModelEntry {
  return { id: uid('m'), name, vision, enabled: true };
}

/** Fills in fields added after the flat single-model era. */
/** Legacy type → canonical type (the generic scan uses binary names). */
const CANONICAL_TYPES: Record<string, string> = {
  claude: 'claude-code',
};

function migrate(raw: Partial<AiProviderEntry> & Record<string, unknown>): AiProviderEntry {
  const rawType = String(raw.type ?? 'custom');
  const entry: AiProviderEntry = {
    id: String(raw.id ?? uid('p')),
    name: String(raw.name ?? 'Provider'),
    kind: raw.kind === 'builtin' ? 'builtin' : 'custom',
    type: CANONICAL_TYPES[rawType] ?? rawType,
    apiFormat:
      raw.apiFormat === 'anthropic'
        ? 'anthropic'
        : 'openai',
    baseUrl: String(raw.baseUrl ?? ''),
    apiKey: String(raw.apiKey ?? ''),
    model: String(raw.model ?? ''),
    enabled: raw.enabled !== false,
    models: [],
  };
    if (raw.detected === true) entry.detected = true;
    if (raw.usable === false) entry.usable = false;
    if (typeof raw.launchKind === 'string' && raw.launchKind) entry.launchKind = raw.launchKind;
    if (typeof raw.launchTarget === 'string' && raw.launchTarget) {
      entry.launchTarget = raw.launchTarget;
    }
    if (raw.zcodeProvider === true) entry.zcodeProvider = true;
    if (
      raw.planInfo &&
      typeof (raw.planInfo as Record<string, unknown>).fetchedAt === 'number' &&
      typeof (raw.planInfo as Record<string, unknown>).body === 'string'
    ) {
      entry.planInfo = raw.planInfo as AiProviderEntry['planInfo'];
    }
  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  entry.models = rawModels
    .map((m) => {
      const item = m as Partial<AiModelEntry> & Record<string, unknown>;
      const name = String(item?.name ?? '');
      if (!name) return null;
      const model: AiModelEntry = {
        id: String(item.id ?? uid('m')),
        name,
        vision: Boolean(item.vision),
        enabled: item.enabled !== false,
      };
      if (typeof item.context === 'string' && item.context) model.context = item.context;
      if (typeof item.contextWindow === 'number' && item.contextWindow > 0) {
        model.contextWindow = item.contextWindow;
      }
      if (typeof item.maxOutputTokens === 'number' && item.maxOutputTokens > 0) {
        model.maxOutputTokens = item.maxOutputTokens;
      }
      if (Array.isArray(item.inputTypes)) {
        model.inputTypes = item.inputTypes.map(String).filter(Boolean);
      }
      if (Array.isArray(item.capabilities)) {
        model.capabilities = item.capabilities.map(String).filter(Boolean);
      }
      if (Array.isArray(item.reasoningLevels)) {
        model.reasoningLevels = item.reasoningLevels.map(String).filter(Boolean);
      }
      if (typeof item.reasoningMapping === 'string' && item.reasoningMapping) {
        model.reasoningMapping = item.reasoningMapping;
      }
      if (typeof item.effort === 'string' && item.effort) model.effort = item.effort;
      if (item.smartConfig === true) model.smartConfig = true;
      return model;
    })
    .filter((m): m is AiModelEntry => m !== null);
  // Legacy flat entry without models: promote the single model.
  if (entry.models.length === 0 && entry.model) {
    entry.models = [makeModel(entry.model, false)];
  }
  // Keep the legacy mirror in sync for older consumers.
  entry.model = entry.models.find((m) => m.enabled)?.name ?? entry.models[0]?.name ?? '';
  return entry;
}

function writeLegacyMirror(providers: AiProviderEntry[], activeId: string) {
  try {
    const active = providers.find((p) => p.id === activeId) ?? providers[0];
    if (!active) return;
    localStorage.setItem(
      'pigry:ai-provider',
      JSON.stringify({
        provider: active.type === 'zcode' ? 'zcode' : active.apiFormat,
        model: active.model,
        baseUrl: active.baseUrl,
        apiKey: active.apiKey,
      }),
    );
  } catch {
    // session-only
  }
}

/** Loads providers, migrating legacy shapes. */
/** Fills the registry's vendor reasoning levels/mapping into models that
 * don't define their own — every known model gets its effort knob. */
function applyRegistryDefaults(list: AiProviderEntry[]): AiProviderEntry[] {
  for (const entry of list) {
    entry.models = entry.models.map((model) => {
      if (model.reasoningLevels?.length) return model;
      const spec = matchModelSpec(model.name);
      if (!spec?.reasoningLevels?.length) return model;
      return {
        ...model,
        reasoningLevels: spec.reasoningLevels,
        reasoningMapping: spec.reasoningMapping ?? model.reasoningMapping,
      };
    });
  }
  return list;
}

/** Drops duplicate scanned-app entries (same app type added twice under
 * different ids — e.g. before type canonicalization). Keeps the first. */
function dedupeAppProviders(list: AiProviderEntry[]): AiProviderEntry[] {
  const seen = new Set<string>();
  const out: AiProviderEntry[] = [];
  for (const entry of list) {
    if (entry.kind !== 'builtin' && APP_PROVIDER_TYPES.has(entry.type)) {
      if (seen.has(entry.type)) continue;
      seen.add(entry.type);
    }
    out.push(entry);
  }
  return out;
}

/** Provider types that come from the installed-AI-apps scan. */
const APP_PROVIDER_TYPES = new Set([
  'claude-code',
  'codex',
  'copilot',
  'gemini',
  'claude',
  'zcode-cli',
  'autoclaw',
  'workbuddy',
  'traework',
  'conebuddy',
  'traecode',
  'opencode',
  'cursor-agent',
  'cursor',
  'openclaw',
  'claude-desktop',
  'chatgpt-desktop',
  'gemini-desktop',
]);

/** True for providers pulled from ZCode desktop's own catalog. */
export function isZcodeProvider(entry: AiProviderEntry): boolean {
  return entry.zcodeProvider === true || entry.type.startsWith('zcode-');
}

/** Marks scanned-app providers so they group under "Installed AI apps" —
 * self-healing for entries added before the flag existed. */
function markAppProviders(list: AiProviderEntry[]): AiProviderEntry[] {
  for (const entry of list) {
    if (entry.kind === 'builtin') continue;
    if (
      APP_PROVIDER_TYPES.has(entry.type) ||
      (entry.type === 'zcode' && entry.name.startsWith('ZCode'))
    ) {
      entry.detected = true;
    }
  }
  return list;
}

/** Flags ChatGPT/Codex-family providers so they group under
 * "ChatGPT Providers" — self-healing like the other marks. */
function markChatgptProviders(list: AiProviderEntry[]): AiProviderEntry[] {
  for (const entry of list) {
    if (entry.kind === 'builtin') continue;
    if (
      entry.type === 'codex' ||
      entry.type === 'chatgpt-desktop' ||
      entry.type.startsWith('chatgpt-')
    ) {
      entry.chatgptProvider = true;
    }
  }
  return list;
}

/** Flags Claude-family providers (Claude Code / Claude Desktop) so they
 * group under "Claude Providers" — self-healing like the zcode marks. */
function markClaudeProviders(list: AiProviderEntry[]): AiProviderEntry[] {
  for (const entry of list) {
    if (entry.kind === 'builtin') continue;
    if (
      entry.type === 'claude-code' ||
      entry.type === 'claude-desktop' ||
      entry.type === 'claude-anthropic-api'
    ) {
      entry.claudeProvider = true;
    }
    if (
      entry.type === 'codex' ||
      entry.type === 'chatgpt-desktop' ||
      entry.type.startsWith('chatgpt-')
    ) {
      entry.chatgptProvider = true;
    }
  }
  return list;
}

/** External/CLI providers — wrap installed apps and binaries (claude-code,
 * zcode-cli, codex, cursor, …). Removed from the app: pages open in the
 * user’ external browser and chat runs on API providers only. */
function isExternalProvider(entry: AiProviderEntry): boolean {
  return (
    APP_PROVIDER_TYPES.has(entry.type) ||
    CLI_PROVIDER_TYPES.has(entry.type) ||
    entry.detected === true
  );
}

export function loadProviders(): AiProviderEntry[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (raw) {
      const list = JSON.parse(raw) as Array<Partial<AiProviderEntry> & Record<string, unknown>>;
      return markChatgptProviders(
        markAppProviders(
          applyRegistryDefaults(
            dedupeAppProviders(dropTestProviders(list.map(migrate))).filter(function (entry) { return !isExternalProvider(entry); }).filter(function (entry) { return entry.id !== 'builtin-zai' && entry.id !== 'builtin-start-plan'; }),
          ),
        ),
      );
    }
    const legacy = localStorage.getItem('pigry:ai-provider');
    if (legacy) {
      const cfg = JSON.parse(legacy) as Partial<AiProviderEntry> & { provider?: string };
      const entry = migrate({
        id: 'default',
        name: cfg.name ?? 'OpenAI',
        type: cfg.provider ?? 'openai',
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      });
      const list = markChatgptProviders(
        markClaudeProviders(
          markAppProviders(
            applyRegistryDefaults(
              dedupeAppProviders(dropTestProviders([entry])).filter(function (entry) { return !isExternalProvider(entry); }).filter(function (entry) { return entry.id !== 'builtin-zai' && entry.id !== 'builtin-start-plan'; }),
            ),
          ),
        ),
      );
      saveProviders(list, activeProviderId());
      return list;
    }
  } catch {
    // fall through to the empty default
  }
  return [];
}

export function saveProviders(providers: AiProviderEntry[], activeId?: string) {
  try {
    localStorage.setItem(
      LIST_KEY,
      JSON.stringify(providers.filter(function (entry) { return !isExternalProvider(entry); }).filter(function (entry) { return entry.id !== 'builtin-zai' && entry.id !== 'builtin-start-plan'; })),
    );
  } catch {
    // session-only
  }
  const id = activeId ?? activeProviderId();
  try {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  } catch {
    // session-only
  }
  writeLegacyMirror(providers, id);
}

export function activeProviderId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function activeProvider(providers?: AiProviderEntry[]): AiProviderEntry | null {
  const list = providers ?? loadProviders();
  const id = activeProviderId();
  return list.find((p) => p.id === id) ?? list[0] ?? null;
}

export function setActiveProvider(id: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
    writeLegacyMirror(loadProviders(), id);
  } catch {
    // session-only
  }
}

export function newId(prefix: string): string {
  return uid(prefix);
}

export function newModel(name: string): AiModelEntry {
  return makeModel(name, false);
}

/** Known-model metadata used by the Add-model dialog's smart configuration.
 * reasoningLevels + reasoningMapping describe the vendor's OWN effort knob —
 * mapping values are payload fragments merged into chat requests. */
export interface KnownModelSpec {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputTypes?: string[];
  capabilities?: string[];
  reasoningLevels?: string[];
  reasoningMapping?: string;
}

/** Zhipu GLM — thinking on/off switch. */
const GLM_THINKING = JSON.stringify({
  low: { thinking: { type: 'disabled' } },
  high: { thinking: { type: 'enabled' } },
});
/** Anthropic extended thinking — effort maps to a token budget. */
const CLAUDE_THINKING = JSON.stringify({
  low: { thinking: { type: 'enabled', budget_tokens: 4096 } },
  medium: { thinking: { type: 'enabled', budget_tokens: 16384 } },
  high: { thinking: { type: 'enabled', budget_tokens: 32768 } },
});
/** OpenAI o-series — native reasoning_effort levels. */
const OPENAI_EFFORT = JSON.stringify({
  low: { reasoning_effort: 'low' },
  medium: { reasoning_effort: 'medium' },
  high: { reasoning_effort: 'high' },
});
/** Qwen3 hybrid thinking — toggle + budget. */
const QWEN_THINKING = JSON.stringify({
  low: { enable_thinking: false },
  high: { enable_thinking: true, thinking_budget: 32768 },
});
/** Gemini 2.5 — thinkingConfig budget. */
const GEMINI_THINKING = JSON.stringify({
  low: { thinkingConfig: { thinkingBudget: 1024 } },
  high: { thinkingConfig: { thinkingBudget: 24576 } },
});

/** Best-effort registry of common model families — matched by substring. */
const KNOWN_MODEL_SPECS: Array<[pattern: string, spec: KnownModelSpec]> = [
  ['glm-5.3', { contextWindow: 200_000, maxOutputTokens: 128_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: GLM_THINKING }],
  ['glm-5', { contextWindow: 200_000, maxOutputTokens: 128_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: GLM_THINKING }],
  ['glm-4.6', { contextWindow: 200_000, maxOutputTokens: 128_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: GLM_THINKING }],
  ['glm-4.5-air', { contextWindow: 128_000, maxOutputTokens: 96_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: GLM_THINKING }],
  ['glm-4.5', { contextWindow: 128_000, maxOutputTokens: 96_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: GLM_THINKING }],
  ['glm-4-flash', { contextWindow: 128_000, maxOutputTokens: 4_096, inputTypes: ['text'] }],
  ['claude-opus-4', { contextWindow: 200_000, maxOutputTokens: 32_000, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: CLAUDE_THINKING }],
  ['claude-sonnet-4', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: CLAUDE_THINKING }],
  ['claude-haiku-4', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: CLAUDE_THINKING }],
  ['claude-3-7', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: CLAUDE_THINKING }],
  ['claude-3-5', { contextWindow: 200_000, maxOutputTokens: 8_192, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'] }],
  ['gpt-4.1', { contextWindow: 1_000_000, maxOutputTokens: 32_768, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['gpt-4o', { contextWindow: 128_000, maxOutputTokens: 16_384, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['o4-mini', { contextWindow: 200_000, maxOutputTokens: 100_000, inputTypes: ['text', 'image'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: OPENAI_EFFORT }],
  ['o3', { contextWindow: 200_000, maxOutputTokens: 100_000, inputTypes: ['text', 'image'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: OPENAI_EFFORT }],
  ['qwen3-coder', { contextWindow: 1_000_000, maxOutputTokens: 65_536, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: QWEN_THINKING }],
  ['qwen3', { contextWindow: 262_144, maxOutputTokens: 32_768, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: QWEN_THINKING }],
  ['qwen-max', { contextWindow: 1_000_000, maxOutputTokens: 32_768, inputTypes: ['text'] }],
  ['qwen-plus', { contextWindow: 1_000_000, maxOutputTokens: 16_384, inputTypes: ['text'] }],
  // DeepSeek R1 reasons on every turn — no effort knob to expose.
  ['deepseek-r1', { contextWindow: 128_000, maxOutputTokens: 32_768, inputTypes: ['text'] }],
  ['deepseek', { contextWindow: 128_000, maxOutputTokens: 8_192, inputTypes: ['text'] }],
  ['gemini-2.5-pro', { contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: ['text', 'image', 'video', 'pdf'], capabilities: ['structured-output', 'native-web-search'], reasoningLevels: ['low', 'high'], reasoningMapping: GEMINI_THINKING }],
  ['gemini-2.5-flash', { contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: ['text', 'image', 'video', 'pdf'], capabilities: ['structured-output', 'native-web-search'], reasoningLevels: ['low', 'high'], reasoningMapping: GEMINI_THINKING }],
  ['gemini', { contextWindow: 1_000_000, maxOutputTokens: 8_192, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['llama', { contextWindow: 128_000, maxOutputTokens: 8_192, inputTypes: ['text'] }],
  ['mistral', { contextWindow: 128_000, maxOutputTokens: 8_192, inputTypes: ['text'] }],
];

/** Looks up known-model metadata for a model id (longest pattern wins). */
export function matchModelSpec(name: string): KnownModelSpec | null {
  const lower = name.trim().toLowerCase();
  if (!lower) return null;
  let hit: [string, KnownModelSpec] | null = null;
  for (const entry of KNOWN_MODEL_SPECS) {
    if (lower.includes(entry[0]) && (!hit || entry[0].length > hit[0].length)) hit = entry;
  }
  return hit ? { ...hit[1] } : null;
}

/** Context window of a model, best-effort: the provider catalog's exact
 * number first, then the known-model registry, then the "128K"/"1M"
 * capability badge shown on the model entry. Null when all three fail. */
export function resolveContextWindow(
  name: string,
  entry?: { contextWindow?: number; context?: string },
): number | null {
  if (entry?.contextWindow && entry.contextWindow > 0) return entry.contextWindow;
  const spec = matchModelSpec(name);
  if (spec?.contextWindow) return spec.contextWindow;
  const badge = entry?.context?.trim() ?? '';
  const match = /^([\d.]+)\s*([kKmM])$/.exec(badge);
  if (match) {
    const n = parseFloat(match[1]);
    if (Number.isFinite(n) && n > 0) {
      return match[2].toLowerCase() === 'm' ? Math.round(n * 1_000_000) : Math.round(n * 1000);
    }
  }
  return null;
}

/** Payload fragment for a model's selected effort level — shallow-merged
 * into the chat request JSON (null when nothing applies). */
export function effortPayloadFragment(
  effort: string | undefined,
  mapping: string | undefined,
): Record<string, unknown> | null {
  if (!effort || !mapping) return null;
  try {
    const map = JSON.parse(mapping) as Record<string, unknown>;
    const fragment = map[effort];
    return fragment && typeof fragment === 'object' && !Array.isArray(fragment)
      ? (fragment as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The URL the agent should POST to for this provider. */
export function resolveEndpoint(entry: AiProviderEntry): string {
  if (entry.baseUrl.trim()) return entry.baseUrl.trim();
  if (entry.type === 'zcode') return 'https://api.z.ai/api/coding/paas/v4/chat/completions';
  if (entry.apiFormat === 'anthropic') return 'https://api.anthropic.com/v1/messages';
  return 'https://api.openai.com/v1/chat/completions';
}

/** Anthropic base URLs take `/v1/messages` appended unless already present. */
export function anthropicEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/messages')) return trimmed;
  return `${trimmed}/v1/messages`;
}

/** Status dot: green = ready to chat, orange = missing key/base URL. */
export function providerStatus(entry: AiProviderEntry): 'ok' | 'warn' {
  if (!entry.enabled) return 'warn';
  // Measured unusable (login gate / no prompt mode) at the last scan.
  if (entry.usable === false) return 'warn';
  // CLI agents run through their own app's login — no endpoint needed.
  if (isCliProvider(entry)) return 'ok';
  if (!entry.baseUrl.trim()) return 'warn';
  return 'ok';
}

/** Provider types backed by an installed CLI coding agent. */
const CLI_PROVIDER_TYPES = new Set([
  'claude-code',
  'codex',
  'copilot',
  'gemini',
  'claude',
  'zcode-cli',
  'autoclaw',
  'workbuddy',
  'traework',
  'conebuddy',
  'traecode',
  'opencode',
  'cursor-agent',
  'cursor',
  'openclaw',
]);

/** True when this provider talks to a CLI agent instead of an HTTP API. */
export function isCliProvider(entry: AiProviderEntry): boolean {
  return CLI_PROVIDER_TYPES.has(entry.type);
}
