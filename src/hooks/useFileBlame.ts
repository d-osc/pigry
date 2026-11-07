/** Per-line blame for the editor's blame annotations. */
import { useEffect, useState } from 'react';
import { getFileBlame } from '../lib/tauriClient';
import type { BlameLine } from '../types/repository';

export function useFileBlame(path: string, enabled: boolean) {
  const [entry, setEntry] = useState<{
    path: string;
    lines: BlameLine[];
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getFileBlame(path)
      .then((lines) => {
        if (!cancelled) setEntry({ path, lines });
      })
      .catch(() => {
        if (!cancelled) setEntry({ path, lines: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  const current = entry?.path === path ? entry : null;
  return { lines: current?.lines ?? null, loading: current === null };
}
