import { useRequestGate } from './useRequestGate';
/** Repository state provider — bridges the Rust backend and the UI. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import * as client from '../lib/tauriClient';
import { useToasts, type Toast } from '../app/Toast';

let notificationSeq = 0;
import type { AppStatePayload, RebaseStep } from '../types/repository';

export type BackendMode = 'tauri' | 'browser';

/** One entry of the status-bar notification log (kept after toasts dismiss). */
export interface NotificationItem {
  id: number;
  message: string;
  type: Toast['type'];
  time: number;
}

export interface RepositoryContextValue {
  mode: BackendMode;
  state: AppStatePayload | null;
  busy: boolean;
  error: string | null;
  netSummary: string | null;
  toasts: Toast[];
  notify: (message: string, type?: Toast['type']) => void;
  /** Toast history for the status-bar bell (newest first, max 20). */
  notifications: NotificationItem[];
  clearNotifications: () => void;
  repository: NonNullable<AppStatePayload['repository']> | null;
  openRepository: (path: string) => Promise<boolean | void>;
  openSshWorkspace: (id: number, isCurrent: () => boolean) => Promise<boolean>;
  closeRepository: () => Promise<boolean>;
  pickRepository: () => Promise<boolean | void>;
  refresh: () => Promise<boolean | void>;
  stage: (paths: string[]) => Promise<boolean | void>;
  unstage: (paths: string[]) => Promise<boolean | void>;
  discard: (path: string) => Promise<boolean | void>;
  commit: (title: string, body: string, amend: boolean) => Promise<boolean>;
  stash: (message?: string) => Promise<boolean | void>;
  stageHunk: (path: string, hunkIndex: number) => Promise<boolean | void>;
  unstageHunk: (path: string, hunkIndex: number) => Promise<boolean | void>;
  discardHunk: (path: string, hunkIndex: number) => Promise<boolean | void>;
  stageLines: (
    path: string,
    side: 'staged' | 'unstaged',
    selectedOld: number[],
    selectedNew: number[],
  ) => Promise<boolean | void>;
  cloneRepo: (url: string, target: string) => Promise<boolean | void>;
  rebaseOnto: (base: string) => Promise<boolean | void>;
  interactiveRebase: (base: string, steps: RebaseStep[]) => Promise<boolean | void>;
  startCommitEdit: (branch: string, headOid: string, oid: string) => Promise<boolean>;
  continueCommitEdit: () => Promise<boolean>;
  abortRebase: () => Promise<boolean | void>;
  revertCommit: (oid: string) => Promise<boolean | void>;
  cherryPick: (oid: string) => Promise<boolean | void>;
  duplicateCommit: (sourceBranch: string, destinationBranch: string, oid: string) => Promise<boolean>;
  /** Finishes a duplicate that conflicted, with every conflicted file resolved. */
  duplicateCommitResolved: (
    sourceBranch: string,
    destinationBranch: string,
    oid: string,
    destinationOid: string,
    resolutions: client.DuplicateResolution[],
  ) => Promise<boolean>;
  mergeBranch: (branch: string, strategy?: string) => Promise<boolean>;
  mergeAbort: () => Promise<boolean | void>;
  /** Finishes or abandons whatever merge, rebase, cherry-pick or revert stopped with conflicts. */
  conflictContinue: () => Promise<boolean | void>;
  conflictAbort: () => Promise<boolean | void>;
  stashApply: (index: number) => Promise<boolean | void>;
  stashPop: (index: number) => Promise<boolean | void>;
  stashDrop: (index: number) => Promise<boolean | void>;
  createTag: (name: string) => Promise<boolean | void>;
  deleteTag: (name: string) => Promise<boolean | void>;
  createBranch: (name: string, checkout: boolean) => Promise<boolean | void>;
  checkoutBranch: (name: string) => Promise<boolean | void>;
  /** Creates (or switches to) the local branch tracking `remote/name`. */
  checkoutRemoteBranch: (remote: string, name: string) => Promise<boolean>;
  /** Checks out a tag as a detached HEAD. */
  checkoutTag: (name: string) => Promise<boolean>;
  deleteBranch: (name: string) => Promise<boolean | void>;
  fetchRemote: () => Promise<boolean>;
  pullRemote: () => Promise<boolean>;
  pushRemote: () => Promise<boolean>;
}

