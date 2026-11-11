/** AI provider store — shared by Settings and the AI agent panels.
 *
 * Providers live in localStorage under `orbit:ai-providers`; the active one
 * is `orbit:ai-active`. The legacy single-provider key `orbit:ai-provider`
 * is kept mirrored so older consumers keep working.
 */
import type { AiProviderEntry, AiModelEntry, AiApiFormat } from '../types/repository';

export type { AiProviderEntry, AiModelEntry, AiApiFormat };

const LIST_KEY = 'pigry:ai-providers';
const ACTIVE_KEY = 'pigry:ai-active';

/** The seeded Qwen Cloud endpoint for agent testing. */
const QWEN_BASE_URL = 'https://token-plan.maas.qwencloudapi.com/apps/anthropic';

/** Z.ai built-in defaults — Anthropic-compatible gateway on the coding plan. */
const ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';
const ZAI_API_KEY = '22ef8ea2fad249c0847d0f72616fc23c.HIQTMWNVAF21VjLN';
const ZAI_MODELS: Array<[name: string, vision: boolean]> = [
  ['glm-5.3', false],
  ['glm-5.2', false],
  ['glm-4.6', false],
];

/** Z.ai test provider — same Anthropic-compatible gateway, dedicated test key. */
const ZAI_TEST_ID = 'zai-test';
const ZAI_TEST_BASE_URL = 'https://api.z.ai/api/anthropic';
const ZAI_TEST_API_KEY = 'c466230fbad74dda9f33d3cc9c18fdf1.kN4JqIlzCGV9mdkx';

export const API_FORMAT_LABEL: Record<AiApiFormat, string> = {
  openai: 'OpenAI chat completions (/v1/chat/completions)',
  anthropic: 'Anthropic messages (/v1/messages)',
};

/** Model list pre-provisioned for Qwen Cloud (as shown in the design). */
const QWEN_MODELS: Array<[name: string, vision: boolean]> = [
  ['glm-5.3', false],
  ['glm-5.2', false],
  ['deepseek-v4-flash-0731', false],
  ['deepseek-v4-pro', false],
  ['deepseek-v4-pro-0813', false],
  ['deepseek-v4.1-flash', true],
  ['qwen3.6-flash', true],
  ['qwen3.7-max', false],
  ['qwen3.7-plus', true],
  ['qwen3.8-flash', true],
  ['qwen3.8-max', true],
];
let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

function makeModel(name: string, vision: boolean): AiModelEntry {
  // Every Qwen Cloud model on this gateway advertises a 1M-token context.
  return { id: uid('m'), name, vision, enabled: true, context: '1M' };
}

function makeBuiltin(id: string, name: string, type: string): AiProviderEntry {
  return {
    id,
    name,
    kind: 'builtin',
    type,
    apiFormat: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
    models: [],
  };
}

/** First-run seed: the two built-ins plus the Qwen Cloud test provider. */
function seedDefaults(): AiProviderEntry[] {
  const qwen = makeBuiltin('qwen-cloud', 'Qwen Cloud', 'custom');
  qwen.kind = 'custom';
  qwen.apiFormat = 'anthropic';
  qwen.baseUrl = QWEN_BASE_URL;
  qwen.apiKey =
    'sk-sp-H.DIMED.vYbS.MEQCIEy6iulOjWXOLgPw684T5rX3ndHy3zRAmRxpbuDmiMtgAiBF6S8M1bUzjb9zuxWUK0_yk-J9rLmID0NRyk3NKRlk8A';
  qwen.models = QWEN_MODELS.map(([name, vision]) => makeModel(name, vision));
  qwen.model = qwen.models[0]?.name ?? '';
  return [
    makeBuiltin('builtin-zai', 'Z.ai', 'zcode'),
    makeBuiltin('builtin-start-plan', 'Start Plan', 'openai'),
    qwen,
  ];
}

