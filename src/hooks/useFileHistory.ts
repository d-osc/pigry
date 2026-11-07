/** Loads the per-file commit history for the Explorer history panel. */
import { useEffect, useState } from 'react';
import { getFileHistory } from '../lib/tauriClient';
import type { FileCommitEntry } from '../types/repository';

export function useFileHistory(path: string) {
  const [entry, setEntry] = useState<{ path: string; commits: FileCommitEntry[] } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    getFileHistory(path)
      .then((commits) => {
        if (!cancelled) setEntry({ path, commits });
      })
      .catch(() => {
        if (!cancelled) setEntry({ path, commits: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const commits = entry?.path === path ? entry.commits : null;
  return { commits, loading: commits === null };
}
