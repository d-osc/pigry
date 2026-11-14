/** Rebase Branch screen — replay the current branch onto another branch.
 * Pick a base, optionally edit the plan (reorder / squash / drop), then
 * rebase. A conflicted rebase surfaces its files with an abort action. */
import { useEffect, useState } from 'react';
import { ChatAwareDiffEditor } from '../../lib/ChatAwareDiffEditor';
import { ArrowDown, ArrowUp, CircleAlert, History, Undo2 } from 'lucide-react';
import { CommitSyncIcon } from '../../lib/CommitSyncIcon';
import { shareCommitWithChat } from '../../lib/chatBridge';
import { AuthorAvatar, useCommitAvatars } from '../../lib/AuthorAvatar';
import { useRepository } from '../../hooks/useRepository';
import {
  abortRebase,
  getBranchCommits,
  getCommitDetail,
  getCommitHistory,
  interactiveRebase,
  mergeStatus,
  readFileAtCommit,
  rebaseOnto,
} from '../../lib/tauriClient';
import type { CommitDetail, RebaseAction, RebaseStep } from '../../types/repository';
import { relativeTime } from '../../lib/relativeTime';
import { languageForPath } from '../../lib/ghData';
import '../../editor/monacoSetup';
import './RebaseBranchScreen.css';

interface PlanRow {
  oid: string;
  shortOid: string;
  summary: string;
  authorName: string;
  authorEmail?: string;
  authorInitials?: string;
  timeSeconds: number;
  /** True when the commit is reachable from a remote branch (on the cloud). */
  pushed: boolean;
  action: RebaseAction;
}

/** Plan load result, tagged with the base/head it was computed for so a
 * switch renders as "loading" instead of showing the previous branch's rows. */
interface PlanState {
  base: string;
  head: string;
  rows: PlanRow[];
  error: string | null;
}

const NEXT_ACTION: Record<RebaseAction, RebaseAction> = {
  pick: 'squash',
  squash: 'drop',
  drop: 'pick',
};

