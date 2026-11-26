/** Menus the user pinned to the side bar's Quick access group (from the Workspace and Extensions groups).
 * The list is ordered and kept in localStorage; open side bars update through QUICK_ACCESS_CHANGED. */
export const QUICK_ACCESS_CHANGED = 'pigry:quick-access-changed';
const KEY = 'pigry:quick-access';
export const QUICK_ACCESS_LIMIT = 30;

type Reader = Pick<Storage, 'getItem'> | undefined;
const defaultStorage = (): Storage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

/** The pinned menu ids, in order, without duplicates; anything unreadable counts as nothing pinned. */
export function readQuickAccess(storage: Reader = defaultStorage()): string[] {
  try {
    const raw = storage?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, QUICK_ACCESS_LIMIT);
  } catch {
    return [];
  }
}

/** Adds the id at the end, or removes it when it is already pinned. */
export function togglePinned(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(0, QUICK_ACCESS_LIMIT);
}

/** Moves a pinned id to position `to` (clamped). Unknown ids leave the list as it is. */
export function movePinned(list: string[], id: string, to: number): string[] {
  const from = list.indexOf(id);
  if (from < 0) return list;
  const rest = list.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

export function writeQuickAccess(ids: string[]): void {
  const clean = [...new Set(ids)].slice(0, QUICK_ACCESS_LIMIT);
  try {
    defaultStorage()?.setItem(KEY, JSON.stringify(clean));
  } catch {
    // storage unavailable: the pins last for this session only
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(QUICK_ACCESS_CHANGED));
}

export const isPinned = (id: string): boolean => readQuickAccess().includes(id);
export const setPinned = (id: string, pinned: boolean): void => {
  const list = readQuickAccess();
  if (list.includes(id) === pinned) return;
  writeQuickAccess(togglePinned(list, id));
};
export const movePinnedTo = (id: string, to: number): void => writeQuickAccess(movePinned(readQuickAccess(), id, to));
