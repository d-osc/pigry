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
      if (typeof item.contextWindow === 'number' && Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0) {
        model.contextWindow = item.contextWindow;
      }
      if (typeof item.maxOutputTokens === 'number' && Number.isSafeInteger(item.maxOutputTokens) && item.maxOutputTokens > 0) {
        model.maxOutputTokens = item.maxOutputTokens;
      }
      if (typeof item.textOutputLanguage === 'string' && item.textOutputLanguage.trim()) {
        model.textOutputLanguage = item.textOutputLanguage.trim();
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
      if (typeof item.defaultEffort === 'string' && item.defaultEffort) model.defaultEffort = item.defaultEffort;
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
      const spec = matchModelSpec(model.name);
      if (!spec?.reasoningLevels?.length) return model;
      const obsoleteMapping =
        (model.reasoningMapping === GLM_THINKING && spec.providerDefaultEffort === 'max') ||
        (model.reasoningMapping === CLAUDE_THINKING && spec.reasoningMapping !== CLAUDE_THINKING);
      if (model.reasoningLevels && !obsoleteMapping) return model;
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
  providerDefaultEffort?: string;
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
function reasoningPreset(
  levels: string[],
  providerDefaultEffort: string | undefined,
  payload: (level: string) => Record<string, unknown>,
): KnownModelSpec {
  return {
    reasoningLevels: levels,
    providerDefaultEffort,
    reasoningMapping: JSON.stringify(Object.fromEntries(levels.map((level) => [level, payload(level)]))),
  };
}

const STANDARD_EFFORT = ['low', 'medium', 'high'];
const EXTENDED_EFFORT = [...STANDARD_EFFORT, 'xhigh', 'max'];
const OPENAI_OPT_IN_EFFORT = ['none', ...EXTENDED_EFFORT];

function openAiSpec(contextWindow: number, levels: string[], defaultEffort?: string, maxOutputTokens = 128_000): KnownModelSpec {
  return {
    contextWindow,
    maxOutputTokens,
    inputTypes: ['text', 'image'],
    ...reasoningPreset(levels, defaultEffort, (level) => ({ reasoning_effort: level })),
  };
}

function claudeEffort(levels: string[], defaultEffort: string): KnownModelSpec {
  return {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputTypes: ['text', 'image', 'pdf'],
    capabilities: ['structured-output'],
    ...reasoningPreset(levels, defaultEffort, (level) => ({ output_config: { effort: level } })),
  };
}

const GLM_53 = {
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  inputTypes: ['text'],
  ...reasoningPreset(['low', 'high', 'max'], 'max', (level) => ({ reasoning_effort: level })),
};
const GLM_53_FLASH = { ...GLM_53, inputTypes: ['text', 'image', 'video'] };
const GLM_DYNAMIC_THINKING = { reasoningLevels: ['low', 'high'], reasoningMapping: GLM_THINKING, providerDefaultEffort: 'dynamic thinking' };
const CLAUDE_HIGH = claudeEffort([...STANDARD_EFFORT, 'max'], 'high');
const CLAUDE_XHIGH = claudeEffort(EXTENDED_EFFORT, 'high');
const OPENAI_56 = openAiSpec(1_050_000, OPENAI_OPT_IN_EFFORT, 'medium');
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

/** Built-in model metadata, keyed by API model ID. Provider deployments may differ. */
const KNOWN_MODEL_SPECS: Array<[id: string, spec: KnownModelSpec]> = [
  ['glm-5.3-flashx-legal', GLM_53_FLASH],
  ['glm-5.3-flashx', GLM_53_FLASH],
  ['glm-5.3-flash', GLM_53_FLASH],
  ['glm-5.3', GLM_53],
  ['glm-5.2', {
    ...GLM_53,
    ...reasoningPreset(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'max', (level) => ({
      reasoning_effort: level,
    })),
  }],
  ['glm-5.1', { contextWindow: 200_000, maxOutputTokens: 128_000, inputTypes: ['text'], ...GLM_DYNAMIC_THINKING }],
  ['glm-5', { contextWindow: 200_000, maxOutputTokens: 128_000, inputTypes: ['text'], ...GLM_DYNAMIC_THINKING }],
  ['glm-4.6', { contextWindow: 200_000, maxOutputTokens: 128_000, inputTypes: ['text'], ...GLM_DYNAMIC_THINKING }],
  ['glm-4.5-air', { contextWindow: 128_000, maxOutputTokens: 96_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: GLM_THINKING }],
  ['glm-4.5', { contextWindow: 128_000, maxOutputTokens: 96_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: GLM_THINKING }],
  ['glm-4-flash', { contextWindow: 128_000, maxOutputTokens: 4_096, inputTypes: ['text'] }],
  ['claude-opus-5-5', claudeEffort(EXTENDED_EFFORT, 'medium')],
  ['claude-opus-5', CLAUDE_XHIGH],
  ['claude-sonnet-5-5', CLAUDE_XHIGH],
  ['claude-sonnet-5', CLAUDE_XHIGH],
  ['claude-haiku-5-5', claudeEffort(EXTENDED_EFFORT, 'medium')],
  ['claude-fable-5-2', CLAUDE_XHIGH],
  ['claude-fable-5-1', CLAUDE_XHIGH],
  ['claude-fable-5', CLAUDE_XHIGH],
  ['claude-opus-4-8', CLAUDE_XHIGH],
  ['claude-opus-4-7', CLAUDE_XHIGH],
  ['claude-opus-4-6', CLAUDE_HIGH],
  ['claude-sonnet-4-6', CLAUDE_HIGH],
  ['claude-opus-4-5', { ...CLAUDE_HIGH, contextWindow: 200_000, maxOutputTokens: 64_000, ...reasoningPreset(STANDARD_EFFORT, 'high', (level) => ({ output_config: { effort: level } })) }],
  ['claude-sonnet-4-5', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], reasoningLevels: STANDARD_EFFORT, reasoningMapping: CLAUDE_THINKING }],
  ['claude-haiku-4-5', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], reasoningLevels: STANDARD_EFFORT, reasoningMapping: CLAUDE_THINKING }],
  ['claude-opus-4', { contextWindow: 200_000, maxOutputTokens: 32_000, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: CLAUDE_THINKING }],
  ['claude-sonnet-4', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'], reasoningLevels: ['low', 'medium', 'high'], reasoningMapping: CLAUDE_THINKING }],
  ['claude-3-7-sonnet', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], reasoningLevels: STANDARD_EFFORT, reasoningMapping: CLAUDE_THINKING }],
  ['claude-3-5-sonnet', { contextWindow: 200_000, maxOutputTokens: 8_192, inputTypes: ['text', 'image', 'pdf'] }],
  ['claude-3-5-haiku', { contextWindow: 200_000, maxOutputTokens: 8_192, inputTypes: ['text'] }],
  ['gpt-6.2-astra', openAiSpec(1_050_000, EXTENDED_EFFORT)],
  ['gpt-6.2-sol', openAiSpec(1_050_000, EXTENDED_EFFORT)],
  ['gpt-6.1-sol', openAiSpec(1_050_000, EXTENDED_EFFORT, 'medium')],
  ['gpt-6.1-terra', OPENAI_56],
  ['gpt-6-astra', openAiSpec(1_050_000, EXTENDED_EFFORT)],
  ['gpt-6-sol', openAiSpec(1_050_000, OPENAI_OPT_IN_EFFORT, 'medium')],
  ['gpt-6-luna', OPENAI_56],
  ['gpt-5.6', OPENAI_56],
  ['gpt-5.6-sol', OPENAI_56],
  ['gpt-5.6-terra', OPENAI_56],
  ['gpt-5.6-luna', OPENAI_56],
  ['gpt-5.5', openAiSpec(1_050_000, OPENAI_OPT_IN_EFFORT.slice(0, -1), 'medium')],
  ['gpt-5.4', openAiSpec(1_050_000, OPENAI_OPT_IN_EFFORT.slice(0, -1), 'none')],
  ['gpt-5.4-mini', openAiSpec(400_000, OPENAI_OPT_IN_EFFORT.slice(0, -1), 'none')],
  ['gpt-5.4-nano', openAiSpec(400_000, OPENAI_OPT_IN_EFFORT.slice(0, -1), 'none')],
  ['gpt-5.2', openAiSpec(400_000, OPENAI_OPT_IN_EFFORT.slice(0, -1), 'none')],
  ['gpt-5.1', openAiSpec(400_000, ['none', ...STANDARD_EFFORT], 'none')],
  ['gpt-5.1-codex', openAiSpec(400_000, STANDARD_EFFORT)],
  ['gpt-5', openAiSpec(400_000, ['minimal', ...STANDARD_EFFORT], 'medium')],
  ['gpt-5-mini', openAiSpec(400_000, ['minimal', ...STANDARD_EFFORT], 'medium')],
  ['gpt-5-nano', openAiSpec(400_000, ['minimal', ...STANDARD_EFFORT], 'medium')],
  ['gpt-4.1', { contextWindow: 1_047_576, maxOutputTokens: 32_768, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['gpt-4.1-mini', { contextWindow: 1_047_576, maxOutputTokens: 32_768, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['gpt-4.1-nano', { contextWindow: 1_047_576, maxOutputTokens: 32_768, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['gpt-4o', { contextWindow: 128_000, maxOutputTokens: 16_384, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['gpt-4o-mini', { contextWindow: 128_000, maxOutputTokens: 16_384, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['o4-mini', openAiSpec(200_000, STANDARD_EFFORT, 'medium', 100_000)],
  ['o3', openAiSpec(200_000, STANDARD_EFFORT, 'medium', 100_000)],
  ['o3-mini', { ...openAiSpec(200_000, STANDARD_EFFORT, 'medium', 100_000), inputTypes: ['text'] }],
  ['o1', openAiSpec(200_000, STANDARD_EFFORT, 'medium', 100_000)],
  ['qwen3.5-plus', { contextWindow: 1_000_000, maxOutputTokens: 65_536, inputTypes: ['text', 'image', 'video'], reasoningLevels: ['low', 'high'], reasoningMapping: QWEN_THINKING }],
  ['qwen3-coder', { contextWindow: 1_000_000, maxOutputTokens: 65_536, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: QWEN_THINKING }],
  ['qwen3', { contextWindow: 262_144, maxOutputTokens: 32_768, inputTypes: ['text'], reasoningLevels: ['low', 'high'], reasoningMapping: QWEN_THINKING }],
  ['qwen-max', { contextWindow: 1_000_000, maxOutputTokens: 32_768, inputTypes: ['text'] }],
  ['qwen-plus', { contextWindow: 1_000_000, maxOutputTokens: 16_384, inputTypes: ['text'] }],
  // DeepSeek R1 reasons on every turn — no effort knob to expose.
  ['deepseek-r1', { contextWindow: 128_000, maxOutputTokens: 32_768, inputTypes: ['text'] }],
  ['deepseek-flash', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputTypes: ['text', 'image'] }],
  ['deepseek-v4-pro', { contextWindow: 1_000_000, maxOutputTokens: 384_000, inputTypes: ['text'] }],
  ['gemini-3.1-pro-preview', { contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: ['text', 'image', 'video', 'pdf'], providerDefaultEffort: 'high' }],
  ['gemini-2.5-pro', { contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: ['text', 'image', 'video', 'pdf'], capabilities: ['structured-output', 'native-web-search'], reasoningLevels: ['low', 'high'], reasoningMapping: GEMINI_THINKING }],
  ['gemini-2.5-flash', { contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: ['text', 'image', 'video', 'pdf'], capabilities: ['structured-output', 'native-web-search'], reasoningLevels: ['low', 'high'], reasoningMapping: GEMINI_THINKING }],
];

const MODEL_SPECS_BY_ID = new Map(KNOWN_MODEL_SPECS);
export const KNOWN_MODEL_IDS = [...MODEL_SPECS_BY_ID.keys()].sort();

/** Resolves API aliases, provider namespaces, and dated snapshots. */
export function matchModelSpec(name: string): KnownModelSpec | null {
  const modelId = name.trim().toLowerCase();
  const id = modelId.slice(modelId.lastIndexOf('/') + 1)
    .replace(/^(claude-(?:opus|sonnet|haiku|fable)-\d+)\.(\d+)/, '$1-$2');
  return MODEL_SPECS_BY_ID.get(id)
    ?? MODEL_SPECS_BY_ID.get(id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, ''))
    ?? null;
}

export function configuredModelEffort(model?: Pick<AiModelEntry, 'effort' | 'defaultEffort'> | null): string | undefined {
  return model?.effort || model?.defaultEffort;
}

export function maxOutputTokenPayload(
  apiFormat: AiApiFormat,
  endpoint: string,
  limit?: number,
): Record<string, number> {
  if (apiFormat === 'anthropic') return { max_tokens: limit ?? 4096 };
  if (!limit) return {};
  // OpenAI's Chat Completions endpoint uses max_completion_tokens for
  // reasoning models. Compatible endpoints can still expect max_tokens.
  return /^https:\/\/api\.openai\.com(?:\/|$)/i.test(endpoint)
    ? { max_completion_tokens: limit }
    : { max_tokens: limit };
}

export function textOutputLanguageInstruction(language?: string): string {
  return language
    ? `\n\n[Model language preference]\nWrite your response in ${JSON.stringify(language)} unless the user explicitly requests another language. Preserve code, identifiers, and quoted source text as appropriate.`
    : '';
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
