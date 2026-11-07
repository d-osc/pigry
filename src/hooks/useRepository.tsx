/** Repository state provider — bridges the Rust backend and the UI. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import * as client from '../lib/tauriClient';
import type { AppStatePayload } from '../types/repository';

export type BackendMode = 'tauri' | 'browser';

export interface RepositoryContextValue {
  mode: BackendMode;
  state: AppStatePayload | null;
  busy: boolean;
  error: string | null;
  netSummary: string | null;
  repository: NonNullable<AppStatePayload['repository']> | null;
  openRepository: (path: string) => Promise<void>;
  pickRepository: () => Promise<void>;
  refresh: () => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (path: string) => Promise<void>;
  commit: (title: string, body: string, amend: boolean) => Promise<void>;
  stash: (message?: string) => Promise<void>;
  fetchRemote: () => Promise<boolean>;
  pullRemote: () => Promise<boolean>;
  pushRemote: () => Promise<boolean>;
}

const RepositoryContext = createContext<RepositoryContextValue | null>(null);

export function RepositoryProvider({ children }: { children: ReactNode }) {
  const [mode] = useState<BackendMode>(() =>
    client.isTauri() ? 'tauri' : 'browser',
  );
  const [state, setState] = useState<AppStatePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [netSummary, setNetSummary] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'tauri') return;
    client
      .getAppState()
      .then(setState)
      .catch((e: unknown) => setError(String(e)));
  }, [mode]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, extract: (result: T) => AppStatePayload | null) => {
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        const payload = extract(result);
        if (payload) setState(payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const runNet = useCallback(
    async (action: () => Promise<client.NetResultLike>) => {
      setBusy(true);
      setError(null);
      let ok = false;
      try {
        const result = await action();
        setNetSummary(result.summary);
        ok = true;
        const payload = await client.refresh();
        setState(payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return ok;
    },
    [],
  );

  const value = useMemo<RepositoryContextValue>(
    () => ({
      mode,
      state,
      busy,
      error,
      netSummary,
      repository: state?.repository ?? null,
      openRepository: (path) => run(() => client.openRepository(path), (p) => p),
      pickRepository: async () => {
        if (!client.isTauri()) return;
        await run(() => client.pickRepository(), (p) => p);
      },
      refresh: () => run(() => client.refresh(), (p) => p),
      stage: (paths) => run(() => client.stagePaths(paths), (p) => p),
      unstage: (paths) => run(() => client.unstagePaths(paths), (p) => p),
      discard: (path) => run(() => client.discardFile(path), (p) => p),
      commit: async (title, body, amend) => {
        await run(() => client.commitChanges(title, body, amend), (outcome) => outcome.state);
      },
      stash: (message) => run(() => client.stashChanges(message), (p) => p),
      fetchRemote: () => runNet(() => client.gitFetch()),
      pullRemote: () => runNet(() => client.gitPull()),
      pushRemote: () => runNet(() => client.gitPush()),
    }),
    [mode, state, busy, error, netSummary, run, runNet],
  );

  return <RepositoryContext.Provider value={value}>{children}</RepositoryContext.Provider>;
}

export function useRepository(): RepositoryContextValue {
  const context = useContext(RepositoryContext);
  if (!context) {
    throw new Error('useRepository must be used inside <RepositoryProvider>');
  }
  return context;
}
