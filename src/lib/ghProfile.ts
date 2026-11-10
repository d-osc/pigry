/** Shared GitHub profile cache — fetched once at app start and reused
 * everywhere (AI agent chat, title bar, anywhere else). The latest profile
 * is kept in memory + localStorage (`orbit:gh-profile`) so the first paint
 * already has name/avatar without waiting for gh.
 */
import { ghAccountList } from './tauriClient';
import type { GhAccount } from '../types/repository';

export interface GhProfile {
  /** Display name (full name when set, else login). */
  name: string;
  /** GitHub login. */
  login: string;
  avatarUrl: string;
}

const CACHE_KEY = 'pigry:gh-profile';
export const GH_PROFILE_EVENT = 'pigry:gh-profile';

let memory: GhProfile | null = null;
let loading: Promise<GhProfile | null> | null = null;

/** Sync read — memory first, then the localStorage cache. */
export function readCachedProfile(): GhProfile | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GhProfile;
      if (parsed?.login) {
        memory = parsed;
        return parsed;
      }
    }
  } catch {
    // corrupt cache — refetch
  }
  return null;
}

function setCachedProfile(profile: GhProfile | null) {
  memory = profile;
  try {
    if (profile) localStorage.setItem(CACHE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // storage unavailable
  }
  window.dispatchEvent(new Event(GH_PROFILE_EVENT));
}

/** Cache + broadcast from an account list that someone already fetched. */
export function updateGhProfileFromAccounts(accounts: GhAccount[]): GhProfile | null {
  const me = accounts.find((account) => account.active) ?? accounts[0] ?? null;
  const profile: GhProfile | null = me
    ? { name: me.fullName || me.name, login: me.name, avatarUrl: me.avatarUrl }
    : null;
  setCachedProfile(profile);
  return profile;
}

/** Fetches the active gh account (concurrent calls share one request). */
export function loadGhProfile(force = false): Promise<GhProfile | null> {
  if (!force && loading) return loading;
  loading = ghAccountList()
    .then((accounts) => {
      loading = null;
      return updateGhProfileFromAccounts(accounts);
    })
    .catch(() => {
      loading = null;
      return readCachedProfile();
    });
  return loading;
}

/** Subscribe to profile changes; fires immediately with the cached value. */
export function subscribeGhProfile(cb: (profile: GhProfile | null) => void): () => void {
  const handler = () => cb(readCachedProfile());
  handler();
  window.addEventListener(GH_PROFILE_EVENT, handler);
  return () => window.removeEventListener(GH_PROFILE_EVENT, handler);
}

/** Kick off profile detection at app startup (non-blocking). */
export function initGhProfile(): void {
  void loadGhProfile().catch(() => {});
}
