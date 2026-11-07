/** Loads commit history from the backend; reloads on toggle or reloadKey change. */
import { useEffect, useState } from 'react';
import { getCommitHistory } from '../lib/tauriClient';
import type { CommitHistory } from '../types/repository';

interface HistoryEntry {
  includeRemotes: boolean;
  history: CommitHistory;
  error: null;
}

export function useCommitHistory(includeRemotes: boolean, reloadKey = 0) {
  const [entry, setEntry] = useState<HistoryEntry | null>(null);
  const [failed, setFailed] = useState<{ includeRemotes: boolean; error: string } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    getCommitHistory(includeRemotes)
      .then((history) => {
        if (!cancelled) {
          setEntry({ includeRemotes, history, error: null });
          setFailed(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFailed({ includeRemotes, error: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [includeRemotes, reloadKey]);

  const isCurrent = (key: { includeRemotes: boolean }) =>
    key.includeRemotes === includeRemotes;
  const history = entry && isCurrent(entry) ? entry.history : null;
  const error = failed && isCurrent(failed) ? failed.error : null;
  const loading = history === null && error === null;

  return { history, error, loading };
}
