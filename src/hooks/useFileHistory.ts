/** Loads the per-file commit history for the Explorer history panel. */
import { useEffect, useState } from 'react';
import { useRepository } from './useRepository';
import { getFileHistory } from '../lib/tauriClient';
import type { FileCommitEntry } from '../types/repository';

export function useFileHistory(path: string, refName?: string | null) {
  const { repository } = useRepository();
  const scope = `${repository?.localPath}:${repository?.headOid}:${refName ?? ''}:${path}`;
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState<{ scope: string; commits: FileCommitEntry[]; error: string | null } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    getFileHistory(path, refName ?? null)
      .then((commits) => {
        if (!cancelled) setEntry({ scope, commits, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setEntry({ scope, commits: [], error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, refName, scope, attempt]);

  const current = entry?.scope === scope ? entry : null;
  const commits = current?.commits ?? null;
  return { commits, error: current?.error ?? null, retry: () => setAttempt((n) => n + 1), loading: commits === null };
}