/** Fills in fields added after the flat single-model era. */
function migrate(raw: Partial<AiProviderEntry> & Record<string, unknown>): AiProviderEntry {
  const entry: AiProviderEntry = {
    id: String(raw.id ?? uid('p')),
    name: String(raw.name ?? 'Provider'),
    kind: raw.kind === 'builtin' ? 'builtin' : 'custom',
    type: String(raw.type ?? 'custom'),
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

/** The seeded Z.ai test provider (kind "custom" so the key stays editable). */
function makeZaiTestProvider(): AiProviderEntry {
  const entry = makeBuiltin(ZAI_TEST_ID, 'Z.ai (test)', 'custom');
  entry.kind = 'custom';
  entry.apiFormat = 'anthropic';
  entry.baseUrl = ZAI_TEST_BASE_URL;
  entry.apiKey = ZAI_TEST_API_KEY;
  entry.models = ZAI_MODELS.map(([name, vision]) => makeModel(name, vision));
  entry.model = entry.models[0]?.name ?? '';
  return entry;
}

/** Appends the Z.ai test provider when it is missing from a stored list, and
 * keeps stored copies in sync with the seeded credentials — the key is
 * managed in code (this is the throwaway test provider), so the constant
 * always wins over any stale localStorage copy. */
function ensureZaiTestProvider(list: AiProviderEntry[]): AiProviderEntry[] {
  const idx = list.findIndex((p) => p.id === ZAI_TEST_ID);
  if (idx < 0) {
    const zaiIndex = list.findIndex((p) => p.id === 'builtin-zai');
    const insertAt = zaiIndex >= 0 ? zaiIndex + 1 : list.length;
    return [...list.slice(0, insertAt), makeZaiTestProvider(), ...list.slice(insertAt)];
  }
  const entry = list[idx];
  if (entry.apiKey === ZAI_TEST_API_KEY && entry.baseUrl === ZAI_TEST_BASE_URL) return list;
  const models = entry.models.length > 0 ? entry.models : makeZaiTestProvider().models;
  const next = [...list];
  next[idx] = {
    ...entry,
    apiFormat: 'anthropic',
    baseUrl: ZAI_TEST_BASE_URL,
    apiKey: ZAI_TEST_API_KEY,
    models,
    model: models.some((m) => m.name === entry.model) ? entry.model : models[0]?.name ?? '',
  };
  return next;
}

/** Fills in the Z.ai built-in when the user has not configured it yet.
 * Existing values always win — this only fills empty fields. */
function ensureZaiDefaults(list: AiProviderEntry[]): AiProviderEntry[] {
  const zai = list.find((p) => p.id === 'builtin-zai');
  if (!zai || (zai.baseUrl && zai.apiKey)) return list;
  const filled: AiProviderEntry = {
    ...zai,
    apiFormat: 'anthropic',
    baseUrl: zai.baseUrl || ZAI_BASE_URL,
    apiKey: zai.apiKey || ZAI_API_KEY,
    models:
      zai.models.length > 0
        ? zai.models
        : ZAI_MODELS.map(([name, vision]) => makeModel(name, vision)),
  };
  filled.model = filled.models.find((m) => m.enabled)?.name ?? '';
  return list.map((p) => (p.id === 'builtin-zai' ? filled : p));
}

/** Loads providers, migrating legacy shapes and seeding on first run. */
export function loadProviders(): AiProviderEntry[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (raw) {
      const list = JSON.parse(raw) as Array<Partial<AiProviderEntry> & Record<string, unknown>>;
      return ensureZaiTestProvider(ensureZaiDefaults(list.map(migrate)));
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
      const list = ensureZaiTestProvider(
        ensureZaiDefaults([
          makeBuiltin('builtin-zai', 'Z.ai', 'zcode'),
          makeBuiltin('builtin-start-plan', 'Start Plan', 'openai'),
          entry,
        ]),
      );
      saveProviders(list, activeProviderId());
      return list;
    }
  } catch {
    // fall through to seed
  }
  const seeded = ensureZaiTestProvider(ensureZaiDefaults(seedDefaults()));
  saveProviders(seeded, 'qwen-cloud');
  return seeded;
}

export function saveProviders(providers: AiProviderEntry[], activeId?: string) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(providers));
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

