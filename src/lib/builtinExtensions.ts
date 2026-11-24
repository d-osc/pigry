/** Menus that Pigry ships as built-in extensions (Diagram, Design, Board, E2E Testing, Reports): they live in the
 * side bar's Extensions group and can be switched off, which hides them from the side bar and the command palette.
 * Which menus are extensions is declared in app/navigation.ts (`group: 'extension'`); this module remembers the ones
 * the user switched off. */
export const EXTENSIONS_CHANGED = 'pigry:extensions-changed';
/** Asks the app to show a menu (dispatched by Settings › Extensions). */
export const GO_SCREEN_EVENT = 'pigry:go-screen';
/** Asks the app to open Settings on a section; the detail is { section, extensionId? } (dispatched by the Extension Store). */
export const OPEN_SETTINGS_EVENT = 'pigry:open-settings';

const DISABLED_KEY = 'pigry:disabled-menus';

export function readDisabledMenus(storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): Set<string> {
  try {
    const raw = storage?.getItem(DISABLED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function isMenuEnabled(id: string): boolean {
  return !readDisabledMenus().has(id);
}

/** Switches a built-in extension menu on or off; open side bars and palettes update at once. */
export function setMenuEnabled(id: string, enabled: boolean): void {
  const disabled = readDisabledMenus();
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...disabled]));
  } catch {
    // session-only
  }
  window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED));
}
