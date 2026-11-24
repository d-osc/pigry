/** Turns a CLI scan into provider entries (pure — no process spawning, so it can be tested in node). */
import type { CliDetectResult } from './tauriClient.ts';
import { newModel, type AiProviderEntry } from './aiProviders.ts';

function entry(id: string, name: string, type: 'claude-code' | 'codex' | 'antigravity', model: string): AiProviderEntry {
  return { id, name, kind: 'custom', type, apiFormat: 'openai', baseUrl: '', apiKey: '', model, enabled: true, models: [] };
}

/** Turns a raw scan into provider entries (the CLI picks its own login, so there is no endpoint or key). */
export function buildCliEntries(result: CliDetectResult): AiProviderEntry[] {
  const found: AiProviderEntry[] = [];
  if (result.claude) {
    const app = result.apps.find((a) => a.binary === 'claude');
    const names = [...new Set([result.claudeModel, ...result.claudeProviders.flatMap((p) => p.models), 'opus', 'sonnet', 'haiku'].filter((n) => n && n.trim()))];
    const base = entry('cli-claude', 'Claude subscription' + (result.claudeVersion ? ' · Claude Code ' + result.claudeVersion : ''), 'claude-code', result.claudeModel || 'sonnet');
    found.push({ ...base, claudeProvider: true, usable: app ? app.usable : true, models: names.map((n) => ({ ...newModel(n), enabled: true })) });
  }
  if (result.codex) {
    const app = result.apps.find((a) => a.binary === 'codex');
    const base = entry('cli-codex', 'Codex' + (result.codexVersion ? ' · ' + result.codexVersion : ''), 'codex', result.codexModel || '');
    found.push({ ...base, usable: app ? app.usable : true, models: result.codexModel ? [{ ...newModel(result.codexModel), enabled: true }] : [] });
  }
  const agy = result.apps.find((a) => a.binary === 'agy');
  if (agy) {
    // Antigravity (Google): `agy` with the user's own Google sign-in. Models come from `agy models`.
    const first = agy.models.find((m) => /flash-high|pro/.test(m)) ?? agy.models[0] ?? '';
    const base = entry('cli-agy', 'Antigravity' + (agy.version ? ' · ' + agy.version : ''), 'antigravity', agy.model || first);
    found.push({ ...base, usable: agy.usable, models: agy.models.map((n) => ({ ...newModel(n), enabled: true })) });
  }
  return found;
}

