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
import { listen } from '@tauri-apps/api/event';
import * as client from '../lib/tauriClient';
import { useToasts, type Toast } from '../app/Toast';
import type { AppStatePayload, RebaseStep } from '../types/repository';

export type BackendMode = 'tauri' | 'browser';

export interface RepositoryContextValue {
  mode: BackendMode;
  state: AppStatePayload | null;
  busy: boolean;
  error: string | null;
  netSummary: string | null;
  toasts: Toast[];
  notify: (message: string, type?: Toast['type']) => void;
  repository: NonNullable<AppStatePayload['repository']> | null;
  openRepository: (path: string) => Promise<void>;
  pickRepository: () => Promise<void>;
  refresh: () => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (path: string) => Promise<void>;
  commit: (title: string, body: string, amend: boolean) => Promise<void>;
  stash: (message?: string) => Promise<void>;
  stageHunk: (path: string, hunkIndex: number) => Promise<void>;
  unstageHunk: (path: string, hunkIndex: number) => Promise<void>;
  discardHunk: (path: string, hunkIndex: number) => Promise<void>;
  cloneRepo: (url: string, target: string) => Promise<void>;
  rebaseOnto: (base: string) => Promise<void>;
  interactiveRebase: (base: string, steps: RebaseStep[]) => Promise<void>;
  abortRebase: () => Promise<void>;
  revertCommit: (oid: string) => Promise<void>;
  cherryPick: (oid: string) => Promise<void>;
  mergeBranch: (branch: string) => Promise<void>;
  stashApply: (index: number) => Promise<void>;
  stashPop: (index: number) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;
  createTag: (name: string) => Promise<void>;
  deleteTag: (name: string) => Promise<void>;
  createBranch: (name: string, checkout: boolean) => Promise<void>;
  checkoutBranch: (name: string) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;
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
  const { toasts, push } = useToasts();

  useEffect(() => {
    if (mode !== 'tauri') return;
    client
      .getAppState()
      .then(setState)
      .catch((e: unknown) => setError(String(e)));
  }, [mode]);

  // Auto-refresh when the file watcher detects external changes.
  useEffect(() => {
    if (mode !== 'tauri') return;
    let unlisten: (() => void) | null = null;
    listen('repo-changed', () => {
      client.refresh()
        .then(setState)
        .catch(() => {});
    }).then((off) => { unlisten = off; });
    return () => { unlisten?.(); };
  }, [mode]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, extract: (result: T) => AppStatePayload | null, successMsg?: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        const payload = extract(result);
        if (payload) setState(payload);
        if (successMsg) push(successMsg, 'success');
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        push(message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [push],
  );

  const runNet = useCallback(
    async (action: () => Promise<client.NetResultLike>) => {
      setBusy(true);
      setError(null);
      let ok = false;
      try {
        const result = await action();
        setNetSummary(result.summary);
        push(result.summary, 'success');
        ok = true;
        const payload = await client.refresh();
        setState(payload);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        push(message, 'error');
      } finally {
        setBusy(false);
      }
      return ok;
    },
    [push],
  );

  const value = useMemo<RepositoryContextValue>(
    () => ({
      mode,
      state,
      busy,
      error,
      netSummary,
      toasts,
      notify: push,
      repository: state?.repository ?? null,
      openRepository: (path) => run(() => client.openRepository(path), (p) => p, 'Repository opened'),
      pickRepository: async () => {
        if (!client.isTauri()) return;
        await run(() => client.pickRepository(), (p) => p, 'Repository opened');
      },
      refresh: () => run(() => client.refresh(), (p) => p),
      stage: (paths) =>
        run(() => client.stagePaths(paths), (p) => p, `Staged ${paths.length} file${paths.length === 1 ? '' : 's'}`),
      unstage: (paths) =>
        run(() => client.unstagePaths(paths), (p) => p, `Unstaged ${paths.length} file${paths.length === 1 ? '' : 's'}`),
      discard: (path) => run(() => client.discardFile(path), (p) => p, 'Changes discarded'),
      commit: async (title, body, amend) => {
        await run(
          () => client.commitChanges(title, body, amend),
          (outcome) => outcome.state,
          amend ? 'Commit amended' : 'Commit created',
        );
      },
      stash: (message) => run(() => client.stashChanges(message), (p) => p, 'Changes stashed'),
      stageHunk: (path, hunkIndex) => run(() => client.stageHunk(path, hunkIndex), (p) => p, 'Hunk staged'),
      unstageHunk: (path, hunkIndex) => run(() => client.unstageHunk(path, hunkIndex), (p) => p, 'Hunk unstaged'),
      discardHunk: (path, hunkIndex) => run(() => client.discardHunk(path, hunkIndex), (p) => p, 'Hunk discarded'),
      cloneRepo: (url, target) => run(() => client.cloneRepo(url, target), (p) => p, 'Repository cloned'),
      rebaseOnto: (base) => run(() => client.rebaseOnto(base), (p) => p, `Rebased onto ${base}`),
      interactiveRebase: (base, steps) =>
        run(
          () => client.interactiveRebase(base, steps),
          (p) => p,
          `Rebase applied: ${steps.length} commit${steps.length === 1 ? '' : 's'} replayed`,
        ),
      abortRebase: () => run(() => client.abortRebase(), (p) => p, 'Rebase aborted'),
      revertCommit: (oid) => run(() => client.revertCommit(oid), (p) => p, 'Commit reverted'),
      cherryPick: (oid) => run(() => client.cherryPick(oid), (p) => p, 'Commit cherry-picked'),
      mergeBranch: (branch) => run(() => client.mergeBranch(branch), (p) => p, `Merged ${branch}`),
      stashApply: (index) => run(() => client.stashApply(index), (p) => p, 'Stash applied'),
      stashPop: (index) => run(() => client.stashPop(index), (p) => p, 'Stash popped'),
      stashDrop: (index) => run(() => client.stashDrop(index), (p) => p, 'Stash dropped'),
      createTag: (name) => run(() => client.createTag(name), (p) => p, `Tag "${name}" created`),
      deleteTag: (name) => run(() => client.deleteTag(name), (p) => p, `Tag "${name}" deleted`),
      createBranch: (name, checkout) =>
        run(
          () => client.createBranch(name, checkout),
          (p) => p,
          checkout ? `Switched to new branch "${name}"` : `Branch "${name}" created`,
        ),
      checkoutBranch: (name) => run(() => client.checkoutBranch(name), (p) => p, `Switched to "${name}"`),
      deleteBranch: (name) => run(() => client.deleteBranch(name), (p) => p, `Branch "${name}" deleted`),
      fetchRemote: () => runNet(() => client.gitFetch()),
      pullRemote: () => runNet(() => client.gitPull()),
      pushRemote: () => runNet(() => client.gitPush()),
    }),
    [mode, state, busy, error, netSummary, toasts, push, run, runNet],
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
