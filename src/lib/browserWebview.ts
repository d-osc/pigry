/** Floating browser panel — native child webviews via the browser_* Tauri
 * commands (Tauri multiwebview). No-ops in browser preview (no backend).
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauriClient';

export async function browserCreate(
  id: string,
  url: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  if (!isTauri()) return;
  await invoke('browser_create', { id, url, x, y, width, height });
}

export async function browserPosition(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  if (!isTauri()) return;
  await invoke('browser_position', { id, x, y, width, height });
}

export async function browserSetVisible(id: string, visible: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke('browser_set_visible', { id, visible });
}

export async function browserNavigate(id: string, url: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('browser_navigate', { id, url });
}

export async function browserClose(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('browser_close', { id });
}

/** Evaluates JavaScript in a panel webview — fire-and-forget (no result
 * comes back). Used by the browser_panel agent tool to drive the visible
 * page (fill inputs, click, submit). */
export async function browserEval(id: string, js: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('browser_eval', { id, js });
}

/** Current URL of a panel webview (E2E assertions + the eval read-back
 * channel: results ride in the URL fragment). */
export async function browserUrl(id: string): Promise<string> {
  if (!isTauri()) return '';
  return invoke('browser_url', { id });
}

/** CDP against the app's own WebView2 pages — dev builds only (the remote
 * debugging port is enabled by lib.rs under debug_assertions). Actions:
 * "targets" | "network" | "screenshot" | "pdf" | "upload". */
export async function cdpTool(
  action: string,
  opts: {
    urlPrefix?: string;
    contains?: string;
    selector?: string;
    paths?: string[];
    max?: number;
    value?: string;
    waitMs?: number;
    op?: string;
    name?: string;
  } = {},
): Promise<string> {
  if (!isTauri()) throw new Error('CDP tools need the desktop app');
  return invoke('browser_cdp', {
    action,
    urlPrefix: opts.urlPrefix ?? null,
    contains: opts.contains ?? null,
    selector: opts.selector ?? null,
    paths: opts.paths ?? null,
    max: opts.max ?? null,
    value: opts.value ?? null,
    waitMs: opts.waitMs ?? null,
    op: opts.op ?? null,
    name: opts.name ?? null,
  });
}

/** Destroys `browser-*` webviews whose id is not in `keepIds` — cleans up
 * orphans left behind when the page hot-reloads (their close/position
 * handlers died with the old page). */
export async function browserPrune(keepIds: string[]): Promise<void> {
  if (!isTauri()) return;
  await invoke('browser_prune', { keep: keepIds });
}

/** Adds https:// when the address has no scheme. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^(about|data|javascript|blob|mailto):/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}