/** Known-model metadata used by the Add-model dialog's smart configuration. */
export interface KnownModelSpec {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputTypes?: string[];
  capabilities?: string[];
  reasoningLevels?: string[];
}

/** Best-effort registry of common model families — matched by substring. */
const KNOWN_MODEL_SPECS: Array<[pattern: string, spec: KnownModelSpec]> = [
  ['glm-4.6', { contextWindow: 200_000, maxOutputTokens: 128_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'] }],
  ['glm-4.5-air', { contextWindow: 128_000, maxOutputTokens: 96_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'] }],
  ['glm-4.5', { contextWindow: 128_000, maxOutputTokens: 96_000, inputTypes: ['text'], reasoningLevels: ['low', 'high'] }],
  ['glm-4-flash', { contextWindow: 128_000, maxOutputTokens: 4_096, inputTypes: ['text'] }],
  ['claude-opus-4', { contextWindow: 200_000, maxOutputTokens: 32_000, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'] }],
  ['claude-sonnet-4', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'] }],
  ['claude-haiku-4', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'] }],
  ['claude-3-7', { contextWindow: 200_000, maxOutputTokens: 64_000, inputTypes: ['text', 'image', 'pdf'], reasoningLevels: ['low', 'high'] }],
  ['claude-3-5', { contextWindow: 200_000, maxOutputTokens: 8_192, inputTypes: ['text', 'image', 'pdf'], capabilities: ['structured-output'] }],
  ['gpt-4.1', { contextWindow: 1_000_000, maxOutputTokens: 32_768, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['gpt-4o', { contextWindow: 128_000, maxOutputTokens: 16_384, inputTypes: ['text', 'image'], capabilities: ['structured-output'] }],
  ['o4-mini', { contextWindow: 200_000, maxOutputTokens: 100_000, inputTypes: ['text', 'image'], reasoningLevels: ['low', 'medium', 'high'] }],
  ['o3', { contextWindow: 200_000, maxOutputTokens: 100_000, inputTypes: ['text', 'image'], reasoningLevels: ['low', 'medium', 'high'] }],
  ['qwen3-coder', { contextWindow: 1_000_000, maxOutputTokens: 65_536, inputTypes: ['text'] }],
  ['qwen3', { contextWindow: 262_144, maxOutputTokens: 32_768, inputTypes: ['text'], reasoningLevels: ['low', 'high'] }],
  ['qwen-max', { contextWindow: 1_000_000, maxOutputTokens: 32_768, inputTypes: ['text'] }],
  ['qwen-plus', { contextWindow: 1_000_000, maxOutputTokens: 16_384, inputTypes: ['text'] }],
  ['deepseek-r1', { contextWindow: 128_000, maxOutputTokens: 32_768, inputTypes: ['text'], reasoningLevels: ['low', 'high'] }],
  ['deepseek', { contextWindow: 128_000, maxOutputTokens: 8_192, inputTypes: ['text'] }],
  ['gemini-2.5-pro', { contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: ['text', 'image', 'video', 'pdf'], capabilities: ['structured-output', 'native-web-search'] }],
  ['gemini-2.5-flash', { contextWindow: 1_048_576, maxOutputTokens: 65_536, inputTypes: ['text', 'image', 'video', 'pdf'], capabilities: ['structured-output', 'native-web-search'] }],
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
  if (!entry.baseUrl.trim()) return 'warn';
  return 'ok';
}

/** True when this provider talks to a CLI agent instead of an HTTP API. */
export function isCliProvider(entry: AiProviderEntry): boolean {
  return entry.type === 'claude-code' || entry.type === 'codex';
}
