/** Per-line diff status (added/modified vs HEAD) for gutter decorations. */
import { useEffect, useState } from 'react';
import { getLineChanges } from '../lib/tauriClient';
import type { LineChange } from '../types/repository';

export function useLineChanges(path: string, reloadKey: string | number) {
  const [entry, setEntry] = useState<{
    path: string;
    changes: LineChange[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLineChanges(path)
      .then((changes) => {
        if (!cancelled) setEntry({ path, changes });
      })
      .catch(() => {
        if (!cancelled) setEntry({ path, changes: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  const current = entry?.path === path ? entry : null;
  return { changes: current?.changes ?? null, loading: current === null };
}
