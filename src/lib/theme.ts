/**
 * Theme preference — applied as `data-theme` on <html> so tokens.css can
 * swap palettes. "auto" follows the clock: light from 06:00 to 18:00,
 * dark at night; a minute-interval watcher keeps it in sync while running.
 */

export type ThemePreference = 'auto' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

/** Fired on window whenever the resolved theme changes. */
export const THEME_CHANGED_EVENT = 'orbit:theme-changed';

const THEME_KEY = 'orbit:theme';

/** Daytime window (local hours, start inclusive / end exclusive) for light. */
const LIGHT_FROM = 6;
const LIGHT_TO = 18;

export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'auto') return raw;
  } catch {
    // fall through
  }
  return 'auto';
}

/** "light" inside the daytime window, "dark" outside. */
export function resolveAutoTheme(date: Date = new Date()): 'dark' | 'light' {
  const hour = date.getHours();
  return hour >= LIGHT_FROM && hour < LIGHT_TO ? 'light' : 'dark';
}

/** Applies the resolved theme to the document root. */
export function applyTheme(pref: ThemePreference): void {
  const resolved = pref === 'auto' ? resolveAutoTheme() : pref;
  document.documentElement.dataset.theme = resolved;
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
}

/** The theme currently applied to the document root. */
export function currentResolvedTheme(): ResolvedTheme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return resolveAutoTheme();
}

export function writeThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // session-only
  }
  applyTheme(pref);
}

/**
 * Applies the stored preference once and re-resolves "auto" every minute
 * so the theme flips at the daytime boundary without a restart.
 */
export function startThemeWatcher(): () => void {
  applyTheme(readThemePreference());
  const timer = window.setInterval(() => {
    if (readThemePreference() === 'auto') applyTheme('auto');
  }, 60_000);
  return () => window.clearInterval(timer);
}
