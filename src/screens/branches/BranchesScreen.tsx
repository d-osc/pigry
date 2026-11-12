/** Branches screen — every local and remote branch on the left (with
 * local/cloud symbols + search), the selected branch's commits on the right
 * (with commit search, expandable detail and per-file compares). */
import { useEffect, useMemo, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Check, Cloud, GitBranch } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  checkoutBranch,
  getBranchCommits,
  getCommitDetail,
  readFileAtCommit,
} from '../../lib/tauriClient';
import type {
  CommitDetail,
  CommitFileEntry,
  CommitRow,
  WorktreeFileContent,
} from '../../types/repository';
import { relativeTime } from '../../lib/relativeTime';
import { languageForPath } from '../../lib/ghData';
import '../../editor/monacoSetup';
import './BranchesScreen.css';

interface BranchEntry {
  /** Ref name to walk ("main", "origin/main"). */
  ref: string;
  /** Display name without the remote prefix for local entries. */
  name: string;
  kind: 'local' | 'remote';
  remote: string | null;
  isHead: boolean;
}

export function BranchesScreen() {
  const { repository, refresh, notify } = useRepository();
  const [branchQuery, setBranchQuery] = useState('');
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [rows, setRows] = useState<CommitRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingRows, setLoadingRows] = useState(true);
  const [commitQuery, setCommitQuery] = useState('');
  const [selectedCommit, setSelectedCommit] = useState<CommitRow | null>(null);
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

  const entries: BranchEntry[] = useMemo(() => {
    const localBranches = repository?.branches ?? [];
    const remoteGroups = repository?.remotes ?? [];
    const list: BranchEntry[] = localBranches.map((branch) => ({
      ref: branch.name,
      name: branch.name,
      kind: 'local' as const,
      remote: null,
      isHead: branch.isHead,
    }));
    for (const group of remoteGroups) {
      for (const name of group.branches) {
        if (name === 'HEAD') continue;
        list.push({
          ref: `${group.remote}/${name}`,
          name,
          kind: 'remote' as const,
          remote: group.remote,
          isHead: false,
        });
      }
    }
    return list;
  }, [repository]);

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) => entry.ref.toLowerCase().includes(query),
    );
  }, [entries, branchQuery]);

  /** How many branch commits are shown before "Show more". */
  const [visibleCount, setVisibleCount] = useState(100);
  const filteredRows = useMemo(() => {
    const query = commitQuery.trim().toLowerCase();
    if (!query) return rows.slice(0, visibleCount);
    return rows.filter(
      (row) =>
        row.oid.toLowerCase().includes(query) ||
        row.shortOid.toLowerCase().includes(query) ||
        row.summary.toLowerCase().includes(query),
    );
  }, [rows, commitQuery, visibleCount]);

  // New branch selected — collapse back to the first page.
  useEffect(() => {
    setVisibleCount(100);
  }, [selectedRef]);

  // Select HEAD's branch by default once the list loads.
  useEffect(() => {
    if (selectedRef === null && entries.length > 0) {
      const headEntry = entries.find((entry) => entry.isHead) ?? entries[0];
      setSelectedRef(headEntry.ref);
    }
  }, [entries, selectedRef]);

  // Load the selected branch's commits (and reload on repo changes).
  const headOid = repository?.headOid ?? '';
  useEffect(() => {
    if (!selectedRef) return;
    let cancelled = false;
    getBranchCommits(selectedRef)
      .then((history) => {
        if (cancelled) return;
        setRows(history.commits);
        setTotal(history.total);
        setSelectedCommit(null);
        setDetail(null);
        setOpenFile(null);
        setFileContent(null);
        setLoadingRows(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setLoadingRows(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRef, headOid]);

  const selectCommit = async (row: CommitRow) => {
    if (selectedCommit?.oid === row.oid) {
      setSelectedCommit(null);
      setDetail(null);
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setSelectedCommit(row);
    setDetail(null);
    setOpenFile(null);
    setFileContent(null);
    setLoadingDetail(true);
    try {
      setDetail(await getCommitDetail(row.oid));
    } catch {
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

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
      const [before, after]: [WorktreeFileContent | null, WorktreeFileContent] =
        await Promise.all([
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

  const doCheckout = (entry: BranchEntry) => {
    if (entry.kind !== 'local' || entry.isHead) return;
    checkoutBranch(entry.name)
      .then(() => {
        notify(`Checked out ${entry.name}`, 'success');
        refresh();
      })
      .catch((error) => {
        notify(error instanceof Error ? error.message : String(error), 'error');
      });
  };

  return (
    <div className="branches-screen">
      <aside className="branches__left">
        <h3 className="branches__pane-title">Branches</h3>
        <input
          type="text"
          className="branches__search"
          placeholder="Search branches…"
          value={branchQuery}
          onChange={(event) => setBranchQuery(event.target.value)}
        />
        <ul className="branches__list">
          {filteredBranches.map((entry) => (
            <li key={entry.ref} className="branches__item">
              <button
                type="button"
                className={`branches__branch${selectedRef === entry.ref ? ' is-selected' : ''}`}
                onClick={() => setSelectedRef(entry.ref)}
                title={entry.ref}
              >
                {entry.kind === 'local' ? (
                  <GitBranch size={12} strokeWidth={1.5} className="branches__icon branches__icon--local" />
                ) : (
                  <Cloud size={12} strokeWidth={1.5} className="branches__icon branches__icon--remote" />
                )}
                <span className="branches__branch-name">{entry.name}</span>
                {entry.kind === 'remote' && (
                  <span className="branches__remote-tag">{entry.remote}</span>
                )}
                {entry.isHead && (
                  <span className="branches__head-tag">
                    <Check size={11} strokeWidth={2} />
                    HEAD
                  </span>
                )}
              </button>
              {entry.kind === 'local' && !entry.isHead && (
                <button
                  type="button"
                  className="branches__checkout-btn"
                  title={`Checkout ${entry.name}`}
                  onClick={() => doCheckout(entry)}
                >
                  Checkout
                </button>
              )}
            </li>
          ))}
          {filteredBranches.length === 0 && (
            <li className="branches__empty">No branches match.</li>
          )}
        </ul>
      </aside>

      <section className="branches__right">
        <h3 className="branches__pane-title">
          Commits — <span className="branches__selected-ref">{selectedRef ?? '…'}</span>
          {total > 0 && <span className="branches__count">({total})</span>}
        </h3>
        <input
          type="text"
          className="branches__search"
          placeholder="Search commits — sha or message"
          value={commitQuery}
          onChange={(event) => {
              setCommitQuery(event.target.value);
              setVisibleCount(100);
            }}
        />
        <ul className="branches__rows">
          {loadingRows && <li className="branches__empty">Loading commits…</li>}
          {!loadingRows && filteredRows.map((row) => {
            const isSelected = selectedCommit?.oid === row.oid;
            return (
              <li key={row.oid} className="branches__row-item">
                <button
                  type="button"
                  className={`branches__row${isSelected ? ' is-selected' : ''}`}
                  onClick={() => void selectCommit(row)}
                >
                  <span className="branches__row-sha">{row.shortOid}</span>
                  <span className="branches__row-summary">{row.summary}</span>
                  <span className="branches__row-meta">
                    {row.authorName} · {relativeTime(row.timeSeconds)}
                  </span>
                </button>
                {isSelected && (
                  <div className="branches__detail">
                    {loadingDetail && <p className="branches__empty">Loading commit…</p>}
                    {detail && (
                      <>
                        <div className="branches__detail-head">
                          <div>
                            <span className="branches__detail-sha">{detail.shortOid}</span>
                            <span className="branches__detail-summary">{detail.summary}</span>
                            <div className="branches__detail-meta">
                              {detail.authorName} · {relativeTime(detail.timeSeconds)}
                              {detail.isMerge && ' · merge commit'}
                            </div>
                          </div>
                        </div>
                        {detail.message !== detail.summary && (
                          <pre className="branches__detail-body">{detail.message}</pre>
                        )}
                        <h4 className="branches__section-title">
                          Files ({detail.files.length})
                        </h4>
                        <ul className="branches__files">
                          {detail.files.map((file: CommitFileEntry) => {
                            const parentOid = detail.parents[0] ?? null;
                            const fileKey = `${detail.oid}:${file.path}`;
                            const fileOpen = openFile === fileKey;
                            return (
                              <li key={`${file.path}:${file.status}`} className="branches__file">
                                <button
                                  type="button"
                                  className="branches__file-row"
                                  title={`Compare ${file.path} (parent vs commit)`}
                                  onClick={() =>
                                    void openCompare(detail.oid, parentOid, file.path)
                                  }
                                >
                                  <span
                                    className={`branches__file-status branches__file-status--${file.status}`}
                                  >
                                    {file.status}
                                  </span>
                                  <span className="branches__file-path">{file.path}</span>
                                  <span className="branches__file-stats">
                                    <span className="stats-add">+{file.additions}</span>
                                    <span className="stats-del">−{file.deletions}</span>
                                  </span>
                                </button>
                                {fileOpen && (
                                  <>
                                    {loadingFile && (
                                      <p className="branches__empty">Loading versions…</p>
                                    )}
                                    <div className="branches__file-view">
                                      <div className="branches__file-view-labels">
                                        <span>
                                          BEFORE — {parentOid?.slice(0, 7) ?? '(new file)'}
                                        </span>
                                        <span>COMMIT — {detail.shortOid}</span>
                                        <div
                                          className="branches__view-mode"
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
                                      <DiffEditor
                                        key={fileKey}
                                        original={fileContent?.before ?? ''}
                                        modified={fileContent?.after ?? ''}
                                        language={fileContent?.language ?? 'plaintext'}
                                        theme="orbit-dark"
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
          {!loadingRows && filteredRows.length === 0 && rows.length > 0 && (
            <li className="branches__empty">No commits match the search.</li>
          )}
          {!loadingRows && !commitQuery.trim() && rows.length > visibleCount && (
            <li className="branches__show-more-row">
              <button
                type="button"
                className="branches__show-more"
                onClick={() => setVisibleCount((count) => count + 100)}
              >
                Show more — {rows.length - visibleCount} older commits
              </button>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
