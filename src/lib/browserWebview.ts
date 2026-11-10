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

/** Adds https:// when the address has no scheme. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}
