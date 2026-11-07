/** Loads hunks for a file side (unstaged or staged); reloads per key. */
import { useEffect, useState } from 'react';
import { getFileHunks } from '../lib/tauriClient';
import type { HunkInfo } from '../types/repository';

export function useFileHunks(path: string, reloadKey: number, staged: boolean) {
  const [entry, setEntry] = useState<{
    path: string;
    staged: boolean;
    hunks: HunkInfo[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFileHunks(path, staged)
      .then((hunks) => {
        if (!cancelled) setEntry({ path, staged, hunks });
      })
      .catch(() => {
        if (!cancelled) setEntry({ path, staged, hunks: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey, staged]);

  const current = entry?.path === path && entry.staged === staged ? entry : null;
  return { hunks: current?.hunks ?? null, loading: current === null };
}