export function RebaseBranchScreen() {
  const { repository, refresh, notify } = useRepository();
  const avatarMap = useCommitAvatars();
  const currentBranch = repository?.currentBranch ?? '';
  const rebaseRunning = repository?.rebaseInProgress ?? false;
  const headOid = repository?.headOid ?? '';
  const others = (repository?.branches ?? []).filter((b) => !b.isHead);

  /** The chosen base branch; falls back to the first other branch. */
  const [baseBranch, setBaseBranch] = useState('');
  const base = baseBranch || others[0]?.name || '';
  const [plan, setPlan] = useState<PlanState | null>(null);
  /** Conflicted files for the rebase mid-flight (null = none loaded). */
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const [running, setRunning] = useState(false);

  // Expanded commit detail (click a plan row to inspect its file changes).
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{
    before: string;
    after: string;
    language: string;
  } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [splitView, setSplitView] = useState(true);

  const planCurrent = plan !== null && plan.base === base && plan.head === headOid;
  const rows = planCurrent ? plan.rows : null;
  const planError = planCurrent ? plan.error : null;
  const planValid = rows !== null && rows.length > 0 && rows[rows.length - 1].action !== 'squash';

  // The plan is the commits between the base branch and HEAD (base excluded),
  // newest first — the same rows the commit-graph rebase modal edits. The
  // base tip comes from its own branch history; when the branches diverged
  // (or the tip is outside the loaded history window) the tip has no position
  // in HEAD's listing and the editable plan is unavailable — the plain rebase
  // still works, git only replays HEAD's side.
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    Promise.all([getCommitHistory(false), getBranchCommits(base)])
      .then(([history, branchHistory]) => {
        if (cancelled) return;
        const tip = branchHistory.commits[0]?.oid ?? '';
        const index = tip ? history.commits.findIndex((c) => c.oid === tip) : -1;
        if (index === -1) {
          setPlan({
            base,
            head: headOid,
            rows: [],
            error: `${base} is outside the loaded history of ${currentBranch || 'HEAD'} — the branches may have diverged. The plain rebase still works.`,
          });
          return;
        }
        setPlan({
          base,
          head: headOid,
          rows: history.commits.slice(0, index).map((row) => ({
            oid: row.oid,
            shortOid: row.shortOid,
            summary: row.summary,
            authorName: row.authorName,
            authorEmail: row.authorEmail,
            authorInitials: row.authorInitials,
            timeSeconds: row.timeSeconds,
            pushed: row.pushed,
            action: 'pick' as RebaseAction,
          })),
          error: null,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPlan({ base, head: headOid, rows: [], error: 'Could not load the commit history for the rebase plan.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [base, headOid, currentBranch]);

  // A rebase left mid-flight (started here or in a terminal) — load its
  // conflicted files for the abort card.
  useEffect(() => {
    if (!rebaseRunning) return;
    let cancelled = false;
    mergeStatus()
      .then((status) => {
        if (!cancelled) setConflictFiles(status.conflicted);
      })
      .catch(() => {
        if (!cancelled) setConflictFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rebaseRunning]);

  const move = (index: number, delta: number) => {
    setPlan((prev) => {
      if (!prev || prev.base !== base || prev.head !== headOid) return prev;
      const target = index + delta;
      if (target < 0 || target >= prev.rows.length) return prev;
      const nextRows = [...prev.rows];
      [nextRows[index], nextRows[target]] = [nextRows[target], nextRows[index]];
      return { ...prev, rows: nextRows };
    });
  };

  const cycleAction = (index: number) => {
    setPlan((prev) => {
      if (!prev || prev.base !== base || prev.head !== headOid) return prev;
      const nextRows = [...prev.rows];
      const row = nextRows[index];
      // The oldest selected row cannot squash into the base — cycle pick/drop only.
      const nextAction =
        index === nextRows.length - 1 && row.action === 'pick' ? 'drop' : NEXT_ACTION[row.action];
      nextRows[index] = { ...row, action: nextAction };
      return { ...prev, rows: nextRows };
    });
  };

  /** Click a plan row — expand/collapse its commit detail (file changes). */
  const toggleDetail = async (row: PlanRow) => {
    // Clicking the selected row again collapses its detail.
    if (selectedOid === row.oid) {
      setSelectedOid(null);
      setDetail(null);
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setSelectedOid(row.oid);
    setDetail(null);
    setOpenFile(null);
    setFileContent(null);
    shareCommitWithChat({ oid: row.oid, summary: row.summary });
    setLoadingDetail(true);
    try {
      setDetail(await getCommitDetail(row.oid));
    } catch {
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  /** Toggle the before/after diff of one file inside the expanded commit. */
  const openCompare = async (oid: string, parentOid: string | null, filePath: string) => {
    const key = `${oid}:${filePath}`;
    if (openFile === key) {
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setOpenFile(key);
    setFileContent(null);
    setLoadingFile(true);
    try {
      const [before, after] = await Promise.all([
        parentOid ? readFileAtCommit(filePath, parentOid) : null,
        readFileAtCommit(filePath, oid),
      ]);
      setFileContent({
        before: before?.content ?? '',
        after: after?.content ?? '',
        language: after?.language || before?.language || languageForPath(filePath),
      });
    } catch {
      setFileContent(null);
    } finally {
      setLoadingFile(false);
    }
  };

  const handleRebaseError = async (error: unknown) => {
    const messageText = error instanceof Error ? error.message : String(error);
    if (messageText.includes('CONFLICT') || messageText.includes('could not apply')) {
      try {
        const status = await mergeStatus();
        setConflictFiles(status.conflicted);
      } catch {
        setConflictFiles([]);
      }
      notify('Rebase conflicts — resolve the files or abort', 'error');
    } else {
      notify(messageText, 'error');
    }
    // The failed rebase may still be mid-flight on the git side; a refresh
    // flips rebaseInProgress so the conflict card and banner appear.
    refresh();
  };

  const doRebase = async () => {
    if (running || rebaseRunning || !base) return;
    setRunning(true);
    try {
      await rebaseOnto(base);
      notify(`Rebased ${currentBranch || 'HEAD'} onto ${base}`, 'success');
      refresh();
    } catch (error) {
      await handleRebaseError(error);
    } finally {
      setRunning(false);
    }
  };

  const doInteractive = async () => {
    if (running || rebaseRunning || !base || !planValid || rows === null) return;
    // Display order is newest first; the todo list git applies is the reverse.
    const steps: RebaseStep[] = [...rows].reverse().map(({ oid, action }) => ({ oid, action }));
    setRunning(true);
    try {
      await interactiveRebase(base, steps);
      notify(
        `Rebase applied: ${steps.length} commit${steps.length === 1 ? '' : 's'} replayed`,
        'success',
      );
      refresh();
    } catch (error) {
      await handleRebaseError(error);
    } finally {
      setRunning(false);
    }
  };

  const doAbort = async () => {
    try {
      await abortRebase();
      notify('Rebase aborted — branch restored', 'success');
      setConflictFiles(null);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const hasOthers = others.length > 0;

  return (
    <div className="rb-screen">
      <section className="rb__header">
        <h3 className="rb__title">
          <History size={14} strokeWidth={1.5} />
          Rebase Branch
        </h3>
        <span className="rb__branch">
          replays {currentBranch || 'the current branch'} onto the branch you pick — rewrite
          history before pushing
        </span>
      </section>

      {rebaseRunning && (
        <section className="rb__conflict">
          <p className="rb__conflict-title">
            <CircleAlert size={13} strokeWidth={1.5} />
            Rebase in progress on {currentBranch || 'the current branch'}
          </p>
          {conflictFiles !== null && conflictFiles.length > 0 && (
            <ul className="rb__conflict-files">
              {conflictFiles.map((file) => (
                <li key={file} className="rb__conflict-file">
                  {file}
                </li>
              ))}
            </ul>
          )}
          <div className="rb__conflict-actions">
            <button type="button" className="rb__abort-btn" onClick={() => void doAbort()}>
              <Undo2 size={12} strokeWidth={1.5} />
              Abort rebase
            </button>
            <span className="rb__conflict-hint">
              resolve the files in Working changes, then continue in a terminal — or abort to
              restore the branch
            </span>
          </div>
        </section>
      )}

      <section className="rb__browse">
        <h4 className="rb__section-title">Base branch</h4>
        <div className="rb__branch-row">
          <label className="rb__branch-label">
            Rebase {currentBranch || 'HEAD'} onto
            <select
              className="rb__branch-select"
              value={base}
              disabled={!hasOthers || rebaseRunning}
              onChange={(event) => setBaseBranch(event.target.value)}
            >
              {hasOthers ? (
                others.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))
              ) : (
                <option value="">no other branches</option>
              )}
            </select>
          </label>
        </div>

        <h4 className="rb__section-title">
          Commits to replay{rows !== null ? ` (${rows.length})` : ''}
        </h4>
        {rows === null && !planError && <p className="rb__empty">Loading commits…</p>}
        {planError && <p className="rb__plan-error">{planError}</p>}
        {rows !== null && rows.length === 0 && !planError && (
          <p className="rb__empty">
            No commits between {base} and HEAD — nothing to rebase.
          </p>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="rb__list">
            {rows.map((row, index) => (
              <li
                key={row.oid}
                className={`rb__row${row.action === 'drop' ? ' rb__row--drop' : ''}${selectedOid === row.oid ? ' rb__row--open' : ''}`}
              >
                <button
                  type="button"
                  className="rb__action"
                  onClick={() => cycleAction(index)}
                  title="Click to cycle pick → squash → drop"
                  data-action={row.action}
                >
                  {row.action}
                </button>
                <button
                  type="button"
                  className="rb__row-main"
                  title={selectedOid === row.oid ? 'Collapse commit' : 'Show file changes'}
                  onClick={() => void toggleDetail(row)}
                >
                  <span className="rb__oid">{row.shortOid}</span>
                  <span className="rb__summary" title={row.summary}>
                    {row.summary}
                  </span>
                  <AuthorAvatar row={row} avatarMap={avatarMap} />
                  {Number.isFinite(row.timeSeconds) && (
                    <span
                      className="rb__meta"
                      title={new Date(row.timeSeconds * 1000).toLocaleString()}
                    >
                      {row.authorName} · {relativeTime(row.timeSeconds)}
                    </span>
                  )}
                  <CommitSyncIcon pushed={row.pushed} />
                </button>
                <span className="rb__move">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move commit up (applied later)"
                  >
                    <ArrowUp size={11} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => move(index, 1)}
                    disabled={index === rows.length - 1}
                    aria-label="Move commit down (applied earlier)"
                  >
                    <ArrowDown size={11} />
                  </button>
                </span>
                {selectedOid === row.oid && (
                  <div className="rb__detail">
                    {loadingDetail && <p className="rb__empty">Loading commit…</p>}
                    {detail && (
                      <>
                        <div className="rb__detail-head">
                          <div>
                            <span className="rb__detail-sha">{detail.shortOid}</span>
                            <span className="rb__detail-summary">{detail.summary}</span>
                            <div className="rb__detail-meta">
                              {detail.authorName} · {relativeTime(detail.timeSeconds)}
                              {detail.isMerge && ' · merge commit'}
                            </div>
                          </div>
                        </div>
                        {detail.message !== detail.summary && (
                          <pre className="rb__detail-body">{detail.message}</pre>
                        )}
                        <h4 className="rb__section-title">
                          Files ({detail.files.length})
                        </h4>
                        <ul className="rb__files">
                          {detail.files.map((file) => {
                            const parentOid = detail.parents[0] ?? null;
                            const fileKey = `${detail.oid}:${file.path}`;
                            const fileOpen = openFile === fileKey;
                            return (
                              <li
                                key={`${file.path}:${file.status}`}
                                className="rb__file"
                              >
                                <button
                                  type="button"
                                  className="rb__file-row"
                                  title={`Compare ${file.path} (parent vs commit)`}
                                  onClick={() =>
                                    void openCompare(detail.oid, parentOid, file.path)
                                  }
                                >
                                  <span
                                    className={`rb__file-status rb__file-status--${file.status}`}
                                  >
                                    {file.status}
                                  </span>
                                  <span className="rb__file-path">{file.path}</span>
                                  <span className="rb__file-stats">
                                    <span className="stats-add">+{file.additions}</span>
                                    <span className="stats-del">−{file.deletions}</span>
                                  </span>
                                </button>
                                {fileOpen && (
                                  <div className="rb__file-view">
                                    <div className="rb__file-view-labels">
                                      <span>
                                        BEFORE — {parentOid?.slice(0, 7) ?? '(new file)'}
                                      </span>
                                      <span>COMMIT — {detail.shortOid}</span>
                                      <div
                                        className="rb__view-mode"
                                        role="group"
                                        aria-label="Diff layout"
                                      >
                                        <button
                                          type="button"
                                          className={splitView ? 'is-active' : ''}
                                          onClick={() => setSplitView(true)}
                                        >
                                          Split
                                        </button>
                                        <button
                                          type="button"
                                          className={!splitView ? 'is-active' : ''}
                                          onClick={() => setSplitView(false)}
                                        >
                                          Unified
                                        </button>
                                      </div>
                                    </div>
                                    {loadingFile && (
                                      <p className="rb__empty">Loading versions…</p>
                                    )}
                                    <ChatAwareDiffEditor
                                      chatMeta={{ path: file.path, source: 'Rebase Branch' }}
                                      key={fileKey}
                                      original={fileContent?.before ?? ''}
                                      modified={fileContent?.after ?? ''}
                                      language={fileContent?.language ?? 'plaintext'}
                                      theme="pigry-dark"
                                      options={{
                                        readOnly: true,
                                        renderSideBySide: splitView,
                                        fontSize: 11,
                                        lineHeight: 18,
                                        minimap: { enabled: false },
                                        scrollBeyondLastLine: false,
                                        automaticLayout: true,
                                      }}
                                    />
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="rb__actions">
          <button
            type="button"
            className="rb__rebase-btn"
            disabled={!hasOthers || !base || running || rebaseRunning}
            onClick={() => void doRebase()}
          >
            <History size={13} strokeWidth={1.5} />
            {running ? 'Rebasing…' : `Rebase onto ${base || '…'}`}
          </button>
          <button
            type="button"
            className="rb__plan-btn"
            disabled={!planValid || running || rebaseRunning}
            title="Apply the edited plan (reorder / squash / drop)"
            onClick={() => void doInteractive()}
          >
            Start rebase with plan
          </button>
        </div>
        <p className="rb__hint">
          Click the action chip to cycle pick → squash → drop; arrows reorder. The plain rebase
          replays every commit untouched. Cloud = pushed to a remote; disk = local only.
        </p>
      </section>
    </div>
  );
}
