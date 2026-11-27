/** The E2E runner's browser picker (like Cypress's browser list): which installed
 * browser the test window uses — a Chromium one (driven over CDP), Firefox
 * (driven over WebDriver BiDi) or one of Playwright's own builds (Chromium,
 * Firefox, WebKit, driven by Playwright through a Node bridge) — and what
 * `Cypress.browser` says.
 * The choice is per machine (browsers differ between computers), so it is kept
 * in local storage, not in the git-tracked E2E settings. */

import type { InstalledBrowser } from '../../../lib/tauriClient';

/** "" = Auto: Edge, then Chrome (the order the test browser always tried); Firefox only when no Chromium browser is installed. */
export const AUTO_BROWSER = '';
const STORAGE_KEY = 'pigry.e2e.browser';

export function getSelectedBrowser(): string {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) ?? AUTO_BROWSER; } catch { return AUTO_BROWSER; }
}

export function setSelectedBrowser(id: string): void {
  try {
    if (id) globalThis.localStorage?.setItem(STORAGE_KEY, id);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable: the choice lasts for this session only */ }
}

export const browserLabel = (b: InstalledBrowser): string => {
  const major = b.version.split('.')[0];
  return major ? `${b.displayName} ${major}` : b.displayName;
};

/** How a browser is driven: "cdp", "bidi" or "playwright" (older backends sent no engine). */
export const engineOf = (b: { family: string; engine?: string } | undefined): string =>
  b?.engine || (b?.family === 'firefox' ? 'bidi' : 'cdp');

/** Finds a browser by id ("chrome-beta", "pw-webkit"), Cypress name ("chrome", stable channel
 * first, an installed browser before a Playwright build) or display name ("Chrome Canary",
 * "Playwright WebKit"), case-insensitively. "" / "auto" → Auto. */
export function matchBrowser(list: InstalledBrowser[], query: string): { id: string } | { error: string } {
  const q = query.trim().toLowerCase();
  if (!q || q === 'auto') return { id: AUTO_BROWSER };
  const hit = list.find((b) => b.id === q)
    ?? list.find((b) => b.name === q && b.channel === 'stable')
    ?? list.find((b) => b.name === q)
    ?? list.find((b) => b.displayName.toLowerCase() === q);
  if (hit) return { id: hit.id };
  const names = list.map((b) => b.id).join(', ');
  return { error: `browser "${query}" is not installed — ${names ? `installed: ${names}` : 'no supported browser (Edge, Chrome, Brave, Firefox…) was found'} (or "auto")` };
}

/** The browser a run uses: the chosen one, or for Auto the first installed Chromium browser (Edge, then Chrome), else Firefox, else a Playwright build. */
export const resolveBrowser = (list: InstalledBrowser[], id: string): InstalledBrowser | undefined =>
  (id ? list.find((b) => b.id === id) : list.find((b) => engineOf(b) === 'cdp') ?? list.find((b) => engineOf(b) === 'bidi') ?? list[0]);

export const isFirefoxFamily = (b: { family: string } | undefined): boolean => b?.family === 'firefox';

/** Why a setting does nothing (or less) in the picked browser; "" when it applies fully. */
export function browserSettingNote(setting: 'chromeWebSecurity' | 'video', b: { family: string; engine?: string } | undefined): string {
  if (!b) return '';
  if (setting === 'video') {
    return engineOf(b) === 'bidi' ? 'Chromium only: Firefox runs skip the video (WebDriver BiDi has no screencast) — Playwright Firefox records one' : '';
  }
  if (b.family === 'firefox') return 'Chromium only: in Firefox turning it off only lifts CORS checks — cross-origin iframes stay blocked';
  if (b.family === 'webkit') return 'Chromium only: WebKit has no switch for it — web security stays on';
  return '';
}

export interface CypressBrowser {
  name: string;
  family: string;
  channel: string;
  version: string;
  majorVersion: number | string;
  displayName: string;
  path: string;
  isHeaded: boolean;
  isHeadless: boolean;
}

type BrowserMatcher = string | Partial<CypressBrowser> | Array<string | Partial<CypressBrowser>>;

/** `Cypress.isBrowser(matcher)`: a name ("firefox", "!chrome" to exclude), an object
 * whose every key must match ({ family: "firefox" }), or a list of those (any
 * positive one matches and no excluded one does). */
export function isBrowser(b: CypressBrowser, matcher: BrowserMatcher): boolean {
  const one = (m: string | Partial<CypressBrowser>): boolean => (typeof m === 'string'
    ? b.name === m.toLowerCase()
    : Object.entries(m).every(([k, v]) => (b as unknown as Record<string, unknown>)[k] === v));
  const list = Array.isArray(matcher) ? matcher : [matcher];
  const excluded = list.filter((m): m is string => typeof m === 'string' && m.startsWith('!')).map((m) => m.slice(1));
  const wanted = list.filter((m) => !(typeof m === 'string' && m.startsWith('!')));
  return (wanted.length === 0 || wanted.some(one)) && !excluded.some(one);
}

/** `Cypress.browser` for a run (a generic Chromium entry when the browser is unknown). */
export function cypressBrowserOf(b: InstalledBrowser | undefined): CypressBrowser {
  if (!b) return { name: 'chromium', family: 'chromium', channel: 'stable', version: '', majorVersion: '', displayName: 'Test browser', path: '', isHeaded: true, isHeadless: false };
  const major = Number.parseInt(b.version.split('.')[0] ?? '', 10);
  return { name: b.name, family: b.family, channel: b.channel, version: b.version, majorVersion: Number.isNaN(major) ? '' : major, displayName: b.displayName, path: b.path, isHeaded: true, isHeadless: false };
}
