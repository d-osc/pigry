import { CommitFilters, CommitSortSelect } from '../commit-preview/CommitListControls';
import { browseCommits, useCommitTimeRange, type CommitSort } from '../commit-preview/commitList';
import { useRequestGate } from '../../hooks/useRequestGate';
/** Shared screen behind Cherry Pick and Revert commit — browse recent commits, inspect one, and apply an action to
 * it on the current branch. Conflicted runs surface the conflicted files with an abort action. */
import { useEffect, useState } from 'react';
import { ChatAwareDiffEditor } from '../../lib/ChatAwareDiffEditor';
import { CircleAlert, Undo2, type LucideIcon } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  getBranchCommits,
  getCommitDetail,
  getCommitHistory,
  mergeStatus,
  readFileAtCommit,
} from '../../lib/tauriClient';
import type { CommitDetail, CommitRow } from '../../types/repository';
import { relativeTime } from '../../lib/relativeTime';
import { CommitSyncIcon } from '../../lib/CommitSyncIcon';
import { AuthorAvatar, useCommitAvatars } from '../../lib/AuthorAvatar';
import { shareCommitWithChat } from '../../lib/chatBridge';
import { languageForPath } from '../../lib/ghData';
import '../../editor/monacoSetup';
import './CherryPickScreen.css';

const MAX_ROWS = 40;

/** What differs between the screens that share this layout. */
export interface CommitActionConfig {
  title: string;
  Icon: LucideIcon;
  /** Header hint, given the checked-out branch name. */
  subtitle: (branch: string) => string;
  /** Browse only the checked-out branch (a revert needs a commit reachable from HEAD). */
  currentBranchOnly?: boolean;
  /** Chat context label for shared diffs. */
  source: string;
  actionLabel: (shortOid: string) => string;
  actionBusyLabel: string;
  actionTooltip: (shortOid: string, branch: string) => string;
  mergeTooltip: string;
  success: (shortOid: string) => string;
  run: (oid: string) => Promise<unknown>;
  conflictTitle: string;
  conflictNotice: string;
  conflictHint: string;
  isConflict: (message: string) => boolean;
  abortLabel: string;
  abortDone: string;
  abort: () => Promise<unknown>;
}

