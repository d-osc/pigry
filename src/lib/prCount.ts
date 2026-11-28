/** Open pull request count per repository — the side bar's "Pull requests"
 * badge. The side bar asks gh once per repository; the Pull requests screen
 * asks again whenever it (re)loads its list, so the badge follows refreshes
 * and new PRs. No count (gh missing, signed out, no GitHub remote) means no
 * badge. */
import { useEffect, useSyncExternalStore } from 'react';
import { ghOpenPrCount, isTauri } from './tauriClient';

const counts = new Map<string, number>();
const requested = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Fetch the open PR count of a repository again (gh) and publish it. */
export function refreshOpenPrCount(repoPath: string | null | undefined): void {
  const path = repoPath ?? '';
  if (!path || !isTauri()) return;
  requested.add(path);
  ghOpenPrCount()
    .then((count) => {
      if (counts.get(path) === count) return;
      counts.set(path, count);
      for (const listener of listeners) listener();
    })
    .catch(() => {
      // gh unavailable — keep whatever the badge showed (none at first)
    });
}

/** Open PR count for the repository, or null while unknown. */
export function useOpenPrCount(repoPath: string | null | undefined): number | null {
  const path = repoPath ?? '';
  useEffect(() => {
    if (path && !requested.has(path)) refreshOpenPrCount(path);
  }, [path]);
  return useSyncExternalStore(subscribe, () => (path ? (counts.get(path) ?? null) : null));
}