const RepositoryContext = createContext<RepositoryContextValue | null>(null);

export function RepositoryProvider({ children }: { children: ReactNode }) {
  const stateGate = useRequestGate();
  const operationInFlight = useRef(false);
  const queuedWatcherRefresh = useRef(false);
  const [mode] = useState<BackendMode>(() =>
    client.isTauri() ? 'tauri' : 'browser',
  );
  const [state, setState] = useState<AppStatePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [netSummary, setNetSummary] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  // Toasts vanish after 3.5s — keep a log for the status-bar bell.
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const notifyAndLog = useCallback((message: string, type: Toast['type'] = 'success') => {
    push(message, type);
    setNotifications((prev) =>
      [{ id: ++notificationSeq, message, type, time: Date.now() }, ...prev].slice(0, 20),
    );
  }, [push]);
  const clearNotifications = useCallback(() => setNotifications([]), []);

  useEffect(() => {
    // In a plain browser getAppState resolves with the design demo fixture.
    const current = stateGate.begin();
    client.getAppState().then(async (payload) => {
      try {
        const folder = await client.getLaunchFolder();
        if (!current()) return;
        const opened = folder ? await client.openRepository(folder) : payload;
        if (current()) setState(opened);
      } catch (e: unknown) {
        if (current()) { setState(payload); setError(String(e)); }
      }
    })
      .catch((e: unknown) => { if (current()) setError(String(e)); });
    return () => stateGate.invalidate();
  }, [mode, stateGate]);

  const refreshFromWatcher = useCallback(() => {
    if (operationInFlight.current) {
      queuedWatcherRefresh.current = true;
      return;
    }
    queuedWatcherRefresh.current = false;
    const current = stateGate.begin();
    client.refresh().then((payload) => { if (current()) setState(payload); })
      .catch((e: unknown) => { if (current()) setError(String(e)); });
  }, [stateGate]);

  // Apply changes that arrived while a repository operation was running.
  useEffect(() => {
    if (!busy && queuedWatcherRefresh.current) refreshFromWatcher();
  }, [busy, refreshFromWatcher]);

  // Auto-refresh when the file watcher detects external changes.
  useEffect(() => {
    if (mode !== 'tauri') return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen('repo-changed', refreshFromWatcher)
      .then((off) => { if (disposed) off(); else unlisten = off; })
      .catch((e: unknown) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; unlisten?.(); };
  }, [mode, refreshFromWatcher]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, extract: (result: T) => AppStatePayload | null, successMsg?: string) => {
      if (operationInFlight.current) {
        notifyAndLog('Another repository operation is still running. Please wait.', 'error');
        return false;
      }
      operationInFlight.current = true;
      stateGate.invalidate();
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        const payload = extract(result);
        if (payload) setState(payload);
        if (successMsg && payload) notifyAndLog(successMsg, 'success');
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        notifyAndLog(message, 'error');
        return false;
      } finally {
        operationInFlight.current = false;
        setBusy(false);
      }
    },
    [notifyAndLog, stateGate],
  );

  const runNet = useCallback(
    async (action: () => Promise<client.NetResultLike>) => {
      if (operationInFlight.current) return false;
      operationInFlight.current = true;
      stateGate.invalidate();
      setBusy(true);
      setError(null);
      let ok = false;
      try {
        const result = await action();
        setNetSummary(result.summary);
        notifyAndLog(result.summary, 'success');
        ok = true;
        const payload = await client.refresh();
        setState(payload);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        notifyAndLog(message, 'error');
      } finally {
        operationInFlight.current = false;
        setBusy(false);
      }
      return ok;
    },
    [notifyAndLog, stateGate],
  );

  const value = useMemo<RepositoryContextValue>(
    () => ({
      mode,
      state,
      busy,
      error,
      netSummary,
      toasts,
      notify: notifyAndLog,
      notifications,
      clearNotifications,
      repository: state?.repository ?? null,
      openRepository: (path) => run(() => client.openRepository(path), (p) => p, 'Repository opened'),
      openSshWorkspace: (id, isCurrent) => run(async () => {
        try {
          return await client.openSshWorkspace(id);
        } catch (error) {
          if (isCurrent()) throw error;
          return null;
        }
      }, (payload) => payload, 'Server workspace opened'),
      closeRepository: () => run(() => client.closeRepository(), (payload) => payload),
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
        return run(
          () => client.commitChanges(title, body, amend),
          (outcome) => outcome.state,
          amend ? 'Commit amended' : 'Commit created',
        );
      },
      stash: (message) => run(() => client.stashChanges(message), (p) => p, 'Changes stashed'),
      stageHunk: (path, hunkIndex) => run(() => client.stageHunk(path, hunkIndex), (p) => p, 'Hunk staged'),
      unstageHunk: (path, hunkIndex) => run(() => client.unstageHunk(path, hunkIndex), (p) => p, 'Hunk unstaged'),
      discardHunk: (path, hunkIndex) => run(() => client.discardHunk(path, hunkIndex), (p) => p, 'Hunk discarded'),
      stageLines: (path, side, selectedOld, selectedNew) =>
        run(
          () => client.stageLines(path, side, selectedOld, selectedNew),
          (p) => p,
          side === 'staged' ? 'Selected lines unstaged' : 'Selected lines staged',
        ),
      cloneRepo: (url, target) => run(() => client.cloneRepo(url, target), (p) => p, 'Repository cloned'),
      rebaseOnto: (base) => run(() => client.rebaseOnto(base), (p) => p, `Rebased onto ${base}`),
      interactiveRebase: (base, steps) =>
        run(
          () => client.interactiveRebase(base, steps),
          (p) => p,
          `Rebase applied: ${steps.length} commit${steps.length === 1 ? '' : 's'} replayed`,
        ),
      startCommitEdit: (branch, headOid, oid) =>
        run(() => client.startCommitEdit(branch, headOid, oid), (payload) => payload),
      continueCommitEdit: () =>
        run(() => client.continueCommitEdit(), (payload) => {
          if (!payload.repository?.commitEdit) notifyAndLog('Commit edit complete', 'success');
          return payload;
        }),
      abortRebase: () => run(() => client.abortRebase(), (p) => p, 'Rebase aborted'),
      revertCommit: (oid) => run(() => client.revertCommit(oid), (p) => p, 'Commit reverted'),
      cherryPick: (oid) => run(() => client.cherryPick(oid), (p) => p, 'Commit cherry-picked'),
      duplicateCommit: (source, destination, oid) =>
        run(() => client.duplicateCommit(source, destination, oid), (p) => p, `Duplicated ${oid.slice(0, 7)} onto ${destination}`),
      duplicateCommitResolved: (source, destination, oid, destinationOid, resolutions) =>
        run(
          () => client.duplicateCommitResolved(source, destination, oid, destinationOid, resolutions),
          (p) => p,
          `Duplicated ${oid.slice(0, 7)} onto ${destination} with ${resolutions.length} resolved file${resolutions.length === 1 ? '' : 's'}`,
        ),
      mergeBranch: (branch, strategy) => run(() => client.mergeBranch(branch, strategy), (p) => p, `Merged ${branch}`),
      mergeAbort: () => run(() => client.mergeAbort(), (p) => p, 'Merge aborted'),
      conflictContinue: () => run(() => client.conflictContinue(), (p) => p, 'Conflicts resolved — operation finished'),
      conflictAbort: () => run(() => client.conflictAbort(), (p) => p, 'Operation aborted'),
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
      checkoutRemoteBranch: (remote, name) =>
        run(() => client.checkoutRemoteBranch(remote, name), (p) => p, `Switched to "${name}" (tracking ${remote}/${name})`),
      checkoutTag: (name) => run(() => client.checkoutTag(name), (p) => p, `Checked out tag "${name}" (detached HEAD)`),
      deleteBranch: (name) => run(() => client.deleteBranch(name), (p) => p, `Branch "${name}" deleted`),
      fetchRemote: () => runNet(() => client.gitFetch()),
      pullRemote: () => runNet(() => client.gitPull()),
      pushRemote: () => runNet(() => client.gitPush()),
    }),
    [mode, state, busy, error, netSummary, toasts, run, runNet, notifyAndLog, notifications, clearNotifications],
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
