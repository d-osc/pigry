/** Lists unstaged hunks for a file; reloads per path and refresh key. */
import { useEffect, useState } from 'react';
import { getFileHunks } from '../lib/tauriClient';
import type { HunkInfo } from '../types/repository';

export function useFileHunks(path: string, reloadKey: number) {
  const [entry, setEntry] = useState<{ path: string; hunks: HunkInfo[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFileHunks(path)
      .then((hunks) => {
        if (!cancelled) setEntry({ path, hunks });
      })
      .catch(() => {
        if (!cancelled) setEntry({ path, hunks: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  const hunks = entry?.path === path ? entry.hunks : null;
  return { hunks, loading: hunks === null };
}
