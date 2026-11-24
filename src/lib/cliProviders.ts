/** CLI providers ("Provider CLI"): the coding-agent CLIs found on this machine (Claude Code with the user's own subscription, Codex).
 * Scanning them spawns processes, so the result is cached in localStorage and only refreshed when it is old or the user asks. */
import { cliDetect } from './tauriClient.ts';
import type { AiProviderEntry } from './aiProviders.ts';
import { buildCliEntries } from './cliEntries.ts';

export { buildCliEntries };

const CACHE_KEY = 'pigry:cli-providers-v3';
const MODEL_KEY = 'pigry:cli-models-v1';
const EFFORT_KEY = 'pigry:cli-efforts-v1';
/** A cached scan is trusted for a day; the Settings page has a Rescan button for sooner. */
export const CLI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** While the app is open the CLIs are rescanned every 15 minutes; a CLI shown as not ready is rechecked when the window gets focus (at most every 15 s). */
export const CLI_RESCAN_INTERVAL_MS = 15 * 60 * 1000;
export const CLI_FOCUS_RESCAN_MIN_MS = 15 * 1000;
export const CLI_PROVIDERS_CHANGED = 'pigry:cli-providers-changed';

export interface CliCache { at: number; entries: AiProviderEntry[] }

export function readCliCache(): CliCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CliCache>;
    if (typeof parsed.at !== 'number' || !Array.isArray(parsed.entries)) return null;
    return { at: parsed.at, entries: parsed.entries };
  } catch {
    return null;
  }
}

export const isCliCacheFresh = (cache: CliCache | null, now: number): boolean => !!cache && now - cache.at < CLI_CACHE_TTL_MS && now >= cache.at;

function writeCliCache(entries: AiProviderEntry[], now: number): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, entries } satisfies CliCache)); } catch { /* session-only */ }
}
export function clearCliCache(): void {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* storage unavailable */ }
}

/** The model the user last picked for each CLI provider. */
export function readCliModels(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v)) as Record<string, string>;
  } catch {
    return {};
  }
}
export function saveCliModel(id: string, model: string): void {
  try { localStorage.setItem(MODEL_KEY, JSON.stringify({ ...readCliModels(), [id]: model })); } catch { /* session-only */ }
  notifyChanged();
}

/** The effort level the user picked per CLI provider and model: { providerId: { modelName: level } }. */
export function readCliEfforts(): Record<string, Record<string, string>> {
  try { return JSON.parse(localStorage.getItem(EFFORT_KEY) ?? '{}') as Record<string, Record<string, string>>; } catch { return {}; }
}
export function saveCliEffort(id: string, modelName: string, effort: string | undefined): void {
  const all = readCliEfforts();
  const mine = { ...(all[id] ?? {}) };
  if (effort) mine[modelName] = effort; else delete mine[modelName];
  try { localStorage.setItem(EFFORT_KEY, JSON.stringify({ ...all, [id]: mine })); } catch { /* session-only */ }
  notifyChanged();
}

/** Cached entries with the user's last model and effort choices applied. */
export function withChosenModels(entries: AiProviderEntry[]): AiProviderEntry[] {
  const chosen = readCliModels(), efforts = readCliEfforts();
  return entries.map((e) => {
    const models = e.models.map((m) => (efforts[e.id]?.[m.name] ? { ...m, effort: efforts[e.id][m.name] } : m));
    const model = chosen[e.id] && (e.models.length === 0 || e.models.some((m) => m.name === chosen[e.id])) ? chosen[e.id] : e.model;
    return { ...e, models, model };
  });
}

function notifyChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CLI_PROVIDERS_CHANGED));
}

let inflight: Promise<AiProviderEntry[]> | null = null;
/** True while any component's scan is running (so every screen can say "Scanning…"). */
export const isCliScanning = (): boolean => inflight !== null;
/** Scans the machine (spawns the CLIs), stores the result and tells every listener. One scan at a time. */
export function scanCliProviders(): Promise<AiProviderEntry[]> {
  if (!inflight) {
    inflight = cliDetect()
      .then((result) => {
        const entries = buildCliEntries(result);
        writeCliCache(entries, Date.now());
        notifyChanged();
        return entries;
      })
      .finally(() => { inflight = null; notifyChanged(); });
    notifyChanged();
  }
  return inflight;
}

/** Cached entries when the cache is fresh; otherwise scans. */
export async function loadCliProviders(): Promise<AiProviderEntry[]> {
  const cache = readCliCache();
  if (cache && isCliCacheFresh(cache, Date.now())) return withChosenModels(cache.entries);
  return withChosenModels(await scanCliProviders());
}
