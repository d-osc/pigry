/** Loads the per-file commit history for the Explorer history panel. */
import { useEffect, useState } from 'react';
import { useRepository } from './useRepository';
import { getFileHistory } from '../lib/tauriClient';
import type { FileCommitEntry } from '../types/repository';

// History, Compare and Merge all show the same file's history at once; they
// share one request per repository + HEAD + ref + path instead of three.
const MAX_CACHED = 30;
const REF_HISTORY_TTL_MS = 30_000;
const loads = new Map<string, Promise<FileCommitEntry[]>>();

function loadHistory(scope: string, path: string, refName: string | null): Promise<FileCommitEntry[]> {
  const cached = loads.get(scope);
  if (cached) return cached;
  const pending = getFileHistory(path, refName);
  loads.set(scope, pending);
  const forget = () => {
    if (loads.get(scope) === pending) loads.delete(scope);
  };
  // A failure is not cached: Try again asks the backend again. History from
  // HEAD is fixed for its HEAD id (part of the scope); another ref (a PR
  // branch) can move after a fetch without HEAD changing, so it expires.
  pending.then(() => {
    if (refName) window.setTimeout(forget, REF_HISTORY_TTL_MS);
  }, forget);
  if (loads.size > MAX_CACHED) {
    const oldest = loads.keys().next().value;
    if (oldest !== undefined) loads.delete(oldest);
  }
  return pending;
}

export function useFileHistory(path: string, refName?: string | null) {
  const { repository } = useRepository();
  const scope = `${repository?.localPath}:${repository?.headOid}:${refName ?? ''}:${path}`;
  const [attempt, setAttempt] = useState(0);
  const [entry, setEntry] = useState<{ scope: string; commits: FileCommitEntry[]; error: string | null } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    loadHistory(scope, path, refName ?? null)
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
  const retry = () => {
    loads.delete(scope);
    setAttempt((n) => n + 1);
  };
  return { commits, error: current?.error ?? null, retry, loading: commits === null };
}