export function CommitActionScreen({ config }: { config: CommitActionConfig }) {
  const { Icon } = config;
  const fileGate = useRequestGate();
  const detailGate = useRequestGate();
  const { repository, refresh, notify } = useRepository();
  const avatarMap = useCommitAvatars();
  const headOid = repository?.headOid ?? '';
  const currentBranch = repository?.currentBranch ?? '';
  const [rows, setRows] = useState<CommitRow[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CommitSort>('newest');
  const [account, setAccount] = useState('');
  const { range, setRange, cutoff } = useCommitTimeRange();
  /** '' = every branch (full history); otherwise a branch ref to browse. */
  const [branchFilter, setBranchFilter] = useState('');
  /** How many rows are shown before "Show more" (search shows all matches). */
  const [visibleCount, setVisibleCount] = useState(MAX_ROWS);
  const [selected, setSelected] = useState<CommitRow | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [picking, setPicking] = useState(false);
  const [conflicted, setConflicted] = useState<string[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{
    before: string;
    after: string;
    language: string;
  } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [splitView, setSplitView] = useState(true);
  const matchingRows = browseCommits(rows, sort, query, account, cutoff);
  const visibleRows = query.trim() ? matchingRows : matchingRows.slice(0, visibleCount);

  // Reload the browse list whenever HEAD moves or the branch filter changes.
  useEffect(() => {
    let cancelled = false;
    const listed = config.currentBranchOnly ? currentBranch : branchFilter;
    const load = listed
      ? getBranchCommits(listed)
      : getCommitHistory(false);
    load
      .then((history) => {
        if (!cancelled) setRows(history.commits);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [headOid, branchFilter, currentBranch, config.currentBranchOnly]);
  const selectCommit = async (row: CommitRow) => {
    const isCurrent = detailGate.begin();
    fileGate.invalidate();
    // Clicking the selected row again collapses its detail.
    if (selected?.oid === row.oid) {
      setSelected(null);
      setDetail(null);
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setSelected(row);
    setDetail(null);
    setOpenFile(null);
    setFileContent(null);
    shareCommitWithChat({ oid: row.oid, summary: row.summary });
    setLoadingDetail(true);
    try {
      const result = await getCommitDetail(row.oid);
      if (isCurrent()) setDetail(result);
    } catch (error) {
      if (!isCurrent()) return;
      notify(error instanceof Error ? error.message : String(error), 'error');
      setDetail(null);
    } finally {
      if (isCurrent()) setLoadingDetail(false);
    }
  };

  const openCompare = async (oid: string, parentOid: string | null, filePath: string) => {
    const isCurrent = fileGate.begin();
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
      if (!isCurrent()) return;
      setFileContent({
        before: before?.content ?? '',
        after: after?.content ?? '',
        language: after?.language || before?.language || languageForPath(filePath),
      });
    } catch (error) {
      if (!isCurrent()) return;
      notify(error instanceof Error ? error.message : String(error), 'error');
      setFileContent(null);
    } finally {
      if (isCurrent()) setLoadingFile(false);
    }
  };

  const doPick = async (row: CommitRow) => {
    if (picking) return;
    setPicking(true);
    try {
      await config.run(row.oid);
      notify(config.success(row.shortOid), 'success');
      refresh();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (config.isConflict(messageText)) {
        try {
          const status = await mergeStatus();
          setConflicted(status.conflicted);
        } catch {
          setConflicted([]);
        }
        notify(config.conflictNotice, 'error');
      } else {
        notify(messageText, 'error');
      }
    } finally {
      setPicking(false);
    }
  };

  const doAbort = async () => {
    try {
      await config.abort();
      notify(config.abortDone, 'success');
      setConflicted(null);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  return (
    <div className="cherry-screen">
      <section className="cherry__header">
        <h3 className="cherry__title">
          <Icon size={14} strokeWidth={1.5} />
          {config.title}
        </h3>
        <span className="cherry__branch">{config.subtitle(currentBranch || 'the current branch')}</span>
      </section>

      {conflicted !== null && (
        <section className="cherry__conflict">
          <p className="cherry__conflict-title">
            <CircleAlert size={13} strokeWidth={1.5} />
            {config.conflictTitle}
          </p>
          <ul className="cherry__conflict-files">
            {conflicted.map((file) => (
              <li key={file} className="cherry__conflict-file">
                {file}
              </li>
            ))}
          </ul>
          <div className="cherry__conflict-actions">
            <button
              type="button"
              className="cherry__abort-btn"
              onClick={() => void doAbort()}
            >
              <Undo2 size={12} strokeWidth={1.5} />
              {config.abortLabel}
            </button>
            <span className="cherry__conflict-hint">
              {config.conflictHint}
            </span>
          </div>
        </section>
      )}

      <section className="cherry__browse">
        <h4 className="cherry__section-title">Recent commits</h4>
        {!config.currentBranchOnly && <div className="cherry__branch-row">
          <label className="cherry__branch-label">
            Branch
            <select
              className="cherry__branch-select"
              value={branchFilter}
              onChange={(event) => {
                setBranchFilter(event.target.value);
                // New list source — collapse back to the first page.
                setVisibleCount(MAX_ROWS);
                setSelected(null);
                setDetail(null);
              }}
            >
              <option value="">All branches</option>
              {(repository?.branches ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.isHead ? '  (checked out)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>}
        <div className="cherry__search">
          <input
            type="text"
            className="cherry__search-input"
            placeholder="Search commits — sha or message"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="cherry__search-clear"
              title="Clear search"
              onClick={() => setQuery('')}
            >
              ×
            </button>
          )}
        </div>
        <div className="commit-list-controls">
          <CommitFilters commits={rows} account={account} range={range}
            onAccountChange={value => { setAccount(value); setVisibleCount(MAX_ROWS); }}
            onRangeChange={value => { setRange(value); setVisibleCount(MAX_ROWS); }} />
          <CommitSortSelect sort={sort} onChange={value => { setSort(value); setVisibleCount(MAX_ROWS); }} />
        </div>
        <ul className="cherry__rows">
          {visibleRows.map((row) => {
            const isSelected = selected?.oid === row.oid;
            return (
              <li key={row.oid} className="cherry__row-item">
                <button
                  type="button"
                  className={`cherry__row${isSelected ? ' is-selected' : ''}`}
                  onClick={() => void selectCommit(row)}
                >
                  <span className="cherry__row-sha">{row.shortOid}</span>
                  <span className="cherry__row-summary">{row.summary}</span>
                  <AuthorAvatar row={row} avatarMap={avatarMap} />
                  <span className="cherry__row-meta">
                    {row.authorName} · {relativeTime(row.timeSeconds)}
                  </span>
                  <CommitSyncIcon pushed={row.pushed} />
                </button>
                {isSelected && (
                  <div className="cherry__detail">
                    {loadingDetail && <p className="cherry__empty">Loading commit…</p>}
                    {detail && (
                      <>
                        <div className="cherry__detail-head">
                          <div>
                            <span className="cherry__detail-sha">{detail.shortOid}</span>
                            <span className="cherry__detail-summary">{detail.summary}</span>
                            <div className="cherry__detail-meta">
                              {detail.authorName} · {relativeTime(detail.timeSeconds)}
                              {detail.isMerge && ' · merge commit'}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="cherry__pick-btn"
                            disabled={picking || detail.isMerge}
                            title={
                              detail.isMerge
                                ? config.mergeTooltip
                                : config.actionTooltip(detail.shortOid, currentBranch)
                            }
                            onClick={() => void doPick(selected)}
                          >
                            <Icon size={13} strokeWidth={1.5} />
                            {picking ? config.actionBusyLabel : config.actionLabel(detail.shortOid)}
                          </button>
                        </div>
                        {detail.message !== detail.summary && (
                          <pre className="cherry__detail-body">{detail.message}</pre>
                        )}
                        <h4 className="cherry__section-title">
                          Files ({detail.files.length})
                        </h4>
                        <ul className="cherry__files">
                          {detail.files.map((file) => {
                            const parentOid = detail.parents[0] ?? null;
                            const fileKey = `${detail.oid}:${file.path}`;
                            const fileOpen = openFile === fileKey;
                            return (
                              <li
                                key={`${file.path}:${file.status}`}
                                className="cherry__file"
                              >
                                <button
                                  type="button"
                                  className="cherry__file-row"
                                  title={`Compare ${file.path} (parent vs commit)`}
                                  onClick={() =>
                                    void openCompare(detail.oid, parentOid, file.path)
                                  }
                                >
                                  <span
                                    className={`cherry__file-status cherry__file-status--${file.status}`}
                                  >
                                    {file.status}
                                  </span>
                                  <span className="cherry__file-path">{file.path}</span>
                                  <span className="cherry__file-stats">
                                    <span className="stats-add">+{file.additions}</span>
                                    <span className="stats-del">−{file.deletions}</span>
                                  </span>
                                </button>
                                {fileOpen && (
                                  <>
                                    {loadingFile && (
                                      <p className="cherry__empty">Loading versions…</p>
                                    )}
                                    <div className="cherry__file-view">
                                      <div className="cherry__file-view-labels">
                                        <span>
                                          BEFORE — {parentOid?.slice(0, 7) ?? '(new file)'}
                                        </span>
                                        <span>COMMIT — {detail.shortOid}</span>
                                        <div
                                          className="cherry__view-mode"
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
                                      <ChatAwareDiffEditor
                                        chatMeta={{ path: file.path, source: config.source }}
                                        key={fileKey}
                                        original={fileContent?.before ?? ''}
                                        modified={fileContent?.after ?? ''}
                                        language={fileContent?.language ?? 'plaintext'}
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
                                  </>
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
            );
          })}
          {!query.trim() && !account.trim() && rows.length === 0 && (
            <li className="cherry__empty">Loading commits…</li>
          )}
          {(query.trim() || account.trim()) && visibleRows.length === 0 && (
            <li className="cherry__empty">No commits match the search.</li>
          )}
        </ul>
        {!query.trim() && visibleCount < matchingRows.length && (
          <button
            type="button"
            className="cherry__show-more"
            onClick={() => setVisibleCount((count) => count + MAX_ROWS)}
          >
            Show more — {matchingRows.length - visibleCount} remaining commits
          </button>
        )}
      </section>

    </div>
  );
}
